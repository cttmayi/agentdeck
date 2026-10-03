import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { IllegalTransitionError } from '@agentdeck/domain'
import {
  agentId,
  chatTurnId,
  conversationId,
  issueId,
  makeAgent,
  makeChatTurn,
  makeConversation,
  makeIssue,
  makeReport,
  makeRun,
  makeSkill,
  makeTool,
  reportId,
  runId,
  toolId,
  wsId,
} from '@agentdeck/domain/testing'
import type {
  Action,
  ActionId,
  Artifact,
  AuditRecord,
  BlobRef,
  RunId,
  VerdictId,
  VerdictRecord,
} from '@agentdeck/protocol'
import { FileStore } from './file-store.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

let dir: string
let store: FileStore

const WS = wsId('ws-1')

before(async () => {
  dir = await makeTempDir('store')
  store = await FileStore.open({ dataDir: dir, fsync: false })
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
  })

  test('★ 关闭后重开，数据仍在（append-only 日志回放）', async () => {
    const reopenDir = await makeTempDir('reopen')
    try {
      const a = await FileStore.open({ dataDir: reopenDir, fsync: false })
      await a.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await a.insertAgent(makeAgent({ id: 'persist-me', workspaceId: WS }))
      await a.close()

      const b = await FileStore.open({ dataDir: reopenDir, fsync: false })
      assert.equal((await b.getAgent(agentId('persist-me')))?.id, 'persist-me')
      await b.close()
    } finally {
      await cleanup(reopenDir)
    }
  })

  test('列表按 id 排序并支持游标分页', async () => {
    const d = await makeTempDir('page')
    try {
      const s = await FileStore.open({ dataDir: d, fsync: false })
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

  test('★ 游标不在结果集里时，翻页必须继续而不是重放第一页', async () => {
    const d = await makeTempDir('cursor-gone')
    try {
      const s = await FileStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      // id 有序，于是排序 = id 升序，翻页位置是可预期的
      for (const id of ['a', 'b', 'c', 'd', 'e']) {
        await s.insertIssue(makeIssue({ id, workspaceId: WS }))
      }

      const p1 = await s.listIssues({ workspaceId: WS, limit: 2 })
      assert.deepEqual(p1.items.map((i) => i.id), ['a', 'b'])
      assert.equal(p1.nextCursor, 'b')

      // ⚠️ 这一条**曾经是个假测试**，必须记下来。
      //
      //    原先这里只写了 `transitionIssue('b','todo','done')`，然后照旧
      //    **不带过滤**地翻页。但改状态并没有把 'b' 从列表里拿掉，于是
      //    旧实现（`findIndex(id === 'b') = 1` ⇒ start = 2）同样给出
      //    ['c','d']——**bug 还在，测试照样绿**。
      //
      //    真正能咬住旧实现的形态是"**游标不在候选集里**"。端口没有删除
      //    操作，所以最贴近的可达形态就是加一个把游标排除掉的过滤：
      //    过滤后是 ['a','c','d','e']，旧实现找 'b' 得 -1 ⇒ 起点 0
      //    ⇒ 返回 ['a','c']，正是"回头重放"。
      await s.transitionIssue(issueId('b'), 'todo', 'done')

      const p2 = await s.listIssues({
        workspaceId: WS,
        status: ['todo'],
        limit: 2,
        cursor: 'b',
      })
      assert.deepEqual(
        p2.items.map((i) => i.id),
        ['c', 'd'],
        '必须从游标原本的位置继续，而不是回头重来',
      )
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('★ 垃圾游标要么返回空、要么返回全部，绝不静默回头重放', async () => {
    const d = await makeTempDir('cursor-junk')
    try {
      const s = await FileStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      for (const id of ['a', 'b', 'c']) {
        await s.insertIssue(makeIssue({ id, workspaceId: WS }))
      }

      // 大于全部 ⇒ 没有"之后"了，返回空并终止翻页
      const beyond = await s.listIssues({ workspaceId: WS, cursor: 'zzzz', limit: 2 })
      assert.deepEqual(beyond.items, [])
      assert.equal(beyond.nextCursor, null, '必须终止，否则调用方会一直问下去')

      // 小于全部 ⇒ 全部都在它之后
      const before = await s.listIssues({ workspaceId: WS, cursor: '0', limit: 2 })
      assert.deepEqual(before.items.map((i) => i.id), ['a', 'b'])
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('issue 支持状态过滤与子串检索（目录管理，FR-ISSUE-09/10）', async () => {
    const d = await makeTempDir('query')
    try {
      const s = await FileStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await s.insertIssue(makeIssue({ id: 'i-a', workspaceId: WS, title: '依赖漏洞', status: 'todo' }))
      await s.insertIssue(makeIssue({ id: 'i-b', workspaceId: WS, title: '文档错别字', status: 'done' }))

      const todo = await s.listIssues({ workspaceId: WS, status: ['todo'] })
      assert.deepEqual(todo.items.map((i) => i.id), ['i-a'])

      const searched = await s.listIssues({ workspaceId: WS, search: '漏洞' })
      assert.deepEqual(searched.items.map((i) => i.id), ['i-a'])

      const byAssignee = await s.listIssues({
        workspaceId: WS,
        assigneeId: 'nobody',
      })
      assert.equal(byAssignee.items.length, 0)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })
})

/**
 * 工具包（D40）的读写。
 *
 * 与 skill 是同一套形状（装进来、列出来、按 id 批量取、卸载），所以用例也
 * 逐条对齐；不同的只有两条**工具特有的语义**，都单独钉住了：
 *   · slug 只在**一个 workspace 内**唯一 ⇒ 同名 slug 跨工作区各有一份是合法的；
 *   · 包内文件与清单**就在记录里**（`files` / `manifest`），所以"重开后还在"
 *     必须连它们一起验，否则会漏掉"只把 id 与 slug 存对了"这种半截持久化。
 */
describe('工具包（D40）：CRUD 与卸载', () => {
  const WSA = wsId('ws-tool-a')
  const WSB = wsId('ws-tool-b')

  /** 每个用例自己开一份目录：互不干扰，也不必操心清理顺序。 */
  async function openScratch(prefix: string): Promise<{ store: FileStore; dir: string }> {
    const dir = await makeTempDir(prefix)
    const s = await FileStore.open({ dataDir: dir, fsync: false })
    for (const [id, name] of [
      [WSA, 'A'],
      [WSB, 'B'],
    ] as const) {
      await s.insertWorkspace({
        executeTemplate: '',
        reviewTemplate: '',
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

      // getTool 是跨 workspace 找的（与 getSkill 一致）：判决解析只拿得到 id
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

      const got = await s.listToolsByIds([toolId('t3'), toolId('t1')])
      assert.deepEqual(got.map((t) => t.id).sort(), ['t1', 't3'])
      // 传进来的顺序不影响结果集（调用方按 agent 的 toolIds 给，那是集合语义）
      assert.deepEqual(
        (await s.listToolsByIds([toolId('t1'), toolId('t3')])).map((t) => t.id).sort(),
        ['t1', 't3'],
      )
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
        '★ 跨 workspace 取会拿到别人的包——判决里的 <slug>.<动作名> 就指向了没声明过的动作',
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
      assert.equal(await s.deleteTool(toolId('t1')), false, '"它已经不在了"不是错误')
      // 从来没存在过的 id 同样是 false，不抛
      assert.equal(await s.deleteTool(toolId('ghost')), false)

      assert.equal(await s.getTool(toolId('t1')), null)
      assert.equal(await s.getToolBySlug(WSA, 'deploy'), null)
      assert.deepEqual((await s.listTools(WSA)).map((t) => t.slug), ['lint'])
      assert.deepEqual(
        await s.listToolsByIds([toolId('t1')]),
        [],
        '删完批量取也取不到（不是回落成 null 之类的东西）',
      )

      // ★ 同名 slug 的那一个在别的 workspace，必须原封不动
      assert.deepEqual((await s.listTools(WSB)).map((t) => t.slug), ['deploy'])
      assert.equal((await s.getToolBySlug(WSB, 'deploy'))?.id, 't3')
    } finally {
      await s.close()
      await cleanup(dir)
    }
  })

  test('★ 关闭后重开：工具包还在，清单 / 包内文件 / slug 查询都完好', async () => {
    /**
     * 文件适配器是**只追加日志**：删除靠日志里的 `del` 记录，重开时按顺序回放
     * 重建索引。所以这里删一个、留一个，重开后必须看到"剩下的那个在、删掉的那个
     * 不在"——只验"插入的还在"会漏掉 del 回放这条路。
     */
    const dir = await makeTempDir('tool-reopen')
    try {
      const a = await FileStore.open({ dataDir: dir, fsync: false })
      await a.insertWorkspace({
        executeTemplate: '',
        reviewTemplate: '',
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

      const b = await FileStore.open({ dataDir: dir, fsync: false })
      const back = await b.getTool(toolId('tool-1'))
      assert.equal(back?.slug, 'deploy')
      // 清单与包内文件都是这条记录的一部分，回放时必须原样带回来
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
        workDir: '/tmp/x',
      }),
      true,
    )
    const run = await store.getRun(RID)
    assert.equal(run?.startedAt, 123)
    assert.equal(run?.workDir, '/tmp/x')
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

  test('终态没有出边——重试必须新建 run（DR-3）', async () => {
    assert.equal(await store.transitionRun(RID, 'running', 'completed', { finishedAt: 200 }), true)
    await assert.rejects(() => store.transitionRun(RID, 'completed', 'running'))
  })

  test('不存在的 run ⇒ false（不抛）', async () => {
    assert.equal(await store.transitionRun(runId('nope'), 'queued', 'dispatched'), false)
  })
})

describe('工作目录串行化（D20）', () => {
  test('★ 同一目录被占用时可被查出——这是 waiting_local_directory 的依据', async () => {
    const d = await makeTempDir('workdir')
    try {
      const s = await FileStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await s.insertRun(
        makeRun({ id: 'r-hold', workspaceId: WS, agentId: 'a1', status: 'running', workDir: '/repo' }),
      )

      const held = await s.findRunHoldingWorkDir('/repo')
      assert.equal(held?.id, 'r-hold')

      // 排除自己时不算占用（自己当然占着）
      assert.equal(await s.findRunHoldingWorkDir('/repo', runId('r-hold')), null)
      // 别的目录不算
      assert.equal(await s.findRunHoldingWorkDir('/other'), null)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('已终态的 run 不再占用目录', async () => {
    const d = await makeTempDir('workdir2')
    try {
      const s = await FileStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await s.insertRun(
        makeRun({ id: 'r-done', workspaceId: WS, agentId: 'a1', status: 'completed', workDir: '/repo' }),
      )
      assert.equal(await s.findRunHoldingWorkDir('/repo'), null)
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
      const s = await FileStore.open({ dataDir: d, fsync: false })
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

      const found = await s.findActiveRunForSubjectAgent(
        { type: 'issue', id: 'i1' },
        agentId('a1'),
      )
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
      const s = await FileStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })

      const r1 = makeReport({ id: 'rep-1', workspaceId: WS, kind: 'ci-failure', dedupKey: 'k1' })
      const r2 = makeReport({ id: 'rep-2', workspaceId: WS, kind: 'ci-failure', dedupKey: 'k1' })

      assert.equal(await s.insertReport(r1), true)
      assert.equal(await s.insertReport(r2), false, '重复去重键必须被拒')
      assert.equal((await s.findReportByDedupKey('k1'))?.id, 'rep-1')

      // 不同去重键正常写入
      const r3 = makeReport({ id: 'rep-3', workspaceId: WS, kind: 'ci-failure', dedupKey: 'k2' })
      assert.equal(await s.insertReport(r3), true)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('去重索引在重开后仍然有效', async () => {
    const d = await makeTempDir('dedup2')
    try {
      const a = await FileStore.open({ dataDir: d, fsync: false })
      await a.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await a.insertReport(
        makeReport({ id: 'rep-x', workspaceId: WS, kind: 'k', dedupKey: 'dup-key' }),
      )
      await a.close()

      const b = await FileStore.open({ dataDir: d, fsync: false })
      assert.equal((await b.findReportByDedupKey('dup-key'))?.id, 'rep-x')
      assert.equal(
        await b.insertReport(
          makeReport({ id: 'rep-y', workspaceId: WS, kind: 'k', dedupKey: 'dup-key' }),
        ),
        false,
      )
      await b.close()
    } finally {
      await cleanup(d)
    }
  })
})

describe('动作幂等键（FR-ACTION-03）', () => {
  test('按幂等键可查回已存在的动作', async () => {
    const d = await makeTempDir('idem')
    try {
      const s = await FileStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })

      const action = {
        id: 'act-1' as ActionId,
        workspaceId: WS,
        verdictId: 'v-1' as VerdictId,
        type: 'comment.create' as const,
        plane: 'local' as const,
        params: { body: 'x' },
        status: 'proposed' as const,
        idempotencyKey: 'v-1:comment.create:{"body":"x"}',
        dryRun: false,
        result: null,
        error: null,
        rollbackRef: null,
        createdAt: 1,
        finishedAt: null,
      }
      await s.insertAction(action)

      assert.equal((await s.findActionByIdempotencyKey(action.idempotencyKey))?.id, 'act-1')
      assert.equal(await s.findActionByIdempotencyKey('nope'), null)

      // 状态机对动作同样生效
      assert.equal(await s.transitionAction(action.id, 'proposed', 'auto_approved'), true)
      assert.equal(await s.transitionAction(action.id, 'proposed', 'executing'), false)
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
      const s = await FileStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      const rid = runId('r-msg')
      await s.insertRun(makeRun({ id: 'r-msg', workspaceId: WS, agentId: 'a1' }))

      for (let seq = 0; seq < 5; seq++) {
        await s.appendRunMessage(rid, {
          seq,
          type: 'text',
          tool: null,
          content: `m${seq}`,
          input: null,
          output: null,
          outputTruncated: false,
          at: 1000, // ★ 故意用同一时间戳：补齐必须靠 seq，不能靠时间
        })
      }

      assert.equal(await s.lastRunMessageSeq(rid), 4)
      const all = await s.listRunMessages(rid)
      assert.deepEqual(all.map((m) => m.content), ['m0', 'm1', 'm2', 'm3', 'm4'])

      const tail = await s.listRunMessages(rid, 2)
      assert.deepEqual(tail.map((m) => m.content), ['m3', 'm4'])
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('重开后 lastSeq 被正确恢复', async () => {
    const d = await makeTempDir('messages2')
    try {
      const rid = runId('r-msg2')
      const a = await FileStore.open({ dataDir: d, fsync: false })
      await a.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await a.insertRun(makeRun({ id: 'r-msg2', workspaceId: WS, agentId: 'a1' }))
      await a.appendRunMessage(rid, {
        seq: 7,
        type: 'status',
        tool: null,
        content: 'x',
        input: null,
        output: null,
        outputTruncated: false,
        at: 1,
      })
      await a.close()

      const b = await FileStore.open({ dataDir: d, fsync: false })
      assert.equal(await b.lastRunMessageSeq(rid), 7)
      await b.close()
    } finally {
      await cleanup(d)
    }
  })

  test('给不存在的 run 追加消息 ⇒ 报错（不静默丢弃）', async () => {
    await assert.rejects(() => store.lastRunMessageSeq(runId('ghost')))
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
  })

  test('读回内容一致，未知引用返回 null', async () => {
    const enc = new TextEncoder()
    const text = '内容 with utf8 ✨'
    const ref = await store.putBlob(enc.encode(text))
    const back = await store.getBlob(ref)
    assert.equal(back && Buffer.from(back).toString('utf8'), text)
    assert.equal(await store.hasBlob(ref), true)

    const ghost = `sha256:${'0'.repeat(64)}` as typeof ref
    assert.equal(await store.getBlob(ghost), null)
    assert.equal(await store.hasBlob(ghost), false)
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
  test('按 run 取回审计记录，且不含 skill 指纹字段', async () => {
    const d = await makeTempDir('audit')
    try {
      const s = await FileStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      const rid = runId('r-audit')
      await s.insertRun(makeRun({ id: 'r-audit', workspaceId: WS, agentId: 'a1' }))

      await s.appendAudit({
        id: 'aud-1' as never,
        workspaceId: WS,
        runId: rid,
        subject: { type: 'issue', id: 'i1' },
        inputBlobRefs: [],
        skillRefs: [{ id: makeSkill({ id: 's1' }).id, slug: 'sec-vuln', source: 'local' }],
        runtimeDescriptorKey: 'claude',
        cliVersion: '2.1.220',
        modelId: 'claude-sonnet-4-5',
        promptHash: 'abc',
        argvRedacted: ['claude', '-p', '--output-format', 'stream-json'],
        verdictId: null,
        actionIds: [],
        queuedAt: 1,
        startedAt: 2,
        finishedAt: 3,
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          costUsdMicros: 1234,
          costSource: 'provider',
        },
      })

      const audits = await s.listAuditsByRun(rid)
      assert.equal(audits.length, 1)
      assert.equal(audits[0]?.skillRefs[0]?.slug, 'sec-vuln')
      // 成本用整数微美元，避免浮点漂移
      assert.equal(audits[0]?.usage?.costUsdMicros, 1234)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })
})

describe('压缩（compaction）', () => {
  test('★ 压缩后重开，数据完整——先落快照再丢日志', async () => {
    const d = await makeTempDir('compact')
    try {
      const a = await FileStore.open({ dataDir: d, fsync: false })
      await a.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      for (let i = 0; i < 5; i++) {
        await a.insertIssue(makeIssue({ id: `ci-${i}`, workspaceId: WS }))
      }
      await a.transitionIssue(
        (await a.listIssues({ workspaceId: WS })).items[0]!.id,
        'todo',
        'in_progress',
      )
      await a.compact()
      await a.close()

      const b = await FileStore.open({ dataDir: d, fsync: false })
      const all = await b.listIssues({ workspaceId: WS })
      assert.equal(all.items.length, 5)
      assert.equal(all.items.filter((i) => i.status === 'in_progress').length, 1)
      await b.close()
    } finally {
      await cleanup(d)
    }
  })

  test('压缩后继续写入，再重开仍完整', async () => {
    const d = await makeTempDir('compact2')
    try {
      const a = await FileStore.open({ dataDir: d, fsync: false })
      await a.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      await a.insertIssue(makeIssue({ id: 'before', workspaceId: WS }))
      await a.compact()
      await a.insertIssue(makeIssue({ id: 'after', workspaceId: WS }))
      await a.close()

      const b = await FileStore.open({ dataDir: d, fsync: false })
      const all = await b.listIssues({ workspaceId: WS })
      assert.deepEqual(
        all.items.map((i) => i.id).sort(),
        ['after', 'before'],
      )
      await b.close()
    } finally {
      await cleanup(d)
    }
  })
})

describe('deleteRun：删掉一条 run 连同它派生的一切', () => {
  /** 造一条"完整"的 run：有消息流、有引用它的对话轮次、有 verdict/action/artifact/audit。 */
  async function seedFullRun(s: FileStore, id: string) {
    const rid = runId(id)
    const agent = makeAgent({ id: 'a1', workspaceId: WS })
    await s.insertAgent(agent)
    await s.insertRun(makeRun({ id, workspaceId: WS, agentId: 'a1', status: 'completed' }))
    // 消息流：先写一条再读，保证 `runs/<id>/messages.jsonl` 真的落盘
    await s.appendRunMessage(rid, {
      seq: 0,
      type: 'text',
      tool: null,
      content: 'm0',
      input: null,
      output: null,
      outputTruncated: false,
      at: 1000,
    })
    // 对话：两个轮次，只有一个引用这条 run
    const convId = conversationId('c1')
    await s.insertConversation(makeConversation({ id: 'c1', workspaceId: WS, turnCount: 2 }))
    await s.insertChatTurn(
      makeChatTurn({ id: 't1', conversationId: 'c1', workspaceId: WS, seq: 1, runId: rid }),
    )
    await s.insertChatTurn(
      makeChatTurn({ id: 't2', conversationId: 'c1', workspaceId: WS, seq: 2, runId: null }),
    )
    // verdict + action + artifact
    const vid = 'v1' as VerdictId
    await s.insertVerdict({
      id: vid,
      workspaceId: WS,
      runId: rid,
      subject: { type: 'issue', id: 'i1' as never },
      status: 'dispatched_to_action',
      conclusion: 'pass',
      reasonCode: 'ok' as VerdictRecord['reasonCode'],
      confidence: 0.9,
      findings: [],
      action: { type: 'x.y', params: {} },
      escalateReason: null,
      invalidResolution: null,
      skillRefs: [],
      modelId: null,
      promptHash: null,
      createdAt: 1,
    })
    await s.insertAction({
      id: 'act1' as Action['id'],
      workspaceId: WS,
      verdictId: vid,
      type: 'x.y',
      plane: 'local',
      params: {},
      status: 'executed',
      idempotencyKey: 'k1',
      dryRun: false,
      result: null,
      error: null,
      rollbackRef: null,
      createdAt: 1,
      finishedAt: 1,
    })
    await s.insertArtifact({
      id: 'art1' as Artifact['id'],
      workspaceId: WS,
      runId: rid,
      kind: 'document',
      summary: '产出',
      blobRef: `sha256:${'a'.repeat(64)}` as BlobRef,
      createdAt: 1,
    })
    // 审计：**必须保留**（可追溯性是"发生过什么"的不可变历史）
    await s.appendAudit({
      id: 'aud1' as AuditRecord['id'],
      workspaceId: WS,
      runId: rid,
      subject: { type: 'issue', id: 'i1' },
      inputBlobRefs: [],
      skillRefs: [],
      runtimeDescriptorKey: 'claude',
      cliVersion: '1',
      modelId: null,
      promptHash: null,
      argvRedacted: ['claude'],
      verdictId: null,
      actionIds: [],
      queuedAt: 1,
      startedAt: null,
      finishedAt: null,
      usage: null,
    })
    return { rid, convId }
  }

  test('删掉一条孤立 run：返回 true、记录没了、消息流文件没了；再删一次返回 false（幂等，不是错误）', async () => {
    const d = await makeTempDir('delrun-1')
    try {
      const s = await FileStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      const rid = runId('r-iso')
      await s.insertRun(makeRun({ id: 'r-iso', workspaceId: WS, agentId: 'a1', status: 'failed' }))
      await s.appendRunMessage(rid, {
        seq: 0,
        type: 'text',
        tool: null,
        content: 'm0',
        input: null,
        output: null,
        outputTruncated: false,
        at: 1000,
      })

      assert.equal(await s.deleteRun(rid), true)
      assert.equal(await s.getRun(rid), null)
      // run 已不存在：listRunMessages 在 run 缺失时抛错（与"run 还在但没消息"区分）
      await assert.rejects(() => s.listRunMessages(rid), /找不到 run/)
      // 消息流文件真的从磁盘上没了
      await assert.rejects(
        access(join(d, 'runs', 'r-iso', 'messages.jsonl')),
        (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
      )
      // 第二次删：本来就没有，不是错误
      assert.equal(await s.deleteRun(rid), false)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('★ 连带删除：引用它的对话轮次删掉、另一个轮次与对话保留、turnCount 重算', async () => {
    const { rid, convId } = await seedFullRun(store, 'r-full')
    assert.equal((await store.getConversation(convId))?.turnCount, 2)

    assert.equal(await store.deleteRun(rid), true)

    // run 本体没了
    assert.equal(await store.getRun(rid), null)
    // 引用它的那轮没了、没引用它的那轮还在
    const turns = await store.listChatTurns(convId)
    assert.deepEqual(
      turns.map((t) => t.id),
      [chatTurnId('t2')],
    )
    // turnCount 重算成 1（冗余字段不许留在旧值上）
    assert.equal((await store.getConversation(convId))?.turnCount, 1)
  })

  test('★ 连带删除：verdict、由它触发的 action、artifact 都删掉；审计记录保留', async () => {
    const { rid } = await seedFullRun(store, 'r-full2')
    assert.equal(await store.deleteRun(rid), true)

    assert.deepEqual(await store.listVerdictsByRun(rid), [])
    assert.deepEqual(await store.listActionsByVerdict('v1' as VerdictId), [])
    assert.deepEqual(await store.listArtifactsByRun(rid), [])
    // 审计是"发生过什么"的不可变历史：run 删了它也得读得到
    const audits = await store.listAuditsByRun(rid)
    assert.equal(audits.length, 1)
    assert.equal(audits[0]!.id, 'aud1')
  })

  test('★ 孤立对话（没有轮次引用这条 run）不受影响', async () => {
    const d = await makeTempDir('delrun-2')
    try {
      const s = await FileStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
      const rid = runId('r-orphan')
      await s.insertRun(makeRun({ id: 'r-orphan', workspaceId: WS, agentId: 'a1', status: 'completed' }))
      const convId = conversationId('c2')
      await s.insertConversation(makeConversation({ id: 'c2', workspaceId: WS, turnCount: 1 }))
      await s.insertChatTurn(
        makeChatTurn({ id: 't3', conversationId: 'c2', workspaceId: WS, seq: 1, runId: runId('other') }),
      )

      await s.deleteRun(rid)
      // 不引用这条 run 的对话原样保留
      assert.deepEqual(
        (await s.listChatTurns(convId)).map((t) => t.id),
        [chatTurnId('t3')],
      )
      assert.equal((await s.getConversation(convId))?.turnCount, 1)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })
})

describe('deleteIssue：删掉一条任务连同挂它名下的一切', () => {
  test('★ 删任务 = 执行 run + 审核链 run + 评论 + issue 本体一起删；审计保留；聊天 run 不碰', async () => {
    const d = await makeTempDir('delissue-1')
    try {
      const s = await FileStore.open({ dataDir: d, fsync: false })
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })

      // 任务 + 评论
      await s.insertIssue(makeIssue({ id: 'i-del', workspaceId: WS, title: '要删的任务' }))
      await s.insertComment({
        id: 'c1' as never,
        workspaceId: WS,
        issueId: 'i-del' as never,
        authorType: 'member' as const,
        authorId: 'me',
        type: 'comment' as const,
        content: '评论',
        createdAt: 1,
      })

      // 执行 run（subject = issue）→ 审核 run（subject = 执行 run）
      const execId = runId('r-exec')
      await s.insertRun(
        makeRun({
          id: 'r-exec',
          workspaceId: WS,
          agentId: 'a1',
          status: 'completed',
          subject: { type: 'issue', id: 'i-del' },
          trigger: 'assignment',
        }),
      )
      await s.appendRunMessage(execId, {
        seq: 0,
        type: 'text',
        tool: null,
        content: 'm0',
        input: null,
        output: null,
        outputTruncated: false,
        at: 1000,
      })
      await s.insertRun(
        makeRun({
          id: 'r-review',
          workspaceId: WS,
          agentId: 'a1',
          status: 'completed',
          subject: { type: 'run', id: 'r-exec' },
          trigger: 'assignment',
          kind: 'review',
        }),
      )

      // 聊天 run（subject = conversation）——删任务**不能**碰它
      await s.insertRun(
        makeRun({
          id: 'r-chat',
          workspaceId: WS,
          agentId: 'a1',
          status: 'completed',
          subject: { type: 'conversation', id: 'c-chat' },
          trigger: 'chat',
        }),
      )

      // 审计（挂在执行 run 上）：保留
      await s.appendAudit({
        id: 'aud-del' as AuditRecord['id'],
        workspaceId: WS,
        runId: execId,
        subject: { type: 'issue', id: 'i-del' },
        inputBlobRefs: [],
        skillRefs: [],
        runtimeDescriptorKey: 'claude',
        cliVersion: '1',
        modelId: null,
        promptHash: null,
        argvRedacted: ['claude'],
        verdictId: null,
        actionIds: [],
        queuedAt: 1,
        startedAt: null,
        finishedAt: null,
        usage: null,
      })

      assert.equal(await s.deleteIssue(issueId('i-del')), true)

      assert.equal(await s.getIssue(issueId('i-del')), null)
      assert.deepEqual(await s.listComments(issueId('i-del')), [])
      assert.equal(await s.getRun(execId), null)
      assert.equal(await s.getRun(runId('r-review')), null)
      // 消息流文件也删了
      await assert.rejects(
        access(join(d, 'runs', 'r-exec', 'messages.jsonl')),
        (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
      )
      // 聊天 run 安然无恙
      assert.ok(await s.getRun(runId('r-chat')))
      // 审计保留
      assert.equal((await s.listAuditsByRun(execId)).length, 1)
      await s.close()
    } finally {
      await cleanup(d)
    }
  })

  test('★ 不存在的任务返回 false（幂等，不是错误）', async () => {
    assert.equal(await store.deleteIssue(issueId('nope')), false)
  })
})
