import {
  buildAuditRecord,
  decideReview,
  describeDecision,
  isStructuralInvalid,
  type ReviewDecision,
  type Store,
} from '@agentdeck/domain'
import {
  formatVerdictIssues,
  ulid,
  type ActionRefType,
  type Tool,
  type AuditRecord,
  type BlobRef,
  type InboxItem,
  type InboxSeverity,
  type Run,
  type SkillRef,
  type TokenUsage,
  type VerdictIssue,
  type VerdictRecord,
  type VerdictStatus,
  type WorkspaceId,
} from '@agentdeck/protocol'
import type { ActionRunner } from './actions.ts'

/**
 * 审核收口：把一个 review run 的产出变成判决、动作与审计（S1/S2 的落点）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 判决落库时的一个取舍
 * ══════════════════════════════════════════════════════════════════
 *
 * `VerdictRecord` 的 schema 要求 conclusion / reasonCode 等字段必填，
 * 但 `invalid` 的情况下我们**根本没有一个合法判决**。
 *
 * 处理方式是诚实降级：用 `conclusion = 'needs_human'` +
 * `reasonCode = 'internal_error'` 记录，并把具体问题写进 `escalateReason`。
 * 这样"这条判决不合规"在数据里是**看得出来的**，而不是伪装成一个正常判决。
 */

export interface ReviewHandlingDeps {
  store: Store
  actions: ActionRunner
  /**
   * 为一次判决不合规的重试创建新 run。
   *
   * 不返回则视为"不重试"，直接降级为建议。
   */
  createRetryRun?: (run: Run) => Promise<string | null>
  /**
   * 为一次**审核不通过**创建返工 run（D45）：把审核意见交回执行者重做。
   *
   * ⚠️ 与 `createRetryRun` 方向相反：`retry` 重做的是**审核者**（它没按格式
   *    输出判决），`rework` 重做的是**执行者**（活本身不合格）。
   *
   * 不返回则视为"没派出去" ⇒ 退化成交给人的那条路（`rework_exhausted`），
   * **不能让判决悬着**。
   */
  createReworkRun?: (run: Run, verdict: VerdictRecord) => Promise<string | null>
  now?: () => number
}

export interface ReviewHandlingInput {
  run: Run
  workspaceId: WorkspaceId
  /** agent 的原始输出。 */
  output: string
  /** 这个审核者允许触发的动作（内置裸名或第三方命名空间；skill 不参与授权）。 */
  allowedActions: readonly ActionRefType[]
  /**
   * 这个工作区**已安装的工具包**（D40）——透传给 `decideReview`，否则判决里的
   * 第三方动作会被判成"未知动作类型"。
   */
  tools?: readonly Tool[]
  /**
   * 使用者在界面上设好的固定参数（D43）：`动作名 → 参数名 → 值`。
   *
   * 两个落点：① `decideReview` 校验判决时，模型写了固定参数 ⇒ 结构性 invalid；
   * ② `ActionRunner.execute` 执行时把固定值注入最终参数（像绑定值一样，模型
   *    看不见的那一侧）。判据与 `allowedActions` 同一个：**字段在不在**——
   *    `run.actionParams ?? 审核者.actionParams`。
   */
  fixedParams?: Readonly<Record<ActionRefType, Readonly<Record<string, unknown>>>>
  /**
   * 审核者给哪些动作勾了「调试」（`Agent.debugActions`，2026-09）。
   *
   * 勾了的动作在 `act` 收口时**不跑脚本**，只记录动作与解析后的完整参数
   * （时间线显示「调试 · 未执行」）。判据与 `fixedParams` 同一个：**字段在
   * 不在**——读取处是 `agentForStandard?.debugActions ?? []`。
   */
  debugActions?: readonly ActionRefType[]
  /** 已因 invalid 重试过几次。 */
  invalidAttempts: number
  /** 这条任务允许返工几次（D45）；0/缺省 = 不返工，`fail` 直接交给人。 */
  maxReworks?: number
  /** 这条任务已经返工过几次（D45）。与 `invalidAttempts` 是两件事、两个计数。 */
  usedReworks?: number
  /** 审核对象快照（审计用）。 */
  inputBlobRefs: readonly BlobRef[]
  skillRefs: readonly SkillRef[]
  modelId: string | null
  promptHash: string | null
  /** 实际执行的命令行（原始；脱敏在 `buildAuditRecord` 里做）。 */
  argv: readonly string[]
  /** runtime 描述表的键——**由调用方给**，不在这里写死。 */
  runtimeDescriptorKey: string
  /** 探测到的 CLI 版本；读不到时 null。 */
  cliVersion: string | null
  usage: TokenUsage | null | undefined
  /**
   * ⚠️ 这里原来还有 `chainSteps`（判决所属的链路，根 → 当前 run）。
   *
   * 它是为**动作派生**服务的：`issue.assign_agent` 派生新 run 之前要判环与判
   * 深度，而"环"需要整条链路才认得出来。D41 把内置动作全部移除之后没有任何
   * 动作能派生 run（工具脚本没有平台 API），于是这份输入连同 daemon 侧的
   * `loadChainSteps` 调用一起删掉了。
   *
   * 域层的 `packages/domain/src/loop/*`（`loadChainSteps` / `detectChainCycle` /
   * `assertCanDeriveRun`）**保留**：它们不假设内置动作存在，仍是 INV-14~16 的
   * 实现，只是这个版本在 daemon 里没有调用点了。
   */
}

