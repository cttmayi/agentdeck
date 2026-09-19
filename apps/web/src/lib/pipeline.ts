import type { TextParams, WebTextId } from '@alpha-helper/i18n'
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
export type Stage =
  | 'executing'
  | 'awaiting_review'
  /**
   * ★ 判决要求做某件事，平台**正在做**（D40 之后）。
   *
   * 在这之前，这一段是**看不见**的：判决一产出就显示「已审查」，于是
   * "还没做完"和"已经做完"长得一模一样。
   */
  | 'action_running'
  /**
   * ★ 判决要求的动作**失败了**——卡在人手里。
   *
   * 它与会话里的 `needs_human` 走**同一列**（"等待人处理"），因为下一步动作
   * 完全一样：等人。卡片上写清是哪一种（判决要人 / 行动失败），两者都需要
   * 一个**人**去看一眼。
   */
  | 'action_failed'
  | 'needs_human'
  | 'reviewed'

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
   *
   * ⚠️ 这里是**文案键**（D39），不是中文句子：推导逻辑与语言无关，取词是界面
   *    的事。这样同一句话只有一处出处，中英两边由 `web/tasks.ts` 保证都有。
   */
  noteId: WebTextId | null
  /**
   * 需要留意的情况。
   *
   * 与 `noteId` 分开：界面要用不同的视觉处理它（色条），而"需要留意"
   * 与"当前状态"是两种信息。
   */
  warningId: WebTextId | null
  /** `warningId` 的插值（失败原因、判决给的理由）。没有占位符时是 `undefined`。 */
  warningParams?: TextParams | undefined
  /**
   * 这次判决**要求做的那个动作**（没有 / 还没落库 ⇒ `null`）。
   *
   * ⚠️ 与 `warningId` 分开：提示是"一句话该不该给"，这里是**事实**。
   *    任务详情要显示"到底触发了什么动作、什么状态、为什么失败"——那些是
   *    契约值（`example-note.append-note`、`failed`），原样显示、不翻译。
   */
  /**
   * ⚠️ 形状**引用** `RunSummary['action']` 而不是在这里再抄一遍：
   *    两处各写一份类型的话，往 daemon 那侧加一个字段（`result`/`params`/
   *    `finishedAt` 就是这么加进来的）时，这里不会报错、只会**看不到那个字段**
   *    ——而"看不到"的表现正好是使用者报的那条「配了行动但看不见结果」。
   */
  action: RunSummary['action']
  /**
   * 这个任务**已经返工过几次**（D45）。
   *
   * 判据是名下有 `chainDepth >= 1` 的执行 run 数——每条返工 run 的 `chainDepth`
   * 就是"它是第几次返工"，所以数一数就知道。`0` = 没返工过（绝大多数任务）。
   *
   * ⚠️ 这里**只给事实，不给上限**：上限配在这条任务的首个执行 run 上
   *    （`maxReworks`），而这个函数拿到的是"已经几次"。界面要显示 `N/M` 就自己
   *    从首条执行 run 上取 M——把两个数在这里拼成一句话，会让"上限改了但旧 run
   *    还记着老上限"这种正常情况显示成一个自相矛盾的值。
   */
  reworked: number
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


/**
 * 动作记录里哪些状态算"这一步结束了"。
 *
 * ★ 判据是**白名单**而不是"不是 executing 就算完"：状态的取值是契约
 *   （`ActionStatus`），将来加了新状态时，这里默认把它当成"没结束"——
 *   宁可多显示一会儿「行动中」，也不要**把没做完的说成做完了**。
 */
const ACTION_DONE_STATUSES = new Set(['executed', 'skipped', 'rolled_back'])

