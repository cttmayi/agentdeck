import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ActionRef, ActionType, Verdict } from '@alpha-helper/protocol'
import {
  ACTION_REGISTRY,
  getActionDefinition,
  isKnownActionType,
  validateActionAllowed,
  validateActionRef,
} from '../actions/registry.ts'
import { describeDecision, decideReview, isStructuralInvalid } from '../review/pipeline.ts'
import { REDACTED, redactArgv } from '../audit/record.ts'
import { VERDICT_FENCE_BEGIN, VERDICT_FENCE_END } from '@alpha-helper/protocol'

// ─────────────────────────────────────────────────────────────
// 动作注册表
// ─────────────────────────────────────────────────────────────

describe('动作注册表（FR-ACTION-01~11）', () => {
  test('每条定义都声明了执行端（INV-10）', () => {
    for (const [type, def] of Object.entries(ACTION_REGISTRY)) {
      assert.equal(def.type, type)
      assert.ok(['local', 'remote'].includes(def.plane), `${type} 缺执行端`)
    }
  })

  test('★ 首版全部是本地动作，且默认不需要人批准（INV-4：人不是默认关卡）', () => {
    for (const def of Object.values(ACTION_REGISTRY)) {
      assert.equal(def.plane, 'local')
      assert.notEqual(def.requiresApproval, true, `${def.type} 不应默认要人批准`)
    }
  })

  test('不可回滚的动作被显式标注（FR-ACTION-05）', () => {
    const notify = getActionDefinition('notify.emit')
    assert.equal(notify.reversible, false, '通知发出去就收不回')
    assert.equal(getActionDefinition('comment.create').reversible, true)
  })

  test('会派生 run 的动作被标注（影响回路边界）', () => {
    assert.equal(getActionDefinition('issue.assign_agent').spawnsRun, true)
    assert.equal(getActionDefinition('comment.create').spawnsRun, undefined)
  })

  test('★ 未知动作类型 ⇒ 拒绝（未声明即拒绝，不给模型绕过的路）', () => {
    const result = validateActionRef({ type: 'deploy.production', params: {} } as unknown as ActionRef)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.issues[0]!, /未知动作类型/)
    assert.equal(isKnownActionType('deploy.production'), false)
  })

  test('参数不符合 schema ⇒ 拒绝，且带字段路径', () => {
    const bad = validateActionRef({
      type: 'issue.update_status',
      params: { issueId: 'i1', status: '随便写的状态' },
    })
    assert.equal(bad.ok, false)
    if (bad.ok) return
    assert.match(bad.issues[0]!, /status/)
  })

  test('参数多一个字段 ⇒ 拒绝（strictObject：不能从参数绕过闭合）', () => {
    const bad = validateActionRef({
      type: 'comment.create',
      params: { issueId: 'i1', body: 'x', extra: 1 },
    })
    assert.equal(bad.ok, false)
  })

  test('合法动作通过', () => {
    assert.equal(
      validateActionRef({ type: 'comment.create', params: { issueId: 'i1', body: 'hi' } }).ok,
      true,
    )
  })

  test('★ skill 只允许动作的一个子集，不在子集内 ⇒ 拒绝', () => {
    const ref: ActionRef = { type: 'issue.create', params: { title: 'x' } }
    const allowed: ActionType[] = ['comment.create', 'issue.add_label']
    const result = validateActionAllowed(ref, allowed)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.issues[0]!, /不在该 skill 允许的动作子集内/)
  })

  test('在子集内 ⇒ 通过', () => {
    assert.equal(
      validateActionAllowed({ type: 'comment.create', params: {} }, ['comment.create']).ok,
      true,
    )
  })

  test('每个动作都能给人话摘要', () => {
    assert.match(
      getActionDefinition('issue.update_status').describe({ issueId: 'i1', status: 'done' }),
      /i1.*done/,
    )
  })
})

// ─────────────────────────────────────────────────────────────
// 审核决策
// ─────────────────────────────────────────────────────────────

const fence = (obj: unknown): string =>
  `一些说明\n${VERDICT_FENCE_BEGIN}\n${JSON.stringify(obj)}\n${VERDICT_FENCE_END}\n结束`

