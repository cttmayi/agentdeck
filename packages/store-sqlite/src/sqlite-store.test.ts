import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { IllegalTransitionError, type RunPatch } from '@agentdeck/domain'
import {
  agentId,
  conversationId,
  makeAgent,
  makeChatTurn,
  makeConversation,
  makeIssue,
  makeReport,
  makeRun,
  makeSkill,
  makeTool,
  runId,
  toolId,
  wsId,
} from '@agentdeck/domain/testing'
import type { ActionId, BlobRef, RunMessage, RunStatus, VerdictId } from '@agentdeck/protocol'
import {
  SQLITE_STORE_FORMAT_VERSION,
  SqliteStore,
  sqliteStorePath,
} from './sqlite-store.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { loosePatch } from './testing/patches.ts'

let dir: string
let store: SqliteStore

const WS = wsId('ws-1')

/** 造一条执行消息。除 seq / content 外全都固定，免得测试被无关字段干扰。 */
function msg(seq: number, content = `m${seq}`): RunMessage {
  return {
    seq,
    type: 'text',
    tool: null,
    content,
    input: null,
    output: null,
    outputTruncated: false,
    // ★ 故意用同一时间戳：补齐必须靠 seq，不能靠时间（FR-BRIDGE-18）
    at: 1000,
  }
}

before(async () => {
  dir = await makeTempDir('sqlite')
  store = await SqliteStore.open({ dataDir: dir, fsync: false })
  await store.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: '默认', createdAt: Date.now(), updatedAt: Date.now() })
})

after(async () => {
  await store.close()
  await cleanup(dir)
})

