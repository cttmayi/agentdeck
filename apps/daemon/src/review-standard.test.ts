import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ActionRefType, Agent } from '@agentdeck/protocol'
import {
  effectiveAllowedActions,
  resolveReviewStandard,
  reviewerIdentity,
} from './review-standard.ts'

/**
 * ══════════════════════════════════════════════════════════════════
 * 「审核标准」的解析（D37）——三处调用点共用的那一份判据
 * ══════════════════════════════════════════════════════════════════
 *
 * 派发审核前判"这个审核者能不能用"、渲染第一句话的 `{{standards}}`、判决收口时
 * 校验动作白名单——三处都用这个函数。所以它错一点，三处一起错，而且是"界面说
 * 它有标准、平台却不派审核"那类最难查的错。
 *
 * 这里只测**纯函数**（不起 daemon）：`resolveReviewStandard` 的几种情形。
 * 派发与判决那两条链路的端到端在 `review-e2e.test.ts`。
 *
 * ══════════════════════════════════════════════════════════════════
 * D40 收口：**动作权限搬到 agent 上**，skill 不再参与授权
 * ══════════════════════════════════════════════════════════════════
 *
 * 所以这个文件里同时钉住两件事：
 *
 *   1. 白名单的权威顺序：`agent.allowedActions` 非空 ⇒ 用它；空 ⇒ 回退到
 *      老数据里 `reviewStandard.allowedActions` 那份（**只读兼容**）；
 *   2. **skill 的动作配置一个字都不算数**——包括老 skill 里还留着的那个键。
 *
 * ── D41：夹具里的动作名 ──
 *
 * 夹具动作名换成工具包动作名（`fixture-tool.act` / `other-tool.act` /
 * `third-tool.act`）：D41 之后动作名**只可能**是 `<包 slug>.<动作名>`，
 * 平台的六个内置动作全删了。原来的夹具用的是内置名，其中 `issue.add_label`
 * 这类连形状都不合法（下划线不在允许字符里）——拿它当夹具会让人以为
 * 这套名字还能出现在白名单里。**断言原意一字未改**（这里守的是回退与权威
 * 来源，不是动作本身）。
 */
const agent = (
  reviewStandard: Agent['reviewStandard'],
  allowedActions: ActionRefType[] = [],
): Pick<Agent, 'reviewStandard' | 'allowedActions'> => ({ reviewStandard, allowedActions })

/** 正常数据里的 skill：只有名字与正文（`Skill` 上已经没有 `allowedActions` 了）。 */
const skill = (name: string, body: string) => ({ name, body })

/**
 * **老数据**里的 skill：它当年带一个 `allowedActions`。
 *
 * 整个 `Skill` 实体上已经没有这个键了，而老记录是整条 JSON 存下来的——所以
 * 形状上要照着当年的样子构造，才能钉住"读它也不算数"这条。
 */
const legacySkill = (
  name: string,
  body: string,
  allowedActions: ActionRefType[] = [],
): { name: string; body: string; allowedActions: ActionRefType[] } => ({
  name,
  body,
  allowedActions,
})

