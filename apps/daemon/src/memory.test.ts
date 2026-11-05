import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import {
  DEFAULT_MEMORY_PREFIXES,
  MEMORY_LIMIT,
  MEMORY_TEXT_MAX,
  addMemoryEntry,
  applyMemoryDelta,
  effectiveMemoryPrefixes,
  listActiveMemory,
  removeMemoryEntry,
  setMemoryPinned,
} from './memory.ts'
import type { MemoryEntry, MemoryEntryId, WorkspaceId, AgentId } from '@agentdeck/protocol'
import type { Store } from '@agentdeck/domain'

/**
 * 智能体记忆（分批第 240 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一层要守住的三件事
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **上限满了明确拒绝**，绝不自动驱逐——系统偷偷删掉它自己的记忆，
 *    人不会知道它什么时候忘的。
 * ② **改 = 新增 + 删掉旧的**：所以这里没有"更新正文"这条路，只有 add / remove / pin；
 *    删是**打时间戳**（记录留着，可查"这条什么时候被换掉的"）。
 * ③ **触发词是全局的一份**：缺省 = 平台默认，**空数组 = 关**（不是"每句都算"）。
 */

const WS = 'ws-1' as WorkspaceId
const AGENT = 'agent-1' as AgentId

/** 只实现记忆这一块的假 store（真 store 的行为由 file-store / sqlite 的测试钉着）。 */
function fakeStore(initial: MemoryEntry[] = []) {
  const rows = [...initial]
  const store = {
    async listMemoryEntries(_ws: WorkspaceId, agentId?: AgentId) {
      return agentId === undefined ? [...rows] : rows.filter((r) => r.agentId === agentId)
    },
    async insertMemoryEntry(entry: MemoryEntry) {
      rows.push(entry)
    },
    async updateMemoryEntry(entry: MemoryEntry) {
      const i = rows.findIndex((r) => r.id === entry.id)
      if (i < 0) return false
      rows[i] = entry
      return true
    },
  }
  return { store: store as unknown as Store, rows }
}

let seq = 0
function idGen(): () => string {
  return () => `mem-${++seq}`
}

describe('记忆：加一条', () => {
  test('★ 正常加一条：类型、正文、出处、置顶都落下来', async () => {
    const { store, rows } = fakeStore()
    const res = await addMemoryEntry(store, {
      workspaceId: WS,
      agentId: AGENT,
      kind: 'fact',
      text: '  这个仓库跑测试用 pnpm  ',
      evidence: 'run-1',
      pinned: true,
      newId: idGen(),
      now: () => 1000,
    })
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.equal(res.entry.text, '这个仓库跑测试用 pnpm', '首尾空白要去掉')
    assert.equal(res.entry.evidence, 'run-1')
    assert.equal(res.entry.pinned, true)
    assert.equal(res.entry.useCount, 0, '新条目还没被用过')
    assert.equal(res.entry.removedAt, null)
    assert.equal(rows.length, 1)
  })

  test('★★ 类型不认识 ⇒ `kind_invalid`（不猜）', async () => {
    const { store } = fakeStore()
    const res = await addMemoryEntry(store, {
      workspaceId: WS,
      agentId: AGENT,
      kind: 'opinion',
      text: 'x',
      newId: idGen(),
    })
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.code, 'kind_invalid')
  })

  test('★ 空正文 / 全是空白 ⇒ `text_empty`', async () => {
    const { store } = fakeStore()
    for (const text of ['', '   ', '\n\t ']) {
      const res = await addMemoryEntry(store, {
        workspaceId: WS,
        agentId: AGENT,
        kind: 'fact',
        text,
        newId: idGen(),
      })
      assert.equal(res.ok, false, JSON.stringify(text))
      if (!res.ok) assert.equal(res.code, 'text_empty')
    }
  })

  test('★ 超长 ⇒ `text_too_long`，而且错误里说得出上限与现在多少字', async () => {
    const { store } = fakeStore()
    const res = await addMemoryEntry(store, {
      workspaceId: WS,
      agentId: AGENT,
      kind: 'fact',
      text: 'x'.repeat(MEMORY_TEXT_MAX + 1),
      newId: idGen(),
    })
    assert.equal(res.ok, false)
    if (!res.ok) {
      assert.equal(res.code, 'text_too_long')
      assert.match(res.error, new RegExp(String(MEMORY_TEXT_MAX)))
    }
  })

  test('★★ 满了（40 条）⇒ `limit_reached`，**不驱逐**最旧的那条', async () => {
    const seed: MemoryEntry[] = Array.from({ length: MEMORY_LIMIT }, (_, i) => ({
      id: `seed-${i}` as MemoryEntryId,
      workspaceId: WS,
      agentId: AGENT,
      kind: 'fact' as const,
      text: `第 ${i} 条`,
      pinned: false,
      useCount: 0,
      lastUsedAt: null,
      createdAt: i,
      removedAt: null,
    }))
    const { store, rows } = fakeStore(seed)
    const res = await addMemoryEntry(store, {
      workspaceId: WS,
      agentId: AGENT,
      kind: 'fact',
      text: '再加一条',
      newId: idGen(),
    })
    assert.equal(res.ok, false)
    if (!res.ok) {
      assert.equal(res.code, 'limit_reached')
      assert.match(res.error, /满了/, '错误里要说清"满了"，并指出下一步是删几条')
    }
    assert.equal(rows.length, MEMORY_LIMIT, '被拒之后条数不变（没有偷偷删一条给新的腾地方）')
  })

  test('★ 删掉的**不占名额**（上限按活着的那几条算）', async () => {
    const seed: MemoryEntry[] = Array.from({ length: MEMORY_LIMIT }, (_, i) => ({
      id: `seed-${i}` as MemoryEntryId,
      workspaceId: WS,
      agentId: AGENT,
      kind: 'fact' as const,
      text: `第 ${i} 条`,
      pinned: false,
      useCount: 0,
      lastUsedAt: null,
      createdAt: i,
      removedAt: i === 0 ? 999 : null,
    }))
    const { store } = fakeStore(seed)
    const res = await addMemoryEntry(store, {
      workspaceId: WS,
      agentId: AGENT,
      kind: 'fact',
      text: '腾出来的名额',
      newId: idGen(),
    })
    assert.equal(res.ok, true)
  })
})

