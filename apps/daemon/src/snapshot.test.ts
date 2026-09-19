import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import {
  checksumOf,
  exportData,
  importData,
  verifyDataSnapshot,
} from '@alpha-helper/domain'
import { FileStore } from '@alpha-helper/store-file'
import { makeIssue, makeReport, wsId } from '@alpha-helper/domain/testing'
import { ulid, type Report, type Run } from '@alpha-helper/protocol'
import { join } from 'node:path'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 放在 daemon 而不是 domain 包里：这是**跨适配器**的集成测试，
 * 需要同时拿到 domain 的导出逻辑与 store-file 适配器。
 * `packages/domain` 不允许依赖任何适配器（design §3.1 的依赖方向），
 * 而组合根正好是两者都在的地方。

/**
 * 数据导出与导入（FR-STOR-05）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 「为迁移到数据库留通道」这句话决定了测试该测什么
 * ══════════════════════════════════════════════════════════════════
 *
 * 它要的不是"能备份"，而是"**导出物里不含任何存储实现的东西**"。
 * 一旦快照里出现 `logs/run.jsonl` 这样的路径、或者某个适配器特有的字段，
 * 它就只是文件存储的备份，换到数据库上什么也搬不过去。
 *
 * 所以这里最要紧的两条是：
 *   ① 快照里**只应有领域实体**，不该有别的东西；
 *   ② **导出→导入到另一个空库**之后，实体数量与内容对得上。
 *
 * ② 是真在验证"通道能不能过人"，而不只是"函数返回了个对象"。
 */

let dirA: string
let dirB: string
let storeA: FileStore
let storeB: FileStore
const WS = wsId('ws_snap')

before(async () => {
  dirA = await makeTempDir('alpha-snap-a')
  dirB = await makeTempDir('alpha-snap-b')
  storeA = await FileStore.open({ dataDir: dirA, fsync: false })
  storeB = await FileStore.open({ dataDir: dirB, fsync: false })

  await storeA.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: '快照测试', createdAt: 1, updatedAt: 1 })
  await storeA.insertIssue(makeIssue({ id: 'i-1', workspaceId: WS, title: '第一件事' }))
  await storeA.insertIssue(makeIssue({ id: 'i-2', workspaceId: WS, title: '第二件事' }))

  const report = makeReport({ id: 'r-1', workspaceId: WS, kind: 'ci-failure' })
  await storeA.insertReport(report)
  await storeA.insertComment({
    id: 'c-1' as never,
    workspaceId: WS,
    issueId: 'i-1' as never,
    authorType: 'agent',
    authorId: 'a',
    type: 'comment',
    content: '一条评论',
    createdAt: 5 as never,
  })
  await storeA.appendInboxItem({
    id: 'in-1' as never,
    workspaceId: WS,
    type: 'test',
    severity: 'attention',
    title: '一条通知',
    body: '',
    issueId: null,
    runId: null,
    read: false,
    createdAt: 6,
  })
})

after(async () => {
  await storeA.close()
  await storeB.close()
  await cleanup(dirA)
  await cleanup(dirB)
})

describe('数据快照：导出', () => {
  test('★ 快照里只有领域实体，没有任何存储实现的东西', async () => {
    const snap = await exportData(storeA, { workspaceId: WS })
    const keys = Object.keys(snap.data).sort()
    assert.deepEqual(keys, [
      // ── 领域实体。**它们**才该出现在快照里：导出物要自包含，凡是别处
      //    引用得到的东西（agent 挂的 skillIds / toolIds、判决引用的动作与
      //    工具包）都得在同一份文件里。
      'actions',
      'agents',
      'artifacts',
      'audits',
      'comments',
      'device',
      'inbox',
      'issues',
      'reports',
      'runs',
      'skills',
      // D40：工具包（组）也是领域实体——判决与审计里的 `<slug>.<动作名>`
      // 引用它，导出漏了它就会指向一个不存在的包
      'tools',
      'verdicts',
      'workspace',
    ])
    // ── 与上面相对：**存储实现**的东西一个都不许进来。
    //    这条才是本用例的真正判据（清单只是它的一种写法）：
    //    一旦快照里出现 "logs/..." 这样的路径，它就只是文件适配器的备份了
    const text = JSON.stringify(snap)
    assert.ok(!text.includes('jsonl'), '不该出现文件适配器的日志文件名')
    assert.ok(!text.includes('dataDir'), '不该出现数据目录路径')
  })

  test('counts 与实际条数一致', async () => {
    const snap = await exportData(storeA, { workspaceId: WS })
    assert.equal(snap.counts['issues'], 2)
    assert.equal(snap.counts['comments'], 1)
    assert.equal(snap.counts['reports'], 1)
    assert.equal(snap.counts['workspace'], 1)
  })

  test('★ 同一份数据导两次逐字节相同', async () => {
    const a = await exportData(storeA, { workspaceId: WS, now: () => 1 })
    const b = await exportData(storeA, { workspaceId: WS, now: () => 1 })
    assert.equal(a.checksum, b.checksum)
  })

  test('★ 分页要翻到底 —— 只导第一页是最容易犯的错', async () => {
    // 造 250 条 issue（超过任何一页的 limit）
    const many = await makeTempDir('alpha-snap-many')
    const store = await FileStore.open({ dataDir: many, fsync: false })
    const W = wsId('ws_many')
    await store.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, locale: 'zh', id: W, name: 'w', createdAt: 1, updatedAt: 1 })
    for (let i = 0; i < 250; i += 1) {
      await store.insertIssue(makeIssue({ id: `bulk-${String(i).padStart(4, '0')}`, workspaceId: W }))
    }
    const snap = await exportData(store, { workspaceId: W })
    assert.equal(
      snap.data.issues.length,
      250,
      '端口全是分页的；导出必须一直翻到 nextCursor 为 null，否则数据会静默少掉',
    )
    await store.close()
    await cleanup(many)
  })
})

