import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
import { deliveredText } from './testing/delivered.ts'

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

describe('记忆：顺序与置顶上限', () => {
  test('★★ 列表按**注入顺序**返回：置顶在前、然后 约定>偏好>事实>教训、同类最近用过的在前', async () => {
    const { store } = fakeStore()
    const add = async (kind: string, text: string, pinned = false) =>
      addMemoryEntry(store, {
        workspaceId: WS,
        agentId: AGENT,
        kind,
        text,
        ...(pinned ? { pinned: true } : {}),
        newId: idGen(),
      })
    await add('lesson', '教训甲')
    await add('fact', '事实甲')
    await add('commitment', '约定甲')
    await add('preference', '偏好甲')
    await add('lesson', '置顶的教训', true)

    const listed = (await listActiveMemory(store, WS, AGENT)).map((e) => e.text)
    assert.deepEqual(
      listed,
      ['置顶的教训', '约定甲', '偏好甲', '事实甲', '教训甲'],
      '界面从上到下就是"预算不够时先丢下面的"——顺序必须与第一句话一致',
    )
  })

  test('★★ 最多 3 条可置顶；第 4 条被拒，并说清已经钉了几条', async () => {
    const { store } = fakeStore()
    const ids: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const res = await addMemoryEntry(store, {
        workspaceId: WS,
        agentId: AGENT,
        kind: 'fact',
        text: `第 ${i} 条`,
        newId: idGen(),
      })
      assert.equal(res.ok, true)
      if (res.ok) ids.push(res.entry.id as string)
    }
    for (let i = 0; i < 3; i += 1) {
      const r = await setMemoryPinned(store, {
        workspaceId: WS,
        agentId: AGENT,
        entryId: ids[i]!,
        pinned: true,
      })
      assert.equal(r.ok, true, `第 ${i + 1} 条应当能钉`)
    }
    const fourth = await setMemoryPinned(store, {
      workspaceId: WS,
      agentId: AGENT,
      entryId: ids[3]!,
      pinned: true,
    })
    assert.equal(fourth.ok, false)
    if (!fourth.ok) {
      assert.equal(fourth.code, 'pin_limit')
      assert.match(fourth.error, /最多置顶 3 条/)
    }
    // 取消一条之后又能钉了
    await setMemoryPinned(store, { workspaceId: WS, agentId: AGENT, entryId: ids[0]!, pinned: false })
    const retry = await setMemoryPinned(store, {
      workspaceId: WS,
      agentId: AGENT,
      entryId: ids[3]!,
      pinned: true,
    })
    assert.equal(retry.ok, true)
  })

  test('★★ 差量里的置顶超限要**说出来**（不能静默跳过：界面上 ★ 亮着而库里没钉上）', async () => {
    const { store } = fakeStore()
    const ids: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const res = await addMemoryEntry(store, {
        workspaceId: WS,
        agentId: AGENT,
        kind: 'fact',
        text: `第 ${i} 条`,
        newId: idGen(),
      })
      if (res.ok) ids.push(res.entry.id as string)
    }
    const applied = await applyMemoryDelta(store, {
      workspaceId: WS,
      agentId: AGENT,
      delta: {
        pin: ids.map((id) => ({ id, pinned: true })),
      },
    })
    assert.equal(applied.ok, false)
    if (!applied.ok) assert.equal(applied.code, 'pin_limit')
  })
})