const passVerdict = {
  schemaVersion: 1,
  conclusion: 'pass',
  reasonCode: 'meets_criteria',
  confidence: 0.9,
  findings: [],
  action: null,
  escalateReason: null,
}

describe('审核决策（S2/S1 的收口）', () => {
  const base = { allowedActions: ['comment.create', 'issue.update_status'] as ActionType[], invalidAttempts: 0 }

  test('pass 且无动作 ⇒ advisory（只记录）', () => {
    const d = decideReview({ ...base, output: fence(passVerdict) })
    assert.equal(d.kind, 'advisory')
  })

  test('pass 且有动作 ⇒ act', () => {
    const d = decideReview({
      ...base,
      output: fence({ ...passVerdict, action: { type: 'comment.create', params: { issueId: 'i1', body: 'ok' } } }),
    })
    assert.equal(d.kind, 'act')
    if (d.kind !== 'act') return
    assert.equal(d.verdict.action?.type, 'comment.create')
  })

  test('fail ⇒ act（schema 保证 fail 必有 action）', () => {
    const d = decideReview({
      ...base,
      output: fence({
        ...passVerdict,
        conclusion: 'fail',
        reasonCode: 'missing_tests',
        action: { type: 'issue.update_status', params: { issueId: 'i1', status: 'todo' } },
      }),
    })
    assert.equal(d.kind, 'act')
  })

  test('★ needs_human ⇒ escalate，且带结构化原因', () => {
    const d = decideReview({
      ...base,
      output: fence({
        ...passVerdict,
        conclusion: 'needs_human',
        reasonCode: 'conflicting_criteria',
        escalateReason: '两条标准冲突',
      }),
    })
    assert.equal(d.kind, 'escalate')
    if (d.kind !== 'escalate') return
    assert.equal(d.escalateReason, '两条标准冲突')
  })
})

