import {
  extractVerdictJson,
  formatVerdictIssues,
  parseVerdict,
  type ActionType,
  type Verdict,
  type VerdictIssue,
} from '@alpha-helper/protocol'
import { validateActionAllowed, validateActionRef } from '../actions/registry.ts'

/**
 * 审核流水线的决策逻辑（S2 / S1 的收口处）。
 *
 * ══════════════════════════════════════════════════════════════════
 * `invalid` 是本项目特有的一种失败
 * ══════════════════════════════════════════════════════════════════
 *
 * "模型没按格式输出"与"进程崩了"是**两件事**，正确应对完全相反：
 *
 *   进程崩了     → 重试有意义（可能是抖动）
 *   格式不合规   → 重试也许有意义，但**更常见的是标准本身没说清**，
 *                  继续重试只是烧 token
 *
 * 所以它必须有独立的判定与三条明确出口（retry / 降级 / 升级），
 * 而不是被 try/catch 兜住当成普通错误（FR-REVIEW-04/05）。
 */

export interface ReviewDecisionInput {
  /** agent 的原始输出（含围栏）。 */
  output: string
  /** 该 skill 允许触发的动作子集。 */
  allowedActions: readonly ActionType[]
  /** 这个 run 已经因 invalid 重试过几次。 */
  invalidAttempts: number
  /** 允许的 invalid 重试次数上限。 */
  maxInvalidRetries?: number
}

export type ReviewDecision =
  /** 判决有效且有动作 ⇒ 执行。 */
  | { kind: 'act'; verdict: Verdict }
  /** 判决有效但无动作（如 pass 且无后续）⇒ 只记录。 */
  | { kind: 'advisory'; verdict: Verdict }
  /** 判决要求人介入。 */
  | { kind: 'escalate'; escalateReason: string; verdict: Verdict }
  /** 判决不合规，且还可以重试。 */
  | { kind: 'retry'; issues: VerdictIssue[] }
  /** 判决不合规，重试次数用尽 ⇒ 降级为 advisory。 */
  | { kind: 'downgrade'; issues: VerdictIssue[] }
  /** 判决不合规且必须人介入（用于结构性缺失，重试无意义）。 */
  | { kind: 'invalid'; issues: VerdictIssue[] }

export const DEFAULT_MAX_INVALID_RETRIES = 1

export function decideReview(input: ReviewDecisionInput): ReviewDecision {
  const maxRetries = input.maxInvalidRetries ?? DEFAULT_MAX_INVALID_RETRIES

  const invalid = (issues: VerdictIssue[], retryable = true): ReviewDecision => {
    if (!retryable) return { kind: 'invalid', issues }
    // ══════════════════════════════════════════════════════════════════
    // ★ 结构性问题**重试无意义**，必须在这里就拦掉
    // ══════════════════════════════════════════════════════════════════
    //
    // 这个判断原本是**缺失的**：`isStructuralInvalid()` 早就写好并被文档
    // 描述成"用来区分重试有没有意义"，通知文案里甚至写着"这类问题重试不会
    // 变好"——但 `decideReview` **从来没有问过它**。
    //
    // 于是"动作不在 skill 允许的子集内"这类问题会被判成 retry，让模型
    // 再输出一次**同样的东西**，再失败一次，白烧一轮 token 与时间。
    //
    // 它之所以长期没被发现，是因为重试派发那一段当时是**坏的**
    // （服务端从未提供 `createRetryRun`），所有 retry 都会掉进
    // "拿不到重试机会 ⇒ 降级"的分支，于是这个缺陷被另一个缺陷掩盖了。
    // 把重试修好之后它立刻暴露出来——两个错误叠在一起看起来像对的。
    if (isStructuralInvalid(issues)) return { kind: 'invalid', issues }
    if (input.invalidAttempts < maxRetries) return { kind: 'retry', issues }
    return { kind: 'downgrade', issues }
  }

  // ── ① 抽取判决块 ──
  const json = extractVerdictJson(input.output)
  if (json === null) {
    // 结构性缺失：没有围栏块。重试有意义——模型可能只是这次忘了格式。
    return invalid([
      { path: [], message: '输出里没有找到判决块（缺少约定围栏标记）' },
    ])
  }

  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return invalid([{ path: [], message: '判决块里的内容不是合法 JSON' }])
  }

  // ── ② schema 校验（全局统一，闭合处必须真的闭合）──
  const parsed = parseVerdict(raw)
  if (!parsed.ok) {
    return invalid(parsed.issues)
  }
  const verdict = parsed.verdict

  // ── ③ 动作必须来自注册表，且在 skill 允许的子集内 ──
  if (verdict.action) {
    const known = validateActionRef(verdict.action)
    if (!known.ok) {
      return invalid(known.issues.map((message) => ({ path: ['action'], message })))
    }
    const allowed = validateActionAllowed(verdict.action, input.allowedActions)
    if (!allowed.ok) {
      return invalid(allowed.issues.map((message) => ({ path: ['action'], message })))
    }
  }

  // ── ④ 按结论分流 ──
  switch (verdict.conclusion) {
    case 'needs_human':
      // schema 已保证 escalateReason 非空
      return { kind: 'escalate', escalateReason: verdict.escalateReason ?? '需要人判断', verdict }
    case 'fail':
      // schema 已保证有 action；没有动作的 fail 在校验阶段就被拒了
      return verdict.action ? { kind: 'act', verdict } : { kind: 'advisory', verdict }
    case 'pass':
      return verdict.action ? { kind: 'act', verdict } : { kind: 'advisory', verdict }
  }
}