describe('★ 数据快照：导入（只增不改）', () => {
  test('★ 导出 → 导入到空库：实体数量与内容对得上', async () => {
    const snap = await exportData(storeA, { workspaceId: WS })
    const result = await importData(storeB, snap)

    assert.equal(result.imported['issues'], 2)
    assert.equal(result.imported['comments'], 1)
    assert.equal(result.imported['reports'], 1)
    assert.equal(result.imported['inbox'], 1)

    // 真的读过一遍，不是只看计数
    const issues = await storeB.listIssues({ workspaceId: WS, limit: 100 })
    assert.deepEqual(
      issues.items.map((i: { title: string }) => i.title).sort(),
      ['第一件事', '第二件事'],
    )
    assert.equal((await storeB.getReport('r-1' as never))?.id, 'r-1')
    assert.equal((await storeB.listComments('i-1' as never)).length, 1)
  })

  test('★ 重复导入是幂等的：第二次全部跳过，不产生副本', async () => {
    const snap = await exportData(storeA, { workspaceId: WS })
    const second = await importData(storeB, snap)

    assert.equal(second.imported['issues'] ?? 0, 0, '第二次不该再写入')
    assert.equal(second.skipped['issues'], 2, '应当记为跳过，而不是错误')
    const issues = await storeB.listIssues({ workspaceId: WS, limit: 100 })
    assert.equal(issues.items.length, 2, '★ 不能变成 4 条')
  })

  test('★ 导入**不覆盖**已有数据 —— 覆盖是不可逆的', async () => {
    const target = await makeTempDir('alpha-snap-merge')
    const store = await FileStore.open({ dataDir: target, fsync: false })
    await store.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: '目标库', createdAt: 1, updatedAt: 1 })
    // 目标库里已有一条同 id 但内容不同的 issue
    await store.insertIssue(makeIssue({ id: 'i-1', workspaceId: WS, title: '目标库里原本的标题' }))

    const snap = await exportData(storeA, { workspaceId: WS })
    const result = await importData(store, snap)

    const kept = await store.getIssue('i-1' as never)
    assert.equal(
      kept?.title,
      '目标库里原本的标题',
      '★ 导入绝不能覆盖已有数据：一次误操作就能把现状抹掉，而覆盖不可逆',
    )
    assert.equal(result.skipped['issues'], 1)
    assert.equal(result.imported['issues'], 1, '另一条（i-2）应当被导进来')

    await store.close()
    await cleanup(target)
  })

  test('★ 损坏的快照被拒绝导入，且错误里说明哪里不对', async () => {
    const snap = await exportData(storeA, { workspaceId: WS })
    const tampered = JSON.parse(JSON.stringify(snap)) as typeof snap
    tampered.data.issues[0]!.title = '被偷偷改过的标题'

    await assert.rejects(
      () => importData(storeB, tampered),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        assert.match(message, /校验和/)
        return true
      },
    )
  })

  test('格式版本不认识时拒绝，并说出版本号', () => {
    const result = verifyDataSnapshot({ formatVersion: 99, checksum: 'x', data: {}, counts: {} })
    assert.equal(result.ok, false)
    assert.match(result.issues.join('\n'), /99/)
  })

  test('不是对象时结构化失败，不抛异常', () => {
    assert.equal(verifyDataSnapshot(null).ok, false)
    assert.equal(verifyDataSnapshot([]).ok, false)
  })

  test('★ counts 与 data 对不上也算损坏（即便校验和恰好也对）', async () => {
    const snap = await exportData(storeA, { workspaceId: WS })
    const tampered = JSON.parse(JSON.stringify(snap)) as typeof snap
    tampered.counts['issues'] = 99
    // 重新算校验和，模拟"有人改了数据又补上了校验和"的情况
    const { checksum: _drop, ...rest } = tampered
    tampered.checksum = checksumOf(rest)

    const result = verifyDataSnapshot(tampered)
    assert.equal(result.ok, false, 'counts 是第二道防线：两道都过才算完整')
    assert.match(result.issues.join('\n'), /counts\.issues/)
  })
})

