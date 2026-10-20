import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { DRAFTER_INSTRUCTIONS, DRAFTER_NAME } from './builtin-drafter.ts'

/**
 * 内置起草者的**牙齿**（2026-10，定稿第 ①②③⑥ 条）：接口层的三条拒绝 + 一条恢复。
 *
 * 为什么这些必须**在接口层**测、不能只在模块层测：这些拒绝的真实目的是"挡住别的入口"，
 * 而模块层（`ensureBuiltinDrafter`）只保证"启动时会把它补回来/不动它"。真正的风险是
 * 有人从**删除按钮、改角色、挂技能**这三条路把它弄坏 —— 三条路都走 HTTP，所以判据也
 * 必须走 HTTP。用户看到的表现也在这里："它到底能不能被删/被改成业务执行者"。
 */

async function withDaemon<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir('builtin-drafter-routes')
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

interface AgentRow {
  id: string
  name: string
  instructions: string
  role: string
  builtin?: boolean
  skillIds: string[]
}

async function drafterOf(url: string): Promise<AgentRow> {
  const body = (await (await fetch(`${url}/api/agents`)).json()) as { agents: AgentRow[] }
  const found = body.agents.find((a) => a.builtin === true)
  assert.ok(found, '启动之后必须有一条内置起草者（每次启动对账）')
  return found
}

describe('内置起草者：启动就有、不能删、不能改坏、能恢复默认', () => {
  test('★ 启动之后它就在（角色是起草者、指令是默认值、不挂技能）', async () => {
    await withDaemon(async (url) => {
      const drafter = await drafterOf(url)
      assert.equal(drafter.role, 'drafter')
      assert.equal(drafter.name, DRAFTER_NAME)
      assert.equal(drafter.instructions, DRAFTER_INSTRUCTIONS)
      assert.deepEqual(drafter.skillIds, [])
    })
  })

  test('★★★ 删不掉：400 + 说清"要恢复原样用恢复默认值"（不是静默删掉再偷偷重建）', async () => {
    await withDaemon(async (url) => {
      const drafter = await drafterOf(url)
      const res = await fetch(`${url}/api/agents/${drafter.id}`, { method: 'DELETE' })
      assert.equal(res.status, 400)
      const body = (await res.json()) as { error: string; code?: string }
      assert.equal(body.code, 'builtin_agent_not_deletable')
      assert.match(body.error, /恢复成默认值/)
      // 删完它还得在（拒绝必须是真拒绝，不是"删了再补"——后者在列表里看不出来）
      assert.equal((await drafterOf(url)).id, drafter.id)
    })
  })

  test('★★ 改不坏：角色 / 内置标记 / 挂载技能三条都拒绝（静默忽略会让人以为配上了）', async () => {
    await withDaemon(async (url) => {
      const drafter = await drafterOf(url)
      for (const patch of [{ role: 'executor' }, { skillIds: ['01SKILL'] }, { builtin: false }]) {
        const res = await fetch(`${url}/api/agents/${drafter.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        assert.equal(res.status, 400, `这条 patch 该被拒绝：${JSON.stringify(patch)}`)
        const body = (await res.json()) as { code?: string }
        assert.equal(body.code, 'builtin_agent_field_locked')
      }
      const after = await drafterOf(url)
      assert.equal(after.role, 'drafter')
      assert.deepEqual(after.skillIds, [])
    })
  })

  test('★ 能改的照旧能改：名字与指令（使用者的资产），而且改完还在', async () => {
    await withDaemon(async (url) => {
      const drafter = await drafterOf(url)
      const res = await fetch(`${url}/api/agents/${drafter.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instructions: '我们团队的起草规范。' }),
      })
      assert.equal(res.status, 200, await res.text())
      assert.equal((await drafterOf(url)).instructions, '我们团队的起草规范。')
    })
  })

  test('★★★ 「恢复成默认值」：改过之后能一键回到默认（一字不差）', async () => {
    await withDaemon(async (url) => {
      const drafter = await drafterOf(url)
      await fetch(`${url}/api/agents/${drafter.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '我自己改的起草者', instructions: '改坏了' }),
      })
      const res = await fetch(`${url}/api/agents/${drafter.id}/restore-default`, { method: 'POST' })
      assert.equal(res.status, 200, await res.text())
      const after = await drafterOf(url)
      assert.equal(after.name, DRAFTER_NAME)
      assert.equal(after.instructions, DRAFTER_INSTRUCTIONS)
    })
  })

  test('普通 agent 没有"默认值"可恢复（400 而不是假装成功）', async () => {
    await withDaemon(async (url) => {
      const body = (await (await fetch(`${url}/api/agents`)).json()) as { agents: AgentRow[] }
      const plain = body.agents.find((a) => a.builtin !== true && a.role === 'executor')
      assert.ok(plain)
      const res = await fetch(`${url}/api/agents/${plain.id}/restore-default`, { method: 'POST' })
      assert.equal(res.status, 400)
      const err = (await res.json()) as { code?: string }
      assert.equal(err.code, 'not_builtin_agent')
    })
  })
})
