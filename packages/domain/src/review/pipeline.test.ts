import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { VERDICT_FENCE_BEGIN, VERDICT_FENCE_END } from '@agentdeck/protocol'
import type { ActionRef, ActionRefType } from '@agentdeck/protocol'
import { validateActionAllowed } from '../actions/definition.ts'
import { describeDecision, decideReview, isStructuralInvalid } from '../review/pipeline.ts'
import { REDACTED, redactArgv } from '../audit/record.ts'
import { makeTool } from '../testing/fixtures.ts'

// ─────────────────────────────────────────────────────────────
// 动作白名单：一次成员判断（动作本身已经不在这里了）
// ─────────────────────────────────────────────────────────────

/**
 * ══════════════════════════════════════════════════════════════════
 * D41：内置动作与它们的注册表已全部移除
 * ══════════════════════════════════════════════════════════════════
 *
 * `actions/registry.ts` **已删除**，定义改由工具包的清单摊出来
 * （见 `actions/tool-actions.ts` 与它的测试 `actions/tool-actions.test.ts`）。
 * 所以这一节里原先守**内置动作注册表**的那些用例守的能力，在平台里已经
 * 不存在了：
 *
 *   · 注册表的形状（`ACTION_REGISTRY`：每条定义都声明执行端、首版全是本地
 *     动作且默认不要人批准、不可回滚要显式标注、会派生 run 要标注）；
 *   · `getActionDefinition` 的 `describe` / `reversible` / `spawnsRun`；
 *   · `validateActionRef` 与 `isKnownActionType` —— "在不在注册表里"那套判据。
 *     它现在换成了"**装没装**那个包"，由 `validateActionRefWith(ref, { tools })`
 *     负责，用例在 `actions/tool-actions.test.ts`（那边的 `toolActionDefinitions`
 *     一节守着"每条定义都来自工具包、都带 provider"，等于接过了注册表的形状）。
 *
 * 留下来的是这一层里**与实现无关**的那件事：`validateActionAllowed` 的一次
 * 成员判断（它还在 `actions/definition.ts` 里）。
 */

