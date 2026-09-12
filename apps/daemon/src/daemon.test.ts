import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { isAllowedHost } from './server.ts'
import { RunRegistry, replayMessagesSince } from './registry.ts'
import { Semaphore } from './semaphore.ts'
import { WorkDirLocks } from './workdir-locks.ts'
import { parseCliArgs, DEFAULT_PORT } from './cli.ts'
import type { RunId, RunMessage } from '@alpha-helper/protocol'

const addr = (port: number): AddressInfo => ({
  address: '127.0.0.1',
  family: 'IPv4',
  port,
})

describe('Host 校验（FR-BRIDGE-10 —— 防 DNS rebinding）', () => {
  test('接受回环 Host', () => {
    assert.equal(isAllowedHost('127.0.0.1:4517', addr(4517)), true)
    assert.equal(isAllowedHost('localhost:4517', addr(4517)), true)
    assert.equal(isAllowedHost('[::1]:4517', addr(4517)), true)
  })

  test('★ 拒绝外部域名 —— 攻击者能让域名解析到 127.0.0.1，但改不了 Host', () => {
    assert.equal(isAllowedHost('evil.example.com', addr(4517)), false)
    assert.equal(isAllowedHost('evil.example.com:4517', addr(4517)), false)
  })

  test('★ 拒绝端口不匹配 —— 同机别的服务不能冒充', () => {
    assert.equal(isAllowedHost('127.0.0.1:9999', addr(4517)), false)
  })

  test('没有 Host 头时拒绝', () => {
    assert.equal(isAllowedHost('', addr(4517)), false)
  })

  test('不带端口的回环 Host 也接受（同源请求可能省略）', () => {
    assert.equal(isAllowedHost('127.0.0.1', addr(4517)), true)
  })
})

describe('RunRegistry —— seq 单调与订阅分发', () => {
  const rid = 'run-1' as RunId

  test('seq 从 0 开始单调递增', () => {
    const r = new RunRegistry()
    r.create({ runId: rid, kind: 'execute', agentId: 'a' as never, workDir: '/x', startedAt: 1 })
    assert.equal(r.get(rid)?.lastSeq, -1, '还没有事件时 lastSeq = -1')

    const e0 = r.emit(rid, { t: 'status', status: 'running', at: 1 })
    const e1 = r.emit(rid, { t: 'status', status: 'completed', at: 2 })
    assert.equal(e0?.seq, 0)
    assert.equal(e1?.seq, 1)
    assert.equal(r.get(rid)?.status, 'completed')
  })

  test('消息事件同时携带消息级 seq（与事件 seq 一致）', () => {
    const r = new RunRegistry()
    r.create({ runId: rid, kind: 'execute', agentId: 'a' as never, workDir: '/x', startedAt: 1 })
    const event = r.emit(rid, {
      t: 'message',
      message: { type: 'text', tool: null, content: 'hi', input: null, output: null, outputTruncated: false, at: 1 },
    })
    assert.equal(event?.t, 'message')
    if (event?.t !== 'message') return
    assert.equal(event.seq, 0)
    assert.equal(event.message.seq, 0, '消息 seq 必须与事件 seq 对齐，页面才能用同一个游标')
  })

  test('订阅者收到事件；取消订阅后不再收到', () => {
    const r = new RunRegistry()
    r.create({ runId: rid, kind: 'execute', agentId: 'a' as never, workDir: '/x', startedAt: 1 })

    const seen: number[] = []
    const unsubscribe = r.subscribe(rid, (e) => seen.push(e.seq))
    r.emit(rid, { t: 'status', status: 'running', at: 1 })
    unsubscribe()
    r.emit(rid, { t: 'status', status: 'completed', at: 2 })

    assert.deepEqual(seen, [0])
    assert.equal(r.subscriberCount(rid), 0)
  })

  test('★ 单个订阅者抛错不影响其他订阅者与执行本身', () => {
    const r = new RunRegistry()
    r.create({ runId: rid, kind: 'execute', agentId: 'a' as never, workDir: '/x', startedAt: 1 })

    const seen: number[] = []
    r.subscribe(rid, () => {
      throw new Error('订阅者坏了')
    })
    r.subscribe(rid, (e) => seen.push(e.seq))

    assert.doesNotThrow(() => r.emit(rid, { t: 'status', status: 'running', at: 1 }))
    assert.deepEqual(seen, [0])
  })

  test('对不存在的 run 发事件返回 null', () => {
    const r = new RunRegistry()
    assert.equal(r.emit('ghost' as RunId, { t: 'status', status: 'running', at: 1 }), null)
  })

  test('请求取消是幂等的', () => {
    const r = new RunRegistry()
    r.create({ runId: rid, kind: 'execute', agentId: 'a' as never, workDir: '/x', startedAt: 1 })
    assert.equal(r.requestCancellation(rid), true)
    assert.equal(r.requestCancellation(rid), true)
    assert.equal(r.get(rid)?.cancellationRequested, true)
  })
})

