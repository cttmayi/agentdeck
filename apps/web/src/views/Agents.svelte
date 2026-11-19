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
  } from '../lib/stores.ts'
  import MainArea from '../components/MainArea.svelte'
  import NewAgentForm from '../components/NewAgentForm.svelte'
  import WorkspaceSettings from '../components/WorkspaceSettings.svelte'
  import ListPane from '../components/ListPane.svelte'
  import ListGroupHead from '../components/ListGroupHead.svelte'
import ListRow from '../components/ListRow.svelte'
  import AgentDetail from '../components/AgentDetail.svelte'
  import type { Agent } from '../lib/api.ts'
  import { hasEntry, isHalfBuiltinAgent, isPlatformMember } from '../lib/members.ts'
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
  /*
   * ⚠️ 2026-11（D159）：这里原来有一个 `actionError`（「设为默认」失败的提示）。
   *   那颗按钮搬进右栏栏头（`AgentDetail`）之后，错误提示也归那边——它有自己的
   *   `.notice bad` 区域，不需要列表上方再开一条通道。
   */
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
   * ⚠️ 判据是**内置岗位**，不是名字（2026-10 D81/D82 的教训）：名字使用者能改，
   *    岗位值不能；按名字猜会让内置起草者被标成「执行」——一个永远不接任务的 agent
   *    看起来像执行者，使用者会去问"它为什么不干活"。
   *
   * ⚠️ 2026-11（S4，D127）：**角色退场** ⇒ 用户建的 agent 不再有"执行 / 审核"标签，
   *    统一叫「智能体」；只有平台内置的那几种按岗位显示（起草 / 记忆整理 / 生成智能体 /
   *    沉淀审核）。徽标配色也不再分"审核中 / 进行中"——那是流程状态，不是身份。
   */
  /*
   * ★ 2026-11（D155）：这里原来有两个函数（`roleLabelOf` / `roleBadgeOf`）给每行画一枚
   *   "这条是哪一条出厂成员"的徽标。使用者："智能体的徽标就不显示了吧，都是智能体"——
   *   在列表里它什么都多余：**它们都是智能体**，而"是哪一条出厂成员"名字里就有
   *   （`沉淀起草者`），要看细节有详情页的「入口」与平台动作徽标。
   *   判据（探针那两条"起草者的徽标说「起草」而不是「执行」"）随之删掉——意图本身没了。
   */

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
  /*
   * ★ 2026-11（D147）：判据从 `builtin === true` 换成 `isPlatformMember()`（= 读 `owner`）。
   *   两者的差别在**半内置**与已下线的 `skill-reviewer`：它们的 `builtin` 还是 `true`，
   *   但服务端已经按 `owner: 'user'` 处理（能改、能删）——照旧按 `builtin` 归堆，会把
   *   一条能删的智能体放进"内置（不能删）"那一组，两条界面说法互相矛盾。
   */
  $: builtinAgents = visibleAgents.filter((a) => isPlatformMember(a))
  $: ownAgents = visibleAgents.filter((a) => !isPlatformMember(a))
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
    /**
     * ★ 2026-11（D147）：**置灰的「新建平台成员」**（设计稿 §7 画过、一期没做）。
     *
     * 使用者 D145 拍板：「一期只允许用户造 `owner=user`，相关入口**显示但置灰**」。
     * 摆出来而不是藏起来，是因为"平台成员从哪来"这件事必须有个可见的答案——四个成员
     * 已经在列表的「内置」组里，那么"能不能再加一个"就该在原地回答，而不是让使用者
     * 去别处找。`title` 说明为什么（置灰而不说，读起来就是坏了）。
     *
     * ⚠️ `onActivate` 是空的**但按钮是 `disabled`**：不是"点了没反应"，浏览器根本不让点
     *    ——这两种在界面上是不同的事实（`page-actions` 里 `disabled` 会真的传给 `<button>`）。
     */
    {
      id: 'newPlatformMember',
      label: $t('agents.newPlatformMember'),
      kind: 'secondary',
      icon: 'plus',
      disabled: true,
      title: $t('agents.newPlatformMemberTitle'),
      onActivate: () => {},
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
    /*
     * ★ 2026-11（D156）：按 §2.6 的写法给全——`items.length > 0 && visible.length === 0`。
     *   原来只给后半句（"一条都没搜出来"），靠 `empty` 先命中才没出错；把条件写全，
     *   下一个改这段的人不必再去读 `ListPane` 的分支顺序。
     */
    emptyFiltered={$agents.length > 0 && visibleAgents.length === 0}
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
      <!-- ⚠️ 2026-11（D159）：这里原来显示「设为默认」的失败信息——那颗按钮搬进右栏栏头了，
           错误也跟着搬过去（`AgentDetail` 的 `.notice bad`）。 -->
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
        <!-- ★ 2026-11（D161）：`slot` 落到 DOM 上（探针与"哪条是内置的"都靠它——
             名字里的「（内置）」后缀已经去掉了，而名字是使用者能改的，槽位不是）。 -->
        <ListRow
          rowClass="agent-row"
          active={a.id === selectedId}
          dataSlot={a.slot ?? 'user'}
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
              <!-- ★ 2026-11（D155）：这里原来有一枚"是哪一条出厂成员"的徽标，删了
                   （使用者："都是智能体"；名字里已经写着是哪一条）。 -->
              <!--
                ⚠️ 这里原来有一个「未挂 skill」徽标，2026-10 删了：它写下的那句话
                   已经不是真的（审核者不挂 skill 也能审）。
              -->
              <!--
                ★ 2026-11（D147）：**半内置**（`builtin: true` 但认不出是哪一条）要在行上
                   说出来。它按使用者自己的智能体处理（能改能删），所以它既不在「内置」
                   那一组，也不该看起来和普通智能体一模一样。
              -->
              {#if isHalfBuiltinAgent(a)}
                <span
                  class="badge blocked"
                  data-agent-half-builtin
                  title={$t('agents.halfBuiltinTitle')}>{$t('agents.halfBuiltinBadge')}</span
                >
              {/if}
              {#if a.id === $effectiveDefaultAgentId}
                <!-- 新建任务的默认选择是谁，必须在列表上看得见 -->
                <span class="badge default-badge">{$t('agents.defaultBadge')}</span>
              {/if}
            </span>
            <span class="list-row-sub agent-notes faint fs-xs">
              <span class="agent-notes-trunc">
                {a.instructions.trim()
                  ? a.instructions.slice(0, 48) + (a.instructions.length > 48 ? '…' : '')
                  : $t('agents.noInstructions')}
              </span>
              <span class="agent-notes-meta">
                {$t('agents.skillCount', { count: a.skillIds.length })}
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
          <!--
            ★ 2026-11（D159）：这里原来有一颗行内「设为默认」按钮。使用者定了两种收法，
              选了第二种：**挪进详情栏头**——严格按 `ui-style.md` §2.6 / 范例页：
              **行 = 标题 + 副行 + （可选的一颗 × 危险动作）**，而"设为默认"是一颗要读文字
              的动作，放在行里既开了一个"文字按钮也能进行"的口子，也让每一行都多出一个
              常驻按钮（别的页行内只有一个 1.75rem 方块）。
              它现在在右栏栏头（`AgentDetail` 的 `.detail-actions`），条件与这里原来那句
              判据一模一样：`!readOnly && hasEntry(a,'task') && a.id !== 默认`。
          -->
        </ListRow>
      {/snippet}
      <ul class="list-stack agent-list">
        {#if builtinAgents.length > 0}
          <!-- ★ 2026-11（D137）：改用标准控件 `ListGroupHead`（与任务页同一个组头）。
               选中项被收起来时那句话说在 `note` 里：右栏还在显示它，列表里却"不见了"。 -->
          <ListGroupHead
            label={$t('agents.groupBuiltin')}
            count={String(builtinAgents.length)}
            note={selectionInBuiltin
              ? $t('agents.groupSelectionHere')
              : $t('agents.groupBuiltinHint')}
            open={showBuiltin}
            ontoggle={() => (builtinOpen = !builtinOpen)}
            groupKey="builtin"
          />
          {#if showBuiltin}
            {#each builtinAgents as a (a.id)}
              {@render agentRow(a)}
            {/each}
          {/if}
        {/if}

        {#if ownAgents.length > 0}
          <!-- ⚠️ 组间那条分隔线现在由 `app.css` 的
               `.list-stack > .list-group-head-wrap:not(:first-child)` 自动画
               （上一组真有东西才会有它的组头，所以不需要页面判断） -->
          <ListGroupHead
            label={$t('agents.groupOwn')}
            count={String(ownAgents.length)}
            note={selectionInOwn ? $t('agents.groupSelectionHere') : $t('agents.groupOwnHint')}
            open={showOwn}
            ontoggle={() => (ownOpen = !ownOpen)}
            groupKey="own"
          />
          {#if showOwn}
            {#each ownAgents as a (a.id)}
              {@render agentRow(a)}
            {/each}
          {/if}
        {/if}
      </ul>
    {/snippet}
    <!--
      ★ 2026-11（使用者点名去掉）：「本机 CLI」概览（runtime-block）整块删除——
      CLI 名 + 版本号的列表搬去了「关于」页的「运行环境」区（`views/About.svelte`，
      `/api/identity` 的 `runtimes` 同一份数据）。列表顶部环境预检问题（env-issues）
      保留：它提示"CLI 状态目录写不进去"这类方向性错误，是排障提示不是展示。
    -->
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
          onselect={(id) => {
            // ★ 2026-11（D160）：复制完成后直接选中副本（意图是"去改那份抄本"）
            selectedId = id
            creating = false
          }}
        />
      {/if}
    {/snippet}
  </MainArea>
</div>

<style>
  /* ══════════════ 列表（窄栏里的卡片，不是表格）══════════════
     画表格的话六列会在 26rem 里互相挤；卡片竖排能放同样的字段，还顺手
     把"整条可点"表达清楚了。 */

  /*
   * ⚠️ 2026-11（D137）：这一整段（`.agent-group-head-wrap` / `.agent-group-head` /
   *   `.chev` / `.agent-group-name` / `.spacer` / `.agent-group-sep`）**都删了**——
   *   组头改成标准控件 `ListGroupHead`，样式在 `app.css` 的 `.list-group-head` 一族；
   *   组间那条分隔线由 `.list-stack > .list-group-head-wrap:not(:first-child)` 自动画
   *   （上一组没东西就不会有它的组头，所以"要不要画"这件事不用页面判断）。
   *   原来的注释还留着一条有用的结论：组头**贴着**它那组的第一行，中间不该浮空隙——
   *   现在由 `.list-stack` 的 `gap` 统一给（所有子项同一档，组头不例外）。
   */
  /* ⚠️ 2026-11：重置 + 行距在全局 `.list-stack`（markup：`class="list-stack
     agent-list"`）。这里只留**这一页的形状差异**：内置/自建两段之间要留白。 */
  .agent-list {
    margin-bottom: var(--sp-5);
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

  /* ⚠️ 2026-11（D142）：共用部分走 `.list-row-sub`（它本来就是 baseline 对齐——这一页
     是最早写对的那处）；这里只留宽度。 */
  .agent-notes {
    width: 100%;
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

</style>