describe('基本 CRUD 与持久化', () => {
  test('写入 agent / skill / issue 后可读回', async () => {
    const agent = makeAgent({ id: 'a1', workspaceId: WS, skillIds: [makeSkill({ id: 's1' }).id] })
    const skill = makeSkill({ id: 's1', workspaceId: WS, slug: 'sec-vuln' })
    const issue = makeIssue({ id: 'i1', workspaceId: WS, title: '改一下' })

    await store.insertAgent(agent)
    await store.insertSkill(skill)
    await store.insertIssue(issue)

    assert.equal((await store.getAgent(agentId('a1')))?.id, 'a1')
    assert.equal((await store.getSkill(skill.id))?.slug, 'sec-vuln')
    assert.equal((await store.getIssue(issue.id))?.title, '改一下')
    assert.deepEqual(
      (await store.listSkillsByIds([skill.id])).map((s) => s.id),
      ['s1'],
    )
    // IN () 是语法错误：空集合必须单独处理，不能让空数组走到 SQL 里
    assert.deepEqual(await store.listSkillsByIds([]), [])
  })

  test('★ 关闭后重开，且**不需要先列举**就能跨 workspace 查到数据', async () => {
    /**
     * 这条用例是针对文件适配器真实踩过的坑写的：那边每个 workspace 的存储
     * 是懒建的，而 `getAgent` 这类查询靠遍历内存里的 store 集合，于是重开
     * 进程后集合是空的，所有跨 workspace 查询都返回 null——数据好好躺在
     * 日志里，却表现为"数据丢了"。所以这里特意**不调用任何列举方法**，
     * 直接在重开后就查。
     */
    const reopenDir = await makeTempDir('reopen')
    try {
      const a = await SqliteStore.open({ dataDir: reopenDir, fsync: false })
      await a.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await a.insertAgent(makeAgent({ id: 'persist-me', workspaceId: WS }))
      await a.close()

      const b = await SqliteStore.open({ dataDir: reopenDir, fsync: false })
      assert.equal((await b.getAgent(agentId('persist-me')))?.id, 'persist-me')
      assert.equal(await b.formatVersion(), SQLITE_STORE_FORMAT_VERSION)
      await b.close()
    } finally {
      await cleanup(reopenDir)
    }
  })

  test('列表按 id 排序并支持游标分页', async () => {
    const d = await makeTempDir('page')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      for (let i = 0; i < 5; i++) {
        await s.insertIssue(makeIssue({ id: `issue-${i}`, workspaceId: WS }))
      }

      const p1 = await s.listIssues({ workspaceId: WS, limit: 2 })
      assert.equal(p1.items.length, 2)
      assert.notEqual(p1.nextCursor, null)

      const p2 = await s.listIssues({ workspaceId: WS, limit: 2, cursor: p1.nextCursor })
      assert.equal(p2.items.length, 2)
      assert.notEqual(p2.items[0]?.id, p1.items[0]?.id)

      const last = await s.listIssues({ workspaceId: WS, limit: 10 })
      assert.equal(last.nextCursor, null)
      assert.equal(last.items.length, 5)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('★ 游标不被结果集包含时也要继续/终止，绝不回头重放', async () => {
    /**
     * 游标那条**不在候选集里**有三种真实来源：被状态过滤排掉、来自别的
     * workspace、调用方传来一个垃圾值。端口里没有删除操作，所以"游标条目被
     * 删掉"在可观测层面就等价于"游标不在这一页的候选集里"。
     *
     * 旧的文件实现用 `findIndex(id === cursor) + 1`，游标不在时起点退回 0，
     * 于是客户端在第一页上永远打转且毫无报错——这个测试就是为了不让那种
     * 行为以任何形式回来。
     */
    const d = await makeTempDir('cursor-gone')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      for (const [id, status] of [
        ['a', 'todo'],
        ['b', 'done'],
        ['c', 'todo'],
        ['d', 'todo'],
      ] as const) {
        await s.insertIssue(makeIssue({ id, workspaceId: WS, status }))
      }

      const p1 = await s.listIssues({ workspaceId: WS, limit: 2 })
      assert.deepEqual(p1.items.map((i) => i.id), ['a', 'b'])
      assert.equal(p1.nextCursor, 'b')

      // 游标被状态过滤排掉（'b' 是 done，这一页只要 todo）⇒ 从它的位置继续
      const filtered = await s.listIssues({ workspaceId: WS, status: ['todo'], limit: 2, cursor: 'b' })
      assert.deepEqual(filtered.items.map((i) => i.id), ['c', 'd'])

      // 游标指向别的 workspace / 未知对象：'a9' 大于全部 ⇒ 空页且必须终止
      const beyond = await s.listIssues({ workspaceId: WS, cursor: 'zzz', limit: 2 })
      assert.deepEqual(beyond.items, [])
      assert.equal(beyond.nextCursor, null, '必须终止，否则调用方会一直问下去')

      // 小于全部 ⇒ 全部都在它之后（不是"找不到就从头"那种偶然的正确）
      const before = await s.listIssues({ workspaceId: WS, cursor: '0', limit: 2 })
      assert.deepEqual(before.items.map((i) => i.id), ['a', 'b'])
      assert.equal(before.nextCursor, 'b')

      // 恰好是最后一条 ⇒ 空页 + 终止
      const atEnd = await s.listIssues({ workspaceId: WS, cursor: 'd', limit: 2 })
      assert.deepEqual(atEnd, { items: [], nextCursor: null })
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('已知差异：id 含星平面字符时，SQL 的 BINARY 序与文件适配器的 JS 代码单元序相反', async () => {
    /**
     * ⚠️ 这条测试**不是**在断言"这样更好"，而是把一处**实测到的、有意的差异**
     * 钉住，免得将来有人重新发现它、或者以为它是偶然：
     *
     *   JS：`U+1F600` 的 UTF-16 代码单元是 `D83D DE00` < `U+FFFD`
     *   SQL BINARY：`U+1F600` 的 UTF-8 是 `F0 9F 98 80` > `U+FFFD` 的 `EF BF BD`
     *
     * 所以含 emoji 的 id 在两个适配器上顺序相反，游标语义也随之不同。它**不可达**：
     * 端口的游标约定是"ULID，天然可排序"，而 ULID 是 ASCII，两种序在 ASCII 上
     * 完全一致。要对齐就得存一列手工算出的 UTF-16 排序键（双份真相），代价换不到
     * 任何可达场景，所以选择保留差异并写清楚。
     */
    const d = await makeTempDir('collation')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      const ids = ['m', 'z', '\uFFFD', '\u{1F600}']
      for (const id of ids) await s.insertIssue(makeIssue({ id, workspaceId: WS }))

      const ordered = (await s.listIssues({ workspaceId: WS })).items.map((i) => i.id)
      assert.deepEqual(ordered, ['m', 'z', '\uFFFD', '\u{1F600}'], 'BINARY（UTF-8 字节）序')
      // JS 的代码单元序会是 ['m', 'z', '\u{1F600}', '\uFFFD']——两者在星平面上相反
      assert.deepEqual(
        await s.listIssues({ workspaceId: WS, cursor: '\u{1F600}' }),
        { items: [], nextCursor: null },
      )
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('issue 支持状态过滤与子串检索（目录管理，FR-ISSUE-09/10）', async () => {
    const d = await makeTempDir('query')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await s.insertIssue(makeIssue({ id: 'i-a', workspaceId: WS, title: '依赖漏洞', status: 'todo' }))
      await s.insertIssue(
        makeIssue({ id: 'i-b', workspaceId: WS, title: '文档错别字', status: 'done' }),
      )

      const todo = await s.listIssues({ workspaceId: WS, status: ['todo'] })
      assert.deepEqual(todo.items.map((i) => i.id), ['i-a'])

      const searched = await s.listIssues({ workspaceId: WS, search: '漏洞' })
      assert.deepEqual(searched.items.map((i) => i.id), ['i-a'])

      const byAssignee = await s.listIssues({ workspaceId: WS, assigneeId: 'nobody' })
      assert.equal(byAssignee.items.length, 0)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('★ listWorkspaceIds 按创建顺序返回——顺序就是"默认工作区"的语义', async () => {
    const d = await makeTempDir('wsids')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      // 故意让 id 的字典序与创建顺序相反：按 id 排序会给出错误的默认工作区
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: wsId('zzz-first'), name: 'z', createdAt: 1, updatedAt: 1 })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: wsId('aaa-second'), name: 'a', createdAt: 2, updatedAt: 2 })

      assert.deepEqual(await s.listWorkspaceIds(), [wsId('zzz-first'), wsId('aaa-second')])
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('device 是单例，重复写入即覆盖（不是插出第二台设备）', async () => {
    const d = await makeTempDir('device')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      assert.equal(await s.getDevice(), null)
      await s.upsertDevice({ id: 'dev-1' as never, name: '本机', createdAt: 1, lastSeenAt: 1 })
      await s.upsertDevice({ id: 'dev-1' as never, name: '本机', createdAt: 1, lastSeenAt: 9 })
      assert.equal((await s.getDevice())?.lastSeenAt, 9)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })
})

/**
 * 工具包（D40）的读写。
 *
 * 与 `store-file` 的那一组逐条对齐（同一套端口语义），所以这里只挑 SQL 侧
 * 真正会走样的地方多说一句：`listTools` 按 **rowid** 返回（等于写入顺序），
 * `getToolBySlug` 走的是 `(workspace_id, slug)` 上的索引——索引**故意不是唯一
 * 索引**，理由写在 `sqlite-store.ts` 的建表处（唯一约束会把"装了同 slug 的包"
 * 从"覆盖写入"变成"报错"，那是与文件适配器不一致的行为改变）。
 */
describe('工具包（D40）：CRUD 与卸载', () => {
  const WSA = wsId('ws-tool-a')
  const WSB = wsId('ws-tool-b')

  async function openScratch(prefix: string): Promise<{ store: SqliteStore; dir: string }> {
    const dir = await makeTempDir(prefix)
    const s = await SqliteStore.open({ dataDir: dir, fsync: false })
    for (const [id, name] of [
      [WSA, 'A'],
      [WSB, 'B'],
    ] as const) {
      await s.insertWorkspace({
        executeTemplate: '',
        reviewTemplate: '', chatTemplate: '',
        defaultAgentId: null,
        locale: 'zh',
        id,
        name,
        createdAt: 1,
        updatedAt: 1,
      })
    }
    return { store: s, dir }
  }

  test('插进去能取到，且按 workspace 隔离', async () => {
    const { store: s, dir } = await openScratch('tool-crud')
    try {
      await s.insertTool(makeTool({ id: 't1', workspaceId: WSA, slug: 'deploy' }))
      await s.insertTool(makeTool({ id: 't2', workspaceId: WSA, slug: 'lint' }))
      await s.insertTool(makeTool({ id: 't3', workspaceId: WSB, slug: 'deploy' }))

      assert.equal((await s.getTool(toolId('t1')))?.slug, 'deploy')
      assert.equal((await s.getTool(toolId('t3')))?.workspaceId, WSB)
      assert.equal(await s.getTool(toolId('nope')), null)

      assert.deepEqual((await s.listTools(WSA)).map((t) => t.slug), ['deploy', 'lint'])
      assert.deepEqual((await s.listTools(WSB)).map((t) => t.slug), ['deploy'])
    } finally {
      await s.close()
      await cleanup(dir)
    }
  })

  test('listToolsByIds 批量取，且与传入顺序无关、空集合不炸', async () => {
    const { store: s, dir } = await openScratch('tool-byids')
    try {
      await s.insertTool(makeTool({ id: 't1', workspaceId: WSA, slug: 'deploy' }))
      await s.insertTool(makeTool({ id: 't2', workspaceId: WSA, slug: 'lint' }))
      await s.insertTool(makeTool({ id: 't3', workspaceId: WSB, slug: 'deploy' }))

      assert.deepEqual(
        (await s.listToolsByIds([toolId('t3'), toolId('t1')])).map((t) => t.id).sort(),
        ['t1', 't3'],
      )
      assert.deepEqual(
        (await s.listToolsByIds([toolId('t1'), toolId('t3')])).map((t) => t.id).sort(),
        ['t1', 't3'],
      )
      // IN () 是语法错误：空集合必须提前返回
      assert.deepEqual(await s.listToolsByIds([]), [])
    } finally {
      await s.close()
      await cleanup(dir)
    }
  })

  test('★ getToolBySlug 命中与未命中，且同名 slug 只在本 workspace 内唯一', async () => {
    const { store: s, dir } = await openScratch('tool-slug')
    try {
      await s.insertTool(makeTool({ id: 't1', workspaceId: WSA, slug: 'deploy' }))
      await s.insertTool(makeTool({ id: 't3', workspaceId: WSB, slug: 'deploy' }))

      assert.equal((await s.getToolBySlug(WSA, 'deploy'))?.id, 't1')
      assert.equal(await s.getToolBySlug(WSA, 'nope'), null)
      assert.equal(
        (await s.getToolBySlug(WSB, 'deploy'))?.id,
        't3',
        '★ 查询必须带上 workspace_id：否则会把别人空间的包当成自己的',
      )
    } finally {
      await s.close()
      await cleanup(dir)
    }
  })

  test('★ 卸载：删得掉、删两次第二次返回 false（幂等，不是错误）、别的 workspace 不受影响', async () => {
    const { store: s, dir } = await openScratch('tool-uninstall')
    try {
      await s.insertTool(makeTool({ id: 't1', workspaceId: WSA, slug: 'deploy' }))
      await s.insertTool(makeTool({ id: 't2', workspaceId: WSA, slug: 'lint' }))
      await s.insertTool(makeTool({ id: 't3', workspaceId: WSB, slug: 'deploy' }))

      assert.equal(await s.deleteTool(toolId('t1')), true)
      // `changes = 0` ⇒ false：删一个已经不在的记录是幂等，不是错误
      assert.equal(await s.deleteTool(toolId('t1')), false, '"它已经不在了"不是错误')
      assert.equal(await s.deleteTool(toolId('ghost')), false)

      assert.equal(await s.getTool(toolId('t1')), null)
      assert.equal(await s.getToolBySlug(WSA, 'deploy'), null)
      assert.deepEqual((await s.listTools(WSA)).map((t) => t.slug), ['lint'])
      assert.deepEqual(await s.listToolsByIds([toolId('t1')]), [])

      assert.deepEqual((await s.listTools(WSB)).map((t) => t.slug), ['deploy'])
      assert.equal((await s.getToolBySlug(WSB, 'deploy'))?.id, 't3')
    } finally {
      await s.close()
      await cleanup(dir)
    }
  })

  test('★ 关闭后重开：工具包还在，清单 / 包内文件 / slug 查询都完好', async () => {
    /**
     * 本适配器是**就地更新**（删掉就真删掉了），不像文件适配器要回放 `del`
     * 记录，所以这条用例盯着的是另一件事：清单（`manifest`）与包内文件
     * （`files`）是整个 JSON 的一部分，重开后必须逐字回来——半截持久化
     * （只存对了 id 与 slug）在界面上看起来"包还在"，实际根本执行不了。
     */
    const dir = await makeTempDir('tool-reopen')
    try {
      const a = await SqliteStore.open({ dataDir: dir, fsync: false })
      await a.insertWorkspace({
        executeTemplate: '',
        reviewTemplate: '', chatTemplate: '',
        defaultAgentId: null,
        locale: 'zh',
        id: WSA,
        name: 'A',
        createdAt: 1,
        updatedAt: 1,
      })
      await a.insertTool(makeTool({ id: 'tool-1', workspaceId: WSA, slug: 'deploy' }))
      await a.insertTool(makeTool({ id: 'tool-gone', workspaceId: WSA, slug: 'obsolete' }))
      await a.deleteTool(toolId('tool-gone'))
      await a.close()

      const b = await SqliteStore.open({ dataDir: dir, fsync: false })
      const back = await b.getTool(toolId('tool-1'))
      assert.equal(back?.slug, 'deploy')
      assert.equal(back?.manifest.actions[0]?.name, 'run')
      assert.deepEqual(back?.files, { 'index.mjs': '// 空实现\n' })
      assert.equal((await b.getToolBySlug(WSA, 'deploy'))?.id, 'tool-1')
      assert.deepEqual((await b.listTools(WSA)).map((t) => t.slug), ['deploy'])
      await b.close()
    } finally {
      await cleanup(dir)
    }
  })
})

describe('CAS 状态转移（端口的支点）', () => {
  const RID = runId('run-cas')

  test('前态匹配 ⇒ 转移成功', async () => {
    await store.insertRun(makeRun({ id: 'run-cas', workspaceId: WS, agentId: 'a1' }))
    assert.equal(await store.transitionRun(RID, 'queued', 'dispatched'), true)
    assert.equal((await store.getRun(RID))?.status, 'dispatched')
  })

  test('★ 前态不匹配 ⇒ 返回 false，且**不写入**', async () => {
    assert.equal(await store.transitionRun(RID, 'queued', 'dispatched'), false)
    assert.equal((await store.getRun(RID))?.status, 'dispatched', '状态不应被改动')
  })

  test('可以携带 patch（绝对赋值）', async () => {
    assert.equal(
      await store.transitionRun(RID, 'dispatched', 'running', {
        startedAt: 123,
        workDir: '/repo/x',
      }),
      true,
    )
    const run = await store.getRun(RID)
    assert.equal(run?.startedAt, 123)
    assert.equal(run?.workDir, '/repo/x')
  })

  test('★ 非法转移当场抛错，而不是写进一个非法状态', async () => {
    await assert.rejects(
      () => store.transitionRun(RID, 'running', 'queued'),
      (err: unknown) => {
        assert.ok(err instanceof IllegalTransitionError)
        return true
      },
    )
    assert.equal((await store.getRun(RID))?.status, 'running', '状态不应被改动')
  })

  test('★ 前态不匹配时不该抛状态机错——并发下的正常失败不能变成异常', async () => {
    // 终态没有出边，但如果前态本来就不匹配，应当是安静的 false（先判 CAS 再校验状态机）
    assert.equal(await store.transitionRun(RID, 'queued', 'running'), false)
  })

  test('终态没有出边——重试必须新建 run（DR-3）', async () => {
    assert.equal(await store.transitionRun(RID, 'running', 'completed', { finishedAt: 200 }), true)
    await assert.rejects(() => store.transitionRun(RID, 'completed', 'running'))
  })

  test('不存在的 run ⇒ false（不抛）', async () => {
    assert.equal(await store.transitionRun(runId('nope'), 'queued', 'dispatched'), false)
  })

  test('★ 同时发起多个相同 CAS，只有一个成功（UPDATE ... WHERE 才是裁判）', async () => {
    const d = await makeTempDir('cas-race')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await s.insertRun(makeRun({ id: 'r-race', workspaceId: WS, agentId: 'a1' }))

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          s.transitionRun(runId('r-race'), 'queued', 'dispatched', { dispatchedAt: 7 }),
        ),
      )
      assert.equal(results.filter(Boolean).length, 1, '只能有一次转移成功')
      assert.equal((await s.getRun(runId('r-race')))?.status, 'dispatched')
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('★ 别人（另一个连接）改了状态，本地 CAS 必须失败——不能信缓存', async () => {
    /**
     * 这条是"CAS 由 SQL 的 WHERE 承担"的直接证据：进程内我们没机会插进
     * 读与写之间，但**另一个进程**可以。文件适配器曾经因为依赖内存里的
     * 状态而在这个场景下写错，这里必须失败而不是覆盖别人的写入。
     */
    const d = await makeTempDir('cas-foreign')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await s.insertRun(makeRun({ id: 'r-foreign', workspaceId: WS, agentId: 'a1' }))

      const raw = new DatabaseSync(sqliteStorePath(d))
      raw
        .prepare(`UPDATE run SET json = ? WHERE id = ?`)
        .run(
          JSON.stringify(makeRun({ id: 'r-foreign', workspaceId: WS, agentId: 'a1', status: 'cancelled' })),
          'r-foreign',
        )
      raw.close()

      assert.equal(await s.transitionRun(runId('r-foreign'), 'queued', 'dispatched'), false)
      assert.equal((await s.getRun(runId('r-foreign')))?.status, 'cancelled')
      await s.close()
    } finally {
      await cleanup(d)
    }
  })
})

describe('patch 的 undefined / null 语义', () => {
  test('★ patch 里的 undefined 不得清空已存的值，null 才清空', async () => {
    const d = await makeTempDir('patch')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      const rid = runId('r-patch')
      await s.insertRun(makeRun({ id: 'r-patch', workspaceId: WS, agentId: 'a1' }))
      await s.transitionRun(rid, 'queued', 'dispatched', {
        workDir: '/repo',
        waitReason: '被占用',
      })

      /**
       * `exactOptionalPropertyTypes` 下，`{ ...当前值, ...patch }` 里只要 patch
       * 带上了某个键（哪怕值是 undefined），就会把已存的值覆盖成 undefined。
       * 而 patch 在真实调用点是拼出来的——类型说是 `string | null`，运行时却
       * 可能是 undefined，所以"没提到就不改"必须靠 pruneUndefined 显式实现。
       */
      await s.transitionRun(
        rid,
        'dispatched',
        'running',
        loosePatch<RunPatch>({ waitReason: undefined }),
      )
      const kept = await s.getRun(rid)
      assert.equal(kept?.waitReason, '被占用', 'undefined 不应清空字段')
      assert.equal(kept?.workDir, '/repo')

      await s.transitionRun(rid, 'running', 'completed', { waitReason: null })
      assert.equal((await s.getRun(rid))?.waitReason, null, 'null 才是清空')
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('issue 的 patch 同样区分 undefined 与 null，并刷新 updatedAt', async () => {
    const d = await makeTempDir('patch-issue')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await s.insertIssue(
        makeIssue({
          id: 'i-p',
          workspaceId: WS,
          title: '原标题',
          priority: 'high',
          assignee: { type: 'agent', id: 'a1' },
        }),
      )

      assert.equal(
        await s.transitionIssue(
          'i-p' as never,
          'todo',
          'in_progress',
          loosePatch({ title: undefined }),
        ),
        true,
      )
      const after = await s.getIssue('i-p' as never)
      assert.equal(after?.title, '原标题', 'undefined 不应清空标题')
      assert.equal(after?.priority, 'high')
      assert.equal(after?.status, 'in_progress')
      assert.ok((after?.updatedAt ?? 0) > 1, 'updatedAt 应被刷新')

      assert.equal(await s.transitionIssue('i-p' as never, 'todo', 'done'), false, '前态已不匹配')
      assert.equal(
        await s.transitionIssue('i-p' as never, 'in_progress', 'done', { assignee: null }),
        true,
      )
      assert.equal((await s.getIssue('i-p' as never))?.assignee, null)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })
})

describe('工作目录串行化（D20）', () => {
  test('★ 同一目录被占用时可被查出——这是 waiting_local_directory 的依据', async () => {
    const d = await makeTempDir('workdir')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await s.insertRun(
        makeRun({
          id: 'r-hold',
          workspaceId: WS,
          agentId: 'a1',
          status: 'running',
          workDir: '/repo',
        }),
      )

      assert.equal((await s.findRunHoldingWorkDir('/repo'))?.id, 'r-hold')
      // 排除自己时不算占用（自己当然占着）
      assert.equal(await s.findRunHoldingWorkDir('/repo', runId('r-hold')), null)
      // 别的目录不算
      assert.equal(await s.findRunHoldingWorkDir('/other'), null)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('★ 只有非终态算占用；queued 还没被受理，不算占用', async () => {
    const d = await makeTempDir('workdir-states')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })

      const active: RunStatus[] = ['dispatched', 'running', 'waiting_local_directory']
      for (const [i, status] of active.entries()) {
        await s.insertRun(
          makeRun({ id: `r-active-${i}`, workspaceId: WS, agentId: 'a1', status, workDir: '/repo' }),
        )
      }
      for (const [i, status] of (['queued', 'completed', 'failed', 'cancelled'] as RunStatus[]).entries()) {
        await s.insertRun(
          makeRun({ id: `r-idle-${i}`, workspaceId: WS, agentId: `a${i}`, status, workDir: '/idle' }),
        )
      }

      assert.notEqual(await s.findRunHoldingWorkDir('/repo'), null)
      // queued / 终态都不占用目录
      assert.equal(await s.findRunHoldingWorkDir('/idle'), null)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })
})

describe('同一 (subject, agent) 不自竞争（INV-17）', () => {
  test('查出仍在进行的 run', async () => {
    const d = await makeTempDir('selfrace')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await s.insertRun(
        makeRun({
          id: 'r1',
          workspaceId: WS,
          agentId: 'a1',
          status: 'running',
          subject: { type: 'issue', id: 'i1' },
        }),
      )

      const found = await s.findActiveRunForSubjectAgent({ type: 'issue', id: 'i1' }, agentId('a1'))
      assert.equal(found?.id, 'r1')

      // 不同 agent 不算自竞争
      assert.equal(
        await s.findActiveRunForSubjectAgent({ type: 'issue', id: 'i1' }, agentId('a2')),
        null,
      )
      // 不同对象不算
      assert.equal(
        await s.findActiveRunForSubjectAgent({ type: 'issue', id: 'i2' }, agentId('a1')),
        null,
      )
      // 对象类型不同也不算（issue:i1 与 report:i1 是两个对象）
      assert.equal(
        await s.findActiveRunForSubjectAgent({ type: 'report', id: 'i1' }, agentId('a1')),
        null,
      )
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('已终态的 run 不算"仍在进行"', async () => {
    const d = await makeTempDir('selfrace2')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await s.insertRun(
        makeRun({
          id: 'r-done',
          workspaceId: WS,
          agentId: 'a1',
          status: 'completed',
          subject: { type: 'issue', id: 'i-done' },
        }),
      )
      assert.equal(
        await s.findActiveRunForSubjectAgent({ type: 'issue', id: 'i-done' }, agentId('a1')),
        null,
      )
      await s.close()
    } finally {
      await cleanup(d)
    }
  })
})

describe('report 去重键（FR-REPORT-03 —— 平台侧的正确性保证）', () => {
  test('★ 同一去重键第二次写入返回 false（幂等，不是错误）', async () => {
    const d = await makeTempDir('dedup')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })

      const r1 = makeReport({ id: 'rep-1', workspaceId: WS, kind: 'ci-failure', dedupKey: 'k1' })
      const r2 = makeReport({ id: 'rep-2', workspaceId: WS, kind: 'ci-failure', dedupKey: 'k1' })

      assert.equal(await s.insertReport(r1), true)
      assert.equal(await s.insertReport(r2), false, '重复去重键必须被拒')
      assert.equal((await s.findReportByDedupKey('k1'))?.id, 'rep-1')
      assert.equal((await s.getReport('rep-1' as never))?.kind, 'ci-failure')

      const r3 = makeReport({ id: 'rep-3', workspaceId: WS, kind: 'ci-failure', dedupKey: 'k2' })
      assert.equal(await s.insertReport(r3), true)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('★ 唯一性是数据库层保证的：绕过适配器直接插入必须被 SQLite 拒绝', async () => {
    /**
     * 这条是 requirement"用 UNIQUE 索引"的**直接证据**。应用层"先查有没有
     * 再插入"在并发下会漏（两个进程同时查、同时插），所以必须由约束兜底。
     * 这里绕过适配器用原生连接插一条重复去重键：如果适配器只是自己查了一下，
     * 这条原生插入就会成功。
     */
    const d = await makeTempDir('dedup-index')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await s.insertReport(makeReport({ id: 'rep-u1', workspaceId: WS, kind: 'k', dedupKey: 'uniq' }))
      await s.close()

      const raw = new DatabaseSync(sqliteStorePath(d))
      assert.throws(
        () =>
          raw
            .prepare(`INSERT INTO report(id, workspace_id, json) VALUES(?,?,?)`)
            .run('rep-u2', WS, JSON.stringify(makeReport({ id: 'rep-u2', workspaceId: WS, kind: 'k', dedupKey: 'uniq' }))),
        /UNIQUE/i,
      )
      raw.close()
    } finally {
      await cleanup(d)
    }
  })

  test('★ 同一个 id 带着新去重键再写一次：覆盖内容，旧键不再解析（有意的偏离）', async () => {
    /**
     * 文件适配器在这里会**保留旧键**：它的去重映射只增不减，于是旧键仍然指向
     * 那条 report（此时它的 `dedupKey` 已经变成新的了）。这里选择让生成列
     * 始终等于实体自己的去重键——"按去重键查到的就是那条键的 report"。
     *
     * 这个分歧在实践中不可达：report 的 id 是 ULID（每次摄取新生成），
     * 去重键是内容摘要，同一个 id 换键意味着"同一条 ULID 的内容变了"。
     * 与其复制一份"永远指向过去"的映射，不如保住那条简单的不变式。
     */
    const d = await makeTempDir('dedup-rekey')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })

      await s.insertReport(makeReport({ id: 'rep-rk', workspaceId: WS, kind: 'k', dedupKey: 'old' }))
      assert.equal(
        await s.insertReport(makeReport({ id: 'rep-rk', workspaceId: WS, kind: 'k', dedupKey: 'new' })),
        true,
        '换了去重键就不该被当成重复',
      )
      assert.equal((await s.findReportByDedupKey('new'))?.id, 'rep-rk')
      assert.equal(await s.findReportByDedupKey('old'), null)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('去重索引在重开后仍然有效', async () => {
    const d = await makeTempDir('dedup2')
    try {
      const a = await SqliteStore.open({ dataDir: d, fsync: false })
      await a.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await a.insertReport(makeReport({ id: 'rep-x', workspaceId: WS, kind: 'k', dedupKey: 'dup-key' }))
      await a.close()

      const b = await SqliteStore.open({ dataDir: d, fsync: false })
      assert.equal((await b.findReportByDedupKey('dup-key'))?.id, 'rep-x')
      assert.equal(
        await b.insertReport(makeReport({ id: 'rep-y', workspaceId: WS, kind: 'k', dedupKey: 'dup-key' })),
        false,
      )
      await b.close()
    } finally {
      await cleanup(d)
    }
  })
})

describe('动作幂等键（FR-ACTION-03）', () => {
  function makeAction(over: { id: string; idempotencyKey: string; status?: 'proposed' }) {
    return {
      id: over.id as ActionId,
      workspaceId: WS,
      verdictId: 'v-1' as VerdictId,
      type: 'comment.create' as const,
      plane: 'local' as const,
      params: { body: 'x' },
      status: over.status ?? ('proposed' as const),
      idempotencyKey: over.idempotencyKey,
      dryRun: false,
      result: null,
      error: null,
      rollbackRef: null,
      createdAt: 1,
      finishedAt: null,
    }
  }

  test('按幂等键可查回已存在的动作', async () => {
    const d = await makeTempDir('idem')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })

      const action = makeAction({ id: 'act-1', idempotencyKey: 'v-1:comment.create:{"body":"x"}' })
      await s.insertAction(action)

      assert.equal((await s.findActionByIdempotencyKey(action.idempotencyKey))?.id, 'act-1')
      assert.equal(await s.findActionByIdempotencyKey('nope'), null)
      assert.equal((await s.getAction('act-1' as ActionId))?.type, 'comment.create')

      // 状态机对动作同样生效
      assert.equal(await s.transitionAction(action.id, 'proposed', 'auto_approved'), true)
      assert.equal(await s.transitionAction(action.id, 'proposed', 'executing'), false)
      // 幂等命中的动作落 skipped，而不是静默成功（SM-ACT-2）
      assert.equal(
        await s.transitionAction(action.id, 'auto_approved', 'skipped', { error: '重复触发' }),
        true,
      )
      assert.equal((await s.getAction(action.id))?.error, '重复触发')
      assert.deepEqual(
        (await s.listActionsByVerdict('v-1' as VerdictId)).map((a) => a.id),
        ['act-1'],
      )
      await s.close()
    } finally {
      await cleanup(d)
    }
  })
})

describe('消息流（FR-BRIDGE-18）', () => {
  test('★ seq 单调递增，since 补齐不依赖时间戳', async () => {
    const d = await makeTempDir('messages')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      const rid = runId('r-msg')
      await s.insertRun(makeRun({ id: 'r-msg', workspaceId: WS, agentId: 'a1' }))

      for (let seq = 0; seq < 5; seq++) await s.appendRunMessage(rid, msg(seq))

      assert.equal(await s.lastRunMessageSeq(rid), 4)
      const all = await s.listRunMessages(rid)
      assert.deepEqual(all.map((m) => m.content), ['m0', 'm1', 'm2', 'm3', 'm4'])

      const tail = await s.listRunMessages(rid, 2)
      assert.deepEqual(tail.map((m) => m.content), ['m3', 'm4'])
      assert.equal((await s.listRunMessages(rid, 4)).length, 0)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('重开后 lastSeq 被正确恢复', async () => {
    const d = await makeTempDir('messages2')
    try {
      const rid = runId('r-msg2')
      const a = await SqliteStore.open({ dataDir: d, fsync: false })
      await a.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await a.insertRun(makeRun({ id: 'r-msg2', workspaceId: WS, agentId: 'a1' }))
      await a.appendRunMessage(rid, msg(7, 'x'))
      await a.close()

      const b = await SqliteStore.open({ dataDir: d, fsync: false })
      assert.equal(await b.lastRunMessageSeq(rid), 7)
      assert.deepEqual((await b.listRunMessages(rid)).map((m) => m.content), ['x'])
      await b.close()
    } finally {
      await cleanup(d)
    }
  })

  test('★ 没有消息时 lastSeq 是 -1（不是 0）', async () => {
    const d = await makeTempDir('messages-empty')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await s.insertRun(makeRun({ id: 'r-empty', workspaceId: WS, agentId: 'a1' }))
      // -1 才能让"从哪开始补齐"与"尚未产生任何消息"区分开
      assert.equal(await s.lastRunMessageSeq(runId('r-empty')), -1)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('★ 同 seq 重复追加不报错——端口语义是"追加"，不是"唯一插入"', async () => {
    /**
     * 文件适配器允许同 seq 追加两条（读取时按 seq 稳定排序，两条都返回），
     * 所以这里也**不建 `(run_id, seq)` 唯一约束**：加了约束会把"调用方给重了
     * seq"从一个调用方 bug 升级成存储报错，改变了端口行为。seq 单调是调用方
     * 的责任（FR-BRIDGE-18），存储不替它做判断。
     */
    const d = await makeTempDir('messages-dupseq')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      const rid = runId('r-dup')
      await s.insertRun(makeRun({ id: 'r-dup', workspaceId: WS, agentId: 'a1' }))

      await s.appendRunMessage(rid, msg(0, '第一次'))
      await s.appendRunMessage(rid, msg(0, '重复的那条'))
      assert.deepEqual(
        (await s.listRunMessages(rid)).map((m) => m.content),
        ['第一次', '重复的那条'],
      )
      assert.equal(await s.lastRunMessageSeq(rid), 0)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('给不存在的 run 追加消息 ⇒ 报错（不静默丢弃）', async () => {
    await assert.rejects(() => store.lastRunMessageSeq(runId('ghost')), /找不到 run/)
    await assert.rejects(() => store.appendRunMessage(runId('ghost'), msg(0)), /找不到 run/)
    await assert.rejects(() => store.listRunMessages(runId('ghost')), /找不到 run/)
  })
})

describe('内容寻址 blob', () => {
  test('★ 同一内容重复写入得到同一个引用（天然幂等）', async () => {
    const enc = new TextEncoder()
    const ref1 = await store.putBlob(enc.encode('hello'))
    const ref2 = await store.putBlob(enc.encode('hello'))
    assert.equal(ref1, ref2)
    assert.match(ref1, /^sha256:[0-9a-f]{64}$/)

    const ref3 = await store.putBlob(enc.encode('world'))
    assert.notEqual(ref1, ref3)

    // 与文件适配器同一哈希算法：同一份内容在两种存储下引用必须相同，
    // 否则迁移时所有引用都会失效
    assert.equal(ref1, 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  test('读回内容一致，未知引用返回 null', async () => {
    const enc = new TextEncoder()
    const text = '内容 with utf8 ✨'
    const ref = await store.putBlob(enc.encode(text))
    const back = await store.getBlob(ref)
    assert.equal(back && Buffer.from(back).toString('utf8'), text)
    assert.equal(await store.hasBlob(ref), true)

    const ghost = `sha256:${'0'.repeat(64)}` as BlobRef
    assert.equal(await store.getBlob(ghost), null)
    assert.equal(await store.hasBlob(ghost), false)
  })

  test('二进制内容（含 0x00 / 0xFF）原样取回', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 0, 128])
    const ref = await store.putBlob(bytes)
    const back = await store.getBlob(ref)
    assert.deepEqual(back && [...back], [...bytes])
  })

  test('report 的快照可直接按内容寻址取回', async () => {
    const enc = new TextEncoder()
    const text = '快照内容'
    const ref = await store.putBlob(enc.encode(text))
    const report = makeReport({ id: 'rep-blob', workspaceId: WS, kind: 'k', dedupKey: 'blob-1' })
    await store.insertReport({ ...report, blobRef: ref })
    const back = await store.findReportByDedupKey('blob-1')
    assert.equal(back?.blobRef, ref)
    const bytes = await store.getBlob(ref)
    assert.equal(bytes && Buffer.from(bytes).toString('utf8'), text)
  })
})

describe('审计链（FR-AUDIT-01）', () => {
  test('按 run 取回审计记录，且按入队时间排序', async () => {
    const d = await makeTempDir('audit')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      const rid = runId('r-audit')
      await s.insertRun(makeRun({ id: 'r-audit', workspaceId: WS, agentId: 'a1' }))

      const base = {
        workspaceId: WS,
        runId: rid,
        subject: { type: 'issue', id: 'i1' } as const,
        inputBlobRefs: [],
        skillRefs: [{ id: makeSkill({ id: 's1' }).id, slug: 'sec-vuln', source: 'local' as const }],
        runtimeDescriptorKey: 'claude',
        cliVersion: '2.1.220',
        modelId: 'claude-sonnet-4-5',
        promptHash: 'abc',
        argvRedacted: ['claude', '-p', '--output-format', 'stream-json'],
        verdictId: null,
        actionIds: [],
        startedAt: 2,
        finishedAt: 3,
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          costUsdMicros: 1234,
          costSource: 'provider' as const,
        },
      }
      await s.appendAudit({ ...base, id: 'aud-late' as never, queuedAt: 200 })
      await s.appendAudit({ ...base, id: 'aud-early' as never, queuedAt: 100 })

      const audits = await s.listAuditsByRun(rid)
      assert.deepEqual(
        audits.map((a) => a.id),
        ['aud-early', 'aud-late'],
      )
      assert.equal(audits[0]?.skillRefs[0]?.slug, 'sec-vuln')
      // 成本用整数微美元，避免浮点漂移
      assert.equal(audits[0]?.usage?.costUsdMicros, 1234)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })
})

describe('verdict 与 artifact', () => {
  test('verdict 的 CAS 与非法转移', async () => {
    const d = await makeTempDir('verdict')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      const rid = runId('r-v')
      await s.insertRun(makeRun({ id: 'r-v', workspaceId: WS, agentId: 'a1' }))
      const vid = 'v-1' as VerdictId

      await s.insertVerdict({
        id: vid,
        workspaceId: WS,
        runId: rid,
        subject: { type: 'issue', id: 'i1' },
        status: 'pending_verdict',
        conclusion: 'pass',
        reasonCode: 'ok',
        confidence: 0.9,
        findings: [],
        action: null,
        escalateReason: null,
        invalidResolution: null,
        skillRefs: [],
        modelId: null,
        promptHash: null,
        createdAt: 1,
      } as never)

      assert.equal(await s.transitionVerdict(vid, 'pending_verdict', 'invalid', {
        invalidResolution: 'retry',
      }), true)
      assert.equal((await s.getVerdict(vid))?.invalidResolution, 'retry')
      // 前态已不匹配 ⇒ 安静地 false
      assert.equal(await s.transitionVerdict(vid, 'pending_verdict', 'emitted'), false)
      // 前态匹配但目标非法 ⇒ 抛
      await assert.rejects(() => s.transitionVerdict(vid, 'invalid', 'emitted'))
      assert.equal((await s.listVerdictsByRun(rid)).length, 1)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('artifact 按 run 取回', async () => {
    const d = await makeTempDir('artifact')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      const rid = runId('r-art')
      await s.insertArtifact({
        id: 'art-1' as never,
        workspaceId: WS,
        runId: rid,
        kind: 'document',
        summary: '构建日志',
        blobRef: `sha256:${'a'.repeat(64)}` as BlobRef,
        createdAt: 5,
      })
      assert.deepEqual(
        (await s.listArtifactsByRun(rid)).map((a) => a.summary),
        ['构建日志'],
      )
      await s.close()
    } finally {
      await cleanup(d)
    }
  })
})

describe('通知中心（FR-ISSUE-07/08）', () => {
  test('★ 默认只列未读，按时间倒序，条数封顶', async () => {
    const d = await makeTempDir('inbox')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })

      const item = (id: string, createdAt: number) => ({
        id,
        workspaceId: WS,
        type: 'review.needs_decision',
        severity: 'action_required' as const,
        title: `通知 ${id}`,
        body: '',
        issueId: null,
        runId: null,
        read: false,
        createdAt,
      })
      await s.appendInboxItem(item('n1', 100))
      await s.appendInboxItem(item('n2', 200))

      assert.deepEqual(
        (await s.listInboxItems({ workspaceId: WS })).map((i) => i.id),
        ['n2', 'n1'],
      )
      assert.equal((await s.listInboxItems({ workspaceId: WS, limit: 1 })).length, 1)

      assert.equal(await s.markInboxItemRead('n2'), true)
      assert.equal(await s.markInboxItemRead('nope'), false)
      assert.deepEqual(
        (await s.listInboxItems({ workspaceId: WS })).map((i) => i.id),
        ['n1'],
      )
      assert.deepEqual(
        (await s.listInboxItems({ workspaceId: WS, unreadOnly: false })).map((i) => i.id),
        ['n2', 'n1'],
      )
      await s.close()
    } finally {
      await cleanup(d)
    }
  })
})

describe('注释（Comment）', () => {
  test('按 issue 取注释并按创建时间排序', async () => {
    const d = await makeTempDir('comment')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      const mk = (id: string, createdAt: number) => ({
        id: id as never,
        workspaceId: WS,
        issueId: 'i-1' as never,
        authorType: 'member' as const,
        authorId: 'me',
        type: 'comment' as const,
        content: id,
        createdAt,
      })
      await s.insertComment(mk('c-late', 200))
      await s.insertComment(mk('c-early', 100))
      await s.insertComment({ ...mk('c-other', 50), issueId: 'i-2' as never })

      assert.deepEqual(
        (await s.listComments('i-1' as never)).map((c) => c.content),
        ['c-early', 'c-late'],
      )
      await s.close()
    } finally {
      await cleanup(d)
    }
  })
})

/**
 * 聊天（Conversation 与 ChatTurn，闭环的旁路）。
 *
 * 这一组盯的**不是"能不能存进去"**，而是顺序与"找不到时的答案"：
 *
 *   ★ 列表顺序（`lastTurnAt ?? createdAt` 倒序 + id 兜底）
 *   ★ 回合顺序（`seq` 升序）
 *   ★ "上一轮是谁"（从后往前找第一条带 run 的）
 *   ★ 找不到时的答案是 `null`，而且**不能顺手插出一条**
 *
 * 前三条错了比少了更糟：少一条轮次看得出来，顺序错了看不出来，而
 * `lastChatTurnWithRun` 一旦答错，下一轮就会接错上文——聊天会"莫名其妙
 * 忘了刚才说的话"，且没有任何一处报错。
 */
describe('聊天（Conversation 与 ChatTurn）', () => {
  const WSA = wsId('ws-chat-a')
  const WSB = wsId('ws-chat-b')

  async function openScratch(prefix: string): Promise<{ store: SqliteStore; dir: string }> {
    const dir = await makeTempDir(prefix)
    const s = await SqliteStore.open({ dataDir: dir, fsync: false })
    await insertWorkspaces(s)
    return { store: s, dir }
  }

  async function insertWorkspaces(s: SqliteStore): Promise<void> {
    for (const [id, name] of [
      [WSA, 'A'],
      [WSB, 'B'],
    ] as const) {
      await s.insertWorkspace({
        executeTemplate: '',
        reviewTemplate: '', chatTemplate: '',
        defaultAgentId: null,
        locale: 'zh',
        id,
        name,
        createdAt: 1,
        updatedAt: 1,
      })
    }
  }

  /** 造一条回合。除给到的字段外全都固定，免得断言被无关字段干扰。 */
  const turn = (
    id: string,
    conversation: string,
    seq: number,
    over: { runId?: string | null; createdAt?: number } = {},
  ) =>
    makeChatTurn({
      id,
      // 裸字符串在这里收成品牌类型（`ChatTurn['conversationId']`），调用点就
      // 只需要写 id 本身，不必到处 `conversationId('c1')`
      conversationId: conversationId(conversation),
      workspaceId: WSA,
      seq,
      userText: `第 ${seq} 轮`,
      // 显式判 null / undefined，不用 `||`：空字符串是下面要测的一个值，
      // `||` 会把它当成"没给"，那条断言就变成测不到东西的空壳。
      runId: over.runId === undefined || over.runId === null ? null : runId(over.runId),
      createdAt: over.createdAt ?? 1000,
    })

  test('★ 列表按 `lastTurnAt ?? createdAt` 倒序，同键时按 id 倒序兜底', async () => {
    const { store: s, dir } = await openScratch('chat-list')
    try {
      /**
       * 四个对话把三种情形凑齐：
       *
       *   c-talked    createdAt 100，但说过话（lastTurnAt 300）⇒ 排最前
       *   c-never-c   createdAt 200 ┐同一毫秒建的（排序键相同）
       *   c-never-b   createdAt 200 ┘必须按 id 倒序兜底，否则顺序随扫描顺序变
       *   c-old       createdAt 100，但**刚改过标题**（updatedAt 999）
       *
       * c-old 是这条用例的重点：排序键**不是** `updatedAt`。改个标题不该把一个
       * 对话顶到最前面（那会让"我刚聊过的那个"随时被一次改名挤走）。
       */
      await s.insertConversation(
        makeConversation({ id: 'c-never-b', workspaceId: WSA, createdAt: 200 }),
      )
      await s.insertConversation(
        makeConversation({ id: 'c-never-c', workspaceId: WSA, createdAt: 200 }),
      )
      await s.insertConversation(
        makeConversation({ id: 'c-old', workspaceId: WSA, createdAt: 100, updatedAt: 999 }),
      )
      await s.insertConversation(
        makeConversation({
          id: 'c-talked',
          workspaceId: WSA,
          createdAt: 100,
          lastTurnAt: 300,
        }),
      )

      assert.deepEqual(
        (await s.listConversations(WSA)).map((c) => c.id),
        ['c-talked', 'c-never-c', 'c-never-b', 'c-old'],
      )
    } finally {
      await s.close()
      await cleanup(dir)
    }
  })

  test('★ 一轮一轮加 turn：listChatTurns 按 seq 升序（不按写入顺序、不按时间）', async () => {
    const { store: s, dir } = await openScratch('chat-turns')
    try {
      // ★ 故意乱序写入、且时间戳完全相同：补齐只能靠 seq
      await s.insertChatTurn(turn('t3', 'c1', 3))
      await s.insertChatTurn(turn('t1', 'c1', 1))
      await s.insertChatTurn(turn('t2', 'c1', 2))

      assert.deepEqual(
        (await s.listChatTurns(conversationId('c1'))).map((t) => t.id),
        ['t1', 't2', 't3'],
      )

      /**
       * 同一个 seq 追加两条（端口语义是"追加"，不是"唯一插入"）：不报错，且
       * 顺序是**插入顺序**——文件适配器那边是 JS 的 `Array#sort`（稳定），
       * SQL 这边靠 `ORDER BY seq, rowid` 对齐同一条语义。
       */
      await s.insertChatTurn(turn('t2b', 'c1', 2))
      assert.deepEqual(
        (await s.listChatTurns(conversationId('c1'))).map((t) => t.id),
        ['t1', 't2', 't2b', 't3'],
      )

      // 别的对话的回合不能混进来；不存在的对话是空数组（不是 null）
      await s.insertChatTurn(turn('x1', 'c-other', 1))
      assert.deepEqual(
        (await s.listChatTurns(conversationId('c1'))).map((t) => t.id),
        ['t1', 't2', 't2b', 't3'],
      )
      assert.deepEqual(await s.listChatTurns(conversationId('c-nope')), [])
    } finally {
      await s.close()
      await cleanup(dir)
    }
  })

  test('★ lastChatTurnWithRun 从后往前找第一条带 run 的：尾轮没抢到并发槽位是合法状态', async () => {
    const { store: s, dir } = await openScratch('chat-last-run')
    try {
      assert.equal(await s.lastChatTurnWithRun(conversationId('c1')), null, '一条都没有 ⇒ null')

      await s.insertChatTurn(turn('t1', 'c1', 1, { runId: 'r1' }))
      await s.insertChatTurn(turn('t2', 'c1', 2, { runId: 'r2' }))
      // ★ 尾轮没有 run：建 run 那一刻被并发槽位/目录锁挡下了，轮次记录仍然留着
      await s.insertChatTurn(turn('t3', 'c1', 3, { runId: null }))

      assert.equal(
        (await s.lastChatTurnWithRun(conversationId('c1')))?.id,
        't2',
        '★ 必须往回再找一条，否则下一轮会丢掉上文（"我说的话它不记得了"）',
      )

      // 一个对话里一条 run 都没有 ⇒ null（不抛）
      await s.insertChatTurn(turn('u1', 'c2', 1, { runId: null }))
      await s.insertChatTurn(turn('u2', 'c2', 2, { runId: null }))
      assert.equal(await s.lastChatTurnWithRun(conversationId('c2')), null)

      /**
       * ⚠️ 空字符串 runId：`RunId` 的 schema 是 `z.string()`（**没有** `.min(1)`），
       *    所以它在类型上是合法值。文件适配器写的是 `if (t.runId)`——那是**真假值**
       *    判断，空字符串在那边是假值，会被跳过。这里也必须跳过，否则同一条记录
       *    在两个适配器上会给出不同的"上一轮"。
       */
      await s.insertChatTurn(turn('e1', 'c3', 1, { runId: '' }))
      assert.equal(await s.lastChatTurnWithRun(conversationId('c3')), null)
    } finally {
      await s.close()
      await cleanup(dir)
    }
  })

  test('★ 追加一轮之后更新 lastTurnAt / turnCount：它必须被顶到列表最前面', async () => {
    const { store: s, dir } = await openScratch('chat-touch')
    try {
      await s.insertConversation(
        makeConversation({ id: 'c-a', workspaceId: WSA, createdAt: 100, updatedAt: 100 }),
      )
      await s.insertConversation(
        makeConversation({ id: 'c-b', workspaceId: WSA, createdAt: 200, updatedAt: 200 }),
      )
      assert.deepEqual(
        (await s.listConversations(WSA)).map((c) => c.id),
        ['c-b', 'c-a'],
        '还没说过话：按 createdAt 倒序',
      )

      // daemon 在 insertChatTurn 之后走这一处更新（turnCount 是冗余字段，
      // 只有这一条路径写它——见 `Conversation` 上面的说明）
      await s.insertChatTurn(turn('ta1', 'c-a', 1, { runId: 'ra1' }))
      const after = await s.updateConversation(conversationId('c-a'), {
        lastTurnAt: 500,
        turnCount: 1,
        updatedAt: 500,
      })
      assert.equal(after?.turnCount, 1)
      assert.deepEqual(
        (await s.listConversations(WSA)).map((c) => c.id),
        ['c-a', 'c-b'],
        '★ 说过话的排最前——排序键是 lastTurnAt',
      )
    } finally {
      await s.close()
      await cleanup(dir)
    }
  })

  test('★ updateConversation：改标题返回新记录；找不到返回 null，且**不能顺手插出一条**', async () => {
    const { store: s, dir } = await openScratch('chat-update')
    try {
      await s.insertConversation(
        makeConversation({
          id: 'c1',
          workspaceId: WSA,
          title: '旧标题',
          workDir: '/repo',
          turnCount: 2,
        }),
      )

      const updated = await s.updateConversation(conversationId('c1'), { title: '新标题' })
      assert.equal(updated?.title, '新标题')
      assert.equal(updated?.workDir, '/repo', 'patch 只动它说的那个字段')
      assert.equal(updated?.turnCount, 2)
      assert.equal(
        (await s.getConversation(conversationId('c1')))?.title,
        '新标题',
        '落盘了，不只是返回值对了',
      )

      // null 才是"清空"（workDir 是 nullable，用来表达"接进我的仓库"之外的默认）
      assert.equal((await s.updateConversation(conversationId('c1'), { workDir: null }))?.workDir, null)

      /**
       * ★ 找不到时的答案是 `null`——不抛错，也不静默成功。
       *
       * 最容易写歪的正是这里：`UPDATE ... WHERE id = ?` 零行匹配时**什么都不说**，
       * 把它当成功返回会让调用方以为改名生效了。所以除了返回值，还要看
       * "有没有凭空多出一条"——用 upsert 实现的话，一条 `updateConversation`
       * 就能造出一个只有标题、没有 agentId 的野记录。
       */
      assert.equal(await s.updateConversation(conversationId('nope'), { title: 'x' }), null)
      assert.equal(await s.getConversation(conversationId('nope')), null, '★ 不能插出一条')
      assert.deepEqual(
        (await s.listConversations(WSA)).map((c) => c.id),
        ['c1'],
        '★ 列表里也不能多出东西',
      )

      /**
       * ⚠️ patch 里**显式**带 `undefined`：两个适配器都**不** prune（文件适配器的
       *    `updateConversation` 就是原样 `{ ...cur, ...patch }`），于是该字段从落盘的
       *    JSON 里消失。这与 `transition*` 那四个方法的行为**不同**，是刻意对齐
       *    文件适配器的结果；钉住它是为了将来有人"顺手加个 pruneUndefined"时
       *    当场失败——那会让同一个调用在两个适配器上得到不同的记录。
       */
      await s.updateConversation(conversationId('c1'), loosePatch({ workDir: undefined }))
      assert.equal((await s.getConversation(conversationId('c1')))?.workDir, undefined)
      assert.equal((await s.getConversation(conversationId('c1')))?.title, '新标题')
    } finally {
      await s.close()
      await cleanup(dir)
    }
  })

  test('★ 按 workspace 隔离；getConversation 则按 id 全局取（id 是 ULID，跨空间不会撞）', async () => {
    const { store: s, dir } = await openScratch('chat-ws')
    try {
      await s.insertConversation(makeConversation({ id: 'ca', workspaceId: WSA, createdAt: 1 }))
      await s.insertConversation(makeConversation({ id: 'cb', workspaceId: WSB, createdAt: 2 }))
      await s.insertChatTurn({ ...turn('tb1', 'cb', 1, { runId: 'rb1' }), workspaceId: WSB })

      assert.deepEqual((await s.listConversations(WSA)).map((c) => c.id), ['ca'])
      assert.deepEqual(
        (await s.listConversations(WSB)).map((c) => c.id),
        ['cb'],
        '★ A 的对话不能出现在 B 的列表里',
      )

      /**
       * `getConversation` 按 id 取是**全局**的，这是与文件适配器一致的行为
       * （那边遍历所有 workspace 的内存索引找那条 id）。这不是隔离没做好：
       * id 是 ULID，端口的签名里也没有"在某个 workspace 内按 id 取对话"这个方法。
       *
       * `listChatTurns` 同理：它的签名里**没有 workspaceId**（端口就是这么定的），
       * 所以别的 workspace 的对话，只要 id 给对了，回合就读得到。
       */
      assert.equal((await s.getConversation(conversationId('cb')))?.workspaceId, WSB)
      assert.deepEqual(
        (await s.listChatTurns(conversationId('cb'))).map((t) => t.id),
        ['tb1'],
      )
    } finally {
      await s.close()
      await cleanup(dir)
    }
  })

  test('★ deleteConversation：删对话**连同它的轮次**；本来就不在 ⇒ false（不是错误）', async () => {
    const { store: s, dir } = await openScratch('chat-delete')
    try {
      await s.insertConversation(makeConversation({ id: 'c1', workspaceId: WSA, title: '要删的' }))
      // 轮次指向一条**真实存在**的 run，这样"删对话不能动 run"才是个完整场景
      await s.insertRun(makeRun({ id: 'r1', agentId: 'a1', workspaceId: WSA }))
      await s.insertChatTurn(turn('t1', 'c1', 1, { runId: 'r1' }))
      await s.insertChatTurn(turn('t2', 'c1', 2, { runId: 'r2' }))
      // 另一个对话，用来验"只删它自己的轮次"
      await s.insertConversation(makeConversation({ id: 'c2', workspaceId: WSA, title: '留着' }))
      await s.insertChatTurn(turn('u1', 'c2', 1, { runId: 'r9' }))

      assert.equal(await s.deleteConversation(conversationId('c1')), true)
      assert.equal(await s.getConversation(conversationId('c1')), null)
      assert.deepEqual(
        await s.listChatTurns(conversationId('c1')),
        [],
        '★ 轮次必须一起删掉——留下"没有对话的轮次"没有任何入口能看见它',
      )

      /**
       * ⚠️ 那条 run **不动**。它是审计记录（成本、日志、工作目录的归属都挂在它
       *    身上），而它的产出就是聊天记录本身——删掉 run 等于把"这次对话真的
       *    发生过"一起删了。顺手补一条 `DELETE FROM run` 会被这两行挡住。
       */
      assert.equal((await s.getRun(runId('r1')))?.id, 'r1', '★ 删对话不能删 run')
      assert.equal((await s.getRun(runId('r1')))?.status, 'queued', 'run 的状态也不能被顺手改掉')

      assert.equal((await s.getConversation(conversationId('c2')))?.title, '留着')
      assert.deepEqual(
        (await s.listChatTurns(conversationId('c2'))).map((t) => t.id),
        ['u1'],
        '★ 删 A 的轮次不能动到 B 的',
      )
      assert.deepEqual((await s.listConversations(WSA)).map((c) => c.id), ['c2'])

      // 幂等：第二次的正确答案是"没有可删的东西"，不是抛错
      assert.equal(await s.deleteConversation(conversationId('c1')), false)
      assert.equal(await s.deleteConversation(conversationId('nope')), false)

      /**
       * ★ 对话不存在时，**孤儿轮次也不动**。
       *
       * 这不是笔误，而是与文件适配器对齐：那边是"找到对话才进删除逻辑"，
       * 所以一条没有对话的轮次（写入路径不会产生这种数据）不会被顺手删掉。
       * 若这里图省事写成"无条件按 conversationId 删轮次"，返回值就会出现
       * `false` 却删了东西的矛盾。
       */
      await s.insertChatTurn(turn('orphan', 'c-gone', 1, { runId: 'r-orphan' }))
      assert.equal(await s.deleteConversation(conversationId('c-gone')), false)
      assert.deepEqual(
        (await s.listChatTurns(conversationId('c-gone'))).map((t) => t.id),
        ['orphan'],
      )
    } finally {
      await s.close()
      await cleanup(dir)
    }
  })

  test('★ 关闭后重开：对话与回合都在，排序键与"上一轮"照样算得出来', async () => {
    /**
     * 排序键 `sort_at` 是 **VIRTUAL 生成列**——它不落盘，重开后由 SQLite 从
     * JSON 重新求值。所以这条用例顺带实证了那个取舍：排序键与实体内容物理上
     * 不可能不一致，也就没有"迁移时忘了回填派生列"这回事。
     */
    const dir = await makeTempDir('chat-reopen')
    try {
      const a = await SqliteStore.open({ dataDir: dir, fsync: false })
      await insertWorkspaces(a)
      await a.insertConversation(
        makeConversation({ id: 'c-old', workspaceId: WSA, createdAt: 100 }),
      )
      await a.insertConversation(
        makeConversation({
          id: 'c-live',
          workspaceId: WSA,
          createdAt: 100,
          lastTurnAt: 400,
          turnCount: 2,
        }),
      )
      await a.insertChatTurn(turn('t1', 'c-live', 1, { runId: 'r1' }))
      await a.insertChatTurn(turn('t2', 'c-live', 2, { runId: 'r2' }))
      await a.insertChatTurn(turn('t3', 'c-live', 3, { runId: null }))
      await a.close()

      const b = await SqliteStore.open({ dataDir: dir, fsync: false })
      assert.deepEqual(
        (await b.listConversations(WSA)).map((c) => c.id),
        ['c-live', 'c-old'],
        '重开后排序键仍然有效',
      )
      assert.deepEqual(
        (await b.listChatTurns(conversationId('c-live'))).map((t) => t.id),
        ['t1', 't2', 't3'],
      )
      assert.equal((await b.lastChatTurnWithRun(conversationId('c-live')))?.id, 't2')
      assert.equal((await b.getConversation(conversationId('c-live')))?.turnCount, 2)
      assert.equal(
        (await b.getConversation(conversationId('c-live')))?.lastTurnAt,
        400,
        'lastTurnAt 是整个 JSON 的一部分，重开后逐字回来',
      )
      await b.close()
    } finally {
      await cleanup(dir)
    }
  })
})

describe('存储格式版本门禁（FR-STOR-04）', () => {
  test('首次打开写入当前版本；关闭重开后版本不变', async () => {
    const d = await makeTempDir('version-ok')
    try {
      const a = await SqliteStore.open({ dataDir: d, fsync: false })
      assert.equal(await a.formatVersion(), SQLITE_STORE_FORMAT_VERSION)
      await a.close()
      const b = await SqliteStore.open({ dataDir: d, fsync: false })
      assert.equal(await b.formatVersion(), SQLITE_STORE_FORMAT_VERSION)
      await b.close()
    } finally {
      await cleanup(d)
    }
  })

  test('★ 数据库版本高于程序支持 ⇒ 拒绝打开并给出可读原因', async () => {
    const d = await makeTempDir('version-high')
    try {
      const store0 = await SqliteStore.open({ dataDir: d, fsync: false })
      await store0.close()

      // 模拟"用旧程序打开新数据"：直接把版本改高
      const raw = new DatabaseSync(sqliteStorePath(d))
      raw.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run('99', 'formatVersion')
      raw.close()

      await assert.rejects(
        () => SqliteStore.open({ dataDir: d, fsync: false }),
        (err: unknown) => {
          assert.match((err as Error).message, /请升级程序/)
          return true
        },
      )
    } finally {
      await cleanup(d)
    }
  })

  test('★ 拒绝打开之后必须能重新打开（失败的 open 不能留下锁住的句柄）', async () => {
    const d = await makeTempDir('version-relock')
    try {
      const store0 = await SqliteStore.open({ dataDir: d, fsync: false })
      await store0.close()
      const raw = new DatabaseSync(sqliteStorePath(d))
      raw.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run('99', 'formatVersion')
      raw.close()

      await assert.rejects(() => SqliteStore.open({ dataDir: d, fsync: false }))

      // 把版本改回来：如果上一次失败的 open 没关句柄，这里会撞上文件锁
      const fix = new DatabaseSync(sqliteStorePath(d))
      fix.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run('1', 'formatVersion')
      fix.close()
      const ok = await SqliteStore.open({ dataDir: d, fsync: false })
      assert.equal(await ok.formatVersion(), 1)
      await ok.close()
    } finally {
      await cleanup(d)
    }
  })

  test('版本字段不可读 ⇒ 当成损坏文件报错，而不是当成新库覆盖掉', async () => {
    const d = await makeTempDir('version-garbage')
    try {
      const store0 = await SqliteStore.open({ dataDir: d, fsync: false })
      await store0.close()
      const raw = new DatabaseSync(sqliteStorePath(d))
      raw.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run('并不是数字', 'formatVersion')
      raw.close()

      await assert.rejects(() => SqliteStore.open({ dataDir: d, fsync: false }), /格式版本字段不可读/)
    } finally {
      await cleanup(d)
    }
  })
})

describe('打开期校验与关闭', () => {
  test('★ open() 之后立刻可用：表已建好，不依赖任何一次写入', async () => {
    const d = await makeTempDir('eager')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      // 全新库里每个查询都应当直接可用（而不是"写一次之后才存在"）
      assert.deepEqual(await s.listWorkspaceIds(), [])
      assert.equal(await s.getRun(runId('nope')), null)
      assert.equal(await s.getBlob(`sha256:${'0'.repeat(64)}` as BlobRef), null)
      assert.equal(await s.getDevice(), null)
      assert.equal((await s.listRuns({ workspaceId: WS })).items.length, 0)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('close() 是幂等的；关闭后再用会给出可读错误', async () => {
    const d = await makeTempDir('close')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false })
      await s.close()
      await s.close()
      await assert.rejects(() => s.listWorkspaceIds(), /存储已关闭/)
    } finally {
      await cleanup(d)
    }
  })

  test('自定义文件名可用（两个库可以并存于同一个 dataDir）', async () => {
    const d = await makeTempDir('filename')
    try {
      const s = await SqliteStore.open({ dataDir: d, fsync: false, fileName: 'other.sqlite' })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await s.close()

      // 默认文件名的那份仍然是空库：两边互不干扰
      const t = await SqliteStore.open({ dataDir: d, fsync: false })
      assert.deepEqual(await t.listWorkspaceIds(), [])
      await t.close()

      const again = await SqliteStore.open({ dataDir: d, fsync: false, fileName: 'other.sqlite' })
      assert.deepEqual(await again.listWorkspaceIds(), [WS])
      await again.close()
    } finally {
      await cleanup(d)
    }
  })

  test('★ 不是本程序写的 SQLite 文件 ⇒ 打开时给出可读原因，不静默当成空库', async () => {
    const d = await makeTempDir('foreign')
    try {
      const raw = new DatabaseSync(sqliteStorePath(d))
      raw.exec('CREATE TABLE something_else (x TEXT)')
      raw.close()

      await assert.rejects(() => SqliteStore.open({ dataDir: d, fsync: false }))
    } finally {
      await cleanup(d)
    }
  })
})
