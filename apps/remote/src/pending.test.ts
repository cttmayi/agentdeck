import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { collectPending } from './pending.ts'
import { PluginStore } from './plugin-store.ts'

/**
 * 待处理项拉取（FR-REG-06/07/11）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 最关键的一条是"不暂存"
 * ══════════════════════════════════════════════════════════════════
 *
 * 需求方原话："不需要暂存，有需求的时候，远端重新调用端口去询问第3方"。
 * 而最容易破坏它的恰恰是**看起来像优化的那个动作**——顺手加个缓存。
 * 所以测试直接钉死：问两次，第三方必须被真的打到两次。
 */

const ACCOUNT = { id: 'acc_1', email: 'a@x.com', displayName: 'a' }

function plugin(name: string, query: unknown) {
  return {
    manifest: {
      apiVersion: 1,
      name,
      capability: 'third-party' as const,
      version: '1.0.0',
      scopes: ['thirdparty:query'],
    },
    enabled: true,
    error: null,
    impl: { query },
  }
}

describe('★ 待处理项：每次询问都真的打第三方（FR-REG-07）', () => {
  test('★ 问两次 ⇒ 第三方被真的调用两次，不做缓存', async () => {
    let calls = 0
    const store = new PluginStore(null)
    const plugins = [
      plugin('counter', async () => {
        calls += 1
        return { items: [{ externalId: `e${calls}`, kind: 'k', title: 't' }] }
      }),
    ]

    const first = await collectPending({ plugins, store, account: ACCOUNT })
    const second = await collectPending({ plugins, store, account: ACCOUNT })

    assert.equal(calls, 2, '★ 顺手加个缓存"看起来像优化"，但它正是这条需求要防的')
    assert.equal(first.items[0]?.externalId, 'e1')
    assert.equal(second.items[0]?.externalId, 'e2', '第二次拿到的是新数据，不是缓存')
  })

  test('账号身份被传给第三方（账号即凭证，D12）', async () => {
    let seen: unknown = null
    const store = new PluginStore(null)
    await collectPending({
      plugins: [plugin('who', async (p: unknown) => {
        seen = p
        return { items: [] }
      })],
      store,
      account: ACCOUNT,
    })
    assert.deepEqual((seen as { account: unknown }).account, ACCOUNT)
  })

  test('密钥在**进程内**传给插件，不经过任何 HTTP 响应', async () => {
    const store = new PluginStore(null)
    await store.setSecret('needs-key', 'apiKey', 'sk-secret')
    let got: string | null = null
    await collectPending({
      plugins: [plugin('needs-key', async (p: { secret: (k: string) => string | null }) => {
        got = p.secret('apiKey')
        return { items: [] }
      })],
      store,
      account: ACCOUNT,
    })
    assert.equal(got, 'sk-secret')
  })
})

describe('★ 一个第三方坏了不能拖垮整次轮询（FR-REG-11）', () => {
  test('★ 抛异常的插件被跳过，其余照常返回，且**原因带出去**', async () => {
    const store = new PluginStore(null)
    const result = await collectPending({
      plugins: [
        plugin('broken', async () => {
          throw new Error('第三方 503')
        }),
        plugin('fine', async () => ({ items: [{ externalId: 'ok', kind: 'k', title: '好的' }] })),
      ],
      store,
      account: ACCOUNT,
    })

    assert.equal(result.items.length, 1)
    assert.equal(result.items[0]?.externalId, 'ok')
    assert.equal(result.warnings.length, 1)
    assert.equal(result.warnings[0]?.plugin, 'broken')
    // ★ 只写日志等于静默丢弃——页面拿不到就发不出通知
    assert.match(result.warnings[0]?.reason ?? '', /503/)
  })

  test('★ 第三方不回话时有超时，轮询不会挂死', async () => {
    const store = new PluginStore(null)
    const started = Date.now()
    const result = await collectPending({
      plugins: [plugin('hang', () => new Promise(() => {}))], // 永远不 resolve
      store,
      account: ACCOUNT,
      timeoutMs: 60,
    })
    const elapsed = Date.now() - started

    assert.ok(elapsed < 2000, `不该挂死，实耗 ${elapsed}ms`)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0]?.reason ?? '', /没有响应/)
  })

  test('插件没实现 query 时给出可读警告，而不是崩掉', async () => {
    const store = new PluginStore(null)
    const result = await collectPending({
      plugins: [
        {
          manifest: {
            apiVersion: 1,
            name: 'empty',
            capability: 'third-party' as const,
            version: '1.0.0',
            scopes: [],
          },
          enabled: true,
          error: null,
          impl: {},
        },
      ],
      store,
      account: ACCOUNT,
    })
    assert.equal(result.warnings[0]?.reason, '插件没有实现 query')
  })
})

describe('★ 第三方返回不合法条目时拒绝，而不是编占位值', () => {
  test('★ 缺 title 的条目被拒绝，理由是"不能代填"', async () => {
    const store = new PluginStore(null)
    const result = await collectPending({
      plugins: [plugin('sloppy', async () => ({ items: [{ externalId: 'e', kind: 'k' }] }))],
      store,
      account: ACCOUNT,
    })
    assert.equal(result.items.length, 0)
    assert.match(result.warnings[0]?.reason ?? '', /title/)
    assert.match(
      result.warnings[0]?.reason ?? '',
      /不能由远端代填|无意义/,
      '要解释为什么不代填一个"未命名报告"',
    )
  })

  test('缺 body 是**合法的** —— 只给标题的报告有意义', async () => {
    const store = new PluginStore(null)
    const result = await collectPending({
      plugins: [plugin('ok', async () => ({ items: [{ externalId: 'e', kind: 'k', title: '只有标题' }] }))],
      store,
      account: ACCOUNT,
    })
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0]?.body, '')
    assert.deepEqual(result.warnings, [])
  })

  test('兼容裸数组返回', async () => {
    const store = new PluginStore(null)
    const result = await collectPending({
      plugins: [plugin('bare', async () => [{ externalId: 'e', kind: 'k', title: 't' }])],
      store,
      account: ACCOUNT,
    })
    assert.equal(result.items.length, 1)
  })

  test('返回非数组时是明确警告，不是空结果', async () => {
    const store = new PluginStore(null)
    const result = await collectPending({
      plugins: [plugin('weird', async () => ({ nope: true }))],
      store,
      account: ACCOUNT,
    })
    assert.match(result.warnings[0]?.reason ?? '', /items/)
  })

  test('queried 记录真的打到了哪些插件（印证"不暂存"）', async () => {
    const store = new PluginStore(null)
    const result = await collectPending({
      plugins: [
        plugin('a', async () => ({ items: [] })),
        plugin('b', async () => {
          throw new Error('x')
        }),
      ],
      store,
      account: ACCOUNT,
    })
    assert.deepEqual(result.queried, ['a', 'b'], '失败的也算打过——它确实被问了')
  })
})