describe('动作白名单：不在行动权限里就拒绝', () => {
  test('★ 不在行动权限里 ⇒ 拒绝，且报错指出**去哪儿勾上**', () => {
    // ⚠️ 措辞在 D40 收口时改过：授权不再是"skill 的子集"，而是**审核者的行动权限**
    //    （`Agent.allowedActions`）。这句话是使用者唯一能看到的东西——指错地方
    //    会让他去 Skills 页翻半天，而该去的是那个审核者的「行动权限」。
    //
    //    D41：夹具动作名换成工具包动作名（`<包 slug>.<动作名>`）——动作名从此只有
    //    这一种来源，写 `issue.create` 那种内置名会让人以为它还是内置动作。
    const ref: ActionRef = { type: 'fixture-tool.act', params: { text: 'x' } }
    const allowed: ActionRefType[] = ['other-tool.act', 'third-tool.act']
    const result = validateActionAllowed(ref, allowed)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.issues[0]!, /不在这个审核者的行动权限里/)
    assert.match(result.issues[0]!, /行动权限.*勾上/)
    assert.doesNotMatch(result.issues[0]!, /skill/)
  })

  test('在行动权限里 ⇒ 通过', () => {
    assert.equal(
      validateActionAllowed({ type: 'fixture-tool.act', params: {} }, ['fixture-tool.act']).ok,
      true,
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

/**
 * ══════════════════════════════════════════════════════════════════
 * D41：判决里的动作**只能**来自装进来的工具包
 * ══════════════════════════════════════════════════════════════════
 *
 * `decideReview` 现在只用 `validateActionRefWith(ref, { tools: input.tools ?? [] })`
 * 校验动作。所以凡是"判决带一个动作"的用例都必须给出**装了这个包**的工具实体
 * （`tools` 入参）——不给 `tools` ⇒ 什么都解析不出来 ⇒ 任何带 `action` 的判决
 * 都被判"未知动作类型"（结构性 invalid，不可重试）。
 *
 * 夹具用 `testing/fixtures.ts` 的 `makeTool({ id })`：它默认声明一个叫 `run`
 * 的动作，所以完整动作名是 `<slug>.run`。
 */
const tools = [makeTool({ id: 'fixture-tool' })]
/** 夹具动作的完整名字——白名单与判决里写的都是它。 */
const ACTION = 'fixture-tool.run'

describe('审核决策（S2/S1 的收口）', () => {
  const base = { allowedActions: [ACTION] as ActionRefType[], tools, invalidAttempts: 0 }

  test('pass 且无动作 ⇒ advisory（只记录）', () => {
    const d = decideReview({ ...base, output: fence(passVerdict) })
    assert.equal(d.kind, 'advisory')
  })

  test('pass 且有动作 ⇒ act', () => {
    const d = decideReview({
      ...base,
      // ⚠️ D41：参数只写**开放参数**（夹具工具没有声明任何开放参数 ⇒ 只能是 `{}`）；
      //    绑定参数（真实工具里的 `dir` 那种）由平台按事实注入，模型写不出来。
      output: fence({ ...passVerdict, action: { type: ACTION, params: {} } }),
    })
    assert.equal(d.kind, 'act')
    if (d.kind !== 'act') return
    assert.equal(d.verdict.action?.type, ACTION)
  })

  test('★ fail ⇒ rework（还有返工额度：交回执行者重做）', () => {
    const d = decideReview({
      ...base,
      maxReworks: 2,
      usedReworks: 0,
      output: fence({
        ...passVerdict,
        conclusion: 'fail',
        reasonCode: 'missing_tests',
        // D45：fail **不带** action
        action: null,
      }),
    })
    assert.equal(d.kind, 'rework')
  })

  test('★ fail 且额度已用完 ⇒ rework_exhausted（交给人，不静默停在"已审查"）', () => {
    const d = decideReview({
      ...base,
      maxReworks: 2,
      usedReworks: 2,
      output: fence({
        ...passVerdict,
        conclusion: 'fail',
        reasonCode: 'missing_tests',
        action: null,
      }),
    })
    assert.equal(d.kind, 'rework_exhausted')
  })

  test('★ fail 且这条任务没配返工（默认 0）⇒ rework_exhausted', () => {
    const d = decideReview({
      ...base,
      output: fence({
        ...passVerdict,
        conclusion: 'fail',
        reasonCode: 'missing_tests',
        action: null,
      }),
    })
    assert.equal(d.kind, 'rework_exhausted')
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
  const base = { allowedActions: [ACTION] as ActionRefType[], tools }

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

  test('★ 动作来自一个没装的工具包 ⇒ invalid，且被判为结构性问题', () => {
    const d = decideReview({
      ...base,
      // `deploy.production` 的形状是合法的（它就是 `<包 slug>.<动作名>`），
      // 只是这个工作区**没有装** `deploy` 这个包。
      output: fence({ ...passVerdict, action: { type: 'deploy.production', params: {} } }),
      invalidAttempts: 0,
    })
    // ⚠️ 这里原本断言 `'retry'`，而那是**错的**——测试名自己写的就是
    //    "⇒ invalid"。当初通过是因为 `decideReview` 从没问过
    //    `isStructuralInvalid()`，所有不合规判决一律先 retry；
    //    而重试派发当时又是坏的，于是全都掉进降级分支、看起来"处理过了"。
    //
    //    现在按状态机与 FR-RUN-07（只重试重试能修好的）走 escalate：
    //    动作名与**已装的东西**对不上是**配置问题**，模型再写一次还是同一个名字。
    //
    //    D41 的语义变化：判据从"在不在内置注册表里"变成"**装没装**那个包"
    //    （见 `validateActionRefWith` 的三层校验）。守的能力没变——"未声明即
    //    拒绝"，只是"声明"的出处换成了已安装包的清单。测试名也跟着改。
    assert.equal(d.kind, 'invalid', '结构性问题不该重试')
    if (d.kind !== 'invalid') return
    assert.equal(isStructuralInvalid(d.issues), true, '并且要能认出它是结构性的')
  })

  test('★ 动作不在这个审核者的行动权限里 ⇒ invalid', () => {
    const d = decideReview({
      ...base,
      // 动作**是装了的**（`fixture-tool` 在 `tools` 里、也声明了 `run`），
      // 但这个审核者的行动权限是空的 ⇒ 撞的是白名单那一层。
      allowedActions: [],
      output: fence({ ...passVerdict, action: { type: ACTION, params: {} } }),
      invalidAttempts: 0,
    })
    // 同上一处：测试名说 invalid，断言却写过 retry。动作越权是**配置**问题
    // （白名单与想做的事对不上），重试只会得到同样的越权动作。
    assert.equal(d.kind, 'invalid', '动作越权是配置问题，重试无意义')
    if (d.kind !== 'invalid') return
    assert.match(d.issues[0]!.message, /行动权限/)
    // ⚠️ D41：这句报错的措辞里**没有** `子集` 这个词——它靠 `path[0] === 'action'`
    //    兜底才被判成结构性的（`isStructuralInvalid` 仍认 `子集`、`未知动作类型`、
    //    `动作注册表` 三个老信号，但新文案里一个都没有）。所以这里顺带钉住
    //    "它在结构性的意义上仍然成立"，别哪天把 path 改掉就没声了。
    assert.equal(isStructuralInvalid(d.issues), true, '动作越权同样是结构性问题')
  })

  test('★ 动作参数不合法 ⇒ 仍然 retry（这是模型手误，不是配置问题）', () => {
    const d = decideReview({
      ...base,
      // 夹具工具没有声明任何开放参数 ⇒ 模型写的 `text` 是**未知键**，
      // 正是"模型这次写错了参数"那一类（报错带 `动作参数 ` 前缀）。
      output: fence({ ...passVerdict, action: { type: ACTION, params: { text: '一句话' } } }),
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
