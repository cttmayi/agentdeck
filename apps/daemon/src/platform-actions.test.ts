import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'
import { PLATFORM_ACTIONS, PLATFORM_ACTION_IDS, actionEntriesFor, memberOfAction } from './platform-actions.ts'
import { MEMBER_ACTION_IDS, PLATFORM_MEMBER_ENTRIES, canBeCalledByAction } from './platform-member.ts'
import { ensureBuiltinAgents } from './builtin-drafter.ts'

/**
 * **平台动作注册表**（2026-11，D148）。
 *
 * 这组判据钉的不是"表里写了什么"（那是文档），而是**表与代码没有分开**：
 *
 *   · `MEMBER_ACTION_IDS` 与 `PLATFORM_MEMBER_ENTRIES` 里的 `action:` 都是**派生**的
 *     ——判据证明它们真的等于表，而不是两处各写一份后碰巧一样；
 *   · 每一行声明的**采纳路由**必须真的出现在 `server.ts` 源码里（改名不同步就红）；
 *   · 每一行声明的**产出路径**同样要出现在用到它的文件里。
 *
 * ⚠️ 为什么用"读源码 grep"这种笨办法：采纳路由有几条是带参数的
 *    （`/api/agents/:id` 那条是写记忆），没法写成可直接 import 的常量。与其为了
 *    统一而把路由拆成两段拼接（那会把 `server.ts` 的匹配逻辑改得难读），不如让
 *    判据去比对——本仓库对付"清单与代码两张皮"一直是用这个办法。
 */

const SERVER_SRC = new URL('./server.ts', import.meta.url)

describe('★ 动作注册表：四行，id 唯一，执行者都是平台成员', () => {
  test('四个动作都在，id 不重复', () => {
    /*
     * ⚠️ 2026-11（D155）：原来是五个——`agent-draft` 删了（**死接口**：没有任何代码产出
     *   那种 run；"写岗位卡"发生在普通聊天 run 里）。删掉它之后，两个生成者都只有
     *   自己的"采纳"一个动作，与「编排生成者」一致。
     */
    assert.deepEqual(PLATFORM_ACTION_IDS, [
      'skill-draft',
      'memory-tidy',
      'agent-commit',
      'workflow-commit',
    ])
    assert.equal(new Set(PLATFORM_ACTION_IDS).size, PLATFORM_ACTION_IDS.length)
  })

  test('★ 每个动作的执行者都说得出是谁（没有一行漏填 member）', () => {
    for (const action of PLATFORM_ACTIONS) {
      assert.equal(memberOfAction(action.id), action.member, action.id)
      assert.ok(action.member.length > 0, `${action.id} 的执行者不能为空`)
    }
  })

  test('★ 每个动作都在"人按哪一下"里有落点（没有只有接口、没有入口的动作）', () => {
    for (const action of PLATFORM_ACTIONS) {
      assert.ok(action.startFrom.page === 'chat' || action.startFrom.page === 'crystallize')
      assert.ok(
        action.startFrom.where.trim() !== '',
        `${action.id} 没说清人从哪里发起——那样的动作会变成"有接口没人能按"`,
      )
    }
  })
})

describe('★★ 派生：成员入口与 action id 都从表里出来，不是各写一份', () => {
  test('MEMBER_ACTION_IDS 就是表里的 id（顺序也一致）', () => {
    assert.deepEqual([...MEMBER_ACTION_IDS], [...PLATFORM_ACTION_IDS])
  })

  test('★ 每个动作都在它的成员身上有一条 action:<id> 入口', () => {
    for (const action of PLATFORM_ACTIONS) {
      const entries = PLATFORM_MEMBER_ENTRIES[action.member]
      assert.ok(
        entries.includes(`action:${action.id}`),
        `${action.id} 该出现在「${action.member}」的入口里，实际是 ${JSON.stringify(entries)}`,
      )
    }
  })

  test('★ 反过来：成员身上也没有"不属于它的动作"', () => {
    for (const [kind, entries] of Object.entries(PLATFORM_MEMBER_ENTRIES)) {
      for (const entry of entries) {
        if (!entry.startsWith('action:')) continue
        const id = entry.slice('action:'.length)
        assert.equal(memberOfAction(id as never), kind, `${kind} 身上不该有 ${entry}`)
      }
    }
  })

  test('actionEntriesFor 与出厂表逐项相等（表是唯一来源）', () => {
    for (const kind of Object.keys(PLATFORM_MEMBER_ENTRIES) as Array<keyof typeof PLATFORM_MEMBER_ENTRIES>) {
      const fromTable = PLATFORM_MEMBER_ENTRIES[kind].filter((e) => e.startsWith('action:'))
      assert.deepEqual([...fromTable], actionEntriesFor(kind), kind)
    }
  })

  test('★ 判据函数与表一致：canBeCalledByAction 认的正是表里写的成员', async () => {
    /*
     * ⚠️ 2026-11（D154）：谁是"哪一条成员"不再看记录上的老字段（那字段已经没有了），
     *   改看**槽位表**——判据的意图没变（"表说这条动作归谁，就只有谁能被它叫"）。
     */
    const { agents, slots } = await ensureBuiltinAgentsForTest()
    for (const action of PLATFORM_ACTIONS) {
      for (const agent of agents) {
        const expected = slots[action.member as keyof typeof slots] === (agent.id as string)
        assert.equal(
          canBeCalledByAction(agent, action.id),
          expected,
          `${String(agent.name)} 能不能被 ${action.id} 叫，与表不一致`,
        )
      }
    }
  })
})

