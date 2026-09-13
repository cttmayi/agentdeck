import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  checkVersionSupport,
  compareVersions,
  matchesVersionRange,
  parseVersion,
  shouldRefuseToRun,
} from './version-support.ts'
import type { RuntimeDescriptor } from './runtime-table.ts'

/**
 * FR-CLI-07：声明并测试受支持的 CLI 版本范围。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一组测试真正保护的是什么
 * ══════════════════════════════════════════════════════════════════
 *
 * 需求原文是「必须声明并测试受支持的 CLI 版本范围。**以实际版本验证，
 * 不得凭文档推断**」。
 *
 * 前半句很容易被做成"表里填个范围字符串"，那样它只是一条注释——而且是
 * **会骗人的注释**：填了范围，看起来就像验证过了。所以这里最要紧的测试
 * 不是"范围匹配对不对"，而是：
 *
 *   **一个没有实测版本的声明，必须被报成"未声明"，而不是"支持"。**
 */

function descriptorWith(versions?: RuntimeDescriptor['versions']): RuntimeDescriptor {
  return {
    key: 'fake',
    command: 'fake',
    protocol: 'stream-json',
    family: 'generic-ndjson',
    evidence: 'provisional',
    sessionState: 'unknown',
    skills: { kind: 'directory', dir: '.x/skills' },
    contextFile: 'X.md',
    managedFlags: { model: '--model', maxTurns: '--max-turns', resume: '--resume' },
    toolConfig: { enabled: false, reason: 'r' },
    disableSwitch: { enabled: false, reason: 'r' },
    resume: { flag: '', rejectDetectable: false },
    promptDelivery: 'argv',
    baseArgs: [],
    blockedArgs: {},
    ...(versions ? { versions } : {}),
  }
}

describe('版本解析与比较', () => {
  test('解析常见写法', () => {
    assert.deepEqual(parseVersion('2.1.143'), [2, 1, 143])
    assert.deepEqual(parseVersion('v2.1'), [2, 1])
    assert.deepEqual(parseVersion('2'), [2])
    // 预发布与构建元数据被截掉：本匹配器只比主.次.补丁
    assert.deepEqual(parseVersion('2.1.143-beta.1'), [2, 1, 143])
    assert.deepEqual(parseVersion('2.1.143+build.7'), [2, 1, 143])
  })

  test('解析不出来时返回 null，而不是抛异常或当成 0', () => {
    assert.equal(parseVersion(''), null)
    assert.equal(parseVersion('abc'), null)
    assert.equal(parseVersion('2.x.1'), null)
  })

  test('逐段比较，缺的段按 0 补齐', () => {
    assert.equal(compareVersions([2, 1], [2, 1, 0]), 0, '2.1 与 2.1.0 是同一个版本')
    assert.equal(compareVersions([2, 1, 143], [2, 2, 0]), -1)
    assert.equal(compareVersions([3, 0, 0], [2, 9, 9]), 1)
  })
})

describe('范围匹配', () => {
  test('通配与精确', () => {
    assert.equal(matchesVersionRange('2.1.143', '*'), true)
    assert.equal(matchesVersionRange('2.1.143', ''), true)
    assert.equal(matchesVersionRange('2.1.143', '2.1.143'), true)
    assert.equal(matchesVersionRange('2.1.144', '2.1.143'), false)
  })

  test('通配段：2.1.x / 2.x', () => {
    assert.equal(matchesVersionRange('2.1.143', '2.1.x'), true)
    assert.equal(matchesVersionRange('2.1.999', '2.1.x'), true)
    assert.equal(matchesVersionRange('2.2.0', '2.1.x'), false)
    assert.equal(matchesVersionRange('2.9.0', '2.x'), true)
    assert.equal(matchesVersionRange('3.0.0', '2.x'), false)
  })

  test('比较运算符', () => {
    assert.equal(matchesVersionRange('2.1.143', '>=2.0.0'), true)
    assert.equal(matchesVersionRange('1.9.0', '>=2.0.0'), false)
    assert.equal(matchesVersionRange('2.1.143', '>2.1.143'), false)
    assert.equal(matchesVersionRange('2.1.143', '<=2.1.143'), true)
  })

  test('空格分隔的多个条件是**全部满足**才算匹配', () => {
    assert.equal(matchesVersionRange('2.1.143', '>=2.0.0 <3.0.0'), true)
    assert.equal(matchesVersionRange('3.0.0', '>=2.0.0 <3.0.0'), false)
    assert.equal(matchesVersionRange('1.0.0', '>=2.0.0 <3.0.0'), false)
  })

  test('★ 表达式解析不了时返回 null，**不是 false**', () => {
    // "解析不了"是表写错了，"不匹配"是版本真的不匹配——两者的处置完全不同。
    // 混成一个 false 会让一个笔误看起来像版本问题。
    assert.equal(matchesVersionRange('2.1.143', '>=two <three'), null)
    assert.equal(matchesVersionRange('2.1.143', '>= '), null)
    assert.equal(matchesVersionRange('not-a-version', '>=1.0.0'), null)
  })
})

