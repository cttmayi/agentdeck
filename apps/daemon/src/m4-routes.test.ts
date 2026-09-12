import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { verifyAuditExport } from '@alpha-helper/domain'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * M4 的两个只读接口。
 *
 * ══════════════════════════════════════════════════════════════════
 * 接口很薄，但"薄"不等于不用测
 * ══════════════════════════════════════════════════════════════════
 *
 * 底下的 `exportAudit` / `aggregateCost` 已经在 `reporting.test.ts` 里
 * 走真实存储测过了。这里要钉住的是**接线**：
 *
 *   - 导出是不是真的带上下载头（它是给人存下来的文件，不是内联渲染的 JSON）；
 *   - `?runId=` 这个参数有没有被真的用上；
 *   - 两个接口是不是都**只读**。
 *
 * 接线错了单测是不会发现的——两边各自都对，凑起来不通。
 */

async function withDaemon<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir('m4-routes')
  const d = await startDaemon({
    dataDir: dir,
    port: 0,
    fsync: false,
    backend: {
      key: 'claude',
      protocol: 'stream-json',
      rejectDetectable: true,
      async probe() {
        return { available: false, command: 'claude', cliVersion: null }
      },
      async execute() {
        throw new Error('这个测试不该执行任何 run')
      },
    } as never,
    onWarn: () => {},
    onInfo: () => {},
  })
  try {
    return await fn(d.url)
  } finally {
    await d.close()
    await cleanup(dir)
  }
}

describe('M4 只读接口', () => {
  test('GET /api/costs 返回聚合结果，且总数与明细一致', async () => {
    await withDaemon(async (url) => {
      const res = await fetch(`${url}/api/costs`)
      assert.equal(res.status, 200)
      const body = (await res.json()) as {
        total: { key: string; runs: number; costUsdMicros: number }
        byAgent: unknown[]
        byKind: unknown[]
        runsWithoutUsage: number
      }
      assert.equal(body.total.key, '全部')
      assert.equal(Number.isInteger(body.total.costUsdMicros), true, '成本必须是整数微美元')
      assert.equal(body.total.runs, 0, '全新的数据目录里没有 run')
      assert.equal(body.runsWithoutUsage, 0)
    })
  })

  test('★ GET /api/audits/export 是**下载**语义，不是内联渲染', async () => {
    await withDaemon(async (url) => {
      const res = await fetch(`${url}/api/audits/export`)
      assert.equal(res.status, 200)
      // 少了这个头，浏览器会把一份要存档的文件当页面渲染掉
      assert.match(
        res.headers.get('content-disposition') ?? '',
        /attachment/,
        '导出物是给人存下来的文件',
      )
      assert.match(res.headers.get('content-disposition') ?? '', /alpha-helper-audit-/)
    })
  })

  test('★ 导出的内容自带校验和，且能通过校验', async () => {
    await withDaemon(async (url) => {
      const doc = await (await fetch(`${url}/api/audits/export`)).json()
      assert.deepEqual(verifyAuditExport(doc), { ok: true, issues: [] })
    })
  })

  test('?runId= 参数被真的用上', async () => {
    await withDaemon(async (url) => {
      const doc = (await (
        await fetch(`${url}/api/audits/export?runId=nonexistent-run`)
      ).json()) as { count: number; records: unknown[] }
      assert.equal(doc.count, 0)
      assert.deepEqual(doc.records, [])
    })
  })

  test('未知 /api 路径仍是 404，不会掉进静态资源或导出分支', async () => {
    await withDaemon(async (url) => {
      assert.equal((await fetch(`${url}/api/nope`)).status, 404)
    })
  })
})

describe('★ 报告投递的边界校验（一个能被合法调用触发的 500 是缺陷）', () => {
  /** 提交一个报告批次，返回状态码与响应体。 */
  async function post(url: string, body: unknown) {
    const res = await fetch(`${url}/api/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  test('★ 省略 body 的条目必须被接受 —— MCP 的工具 schema 说它可选', async () => {
    // 这条曾经是 HTTP 500 + 一句 Node 内部的 TypeError：
    // `body` 在类型声明上是必填的，但**类型不是运行时校验**，
    // `undefined` 一路走到 `createHash().update()` 才炸。
    // 而 MCP 那边的工具 schema 把 body 标成可选——按文档写的调用必然踩到。
    await withDaemon(async (url) => {
      const res = await post(url, {
        source: 'cli',
        items: [{ externalId: 'x1', kind: 'ci-failure', title: '只有标题' }],
      })
      assert.equal(res.status, 202, `应当受理，实得 ${res.status}：${JSON.stringify(res.body)}`)
    })
  })

  test('★ 缺必填字段 ⇒ 400 且指出是**第几条、哪个字段**', async () => {
    await withDaemon(async (url) => {
      const res = await post(url, {
        source: 'cli',
        items: [
          { externalId: 'ok', kind: 'k', title: 't' },
          { externalId: 'bad', kind: 'k' }, // 缺 title
        ],
      })
      assert.equal(res.status, 400)
      // 批量投递时"输入不合法"这种话让人无从下手
      assert.match(String(res.body['error']), /items\[1\]/, '要指出是第二条')
      assert.match(String(res.body['error']), /title/, '要指出是哪个字段')
      assert.equal(res.body['index'], 1)
      assert.ok(Array.isArray(res.body['issues']))
    })
  })

  test('★ 空数组 ⇒ 400，不是静默受理', async () => {
    await withDaemon(async (url) => {
      const res = await post(url, { source: 'cli', items: [] })
      assert.equal(res.status, 400)
      assert.match(String(res.body['error']), /不能为空/)
    })
  })

  test('缺少 source 或是数组时才报最外层错误', async () => {
    await withDaemon(async (url) => {
      assert.equal((await post(url, { items: [] })).status, 400)
      assert.equal((await post(url, { source: 'x', items: 'not-an-array' })).status, 400)
    })
  })

  test('items 不是对象时也走 400，不会 500', async () => {
    await withDaemon(async (url) => {
      const res = await post(url, { source: 'x', items: ['just-a-string', 42, null] })
      assert.equal(res.status, 400)
      assert.match(String(res.body['error']), /items\[0\]/)
    })
  })
})

describe('★ D27：工作目录不再必填', () => {
  test('★ 不传 workDir 也能受理 —— 这正是 D27 要消除的动作', async () => {
    await withDaemon(async (url) => {
      const issue = (await (
        await fetch(`${url}/api/issues`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: '不指定目录' }),
        })
      ).json()) as { id: string }

      const res = await fetch(`${url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: '01M2D27AAAAAAAAAAAAAAAAAA1',
          kind: 'execute',
          agentRef: { id: 'a', name: 'a', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: issue.id },
          prompt: '不指定工作目录',
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })

      // 这个校验漏改过一次，症状就是"页面不填目录就提交不了"——
      // 而"不填目录"恰恰是 D27 的默认路径。
      assert.equal(res.status, 202, `应当受理，实得 ${res.status}：${await res.text()}`)
    })
  })

  test('★ 缺 runId 仍然拒绝（那一项没有变）', async () => {
    await withDaemon(async (url) => {
      const res = await fetch(`${url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'execute' }),
      })
      assert.equal(res.status, 400)
      assert.match(String(((await res.json()) as { error: string }).error), /runId/)
    })
  })
})
