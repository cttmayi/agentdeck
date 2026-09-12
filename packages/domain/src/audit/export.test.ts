import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  AUDIT_EXPORT_FORMAT_VERSION,
  type AuditRecord,
  type TokenUsage,
} from '@alpha-helper/protocol'
import { aggregateCost, checksumOf, verifyAuditExport } from './export.ts'

/**
 * 审计导出的校验和与成本聚合。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这两件事的共同点：**数字必须可信**
 * ══════════════════════════════════════════════════════════════════
 *
 * 审计导出会被带出本机、存档、对比。一份被改过却"看起来一模一样"的
 * 审计文件，比完全没有审计更糟——它给了人虚假的确定性。
 *
 * 成本同理：一个把缺失数据当零的总数，会让人按错误的数量级做决定。
 */

function makeAudit(over: Record<string, unknown> = {}): AuditRecord {
  return {
    ...over,
    id: 'audit-1',
    workspaceId: 'ws_1',
    runId: 'run-1',
    subject: { type: 'issue', id: 'issue-1' },
    inputBlobRefs: [],
    skillRefs: [],
    runtimeDescriptorKey: 'claude',
    cliVersion: null,
    modelId: null,
    promptHash: null,
    argvRedacted: ['claude', '-p', '***'],
    contextBlockHash: null,
    verdictId: null,
    actionIds: [],
    queuedAt: 1000,
    startedAt: 1001,
    finishedAt: 2000,
    usage: null,
  } as unknown as AuditRecord
}

describe('审计导出：校验和必须真的能发现改动', () => {
  test('★ 原样校验通过', () => {
    const doc = {
      formatVersion: AUDIT_EXPORT_FORMAT_VERSION,
      exportedAt: 1,
      workspaceId: 'ws_1',
      count: 1,
      limitations: ['x'],
      records: [makeAudit()],
      checksum: '',
    }
    doc.checksum = checksumOf({ ...doc, checksum: undefined } as never)
    // 用与 exportAudit 一致的口径重算
    const { checksum, ...rest } = doc
    doc.checksum = checksumOf(rest)
    assert.notEqual(checksum, '', '必须有 checksum')
    assert.deepEqual(verifyAuditExport(doc), { ok: true, issues: [] })
  })

  test('★ 改动任意一个字段都会被查出来，并且说明是"被改过"', () => {
    const doc: Record<string, unknown> = {
      formatVersion: AUDIT_EXPORT_FORMAT_VERSION,
      exportedAt: 1,
      workspaceId: 'ws_1',
      count: 1,
      limitations: [],
      records: [makeAudit()],
    }
    doc['checksum'] = checksumOf(doc)

    const tampered = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>
    ;(tampered['records'] as AuditRecord[])[0]!.modelId = '偷偷换成别的模型'

    const result = verifyAuditExport(tampered)
    assert.equal(result.ok, false)
    assert.match(result.issues.join('\n'), /校验和/)
  })

  test('★ 删掉一条记录也会被发现（count 与 records 对不上）', () => {
    const base: Record<string, unknown> = {
      formatVersion: AUDIT_EXPORT_FORMAT_VERSION,
      exportedAt: 1,
      workspaceId: 'ws_1',
      count: 2,
      limitations: [],
      records: [makeAudit({ id: 'a' }), makeAudit({ id: 'b' })],
    }
    base['checksum'] = checksumOf(base)

    const truncated = JSON.parse(JSON.stringify(base)) as Record<string, unknown>
    truncated['records'] = [(truncated['records'] as AuditRecord[])[0]]

    const result = verifyAuditExport(truncated)
    assert.equal(result.ok, false)
    assert.match(result.issues.join('\n'), /截断|count/)
  })

  test('★ 键顺序不同但内容相同 —— 必须仍然通过（否则对比两次导出就没法用）', () => {
    const a: Record<string, unknown> = { b: 1, a: 2, c: { z: 1, y: 2 } }
    const b: Record<string, unknown> = { c: { y: 2, z: 1 }, a: 2, b: 1 }
    assert.equal(checksumOf(a), checksumOf(b))
  })

  test('数组顺序**是**内容的一部分 —— 不能被规范化掉', () => {
    assert.notEqual(checksumOf({ xs: [1, 2] }), checksumOf({ xs: [2, 1] }))
  })

  test('格式版本不认识时给出版本号，而不是笼统的失败', () => {
    const result = verifyAuditExport({
      formatVersion: 99,
      checksum: 'x',
      records: [],
      count: 0,
    })
    assert.equal(result.ok, false)
    assert.match(result.issues.join('\n'), /99/)
    assert.match(result.issues.join('\n'), new RegExp(String(AUDIT_EXPORT_FORMAT_VERSION)))
  })

  test('不是对象时返回结构化失败，而不是抛异常', () => {
    assert.equal(verifyAuditExport(null).ok, false)
    assert.equal(verifyAuditExport('text').ok, false)
    assert.equal(verifyAuditExport([]).ok, false)
  })

  test('缺少 checksum 时明确报出来', () => {
    const result = verifyAuditExport({
      formatVersion: AUDIT_EXPORT_FORMAT_VERSION,
      records: [],
      count: 0,
    })
    assert.equal(result.ok, false)
    assert.match(result.issues.join('\n'), /checksum/)
  })
})

