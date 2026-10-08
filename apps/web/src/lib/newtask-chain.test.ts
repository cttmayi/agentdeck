import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Agent, AgentRole, Tool } from './api.ts'
import {
  actionsRunField,
  defaultActionParams,
  defaultActionPicks,
  groupExecutor,
  paramsMatchReviewer,
  paramsRunField,
  picksMatchReviewer,
  resolveNewTaskChain,
  reviewerCandidates,
  reviewerChoiceOf,
  reviewerRunField,
  reworkRunField,
  toReviewerPick,
  type GroupChainDefaults,
  type ReviewerChoice,
} from './newtask-chain.ts'

/**
 * 「执行 → 审核 → 行动」这条链的推导（新建任务页）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里守的是**三态**，以及三态各自最贵的那个错
 * ══════════════════════════════════════════════════════════════════
 *
 * `reviewerAgentId` 的三态（省略 / null / id）在请求体里就是 ② 上的三个选项，
 * 而错一格的后果都不是"显示得不好看"：
 *
 *   · "不点名"被推成"这一次点名" ⇒ 组的默认被**悄悄冻成**一次性覆盖：以后组里
 *     换了审核者，这条路上仍按当时那个人跑；
 *   · "不点名"被推成 `null` ⇒ 使用者以为自己只是没点名，实际在库里留下一条
 *     "他决定不审"的记录（而现在这两者**行为相同、记录不同**，见 `Run.reviewerAgentId`）；
 *   · "不审"被推成"不点名" ⇒ 一条本该被审的产出直接完成，没人会收到提示。
 *
 * ⚠️ 判据必须读**真的会发出去的那个东西**（`reviewerRunField()` 经
 *    `JSON.stringify` 之后的形状），而不是读"我记得我是这么写的"：
 *    `{ reviewerAgentId: undefined }` 与 `{}` 序列化之后一样，但意图完全不同，
 *    而这里要钉住的正是**意图**（省略 ≠ null）。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ 2026-10：链的两个默认来源都只剩**组**
 * ══════════════════════════════════════════════════════════════════
 *
 * 这个文件里原来有一大批用例围着**执行者身上那条「由谁来审它」**转
 * （`executor.reviewerAgentId`），以及围着**审核者个人的行动权限**
 * （`reviewer.allowedActions` / `actionParams`）转——它们是老路径那两个字段的
 * 判据。那两个字段连同概念一起撤掉了，于是判据整体搬到**组**上：
 *
 *   · 谁审 ⇒ 组的审核者（`GroupChainDefaults.reviewerId`）；没有组 ⇒ **没有人审**；
 *   · 允许动什么 ⇒ 组的 `allowedActions` / `actionParams`；没有组 ⇒ 空。
 *
 * ⚠️ 搬家**没有放宽任何一条**：省略语义、"不点名 ≠ 不审"、"点了一个已经不存在的人
 *    照样把 id 发出去"这些判据一条没动，动的只是"那份默认从哪儿来"。
 * ⚠️ 也**不能**造一个带 `reviewerAgentId` 的 agent 夹具来"让老用例继续跑"：
 *    那会让这一整套测试围着一个服务端**永远不会再返回**的字段转（见下面
 *    `agent()` 的注释与那条负向断言）。
 */

/**
 * 一个 agent。**只有真实存在的字段**。
 *
 * ⚠️ 这里原来还接受 `reviewerAgentId` / `allowedActions` / `actionParams`
 *    （以及一个只存在于夹具里的 `legacyActions`）——它们现在都不是 `Agent` 上的
 *    字段了。留着那份夹具的话，这一套测试会继续"验证"一条已经不存在的读取路径，
 *    而**没有任何东西会报错**（web 的测试文件不经类型检查，见 `tsconfig.test.json`
 *    继承下来的 `exclude`）。所以夹具跟着字段一起收。
 *
 * ⚠️ 这也意味着：本文件里凡是要"某个人有一份审核者/动作配置"的地方，都必须造一个
 *    **组**才能表达（`group()`）。这不是麻烦，它正是这次改动的意义——那份配置
 *    本来就只属于组。
 */
