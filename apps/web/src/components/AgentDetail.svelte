<script lang="ts">
  import type { Agent } from '../lib/api.ts'
  import { agents, identity, skills, updateAgent } from '../lib/stores.ts'
  import { showToast } from '../lib/view.ts'
  import ReviewStandardEditor from './ReviewStandardEditor.svelte'

  /**
   * 智能体详情 / 编辑（FR-AGENT-19）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这一版重做了**显示**，重点在三件事
   * ══════════════════════════════════════════════════════════════════
   *
   * **① 分组，而不是一长串字段。**
   *    初版把八个字段平铺成一个两列网格（`dl.meta-grid`），于是"角色"这种
   *    一个词的字段和"指令"这种一整段的字段挤在同一种排版里。更糟的是
   *    它们之间**没有层次**——使用者扫完一整屏才知道哪些是一类。
   *    现在分成四组：身份 / 行为 / 关系 / 运行环境。
   *
   * **② 只读与编辑用**同一套骨架**。**
   *    初版的两个视图结构不同（一个是 dl 网格、一个是竖排 label），
   *    点「编辑」之后布局整个重排，眼睛得重新找位置。现在两者共用同样的
   *    分组与字段行，切换时只有"值"变成"输入框"。
   *
   * **③ 字段行统一对齐。**
   *    label 定宽、值左对齐，所有行的值与值在同一个竖线上——这是让一张
   *    配置表"看起来是整理过的"最省力也最有效的一招。初版用
   *    `grid-template-columns: max-content 1fr`，label 宽度随内容变，
   *    竖线是歪的。
   *
   * 顺带清掉了散落的 `style="..."`——它们绕过了设计令牌，是"看起来不齐"
   * 的另一个常见来源。
   *
   * ══════════════════════════════════════════════════════════════════
   * 编辑用 PATCH 语义（这一半没变）
   * ══════════════════════════════════════════════════════════════════
   *
   * 只提交**改动过的**字段。整体提交的话，两个人同时编辑时后保存的会把
   * 前一个的改动抹掉——而这里没有并发控制，减少提交面是最省事的缓解。
   * 而且"只改名字却把指令清空"那种坑也不会发生。
   */
  export let agent: Agent
  export let onclose: () => void
  export let onchanged: () => void

  let editing = false
  let busy = false
  let error = ''

  const blankDraft = () => ({
    name: agent.name,
    role: agent.role,
    instructions: agent.instructions,
    skillIds: [...agent.skillIds],
    reviewerAgentId: agent.reviewerAgentId ?? '',
    runtimeKey: agent.runtimeKey,
    workDir: agent.workDir ?? '',
    model: agent.model ?? '',
    // D37：审核标准（只对审核者有意义）
    reviewStandard: agent.reviewStandard ? { ...agent.reviewStandard } : null,
  })

  let draft = blankDraft()

  /**
   * 可选的 runtime —— **从身份接口来，不写死**。
   *
   * ★ 原来是两个写死的 `<option value="claude">` / `"generic"`。那意味着
   *   加一个 runtime（描述表一行 + 适配器包 + 装配表一行）之后，**界面上
   *   根本选不到它**——只有直接调接口才行。而"接口支持、界面没有入口"
   *   是这个仓库里最常见的那类缺陷。
   */
  $: runtimeOptions = $identity?.runtimes.map((r) => r.key) ?? []

  /**
   * 该 runtime 的"未验证"提示；已验证 / 还不知道时返回 null。
   *
   * ★ 判据是描述表里的 `evidence`，不是 `runtimeKey === 'generic'`。
   *   写死 runtime 名的那种判断，在加入第三个 runtime 时会**静默失效**：
   *   一个未验证的 CLI 会被显示得像验证过一样——而那正是 `evidence`
   *   这个字段存在的理由。
   */
  function evidenceWarning(key: string): string | null {
    const runtime = $identity?.runtimes.find((r) => r.key === key)
    if (!runtime || runtime.evidence === 'verified') return null
    return runtime.evidenceNote ?? '未对照真实程序（字段名是按公开形状推导的）'
  }

  function startEdit(): void {
    // 每次进入编辑都重新拷一份——否则上一次取消留下的改动会残留
    draft = blankDraft()
    editing = true
    error = ''
  }

  function cancelEdit(): void {
    editing = false
    error = ''
  }

  /** 只把**真的变了**的字段放进 patch。 */
  function buildPatch(): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    if (draft.name !== agent.name) patch['name'] = draft.name
    if (draft.instructions !== agent.instructions) patch['instructions'] = draft.instructions
    if (draft.role !== agent.role) patch['role'] = draft.role
    if ((draft.workDir || '') !== (agent.workDir ?? '')) patch['workDir'] = draft.workDir
    if ((draft.model || '') !== (agent.model ?? '')) patch['model'] = draft.model
    if (draft.runtimeKey !== agent.runtimeKey) patch['runtimeKey'] = draft.runtimeKey
    if (draft.skillIds.slice().sort().join() !== agent.skillIds.slice().sort().join())
      patch['skillIds'] = draft.skillIds
    if ((draft.reviewerAgentId || null) !== (agent.reviewerAgentId ?? null))
      patch['reviewerAgentId'] = draft.reviewerAgentId || null
    // 标准按值比较（它是对象，直接比引用永远不相等）
    if (JSON.stringify(draft.reviewStandard) !== JSON.stringify(agent.reviewStandard ?? null))
      patch['reviewStandard'] = draft.reviewStandard
    return patch
  }

  /** 有几处改动——用在保存按钮上，让"要不要保存"一眼可见。 */
  $: changedCount = editing ? Object.keys(buildPatch()).length : 0

  async function save(): Promise<void> {
    const patch = buildPatch()
    if (Object.keys(patch).length === 0) {
      editing = false
      return
    }
    busy = true
    error = ''
    try {
      await updateAgent(agent.id, patch)
      editing = false
      showToast('已保存')
      onchanged()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  $: attached = $skills.filter((s) => agent.skillIds.includes(s.id))
  $: reviewers = $agents.filter((a) => a.role === 'reviewer' && a.id !== agent.id)
  $: chosenReviewer = $agents.find((a) => a.id === agent.reviewerAgentId) ?? null
  $: isReviewer = agent.role === 'reviewer'


  /**
   * 哪些执行者指向了这个审核者。
   *
   * 这个**反向查询**在看审核者时很有用：审核者是"被动"的一方，光看它自己
   * 的配置看不出它在为谁服务。没有它，一个审核者的详情页会说不出它到底
   * 在审谁——而"我建了这个审核者，它怎么没动静"是最常见的问题。
   */
  $: executorsPointingHere = $agents.filter((a) => a.reviewerAgentId === agent.id)

  /** 摘要里最该被看到的那一处问题——没有就不显示。 */
  $: headline =
    isReviewer && !agent.reviewStandard && agent.skillIds.length === 0
      ? {
          tone: 'bad',
          text: '它审不了任何东西：没有审核标准，平台不会把产出交给它审。点「编辑」写一条。',
        }
      : !isReviewer && !agent.reviewerAgentId
        ? { tone: 'warn', text: '执行产出不会被自动审核（没有指定审核者）。' }
        : null
</script>

<div class="detail">
  <!-- ══════════════ 头部：它是谁 ══════════════ -->
  <header class="hero">
    <div class="hero-main">
      <button type="button" class="ghost small back" onclick={onclose}>← 智能体列表</button>

      <div class="hero-title">
        <span class="avatar {agent.role}">{agent.name.slice(0, 1).toUpperCase()}</span>
        <div>
          <h2>{agent.name}</h2>
          <p class="role-line">
            <span class="badge {isReviewer ? 'in_review' : 'in_progress'}">
              {isReviewer ? '审核' : '执行'}
            </span>
            <span class="faint small">
              {isReviewer ? '按标准审别人的产出，给判决' : '接到任务后动手干活'}
            </span>
          </p>
        </div>
      </div>
    </div>

    <div class="hero-actions">
      {#if !editing}
        <button type="button" onclick={startEdit}>编辑</button>
      {:else}
        <button type="button" class="secondary" onclick={cancelEdit} disabled={busy}>取消</button>
        <button type="button" onclick={save} disabled={busy}>
          {busy ? '保存中…' : changedCount > 0 ? `保存 ${changedCount} 处改动` : '保存'}
        </button>
      {/if}
    </div>
  </header>

  {#if headline && !editing}
    <div class="notice {headline.tone} headline">{headline.text}</div>
  {/if}

  {#if error}
    <div class="notice bad headline">{error}</div>
  {/if}

  <div class="panes">
    <!-- ══════════════ 它怎么干活 ══════════════ -->
    <section class="section">
      <h3>它怎么干活</h3>

      {#if editing}
        <div class="field-row">
          <label for="agent-name">名称</label>
          <input id="agent-name" bind:value={draft.name} />
        </div>

        <div class="field-row">
          <span class="row-label">角色</span>
          <div class="role-picker">
            <button
              type="button"
              class="role-card"
              class:active={draft.role === 'executor'}
              onclick={() => (draft.role = 'executor')}
            >
              <strong>执行</strong><span>接到任务后动手干活</span>
            </button>
            <button
              type="button"
              class="role-card"
              class:active={draft.role === 'reviewer'}
              onclick={() => (draft.role = 'reviewer')}
            >
              <strong>审核</strong><span>按标准审别人的产出</span>
            </button>
          </div>
        </div>

        <div class="field-row">
          <label for="agent-instructions">指令</label>
          <div>
            <textarea id="agent-instructions" bind:value={draft.instructions} rows="4"></textarea>
            <p class="row-hint">这段填进第一句话模版的 <code>{'{{instructions}}'}</code>。</p>
          </div>
        </div>
      {:else}
        <div class="field-row">
          <span class="row-label">指令</span>
          {#if agent.instructions.trim()}
            <p class="prose">{agent.instructions}</p>
          {:else}
            <p class="empty-value">没有写指令 —— 它只会拿到任务的标题与说明。</p>
          {/if}
        </div>
      {/if}
    </section>

    <!-- ══════════════ 用什么标准 ══════════════ -->
    <section class="section">
      <h3>用什么标准</h3>

      {#if editing}
        <!-- D37：标准内联在审核者身上，所以它是这一段的**第一件事** -->
        {#if draft.role === 'reviewer'}
          <div class="field-row">
            <span class="row-label">审核标准</span>
            <div>
              <ReviewStandardEditor
                value={draft.reviewStandard}
                onchange={(next) => {
                  draft.reviewStandard = next
                  draft = { ...draft }
                }}
              />
              {#if agent.skillIds.length > 0 && !agent.reviewStandard}
                <!-- 过渡期：老数据的标准还在挂载的 skill 里 -->
                {#each attached as s (s.id)}
                  <p class="row-hint std-legacy">
                    当前它仍然沿用挂载的 skill「<code>{s.slug}</code>」当标准（老配置）。
                    用上面那一栏写上自己的标准即可取而代之。
                  </p>
                {/each}
              {/if}
            </div>
          </div>
        {:else}
          <div class="field-row">
            <span class="row-label">审核标准</span>
            <p class="empty-value">不适用 —— 执行者不审别人的产出。</p>
          </div>
        {/if}

        <div class="field-row">
          <span class="row-label">挂载的 skill</span>
          {#if $skills.length === 0}
            <p class="empty-value">还没有任何 skill。</p>
          {:else}
            <div class="skill-picker">
              {#each $skills as s (s.id)}
                <label class="skill-option">
                  <input type="checkbox" value={s.id} bind:group={draft.skillIds} />
                  <span><code>{s.slug}</code></span>
                </label>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <div class="field-row">
          <span class="row-label">审核标准</span>
          <div>
            {#if !isReviewer}
              <p class="empty-value">不适用 —— 执行者不审别人的产出。</p>
            {:else if agent.reviewStandard}
              <span class="badge default-badge">{agent.reviewStandard.name}</span>
              <p class="row-hint">
                它按下面这份标准判断；判完能触发的动作：
                {#if agent.reviewStandard.allowedActions.length === 0}
                  <strong>一个都没有</strong>（只报告、不动作）
                {:else}
                  {#each agent.reviewStandard.allowedActions as a, i (a)}{i > 0 ? '、' : ''}<code
                      >{a}</code
                    >{/each}
                {/if}
              </p>
              <details open>
                <summary>看标准正文</summary>
                <pre class="tpl-text">{agent.reviewStandard.body}</pre>
              </details>
            {:else if attached.length > 0}
              <!-- 过渡期：标准还在挂载的 skill 里 -->
              <p class="row-hint">
                它还没有内联的审核标准，当前<strong>沿用挂载的 skill</strong>当标准：
                {#each attached as s, i (s.id)}{i > 0 ? '、' : ''}<code>{s.slug}</code>{/each}。
                点「编辑」可以把标准写进它自己身上（推荐——那样它不依赖 skill 就能审）。
              </p>
            {:else}
              <p class="empty-value">
                没有审核标准 —— <strong>它拿不到审核任务</strong>。点「编辑」写一条。
              </p>
            {/if}
          </div>
        </div>

        <div class="field-row">
          <span class="row-label">挂载的 skill</span>
          <div>
            {#if attached.length === 0}
              <p class="empty-value">
                {isReviewer
                  ? '一个都没挂 —— 它审不了任何东西，审核标准就写在 skill 里。'
                  : '没有挂（执行者可以不挂，产出由审核者按标准来判）。'}
              </p>
            {:else}
              <div class="chips">
                {#each attached as s (s.id)}
                  <span class="chip"><code>{s.slug}</code><span class="chip-sub">{s.name}</span></span>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </section>

    <!-- ══════════════ 与其他智能体的关系 ══════════════ -->
    <section class="section">
      <h3>与其他智能体的关系</h3>

      {#if editing}
        {#if draft.role === 'executor'}
          <div class="field-row">
            <label for="agent-reviewer">由谁来审它</label>
            <div>
              <select id="agent-reviewer" bind:value={draft.reviewerAgentId}>
                <option value="">不自动审核</option>
                {#each reviewers as r (r.id)}
                  <option value={r.id}>{r.name}</option>
                {/each}
              </select>
              <p class="row-hint">
                执行完由它审。选「不自动审核」也是明确的选择——每个任务都多跑一次
                审核会既费钱又吵。
              </p>
            </div>
          </div>
        {:else}
          <div class="field-row">
            <span class="row-label">由谁来审它</span>
            <p class="empty-value">
              不适用 —— 它是<strong>审别人的那个</strong>。反过来，在执行角色的智能体上指定它即可。
            </p>
          </div>
        {/if}
      {:else if isReviewer}
        <div class="field-row">
          <span class="row-label">谁由它来审</span>
          <div>
            {#if executorsPointingHere.length === 0}
              <p class="empty-value">
                暂时没有执行者指向它 —— 在某个执行角色的智能体上把「由谁来审它」设成它。
              </p>
            {:else}
              <div class="chips">
                {#each executorsPointingHere as e (e.id)}
                  <span class="chip">{e.name}</span>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {:else}
        <div class="field-row">
          <span class="row-label">由谁来审它</span>
          <div>
            {#if chosenReviewer}
              <strong>{chosenReviewer.name}</strong>
              <p class="row-hint">它执行完的产出会交给这个审核者。</p>
            {:else if agent.reviewerAgentId}
              <span class="bad">指定的审核者已不存在（{agent.reviewerAgentId}）</span>
            {:else}
              <p class="empty-value">
                没有指定 —— 执行产出不会被自动审核。这是明确的选择，不是错误。
              </p>
            {/if}
          </div>
        </div>
      {/if}
    </section>

    <!-- ══════════════ 运行环境 ══════════════ -->
    <section class="section">
      <h3>运行环境</h3>

      {#if editing}
        <div class="field-row">
          <label for="agent-runtime">runtime</label>
          <div>
            <select id="agent-runtime" bind:value={draft.runtimeKey}>
              {#each runtimeOptions as key (key)}
                <option value={key}>{key}</option>
              {/each}
              {#if !runtimeOptions.includes(draft.runtimeKey)}
                <!-- 身份还没到（或这个 runtime 已被摘掉）：把当前值显示出来。
                     少了这一支，select 会静默落到第一项 —— 那等于偷偷改了
                     这个 agent 的 runtime。 -->
                <option value={draft.runtimeKey}>{draft.runtimeKey}（当前）</option>
              {/if}
            </select>
            {#if evidenceWarning(draft.runtimeKey)}
              <p class="row-hint warn">{evidenceWarning(draft.runtimeKey)}</p>
            {/if}
          </div>
        </div>

        <div class="field-row">
          <label for="agent-model">模型</label>
          <div>
            <input id="agent-model" bind:value={draft.model} placeholder="留空 = 用 CLI 默认" />
          </div>
        </div>

        <div class="field-row">
          <label for="agent-workdir">默认工作目录</label>
          <div>
            <input id="agent-workdir" bind:value={draft.workDir} placeholder="留空 = 每个任务自动分配" />
            <p class="row-hint">
              留空时每个任务得到自己的目录（重试还看得见上次的文件）。填了之后，
              这个目录同时只跑一个任务，其余排队。
            </p>
          </div>
        </div>
      {:else}
        <div class="field-row">
          <span class="row-label">runtime</span>
          <div>
            <code>{agent.runtimeKey}</code>
            {#if evidenceWarning(agent.runtimeKey)}
              <span class="warn small">{evidenceWarning(agent.runtimeKey)}</span>
            {/if}
          </div>
        </div>

        <div class="field-row">
          <span class="row-label">模型</span>
          <span class:empty-value={!agent.model}>{agent.model ?? '用 CLI 默认'}</span>
        </div>

        <div class="field-row">
          <span class="row-label">默认工作目录</span>
          {#if agent.workDir}
            <code class="path">{agent.workDir}</code>
          {:else}
            <span class="empty-value">每个任务自动分配</span>
          {/if}
        </div>
      {/if}
    </section>
  </div>
</div>

<style>
  /* ══════════════════════════════════════════════════════════════════
     布局
     ══════════════════════════════════════════════════════════════════

     上限 52rem 是**阅读宽度**：再宽的话眼睛从 label 扫到 value 要横跨
     一整屏，反而更难对齐行。 */
  .detail {
    max-width: 52rem;
  }

  /* ── 头部 ── */

  .hero {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-4);
    padding-bottom: var(--sp-4);
    margin-bottom: var(--sp-4);
    border-bottom: 1px solid var(--line);
  }

  .back {
    padding-left: 0;
    margin-bottom: var(--sp-3);
  }

  .hero-title {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
  }

  /* 头像用角色着色：一眼能分出"审的"和"干的"，比读文字快 */
  .avatar {
    width: 2.5rem;
    height: 2.5rem;
    flex: none;
    border-radius: var(--radius);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--fs-lg);
    font-weight: 600;
    color: #fff;
    background: var(--accent-dim);
  }

  .avatar.reviewer {
    background: #5b4a86;
  }

  .hero-title h2 {
    margin: 0 0 2px;
  }

  .role-line {
    margin: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }

  .hero-actions {
    display: flex;
    gap: var(--sp-2);
    flex: none;
  }

  .headline {
    margin-bottom: var(--sp-4);
  }

  /* ── 分组 ── */

  .panes {
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
  }

  .section h3 {
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    font-weight: 600;
    margin-bottom: var(--sp-1);
    padding-bottom: var(--sp-2);
    border-bottom: 1px solid var(--line);
  }

  /**
   * ★ 字段行：label 定宽、值左对齐。
   *
   * 这是让一张配置表"看起来是整理过的"最省力也最有效的一招——
   * 所有行的值都落在同一条竖线上。初版用 `max-content` 让 label 宽度
   * 随内容变，于是那条竖线是歪的，整片看起来就"没对齐"。
   */
  .field-row {
    display: grid;
    grid-template-columns: 9rem 1fr;
    gap: var(--sp-4);
    align-items: start;
    padding: var(--sp-3) 0;
  }

  .field-row + .field-row {
    border-top: 1px solid var(--line);
  }

  .row-label,
  .field-row > label {
    color: var(--text-faint);
    font-size: var(--fs-sm);
    /* 与右侧首行文字对齐：右侧多是 fs-base，行高不同会让 label 看起来偏高 */
    padding-top: 2px;
  }

  /* ── 值的呈现 ── */

  .prose {
    margin: 0;
    white-space: pre-wrap;
    color: var(--text-dim);
    /* 指令可能是一整段，限一下宽度避免行长过长 */
    max-width: 46ch;
  }

  .empty-value {
    margin: 0;
    color: var(--text-faint);
    font-size: var(--fs-sm);
  }

  .row-hint {
    margin: var(--sp-2) 0 0;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    max-width: 46ch;
  }

  .path {
    word-break: break-all;
  }

  /* ── skill 标签 ── */

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }

  .chip {
    display: inline-flex;
    align-items: baseline;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-3);
    border: 1px solid var(--line-strong);
    border-radius: 100px;
    background: var(--surface);
    font-size: var(--fs-sm);
  }

  .chip-sub {
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }

  /* ── 编辑控件 ── */

  .skill-picker {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
    gap: var(--sp-1);
    max-height: 11rem;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2);
    background: var(--bg);
  }

  .skill-option {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0;
    cursor: pointer;
    font-size: var(--fs-sm);
  }

  .skill-option input {
    width: auto;
    margin: 0;
  }

  /* 角色选择：两个等宽卡片。这是"选边"的决定，值得占视觉重量 */
  .role-picker {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-2);
  }

  .role-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
    text-align: left;
    padding: var(--sp-3);
    background: var(--bg);
    border: 1px solid var(--line-strong);
    color: var(--text-dim);
  }

  .role-card strong {
    color: var(--text);
    font-size: var(--fs-md);
  }

  .role-card span {
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }

  .role-card.active {
    border-color: var(--accent);
    background: var(--surface-2);
  }

  .role-card.active strong {
    color: var(--accent);
  }
</style>
