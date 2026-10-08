import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from './entities.ts'
import {
  LEGACY_AGENT_KEYS,
  cleanAgent,
  hasLegacyAgentFields,
  stripLegacyAgentFields,
} from './agent-legacy.ts'

/**
 * 撤掉的字段怎么从老记录里摘掉（2026-10）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件里最重要的是**两条边界**，不是"能不能删"
 * ══════════════════════════════════════════════════════════════════
 *
 * 删除本身三行就能写完，而它一旦越界，代价落在使用者身上：
 *
 *   · **只删撤掉的那几个键**：多删一个键就是"平台偷偷改配置"——比如把还在用的
 *     `reviewStandard` 整个删掉，那位审核者就再也审不动了，而日志里只有一句
 *     "清理了老字段"。
 *   · **不认识的键不碰**：它不是通用消毒器。哪天有个新键刚上、这个函数顺手把
 *     "看起来不认识"的键也清了，那就是数据丢失。
 *
 * 还有一条更容易被忽略的：它**不许就地改**（`next` 是新对象）。清理是"顺手做"的
 * 事，如果有人拿着原对象继续用，就地改会让读到的东西在背后变掉。
 */

/** 一条"老形态"的记录：四个撤掉的键都在，另外还内嵌着一份老标准。 */
function legacyRecord(): Record<string, unknown> {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    name: '老形态审核者',
    instructions: '逐条核查。',
    model: null,
    runtimeKey: 'claude',
    workDir: null,
    skillIds: [],
    env: {},
    role: 'reviewer',
    reviewStandard: {
      name: '老标准',
      body: '# 老标准\n\n只看有没有写测试。',
      // 这一度与判断依据合体存在标准里（动作白名单）——同一个字段名，两层都出现过
      allowedActions: ['legacy-tool.act'],
    },
    // ⚠️ `ownerGroupId` 是**可选**字段（全局 agent 没有它，私有成员才有）——
    //    这里刻意不写它：老记录里它常常也不在（那时还没有智能体组）。
    createdAt: 1,
    updatedAt: 2,
    // 撤掉的四个（顶层）
    reviewerAgentId: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
    allowedActions: ['legacy-tool.act'],
    debugActions: ['legacy-tool.debug'],
    actionParams: { 'legacy-tool.act': { text: '嗯' } },
  }
}

describe('stripLegacyAgentFields：摘掉撤下的字段', () => {
  test('★ 四个顶层键 + `reviewStandard.allowedActions` 都不见了', () => {
    const { next, removed } = stripLegacyAgentFields(legacyRecord())

    for (const key of LEGACY_AGENT_KEYS) {
      assert.equal(key in next, false, `★ ${key} 必须摘掉`)
    }
    assert.equal(
      'allowedActions' in (next['reviewStandard'] as Record<string, unknown>),
      false,
      '★ 标准里内嵌的那一份同名字段也要摘（老数据里它才是"权威白名单"）',
    )

    // 摘了什么要**说得出来**：启动日志逐条报的就是这个数组（"不静默"）
    assert.deepEqual(removed.slice().sort(), [
      'actionParams',
      'allowedActions',
      'debugActions',
      'reviewStandard.allowedActions',
      'reviewerAgentId',
    ])
  })

  test('★ 别的字段一个字都不动（撤掉的只有那四个）', () => {
    const before = legacyRecord()
    const { next } = stripLegacyAgentFields(before)

    // 除了那五处，其余完全相同——**逐键比对**，而不是只挑几个看着重要的看：
    // "顺手删了别的"正是这个函数最危险的失效方式。
    const expected: Record<string, unknown> = { ...before }
    for (const key of LEGACY_AGENT_KEYS) delete expected[key]
    expected['reviewStandard'] = { name: '老标准', body: '# 老标准\n\n只看有没有写测试。' }

    assert.deepEqual(next, expected)
  })

  test('★ 不认识的键**不碰**（它不是通用消毒器）', () => {
    const { next } = stripLegacyAgentFields({ name: 'x', 未来的字段: { a: 1 } })
    assert.deepEqual(next['未来的字段'], { a: 1 }, '不认识的键不许顺手清掉——那是数据丢失')
  })

  test('★ 不许就地改（`next` 是新对象，传进来的那份原样不动）', () => {
    const before = legacyRecord()
    const snapshot = JSON.parse(JSON.stringify(before)) as Record<string, unknown>
    const { next } = stripLegacyAgentFields(before)

    assert.deepEqual(before, snapshot, '★ 传进来的记录必须原样不动')
    assert.notEqual(next, before, '回来的是新对象')
  })

  test('本来就是干净记录 ⇒ 一个字都不删（`removed` 空）', () => {
    const clean = legacyRecord()
    for (const key of LEGACY_AGENT_KEYS) delete clean[key]
    clean['reviewStandard'] = { name: '老标准', body: '# 标准' }

    const { removed } = stripLegacyAgentFields(clean)
    assert.deepEqual(removed, [], '干净的记录不该被"清"一遍（那会带来无谓的写与 mtime 变化）')
    assert.equal(hasLegacyAgentFields(clean), false)
  })

  test('★ `reviewStandard` 只摘内嵌字段：没有正文也不删整个键', () => {
    // ⚠️ 这条路是**故意**留的：判断"这份标准空了没"不归清理管（那是审核链的事，
    //    它自己会说"没有写「指令」，无法审核"）。清理多管一步，就会把"标准空了"
    //    这个可见状态变成一个**不存在的键**，报错文案随之指错地方。
    const { next, removed } = stripLegacyAgentFields({
      name: 'x',
      reviewStandard: { allowedActions: ['a.b'] },
    })
    assert.deepEqual(next['reviewStandard'], {}, '键在，内嵌的老字段没了')
    assert.deepEqual(removed, ['reviewStandard.allowedActions'])
  })

  test('`reviewStandard` 是 null / 不是对象时不动它（老数据的形状是多样的）', () => {
    for (const value of [null, 42, 'x', ['a'], undefined]) {
      const { next, removed } = stripLegacyAgentFields({ name: 'x', reviewStandard: value })
      assert.equal(next['reviewStandard'], value, `reviewStandard=${JSON.stringify(value)} 原样保留`)
      assert.deepEqual(removed, [], '没有内嵌字段可摘')
    }
  })
})

