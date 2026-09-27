import type { Run } from '@agentdeck/protocol'
import type { Store } from '../ports/store.ts'
import type { ChainStep } from './bounds.ts'

/**
 * 链路重建（INV-14~16 的地基）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须能重建整条链路，而不能只看一个深度数字
 * ══════════════════════════════════════════════════════════════════
 *
 * `Run.chainDepth` 只是一个**计数器**。计数器能挡住长链，但挡不住短环：
 *
 *     A 审 X → 判"要改" → 派生 run → B 审 X → 判"要改" → 派生 run → A 审 X → …
 *
 * 这条链的深度可以很小（3 就够转一圈）却永远不停。只有把
 * "谁在什么对象上、以什么理由做过判断"重新拼出来，才认得出一模一样的一步。
 *
 * ══════════════════════════════════════════════════════════════════
 * 重建路径：Run.derivedFrom 是唯一的边
 * ══════════════════════════════════════════════════════════════════
 *
 *     run.derivedFrom → action → action.verdictId → verdict → verdict.runId → 上一个 run
 *
 * 这条边从 M0 起就在 schema 里（`Run.derivedFrom`），但一直没人走过去。
 * 不新增字段就能还原，也意味着**历史数据同样可重建**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 一步的"身份"取的是它**产出的判决的原因码**
 * ══════════════════════════════════════════════════════════════════
 *
 * 判据是"同一对象、同一 agent、同一原因码出现第二次"。
 * 用原因码而不是用 runId 或时间戳，是因为要抓的是**在原地打转**：
 * 如果每轮的原因码都在变（真的在推进），就不该被判成环。
 */

/** 重建的兜底上限：数据损坏或将来出现意料之外的边时，不能把进程挂死。 */
export const MAX_CHAIN_HOPS = 64

/**
 * 重建一条链路，返回**从根到当前**的步骤序列。
 *
 * 顺序很重要：`detectChainCycle` 按出现顺序判重，根在前才符合
 * "第一步 vs 后来的某一步重复"这个直觉。
 */
export async function loadChainSteps(
  store: Store,
  run: Run,
  maxHops: number = MAX_CHAIN_HOPS,
): Promise<ChainStep[]> {
  const steps: ChainStep[] = []
  const seenRuns = new Set<string>()

  let current: Run | null = run
  let hops = 0

  while (current && hops < maxHops) {
    // 数据层面的自环兜底：derivedFrom 万一指回自己，循环会无限下去。
    if (seenRuns.has(current.id)) break
    seenRuns.add(current.id)
    hops += 1

    const verdicts = await store.listVerdictsByRun(current.id)
    steps.push({
      subjectId: current.subject.id,
      agentId: current.agentId,
      // 这个 run 产出的判决的结论原因 —— 即"它为什么要求下一步"
      reasonCode: verdicts[0]?.reasonCode ?? null,
    })

    const parent = await loadDerivingRun(store, current)
    current = parent
  }

  return steps.reverse()
}

/** 沿 `derivedFrom` 往回走一步；走不通就返回 null（链路到头）。 */
async function loadDerivingRun(store: Store, run: Run): Promise<Run | null> {
  if (!run.derivedFrom) return null
  const action = await store.getAction(run.derivedFrom)
  if (!action) return null
  const verdict = await store.getVerdict(action.verdictId)
  if (!verdict) return null
  return store.getRun(verdict.runId)
}

/**
 * 从链路推出应写入新 run 的 `chainDepth`。
 *
 * 根 run 的深度是 0，因此取 `steps.length - 1`——
 * 与 `Run.chainDepth` 在 schema 里的含义保持一致（`z.number().nonnegative()`）。
 */
export function depthFromChain(steps: readonly ChainStep[]): number {
  return Math.max(0, steps.length - 1)
}

/**
 * 把**刚产出的判决原因码**并进链路的最后一步。
 *
 * ══════════════════════════════════════════════════════════════════
 * 没有这一步，环检测就是死的
 * ══════════════════════════════════════════════════════════════════
 *
 * `loadChainSteps` 是在**判决落库之前**调用的（审核收口一开头就重建链路）。
 * 因此当前 run 那一步读到的 `reasonCode` 必然是 `null`——它的判决还没写下去。
 *
 * 于是比较就变成了 `(X, A, 'needs_fix')` vs `(X, A, null)`：
 * **永远不相等，环永远抓不到**。这是个很隐蔽的失败——所有代码看起来都正常，
 * 测试也不会报错，只有真的转起圈来才知道边界没生效。
 *
 * 而此刻原因码其实**已经知道**：就在刚解析出来的 verdict 里。
 * 把它并进去，链路上的每一步才都是"这个 agent 在这个对象上给出的判断"。
 *
 * 空链路时返回空——不要凭空造出一步。
 */
export function withCurrentVerdict(
  steps: readonly ChainStep[],
  reasonCode: string | null,
): ChainStep[] {
  if (steps.length === 0) return []
  const out = steps.map((s) => ({ ...s }))
  const last = out[out.length - 1]!
  last.reasonCode = reasonCode
  return out
}
