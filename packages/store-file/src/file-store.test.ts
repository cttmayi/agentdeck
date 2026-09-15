import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { IllegalTransitionError } from '@alpha-helper/domain'
import {
  agentId,
  issueId,
  makeAgent,
  makeIssue,
  makeReport,
  makeRun,
  makeSkill,
  reportId,
  runId,
  wsId,
} from '@alpha-helper/domain/testing'
import type { ActionId, RunId, VerdictId } from '@alpha-helper/protocol'
import { FileStore } from './file-store.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

let dir: string
let store: FileStore

const WS = wsId('ws-1')

before(async () => {
  dir = await makeTempDir('store')
  store = await FileStore.open({ dataDir: dir, fsync: false })
  await store.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: '默认', createdAt: Date.now(), updatedAt: Date.now() })
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
      await a.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
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
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
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
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
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
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
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
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
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
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
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
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
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
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
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
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: 'w', createdAt: 1, updatedAt: 1 })

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
      await a.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
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
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: 'w', createdAt: 1, updatedAt: 1 })

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
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
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
      await a.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
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
      await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
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
      await a.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
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
      await a.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
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