describe('记忆：改 = 新增 + 删掉旧的', () => {
  test('★★ 删是**打时间戳**：记录留着、不再出现在"活着的"里面', async () => {
    const { store, rows } = fakeStore()
    const added = await addMemoryEntry(store, {
      workspaceId: WS,
      agentId: AGENT,
      kind: 'lesson',
      text: '原来的说法',
      newId: idGen(),
      now: () => 100,
    })
    assert.equal(added.ok, true)
    if (!added.ok) return

    const removed = await removeMemoryEntry(store, {
      workspaceId: WS,
      agentId: AGENT,
      entryId: added.entry.id as string,
      now: () => 500,
    })
    assert.equal(removed.ok, true)
    assert.equal(rows.length, 1, '记录还在日志里（可查"什么时候被换掉的"）')
    assert.equal(rows[0]?.removedAt, 500)
    assert.deepEqual(await listActiveMemory(store, WS, AGENT), [])
  })

  test('★ 删两次是幂等的（第二次 `alreadyRemoved`，不是错误）', async () => {
    const { store } = fakeStore()
    const added = await addMemoryEntry(store, {
      workspaceId: WS,
      agentId: AGENT,
      kind: 'fact',
      text: 'A',
      newId: idGen(),
    })
    assert.equal(added.ok, true)
    if (!added.ok) return
    const first = await removeMemoryEntry(store, {
      workspaceId: WS,
      agentId: AGENT,
      entryId: added.entry.id as string,
    })
    const second = await removeMemoryEntry(store, {
      workspaceId: WS,
      agentId: AGENT,
      entryId: added.entry.id as string,
    })
    assert.equal(first.ok && first.alreadyRemoved, false)
    assert.equal(second.ok && second.alreadyRemoved, true)
  })

  test('★★ 不存在的条目 ⇒ `entry_not_found`（"它已经没了"与"删失败"分开）', async () => {
    const { store } = fakeStore()
    const res = await removeMemoryEntry(store, {
      workspaceId: WS,
      agentId: AGENT,
      entryId: 'nope',
    })
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.code, 'entry_not_found')
  })

  test('★★ 差量：一次"改"就是 add 一条 + remove 旧的（界面上的「改」）', async () => {
    const { store, rows } = fakeStore()
    const old = await addMemoryEntry(store, {
      workspaceId: WS,
      agentId: AGENT,
      kind: 'fact',
      text: '旧说法',
      newId: idGen(),
    })
    assert.equal(old.ok, true)
    if (!old.ok) return

    const applied = await applyMemoryDelta(store, {
      workspaceId: WS,
      agentId: AGENT,
      delta: {
        add: [{ kind: 'fact', text: '新说法' }],
        remove: [old.entry.id as string],
      },
      newId: idGen(),
      now: () => 777,
    })
    assert.equal(applied.ok, true)
    if (!applied.ok) return
    assert.equal(applied.added.length, 1)
    assert.deepEqual(applied.removed, [old.entry.id as string])
    const active = await listActiveMemory(store, WS, AGENT)
    assert.deepEqual(
      active.map((e) => e.text),
      ['新说法'],
      '活着的只剩新的那条（旧的打上时间戳留在日志里）',
    )
    assert.equal(rows.length, 2, '两条记录都在（append-only）')
  })

  test('★ 差量里的置顶开关：改成 ★ / 取消 ★', async () => {
    const { store } = fakeStore()
    const added = await addMemoryEntry(store, {
      workspaceId: WS,
      agentId: AGENT,
      kind: 'commitment',
      text: '报告不出现"赋能"',
      newId: idGen(),
    })
    assert.equal(added.ok, true)
    if (!added.ok) return

    const on = await setMemoryPinned(store, {
      workspaceId: WS,
      agentId: AGENT,
      entryId: added.entry.id as string,
      pinned: true,
    })
    assert.equal(on.ok, true)
    if (on.ok) assert.equal(on.entry.pinned, true)

    const applied = await applyMemoryDelta(store, {
      workspaceId: WS,
      agentId: AGENT,
      delta: { pin: [{ id: added.entry.id as string, pinned: false }] },
    })
    assert.equal(applied.ok, true)
    const active = await listActiveMemory(store, WS, AGENT)
    assert.equal(active[0]?.pinned, false)
  })

  test('★★ 差量里加一条失败 ⇒ 整次保存返回失败，**不静默**（说明停在第几条）', async () => {
    const { store } = fakeStore()
    const applied = await applyMemoryDelta(store, {
      workspaceId: WS,
      agentId: AGENT,
      delta: {
        add: [
          { kind: 'fact', text: '第一条没问题' },
          { kind: 'fact', text: '' },
        ],
      },
      newId: idGen(),
    })
    assert.equal(applied.ok, false)
    if (!applied.ok) {
      assert.equal(applied.code, 'text_empty')
      assert.match(applied.error, /第 2 条/, '错误里要说清是第几条')
    }
  })

  test('★ 置顶一条不存在的（另一端刚删了）**不让整次保存失败**', async () => {
    const { store } = fakeStore()
    const applied = await applyMemoryDelta(store, {
      workspaceId: WS,
      agentId: AGENT,
      delta: { pin: [{ id: 'gone', pinned: true }] },
    })
    assert.equal(applied.ok, true)
    if (applied.ok) assert.deepEqual(applied.pinned, [])
  })
})

