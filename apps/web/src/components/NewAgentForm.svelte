<script lang="ts">
  import { agents, createAgent, identity, skills } from '../lib/stores.ts'
  import type { AgentRole, ReviewStandard } from '../lib/api.ts'
  import ActionPicker from './ActionPicker.svelte'
  import { showToast } from '../lib/view.ts'
  import Drawer from './Drawer.svelte'
  import { t, tx } from '../lib/i18n.ts'

  /**
   * 新建智能体（D28）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 两个字段决定了这个 agent 的"身份"
   * ══════════════════════════════════════════════════════════════════
   *
   * **角色**：它是干活的还是审的。这一个选择取代了原来四个互相牵扯的开关
   * （认哪些 kind、兜底审核者、自动审核、并发上限）——那些合起来表达的
   * 其实只有两件事，而其中两件是通配模式字符串，需要学。
   *
   * **由谁审我**：只在"执行"角色下出现。选一个审核 agent 的名字即可，
   * 不需要理解路由规则。
   *
   * 其余字段（skill、runtime、工作目录）是"这个 agent 怎么干活"，
   * 各自独立，不参与身份判断。
   */
  /**
   * ══════════════════════════════════════════════════════════════════
   * 受控组件 + **右侧抽屉**：开关由父组件拿着，内容画在抽屉里
   * ══════════════════════════════════════════════════════════════════
   *
   * 这个表单在左栏里待过两版，都不行：
   *
   *   1. 挂在按钮旁边（组件自己管开关）⇒ 它俩必然在同一个容器里，而那个容器
   *      是 416px 宽的头部行；表单按 `max-width: 46rem` 画成 736px，横着盖住
   *      右栏、头部涨到 1070px、清单被顶出视口；
   *   2. 放进左栏正文 ⇒ 不溢出了，但**太窄**：技能多选、runtime、工作目录挤在
   *      358px 里，读起来憋。
   *
   * 现在它是右侧抽屉（**58rem = 928px**，D48 之前是 46rem）：浮在主从布局
   * 上面、不动清单，关掉就回到原地。字段宽度交给抽屉，不写死。
   *
   * ⚠️ 为什么是 58rem 而不是与「安装 skill」同宽的 46rem：这个抽屉里要**写**
   *    一份 800 字的指令，46rem 的正文只有 686px、一行放 50 个中文字，读起来
   *    一直在滚（见 D48）。宽度按**内容**选，不是按"大小档次"。
   */
  export let open = false
  export let onclose: () => void = () => {}
  export let oncreated: () => void = () => {}

  let name = ''
  let role: AgentRole = 'executor'
  let instructions = ''
  /**
   * 审核标准（D37）——只对审核者有意义。
   *
   * 与「第一句话模版」那个全局配置不同，标准是**每个审核者一份**（不同的领域
   * 用不同的标准，这是 D22 的立场）。执行者保持 `null`。
   */
  let reviewStandard: ReviewStandard | null = null
  /**
   * 行动权限（D40 收口）——同样**只对审核者有意义**，执行者保持空数组。
   *
   * ★ 初值是**空数组**（D41：内置动作整组移除之后，预勾那一档随之作废）。
   *
   *   这里原来预勾 `comment.create`（"最小权限里至少能留下一条评论"）。那个动作名
   *   现在根本不是动作了——动作**只能**来自装进来的工具包（`<包 slug>.<动作名>`），
   *   而"装了哪个包、包里有哪些动作"是使用者自己的事：平台替他勾一个，勾的要么是
   *   不存在的名字，要么是某个他没打算授权的包。所以默认回到空——这也正是协议
   *   schema 的默认值（"允许什么"必须由使用者说了算）。
   *
   *   ⚠️ 一个工具包都没装时，这一栏显示的是明确的空态（见 `ActionPicker.svelte`），
   *      而不是一片空白。
   *
   * ⚠️ 详情页的编辑初值取 agent 自己的值（`effectiveAllowedActions()`）——
   *   与这里的空数组是同一件事的两面：谁也不替使用者加权限。
   */
  let allowedActions: string[] = []
  /**
   * 调试动作（2026-09）：标了「调试」的那些——是 `allowedActions` 的**子集**，
   * 只对审核者有意义（服务端会校验子集）。
   */
  let debugActions: string[] = []
  /**
   * 动作的固定参数（D43）：与 `allowedActions` 同一档（只对审核者有意义）。
   * 初值是空对象——"谁也不替使用者钉值"，与"谁也不替使用者加权限"同一件事。
   */
  let actionParams: Record<string, Record<string, unknown>> = {}
  let selectedSkills: string[] = []
  let reviewerAgentId = ''
  /**
   * 可选的 runtime —— 从**身份接口**来，不写死两项。
   *
   * 写死的话，新加一个 runtime 之后这个表单里根本选不到它（只有直接调接口
   * 才行）。初始化取第一个可用项，而不是硬编码 'claude'。
   */
  $: runtimeOptions = $identity?.runtimes.map((r) => r.key) ?? []
  let runtimeKey = 'claude'
  let workDir = ''
  let busy = false
  let error = ''

  // 只有"审核"角色才谈得上"由谁审我"
  $: reviewers = $agents.filter((a) => a.role === 'reviewer')


  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    error = ''
    busy = true
    try {
      await createAgent({
        name,
        role,
        instructions,
        skillIds: selectedSkills,
        reviewerAgentId: role === 'executor' && reviewerAgentId ? reviewerAgentId : null,
        runtimeKey,
        workDir,
        reviewStandard: role === 'reviewer' ? reviewStandard : null,
        // 执行者一律空数组（服务端对"执行者带动作"是 400——执行者的能力是工具）
        allowedActions: role === 'reviewer' ? allowedActions : [],
        // 固定参数同理：只送审核者的那份，且只送**勾上的动作**的参数（没勾的
        // 没有落点；服务端按已装工具校验会放行，但那份固定参数永远不会被用上）
        actionParams:
          role === 'reviewer'
            ? Object.fromEntries(
                allowedActions
                  .filter((a) => actionParams[a] && Object.keys(actionParams[a]).length > 0)
                  .map((a) => [a, { ...actionParams[a] }]),
              )
            : {},
        // 调试同理：只送审核者的那份，且只送**勾上了的**（子集）
        debugActions:
          role === 'reviewer' ? debugActions.filter((a) => allowedActions.includes(a)) : [],
      })
      name = ''
      instructions = ''
      reviewStandard = null
      // 回到表单的默认值：动作权限**是空的**（D41：没有内置动作可预勾了）
      allowedActions = []
      debugActions = []
      actionParams = {}
      selectedSkills = []
      reviewerAgentId = ''
      workDir = ''
      role = 'executor'
      showToast(tx('agents.created'))
      // 关不关由父组件决定（它是"正在新建"这个状态的持有者）
      oncreated()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }
