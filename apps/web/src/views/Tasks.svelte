<script lang="ts">
  import { onDestroy } from 'svelte'
  import ListPane from '../components/ListPane.svelte'
  import ListGroupHead from '../components/ListGroupHead.svelte'
import ListRow from '../components/ListRow.svelte'
  import MainArea from '../components/MainArea.svelte'
  import {
    api,
    newRunId,
    type RunMessage,
    type RunSummary,
    type WorkDirFile,
    type WorkDirListing,
  } from '../lib/api.ts'
  import { renderMarkdown } from '../lib/markdown.ts'
  import { markdownHtmlMode } from '../lib/markdown-html.ts'
  import { paneResize } from '../lib/pane-resize.ts'
    import { agents, identity, issues, loadIssues, loadRuns, loading, loadError, runs, deleteTask, loadSkills } from '../lib/stores.ts'
  import { clearPageActions, setPageActions } from '../lib/page-actions.ts'
  import { leaveCreate } from '../lib/leave-create.ts'
  import { creating, goCreate, goCrystallize, selectedIssueId, showToast } from '../lib/view.ts'
  import WorkflowRunView from '../components/WorkflowRunView.svelte'
  import { askConfirm } from '../lib/confirm.ts'
  import { absoluteTime, relativeTime } from '../lib/time.ts'
  import { runStatusClass, runStatusKey } from '../lib/run-status.ts'
  import { finalResultText } from '../lib/final-output.ts'
  import {
    PIPELINE_COLUMNS as COLUMNS,
    TERMINAL_RUN_STATUSES,
    formatRunStamp,
    runsForIssue,
    stageOf,
    stageShortId,
  } from '../lib/pipeline.ts'
  import { groupTasks } from '../lib/task-groups.ts'
  import { workflowRuns, loadWorkflowRuns } from '../lib/stores.ts'
  import RunLog from '../components/RunLog.svelte'
  import { t, tx } from '../lib/i18n.ts'
  import type { WebTextId } from '@agentdeck/i18n'
  import NewTaskForm from '../components/NewTaskForm.svelte'
  import WorkDirTree from '../components/WorkDirTree.svelte'
  import { FoldSection } from '@agentdeck/ui/components'

  /**
   * 任务清单 + 任务详情。
   *
   * ══════════════════════════════════════════════════════════════════
   * 跑完之后是「最后结果」，不是「实时输出」
   * ══════════════════════════════════════════════════════════════════
   *
   * 执行中要的是"它现在在干什么"（原始日志、按 seq 追加）；跑完之后要的是
   * "它做成了什么"——那是**结论**，不是流水。同一块地方在两种状态下显示同一种
   * 东西，等于让使用者自己从几十条工具调用里翻出最后那段话。
   *
   * 所以跑完切成左右两栏：左边是最后那段产出（按 Markdown 渲染，图也显示出来），
   * 右边是工作目录里的文件（产出就在那儿，可以直接点开）。原始日志仍然可翻。
   *
   * ══════════════════════════════════════════════════════════════════
   * 两种视图各有各的用途，都要有（FR-ISSUE-04）
   * ══════════════════════════════════════════════════════════════════
   *
   * 列表适合"找一条具体的任务"，看板适合"看整体堆在哪里"。只留一个会逼着
   * 使用者用错误的工具回答其中一半的问题。
   *
   * 执行记录与实时日志放在**任务详情**里，而不是单独一栏——执行属于某个
   * 任务，"我在看哪个任务的执行"这个问题本来就不该由使用者自己拼。
   */
  /**
   * ★ 第一个参数是**整条 issue**，不是 id（D47）：阶段里多了一档「已放弃」，
   *   而它由 **issue 自己的状态**决定——run 里根本没有这个信息。
   *
   * 参数是必填的（不是可选的第三个参数），所以"忘了传"是**编译错误**。这不是
   * 洁癖：第一版做成可选时，这里两处都没传，症状是点「放弃」之后接口 200、issue
   * 状态确实变了、而看板一动不动——不报错、不告警。
   */
  /**
   * 任务清单（列表 + 看板共用）的顺序：**新的在前**（2026-09 的决定——
   * 原来是 API 给的升序、最旧的在前，使用者要求"逆向排"）。
   *
   * ⚠️ 只排这一页；任务详情里的时间线仍是升序（那是历史，见 `runsForIssue`）。
   * ⚠️ id 是 ULID（自带时间序），按 id 倒序 = 按创建时间新的在前。
   */

  // run 状态 → 徽标颜色 / 词条：共享在 lib/run-status.ts（沉淀页左栏也用同一份，
  // 两处各抄一份就会"同一个 run 在两个页面颜色不一样"）。

  /** 相对时间的「现在」——每次响应式更新重算一遍。 */
  $: now = Date.now()
  $: staged = visible
    .slice()
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map((issue) => ({ issue, info: stageOf(issue, $runs) }))

  /** 当前打开那个任务的阶段——详情头要显示它（不该在模板里算两遍）。 */
  $: selectedStage = selected ? stageOf(selected, $runs) : null

  /*
   * ⚠️ 2026-11（D123）：这里原来有四个助手——`actionResultOf` / `actionDetailOf`
   *   / `actionMetaOf` / `actionParamsOf`，负责把一条动作记录画成"做了什么 /
   *   退出码 / 耗时 / 参数"。动作能力退场 ⇒ 判决不再触发动作，这些没有数据可画。
   */

  /**
   * 「需要注意」单独一拨置顶。
   *
   * 不重排全部：使用者的心理模型是"列表按时间（新的在前）"，整体重排会让人
   * 找不到刚才那条。置顶一拨 + 其余保持原序，两边都成立。
   */
  /**
   * ★ 2026-11（使用者立项，demo v3 拍板）：任务列表**分组**——同一来源
   *   （定时任务触发的）任务一组。与看板/平铺切换并列：
   *   · viewMode：'group'（默认，组间按组内最新任务时间倒排、手动组参与）/ 'flat'（现状）
   *   · stageCol：状态筛选，'all' 或某看板列（`col.ids[0]` 作 key）——与分组正交
   *   · 组头可折叠（默认展开）
   */
  const GROUP_VIEW_KEY = 'agentdeck.issue-view-group'
  let viewMode: 'group' | 'flat' =
    localStorage.getItem(GROUP_VIEW_KEY) === 'flat' ? 'flat' : 'group'
  let stageCol: string = 'all'
  // 折叠状态：本文件是 **legacy 模式**（满篇 `$:`），不能引 runes 的 `$state`
  //   （一用整文件切 runes 模式，所有 legacy `$:` 当场报错）。
  //   普通 Set 的 add/delete 也不触发重渲染（探针实测 aria-expanded 不翻转），
  //   所以 toggle 时**换一个新 Set 实例赋值**——legacy 的赋值依赖照常工作。
  let collapsedGroups = new Set<string>()
  function toggleGroup(key: string): void {
    const next = new Set(collapsedGroups)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    collapsedGroups = next
  }
  function setViewMode(next: 'group' | 'flat'): void {
    viewMode = next
    localStorage.setItem(GROUP_VIEW_KEY, next)
  }

  /** 筛选 chips 的计数：**恒为总数**（用 `searched`，不含状态筛选）——
      选中某档后其它档的数字不变、「全部」也不变（见 `searched` 的注释）。 */
  $: colCounts = COLUMNS.map((c) => ({
    // ⚠️ 每列至少一个 stage（`ids` 非空是数组定义保证的）；`!` 消掉
    //    noUncheckedIndexedAccess 的 undefined。
    key: c.ids[0]!,
    titleId: c.titleId,
    n: searched.filter((i) => c.ids.includes(stageOf(i, $runs).stage)).length,
  }))
  /** 当前筛选档对应的列标题（筛选空态文案要用）。 */
  $: activeColTitle = COLUMNS.find((c) => c.ids[0] === stageCol)?.titleId ?? null

  /**
   * 分组视图的派生数据：按来源分组、组内保持 staged 顺序（时间倒序）、
   * 组间按组内最新任务时间倒排（手动创建也参与——不固定压底）。
   * 逻辑在 `lib/task-groups.ts`（纯函数，单测钉死）；这里只喂数据。
   * ⚠️ `staged` 已是筛选后的（见 `visible`），所以 `g.items` 天然是筛后数量——
   *    组头计数与可见内容一致（不误导）。
   */
  $: groups = groupTasks(staged, tx('tasks.manualGroup'))

  const VIEW_KEY = 'agentdeck.issue-view'
  let mode: 'list' | 'board' = localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list'

  /**
   * ══════════════════════════════════════════════════════════════════
   * 右栏的两种占用：某条任务的详情 / 建任务那张表单（D58 第二步）
   * ══════════════════════════════════════════════════════════════════
   *
   * 右栏一次只放一件事，而这两件事**都会丢东西**：表单里有使用者写了一半的正文，
   * 详情里有他正在读的执行记录。所以凡是"把右栏换成另一件事"的动作都要走守卫
   * （`leaveCreate()`，见 `lib/leave-create.ts`），而不是各自去 `set`。
   *
   * ⚠️ 判据（"填过没有"= `createDirty`）只有一处、离这里很远，而且**不止这一页
   *    在用**：侧边栏的「任务」那一项也走同一个守卫（那一栏上面那个返回按钮按
   *    要求去掉了，顶栏那两颗按钮与侧栏那一项就是"怎么回去"的全部答案）。
   */
  /** 进「建任务」那一栏（顶栏那个主操作）。进来时**不选中任何任务**：
      右栏已经给表单了，列表上再高亮一条会让人以为"这条正在被改"。 */
  function startCreate(): void {
    selectedIssueId.set(null)
    goCreate()
  }

  /**
   * ★★ 建任务**只在列表那一档成立**，所以进这一栏就把模式拨回列表。
   *
   * ⚠️ 这一条是**探针逼出来的**：右栏（表单住的地方）只在 `mode === 'list'` 下
   *    渲染，而模式存在 `localStorage` 里。于是"上一次用的是看板"的人点
   *    「新建任务」——地址变了、`$creating` 也真了，**屏幕上却什么都不出现**
   *    （看板是全宽呈现，右栏整个不存在）。这与我先前担心过的那个窄屏坑是同一类：
   *    状态都设对了，只是那一块**没有地方画**。
   *
   * ⚠️ 顺带**写回存储**：不写的话，离开这一页再回来又跳回看板，而使用者明明
   *    刚从看板过来建任务。
   *
   * ⚠️ 写成 `$:` 而不是只在 `startCreate()` 里改：直接打开/收藏 `#/tasks/new`
   *    （书签、别人发来的链接）根本不经过那个按钮，而它踩的是同一个坑。
   */
  $: if ($creating && mode !== 'list') {
    mode = 'list'
    localStorage.setItem(VIEW_KEY, 'list')
  }

  /** 点列表里的一条：如果右栏正开着表单，先按上面的规矩问一句。 */
  async function pickIssue(id: string): Promise<void> {
    if ($creating && !(await leaveCreate())) return
    // ★ 编排任务（2026-11 再改）：**不跳转**——点开就在任务页主区显示运行画面
    //   （步骤链 + 日志 + 工作目录树）。编排任务不是"一条 run 的任务"，
    //   是"一串步骤"；细节 = 运行画面，直接嵌在详情区。
    if ($issues.find((i) => i.id === id)?.source?.kind === 'workflow') {
      await loadWorkflowRuns()
    }
    selectedIssueId.set(id)
  }

  /**
   * 切列表 / 看板。
   *
   * ⚠️ 切到看板会把右栏整块收掉（看板是全宽呈现），也就是"表单被切走了"——
   *    与点另一条任务是同一件事，所以同样要问。
   */
  async function setMode(next: 'list' | 'board'): Promise<void> {
    // ★ 2026-10：这一栏上面那个「返回任务清单」按要求去掉了，于是**顶栏那两颗按钮
    //   就是宽屏下"怎么回去"的答案**——所以"已经写着列表还要再点一次列表"不能是
    //   空操作：在建任务里它必须表示"离开表单、回列表"（从前 `mode === next` 直接
    //   返回，点它一点反应都没有，而使用者那时正想回去）。
    if (mode === next && !$creating) return
    if ($creating && !(await leaveCreate())) return
    mode = next
    localStorage.setItem(VIEW_KEY, next)
  }

  /**
   * 顶栏那一排动作（机制见 `lib/page-actions.ts`）。
   *
   * ⚠️ 写在 `$:` 里并读 `$t(...)` 与 `mode`：**两种变化都要重新登记**——
   *    语言变（标签换字）与模式变（哪个按钮算"当前"）。
   * ⚠️ 卸载时收回来（登记里存的是抓着这一页状态的闭包）。
   *
   * ★ 两个模式按钮用 `ghost`：它们是"这一页怎么呈现"的开关，不是两个动作；
   *   刷新是 `secondary`。原来它们挤在栏头全是一个样子，看不出主次。
   */
  $: setPageActions('tasks', [
    {
      // ★ 2026-10（D58）：「新建任务」并进这一页 ⇒ 它就是这一页的**主操作**
      //   （primary 排在模式开关前面）。词条复用导航那一条（`shell.navNewTask`）：
      //   同一句话在两个地方出现，**只有一个出处**——各写一份的后果是
      //   "侧栏说『新建任务』、按钮说『新任务』"，而那种不一致没人会去查。
      //   `title` 用 `shell.navNewTaskHint`（原来挂在侧栏那一项下面的说明）。
      id: 'new',
      label: $t('shell.navNewTask'),
      kind: 'primary',
      icon: 'plus',
      // ⚠️ **不给它 `active`**（虽然"正在建任务"确实是一种"当前"）：这一排里
      //   `active` 的语义是**"现在是哪一种呈现方式"**，而那有且只有一个
      //   （列表 / 看板）。两处都能点亮时，一排里会出现两个实心块，而"我在哪一种"
      //   这个问题反而没人回答得出来（实测：探针那条"当前模式只有一个"红了）。
      //   正在建任务这件事由**右栏**说（标题就是「新建任务」）。
      title: $t('shell.navNewTaskHint'),
      onActivate: () => startCreate(),
    },
    {
      id: 'list',
      label: $t('tasks.modeList'),
      kind: 'ghost',
      icon: 'list',
      active: mode === 'list',
      onActivate: () => setMode('list'),
    },
    {
      id: 'board',
      label: $t('tasks.modeBoard'),
      kind: 'ghost',
      icon: 'board',
      active: mode === 'board',
      onActivate: () => setMode('board'),
    },
    {
      id: 'refresh',
      label: $t('common.refresh'),
      kind: 'secondary',
      icon: 'refresh',
      onActivate: () => void refresh(),
    },
  ])
  onDestroy(() => clearPageActions('tasks'))

  let filter = ''

  /**
   * 文字搜索后的集合（**不含状态筛选**）。
   *
   * ★ 2026-11 修 bug（使用者："全部本来 27，选中待处理后变成 14，不合理"）：
   *   chips 上的数字（「全部」和各列）**恒为总数**——一旦跟着当前筛选走，
   *   选中「待处理」后「全部」就显示 14，看起来像"任务变少了"。
   *   所以计数一律用 `searched`（只有文字搜索参与），状态筛选单独在 `visible` 做。
   */
  $: searched = $issues.filter((i) => {
    if (!filter.trim()) return true
    const q = filter.trim().toLowerCase()
    return i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)
  })
  // ★ 状态筛选（与分组正交——分组管"同源"、筛选管"状态"）；0 结果时的观感
  //   由空态文案承担（`tasks.emptyStage`），工具条在 `top` 插槽里不跟着消失。
  $: visible = searched.filter((i) => {
    if (stageCol === 'all') return true
    const col = COLUMNS.find((c) => c.ids[0] === stageCol)
    if (!col) return true
    return col.ids.includes(stageOf(i, $runs).stage)
  })

  $: selected = $issues.find((i) => i.id === $selectedIssueId) ?? null
  /** 选中任务是编排任务时，它的编排 run（详情区显示运行画面，不切视图）。 */
  $: wfRunForSelected = selected ? $workflowRuns.find((r) => r.issueId === selected.id) ?? null : null
  // ⚠️ 不能只按 `subject.id === issue.id` 过滤：**review run 的 subject 是那条
  //   执行 run 的 id**，不是 issue。那样过滤会漏掉所有审查 run ——
  //   表现就是"看板说已审查完成，点进来却看不到审查结论"。
  //   归属规则与看板共用同一个纯函数（见 lib/pipeline.ts）。
  $: issueRuns = selected ? runsForIssue(selected.id, $runs) : []

  function agentName(id: string | null): string {
    if (!id) return tx('tasks.unassigned')
    return $agents.find((a) => a.id === id)?.name ?? id
  }

  // ── 任务详情 ──

  let activeRun: RunSummary | null = null
  /**
   * 「沉淀技能」这个按钮什么时候能点：**这条 run 跑完了**。
   *
   * ⚠️ D80：这里原来还有一道"置灰门"——要**有用户反馈或者审核过**才许沉淀
   *   （从 `/api/crystallize/targets` 取 `reviewed` / `hasUserFeedback`）。
   *   D125 之后两半都没了：审核 run 退场，而"用户反馈"从来没有记录机制。
   *   于是门槛只剩"跑完了"——**该不该沉淀由人判断**（他点了这个按钮就是判断）。
   */
  $: canOptimizeSkill = activeIsTerminal
  // ── 最后结果（跑完之后）──
  /** 这次执行的最后一段产出（最后一条 text 消息）。 */
  let finalOutput = ''
  let finalOutputFor: string | null = null
  let showRawLog = false

  $: activeIsTerminal =
    activeRun !== null && ['completed', 'failed', 'cancelled'].includes(activeRun.status)
  /**
   * ★ D69.12：日志视图（正在跑 / 点「看完整日志」）。此时详情栏切成 flex
   *   纵向布局：日志 `flex:1` 精确填满剩余空间、内部滚动——外置滚动条消失。
   *   结果视图（terminal 且没切日志）保持原来的整栏滚动 + sticky 裁决条。
   */
  $: logMode = activeRun !== null && !(activeIsTerminal && !showRawLog)

  async function loadResult(run: RunSummary): Promise<void> {
    // 最后一段 text 就是"产出"。取最后一条而不是拼接：中间那些
    // "我先看一下目录" 之类的过程话不属于结论。
    try {
      const out = await api<{ messages: RunMessage[] }>(`/api/runs/${run.runId}/messages`)
      const texts = (out.messages ?? []).filter((m) => m.type === 'text' && m.content.trim() !== '')
      finalOutput = texts.length > 0 ? texts[texts.length - 1]!.content : ''
    } catch {
      finalOutput = ''
    }
    finalOutputFor = run.runId
  }


  /** 工作目录里的相对路径 → 能取的地址（Markdown 里的图片靠它显示）。 */
  function resolveAsset(href: string, runId: string): string | null {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href // 外部绝对地址
    return `/api/runs/${runId}/file?path=${encodeURIComponent(href)}`
  }

  /**
   * 「最后结果」要显示的文字。
   *
   * ★ 判决围栏（`<<<ALPHA_VERDICT>>>` … `<<<END_ALPHA_VERDICT>>>`）是**机器读的**
   *   标记。它们现在**不再由平台产生**（判决契约随审核 run 退场，D125），但**老
   *   记录的正文里还留着**——那段围栏与 JSON 在人看的地方只是噪音，看起来还像
   *   "平台没处理"（使用者的原话：显示 `<<<ALPHA_VERDICT>>>` 不优美）。
   *
   *   所以无条件剥掉：`stripVerdictBlocks` 在没有围栏时原样返回，代价是零。
   */
  $: resultText =
    activeRun === null || finalOutputFor !== activeRun.runId
      ? ''
      : finalResultText(finalOutput, true)

  $: renderedResult =
    resultText !== ''
      ? renderMarkdown(resultText, {
        html: $markdownHtmlMode, resolveAsset: (href) => resolveAsset(href, activeRun!.runId) })
      : ''

  /*
   * ⚠️ 2026-11（D125）：这里原来是 `verdicts` / `verdictsFor`——这条 run 的判决
   *   列表（`GET /api/runs/:id/verdicts`，模型判的 + 人工裁决追加的）。判决退场
   *   ⇒ 不取、不画。
   */

  // ══════════════════════════════════════════════════════════════════
  // ★ 打开详情时必须走 `selectRun()`，而不是只赋一个 `activeRun`
  // ══════════════════════════════════════════════════════════════════
  //
  // 原来这里只写 `activeRun = issueRuns[0]`。于是从列表点开一个任务时，
  // **没有人去取它的结果与文件**——那些是在 `selectRun()` 里做的。表现是
  // 右边结果区一直停在骨架屏，直到你手点一下 run 标签或按刷新。
  //
  // 这个 bug 是"量尺寸"量出来的：打桩渲染后测到结果区高度只有 73px、
  // 文件列表 0 项 —— 肉眼扫一眼截图很可能看不出来（骨架屏也是灰条）。
  // ★ `issueRuns` 现在是**时间线（最早的在前）**，所以"最新的那一条"是最后一个。
  //   原来取 `[0]` 是对的（那时数组是倒序），顺序改成升序之后必须跟着改——
  //   否则点开任务会默认停在**最早**那次执行上。
  const newestRun = (list: RunSummary[]): RunSummary | null => list[list.length - 1] ?? null

  $: if (issueRuns.length > 0 && (!activeRun || !issueRuns.some((r) => r.runId === activeRun!.runId))) {
    const target = newestRun(issueRuns)
    if (target) void selectRun(target)
  }

  async function cancel(runId: string): Promise<void> {
    // ★ 停下来就不可逆（不会自己接着跑）——按与删除同一判据先问一句。
    if (
      !(await askConfirm({
        title: $t('tasks.cancelRun'),
        message: $t('tasks.confirmCancelRunBody'),
        confirmLabel: $t('tasks.cancelRun'),
        danger: true,
      }))
    )
      return
    // ★ 必须 try/catch：原来这里是裸 `await`，取消失败（daemon 不在、run 已经
    //   结束、网络断了）时是一个 **unhandled rejection**——界面上**什么都不发生**，
    //   使用者只会觉得"点了没反应"，然后反复点。同一页的删除（`removeTask`）和
    //   聊天页的停止（`Chat.svelte` 的 `stop()`）都是带 catch 的。
    runError = ''
    try {
      await api(`/api/runs/${runId}/cancel`, { method: 'POST' })
      await loadRuns()
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err)
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // ★ 人的出路（D47；D125 之后只剩两个）
  // ══════════════════════════════════════════════════════════════════
  //
  // 这里原来还装着「人工裁决」（D46）：人点「通过」就追加一条 `source: 'human'`
  // 的判决，看板的阶段由此从「待审查」变成「已审查」。**判决与人工裁决面板一起
  // 退场**（D125）⇒ 那个按钮、它那条判据（`passGate`，与 daemon 的
  // `canHostHumanVerdict` 严格对齐）以及载体选择的整套推理都删了。
  //
  // 剩下的是**出路**而不是**结论**：
  //   · 「反馈」= 再派一条普通任务（就是原来的「发送并继续」）——它要的是干活；
  //   · 「放弃」= 改 issue 状态——它要的是别再盯着它。
  //
  // ⚠️ 那次改动留下一条一直有效的教训：**凡是"某个动作只对某一类记录生效"的
  //   场合，界面与 daemon 必须用同一条判据**，否则会出现"按钮点得动、请求被 409
  //   拒"，或者更糟的"点了通过、看板一动不动"（判决落在一个阶段推导不看的地方）。
  $: abandonSupported = ($identity?.capabilities ?? []).includes('issue-abandon')

  /**
   * 整块「这条任务怎么办」给不给。
   *
   * ★ 为什么是"只要选中了就给"，而不是某个按钮的条件：两个按钮的可用条件不同
   *   ——「反馈」要有一次**跑完**的执行可以接（`feedbackReady`），「放弃」什么
   *   都不需要（它是"我不想管了"，与跑到哪一步无关）。用任何一个当整块的开关，
   *   都会让另一个在它**本该可用**的时候消失。
   */
  $: canDecide = selected !== null

  /** 这条任务是不是已经放弃了。 */
  $: isAbandoned = selected?.status === 'cancelled'

  /** 放弃 / 恢复要不要给（旧 daemon 没有这两条路由 ⇒ 不给，免得点了 404）。 */
  $: canAbandon = abandonSupported && selected !== null

  /**
   * 「反馈」能不能点：要有一次**跑完**的执行。
   *
   * 因为它就是"接着上次说"——`resumeFromRunId` 要指向一条已经结束的执行。
   * 指向一条**正在跑**的 run 是没意义的（那次会话还没落定，没有 sessionId 可
   * 恢复），而同一工作目录的并发本来也会被串行化，于是那条反馈会静悄悄地排在
   * 后面，看起来像没生效。
   */
  $: feedbackReady =
    lastExecuteRun !== null && TERMINAL_RUN_STATUSES.has(lastExecuteRun.status)

  let humanReason = ''
  /** 哪个按钮正在跑（`null` = 都闲着）。三个动作共用一个"忙"状态。 */
  let deciding: 'feedback' | 'abandon' | 'recover' | null = null
  let decideError = ''
  /** run 操作的错误（现在只有「取消这次执行」）。显示在 run 详情区里。 */
  let runError = ''

  /**
   * ②「反馈」——把上面那段话发回给执行者重做。
   *
   * ★ 它就是原来的「发送并继续」（`sendFollowUp`），D47 把两者合并了：**没有
   *   任何额外的记录动作**——派出去的那条新 run 本身就足以让看板离开「等待人
   *   处理」（新 run 未结束 ⇒ 阶段是「执行中」）。这与"人工裁决"那条路的区别
   *   是刻意的：那边要的是**结论**（只能靠记录表达），这边要的是**干活**。
   *
   * 理由**必填**：这段文字就是执行者拿到的依据，一句"不行"没法干活。
   */
  async function feedback(): Promise<void> {
    if (deciding !== null || !feedbackReady) return
    const message = humanReason.trim()
    if (message === '') {
      // ★ 在界面这一层就说，不要等 daemon 回 400——让使用者白等一次往返没有
      //   意义。但**权威不在这里**：这条规则的本体是"反馈必须说清要改什么"，
      //   它写在这句话本身（`tasks.needReasonForFeedback` 的词条）和这段注释里，
      //   而不是某个 schema 里——因为「反馈」**不落记录**，没有 schema 可挂。
      decideError = tx('tasks.needReasonForFeedback')
      return
    }
    deciding = 'feedback'
    decideError = ''
    try {
      await sendFollowUp(message)
      humanReason = ''
    } catch (err) {
      decideError = err instanceof Error ? err.message : String(err)
    } finally {
      deciding = null
    }
  }

  /**
   * ③「放弃」/「恢复」——改 issue 的状态（D47）。
   *
   * ⚠️ 放弃会**顺手取消正在跑的 run**（daemon 那边做的）。这是这个功能唯一的
   *    副作用，所以它写在按钮旁边那句提示里，不藏在代码里。
   */
  async function setAbandoned(abandon: boolean): Promise<void> {
    if (!selected || deciding !== null) return
    // ★ 放弃要比「恢复」多一道确认：它会**顺手取消正在跑的 run**（服务端做的），
    //   而那一步不可逆。原来它直接执行——同页的删除要确认、这个更贵的动作不要，
    //   分级是反的。判据沿用工具页那条：「停掉就接不回来 ⇒ 问一句」。
    if (
      abandon &&
      !(await askConfirm({
        title: $t('tasks.confirmAbandonTitle'),
        message: $t('tasks.confirmAbandonBody'),
        confirmLabel: $t('tasks.decideAbandon'),
        danger: true,
      }))
    )
      return
    deciding = abandon ? 'abandon' : 'recover'
    decideError = ''
    try {
      await api(`/api/issues/${selected.id}/${abandon ? 'abandon' : 'reopen'}`, {
        method: 'POST',
      })
      // ★ 放弃之后这块只剩「恢复」按钮，所以把理由框里的内容清掉——留着它会
      //   让人以为恢复之后还会接着用那段文字（不会，恢复只是把状态改回来）。
      if (abandon) humanReason = ''
      await refresh()
    } catch (err) {
      decideError = err instanceof Error ? err.message : String(err)
    } finally {
      deciding = null
    }
  }

  /**
   * ④「删除任务」——列表每项右侧那个「×」。
   *
   * 与「放弃」不同：放弃只是改状态（run 还留着），删除是**连同全部执行记录
   * 一起删掉**（消息、审核结果、产物；审计保留）。所以确认文案里写清楚了
   * "无法找回"，这里也只做一件事：调接口 + 重取两份列表。
   */
  async function removeTask(id: string): Promise<void> {
    // ★ 平台自己的确认框（居中），不是 `window.confirm`——理由见 `lib/confirm.ts`
    if (
      !(await askConfirm({
        title: $t('tasks.delete'),
        message: $t('tasks.deleteConfirm'),
        confirmLabel: $t('tasks.delete'),
        danger: true,
      }))
    )
      return
    try {
      await deleteTask(id)
      if ($selectedIssueId === id) selectedIssueId.set(null)
      showToast($t('tasks.deleted'))
    } catch (err) {
      decideError = err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * 从看板点开一个任务。
   *
   * 看板是**全宽**的（三列挤在半个屏幕里没法看），所以详情不能并排显示；
   * 这里切回列表模式再选中——于是使用者落进"列表 + 详情"的主从布局里，
   * 而不是丢进一个没有列表的孤立页面。
   */
  function selectFromBoard(issueId: string): void {
    // 编排任务（2026-11 再改）：看板点开同样不跳转——主区显示运行画面
    if ($issues.find((i) => i.id === issueId)?.source?.kind === 'workflow') {
      void loadWorkflowRuns()
    }
    setMode('list')
    selectedIssueId.set(issueId)
  }

  async function selectRun(run: RunSummary): Promise<void> {
    activeRun = run
    showRawLog = false
    finalOutput = ''
    finalOutputFor = null
    // 工作目录那一栏的状态现在住在 `WorkDirTree` 里，换 run 时由 `reloadKey`
    // 触发它自己清空重取——这里不再需要手动重置六个变量。
    // 跑完的才去取结果；还在跑的时候右边是实时日志，没必要多拉一次
    if (['completed', 'failed', 'cancelled'].includes(run.status)) await loadResult(run)
  }

  // ── 接着沟通（在同一任务上继续）──
  /**
   * ══════════════════════════════════════════════════════════════════
   * 为什么这是"再起一条 run"，而不是"给已有 run 追加消息"
   * ══════════════════════════════════════════════════════════════════
   *
   * 一次 run 的产出是**不可变快照**（连消息流都按 seq 单调追加）。往里塞新
   * 输入会让"这条 run 当时到底收到了什么"变得不可回答，审计链也就断了。
   *
   * 所以"接着说"= 同一任务上**新起一条 execute run**，并用 `resumeFromRunId`
   * 指向上一次：
   *
   *   - **工作目录**按任务分配（D27），所以两条 run 落在同一个目录里——
   *     agent 上次留下的文件还在；
   *   - **会话**由 daemon 去取上一次的 sessionId 并交给 CLI 恢复（FR-CLI-06），
   *     于是它是"接着上次说"，而不是"从头再来一遍"。
   *
   * 恢复是**尽力而为**：CLI 可能拒绝（换了版本、会话过期），那时它会在日志里
   * 说明"恢复被拒、本次将没有上文"，而不是假装恢复成功。
   */
  /**
   * 这个任务上**最新的一次执行**——接着沟通就是接在它后面。
   *
   * ⚠️ 时间线是升序的，所以最新的在**末尾**（原来 `find` 能拿到是因为当时
   *    数组倒序——顺序一改，`find` 就变成"最早那次"，接着沟通会接错）。
   */
  $: lastExecuteRun = issueRuns.filter((r) => r.kind === 'execute').at(-1) ?? null

  /**
   * ★ D47：把这段话发回给执行者重做 —— 这就是「反馈」按钮，也就是原来那个
   *   「发送并继续」。两者是**同一件事**，所以合并成了一个（使用者的话：
   *   "功能就合并了"）。
   *
   * 为什么它是"重做"而不是"聊天"：`resumeFromRunId` 指向上一次执行，daemon 会
   * 取那次会话的 sessionId 交给 CLI 恢复（FR-CLI-06），于是执行者带着上文接着
   * 干，而不是从头再来一遍。恢复是**尽力而为**：CLI 可能拒绝（换了版本、会话
   * 过期），那时它会在日志里说明"恢复被拒、本次将没有上文"，而不是假装成功。
   *
   * ★ 它**不落任何判决记录**。这是 D47 的一个刻意决定：派出去的那条新 run
   *   本身就足以让看板离开「等待人处理」（新 run 未结束 ⇒ 阶段是「执行中」），
   *   而"我要求重做"这件事在那个 run 的 prompt 里写着。再补一条判决反而会带来
   *   一个难题：那条判决该挂在哪条 run 上？（旧审核 run 已经不生效、新 run 还
   *   没有结论）——一个挂不对地方的判决就是这个仓库最防的那种"落库了但没人看"。
   *
   * 抛错而不自己吞掉：调用方（`feedback()`）要在一个地方显示它。
   */
  async function sendFollowUp(message: string): Promise<void> {
    if (!selected || !lastExecuteRun) return

    const agent = $agents.find((a) => a.id === lastExecuteRun!.agentId)
    if (!agent) {
      // 执行者被删掉了 ⇒ 这条路走不通。**说清是哪一件事坏了**：含糊的"发送失败"
      // 会让人以为是网络问题，而实际要做的是换个 agent 或直接放弃这条任务。
      throw new Error(tx('tasks.agentGone'))
    }

    const runId = newRunId()
    await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        runId,
        kind: 'execute',
        agentRef: { id: agent.id, name: agent.name, instructions: agent.instructions },
        // 不传 skills：由 daemon 按这个 agent 的配置解析（同 NewTask）
        subject: { type: 'issue', id: selected.id },
        prompt: message,
        // ★ 指向上一次执行 ⇒ daemon 会取它的 sessionId 交给 CLI 恢复
        resumeFromRunId: lastExecuteRun.runId,
        limits: { maxTurns: null, timeoutMs: null },
      }),
    })
    await refresh()
    // 立刻切到新那条 run：使用者刚说了话，想看的是它的实时输出
    const created = $runs.find((r) => r.runId === runId)
    if (created) await selectRun(created)
  }

  async function refresh(): Promise<void> {
    await Promise.all([loadIssues(), loadRuns()])
    if (!activeRun) return
    // 刷新后 activeRun 可能是**旧对象**（`$runs` 换了引用，但这个变量还指着
    // 上一份），状态可能已经从"进行中"变成"跑完了" —— 所以按 runId 取最新的
    // 那一份，否则"跑完切到结果视图"这个切换永远不会发生。
    const fresh = $runs.find((r) => r.runId === activeRun!.runId) ?? activeRun
    activeRun = fresh
    if (['completed', 'failed', 'cancelled'].includes(fresh.status)) await loadResult(fresh)
  }
