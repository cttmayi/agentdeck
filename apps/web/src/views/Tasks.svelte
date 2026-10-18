<script lang="ts">
  import { onDestroy } from 'svelte'
  import ListPane from '../components/ListPane.svelte'
  import ListRow from '../components/ListRow.svelte'
  import MainArea from '../components/MainArea.svelte'
  import CrystallizeView from '../components/CrystallizeView.svelte'
  import {
    api,
    newRunId,
    type ActionView,
    type RunMessage,
    type RunSummary,
    type VerdictActionView,
    type VerdictView,
    type WorkDirFile,
    type WorkDirListing,
  } from '../lib/api.ts'
  import { renderMarkdown } from '../lib/markdown.ts'
    import { agents, identity, issues, loadIssues, loadRuns, loading, loadError, runs, deleteTask, loadSkills } from '../lib/stores.ts'
  import { clearPageActions, setPageActions } from '../lib/page-actions.ts'
  import { leaveCreate } from '../lib/leave-create.ts'
  import { creating, goCreate, go, selectedIssueId, showToast } from '../lib/view.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import { absoluteTime, relativeTime } from '../lib/time.ts'
  import { finalResultText } from '../lib/final-output.ts'
  import {
    PIPELINE_COLUMNS as COLUMNS,
    TERMINAL_RUN_STATUSES,
    formatRunStamp,
    runsForIssue,
    splitByAttention,
    stageOf,
    stageShortId,
  } from '../lib/pipeline.ts'
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

  /**
   * run 状态 → 徽标颜色类。
   *
   * ★ 协议里的 `RunStatus` 有 8 个值，而 `app.css` 的状态色只覆盖了
   *   `completed`/`failed`/`cancelled` 三个——`running`/`queued`/`dispatched`/
   *   `deferred`/`waiting_local_directory` **原来一个颜色都没有**（徽标落回
   *   `currentColor`，看起来"没有状态"）。这里映射到已有的那批语义色，
   *   不新增 CSS 变量：`queued`/`deferred`/`waiting_local_directory` 都表示
   *   "还没轮到它"，与看板的待办同色。
   */
  const RUN_STATUS_CLASS: Record<string, string> = {
    queued: 'backlog',
    deferred: 'backlog',
    waiting_local_directory: 'backlog',
    dispatched: 'in_progress',
    running: 'in_progress',
    completed: 'done',
    failed: 'failed',
    cancelled: 'cancelled',
  }

  /** 状态徽标里的字：走词表（`term.runStatus.*`），**不显示协议英文值**。 */
  function runStatusLabel(status: string): WebTextId {
    return `term.runStatus.${status}` as WebTextId
  }

  /** 相对时间的「现在」——每次响应式更新重算一遍。 */
  $: now = Date.now()
  $: staged = visible
    .slice()
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map((issue) => ({ issue, info: stageOf(issue, $runs) }))

  /** 当前打开那个任务的阶段——详情头要显示它（不该在模板里算两遍）。 */
  $: selectedStage = selected ? stageOf(selected, $runs) : null

  /**
   * ★ 动作要显示的三样东西。
   *
   * ⚠️ 这里从**派生值**（`$: actionDetail = …`）改成了**函数**，是跟着显示位置
   *    一起变的：原来是"详情里那个唯一的最新动作"，一个值算一次就够；现在动作挂在
   *    **各自那张判决卡**上，一屏里可能有好几张（返工回路转过几圈时），要按
   *    `verdictId` 分别求值。
   *
   *    改成函数是安全的：调用点在 `{#each}` 里，`verdictActions` 变了会重建那一段，
   *    不存在"值变了但没重渲染"那个坑（那个坑是"模板里调函数读 prop"，
   *    这里读的是 each 的局部变量）。
   *
   * 三样：
   *   - `actionDetailOf`：脚本回的那句话（`result.detail`）；
   *   - `actionMetaOf`：退出码 / 耗时 / 预演标记这些**事实**（有才算）；
   *   - `actionParamsOf`：它带着什么参数跑的（合并后的那一条）。
   */
  const actionResultOf = (a: ActionView): Record<string, unknown> | null =>
    (a.result ?? null) as Record<string, unknown> | null

  /**
   * `detail` 是脚本自己写的，可能是空串或非字符串（脚本是我们之外的东西写的）。
   * 只认非空字符串——否则界面上会出现一行空的段落。
   */
  function actionDetailOf(a: ActionView): string | null {
    const d = actionResultOf(a)?.['detail']
    return typeof d === 'string' && d.trim() !== '' ? d : null
  }

  function actionMetaOf(a: ActionView): string[] {
    const r = actionResultOf(a)
    if (!r) return []
    return [
      ...(typeof r['exitCode'] === 'number'
        ? [$t('tasks.actionExitCode', { code: r['exitCode'] as number })]
        : []),
      ...(typeof r['durationMs'] === 'number'
        ? [$t('tasks.actionDuration', { ms: r['durationMs'] as number })]
        : []),
      ...(r['dryRun'] === true ? [$t('tasks.actionDebug')] : []),
      ...(a.finishedAt ? [new Date(a.finishedAt).toLocaleString()] : []),
    ]
  }

  /**
   * 参数的**展示**形状：值可能是对象/数组（模型填的开放参数没有形状约束），
   * 直接 `{v}` 会渲染成 `[object Object]`——那等于没显示。所以统一 `JSON.stringify`，
   * 并按**参数名**排序（对象的键序不定，同一条动作两次打开顺序不一样会像"变了"）。
   */
  function actionParamsOf(a: ActionView): Array<readonly [string, string]> {
    return Object.entries((a.params ?? {}) as Record<string, unknown>)
      .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as const)
      .sort((x, y) => x[0].localeCompare(y[0]))
  }

  /**
   * 「需要注意」单独一拨置顶。
   *
   * 不重排全部：使用者的心理模型是"列表按时间（新的在前）"，整体重排会让人
   * 找不到刚才那条。置顶一拨 + 其余保持原序，两边都成立。
   */
  $: byAttention = splitByAttention(staged)

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

  $: visible = $issues.filter((i) => {
    if (!filter.trim()) return true
    const q = filter.trim().toLowerCase()
    return i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)
  })

  $: selected = $issues.find((i) => i.id === $selectedIssueId) ?? null
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
  // ── D80：任务「优化 skill」的置灰门（有用户反馈 或 审核过）──
  let optimizeOpen = false
  let optimizeGate: { reviewed: boolean; hasUserFeedback: boolean } | null = null
  let optimizeGateRunId = ''
  $: canOptimizeSkill =
    activeIsTerminal &&
    optimizeGate !== null &&
    (optimizeGate.reviewed || optimizeGate.hasUserFeedback)

  /** run 终态后取一次置灰门（轻量 GET；开面板时会再取一次新鲜的）。 */
  async function refreshOptimizeGate(runId: string): Promise<void> {
    try {
      const res = await api<{ reviewed: boolean; hasUserFeedback: boolean }>(
        `/api/crystallize/targets?runId=${encodeURIComponent(runId)}`,
      )
      optimizeGate = { reviewed: res.reviewed, hasUserFeedback: res.hasUserFeedback }
    } catch {
      // 取不到就不放行（按钮置灰比误放行安全）
      optimizeGate = null
    }
  }
  // ── 最后结果（跑完之后）──
  /** 这次执行的最后一段产出（最后一条 text 消息）。 */
  let finalOutput = ''
  let finalOutputFor: string | null = null
  let showRawLog = false

  $: activeIsTerminal =
    activeRun !== null && ['completed', 'failed', 'cancelled'].includes(activeRun.status)
  // ★ 取置灰门放在 activeIsTerminal 之后：避免在它尚未求值（undefined）时白跑
  $: if (activeRun && activeIsTerminal && optimizeGateRunId !== activeRun.runId) {
    optimizeGateRunId = activeRun.runId
    void refreshOptimizeGate(activeRun.runId)
  }
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
   * ★ 判决块（`<<<ALPHA_VERDICT>>>` … `<<<END_ALPHA_VERDICT>>>`）是**机器读的**：
   *   它已经按结论 / 理由码 / 证据 / 行动分项显示在下面的判决卡片里了，正文里再
   *   摊一遍原始标记与 JSON 只是噪音——而且看起来像"平台没处理"（使用者的原话：
   *   显示 `<<<ALPHA_VERDICT>>>` 不优美）。所以**这条 run 有落库判决时**剥掉它。
   *
   * ⚠️ **没有**判决记录时不剥：那种情形通常是模型给的块没通过校验、或者块是半开的，
   *    而那段原文是使用者唯一能看到"它到底写了什么"的地方——替人擦掉现场比难看更糟。
   *    `activeRun.verdict` 随列表响应一起来（不是异步取的那一份判决），所以这里
   *    没有"先剥了、又发现其实没判决"的时序问题。
   */
  $: resultText =
    activeRun === null || finalOutputFor !== activeRun.runId
      ? ''
      : finalResultText(finalOutput, activeRun.verdict !== null)

  $: renderedResult =
    resultText !== ''
      ? renderMarkdown(resultText, { resolveAsset: (href) => resolveAsset(href, activeRun!.runId) })
      : ''

  let verdicts: VerdictView[] = []
  /**
   * ★ 这些判决**触发的**动作记录（D45 的显示位置调整）。
   *
   * 与判决**一起取**、**一起画**：使用者的原话是「应该作为审核 PASS 的依据，
   * 放在一起更合理」——判决说"通过"，而"通过之后真的做了什么、结果如何"是那份
   * 通过的一部分。分两处（或分两拍）显示，会让"通过了但什么也没发生"看起来
   * 很正常。
   */
  let verdictActions: VerdictActionView[] = []
  let verdictsFor: string | null = null

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

  async function loadVerdicts(runId: string): Promise<void> {
    verdictsFor = runId
    try {
      const out = await api<{ verdicts: VerdictView[]; actions?: VerdictActionView[] }>(
        `/api/runs/${runId}/verdicts`,
      )
      verdicts = out.verdicts ?? []
      verdictActions = out.actions ?? []
    } catch {
      verdicts = []
      verdictActions = []
    }
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
  // ★ 人工裁决（D46）
  // ══════════════════════════════════════════════════════════════════
  //
  // 在这之前，一条任务的判决只可能落在三种"卡住"的状态里，而这个页面上**没有
  // 任何出路**：判 `fail` 且没有返工额度 ⇒ 「等待人处理」；判 `needs_human` ⇒
  // 同样；判决不合规且不可重试 ⇒ 同样。人点进去只能看到结论，唯一的按钮是
  // 「继续沟通」——而那是**再派一次活给 agent**，不是"我自己来定"。
  //
  // ── 为什么它不是"一个按钮" ──
  //
  // 看板的阶段是**从记录推出来的**（`lib/pipeline.ts` 的 `stageOf`），所以
  // 人工通过必须落成一条**判决记录**（`POST /api/runs/{id}/human-verdict`）。
  // 在界面里改一个变量的话，刷新就没了、看板也不会动。
  //
  // ── 载体的选法必须与 daemon 的 `canHostHumanVerdict` 一致 ──
  //
  // 界面算"挂在哪条 run 上"，daemon 只校验"这一条能不能被裁决"。两边判据要
  // 对齐，否则会出现"按钮点得动、请求被 409 拒"或者更糟的"点了通过、看板不动"。
  // 下面这个 `passGate` 就是那条判据的界面侧写法。
  $: humanVerdictSupported = ($identity?.capabilities ?? []).includes('human-verdict')
  $: abandonSupported = ($identity?.capabilities ?? []).includes('issue-abandon')

  /**
   * 「通过」能不能点，以及那条判决要挂在哪条 run 上。
   *
   * `null` = **这条任务不能通过**，附带一句说清为什么（`noteId`）。
   *
   * ⚠️ 它**只关掉「通过」那一个按钮**，不关整块面板。D46 时它确实是整块面板的
   *    开关（那时只有一个按钮），但 D47 之后那块装着三个出路，而「反馈」和
   *    「放弃」在"不能通过"的时候**照样该给**——任务还卡着，人总得有条路。
   *    整块面板的开关是 `canDecide`。
   */
  $: passGate = (() => {
    const st = selectedStage
    if (!st || !st.executeRun) return null
    if (!humanVerdictSupported) return null
    // 这次执行还没结束 ⇒ 没有产出可看，也就没有可裁决的结论
    if (!TERMINAL_RUN_STATUSES.has(st.executeRun.status)) {
      return { ok: false as const, noteId: 'tasks.humanVerdictUnavailable' as const }
    }

    // ★ 「行动中 / 行动失败」时不给：那里要解决的是**动作**，不是审核结论。
    //   在这儿点"通过"会让看板从「行动失败」跳到「已完成审查」——把一件没做成
    //   的事说成做完了，而 D40 收口那条规则本来就是为了防这个。
    if (st.stage === 'action_running' || st.stage === 'action_failed') {
      return { ok: false as const, noteId: 'tasks.humanVerdictActionFirst' as const }
    }

    const review = st.reviewRun
    // ① 有审核结论 ⇒ 判决挂在**那条审核 run** 上（人裁决的就是那份结论）
    if (review && review.status === 'completed' && review.verdict) {
      return { ok: true as const, runId: review.runId }
    }
    // ② 审核还在跑 ⇒ 等它出结论（抢答会让两个结论打架）
    if (review) {
      return { ok: false as const, noteId: 'tasks.humanVerdictUnavailable' as const }
    }
    // ③ 压根没有审核 run（"没配审核者"那种任务）⇒ 挂在**执行 run** 上
    return { ok: true as const, runId: st.executeRun.runId }
  })()

  /**
   * 整块「这条任务怎么办」给不给。
   *
   * ══════════════════════════════════════════════════════════════════
   * ★ 为什么是"只要选中了就给"，而不是"能人工裁决时才给"
   * ══════════════════════════════════════════════════════════════════
   *
   * D46 时这块的开关是"能人工裁决"，因为那时它只有「通过」一个按钮。D47 之后
   * 它装着三个出路，而**它们的可用条件各不相同**：
   *
   *   · 「通过」要有可裁决的结论（`passGate`）；
   *   · 「反馈」要有一次**跑完**的执行可以接在后面（`feedbackReady`）；
   *   · 「放弃」**什么都不需要**——它是"我不想管了"，与跑到哪一步无关。
   *
   * 用任何一个按钮的条件当整块的开关，都会让另外两个在它们**本该可用**的时候
   * 消失。最典型的是「放弃」：一条刚建出来、一次都没跑的、或者**正在跑**的任务，
   * 恰恰是最想放弃它的两种情形（建错了 / 在烧 token），而按"能裁决"开关的话
   * 那块根本不会出现。
   *
   * 所以开关只判"有没有选中任务"，每个按钮各自置灰并各自说清为什么。代价是
   * 一条刚建出来的任务上会看到两个灰按钮——那是**如实**的：此刻确实只有放弃
   * 可做。
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

  /**
   * 「通过」不能点时那句解释；**能点、或者这个 daemon 根本没有这条路**时是 null。
   *
   * 后者返回 null 是为了让"旧 daemon"这一档**不显示任何提示**——那时候连按钮
   * 都不画（见模板里 `{#if humanVerdictSupported}`），再挂一句"现在还不能人工
   * 裁决"会让人以为等一会儿就有了。
   */
  $: passBlockedNoteId =
    humanVerdictSupported && passGate !== null && !passGate.ok ? passGate.noteId : null

  let humanReason = ''
  /** 哪个按钮正在跑（`null` = 都闲着）。三个动作共用一个"忙"状态。 */
  let deciding: 'pass' | 'feedback' | 'abandon' | 'recover' | null = null
  let decideError = ''
  /** run 操作的错误（现在只有「取消这次执行」）。显示在 run 详情区里。 */
  let runError = ''

  /**
   * 这条任务**已经被人判过通过**吗。
   *
   * 判据取已加载的判决列表里有没有 `source === 'human'` 的那条——它只是给一句
   * 提示（"可以再判一次，历史会保留"），不是判据本身。真正的判据在 daemon 那边。
   */
  $: humanDecided = verdicts.some((v) => v.source === 'human')

  /**
   * ①「通过」——落一条人工判决，任务进「已完成审查」。
   *
   * 理由**选填**：人脑子里那个判断（"我看过了，可以"）逼他写下来，最常见的结局
   * 是写一句"ok"或者干脆不点——门槛换来的是噪音，不是信息。所以空理由照发。
   */
  async function passTask(): Promise<void> {
    if (!passGate?.ok || deciding !== null) return
    deciding = 'pass'
    decideError = ''
    try {
      await api(`/api/runs/${passGate.runId}/human-verdict`, {
        method: 'POST',
        body: JSON.stringify({ reason: humanReason.trim() }),
      })
      humanReason = ''
      await refresh()
    } catch (err) {
      decideError = err instanceof Error ? err.message : String(err)
    } finally {
      deciding = null
    }
  }

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
    await Promise.all([
      loadVerdicts(run.runId),
      // 跑完的才去取结果；还在跑的时候右边是实时日志，没必要多拉一次
      ['completed', 'failed', 'cancelled'].includes(run.status)
        ? loadResult(run)
        : Promise.resolve(),
    ])
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
    await Promise.all([
      loadVerdicts(fresh.runId),
      ['completed', 'failed', 'cancelled'].includes(fresh.status)
        ? loadResult(fresh)
        : Promise.resolve(),
    ])
  }
