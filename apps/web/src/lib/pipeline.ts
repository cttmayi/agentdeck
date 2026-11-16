import type { TextParams, WebTextId } from '@agentdeck/i18n'
import type { Issue, RunSummary } from './api.ts'

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
 * ★ 2026-11（D125）：只剩"执行"这一件事
 * ══════════════════════════════════════════════════════════════════
 *
 * 这里原来有六档：`executing` / `awaiting_review` / `needs_human` / `reviewed`
 * （另加 D123 删掉的 `action_running` / `action_failed`）——它们围着的都是
 * "审核 run 判了什么"。
 *
 *   **审核 run 与判决一起退场**（使用者拍板："智能体本身也不分『执行』与『审核』"）
 *   ⇒ 阶段只剩**执行自己的事实**：在跑 / 跑完了 / 跑砸了，外加任务级的"已放弃"。
 *
 *   要有人把关怎么办？由**编排**再派一条普通 run 去把关（它的答复就是答复，
 *   不产生平台级判决）——那时它是流水线上的**另一条执行 run**，不是新的一档。
 *
 *   ⚠️ 删掉那几档的代价要说清：**"这件事还等着你"不再由阶段表达**。原来
 *   `needs_human` 是"卡在人这儿"的专用档，现在它没有对应物了——因为平台不再
 *   产生"需要人裁决的结论"这种东西。人的出路只剩两条：**放弃**与**再派一条
 *   任务**（「反馈」）。
 */
export type Stage = 'executing' | 'done' | 'failed'
  /**
   * ★ 放弃：**任务级**的事实，盖过一切由 run 推出来的阶段（D47）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么它必须是**覆盖**而不是"再算一种情况"
   * ══════════════════════════════════════════════════════════════════
   *
   * 上面三档全部由 **run** 推出来；这一档由 **issue 自己的状态**决定。两者不是
   * 同一层的东西——一条被放弃的任务可能同时"有一条 run 正在跑"，而"我不管它了"
   * 这句话与它无关，它只说一件事：**别再让它占着你的注意力**。
   *
   * 所以它不是流水线上的一站（从左到右越来越接近结束），而是一个**出口**：
   * 看板把它放在最后一列，与流程方向无关，与"结束"也无关——放弃的任务可能
   * 一条 run 都没跑完。
   *
   * ⚠️ 它是**可撤销的**（`POST /issues/{id}/reopen`），所以那一列的任务还能
   *    回到流水线上。这也是为什么它不隐藏、不删除：放弃是一个判断，判断会变。
   */
  | 'abandoned'

/** run 的终态。不在其中的都算"还在进行"。 */
export const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export interface StageInfo {
  stage: Stage
  /** 作为锚点的那条执行 run（可能还没有）。 */
  executeRun: RunSummary | null
  /*
   * ⚠️ 2026-11（D125）：这里原来还有 `reviewRun: RunSummary | null`——"正在进行或
   *   已完成的审核 run"，界面靠它画"谁审、审到哪了"。审核 run 退场 ⇒ 删。
   */
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
  /*
   * ⚠️ 2026-11（D123）：这里原来是 `action: RunSummary['action']`——这次判决
   *   **要求做的那个动作**（任务详情据此显示"触发了什么、什么状态、为什么失败"）。
   *   动作能力退场 ⇒ daemon 的 runs 列表不再给这一栏，这里随之删。
   */
  /*
   * ⚠️ 2026-11（D124）：这里原来是 `reworked: number`——"这个任务已经返工过几次"
   *   （数名下 `chainDepth >= 1` 的执行 run）。**返工退场** ⇒ 不再有返工 run，
   *   这个数恒为 0；留着它会让每个任务行都显示一个"0 次返工"的假事实。
   */
}

