<script lang="ts">
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
  import { flattenWorkDir, humanSize } from '../lib/workdir-view.ts'
  import { agents, issues, loadIssues, loadRuns, loading, loadError, runs } from '../lib/stores.ts'
  import { selectedIssueId } from '../lib/view.ts'
  import {
    PIPELINE_COLUMNS as COLUMNS,
    formatRunStamp,
    runsForIssue,
    splitByAttention,
    stageOf,
    stageShortId,
  } from '../lib/pipeline.ts'
  import RunLog from '../components/RunLog.svelte'
  import { t, tx } from '../lib/i18n.ts'
  import type { WebTextId } from '@alpha-helper/i18n'

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
  $: staged = visible.map((issue) => ({ issue, info: stageOf(issue.id, $runs) }))

  /** 当前打开那个任务的阶段——详情头要显示它（不该在模板里算两遍）。 */
  $: selectedStage = selected ? stageOf(selected.id, $runs) : null

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
      ...(r['dryRun'] === true ? [$t('tasks.actionDryRun')] : []),
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
   * 不重排全部：使用者的心理模型是"列表大致按时间"，整体重排会让人找不到
   * 刚才那条。置顶一拨 + 其余保持原序，两边都成立。
   */
  $: byAttention = splitByAttention(staged)

  const VIEW_KEY = 'alpha-helper.issue-view'
  let mode: 'list' | 'board' = localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list'

  function setMode(next: 'list' | 'board'): void {
    mode = next
    localStorage.setItem(VIEW_KEY, next)
  }

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
  // ── 最后结果（跑完之后）──
  /** 这次执行的最后一段产出（最后一条 text 消息）。 */
  let finalOutput = ''
  let finalOutputFor: string | null = null
  // ══════════ 工作目录那一栏：默认只列第一级，目录点开才取下一层 ══════════
  let wdRoot: WorkDirFile[] = []
  /** 已经取回来的子层：目录路径 → 它的直接子项。 */
  let wdChildren: ReadonlyMap<string, WorkDirFile[]> = new Map()
  let wdExpanded: ReadonlySet<string> = new Set()
  /** 正在取哪几层（键是目录路径，'' = 顶层）。 */
  let wdLoading: ReadonlySet<string> = new Set()
  let wdTruncated = false
  let wdLoadedFor: string | null = null
  /** 取目录失败的原因——必须**显示出来**，不能静默留空。 */
  let listingError = ''
  let showRawLog = false

  $: activeIsTerminal =
    activeRun !== null && ['completed', 'failed', 'cancelled'].includes(activeRun.status)

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

    await loadWorkDir(run.runId, '')
  }

  /**
   * 取某一层目录（`dir` 为空串 = 顶层）。
   *
   * 一次只取一层：递归列整棵树时，一个技能目录就能带出
   * `.claude/skills/algorithmic-art/templates/viewer.html` 这种一长串路径，
   * 把真正的产出淹掉十几行里。
   */
  async function loadWorkDir(runId: string, dir: string): Promise<void> {
    const mark = (set: ReadonlySet<string>, path: string, on: boolean): Set<string> => {
      const next = new Set(set)
      if (on) next.add(path)
      else next.delete(path)
      return next
    }
    wdLoading = mark(wdLoading, dir, true)
    try {
      const suffix = dir === '' ? '' : `?dir=${encodeURIComponent(dir)}`
      const out = await api<WorkDirListing>(`/api/runs/${runId}/files${suffix}`)
      if (dir === '') {
        wdRoot = out.entries
        wdTruncated = out.truncated
        wdLoadedFor = runId
      } else {
        const next = new Map(wdChildren)
        next.set(dir, out.entries)
        wdChildren = next
      }
      listingError = ''
    } catch (err) {
      // ★ 失败必须**说出来**。第一版这里是 `catch { listing = null }`，而界面把
      //   null 渲染成骨架屏 —— 于是"接口取不到"和"还在加载"长得一模一样，
      //   使用者看到的就是"这一栏什么都没有"（实测撞到过一次：daemon 还是旧
      //   代码，`/files` 返回 404，而那一栏只是安静地空着）。
      listingError = err instanceof Error ? err.message : String(err)
    } finally {
      wdLoading = mark(wdLoading, dir, false)
    }
  }

  /** 展开/收起一个目录。展开时如果还没取过它的子项，就去取一层。 */
  function toggleDir(entry: WorkDirFile): void {
    const next = new Set(wdExpanded)
    if (next.has(entry.path)) {
      next.delete(entry.path)
    } else {
      next.add(entry.path)
      if (!wdChildren.has(entry.path) && activeRun) void loadWorkDir(activeRun.runId, entry.path)
    }
    wdExpanded = next
  }

  $: wdRows = flattenWorkDir(wdRoot, wdChildren, wdExpanded)

  /** 工作目录里的相对路径 → 能取的地址（Markdown 里的图片靠它显示）。 */
  function resolveAsset(href: string, runId: string): string | null {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href // 外部绝对地址
    return `/api/runs/${runId}/file?path=${encodeURIComponent(href)}`
  }

  $: renderedResult =
    activeRun && finalOutputFor === activeRun.runId && finalOutput !== ''
      ? renderMarkdown(finalOutput, { resolveAsset: (href) => resolveAsset(href, activeRun!.runId) })
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
    await api(`/api/runs/${runId}/cancel`, { method: 'POST' })
    await loadRuns()
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
    wdRoot = []
    wdChildren = new Map()
    wdExpanded = new Set()
    wdLoading = new Set()
    wdLoadedFor = null
    listingError = ''
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
  let followUp = ''
  let sending = false
  let sendError = ''

  /**
   * 这个任务上**最新的一次执行**——接着沟通就是接在它后面。
   *
   * ⚠️ 时间线是升序的，所以最新的在**末尾**（原来 `find` 能拿到是因为当时
   *    数组倒序——顺序一改，`find` 就变成"最早那次"，接着沟通会接错）。
   */
  $: lastExecuteRun = issueRuns.filter((r) => r.kind === 'execute').at(-1) ?? null
  $: canFollowUp =
    lastExecuteRun !== null && ['completed', 'failed', 'cancelled'].includes(lastExecuteRun.status)

  async function sendFollowUp(): Promise<void> {
    const message = followUp.trim()
    if (message === '' || !selected || !lastExecuteRun) return

    const agent = $agents.find((a) => a.id === lastExecuteRun!.agentId)
    if (!agent) {
      sendError = tx('tasks.agentGone')
      return
    }

    sending = true
    sendError = ''
    try {
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
      followUp = ''
      await refresh()
      // 立刻切到新那条 run：使用者刚说了话，想看的是它的实时输出
      const created = $runs.find((r) => r.runId === runId)
      if (created) await selectRun(created)
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err)
    } finally {
      sending = false
    }
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
  <button
    type="button"
    class="task-row"
    class:attention={needsAttention}
    class:active={$selectedIssueId === issue.id}
    onclick={() => selectedIssueId.set(issue.id)}
  >
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
      <span class="faint small">{new Date(issue.updatedAt).toLocaleDateString()}</span>
    </span>
  </button>
{/snippet}

