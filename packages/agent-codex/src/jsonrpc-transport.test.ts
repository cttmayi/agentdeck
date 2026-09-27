import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  JsonRpcServerError,
  JsonRpcTransport,
  OVERLOAD_ERROR_CODE,
} from './jsonrpc-transport.ts'

/**
 * 帧层的测试：只测"帧"，不测业务。用一个内存"对讲机"——write 回调把帧收集
 * 起来，测试手工 push 服务端的响应/通知帧。真实协议形状（方法名、错误码）见
 * `codex-descriptor.ts` 与 `unverifiedFields()`。
 */

interface Harness {
  transport: JsonRpcTransport
  sent: unknown[]
  notifications: Array<{ method: string; params: unknown }>
  unparsable: string[]
  serverRequests: Array<{ id: number; method: string; params: unknown; respond: (r: unknown) => void }>
}

function makeHarness(opts: { maxRetries?: number; retryDelayMs?: number } = {}): Harness {
  const h: Harness = {
    sent: [],
    notifications: [],
    unparsable: [],
    serverRequests: [],
    transport: undefined as unknown as JsonRpcTransport,
  }
  h.transport = new JsonRpcTransport(
    {
      onNotification: (method, params) => h.notifications.push({ method, params }),
      onUnparsableLine: (line) => h.unparsable.push(line),
      onServerRequest: (id, method, params, respond) => h.serverRequests.push({ id, method, params, respond }),
      // exactOptionalPropertyTypes：显式 undefined 会把"没传"变成"传了 undefined"
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(opts.retryDelayMs !== undefined ? { retryDelayMs: opts.retryDelayMs } : {}),
    },
    (frame) => h.sent.push(frame),
  )
  return h
}

/** 从 harness 收到的帧里找第一帧并返回其 id（假定测试顺序发送）。 */
function firstId(h: Harness): number {
  const frame = h.sent[0] as { id?: number }
  assert.ok(typeof frame?.id === 'number', '第一帧应是带 id 的请求')
  return frame.id as number
}

describe('JsonRpcTransport（JSON-RPC 2.0 帧层）', () => {
  test('★ 请求 → 响应按 id 匹配并 resolve', async () => {
    const h = makeHarness()
    const p = h.transport.request('initialize', { clientInfo: { name: 'agentdeck' } })
    const id = firstId(h)
    h.transport.push(JSON.stringify({ id, result: { userAgent: 'codex/fake' } }))
    await assert.doesNotReject(p)
    assert.deepEqual(await p, { userAgent: 'codex/fake' })
  })

  test('★ 响应带 error → reject 成 JsonRpcServerError（保留 code 与 message）', async () => {
    const h = makeHarness()
    const p = h.transport.request('thread/resume', { threadId: 'thr_missing' })
    const id = firstId(h)
    h.transport.push(JSON.stringify({ id, error: { code: -32602, message: 'thread not found: thr_missing' } }))
    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof JsonRpcServerError)
      assert.equal((err as JsonRpcServerError).code, -32602)
      assert.match((err as JsonRpcServerError).message, /thread not found/)
      return true
    })
  })

  test('★ 无 id 的入站帧 → onNotification', () => {
    const h = makeHarness()
    h.transport.push(JSON.stringify({ method: 'item/completed', params: { item: { type: 'agentMessage' } } }))
    assert.equal(h.notifications.length, 1)
    assert.equal(h.notifications[0]!.method, 'item/completed')
  })

  test('★ server → client 的请求（带 id + method）→ onServerRequest，respond 回一帧', () => {
    const h = makeHarness()
    h.transport.push(
      JSON.stringify({ id: 200, method: 'item/commandExecution/requestApproval', params: { tool: 'command' } }),
    )
    assert.equal(h.serverRequests.length, 1)
    h.serverRequests[0]!.respond({ decision: 'decline' })
    assert.deepEqual(h.sent.at(-1), { id: 200, result: { decision: 'decline' } })
  })

  test('★ -32001 背压：重试后成功（maxRetries=2, 0 延迟）', async () => {
    let calls = 0
    const h = makeHarness({ maxRetries: 2, retryDelayMs: 0 })
    const p = h.transport.request('turn/start', {})
    const id = firstId(h)
    h.transport.push(JSON.stringify({ id, error: { code: OVERLOAD_ERROR_CODE, message: 'Server overloaded; retry later.' } }))
    calls++
    // 等服务端重发（第二次请求会落到 sent 里）
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(h.sent.length, 2, '第一次失败后应重发一次')
    const id2 = (h.sent[1] as { id: number }).id
    h.transport.push(JSON.stringify({ id: id2, result: { turn: { id: 'turn_1' } } }))
    const result = await p
    assert.deepEqual(result, { turn: { id: 'turn_1' } })
    assert.equal(calls, 1)
  })

  test('★ -32001 重试次数耗尽 → 仍 reject', async () => {
    const h = makeHarness({ maxRetries: 1, retryDelayMs: 0 })
    const p = h.transport.request('turn/start', {})
    const id = firstId(h)
    h.transport.push(JSON.stringify({ id, error: { code: OVERLOAD_ERROR_CODE, message: 'Server overloaded; retry later.' } }))
    await new Promise((r) => setTimeout(r, 10))
    const id2 = (h.sent[1] as { id: number }).id
    h.transport.push(JSON.stringify({ id: id2, error: { code: OVERLOAD_ERROR_CODE, message: 'Server overloaded; retry later.' } }))
    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof JsonRpcServerError)
      assert.equal((err as JsonRpcServerError).code, OVERLOAD_ERROR_CODE)
      return true
    })
  })

  test('★ 超时 → reject（普通 Error，不是 JsonRpcServerError）', async () => {
    const h = makeHarness()
    const p = h.transport.request('initialize', {}, { timeoutMs: 20 })
    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof Error && !(err instanceof JsonRpcServerError))
      assert.match(err.message, /超时/)
      return true
    })
  })

  test('★ 坏行 / 未知形状 → onUnparsableLine（不崩、不计入通知）', () => {
    const h = makeHarness()
    h.transport.push('这不是 JSON')
    h.transport.push('{"id": "字符串id", "method": "x"}') // id 必须是 number
    h.transport.push('42') // 非对象
    assert.equal(h.notifications.length, 0)
    assert.equal(h.unparsable.length, 3)
  })

  test('★ 未知 id 的响应 → 忽略（可能是已超时的请求）', async () => {
    const h = makeHarness()
    h.transport.push(JSON.stringify({ id: 999, result: { x: 1 } }))
    assert.equal(h.sent.length, 0)
    await new Promise((r) => setTimeout(r, 10))
  })
})