describe('成本聚合', () => {
  const usage = (micros: number, source: 'provider' | 'estimated' = 'provider'): TokenUsage => ({
    inputTokens: 100,
    outputTokens: 50,
    costUsdMicros: micros,
    costSource: source,
  })

  test('按 agent 与 kind 分组，并按成本降序', () => {
    const report = aggregateCost([
      { agentId: 'A', kind: 'execute', usage: usage(500) },
      { agentId: 'B', kind: 'review', usage: usage(1500) },
      { agentId: 'A', kind: 'review', usage: usage(200) },
    ])

    assert.equal(report.total.runs, 3)
    assert.equal(report.total.costUsdMicros, 2200)
    assert.equal(report.total.inputTokens, 300)
    assert.deepEqual(
      report.byKind.map((b) => b.key),
      ['review', 'execute'],
      '贵的在前——目的是让花钱的地方一眼可见',
    )
    assert.equal(report.byKind[0]?.costUsdMicros, 1700)
    assert.equal(report.runsWithoutUsage, 0)
  })

  test('★ 缺失用量必须被显式报出来，不能当零算', () => {
    const report = aggregateCost([
      { agentId: 'A', kind: 'execute', usage: usage(1000) },
      { agentId: 'A', kind: 'execute', usage: null },
      { agentId: 'A', kind: 'execute', usage: null },
    ])

    assert.equal(report.total.runs, 3, '三条 run 都要被计入')
    assert.equal(report.total.costUsdMicros, 1000, '缺失的不能被算成零成本以外的任何东西')
    assert.equal(
      report.runsWithoutUsage,
      2,
      '★ 不报出来的话，"总成本 1000"会被误读成"这三条一共花了 1000"',
    )
  })

  test('★ 估算成本被单独计数 —— 估算与上报不能混为一谈', () => {
    const report = aggregateCost([
      { agentId: 'A', kind: 'execute', usage: usage(100, 'provider') },
      { agentId: 'A', kind: 'execute', usage: usage(200, 'estimated') },
      { agentId: 'A', kind: 'execute', usage: usage(300, 'estimated') },
    ])
    assert.equal(report.total.costUsdMicros, 600)
    assert.equal(report.total.estimatedRuns, 2)
  })

  test('★ 整数微美元累加，不产生浮点漂移', () => {
    const runs = Array.from({ length: 1000 }, () => ({
      agentId: 'A',
      kind: 'execute',
      usage: usage(1),
    }))
    const report = aggregateCost(runs)
    assert.equal(report.total.costUsdMicros, 1000, '浮点累加会在这里漂出小数')
    assert.equal(Number.isInteger(report.total.costUsdMicros), true)
  })

  test('空输入得到全零而不是报错', () => {
    const report = aggregateCost([])
    assert.equal(report.total.runs, 0)
    assert.equal(report.total.costUsdMicros, 0)
    assert.deepEqual(report.byAgent, [])
    assert.deepEqual(report.byKind, [])
    assert.equal(report.runsWithoutUsage, 0)
  })
})
