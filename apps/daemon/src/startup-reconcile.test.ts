import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { FileStore } from '@agentdeck/store-file'
import { wsId } from '@agentdeck/domain/testing'
import { RECONCILE_PLAN, reconcileStartup } from './startup-reconcile.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { ensureTestWorkspace } from './testing/test-workspace.ts'

/**
 * **启动对账**（2026-11，D149）。
 *
 * 这组判据钉三件事，每件都对应一次真实的、或几乎发生的故障：
 *
 *   ① **计划与实现一一对应**：`RECONCILE_PLAN` 里写了、实现里没有 = 死接口
 *      （用户点开日志以为做了，其实什么都没做——本仓库最怕的那一类）。
 *   ② **顺序是数据且真的被遵守**：`needs` 声明的依赖必须在前面。最要命的一条是
 *      "老字段清理 → `owner`/`entries` 写回"：反了会让清理"没东西可清"，日志里那句
 *      "清了谁"随之消失（这个顺序曾经真的写错过，`agent-legacy-cleanup.test.ts` 抓到）。
 *   ③ **跑一遍之后数据真的齐了**：内置成员都在、`owner`/`entries` 都写进了记录
 *      ——判据落在**库里的事实**上，不是"函数返回了一个好看的数组"。
 */

const WS = wsId('ws-reconcile')

async function withStore<T>(fn: (store: FileStore) => Promise<T>): Promise<T> {
  const dir = await makeTempDir('startup-reconcile')
  const store = await FileStore.open({ dataDir: dir, fsync: false })
  // ★ 2026-11（D154）：槽位表挂在工作区上（`Workspace.platformSlots`）⇒ 先有工作区
  await ensureTestWorkspace(store, WS)
  try {
    return await fn(store)
  } finally {
    await store.close()
    await cleanup(dir)
  }
}

describe('★ 计划本身：八步都在，依赖都指向前面的步骤', () => {
  test('八步一个不少，id 不重复', () => {
    const ids = RECONCILE_PLAN.map((s) => s.id)
    assert.deepEqual(ids, [
      'memory-defaults',
      'builtin-agents',
      'drafter-skill-mount',
      'agent-maker-skills',
      'workflow-maker-skills',
      'agent-legacy-cleanup',
      'platform-member-fields',
      'workflow-refs-scan',
    ])
    assert.equal(new Set(ids).size, ids.length)
  })

  test('★ 每一步的 `needs` 都必须排在它**前面**（顺序写错在这里就红，不用等启动）', () => {
    const seen = new Set<string>()
    for (const step of RECONCILE_PLAN) {
      for (const need of step.needs) {
        assert.ok(seen.has(need), `「${step.id}」依赖「${need}」，但后者排在它后面或压根没有`)
      }
      seen.add(step.id)
    }
  })

  test('★★ 三条关键顺序各有一个判据（它们各自对应一次真事故或真不变量）', () => {
    const pos = (id: string) => RECONCILE_PLAN.findIndex((s) => s.id === id)
    assert.ok(pos('agent-legacy-cleanup') < pos('platform-member-fields'), '老字段清理必须在属性写回之前')
    assert.ok(pos('builtin-agents') < pos('drafter-skill-mount'), '成员还没建，挂不了技能')
    assert.ok(pos('platform-member-fields') < pos('workflow-refs-scan'), '引用扫描读的就是那两个属性')
  })

  test('每一步都说得出"在补什么"（日志与报错都要用它）', () => {
    for (const step of RECONCILE_PLAN) {
      assert.ok(step.what.trim() !== '', `${step.id} 没说清这一步做什么`)
    }
  })
})

describe('★★ 真跑一遍：内置成员齐了、owner/entries 写进了数据', () => {
  test('★ 返回的步骤顺序 = 计划顺序（没有偷偷跳过哪一步）', async () => {
    await withStore(async (store) => {
      const result = await reconcileStartup({
        store,
        workspaceId: WS,
        workflows: [],
        info: () => {},
        warn: () => {},
      })
      assert.deepEqual([...result.steps], RECONCILE_PLAN.map((s) => s.id))
    })
  })

  test('★ 四个内置成员都在，而且都带上了 owner + entries', async () => {
    await withStore(async (store) => {
      await reconcileStartup({ store, workspaceId: WS, workflows: [], info: () => {}, warn: () => {} })
      const agents = await store.listAgents(WS)
      const platform = agents.filter((a) => a.owner === 'platform')
      assert.equal(platform.length, 4, `平台成员该有 4 个，实际 ${platform.map((a) => a.name).join('、')}`)
      for (const a of platform) {
        assert.ok(Array.isArray(a.entries), `${String(a.name)} 没有 entries`)
        assert.ok((a.entries ?? []).length > 0, `${String(a.name)} 一个接入点都没有`)
        assert.ok(
          (a.entries ?? []).some((e) => e.startsWith('action:')),
          `${String(a.name)} 的接入点里没有它自己的动作`,
        )
      }
    })
  })

  test('★★ 幂等：跑两遍不会长出第二份内置成员、日志也不重复动手', async () => {
    await withStore(async (store) => {
      const first: string[] = []
      await reconcileStartup({
        store,
        workspaceId: WS,
        workflows: [],
        info: (m) => first.push(m),
        warn: () => {},
      })
      const countAfterFirst = (await store.listAgents(WS)).length
      const second: string[] = []
      await reconcileStartup({
        store,
        workspaceId: WS,
        workflows: [],
        info: (m) => second.push(m),
        warn: () => {},
      })
      assert.equal((await store.listAgents(WS)).length, countAfterFirst, '第二遍不该再建人')
      // 第二遍仍然会报"起草者挂了"这类**现状**，但不该再报"已建立 / 已写入"
      assert.equal(
        second.some((m) => m.includes('已建立') || m.includes('已写入')),
        false,
        `第二遍不该再说"建了/写了"：${second.join(' | ')}`,
      )
    })
  })

  test('★ 编排引用了平台成员时要**点名**（只报不改）', async () => {
    await withStore(async (store) => {
      const warnings: string[] = []
      // ⚠️ 编排**不在 store 里**（它是数据目录下的一个文件，由 `loadWorkflows` 读），
      //    所以这里传一份数组进去，并断言它**一个字节都没被动过**——"只报不改"。
      const workflows = [
        { name: '老编排', code: "await flow([agent('沉淀起草者（内置）')], '{{task}}')" },
      ]
      const snapshot = JSON.stringify(workflows)
      await reconcileStartup({
        store,
        workspaceId: WS,
        workflows,
        info: () => {},
        warn: (m) => warnings.push(m),
      })
      const hit = warnings.find((m) => m.includes('引用了平台成员'))
      assert.ok(hit, `该报一条引用告警，实际：${warnings.join(' | ')}`)
      assert.match(hit, /老编排/, '要点名是哪条编排')
      assert.equal(JSON.stringify(workflows), snapshot, '扫描不许改编排内容（只报不改）')
    })
  })
})
