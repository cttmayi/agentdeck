/**
 * 编排运行画面：**每个 run 一张卡片**的显示判据——纯函数（可单测）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 使用者的期望（2026-11，照他的原话）
 * ══════════════════════════════════════════════════════════════════
 *
 *   "Agent 已启动在卡片中显示出来，一直接受文字消息并显示，直到最后结束。
 *    不要 Agent 之间有依赖关系，这样就不存在相互影响。"
 *
 * 翻译成三条判据：
 *   ① **run 一提交就上卡片**（不等兄弟 run 的状态、不等"执行完"）；
 *   ② **边跑边显示文字**（非终态就一直重拉，终态再补一次全文，之后不动）；
 *   ③ **两个 run 之间没有任何显示依赖**：卡片画不画只看"这条 run 存不存在"，
 *      文字画什么只看"这条 run 自己的状态与产出"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 之前为什么 loop 的审核 agent 显示不出来（两个 bug 叠在一起）
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **取数只看"最后一个 runId"**（`lastRunId(st)`）：loop 的
 *    `[执行1, 把关1, 执行2, …]` 里只有最新的那一条被拉过，前面几轮的 run 从来没取过数；
 * ② **取过一次就短路**（`if (execStatuses[rid] !== undefined) continue`）⇒ 状态是
 *    **快照**：执行 run 在"它还最新"的那几拍被取到（此时 `running`），把关 run 一提交
 *    它就不再是最新 ⇒ 再也不刷新 ⇒ 永远是 `running`。而把关者那一行的条件是
 *    "执行 run 已 `completed`" ⇒ **永远不成立** ⇒ 那一行永不出现。
 *
 * 修法就是使用者那三句话：**按 run 取数、非终态继续刷、按 run 独立渲染**。
 *
 * ⚠️ 抄一份终态常量是不理想的（前端不 import protocol 包，理由见 `api.ts` 顶部），
 *    所以由 `workflow-cards.test.ts` 钉住"这一列与协议里的终态逐项相同"
 *    ——与 `chat.ts` 同一个做法：抄一份而不钉住，才是真正危险的那种抄。
 */

/**
 * 已经结束的 run 状态（协议 `RunStatus` 里的终态子集）。
 *
 * ⚠️ 必须与 `packages/protocol/src/enums.ts` 的 `TERMINAL_RUN_STATUSES` 逐项相同。
 */
export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const

/** 这个 run 状态是不是终态（`undefined` / `null` = 还不知道 ⇒ 不算终态）。 */
export function isRunTerminal(status: string | undefined | null): boolean {
  if (status === undefined || status === null) return false
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
}

/**
 * 这条 run 的「状态 + 产出」还要不要再拉一次。
 *
 * @param status 界面此刻知道的状态（`undefined` = 还没取过）
 * @param hasOutput 已经有产出了吗
 *
 * 四种情形：
 *   · 从没取过 ⇒ 要（两条都要）；
 *   · **非终态 ⇒ 要**（「一直接受文字消息并显示」——这一条就是它）；
 *   · 终态但没有产出 ⇒ 要一次（终态那一刻的全文常常还没抓到）；
 *   · 终态且已有产出 ⇒ 不用（run 结束后产出不会变）。
 *
 * ⚠️ 这里**没有**"只取最后一个 runId"这回事：判据只问"这条 run 自己"，
 *    与它在步骤里的位置、与兄弟 run 的状态都无关（使用者的第 ③ 条）。
 */
export function needsFetch(status: string | undefined | null, hasOutput: boolean): boolean {
  if (status === undefined || status === null) return true
  if (!isRunTerminal(status)) return true
  return !hasOutput
}

/**
 * loop 步骤的「轮」：`step.runIds` 两两配对（执行者、把关者）。
 *
 * ⚠️ 引擎在 `while (attempt <= maxRounds)` 里**先执行再把关**，所以顺序恒为
 *    `[执行1, 把关1, 执行2, 把关2, …]`。奇数个（只可能出现在"把关者抛错"留下的
 *    半轮）时如实按半轮渲染，**不硬凑**一个空把关者。
 */
export function loopRounds(
  runIds: readonly string[],
): Array<{ exec: string; guard: string | null }> {
  const out: Array<{ exec: string; guard: string | null }> = []
  for (let i = 0; i < runIds.length; i += 2) {
    out.push({ exec: runIds[i]!, guard: runIds[i + 1] ?? null })
  }
  return out
}

/**
 * 这条 run 的卡片正文该画成什么。
 *
 *   · `text`   —— 有产出，画原文（边跑边刷出来的那段）；
 *   · `running`—— 非终态但还没吐字：给「（正在跑…）」。**这是"已启动"的样子**，
 *                 不是"没有产出"——那时候说没有产出是假话；
 *   · `empty`  —— 终态且确实没产出：给「（还没有产出）」。
 *
 * ⚠️ 三个分支只看**这条 run 自己**的状态与产出，不看兄弟 run（第 ③ 条）。
 */
export type RunCardBody = 'text' | 'running' | 'empty'

export function runCardBody(
  status: string | undefined | null,
  output: string | undefined,
): RunCardBody {
  if (output !== undefined && output.trim() !== '') return 'text'
  return isRunTerminal(status) ? 'empty' : 'running'
}