</script>

{#snippet row(issue: (typeof visible)[number], info: ReturnType<typeof stageOf>)}
  <!--
    ★ 为什么从"四列的表格"改成"两行的列表"

      使用者的原话：「任务清单列表模式下，任务可能很长，当前显示布局会拉很高」。

      先量了再说（tools/layout-probe）：一个 90 字的标题让**一行**变成 191px。
      而量出来的列宽是 任务 157 / 阶段 61 / 指派给 62 / 更新于 88——左栏只有
      26rem，四列加起来就把标题挤到 157px：标题一长就换行，一换行整行就高。

      把标题限成两行只能降到 106px，因为**别的列也在换行**（61px 的阶段格里
      要放下"待审查"+"还没开始执行"两个东西）。四列在这点宽度里放不下这些
      信息——这是算出来的，不是感觉。

      所以改成两行：标题独占一行（宽度从 157px 变成整个栏宽，两行封顶），
      阶段/指派给/更新于 收进第二行的元信息里。行高不再由标题长度决定，
      而**信息一个没少**。与「智能体」那一栏的列表也是同一个形状。
  -->
  <ListRow
    rowClass="task-row"
    active={$selectedIssueId === issue.id}
    onclick={() => void pickIssue(issue.id)}
  >
    {#snippet children()}
      <!--
        ★ 标题**单行 + 省略号**，不是"最多两行"。

          先量了才定的（tools/layout-probe 里有一条"长短标题的行高差"）：
          两行截断能把 191px 压到 80px，但**短标题那行仍然是 61px**——
          也就是说行高还在跟着标题长度变（差 19px）。列表的节奏要的是**每行一样高**，
          所以这里单行截断：短标题、长标题占的都是那一行。

          完整标题在 `title`（悬停可见）和右栏详情里；列表是用来扫的。
      -->
      <!-- ⚠️ 标题与徽标必须同一行：`{#if}` 块换行会在 textContent 里留前导空白，
           探针按 `startsWith('探针用的任务')` 找夹具行（布局判据的入口）——踩过。 -->
      <span class="task-title ellipsis" title={issue.title}>{#if issue.source?.kind === 'workflow'}<span class="badge">{$t('workflows.taskBadge')}</span>{/if}{issue.title}</span>
      <span class="list-row-sub task-meta">
        <span class="badge stage-tag {info.stage}">{$t(stageShortId(info.stage))}</span>
        <!-- 只显示标签**之外**的信息（`note`）：「待审查」后面再跟一句
             「等待审核」是重复，使用者点名要去掉的就是它。 -->
        {#if info.noteId}
          <span class="faint fs-xs">{$t(info.noteId)}</span>
        {/if}
        <!-- ⚠️ 2026-11（D124）：这里原来是「返工 N 次」那枚标记。返工退场 ⇒
             不再有返工 run，"这个任务审了不止一轮"这件事也就不存在了。 -->
        <span class="faint fs-xs">{agentName(issue.assignee?.id ?? null)}</span>
        <span class="faint fs-xs" title={absoluteTime(issue.updatedAt)}>{relativeTime(issue.updatedAt, now)}</span>
      </span>
    {/snippet}
    {#snippet action()}
      <button
        type="button"
        class="list-row-action"
        title={$t('tasks.delete')}
        aria-label={$t('tasks.delete')}
        onclick={() => void removeTask(issue.id)}
      >
        ×
      </button>
    {/snippet}
  </ListRow>
{/snippet}

<div
  class="split-layout"
  class:board={mode === 'board'}
  class:with-detail={mode === 'list' && (selected !== null || $creating)}
  data-list-key="tasks"
  data-list-label={$t('shell.resizeList')}
  use:paneResize
>
  <!-- ══════════════════ 中栏：清单 / 看板 ══════════════════ -->
  {#if mode === 'board'}
    <!--
      ⚠️ 看板是**另一种呈现**（D61 起就不算进"三页同款"的列表栏）：它的栏头有
      标题 + 说明两行（列的含义得就地讲），列表模式的「计数 + 搜索」栏头带在
      ListPane 里。这里保留自己的 pane 结构；加载 / 报错 / 空态与列表同一套。
    -->
    <section class="pane list-pane">
      <header class="pane-head">
        <div>
          <h2>{$t('tasks.boardTitle')}</h2>
          <p class="hint">
            {$t('tasks.boardHintBefore')}<strong>{$t('tasks.boardHintStrong')}</strong>{$t('tasks.boardHintAfter')}
          </p>
        </div>
        <!--
          ★ 2026-10（紧凑性）：看板是**全宽**呈现，搜索框不再独占一整行——
          并进栏头右侧，与标题同排（列表模式的搜索框留在下方 pane-body 里）。
        -->
        <input
          bind:value={filter}
          placeholder={$t('tasks.search')}
          style="max-width:16rem;align-self:center"
          autocomplete="off"
        />
      </header>

      <div class="pane-body">
        {#if $loading['issues'] && $issues.length === 0}
          <div class="skeleton"></div>
          <div class="skeleton"></div>
        {:else if $loadError['issues']}
          <div class="notice bad">{$loadError['issues']}</div>
        {:else if visible.length === 0}
          <div class="empty">
            <strong>{filter ? $t('tasks.emptyFiltered') : $t('tasks.empty')}</strong>
            {filter ? $t('tasks.emptyFilteredHint') : $t('tasks.emptyHint')}
          </div>
        {:else}
          <div class="board">
            {#each COLUMNS as col (col.ids[0])}
              <!-- 一列可以收多档（「待处理」收 awaiting_review 与 needs_human） -->
              {@const items = staged.filter((x) => col.ids.includes(x.info.stage))}
              <div class="column">
                <!-- ★ D179：看板列头**不是标题**（它是标签档：12px 大写 + faint），标签换成
                     div —— 原来用 `<h4>` 却把字号压到 12px，与"段内小节 13px"撞车。 -->
                <div class="column-label">
                  <span>{$t(col.titleId)} <span class="faint">{items.length}</span></span>
                  <span class="col-hint">{$t(col.hintId)}</span>
                </div>

                {#if items.length === 0}
                  <p class="col-empty faint fs-xs">{$t('tasks.columnEmpty')}</p>
                {/if}

                {#each items as { issue, info } (issue.id)}
                  <button type="button" class="card" onclick={() => selectFromBoard(issue.id)}>
                    <span class="card-title">{issue.title}</span>
                    <span class="card-meta">
                      <span class="faint fs-xs">{agentName(issue.assignee?.id ?? null)}</span>
                    </span>
                    <span class="card-meta">
                      {#if info.noteId}<span class="faint fs-xs">{$t(info.noteId)}</span>{/if}
                      <span class="faint fs-xs" title={absoluteTime(issue.updatedAt)}>{relativeTime(issue.updatedAt, now)}</span>
                    </span>
                    {#if info.warningId}
                      <span class="card-warning">{$t(info.warningId, info.warningParams)}</span>
                    {/if}
                  </button>
                {/each}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </section>
  {:else}
    <!-- 列表模式（D66）：栏头带 + 五态壳在标准控件 ListPane 里，这一页给内容。
         栏头没有标题——它与顶栏页名一字不差（同一个词条 `shell.navTasks`），
         同页上下写同一句话看起来像渲染错了。 -->
    <ListPane
      countLabel={$t('tasks.listCount', { count: visible.length })}
      searchPlaceholder={$t('tasks.search')}
      filter={filter}
      onFilter={(v) => (filter = v)}
      loading={($loading['issues'] && $issues.length === 0) ?? false}
      loadError={$loadError['issues'] ?? null}
      empty={stageCol === 'all' && !filter && visible.length === 0}
      emptyTitle={$t('tasks.empty')}
      emptyHint={$t('tasks.emptyHint')}
      emptyFiltered={(stageCol !== 'all' || filter !== '') && visible.length === 0}
      emptyFilteredTitle={
        filter !== ''
          ? $t('tasks.emptyFiltered')
          : $t('tasks.emptyStage', { stage: $t(activeColTitle ?? 'tasks.filterAll') })
      }
      emptyFilteredHint={
        filter !== '' ? $t('tasks.emptyFilteredHint') : $t('tasks.emptyStageHint')
      }
    >
      {#snippet top()}
        <!-- ★ 2026-11：状态筛选 chips + 分组/平铺切换。
             ⚠️ 放 **top 插槽**（ListPane 的 empty 分支之外、常驻）：筛选出 0 结果时
             列表显示空态，若工具条跟着 rows 一起消失，使用者会被锁死在空态里
             切不回「全部」（用户实测踩到："选中进行中内容都消失了"）。 -->
        <div class="list-tools">
          <div class="stage-chips" role="group" aria-label={$t('tasks.filterLabel')}>
            <button
              type="button"
              class:active={stageCol === 'all'}
              onclick={() => (stageCol = 'all')}
            >
              {$t('tasks.filterAll')} {searched.length}
            </button>
            {#each colCounts as c (c.key)}
              <button
                type="button"
                class:active={stageCol === c.key}
                onclick={() => (stageCol = c.key)}
              >
                {$t(c.titleId)} {c.n}
              </button>
            {/each}
          </div>
          <div class="view-switch" role="group" aria-label={$t('tasks.viewSwitchLabel')}>
            <button
              type="button"
              class:active={viewMode === 'group'}
              onclick={() => setViewMode('group')}
            >
              {$t('tasks.viewGroup')}
            </button>
            <button
              type="button"
              class:active={viewMode === 'flat'}
              onclick={() => setViewMode('flat')}
            >
              {$t('tasks.viewFlat')}
            </button>
          </div>
        </div>
      {/snippet}
      {#snippet loadingSkeleton()}
        <div class="skeleton"></div>
        <div class="skeleton"></div>
      {/snippet}
      {#snippet rows()}
        {#if viewMode === 'group'}
          <ul class="list-stack task-list">
            {#each groups as g (g.key)}
              <!--
                ★ 2026-11（D137）：组头改用标准控件 `ListGroupHead`，行与它**平级**。
                  改之前是 `<li class="task-group">` 里套 `<li class="list-row">`（结构不合法，
                  浏览器能忍），而且组头样式与智能体页那套各写一份、还长得不一样。
                  `data-task-group` 仍挂在组头上——探针按它认组（键没变，判据不用改）。
              -->
              <ListGroupHead
                label={g.name}
                count={$t('tasks.groupCount', { n: g.items.length })}
                open={!collapsedGroups.has(g.key)}
                ontoggle={() => toggleGroup(g.key)}
                groupKey={g.key}
              />
              {#if !collapsedGroups.has(g.key)}
                {#each g.items as { issue, info } (issue.id)}
                  {@render row(issue, info)}
                {/each}
              {/if}
            {/each}
          </ul>
        {:else}
          <!-- ★ 2026-11（使用者："平铺改一下，去掉之前的分类"）：平铺 = 纯时间倒序，
               不再分「需要注意 / 其余」两拨（分组视图按来源分组、平铺按时间，
               两个视图都不再做"需注意置顶"）。行上该显示的警告（执行失败等）仍在
               每行的标签/提示里。 -->
          <ul class="list-stack task-list">
            {#each staged as { issue, info } (issue.id)}
              {@render row(issue, info)}
            {/each}
          </ul>
        {/if}
      {/snippet}
    </ListPane>
  {/if}

  <!-- ══════════════════ 右栏：建任务 / 任务详情（宽屏并排 / 窄屏整页）══════════════════ -->
  {#if mode === 'list'}
    <!-- ★ 右主区（D69.15）：壳 / 栏头 / 空态统一在 MainArea，正文三态自管。
         建任务 / 任务详情 / 没选中 都走同一个壳；栏头（返回+标题+副题）由
         MainArea 的结构化 props 渲染——从此详情栏头固定在上方、不再跟着滚走
         （与聊天的 chat-head 同一形态，这正是统一的意义）。
         ★ 三轮：沉淀已搬到独立一页（导航列工具之下），任务页只留这一格入口
         ★ 分批第 39 批：名字改成「沉淀技能&智能体」——分批第 34–38 批之后它也能改
           智能体的指令，名字只提 skill 等于把那条路从名字上藏起来（使用者原话：
           「之前的名字以为只有 skill」）
           入口按钮；这里不再有流程页分支。 -->
    <MainArea
      empty={!$creating && !selected}
      emptyTitle={$t('tasks.pickOneTitle')}
      emptyHint={$t('tasks.pickOneHint')}
      headClass={$creating ? 'detail-head create-head' : 'detail-head'}
      backLabel={selected ? $t('tasks.backToList') : undefined}
      onBack={() => selectedIssueId.set(null)}
      title={$creating ? $t('shell.navNewTask') : wfRunForSelected ? undefined : selected?.title ?? ''}
      bodyClass={$creating ? 'create-body' : logMode ? 'detail-scroll log-mode' : 'detail-scroll'}
    >
      {#snippet sub()}
        {#if $creating}
          <span class="faint">{$t('shell.navNewTaskHint')}</span>
        {:else if selected}
          {#if selectedStage}
            <span class="stage-tag {selectedStage.stage}"
            >{$t(stageShortId(selectedStage.stage))}</span
          >
          {/if}
          <span class="faint">{agentName(selected.assignee?.id ?? null)}</span>
          <!-- ★ 完整时间戳放在栏头副题：列表只剩日期了（见 D42 原注释） -->
          <span class="faint">{$t('tasks.updatedAt', { time: new Date(selected.updatedAt).toLocaleString() })}</span>
        {/if}
      {/snippet}
      {#snippet actions()}
        {#if selected && !$creating}
          <!--
            D80：任务「沉淀技能&智能体」按钮（§4.3）——按钮可用 ⟺ 任务 run 终态
            且（有用户反馈 或 审核过）。置灰时 title 说明"为什么灰"。
            ★ 三轮：点按钮**跳到沉淀页**（`#/crystallize/<runId>`），流程在那里进行。
          -->
          <!--
            ★ 分批第 265 批（使用者："任务页也一样，需要有『沉淀技能』和『删除任务』2 个按钮"）：
            栏头这一排现在两格：沉淀技能&智能体 / 删除任务，与聊天页那排同一种工具条
            （样式在 `app.css` 的 `.detail-head .detail-actions` 里，一处定义）。
            ⚠️ 「删除任务」原来**只在列表行右侧**有个 ×：选中一个任务之后想删它，得先回列表
              找到那一行。同一个动作现在两处都有，用的是同一个 `removeTask`（含确认框）。
          -->
          <button
            type="button"
            class="btn btn--ghost"
            disabled={!canOptimizeSkill}
            title={canOptimizeSkill ? '' : $t('tasks.optimizeNeedsFinishedRun')}
            onclick={() => goCrystallize(activeRun?.runId ?? '')}
          >
            {$t('crystallize.optimize')}
          </button>
          <button
            type="button"
            class="btn btn--danger"
            data-task-delete
            onclick={() => void removeTask(selected.id)}
          >
            {$t('tasks.delete')}
          </button>
        {/if}
      {/snippet}
      {#snippet body()}
        {#if $creating}
          <NewTaskForm />
        {:else if wfRunForSelected}
          <!-- ★ 编排任务（2026-11 再改）：主区直接显示运行画面（步骤链 + 日志 +
               工作目录树）——与「编排任务」视图的右栏同一形态（embedded 隐藏
               返回按钮，栏头由 WorkflowRunView 自带标题/状态/控制）。 -->
          <WorkflowRunView runId={wfRunForSelected.id} embedded />
        {:else if selected}
          {#key selected.id}

  <!--
    ★ 「这一次是谁审的」（D42；2026-10 收成两态）。

  <!-- 2026-11（使用者："任务里面，不需要显示「这次由谁审」…"）：整块删掉——
       标题 + 两种显示（没审核者的长解释、有审核者的名字+来源）都不画。
       审核行为不受影响（reviewer 仍随 run 记录，这里只是详情页不再说）。 -->

  <section class="drawer-section">
    <h3>{$t('tasks.runsHeading')} <span class="faint fs-xs">（{issueRuns.length}）</span></h3>

    {#if issueRuns.length === 0}
      <div class="empty">
        <strong>{$t('tasks.neverRunTitle')}</strong>
        {$t('tasks.neverRunHint')}
      </div>
    {:else}
      <div class="run-tabs">
        {#each issueRuns as run (run.runId)}
          <button
            type="button"
            class="run-tab"
            class:active={activeRun?.runId === run.runId}
            onclick={() => selectRun(run)}
          >
            <span class="badge {runStatusClass(run.status)}"
              >{$t(runStatusKey(run.status))}</span
            >
            <!-- ★ 类型与时间必须显示：只给状态和 runId 的话，使用者**看不出
                 哪个先哪个后**——他只能凭感觉，于是会觉得"顺序不对"。 -->
            <span class="fs-xs">{run.kind === 'review' ? $t('tasks.kindReview') : $t('tasks.kindExecute')}</span>
            <span class="mono faint fs-xs" title={new Date(run.queuedAt).toLocaleString()}>
              {formatRunStamp(run.queuedAt)}
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </section>

  {#if selected.description}
    <!-- ★ D69.9：描述是**任务原文**（可能很长）——跑过之后默认折叠（首行标题行
         常驻），未跑的任务展开它（那是唯一的正文）。 -->
    <FoldSection title={$t('tasks.descriptionHeading')} open={issueRuns.length === 0}>
      <p class="hint" style="white-space:pre-wrap">{selected.description}</p>
    </FoldSection>
  {/if}

  {#if activeRun}
    <section class="drawer-section run-section">
      <h3>
        {activeIsTerminal && !showRawLog ? $t('tasks.finalResult') : $t('tasks.rawLog')}
        <span class="faint fs-xs mono"
          >{$t('tasks.runIdLabel', { id: activeRun.runId.slice(-8) })}</span
        >
        {#if activeIsTerminal}
          <!-- 跑完之后默认给结论；原始流水仍然一条不少，按需翻 -->
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            style="margin-left:var(--sp-3)"
            onclick={() => (showRawLog = !showRawLog)}
          >
            {showRawLog ? $t('tasks.showFinalResult') : $t('tasks.showRawLog')}
          </button>
        {:else}
          <!--
            ★ 2026-10（使用者要求重排）：「取消这次执行」从日志区底部的独立按钮
              挪进 run 的头部工具栏——它操作的就是**这条 run**，放在 run 自己的
              标题行（紧挨 run id）语义才对得上，而且只在这条 run 还能停的时候
              出现：跑完（completed/failed/cancelled）按钮随之消失，不再留一个
              永远灰着的占位（原来那个按钮正是这样：run 结束后照常显示、永久
              disabled，且没有任何"为什么灰"的说明——违背按钮置灰必须写出来的
              那条纪律）。

              ⚠️ 终态切换按钮（上面）与停止按钮**互斥**出现：前者只在跑完显示，
              后者只在跑着显示，所以两个按钮不会同排。可取消 = 非终态（queued /
              dispatched / waiting_local_directory / running / deferred），与
              daemon 的 `executor.cancel()` 覆盖的范围一致；deferred 点取消可能
              409（它还没被调度），这是既有行为，不在这里展开。
          -->
          <button
            type="button"
            class="btn btn--danger btn--sm"
            style="margin-left:var(--sp-3)"
            onclick={() => cancel(activeRun!.runId)}
          >
            {$t('tasks.cancelRun')}
          </button>
        {/if}
      </h3>

      <!-- ★ 取消失败要看得见：按钮就在上面一行，错误紧跟其后（触发它的地方） -->
      {#if runError}
        <p class="notice bad">{runError}</p>
      {/if}

      {#if activeIsTerminal && !showRawLog}
        <!-- ══════════ 最后结果：左结论 / 右产出文件 ══════════ -->
        <div class="result-grid">
          <div class="result-main">
            {#if renderedResult}
              <article class="markdown">{@html renderedResult}</article>
            {:else if finalOutputFor === activeRun.runId && finalOutput !== '' && resultText === ''}
              <!-- ★ 正文里**只有**判决块（审核那条路很常见）：剥完之后一个字都不剩。
                   这时**不能**沿用下面那个空态——"这次执行没有留下文字产出 / 它可能
                   只改了文件、或者中途失败了"在这里是**说错话**：它明明产出了判决，
                   只是那一段是机器读的。说错话比空着更糟。 -->
              <div class="empty">
                <strong>{$t('tasks.verdictOnly')}</strong>
                {$t('tasks.verdictOnlyHint')}
              </div>
            {:else if finalOutputFor === activeRun.runId && finalOutput === ''}
              <div class="empty">
                <strong>{$t('tasks.noTextOutput')}</strong>
                {$t('tasks.noTextOutputHint')}
              </div>
            {:else}
              <div class="skeleton skeleton--block"></div>
            {/if}
          </div>

          <aside class="result-files">
            <h4>{$t('files.heading')}</h4>
            <!--
              工作目录那一栏现在与聊天**共用**一个组件（`WorkDirTree.svelte`）：
              两处的差别只有"问谁"——这里按某次执行的目录问。判据（排序、注入物
              弱化、一次一层、取不到时说什么）都在那一个组件里，见它的注释。
            -->
            <WorkDirTree base={`/api/runs/${activeRun.runId}`} reloadKey={activeRun.runId} />
          </aside>
        </div>
      {:else}
        <!-- ⚠️ 这里曾经传 `since={activeRun.lastSeq}`，而那个字段是"库里已有的最后
             一条消息的序号"。`since` 的语义是"跳过它及之前的一切"，于是打开一条
             已经跑完的任务时全部历史都被跳过 —— 日志空的，agent 的最后产出看不到。
             订阅游标现在由 RunLog 自己持有，父组件没有机会传错。 -->
        <RunLog runId={activeRun.runId} onterminal={() => void refresh()} fill />
      {/if}

      {#if !logMode}
      <!--
        ⚠️ 2026-11（D125）：这里原来是**判决卡**——这条 run 的每条判决一张卡片
        （结论徽标 + 理由码 + 置信度/人工标记 + 证据明细 + 升级原因）。
        判决退场 ⇒ 整段删。

        ⚠️ 「结论值不翻译、旁边给本地化显示名」那条做法没有过期：**契约值原样
        显示、旁边再给人话**，谁也不会误会哪个是真的。
      -->

      <!-- ★ D69.9：元数据（工作目录/类型/耗时）默认折叠；标题行把工作目录
            放在摘要位——它常常是唯一想确认的那一项 -->
      <FoldSection title={$t('tasks.metaHeading')} summary={activeRun.workDir ?? ''}>
        <dl class="meta-grid">
          <dt>{$t('tasks.workDir')}</dt>
          <dd class="mono">{activeRun.workDir ?? '—'}</dd>
          <dt>{$t('tasks.type')}</dt>
          <dd>{activeRun.kind === 'review' ? $t('tasks.kindReview') : $t('tasks.kindExecute')}</dd>
          <!-- ⚠️ 2026-11（D125）：`kindReview` 只服务**老记录**——新 run 只有 execute。 -->
          {#if activeRun.finishedAt}
            <dt>{$t('tasks.duration')}</dt>
            <dd>{$t('tasks.seconds', { seconds: ((activeRun.finishedAt - activeRun.queuedAt) / 1000).toFixed(1) })}</dd>
          {/if}
        </dl>
      </FoldSection>
      {/if}

    </section>
  {/if}

      <!--
        ══════════════════════════════════════════════════════════════
        ★ 人的出路：反馈 / 放弃（D47；D125 之后只剩这两个）
        ══════════════════════════════════════════════════════════════

        位置：**紧跟在这次 run 的结果区之后**。这里原来放的是「人工裁决」那块面板
        （D46：通过 / 反馈 / 放弃三个出路），它回答的是"审核说不行，我能不能
        自己说行"。**判决与人工裁决面板一起退场**（D125）⇒ 「通过」没有了，那块
        面板只剩下两个**出路**。

        ★ 它同时**取代了原来那个常驻底栏**（「发送并继续」）：D47 把两者合并了
        ——「反馈」就是「发送并继续」。所以这块必须覆盖底栏原来覆盖的范围，否则
        "已经跑完的任务再也说不出下一句"。

        开关是 `canDecide`（**只要选中了任务就给**），两个按钮各有自己的可用性：

          · 反馈：要有一次**跑完**的执行可以接（`feedbackReady`），否则置灰 + 说清为什么；
          · 放弃：只在支持这条路由的 daemon 上给，且放弃后换成「恢复」。

        ⚠️ 开关为什么放宽到"只要选中了任务"：两个按钮的可用条件不同，用其中任何
           一个当整块的开关，都会让另一个在**本该可用**时消失。最典型的是「放弃」
           ——一条刚建出来、一次都没跑的、或者**正在跑**的任务，恰恰是最想放弃它的
           两种情形（建错了 / 在烧 token）。

        两件事在文案里刻意说清了（见 `packages/i18n/src/web/tasks.ts` 里
        `decide*` 那组注释）：
          ① 理由**必填**——这段文字就是执行者拿到的依据；
          ② 「放弃」会**取消正在跑的 run**（这个功能唯一的副作用）。
      -->
      {#if canDecide && !logMode}
        <section class="drawer-section decide-bar">
          {#if isAbandoned}
            <!-- 放弃过的任务只给一条出路：恢复。它已经出局了，不该再出现三个
                 能改流程的按钮——那会让人以为它还在流程里。 -->
            <p class="faint fs-xs">{$t('tasks.abandonNote')}</p>
            {#if canAbandon}
              <button
                type="button"
                class="btn btn--primary"
                disabled={deciding !== null}
                title={deciding !== null ? $t('common.busyHint') : undefined}
                onclick={() => setAbandoned(false)}
              >
                {deciding === 'recover' ? $t('tasks.decideAbandoning') : $t('tasks.decideRecover')}
              </button>
            {/if}
          {:else}
            <label class="human-reason">
              <span class="fs-xs reason-label">{$t('tasks.decideReasonLabel')}</span>
              <textarea
                bind:value={humanReason}
                rows="3"
                placeholder={$t('tasks.decideReasonPlaceholder')}
                disabled={deciding !== null}
                onkeydown={(e) => {
                  // Ctrl/Cmd+Enter = 反馈。「接着干」是高频动作，不该逼人去够鼠标
                  //（这条快捷键原来是底栏那个按钮的，合并之后跟着搬过来）。
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') feedback()
                }}
              ></textarea>
            </label>

            <div class="decide-actions">
              <button
                type="button"
                class="btn btn--primary"
                disabled={deciding !== null || !feedbackReady}
                title={feedbackReady
                  ? $t('tasks.decideFeedbackHint')
                  : $t('tasks.needRunForFeedback')}
                onclick={feedback}
              >
                {deciding === 'feedback'
                  ? $t('tasks.decideFeedbacking')
                  : $t('tasks.decideFeedback')}
              </button>
              {#if canAbandon}
                <button
                  type="button"
                  class="btn btn--danger"
                  disabled={deciding !== null}
                  title={$t('tasks.decideAbandonHint')}
                  onclick={() => setAbandoned(true)}
                >
                  {deciding === 'abandon' ? $t('tasks.decideAbandoning') : $t('tasks.decideAbandon')}
                </button>
              {/if}
            </div>

            <!--
              ★ 按钮为什么是灰的 —— **必须写出来**，而且要在按钮之外也写一遍：
                `title` 只有鼠标悬停才看得见，而"按钮是灰的、不知道为什么"
                正是 D46 那次需求的来源（"没有可点的 UI"）。
            -->
            {#if !feedbackReady}
              <p class="faint fs-xs">{$t('tasks.needRunForFeedback')}</p>
            {/if}
          {/if}

          {#if decideError}
            <div class="notice bad" style="margin-top:var(--sp-2)">{decideError}</div>
          {/if}
        </section>
      {/if}
          {/key}
        {/if}
      {/snippet}
    </MainArea>
  {/if}
</div>

<style>
  /**
   * ══════════════════════════════════════════════════════════════════
   * 建任务那一栏：**留白归表单自己**（这里 `padding: 0`）
   * ══════════════════════════════════════════════════════════════════
   *
   * 右栏平时（任务详情）用的是 `.pane-body` 自己的留白。建任务这一栏不一样：
   * 表单底部那条提交栏是 `position: sticky` + **负外边距**去抵消容器的内边距
   * （不留负边距的话，滚过去的内容会从它两侧露出来），也就是说"容器的内边距"
   * 与"提交栏的负外边距"是**一对**、必须相等。
   *
   * ⚠️ 两边各写一份 `var(--sp-6)` 就是一对会漂移的常量（改了一处、另一处不报错，
   *    只是提交栏左右各差 24px）。所以这里把内边距**归零**、由 `.form-frame`
   *    自己带——一份留白，一个出处。
   */
  /* D69.15：`.create-body` 是 MainArea 渲染的（bodyClass），Tasks 的 scoped
     样式跨不过组件边界——打成 :global 才能命中。
     ⚠️ 写成 `:global(.pane-body.create-body)` 而不是 `.create-body`：后者与
     app.css 的 `.pane-body`（padding）同特异性，bundle 里 `.pane-body` 靠后、
     会把 `padding: 0` 盖掉——实测 frame 宽度差 48px、提交栏横贯不了可滚区。
     双类选择器特异性升到 (0,2,0)，与出现顺序无关地稳压。 */
  :global(.pane-body.create-body) {
    padding: 0;
  }

  /**
   * ★ 这一栏的左右留白**只有一个出处**：`--create-pad-x`。
   *
   * 三个地方读它：栏头（`.detail-head.create-head`）、表单的 `.form-frame`、
   * 以及提交栏那两个负外边距（要抵消掉同一份留白才横贯整栏）。
   *
   * ⚠️⚠️ **D214：这个变量原来定义在 `.pane-body.create-body` 上，而栏头是它的兄弟**
   *   ——自定义属性只沿**子树**继承，兄弟读不到 ⇒ `.detail-head.create-head` 里那句
   *   `padding: … var(--create-pad-x) …` 变成"无效值"，整条声明在计算时被丢弃，
   *   **栏头内距塌成 0**（实测 `0px/0px/0px/0px`，标题贴着栏边；而其它三个"新建"
   *   视图都是 16/24/12）。
   *   现在定义在**共同祖先** `.detail-pane` 上（用 `:has()` 定位到"这一栏正在新建"），
   *   栏头与正文同时继承到同一个值，断点也只改一处。
   */
  :global(.detail-pane:has(> .pane-body.create-body)) {
    --create-pad-x: var(--sp-6);
  }

  /* 与 `.main` 同一条断点、同一个值（窄窗口下平台各处都收一档留白） */
  @media (width < 60rem) {
    :global(.detail-pane:has(> .pane-body.create-body)) {
      --create-pad-x: var(--sp-4);
    }
  }

  /* 这一栏自己的小标题（返回列表 / 新建任务 / 交给智能体去做）：留白跟着上面那个变量
     （D69.15：MainArea 渲染，:global）。
     ⚠️ 必须写双类 `:global(.detail-head.create-head)`：app.css 现在给 `.detail-head`
     统一了留白/下边框（标题字号统一那轮），单类 `.create-head` 与它同特异性、bundle
     里 app.css 靠后会把它盖掉——双类 (0,2,0) 稳压，留白继续跟 `--create-pad-x`。 */
  :global(.detail-head.create-head) {
    padding: var(--sp-4) var(--create-pad-x) 0;
  }

  /* ══════════════ 列表：两行的行（标题 + 元信息）══════════════ */

  /* ⚠️ 这三行**必须有**：容器是 `<ul>`（每项要放"整行可点的主按钮 + 兄弟删除
     按钮"，`li` 才装得下），而 `ul` 自带 `padding-inline-start: 40px` 与圆点
     标记——不归零的话整列内容会**整体右移 40px 并多出一排圆点**（实测的表现
     就是"内容怎么靠右了"）。与聊天页 `.conv-list` 同一处理。 */
  /* ⚠️ 2026-11：重置 + 行距移到全局 `.list-stack`（markup：`class="list-stack
     task-list"`）——六个列表页同一份，不再各写六行。 */

  /* ★ 整行可点 + 右侧独立删除按钮（与「智能体」「聊天」两栏同形）：
       `li` 容器里放主按钮（flex:1）+ 兄弟删除按钮。 */
  /* ★ 列表模式的栏头（D61）：与聊天页那个"只有标题"的栏头**同高同款**
     （`.list-head` / `.list-toolbar` 共用 `--list-head-h`，见 app.css）。
     没有标题（与页名重复），左边计数、右边搜索，搜索框不再独行。 */
  .list-toolbar {
    align-items: center;
  }

  /* 删除按钮：默认几乎不可见，hover 才露出危险色——扫列表时不该被一排 × 吵到 */
  /* ⚠️ 2026-11（D142）：共用部分（display / 基线对齐 / gap / 字号 / 字色）走 app.css 的
     `.list-row-sub`；这里只留**这一页的形状**：允许换行（任务元信息里有阶段标签 + 三段时间），
     且换行也只占一行的高度。 */
  .task-meta {
    flex-wrap: wrap;
    min-height: 1.2em;
  }

  /*
    单行 + 省略号：行高因此与标题长度**无关**（每行一样高）。
    `display:block` 是必需的——行内元素上 `text-overflow` 不生效。
  */
  .task-title {
  /* D190：截断四行收进全局 `.ellipsis`（markup 里已经带上） */
    display: block;
    font-weight: 600;
  }

  /* D65：阶段标签与平台徽标（`.badge`）**同一条配方**——胶囊 + 圆点 + 10% 底 +
     28% 发丝边。原来它是描边方角（r4px、无底无点），和智能体的角色徽标、技能/工具
     页的徽标是两种形状。改完之后任务列表与看板里的阶段 chip 都变成胶囊。 */
  /*
   * 阶段标签 = **`.badge` 的一个变体**（2026-11，D142）。
   *
   * 原来这里是一整套"再画一遍"（胶囊 + 圆点 + 10% 底 + 28% 边 + inline-flex），
   * 与 `.badge` 逐条重复——重复的代价不只是代码：`.badge` 修基线的时候它没跟着修
   * （`.badge` 的 `::before` 圆点让基线落在圆点上，比旁的文字低 1.9px），
   * 于是任务页那一行照样歪。
   * 现在形状全部来自 `.badge`，这里只留**竖内距 0**（`0.1rem` 会把任务行撑高 2-3px）。
   */
  .stage-tag {
    padding: 0 var(--sp-2);
  }

  /* 阶段色与看板的列色一致：同一件事在两个视图里该是同一个颜色。
     ⚠️ 只设 `color`：描边与底都从 currentColor 派生（color-mix），
     与 `.badge` 同一条配方。 */
  .stage-tag.executing { color: var(--status-active); }
  .stage-tag.awaiting_review { color: var(--status-review); }
  .stage-tag.reviewed { color: var(--status-done); }
  /* "待人工"用告警色：它是**卡在你手里**那一档——不是进行中，也不是完成 */
  .stage-tag.needs_human { color: var(--warn); }
  /* ★ D47「已放弃」用**最弱**的颜色，不是告警色也不是完成色：它既不是"出事了"
     （放弃是人的决定，不是故障），也不是"做完了"（它只是出局了）。中性灰是唯一
     不会误导读者的选择——这条任务既不需要你管，也没有做成什么。 */
  .stage-tag.abandoned { color: var(--text-faint); }

  /* ══════════════ 分组视图（2026-11，使用者立项）══════════════ */
  .list-tools {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    padding: 0 var(--sp-3) var(--sp-2);
    flex-wrap: wrap;
  }
  /*
   * ⚠️ 2026-11（D136）：分组视图里的行原来**没有行距**（0px），而平铺视图/聊天/智能体
   *   都是 `var(--sp-1)`——因为 `.list-stack` 的 `gap` 只作用于它的**直接子项**，
   *   而分组视图里那些子项是 `.task-group`，行在组内是普通块级堆叠。
   *   结果：同一个列表，换个视图行与行就贴在一起（hover 框互相咬住）。
   *   判据是探针 `skeleton.listBox`（五页行距都是 4px）。
   */
  /*
   * ⚠️ 2026-11（D137）：这里原来有 `.task-list--grouped .task-group` + `.group-head` /
   *   `.group-arrow` / `.group-name` / `.group-count` 一整套（带边框的卡片式组头）。
   *   现在组头是标准控件 `ListGroupHead`、样式在 `app.css` 的 `.list-group-head` 一族，
   *   页面里一个字都不写。
   */

  /* 跑完之后：左边结论、右边产出文件（D69.9.1 从折叠区挪回——文件是高频项） */
  .result-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(14rem, 20rem);
    gap: var(--sp-4);
    align-items: start;
  }

  @media (width < 60rem) {
    /* 窄屏堆起来：两栏挤在 800px 里两边都不能读 */
    .result-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .result-files {
    border-left: 1px solid var(--line);
    padding-left: var(--sp-4);
  }

  .result-files h4 {
    margin: 0 0 var(--sp-2);
  }

  /*
    人的三个出路共用那一个输入框（D46 + D47）。
    
    ★ `min-width: 0` 不是装饰：这一块在窄屏下是**整宽**的，而宽屏下详情栏只有
      半栏——不加它，输入框的固有宽度会把这一栏顶出容器（D44 那次实测过：
      `.field-row` 缺 `min-width:0` 时 950px 的内容撑破了 725px 的栏位）。
    ★ `box-sizing: border-box` 同理：宽度按容器算，不按内容算。
  */
  .human-reason {
    display: block;
    margin: var(--sp-3) 0 var(--sp-2);
    min-width: 0;
  }

  .human-reason textarea {
    display: block;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    margin-top: var(--sp-1);
    font-family: inherit;
    font-size: var(--fs-sm);
    padding: var(--sp-2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--text);
    resize: vertical;
  }

  /* ── 日志视图 = flex 纵向布局（D69.12）：日志吃满剩余空间、内置滚动，
     **外置滚动条消失**（使用者：点「看完整日志」出现两个滚动条——内置+外置，
     不该有外置那个）。
     flex 链：pane-body(flex col, overflow hidden) → .run-section(flex 1, flex col)
         → RunLog 的 .log-wrap(flex 1, flex col) → .log(flex 1, 内部滚动)。
     只有日志视图才 flex——结果视图保持整栏滚动 + sticky 裁决条。
     ⚠️ D69.15 起 pane-body 由 MainArea 渲染（bodyClass 传入 `log-mode`），
     scoped 样式跨不过组件边界——三个选择器打成 :global 才能命中。 */
  :global(.detail-scroll.log-mode) {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  :global(.detail-scroll.log-mode) > * {
    flex-shrink: 0;
  }
  :global(.detail-scroll.log-mode) .run-section {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    margin-bottom: 0;
  }

  /* ── 人工裁决条（D69.10）：内容超出一屏时**固定在本栏底部**（sticky bottom），
     「通过 / 反馈 / 放弃」永远够得着；不满一屏时自然跟在正文后面。
     ⚠️ 实底背景 + 顶边是必须的：内容从条底下滚过时不透字。
     ⚠️ **不给结果/报告区定高**：它们用自然高度、吃满可用的一屏，裁决条只靠
     sticky 钉底——固定高低会把可用空间框死或浪费掉。 */
  .decide-bar {
    position: sticky;
    bottom: 0;
    z-index: 2;
    background: var(--bg);
    margin: var(--sp-2) calc(-1 * var(--sp-5)) 0;
    padding: var(--sp-3) var(--sp-5) var(--sp-4);
    border-top: 1px solid var(--line);
  }

  /* 三个按钮并排。
     ⚠️ `flex-wrap` 是必需的：窄屏下「通过 / 反馈 / 放弃」加上中文标签会超过
        详情栏宽度，不换行就会把那一栏顶出容器（与上面 `min-width:0` 是同一类
        事故，只是这次是按钮而不是输入框）。 */
  /* D69.13+D69.14：「理由 / 反馈内容」独立加粗（「这条任务怎么办」标题已删，它现在是这块的醒目行） */
  .human-reason .reason-label {
    font-weight: 600;
  }

  .decide-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }

  /* ── 流水线看板 ──
     阶段档位：执行中 / 已结束（+ 已放弃，**不是流水线的一站**，见 `PIPELINE_COLUMNS`）。

     ★★ 2026-11（D192）：**这一族"固定列数"的规则整族删掉了**（`.board-6` 的
        `repeat(6)` + 三个断点阶梯 110rem / 64rem / 60rem）。它们从来没有生效过：
        `.board` 那条 `repeat(auto-fit, minmax(10rem, 1fr))` 写在**后面**、特异性相同，
        于是把 `repeat(6)` 与它的每一步阶梯全压住了。实测（1920 宽的窗口、看板里
        两个状态）：列宽 810 / 810 —— 那是 `auto-fit` 算的两列，不是 `repeat(6)` 的
        六分之一。也就是说界面上一直是"有几个状态就几列、宽度不够自动折行"，
        而样式表里写的却是另一回事。
        ★ 留下来的这个行为本来就是对的（列数该跟着 `PIPELINE_COLUMNS` 走：状态
        从三列并成两列之后，"固定六列"只是历史残留），所以删的是规则，不是行为——
        `.board` 的 auto-fit 就是唯一那一份定义。 */

  .col-hint {
    display: block;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    margin-top: 2px;
  }

  .column-label {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0;
  }

  .col-empty {
    padding: var(--sp-3) var(--sp-2);
    margin: 0;
  }

  .card-meta {
    display: flex;
    justify-content: space-between;
    gap: var(--sp-2);
  }

  /* 需要留意的情况用一条左侧色条，而不是整块变红——
     整块变红会让"有一处小问题"看起来像"这张卡坏了" */
  .card-warning {
    display: block;
    font-size: var(--fs-xs);
    color: var(--warn);
    border-left: 2px solid var(--warn);
    padding-left: var(--sp-2);
    margin-top: var(--sp-1);
  }

  /**
   * 判决卡里的动作块（D45 的显示位置调整）。
   *
   * 用左侧一道**中性**细线把它标成"这张卡的后续"——与 `.card-warning` 同一套
   * 视觉语言（都是"挂在某句话下面的东西"），但颜色不同：`card-warning` 是
   * **出事了**的语气，而动作块大多数时候是"顺利做完了"，用警告色会平白吓人。
   */
  .action-line {
    border-left: 2px solid var(--line);
    padding-left: var(--sp-2);
    margin-top: var(--sp-2);
  }

  /* ── 看板 ── */
  .board {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--sp-3);
    align-items: start;
  }

  .column {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2);
    min-height: 5rem;
  }

  /* 标签档：12px 大写 + faint（不是标题层级里的任何一级，见 ui-style.md §2.9） */
  .column-label {
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-faint);
    margin: var(--sp-1) var(--sp-2) var(--sp-2);
    display: flex;
    justify-content: space-between;
  }

  .card {
    display: block;
    width: 100%;
    text-align: left;
    background: var(--surface-2);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: var(--sp-2);
    margin-bottom: var(--sp-1);
    cursor: pointer;
    color: var(--text);
  }

  .card:hover {
    background: var(--surface-hover);
    border-color: var(--line-strong);
    filter: none;
  }

  .card-title {
    display: block;
    font-size: var(--fs-sm);
    margin-bottom: 2px;
  }

  /* ── 执行记录标签 ── */
  .run-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }

  .run-tab {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    background: var(--surface);
    border: 1px solid var(--line);
    color: var(--text-dim);
    padding: var(--sp-1) var(--sp-3);
    border-radius: var(--radius-pill);
  }

  .run-tab.active {
    border-color: var(--accent);
    color: var(--text);
  }

  /* ── 元信息栅格 ── */
  .meta-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--sp-1) var(--sp-4);
    margin: 0 0 var(--sp-3);
    font-size: var(--fs-sm);
  }

  .meta-grid dt { color: var(--text-faint); }
  .meta-grid dd { margin: 0; word-break: break-all; }

  :global(.btn--ghost.active) {
    background: var(--surface-2);
    color: var(--text);
  }
</style>
