import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VERDICT_FENCE_BEGIN,
  VERDICT_FENCE_END,
  extractVerdictJson,
  formatVerdictIssues,
  parseVerdict,
} from './verdict.ts'

/** 一份最小的合法判决。 */
const validPass = {
  schemaVersion: 1,
  conclusion: 'pass',
  reasonCode: 'meets_criteria',
  confidence: 0.9,
  findings: [],
  action: null,
  escalateReason: null,
} as const

const validFail = {
  ...validPass,
  conclusion: 'fail',
  reasonCode: 'missing_tests',
  action: { type: 'issue.update_status', params: { status: 'todo' } },
}

const validNeedsHuman = {
  ...validPass,
  conclusion: 'needs_human',
  reasonCode: 'conflicting_criteria',
  escalateReason: '两条审核标准互相冲突，需要人定优先级',
}

describe('Verdict —— 基本合法性', () => {
  test('合法的 pass 通过', () => {
    const r = parseVerdict(validPass)
    assert.equal(r.ok, true)
  })

  test('合法的 fail（带 action）通过', () => {
    const r = parseVerdict(validFail)
    assert.equal(r.ok, true)
  })

  test('合法的 needs_human（带 escalateReason）通过', () => {
    const r = parseVerdict(validNeedsHuman)
    assert.equal(r.ok, true)
  })
})

describe('Verdict —— 出口规则（INV-4/5）', () => {
  test('fail 不给 action ⇒ 拒（判决没有出口）', () => {
    const r = parseVerdict({ ...validFail, action: null })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.ok(r.issues.some((i) => i.path.join('.') === 'action'))
  })

  test('needs_human 不给 escalateReason ⇒ 拒（升级必须带结构化原因）', () => {
    const r = parseVerdict({ ...validNeedsHuman, escalateReason: null })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.ok(r.issues.some((i) => i.path.join('.') === 'escalateReason'))
  })

  test('needs_human 给空白 escalateReason ⇒ 拒', () => {
    const r = parseVerdict({ ...validNeedsHuman, escalateReason: '   ' })
    assert.equal(r.ok, false)
  })

  test('pass 带 escalateReason ⇒ 拒（语义矛盾）', () => {
    const r = parseVerdict({ ...validPass, escalateReason: '不该有' })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.ok(r.issues.some((i) => i.path.join('.') === 'escalateReason'))
  })

  test('pass 可以没有 action', () => {
    const r = parseVerdict({ ...validPass, action: null })
    assert.equal(r.ok, true)
  })
})

describe('Verdict —— 「一开一合」的合（闭合处必须真的拒绝）', () => {
  test('未知 reasonCode ⇒ 拒', () => {
    const r = parseVerdict({ ...validPass, reasonCode: 'cve_detected' })
    assert.equal(r.ok, false)
  })

  test('未知 action.type ⇒ 拒（必须来自注册表）', () => {
    const r = parseVerdict({ ...validFail, action: { type: 'deploy.production', params: {} } })
    assert.equal(r.ok, false)
  })

  test('顶层多一个字段 ⇒ 拒（不能从顶层绕开闭合）', () => {
    const r = parseVerdict({ ...validPass, extraTopLevel: 'x' })
    assert.equal(r.ok, false)
  })

  test('action 里多一个字段 ⇒ 拒（尤其不能自带执行端）', () => {
    const r = parseVerdict({
      ...validFail,
      action: { type: 'issue.update_status', params: {}, plane: 'remote' },
    })
    assert.equal(r.ok, false)
  })

  test('finding 里多一个字段 ⇒ 拒（只能走 detail）', () => {
    const r = parseVerdict({
      ...validPass,
      findings: [
        {
          severity: 'high',
          summary: '有问题',
          evidence: [],
          cveList: ['CVE-2024-1'],
        },
      ],
    })
    assert.equal(r.ok, false)
  })

  test('schemaVersion 不匹配 ⇒ 拒', () => {
    const r = parseVerdict({ ...validPass, schemaVersion: 2 })
    assert.equal(r.ok, false)
  })

  test('confidence 越界 ⇒ 拒', () => {
    assert.equal(parseVerdict({ ...validPass, confidence: 1.5 }).ok, false)
    assert.equal(parseVerdict({ ...validPass, confidence: -0.1 }).ok, false)
  })

  test('findings 超过 100 条 ⇒ 拒', () => {
    const findings = Array.from({ length: 101 }, () => ({
      severity: 'info',
      summary: 'x',
      evidence: [],
    }))
    assert.equal(parseVerdict({ ...validPass, findings }).ok, false)
  })
})

describe('Verdict —— 「一开一合」的开（detail 是唯一出口）', () => {
  test('finding.detail 可以放任意结构', () => {
    const r = parseVerdict({
      ...validPass,
      findings: [
        {
          severity: 'critical',
          summary: '依赖含已知漏洞',
          evidence: [{ blobRef: null, locator: 'line 12', excerpt: 'lodash@1.0.0' }],
          detail: {
            cves: ['CVE-2024-0001'],
            cvss: 9.8,
            nested: { anything: [1, 2, 3] },
          },
        },
      ],
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.deepEqual(r.verdict.findings[0]?.detail?.['cves'], ['CVE-2024-0001'])
  })

  test('finding.detail 可省略', () => {
    const r = parseVerdict({
      ...validPass,
      findings: [{ severity: 'low', summary: 'x', evidence: [] }],
    })
    assert.equal(r.ok, true)
  })
})

describe('Verdict —— 错误信息可读', () => {
  test('formatVerdictIssues 带字段路径', () => {
    const r = parseVerdict({ ...validFail, action: null })
    assert.equal(r.ok, false)
    if (r.ok) return
    const msg = formatVerdictIssues(r.issues)
    assert.match(msg, /action/)
  })
})

describe('判决提取 —— 约定围栏 + 确定性切片（FR-CLI-44/45）', () => {
  const wrap = (json: string) => `${VERDICT_FENCE_BEGIN}\n${json}\n${VERDICT_FENCE_END}`

  test('抽取正常围栏内的内容', () => {
    const text = `我先说明一下。\n${wrap('{"a":1}')}\n完成。`
    assert.equal(extractVerdictJson(text), '{"a":1}')
  })

  test('没有围栏 ⇒ null（不做正则兜底）', () => {
    assert.equal(extractVerdictJson('判决是 {"a":1} 大概这样'), null)
  })

  test('多个块 ⇒ 取最后一个（前面的可能是被回显的示例）', () => {
    const text = `${wrap('{"example":true}')}\n中间闲聊\n${wrap('{"real":true}')}`
    assert.equal(extractVerdictJson(text), '{"real":true}')
  })

  test('有 BEGIN 无 END ⇒ null（半个块不算有效判决）', () => {
    assert.equal(extractVerdictJson(`开头 ${VERDICT_FENCE_BEGIN} {"a":1}`), null)
  })

  test('孤立的 END 标记不影响切片（只在 BEGIN 之后找 END）', () => {
    const text = `文档里写了 ${VERDICT_FENCE_END} 这个标记\n${wrap('{"ok":true}')}`
    assert.equal(extractVerdictJson(text), '{"ok":true}')
  })

  test('切片结果直接交给 parseVerdict —— 不合规就走 invalid，不做修复', () => {
    const sliced = extractVerdictJson(wrap('{"conclusion":"pass"}'))
    assert.notEqual(sliced, null)
    const parsed = parseVerdict(JSON.parse(sliced!))
    assert.equal(parsed.ok, false)
  })
})
