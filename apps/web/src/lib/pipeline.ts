import type { RunSummary } from './api.ts'

/**
 * 任务流水线的阶段推导。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么按"事实"分组，而不是按 issue 的 status 字段
 * ══════════════════════════════════════════════════════════════════
 *
 * `status` 是**人工维护的**：任务做完了要有人去改它。而流水线阶段是
 * **从执行记录推出来的事实**——没人改也不会错。
 *
 * 一个"状态还是 in_progress、其实执行早就结束在等审核"的任务，按 status
 * 看不出任何问题；按阶段一眼就能看到它卡在第二列。
 *
 * ── 阶段怎么判 ──
 *
 * 以**最新的一次执行 run** 为锚点（重试会产生多条，旧的不算数）：
 *
 * | 情况 | 阶段 |
 * |---|---|
 * | 一条执行 run 都还没有 | 正在执行（等待执行） |
 * | 最新执行 run 未结束 | 正在执行 |
 * | 执行结束了、审核未完成 | 待审查 |
 * | 审核完成了 | 已审查 |
 *
 * ⚠️ **审核 run 的 subject 是执行 run 的 id**（`{type:'run'}`），不是 issue。
 *    所以"这条执行被审过没有"要顺着 `issue → 执行 run → 审核 run` 这条链走。
 *    直接按 issue 找 review run 会一条也找不到——那个 bug 我犯过一次。
 *
 * 之所以把它放在 `.ts` 里而不是组件内部：**这段逻辑有真实的边界情况**
 *（重试、执行失败、没配审核者），值得单独测。藏在 Svelte 组件里就只能靠
 * 手点界面来验证，而那些边界情况恰恰最难手动复现。
 */

/**
 * 一个任务"走到哪一步了"。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ `needs_human` 是独立的一档，不是"已审查"的一种
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者的反馈：「审查的结论是 `needs_human`，被标为『已审查』，不合理」。
 *
 * 确实不合理：`needs_human` 的意思是**判决自己说了"这事得人来定"**——
 * 它没在等人审，它在等**你**。把它归进「已审查」，等于把待办显示成做完了
 * （而且那一栏的语义是"判决已产出、流程走完了"）。
 *
 * 所以它单独一档：看板上单独一列，列表里单独一个标签（`待人工`）。
 */
export type Stage = 'executing' | 'awaiting_review' | 'needs_human' | 'reviewed'

/** run 的终态。不在其中的都算"还在进行"。 */
export const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export interface StageInfo {
  stage: Stage
  /** 作为锚点的那条执行 run（可能还没有）。 */
  executeRun: RunSummary | null
  /** 正在进行或已完成的审核 run。 */
  reviewRun: RunSummary | null
  /**
   * 标签**之外**还值得说一句的东西；没有就是 `null`。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这里原来还有一个 `detail`，已经删掉了
   * ══════════════════════════════════════════════════════════════════
   *
   * 使用者的反馈：「阶段里面去掉『待审查』下面『等待审核』的字样，重复了」。
   *
   * 第一刀是把重复的那句从界面上撤掉（列表/看板改读 `note`）。但撤完一看，
   * `detail` 在整个前端**一个消费者都没有**：它当初的理由是"给看板列头写
   * 的"，可看板列头用的是列定义里的静态 `col.hint`，卡片用的是 `note`。
   *
   * 于是 `detail` 只剩一个作用：**把刚被点掉的那句话继续养在数据层**，
   * 任何后来的改动只要顺手渲染一下它，重复就原样长回来。删掉它，
   * "同一句话只准有一个出处"就成了类型层面的事实——`note` 之外没有别处。
   *
   * 删掉**没有丢失任何使用者可见的信息**：
   *   - '还没开始执行' / '排队中（工作目录被占用）' → 原来就等于 `note`；
   *   - '执行中' / '审核中' → 就是标签本身，`note` 只在审核真在跑时说；
   *   - '等待审核' / '审核已完成' → 与标签"待审查"/"已审查"同义，无信息。
   */
  note: string | null
  /**
   * 需要留意的情况。
   *
   * 与 `note` 分开：界面要用不同的视觉处理它（色条），而"需要留意"
   * 与"当前状态"是两种信息。
   */
  warning: string | null
}