<div
  class="split-layout"
  class:board={mode === 'board'}
  class:with-detail={mode === 'list' && selected !== null}
>
  <!-- ══════════════════ 中栏：清单 / 看板 ══════════════════ -->
  <section class="pane list-pane">
    <header class="pane-head">
      <div>
        <h2>{mode === 'board' ? $t('tasks.boardTitle') : $t('tasks.listTitle')}</h2>
        <p class="hint">
          {#if mode === 'board'}
            {$t('tasks.boardHintBefore')}<strong>{$t('tasks.boardHintStrong')}</strong>{$t('tasks.boardHintAfter')}
          {:else}
            {$t('tasks.listHint')}
          {/if}
        </p>
      </div>
      <div class="pane-actions">
        <button type="button" class="ghost small" class:active={mode === 'list'} onclick={() => setMode('list')}>{$t('tasks.modeList')}</button>
        <button type="button" class="ghost small" class:active={mode === 'board'} onclick={() => setMode('board')}>{$t('tasks.modeBoard')}</button>
        <button type="button" class="secondary small" onclick={refresh}>{$t('common.refresh')}</button>
      </div>
    </header>

    <div class="pane-body">
      <input
        bind:value={filter}
        placeholder={$t('tasks.search')}
        style="max-width:22rem;margin-bottom:var(--sp-4)"
        autocomplete="off"
      />

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
  {:else if mode === 'board'}
    <div class="board board-5">
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
                <span class="faint small">{new Date(issue.updatedAt).toLocaleDateString()}</span>
              </span>
              {#if info.warningId}
                <span class="card-warning">{$t(info.warningId, info.warningParams)}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/each}
    </div>

  {:else}
    <div class="task-list">
      {#if byAttention.attention.length > 0}
        <div class="list-head">
          {$t('tasks.attentionTitle', { count: byAttention.attention.length })}
          <span class="faint small">{$t('tasks.attentionHint')}</span>
        </div>
        {#each byAttention.attention as { issue, info } (issue.id)}
          {@render row(issue, info, true)}
        {/each}
        <div class="list-head">{$t('tasks.restTitle', { count: byAttention.rest.length })}</div>
      {/if}
      {#each byAttention.rest as { issue, info } (issue.id)}
        {@render row(issue, info, false)}
      {/each}
    </div>
  {/if}
    </div>
  </section>

  <!-- ══════════════════ 右栏：任务详情（宽屏并排 / 窄屏整页）══════════════════ -->
  {#if mode === 'list'}
    <section class="pane detail-pane">
      {#if selected}
        <div class="pane-body detail-scroll">
          <header class="detail-head">
            <button
              type="button"
              class="ghost small back-to-list"
              onclick={() => selectedIssueId.set(null)}
            >{$t('tasks.backToList')}</button>
            <h2>{selected.title}</h2>
            <p class="detail-sub">
              {#if selectedStage}
                <span class="stage-tag {selectedStage.stage}"
                >{$t(stageShortId(selectedStage.stage))}</span
              >
              {/if}
              <span class="faint">{agentName(selected.assignee?.id ?? null)}</span>
              <!--
                ★ 完整时间戳放在这里，因为列表里只剩日期了。

                  列表那一列的宽度要留给标题（见行模板上的说明），所以元信息里
                  用的是 `toLocaleDateString`。但"更新于几点几分"原来只有那一列
                  有——只留日期就等于**悄悄丢了一条信息**。详情栏有地方，放这儿。
              -->
              <span class="faint">{$t('tasks.updatedAt', { time: new Date(selected.updatedAt).toLocaleString() })}</span>
            </p>
          </header>

    {#if selected.description}
      <section class="drawer-section">
        <h3>{$t('tasks.descriptionHeading')}</h3>
        <p class="hint" style="white-space:pre-wrap">{selected.description}</p>
      </section>
    {/if}

  <!--
    ★ 「这一次是谁审的」（D42）。
    只在**偏离长期配置**时才显示：`follow` 是绝大多数情况，也说出来只会多一行噪音。
    而 `override` / `none` 必须留痕——否则一条"这次不审"的任务，事后在界面上
    看不出那是**当时有人这么决定**，只会看起来像"审核链路坏了"。
  -->
  {#if selectedStage?.executeRun?.reviewer && selectedStage.executeRun.reviewer.mode !== 'follow'}
    <section class="drawer-section">
      <h3>{$t('tasks.reviewerHeading')}</h3>
      {#if selectedStage.executeRun.reviewer.mode === 'none'}
        <p class="hint">{$t('tasks.reviewerNone')}</p>
      {:else}
        <p>
          {agentName(selectedStage.executeRun.reviewer.agentId)}
          <span class="faint small">{$t('tasks.reviewerOverridden')}</span>
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
            <span class="badge {run.status}">{run.status}</span>
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

  {#if activeRun}
    <section class="drawer-section">
      <h3>
        {activeIsTerminal && !showRawLog ? $t('tasks.finalResult') : $t('tasks.rawLog')}
        <span class="faint small mono">run {activeRun.runId.slice(-8)}</span>
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
        {/if}
      </h3>

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

      {#if activeIsTerminal && !showRawLog}
        <!-- ══════════ 最后结果：左结论 / 右产出文件 ══════════ -->
        <div class="result-grid">
          <div class="result-main">
            {#if renderedResult}
              <article class="markdown">{@html renderedResult}</article>
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
            <h4>{$t('tasks.filesHeading')}</h4>
            {#if listingError}
              <div class="notice bad">
                {$t('tasks.filesError')}
                <p class="faint small" style="margin:var(--sp-2) 0 0">{listingError}</p>
                <p class="faint small" style="margin:var(--sp-2) 0 0">
                  {$t('tasks.filesErrorHint')}
                </p>
              </div>
            {:else if wdLoadedFor !== activeRun.runId}
              <div class="skeleton" style="width:70%"></div>
            {:else if wdRows.length === 0}
              <p class="hint">{$t('tasks.dirEmpty')}</p>
            {:else}
              <!--
                默认只列**第一级**，目录点一下才取它的下一层。
                不显示整串路径（层级靠缩进，路径在悬停提示里）；不写"平台注入"
                那种说明文字（弱化显示就够了）。
              -->
              <ul class="wd">
                {#each wdRows as { entry, depth } (entry.path)}
                  <li style="padding-left:{depth * 0.9}rem">
                    {#if entry.kind === 'dir'}
                      <button
                        type="button"
                        class="wd-dir"
                        class:managed={entry.managed}
                        title={entry.path}
                        onclick={() => toggleDir(entry)}
                      >
                        <span class="wd-twisty">
                          {entry.hasChildren ? (wdExpanded.has(entry.path) ? '▾' : '▸') : '·'}
                        </span>
                        <span class="mono">{entry.name}</span>
                      </button>
                      {#if wdLoading.has(entry.path)}
                        <span class="faint small">{$t('tasks.reading')}</span>
                      {/if}
                    {:else}
                      <a
                        class="wd-file"
                        class:managed={entry.managed}
                        title={entry.path}
                        href="/api/runs/{activeRun.runId}/file?path={encodeURIComponent(entry.path)}"
                        target="_blank"
                        rel="noreferrer noopener"
                      >{entry.name}</a>
                      <span class="faint small">{humanSize(entry.sizeBytes)}</span>
                    {/if}
                  </li>
                {/each}
              </ul>
              {#if wdTruncated}
                <p class="faint small">{$t('tasks.truncated')}</p>
              {/if}
            {/if}
          </aside>
        </div>
      {:else}
        <!-- ⚠️ 这里曾经传 `since={activeRun.lastSeq}`，而那个字段是"库里已有的最后
             一条消息的序号"。`since` 的语义是"跳过它及之前的一切"，于是打开一条
             已经跑完的任务时全部历史都被跳过 —— 日志空的，agent 的最后产出看不到。
             订阅游标现在由 RunLog 自己持有，父组件没有机会传错。 -->
        <RunLog runId={activeRun.runId} onterminal={() => void refresh()} />
      {/if}

      <div style="margin-top:var(--sp-3);display:flex;gap:var(--sp-2)">
        <button
          type="button"
          class="danger"
          disabled={['completed', 'failed', 'cancelled'].includes(activeRun.status)}
          onclick={() => cancel(activeRun!.runId)}
        >
          {$t('tasks.cancelRun')}
        </button>
        <button type="button" class="secondary" onclick={() => loadVerdicts(activeRun!.runId)}>
          {$t('tasks.readVerdict')}
        </button>
      </div>

      {#if verdictsFor === activeRun.runId && verdicts.length > 0}
        <h4 style="margin-top:var(--sp-4)">{$t('tasks.verdictHeading')}</h4>
        {#each verdicts as v (v.id)}
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
              <span class="faint small">{$t('tasks.confidence', { percent: Math.round(v.confidence * 100) })}</span>
            </div>
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
          </article>
        {/each}
      {/if}
    </section>
  {/if}

        </div>

        {#if canFollowUp && lastExecuteRun}
          <!-- ══════════ 常驻底栏：继续沟通 ══════════
               它原来是滚到底才看得到的最后一段，而"接着干"是这个产品最核心的
               交互之一 —— 放在底栏，随时能说下一句。 -->
          <footer class="pane-foot">
      <!--
        ⚠️ 这一段要**短**。它原来是一整段说明加三行输入框，实测占了详情栏
        284px —— 一个 748px 高的栏位里，常驻底栏吃掉 38%，正文就没地方了。
        详细说明挪进 title（鼠标悬停可见），正文只留一句。
      -->
      <section
        class="follow-up"
        title={$t('tasks.continueHint', {
          dir: lastExecuteRun.workDir ?? $t('tasks.autoWorkDir'),
        })}
      >
        <textarea
          bind:value={followUp}
          rows="2"
          placeholder={$t('tasks.continuePlaceholder')}
          disabled={sending}
          onkeydown={(e) => {
            // Ctrl/Cmd+Enter 发送：「接着干」是高频动作，不该逼人去够鼠标
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendFollowUp()
          }}
        ></textarea>
        <div class="follow-actions">
          <button type="button" disabled={sending || followUp.trim() === ''} onclick={sendFollowUp}>
            {sending ? $t('tasks.sending') : $t('tasks.sendAndContinue')}
          </button>
          <span class="faint small">{$t('tasks.continueFooter')}</span>
        </div>
        {#if sendError}
          <div class="notice bad" style="margin-top:var(--sp-2)">{sendError}</div>
        {/if}
      </section>
          </footer>
        {/if}
      {:else}
        <div class="pane-body">
          <div class="empty">
            <strong>{$t('tasks.pickOneTitle')}</strong>
            {$t('tasks.pickOneHint')}
          </div>
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  /* ══════════════ 列表：两行的行（标题 + 元信息）══════════════ */

  .task-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* 「需要注意」那一拨：左边一条醒目色条，不靠颜色变字体 */
  .list-head {
    padding: var(--sp-3) 0 var(--sp-1);
    font-size: var(--fs-sm);
    color: var(--text-dim);
    border-bottom: 1px solid var(--line);
  }

  .task-row {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
    text-align: left;
    padding: var(--sp-2) var(--sp-3);
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius);
    color: var(--text);
    cursor: pointer;
  }

  .task-row:hover {
    background: var(--surface-2);
  }

  .task-row.active {
    background: var(--surface-2);
    border-color: var(--accent);
  }

  .task-row.attention {
    border-left: 2px solid var(--warn);
  }

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

  .stage-tag {
    display: inline-block;
    padding: 0 var(--sp-1);
    border-radius: var(--radius-sm);
    border: 1px solid var(--line-strong);
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }

  /* 阶段色与看板的列色一致：同一件事在两个视图里该是同一个颜色 */
  .stage-tag.executing { border-color: var(--status-active); color: var(--status-active); }
  .stage-tag.awaiting_review { border-color: var(--status-review); color: var(--status-review); }
  .stage-tag.reviewed { border-color: var(--status-done); color: var(--status-done); }
  /* "待人工"用告警色：它是**卡在你手里**那一档——不是进行中，也不是完成 */
  .stage-tag.needs_human { border-color: var(--warn); color: var(--warn); }

  /* 跑完之后：左边结论、右边产出文件 */
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

  .markdown {
    font-size: var(--fs-sm);
    line-height: 1.7;
    word-break: break-word;
  }

  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3),
  .markdown :global(h4) {
    margin: var(--sp-4) 0 var(--sp-2);
    line-height: 1.3;
  }

  .markdown :global(h1) { font-size: 1.4em; }
  .markdown :global(h2) { font-size: 1.2em; }
  .markdown :global(h3) { font-size: 1.05em; }

  .markdown :global(p) { margin: 0 0 var(--sp-3); }

  .markdown :global(ul),
  .markdown :global(ol) {
    margin: 0 0 var(--sp-3);
    padding-left: 1.4em;
  }

  .markdown :global(li) { margin-bottom: var(--sp-1); }

  .markdown :global(code) {
    font-family: var(--font-mono);
    font-size: 0.92em;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0 0.3em;
  }

  .markdown :global(pre) {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-3);
    overflow-x: auto;
  }

  .markdown :global(pre code) {
    background: none;
    border: 0;
    padding: 0;
  }

  .markdown :global(blockquote) {
    margin: 0 0 var(--sp-3);
    padding-left: var(--sp-3);
    border-left: 3px solid var(--line);
    color: var(--text-faint);
  }

  .markdown :global(table) {
    border-collapse: collapse;
    margin: 0 0 var(--sp-3);
    width: 100%;
  }

  .markdown :global(th),
  .markdown :global(td) {
    border: 1px solid var(--line);
    padding: var(--sp-1) var(--sp-2);
    text-align: left;
  }

  .markdown :global(img) {
    max-width: 100%;
    border-radius: var(--radius);
    border: 1px solid var(--line);
  }

  .result-files {
    border-left: 1px solid var(--line);
    padding-left: var(--sp-4);
  }

  .result-files h4 {
    margin: 0 0 var(--sp-2);
  }

  .wd {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .wd li {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 2px 0;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    min-width: 0;
  }

  .wd-dir {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    background: none;
    border: 0;
    padding: 0;
    color: var(--text-dim);
    font: inherit;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .wd-dir:hover { color: var(--text); }

  /* 展开箭头定宽：不定宽时，目录名会随着 ▸/▾ 的宽度差左右抖 */
  .wd-twisty {
    width: 0.75rem;
    flex-shrink: 0;
    color: var(--text-faint);
  }

  .wd-file {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* 平台注入的（技能、上下文文件）：弱化显示就够了，不再用一段文字去解释 */
  .wd-dir.managed,
  .wd-file.managed {
    color: var(--text-faint);
  }

  .result-files ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /* 常驻底栏里的它**不再自带边框与内边距**：外层 .pane-foot 已经有分隔线了，
     再套一层框会显得像页面里的一个孤岛 */
  .follow-up textarea {
    width: 100%;
    font-family: inherit;
    font-size: var(--fs-sm);
    padding: var(--sp-2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--text);
    resize: vertical;
  }

  .follow-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin-top: var(--sp-2);
  }

  /* ── 五列流水线 ──
     D40 起是五档：执行中 / 待审查 / 行动中 / 等待人处理（含行动失败） / 已完成审查。
     固定列数（而不是 auto-fit）：这几列就是流水线的几个状态，少一列会让人以为
     那个状态不存在。 */
  .board-5 {
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: var(--sp-3);
  }

  /* 中等宽度放 5 列会把每列压到 150px 上下，读不了 ⇒ 改成 3+2 两行 */
  @media (max-width: 100rem) {
    .board-5 {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  @media (max-width: 64rem) {
    .board-5 {
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