/** 截断长文本（失败原因可能是一整段堆栈，列表里只留一句话的位置）。 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function stageOf(issueId: string, allRuns: readonly RunSummary[]): StageInfo {
  const executes = allRuns
    .filter(
      (r) => r.kind === 'execute' && r.subject?.type === 'issue' && r.subject.id === issueId,
    )

    .sort((a, b) => b.queuedAt - a.queuedAt)

  // ★ D45：这个任务**已经返工过几次**。每条返工 run 的 `chainDepth` 就是"第几次"，
  //   所以数一数即可——不需要在数据层再养一个计数器（同一件事两个出处，
  //   "哪个说了算"就只能靠注释记住）。
  //
  //   ⚠️ 声明必须在**所有早返回之前**（上面那两个 `stage: 'executing'` 也要带上它）。
  const reworked = executes.filter((r) => (r.chainDepth ?? 0) >= 1).length

  const latest = executes[0] ?? null
  if (!latest) {
    return {
      stage: 'executing',
      reworked,
      executeRun: null,
      reviewRun: null,
      // 标签是"执行中"，可它其实一次都没跑过 ⇒ 这句是额外信息，要留着
      noteId: 'tasks.noteNotStarted',
      warningId: null,
      action: null,
    }
  }

  if (!TERMINAL_RUN_STATUSES.has(latest.status)) {
    return {
      stage: 'executing',
      reworked,
      executeRun: latest,
      reviewRun: null,
      // "排队中（工作目录被占用）"是标签之外的信息；单纯"执行中"与标签重复，不要
      noteId: latest.status === 'waiting_local_directory' ? 'tasks.noteWaitingDir' : null,
      warningId: null,
      action: null,
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
      //
      // ★ D45：`fail` 也会落到这里（返工次数用完、或这条任务压根没配返工），
      //   但它的"原因"不在 `escalateReason` 上——schema 只允许 `needs_human`
      //   带那个字段。所以按结论分开说：**"审核不通过"与"审核者拿不准"是
      //   两件事**，前者要你去改活、后者要你去补判断依据，给同一句话等于
      //   把"哪里需要我"这条最有用的信息抹平。
      const reason = verdict.escalateReason?.trim()
      const rejected = verdict.conclusion === 'fail'
      return {
        stage: 'needs_human',
        reworked,
        executeRun: latest,
        reviewRun: finished,
        // 标签"待人工"已经说了这件事；缺什么在 warning 里（那是要给你看的）
        noteId: null,
        action: finished.action ?? null,
        warningId: rejected
          ? 'tasks.warnRejectedNoRework'
          : reason
            ? 'tasks.warnNeedsHuman'
            : 'tasks.warnNeedsHumanNoReason',
        ...(reason
          ? { warningParams: { reason: reason.length > 80 ? `${reason.slice(0, 80)}…` : reason } }
          : {}),
      }
    }
    // ── 判决有效且不是"要人" ⇒ 看它**要求的那个动作**做得怎么样了 ──
    //
    // ★ 这一段是这次改动的一半：过去「已审查」= 判决已产出，动作成没成与它无关，
    //   于是"判决通过、动作失败"的任务看起来跟"全都做完了"一模一样（使用者那句
    //   "审核通过并行动成功才最后算通过"就是冲这个来的）。
    //
    //   判据取动作记录自己的状态（`RunSummary.action`，由 daemon 的 runs 列表给出）：
    //     · 还在跑（proposed/auto_approved/executing）⇒ 行动中
    //     · failed                                    ⇒ 行动失败（卡在人手里）
    //     · executed / skipped / rolled_back / 没有动作 ⇒ 已审查
    const action = finished.action ?? null

    // ⚠️ 判决已经说"派给动作了"，而动作记录**还没出现**（判决落库与动作落库之间
    //    那一小段）：这时只能算「行动中」，不能算「已审查」——否则那一瞬间它会
    //    短暂地显示成"做完了"。判据取判决自己的状态（`dispatched_to_action`）。
    if (action === null && finished.verdict?.status === 'dispatched_to_action') {
      return {
        stage: 'action_running',
        reworked,
        executeRun: latest,
        reviewRun: finished,
        noteId: 'tasks.noteActionRunning',
        warningId: null,
        action: null,
      }
    }

    // ⚠️ D45：判决说"已派返工"，而那条返工 run **还没出现在列表里**（派出去与
    //    列表刷新之间那一小段）。这时算「执行中」——返工就是要再跑一次活。
    //    不处理的话它会短暂显示成「已审查」，而那是这条判决**最不**该有的样子：
    //    它是"不通过、正在重做"，不是"做完了"。
    if (action === null && finished.verdict?.status === 'rework_requested') {
      return {
        stage: 'executing',
        reworked,
        executeRun: latest,
        reviewRun: finished,
        noteId: 'tasks.noteReworking',
        warningId: null,
        action: null,
      }
    }

    if (action !== null && !ACTION_DONE_STATUSES.has(action.status)) {
      const failed = action.status === 'failed'
      return {
        stage: failed ? 'action_failed' : 'action_running',
        reworked,
        executeRun: latest,
        reviewRun: finished,
        action,
        // 动作名是**契约值**（`example-note.append-note` 那种），原样显示；
        // 它是对"到底在做什么"最有用的那一条信息。
        noteId: failed ? null : 'tasks.noteActionRunning',
        ...(failed
          ? {
              // 失败原因正是"要我去做什么"——带上它（与 needs_human 同理）。
              // ⚠️ 没有原因时**必须换一条键**：带着 `{reason}` 的模板会原样留下
              //    那个占位符（`renderText` 缺参数时刻意不编一个值）。
              warningId:
                action.error !== null && action.error !== ''
                  ? ('tasks.warnActionFailed' as const)
                  : ('tasks.warnActionFailedNoReason' as const),
              ...(action.error !== null && action.error !== ''
                ? { warningParams: { reason: truncate(action.error, 120) } }
                : {}),
            }
          : { warningId: null }),
      }
    }

    return {
      stage: 'reviewed',
      reworked,
      executeRun: latest,
      reviewRun: finished,
      noteId: null, // 标签已经是"已审查"，再说一遍就是重复
      warningId: null,
      action,
    }
  }

  const active = reviews.find((r) => !TERMINAL_RUN_STATUSES.has(r.status))
  // 执行失败/被取消，或者根本没派审核 ⇒ 都要说一句（见下面两个函数）。
  const warning = executionWarning(latest) ?? coverageWarning(reviews.length)
  return {
    stage: 'awaiting_review',
    reworked,
    executeRun: latest,
    reviewRun: active ?? null,
    // ★ 只有审核**真的在跑**才说「审核中」：那与标签"待审查"是两件事。
    //   排队中的审核（queued/dispatched）不说——"审核中"对它不成立，
    //   而"等待审核"又与标签重复（使用者点名要去掉的正是它）。
    noteId: active?.status === 'running' ? 'tasks.noteReviewing' : null,
    warningId: warning?.warningId ?? null,
    warningParams: warning?.warningParams,
    action: null,
  }
}

/** 一条提示 = 文案键 + 可选的插值。 */
interface WarningRef {
  warningId: WebTextId
  warningParams?: TextParams
}

