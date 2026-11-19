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
  builtin?: boolean
  /** ★ 2026-11（D154）：服务端按槽位表算好发下来的（记录上不再有岗位字段）。 */
  slot?: string | null
  /**
   * ⚠️ 2026-11（S4，D127）：这里原来是 `role: string`。**角色退场** ⇒ 判据换成
   *   `builtin` + `builtinKind`（"是哪一条内置"）。
   */
  builtinKind?: 'drafter' | 'skill-reviewer' | 'memory-tidy' | 'agent-maker'
  owner?: string
  entries?: string[]
  skillIds: string[]
}

async function drafterOf(url: string): Promise<AgentRow> {
  const body = (await (await fetch(`${url}/api/agents`)).json()) as { agents: AgentRow[] }
  /* ★ 2026-11（D154）：接口算好发下 `slot`，按它认人 */
  const found = body.agents.find((a) => a.slot === 'drafter')
  assert.ok(found, '启动之后必须有一条内置起草者（每次启动对账）')
  return found
}

describe('内置起草者：启动就有、不能删、不能改坏、能恢复默认', () => {
  test('★ 启动之后它就在（岗位是起草者、指令是默认值、不挂技能）', async () => {
    await withDaemon(async (url) => {
      const drafter = await drafterOf(url)
      assert.equal(drafter.slot, 'drafter', '★ 2026-11（D154）：认人看槽位（记录上不再有岗位字段）')
      assert.equal(drafter.builtin, undefined, '新记录不写 builtin 标记')
      assert.equal(drafter.owner, 'platform')
      assert.deepEqual(drafter.entries, ['action:skill-draft'])
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

  test('★★★ 只读：任何字段都改不了（名字/指令/技能挂载/CLI 一律 400）', async () => {
    // ★ 分批第 190 批（使用者："把内置智能体全部改成只读"）：从"锁三个字段"收紧到"全锁"。
    //   写法已经交给使用者装的技能，平台内置的那条身份不能再被改——否则"平台说的"与
    //   "实际跑的"对不上，而这条链的每一步都要能对上。
    await withDaemon(async (url) => {
      const drafter = await drafterOf(url)
      const patches = [
        { },
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
      assert.equal(after.slot, 'drafter', '★ 2026-11（D154）：认人看槽位')
      assert.deepEqual(after.skillIds, [])
      assert.equal(after.name, DRAFTER_NAME)
      assert.equal(after.instructions, DRAFTER_INSTRUCTIONS)
    })
  })

  /*
   * ⚠️ 2026-11（D160）：这里原来有两条「恢复成默认值」的用例（能回到默认 / 普通 agent 没有
   *   默认值可恢复）。**那条接口整条删掉了**（使用者定："内置智能体不应该有『恢复默认值』…
   *   或者可以有一个『复制智能体』的功能"）⇒ 用例随之删除；替它的是 `agent-copy.test.ts`
   *   （复制平台成员 ⇒ 得到一条自建的副本，原件一个字都不动）。
   */
})
