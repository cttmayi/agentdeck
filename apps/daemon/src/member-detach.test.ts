import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * ★ 2026-11（D150）：**把平台成员改成普通智能体**（`detach`）。
 *
 * 这条路存在的理由：平台成员是只读的，"我只想改一下起草者的口吻"没有别的正规出口。
 *
 * 这组判据钉的是**四步各自的后果**，尤其是第 ② 步里那个最容易漏的半句：
 * **必须把 `builtin` / `builtinKind` 一起摘掉**。留着它们，平台对账（认的是这两个
 * 字段）下一次启动就会把这条记录**认领回平台**——使用者改过的东西又被锁上，
 * detach 白做，而且不会有任何报错。
 */

type AgentRow = {
  id: string
  name: string
  owner?: string
  entries?: string[]
  builtin?: boolean
  builtinKind?: string
  instructions?: string
}

async function withDaemon<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir('member-detach')
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

async function listAgents(url: string): Promise<AgentRow[]> {
  const out = (await (await fetch(`${url}/api/agents`)).json()) as { agents: AgentRow[] }
  return out.agents
}

async function findMember(url: string, needle: string): Promise<AgentRow> {
  const row = (await listAgents(url)).find((a) => a.name.includes(needle))
  assert.ok(row, `没找到「${needle}」（现有：${(await listAgents(url)).map((a) => a.name).join('、')}）`)
  return row
}

describe('★ detach：改成你自己的，平台随即重新出厂一条', () => {
  test('★★ 改完之后：owner=user、三项入口全开、builtin 标记**摘掉了**', async () => {
    await withDaemon(async (url) => {
      const drafter = await findMember(url, '沉淀起草者')
      const res = await fetch(`${url}/api/agents/${drafter.id}/detach`, { method: 'POST' })
      assert.equal(res.status, 200)
      const out = (await res.json()) as { agent: AgentRow; references: unknown; recreated: string[] }

      assert.equal(out.agent.owner, 'user')
      assert.deepEqual(out.agent.entries, ['chat', 'task', 'workflow'])
      // ⚠️ 关键半步：这两个字段不摘掉，下次启动会被对账认领回平台
      assert.equal(out.agent.builtin, undefined)
      assert.equal(out.agent.builtinKind, undefined)
    })
  })

  test('★★ 补位：平台立刻建回一条新的原始成员（不等下次启动）', async () => {
    await withDaemon(async (url) => {
      const drafter = await findMember(url, '沉淀起草者')
      const res = await fetch(`${url}/api/agents/${drafter.id}/detach`, { method: 'POST' })
      const out = (await res.json()) as { recreated: string[] }
      assert.ok(out.recreated.some((n) => n.includes('沉淀起草者')), `该报出重新建了哪条：${JSON.stringify(out.recreated)}`)

      const after = await listAgents(url)
      const members = after.filter((a) => a.owner === 'platform')
      assert.equal(members.length, 4, '平台成员仍是四个（新的那条补位成功）')
      assert.ok(
        members.some((m) => m.name.includes('沉淀起草者')),
        '新出厂的那条要有它自己的动作入口',
      )
      const fresh = members.find((m) => m.name.includes('沉淀起草者'))!
      assert.deepEqual(fresh.entries, ['action:skill-draft'], '新的是原始配置，不是从旧的那条抄的')
      // 旧的那条还在，只是变成了普通智能体
      assert.ok(after.some((a) => a.id === drafter.id && a.owner === 'user'))
    })
  })

  test('★ 改写之后它就是"你的"了：能改名字（之前只读会 400）', async () => {
    await withDaemon(async (url) => {
      const drafter = await findMember(url, '沉淀起草者')
      // 改写之前：只读
      const blocked = await fetch(`${url}/api/agents/${drafter.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '我的起草者' }),
      })
      assert.equal(blocked.status, 400, '平台成员本来改不了')
      assert.equal(((await blocked.json()) as { code: string }).code, 'builtin_agent_readonly')

      await fetch(`${url}/api/agents/${drafter.id}/detach`, { method: 'POST' })
      const ok = await fetch(`${url}/api/agents/${drafter.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '我的起草者' }),
      })
      assert.equal(ok.status, 200)
      assert.equal(((await ok.json()) as AgentRow).name, '我的起草者')
    })
  })

  test('★ 引用检查**只算不写**：preview 之后数据一个字不变', async () => {
    await withDaemon(async (url) => {
      const before = JSON.stringify(await listAgents(url))
      const drafter = await findMember(url, '沉淀起草者')
      const res = await fetch(`${url}/api/agents/${drafter.id}/detach-preview`)
      assert.equal(res.status, 200)
      const out = (await res.json()) as { references: Record<string, unknown> }
      assert.equal(typeof out.references['conversationCount'], 'number')
      assert.ok(Array.isArray(out.references['workflowNames']))
      assert.equal(JSON.stringify(await listAgents(url)), before, 'preview 不许写库')
    })
  })

  test('★ 普通智能体没有"脱离"这回事 ⇒ 400（并说清为什么）', async () => {
    await withDaemon(async (url) => {
      const created = (await (
        await fetch(`${url}/api/agents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: '我自己的' }),
        })
      ).json()) as AgentRow
      const res = await fetch(`${url}/api/agents/${created.id}/detach`, { method: 'POST' })
      assert.equal(res.status, 400)
      const body = (await res.json()) as { error: string; code: string }
      assert.equal(body.code, 'agent_not_platform')
      assert.match(body.error, /本来就是你自己的/)
    })
  })
})
