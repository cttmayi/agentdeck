import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { exportAudit, verifyAuditExport, aggregateCost } from '@agentdeck/domain'
import { FileStore } from '@agentdeck/store-file'
import type { AuditRecord, Run } from '@agentdeck/protocol'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 审计导出与成本（M4）：**走真实存储**的那一半。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么纯函数测试不够
 * ══════════════════════════════════════════════════════════════════
 *
 * `checksumOf` / `verifyAuditExport` 的测试只证明了"给定一份文档，校验和能
 * 发现改动"。但导出真正会出错的地方在**取数**那一段：
 *
 *   - 只导出了一个工作区的数据？还是把别的工作区的也带出来了？
 *   - 同一份数据导两次，字节一样吗？（不一样的话"对比两次导出"就没法用）
 *   - run 的审计链是不是都取到了？
 *
 * 这些只有接上真存储才测得到。
 */

const WS_A = 'ws_a' as Run['workspaceId']
const WS_B = 'ws_b' as Run['workspaceId']

let dir: string
let store: FileStore

before(async () => {
  dir = await makeTempDir('reporting')
  store = await FileStore.open({ dataDir: dir, fsync: false })
  await store.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS_A, name: 'A', createdAt: 1, updatedAt: 1 })
  await store.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS_B, name: 'B', createdAt: 2, updatedAt: 2 })
})

after(async () => {
  await store.close()
  await cleanup(dir)
})

function makeAudit(over: {
  id: string
  workspaceId: Run['workspaceId']
  runId: string
  usage?: AuditRecord['usage']
}): AuditRecord {
  return {
    id: over.id,
    workspaceId: over.workspaceId,
    runId: over.runId,
    subject: { type: 'issue', id: 'issue-1' },
    inputBlobRefs: [],
    skillRefs: [],
    runtimeDescriptorKey: 'claude',
    cliVersion: null,
    modelId: null,
    promptHash: null,
    argvRedacted: ['claude', '-p', '***'],
    verdictId: null,
    actionIds: [],
    queuedAt: 1000,
    startedAt: 1001,
    finishedAt: 2000,
    usage: over.usage ?? null,
  } as unknown as AuditRecord
}

async function putRun(id: string, ws: Run['workspaceId'], usage: AuditRecord['usage']): Promise<void> {
  const now = Date.now()
  const run: Run = {
    id: id as Run['id'],
    workspaceId: ws,
    kind: 'review',
    status: 'completed',
    agentId: 'agent-1' as Run['agentId'],
    subject: { type: 'issue', id: 'issue-1' as never },
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
    usage,
    queuedAt: now,
    dispatchedAt: now,
    startedAt: now,
    finishedAt: now,
  }
  await store.insertRun(run)
  await store.appendAudit(makeAudit({ id: `audit-${id}`, workspaceId: ws, runId: id, usage }))
}

describe('审计导出（走真实存储）', () => {
  test('★ 只导出指定工作区，不把别人的数据带出来', async () => {
    await putRun('ra-1', WS_A, { inputTokens: 10, outputTokens: 5, costUsdMicros: 100, costSource: 'provider' })
    await putRun('rb-1', WS_B, { inputTokens: 999, outputTokens: 999, costUsdMicros: 999, costSource: 'provider' })

    const doc = await exportAudit(store, { workspaceId: WS_A })
    assert.equal(doc.count, 1, '只该有 A 工作区那一条')
    assert.ok(
      doc.records.every((r) => (r.workspaceId as string) === WS_A),
      '混进别的 workspace 的审计记录是数据泄漏，不是小瑕疵',
    )
    assert.equal(verifyAuditExport(doc).ok, true)
  })

  test('★ 同一份数据导两次必须逐字节相同 —— 否则"对比两次导出"没法用', async () => {
    const a = await exportAudit(store, { workspaceId: WS_A, now: () => 12345 })
    const b = await exportAudit(store, { workspaceId: WS_A, now: () => 12345 })
    assert.deepEqual(a, b)
    assert.equal(a.checksum, b.checksum)
  })

  test('记录按 runId 稳定排序，与写入顺序无关', async () => {
    const doc = await exportAudit(store, { workspaceId: WS_A })
    const runIds = doc.records.map((r) => r.runId as string)
    assert.deepEqual([...runIds].sort(), runIds, '必须是排好序的')
  })

  test('可以只导某一条 run', async () => {
    const doc = await exportAudit(store, { workspaceId: WS_A, runIds: ['ra-1'] })
    assert.equal(doc.count, 1)
    assert.equal(doc.records[0]?.runId, 'ra-1')
  })

  test('★ 导出物里带着能力边界说明，因为它会被带出本机', async () => {
    const doc = await exportAudit(store, { workspaceId: WS_A })
    const text = doc.limitations.join('\n')
    assert.match(text, /指纹/, '要说明"不可逐字节复现"')
    assert.match(text, /脱敏/, '要说明 argv 被脱敏')
    assert.match(text, /不是执行凭据/, '要说清它不能用来重放')
  })

  test('空工作区导出一份合法的空文档，而不是报错', async () => {
    const doc = await exportAudit(store, { workspaceId: 'ws_empty' as Run['workspaceId'] })
    assert.equal(doc.count, 0)
    assert.equal(verifyAuditExport(doc).ok, true)
  })

  test('★ 改动导出文件里的任何一条记录都会被校验和抓到', async () => {
    const doc = await exportAudit(store, { workspaceId: WS_A })
    const tampered = JSON.parse(JSON.stringify(doc)) as typeof doc
    ;(tampered.records[0] as unknown as Record<string, unknown>)['argvRedacted'] = [
      'claude',
      '-p',
      '偷偷换掉的参数',
    ]
    assert.equal(verifyAuditExport(tampered).ok, false)
  })
})

describe('成本聚合（走真实存储的用量字段）', () => {
  test('★ 没上报用量的 run 被单独计数，不被当成零成本', async () => {
    const page = await store.listRuns({ workspaceId: WS_A, limit: 100 })
    const report = aggregateCost(
      page.items.map((r) => ({ agentId: r.agentId as string, kind: r.kind, usage: r.usage })),
    )
    assert.ok(report.total.runs >= 1)
    // 这个工作区里 ra-1 有用量；没有用量的那些必须体现在 runsWithoutUsage 里
    assert.equal(
      report.total.runs,
      page.items.length,
      '每一条 run 都要被计入总数，不管有没有用量',
    )
    assert.equal(report.runsWithoutUsage, page.items.filter((r) => !r.usage).length)
  })
})
