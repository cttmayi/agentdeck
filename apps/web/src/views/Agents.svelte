<script lang="ts">
  import { onDestroy } from 'svelte'
  import {
    agents,
    effectiveDefaultAgentId,
    identity,
    loadAgents,
    loadIdentity,
    loading,
    loadError,
    setDefaultAgent,
  } from '../lib/stores.ts'
  import MainArea from '../components/MainArea.svelte'
  import NewAgentForm from '../components/NewAgentForm.svelte'
  import WorkspaceSettings from '../components/WorkspaceSettings.svelte'
  import ListPane from '../components/ListPane.svelte'
  import ListRow from '../components/ListRow.svelte'
  import AgentDetail from '../components/AgentDetail.svelte'
  import type { Agent } from '../lib/api.ts'
  import { clearPageActions, setPageActions } from '../lib/page-actions.ts'
  import { t } from '../lib/i18n.ts'
  import { listGrip } from '../lib/list-grip.ts'

  /**
   * 智能体视图 = agent 配置 + runtime 状态。
   *
   * ══════════════════════════════════════════════════════════════════
   * 布局：与「任务清单」同一套主从（列表 | 详情）
   * ══════════════════════════════════════════════════════════════════
   *
   * 原来点一个 agent 会把整页换成详情（列表消失），返回要靠详情里那个
   * 「← 智能体列表」。同一件事在任务页已经是"左列表右详情"了，两个页面对
   * 同一个动作给出两种反应是没有道理的——所以这里改成共用 `.split-layout`
   * （那套 CSS 本来就是按"两个视图共用"写的，连详情里返回按钮的隐藏规则
   * 都已经按 `.back` 写好了）。
   *
   * 页级信息（Runtime 概览、环境问题）留在**列表那一栏**：它们在改版前就是
   * "列表下面的一段"，放进左栏是原样搬运；而右栏保持"选中的那个 agent"
   * 这一件事，语义不混。窄屏下左栏会被详情顶掉，返回即可见——这与任务的
   * 行为一致。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么 runtime 放这里而不是单独一栏
   * ══════════════════════════════════════════════════════════════════
   *
   * agent 跑在哪个 runtime 上是它**配置的一部分**，两个概念分开看会让人
   * 对不上号——"这个 agent 到底用的哪个 CLI"变成要去另一页拼。侧边栏则
   * 保持只有四项。
   *
   * ══════════════════════════════════════════════════════════════════
   * 证据等级与版本判定**必须显示**
   * ══════════════════════════════════════════════════════════════════
   *
   * `provisional` 的 runtime 与实测过的可信度完全不同；`undeclared` 的
   * 版本范围意味着"我们没验证过任何版本"。把这些藏起来，使用者就会以为
   * 它们一样可信——那正是这个项目反复在防的那类"把不确定说成确定的"。
   */
  /** 当前点开查看的 agent。null = 还没有选（右栏显示占位）。 */
  let selectedId: string | null = null
  /**
   * 页面级动作失败（现在只有「设为默认」）。
   *
   * ★ 必须写出来：原来那里是裸 `void setDefaultAgent(a.id)`，失败时客户端拿到的
   *   是一个 **unhandled rejection**、界面上毫无反应——而"设为默认"失败的样子
   *   与成功**一模一样**（徽标不动），使用者会以为已经设上了。
   */
  let actionError = ''
  $: selected = $agents.find((a) => a.id === selectedId) ?? null

  /**
   * 正在新建（D32 修）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这个状态为什么要提到视图这一层
   * ══════════════════════════════════════════════════════════════════
   *
   * 原来「新建智能体」那个按钮**自己**管着"开不开"，表单就渲染在它旁边——
   * 而它在左栏的 `pane-head` 里。于是表单被塞进一个 416px 宽的头部行：
   * 实测表单是 736px（横着盖住右栏）、头部从 167px 涨到 1070px、agent 清单
   * 被顶到视口外。**"新建"这个动作把一个主从布局整垮了。**
   *
   * 现在按钮在头部（位置不变），表单在它下面的正文里（`pane-body`）。
   * 两处联动 ⇒ 状态放在这里，两边都只是渲染。
   */
  let creating = false

  /**
   * 栏头带的搜索（D62）：与任务页列表模式同款。只过滤**名称与指令**——
   * 关系（审核者是谁、几个技能）是次要信息，搜它反而容易找不到想要的。
   */
  let filter = ''
  /**
   * 角色徽标的文案与样式。
   *
   * ★ 分批第 268 批：从模板里的 `{@const}` 提到这里——行体要抽成 snippet 给**两组**
   *   各渲染一次（内置一组、自建一组），而 `{@const}` 不能住在 snippet 里。
   *
   * ⚠️ 判据是**角色**，不是名字/是否内置（2026-10 D81/D82 的教训）：名字使用者能改，
   *    角色不能；按 `reviewer ? 审核 : 执行` 写会让内置起草者被标成「执行」——一个永远
   *    不接任务的 agent 看起来像执行者，使用者会去问"它为什么不干活"。
   */
  function roleLabelOf(a: Agent): string {
    if (a.role === 'reviewer') return $t('agents.roleReviewer')
    if (a.role === 'drafter') return $t('agents.roleDrafter')
    if (a.role === 'skill-reviewer') return $t('agents.roleSkillReviewer')
    if (a.role === 'memory-tidy') return $t('agents.roleMemoryTidy')
    return $t('agents.roleExecutor')
  }
  function roleBadgeOf(a: Agent): string {
    return a.role === 'reviewer' || a.role === 'skill-reviewer' ? 'in_review' : 'in_progress'
  }

  $: visibleAgents = $agents.filter((a) => {
    if (!filter.trim()) return true
    const q = filter.trim().toLowerCase()
    return (
      a.name.toLowerCase().includes(q) || a.instructions.trim().toLowerCase().includes(q)
    )
  })

  /**
   * ★ 分批第 268 批（使用者："期待分组，将『内置』分成一直，其他分成组"）：左栏按
   *   **内置 / 自建** 归堆。组名是使用者定的（「内置」「自建」），顺序也是他定的
   *   （内置在上、自建在下）。
   *
   * ⚠️ **分组只归堆，不改组内顺序**：组里仍然沿用原来的顺序（服务端给的顺序 = 最近改过
   *    的在上面）。若拿分组顺带排序，使用者会失去"我刚改过的那条去哪了"的线索。
   * ⚠️ 判据是 `builtin === true`（协议字段），**不是名字**：名字使用者能改（起草者可以改名），
   *    而内置标记是平台写的。
   */
  $: builtinAgents = visibleAgents.filter((a) => a.builtin === true)
  $: ownAgents = visibleAgents.filter((a) => a.builtin !== true)
  /**
   * 折叠状态：**内置默认收拢、自建默认展开**（使用者定的）。
   *
   * ⚠️ 搜索时**无视折叠**（下面 `showBuiltin`/`showOwn` 里判）：搜出来 3 条却被折叠藏住，
   *    人只会以为"搜索坏了"。
   */
  let builtinOpen = false
  let ownOpen = true
  $: filtering = filter.trim() !== ''
  $: showBuiltin = builtinAgents.length > 0 && (builtinOpen || filtering)
  $: showOwn = ownAgents.length > 0 && (ownOpen || filtering)
  /**
   * ⚠️ 选中的那条如果正好在**收起来的组**里，界面上就"选中项不见了"——而右栏还在显示它。
   *    所以那个组的标题上要留一句"选中在这里"（不是替使用者展开：他收起来是故意的）。
   */
  $: selectionInBuiltin =
    !showBuiltin && builtinAgents.some((a) => a.id === selectedId)
  $: selectionInOwn = !showOwn && ownAgents.some((a) => a.id === selectedId)

  /**
   * 打开「设置」（右侧抽屉）。
   *
   * ★ 里面装的是**平台行为**的设置：现在有"第一句话模版"（D32，通用配置——
   *   一次设定、所有 agent 生效），以后还会有别的。入口放在这一页的「新建」
   *   旁边——按使用者的说法："智能体的设置…应该在'新建'附近"。
   *
   * ⚠️ 两个抽屉互斥：同时开两个的话遮罩会叠在一起，Esc 也不知道该关哪个。
   */
  let settingsOpen = false

  /**
   * 环境预检的问题。
   *
   * ⚠️ 这里必须写全可选链：`environment` 是可选字段，而模板里的类型流
   *    与普通代码不同——svelte-check 会如实报出来，tsc 根本看不到这些行。
   */
  $: envIssues = $identity?.environment?.issues ?? []

  function refresh(): void {
    void Promise.all([loadAgents(), loadIdentity()])
  }

  /**
   * 顶栏那一排动作（机制见 `lib/page-actions.ts`）。
   *
   * ⚠️ 写在 `$:` 里并读 `$t(...)`：语言一变就重新登记一遍（整体覆盖，不是追加）。
   * ⚠️ `disabled` 也要跟着状态走：新建面板开着时不该还能点「新建」（原来是靠
   *    就地渲染的按钮上那个 `disabled` 属性，搬家之后必须一起搬）。
   * ⚠️ 卸载时收回来（登记里存的是抓着这一页状态的闭包）。
   *
   * ★ 三个按钮的权重：**新建是这一页的主线**（`primary`），设置与刷新是配套
   *   动作（`secondary`）。
   */
  $: setPageActions('agents', [
    {
      id: 'new',
      /*
       * ★ 复用**它打开的那个面板的标题**（`agents.newTitle`），不另立一条按钮词条：
       *   2026-10 使用者要求按钮从「新建」改成「新建智能体」——而抽屉标题早就是
       *   「新建智能体」，两处一直各写一份、于是按钮与它打开的面板说的不是一句话。
       *   合成一条之后，"同一句话只有一个出处"这件事在界面上看得见（任务页那条
       *   `shell.navNewTask` 是同一个做法）。
       */
      label: $t('agents.newTitle'),
      kind: 'primary',
      icon: 'plus',
      disabled: creating,
      onActivate: () => {
        creating = true
        settingsOpen = false
        selectedId = null
      },
    },
    {
      id: 'settings',
      label: $t('agents.settingsButton'),
      kind: 'secondary',
      title: $t('agents.settingsTitle'),
      /**
       * ★ 295 批：设置从右抽屉搬进**主区面板** ⇒ 这颗按钮变成**开关**：
       *   再点一次就回到刚才那个智能体（原来它是 `disabled: settingsOpen`，
       *   而抽屉自己有关闭按钮，不需要它当开关）。
       */
      onActivate: () => {
        settingsOpen = !settingsOpen
        if (settingsOpen) {
          creating = false
          selectedId = null
        }
      },
    },
    {
      id: 'refresh',
      label: $t('common.refresh'),
      kind: 'secondary',
      icon: 'refresh',
      onActivate: refresh,
    },
  ])
  onDestroy(() => clearPageActions('agents'))
