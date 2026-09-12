import assert from 'node:assert/strict'
import { describe, test, before } from 'node:test'

/**
 * 页面同步逻辑（FR-REG-06/07/11/12/18、FR-RUNTIME-13、FR-AUTH-08/10）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里测的是**纯逻辑**那一半
 * ══════════════════════════════════════════════════════════════════
 *
 * `sync.js` 整体跑在浏览器里，但它最要紧的几条规则与 DOM 无关：
 * 设定怎么夹、队列怎么涨、上报包里**有没有正文**。这些都能在 Node 里
 * 用一个 localStorage 桩测掉——而它们恰好也是最容易悄悄写坏的部分。
 *
 * 尤其是"上报包里没有正文"这一条：它很容易在后续维护中被"顺手带上
 * prompt 方便排查"破坏，而那种改动的后果是**使用者的代码与密钥外泄**。
 */

// 最小 localStorage 桩：sync.js 只用到这三个方法
const store = new Map<string, string>()
before(() => {
  ;(globalThis as Record<string, unknown>)['localStorage'] = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
})

const sync = (await import('../public/sync.js')) as typeof import('../public/sync.js')

describe('★ 同步设定：坏值要夹住，不能照单全收', () => {
  test('缺省值', () => {
    const s = sync.readSyncSettings(null)
    assert.equal(s.pollIntervalMs, sync.DEFAULT_POLL_INTERVAL_MS)
    assert.equal(s.reportingEnabled, true, '上报默认开，但页面上必须明示上报什么')
  })

  test('★ 过小的间隔被夹到下限 —— 否则页面会把远端打爆', () => {
    const s = sync.readSyncSettings({ pollIntervalMs: 1 })
    assert.equal(s.pollIntervalMs, sync.MIN_POLL_INTERVAL_MS)
  })

  test('过大的间隔被夹到上限', () => {
    const s = sync.readSyncSettings({ pollIntervalMs: 999_999_999 })
    assert.equal(s.pollIntervalMs, sync.MAX_POLL_INTERVAL_MS)
  })

  test('非法值回落到默认，而不是抛错（设定是远端来的，坏值不该让页面起不来）', () => {
    assert.equal(sync.readSyncSettings({ pollIntervalMs: 'abc' }).pollIntervalMs, sync.DEFAULT_POLL_INTERVAL_MS)
    assert.equal(sync.readSyncSettings({ pollIntervalMs: null }).pollIntervalMs, sync.DEFAULT_POLL_INTERVAL_MS)
  })

  test('★ 只有显式 false 才关闭上报 —— 缺省与非法值都是开', () => {
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

  test('★ 超过上限时丢**最旧**的，而不是让队列无限涨', () => {
    sync.clearQueue()
    for (let i = 0; i < 600; i += 1) sync.enqueue([{ digest: `d${i}` }])
    const queue = sync.readQueue()
    assert.equal(queue.length, 500)
    // localStorage 有配额；撑爆的后果是**整个队列丢失**，比丢最旧的那些糟得多
    assert.equal(queue[queue.length - 1]?.digest, 'd599', '最新的必须在')
    sync.clearQueue()
  })
})

describe('★ 上报内容：结构上拿不到正文（FR-REG-14）', () => {
  const issues = [
    { id: 'i-1', status: 'done', updatedAt: 1700000000000, title: '很敏感的任务标题', description: '机密' },
  ]
  const runs = [
    { runId: 'r-1', status: 'completed', queuedAt: 1700000000000, output: '报告原文', prompt: '机密 prompt' },
  ]

  test('★ 记录里不含标题、描述、prompt、报告原文', () => {
    const records = sync.collectRecords(issues, runs)
    const text = JSON.stringify(records)
    for (const secret of ['很敏感的任务标题', '机密', '报告原文', '机密 prompt']) {
      assert.ok(
        !text.includes(secret),
        `★ 上报包里出现了「${secret}」——那很容易在"顺手带上方便排查"时被破坏，` +
          `而后果是使用者的代码与密钥外泄`,
      )
    }
  })

  test('保留的是摘要、状态与时间', () => {
    const records = sync.collectRecords(issues, runs)
    assert.ok(records.some((r) => r['kind'] === 'run'))
    assert.ok(records.some((r) => r['kind'] === 'action'))
    const run = records.find((r) => r['kind'] === 'run')
    assert.ok(run, '应当有一条 run 记录')
    assert.equal(run['conclusion'], 'completed')
    assert.match(String(run['digest']), /^djb2:/)
  })

  test('digest 是稳定摘要（同样的输入给同样的值，远端才能据此去重）', () => {
    const a = sync.collectRecords(issues, runs)
    const b = sync.collectRecords(issues, runs)
    assert.deepEqual(a, b)
  })
})
