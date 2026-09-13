import {
  buildAuditRecord,
  decideReview,
  describeDecision,
  isStructuralInvalid,
  withCurrentVerdict,
  type ReviewDecision,
  type ChainStep,
  type Store,
} from '@alpha-helper/domain'
import {
  formatVerdictIssues,
  ulid,
  type ActionType,
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
} from '@alpha-helper/protocol'
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
  now?: () => number
}

export interface ReviewHandlingInput {
  run: Run
  workspaceId: WorkspaceId
  /** agent 的原始输出。 */
  output: string
  /** 该 skill 允许触发的动作子集。 */
  allowedActions: readonly ActionType[]
  /** 已因 invalid 重试过几次。 */
  invalidAttempts: number
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
  /** 注入的上下文块哈希；没有注入时 null。 */
  contextBlockHash: string | null
  usage: TokenUsage | null | undefined
  /**
   * 判决所属的链路（根 → 当前 run）。
   *
   * 由调用方重建后传入。**不能在这里自己重建**：判决落库发生在动作之前，
   * 此刻链路还是"判决之前"的样子，而动作派生需要的是同一份快照。
   * 缺省为空链路——那意味着环检测无效，只保留深度兜底。
   */
  chainSteps?: readonly ChainStep[]
}

export interface ReviewHandlingResult {
  decision: ReviewDecision
  verdictId: string | null
  /** 已执行的动作 id。 */
  actionIds: string[]
  /** 派生出的新 run（重试或动作派生）。 */
  spawnedRunId: string | null
  /** 派生被回路边界拦下时的原因（指派本身可能已经成功）。 */
  derivationBlocked: { reason: 'cycle' | 'depth'; message: string } | null
}

export class ReviewCoordinator {
  readonly #store: Store
  readonly #actions: ActionRunner
  readonly #createRetryRun: ((run: Run) => Promise<string | null>) | undefined
  readonly #now: () => number

  constructor(deps: ReviewHandlingDeps) {
    this.#store = deps.store
    this.#actions = deps.actions
    this.#createRetryRun = deps.createRetryRun
    this.#now = deps.now ?? (() => Date.now())
  }

  async handle(input: ReviewHandlingInput): Promise<ReviewHandlingResult> {
    const decision = decideReview({
      output: input.output,
      allowedActions: input.allowedActions,
      invalidAttempts: input.invalidAttempts,
    })

    const verdictId = ulid(this.#now()) as VerdictRecord['id']
    const status = statusFor(decision)
    const record = this.#recordFrom(input, decision, verdictId, status)
    await this.#store.insertVerdict(record)

    let actionIds: string[] = []
    let spawnedRunId: string | null = null
    let derivationBlocked: { reason: 'cycle' | 'depth'; message: string } | null = null

    switch (decision.kind) {
      case 'act': {
        const result = await this.#actions.execute({
          ref: decision.verdict.action!,
          workspaceId: input.workspaceId,
          verdictId,
          runId: input.run.id,
          // ★ 把刚解析出的原因码并进链路最后一步。
          //   不并的话当前这一步的 reasonCode 恒为 null，环检测永远配不上。
          chainSteps: withCurrentVerdict(
            input.chainSteps ?? [],
            decision.verdict.reasonCode ?? null,
          ),
        })
        actionIds = [result.action.id]
        // ★ 动作派生出的 run 必须传出去 —— 它既是 UI 的"下一步在哪"，
        //    也是下一次环检测往里加的那一环。早先这里被显式丢弃过。
        if (result.spawnedRunId) spawnedRunId = result.spawnedRunId
        if (result.derivationBlocked) derivationBlocked = result.derivationBlocked
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
      contextBlockHash: input.contextBlockHash,
      verdictId,
      actionIds: [...actionIds] as AuditRecord['actionIds'],
      queuedAt: input.run.queuedAt,
      startedAt: input.run.startedAt,
      finishedAt: this.#now(),
      usage: input.usage,
    })
    await this.#store.appendAudit(audit)

    return { decision, verdictId, actionIds, spawnedRunId, derivationBlocked }
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
