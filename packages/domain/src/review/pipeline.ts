import {
  extractVerdictJson,
  formatVerdictIssues,
  parseVerdict,
  type ActionRefType,
  type Tool,
  type Verdict,
  type VerdictIssue,
} from '@alpha-helper/protocol'
import { validateActionAllowed } from '../actions/definition.ts'
import { validateActionRefWith } from '../actions/tool-actions.ts'

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
  /**
   * 这个**审核者**允许触发的动作（`<包 slug>.<动作名>`）。
   *
   * ⚠️ 措辞是"审核者"而不是"skill"：skill 不参与动作授权，白名单住在
   *    `Agent.allowedActions`（老数据回退到标准里那份）。
   */
  allowedActions: readonly ActionRefType[]
  /**
   * 这个工作区**已安装的工具包**（D40）。
   *
   * ★ **不给就什么都解析不出来**（D41：没有内置动作了）——判决里带动作就会被判
   *   "未知动作类型"（结构性 invalid）。这不是可选的优化：动作名是
   *   `<包 slug>.<动作名>`，而"这个包装没装、有没有声明这个动作"只有拿着包清单才知道。
   *
   * ⚠️ 这里**不校验绑定参数**（本函数是纯的、没有 run 的事实可依据）；绑定值
   *    由 daemon 侧执行前那一道 `ActionRunner` 收口（它手上才有 workdir 之类）。
   */
  tools?: readonly Tool[]
  /**
   * 使用者在界面上设好的固定参数（D43）：`动作名 → 参数名 → 值`。
   *
   * 校验判决里的动作时，这些参数名会被当成"模型不许写"——写了 ⇒ 结构性
   * invalid（不可重试）。执行时由 daemon 侧的 `ActionRunner` 注入真实值。
   *
   * ⚠️ 这里**只做"模型不许写固定参数"这一条**；固定值本身合不合规由写入口
   *    （保存 agent / 提交 run 时）校验过，这里不重复。
   */
  fixedParams?: Readonly<Record<ActionRefType, Readonly<Record<string, unknown>>>>
  /** 这个 run 已经因 invalid 重试过几次。 */
  invalidAttempts: number
  /** 允许的 invalid 重试次数上限。 */
  maxInvalidRetries?: number
  /**
   * 这条任务允许**返工**几次（D45）。
   *
   * 返工 = 审核判 `fail` ⇒ 把审核意见交回执行者重做。`0`（默认）表示不返工：
   * `fail` 直接交给人（看板「等待人处理」）。
   */
  maxReworks?: number
  /**
   * 这条任务**已经**返工过几次。
   *
   * ⚠️ 与 `invalidAttempts` 是两件事、两个计数：`invalid` 是"判决本身没按格式
   *   输出"（重试的是**审核者**），`rework` 是"判决说这活不行"（重做的是**执行者**）。
   *   混用一个计数会让"模型不会写 JSON"吃掉"活干得不行"的额度。
   */
  usedReworks?: number
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
  /**
   * 判决说"这活不行"（`fail`），且**还有返工额度** ⇒ 把审核意见交回执行者重做（D45）。
   *
   * 与 `retry` 的区别：`retry` 重试的是**审核者**（它没按格式输出），
   * `rework` 重做的是**执行者**（活本身不合格）。
   */
  | { kind: 'rework'; verdict: Verdict }
  /**
   * 判决说"这活不行"，但**返工额度已经用完**（或这条任务本来就没配）⇒ 交给人（D45）。
   *
   * ⚠️ 这是新语义下 `fail` 的重要出口：`fail` 不再带处置动作，平台自己已经
   *    无事可做，所以必须**明确进人的队列**，而不是静默停在"已审查"——那会让
   *    一条被否决的任务看起来像已经处理完了。
   */
  | { kind: 'rework_exhausted'; verdict: Verdict }

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

  // ── ③ 动作必须是**已安装工具包里声明过的**，且在这个审核者的行动权限里 ──
  if (verdict.action) {
    // ★ D41：动作只可能来自工具包，所以校验必须带工具清单；
    //   没给清单 ⇒ 什么都解析不出来（"未声明即拒绝"）。
    //   绑定参数在这一层**不校验**（本函数是纯的、没有 run 的事实可依据）——
    //   那一层由 daemon 侧执行前收口（`ActionRunner`）。
    const fixedForAction = input.fixedParams?.[verdict.action.type]
    const known = validateActionRefWith(verdict.action, {
      tools: input.tools ?? [],
      // D43：固定参数模型不许写——按"这次生效的那一份"（任务级覆盖优先）
      ...(fixedForAction ? { fixed: fixedForAction } : {}),
    })
    if (!known.ok) {
      return invalid(known.issues.map((message: string) => ({ path: ['action'], message })))
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
      // ★ D45：`fail` 的出口是**返工**（交回执行者重做），不是处置。
      //   schema 已保证它没有 action——所以这里不存在"要不要执行动作"的分支。
      //
      //   有没有额度是两件不同的事：
      //     有额度 ⇒ 派生一条返工 run（执行者带着审核意见重做）
      //     没额度 ⇒ 交给人（`rework_exhausted`），**不能静默停在"已审查"**
      return (input.usedReworks ?? 0) < (input.maxReworks ?? 0)
        ? { kind: 'rework', verdict }
        : { kind: 'rework_exhausted', verdict }
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
    case 'rework':
      return `判决：不通过（${decision.verdict.reasonCode}）→ 交回执行者返工`
    case 'rework_exhausted':
      return `判决：不通过（${decision.verdict.reasonCode}），返工次数已用完 → 交给人`
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
 * | 动作类型解析不出来（没装 / 包里没声明） | ✗ | 那是**配置**问题。模型再输出一次，还是同一个名字 |
 * | 动作不在这个审核者的行动权限里 | ✗ | 同上：那是**配置**问题（要去「行动权限」里勾上） |
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