describe('消息补齐（FR-BRIDGE-04/18）', () => {
  const msg = (seq: number): RunMessage => ({
    seq,
    type: 'text',
    tool: null,
    content: `m${seq}`,
    input: null,
    output: null,
    outputTruncated: false,
    at: 1000, // 刻意同一时间戳：补齐必须靠 seq
  })

  test('只返回 since 之后的消息，且按 seq 升序', () => {
    const all = [msg(0), msg(1), msg(2), msg(3)]
    assert.deepEqual(
      replayMessagesSince(all, 1).map((m) => m.seq),
      [2, 3],
    )
    assert.deepEqual(
      replayMessagesSince(all, -1).map((m) => m.seq),
      [0, 1, 2, 3],
    )
    assert.deepEqual(replayMessagesSince(all, 3), [])
  })

  test('乱序输入也能排出正确顺序', () => {
    const shuffled = [msg(2), msg(0), msg(3), msg(1)]
    assert.deepEqual(
      replayMessagesSince(shuffled, 0).map((m) => m.seq),
      [1, 2, 3],
    )
  })
})

describe('并发槽位（FR-RUNTIME-04 —— 先占槽再执行）', () => {
  test('取满后拒绝', () => {
    const s = new Semaphore(2)
    assert.equal(s.tryAcquire(), true)
    assert.equal(s.tryAcquire(), true)
    assert.equal(s.tryAcquire(), false, '取不到槽位必须能拒绝，而不是排队堆积')
    assert.equal(s.available, 0)
  })

  test('释放后可再取', () => {
    const s = new Semaphore(1)
    s.tryAcquire()
    s.release()
    assert.equal(s.tryAcquire(), true)
  })

  test('多余的释放不会把计数变负', () => {
    const s = new Semaphore(1)
    s.release()
    s.release()
    assert.equal(s.inUse, 0)
    assert.equal(s.available, 1)
  })

  test('上限必须 >= 1', () => {
    assert.throws(() => new Semaphore(0))
  })
})

describe('工作目录锁（D20 —— 同目录串行化）', () => {
  const a = 'run-a' as RunId
  const b = 'run-b' as RunId

  test('无人占用时立刻拿到', () => {
    const l = new WorkDirLocks()
    assert.equal(l.acquire('/repo', a).acquired, true)
    assert.equal(l.holderOf('/repo'), a)
  })

  test('★ 已占用时排队而不是失败', () => {
    const l = new WorkDirLocks()
    l.acquire('/repo', a)
    const second = l.acquire('/repo', b)
    assert.equal(second.acquired, false, '应排队')
    assert.notEqual(second.waiting, undefined)
    assert.equal(l.waitingCount('/repo'), 1)
  })

  test('★ 释放时直接移交给队首（不留空窗）', async () => {
    const l = new WorkDirLocks()
    l.acquire('/repo', a)
    const second = l.acquire('/repo', b)

    l.release('/repo', a)
    await second.waiting

    assert.equal(l.holderOf('/repo'), b, '应移交给排队者，而不是变成空闲')
    assert.equal(l.waitingCount('/repo'), 0)
  })

  test('FIFO：多个排队者按顺序拿到', async () => {
    const l = new WorkDirLocks()
    const c = 'run-c' as RunId
    l.acquire('/repo', a)
    const second = l.acquire('/repo', b)
    const third = l.acquire('/repo', c)

    l.release('/repo', a)
    await second.waiting
    assert.equal(l.holderOf('/repo'), b)

    l.release('/repo', b)
    await third.waiting
    assert.equal(l.holderOf('/repo'), c)
  })

  test('取消排队者后不再被移交', () => {
    const l = new WorkDirLocks()
    l.acquire('/repo', a)
    l.acquire('/repo', b)
    assert.equal(l.cancelWaiting('/repo', b), true)
    assert.equal(l.waitingCount('/repo'), 0)

    l.release('/repo', a)
    assert.equal(l.holderOf('/repo'), undefined)
  })

  test('非持有者释放无效（不能让无关的 run 解锁）', () => {
    const l = new WorkDirLocks()
    l.acquire('/repo', a)
    l.release('/repo', b)
    assert.equal(l.holderOf('/repo'), a)
  })

  test('重复获取是幂等的，不会把自己排到队里', () => {
    const l = new WorkDirLocks()
    l.acquire('/repo', a)
    assert.equal(l.acquire('/repo', a).acquired, true)
    assert.equal(l.waitingCount('/repo'), 0)
  })

  test('不同目录互不影响', () => {
    const l = new WorkDirLocks()
    assert.equal(l.acquire('/repo1', a).acquired, true)
    assert.equal(l.acquire('/repo2', b).acquired, true)
  })
})

describe('CLI 参数', () => {
  test('默认端口是固定的（FR-BRIDGE-14）', () => {
    assert.equal(parseCliArgs([]).port, DEFAULT_PORT)
  })

  test('可覆盖端口与数据目录', () => {
    const o = parseCliArgs(['--port', '8080', '--data-dir', '/tmp/d'])
    assert.equal(o.port, 8080)
    assert.equal(o.dataDir, '/tmp/d')
  })

  test('非法端口被拒（而不是静默用默认值）', () => {
    assert.throws(() => parseCliArgs(['--port', 'abc']), /端口不合法/)
    assert.throws(() => parseCliArgs(['--port', '99999']), /端口不合法/)
  })

  test('--no-open 关闭自动打开浏览器', () => {
    assert.equal(parseCliArgs(['--no-open']).open, false)
    assert.equal(parseCliArgs([]).open, true)
  })
})