describe('记忆：不许把凭据抄进来（分批第 241 批）', () => {
  test('★★ 像密钥的正文被拒，并给出"写变量名"的替代说法', async () => {
    const { store } = fakeStore()
    const cases = [
      '部署用 sk-abcdefghijklmnopqrstuvwx 这个 key',
      '记住 ghp_0123456789abcdefghijABCDEFGHIJ',
      'password=SuperSecret123456',
      'token: abcdefghijklmnop123',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
      '-----BEGIN RSA PRIVATE KEY-----',
    ]
    for (const text of cases) {
      const res = await addMemoryEntry(store, {
        workspaceId: WS,
        agentId: AGENT,
        kind: 'fact',
        text,
        newId: idGen(),
      })
      assert.equal(res.ok, false, `应当拒绝：${text}`)
      if (!res.ok) {
        assert.equal(res.code, 'looks_like_secret')
        assert.match(res.error, /变量名/, '错误里要说清"写变量名、别写值"')
      }
    }
  })

  test('★★ 但"写变量名"本身是允许的（这正是我们想要的行为）', async () => {
    const { store } = fakeStore()
    for (const text of [
      '部署用 $GITHUB_TOKEN（不要把它写进任何文件）',
      'token 从环境变量 GITHUB_TOKEN 里取',
      '这个仓库的 API key 放在 1Password 里，不在这里写',
    ]) {
      const res = await addMemoryEntry(store, {
        workspaceId: WS,
        agentId: AGENT,
        kind: 'fact',
        text,
        newId: idGen(),
      })
      assert.equal(res.ok, true, `不该拒绝：${text}`)
    }
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

/**
 * ★ 端到端：记忆**真的进了第一句话**，而且"用过"被记了一笔。
 *
 * 这一条把三处串起来：接口写进去 → 执行器组装第一句话（`buildBlocks`）→ 记账
 * （`useCount`）。任何一处断了，界面上都会看起来正常（记忆列表有、跑得也正常），
 * 只是它从没被用上——那正是最需要一条端到端断言的地方。
 */
describe('「整理成记忆」：真的分析整段对话（分批第 243 批）', () => {
  test('★★★ 起一条分析 run（读整段对话）→ 解析出候选 → 人确认才写进记忆', async () => {
    const dir = await makeTempDir('memory-tidy-e2e')
    /** 它收到的第一句话（含 transcript 的内容说明）——用来断言"整段对话被交过去了"。 */
    const prompts: string[] = []
    const d = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      backend: {
        key: 'claude',
        protocol: 'stream-json',
        rejectDetectable: true,
        async probe() {
          return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
        },
        async execute(opts: { prompt?: string; systemPrompt?: string | null }) {
          prompts.push(deliveredText(opts as never))
          const { AsyncQueue } = await import('@agentdeck/agent-core')
          const queue = new AsyncQueue<never>()
          /**
           * ⚠️ 产出要**当一条 `text` 消息**推进队列，而不是只填 `result.output`：
           *    daemon 只把流里的消息落进 `messages.jsonl`，`result.output` 不进记录
           *    （真 adapter 也是靠流吐 text 的）。第一版只填了 `output`，于是平台
           *    读到的"最后一段正文"是空的 ⇒ 解析必然失败（而 run 是 completed，
           *    看起来一切正常）。
           */
          queue.push({
            type: 'text',
            content:
              '我读了整段对话：\n```json\n[' +
              // 出处能在人的话里找到 ⇒ grounded
              '{"kind":"fact","text":"这个仓库用 pnpm","from":"这个仓库用 pnpm，别用 npm"},' +
              // 出处对不上 ⇒ 仍然列出来，但 grounded=false（界面默认不勾）
              '{"kind":"fact","text":"distilly 用 python 写","from":"我说过 distilly 用 python"},' +
              '{"kind":"opinion","text":"我觉得还行"},' +
              '{"kind":"fact","text":"token 是 sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF"}' +
              ']\n```',
          } as never)
          queue.close()
          /**
           * 假 CLI 的"产出"：一个带围栏的 JSON（模型最常见的写法）。
           * ⚠️ 里面有一条**看起来像密钥**的，一条类型不认识的——它们必须被剔掉，
           *    而且界面要能说出剔了几条。
           */
          terminalState.push('completed')
          return {
            messages: queue,
            result: Promise.resolve({
              status: 'completed',
              output:
                '我读了整段对话：\n```json\n[' +
                '{"kind":"fact","text":"这个仓库用 pnpm"},' +
                '{"kind":"preference","text":"说话短一点"},' +
                '{"kind":"opinion","text":"我觉得还行"},' +
                '{"kind":"fact","text":"token 是 sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF"}' +
                ']\n```',
              durationMs: 1,
              sessionId: 'tidy',
              usage: { inputTokens: 0, outputTokens: 0, costUsdMicros: 0, costSource: 'provider' },
              exitCode: 0,
            }),
            async cancel() {
              queue.close()
            },
            lastActivityAt: () => Date.now(),
          }
        },
      } as never,
      onWarn: () => {},
    })
    const terminalState: string[] = []
    try {
      const created = await fetch(`${d.url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '整理执行者', instructions: '你是干活的' }),
      })
      const agent = (await created.json()) as { id: string }

      // 先有一段对话（否则"没有内容可整理"）
      const conv = await fetch(`${d.url}/api/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: agent.id, text: '这个仓库用 pnpm，别用 npm' }),
      })
      assert.equal(conv.status, 201, await conv.clone().text())
      const conversation = (await conv.json()) as { conversation: { id: string } }
      const conversationId = conversation.conversation.id

      // 等第一轮跑完（分析要读它的产出）
      const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
      const waitRuns = async (): Promise<void> => {
        const deadline = Date.now() + 8000
        for (;;) {
          const runs = (await (await fetch(`${d.url}/api/runs`)).json()) as {
            runs: Array<{ status: string }>
          }
          if (runs.runs.length > 0 && runs.runs.every((r) => TERMINAL.has(r.status))) return
          if (Date.now() > deadline) throw new Error('等 run 结束超时')
          await new Promise((r) => setTimeout(r, 25))
        }
      }
      await waitRuns()

      // ── ① 起整理 ──
      const start = await fetch(`${d.url}/api/conversations/${conversationId}/memory-tidy`, {
        method: 'POST',
      })
      assert.equal(start.status, 202, await start.clone().text())
      const { tidyRunId } = (await start.json()) as { tidyRunId: string }
      assert.ok(tidyRunId !== '')
      await waitRuns()

      // ── ② 读结果：解析成候选，坏的两条被剔掉 ──
      const got = await fetch(
        `${d.url}/api/conversations/${conversationId}/memory-tidy/${tidyRunId}`,
      )
      assert.equal(got.status, 200)
      const answer = (await got.json()) as {
        status: string
        candidates: Array<{ kind: string; text: string; from: string | null; grounded: boolean }>
        dropped: Array<{ reason: string }>
        parsed: boolean
      }
      assert.equal(answer.parsed, true)
      assert.deepEqual(
        answer.candidates.map((c) => `${c.kind}:${c.text}`),
        ['fact:这个仓库用 pnpm', 'fact:distilly 用 python 写'],
      )
      /**
       * ★★ 分批第 244 批：**出处由平台核对**，不是它说了算。
       *
       * 使用者的例子：他只说了一句「分析 https://…，让我理解其做法和功能」，平台却
       * 整理出了记忆——那是它自己查到的。所以"有没有人的原话"这件事不能只靠提示词，
       * 平台要自己核一遍：对得上的标 `grounded`，对不上的照样列出来（决定权在人），
       * 但界面上默认不勾。
       */
      assert.deepEqual(
        answer.candidates.map((c) => c.grounded),
        [true, false],
        '★ 第一条的出处能在人的话里找到，第二条找不到',
      )
      assert.deepEqual(
        answer.dropped.map((x) => x.reason).sort(),
        ['kind_invalid', 'looks_like_secret'],
        '★ 类型不认识与像密钥的都要剔掉并报出来',
      )

      // ── ③ 那条分析 run 读的是**整段对话**（transcript 落进了它的工作目录）──
      const runs = (await (await fetch(`${d.url}/api/runs`)).json()) as {
        runs: Array<{ runId: string; subject: { type: string; id: string } }>
      }
      const tidyRun = runs.runs.find((r) => r.subject.type === 'memory-tidy')
      assert.ok(tidyRun, '有一条 subject 是 memory-tidy 的 run')
      assert.equal(tidyRun.subject.id, conversationId, 'subject id 是对话 id（不是 run id）')
      const runDetail = (await (await fetch(`${d.url}/api/runs/${tidyRun.runId}`)).json()) as {
        workDir: string
      }
      const transcript = await readFile(`${runDetail.workDir}/transcript.md`, 'utf8')
      assert.match(transcript, /这个仓库用 pnpm，别用 npm/, '★ 人的话在正文里')
      assert.match(transcript, /## 第 1 轮/)

      // ── ④ **人确认之后**才写进记忆（分析本身没有写权限）──
      const before = (await (await fetch(`${d.url}/api/agents/${agent.id}`)).json()) as {
        memory: unknown[]
      }
      assert.equal(before.memory.length, 0, '分析完还没有记忆')
      const write = await fetch(`${d.url}/api/agents/${agent.id}/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 界面上只会把**勾中的**交过来（默认勾的是 grounded 那些）——这里照那个语义走
        body: JSON.stringify({
          entries: answer.candidates
            .filter((c) => c.grounded)
            .map((c) => ({ kind: c.kind, text: c.text, evidence: tidyRunId })),
        }),
      })
      assert.equal(write.status, 201, await write.clone().text())
      const after = (await (await fetch(`${d.url}/api/agents/${agent.id}`)).json()) as {
        memory: Array<{ text: string; evidence: string | null }>
      }
      assert.equal(after.memory.length, 1, '只有"有出处"的那一条被交上去')
      assert.equal(after.memory[0]?.evidence, tidyRunId, '出处记的是这次整理那条 run')
    } finally {
      await d.close()
      await cleanup(dir)
    }
  })
})

describe('记忆：磁盘镜像跟着写（分批第 241 批）', () => {
  test('★★ 详情页保存 / 聊天入口 写记忆之后，<memoryRoot>/<agentId>/MEMORY.md 跟着更新', async () => {
    const dir = await makeTempDir('memory-mirror-api')
    const mirrorRoot = `${dir}-mirror`
    const d = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      memoryRoot: mirrorRoot,
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
        body: JSON.stringify({ name: '镜像测试', instructions: '你是干活的' }),
      })
      const agent = (await created.json()) as { id: string }
      const mirror = `${mirrorRoot}/${agent.id}/MEMORY.md`

      // ① 聊天入口（POST /memory）
      await fetch(`${d.url}/api/agents/${agent.id}/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'lesson', text: '别直接改 dist' }),
      })
      const first = await readFile(mirror, 'utf8')
      assert.match(first, /# 记忆：镜像测试/)
      assert.match(first, /别直接改 dist/)
      assert.match(first, /改这个文件\*\*不会生效\*\*/, '★ 镜像必须自己说清不是权威')

      // ② 详情页保存（PATCH agent 的记忆差量）——镜像同样要跟上
      await fetch(`${d.url}/api/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ memory: { add: [{ kind: 'preference', text: '说话短一点' }] } }),
      })
      const second = await readFile(mirror, 'utf8')
      assert.match(second, /说话短一点/)
      assert.match(second, /共 2 条/)

      // ③ 删一条（DELETE /memory/{id}）之后镜像里不该再有它
      const detail = (await (await fetch(`${d.url}/api/agents/${agent.id}`)).json()) as {
        memory: Array<{ id: string; text: string }>
      }
      const target = detail.memory.find((e) => e.text === '别直接改 dist')
      assert.ok(target)
      await fetch(`${d.url}/api/agents/${agent.id}/memory/${target.id}`, { method: 'DELETE' })
      const third = await readFile(mirror, 'utf8')
      assert.doesNotMatch(third, /别直接改 dist/, '删掉的条目从镜像里消失')
      assert.match(third, /说话短一点/)
      assert.match(third, /共 1 条/)
    } finally {
      await d.close()
      await cleanup(dir)
      await cleanup(mirrorRoot)
    }
  })
})

describe('记忆：真的进了第一句话（端到端）', () => {
  test('★★★ 一轮对话的第一句话里有那几条记忆，跑完之后 useCount 变成 1', async () => {
    const dir = await makeTempDir('memory-prompt')
    const prompts: string[] = []
    const d = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      backend: {
        key: 'claude',
        protocol: 'stream-json',
        rejectDetectable: true,
        async probe() {
          return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
        },
        async execute(opts: { prompt?: string; systemPrompt?: string | null }) {
          // ⚠️ 用 `deliveredText`：A 档下 ①② 在 systemPrompt 里、③ 在 prompt 里——
          //    只读 `opts.prompt` 会漏掉身份（而记忆就挂在身份那一块里）。
          prompts.push(deliveredText(opts as never))
          const { AsyncQueue } = await import('@agentdeck/agent-core')
          const queue = new AsyncQueue<never>()
          queue.close()
          return {
            messages: queue,
            result: Promise.resolve({
              status: 'completed',
              output: '好',
              durationMs: 1,
              sessionId: 'mem',
              usage: { inputTokens: 0, outputTokens: 0, costUsdMicros: 0, costSource: 'provider' },
              exitCode: 0,
            }),
            async cancel() {
              queue.close()
            },
            lastActivityAt: () => Date.now(),
          }
        },
      } as never,
      onWarn: () => {},
    })
    try {
      const created = await fetch(`${d.url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '记忆执行者', instructions: '你是干活的' }),
      })
      const agent = (await created.json()) as { id: string }
      await fetch(`${d.url}/api/agents/${agent.id}/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'commitment', text: '报告里不许出现"赋能"这类词' }),
      })

      const conv = await fetch(`${d.url}/api/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: agent.id, text: '帮我写一份周报' }),
      })
      assert.equal(conv.status, 201, await conv.clone().text())

      /**
       * 等这一轮跑到**终态**。
       *
       * ⚠️ 判据要用白名单（终态三种），不能只排除 `running`/`queued`：那一轮在真正
       *    执行前还经过 `dispatched` 这类中间态，只排除两个会让循环**在它跑起来之前**
       *    就退出——第一版就是这么拿到空 `prompts` 的（断言说的是"第一句话里没有记忆"，
       *    而真正的原因是"还没跑"）。
       */
      const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
      const deadline = Date.now() + 8000
      for (;;) {
        const runs = (await (await fetch(`${d.url}/api/runs`)).json()) as {
          runs: Array<{ status: string }>
        }
        if (runs.runs.length > 0 && runs.runs.every((r) => TERMINAL.has(r.status))) break
        if (Date.now() > deadline) throw new Error('等 run 结束超时')
        await new Promise((r) => setTimeout(r, 25))
      }

      const delivered = prompts.join('\n=== NEXT ===\n')
      assert.match(delivered, /过去记下的经验/, '★ 第一句话里要有「经验」这一块')
      assert.match(delivered, /- \[约定\] 报告里不许出现"赋能"这类词/, '★ 具体那一条也在')
      assert.match(
        delivered,
        /你是干活的[\s\S]*过去记下的经验/,
        '顺序：人设 → 经验（记忆排在身份之后）',
      )

      const after = (await (await fetch(`${d.url}/api/agents/${agent.id}`)).json()) as {
        memory: Array<{ useCount: number; lastUsedAt: number | null }>
      }
      assert.equal(after.memory[0]?.useCount, 1, '跑完之后记了一次"用上了"')
      assert.equal(typeof after.memory[0]?.lastUsedAt, 'number', '最近使用时间跟着写')
    } finally {
      await d.close()
      await cleanup(dir)
    }
  })
})