describe('★★★ 表与代码两张皮：每一行声明的路由/路径都得真的在代码里', () => {
  test('采纳路由出现在 server.ts 里（改名不同步就红）', async () => {
    const src = await readFile(SERVER_SRC, 'utf8')
    for (const action of PLATFORM_ACTIONS) {
      const route = action.adopt.route
      if (route === null) continue
      /**
       * 参数化路由在代码里是正则（`/^\/api\/conversations\/([^/]+)\/agent-commit$/`），
       * 整串比对不上 ⇒ 比**最后一段**（`agent-commit` 这种名字足够独特）。
       * 不参数化的（`/api/crystallize/commit`）就整串比。
       */
      const needle = route.includes(':') ? route.slice(route.lastIndexOf('/') + 1) : route
      assert.ok(
        src.includes(needle),
        `${action.id} 声明的采纳路由「${route}」在 server.ts 里找不到（改过名？）`,
      )
    }
  })

  test('产出路径出现在 server.ts 或它的定义模块里', async () => {
    const src = await readFile(SERVER_SRC, 'utf8')
    const agentMaker = await readFile(new URL('./agent-maker.ts', import.meta.url), 'utf8')
    const workflowMaker = await readFile(new URL('./workflow-maker.ts', import.meta.url), 'utf8')
    const pool = src + agentMaker + workflowMaker
    for (const action of PLATFORM_ACTIONS) {
      const produce = action.produce
      if (produce === null) continue // 产出不是文件（"整理记忆"那条）
      assert.ok(
        pool.includes(produce.dir),
        `${action.id} 的产出目录「${produce.dir}」在代码里找不到`,
      )
      if (produce.file !== undefined) {
        assert.ok(pool.includes(produce.file), `${action.id} 的产出文件「${produce.file}」在代码里找不到`)
      }
    }
  })

  test('素材文件名在 server.ts 里是通过常量用的（不是又写了一遍字面量）', async () => {
    const src = await readFile(SERVER_SRC, 'utf8')
    // 这两份素材必须走 `MEMORY_*_FILE` 常量：`'transcript.md'` 这种字面量只许留在注释里
    // （注释是给人读的；代码里出现就是第二份定义，改一处漏一处只是时间问题）。
    const codeLines = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    for (const literal of ["'transcript.md'", "'existing-memory.md'"]) {
      const hit = codeLines.find((line) => line.includes(literal))
      assert.equal(hit, undefined, `代码里还有硬编码的 ${literal}：${hit ?? ''}`)
    }
  })
})

/** 造一份真实的出厂成员清单（判据要拿真记录比对，不能自己拼一份）。 */
async function ensureBuiltinAgentsForTest() {
  const { FileStore } = await import('@agentdeck/store-file')
  const { wsId } = await import('@agentdeck/domain/testing')
  const { makeTempDir, cleanup } = await import('./testing/tmp.ts')
  const { ensureTestWorkspace } = await import('./testing/test-workspace.ts')
  const dir = await makeTempDir('platform-actions')
  const store = await FileStore.open({ dataDir: dir, fsync: false })
  const ws = wsId('ws-platform-actions')
  // ★ 2026-11（D154）：槽位表挂在工作区上
  await ensureTestWorkspace(store, ws)
  try {
    const { slots } = await ensureBuiltinAgents(store, ws)
    return { agents: await store.listAgents(ws), slots }
  } finally {
    await store.close()
    await cleanup(dir)
  }
}
