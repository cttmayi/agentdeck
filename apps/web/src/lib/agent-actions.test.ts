import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import type { Tool } from './api.ts'
import {
  allowedActionsFromLegacyStandard,
  describeActionPicks,
  describeAllowedActions,
  effectiveAllowedActions,
  splitAllowedActions,
} from './agent-actions.ts'

/**
 * 行动权限的显示逻辑（D40 收口、D41 收窄）。
 *
 * 这里守的主要是**老数据的回退**：动作权限从审核标准搬到 agent 上之后，老工作区
 * 里那份配置还在 `reviewStandard.allowedActions` 上。回退规则写错（或者哪天被
 * "简化"掉）的表现是**使用者以为自己配过的动作没了**——那是这次搬家最容易出的
 * 一类错，而且不会报任何错。
 *
 * ══════════════════════════════════════════════════════════════════
 * D41：内置动作整组移除之后，这里多了两条**否定**的判断
 * ══════════════════════════════════════════════════════════════════
 *
 * 这个文件原来还守着 `BUILTIN_ACTIONS`（那六个裸名）与 `DEFAULT_ALLOWED_ACTIONS`
 * （表单预勾 `comment.create`）。使用者把内置动作全部移除之后，那两样东西本身
 * 不存在了，所以守的东西跟着变：**默认是空**、显示逻辑**只认工具动作**
 * （`<包 slug>.<动作名>`）。这两条都是"现在是什么"，不是放宽。
 */

function agent(
  allowedActions: string[] | undefined,
  standardActions: string[] | undefined,
): {
  allowedActions?: string[] | undefined
  reviewStandard: { allowedActions?: string[] | undefined } | null
} {
  return {
    ...(allowedActions === undefined ? {} : { allowedActions }),
    reviewStandard: standardActions === undefined ? null : { allowedActions: standardActions },
  }
}

describe('★ 有效行动权限：新字段优先，空则回退老字段', () => {
  test('新字段有值 ⇒ 用它（老字段里剩下的那份不算数）', () => {
    assert.deepEqual(
      effectiveAllowedActions(agent(['probe-tool.clean-notes'], ['probe-tool.append-note'])),
      ['probe-tool.clean-notes'],
    )
  })

  test('★ 新字段为空、老字段有值 ⇒ 回退到老字段（否则使用者以为配置丢了）', () => {
    assert.deepEqual(
      effectiveAllowedActions(
        agent([], ['probe-tool.append-note', 'probe-tool.clean-notes']),
      ),
      ['probe-tool.append-note', 'probe-tool.clean-notes'],
    )
  })

  test('新字段**根本不存在**（老记录里没有这个键）与空数组同义', () => {
    assert.deepEqual(effectiveAllowedActions(agent(undefined, ['probe-tool.append-note'])), [
      'probe-tool.append-note',
    ])
  })

  test('两边都没有（含整条标准为 null）⇒ 空数组，不是 undefined', () => {
    assert.deepEqual(effectiveAllowedActions(agent(undefined, undefined)), [])
    assert.deepEqual(effectiveAllowedActions(agent([], [])), [])
  })

  test('返回的是副本：界面改草稿不会写回传进来的对象', () => {
    const source = agent([], ['probe-tool.append-note'])
    effectiveAllowedActions(source).push('probe-tool.clean-notes')
    assert.deepEqual(source.reviewStandard?.allowedActions, ['probe-tool.append-note'])
  })
})

describe('回退来源：界面据此说"它来自老配置"', () => {
  test('★ 只有"新字段空 + 老字段有"才算回退', () => {
    assert.equal(allowedActionsFromLegacyStandard(agent([], ['probe-tool.append-note'])), true)
    assert.equal(
      allowedActionsFromLegacyStandard(agent(['probe-tool.clean-notes'], ['probe-tool.append-note'])),
      false,
    )
    assert.equal(allowedActionsFromLegacyStandard(agent([], [])), false)
    assert.equal(allowedActionsFromLegacyStandard(agent(undefined, undefined)), false)
  })
})