describe('D37：审核标准怎么解析', () => {
  test('有内联标准 ⇒ 用它，且不标成"来自 skill"', () => {
    const resolved = resolveReviewStandard(
      agent(
        { body: '# 安全审核\n\n1. 只看越权。' },
        ['fixture-tool.act'],
      ),
      [],
    )
    assert.ok(resolved)
    assert.match(resolved.body, /只看越权/)
    assert.deepEqual(resolved.allowedActions, ['fixture-tool.act'], '来自 agent.allowedActions')
    assert.equal(resolved.fromSkills, false)
  })

  test('★★ 老数据里的标准还带着 `name` 键 ⇒ 读的时候忽略它，不需要迁移', () => {
    // 删掉那个字段之前存的记录里，标准是 `{ name, body }` 两截。整条记录以 JSON
    // 存、读取路径上没有 zod 校验，所以老记录读回来**一定**还带着 `name`——
    // 这条钉的是"不需要数据迁移"这句话：多的那个键不影响任何解析结果。
    const legacy = { name: '当年起的名字', body: '# 正文\n\n照旧要能判' } as unknown as Agent['reviewStandard']
    const resolved = resolveReviewStandard(agent(legacy, ['fixture-tool.act']), [])
    assert.ok(resolved, '带多余键的老标准照样能用')
    assert.equal(resolved.body, '# 正文\n\n照旧要能判')
    assert.deepEqual(resolved.allowedActions, ['fixture-tool.act'])
    assert.equal(resolved.fromSkills, false)
  })

  test('★ 动作来自 `Agent.allowedActions`，不是标准里的那份（搬家后的正常路径）', () => {
    // 内联标准里**没有**动作字段（写入口只写名字与正文），agent 上那份才是权威。
    const resolved = resolveReviewStandard(agent({ body: '正文' }, ['other-tool.act']), [])
    assert.ok(resolved)
    assert.deepEqual(resolved.allowedActions, ['other-tool.act'])
  })

  test('★ 老数据回退：`Agent.allowedActions` 为空时用标准里那份（只读兼容）', () => {
    // 这是搬走之前的写法：动作写在标准里、agent 上没有（老记录的 `allowedActions`
    // 键**根本不存在** ⇒ 读取时按空处理）。判决必须照旧按它校验，否则
    // "一次升级就把在跑的审核者的动作权限抹掉"。
    const resolved = resolveReviewStandard(
      agent({ body: '正文', allowedActions: ['fixture-tool.act', 'other-tool.act'] }),
      [],
    )
    assert.ok(resolved)
    assert.deepEqual(
      resolved.allowedActions,
      ['fixture-tool.act', 'other-tool.act'],
      '★ 老数据不能因为搬家而失去动作权限',
    )
  })

  test('★ 回退只在 agent 为空时发生：agent 有值 ⇒ 标准里那份被忽略（不被合并）', () => {
    // 合并语义是安全相关的：并集等于悄悄放宽权限、交集等于莫名其妙收紧，
    // 两个都不该是隐式行为。谁在权威位置上，就只按谁判。
    const resolved = resolveReviewStandard(
      agent({ body: '正文', allowedActions: ['third-tool.act'] }, ['fixture-tool.act']),
      [],
    )
    assert.ok(resolved)
    assert.deepEqual(resolved.allowedActions, ['fixture-tool.act'], '不许被标准里那份放宽')
  })

  test('★ skill 不再参与动作授权：老 skill 里的 `allowedActions` 一个字都不算', () => {
    // ⚠️ 这条是这次搬家的核心断言：一个挂着**带动作配置的老 skill** 的审核者，
    //    有效动作列表**只**由 agent 决定。并集（改动之前的行为）在此被明确否掉。
    const resolved = resolveReviewStandard(agent(null, ['fixture-tool.act']), [
      legacySkill('老标准', '老正文', ['other-tool.act', 'third-tool.act']),
    ])
    assert.ok(resolved)
    assert.deepEqual(
      resolved.allowedActions,
      ['fixture-tool.act'],
      '★ 老 skill 的动作既不加进来，也不顶替 agent 上那份',
    )
    assert.equal(resolved.fromSkills, true, '正文仍然来自 skill（兼容路径只影响正文）')
  })

  test('★ 只在这两处都空时，老 skill 的动作才兜底（D40 收口前的老数据）', () => {
    // ⚠️ 这一层是**只读兜底**，不是"skill 又能授权了"：新数据里写入口只写
    //    `Agent.allowedActions`，而且这里只在 agent 与内联标准都为空的**最后**
    //    才走。留着它的理由：D40 之前建好的审核者（标准与动作都在 skill 里）
    //    如果因为这次搬家拿到空白名单，它的判决会突然整条无效——而使用者
    //    **没有动过任何配置**。
    const resolved = resolveReviewStandard(agent(null, []), [
      legacySkill('老标准', '老正文', ['fixture-tool.act']),
    ])
    assert.ok(resolved)
    assert.deepEqual(resolved.allowedActions, ['fixture-tool.act'], '老数据不至于突然失去动作')
    assert.equal(resolved.fromSkills, true, '界面上那条"建议固化"的提示同时也说明了动作的出处')

    // 而 agent 上一旦有了值，skill 那份就不再被读（先看前两层）
    const own = resolveReviewStandard(agent(null, ['third-tool.act']), [
      legacySkill('老标准', '老正文', ['fixture-tool.act']),
    ])
    assert.deepEqual(own?.allowedActions, ['third-tool.act'], 'agent 上那份是权威')
  })

  test('★ 内联标准优先于挂载的 skill（两份都在时以内联为准，不合并）', () => {
    const resolved = resolveReviewStandard(agent({ body: '内联正文' }, ['fixture-tool.act']), [
      skill('挂着的', 'skill 正文'),
      legacySkill('老挂着的', '老正文', ['other-tool.act', 'third-tool.act']),
    ])
    assert.ok(resolved)
    assert.equal(resolved.body, '内联正文')
    assert.deepEqual(resolved.allowedActions, ['fixture-tool.act'], '不许被 skill 的动作放宽')
    assert.equal(resolved.fromSkills, false)
  })

  test('★ 过渡期：没有内联标准但挂了 skill ⇒ 用 skill 的**正文**顶上（老数据不停摆）', () => {
    const resolved = resolveReviewStandard(agent(null, []), [
      skill('通用审核', '# 通用审核\n\n判断标准…'),
      skill('安全', '# 安全\n\n越权检查…'),
    ])
    assert.ok(resolved, '这是不改动之前的行为，必须还能用')
    assert.equal(resolved.fromSkills, true, '要标出来——界面据此提示迁移')
    assert.match(resolved.body, /通用审核/)
    assert.match(resolved.body, /越权检查/, '多份 skill 的正文都要在')
    // ⚠️ 这里曾经断言"动作并集 —— 与改动之前一分不差"。那句话已经作废：
    //    动作权限搬到 agent 上了，skill 只提供正文（D40 收口）。
    assert.deepEqual(resolved.allowedActions, [], '动作不再从 skill 推出来')
  })

  test('两者都没有 / 正文是空白 ⇒ null（没有标准）', () => {
    assert.equal(resolveReviewStandard(agent(null), []), null)
    assert.equal(resolveReviewStandard(agent(null), [skill('空壳', '   ')]), null)
    assert.equal(
      resolveReviewStandard(agent({ body: '  ' }), []),
      null,
      '只有空白的"标准"等于没有标准',
    )
  })

  test('内联标准存在但正文空白时，**回落到 skill**（而不是当成"有标准"）', () => {
    // 边界情形：使用者把正文清空了、但没删除那条标准。这时不能拿它当标准
    // （它没有任何内容），也不能让审核者直接变成"审不了"——挂了 skill 就照旧用。
    const resolved = resolveReviewStandard(agent({ body: '' }, ['fixture-tool.act']), [
      skill('兜底标准', '兜底正文'),
    ])
    assert.ok(resolved)
    assert.equal(resolved.fromSkills, true)
    assert.match(resolved.body, /兜底正文/)
    assert.deepEqual(resolved.allowedActions, ['fixture-tool.act'], '动作仍然只由 agent 决定')
  })
})