</script>

{#if open}
  <Drawer
    {open}
    size="wider"
    title={$t('agents.newTitle')}
    subtitle={$t('agents.newSubtitle')}
    {onclose}
  >
  <form onsubmit={submit} class="agent-form" id="new-agent-form">

    <label>
      {$t('agents.nameLabel')}
      <input bind:value={name} placeholder={$t('agents.namePlaceholder')} required autocomplete="off" />
    </label>

    <!-- 角色：用两个大按钮而不是下拉或单选圆圈——这是一个"选边"的决定，
         值得占视觉重量；下拉会让人一扫而过 -->
    <div class="field">
      <span class="field-label">{$t('agents.roleFieldLabel')}</span>
      <div class="role-picker">
        <button
          type="button"
          class="role-card"
          class:active={role === 'executor'}
          onclick={() => (role = 'executor')}
        >
          <strong>{$t('agents.roleExecutor')}</strong>
          <span>{$t('agents.roleExecutorHint')}</span>
        </button>
        <button
          type="button"
          class="role-card"
          class:active={role === 'reviewer'}
          onclick={() => (role = 'reviewer')}
        >
          <strong>{$t('agents.roleReviewer')}</strong>
          <span>{$t('agents.roleReviewerHint')}</span>
        </button>
      </div>
    </div>

    {#if role === 'executor'}
      <label>
        {$t('agents.reviewerFieldLabel')}
        {#if reviewers.length === 0}
          <select disabled><option>{$t('agents.noReviewerOption')}</option></select>
          <span class="hint">
            {$t('agents.noReviewerHint')}
          </span>
        {:else}
          <select bind:value={reviewerAgentId}>
            <option value="">{$t('agents.noAutoReview')}</option>
            {#each reviewers as r (r.id)}
              <option value={r.id}>{r.name}</option>
            {/each}
          </select>
          <span class="hint">
            {$t('agents.reviewerHint')}
          </span>
        {/if}
      </label>
    {/if}

    <label>
      {$t('agents.instructionsLabel')}
      <!--
        ★ 指令是**一份文档**，不是一行备注（D48）。

        它原来是 `rows="3"`（约 3 行 / **150 字**），而实际写进去的是几百到上千字
        的角色设定 —— 使用者的原话是"至少要能方便预览 800 字文章"。

        ⚠️ `rows` 只是**没有 CSS 时的兜底**，真正的高度下限在下面
           `.instructions` 的 `min-height: 22rem`。
           （原来这里写的是 `rows="16"` + `min-height: 20rem`，而 `rows="16"`
             本身就有 350.8px，比 20rem = 320px **更高**——于是那条 min-height
             一个字都没生效，注释说的和代码做的正好相反。`rows="6"` 让它退回
             兜底的位置，`22rem` 才真的说了算。）
      -->
      <textarea
        class="instructions"
        bind:value={instructions}
        rows="6"
        placeholder={role === 'reviewer'
          ? $t('agents.instructionsPlaceholderReviewer')
          : $t('agents.instructionsPlaceholderExecutor')}
      ></textarea>
      <span class="hint">
        {$t('agents.instructionsHintBefore')}<strong>{$t('agents.instructionsFieldStrong')}</strong>{$t('agents.instructionsHintAfter')}
      </span>
    </label>

    {#if role === 'reviewer'}
      <!--
        ★ 2026-09：「标准」并进上面的「指令」，不再单独设置（使用者的决定）。
        D40 收口：行动权限仍然是审核者的**另一个**字段。
        所以这一栏只剩行动权限——判断依据写在上面的「指令」里。
      -->
      <p class="hint" data-standard-merged>{$t('agents.standardMergedHint')}</p>

      <div class="field">
        <span class="field-label">{$t('agents.sectionActions')}</span>
        <ActionPicker
          value={allowedActions}
          onchange={(next) => {
            allowedActions = next
            // ★ 调试是允许的子集：允许里摘掉的动作，调试一起摘
            debugActions = debugActions.filter((a) => next.includes(a))
          }}
          params={actionParams}
          onparams={(next) => (actionParams = next)}
          debug={debugActions}
          ondebug={(next) => (debugActions = next)}
        />
      </div>
    {/if}

    <label>
      {$t('agents.attachedSkillsLabel')}
      {#if $skills.length === 0}
        <select disabled><option>{$t('agents.noSkillsOption')}</option></select>
      {:else}
        <div class="skill-picker">
          {#each $skills as s (s.id)}
            <label class="skill-option">
              <input type="checkbox" value={s.id} bind:group={selectedSkills} />
              <span><code>{s.slug}</code> <span class="faint small">{s.name}</span></span>
            </label>
          {/each}
        </div>
      {/if}
      {#if role === 'reviewer'}
        <span class="hint">
          {$t('agents.reviewerSkillsHintBefore')}<strong>{$t('agents.instructionsLabel')}</strong>{$t('agents.reviewerSkillsHintAfter')}
        </span>
      {:else}
        <span class="hint">{$t('agents.executorSkillsHint')}</span>
      {/if}
    </label>

    <div class="row">
      <label>
        {$t('agents.runtimeFieldLabel')}
        <select bind:value={runtimeKey}>
          {#each runtimeOptions as key (key)}
            {@const r = $identity?.runtimes.find((x) => x.key === key)}
            <option value={key}>
              {key}{r && r.evidence !== 'verified' ? $t('agents.runtimeUnverified') : ''}
            </option>
          {/each}
          {#if !runtimeOptions.includes(runtimeKey)}
            <option value={runtimeKey}>{$t('agents.runtimeCurrent', { key: runtimeKey })}</option>
          {/if}
        </select>
      </label>
      <label>
        {$t('agents.workDirLabelOptional')}
        <input bind:value={workDir} placeholder={$t('agents.workDirPlaceholder')} />
      </label>
    </div>

  </form>

    <!-- 主操作常驻底部：表单很长，正文一长就不该让人先滚到底才能按 -->
    <svelte:fragment slot="foot">
      <button
      type="submit"
      form="new-agent-form"
      disabled={busy || !name.trim()}
      title={busy || !name.trim() ? $t('agents.createNeedsName') : undefined}
    >
        {busy ? $t('common.creating') : $t('common.create')}
      </button>
      <button
        type="button"
        class="secondary"
        onclick={onclose}
        disabled={busy}
        title={busy ? $t('common.busyHint') : undefined}
        >{$t('common.cancel')}</button
      >
      {#if error}
        <!-- ★ 与其它页面的保存失败同一呈现（`.notice bad`）：
             原来是脚注里一行行内小字，与别处的错误提示长得不一样。 -->
        <div class="notice bad">{error}</div>
      {/if}
    </svelte:fragment>
  </Drawer>
{/if}

<style>
  /**
   * ⚠️ 这里曾经有一个 `max-width: 46rem`：它在 416px 宽的 flex 行里不会收缩，
   *    于是把表单画成 736px、横着盖住右栏。现在**宽度由抽屉决定**，
   *    这里只管排版（外面有 `.drawer-body` 的 padding）。
   */
  .agent-form {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }


  /**
   * 指令输入框：要能读完一份 800 字的角色设定（D48）。
   *
   * ★ 为什么高度写成 `min-height` 的 rem，而不是靠 `rows`：
   *   `rows` 是**行数**，它的像素高度随字号和行高变；而"能不能读完 800 字"是
   *   个长度问题。写成 rem 之后它锚在长度上。
   *
   * ★ 22rem = 352px 是**实测**出来的（不是估的）：当前 13px 字号、行高 1.6
   *   ⇒ 每行 20.8px ⇒ 框内可见 **16 行**；`wider` 抽屉正文 854px ⇒ 每行 **65**
   *   个中文字 ⇒ 一屏 **1040 字**。要求是 800 字，留了约 30% 余量——窗口比
   *   1440px 窄时一行装的字会变少，那点余量就是给这种情况的。
   *
   * ⚠️ 不要用 `height`：`resize: vertical` 拖出来的高度是**行内样式**，它会
   *    盖掉样式表里的 `height`，看起来"拖了没用"；而 `min-height` 只挡下限，
   *    往上拖永远有效。（代价是拖不到 22rem 以下——那正是这个下限的意思。）
   *    `FirstSentenceTemplate.svelte` 里那个模版框关掉了 `resize`，因为它由
   *    `autosize()` 按内容算高度，手动拖会被下一次输入覆盖回去。
   */
  .instructions {
    min-height: 22rem;
    line-height: 1.6;
    resize: vertical;
  }

  .field-label {
    display: block;
    font-size: var(--fs-sm);
    color: var(--text-dim);
    margin-bottom: var(--sp-1);
  }

  /**
   * 两张角色卡在 416px 的栏里并排只剩 ~150px 一张（说明文字会挤成几行），
   * 所以按容器宽度自动决定：宽了并排、窄了竖着——同一个 `auto-fit` 套路。
   */
  .role-picker {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
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

  .role-card strong { color: var(--text); font-size: var(--fs-md); }
  .role-card span { font-size: var(--fs-xs); color: var(--text-faint); }

  .role-card.active {
    border-color: var(--accent);
    background: var(--surface-2);
  }

  .role-card.active strong { color: var(--accent); }

  /**
   * 两列字段（runtime / 工作目录）按**容器**宽度决定列数：宽了并排、窄了一列。
   * 用 `auto-fit` + `minmax` 而不是媒体查询——这个表单待在抽屉里，抽屉宽度
   * 与视口宽度不是一回事。
   */
  .row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--sp-3);
  }

  .skill-picker {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
    gap: var(--sp-1);
    margin-top: var(--sp-2);
    max-height: 12rem;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2);
    background: var(--bg);
  }

  .skill-option { display: flex; align-items: center; gap: var(--sp-2); margin: 0; cursor: pointer; }
  .skill-option input { width: auto; }
</style>
