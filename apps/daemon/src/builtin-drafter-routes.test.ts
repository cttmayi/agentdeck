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
  const found = body.agents.find((a) => a.role === 'drafter')
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

  test('★★★ 只读：任何字段都改不了（名字/指令/角色/技能挂载/CLI 一律 400）', async () => {
    // ★ 分批第 190 批（使用者："把内置智能体全部改成只读"）：从"锁三个字段"收紧到"全锁"。
    //   写法已经交给使用者装的技能，平台内置的那条身份不能再被改——否则"平台说的"与
    //   "实际跑的"对不上，而这条链的每一步都要能对上。
    await withDaemon(async (url) => {
      const drafter = await drafterOf(url)
      const patches = [
        { role: 'executor' },
        { skillIds: ['01SKILL'] },
        { builtin: false },
        { name: '我改的名字' },
        { instructions: '我们团队的起草规范。' },
      ]
      for (const patch of patches) {
        const res = await fetch(`${url}/api/agents/${drafter.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        assert.equal(res.status, 400, `这条 patch 该被拒绝：${JSON.stringify(patch)}`)
        assert.equal(((await res.json()) as { code?: string }).code, 'builtin_agent_readonly')
      }
      const after = await drafterOf(url)
      assert.equal(after.role, 'drafter')
      assert.deepEqual(after.skillIds, [])
      assert.equal(after.name, DRAFTER_NAME)
      assert.equal(after.instructions, DRAFTER_INSTRUCTIONS)
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

  test('★★ 进不了智能体组（组决定谁执行谁审 = 业务闭环；它不参与）', async () => {
    await withDaemon(async (url) => {
      const drafter = await drafterOf(url)
      // ⚠️ 路径是 `/api/agent-groups`（我第一版按界面上的"智能体组"猜成 `/api/groups`
      //     —— 返回的是 404 `未知路径`，看起来像"这个接口不存在"，其实是路径写错了）。
      const res = await fetch(`${url}/api/agent-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '试图组', members: [drafter.id] }),
      })
      // ⚠️ 这条挡在 `parseGroupFields` 里，是**唯一**能挡住它的地方之一：界面上
      //    「组」页的候选是 `role === 'executor'`（起草者天然落选），但接口是公开的，
      //    而进组之后它就可能被派去执行任务或审别人的产出——它的自愈只在启动时做
      //    （幂等/补标记），**不会自己退出组**。
      // 响应体只能读一次（这一条我在本文件里已经踩过一次，见上面那句注释）
      const text = await res.text()
      assert.equal(res.status, 400, text)
      assert.match((JSON.parse(text) as { error: string }).error, /不能进智能体组/)
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
