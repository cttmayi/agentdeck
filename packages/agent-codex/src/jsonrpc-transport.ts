/**
 * JSON-RPC 2.0 传输层（stdio JSONL 帧层）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一层只管"帧"，不管"业务"
 * ══════════════════════════════════════════════════════════════════
 *
 * 只做四件事：把一行 JSON 变成入站帧并按形状路由（响应 / 通知 / server 请求）、
 * 发请求并等 id 匹配的响应、发通知、回应 server 的请求。thread 与 turn 的
 * 业务时序在 `codex-backend.ts`，通知→AgentMessage 的语义在 `stream-parser.ts`。
 * 分层是为了**可单独测试**：帧层用真实协议形状的 fixture 喂。
 *
 * ⚠️ app-server 的 JSON-RPC 略去了 `"jsonrpc":"2.0"` 头（v2 协议的 serde 配置）。
 *    本层不校验该字段——加了也不报错，缺了也没关系（[未验证]：真实 wire 形状
 *    见 `unverifiedFields()`）。
 */

/** app-server 背压错误码：「Server overloaded; retry later.」 */
export const OVERLOAD_ERROR_CODE = -32001

/** JSON-RPC 服务端返回的错误（响应里的 `error` 对象）。 */
export class JsonRpcServerError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'JsonRpcServerError'
    this.code = code
    this.data = data
  }
}

export interface JsonRpcTransportOptions {
  /** 无 id 的入站通知。 */
  onNotification: (method: string, params: unknown) => void
  /**
   * 解析失败 / 未知形状的行。宽容读取、计数与"是否升级为失败"交给后端
   * （与 NDJSON 解析器同一套纪律：解析器只如实记录，失败分级是策略问题）。
   */
  onUnparsableLine?: (line: string) => void
  /**
   * server → client 的**请求**（如审批 `item/commandExecution/requestApproval`）。
   *
   * ⚠️ 必须回应，否则服务端会一直等：JSON-RPC 里带 id 的入站帧就是一个必须
   *    回 `respond(id, result)` 的请求。不回应的后果是 turn 挂死——那正是
   *    最糟的静默形态。
   */
  onServerRequest?: (
    id: number,
    method: string,
    params: unknown,
    respond: (result: unknown) => void,
  ) => void
  /** -32001 背压的重试上限（缺省 3；测试可设 0 关闭）。 */
  maxRetries?: number
  /** 背压重试的起始延迟 ms，指数退避（缺省 250；测试可设 0）。 */
  retryDelayMs?: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class JsonRpcTransport {
  readonly #options: JsonRpcTransportOptions
  /** 把一帧写成一行 JSON 送到子进程 stdin。 */
  readonly #write: (frame: unknown) => void
  #nextId = 1
  #pending = new Map<number, PendingRequest>()

  constructor(options: JsonRpcTransportOptions, write: (frame: unknown) => void) {
    this.#options = options
    this.#write = write
  }

  /** 从 stdout 收到一行。 */
  push(line: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      this.#options.onUnparsableLine?.(line)
      return
    }
    this.#route(frame)
  }

  #route(frame: unknown): void {
    if (typeof frame !== 'object' || frame === null) {
      this.#options.onUnparsableLine?.(String(frame))
      return
    }
    const msg = frame as Record<string, unknown>

    if (msg['id'] !== undefined) {
      // 我们只发数字 id，也只认数字 id 的响应 / server 请求。
      // 带 id 但不是数字：不认识的形状（我们从不生成，也不回应）——按不可解析处理。
      if (typeof msg['id'] !== 'number') {
        this.#options.onUnparsableLine?.(JSON.stringify(frame))
        return
      }
      if (typeof msg['method'] === 'string') {
        // ★ server → client 的请求：必须回应（审批等）
        this.#options.onServerRequest?.(msg['id'], msg['method'], msg['params'], (result) => {
          this.respond(msg['id'] as number, result)
        })
        return
      }
      // 响应（回我们发过的请求）
      const pending = this.#pending.get(msg['id'])
      if (!pending) return // 已超时/未知 id：忽略
      this.#pending.delete(msg['id'])
      clearTimeout(pending.timer)
      if (msg['error'] !== undefined && msg['error'] !== null) {
        const errObj = msg['error'] as Record<string, unknown>
        pending.reject(
          new JsonRpcServerError(
            typeof errObj['code'] === 'number' ? errObj['code'] : 0,
            typeof errObj['message'] === 'string' ? errObj['message'] : 'JSON-RPC 错误',
            errObj['data'],
          ),
        )
      } else {
        pending.resolve(msg['result'])
      }
      return
    }

    if (typeof msg['method'] === 'string') {
      this.#options.onNotification(msg['method'], msg['params'])
      return
    }

    this.#options.onUnparsableLine?.(JSON.stringify(frame))
  }

  /**
   * 发请求并等响应。
   *
   * - `-32001`（背压）⇒ 指数退避重试（这是**文档化的可重试错误**）；
   * - 其他服务端错误 ⇒ 抛 `JsonRpcServerError`（业务性失败，后端转成 failed run）；
   * - 超时 ⇒ 抛普通 Error（后端视为 infra）。
   */
  async request<T>(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const maxRetries = this.#options.maxRetries ?? 3
    const retryDelayMs = this.#options.retryDelayMs ?? 250
    const timeoutMs = opts?.timeoutMs ?? 60_000
    let attempt = 0
    for (;;) {
      attempt += 1
      try {
        return (await this.#requestOnce(method, params, timeoutMs)) as T
      } catch (err) {
        const overload = err instanceof JsonRpcServerError && err.code === OVERLOAD_ERROR_CODE
        if (overload && attempt <= maxRetries) {
          await sleep(retryDelayMs * 2 ** (attempt - 1))
          continue
        }
        throw err
      }
    }
  }

  #requestOnce(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`JSON-RPC 请求 ${method}（id=${id}）超时（${timeoutMs}ms）——服务端没有响应`))
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: (v) => resolve(v),
        reject: (e) => reject(e),
        timer,
      })
      this.#write({ id, method, ...(params !== undefined ? { params } : {}) })
    })
  }

  /** 发通知（无 id，不需要响应）。 */
  notify(method: string, params?: unknown): void {
    this.#write({ method, ...(params !== undefined ? { params } : {}) })
  }

  /** 回应 server → client 的请求。 */
  respond(id: number, result: unknown): void {
    this.#write({ id, result })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
