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
  import { clearPageActions, setPageActions } from '../lib/page-actions.ts'
  import { t } from '../lib/i18n.ts'

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
  $: visibleAgents = $agents.filter((a) => {
    if (!filter.trim()) return true
    const q = filter.trim().toLowerCase()
    return (
      a.name.toLowerCase().includes(q) || a.instructions.trim().toLowerCase().includes(q)
    )
  })

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
      disabled: settingsOpen,
      title: $t('agents.settingsTitle'),
      onActivate: () => {
        settingsOpen = true
        creating = false
        selectedId = null
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

<div class="split-layout" class:with-detail={creating || selected !== null}>
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
    {#snippet rows()}
      <ul class="agent-list">
        {#each visibleAgents as a (a.id)}
          {@const reviewer =
            a.role === 'reviewer' ? $t('agents.reviewsOthers') : ''}
          <!--
            ★ 2026-10（D81/D82）：角色从两个变成四个（`drafter` / `skill-reviewer` 是内置的
              那两个），而这里原先写的是 `role === 'reviewer' ? 审核 : 执行` —— 于是内置起草者
              与内置 skill 审核者在列表上被标成**「执行」**：一个永远不会接任务的 agent
              看起来像执行者，使用者会去问"它为什么不干活"，而答案是"它压根不是"。
              ⚠️ 判据是**角色**，不是 agent 名字/是否 builtin：名字可以改，角色不能。
          -->
          {@const roleLabel =
            a.role === 'reviewer'
              ? $t('agents.roleReviewer')
              : a.role === 'drafter'
                ? $t('agents.roleDrafter')
                : a.role === 'skill-reviewer'
                  ? $t('agents.roleSkillReviewer')
                  : $t('agents.roleExecutor')}
          {@const roleBadgeClass =
            a.role === 'reviewer' || a.role === 'skill-reviewer' ? 'in_review' : 'in_progress'}
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
                <span class="badge {roleBadgeClass}">{roleLabel}</span>
                <!--
                  ⚠️ 这里原来有一个「未挂 skill」徽标（`a.role === 'reviewer' &&
                     a.skillIds.length === 0` 时显示）。**整段删掉了**，理由是它
                     写下的那句话**已经不是真的**：

                     注释原本说"审核者不挂 skill 就审不了任何东西"。那是 D37 之前
                     的事——那时审核标准就住在挂载的 skill 里。D37 之后标准**内联在
                     审核者身上**（`Agent.reviewStandard`），`resolveReviewStandard()`
                     也是**先看内联标准**、只有它为空时才回退到挂载的 skill。
                     实测线上那个「助手审核员」正是这种形态：`skillIds` 是空的、
                     内联标准是有的、审核跑得完全正常——而列表上给它挂了一个
                     看起来像故障的标记。

                     ★ 一个**指向不存在的故障**的标记比没有标记更糟：使用者会去
                     找一个不需要修的问题，甚至可能为了消掉它而给审核者硬挂一份
                     用不上的 skill。真要表达"这个审核者没有判断依据"，该看的是
                     内联标准在不在，而那是**智能体详情页**的事（列表上不显示标准
                     正文，在这里断言它有没有就成了第二套判断）。
                -->
                {#if a.id === $effectiveDefaultAgentId}
                  <!-- 新建任务的默认选择是谁，必须在列表上看得见 -->
                  <span class="badge default-badge">{$t('agents.defaultBadge')}</span>
                {/if}
              </span>
              <!--
                ★ 2026-10（紧凑性）：指令摘要与元信息不再各占一整行——合并成
                一行：摘要可截断（flex:1）、元信息不收缩靠右。
              -->
              <span class="agent-notes faint small">
                <span class="agent-notes-trunc">
                  {a.instructions.trim()
                    ? a.instructions.slice(0, 48) + (a.instructions.length > 48 ? '…' : '')
                    : $t('agents.noInstructions')}
                </span>
                <span class="agent-notes-meta">
                  <!-- ⚠️ 2026-10（使用者的决定）：执行者的「由谁来审它」设置整段拿掉
                       （审核走智能体组），列表上那一半（不自动审核 / 审核者名）随之
                       去掉——新执行者没有这个设置，留着只会永远显示"不自动审核"。
                       审核者保留「它审别人」。 -->
                  {reviewer}{$t('agents.skillCount', { count: a.skillIds.length })}<code>{a.runtimeKey}</code>
                </span>
              </span>
            {/snippet}
            {#snippet action()}
              <!--
                ★ 「默认」是**单选**：每个 agent 一个「设为默认」，点谁就是谁——
                  设了新的，原来那个自动不再是默认。**没有「取消默认」**：
                  必须有一个默认（使用者的要求），空着只会让"新建任务交给谁"
                  变成一个每次都要想的问题。

                  只对执行者给出这个动作——审核者不接任务（服务端也会拒，
                  这里只是别让人白点一次）。
              -->
              {#if a.role === 'executor' && a.id !== $effectiveDefaultAgentId}
                <button
                  type="button"
                  class="ghost small default-toggle"
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
        {/each}
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
                  <span class="faint small">{r.cliVersion ?? $t('agents.runtimeReady')}</span>
                {:else}
                  <span class="bad small">{$t('agents.runtimeNotFound')}</span>
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
  <WorkspaceSettings open={settingsOpen} onclose={() => (settingsOpen = false)} />

  <!-- ══════════════════ 右栏：新建表单 / 选中的 agent（宽屏并排 / 窄屏整页）══════════════════ -->
  <MainArea empty={!creating && selected === null}>
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
      {#if creating}
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
  .agent-line strong {
    font-weight: 600;
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