/**
 * 一个任务**名下的全部 run**：执行 run + 审它们的 review run。
 *
 * ══════════════════════════════════════════════════════════════════
 * 任务详情原来只按 issue 过滤，于是审查 run 一条都看不到
 * ══════════════════════════════════════════════════════════════════
 *
 * 它写的是 `runs.filter(r => r.subject.id === issueId)`。而 **review run 的
 * subject 是那条 execute run 的 id**（`{type:'run'}`），不是 issue——所以：
 *
 *   - 看板知道这个任务"审查完成了"（`stageOf` 顺着链条找到了 review run），
 *     卡片出现在「已完成审查」那一列；
 *   - 点进任务详情，却**只有一条执行 run**：没有 review run 的标签页，
 *     于是它的判决也读不出来（判决是挂在 review run 上的），
 *     `/api/runs/<执行run>/verdicts` 返回 0 条。
 *
 * 表现就是"那一列说审查完了，点进去看不到任何审查结论"。
 *
 * `stageOf` 的文件头早就写明了这条链（"直接按 issue 找 review run 会一条也
 * 找不到——那个 bug 我犯过一次"），但任务详情这条路没照它做。所以把它提成
 * 一个纯函数，两条路共用同一套"归属"规则，不再各写一遍。
 *
 * 排序：**按时间先后（最早的在前）**——这一列是任务的**时间线**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这条规则被改过一次，改的是"按什么排"
 * ══════════════════════════════════════════════════════════════════
 *
 * 原来是"**执行 run 一组（新的在前）+ 它们的 review run 一组（新的在前）**"。
 * 那个顺序在脑子里想得通（"先看执行、审查在旁边"），但**读出来是乱的**：
 *
 *   一次 执行 → 审核 → 又执行 → 又审核 的任务，标签页排成
 *   `e2, e1, r2, r1`——**后一次审核排在第一次审核前面**，而且 e1 出现在
 *   e2 之后。使用者的反馈是：「任务的记录貌似不是按时间顺序排列的，发现审查了
 *   2 次，后面的审查在前面」。
 *
 * 现在按 `queuedAt` **升序**排：`e1, r1, e2, r2`。从左往右读就是发生顺序，
 * "审了两次"变成一眼可见的先后关系。
 *
 * ⚠️ 因此**默认选中哪一条是调用方的事**：时间线的最早那条在数组开头，
 *    而"点进去想看最新的结果"要靠取最后一条来满足（见 Tasks.svelte）。
 */
export function runsForIssue(
  issueId: string,
  allRuns: readonly RunSummary[],
): RunSummary[] {
  const executes = allRuns.filter(
    (r) => r.kind === 'execute' && r.subject?.type === 'issue' && r.subject.id === issueId,
  )
  const executeIds = new Set(executes.map((r) => r.runId))
  const reviews = allRuns.filter(
    (r) => r.kind === 'review' && r.subject?.type === 'run' && executeIds.has(r.subject.id),
  )

  // 同刻的两条（同一毫秒内入队是可能的）用 runId 兜底：排序必须**稳定**，
  // 否则每次渲染顺序都可能变，看起来像"记录在跳"。
  const byTime = (a: RunSummary, b: RunSummary): number =>
    a.queuedAt - b.queuedAt || a.runId.localeCompare(b.runId)
  return [...executes, ...reviews].sort(byTime)
}

/**
 * 标签页上的时间戳。
 *
 * ★ 它是这次改动的一半：光把顺序排对**还不够**——原来那排标签只显示
 *   `[状态] [runId 后 8 位]`，既没有类型也没有时间，使用者根本看不出
 *   "哪个先哪个后"，只能凭感觉猜（于是他猜"顺序不对"）。
 *   把时间显示出来，顺序才是**可核对**的。
 *
 * 今天的只写时分秒（同一任务的时间线通常就在一天内）；跨天的带上月日。
 */
