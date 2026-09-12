import { DomainError, DomainErrorCode, type Store } from '@alpha-helper/domain'
import { ulid, type InboxItem, type Run, type RunId, type WorkspaceId } from '@alpha-helper/protocol'

/**
 * 重启后的遗留 run 处置（FR-RUNTIME-11）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 不做这件事会怎样
 * ══════════════════════════════════════════════════════════════════
 *
 * run 的状态是**持久化**的（FR-RUNTIME-10）。所以 daemon 被 Ctrl-C 或者崩掉
 * 之后，那些当时正在跑的 run 会**留在 `running` / `dispatched` /
 * `waiting_local_directory` 上**——因为没有任何人有机会把它们改成终态。
 *
 * 下次启动时，如果什么都不做：
 *
 *   - 看板会**永远**把它们显示成"进行中"；
 *   - 统计会把它们算成在途；
 *   - 使用者会去等一个**不会有结果**的东西。
 *
 * 这正是这个项目里反复出现的那类失败——**数据里写着正在进行，其实没人在进行**。
 * 它比一个明确的"失败了"糟得多，因为失败至少是确定的。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么只能标记为失败，而不能"续跑"
 * ══════════════════════════════════════════════════════════════════
 *
 * 因为**续跑所需的东西根本没落盘**：`SubmitRunRequest` 里的 `prompt`、
 * skill 正文、limits 都是随 HTTP 请求来的，`Run` 实体里只留了 `skillRefs`
 * 这样的引用。也就是说 daemon 重启后**拿不回当时要做什么**。
 *
 * 与其假装能续跑（那会跑出一个内容不对的东西，而且看起来一切正常），
 * 不如明确标记失败并把原因写清楚——使用者看到的是"这次因为重启中断了，
 * 请重跑"，这是一个**可行动**的信号。
 *
 * ⚠️ 顺带说明 `daemon_restarted` 这个失败原因是**枚举里早就有的**
 *    （`RunFailureReason`），只是一直没人产生它。这里把它接上。
 */

/**
 * ★ 收口要看的集合与 `ACTIVE_RUN_STATUSES` **不是一回事**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 两个问题的答案不同，所以集合也必须不同
 * ══════════════════════════════════════════════════════════════════
 *
 * `ACTIVE_RUN_STATUSES`（`dispatched` / `running` / `waiting_local_directory`）
 * 回答的是"**这个 run 现在占着资源吗**"——它被 `findRunHoldingWorkDir`
 * 与 `findActiveRunForSubjectAgent` 用，那两个问题的口径都是"还在进行"。
 * `queued` 不在里面是对的：它还没拿到工作目录，也不该挡住同目录的别人。
 *
 * 而这里要回答的是"**这个 run 还会有结果吗**"。一个 `queued` 的 run
 * 显然不会有——它同样卡在那里等一个已经消失的进程。
 *
 * 起初我直接复用了 `ACTIVE_RUN_STATUSES`，于是 `queued` 的 run 被漏掉，
 * 测试当场指出来。**复用语义不同的常量**在这里是最容易走的捷径，
 * 也是这类"漏了一类"缺陷最常见的来源。
 *
 * `deferred`（已排期未到点）同样算非终态——它是定时触发用的，
 * 本版还没产生它，但漏在集合外会让将来启用定时时**默默出问题**。
 */
const NON_TERMINAL_RUN_STATUSES = [
  'deferred',
  'queued',
  'dispatched',
  'waiting_local_directory',
  'running',
] as const satisfies readonly Run['status'][]

export interface ReconcileResult {
  /** 被标记为中断的 run。 */
  interrupted: Array<{ runId: RunId; previousStatus: Run['status'] }>
  /** 发出的通知条数（每个 workspace 至多一条汇总，避免刷屏）。 */
  notices: number
}

export interface ReconcileOptions {
  store: Store
  now?: () => number
}

/**
 * 把上次进程留下的非终态 run 收口。
 *
 * **在起 HTTP 服务之前调用**——否则页面可能在收口完成前就读到那些陈旧状态。
 */
export async function reconcileInterruptedRuns(
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const { store } = options
  const now = options.now ?? (() => Date.now())

  const result: ReconcileResult = { interrupted: [], notices: 0 }
  const workspaceIds = await store.listWorkspaceIds()

  for (const workspaceId of workspaceIds) {
    const stuck: Run[] = []
    for (const status of NON_TERMINAL_RUN_STATUSES) {
      const page = await store.listRuns({ workspaceId, status: [status], limit: 1000 })
      stuck.push(...page.items)
    }
    if (stuck.length === 0) continue

    for (const run of stuck) {
      // CAS 转移：万一期间有人动过它（不可能，但数据是持久的、别假设）
      // 转移失败就跳过——**不要**无条件覆盖。
      const ok = await store.transitionRun(run.id, run.status, 'failed', {
        failureReason: 'daemon_restarted',
        finishedAt: now(),
      })
      if (ok) {
        result.interrupted.push({ runId: run.id, previousStatus: run.status })
      }
    }

    const actuallyInterrupted = result.interrupted.filter((i) =>
      stuck.some((s) => s.id === i.runId),
    )
    if (actuallyInterrupted.length > 0) {
      await store.appendInboxItem(noticeFor(workspaceId, actuallyInterrupted.length, now()))
      result.notices += 1
    }
  }

  return result
}

/**
 * 通知要**汇总成一条**，不是每个 run 一条。
 *
 * 重启可能一次中断十几个 run。逐个发通知会瞬间把通知中心刷满，
 * 而 INV-8 要求通知必须稀缺——一次通知里说清"有 N 个被中断了"，
 * 比 N 条一模一样的通知有用得多。
 * 重启中断属于"需要留意"，不属于"需要你立刻做决定"，所以是 attention。
 */
function noticeFor(
  workspaceId: WorkspaceId,
  count: number,
  now: number,
): InboxItem {
  return {
    id: ulid(now),
    workspaceId,
    type: 'run.interrupted_by_restart',
    severity: 'attention',
    title: `${count} 个执行因 daemon 重启而中断`,
    body:
      `daemon 上次退出时这些执行还在进行，它们已被标记为失败（原因：daemon_restarted）。\n\n` +
      `**为什么会这样**：执行所需的信息（prompt、技能正文、限额）是随请求传来的，` +
      `没有落盘，所以重启后无法续跑——只能明确标记中断，而不是留一个永远"进行中"的状态。\n\n` +
      `**接下来怎么办**：在任务上重新发起一次即可。重跑会是一条新的 run，` +
      `旧记录仍然保留可查。`,
    issueId: null,
    runId: null,
    read: false,
    createdAt: now,
  }
}

/**
 * 供调用方判断"这个失败原因是不是重启造成的"。
 *
 * 单独一个函数是为了让页面不必硬编码字符串比较——那种比较在枚举改名时
 * 会**静默失效**（页面只是不再显示那条提示，不会报错）。
 */
export function isInterruptedByRestart(reason: Run['failureReason']): boolean {
  return reason === 'daemon_restarted'
}

/** 转移非法时抛出——用于自检，不该在正常运行中出现。 */
export function assertReconcileTransition(from: Run['status']): void {
  if (!(NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(from)) {
    throw new DomainError(
      DomainErrorCode.IllegalTransition,
      `只应收口非终态 run，收到 ${from}`,
    )
  }
}
