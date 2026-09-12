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

export type Stage = 'executing' | 'awaiting_review' | 'reviewed'

/** run 的终态。不在其中的都算"还在进行"。 */
export const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export interface StageInfo {
  stage: Stage
  /** 作为锚点的那条执行 run（可能还没有）。 */
  executeRun: RunSummary | null
  /** 正在进行或已完成的审核 run。 */
  reviewRun: RunSummary | null
  /** 一句话说明当前卡在哪儿——直接显示在卡片上。 */
  detail: string
  /**
   * 需要留意的情况。
   *
   * 单独一个字段而不是拼进 `detail`：界面要用不同的视觉处理它
   *（色条），而"需要留意"与"当前状态"是两种信息。
   */
  warning: string | null
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
      detail: '还没开始执行',
      warning: null,
    }
  }

  if (!TERMINAL_RUN_STATUSES.has(latest.status)) {
    return {
      stage: 'executing',
      executeRun: latest,
      reviewRun: null,
      detail:
        latest.status === 'waiting_local_directory'
          ? '排队中（工作目录被占用）'
          : '执行中',
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
    return {
      stage: 'reviewed',
      executeRun: latest,
      reviewRun: finished,
      detail: '审核已完成',
      warning: null,
    }
  }

  const active = reviews.find((r) => !TERMINAL_RUN_STATUSES.has(r.status))
  return {
    stage: 'awaiting_review',
    executeRun: latest,
    reviewRun: active ?? null,
    detail: active ? '审核中' : '等待审核',
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

/** 三列的定义。顺序就是流水线方向，不能乱。 */
export const PIPELINE_COLUMNS: ReadonlyArray<{
  id: Stage
  title: string
  hint: string
}> = [
  { id: 'executing', title: '正在执行', hint: 'agent 正在干活' },
  { id: 'awaiting_review', title: '已完成执行 · 待审查', hint: '等审核给出判决' },
  { id: 'reviewed', title: '已完成审查', hint: '判决已经产出' },
]