export function formatRunStamp(queuedAt: number, now = Date.now()): string {
  const at = new Date(queuedAt)
  const today = new Date(now)
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate()
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  const ss = String(at.getSeconds()).padStart(2, '0')
  return sameDay ? `${hh}:${mm}:${ss}` : `${at.getMonth() + 1}/${at.getDate()} ${hh}:${mm}`
}

export function stageOf(issueId: string, allRuns: readonly RunSummary[]): StageInfo {
  const executes = allRuns
    .filter(
      (r) => r.kind === 'execute' && r.subject?.type === 'issue' && r.subject.id === issueId,
    )
    .sort((a, b) => b.queuedAt - a.queuedAt)

  const latest = executes[0] ?? null
  if (!latest) {
    return {
      stage: 'executing',
      executeRun: null,
      reviewRun: null,
      // 标签是"执行中"，可它其实一次都没跑过 ⇒ 这句是额外信息，要留着
      note: '还没开始执行',
      warning: null,
    }
  }

  if (!TERMINAL_RUN_STATUSES.has(latest.status)) {
    return {
      stage: 'executing',
      executeRun: latest,
      reviewRun: null,
      // "排队中（工作目录被占用）"是标签之外的信息；单纯"执行中"与标签重复，不要
      note: latest.status === 'waiting_local_directory' ? '排队中（工作目录被占用）' : null,
      warning: null,
    }
  }

  const reviews = allRuns
    .filter(
      (r) => r.kind === 'review' && r.subject?.type === 'run' && r.subject.id === latest.runId,
    )
    .sort((a, b) => b.queuedAt - a.queuedAt)

  const finished = reviews.find((r) => r.status === 'completed')
  if (finished) {
    // ★ 判决说"需要人"时**不是**完成态。
    //   判据取两个：结论是 `needs_human`，或者判决状态是 `escalated`
    //   （后者还覆盖"判决不合规且无法重试 ⇒ 交给人"那条路）。
    //   两者都是"卡在人这儿"，而界面上原来一律显示成"已审查"。
    const verdict = finished.verdict
    const needsHuman =
      verdict !== null &&
      verdict !== undefined &&
      (verdict.conclusion === 'needs_human' || verdict.status === 'escalated')
    if (needsHuman) {
      // 判决自己说了"得人来看"，所以它同时进「需要注意」那一拨（INV-8：
      // 通知只留给"需要你介入"的事）。**把原因带上**——那才是可操作的部分。
      const reason = verdict.escalateReason?.trim()
      return {
        stage: 'needs_human',
        executeRun: latest,
        reviewRun: finished,
        // 标签"待人工"已经说了这件事；缺什么在 warning 里（那是要给你看的）
        note: null,
        warning: reason
          ? `判决要求人介入：${reason.length > 80 ? `${reason.slice(0, 80)}…` : reason}`
          : '判决要求人介入（详见这条审核的判决）',
      }
    }
    return {
      stage: 'reviewed',
      executeRun: latest,
      reviewRun: finished,
      note: null, // 标签已经是"已审查"，再说一遍就是重复
      warning: null,
    }
  }

  const active = reviews.find((r) => !TERMINAL_RUN_STATUSES.has(r.status))
  return {
    stage: 'awaiting_review',
    executeRun: latest,
    reviewRun: active ?? null,
    // ★ 只有审核**真的在跑**才说「审核中」：那与标签"待审查"是两件事。
    //   排队中的审核（queued/dispatched）不说——"审核中"对它不成立，
    //   而"等待审核"又与标签重复（使用者点名要去掉的正是它）。
    note: active?.status === 'running' ? '审核中' : null,
    warning: executionWarning(latest) ?? coverageWarning(reviews.length),
  }
}

