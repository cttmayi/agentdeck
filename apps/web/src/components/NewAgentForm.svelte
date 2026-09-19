<script lang="ts">
  import { agents, createAgent, identity, skills } from '../lib/stores.ts'
  import type { AgentRole, ReviewStandard } from '../lib/api.ts'
  import ReviewStandardEditor from './ReviewStandardEditor.svelte'
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
   * 现在它是右侧抽屉（46rem = 736px，与「安装 skill」同宽）：浮在主从布局
   * 上面、不动清单，关掉就回到原地。字段宽度交给抽屉，不写死。
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
      })
      name = ''
      instructions = ''
      reviewStandard = null
      // 回到表单的默认值：动作权限**是空的**（D41：没有内置动作可预勾了）
      allowedActions = []
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
    wide
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
      <textarea
        bind:value={instructions}
        rows="3"
        placeholder={role === 'reviewer'
          ? $t('agents.instructionsPlaceholderReviewer')
          : $t('agents.instructionsPlaceholderExecutor')}
      ></textarea>
      <span class="hint">
        {$t('agents.instructionsHintBefore')}<code>{'{{instructions}}'}</code>{$t('agents.instructionsHintAfter')}
      </span>
    </label>

    {#if role === 'reviewer'}
      <!--
        D37：标准是审核者的判断依据，写在它自己身上。
        D40 收口：行动权限是审核者的**另一个**字段（原来它长在标准那一栏里）。
        两件事分开："按什么判"是上面那一栏，"判完允许动什么"是下面那一栏。

        ⚠️ **别写 `bind:value={...}`**：Svelte 5 里组件的 `bind:` 不是"子组件调了
           `onchange` 就算"——父组件拿到的那个 setter 只会在**子组件写自己的 prop**
           时被调用，而这两个编辑器只抛 `onchange`（它们是受控组件，`value` 只读）。
           于是 `bind:value` 会是一条**空绑定**：抽屉里写得满满当当，父组件一个字
           都没收到，创建出来的审核者**没有标准、没有行动权限**，而界面上一切正常。
           （这不是推理：探针里那一条"写下正文后状态徽章变「已写」"就是被它红过的
           ——D37 起这一行一直是 `bind:value`。）所以这里显式传 `onchange`，
           与 `AgentDetail.svelte` 用的是同一个写法。
      -->
      <ReviewStandardEditor
        value={reviewStandard}
        onchange={(next) => (reviewStandard = next)}
      />

      <div class="field">
        <span class="field-label">{$t('agents.sectionActions')}</span>
        <ActionPicker
          value={allowedActions}
          onchange={(next) => (allowedActions = next)}
          params={actionParams}
          onparams={(next) => (actionParams = next)}
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
          {$t('agents.reviewerSkillsHintBefore')}<strong>{$t('agents.standardLabel')}</strong>{$t('agents.reviewerSkillsHintAfter')}
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
      <button type="submit" form="new-agent-form" disabled={busy || !name.trim()}>
        {busy ? $t('common.creating') : $t('common.create')}
      </button>
      <button type="button" class="secondary" onclick={onclose} disabled={busy}>{$t('common.cancel')}</button>
      {#if error}
        <span class="bad small">{error}</span>
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

  .field { margin-bottom: var(--sp-3); }

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