function agent(input: { id: string; name?: string; role?: AgentRole }): Agent {
  return {
    id: input.id,
    name: input.name ?? input.id,
    instructions: '',
    workDir: null,
    skillIds: [],
    model: null,
    runtimeKey: 'claude',
    role: input.role ?? 'executor',
    reviewStandard: null,
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

/**
 * 一份组给链的默认（`GroupChainDefaults`）。
 *
 * ⚠️ `members` 是**完整成员对象**（界面上来自 groups store 的 `memberAgents`，含私有，
 *    不是被过滤的全局 `$agents`）：`resolveNewTaskChain` 的 `byId` 在候选池之后回退到
 *    它，私有成员因此解析得出来。
 */
function group(input: {
  members: readonly Agent[]
  reviewerId: string | null
  allowedActions?: readonly string[]
  actionParams?: Record<string, Record<string, unknown>>
  maxReworks?: number | null
}): GroupChainDefaults {
  return {
    members: input.members,
    reviewerId: input.reviewerId,
    allowedActions: input.allowedActions ?? [],
    actionParams: input.actionParams ?? {},
    // ⚠️ 不能写 `input.maxReworks ?? 0`：`null` 在这里是一个**有意义的值**
    //    （"无限返工"），`??` 会把它折成 0，于是"组默认是无限"这一档永远测不到
    //    （踩过一次：测出来的是"省略写成 0"）。
    maxReworks: input.maxReworks === undefined ? 0 : input.maxReworks,
  }
}

/**
 * ② 上的三档。
 *
 * ⚠️ 第一档原来叫 `follow`（"跟随**执行者**的长期安排"）。那个设置撤掉之后它改名
 *    成 `default`（**不点名**：有组就由组决定谁审）——名字换掉是必须的，
 *    `follow` 会让人以为还有一份"长期配置"可跟随。
 */
const DEFAULT: ReviewerChoice = { mode: 'default' }
const NONE: ReviewerChoice = { mode: 'none' }
const pick = (agentId: string): ReviewerChoice => ({ mode: 'pick', agentId })

/** 一份最小的世界：执行者 + 审核者 + 一个提供两个动作的工具包。 */
const R = agent({ id: 'r1', name: '审核员', role: 'reviewer' })
const E = agent({ id: 'e1', name: '助手', role: 'executor' })
const TOOL = tool('probe-tool', [
  { name: 'append-note', summary: '把一句话追加到 NOTES.md' },
  { name: 'say', summary: '打个招呼' },
])

/** ★ 普通组：E 执行、R 审、允许一个动作。链的默认全从这里取。 */
const G = group({
  members: [E, R],
  reviewerId: 'r1',
  allowedActions: ['probe-tool.append-note'],
})

describe('★ agent 身上已经没有任何"审核者/动作"的字段（负向保护）', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 为什么先钉这一条：它是**夹具与现实是否一致**的判据
   * ══════════════════════════════════════════════════════════════════
   *
   * 这一整个文件的价值取决于"夹具长得像真的记录"。夹具是**手写**的，所以它可以
   * 悄悄带上一两个已经不存在的字段，然后让下面几百行判据去测一条**服务端永远不
   * 会再返回**的读取路径——而且不会有任何东西报错（web 的 `.test.ts` 不经类型检查：
   * `apps/web/tsconfig.test.json` 继承了主配置里那条排除测试的 `exclude`，
   * 而 `svelte-check` 只报应用代码的错）。
   *
   * 所以这里显式挡住那四个键：它们从 `Agent` 上撤掉了（谁审在**组**上、允许动什么
   * 也在**组**上），本文件里任何一处都不许再靠它们表达配置。
   */
  test('★★ 夹具不带那四个键（带了就是在测一条不存在的路径）', () => {
    for (const key of ['reviewerAgentId', 'allowedActions', 'actionParams', 'debugActions']) {
      assert.equal(key in E, false, `★ 执行者夹具不该有 ${key}`)
      assert.equal(key in R, false, `★ 审核者夹具不该有 ${key}`)
    }
  })
})

describe('② 不点名：有组 ⇒ 组的审核者；没组 ⇒ 这条任务没有审核者', () => {
  test('★ 有组 ⇒ 组的审核者，来源 `group`，动作取组的', () => {
    const chain = resolveNewTaskChain({
      executor: E,
      choice: DEFAULT,
      agents: [E, R],
      tools: [TOOL],
      group: G,
    })
    assert.equal(chain.reviewer?.id, 'r1')
    assert.equal(chain.reviewerSource, 'group')
    assert.equal(chain.notReviewing, null, '不点名且组里有审核者 ⇒ 会审')
    assert.deepEqual(chain.actions, ['probe-tool.append-note'])
    assert.deepEqual(chain.unavailableActions, [])
  })

  test('★★ 没有组 ⇒ `not_configured`：**选单个智能体那条路上谁也不审**', () => {
    const chain = resolveNewTaskChain({ executor: E, choice: DEFAULT, agents: [E, R], tools: [TOOL] })
    assert.equal(chain.reviewer, null)
    assert.equal(chain.notReviewing, 'not_configured')
    // ⚠️ 这一档不是错误，但它是**必然结果**（不是"某人少配了一样东西"）：
    //    2026-10 之后"谁审"只有组能回答，而这一页选的是一条**没有组的**链。
    //    新建任务的摘要据此**必须把这句话说出来**（`newtask.summaryReviewerAgentPath`）
    //    —— 不画那一行的话，使用者看到的摘要与选组那条只差一行，而那一行恰恰是
    //    "你的产出不会有人看"，且跑完之前没有任何地方会报错。
    assert.deepEqual(chain.actions, [], '没有审核者就没有判决、也就没有动作可显示')
    assert.deepEqual(chain.unavailableActions, [])
  })

  test('组里没有审核者（`reviewerId` 是 null）⇒ 同 `not_configured`', () => {
    const chain = resolveNewTaskChain({
      executor: E,
      choice: DEFAULT,
      agents: [E, R],
      tools: [TOOL],
      group: group({ members: [E], reviewerId: null }),
    })
    assert.equal(chain.reviewer, null)
    assert.equal(chain.notReviewing, 'not_configured')
  })

  test('★ 组的审核者已被删除 ⇒ `dangling`（**不静默退回"没配"**）', () => {
    // 成员被删的表现：`reviewerId` 还在，但 `members` 里已经没有它了。
    const chain = resolveNewTaskChain({
      executor: E,
      choice: DEFAULT,
      agents: [E],
      tools: [TOOL],
      group: group({ members: [E], reviewerId: 'r1' }),
    })
    assert.equal(chain.reviewer, null, 'dangling 时 reviewer 必须是 null')
    assert.equal(chain.notReviewing, 'dangling')
    // 与 `not_configured` 分开的理由：两句话的**下一步不一样**——一条是"这个组没人审"，
    // 一条是"组里那个人没了，去补一个"。合成一条就会漏掉后者。
    assert.notEqual(chain.notReviewing, 'not_configured')
  })

  test('连执行者都没有（一个执行角色的 agent 都没建）⇒ 同 `not_configured`，不炸', () => {
    const chain = resolveNewTaskChain({
      executor: null,
      choice: DEFAULT,
      agents: [R],
      tools: [TOOL],
      group: G,
    })
    assert.equal(chain.reviewer?.id, 'r1', '没有执行者不影响"组的审核者是谁"')
    const bare = resolveNewTaskChain({ executor: null, choice: DEFAULT, agents: [R], tools: [TOOL] })
    assert.equal(bare.reviewer, null)
    assert.equal(bare.notReviewing, 'not_configured')
  })
})

describe('②：这一次换个人审（覆盖只对这一次生效）', () => {
  test('★ 点了某个人 ⇒ 来源 `override`，审核者是那个人，而动作基准仍是**组的**', () => {
    const other = agent({ id: 'r2', name: '安全审核员', role: 'reviewer' })
    const chain = resolveNewTaskChain({
      executor: E,
      choice: pick('r2'),
      agents: [E, R, other],
      tools: [TOOL],
      group: G,
    })
    assert.equal(chain.reviewer?.id, 'r2')
    assert.equal(chain.reviewerSource, 'override')
    assert.equal(chain.notReviewing, null)
    // ★ 动作**不跟着人走**：白名单与"谁审"是两个字段，权限住在组上。
    //   显示成"r2 个人的权限"会让使用者以为换人会换掉这次能动的范围。
    assert.deepEqual(chain.actions, ['probe-tool.append-note'])
  })

  test('★ 点了某个人、但没有组 ⇒ 审核者是那个人，动作是**空的**', () => {
    const other = agent({ id: 'r2', name: '安全审核员', role: 'reviewer' })
    const chain = resolveNewTaskChain({
      executor: E,
      choice: pick('r2'),
      agents: [E, R, other],
      tools: [TOOL],
    })
    assert.equal(chain.reviewer?.id, 'r2')
    assert.equal(chain.notReviewing, null, '有人审 ⇒ 会审')
    // 动作只有一个出处（组）⇒ 这条链一个动作都不许触发：判决只能给结论。
    assert.deepEqual(chain.actions, [])
    assert.deepEqual(chain.actionParams, {})
  })

  test('★ 点的人已经被删掉 ⇒ `dangling`（不回退到"组里那个"，也不回退到"没配"）', () => {
    const chain = resolveNewTaskChain({
      executor: E,
      choice: pick('gone'),
      agents: [E, R],
      tools: [TOOL],
      group: G,
    })
    assert.equal(chain.reviewer, null)
    assert.equal(chain.notReviewing, 'dangling')
    assert.equal(chain.reviewerSource, 'override', '走的路仍然"这一次点名"——这正是要重选的那个选择')
  })
})

describe('②：这一次不自动审核', () => {
  test('★ 明确选"不审" ⇒ `explicit_none`，**即使组里配了审核者**（覆盖掉它）', () => {
    const chain = resolveNewTaskChain({
      executor: E,
      choice: NONE,
      agents: [E, R],
      tools: [TOOL],
      group: G,
    })
    assert.equal(chain.reviewer, null)
    assert.equal(chain.reviewerSource, 'none')
    assert.equal(chain.notReviewing, 'explicit_none')
    assert.deepEqual(chain.actions, [], '不会审 ⇒ 没有判决 ⇒ 没有动作')
  })

  test('★ 同一份世界、"不点名"与"不审"必须推出**不同**的结果', () => {
    // 这一条防的是"两种模式被推成同一个东西"（把 none 也当成 default）。
    // ⚠️ 两者在**行为上**现在是一样的（都不会有人审），但记录与日志不同：
    //    不点名是"你没选组"（缺这个键），不审是"你选的"（`reviewerAgentId: null`）。
    //    推成同一个东西 ⇒ 使用者选的选项看起来没生效，而库里那条记录说的也不是
    //    他做的事。所以判据落在**请求体**上（见下面 `reviewerRunField` 那一组）。
    const world = { executor: E, agents: [E, R], tools: [TOOL], group: G }
    const d = resolveNewTaskChain({ ...world, choice: DEFAULT })
    const none = resolveNewTaskChain({ ...world, choice: NONE })
    assert.equal(d.notReviewing, null, '组里有人审 ⇒ 不点名就是会审')
    assert.equal(none.notReviewing, 'explicit_none')
    assert.notDeepEqual(d.actions, none.actions)
    assert.notDeepEqual(reviewerRunField(DEFAULT), reviewerRunField(NONE))
  })

  test('没有组时"不点名"与"明确不审"推出**同一个** notReviewing（都是没人审）', () => {
    // ★ 这正是上面那条负向保护的边界：能区分的只有请求体（省略 / null），
    //   而 score 上两者都是"没有审核结论"。界面要靠**请求体**说清是谁的决定。
    const world = { executor: E, agents: [E, R], tools: [TOOL] }
    const d = resolveNewTaskChain({ ...world, choice: DEFAULT })
    const none = resolveNewTaskChain({ ...world, choice: NONE })
    assert.equal(d.notReviewing, 'not_configured')
    assert.equal(none.notReviewing, 'explicit_none')
  })
})

describe('③：动作那一栏的两拨（唯一出处 = 组）', () => {
  test('★ 组配过、但提供它的包被卸载了 ⇒ 进 `unavailableActions`（不静默丢掉）', () => {
    const chain = resolveNewTaskChain({
      executor: E,
      choice: DEFAULT,
      agents: [E, R],
      tools: [],
      group: G,
    })
    assert.deepEqual(chain.actions, [])
    assert.deepEqual(
      chain.unavailableActions,
      ['probe-tool.append-note'],
      '它依然是**配过的**：丢掉等于使用者没同意就改了权限',
    )
  })

  test('★★ 没有组 ⇒ 两拨都空（动作不再有"某个人身上那份"这个来源）', () => {
    // ⚠️ 这一条原来钉的是"老数据回退"：动作白名单最早写在审核标准里，后来搬到
    //    `Agent.allowedActions`，界面按"自己的为空就回退到标准里那份"显示。
    //    那两个字段都撤掉了（唯一权威是组），所以判据反过来：**没有组就没有动作**
    //    ——而不是"回退到某个人的那份"。
    const chain = resolveNewTaskChain({ executor: E, choice: DEFAULT, agents: [E, R], tools: [TOOL] })
    assert.deepEqual(chain.actions, [])
    assert.deepEqual(chain.unavailableActions, [])
  })

  test('组一个动作都没配 ⇒ 两拨都是空的（界面据此说"判决只会给结论"）', () => {
    const chain = resolveNewTaskChain({
      executor: E,
      choice: DEFAULT,
      agents: [E, R],
      tools: [TOOL],
      group: group({ members: [E, R], reviewerId: 'r1', allowedActions: [] }),
    })
    assert.deepEqual(chain.actions, [])
    assert.deepEqual(chain.unavailableActions, [])
    assert.notEqual(chain.reviewer, null, '⚠️ "没有动作"与"没有审核者"是两件事，界面也分开说')
  })

  test('顺序按组配的那一份（显示时不替他重排）', () => {
    const chain = resolveNewTaskChain({
      executor: E,
      choice: DEFAULT,
      agents: [E, R],
      tools: [TOOL],
      group: group({
        members: [E, R],
        reviewerId: 'r1',
        allowedActions: ['probe-tool.say', 'probe-tool.append-note'],
      }),
    })
    assert.deepEqual(chain.actions, ['probe-tool.say', 'probe-tool.append-note'])
  })

  test('解析不出来与解析得出来可以同时在：一拨一条，各自成组', () => {
    const chain = resolveNewTaskChain({
      executor: E,
      choice: DEFAULT,
      agents: [E, R],
      tools: [TOOL],
      group: group({
        members: [E, R],
        reviewerId: 'r1',
        // `comment.create` 是内置动作时代的名字（早已整组移除）＝"历史值"。
        allowedActions: ['comment.create', 'probe-tool.say'],
      }),
    })
    assert.deepEqual(chain.actions, ['probe-tool.say'])
    assert.deepEqual(chain.unavailableActions, ['comment.create'])
  })
})

describe('★ 请求体里的那个 key：省略 ≠ null ≠ id', () => {
  test('★ `default`（不点名）⇒ key **根本不出现**（不是 null，也不是解析出来的那个 id）', () => {
    const field = reviewerRunField(DEFAULT)
    assert.deepEqual(field, {})
    assert.equal('reviewerAgentId' in field, false)
    // 真正发出去的是 JSON：这一条比对象比较更贴近事实
    assert.equal(JSON.stringify(field), '{}')
    // ⚠️ 也不能写成"把不点名解析出来的那个人传过去"（组模式下它是非空的，见
    //    `chain.reviewer`）：那会把组的默认**冻结**成这条任务的一次性覆盖。
    assert.equal('reviewerAgentId' in reviewerRunField(DEFAULT), false)
  })

  test('★ `none` ⇒ `reviewerAgentId: null`（key 在，值是 null——"这一次不审"是一条记录）', () => {
    assert.equal(JSON.stringify(reviewerRunField(NONE)), '{"reviewerAgentId":null}')
  })

  test('★ `pick` ⇒ 带那个 id（这一次点名，不改组的默认）', () => {
    assert.equal(JSON.stringify(reviewerRunField(pick('r2'))), '{"reviewerAgentId":"r2"}')
  })

  test('★ 点的人已经不见了 ⇒ **照样**把那个 id 发出去（让服务端回原文，不在本地改主意）', () => {
    // 本地改成"不点名"或 null 等于替使用者做了一个他没做过的决定；而服务端那条
    // `reviewer_not_found` 的原文是页面照原样显示的那句话（`error = err.message`）。
    assert.equal(JSON.stringify(reviewerRunField(pick('gone'))), '{"reviewerAgentId":"gone"}')
  })
})

describe('③：勾选与"组当前那份"比什么', () => {
  /** 一份组：E 执行、R 审、白名单就是传进来的那一份。 */
  function world(allowedActions: string[], tools: Tool[] = [TOOL]) {
    return resolveNewTaskChain({
      executor: E,
      choice: DEFAULT,
      agents: [E, R],
      tools,
      group: group({ members: [E, R], reviewerId: 'r1', allowedActions }),
    })
  }

  test('★ 默认勾的就是组当前那份（`available` 那一份，顺序照配的）', () => {
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
    const chain = resolveNewTaskChain({ executor: E, choice: NONE, agents: [E, R], tools: [TOOL], group: G })
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
  const chain = resolveNewTaskChain({
    executor: E,
    choice: DEFAULT,
    agents: [E, R],
    tools: [TOOL],
    group: group({
      members: [E, R],
      reviewerId: 'r1',
      allowedActions: ['probe-tool.say', 'probe-tool.append-note'],
    }),
  })

  test('★ 一致（含"顺序不同"）⇒ `{}`：key 根本不出现 ⇒ 以后组页给它加动作，这条路上照样跟着变', () => {
    const field = actionsRunField(['probe-tool.append-note', 'probe-tool.say'], chain)
    assert.deepEqual(field, {})
    assert.equal('allowedActions' in field, false)
    // 真正发出去的是 JSON：这一条比对象比较更贴近事实（`undefined` 与"没有这个键"
    // 序列化之后一样，但这里要钉的是**意图**）。
    assert.equal(JSON.stringify(field), '{}')
    // ⚠️ 也不能写成"把当前解析出来的那份传过去"：那会把组的默认冻成一次覆盖。
    assert.equal('allowedActions' in actionsRunField(chain.actions, chain), false)
  })

  test('★ 改了（少勾一个）⇒ 带上那份（覆盖只影响这一条 run）', () => {
    assert.equal(
      JSON.stringify(actionsRunField(['probe-tool.say'], chain)),
      '{"allowedActions":["probe-tool.say"]}',
    )
  })

  test('★ 改了（多勾一个不在组权限里的）⇒ 也带上那份', () => {
    // 覆盖的意义就在这里：勾选框列的是**已装工具包**的全部动作（服务端按这个校验），
    // 而组的默认里可能没有它——这一条任务想用，就得把完整那一份发出去。
    const one = resolveNewTaskChain({
      executor: E,
      choice: DEFAULT,
      agents: [E, R],
      tools: [TOOL],
      group: group({ members: [E, R], reviewerId: 'r1', allowedActions: ['probe-tool.say'] }),
    })
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
    // 省略它 = 用组的默认 ⇒ 判决照样能触发那两个动作。使用者在这里收的紧会**静默
    // 失效**，而那条产出看起来正常结束——这正是这一条要钉住的东西。
    assert.notEqual(JSON.stringify(field), '{}')
  })

  test('★ 组本来就没有动作 + 也没勾 ⇒ 省略（这一档的"不勾"与"它本来空"是一回事）', () => {
    const empty = resolveNewTaskChain({
      executor: E,
      choice: DEFAULT,
      agents: [E, R],
      tools: [TOOL],
      group: group({ members: [E, R], reviewerId: 'r1', allowedActions: [] }),
    })
    assert.deepEqual(empty.actions, [])
    assert.deepEqual(actionsRunField([], empty), {})
  })

  test('★ 组本来空 + 勾了一个 ⇒ 带上那一个（否则勾了等于没勾）', () => {
    const empty = resolveNewTaskChain({
      executor: E,
      choice: DEFAULT,
      agents: [E, R],
      tools: [TOOL],
      group: group({ members: [E, R], reviewerId: 'r1', allowedActions: [] }),
    })
    assert.equal(
      JSON.stringify(actionsRunField(['probe-tool.say'], empty)),
      '{"allowedActions":["probe-tool.say"]}',
    )
  })

  test('★ 点的那个人已经不见了：动作取不到 ⇒ 空勾 = 省略；勾了动作才带（由服务端说"没有审核者"）', () => {
    // ② 点了一个已经被删掉的人（`dangling`）：`reviewer` 是 null、`actions` 是空，
    // 所以"什么都没勾"与"当前那份"一致 ⇒ 省略。
    const gone = resolveNewTaskChain({ executor: E, choice: pick('gone'), agents: [E, R], tools: [TOOL] })
    assert.equal(gone.reviewer, null)
    assert.deepEqual(actionsRunField([], gone), {})
    // 而万一带着动作过来（页面上不可达，但函数不该在这里自作聪明地清空它）：
    // 照样发出去，让 daemon 回 `allowed_actions_without_reviewer` 的原文。
    assert.deepEqual(actionsRunField(['probe-tool.say'], gone), {
      allowedActions: ['probe-tool.say'],
    })
  })

  test('组里没有审核者（不点名 ⇒ 没人审）⇒ 同样是省略（没有覆盖可谈）', () => {
    const bare = resolveNewTaskChain({
      executor: E,
      choice: DEFAULT,
      agents: [E, R],
      tools: [TOOL],
      group: group({ members: [E], reviewerId: null }),
    })
    assert.equal(bare.notReviewing, 'not_configured')
    assert.deepEqual(actionsRunField([], bare), {})
  })
})

describe('③ 的固定参数（D43）：与白名单同一套"省略 = 跟随"判据', () => {
  /** 一份组：允许一个动作，并（可选地）钉一份固定参数。 */
  function world(params: Record<string, Record<string, unknown>>, tools: Tool[] = [TOOL]) {
    return resolveNewTaskChain({
      executor: E,
      choice: DEFAULT,
      agents: [E, R],
      tools,
      group: group({
        members: [E, R],
        reviewerId: 'r1',
        allowedActions: ['probe-tool.append-note'],
        actionParams: params,
      }),
    })
  }

  test('★ 表单默认值就是组配的那份（`defaultActionParams` 原样带出，不做任何修剪）', () => {
    const chain = world({ 'probe-tool.append-note': { text: '组里钉的', dir: '/x' } })
    assert.deepEqual(defaultActionParams(chain), {
      'probe-tool.append-note': { text: '组里钉的', dir: '/x' },
    })
  })

  test('组没设 ⇒ 默认值是 `{}`（表单里那一档空着）', () => {
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

  test('★ 没改 ⇒ `actionParams` 这个 key 根本不出现（省略 = 用组配的那份）', () => {
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

  test('★★ 这一次**什么都不固定** ⇒ 发 `{}`，**不是**省略（顶掉组配的那份，放开给模型填）', () => {
    const chain = world({ 'probe-tool.append-note': { text: '组里钉的' } })
    const field = paramsRunField({}, chain)
    assert.equal('actionParams' in field, true)
    assert.equal(JSON.stringify(field), '{"actionParams":{}}')
    // 省略它 = 用组的默认 ⇒ 模型**不许**写 text（已固定）。使用者在这里想放开，省略会
    // 让"放开"静默失效——这正是这一条要钉住的东西。
    assert.notEqual(JSON.stringify(field), '{}')
  })

  test('★ 组本来没设 + 表单也没动 ⇒ 省略；动了才带（组的默认不冻成覆盖）', () => {
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
    for (const choice of [DEFAULT, NONE, pick('r1'), pick('default')] as ReviewerChoice[]) {
      assert.deepEqual(reviewerChoiceOf(toReviewerPick(choice)), choice)
    }
  })

  test('agent id 恰好叫 `default` 也不会与"不点名"撞上（这就是要加前缀的原因）', () => {
    assert.notEqual(toReviewerPick(pick('default')), toReviewerPick(DEFAULT))
  })

  test('认不出来的值当"不点名"（一个都不指定：不凭空多出一个审核者）', () => {
    assert.deepEqual(reviewerChoiceOf(''), DEFAULT)
    assert.deepEqual(reviewerChoiceOf('pick:'), DEFAULT)
    assert.deepEqual(reviewerChoiceOf('什么鬼'), DEFAULT)
  })
})

// ══════════════════════════════════════════════════════════════════════
// D70：智能体组——链的默认从组取，覆盖照旧只对这一次生效
// ══════════════════════════════════════════════════════════════════════
//
// 2026-10 之后这一节描述的不再是"另一条路径"，而是**唯一**那条：链的默认
// （谁审 / 允许动什么 / 固定参数 / 返工）全部来自组。这里守的是"来源换对了，
// 而省略语义没跟着坏"：
//
//   · 不点名 ⇒ 审核者是组的审核者；
//   · ③ 的比较基准是**组的**行动权限——"没改"就省略 key，daemon 才会用组的默认；
//   · 返工默认是组的 `maxReworks`，"从组默认改到 0"是明确的收紧、必须发出去。

const G_EXEC = agent({ id: 'g-exec', name: '组执行者', role: 'executor' })
const G_REV = agent({ id: 'g-rev', name: '组审核者', role: 'reviewer' })
// 一个**执行者**，身上没有任何审核配置（2026-10 起那种配置不存在了）——
// 用来证明组模式下"谁审"跟这个执行者毫无关系。
const E2 = agent({ id: 'e2', name: '老执行者', role: 'executor' })

const GROUP = group({
  members: [G_EXEC, G_REV],
  reviewerId: 'g-rev',
  allowedActions: ['probe-tool.append-note'],
  actionParams: { 'probe-tool.append-note': { note: '固定' } },
  maxReworks: 2,
})

// ★ 私有一对：**不在** `agents` 候选池里（全局列表被服务端过滤了私有），
// 但组数据带着它们——链必须照样解析（不点名 → 私有审核者）。
const PRIV_EXEC = agent({ id: 'p-exec', name: '私有执行者', role: 'executor' })
const PRIV_REV = agent({ id: 'p-rev', name: '私有审核者', role: 'reviewer' })
const PRIV_GROUP = group({
  members: [PRIV_EXEC, PRIV_REV],
  reviewerId: 'p-rev',
  allowedActions: ['probe-tool.append-note'],
})

describe('D70 组模式：链的默认从组取', () => {
  test('★ 不点名 ⇒ 审核者是组的审核者，动作/参数/返工都是组的', () => {
    const chain = resolveNewTaskChain({
      executor: G_EXEC,
      choice: DEFAULT,
      agents: [G_EXEC, G_REV, R],
      tools: [TOOL],
      group: GROUP,
    })
    assert.equal(chain.reviewer?.id, 'g-rev')
    assert.equal(chain.reviewerSource, 'group')
    assert.equal(chain.notReviewing, null)
    assert.deepEqual(chain.actions, ['probe-tool.append-note'])
    assert.deepEqual(chain.actionParams, { 'probe-tool.append-note': { note: '固定' } })
    assert.equal(chain.maxReworks, 2)
  })

  test('★ "谁审"只由组回答：执行者身上没有任何审核配置可读（也不该去读）', () => {
    const chain = resolveNewTaskChain({
      executor: E2,
      choice: DEFAULT,
      agents: [E2, G_EXEC, G_REV, R],
      tools: [TOOL],
      group: GROUP,
    })
    // E2 是个普通执行者；组模式下不点名 ⇒ 审核者是组的 g-rev。
    assert.equal(chain.reviewer?.id, 'g-rev')
    assert.equal('reviewerAgentId' in E2, false, '★ 执行者身上已经没有这个字段（撤掉了）')
  })

  test('组模式下「这一次点名」⇒ 审核者换成那个人，但动作默认仍是组的（覆盖只换审核）', () => {
    const chain = resolveNewTaskChain({
      executor: G_EXEC,
      choice: pick('r1'),
      agents: [G_EXEC, G_REV, R],
      tools: [TOOL],
      group: GROUP,
    })
    assert.equal(chain.reviewer?.id, 'r1')
    assert.equal(chain.reviewerSource, 'override')
    // ③ 的基准仍是组的行动权限（不是 r1 个人那份——那种东西已经不存在了）
    // daemon 在 `groupId` 展开时只用"省略"的字段填组的默认，而动作白名单与审核者
    // 是两个字段。
    assert.deepEqual(chain.actions, ['probe-tool.append-note'])
  })

  test('组模式下「这一次不审」⇒ explicit_none，即使组配了审核者', () => {
    const chain = resolveNewTaskChain({
      executor: G_EXEC,
      choice: NONE,
      agents: [G_EXEC, G_REV],
      tools: [TOOL],
      group: GROUP,
    })
    assert.equal(chain.notReviewing, 'explicit_none')
    assert.equal(chain.reviewer, null)
    assert.deepEqual(chain.actions, [])
  })

  test('组的审核者已被删除 ⇒ `dangling`（不静默退回"没配"）', () => {
    // ★ 成员被删的表现：`reviewerId` 还在，但 `members` 里已经没有它了。
    const chain = resolveNewTaskChain({
      executor: G_EXEC,
      choice: DEFAULT,
      agents: [G_EXEC],
      tools: [TOOL],
      group: group({ members: [G_EXEC], reviewerId: 'g-rev', allowedActions: ['probe-tool.append-note'] }),
    })
    assert.equal(chain.notReviewing, 'dangling')
  })

  test('★ 私有一对（不在全局候选池里）：不点名 ⇒ 私有审核者解析得出来', () => {
    const chain = resolveNewTaskChain({
      executor: PRIV_EXEC,
      choice: DEFAULT,
      // ⚠️ 候选池是全局池——私有成员**不在里面**，只靠 `group.members` 回退。
      agents: [R],
      tools: [TOOL],
      group: PRIV_GROUP,
    })
    assert.equal(chain.reviewer?.id, 'p-rev')
    assert.equal(chain.reviewer?.name, '私有审核者', '显示用的名字要从组数据里拿到')
    assert.equal(chain.reviewerSource, 'group')
  })

  test('组模式 + 审核者换人时，「不点名」那条链仍然只跟组', () => {
    const followChain = resolveNewTaskChain({
      executor: G_EXEC,
      choice: DEFAULT,
      agents: [G_EXEC, G_REV, R],
      tools: [TOOL],
      group: GROUP,
    })
    assert.equal(followChain.reviewer?.id, 'g-rev')
  })
})

describe('D70：组的执行者解析', () => {
  test('成员里 role 是 executor 的那个（第二轮起直接从成员对象找）', () => {
    assert.equal(groupExecutor(GROUP.members)?.id, 'g-exec')
  })

  test('★ 私有执行者：在组数据里、不在全局池里，照样解析得到', () => {
    assert.equal(groupExecutor(PRIV_GROUP.members)?.id, 'p-exec')
  })

  test('成员被删（找不到执行者）⇒ null（提交前那一页要先把话说在前头）', () => {
    assert.equal(groupExecutor([G_REV]), null)
  })
})

describe('D70 组模式：③ 的比较基准是组的，返工默认是组的', () => {
  const world = (grp: GroupChainDefaults = GROUP) =>
    resolveNewTaskChain({
      executor: G_EXEC,
      choice: DEFAULT,
      agents: [G_EXEC, G_REV],
      tools: [TOOL],
      group: grp,
    })

  test('★ 勾选 == 组的行动权限 ⇒ 省略 key（用组的默认）', () => {
    // 勾了组的（append-note）⇒ 算"没改"，于是请求体里不出现 `allowedActions`。
    assert.deepEqual(actionsRunField(['probe-tool.append-note'], world()), {})
  })

  test('★ 勾选 ≠ 组的行动权限 ⇒ 带上（这一次覆盖组的默认）', () => {
    assert.deepEqual(actionsRunField(['probe-tool.say'], world()), {
      allowedActions: ['probe-tool.say'],
    })
  })

  test('★ 返工 == 组的默认 ⇒ 省略（用组的默认）；组默认是 2、下拉是 0 ⇒ 发 0（明确收紧）', () => {
    const chain = world()
    assert.deepEqual(reworkRunField(2, chain), {})
    assert.deepEqual(reworkRunField(3, chain), { maxReworks: 3 })
    assert.deepEqual(reworkRunField(0, chain), { maxReworks: 0 })
  })

  test('★ 组默认是「无限」（null）：没改 ⇒ 省略；改成有限/0 ⇒ 发出去（明确收紧）', () => {
    const chain = world(group({ ...GROUP, maxReworks: null }))
    // UI 哨兵 -1 = 无限；与组默认 null 相等 ⇒ 用组的默认、省略。
    assert.deepEqual(reworkRunField(-1, chain), {})
    assert.deepEqual(reworkRunField(5, chain), { maxReworks: 5 })
    assert.deepEqual(reworkRunField(0, chain), { maxReworks: 0 })
  })

  test('★ 没有组：`maxReworks` 这个键整个不出现（daemon 对省略的默认是 0），>0 才带', () => {
    const chain = resolveNewTaskChain({
      executor: E,
      choice: DEFAULT,
      agents: [E, R],
      tools: [TOOL],
    })
    assert.equal('maxReworks' in chain, false, '没有组就没有"组默认"这回事')
    assert.deepEqual(reworkRunField(0, chain), {})
    assert.deepEqual(reworkRunField(2, chain), { maxReworks: 2 })
  })

  test('★ 没有组也要能表达「无限返工」：-1 ⇒ 发 null（不能因为"没有组默认"就吞掉）', () => {
    const chain = resolveNewTaskChain({
      executor: E,
      choice: DEFAULT,
      agents: [E, R],
      tools: [TOOL],
    })
    assert.deepEqual(reworkRunField(-1, chain), { maxReworks: null })
  })
})