export interface ReviewHandlingResult {
  decision: ReviewDecision
  verdictId: string | null
  /** 已执行的动作 id。 */
  actionIds: string[]
  /**
   * 派生出的新 run。
   *
   * ⚠️ D41 之后**只剩一个来源**：判决不合规时的重试（`createRetryRun`）。
   *    原来还有"动作派生"那一支（`issue.assign_agent`），随内置动作一起没了。
   */
  spawnedRunId: string | null
  /**
   * 刚写下去的审计记录。
   *
   * ★ 回传它是为了让 run 日志能说一句"审计已记录（runtime…，promptHash…）"。
   *   审计是事后核对的依据，而使用者在此之前**完全不知道它存在**——
   *   界面里也没有入口。日志里报一句，至少让人知道去哪儿找证据。
   */
  audit: AuditRecord
}

export class ReviewCoordinator {
  readonly #store: Store
  readonly #actions: ActionRunner
  readonly #createRetryRun: ((run: Run) => Promise<string | null>) | undefined
  readonly #createReworkRun:
    | ((run: Run, verdict: VerdictRecord) => Promise<string | null>)
    | undefined
  readonly #now: () => number

  constructor(deps: ReviewHandlingDeps) {
    this.#store = deps.store
    this.#actions = deps.actions
    this.#createRetryRun = deps.createRetryRun
    this.#createReworkRun = deps.createReworkRun
    this.#now = deps.now ?? (() => Date.now())
  }

