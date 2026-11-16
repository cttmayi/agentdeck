import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 删智能体（2026-11：编辑页底部新增的「删除」按钮）。
 *
 * 两道闸都是"拒绝 + 说清下一步"，不偷偷改别人的配置：
 *   · 还是某智能体组的成员 ⇒ 400（组里会悬着找不到人的成员 id）；
 *   · 是「新建任务的默认智能体」⇒ 400（界面强调必须有一个默认）。
 * 历史 run 不挡（run 上带执行时的快照），这里不测那条（与组删私有成员一路）。
 */

async function withDaemon<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir('agents-delete')
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

async function create(url: string, body: unknown) {
  const res = await fetch(`${url}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function del(url: string, id: string) {
  const res = await fetch(`${url}/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function get(url: string, id: string) {
  const res = await fetch(`${url}/api/agents/${encodeURIComponent(id)}`)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('★ 删 agent：成功 / 两道闸 / 404', () => {
  test('删成功：详情变 404、全局列表里消失', async () => {
    await withDaemon(async (url) => {
      const made = (await create(url, { name: '临时工' })).body as { id: string }
      assert.equal((await del(url, made.id)).status, 200)
      assert.equal((await get(url, made.id)).status, 404)
      const list = (await fetch(`${url}/api/agents`).then((r) => r.json())) as {
        agents: Array<{ id: string; builtin?: boolean }>
      }
      assert.ok(!list.agents.some((a) => a.id === made.id))
    })
  })

  /*
   * ⚠️ 2026-11（S3）：这里原来是「还是智能体组成员 ⇒ 400，说清先移除」。组退场 ⇒
   *   没有"组成员"这回事，用例删。
   *
   *   ⚠️ 那条规矩本身仍然成立：**删除前先查引用，并点名是谁在引用**——不查的话
   *   症状是"删完发现某处少了一个人"，而那一刻已经是很久以后。
   */

test('是「新建任务的默认智能体」→ 400，说清先换默认', async () => {
    await withDaemon(async (url) => {
      const a = (await create(url, { name: '默认的' })).body as { id: string }
      const set = await fetch(`${url}/api/agents/default`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: a.id }),
      })
      assert.equal(set.status, 200)
      const r = await del(url, a.id)
      assert.equal(r.status, 400)
      assert.match(String(r.body['error']), /默认智能体/)
    })
  })

  test('不存在 → 404', async () => {
    await withDaemon(async (url) => {
      const r = await del(url, '01J00000000000000000000000')
      assert.equal(r.status, 404)
    })
  })
})
