import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'

/**
 * 页面同步逻辑（FR-REG-06/07/11/12/18、FR-RUNTIME-13、FR-AUTH-08/10）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里测的是**纯逻辑**那一半
 * ══════════════════════════════════════════════════════════════════
 *
 * `sync.ts` 整块跑在浏览器里，但它最要紧的几条规则与 DOM 无关：设定怎么夹、
 * 队列怎么涨、上报包里**有没有正文**。这些都能在 Node 里用一个 localStorage
 * 桩测掉——而它们恰好也是最容易悄悄写坏的部分。
 *
 * 尤其是"上报包里没有正文"：它很容易在后续维护中被"顺手带上 prompt 方便
 * 排查"破坏，而那种改动的后果是**使用者的代码与密钥外泄**。
 */

const store = new Map<string, string>()
before(() => {
  ;(globalThis as Record<string, unknown>)['localStorage'] = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
})

const sync = await import('./sync.ts')

describe('★ 同步设定：坏值要夹住，不能照单全收', () => {
  test('缺省值', () => {
    const s = sync.readSyncSettings(null)
    assert.equal(s.pollIntervalMs, sync.DEFAULT_POLL_INTERVAL_MS)
    assert.equal(s.reportingEnabled, true, '上报默认开，但页面上必须明示上报什么')
  })

  test('★ 过小的间隔被夹到下限 —— 否则页面会把远端打爆', () => {
    assert.equal(sync.readSyncSettings({ pollIntervalMs: 1 }).pollIntervalMs, sync.MIN_POLL_INTERVAL_MS)
  })

  test('过大的间隔被夹到上限', () => {
    assert.equal(
      sync.readSyncSettings({ pollIntervalMs: 999_999_999 }).pollIntervalMs,
      sync.MAX_POLL_INTERVAL_MS,
    )
  })

  test('★ 非法值与 null 回落到默认，而不是被 Number(null)=0 夹成 10 秒', () => {
    // Number(null) === 0，于是"没设过"会被夹到下限——轮询频率悄悄变成
    // 默认值的 6 倍。这是个很小的 JS 陷阱，后果是远端被莫名多打 6 倍请求。
    assert.equal(
      sync.readSyncSettings({ pollIntervalMs: null }).pollIntervalMs,
      sync.DEFAULT_POLL_INTERVAL_MS,
    )
    assert.equal(
      sync.readSyncSettings({ pollIntervalMs: 'abc' }).pollIntervalMs,
      sync.DEFAULT_POLL_INTERVAL_MS,
    )
    assert.equal(
      sync.readSyncSettings({ pollIntervalMs: '' }).pollIntervalMs,
      sync.DEFAULT_POLL_INTERVAL_MS,
    )
  })

  test('★ 只有显式 false 才关闭上报', () => {
    assert.equal(sync.readSyncSettings({ reportingEnabled: false }).reportingEnabled, false)
    assert.equal(sync.readSyncSettings({ reportingEnabled: 'no' }).reportingEnabled, true)
    assert.equal(sync.readSyncSettings({}).reportingEnabled, true)
  })
})

describe('★ 上报队列：失败要暂存，且不能无限涨', () => {
  test('入队与读出', () => {
    sync.clearQueue()
    sync.enqueue([{ kind: 'run', digest: 'a' }])
    sync.enqueue([{ kind: 'run', digest: 'b' }])
    assert.equal(sync.readQueue().length, 2)
    sync.clearQueue()
  })

  test('队列坏掉时读出空数组，而不是抛异常', () => {
    store.set('alpha-helper.report-queue', '{ 这不是 json')
    assert.deepEqual(sync.readQueue(), [])
    sync.clearQueue()
  })

  test('★ 超过上限时丢最旧的，而不是让队列无限涨', () => {
    // localStorage 有配额；撑爆的后果是**整个队列丢失**，比丢最旧的那些糟得多
    sync.clearQueue()
    for (let i = 0; i < 600; i += 1) sync.enqueue([{ digest: `d${i}` }])
    const queue = sync.readQueue() as Array<{ digest: string }>
    assert.equal(queue.length, 500)
    assert.equal(queue[queue.length - 1]?.digest, 'd599', '最新的必须在')
    sync.clearQueue()
  })
})

describe('★ 上报内容：结构上拿不到正文', () => {
  const issues = [
    { id: 'i-1', status: 'done', updatedAt: 1700000000000, title: '很敏感的任务标题', description: '机密' },
  ]
  const runs = [
    { runId: 'r-1', status: 'completed', queuedAt: 1700000000000, output: '报告原文', prompt: '机密 prompt' },
  ]

  test('★ 记录里不含标题、描述、prompt、报告原文', () => {
    // FR-REG-14 要求给项目方的部分尽量聚合、去内容化。最容易违反它的做法是
    // "反正都取了，顺手带上"——而 prompt 里可能有代码、密钥、业务信息。
    const text = JSON.stringify(sync.collectRecords(issues, runs))
    for (const secret of ['很敏感的任务标题', '机密', '报告原文', '机密 prompt']) {
      assert.ok(!text.includes(secret), `上报包里出现了「${secret}」`)
    }
  })

  test('保留的是摘要、状态与时间', () => {
    const records: Array<Record<string, unknown>> = sync.collectRecords(issues, runs)
    const run = records.find((r) => r['kind'] === 'run')
    assert.ok(run, '应当有一条 run 记录')
    assert.equal(run['conclusion'], 'completed')
    assert.match(String(run['digest']), /^djb2:/)
    assert.ok(records.some((r) => r['kind'] === 'action'))
  })

  test('digest 稳定（同样的输入给同样的值，远端才能据此去重）', () => {
    assert.deepEqual(sync.collectRecords(issues, runs), sync.collectRecords(issues, runs))
  })
})
