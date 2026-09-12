import {
  actionIdempotencyKey,
  assertCanDeriveRun,
  detectChainCycle,
  getActionDefinition,
  validateActionRef,
  type ChainStep,
  type Store,
} from '@alpha-helper/domain'
import {
  ulid,
  type Action,
  type ActionRef,
  type Comment,
  type InboxItem,
  type InboxSeverity,
  type Issue,
  type RunId,
  type VerdictId,
  type WorkspaceId,
} from '@alpha-helper/protocol'

/**
 * 本地动作执行（FR-ACTION-01~08、INV-9~12）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条不能退让的规则
 * ══════════════════════════════════════════════════════════════════
 *
 * **① 默认自动执行**（INV-4）。这里没有"先等人批准"的分支——`awaiting_approval`
 *    是例外，且只能由 skill 显式声明。若默认要人点一下，人又变回了默认关卡。
 *
 * **② 幂等键必须含 verdictId**。同一判决重放要被去重（落 `skipped`），但
 *    **不同判决产生的相同动作不能被去重**——否则多视角审核里第二个 agent
 *    同样的真实发现会被静默吞掉。
 *
 * **③ 失败必须可见**（FR-ACTION-08）。动作失败不得静默：进 `failed` 状态
 *    并发通知。静默失败会让"判决执行了"这个前提变成假的。
 */

export interface Notifier {
  (item: Omit<InboxItem, 'id' | 'workspaceId' | 'read' | 'createdAt'> & {
    workspaceId: WorkspaceId
  }): Promise<void>
}

export interface ActionRunnerDeps {
  store: Store
  /**
   * 真正派生一个新 run（如 `issue.assign_agent`）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么是回调，而不是在动作里自己建 run
   * ══════════════════════════════════════════════════════════════════
   *
   * 建 run 需要执行器、agent 配置、技能求解、工作目录分配——这些都不是
   * 动作该知道的事。动作只负责"我产生了这么一条派生意图"，
   * **谁来建、建成什么样**由调用方决定。
   *
   * 返回 `null` 表示派生被边界拦下或环境不允许（例如 agent 没有技能）。
   */
  deriveRun?: (input: DeriveRunRequest) => Promise<string | null>
  now?: () => number
}

export interface DeriveRunRequest {
  workspaceId: WorkspaceId
  /** 派生自哪个动作。写进新 run 的 `derivedFrom`。 */
  fromActionId: string
  /** 动作的发起者（审核者）。用于 reviewer≠executor 判定与新 run 的 subject。 */
  requestedByRunId: RunId | null
  params: Record<string, unknown>
  /** 派生前的链路（根 → 当前），由调用方重建。 */
  chainSteps: readonly ChainStep[]
}

export interface ExecuteActionInput {
  ref: ActionRef
  workspaceId: WorkspaceId
  verdictId: VerdictId
  /** 关联的 run（审计与通知用）。 */
  runId: RunId | null
  /** 演练：只校验与记录，不产生副作用。 */
  dryRun?: boolean
  /**
   * 派生前的链路（根 → 当前）。
   *
   * 只有 `spawnsRun` 的动作才用得上；缺省视为"链路为空"，
   * 即允许派生一次。调用方**应当**传真实的链路，否则环检测形同虚设。
   */
  chainSteps?: readonly ChainStep[]
}

export interface ExecuteActionResult {
  action: Action
  /** 是否因为幂等键命中而跳过。 */
  skipped: boolean
  /** 动作派生出的新 run（如指派 agent）。 */
  spawnedRunId?: string
  /**
   * 派生被回路边界拦下的原因。
   *
   * 注意这**不是失败**：指派本身已经成功了。把它记成 `failed` 会让
   * "动作没做成"这个信号变脏——人分不清是环境坏了还是边界起作用了。
   */
  derivationBlocked?: { reason: 'cycle' | 'depth'; message: string }
}

export class ActionRunner {
  readonly #store: Store
  readonly #deriveRun: ((input: DeriveRunRequest) => Promise<string | null>) | undefined
  readonly #now: () => number

  constructor(deps: ActionRunnerDeps) {
    this.#store = deps.store
    this.#deriveRun = deps.deriveRun
    this.#now = deps.now ?? (() => Date.now())
  }