/**
 * ★★ 2026-09：标准并进「指令」，资格判据改成「身份非空」。
 *
 * 两件事必须一起做（只做一件都会坏）：
 *
 *   · 只改判据 ⇒ 一个**只写了标准、没写指令**的老审核者当场**静默停摆**；
 *   · 只改归属 ⇒ 界面撤了那个框，判据还在看它 ⇒ 新建的审核者永远派不出审核。
 *
 * 所以判据看的是**合成后的身份**：指令在前，老数据的标准正文并进来。
 */
describe('2026-09：审核者身份（指令 + 老数据的标准）', () => {
  const skills = [{ name: 'skill-probe', body: '# 老标准\n\n只看有没有写测试。' }]

  test('★ 只有指令 ⇒ 身份就是指令（新数据的正常路径）', () => {
    const out = reviewerIdentity({ reviewStandard: null, instructions: '你按这条判。' }, [])
    assert.equal(out.text, '你按这条判。')
    assert.equal(out.fromLegacyStandard, false)
  })

  test('★★ 只有老数据里的标准 ⇒ 身份是它，而且仍然算"有身份"（不会静默停摆）', () => {
    const inline = reviewerIdentity(
      { reviewStandard: { body: '# 老内联标准', allowedActions: [] }, instructions: '' },
      [],
    )
    assert.equal(inline.text, '# 老内联标准')
    assert.equal(inline.fromLegacyStandard, true)

    const fromSkill = reviewerIdentity({ reviewStandard: null, instructions: '' }, skills)
    assert.match(fromSkill.text, /老标准/)
    assert.equal(fromSkill.fromLegacyStandard, true)
  })

  test('★ 两样都有 ⇒ 合成（指令在前，标准在后），并标出标准是老数据', () => {
    const out = reviewerIdentity(
      { reviewStandard: { body: '# 老内联标准', allowedActions: [] }, instructions: '你是谁。' },
      [],
    )
    assert.equal(out.text, '你是谁。\n\n# 老内联标准')
    assert.equal(out.fromLegacyStandard, true)
  })

  test('★ 两样都空 ⇒ 空身份（这时才不派审核）', () => {
    assert.equal(reviewerIdentity({ reviewStandard: null, instructions: '   ' }, []).text, '')
    assert.equal(reviewerIdentity({ reviewStandard: null, instructions: null }, []).text, '')
  })
})

