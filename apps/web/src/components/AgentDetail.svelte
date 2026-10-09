<script lang="ts">
  import type { Agent } from '../lib/api.ts'
  import {
    agents,
    identity,
    loadError,
    loading,
    skills,
    tools,
    deleteAgent,
    updateAgent,
  } from '../lib/stores.ts'
  import { showToast } from '../lib/view.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import { t, tx } from '../lib/i18n.ts'

  /**
   * 智能体详情 / 编辑（FR-AGENT-19）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这一版重做了**显示**，重点在三件事
   * ══════════════════════════════════════════════════════════════════
   *
   * ★ 2026-10（使用者拍板）：**没有预览页了**——选中即编辑，与智能体组页同款。
   *   没有 hero 头、没有「编辑」按钮、没有查看/编辑两态：右栏进来就是一张
   *   可编辑的卡片（两列网格，对齐「新建私有」），保存 / 取消在底部。
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

  let busy = false
  let error = ''

  const blankDraft = () => ({
    name: agent.name,
    role: agent.role,
    instructions: agent.instructions,
    skillIds: [...agent.skillIds],
    // ⚠️ 2026-10（使用者的决定）：`reviewerAgentId` / `model` / `workDir` 不再进
    // 编辑草稿——这三个"执行者设定"从界面上整段拿掉了（审核走智能体组；模型用
    // CLI 默认；工作目录是任务级的）。协议字段原样保留，老数据继续有效。
    runtimeKey: agent.runtimeKey,
    // D37：审核标准（只对审核者有意义）
    reviewStandard: agent.reviewStandard ? { ...agent.reviewStandard } : null,
    // ⚠️ 2026-10：这里原来还有行动权限那三个（`allowedActions` / `actionParams` /
    //    `debugActions`）。整个能力从 agent 上撤掉了（它在**组**上，见 `blankDraft`
    //    上面那段编辑语义的说明与表单里那一句指路），草稿里不再有它们——留着只会
    //    让 `buildPatch` 把它们写进一个必然被 400 的请求里。
  })

  let draft = blankDraft()

  /**
   * ══════════════════════════════════════════════════════════════════
   * 草稿属于**某一个人**：换 agent 就作废
   * ══════════════════════════════════════════════════════════════════
   *
   * `draft` 是进详情时从 `agent` 拷的一份**快照**，而 `Agents.svelte` 是
   * `{#if selected}<AgentDetail agent={selected} …/>{/if}` —— 换一个 agent 时
   * `{#if}` 仍然是真，于是**组件实例被复用**：`agent` 换了，`draft` 还是
   * **上一个人**的。点「保存」会把**上一个人的**名字、指令、角色 PATCH 到
   * 这个人身上（`buildPatch()` 拿 `draft.*` 与**新的** `agent.*` 比，于是这些
   * 字段全都判成"变了"）。这是**改错人**，不是显示错。
   *
   * 判据是 `agent.id` —— 不是 `role`、也不是 `name`：同一个人刷新之后还是同一份
   * 草稿（改到一半被 `loadAgents()` 刷一下不该把输入清空），换人才作废。
   *
   * ⚠️ 在父组件写 `{#key selected.id}` 也能治，但那是**绕过**：组件自己持有了一份
   *    会过期的拷贝，就该由它自己作废。否则换个地方复用这个组件，同一个坑再来一次。
   */
  let draftOwner = agent.id
  $: if (agent.id !== draftOwner) {
    draftOwner = agent.id
    draft = blankDraft()
    error = ''
  }

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
   * 该 runtime 的"未验证"提示；已验证 / 还不知道时**不在表里**。
   *
   * ★ 判据是描述表里的 `evidence`，不是 `runtimeKey === 'generic'`。
   *   写死 runtime 名的那种判断，在加入第三个 runtime 时会**静默失效**：
   *   一个未验证的 CLI 会被显示得像验证过一样——而那正是 `evidence`
   *   这个字段存在的理由。
   *
   * ⚠️ 整张表用 `$:` 先算好（D39），而不是在标记里调函数：函数体里读 `$t`
   *    对编译器是**看不见的依赖**——切语言时那几行不会重渲染。表是 `$:`
   *    算出来的，标记里读表就订阅上了。表里没有这个 key（= 不该提示）
   *    时取值是 `undefined`，与原来返回 `null` 的语义一致（都是假值）。
   */
  $: evidenceWarnings = Object.fromEntries(
    ($identity?.runtimes ?? [])
      .filter((r) => r.evidence !== 'verified')
      .map((r) => [r.key, r.evidenceNote ?? $t('agents.evidenceNoteFallback')]),
  ) as Record<string, string>

  function cancelEdit(): void {
    // ★ 2026-10：没有查看态了（选中即编辑，与组页同款）——「取消」= 放弃草稿、
    //   退出这一栏（回到空态）。改动直接丢，不逐个字段回滚。
    onclose()
  }

  /** 只把**真的变了**的字段放进 patch。 */
  function buildPatch(): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    if (draft.name !== agent.name) patch['name'] = draft.name
    if (draft.instructions !== agent.instructions) patch['instructions'] = draft.instructions
    if (draft.role !== agent.role) patch['role'] = draft.role
    // ⚠️ 2026-10：`workDir` / `model` / `reviewerAgentId` 三个设置从界面拿掉了
    // （见 `blankDraft`），PATCH 里不再生成——编辑一个 agent 不会碰它们。
    if (draft.runtimeKey !== agent.runtimeKey) patch['runtimeKey'] = draft.runtimeKey
    if (draft.skillIds.slice().sort().join() !== agent.skillIds.slice().sort().join())
      patch['skillIds'] = draft.skillIds
    // 标准按值比较（它是对象，直接比引用永远不相等）
    if (JSON.stringify(draft.reviewStandard) !== JSON.stringify(agent.reviewStandard ?? null))
      patch['reviewStandard'] = draft.reviewStandard
    // ⚠️ 2026-10：这里原来还有三段——行动权限（`allowedActions`）、它的固定参数
    //    （`actionParams`）与调试勾选（`debugActions`）。三者一起撤掉了：**动作只
    //    属于组**（`AgentGroup`），从这里提交它们现在只会得到 400「不认识的字段」。
    //
    //    ★ 那三段里有一条真实的教训值得留在这里（它不再有代码，但换个字段还会
    //      再遇到同样的坑）：当年"按界面上显示的有效值去比"，会让**保存动作本身**
    //      触发一次数据迁移——老数据的有效值来自 `reviewStandard.allowedActions`，
    //      保存时把标准写成新形状，老字段就没了，那份权限在保存的一瞬间消失。
    //      判据必须落在"库里的事实"上，而不是"界面上显示的东西"。
    return patch
  }

  /**
   * ★ 2026-10：保存按钮与组页同款，就写「保存」——不做「保存(有改动)」的计数。
   *    （`changedCount` 那一套是给"查看/编辑两态"用的，两态没了它就没意义了。）
   */
  async function save(): Promise<void> {
    const patch = buildPatch()
    if (Object.keys(patch).length === 0) {
      return
    }
    busy = true
    error = ''
    try {
      await updateAgent(agent.id, patch)
      showToast(tx('agents.saved'))
      onchanged()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  /** 删除（2026-11）：先确认，再删；删完退出这一栏（列表已随 store 刷新）。 */
  async function remove(): Promise<void> {
    const ok = await askConfirm({
      title: tx('agents.confirmDeleteTitle'),
      message: tx('agents.confirmDeleteBody', { name: agent.name }),
      confirmLabel: tx('agents.confirmDelete'),
    })
    if (!ok) return
    error = ''
    try {
      await deleteAgent(agent.id)
      onclose()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  $: attached = $skills.filter((s) => agent.skillIds.includes(s.id))
  /**
   * 能挂上去的 skill。
   *
   * ★ 2026-10：库里**每一条都能挂**（"不可选"这个概念随"本地技能目录改成显式
   *   安装"一起撤掉了）——所以这里就是全部技能。以前要在这里判 `selectable`，
   *   是因为本地目录那条可能"来源目录取消了勾选"而变得不可选；现在装进来的
   *   就是一条普通技能，没有这回事了。
   */
  $: pickableSkills = $skills
  $: isReviewer = agent.role === 'reviewer'

  /**
   * ══════════════════════════════════════════════════════════════════
   * 老数据那份「审核标准」：**不再有单独一段**，它归到「指令」那一栏里
   * ══════════════════════════════════════════════════════════════════
   *
   * ★ 使用者的要求（原话）：「移除审核智能体的『审核标准』」。这一步之所以能删，
   *   是因为判断依据已经并进 ② 身份（= 那个 agent 的「指令」）：界面上一件事
   *   只该有一个出处，而留一段"标准"只会让人在两个框之间来回搬文字。
   *
   * ⚠️ 但**投递链条上它还在**：老数据的 `Agent.reviewStandard`（以及"正文来自挂载
   *   skill"那种更老的形态）仍然会被执行器合成进 ②（`reviewerIdentity`）。所以
   *   删掉那一段之后必须把这两件事**搬到「指令」那一栏里说清**，否则界面会开始
   *   撒谎：使用者看着一段指令，以为那就是全部依据，而实际投递出去的还多出一段。
   *   这也是"宁可显示得啰嗦，也不静默少一段"的那条老规矩。
   *
   * ★ 一并给出**一步并进来**的按钮（`adopt-from-skills` 那个端点现在也收"内联
   *   老标准"这一种，见下）：原来只有在"正文来自挂载 skill"时才给按钮，于是带
   *   内联老标准的审核者（使用者的库里正好有一个）只能自己抄——而"看得见但搬不动"
   *   正是这次改造要消掉的那种状态。
   *
   * ⚠️ 按钮**只在只读态**出现。编辑态里点它会导致一次数据打架：搬移会在服务端把
   *   `skillIds` 清空，而草稿里还留着旧的那份 ⇒ 接着点「保存」会把挂载又写回去，
   *   于是同一段正文既在「指令」里、又在 skill 里被投递**两遍**（服务端那句注释
   *   说的就是这个）。所以编辑态只提示、不提供入口，并说清去哪儿点。
   */
  $: legacyStandardBody = isReviewer ? (agent.reviewStandard?.body ?? '') : ''
  $: legacyFromSkills = isReviewer && !agent.reviewStandard && attached.length > 0
  /** 这份判断依据还走在老形态上（内联老标准，或来自挂载的 skill）⇒ 可以并进来 */
  $: legacyStandardPending = legacyStandardBody !== '' || legacyFromSkills

  /**
   * ══════════════════════════════════════════════════════════════════
   * 执行者的详情里**没有**工具那一段了
   * ══════════════════════════════════════════════════════════════════
   *
   * ★ 使用者的要求（原话）：「执行智能体不支持"行动"，去掉」。
   *
   *   他在「智能体」页选「助手」、点「编辑」，看到的是那一栏「可挂载的工具组」。
   *   先撤掉勾选栏，再整段撤掉——**两段都撤的理由不一样**：
   *     ① 勾选栏是"能改"，撤掉之后这一段只剩"能看"；
   *     ② 而"能看"那半截对一个使用者**永远是同一句空话**：`toolIds` 只能由
   *        `PUT /api/agents/:id/tools` 写，而那条接口没有界面、CLI 和 MCP 都
   *        没有入口（查过 `apps/cli`、`apps/mcp`，一处引用都没有）。所以它对他
   *        建的每个智能体都会一直显示"还没挂任何工具"——而"还没"是在许诺一件
   *        界面做不到的事，正是这一轮误解的来源。
   *
   * ★★ **后续（已做完）**：使用者随后定了"不需要挂载，因为我已经移除了此功能"，
   *    于是那条链**整个清掉了**，这一段的"后果"不再是"悬着的事"：
   *      - `Agent.toolIds` 从协议里删除（老数据不用迁移：`Agent` 不是 strict）；
   *      - `PUT /api/agents/:id/tools` 删除；
   *      - `executor.ts` 里"把挂载的脚本送进工作目录"那段与
   *        `syncInjectedTools` / `removeInjectedTools` 一起删除；
   *      - 「工具」页的「被哪些执行者挂载」那一列、以及"卸载被拒"那条分支删除
   *        （卸载现在一律放行——那条拒绝是一把**没有钥匙的锁**：它叫人"去摘掉"，
   *        而摘掉的地方已经不存在了）。
   *
   *    恢复界面入口：把这一段、`{#if editing}` 那个勾选栏，以及上面这一整条链
   *    一起加回来（见 `packages/protocol/src/entities.ts` 里 `Agent` 上那段说明）。
   */
</script>

<form
  class="agent-form"
  onsubmit={(e) => {
    e.preventDefault()
    void save()
  }}
>
  <!--
    ══════════════════════════════════════════════════════════════════
    ★ 2026-10（使用者拍板）：**没有预览页了**——选中即编辑，与智能体组页同款：
    没有 hero 头、没有「编辑」按钮，进来就是一张可编辑的卡片（两列网格，对齐
    「新建私有」），保存 / 取消在底部。查看态那一整套（只读值、chips、老标准
    的详情展示与一键并进按钮）随这次改造一起删了。
    ══════════════════════════════════════════════════════════════════
  -->
  {#if error}
    <div class="notice bad">{error}</div>
  {/if}

  <section class="card agent-card">
    <!-- ★ 角色是智能体比「新建私有」多出的一维（私有表单由槽位决定角色），
         占一整行。 -->
    <div class="cell role-cell">
          <span class="cell-label">{$t('agents.roleLabel')}</span>
          <div class="role-picker">
            <button
              type="button"
              class="role-card"
              class:active={draft.role === 'executor'}
              onclick={() => (draft.role = 'executor')}
            >
              <strong>{$t('agents.roleExecutor')}</strong><span>{$t('agents.roleExecutorHint')}</span>
            </button>
            <button
              type="button"
              class="role-card"
              class:active={draft.role === 'reviewer'}
              onclick={() => (draft.role = 'reviewer')}
            >
              <strong>{$t('agents.roleReviewer')}</strong><span>{$t('agents.roleReviewerHintShort')}</span>
            </button>
          </div>
        </div>

        <label class="cell">
          {$t('agents.nameLabel')}
          <input id="agent-name" bind:value={draft.name} />
        </label>

        <label class="cell">
          {$t('agents.runtimeRowLabel')}
          <select id="agent-runtime" bind:value={draft.runtimeKey}>
            {#each runtimeOptions as key (key)}
              <option value={key}>{key}</option>
            {/each}
            {#if !runtimeOptions.includes(draft.runtimeKey)}
              <!-- 身份还没到（或这个 runtime 已被摘掉）：把当前值显示出来。
                   少了这一支，select 会静默落到第一项 —— 那等于偷偷改了
                   这个 agent 的 runtime。 -->
              <option value={draft.runtimeKey}>{$t('agents.runtimeCurrent', { key: draft.runtimeKey })}</option>
            {/if}
          </select>
          {#if evidenceWarnings[draft.runtimeKey]}
            <p class="row-hint warn">{evidenceWarnings[draft.runtimeKey]}</p>
          {/if}
        </label>

        <label class="cell instructions-cell">
          {$t('agents.instructionsLabel')}
          <!-- ★ 与 `NewAgentForm.svelte` 里那一栏**同一个字段、同一个要求**（D48）：
               指令是一份几百到上千字的文档，不是一行备注。 -->
          <textarea id="agent-instructions" class="instructions" bind:value={draft.instructions} rows="6"></textarea>
          <p class="row-hint">{$t('agents.instructionsHintBefore')}<strong>{$t('agents.instructionsFieldStrong')}</strong>{$t('agents.instructionsHintAfter')}</p>
          {#if legacyStandardPending}
            <!-- ★ 编辑态**只提示**（按钮在只读态，理由见只读态那段注释：搬移会清空
                 `skillIds`，而草稿里还留着旧的那份 ⇒ 保存会把挂载写回去，正文被投递两遍）。 -->
            <p class="row-hint std-legacy" data-standard-merged data-legacy-standard>
              {$t('agents.standardFoldInEditHint')}
            </p>
          {/if}
        </label>

        <div class="cell skills-cell">
          <span class="cell-label">{$t('agents.attachedSkillsLabel')}</span>
          {#if $skills.length === 0}
            <p class="empty-value">{$t('agents.noSkillsYet')}</p>
          {:else if pickableSkills.length === 0}
            <!-- 库非空、但一条都不能挂：不能复用上面那句"还没有任何 skill" -->
            <p class="empty-value">{$t('agents.noSelectableSkills')}</p>
          {:else}
            <div class="skill-picker">
              {#each pickableSkills as s (s.id)}
                <label class="skill-option">
                  <input type="checkbox" value={s.id} bind:group={draft.skillIds} />
                  <span>
                    <!-- ★ 2026-10：技能以**名字**为主显示（与组里「新建私有」同款）。
                         已安装技能的名字常常就是 slug（如 `fireworks-tech-graph`），
                         之前同时印 slug + name 会重复成两个一模一样的东西。slug 只在
                         和名字不同时才作为机器名补充——名字相同的场合它纯属噪音。 -->
                    {s.name}{#if s.name !== s.slug}<code class="skill-slug">{s.slug}</code>{/if}
                    <!-- ★ 同 slug 可以有好几条（每个来源目录各一条）。只显示名字
                         的话选择器里会出现几个一模一样的东西——所以带上它住在哪个目录。 -->
                    {#if s.localDir}
                      <span class="faint small skill-option-from" title={s.localDir}>
                        {$t('agents.skillFromDir', { dir: s.localDir })}
                      </span>
                    {/if}
                  </span>
                </label>
              {/each}
            </div>
          {/if}
        </div>

        {#if draft.role === 'reviewer'}
          <!--
            ⚠️ 2026-10：这里原来有一整段「行动权限」（`ActionPicker`：允许触发的
            动作 + 固定参数 + 调试勾选）。**整个能力从 agent 上撤掉了**——动作属于
            **这条链**（这队人的活判过之后允许做什么），不属于某个审核者个人：同一个
            审核者在不同组里本来就该配不同的权限，挂在人身上只能共用一份。

            唯一权威是 `AgentGroup.allowedActions` / `actionParams` / `debugActions`，
            配的地方是**智能体组页的 ③ 行动**（那里也带同样的选择器）。

            ★ 所以这里只留一句指路，而**不复用那个选择器**：两处长得一模一样、只有
              一处生效，是最坏的一种界面（使用者会在这里勾一遍，然后在组里再勾一遍）。
          -->
          <div class="cell">
            <span class="cell-label">{$t('agents.sectionActions')}</span>
            <p class="row-hint">{$t('agents.actionsMovedToGroup')}</p>
          </div>
        {/if}
  </section>

  <!-- 主操作在底部（与组页同款）：保存 / 删除 / 取消 -->
  <div class="form-actions">
    <button type="submit" class="primary" disabled={busy}>
      {busy ? $t('common.saving') : $t('common.save')}
    </button>
    <button type="button" class="ghost danger" onclick={() => void remove()}>
      {$t('agents.deleteButton')}
    </button>
    <button type="button" class="ghost" onclick={cancelEdit}>{$t('common.cancel')}</button>
  </div>
</form>

<style>
  /* ══════════════════════════════════════════════════════════════════
     布局
     ══════════════════════════════════════════════════════════════════

     ⚠️ 2026-09：**不再设 `max-width`**（原来钉死 52rem）。任务详情那一栏是
     占满右栏的，而智能体详情被那条上限卡在 832px——宽窗口下右栏右侧空出
     一大片（1920 宽实测 400px+），使用者报「主区不满屏」。去掉之后：
        · `.card.agent-card` 的两列网格直接跟着撑满；
        · 长文字（指令 / 提示）由各自的 `46ch` 上限管着，不会拉成整屏长行。
     与任务的详情栏保持同一套行为。

     2026-10：字段区改成一张卡片（两列网格，对齐「新建私有」），不再是
     `.field-row` 的 9rem 定宽 label 表——那套规则随重构一起删掉了。 */
  .agent-form {
    /* 与组表单同款：纵向一列（卡片 → 底部操作），宽度拉通右栏 */
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }

  /* 主操作在底部（与组页同款） */
  .form-actions {
    display: flex;
    gap: var(--sp-2);
    align-items: center;
  }

  /* ── 卡片 + 网格（2026-10：对齐组里「新建私有」的 `.grid-form`）── */



  /**
   * ★ 一张卡片包住全部字段：两列网格，每个字段一格（label 在上、控件在下）。
   *
   * 与 `MemberSlotForm.svelte` 里「新建私有」的 `.grid-form` 同一套布局——
   * 名字 / CLI 一行，指令 / 技能一行；角色（编辑态）与行动权限（审核者）占整行。
   */
  .card.agent-card {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-3);
    align-items: start;
    margin: 0;
    padding: var(--sp-4);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }

  .cell {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    min-width: 0;
  }

  .cell-label {
    font-size: 0.9em;
    color: var(--text-faint);
  }

  /* 角色（编辑态）：占整行 */
  .cell.role-cell {
    grid-column: 1 / -1;
  }

  /* 行动权限（审核者）：占整行（选择器"左选右配"，最需要宽度） */
  .cell.picker-cell {
    grid-column: 1 / -1;
    margin-top: var(--sp-1);
  }

  /* 行动权限的展开/收起（2026-10：与顶栏「列表 / 看板」同款分段轨——
     与组里「选已有的/新建私有」、任务里「智能体/智能体组」同一套样式） */
  .slot-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }

  .slot-source-toggle {
    display: flex;
    align-items: center;
    height: 1.9rem;
    box-sizing: border-box;
    padding: 0 var(--sp-1);
    gap: 2px;
    background: var(--line);
    border-radius: var(--radius);
  }
  .slot-source-toggle button {
    height: 1.5rem;
    padding: 0 var(--sp-3);
    border-radius: var(--radius-sm);
    border: none;
    background: transparent;
    color: var(--text-dim);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    white-space: nowrap;
  }
  .slot-source-toggle button:hover:not(:disabled) {
    background: var(--surface);
    color: var(--text);
  }
  .slot-source-toggle button.active {
    /* ⚠️ 背景用 `--accent-dim` 而不是 `--accent`：暗色主题下 `--accent` 是浅蓝，
       白字配它看不见（与新建任务页的来源切换同款修法）。 */
    background: var(--accent-dim, #2f6fed);
    color: #fff;
  }

  /* ── 值的呈现 ── */

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

  /**
   * 指令输入框：要能读完一份 800 字的角色设定（D48）。
   *
   * 22rem = 352px 是实测值（13px 字号 / 行高 1.6 ⇒ 16 行），与
   * `NewAgentForm.svelte` 里那一份**必须一致**。
   *
   * ⚠️ 两个文件里各有一份这个规则，因为 Svelte 的 `<style>` 默认**不外泄**，
   *    两个组件没法共用一条作用域规则（提到全局 `app.css` 也不对：那里放的是
   *    通用元素样式，不是某一个字段的高度）。所以只能靠注释互相指认。
   */
  .instructions {
    min-height: 22rem;
    line-height: 1.6;
    resize: vertical;
  }

  /* ── 编辑控件 ── */

  /**
   * ★ 技能区：**固定两列**的框内网格（2026-10 起与组里「新建私有」的
   *   `.skill-picker` 同款 —— 列数、间距、框、滚动上限都一样）。原来用
   *   `repeat(auto-fill, minmax(11rem, 1fr))`，窄格子里会自动缩成一列，
   *   使用者要求的就是"两列"，钉死列数。
   */
  .skill-picker {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-1) var(--sp-2);
    max-height: 11rem;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2);
    background: var(--bg);
    text-align: left;
  }

  .skill-option-from { margin-left: var(--sp-1); }

  /* 补充显示的名字之外的机器名：弱化，不抢主显示的存在感 */
  .skill-slug {
    margin-left: var(--sp-1);
    font-size: 0.9em;
    color: var(--text-faint);
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

  /* 原来这里有一组 `.tool-picker / .tool-option / .tool-save` 的规则，给执行者
     详情里那个「可挂载的工具组」勾选栏用。整段撤掉之后一并删了——留着就是给
     不存在的 DOM 写样式。 */

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