/** 给 UI 与通知用的一句话摘要。 */
export function describeDecision(decision: ReviewDecision): string {
  switch (decision.kind) {
    case 'act':
      return `判决：${decision.verdict.conclusion} → 执行 ${decision.verdict.action?.type ?? '(无)'}`
    case 'advisory':
      return `判决：${decision.verdict.conclusion}（仅记录，无动作）`
    case 'escalate':
      return `升级给人：${decision.escalateReason}`
    case 'retry':
      return `判决不合规，将重试：${formatVerdictIssues(decision.issues)}`
    case 'downgrade':
      return `判决不合规，降级为建议：${formatVerdictIssues(decision.issues)}`
    case 'invalid':
      return `判决不合规且需人介入：${formatVerdictIssues(decision.issues)}`
  }
}

/**
 * 判定 `invalid` 是否属于**结构性**问题。
 *
 * 结构性 = "重试几次都一样"，典型是模型引用了一个不存在（或该 skill 不允许）
 * 的动作。那不是模型发挥失常，而是**审核标准与动作注册表没对齐**——
 * 重试只会重复烧 token 并把同一条错误刷进日志。
 *
 * 反之，"这次忘了写围栏"或"JSON 写坏了"是暂时的，重试有意义。
 *
 * 注意动作相关的问题**有两种来源**：schema 层（`ActionType` 是闭合枚举，
 * 未知类型在校验 verdict 时就被拒）与注册表层（类型对但没注册、或不在
 * skill 子集内）。两处都要认出来，所以这里同时看**字段路径**与**消息内容**。
 */
/**
 * 这个问题是不是**重试也修不好**的结构性问题。
 *
 * ══════════════════════════════════════════════════════════════════
 * 判据是"模型再输出一次会不会不一样"，而不是"问题出现在哪个字段"
 * ══════════════════════════════════════════════════════════════════
 *
 * 这个区分很要紧，因为两类东西长得像、处置却相反（FR-RUN-07 的口径：
 * **只重试重试能修好的**）：
 *
 * | 情况 | 重试有用吗 | 为什么 |
 * |---|---|---|
 * | 动作类型不在注册表 | ✗ | 通常是 skill 里写的动作名与注册表不一致。模型照着 skill 再写一次，还是同一个名字 |
 * | 动作不在 skill 允许的子集内 | ✗ | 同上：那是**标准与注册表**对不上，是配置问题 |
 * | **动作参数不合法** | ✓ | 模型这次把 `status` 写成 `"bogus"`，下次完全可能写对。这是模型失误，不是配置问题 |
 * | 没有围栏块 / JSON 不合法 | ✓ | 典型的"这次忘了格式" |
 *
 * ⚠️ 这里**曾经把"参数不合法"也算成结构性**——因为最初为了兜住 schema 层的
 * 动作错误，加了一条宽泛的 `path[0] === 'action'`。那个路径前缀同时覆盖了
 * `action.params.*`，于是模型的一个手误被当成配置错误，**连重试机会都不给**。
 * 现在按路径是否进到 `params` 里把它分开。
 */
export function isStructuralInvalid(issues: readonly VerdictIssue[]): boolean {
  return issues.some((i) => {
    // ── 参数问题：**重试有意义**，不是结构性 ──
    //
    // 必须先判这一条。`validateActionRef` 把**所有**它的问题都挂在
    // `path: ['action']` 上（参数错误也是），所以路径分不出两者，
    // 而它给参数问题统一加了 `动作参数 ` 前缀——那是唯一可靠的判据。
    if (i.message.startsWith('动作参数')) return false

    // ── 明确的结构性信号 ──
    if (
      i.message.includes('未知动作类型') ||
      i.message.includes('动作注册表') ||
      i.message.includes('子集')
    ) {
      return true
    }
    // schema 层的动作错误（如 `action.type` 不在闭合枚举里）
    return i.path[0] === 'action'
  })
}