/**
 * 执行失败/被取消时要说明——否则卡片只是静静躺在"待审查"里，
 * 而它其实**不会**有审核结果（没有哪条执行产出可审）。
 */
function executionWarning(run: RunSummary): WarningRef | null {
  if (run.status === 'completed') return null
  const cancelled = run.status === 'cancelled'
  const reason = run.failureReason?.trim()
  if (cancelled) {
    return reason
      ? { warningId: 'tasks.warnExecCancelledReason', warningParams: { reason } }
      : { warningId: 'tasks.warnExecCancelled' }
  }
  return reason
    ? { warningId: 'tasks.warnExecFailedReason', warningParams: { reason } }
    : { warningId: 'tasks.warnExecFailed' }
}

/**
 * 执行成功却没有任何审核 run ⇒ 多半是这个 agent 没配「由谁审它」。
 *
 * 这是**配置问题**，不是运行故障，所以要明确指出去看哪里——
 * 只显示"等待审核"会让人一直等一个不会来的东西。
 */
function coverageWarning(reviewCount: number): WarningRef | null {
  if (reviewCount > 0) return null
  return { warningId: 'tasks.warnNoReview' }
}

/**
 * 表格与卡片里用的**短标签**：`term.stage.*`（`packages/i18n/src/web/terms.ts`）。
 *
 * 三列的标题（"已完成执行 · 待审查"）是给看板当列头用的，塞进表格单元格太长
 * （会把那一列撑开、把标题挤没）。短标签原来是这里的一张 `STAGE_SHORT` 表；
 * D39 之后它只剩"键"这一件事，于是并进词条表——**同一句话只有一个出处**，
 * 否则中英两边会各留一份"执行中"，改一处漏一处。
 */