describe('审核决策 —— invalid 的独立处置路径（FR-REVIEW-04/05）', () => {
  const base = { allowedActions: ['comment.create'] as ActionType[] }

  test('没有围栏块 ⇒ retry（第一次）', () => {
    const d = decideReview({ ...base, output: '我直接说了结论，没按格式输出。', invalidAttempts: 0 })
    assert.equal(d.kind, 'retry')
  })

  test('★ 重试次数用尽 ⇒ downgrade（不再烧 token）', () => {
    const d = decideReview({ ...base, output: '没有围栏', invalidAttempts: 1 })
    assert.equal(d.kind, 'downgrade')
  })

  test('围栏里不是合法 JSON ⇒ invalid 路径', () => {
    const d = decideReview({
      ...base,
      output: `${VERDICT_FENCE_BEGIN}\n{不是 JSON}\n${VERDICT_FENCE_END}`,
      invalidAttempts: 0,
    })
    assert.equal(d.kind, 'retry')
    if (d.kind !== 'retry') return
    assert.match(d.issues[0]!.message, /不是合法 JSON/)
  })

  test('schema 不合规（缺 escalateReason）⇒ invalid 路径', () => {
    const d = decideReview({
      ...base,
      output: fence({ ...passVerdict, conclusion: 'needs_human', reasonCode: 'conflicting_criteria' }),
      invalidAttempts: 0,
    })
    assert.equal(d.kind, 'retry')
    if (d.kind !== 'retry') return
    assert.ok(d.issues.some((i) => i.path.join('.') === 'escalateReason'))
  })

  test('★ 动作不在注册表 ⇒ invalid，且被判为结构性问题', () => {
    const d = decideReview({
      ...base,
      output: fence({ ...passVerdict, action: { type: 'deploy.production', params: {} } }),
      invalidAttempts: 0,
    })
    // ⚠️ 这里原本断言 `'retry'`，而那是**错的**——测试名自己写的就是
    //    "⇒ invalid"。当初通过是因为 `decideReview` 从没问过
    //    `isStructuralInvalid()`，所有不合规判决一律先 retry；
    //    而重试派发当时又是坏的，于是全都掉进降级分支、看起来"处理过了"。
    //
    //    现在按状态机与 FR-RUN-07（只重试重试能修好的）走 escalate：
    //    动作名与注册表对不上是**配置问题**，模型再写一次还是同一个名字。
    assert.equal(d.kind, 'invalid', '结构性问题不该重试')
    if (d.kind !== 'invalid') return
    assert.equal(isStructuralInvalid(d.issues), true, '并且要能认出它是结构性的')
  })

  test('★ 动作不在 skill 允许的子集内 ⇒ invalid', () => {
    const d = decideReview({
      ...base,
      output: fence({ ...passVerdict, action: { type: 'issue.create', params: { title: 'x' } } }),
      invalidAttempts: 0,
    })
    // 同上一处：测试名说 invalid，断言却写了 retry。子集不匹配是
    // skill 与注册表对不上，重试只会得到同样的越权动作。
    assert.equal(d.kind, 'invalid', '动作越权是配置问题，重试无意义')
    if (d.kind !== 'invalid') return
    assert.match(d.issues[0]!.message, /子集/)
  })

  test('★ 动作参数不合法 ⇒ 仍然 retry（这是模型手误，不是配置问题）', () => {
    const d = decideReview({
      ...base,
      output: fence({ ...passVerdict, action: { type: 'comment.create', params: { issueId: 'i1' } } }),
      invalidAttempts: 0,
    })
    // ★ 这一条必须**保持 retry**，而且它和上面两条的差别很细：
    //
    //   动作类型不认识 ⇒ 配置问题 ⇒ 不重试
    //   动作参数写错了 ⇒ 模型手误 ⇒ **重试**（下次完全可能写对）
    //
    //   这个区分一度是坏的：为了兜住 schema 层的动作错误加的那条
    //   `path[0] === 'action'` 把参数问题一起吞了，于是模型的一个手误
    //   被当成配置错误，连重试机会都没有。
    assert.equal(d.kind, 'retry', '参数写错是模型手误，重试有意义')
  })

  test('每种决策都有可读摘要', () => {
    const decisions = [
      decideReview({ ...base, invalidAttempts: 0, output: fence(passVerdict) }),
      decideReview({ ...base, invalidAttempts: 0, output: 'x' }),
      decideReview({
        ...base,
        invalidAttempts: 0,
        output: fence({
          ...passVerdict,
          conclusion: 'needs_human',
          reasonCode: 'insufficient_context',
          escalateReason: 'r',
        }),
      }),
    ]
    for (const d of decisions) {
      assert.ok(describeDecision(d).length > 0)
    }
  })

  test('可自定义重试上限', () => {
    const d = decideReview({ ...base, output: 'x', invalidAttempts: 2, maxInvalidRetries: 3 })
    assert.equal(d.kind, 'retry')
  })
})

// ─────────────────────────────────────────────────────────────
// 审计脱敏
// ─────────────────────────────────────────────────────────────

describe('审计 argv 脱敏（FR-AUDIT-01）', () => {
  test('★ 令牌类参数的值被替换，参数名保留（否则无法解释当时怎么起的进程）', () => {
    const redacted = redactArgv(['claude', '-p', '--token', 'mat_abcdefghij', '--model', 'x'])
    assert.deepEqual(redacted, ['claude', '-p', '--token', REDACTED, '--model', 'x'])
  })

  test('`--flag=value` 形式也脱敏', () => {
    assert.deepEqual(redactArgv(['--api-key=sk-1234567890']), [`--api-key=${REDACTED}`])
  })

  test('长得像令牌的裸值也脱敏（宁可多脱敏，不要漏一个真令牌）', () => {
    assert.deepEqual(redactArgv(['mat_abcdefghijkl', 'normal']), [REDACTED, 'normal'])
    assert.deepEqual(redactArgv(['ghp_abcdefghijk']), [REDACTED])
    assert.deepEqual(redactArgv(['Bearer abc.def.ghi']), [REDACTED])
  })

  test('普通参数原样保留', () => {
    const argv = ['claude', '-p', '--output-format', 'stream-json', '--model', 'claude-sonnet-4-5']
    assert.deepEqual(redactArgv(argv), argv)
  })

  test('`--token` 是最后一个参数时不会越界', () => {
    assert.deepEqual(redactArgv(['claude', '--token']), ['claude', '--token'])
  })
})