  async handle(input: ReviewHandlingInput): Promise<ReviewHandlingResult> {
    const decision = decideReview({
      output: input.output,
      allowedActions: input.allowedActions,
      invalidAttempts: input.invalidAttempts,
      // D40：已安装的工具包要一起给——不然判决里合法的第三方动作会被判成
      // "未知动作类型"，而那条是**结构性 invalid**（不可重试）。
      ...(input.tools ? { tools: input.tools } : {}),
      // D43：模型写了固定参数 ⇒ 结构性 invalid（不可重试）
      ...(input.fixedParams ? { fixedParams: input.fixedParams } : {}),
      // D45：`fail` ⇒ 返工。有没有额度决定它是"交回执行者"还是"交给人"。
      ...(input.maxReworks !== undefined ? { maxReworks: input.maxReworks } : {}),
      ...(input.usedReworks !== undefined ? { usedReworks: input.usedReworks } : {}),
    })

    const verdictId = ulid(this.#now()) as VerdictRecord['id']
    const status = statusFor(decision)
    const record = this.#recordFrom(input, decision, verdictId, status)
    await this.#store.insertVerdict(record)

    let actionIds: string[] = []
    let spawnedRunId: string | null = null

    switch (decision.kind) {
      case 'act': {
        const fixedForAction = input.fixedParams?.[decision.verdict.action!.type]
        const result = await this.#actions.execute({
          ref: decision.verdict.action!,
          workspaceId: input.workspaceId,
          verdictId,
          runId: input.run.id,
          // D43：固定参数在**执行这一档**注入（模型不许写，判决校验那层已经拦过）
          ...(fixedForAction ? { fixed: fixedForAction } : {}),
          // ★ 2026-09：审核者给这个动作勾了「调试」⇒ 不跑脚本，只记录动作与参数。
          //   判据与白名单同源（`debugActions ?? []`，见 `ReviewHandlingInput`）。
          debug: (input.debugActions ?? []).includes(decision.verdict.action!.type),
        })
        actionIds = [result.action.id]
        // ⚠️ 这里原来还会读 `result.spawnedRunId` / `result.derivationBlocked`
        //    （内置动作 `issue.assign_agent` 的产物：指派本身成功、派生可能被
        //    回路边界拦下）。D41 之后工具动作**不可能**派生 run，那两个字段
        //    连同它们的语义一起从 `ActionRunner` 的返回值里删掉了。
        await this.#store.transitionVerdict(verdictId, 'validated', 'dispatched_to_action')
        break
      }

      case 'advisory': {
        await this.#store.transitionVerdict(verdictId, 'validated', 'advisory')
        break
      }

      case 'escalate': {
        await this.#store.transitionVerdict(verdictId, 'validated', 'escalated')
        // 升级必须带结构化原因（INV-5）——这里的原因来自 verdict 的 escalateReason
        await this.#notify({
          workspaceId: input.workspaceId,
          type: 'verdict.escalated',
          severity: 'action_required',
          title: `需要你判断：${decision.escalateReason}`,
          body: this.#summarizeFindings(decision),
          issueId: issueIdOf(input.run),
          runId: input.run.id,
        })
        break
      }

      case 'rework': {
        // ══════════════════════════════════════════════════════════════
        // ★ D45：审核不通过 ⇒ 把意见交回**执行者**重做
        // ══════════════════════════════════════════════════════════════
        //
        // 与 `retry` 同一个教训：派出去之后**这条判决必须收口**。状态机允许
        // `validated → rework_requested`，而那是一个**终态**——"重做"是另一条
        // run、另一条 verdict 记录，这条判决的故事到此为止。
        //
        // 派不出去（拿不到额度/目录已被销毁之类）时**不能让它悬着**：退化成
        // 交给人的那条路，并说清为什么。
        const reworkRunId = this.#createReworkRun
          ? await this.#createReworkRun(input.run, record)
          : null
        if (reworkRunId) {
          spawnedRunId = reworkRunId
          await this.#store.transitionVerdict(verdictId, 'validated', 'rework_requested')
        } else {
          await this.#store.transitionVerdict(verdictId, 'validated', 'escalated')
          await this.#notify({
            workspaceId: input.workspaceId,
            type: 'verdict.escalated',
            severity: 'action_required',
            title: '审核不通过，但返工没有派出去',
            body: this.#summarizeFindings(decision),
            issueId: issueIdOf(input.run),
            runId: input.run.id,
          })
        }
        break
      }

      case 'rework_exhausted': {
        // 返工额度用完（或这条任务压根没配）⇒ **明确交给人**。
        //
        // ⚠️ 这里绝不能落成 `advisory`：那会让看板把一条**被否决**的任务显示成
        //    "已完成审查"。`fail` 在新语义下不带处置动作，平台确实无事可做——
        //    正因为如此，它必须进人的队列。
        await this.#store.transitionVerdict(verdictId, 'validated', 'escalated')
        await this.#notify({
          workspaceId: input.workspaceId,
          type: 'verdict.escalated',
          severity: 'action_required',
          title:
            (input.maxReworks ?? 0) > 0
              ? `审核不通过且返工次数已用完（${input.maxReworks} 次）`
              : '审核不通过（这条任务没有配返工）',
          body: this.#summarizeFindings(decision),
          issueId: issueIdOf(input.run),
          runId: input.run.id,
        })
        break
      }

      case 'retry': {
        await this.#store.transitionVerdict(verdictId, 'invalid', 'pending_verdict', {
          invalidResolution: 'retry',
        })
        const retryRunId = this.#createRetryRun ? await this.#createRetryRun(input.run) : null
        if (retryRunId) {
          spawnedRunId = retryRunId
          // ══════════════════════════════════════════════════════════
          // 重试已派出去之后，**这一条 verdict 必须收口**
          // ══════════════════════════════════════════════════════════
          //
          // 状态机允许 `invalid → pending_verdict`，字面意思是"等一个新判决"。
          // 但重试是一条**新的 run**，它产出的是**另一条 verdict 记录**
          // （`#handleReview` 每次都新分配 id）。于是如果就这么留在
          // `pending_verdict`，这条记录会**永远停在一个非终态上，而没有任何
          // 东西会来推进它**——数据里写着"正在等"，实际上没人在等。
          //
          // 这类"看起来在进行、其实已经结束"的状态比一个明确的终态糟得多：
          // 看板会一直显示它、统计会把它算成在途、排查的人会去等一个不会来的东西。
          //
          // 所以派发成功后立刻收口为 `invalid`，并用 `invalidResolution: 'retry'`
          // 记下**当初的处置是重试**。历史完整（这条判决不合规 + 我们发了重试），
          // 状态终态（不会被误算成在途），重试那条 run 有自己的记录与故事。
          await this.#store.transitionVerdict(verdictId, 'pending_verdict', 'invalid', {
            invalidResolution: 'retry',
          })
        } else {
          // 拿不到重试机会 ⇒ 降级，不能让它悬着
          await this.#store.transitionVerdict(verdictId, 'pending_verdict', 'invalid', {
            invalidResolution: 'downgrade_to_advisory',
          })
          await this.#notifyInvalid(input, decision.issues, 'attention')
        }
        break
      }

      case 'downgrade': {
        await this.#store.transitionVerdict(verdictId, 'invalid', 'advisory', {
          invalidResolution: 'downgrade_to_advisory',
        })
        await this.#notifyInvalid(input, decision.issues, 'attention')
        break
      }

      case 'invalid': {
        await this.#store.transitionVerdict(verdictId, 'invalid', 'escalated', {
          invalidResolution: 'escalate',
        })
        await this.#notifyInvalid(input, decision.issues, 'action_required')
        break
      }
    }

    // 审计：无论走哪条路都要留痕（FR-AUDIT-01）
    const audit: AuditRecord = buildAuditRecord({
      workspaceId: input.workspaceId,
      runId: input.run.id,
      subject: input.run.subject,
      inputBlobRefs: input.inputBlobRefs,
      skillRefs: input.skillRefs,
      // ⚠️ 这四项原来全是写死的常量（`'claude'` / `null` / `null`）。
      //    审计是事后唯一的依据，那里写死的值等于**说错话**：
      //    换一个 runtime，审计仍然声称用的是 claude。
      runtimeDescriptorKey: input.runtimeDescriptorKey,
      cliVersion: input.cliVersion,
      modelId: input.modelId,
      promptHash: input.promptHash,
      argv: input.argv,
      verdictId,
      actionIds: [...actionIds] as AuditRecord['actionIds'],
      queuedAt: input.run.queuedAt,
      startedAt: input.run.startedAt,
      finishedAt: this.#now(),
      usage: input.usage,
    })
    await this.#store.appendAudit(audit)

    return { decision, verdictId, actionIds, spawnedRunId, audit }
  }

  #recordFrom(
    input: ReviewHandlingInput,
    decision: ReviewDecision,
    id: VerdictRecord['id'],
    status: VerdictStatus,
  ): VerdictRecord {
    const valid = 'verdict' in decision ? decision.verdict : null

    return {
      id,
      workspaceId: input.workspaceId,
      runId: input.run.id,
      subject: input.run.subject,
      status,
      // 不合格判决**不伪装成正常判决**：明确标成需要人介入 + internal_error
      conclusion: valid?.conclusion ?? 'needs_human',
      reasonCode: valid?.reasonCode ?? 'internal_error',
      confidence: valid?.confidence ?? 0,
      findings: valid?.findings ?? [],
      action: valid?.action ?? null,
      escalateReason:
        valid?.escalateReason ??
        (decision.kind === 'retry' ||
        decision.kind === 'downgrade' ||
        decision.kind === 'invalid'
          ? formatVerdictIssues(decision.issues)
          : null),
      invalidResolution: null,
      skillRefs: input.skillRefs.map((s) => ({ ...s })),
      modelId: input.modelId,
      promptHash: input.promptHash,
      createdAt: this.#now(),
    }
  }

  #summarizeFindings(decision: ReviewDecision): string {
    if (!('verdict' in decision)) return ''
    const findings = decision.verdict.findings
    if (findings.length === 0) return '（没有具体发现项）'
    return findings
      .map((f) => `- [${f.severity}] ${f.summary}`)
      .join('\n')
      .slice(0, 4000)
  }

  async #notify(
    item: Omit<InboxItem, 'id' | 'read' | 'createdAt'>,
  ): Promise<void> {
    const now = this.#now()
    await this.#store.appendInboxItem({ ...item, id: ulid(now), read: false, createdAt: now })
  }

  async #notifyInvalid(
    input: ReviewHandlingInput,
    issues: readonly VerdictIssue[],
    severity: InboxSeverity,
  ): Promise<void> {
    const structural = isStructuralInvalid(issues)
    await this.#notify({
      workspaceId: input.workspaceId,
      type: 'verdict.invalid',
      severity,
      title: structural
        ? '判决引用了不可用的动作 —— 需要检查审核标准与动作注册表'
        : '这次审核没有产出合规的判决',
      body:
        `${formatVerdictIssues(issues)}\n\n` +
        (structural
          ? '这类问题重试不会变好：通常是 skill 里写的动作名与注册表不一致。'
          : '可能是模型这次没按格式输出；重试有机会成功。'),
      issueId: issueIdOf(input.run),
      runId: input.run.id,
    })
  }
}

function statusFor(decision: ReviewDecision): VerdictStatus {
  switch (decision.kind) {
    case 'act':
      return 'validated'
    case 'advisory':
      return 'validated'
    case 'escalate':
      return 'validated'
    // D45：`fail` 的两种去向都**先落 `validated`**（判决本身是合格的），随后由
    // 分流转到 `rework_requested`（有额度）或 `escalated`（没额度、交给人）。
    case 'rework':
      return 'validated'
    case 'rework_exhausted':
      return 'validated'
    case 'retry':
      return 'invalid'
    case 'downgrade':
      return 'invalid'
    case 'invalid':
      return 'invalid'
  }
}

export { describeDecision }

/** 只有 subject 是 issue 时才带 issueId —— 其余情况为 null。 */
function issueIdOf(run: Run): InboxItem['issueId'] {
  return run.subject.type === 'issue' ? (run.subject.id as InboxItem['issueId']) : null
}