/**
 * 一个任务**名下的全部 run**（按时间线排：最早的在前）。
 *
 * ⚠️ 2026-11（D125）：这里原来还要把"审这些执行 run 的 review run"一并收进来
 *   （review run 的 subject 是执行 run 的 id，不是 issue——按 issue 过滤会一条都
 *   找不到，那个 bug 犯过一次）。审核 run 退场 ⇒ 只剩执行 run。
 *
 *   ⚠️ 那条教训仍然成立，而且它不止关于审核：**"这条记录归谁"要顺着链走，
 *   不能想当然按最外层的 id 过滤**。
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
 * 现在按 `queuedAt` **升序**排。
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

  // 同刻的两条（同一毫秒内入队是可能的）用 runId 兜底：排序必须**稳定**，
  // 否则每次渲染顺序都可能变，看起来像"记录在跳"。
  const byTime = (a: RunSummary, b: RunSummary): number =>
    a.queuedAt - b.queuedAt || a.runId.localeCompare(b.runId)
  return [...executes].sort(byTime)
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


/*
 * ⚠️ 2026-11（D123）：这里原来是 `ACTION_DONE_STATUSES`（动作记录里哪些状态算
 *   "这一步结束了"）。动作记录退场 ⇒ 没有要判"结束没结束"的东西。
 */

/** 截断长文本（失败原因可能是一整段堆栈，列表里只留一句话的位置）。 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 哪些 issue 状态算"这条任务已经放弃了"（D47）。
 *
 * 只有 `cancelled` 一个。用集合而不是 `=== 'cancelled'`，是为了让**这条规则
 * 只有一处**：将来若再加一个"放弃"的取值（比如区分"放弃"与"重复"），改这里
 * 就够了，不会漏掉某个 `===` 比较。
 */
const ABANDONED_ISSUE_STATUSES: ReadonlySet<string> = new Set(['cancelled'])

/**
 * 阶段推导。**这是"一条任务现在到哪一步了"的唯一出处**。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ 为什么第一个参数是**整条 issue**，而不是 `issueId: string`（D47）
 * ══════════════════════════════════════════════════════════════════
 *
 * D47 之前它只要 id 就够了（阶段全部由 run 推出来）。加了「已放弃」那一档之后，
 * 还需要 **issue 自己的状态**——而那个信息 run 里根本没有。
 *
 * 第一版把它做成了**可选**的第三个参数（`issueStatus?`），理由是"那一大批只关心
 * run 的用例不用改"。**那是个错误，而且它当场就咬人了**：`views/Tasks.svelte` 里
 * 两个调用点都没传，于是点「放弃」之后接口返回 200、issue 状态确实变了、而看板
 * **一动不动**——不报错、不告警，正是这个文件最防的那类失效。
 *
 * 所以现在改成**必填**：调用方手里本来就有整条 issue，传进来是零成本的，而
 * "忘了传"从"一个静默的错误行为"变成了**编译错误**。这就是这个仓库一贯的做法——
 * 能让编译器守住的约定，不要写成注释里的约定。
 */
export function stageOf(
  issue: Pick<Issue, 'id' | 'status'>,
  allRuns: readonly RunSummary[],
): StageInfo {
  const derived = deriveStage(issue.id, allRuns)

  // ★ D47：放弃是**任务级**的事实，它盖过一切由 run 推出来的阶段。
  //
  //   在这里覆盖而不是在 `deriveStage` 里再插一个分支，是因为那个函数有**六个
  //   早返回点**——每加一档就要在每个返回点都记得带上它，漏一个的表现就是
  //   "放弃过的任务偶尔还显示在「等待人处理」里"（取决于它当初卡在哪一档）。
  //   包一层之后，"放弃赢"这件事只有一个地方说了算。
  if (ABANDONED_ISSUE_STATUSES.has(issue.status)) {
    return {
      ...derived,
      stage: 'abandoned',
      // ⚠️ 提示与警告都必须清掉：放弃过的任务不该再进「需要注意」那一拨
      //    （判据就是 `warningId !== null`；2026-11 列表已不再做"需注意置顶"，
      //      警告仍显示在行的标签/提示里），也不该再提示"没有派审核"——那是
      //    **要你去办**的事，而你已经决定不办了。
      noteId: null,
      warningId: null,
    }
  }

  return derived
}

/**
 * 真正的推导：只看 run。**不要直接调用它**（除了 `stageOf`）——放弃那一条
 * 覆盖规则在 `stageOf` 里，绕过它就会得到"放弃过的任务还显示在流水线上"。
 *
 * 三档，判据只有"最新那次执行走到哪了"：
 *
 * | 情况 | 阶段 |
 * |---|---|
 * | 一条执行 run 都还没有 / 最新那条还没结束 | `executing` |
 * | 最新那条正常跑完 | `done` |
 * | 最新那条失败或被取消 | `failed`（带一句为什么） |
 *
 * ⚠️ 2026-11（D125）：这里原来的判据要顺 `issue → 执行 run → 审核 run` 这条链
 *   走（"这条执行被审过没有"），还要再分 `needs_human` / `reviewed` /
 *   `action_running` 几档。审核 run 与判决退场 ⇒ 只看执行自己的事实。
 */