describe('★ 编辑态的初值：老数据那份权限不能被"打开编辑再保存"清空', () => {
  /**
   * 这一条守的是一个**具体的丢失场景**（不是假想的）：老工作区里动作权限写在
   * `reviewStandard.allowedActions` 上，`Agent.allowedActions` 是空的。如果编辑态
   * 的初值取"空数组"，使用者**什么都没改**、按一下保存，就会把那份权限写空——
   * 那是这个字段最容易出的一类错，而且不报任何错。
   *
   * ⚠️ 判据读的是**组件源码**：`apps/web` 没有组件级测试的跑法（Svelte 组件在
   *    node 里渲不出来），而这条回归的后果又足够贵，所以把"初值必须走有效值"
   *    钉在文本上——它比"我记得我这么写了"结实，红的时候还直接指到那一行。
   *    （浏览器那一侧量的是**另一个**事实：只读态显示的就是接口回的那份有效值。）
   */
  test('★ `AgentDetail.svelte` 的草稿初值取 `effectiveAllowedActions(agent)`', () => {
    const src = readFileSync(new URL('../components/AgentDetail.svelte', import.meta.url), 'utf8')
    assert.match(
      src,
      /allowedActions: effectiveAllowedActions\(agent\)/,
      '编辑态初值必须走**有效值**（含 reviewStandard.allowedActions 的回退）',
    )
    assert.doesNotMatch(
      src,
      /allowedActions: \[\]/,
      '初值不能是空数组——那会让"打开编辑再保存"把老数据那份权限清空',
    )
    assert.doesNotMatch(
      src,
      /allowedActions: \[\.\.\.\(agent\.allowedActions/,
      '也不能只取自己的那个字段（老数据上是空的）',
    )
  })
})

describe('显示：契约值 + 已装工具动作的 summary', () => {
  const tool = {
    id: 't1',
    slug: 'probe-tool',
    name: '探针工具',
    manifest: {
      actions: [{ name: 'append-note', summary: '把一句话追加到 NOTES.md' }],
    },
  } as unknown as Tool

  test('★ 工具动作带上清单里的 summary', () => {
    assert.deepEqual(describeAllowedActions(['probe-tool.append-note'], [tool]), [
      { type: 'probe-tool.append-note', summary: '把一句话追加到 NOTES.md' },
    ])
  })

  test('包已经不在了 ⇒ 只显示契约值，不编一句说明', () => {
    assert.deepEqual(describeAllowedActions(['gone-tool.run'], [tool]), [
      { type: 'gone-tool.run', summary: null },
    ])
  })

  test('一个工具都没装 ⇒ 一律只有契约值（$tools 为空时没有清单可查）', () => {
    assert.deepEqual(describeAllowedActions(['probe-tool.append-note'], []), [
      { type: 'probe-tool.append-note', summary: null },
    ])
  })

  test('顺序按传进来的那份（界面显示与勾选顺序一致）', () => {
    assert.deepEqual(
      describeAllowedActions(['probe-tool.clean-notes', 'probe-tool.append-note'], [tool]).map(
        (e) => e.type,
      ),
      ['probe-tool.clean-notes', 'probe-tool.append-note'],
    )
  })
})

describe('★ D41：动作只能来自工具包', () => {
  test('新建审核者的默认权限**是空的**：没有内置动作可预勾了', () => {
    // ⚠️ 这条钉的是一个**行为决定**（D41 之后它反转了）：D40 时代表单预勾
    //    `comment.create`，那个动作名现在已经不存在，而"装了什么包、包里有什么
    //    动作"是使用者的事——平台不替他勾（协议 schema 的默认也是 `[]`）。
    //
    //    判据读的是**组件源码**：那两处（初值与提交后的复位）在表单里，而这个
    //    仓库里 `apps/web` 没有组件级测试的跑法（Svelte 组件在 node 里渲不出来），
    //    所以只能把"不要再长出预勾"钉在文本上——它比"我记得我删了"结实，
    //    而且红的时候直接指到那一行。
    const src = readFileSync(
      new URL('../components/NewAgentForm.svelte', import.meta.url),
      'utf8',
    )
    assert.match(src, /let allowedActions: string\[\] = \[\]/, '表单的初值必须是空数组')
    assert.match(
      src,
      /allowedActions = \[\]/,
      '提交之后复位回空数组（不能再退回预勾的那一档）',
    )
    assert.doesNotMatch(
      src,
      /DEFAULT_ALLOWED_ACTIONS/,
      '预勾那一档（DEFAULT_ALLOWED_ACTIONS）已经在内置动作移除时作废',
    )
  })

  test('裸名（内置动作的形状）查不到 summary —— 它已经不是任何包的清单里的动作', () => {
    const tool = {
      id: 't1',
      slug: 'comment',
      name: '同名包（故意的）',
      manifest: { actions: [{ name: 'create', summary: '包里的 create（与内置动作同形）' }] },
    } as unknown as Tool
    // `comment.create` 只在**真的装了 slug 为 `comment`、且它声明了 `create`**
    // 的包时才查得到说明；老数据里存下来的那个内置动作名不会凭空匹配上。
    assert.deepEqual(describeAllowedActions(['comment.create'], []), [
      { type: 'comment.create', summary: null },
    ])
    assert.deepEqual(describeAllowedActions(['issue.add_label'], [tool]), [
      { type: 'issue.add_label', summary: null },
    ])
  })
})

describe('D41：存着但解析不出来的动作要**显式列出来**（不是消失）', () => {
  const tools = [
    {
      id: 't1',
      slug: 'demo-tool',
      name: '演示',
      manifest: {
        actions: [
          { name: 'say', summary: '打个招呼' },
          { name: 'bye', summary: '道别' },
        ],
      },
    },
  ] as unknown as Tool[]

  test('★ 分成"能解析的"与"现在解析不出来的"两拨', () => {
    // 老数据里存着的那两个名字（曾经是平台的内置动作）现在解析不出来；
    // 界面必须把它们**列出来**——它们的勾选框不存在，静默丢掉等于
    // "使用者没同意就改了权限"，留着又会让保存被服务端拒。
    const split = splitAllowedActions(
      ['comment.create', 'demo-tool.say', 'issue.update_status'],
      tools,
    )
    assert.deepEqual(split.available, ['demo-tool.say'])
    assert.deepEqual(split.unavailable, ['comment.create', 'issue.update_status'])
  })

  test('一个工具都没装 ⇒ 存着的全都算"解析不出来"（而不是被当成空）', () => {
    const split = splitAllowedActions(['demo-tool.say'], [])
    assert.deepEqual(split.available, [])
    assert.deepEqual(split.unavailable, ['demo-tool.say'], '包被卸载之后它依然是**配过的**')
  })

  test('顺序保持原样（显示时不要替他重排）', () => {
    const split = splitAllowedActions(['demo-tool.bye', 'demo-tool.say'], tools)
    assert.deepEqual(split.available, ['demo-tool.bye', 'demo-tool.say'])
  })
})

describe('★ 使用者库里的真实情形：老数据带着两个已经失效的内置动作名', () => {
  /**
   * 实测过的库：审核者的 `reviewStandard.allowedActions` 是
   * `['comment.create', 'issue.add_label']`（内置动作时代的默认），而
   * `Agent.allowedActions` 是空的。D41 之后这两个名字**既不是内置动作、
   * 也没装对应的包**，于是会出现那条"很坑的路径"：
   *
   *   打开审核者的「行动权限」→ 那两个旧名字还在 → 改个名字点保存 → 400，
   *   而使用者觉得自己什么都没动。
   *
   * 这一组把**喂给界面的那两份数据**按真实值钉住（界面就是照它们画的）：
   *   · 有效值（只读态那一行 + 编辑态草稿的初值）：走老字段回退 ⇒ 就是这两个名字；
   *   · 能不能解析：没有包提供它们 ⇒ **两个都算"现在解析不出来"**，
   *     所以编辑态必须把它们显式列出来（带「移除」），而不是静默丢掉、
   *     也不是画成两个勾着的框（那会让 400 变得不可理解）。
   */
  const LEGACY_PAIR = ['comment.create', 'issue.add_label']

  test('★ 有效值走回退 ⇒ 正是那两个旧名字（只读态显示它、编辑态草稿也用它）', () => {
    const legacyAgent = agent([], LEGACY_PAIR)
    assert.deepEqual(effectiveAllowedActions(legacyAgent), LEGACY_PAIR)
    // 而"这是回退来的"这件事也要看得出来（界面据此换一句说明）
    assert.equal(allowedActionsFromLegacyStandard(legacyAgent), true)
  })

  test('★ 两个都解析不出来（没装包、也再没有内置动作）⇒ 必须显式列出来', () => {
    const split = splitAllowedActions(effectiveAllowedActions(agent([], LEGACY_PAIR)), [])
    assert.deepEqual(split.available, [], '一个都不该被当成"还能勾"的')
    assert.deepEqual(split.unavailable, LEGACY_PAIR, '两个都要列出来（不静默剔除）')
    // 装了别的包也一样：那两个旧名字与任何包都无关
    const otherTool = {
      id: 't9',
      slug: 'probe-tool',
      name: '探针工具',
      manifest: { actions: [{ name: 'append-note', summary: '记一笔' }] },
    } as unknown as Tool
    const withOther = splitAllowedActions(LEGACY_PAIR, [otherTool])
    assert.deepEqual(withOther.unavailable, LEGACY_PAIR)
  })

  test('★ 它们在只读态照原样显示（契约值 + 没有 `summary`）——不是被过滤掉', () => {
    assert.deepEqual(describeAllowedActions(LEGACY_PAIR, []), [
      { type: 'comment.create', summary: null },
      { type: 'issue.add_label', summary: null },
    ])
  })
})

/**
 * ★ ③ 那一行收起来之后，**配置细节**只剩这些胶囊在说。
 *
 * 这几条守的是"使用者不点开对话框也看得见自己配了什么"：哪几个动作、各自干什么、
 * 钉了哪些固定值、其中哪个已经失效。四样缺一样，他都要点开对话框才知道——
 * 而"点开才知道"正是这次把选择器收起来之后新引入的风险。
 */
describe('★ ③ 当前配置的胶囊（契约值 + 说明 + 固定值 + 还能不能用）', () => {
  const tool = {
    id: 't1',
    slug: 'example-issue',
    name: '示例单据工具',
    manifest: {
      actions: [
        { name: 'close', summary: '模拟关闭单据' },
        { name: 'tag', summary: '打标签' },
      ],
    },
  } as unknown as Tool

  test('每个胶囊带自己的说明（只给机器名没人知道它允许干什么）', () => {
    assert.deepEqual(describeActionPicks(['example-issue.close'], [tool], {}, []), [
      {
        type: 'example-issue.close',
        summary: '模拟关闭单据',
        fixed: [],
        unavailable: false,
      },
    ])
  })

  test('★ 固定值按**动作**取：不许把整份参数摊到每个胶囊上', () => {
    // 摊平的后果是每个胶囊都挂着所有动作的固定值，而"哪个值属于哪个动作"
    // 就看不出来了——那种界面比不显示更糟（它会让人以为关单会带上打标签的参数）。
    const entries = describeActionPicks(
      ['example-issue.close', 'example-issue.tag'],
      [tool],
      { 'example-issue.close': { reason: '巡检' }, 'example-issue.tag': { label: 'bug' } },
      [],
    )
    assert.deepEqual(entries[0]?.fixed, [['reason', '巡检']])
    assert.deepEqual(entries[1]?.fixed, [['label', 'bug']])
  })

  test('没钉固定值 ⇒ 空数组（不是"有个空对象"）', () => {
    const entries = describeActionPicks(['example-issue.close'], [tool], {}, [])
    assert.deepEqual(entries[0]?.fixed, [])
  })


  test('★ 「当前不可用」与「没有说明」是两件事，不许合并', () => {
    // 配过、但包被卸载了：`summary` 会是 null（查不到），而它**不会被执行**。
    // 把两者画成同一件事，使用者会把"已经失效"读成"只是没写说明"。
    const entries = describeActionPicks(
      ['gone-tool.act', 'example-issue.close'],
      [tool],
      {},
      ['gone-tool.act'],
    )
    assert.equal(entries[0]?.summary, null)
    assert.equal(entries[0]?.unavailable, true)
    assert.equal(entries[1]?.unavailable, false, '装着的那个不受影响')
  })

  test('顺序跟着勾选那一份走（与发出去的数组同序，不重排）', () => {
    const picks = ['example-issue.tag', 'example-issue.close']
    assert.deepEqual(
      describeActionPicks(picks, [tool], {}, []).map((e) => e.type),
      picks,
    )
  })
})