  async execute(input: ExecuteActionInput): Promise<ExecuteActionResult> {
    const now = this.#now()

    // ── ① 未声明即拒绝 ──
    const validation = validateActionRef(input.ref)
    if (!validation.ok) {
      throw new Error(`动作不合规：${validation.issues.join('；')}`)
    }
    const definition = getActionDefinition(input.ref.type)

    // ── ② 幂等：键含 verdictId ──
    const idempotencyKey = actionIdempotencyKey({
      verdictId: input.verdictId,
      type: input.ref.type,
      params: input.ref.params,
    })

    const existing = await this.#store.findActionByIdempotencyKey(idempotencyKey)
    if (existing) {
      // 已执行过 ⇒ 明确记 skipped，而不是"看起来又成功了一次"
      await this.#store.transitionAction(existing.id, 'proposed', 'skipped')
      return { action: { ...existing, status: 'skipped' }, skipped: true }
    }

    const action: Action = {
      id: ulid(now) as Action['id'],
      workspaceId: input.workspaceId,
      verdictId: input.verdictId,
      type: input.ref.type,
      plane: definition.plane,
      params: input.ref.params,
      status: 'proposed',
      idempotencyKey,
      dryRun: input.dryRun === true,
      result: null,
      error: null,
      rollbackRef: null,
      createdAt: now,
      finishedAt: null,
    }
    await this.#store.insertAction(action)

    // ── ③ 默认自动批准 ──
    await this.#store.transitionAction(action.id, 'proposed', 'auto_approved')

    if (input.dryRun) {
      await this.#store.transitionAction(action.id, 'auto_approved', 'executed', {
        result: { dryRun: true, wouldDo: definition.describe(input.ref.params) },
        finishedAt: this.#now(),
      })
      return { action: { ...action, status: 'executed' }, skipped: false }
    }

    await this.#store.transitionAction(action.id, 'auto_approved', 'executing')

    try {
      const outcome = await this.#dispatch(input, action)
      await this.#store.transitionAction(action.id, 'executing', 'executed', {
        result: outcome.result,
        finishedAt: this.#now(),
        ...(outcome.rollbackRef ? { rollbackRef: outcome.rollbackRef } : {}),
      })
      return {
        action: { ...action, status: 'executed', result: outcome.result },
        skipped: false,
        ...(outcome.spawnedRunId ? { spawnedRunId: outcome.spawnedRunId } : {}),
        ...(outcome.derivationBlocked ? { derivationBlocked: outcome.derivationBlocked } : {}),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.#store.transitionAction(action.id, 'executing', 'failed', {
        error: message,
        finishedAt: this.#now(),
      })

      // ★ 失败不得静默 —— 进通知中心
      await this.#notify({
        workspaceId: input.workspaceId,
        type: 'action.failed',
        severity: 'action_required',
        title: `动作失败：${definition.describe(input.ref.params)}`,
        body: message,
        issueId: typeof input.ref.params['issueId'] === 'string' ? (input.ref.params['issueId'] as Issue['id']) : null,
        runId: input.runId,
      })

      return { action: { ...action, status: 'failed', error: message }, skipped: false }
    }
  }

  /** 做出该判决的审核者（用于 reviewer≠executor）。 */
  async #requesterAgentId(runId: RunId | null): Promise<string | null> {
    if (!runId) return null
    const run = await this.#store.getRun(runId)
    return run ? (run.agentId as string) : null
  }

  /**
   * 派生前的回路边界检查（INV-14~16）。
   *
   * **不抛异常**，而是返回结构化结果——因为指派已经做完了，
   * 把它变成 `failed` 会让"动作没做成"这个信号失真。
   * 返回 null 表示可以派生。
   */
  #checkDerivationBoundary(
    input: ExecuteActionInput,
  ): { reason: 'cycle' | 'depth'; message: string } | null {
    const steps = input.chainSteps ?? []
    try {
      assertCanDeriveRun(steps)
      return null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 区分环与深度：两者的处置方式不同（环要改审核标准，深度要拆任务）
      const cycle = detectChainCycle(steps)
      return { reason: cycle ? 'cycle' : 'depth', message }
    }
  }

  async #notifyBoundary(
    input: ExecuteActionInput,
    blocked: { reason: 'cycle' | 'depth'; message: string },
  ): Promise<void> {
    await this.#notify({
      workspaceId: input.workspaceId,
      type: blocked.reason === 'cycle' ? 'chain.cycle_detected' : 'chain.depth_exceeded',
      severity: 'attention',
      title:
        blocked.reason === 'cycle'
          ? '检测到回路，已停止派生'
          : '链路深度超限，已停止派生',
      body:
        `${blocked.message}\n\n` +
        (blocked.reason === 'cycle'
          ? '同一个 agent 在同一个对象上重复给出了同样的判断。这通常意味着审核标准' +
            '要求的东西模型做不到，或者动作与标准之间接不上——需要改标准，而不是再跑一轮。'
          : '这条链路派生次数已达上限。建议把任务拆小，或人工确认后再继续。'),
      issueId:
        typeof input.ref.params['issueId'] === 'string'
          ? (input.ref.params['issueId'] as Issue['id'])
          : null,
      runId: input.runId,
    })
  }

  async #notify(
    item: Omit<InboxItem, 'id' | 'read' | 'createdAt'>,
  ): Promise<void> {
    const now = this.#now()
    await this.#store.appendInboxItem({
      ...item,
      id: ulid(now),
      read: false,
      createdAt: now,
    })
  }

  async #dispatch(
    input: ExecuteActionInput,
    action: Action,
  ): Promise<{
    result: Record<string, unknown>
    rollbackRef?: string
    spawnedRunId?: string
    derivationBlocked?: { reason: 'cycle' | 'depth'; message: string }
  }> {
    const store = this.#store
    const params = input.ref.params
    const now = this.#now()

    switch (action.type) {
      case 'comment.create': {
        const issueId = params['issueId'] as Comment['issueId']
        const body = params['body'] as string
        const id = ulid(now) as Comment['id']
        await store.insertComment({
          id,
          workspaceId: input.workspaceId,
          issueId,
          authorType: 'agent',
          authorId: 'alpha-helper',
          type: 'comment',
          content: body,
          createdAt: now,
        })
        // 可回滚：评论可以删
        return { result: { commentId: id }, rollbackRef: `comment:${id}` }
      }

      case 'issue.update_status': {
        const issueId = params['issueId'] as Issue['id']
        const issue = await store.getIssue(issueId)
        if (!issue) throw new Error(`issue 不存在：${issueId}`)
        const next = params['status'] as Issue['status']
        const ok = await store.transitionIssue(issueId, issue.status, next)
        if (!ok) throw new Error(`issue 状态已被他人改变，未能从 ${issue.status} 改为 ${next}`)
        return { result: { from: issue.status, to: next }, rollbackRef: `issue:${issueId}:${issue.status}` }
      }

      case 'issue.add_label': {
        const issueId = params['issueId'] as Issue['id']
        const label = params['label'] as string
        const issue = await store.getIssue(issueId)
        if (!issue) throw new Error(`issue 不存在：${issueId}`)
        if (issue.labels.includes(label)) {
          return { result: { label, alreadyPresent: true } }
        }
        const ok = await store.transitionIssue(issueId, issue.status, issue.status, {
          labels: [...issue.labels, label],
        })
        if (!ok) throw new Error(`打标签失败：${issueId}`)
        return { result: { label }, rollbackRef: `label:${issueId}:${label}` }
      }

      case 'issue.create': {
        const id = ulid(now) as Issue['id']
        const issue: Issue = {
          id,
          workspaceId: input.workspaceId,
          title: params['title'] as string,
          description: (params['description'] as string | undefined) ?? '',
          status: 'todo',
          priority: 'none',
          assignee: null,
          labels: [],
          createdAt: now,
          updatedAt: now,
        }
        await store.insertIssue(issue)
        return { result: { issueId: id }, rollbackRef: `issue:${id}` }
      }

      case 'issue.assign_agent': {
        const issueId = params['issueId'] as Issue['id']
        const agentId = params['agentId'] as string
        const issue = await store.getIssue(issueId)
        if (!issue) throw new Error(`issue 不存在：${issueId}`)

        // ── reviewer ≠ executor（INV-1~3） ──
        // 把 issue 指派给刚刚审完它的那个 agent，等于让它审自己。
        // 这是唯一能在这里拦住的地方：到了 run 里再拦就晚了。
        const requesterAgentId = await this.#requesterAgentId(input.runId)
        if (requesterAgentId && requesterAgentId === agentId) {
          throw new Error(
            `不能把 issue 指派给刚刚做出该判决的 agent（${agentId}）—— ` +
              `审核者与执行者必须是不同的 agent（INV-1）`,
          )
        }

        const ok = await store.transitionIssue(issueId, issue.status, issue.status, {
          assignee: { type: 'agent', id: agentId },
        })
        if (!ok) throw new Error(`指派失败：${issueId}`)

        // ★ 指派已经成功，接下来才谈派生。两者结果分开记，
        //    否则"边界拦下了"会被误读成"指派没做成"。
        const blocked = this.#checkDerivationBoundary(input)
        if (blocked) {
          await this.#notifyBoundary(input, blocked)
          return {
            result: { issueId, agentId, spawnedRunId: null, derivationBlocked: blocked.reason },
            rollbackRef: `assign:${issueId}`,
            derivationBlocked: blocked,
          }
        }

        if (!this.#deriveRun) {
          // 没有派生能力时如实记录：不编一个假 runId 出来。
          return {
            result: { issueId, agentId, spawnedRunId: null },
            rollbackRef: `assign:${issueId}`,
          }
        }

        const spawnedRunId = await this.#deriveRun({
          workspaceId: input.workspaceId,
          fromActionId: action.id,
          requestedByRunId: input.runId,
          params,
          chainSteps: input.chainSteps ?? [],
        })

        return {
          result: { issueId, agentId, spawnedRunId },
          rollbackRef: `assign:${issueId}`,
          ...(spawnedRunId ? { spawnedRunId } : {}),
        }
      }

      case 'notify.emit': {
        await this.#notify({
          workspaceId: input.workspaceId,
          type: 'action.notify',
          severity: (params['severity'] as InboxSeverity | undefined) ?? 'info',
          title: params['title'] as string,
          body: (params['body'] as string | undefined) ?? '',
          issueId: null,
          runId: input.runId,
        })
        // 通知发出去就收不回（注册表里标注了 irreversible）
        return { result: { delivered: true } }
      }
    }
  }
}
