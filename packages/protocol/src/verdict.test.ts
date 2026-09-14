import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VERDICT_FENCE_BEGIN,
  VERDICT_FENCE_END,
  extractVerdictJson,
  formatVerdictIssues,
  parseVerdict,
  renderVerdictInstruction,
} from './verdict.ts'
import { ActionType, ReasonCode, Severity } from './enums.ts'

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

describe('★ 给模型看的判决指令（一次真实失败换来的）', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 这组用例的由来：一次真实任务"画一只小猫"，两次审核都失败了
   * ══════════════════════════════════════════════════════════════════
   *
   * 原来那条指令只给一个**空骨架**（`"findings": []`）+ 一句"reasonCode 必须是
   * 协议里的枚举值"。模型因此：
   *
   *   - 在工具调用里反复说"The enum isn't defined anywhere accessible"，
   *     翻遍工作目录去找 reasonCode 的合法取值；
   *   - 最后猜了 `reasonCode: "ok"`，并把 findings 写成自己发明的形状
   *     （`{kind, target, evidence: 一个长字符串}`）⇒ schema 拒绝 ⇒ 降级。
   *
   * 那是**我们的缺陷**：要一个严格闭合的对象，却只画了个轮廓。
   */
  test('★ 指令里的示例**必须能通过校验**（否则就是在教模型一个错的形状）', () => {
    const instruction = renderVerdictInstruction()
    const json = extractVerdictJson(instruction)
    assert.notEqual(json, null, '示例要被围栏包起来，且能被提取出来')
    const parsed = parseVerdict(JSON.parse(json!))
    assert.equal(
      parsed.ok,
      true,
      `★ 示例自己都不合法的话，模型照着抄也会被判不合规：${
        parsed.ok ? '' : formatVerdictIssues(parsed.issues)
      }`,
    )
  })

  test('★ 每个枚举的**全部取值**都要列出来（包括 reasonCode 与 severity）', () => {
    const instruction = renderVerdictInstruction()
    for (const value of ReasonCode.options) {
      assert.ok(instruction.includes(value), `reasonCode 的取值 ${value} 必须写给模型看`)
    }
    for (const value of Severity.options) {
      assert.ok(instruction.includes(value), `severity 的取值 ${value} 必须写给模型看`)
    }
    for (const value of ActionType.options) {
      assert.ok(instruction.includes(value), `action.type 的取值 ${value} 必须写给模型看`)
    }
  })

  test('★ 要点明 findings/evidence 的形状：数组、对象、不能写成一整段字符串', () => {
    const instruction = renderVerdictInstruction()
    assert.match(instruction, /evidence.*数组/s, 'evidence 是数组这件事要说清')
    assert.match(instruction, /excerpt/, '证据项里该有什么字段')
    assert.match(instruction, /闭合/, '要说清"多一个字段就整条不合规"')
    assert.match(instruction, /不要.*字符串/, '明确禁止把证据写成一整段字符串')
  })

  test('★ 枚举与示例都是从 schema 生成的：改 schema 不会让指令漂', () => {
    // 这条守护"单一来源"：指令里的取值来自 `z.enum(...).options`，
    // 而不是抄一遍。往枚举里加一个值，指令自动跟着变。
    const instruction = renderVerdictInstruction()
    assert.ok(ReasonCode.options.length > 10, '前提：reasonCode 是个长枚举')
    const missing = ReasonCode.options.filter((v) => !instruction.includes(v))
    assert.deepEqual(missing, [])
  })
})

describe('★ 校验失败要说人话（它会被使用者看到）', () => {
  test('★ 英文的 zod 文案要翻成能指导下一步的中文', () => {
    const text = formatVerdictIssues([
      { path: ['reasonCode'], message: 'Invalid option: expected one of "a"|"b"', code: 'invalid_value' },
      { path: ['findings', '0', 'summary'], message: 'Invalid input: expected string, received undefined', code: 'invalid_type' },
      { path: ['findings', '0'], message: 'Unrecognized keys: "kind"', code: 'unrecognized_keys' },
      { path: ['findings', '0', 'evidence'], message: 'Too big: expected string to have <=20 characters', code: 'too_big' },
    ])
    assert.match(text, /reasonCode：取值不在允许范围内/)
    assert.match(text, /findings\.0\.summary：这个字段是必填的/)
    assert.match(text, /多出了不允许的字段/)
    assert.match(text, /太长了/)
    assert.doesNotMatch(text, /Invalid option|Unrecognized keys/, '不许把 zod 英文原样丢给使用者')
  })

  test('★ 问题很多时只列前几条，并说清还有多少（不要刷屏）', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      path: ['findings', String(i)],
      message: 'x',
      code: 'invalid_type',
    }))
    const text = formatVerdictIssues(many)
    assert.match(text, /另有 14 处/, '超出部分要有交代，不能静默丢掉')
    assert.ok(text.length < 400, '不能变成一屏都读不完的墙')
  })
})

describe('★ 围栏提取：结尾标记被抄成开头时也要认（真实踩过两次）', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 这条是为一次真实失败加的
   * ══════════════════════════════════════════════════════════════════
   *
   * 一次任务的两条审核，模型给的判决**内容完全合法**，但结尾写成了
   * `<<<ALPHA_VERDICT>>>` 而不是 `<<<END_ALPHA_VERDICT>>>`——于是被判
   * "有 BEGIN 无 END"，整条判决作废，最后落到 needs_human 要人去处理。
   *
   * 这个围栏是**我们自己的约定**，不是模型世界的格式；因为抄错一个结尾标记
   * 就丢掉一份做得很好的审核，代价不对等。所以把"又一个开头标记"也当作结尾。
   */
  test('★ 结尾写成开头 ⇒ 仍然能切出判决', () => {
    const json = '{"schemaVersion":1}'
    const text = `前面的话\n${VERDICT_FENCE_BEGIN}\n${json}\n${VERDICT_FENCE_BEGIN}\n后面的话`
    assert.equal(extractVerdictJson(text), json)
  })

  test('★ 结尾正确时行为不变（取最后一个完整的块）', () => {
    const text = [
      `说明书里写了 ${VERDICT_FENCE_BEGIN} 与 ${VERDICT_FENCE_END} 这对标记`,
      `${VERDICT_FENCE_BEGIN}\n{"real":true}\n${VERDICT_FENCE_END}`,
    ].join('\n')
    assert.equal(extractVerdictJson(text), '{"real":true}')
  })

  test('两个标记都没有 ⇒ 仍然是 null（不要瞎猜）', () => {
    assert.equal(extractVerdictJson('我审完了，结论是 pass。'), null)
  })

  test('★ 指令要**明说**结尾标记带 END_ 前缀（别让模型猜）', () => {
    const instruction = renderVerdictInstruction()
    assert.match(instruction, /结尾标记/, '要把两个标记分别写清楚')
    assert.match(instruction, /END_/, '并提醒结尾那个带 END_ 前缀')
  })
})
