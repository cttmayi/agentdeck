import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Agent, AgentRole, Tool } from './api.ts'
import {
  actionsRunField,
  defaultActionParams,
  defaultActionPicks,
  paramsMatchReviewer,
  paramsRunField,
  picksMatchReviewer,
  resolveNewTaskChain,
  reviewerCandidates,
  reviewerChoiceOf,
  reviewerRunField,
  toReviewerPick,
  type ReviewerChoice,
} from './newtask-chain.ts'

/**
 * 「执行 → 审核 → 行动」这条链的推导（新建任务页）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里守的是**三态**，以及三态各自最贵的那个错
 * ══════════════════════════════════════════════════════════════════
 *
 * `reviewerAgentId` 的三态（省略 / null / id）在界面上就是 ② 上的三个选项，
 * 而错一格的后果都不是"显示得不好看"：
 *
 *   · "跟随"被推成"这一次换人" ⇒ 长期安排被**悄悄冻成**一次性覆盖：下一个人
 *     在智能体页把审核者换掉之后，这条路上仍按老那个人跑；
 *   · "跟随"被推成 `null` ⇒ 使用者以为自己只是照旧，实际把审核关掉了，
 *     而那条产出**看起来正常结束**；
 *   · "不审"被推成"跟随" ⇒ 一条本该被审的产出直接完成，没人会收到提示。
 *
 * ⚠️ 判据必须读**真的会发出去的那个东西**（`reviewerRunField()` 经
 *    `JSON.stringify` 之后的形状），而不是读"我记得我是这么写的"：
 *    `{ reviewerAgentId: undefined }` 与 `{}` 序列化之后一样，但意图完全不同，
 *    而这里要钉住的正是**意图**（省略 ≠ null）。
 */

function agent(input: {
  id: string
  name?: string
  role?: AgentRole
  /** `undefined` = 老数据里**根本没有这个键**（与 `null` 同义）。 */
  reviewerAgentId?: string | null
  allowedActions?: string[]
  /** 搬走之前的那份（写在审核标准里的）——界面按它回退显示。 */
  legacyActions?: string[]
  /** D43：这个审核者长期钉的固定参数。`undefined` = 没设（与 `{}` 同义）。 */
  actionParams?: Record<string, Record<string, unknown>>
}): Agent {
  return {
    id: input.id,
    name: input.name ?? input.id,
    instructions: '',
    workDir: null,
    skillIds: [],
    model: null,
    runtimeKey: 'claude',
    role: input.role ?? 'executor',
    reviewerAgentId: input.reviewerAgentId ?? null,
    ...(input.allowedActions === undefined ? {} : { allowedActions: input.allowedActions }),
    ...(input.actionParams === undefined ? {} : { actionParams: input.actionParams }),
    reviewStandard:
      input.legacyActions === undefined
        ? null
        : { name: '标准', body: '', allowedActions: input.legacyActions },
  }
}