</script>

{#snippet row(
  issue: (typeof visible)[number],
  info: ReturnType<typeof stageOf>,
  needsAttention: boolean,
)}
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
    rowClass={needsAttention ? 'task-row attention' : 'task-row'}
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
      <span class="task-title" title={issue.title}>{issue.title}</span>
      <span class="task-meta">
        <span class="stage-tag {info.stage}">{$t(stageShortId(info.stage))}</span>
        <!-- 只显示标签**之外**的信息（`note`）：「待审查」后面再跟一句
             「等待审核」是重复，使用者点名要去掉的就是它。 -->
        {#if info.noteId}
          <span class="faint small">{$t(info.noteId)}</span>
        {/if}
        <!-- ★ D45：返工过就标出来。它是这条回路**真的转过**的痕迹，扫列表时
             最该看见的就是"这个任务审了不止一轮"——否则"返工一次后通过"与
             "一次就通过"长得一模一样。 -->
        {#if info.reworked > 0}
          <span class="faint small">{$t('tasks.reworkedTag', { n: info.reworked })}</span>
        {/if}
        <span class="faint small">{agentName(issue.assignee?.id ?? null)}</span>
        <span class="faint small" title={absoluteTime(issue.updatedAt)}>{relativeTime(issue.updatedAt, now)}</span>
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
          <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
          <div class="skeleton" style="width:70%"></div>
        {:else if $loadError['issues']}
          <div class="notice bad">{$loadError['issues']}</div>
        {:else if visible.length === 0}
          <div class="empty">
            <strong>{filter ? $t('tasks.emptyFiltered') : $t('tasks.empty')}</strong>
            {filter ? $t('tasks.emptyFilteredHint') : $t('tasks.emptyHint')}
          </div>
        {:else}
          <div class="board board-6">
            {#each COLUMNS as col (col.ids[0])}
              <!-- 一列可以收两档（「等待人处理」收 needs_human 与 action_failed） -->
              {@const items = staged.filter((x) => col.ids.includes(x.info.stage))}
              <div class="column">
                <h4>
                  <span>{$t(col.titleId)} <span class="faint">{items.length}</span></span>
                  <span class="col-hint">{$t(col.hintId)}</span>
                </h4>

                {#if items.length === 0}
                  <p class="col-empty faint small">{$t('tasks.columnEmpty')}</p>
                {/if}

                {#each items as { issue, info } (issue.id)}
                  <button type="button" class="card" onclick={() => selectFromBoard(issue.id)}>
                    <span class="card-title">{issue.title}</span>
                    <span class="card-meta">
                      <span class="faint small">{agentName(issue.assignee?.id ?? null)}</span>
                    </span>
                    <span class="card-meta">
                      {#if info.noteId}<span class="faint small">{$t(info.noteId)}</span>{/if}
                      <span class="faint small" title={absoluteTime(issue.updatedAt)}>{relativeTime(issue.updatedAt, now)}</span>
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
      empty={!filter && visible.length === 0}
      emptyTitle={$t('tasks.empty')}
      emptyHint={$t('tasks.emptyHint')}
      emptyFiltered={filter !== '' && visible.length === 0}
      emptyFilteredTitle={$t('tasks.emptyFiltered')}
      emptyFilteredHint={$t('tasks.emptyFilteredHint')}
    >
      {#snippet loadingSkeleton()}
        <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
        <div class="skeleton" style="width:70%"></div>
      {/snippet}
      {#snippet rows()}
        <ul class="task-list">
          {#if byAttention.attention.length > 0}
            <div class="list-head">
              {$t('tasks.attentionTitle', { count: byAttention.attention.length })}
            </div>
            {#each byAttention.attention as { issue, info } (issue.id)}
              {@render row(issue, info, true)}
            {/each}
            <div class="list-head">{$t('tasks.restTitle', { count: byAttention.rest.length })}</div>
          {/if}
          {#each byAttention.rest as { issue, info } (issue.id)}
            {@render row(issue, info, false)}
          {/each}
        </ul>
      {/snippet}
    </ListPane>
  {/if}

  <!-- ══════════════════ 右栏：建任务 / 任务详情（宽屏并排 / 窄屏整页）══════════════════ -->
  {#if mode === 'list'}
    <!-- ★ 右主区（D69.15）：壳 / 栏头 / 空态统一在 MainArea，正文三态自管。
         建任务 / 任务详情 / 没选中 都走同一个壳；栏头（返回+标题+副题）由
         MainArea 的结构化 props 渲染——从此详情栏头固定在上方、不再跟着滚走
         （与聊天的 chat-head 同一形态，这正是统一的意义）。 -->
    {#if optimizeOpen}
      <!-- D80 沉淀成 skill（设计 §4.1.1 界面改版）：任务详情式**全页**流程，
           替换任务详情主区；栏头返回 = 回任务。素材带审核判决 + 用户反馈。 -->
      <CrystallizeView
        runId={activeRun?.runId ?? ''}
        sourceLabel={selected?.title ?? ''}
        backLabel={$t('crystallize.backToTask')}
        onback={() => (optimizeOpen = false)}
        ondone={() => void loadSkills()}
      />
    {:else}
    <MainArea
      empty={!$creating && !selected}
      emptyTitle={$t('tasks.pickOneTitle')}
      emptyHint={$t('tasks.pickOneHint')}
      headClass={$creating ? 'detail-head create-head' : 'detail-head'}
      backLabel={selected ? $t('tasks.backToList') : undefined}
      onBack={() => selectedIssueId.set(null)}
      title={$creating ? $t('shell.navNewTask') : selected?.title ?? ''}
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
            D80：任务「优化 skill」按钮（§4.3）——按钮可用 ⟺ 任务 run 终态
            且（有用户反馈 或 审核过）。置灰时 title 说明"为什么灰"。
          -->
          <button
            type="button"
            class="ghost"
            disabled={!canOptimizeSkill}
            title={canOptimizeSkill ? '' : $t('crystallize.taskGated')}
            onclick={() => (optimizeOpen = true)}
          >
            {$t('crystallize.optimize')}
          </button>
        {/if}
      {/snippet}
      {#snippet body()}
        {#if $creating}
          <NewTaskForm />
        {:else if selected}
          {#key selected.id}

  <!--
    ★ 「这一次是谁审的」（D42；2026-10 收成两态）。

    ⚠️ 原来是**三态**：`follow`（跟随执行者的长期配置）那一档不画（绝大多数情况，
    说出来只是噪音），只在"偏离长期配置"时才说。`follow` 随 `Agent.reviewerAgentId`
    撤销之后，能出现的事实只剩两件——**有审核者**（可能来自组）与**没有审核者**，
    两件都必须说出来：
      · "没有人审"必须留痕，否则一条没被审的产出事后看起来像"审核链路坏了"；
      · "谁审的"也要说，而且**来自组还是本次指定**由 run 上有没有 `groupId` 决定
        （不同的来源要用不同的话说，见下面 `tasks.reviewerOverridden*` 两句）。
  -->
  {#if selectedStage?.executeRun?.reviewer}
    <section class="drawer-section">
      <h3>{$t('tasks.reviewerHeading')}</h3>
      {#if selectedStage.executeRun.reviewer.mode === 'none'}
        <p class="hint">{$t('tasks.reviewerNone')}</p>
      {:else}
        <p>
          {agentName(selectedStage.executeRun.reviewer.agentId)}
          <span class="faint small">
            {$t(
              selectedStage.executeRun.groupId
                ? 'tasks.reviewerFromGroup'
                : 'tasks.reviewerOverridden',
            )}
          </span>
        </p>
      {/if}
    </section>
  {/if}

  <section class="drawer-section">
    <h3>{$t('tasks.runsHeading')} <span class="faint small">（{issueRuns.length}）</span></h3>

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
            <span class="badge {RUN_STATUS_CLASS[run.status] ?? ''}"
              >{$t(runStatusLabel(run.status))}</span
            >
            <!-- ★ 类型与时间必须显示：只给状态和 runId 的话，使用者**看不出
                 哪个先哪个后**——他只能凭感觉，于是会觉得"顺序不对"。 -->
            <span class="small">{run.kind === 'review' ? $t('tasks.kindReview') : $t('tasks.kindExecute')}</span>
            <span class="mono faint small" title={new Date(run.queuedAt).toLocaleString()}>
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
        <span class="faint small mono"
          >{$t('tasks.runIdLabel', { id: activeRun.runId.slice(-8) })}</span
        >
        {#if activeIsTerminal}
          <!-- 跑完之后默认给结论；原始流水仍然一条不少，按需翻 -->
          <button
            type="button"
            class="ghost small"
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
            class="danger small"
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
              <div class="skeleton"></div>
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
      {#if verdictsFor === activeRun.runId && verdicts.length > 0}
        <h4 style="margin-top:var(--sp-4)">{$t('tasks.verdictHeading')}</h4>
        {#each verdicts as v (v.id)}
          {@const actionCount = verdictActions.filter((a) => a.verdictId === v.id).length}
          <article class="notice" style="margin-bottom:var(--sp-2);flex-direction:column">
            <div style="display:flex;gap:var(--sp-2);align-items:center">
              <!--
                ★ 契约值**不翻译**（它是判决 JSON 里的机器值），但**旁边**给一个
                  本地化显示名：等宽的值 + 人话，两者都在，谁也不会误会哪个是真的。
              -->
              <span class="badge {v.conclusion === 'pass' ? 'done' : v.conclusion === 'fail' ? 'failed' : 'blocked'}">
                <code>{v.conclusion}</code>
                <span class="faint small">{$t(`term.conclusion.${v.conclusion}` as WebTextId)}</span>
              </span>
              <span class="mono small faint" title={$t(`term.reasonCode.${v.reasonCode}` as WebTextId)}
                >{v.reasonCode}</span
              >
              <span class="faint small">{$t(`term.reasonCode.${v.reasonCode}` as WebTextId)}</span>
              <!--
                ★ D46：这条判决**是谁做的**。
                
                同一条 run 上可能有两条判决（模型判 fail、人后来判 pass），两张
                卡片长得几乎一样——不标出来，读的人分不清哪条该信。所以人工那条
                带一个徽章；`source` 缺字段（老数据）就是模型判的，不标。
                
                ⚠️ 置信度对人工裁决**没有意义**（人不是概率输出，落库时写的是 1），
                所以那一项对人工判决不显示——显示出来就是一句"100% 确定"的假精确。
              -->
              {#if v.source === 'human'}
                <span class="badge done">{$t('tasks.humanVerdictBadge')}</span>
              {:else}
                <span class="faint small"
                  >{$t('tasks.confidence', { percent: Math.round(v.confidence * 100) })}</span
                >
              {/if}
            </div>
            <!-- 人工裁决的理由：它是**这句话**而不是一组 findings（D46） -->
            {#if v.source === 'human' && v.humanReason}
              <p class="small">
                <span class="faint small">{$t('tasks.humanVerdictReasonHeading')}</span>
                {v.humanReason}
              </p>
            {/if}
            <!-- ★ D69.9：结论行（徽标+理由码+来源）常驻，证据明细折叠 -->
            <FoldSection
              title={$t('tasks.verdictDetails')}
              summary={$t('tasks.verdictDetailCount', { actions: actionCount, findings: v.findings.length })}
            >
            <!--
              ══════════════════════════════════════════════════════════════
              ★ 这条判决**真的做了什么**（D45 的显示位置调整）
              ══════════════════════════════════════════════════════════════

              使用者的原话：「应该作为审核 PASS 的依据，放在一起更合理」。

              在这之前它单独占一段（详情里另有一个「行动」小节），于是"判决通过"
              与"通过之后做了什么"分在两处：读者得自己在两个方块之间建立因果，
              而"通过了但什么都没发生"和"通过了并做成了"在扫一眼时没有区别。

              现在它挂回**产生它的那张判决卡**里——判决的结论、它要求的动作、
              以及那个动作的**结果**连成一句完整的话：
              「判了 pass ⇒ 要求 append-note ⇒ 真的 append 了（退出码 0）」。

              判据用 `verdictId`（不是"最新那条"）：一张卡只认自己触发的动作，
              返工回路转了几圈时也不会把上一轮的结论画到这一轮下面。
            -->
            {#each verdictActions.filter((a) => a.verdictId === v.id) as a (a.id)}
              <div class="action-line">
                <div class="small">
                  <code>{a.type}</code>
                  <span class="faint small"
                    >{$t(`term.actionStatus.${a.status}` as WebTextId)}</span
                  >
                </div>
                {#if a.error}
                  <p class="card-warning">{$t('tasks.actionFailed', { reason: a.error })}</p>
                {/if}
                <!-- 脚本自己回的那句话："做了什么 / 为什么没做成" -->
                {#if actionDetailOf(a)}
                  <p class="small">{actionDetailOf(a)}</p>
                {/if}
                {#if actionMetaOf(a).length > 0}
                  <p class="faint small">
                    {#each actionMetaOf(a) as m, i (m)}
                      {i > 0 ? ' · ' : ''}{m}
                    {/each}
                  </p>
                {/if}
                <!-- 它带着什么参数跑的（模型填的 open + 平台注入的 bound + 界面固定值）-->
                {#if actionParamsOf(a).length > 0}
                  <details>
                    <summary class="faint small">{$t('tasks.actionParamsSummary')}</summary>
                    <ul class="plain small" style="margin:0">
                      {#each actionParamsOf(a) as [k, val] (k)}
                        <li><code>{k}</code> = <code>{val}</code></li>
                      {/each}
                    </ul>
                  </details>
                {/if}
              </div>
            {/each}
            {#if v.action}
              <div class="small">{$t('tasks.suggestedAction')}<code>{v.action.type}</code></div>
            {/if}
            {#if v.escalateReason}
              <div class="small warn">{$t('tasks.needsHuman', { reason: v.escalateReason ?? '' })}</div>
            {/if}
            {#if v.findings.length > 0}
              <ul class="plain small" style="margin:0">
                {#each v.findings as f}
                  <li>[{f.severity}] {f.summary}</li>
                {/each}
              </ul>
            {:else}
              <div class="faint small">{$t('tasks.noFindings')}</div>
            {/if}
            </FoldSection>
          </article>
        {/each}
      {/if}

      <!-- ★ D69.9：元数据（工作目录/类型/耗时）默认折叠；标题行把工作目录
            放在摘要位——它常常是唯一想确认的那一项 -->
      <FoldSection title={$t('tasks.metaHeading')} summary={activeRun.workDir ?? ''}>
        <dl class="meta-grid">
          <dt>{$t('tasks.workDir')}</dt>
          <dd class="mono">{activeRun.workDir ?? '—'}</dd>
          <dt>{$t('tasks.type')}</dt>
          <dd>{activeRun.kind === 'review' ? $t('tasks.kindReview') : $t('tasks.kindExecute')}</dd>
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
        ★ 人工裁决（D46）
        ══════════════════════════════════════════════════════════════

        位置：**紧跟在判决区之后**。理由是它回答的问题紧接着判决卡上那句结论——
        "审核说不行，那我能不能自己说行"。

        ══════════════════════════════════════════════════════════════
        ★ D47：它同时**取代了原来那个常驻底栏**（「发送并继续」）
        ══════════════════════════════════════════════════════════════

        使用者的要求是把三个出路摆在一起：「通过 / 反馈 / 放弃」，而且
        **「反馈」就是「发送并继续」**——两者合并，所以底栏那个输入框连同它的
        按钮一起撤掉了。留下来的这一块因此要覆盖底栏原来覆盖的范围，否则
        "已经审完的任务再也说不出下一句"（那是这次合并最容易踩的坑）。

        为此它的开关是 `canDecide`（**只要选中了任务就给**），而不是"能人工裁决"
        ——那只是「通过」那一个按钮的条件。三个按钮各有自己的可用性：

          · 通过：要有一条可裁决的 run（`passGate`），否则置灰 + 说清为什么；
          · 反馈：要有一次**跑完**的执行可以接（`feedbackReady`），否则同上；
          · 放弃：只在支持这条路由的 daemon 上给，且放弃后换成「恢复」。

        ⚠️ 开关为什么放宽到"只要选中了任务"：三个按钮的可用条件互不相同，用其中
           任何一个当整块的开关，都会让另外两个在**本该可用**时消失。最典型的是
           「放弃」——一条刚建出来、一次都没跑的、或者**正在跑**的任务，恰恰是最
           想放弃它的两种情形（建错了 / 在烧 token）。代价是一条新任务上会看到
           两个灰按钮，而那是**如实**的：此刻确实只有放弃可做。

        三件事在文案里刻意说清了（见 `packages/i18n/src/web/tasks.ts` 里
        `decide*` 那组注释）：
          ① 「通过」**不触发任何动作**（最容易的误解）；
          ② 理由**什么时候必填**（通过选填、反馈必填）——两个按钮共用一个
             输入框，所以这件事只能靠按钮上的提示说清；
          ③ 「放弃」会**取消正在跑的 run**（这个功能唯一的副作用）。
      -->
      {#if canDecide && !logMode}
        <section class="drawer-section decide-bar">
          {#if isAbandoned}
            <!-- 放弃过的任务只给一条出路：恢复。它已经出局了，不该再出现三个
                 能改流程的按钮——那会让人以为它还在流程里。 -->
            <p class="faint small">{$t('tasks.abandonNote')}</p>
            {#if canAbandon}
              <button
                type="button"
                disabled={deciding !== null}
                title={deciding !== null ? $t('common.busyHint') : undefined}
                onclick={() => setAbandoned(false)}
              >
                {deciding === 'recover' ? $t('tasks.decideAbandoning') : $t('tasks.decideRecover')}
              </button>
            {/if}
          {:else}
            {#if humanDecided}
              <p class="faint small">{$t('tasks.humanVerdictAlready')}</p>
            {/if}

            <label class="human-reason">
              <span class="small reason-label">{$t('tasks.decideReasonLabel')}</span>
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
              {#if humanVerdictSupported}
                <button
                  type="button"
                  disabled={deciding !== null || !passGate?.ok}
                  title={passGate?.ok
                    ? $t('tasks.decidePassHint')
                    : passBlockedNoteId
                      ? $t(passBlockedNoteId)
                      : ''}
                  onclick={passTask}
                >
                  {deciding === 'pass' ? $t('tasks.decidePassing') : $t('tasks.decidePass')}
                </button>
              {/if}
              <button
                type="button"
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
                  class="danger"
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
                正是 D46 那次需求（"没有人工通过的操作 UI"）的来源。
              ★ 2026-10（紧凑性）：两条提示（为什么不能通过 / 为什么不能反馈）
                合并成一行、用「·」隔开——run 还在跑时两条经常同时出现，各占
                一整行都是极短的小字。缺一则只出其一。
            -->
            {#if passBlockedNoteId || !feedbackReady}
              <p class="faint small">
                {#if passBlockedNoteId}{$t(passBlockedNoteId)}{/if}{#if passBlockedNoteId && !feedbackReady}
                  <span class="faint"> · </span>
                {/if}{#if !feedbackReady}{$t('tasks.needRunForFeedback')}{/if}
              </p>
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
    /**
     * ★ 这一栏的左右留白**只有一个出处**：`--create-pad-x`。
     *
     * 三个地方读它：这一栏的标题（下面）、表单的 `.form-frame`（它自带留白）、
     * 以及提交栏那两个负外边距（要抵消掉同一份留白才横贯整栏）。自定义属性会继承，
     * 所以表单里读得到——而"三处各写一份 var(--sp-6)"就是三个会漂移的常量：
     * 我第一版在窄屏那条断点里只改了两处，提交栏比容器宽 32px、整张表单横向溢出。
     */
    --create-pad-x: var(--sp-6);
  }

  /* 与 `.main` 同一条断点、同一个值（窄窗口下平台各处都收一档留白） */
  @media (max-width: 60rem) {
    :global(.pane-body.create-body) {
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
  .task-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    /* D66：行距与聊天/智能体一致（原来 2px vs var(--sp-1)） */
    gap: var(--sp-1);
  }

  /* 「需要注意」那一拨：左边一条醒目色条，不靠颜色变字体 */
  .list-head {
    padding: var(--sp-3) 0 var(--sp-1);
    font-size: var(--fs-sm);
    color: var(--text-dim);
    border-bottom: 1px solid var(--line);
  }

  /* ★ 整行可点 + 右侧独立删除按钮（与「智能体」「聊天」两栏同形）：
       `li` 容器里放主按钮（flex:1）+ 兄弟删除按钮。 */
  /* ★ 列表模式的栏头（D61）：与聊天页那个"只有标题"的栏头**同高同款**
     （`.list-head` / `.list-toolbar` 共用 `--list-head-h`，见 app.css）。
     没有标题（与页名重复），左边计数、右边搜索，搜索框不再独行。 */
  .list-toolbar {
    align-items: center;
  }

  /* 删除按钮：默认几乎不可见，hover 才露出危险色——扫列表时不该被一排 × 吵到 */
  .task-meta {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
    /* 元信息这一行就算换行也只占一行的高度：里面的东西都是短词 */
    min-height: 1.2em;
  }

  /*
    单行 + 省略号：行高因此与标题长度**无关**（每行一样高）。
    `display:block` 是必需的——行内元素上 `text-overflow` 不生效。
  */
  .task-title {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 600;
  }

  /* D65：阶段标签与平台徽标（`.badge`）**同一条配方**——胶囊 + 圆点 + 10% 底 +
     28% 发丝边。原来它是描边方角（r4px、无底无点），和智能体的角色徽标、技能/工具
     页的徽标是两种形状。改完之后任务列表与看板里的阶段 chip 都变成胶囊。 */
  .stage-tag {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    /* 竖内距 0（`0.1rem` 会把它撑成 ~20px，任务行跟着 65→67px，D61 的行高判据
       会红——而它在这个列表里是元信息行的内容，该贴文本行高）。横向留 `--sp-2`
       与 `.badge` 一致；胶囊形状（圆角 + 圆点 + 底）不变。 */
    padding: 0 var(--sp-2);
    border-radius: 100px;
    font-size: var(--fs-xs);
    font-weight: 500;
    border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
    background: color-mix(in srgb, currentColor 10%, transparent);
    white-space: nowrap;
  }

  .stage-tag::before {
    content: '';
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
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

  /* 跑完之后：左边结论、右边产出文件（D69.9.1 从折叠区挪回——文件是高频项） */
  .result-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(14rem, 20rem);
    gap: var(--sp-4);
    align-items: start;
  }

  @media (max-width: 60rem) {
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

  /* ── 六列流水线 ──
     D40 起是五档：执行中 / 待审查 / 行动中 / 等待人处理（含行动失败） / 已完成审查；
     D47 又加了最后一列「已放弃」（**不是流水线的一站**，见 `PIPELINE_COLUMNS`）。
     固定列数（而不是 auto-fit）：这几列就是流水线的几个状态，少一列会让人以为
     那个状态不存在。

     ⚠️ 类名跟着列数走（`.board-6`），因为列数改了而名字不改，下一个改的人就要
        先数一遍 CSS 里的 `repeat(N)` 才能确认它对应几列。 */
  .board-6 {
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: var(--sp-3);
  }

  /* 中等宽度放 6 列会把每列压到 130px 上下，读不了 ⇒ 改成 3+3 两行 */
  @media (max-width: 110rem) {
    .board-6 {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  @media (max-width: 64rem) {
    .board-6 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .col-hint {
    display: block;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    margin-top: 2px;
  }

  .column h4 {
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

  .column h4 {
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
    border-radius: 100px;
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

  :global(button.ghost.active) {
    background: var(--surface-2);
    color: var(--text);
  }
</style>