</script>

<!--
  ★ 页头导语（D63 去掉）：原来是「这里配置每个智能体：它的指令、行动权限，以及
  由谁来审它。」（`agents.headIntro`）——它与技能页/工具页同款。2026-10 使用者
  点名去掉：这句是在复述下面每一条卡片已经在说的话（指令 / 行动权限 / 审核者都在
  卡片与详情里），而顶栏页名 + 栏头带已经把"这一页是什么"说清了。技能页/工具页
  保留自己的导语（它们没有别的地方说那一句）；这一页删。
-->

<div
  class="split-layout"
  class:with-detail={creating || selected !== null}
  data-list-key="agents"
  data-list-label={$t('shell.resizeList')}
  use:listGrip
>
  <!-- ══════════════════ 左栏：智能体清单 + Runtime ══════════════════ -->
  <!--
    ⚠️ 左栏从"没有栏头"（2026-09）到 D62 加回一条与任务/智能体同款的
    「计数 + 搜索」栏头带（栏头里**没有标题**——它与顶栏页名一字不差；
    规则：栏标题 ≠ 页名才放标题）。D66：整栏（栏头带 + 五态壳）收进标准
    控件 ListPane，这一页只给内容 snippet。
  -->
  <ListPane
    countLabel={$t('agents.listCount', { count: visibleAgents.length })}
    searchPlaceholder={$t('agents.search')}
    filter={filter}
    onFilter={(v) => (filter = v)}
    loading={($loading['agents'] && $agents.length === 0) ?? false}
    loadError={$loadError['agents'] ?? null}
    empty={$agents.length === 0}
    emptyTitle={$t('agents.emptyTitle')}
    emptyHint={$t('agents.emptyHint')}
    emptyFiltered={visibleAgents.length === 0}
    emptyFilteredTitle={$t('agents.emptyFiltered')}
    emptyFilteredHint={$t('agents.emptyFilteredHint')}
  >
    {#snippet top()}
      {#if envIssues.length > 0}
        <!--
          环境预检的问题要显示出来。它最常见的形态是"CLI 自己的状态目录写不进去"，
          而那个错误在 agent 输出里长得像"工作目录没建成功"——**指向完全错误的
          方向**。放在列表上方（而不是藏在某个详情里）比让使用者去猜便宜得多。
        -->
        <section class="env-issues">
          <h3 class="warn">{$t('agents.envIssuesTitle')}</h3>
          {#each envIssues as issue}
            <div class="notice warn stack">
              <strong>{issue.summary}</strong>
              <span>{issue.action}</span>
            </div>
          {/each}
        </section>
      {/if}
    {/snippet}
    {#snippet loadingSkeleton()}
      <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
      <div class="skeleton" style="width:60%"></div>
    {/snippet}
    {#snippet readyTop()}
      <!-- ★ 「设为默认」失败要看得见：列表就在下面，错误在它上面一行 -->
      {#if actionError}
        <div class="notice bad">{actionError}</div>
      {/if}
    {/snippet}
    <!--
      ★ 分批第 268 批：**按「内置 / 自建」分组**（使用者定：内置在上、默认收拢；自建在下、
        默认展开；标题后面留一句小字）。

      为什么行体抽成 snippet 而不是复制两份：这一行有 100 多行内容（名字、角色徽标、
      「设为默认」按钮、指令摘要、技能与记忆条数）。复制一份的后果不是"多几行代码"，
      而是**两处会漂**——比如以后给内置那组加"不能删"的提示，另一组忘了加。
    -->
    {#snippet rows()}
      {#snippet agentRow(a: Agent)}
        <ListRow
          rowClass="agent-row"
          active={a.id === selectedId}
          onclick={() => {
            selectedId = a.id
            // ★ 2026-10：新建表单住在右栏了——点清单行就退出"正在新建"
            //   （不然右栏同时想画两样东西）。
            creating = false
          }}
        >
          {#snippet children()}
            <span class="agent-line">
              <strong>{a.name}</strong>
              <span class="badge {roleBadgeOf(a)}">{roleLabelOf(a)}</span>
              <!--
                ⚠️ 这里原来有一个「未挂 skill」徽标，2026-10 删了：它写下的那句话
                   已经不是真的（审核者不挂 skill 也能审）。
              -->
              {#if a.id === $effectiveDefaultAgentId}
                <!-- 新建任务的默认选择是谁，必须在列表上看得见 -->
                <span class="badge default-badge">{$t('agents.defaultBadge')}</span>
              {/if}
            </span>
            <span class="agent-notes faint fs-xs">
              <span class="agent-notes-trunc">
                {a.instructions.trim()
                  ? a.instructions.slice(0, 48) + (a.instructions.length > 48 ? '…' : '')
                  : $t('agents.noInstructions')}
              </span>
              <span class="agent-notes-meta">
                {#if a.role === 'reviewer'}{$t('agents.reviewsOthers')}{/if}{$t('agents.skillCount', { count: a.skillIds.length })}
                <!-- ★ 记忆条数（0 条不画——空着的时候没有任何信息） -->
                {#if (a.memoryCount ?? 0) > 0}
                  <span class="mem-count" data-agent-memory-count
                    >{$t('agents.memoryCountInline', { n: String(a.memoryCount) })}</span
                  >
                {/if}
                <code>{a.runtimeKey}</code>
              </span>
            </span>
          {/snippet}
          {#snippet action()}
            <!--
              ★ 「默认」是**单选**：每个 agent 一个「设为默认」，点谁就是谁。
                **没有「取消默认」**：必须有一个默认（使用者的要求）。
                只对执行者给出这个动作——审核者不接任务（服务端也会拒）。
            -->
            {#if a.role === 'executor' && a.id !== $effectiveDefaultAgentId}
              <button
                type="button"
                class="btn btn--ghost btn--sm default-toggle"
                title={$t('agents.setDefaultTitle')}
                onclick={(e) => {
                  e.stopPropagation()
                  void (async () => {
                    actionError = ''
                    try {
                      await setDefaultAgent(a.id)
                    } catch (err) {
                      actionError = err instanceof Error ? err.message : String(err)
                    }
                  })()
                }}
              >
                {$t('agents.setDefault')}
              </button>
            {/if}
          {/snippet}
        </ListRow>
      {/snippet}
      <ul class="agent-list">
        {#if builtinAgents.length > 0}
          <li class="agent-group-head-wrap">
            <button
              type="button"
              class="agent-group-head"
              data-agent-group="builtin"
              aria-expanded={showBuiltin}
              onclick={() => (builtinOpen = !builtinOpen)}
            >
              <span class="chev" aria-hidden="true">{showBuiltin ? '▾' : '▸'}</span>
              <span class="agent-group-name">{$t('agents.groupBuiltin')}</span>
              <span class="faint">{builtinAgents.length}</span>
              <span class="spacer"></span>
              <!-- ★ 选中项被收起来时留一句话：右栏还在显示它，列表里却"不见了" -->
              {#if selectionInBuiltin}
                <span class="faint fs-xs" data-group-selected-hint
                  >{$t('agents.groupSelectionHere')}</span
                >
              {:else}
                <span class="faint fs-xs">{$t('agents.groupBuiltinHint')}</span>
              {/if}
            </button>
          </li>
          {#if showBuiltin}
            {#each builtinAgents as a (a.id)}
              {@render agentRow(a)}
            {/each}
          {/if}
        {/if}

        {#if ownAgents.length > 0}
          <!-- ⚠️ 两组之间那条分隔线只画在"上面那组真有东西"时，否则列表顶部会多一条悬空的线 -->
          <li class="agent-group-sep" class:with-builtin={builtinAgents.length > 0}></li>
          <li class="agent-group-head-wrap">
            <button
              type="button"
              class="agent-group-head"
              data-agent-group="own"
              aria-expanded={showOwn}
              onclick={() => (ownOpen = !ownOpen)}
            >
              <span class="chev" aria-hidden="true">{showOwn ? '▾' : '▸'}</span>
              <span class="agent-group-name">{$t('agents.groupOwn')}</span>
              <span class="faint">{ownAgents.length}</span>
              <span class="spacer"></span>
              {#if selectionInOwn}
                <span class="faint fs-xs" data-group-selected-hint
                  >{$t('agents.groupSelectionHere')}</span
                >
              {:else}
                <span class="faint fs-xs">{$t('agents.groupOwnHint')}</span>
              {/if}
            </button>
          </li>
          {#if showOwn}
            {#each ownAgents as a (a.id)}
              {@render agentRow(a)}
            {/each}
          {/if}
        {/if}
      </ul>
    {/snippet}
    {#snippet bottom()}
      {#if $identity}
        <!--
          Runtime 概览：窄栏里不再用六列表格（那会只剩横向滚动条），改成一格
          一张卡——字段一个不少，只是竖着排。

          ⚠️ 这一块是**给使用者看的**，所以只说人话（2026-09 改写）：原来它把描述表的
          内部取值（`provisional` / `verified` / `undeclared` / `stateful`）、需求编号
          FR-CLI-07、以及 `pnpm run daemon --verify-runtime all` 一起摆在界面上——
          那些词对读界面的人不构成信息（而且 `**实测过**` 的强调号是原样显示出来的）。
          机器取值仍在 `--verify-runtime` 的输出里，那一份是给开发者的。
          ★ 2026-10 再简化（使用者点名）：卡片只显示「CLI 名 + 版本号」，
            核对/会话/版本支持判定一律不画。判定数据仍在 `--verify-runtime` 里。
        -->
        <section class="runtime-block">
          <h3>{$t('agents.runtimeLocal')}</h3>
          <p class="hint">{$t('agents.runtimeIntro')}</p>

          {#each $identity.runtimes as r (r.key)}
            <!--
              ★ 2026-10 极简：每张卡**只**显示「CLI 名 + 版本号」（如
                 `gpt-4o` → `gpt-4o`；若探测不到版本就显示 ready 态）。
            -->
            <div class="runtime-card">
              <div class="runtime-line">
                <code>{r.key}</code>
                {#if r.available}
                  <span class="faint fs-xs">{r.cliVersion ?? $t('agents.runtimeReady')}</span>
                {:else}
                  <span class="bad fs-xs">{$t('agents.runtimeNotFound')}</span>
                {/if}
              </div>
            </div>
          {/each}
        </section>
      {/if}
    {/snippet}
  </ListPane>

  <!--
    ⚠️ 2026-10：新建智能体**不再弹右侧抽屉**——与编辑态同款，住在右栏正文里
    （`MainArea` body 的 `{#if creating}`，见下）。`WorkspaceSettings` 仍是抽屉。
  -->


  <!-- ══════════════════ 右栏：新建表单 / 选中的 agent（宽屏并排 / 窄屏整页）══════════════════ -->
  <MainArea empty={!settingsOpen && !creating && selected === null}>
    {#snippet emptyContent()}
      <div class="empty">
        <strong>{$t('agents.pickOneTitle')}</strong>
        <p>{$t('agents.pickOneHint')}</p>
        <p>
          {$t('agents.pickOneRoleBefore')}<strong>{$t('agents.pickOneRoleExecutor')}</strong>{$t('agents.pickOneRoleMid')}<strong>{$t('agents.pickOneRoleReviewer')}</strong>{$t('agents.pickOneRoleAfter')}
        </p>
      </div>
    {/snippet}
    {#snippet body()}
      {#if settingsOpen}
        <WorkspaceSettings onclose={() => (settingsOpen = false)} />
      {:else if creating}
        <NewAgentForm
          onclose={() => (creating = false)}
          oncreated={() => {
            creating = false
            void loadAgents()
          }}
        />
      {:else if selected}
        <AgentDetail
          agent={selected}
          onclose={() => (selectedId = null)}
          onchanged={() => void loadAgents()}
        />
      {/if}
    {/snippet}
  </MainArea>
</div>

<style>
  /* ══════════════ 列表（窄栏里的卡片，不是表格）══════════════
     画表格的话六列会在 26rem 里互相挤；卡片竖排能放同样的字段，还顺手
     把"整条可点"表达清楚了。 */

  /**
   * ★ 分批第 268 批：分组标题（内置 / 自建）。
   *
   * ⚠️ 它们是 `<li>` 里的按钮，但**不吃**列表的行间距（`gap: var(--sp-1)`）——
   *    标题要贴着它那组的第一行，否则中间会浮着一条空隙，看起来像漏了一个条目。
   */
  .agent-group-head-wrap {
    margin: 0;
  }
  .agent-group-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-dim);
    font: inherit;
    font-size: var(--fs-xs);
    text-align: left;
    cursor: pointer;
  }
  .agent-group-head:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .agent-group-head .chev {
    width: 0.9em;
    color: var(--text-faint);
  }
  .agent-group-name {
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .agent-group-head .spacer {
    flex: 1;
  }
  /* 两组之间那条分隔线：只在上面那组真有东西时画（否则列表顶部多一条悬空的线） */
  .agent-group-sep {
    display: none;
  }
  .agent-group-sep.with-builtin {
    display: block;
    border-top: 1px solid var(--line);
    margin: var(--sp-1) 0;
    list-style: none;
  }

  .agent-list {
    list-style: none;
    margin: 0 0 var(--sp-5);
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }

  /**
   * 行盒（`.list-row`）与主按钮（`.list-row-main`）的样式在标准控件
   * `ListRow.svelte` 里（D66 抽成标准控件后，三页各一份的复制删掉了）。
   * 这一页 scoped 只剩行**内容**的样式：名字 / 徽标 / 注释摘要 / 「设为默认」。
   * 名字与聊天/任务标题同一档（D65：600；strong 默认 700，实测三页 400/600/700）。
   */
  /* ★ 310 批：与聊天的 `.conv-title`、任务的 `.task-title` 同一条规矩——
     单行 + 省略号必须是**块级**且有 `max-width`，否则长名字会被顶成两行。 */
  .agent-line strong {
    font-weight: 600;
    display: block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-line {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }

  .agent-notes {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    min-width: 0;
  }

  .agent-notes-trunc {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mem-count {
    color: var(--text-faint);
  }
  .agent-notes-meta {
    flex-shrink: 0;
  }

  /* ══════════════ 环境问题 ══════════════ */

  .env-issues {
    margin-bottom: var(--sp-5);
  }

  .env-issues h3 {
    font-size: var(--fs-sm);
    margin-bottom: var(--sp-2);
  }

  /* 两行（结论 + 怎么办）竖排：横排时第二句会被挤成一条竖线 */
  .stack {
    flex-direction: column;
    align-items: flex-start;
    margin-bottom: var(--sp-2);
  }

  /* ══════════════ Runtime ══════════════ */

  .runtime-block h3 {
    font-size: var(--fs-sm);
    margin-bottom: var(--sp-2);
  }

  .runtime-block .hint {
    margin-bottom: var(--sp-3);
  }

  .runtime-card {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    padding: var(--sp-3);
    margin-bottom: var(--sp-2);
  }

  .runtime-line {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
</style>