/**
 * ══════════════════════════════════════════════════════════════════
 * ★★ 动作权限的取法**不许经过"有没有标准正文"**（2026-09 修的那个坑）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这是本仓库里"一个坏掉的导出边界、症状出现在离它很远的地方"的典型：
 *
 *   `effectiveAllowedActions` 原来**不导出**，注释里写着"调用方用
 *   `resolveReviewStandard(...).allowedActions` 就行"。而后者回答的是
 *   "审核标准是什么"——**没有正文时它返回 `null`**。于是 `executor.ts` 里那两处
 *
 *     `run.allowedActions ?? resolveReviewStandard(...)?.allowedActions ?? []`
 *
 *   的判据悄悄变成了"**有没有正文**"：
 *
 *     · 标准内联在 agent 上 ⇒ 动作权限正常；
 *     · 标准并进「指令」、老字段被清成 `null` ⇒ 这一项变成 `[]` ⇒ 判决一引用动作，
 *       就被升级成「动作 X 不在这个审核者的行动权限里（当前允许：无）」。
 *
 * 而"标准并进「指令」"正是 2026-09 之后**所有新审核者的常态**：新建一个审核者、
 * 给它勾上动作，它永远触发不了任何动作，且**没有任何一处报错**。
 * 抓它的是 `s1-e2e` 那条端到端（它给播种的审核者授权动作，而那条用例走的就是
 * "标准在 agent 上"这条路；一次"保存时并进「指令」"的改动把它点着了）。
 */
describe('★★ 动作权限与"有没有标准正文"是两件事（2026-09）', () => {
  const ACT = 'fixture-tool.act' as ActionRefType

  test('★★★ 标准并进「指令」之后（`reviewStandard: null`）动作权限**仍然拿得到**', () => {
    const merged = { reviewStandard: null, instructions: '你是谁。\n\n# 判定', allowedActions: [ACT] }
    assert.deepEqual(
      effectiveAllowedActions(merged, []),
      [ACT],
      '★ 这就是那个坑：动作权限必须与正文无关（否则"并进「指令」"等于把权限清空）',
    )
    assert.equal(
      resolveReviewStandard(merged, []),
      null,
      '⚠️ 而 `resolveReviewStandard` 在这种形态下**确实**返回 null——它回答的是"标准是什么"，' +
        '所以动作权限不能借它的返回值（借了就会被 `?? []` 吞掉）',
    )
  })

  test('★ 老数据的回退顺序照旧：自己的那份优先，为空才回退到标准里那份', () => {
    const legacy = {
      reviewStandard: { body: '# 老标准', allowedActions: ['legacy.act' as ActionRefType] },
      instructions: '',
      allowedActions: [ACT],
    }
    assert.deepEqual(effectiveAllowedActions(legacy, []), [ACT], '自己有 ⇒ 用自己那份')
    assert.deepEqual(
      effectiveAllowedActions({ ...legacy, allowedActions: [] }, []),
      ['legacy.act'],
      '自己空 ⇒ 回退到老标准里那份（只读兼容）',
    )
  })
})
