import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ActionRefType, Agent } from '@agentdeck/protocol'
import { resolveReviewStandard } from './review-standard.ts'

/**
 * ══════════════════════════════════════════════════════════════════
 * 「审核标准」的解析（D37）——**只回答"按什么判"**
 * ══════════════════════════════════════════════════════════════════
 *
 * 派发审核前判"这个审核者能不能用"、渲染第一句话的 `{{standards}}`，都用这个
 * 函数。所以它错一点，两处一起错，而且是"界面说它有标准、平台却不派审核"那类
 * 最难查的错。
 *
 * ⚠️⚠️ **动作权限不在这个文件里**（2026-10）。这个文件里曾经有一大批用例在钉
 *    白名单的权威顺序（agent → 老标准 → 老 skill 三级回退），连"skill 的动作
 *    一个字都不算数"这种细节都钉着。那套东西随"动作权限只在**组**上"一起删掉了：
 *    动作与"按什么判"本来就是两件事，把它们放在一个文件里测，才会让下一个人
 *    以为改这里能改到动作。
 *
 * 这里只测**纯函数**（不起 daemon）。派发、判决与动作那几条链路的端到端在
 * `review-e2e.test.ts` 与 `tool-action-e2e.test.ts`。
 */
/** 解析标准只要 `reviewStandard` 这一样（动作已经不在这个文件里了）。 */
const agent = (reviewStandard: Agent['reviewStandard']): Pick<Agent, 'reviewStandard'> => ({
  reviewStandard,
})

/** 正常数据里的 skill：只有名字与正文（`Skill` 上已经没有 `allowedActions` 了）。 */
const skill = (name: string, body: string) => ({ name, body })

/**
 * **老数据**里的 skill：它当年带一个 `allowedActions`。
 *
 * 整个 `Skill` 实体上已经没有这个键了，而老记录是整条 JSON 存下来的——所以
 * 形状上要照着当年的样子构造，才能钉住"读它也不算数"这条（正文照旧能用，
 * 那个键**一个字节都不参与**）。
 */
const legacySkill = (
  name: string,
  body: string,
): { name: string; body: string; allowedActions: ActionRefType[] } => ({
  name,
  body,
  allowedActions: ['legacy-stale.act' as ActionRefType],
})

describe('D37：审核标准怎么解析', () => {
  test('有内联标准 ⇒ 用它，且不标成"来自 skill"', () => {
    const resolved = resolveReviewStandard(agent({ body: '# 安全审核\n\n1. 只看越权。' }), [])
    assert.ok(resolved)
    assert.match(resolved.body, /只看越权/)
    assert.equal(resolved.fromSkills, false)
  })

  test('★★ 老数据里的标准还带着 `name` 键 ⇒ 读的时候忽略它，不需要迁移', () => {
    // 删掉那个字段之前存的记录里，标准是 `{ name, body }` 两截。整条记录以 JSON
    // 存、读取路径上没有 zod 校验，所以老记录读回来**一定**还带着 `name`——
    // 这条钉的是"不需要数据迁移"这句话：多的那个键不影响任何解析结果。
    const legacy = { name: '当年起的名字', body: '# 正文\n\n照旧要能判' } as unknown as Agent['reviewStandard']
    const resolved = resolveReviewStandard({ reviewStandard: legacy }, [])
    assert.ok(resolved, '带多余键的老标准照样能用')
    assert.equal(resolved.body, '# 正文\n\n照旧要能判')
    assert.equal(resolved.fromSkills, false)
  })

  test('★ 内联标准优先于挂载的 skill（两份都在时以内联为准，不合并）', () => {
    const resolved = resolveReviewStandard({ reviewStandard: { body: '内联正文' } }, [
      skill('挂着的', 'skill 正文'),
      legacySkill('老挂着的', '老正文'),
    ])
    assert.ok(resolved)
    assert.equal(resolved.body, '内联正文', '内联那份是权威，不与 skill 合并')
    assert.equal(resolved.fromSkills, false)
  })

  test('★ 过渡期：没有内联标准但挂了 skill ⇒ 用 skill 的**正文**顶上（老数据不停摆）', () => {
    const resolved = resolveReviewStandard(agent(null), [
      skill('通用审核', '# 通用审核\n\n判断标准…'),
      skill('安全', '# 安全\n\n越权检查…'),
    ])
    assert.ok(resolved, '这是不改动之前的行为，必须还能用')
    assert.equal(resolved.fromSkills, true, '要标出来——界面据此提示迁移')
    assert.match(resolved.body, /通用审核/)
    assert.match(resolved.body, /越权检查/, '多份 skill 的正文都要在')
    // ⚠️ 这里曾经断言"动作并集 —— 与改动之前一分不差"，后来改成"动作不再从
    //    skill 推出来"，2026-10 起连动作字段都没有了：这个函数**只**给正文。
  })

  test('两者都没有 / 正文是空白 ⇒ null（没有标准）', () => {
    assert.equal(resolveReviewStandard(agent(null), []), null)
    assert.equal(resolveReviewStandard(agent(null), [skill('空壳', '   ')]), null)
    assert.equal(
      resolveReviewStandard(agent({ body: '  ' }), []),
      null,
      '只有空白的"标准"等于没有标准',
    )
    // 老 skill 里那个多余的动作键也不改变任何结论（正文空白仍然是空白）
    assert.equal(resolveReviewStandard(agent(null), [legacySkill('老壳', ' ')]), null)
  })

  test('内联标准存在但正文空白时，**回落到 skill**（而不是当成"有标准"）', () => {
    // 边界情形：使用者把正文清空了、但没删除那条标准。这时不能拿它当标准
    // （它没有任何内容），也不能让审核者直接变成"审不了"——挂了 skill 就照旧用。
    const resolved = resolveReviewStandard(agent({ body: '' }), [skill('兜底标准', '兜底正文')])
    assert.ok(resolved)
    assert.equal(resolved.fromSkills, true)
    assert.match(resolved.body, /兜底正文/)
  })
})

/*
 * ⚠️ 2026-11（D125）：这里原来是「2026-09：审核者身份（指令 + 老数据的标准）」——
 *   `reviewerIdentity` 把指令与老标准合成一份**投递出去的身份**，判据是"这份非空"。
 *
 *   审核 run 退场 ⇒ 没有"审核者的身份"要合成（② 就是 agent 自己的「指令」），
 *   函数与这组用例一起删。
 *
 *   ⚠️ 那组用例守着一件很有价值的事：**"只改判据"与"只改归属"必须一起做**——
 *   只改判据会让只写了老标准、没写指令的审核者**静默停摆**（产出照样跑、审核没了）。
 *   任何"同一件事的判据与落点分居两处"的迁移都该照这条经验做。
 */