function deriveStage(issueId: string, allRuns: readonly RunSummary[]): StageInfo {
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
      // 标签是"执行中"，可它其实一次都没跑过 ⇒ 这句是额外信息，要留着
      noteId: 'tasks.noteNotStarted',
      warningId: null,
    }
  }

  if (!TERMINAL_RUN_STATUSES.has(latest.status)) {
    return {
      stage: 'executing',
      executeRun: latest,
      // "排队中（工作目录被占用）"是标签之外的信息；单纯"执行中"与标签重复，不要
      noteId: latest.status === 'waiting_local_directory' ? 'tasks.noteWaitingDir' : null,
      warningId: null,
    }
  }

  /*
   * 执行跑完了：成功就是 `done`，失败/取消就是 `failed`，各自带一句说明。
   *
   * ⚠️ 原来这里不是这么分档的：执行失败**仍然是**「待审查」，只是多一句警告
   *   （因为"待审查"在当时是对的——那次产出确实还没被审）。现在没有"审"这一步了，
   *   一条跑砸的执行停在「待审查」里就成了一句空话：它在等一个不会来的东西。
   */
  const warning = executionWarning(latest)
  if (warning !== null) {
    return {
      stage: 'failed',
      executeRun: latest,
      // 标签"失败"已经说了这件事，原因在 warning 里（那是要给你看的）
      noteId: null,
      warningId: warning.warningId,
      warningParams: warning.warningParams,
    }
  }

  return {
    stage: 'done',
    executeRun: latest,
    noteId: null, // 标签已经是"已完成"，再说一遍就是重复
    warningId: null,
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

/*
 * ⚠️ 2026-11（D125）：这里原来是 `coverageWarning`——"执行成功却没有任何审核 run
 *   ⇒ 多半是这个 agent 没配『由谁审它』"。
 *
 *   审核 run 退场 ⇒ "没配审核者"不再是配置问题（没有审核者这回事），函数删。
 *   ⚠️ 它当年守的那类信息仍然重要：**"这一步在等的东西不会来了"必须说出来**，
 *   只显示"待审查"会让人一直等。现在是"执行失败/取消"那一档在说这件事。
 */

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
  done: 'term.stage.done',
  failed: 'term.stage.failed',
  abandoned: 'term.stage.abandoned',
}

/** 某个阶段的短标签键（表格单元格、卡片角标用）。 */
export function stageShortId(stage: Stage): WebTextId {
  return SHORT_LABEL_ID[stage]
}

/** 两列的定义。顺序就是流水线方向，不能乱。 */
export const PIPELINE_COLUMNS: ReadonlyArray<{
  /**
   * 这一列收哪些 stage。
   *
   * ⚠️ 是**数组**：一列可以收多档。用数组而不是"给某档一个别名"，
   *    是因为阶段推导那边必须是**一档一个事实**，列只是它的展示分组。
   *
   * ★ 2026-11（D125）：三列并成**两列**——进行中 / 已结束。
   *
   *   「待处理」那一列没了：它收的是 `awaiting_review`（等审核）与 `needs_human`
   *   （判决说"得人来定"），而这两件事都是**审核 run 产生的**。审核退场之后
   *   没有"等审核"这回事，也就没有"待处理"这一站。
   *
   *   ⚠️ 代价要说清：**看板上不再有"这件事还等着你"的位置**。人的出路是「反馈」
   *   （再派一条任务，于是它回到「进行中」）与「放弃」（进「已结束」）——这两件事
   *   都在任务详情里做，不需要一列去站。
   *
   *   ⚠️ 合并的是**列**，不是档：卡片与行内仍显示具体 stage（`term.stage.*`
   *   短标签）——「失败」与「已完成」同在这个列里，但长得不一样。
   */
  ids: readonly Stage[]
  titleId: WebTextId
  hintId: WebTextId
}> = [
  {
    ids: ['executing'],
    titleId: 'tasks.col.ongoing.title',
    hintId: 'tasks.col.ongoing.hint',
  },
  {
    ids: ['done', 'failed', 'abandoned'],
    titleId: 'tasks.col.finished.title',
    hintId: 'tasks.col.finished.hint',
  },
]