/**
 * 执行失败/被取消时要说明——否则卡片只是静静躺在"待审查"里，
 * 而它其实**不会**有审核结果（没有哪条执行产出可审）。
 */
function executionWarning(run: RunSummary): string | null {
  if (run.status === 'completed') return null
  const what = run.status === 'cancelled' ? '被取消' : '失败'
  return `执行${what}了${run.failureReason ? `（${run.failureReason}）` : ''}`
}

/**
 * 执行成功却没有任何审核 run ⇒ 多半是这个 agent 没配「由谁审它」。
 *
 * 这是**配置问题**，不是运行故障，所以要明确指出去看哪里——
 * 只显示"等待审核"会让人一直等一个不会来的东西。
 */
function coverageWarning(reviewCount: number): string | null {
  if (reviewCount > 0) return null
  return '没有派审核 —— 检查这个 agent 的「由谁来审它」'
}

/**
 * 表格与卡片里用的**短标签**。
 *
 * 三列的标题（"已完成执行 · 待审查"）是给看板当列头用的，塞进表格单元格太长
 * （会把那一列撑开、把标题挤没）。
 */
export const STAGE_SHORT: Record<Stage, string> = {
  executing: '执行中',
  awaiting_review: '待审查',
  needs_human: '待人工',
  reviewed: '已审查',
}

/** 一个任务 + 它的阶段推导——列表与看板都用它。 */
export interface StagedIssue<T> {
  issue: T
  info: StageInfo
}

/**
 * 把任务分成「**需要注意**」与其余两拨。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么单独一拨，而不是换个排序
 * ══════════════════════════════════════════════════════════════════
 *
 * 单独一拨而不是"按优先级重排全部"：重排会让**其余任务的顺序也变**，而使用者的
 * 心理模型是"列表大致按时间"，突然整体重排会让人找不到刚才那条。
 * 置顶一拨 + 其余保持原序，两边都成立。
 *
 * 判据只用 `StageInfo.warning`，它现在覆盖两类**真的要人看一眼**的情况：
 *   - 执行失败/被取消 —— 它**不会**有审核结果（没有产出可审），干等是白等；
 *   - 执行成功但没派审核 —— 配置问题（那个 agent 没配「由谁来审它」）。
 *
 * 第三类：「**判决要求人介入**」（`needs_human`，或判决状态 `escalated`）。
 *
 * ⚠️ 这类原来**进不来**，因为判决结论不在 `runs` 列表里（要按 run 单独查）。
 *    当时的注释写着"等把它并进列表响应之后再加进来，在那之前不要在这里假装
 *    覆盖了它"——现在判决已经并进列表响应（`RunSummary.verdict`），所以补上。
 *    它正落在 INV-8 对"通知"的定义上：**需要你介入**。
 */
export function splitByAttention<T>(
  staged: ReadonlyArray<StagedIssue<T>>,
): { attention: Array<StagedIssue<T>>; rest: Array<StagedIssue<T>> } {
  const attention: Array<StagedIssue<T>> = []
  const rest: Array<StagedIssue<T>> = []
  for (const item of staged) (item.info.warning ? attention : rest).push(item)
  return { attention, rest }
}

/** 三列的定义。顺序就是流水线方向，不能乱。 */
export const PIPELINE_COLUMNS: ReadonlyArray<{
  id: Stage
  title: string
  hint: string
}> = [
  { id: 'executing', title: '正在执行', hint: 'agent 正在干活' },
  { id: 'awaiting_review', title: '已完成执行 · 待审查', hint: '等审核给出判决' },
  // ★ 这一列在"待审查"之后、"已审查"之前：从左往右是"越来越接近结束"，
  //   而"待人工"是**卡在你手里**那一档——还没结束，所以它在"已审查"前面。
  { id: 'needs_human', title: '等待人处理', hint: '判决要求人介入，卡在你这里' },
  { id: 'reviewed', title: '已完成审查', hint: '判决已经产出' },
]