describe('★ 支持判定：没有实测版本就不算声明', () => {
  test('★ 完全没写 versions ⇒ undeclared', () => {
    const result = checkVersionSupport(descriptorWith(), '2.1.143')
    assert.equal(result.status, 'undeclared')
    assert.match(result.message, /未声明|没有声明/)
  })

  test('★ 只有 range、verifiedWith 为空 ⇒ 仍然 undeclared，不是 supported', () => {
    // 这是整组测试里最要紧的一条。
    // 填一个范围字符串就宣称支持，是最容易发生也最有害的做法——
    // 因为它看起来像是验证过了。需求明确禁止"凭文档推断"。
    const result = checkVersionSupport(
      descriptorWith({ range: '>=2.0.0 <3.0.0', verifiedWith: [] }),
      '2.1.143',
    )
    assert.equal(result.status, 'undeclared', '没实测过就不算声明')
    assert.match(result.message, /凭文档推断|实测/)
  })

  test('★ 实测过的具体版本 ⇒ verified', () => {
    const result = checkVersionSupport(
      descriptorWith({ range: '>=2.0.0 <3.0.0', verifiedWith: ['2.1.143'] }),
      '2.1.143',
    )
    assert.equal(result.status, 'verified')
    assert.match(result.message, /实测过/)
  })

  test('在范围内但没实测过这个具体版本 ⇒ in-range-unverified（既不吹也不否）', () => {
    const result = checkVersionSupport(
      descriptorWith({ range: '>=2.0.0 <3.0.0', verifiedWith: ['2.1.143'] }),
      '2.1.200',
    )
    assert.equal(result.status, 'in-range-unverified')
    assert.match(result.message, /2\.1\.143/, '要说清实测过的是哪些')
  })

  test('★ 落在范围外 ⇒ out-of-range，且默认只是警告而不是拒绝', () => {
    const result = checkVersionSupport(
      descriptorWith({ range: '>=2.0.0 <3.0.0', verifiedWith: ['2.1.143'] }),
      '3.0.0',
    )
    assert.equal(result.status, 'out-of-range')
    assert.equal(result.refuse, false, '默认警告：使用者自己装的 CLI，拒绝运行会很粗暴')
    assert.equal(shouldRefuseToRun(result), false)
    assert.match(result.message, /范围之外/)
    assert.match(result.message, /审计/, '要继续跑就得留下可查的痕迹')
  })

  test('声明了 refuse 才拒绝执行', () => {
    const result = checkVersionSupport(
      descriptorWith({ range: '>=2.0.0 <3.0.0', verifiedWith: ['2.1.143'], onMismatch: 'refuse' }),
      '3.0.0',
    )
    assert.equal(result.status, 'out-of-range')
    assert.equal(shouldRefuseToRun(result), true)
  })

  test('★ 拿不到版本号 ⇒ unknown，如实说"无法判断"而不是"不支持"', () => {
    const result = checkVersionSupport(
      descriptorWith({ range: '>=2.0.0 <3.0.0', verifiedWith: ['2.1.143'] }),
      null,
    )
    assert.equal(result.status, 'unknown')
    assert.equal(result.refuse, false, '测不出来就拒绝运行会把人挡在门外')
    assert.match(result.message, /无法判断/)
    assert.match(result.message, /2\.1\.143/)
  })

  test('表写错了（范围表达式非法）⇒ 报成 undeclared，并指出是**表**的问题', () => {
    const result = checkVersionSupport(
      descriptorWith({ range: 'garbage-range', verifiedWith: ['1.0.0'] }),
      '2.1.143',
    )
    assert.equal(result.status, 'undeclared')
    assert.match(result.message, /表写错|无法解析/)
  })
})