const SHORT_LABEL_ID: Record<Stage, WebTextId> = {
  executing: 'term.stage.executing',
  awaiting_review: 'term.stage.awaiting_review',
  action_running: 'term.stage.action_running',
  action_failed: 'term.stage.action_failed',
  needs_human: 'term.stage.needs_human',
  reviewed: 'term.stage.reviewed',
}

/** 某个阶段的短标签键（表格单元格、卡片角标用）。 */
export function stageShortId(stage: Stage): WebTextId {
  return SHORT_LABEL_ID[stage]
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
 * 判据只用 `StageInfo.warningId`（有没有那条"需要注意"的提示），它现在覆盖两类
 * **真的要人看一眼**的情况：
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
  for (const item of staged) (item.info.warningId ? attention : rest).push(item)
  return { attention, rest }
}

/** 三列的定义。顺序就是流水线方向，不能乱。 */
export const PIPELINE_COLUMNS: ReadonlyArray<{
  /**
   * 这一列收哪些 stage。
   *
   * ⚠️ 是**数组**：一列可以收两档（「等待人处理」同时收 `needs_human` 与
   *    `action_failed`——两者下一步都是等人）。用数组而不是"给某档一个别名"，
   *    是因为阶段推导那边必须是**一档一个事实**，列只是它的展示分组。
   */
  ids: readonly Stage[]
  titleId: WebTextId
  hintId: WebTextId
}> = [
  { ids: ['executing'], titleId: 'tasks.col.executing.title', hintId: 'tasks.col.executing.hint' },
  {
    ids: ['awaiting_review'],
    titleId: 'tasks.col.awaiting_review.title',
    hintId: 'tasks.col.awaiting_review.hint',
  },
  // ★ D40 起「行动中」单独一列：判决一产出就显示"已审查"的那段日子，
  //   把"还在做"和"做完了"显示成了同一个样子。
  {
    ids: ['action_running'],
    titleId: 'tasks.col.action_running.title',
    hintId: 'tasks.col.action_running.hint',
  },
  // ★ 这一列在"行动中"之后、"已审查"之前：从左往右是"越来越接近结束"，
  //   而"待人工"是**卡在你手里**那一档——还没结束，所以它在"已审查"前面。
  //
  //   ⚠️ 它同时收 **两个** stage：`needs_human`（判决自己说要人介入）与
  //   `action_failed`（判决要求的动作失败了）。两者下一步动作完全一样——
  //   **等人来看一眼**——所以并在一列；卡片上写清是哪一种。分成两列的唯一
  //   好处是更整齐，代价是看板从 5 列变 6 列、每列挤到读不了。
  {
    ids: ['needs_human', 'action_failed'],
    titleId: 'tasks.col.needs_human.title',
    hintId: 'tasks.col.needs_human.hint',
  },
  { ids: ['reviewed'], titleId: 'tasks.col.reviewed.title', hintId: 'tasks.col.reviewed.hint' },
]