function tool(slug: string, actions: Array<{ name: string; summary: string }>): Tool {
  return {
    id: `tool-${slug}`,
    slug,
    name: slug,
    description: '',
    version: null,
    manifest: { slug, actions: actions.map((a) => ({ ...a, reversible: true, dryRun: 'supported' })) },
    files: {},
    docs: '',
    source: 'local',
    sourceRef: null,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Tool
}

const FOLLOW: ReviewerChoice = { mode: 'follow' }
const NONE: ReviewerChoice = { mode: 'none' }
const pick = (agentId: string): ReviewerChoice => ({ mode: 'pick', agentId })

/** 一份最小的世界：执行者 + 审核者 + 一个提供两个动作的工具包。 */
const R = agent({
  id: 'r1',
  name: '审核员',
  role: 'reviewer',
  allowedActions: ['probe-tool.append-note'],
})
const E = agent({ id: 'e1', name: '助手', role: 'executor', reviewerAgentId: 'r1' })
const TOOL = tool('probe-tool', [
  { name: 'append-note', summary: '把一句话追加到 NOTES.md' },
  { name: 'say', summary: '打个招呼' },
])

describe('② ↓ ③：跟随执行者的长期安排', () => {
  test('★ 执行者配了审核者 ⇒ 就是它，来源 `follow`，动作取它的（自动审核成立）', () => {
    const chain = resolveNewTaskChain({ executor: E, choice: FOLLOW, agents: [E, R], tools: [TOOL] })
    assert.equal(chain.reviewer?.id, 'r1')
    assert.equal(chain.reviewerSource, 'follow')
    assert.equal(chain.notReviewing, null, '跟随且解析得出来 ⇒ 会审')
    assert.deepEqual(chain.actions, ['probe-tool.append-note'])
    assert.deepEqual(chain.unavailableActions, [])
  })

  test('执行者没配「由谁来审它」 ⇒ `not_configured`，一个人都不会去审', () => {
    const bare = agent({ id: 'e2', role: 'executor', reviewerAgentId: null })
    const chain = resolveNewTaskChain({ executor: bare, choice: FOLLOW, agents: [bare, R], tools: [TOOL] })
    assert.equal(chain.reviewer, null)
    assert.equal(chain.notReviewing, 'not_configured')
    // ⚠️ 这一档**不是**错误：它是一条长期选择（`agents.noReviewerChosen` 里那句话说
    //    的是同一件事）。界面据此说的是"不会被自动审核"，而不是"配错了"。
    assert.deepEqual(chain.actions, [], '没有审核者就没有动作可显示')
    assert.deepEqual(chain.unavailableActions, [])
  })

  test('★ 配的那个 agent 已被删除 ⇒ `dangling`（**不静默退回"没配"**）', () => {
    const chain = resolveNewTaskChain({ executor: E, choice: FOLLOW, agents: [E], tools: [TOOL] })
    assert.equal(chain.reviewer, null, 'dangling 时 reviewer 必须是 null')
    assert.equal(chain.notReviewing, 'dangling')
    // 与 `not_configured` 分开的理由：两句话的**下一步不一样**——一条是"你从来没配过"，
    // 一条是"你配的那个没了，重选一个"。合成一条就会漏掉后者。
    assert.notEqual(chain.notReviewing, 'not_configured')
  })

  test('老数据里 `reviewerAgentId` 这个键**根本不存在** ⇒ 与 `null` 同义（`not_configured`）', () => {
    const legacyExecutor = agent({ id: 'e3', role: 'executor' })
    assert.equal(legacyExecutor.reviewerAgentId, null)
    const chain = resolveNewTaskChain({ executor: legacyExecutor, choice: FOLLOW, agents: [legacyExecutor], tools: [] })
    assert.equal(chain.notReviewing, 'not_configured')
  })

  test('连执行者都没有（一个执行角色的 agent 都没建）⇒ 同 `not_configured`，不炸', () => {
    const chain = resolveNewTaskChain({ executor: null, choice: FOLLOW, agents: [R], tools: [TOOL] })
    assert.equal(chain.reviewer, null)
    assert.equal(chain.notReviewing, 'not_configured')
  })
})

describe('②：这一次换个人审', () => {
  test('★ 选了某个审核者 ⇒ 来源 `override`，动作取**它**的（不是执行者配置那个的）', () => {
    const other = agent({
      id: 'r2',
      name: '安全审核员',
      role: 'reviewer',
      allowedActions: ['probe-tool.say'],
    })
    const chain = resolveNewTaskChain({
      executor: E,
      choice: pick('r2'),
      agents: [E, R, other],
      tools: [TOOL],
    })
    assert.equal(chain.reviewer?.id, 'r2')
    assert.equal(chain.reviewerSource, 'override')
    assert.equal(chain.notReviewing, null)
    // ③ 显示的是**最终那个人**的权限：显示成 r1 的会让使用者以为换人没生效。
    assert.deepEqual(chain.actions, ['probe-tool.say'])
  })

  test('★ 选的人已经被删掉 ⇒ `dangling`（不回退到执行者配的那个，也不回退到"没配"）', () => {
    const chain = resolveNewTaskChain({ executor: E, choice: pick('gone'), agents: [E, R], tools: [TOOL] })
    assert.equal(chain.reviewer, null)
    assert.equal(chain.notReviewing, 'dangling')
    assert.equal(chain.reviewerSource, 'override', '走的路仍然"这一次换人"——这正是要重选的那个选择')
  })

  test('换 ① 之后 ② 跟着重算：同一个"跟随"，两个执行者 ⇒ 两个人、两份动作', () => {
    const r2 = agent({ id: 'r2', role: 'reviewer', allowedActions: ['probe-tool.say'] })
    const e2 = agent({ id: 'e2', role: 'executor', reviewerAgentId: 'r2' })
    const world = { agents: [E, R, e2, r2], tools: [TOOL] }
    const withFirst = resolveNewTaskChain({ executor: E, choice: FOLLOW, ...world })
    const withSecond = resolveNewTaskChain({ executor: e2, choice: FOLLOW, ...world })
    assert.equal(withFirst.reviewer?.id, 'r1')
    assert.equal(withSecond.reviewer?.id, 'r2')
    assert.deepEqual(withFirst.actions, ['probe-tool.append-note'])
    assert.deepEqual(withSecond.actions, ['probe-tool.say'])
  })
})

describe('②：这一次不自动审核', () => {
  test('★ 明确选"不审" ⇒ `explicit_none`，即使执行者配了审核者（覆盖掉它）', () => {
    const chain = resolveNewTaskChain({ executor: E, choice: NONE, agents: [E, R], tools: [TOOL] })
    assert.equal(chain.reviewer, null)
    assert.equal(chain.reviewerSource, 'none')
    assert.equal(chain.notReviewing, 'explicit_none')
    assert.deepEqual(chain.actions, [], '不会审 ⇒ 没有判决 ⇒ 没有动作')
  })

  test('★ 同一份世界、"跟随"与"不审"必须推出**不同**的结果', () => {
    // 这一条防的是"两种模式被推成同一个东西"（把 none 也当成 follow、或者反过来）
    // ——那会让使用者选的那个选项看起来没生效，而产出照旧被（或不被）审核。
    const world = { executor: E, agents: [E, R], tools: [TOOL] }
    const followed = resolveNewTaskChain({ ...world, choice: FOLLOW })
    const none = resolveNewTaskChain({ ...world, choice: NONE })
    assert.equal(followed.notReviewing, null)
    assert.equal(none.notReviewing, 'explicit_none')
    assert.notDeepEqual(followed.actions, none.actions)
  })
})

describe('③：动作那一栏的两拨', () => {
  test('★ 配过、但提供它的包被卸载了 ⇒ 进 `unavailableActions`（不静默丢掉）', () => {
    const chain = resolveNewTaskChain({ executor: E, choice: FOLLOW, agents: [E, R], tools: [] })
    assert.deepEqual(chain.actions, [])
    assert.deepEqual(
      chain.unavailableActions,
      ['probe-tool.append-note'],
      '它依然是**配过的**：丢掉等于使用者没同意就改了权限',
    )
  })

  test('老数据：动作白名单还在 `reviewStandard.allowedActions` 上 ⇒ 按有效值走回退', () => {
    // 判据复用 `effectiveAllowedActions()`（智能体页那一栏用的是同一个）。
    // 这里不重写回退规则：两处各写一遍，迟早出现"同一个审核者，两页显示不一样"。
    const legacyReviewer = agent({ id: 'r3', role: 'reviewer', legacyActions: ['probe-tool.say'] })
    const e = agent({ id: 'e3', role: 'executor', reviewerAgentId: 'r3' })
    const chain = resolveNewTaskChain({ executor: e, choice: FOLLOW, agents: [e, legacyReviewer], tools: [TOOL] })
    assert.deepEqual(chain.actions, ['probe-tool.say'])
    assert.deepEqual(chain.unavailableActions, [])
  })

  test('一个动作都没配 ⇒ 两拨都是空的（界面据此说"判决只会给结论"）', () => {
    const quiet = agent({ id: 'r4', role: 'reviewer', allowedActions: [] })
    const e = agent({ id: 'e4', role: 'executor', reviewerAgentId: 'r4' })
    const chain = resolveNewTaskChain({ executor: e, choice: FOLLOW, agents: [e, quiet], tools: [TOOL] })
    assert.deepEqual(chain.actions, [])
    assert.deepEqual(chain.unavailableActions, [])
    assert.notEqual(chain.reviewer, null, '⚠️ "没有动作"与"没有审核者"是两件事，界面也分开说')
  })

  test('顺序按配的那一份（显示时不替他重排）', () => {
    const two = agent({
      id: 'r5',
      role: 'reviewer',
      allowedActions: ['probe-tool.say', 'probe-tool.append-note'],
    })
    const e = agent({ id: 'e5', role: 'executor', reviewerAgentId: 'r5' })
    const chain = resolveNewTaskChain({ executor: e, choice: FOLLOW, agents: [e, two], tools: [TOOL] })
    assert.deepEqual(chain.actions, ['probe-tool.say', 'probe-tool.append-note'])
  })

  test('解析不出来与解析得出来可以同时在：一拨一条，各自成组', () => {
    const mixed = agent({
      id: 'r6',
      role: 'reviewer',
      allowedActions: ['comment.create', 'probe-tool.say'],
    })
    const e = agent({ id: 'e6', role: 'executor', reviewerAgentId: 'r6' })
    const chain = resolveNewTaskChain({ executor: e, choice: FOLLOW, agents: [e, mixed], tools: [TOOL] })
    assert.deepEqual(chain.actions, ['probe-tool.say'])
    assert.deepEqual(chain.unavailableActions, ['comment.create'])
  })
})

describe('★ 请求体里的那个 key：省略 ≠ null ≠ id', () => {
  test('★ `follow` ⇒ key **根本不出现**（不是 null，也不是解析出来的那个 id）', () => {
    const field = reviewerRunField(FOLLOW)
    assert.deepEqual(field, {})
    assert.equal('reviewerAgentId' in field, false)
    // 真正发出去的是 JSON：这一条比对象比较更贴近事实
    assert.equal(JSON.stringify(field), '{}')
    // ⚠️ 也不能写成"把跟随解析出来的那个人传过去"：那会把长期安排冻结成一次性覆盖。
    assert.equal('reviewerAgentId' in reviewerRunField(FOLLOW), false)
  })

  test('★ `none` ⇒ `reviewerAgentId: null`（key 在，值是 null——"这一次不审"是一条记录）', () => {
    assert.equal(JSON.stringify(reviewerRunField(NONE)), '{"reviewerAgentId":null}')
  })

  test('★ `pick` ⇒ 带那个 id（这一次换人，不改长期配置）', () => {
    assert.equal(JSON.stringify(reviewerRunField(pick('r2'))), '{"reviewerAgentId":"r2"}')
  })

  test('★ 选的人已经不见了 ⇒ **照样**把那个 id 发出去（让服务端回原文，不在本地改主意）', () => {
    // 本地改成"跟随"或 null 等于替使用者做了一个他没做过的决定；而服务端那条
    // `reviewer_not_found` 的原文是页面照原样显示的那句话（`error = err.message`）。
    assert.equal(JSON.stringify(reviewerRunField(pick('gone'))), '{"reviewerAgentId":"gone"}')
  })
})

describe('③：勾选与"审核者当前那份"比什么', () => {
  /** 一个审核者，权限就是夹具里那份；执行者跟随它。 */
  function world(reviewerActions: string[], tools: Tool[] = [TOOL]) {
    const rev = agent({ id: 'rv', name: '审核员', role: 'reviewer', allowedActions: reviewerActions })
    const exe = agent({ id: 'ex', role: 'executor', reviewerAgentId: 'rv' })
    return resolveNewTaskChain({ executor: exe, choice: FOLLOW, agents: [exe, rev], tools })
  }

  test('★ 默认勾的就是审核者当前那份（`available` 那一份，顺序照配的）', () => {
    const chain = world(['probe-tool.say', 'probe-tool.append-note'])
    assert.deepEqual(defaultActionPicks(chain), ['probe-tool.say', 'probe-tool.append-note'])
  })

  test('★ 解析不出来的动作**不进**默认值（预勾上它等于准备好一个必然失败的提交）', () => {
    // `comment.create` 这类旧内置名字现在没有出处了：勾着它提交 ⇒ daemon 回
    // `allowed_actions_unresolvable` 把整条拒掉。所以默认值只取能解析的那一份。
    const chain = world(['comment.create', 'probe-tool.say'])
    assert.deepEqual(defaultActionPicks(chain), ['probe-tool.say'])
    assert.deepEqual(chain.unavailableActions, ['comment.create'])
  })

  test('没有审核者 ⇒ 默认值是空的（那一档 ③ 本来也不可编辑）', () => {
    const chain = resolveNewTaskChain({ executor: E, choice: NONE, agents: [E, R], tools: [TOOL] })
    assert.deepEqual(defaultActionPicks(chain), [])
  })

  test('★ 顺序不同**不算**改过（这就是不能用 `JSON.stringify` 比的原因）', () => {
    const chain = world(['probe-tool.say', 'probe-tool.append-note'])
    const reversed = ['probe-tool.append-note', 'probe-tool.say']
    assert.equal(picksMatchReviewer(reversed, chain), true)
    assert.notEqual(
      JSON.stringify(reversed),
      JSON.stringify(chain.actions),
      '两份的序列化结果本来就不同——判据必须是集合相等',
    )
    assert.deepEqual(actionsRunField(reversed, chain), {})
  })

  test('重复项不算改过（`[a,a]` 与 `[a]` 到了请求体里是同一份白名单）', () => {
    const chain = world(['probe-tool.say'])
    assert.equal(picksMatchReviewer(['probe-tool.say', 'probe-tool.say'], chain), true)
    assert.deepEqual(actionsRunField(['probe-tool.say', 'probe-tool.say'], chain), {})
  })

  test('多一个 / 少一个 / 换一个都算改过', () => {
    const chain = world(['probe-tool.say'])
    assert.equal(picksMatchReviewer(['probe-tool.say', 'probe-tool.append-note'], chain), false)
    assert.equal(picksMatchReviewer([], chain), false)
    const other = world(['probe-tool.append-note'])
    assert.equal(picksMatchReviewer(['probe-tool.append-note'], chain), false)
    assert.equal(picksMatchReviewer(chain.actions, other), false)
  })
})

describe('★ 请求体里的 `allowedActions`：没改就**根本不出现**那个 key', () => {
  const rev = agent({
    id: 'rv',
    role: 'reviewer',
    allowedActions: ['probe-tool.say', 'probe-tool.append-note'],
  })
  const exe = agent({ id: 'ex', role: 'executor', reviewerAgentId: 'rv' })
  const chain = resolveNewTaskChain({
    executor: exe,
    choice: FOLLOW,
    agents: [exe, rev],
    tools: [TOOL],
  })

  test('★ 一致（含"顺序不同"）⇒ `{}`：key 根本不出现 ⇒ 以后智能体页给它加动作，这条路上照样跟着变', () => {
    const field = actionsRunField(['probe-tool.append-note', 'probe-tool.say'], chain)
    assert.deepEqual(field, {})
    assert.equal('allowedActions' in field, false)
    // 真正发出去的是 JSON：这一条比对象比较更贴近事实（`undefined` 与"没有这个键"
    // 序列化之后一样，但这里要钉的是**意图**）。
    assert.equal(JSON.stringify(field), '{}')
    // ⚠️ 也不能写成"把当前解析出来的那份传过去"：那会把长期安排冻成一次覆盖。
    assert.equal('allowedActions' in actionsRunField(chain.actions, chain), false)
  })

  test('★ 改了（少勾一个）⇒ 带上那份（覆盖只影响这一条 run）', () => {
    assert.equal(
      JSON.stringify(actionsRunField(['probe-tool.say'], chain)),
      '{"allowedActions":["probe-tool.say"]}',
    )
  })

  test('★ 改了（多勾一个不在它权限里的）⇒ 也带上那份', () => {
    // 覆盖的意义就在这里：勾选框列的是**已装工具包**的全部动作（服务端按这个校验），
    // 而审核者的长期配置里可能没有它——这一条任务想用，就得把完整那一份发出去。
    const only = agent({ id: 'only', role: 'reviewer', allowedActions: ['probe-tool.say'] })
    const e = agent({ id: 'e', role: 'executor', reviewerAgentId: 'only' })
    const one = resolveNewTaskChain({ executor: e, choice: FOLLOW, agents: [e, only], tools: [TOOL] })
    assert.deepEqual(one.actions, ['probe-tool.say'])
    assert.equal(
      JSON.stringify(actionsRunField(['probe-tool.say', 'probe-tool.append-note'], one)),
      '{"allowedActions":["probe-tool.say","probe-tool.append-note"]}',
    )
  })

  test('★★ 一个都不勾 ⇒ 发 `[]`，**不是**省略（"这一次一个动作都不许触发"是一条决定）', () => {
    const field = actionsRunField([], chain)
    assert.equal('allowedActions' in field, true)
    assert.equal(JSON.stringify(field), '{"allowedActions":[]}')
    // 省略它 = 跟随 ⇒ 判决照样能触发那两个动作。使用者在这里收的紧会**静默失效**，
    // 而那条产出看起来正常结束——这正是这一条要钉住的东西。
    assert.notEqual(JSON.stringify(field), '{}')
  })

  test('★ 审核者本来就没有动作 + 也没勾 ⇒ 省略（这一档的"不勾"与"它本来空"是一回事）', () => {
    const quiet = agent({ id: 'q', role: 'reviewer', allowedActions: [] })
    const e = agent({ id: 'e', role: 'executor', reviewerAgentId: 'q' })
    const empty = resolveNewTaskChain({ executor: e, choice: FOLLOW, agents: [e, quiet], tools: [TOOL] })
    assert.deepEqual(empty.actions, [])
    assert.deepEqual(actionsRunField([], empty), {})
  })

  test('★ 审核者本来空 + 勾了一个 ⇒ 带上那一个（否则勾了等于没勾）', () => {
    const quiet = agent({ id: 'q', role: 'reviewer', allowedActions: [] })
    const e = agent({ id: 'e', role: 'executor', reviewerAgentId: 'q' })
    const empty = resolveNewTaskChain({ executor: e, choice: FOLLOW, agents: [e, quiet], tools: [TOOL] })
    assert.equal(
      JSON.stringify(actionsRunField(['probe-tool.say'], empty)),
      '{"allowedActions":["probe-tool.say"]}',
    )
  })

  test('★ 那份删掉的审核者：动作取不到 ⇒ 空勾 = 省略；勾了动作才带（由服务端说"没有审核者"）', () => {
    // ② 指向一个已经被删掉的人（`dangling`）：`reviewer` 是 null、`actions` 是空，
    // 所以"什么都没勾"与"它当前那份"一致 ⇒ 省略——那正是这一档该有的行为：
    // 页面上 ③ 本来就不可编辑（一份动作都没有落点）。
    const gone = resolveNewTaskChain({ executor: E, choice: pick('gone'), agents: [E, R], tools: [TOOL] })
    assert.equal(gone.reviewer, null)
    assert.deepEqual(actionsRunField([], gone), {})
    // 而万一带着动作过来（页面上不可达，但函数不该在这里自作聪明地清空它）：
    // 照样发出去，让 daemon 回 `allowed_actions_without_reviewer` 的原文。
    assert.deepEqual(actionsRunField(['probe-tool.say'], gone), {
      allowedActions: ['probe-tool.say'],
    })
  })

  test('跟随到"执行者没配审核者"那一档同样是省略（没有覆盖可谈）', () => {
    const bare = agent({ id: 'bare', role: 'executor', reviewerAgentId: null })
    const chainBare = resolveNewTaskChain({
      executor: bare,
      choice: FOLLOW,
      agents: [bare, R],
      tools: [TOOL],
    })
    assert.equal(chainBare.notReviewing, 'not_configured')
    assert.deepEqual(actionsRunField([], chainBare), {})
  })
})

describe('③ 的固定参数（D43）：与白名单同一套"省略 = 跟随"判据', () => {
  /** 一个审核者，长期钉了一份固定参数；执行者跟随它。 */
  function world(
    params: Record<string, Record<string, unknown>>,
    tools: Tool[] = [TOOL],
  ) {
    const rev = agent({
      id: 'rv',
      name: '审核员',
      role: 'reviewer',
      allowedActions: ['probe-tool.append-note'],
      actionParams: params,
    })
    const exe = agent({ id: 'ex', role: 'executor', reviewerAgentId: 'rv' })
    return resolveNewTaskChain({ executor: exe, choice: FOLLOW, agents: [exe, rev], tools })
  }

  test('★ 表单默认值就是审核者长期那份（`defaultActionParams` 原样带出，不做任何修剪）', () => {
    const chain = world({ 'probe-tool.append-note': { text: '长期钉的', dir: '/x' } })
    assert.deepEqual(defaultActionParams(chain), { 'probe-tool.append-note': { text: '长期钉的', dir: '/x' } })
  })

  test('审核者没设 ⇒ 默认值是 `{}`（表单里那一档空着）', () => {
    const chain = world({})
    assert.deepEqual(defaultActionParams(chain), {})
  })

  test('★ 值一样、键序不同 ⇒ **不算**改过（判据必须是深比较，不是 `JSON.stringify`）', () => {
    const chain = world({ 'probe-tool.append-note': { text: 'x', dir: '/y' } })
    const swapped = { 'probe-tool.append-note': { dir: '/y', text: 'x' } }
    assert.equal(paramsMatchReviewer(swapped, chain), true)
    assert.notEqual(
      JSON.stringify(swapped),
      JSON.stringify(chain.actionParams),
      '两份的序列化结果本来就不同——判据必须是逐项深比较',
    )
    assert.deepEqual(paramsRunField(swapped, chain), {})
  })

  test('★ 值改了 / 少一个动作 / 多一个动作都算改过', () => {
    const chain = world({ 'probe-tool.append-note': { text: 'x' } })
    assert.equal(paramsMatchReviewer({ 'probe-tool.append-note': { text: 'y' } }, chain), false)
    assert.equal(paramsMatchReviewer({}, chain), false, '空对象 = 这一次不固定任何参数，是**明确的选择**')
    assert.equal(
      paramsMatchReviewer({ 'probe-tool.append-note': { text: 'x' }, 'probe-tool.say': {} }, chain),
      false,
    )
  })

  test('★ 没改 ⇒ `actionParams` 这个 key 根本不出现（省略 = 跟随审核者长期那份）', () => {
    const chain = world({ 'probe-tool.append-note': { text: 'x' } })
    const field = paramsRunField({ 'probe-tool.append-note': { text: 'x' } }, chain)
    assert.deepEqual(field, {})
    assert.equal('actionParams' in field, false)
    // 真正发出去的是 JSON：这条比对象比较更贴近事实。
    assert.equal(JSON.stringify(field), '{}')
  })

  test('★ 改了 ⇒ 带上这一份（覆盖只影响这一条 run）', () => {
    const chain = world({ 'probe-tool.append-note': { text: 'x' } })
    assert.equal(
      JSON.stringify(paramsRunField({ 'probe-tool.append-note': { text: '这次改的' } }, chain)),
      '{"actionParams":{"probe-tool.append-note":{"text":"这次改的"}}}',
    )
  })

  test('★★ 这一次**什么都不固定** ⇒ 发 `{}`，**不是**省略（顶掉审核者长期那份，放开给模型填）', () => {
    const chain = world({ 'probe-tool.append-note': { text: '长期钉的' } })
    const field = paramsRunField({}, chain)
    assert.equal('actionParams' in field, true)
    assert.equal(JSON.stringify(field), '{"actionParams":{}}')
    // 省略它 = 跟随 ⇒ 模型**不许**写 text（已固定）。使用者在这里想放开，省略会
    // 让"放开"静默失效——这正是这一条要钉住的东西。
    assert.notEqual(JSON.stringify(field), '{}')
  })

  test('★ 审核者本来没设 + 表单也没动 ⇒ 省略；动了才带（跟随不冻成覆盖）', () => {
    const chain = world({})
    assert.deepEqual(paramsRunField({}, chain), {})
    assert.equal(
      JSON.stringify(paramsRunField({ 'probe-tool.append-note': { text: 'x' } }, chain)),
      '{"actionParams":{"probe-tool.append-note":{"text":"x"}}}',
    )
  })
})

describe('② 的候选：INV-1（执行者不能审自己）', () => {
  test('★ 候选**只有**审核者角色，且排除当前选中的执行者', () => {
    const weird = agent({ id: 'e9', name: '另一个执行者', role: 'executor' })
    const ids = reviewerCandidates(E, [E, R, weird]).map((a) => a.id)
    assert.deepEqual(ids, ['r1'])
  })

  test('★ 换了执行者之后，候选跟着重算（同一个人不能被前一步选中又被后一步选）', () => {
    const e2 = agent({ id: 'e2', role: 'executor' })
    const ids = reviewerCandidates(e2, [E, R, e2]).map((a) => a.id)
    assert.deepEqual(ids, ['r1'])
  })

  test('没有执行者时不过滤（一个执行者都没有的那一档不该顺手把审核者也藏起来）', () => {
    assert.deepEqual(reviewerCandidates(null, [E, R]).map((a) => a.id), ['r1'])
  })
})

describe('下拉的取值编码：三态往返不串味', () => {
  test('★ 三种模式各自往返', () => {
    for (const choice of [FOLLOW, NONE, pick('r1'), pick('follow')] as ReviewerChoice[]) {
      assert.deepEqual(reviewerChoiceOf(toReviewerPick(choice)), choice)
    }
  })

  test('agent id 恰好叫 `follow` 也不会与"跟随"撞上（这就是要加前缀的原因）', () => {
    assert.notEqual(toReviewerPick(pick('follow')), toReviewerPick(FOLLOW))
  })

  test('认不出来的值当"跟随"（最保守的一档：不凭空多一个、也不凭空少一个审核者）', () => {
    assert.deepEqual(reviewerChoiceOf(''), FOLLOW)
    assert.deepEqual(reviewerChoiceOf('pick:'), FOLLOW)
    assert.deepEqual(reviewerChoiceOf('什么鬼'), FOLLOW)
  })
})