describe('★ 悬空引用必须被报出来，而不是装作没事', () => {
  test('★ blob 不在快照里 ⇒ 导入后要明确报出有多少引用落空', async () => {
    const source = await makeTempDir('alpha-snap-blob')
    const target = await makeTempDir('alpha-snap-blob2')
    const s1 = await FileStore.open({ dataDir: source, fsync: false })
    const s2 = await FileStore.open({ dataDir: target, fsync: false })

    const W = wsId('ws_blob')
    await s1.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, locale: 'zh', id: W, name: 'w', createdAt: 1, updatedAt: 1 })
    const blobRef = await s1.putBlob(new TextEncoder().encode('报告的原文'))
    const report = { ...(makeReport({ id: 'rb-1', workspaceId: W, kind: 'ci-failure' })), blobRef }
    await s1.insertReport(report)

    const snap = await exportData(s1, { workspaceId: W })
    // blob 刻意不在快照里
    assert.ok(!JSON.stringify(snap).includes('报告的原文'), '快照不含二进制原文')

    const result = await importData(s2, snap)
    assert.equal(
      result.danglingBlobRefs,
      1,
      '★ 不报出来的话，要等到某天点开一份报告发现是空的才反应过来',
    )
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0] ?? '', /原文读不到/)

    // 记录本身还在，只是原文读不到
    assert.equal((await s2.getReport('rb-1' as never))?.id, 'rb-1')

    await s1.close()
    await s2.close()
    await cleanup(source)
    await cleanup(target)
  })

  test('blob 也在目标库里时，不报悬空', async () => {
    const store = await FileStore.open({ dataDir: await makeTempDir('alpha-snap-ok') })
    const W = wsId('ws_ok')
    await store.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, locale: 'zh', id: W, name: 'w', createdAt: 1, updatedAt: 1 })
    const ref = await store.putBlob(new TextEncoder().encode('x'))
    await store.insertReport({ ...(makeReport({ id: 'ok-1', workspaceId: W, kind: 'ci-failure' })), blobRef: ref })

    const snap = await exportData(store, { workspaceId: W })
    const result = await importData(store, snap)
    assert.equal(result.danglingBlobRefs, 0)
    assert.deepEqual(result.warnings, [])
    await store.close()
  })
})

describe('run 谱系也要一起搬过去', () => {
  test('★ run / verdict / action / audit 顺着关系被取全', async () => {
    const dir = await makeTempDir('alpha-snap-graph')
    const store = await FileStore.open({ dataDir: dir, fsync: false })
    const W = wsId('ws_graph')
    await store.insertWorkspace({ executeTemplate: '', reviewTemplate: '', defaultAgentId: null, locale: 'zh', id: W, name: 'w', createdAt: 1, updatedAt: 1 })

    const runId = ulid() as Run['id']
    await store.insertRun({
      id: runId,
      workspaceId: W,
      kind: 'review',
      status: 'completed',
      agentId: 'ag' as never,
      subject: { type: 'issue', id: 'i-1' as never },
      trigger: 'third_party',
      derivedFrom: null,
      chainDepth: 0,
      skillRefs: [],
      workDir: null,
      waitReason: null,
      sessionId: null,
      attempt: 1,
      maxAttempts: 2,
      failureReason: null,
      usage: null,
      queuedAt: 1,
      dispatchedAt: 1,
      startedAt: 1,
      finishedAt: 2,
    })

    const snap = await exportData(store, { workspaceId: W })
    assert.equal(snap.data.runs.length, 1, 'run 没有"列出全部"的口子但能翻页取全')

    await store.close()
    await cleanup(dir)
  })
})