describe('触发词（全局的一份）', () => {
  test('★ 没设过 ⇒ 平台默认那三个', () => {
    assert.deepEqual(effectiveMemoryPrefixes(null), [...DEFAULT_MEMORY_PREFIXES])
    assert.deepEqual(effectiveMemoryPrefixes({}), [...DEFAULT_MEMORY_PREFIXES])
    assert.deepEqual(effectiveMemoryPrefixes({ memoryPrefixes: undefined }), [...DEFAULT_MEMORY_PREFIXES])
  })

  test('★★ 空数组 = **关掉**（不是"每句都算"）', () => {
    assert.deepEqual(effectiveMemoryPrefixes({ memoryPrefixes: [] }), [])
  })

  test('★ 设过的照它来', () => {
    assert.deepEqual(effectiveMemoryPrefixes({ memoryPrefixes: ['记得', '别忘了'] }), ['记得', '别忘了'])
  })
})

describe('记忆接口（HTTP 层）', () => {
  async function withDaemon<T>(fn: (url: string, agentId: string) => Promise<T>): Promise<T> {
    const dir = await makeTempDir('memory-api')
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
    })
    try {
      const created = await fetch(`${d.url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '记忆测试', instructions: '你是干活的' }),
      })
      const agent = (await created.json()) as { id: string }
      return await fn(d.url, agent.id)
    } finally {
      await d.close()
      await cleanup(dir)
    }
  }

  test('★★ 详情带记忆；加一条之后列表的 `memoryCount` 跟着变', async () => {
    await withDaemon(async (url, agentId) => {
      const before = (await (await fetch(`${url}/api/agents/${agentId}`)).json()) as {
        memory?: unknown[]
      }
      assert.deepEqual(before.memory, [], '新 agent 没有记忆（空数组，不是缺字段）')

      const res = await fetch(`${url}/api/agents/${agentId}/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'fact', text: '这个仓库用 pnpm' }),
      })
      assert.equal(res.status, 201, await res.clone().text())
      const { entries } = (await res.json()) as { entries: Array<{ id: string }> }
      assert.equal(entries.length, 1)

      const after = (await (await fetch(`${url}/api/agents/${agentId}`)).json()) as {
        memory: Array<{ text: string }>
      }
      assert.deepEqual(
        after.memory.map((e) => e.text),
        ['这个仓库用 pnpm'],
      )

      const list = (await (await fetch(`${url}/api/agents`)).json()) as {
        agents: Array<{ id: string; memoryCount?: number }>
      }
      assert.equal(list.agents.find((a) => a.id === agentId)?.memoryCount, 1)
    })
  })

  test('★★ 详情页保存：差量里"改"= 加一条 + 删旧的，保存返回最新的记忆', async () => {
    await withDaemon(async (url, agentId) => {
      const created = await fetch(`${url}/api/agents/${agentId}/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'lesson', text: '旧教训' }),
      })
      const { entries } = (await created.json()) as { entries: Array<{ id: string }> }
      const oldId = entries[0]!.id

      const patched = await fetch(`${url}/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          memory: { add: [{ kind: 'lesson', text: '新教训' }], remove: [oldId] },
        }),
      })
      assert.equal(patched.status, 200, await patched.clone().text())
      const body = (await patched.json()) as { memory: Array<{ text: string }> }
      assert.deepEqual(
        body.memory.map((e) => e.text),
        ['新教训'],
      )
    })
  })

  test('★ 撤销（DELETE）之后不再出现在记忆里', async () => {
    await withDaemon(async (url, agentId) => {
      const created = await fetch(`${url}/api/agents/${agentId}/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'fact', text: '记错了' }),
      })
      const { entries } = (await created.json()) as { entries: Array<{ id: string }> }
      const del = await fetch(`${url}/api/agents/${agentId}/memory/${entries[0]!.id}`, {
        method: 'DELETE',
      })
      assert.equal(del.status, 200)
      const after = (await (await fetch(`${url}/api/agents/${agentId}`)).json()) as {
        memory: unknown[]
      }
      assert.deepEqual(after.memory, [])
    })
  })

  test('★★ 触发词写入口：空数组 = 关；去重；身份接口跟着变', async () => {
    await withDaemon(async (url) => {
      const identity = (await (await fetch(`${url}/api/identity`)).json()) as {
        memoryPrefixes?: string[]
      }
      assert.deepEqual(identity.memoryPrefixes, [...DEFAULT_MEMORY_PREFIXES], '没设过 = 平台默认')

      const saved = await fetch(`${url}/api/workspace/memory-prefixes`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: ['记得', '记得', ' 别忘了 '] }),
      })
      assert.equal(saved.status, 200, await saved.clone().text())
      const after = (await (await fetch(`${url}/api/identity`)).json()) as {
        memoryPrefixes?: string[]
      }
      assert.deepEqual(after.memoryPrefixes, ['记得', '别忘了'], '去重 + 去首尾空白')

      await fetch(`${url}/api/workspace/memory-prefixes`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: [] }),
      })
      const off = (await (await fetch(`${url}/api/identity`)).json()) as {
        memoryPrefixes?: string[]
      }
      assert.deepEqual(off.memoryPrefixes, [], '空数组就是关（不是回落到默认）')
    })
  })

  test('★ 触发词非法（空串 / 超长 / 不是数组）逐条说清', async () => {
    await withDaemon(async (url) => {
      for (const body of [{ prefixes: [''] }, { prefixes: ['x'.repeat(33)] }, { prefixes: 'no' }]) {
        const res = await fetch(`${url}/api/workspace/memory-prefixes`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        assert.equal(res.status, 400, JSON.stringify(body))
      }
    })
  })
})