describe('判据与 schema 的对齐：这几个键确实不在 `Agent` 里', () => {
  test('★★ `Agent` 的 schema 认不出它们（parse 之后它们不在结果里）', () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * 这条钉的是"那份清单会不会过期"
     * ══════════════════════════════════════════════════════════════════
     *
     * `LEGACY_AGENT_KEYS` 是手写的清单，而它必须与 `Agent` 的 schema **一致**。
     * 两边分叉有两种方向，都很贵：
     *
     *   · 清单里多一个**还在用**的键 ⇒ 清理会把活字段删掉（"平台偷偷改配置"）；
     *   · 字段被加回来、清单没跟着删 ⇒ 老数据里的键永远不会被清（就是这次要修的
     *     那个问题：使用者说"不要遗留旧数据"）。
     *
     * 判据用 schema 本身：把带老键的记录喂给 `Agent.parse`，zod 会把**不认识的键
     * 直接丢掉**（没有 `passthrough`）。所以"parse 之后它们不见了"就等价于
     * "schema 里没有它们"——哪天有人把字段加回来，这条立刻红。
     */
    const record = legacyRecord()
    const parsed = Agent.parse(record) as unknown as Record<string, unknown>

    for (const key of LEGACY_AGENT_KEYS) {
      assert.equal(
        key in parsed,
        false,
        `★ ${key} 不在 Agent 的 schema 里 ⇒ 它必须在 LEGACY_AGENT_KEYS 清单里（两边要一致）`,
      )
    }
    // 而**在用的**字段照旧被 schema 认下来（不是"整个 schema 都不认"）
    assert.equal(parsed['name'], '老形态审核者')
    assert.equal((parsed['reviewStandard'] as Record<string, unknown>)['body'], '# 老标准\n\n只看有没有写测试。')
    assert.equal(
      'allowedActions' in (parsed['reviewStandard'] as Record<string, unknown>),
      false,
      '★ 标准里那个同名字段也不在 schema 里了',
    )
  })
})

describe('cleanAgent：读路径那个包装', () => {
  test('类型不变，只把老键摘掉（两个 store 的读方法用它）', () => {
    const record = legacyRecord()
    const cleaned = cleanAgent(record as unknown as { name: string })
    const raw = cleaned as unknown as Record<string, unknown>

    assert.equal(raw['name'], '老形态审核者')
    assert.equal('reviewerAgentId' in raw, false)
    assert.equal('allowedActions' in raw, false)
  })
})