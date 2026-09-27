import type {
  AgentId,
  RunEvent,
  RunFailure,
  RunId,
  RunKind,
  RunMessage,
  RunResult,
  RunStatus,
  TokenUsage,
} from '@agentdeck/protocol'

/**
 * 进行中 run 的运行时状态（内存）+ SSE 订阅分发。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么 seq 由 daemon 自己分配，而不是用时间戳
 * ══════════════════════════════════════════════════════════════════
 *
 * 页面刷新后要能"接回来并补齐错过的消息"（FR-BRIDGE-04）。补齐的锚点必须
 * 单调且无歧义——时间戳做不到（同一毫秒多条、本地时钟可能回拨）。
 *
 * 所以每个 run 维护一条**单调递增的 seq**，`GET /events?since=N` 就是
 * "把 N 之后的都给我"。简单、可测、不依赖时钟。
 */

/** 不含 seq 的事件——seq 由 registry 统一分配。 */
export type RunEventInput =
  | { t: 'status'; status: RunStatus; at: number }
  | { t: 'message'; message: Omit<RunMessage, 'seq'> }
  | { t: 'progress'; summary: string; step: number; total: number }
  | { t: 'usage'; usage: TokenUsage }
  | {
      t: 'terminal'
      status: 'completed' | 'failed' | 'cancelled'
      result: RunResult | null
      error: RunFailure | null
    }

export type RunEventListener = (event: RunEvent) => void

export interface RunRuntime {
  runId: RunId
  kind: RunKind
  status: RunStatus
  agentId: AgentId
  workDir: string
  lastSeq: number
  startedAt: number
  /** 是否已请求取消。 */
  cancellationRequested: boolean
}

export class RunRegistry {
  readonly #runtimes = new Map<string, RunRuntime>()
  readonly #listeners = new Map<string, Set<RunEventListener>>()

  create(input: {
    runId: RunId
    kind: RunKind
    agentId: AgentId
    workDir: string
    startedAt: number
  }): RunRuntime {
    const runtime: RunRuntime = {
      runId: input.runId,
      kind: input.kind,
      agentId: input.agentId,
      workDir: input.workDir,
      // seq 从 0 开始；lastSeq = -1 表示"还没有任何事件"
      lastSeq: -1,
      status: 'dispatched',
      startedAt: input.startedAt,
      cancellationRequested: false,
    }
    this.#runtimes.set(input.runId, runtime)
    return runtime
  }

  get(runId: RunId): RunRuntime | undefined {
    return this.#runtimes.get(runId)
  }

  list(): RunRuntime[] {
    return [...this.#runtimes.values()]
  }

  /** 分配 seq 并广播。返回完整事件（便于顺手落盘）。 */
  emit(runId: RunId, input: RunEventInput): RunEvent | null {
    const runtime = this.#runtimes.get(runId)
    if (!runtime) return null

    const seq = runtime.lastSeq + 1
    const event = this.#materialize(input, seq)

    runtime.lastSeq = seq
    if (input.t === 'status') runtime.status = input.status

    for (const listener of this.#listeners.get(runId) ?? []) {
      try {
        listener(event)
      } catch {
        // 单个订阅者出错不能影响其他订阅者与执行本身
      }
    }
    return event
  }

  #materialize(input: RunEventInput, seq: number): RunEvent {
    switch (input.t) {
      case 'message':
        return { t: 'message', seq, message: { ...input.message, seq } }
      default:
        return { ...input, seq } as RunEvent
    }
  }

  subscribe(runId: RunId, listener: RunEventListener): () => void {
    const key = runId as string
    let set = this.#listeners.get(key)
    if (!set) {
      set = new Set()
      this.#listeners.set(key, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.#listeners.delete(key)
    }
  }

  /** 当前订阅者数量——测试与诊断用。 */
  subscriberCount(runId: RunId): number {
    return this.#listeners.get(runId as string)?.size ?? 0
  }

  /** 请求取消。幂等。 */
  requestCancellation(runId: RunId): boolean {
    const runtime = this.#runtimes.get(runId)
    if (!runtime) return false
    runtime.cancellationRequested = true
    return true
  }

  /** 终态后从内存移除（消息已经在 store 里）。 */
  remove(runId: RunId): void {
    this.#runtimes.delete(runId as string)
    this.#listeners.delete(runId as string)
  }

  get size(): number {
    return this.#runtimes.size
  }
}

/**
 * 把"从 since 之后的事件"从持久化的消息里重建。
 *
 * daemon 重启后内存 registry 是空的，但页面可能还开着并拿着旧的 seq。
 * 这时只能从 store 里回放消息——状态类事件（progress/usage/terminal）
 * 无法从消息重建，所以重启后的续传只保证**消息不丢**，终态由 `GET /runs/{id}`
 * 的 run 记录单独给出。这是有意的取舍：为状态类事件也做持久化会把日志
 * 膨胀一倍，而收益只是"刷新时少一次查询"。
 */
export function replayMessagesSince(
  messages: readonly RunMessage[],
  since: number,
): RunMessage[] {
  return messages.filter((m) => m.seq > since).sort((a, b) => a.seq - b.seq)
}
