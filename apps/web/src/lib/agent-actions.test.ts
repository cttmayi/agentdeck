import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import type { Tool } from './api.ts'
import {
  describeActionPicks,
  describeAllowedActions,
  splitAllowedActions,
} from './agent-actions.ts'

/**
 * 行动权限的显示逻辑（2026-10：它服务的对象从 **agent** 换成了 **组**）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件删掉的那一半同样重要（说清楚，免得下次有人"补回来"）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这里原来守着两条**老数据回退**规则：`effectiveAllowedActions(agent)`
 * （自己的 `allowedActions` 为空时回退到 `reviewStandard.allowedActions`）与
 * `allowedActionsFromLegacyStandard(agent)`（"这份是不是回退来的"）。动作权限
 * 从"审核标准里的一组 checkbox"搬到 agent 上时，那是必要的一层。
 *
 * 2026-10 这两条一并删了，理由是**回退的对象没有了**：动作权限已经从 `Agent`
 * 上整个撤掉（它属于组），老记录里那几个键由 daemon 启动时摘掉
 * （`agent-legacy-cleanup.ts`）。留着一层"回退"，界面就会开始显示一份**不可写、
 * 也不该存在**的权限。
 *
 * ⚠️ 而**剩下**的这一半（"一串动作名怎么显示"）与"挂在谁身上"无关，所以组页与
 *    新任务页照旧用它——那些判据一条都没放宽。
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

/**
 * ⚠️ 这里原来有一个 `agent(allowedActions, standardActions)` 夹具（造一条带老字段的
 *    agent 记录）。它随着那两个回退函数一起删掉了——**没有对象了**：`Agent` 上已经
 *    没有这些字段，而老记录里的键由 daemon 启动时摘掉。
 */

/**
 * 从一个 `.svelte` 源码里挑出**提到这些名字的代码行**（把注释整段去掉之后再找）。
 *
 * ⚠️ 必须先整段去掉块注释：`<!-- … -->` 与 `/* … *​/` 里**允许**提到那几个键
 *    （那正是"这里原来是什么"的说明），而它们的**续行**并不以 `<!--` 开头——
 *    按行过滤会把续行误判成代码（这条踩过一次）。
 */
function codeLinesMentioning(src: string, names: readonly string[]): string[] {
  const withoutBlocks = src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  for (const line of withoutBlocks.split('\n')) {
    const t = line.trim()
    if (t.startsWith('//') || t === '') continue
    if (names.some((n) => t.includes(n))) out.push(t)
  }
  return out
}
describe('★ `AgentDetail.svelte` 里已经没有任何"行动权限"的痕迹（2026-10）', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 为什么这条单独一个 describe：它是**负向**的回归保护
   * ══════════════════════════════════════════════════════════════════
   *
   * 撤销一个设置最难的地方不是"删掉那段界面"，而是**别让它从别的地方长回来**：
   * 草稿里留一个 `allowedActions: []`、PATCH 里留一段"清理老字段"的逻辑，都会
   * 让"保存一个 agent"这件事重新去碰一个已经不存在的字段——而现在服务端的回答是
   * 400「不认识的字段」，也就是**保存整个失败**。
   *
   * ⚠️ 判据读的是**组件源码**：`apps/web` 没有组件级测试的跑法（Svelte 组件在
   *    node 里渲不出来），而这条回归的后果足够贵（保存直接不可用），所以钉在文本
   *    上——它比"我记得我删干净了"结实，红的时候还直接指到那一行。
   */
  const src = readFileSync(new URL('../components/AgentDetail.svelte', import.meta.url), 'utf8')

  test('★★ 草稿与 PATCH 里都不再出现那三个键（写了就是 400）', () => {
    assert.deepEqual(
      codeLinesMentioning(src, ['allowedActions', 'actionParams', 'debugActions']),
      [],
      '★ AgentDetail 的代码里不该再有那三个键（它们是 agent 上撤掉的字段）',
    )
  })

  test('★ 编辑态说的是"它在组上配"，而不是画一个勾选栏', () => {
    assert.match(src, /agents\.actionsMovedToGroup/, '要有一句指路（去哪儿改）')
    assert.doesNotMatch(
      src,
      /import ActionPicker/,
      '★ 不许把那个选择器画在智能体页：两处一样、只有一处生效',
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

describe('★ 新建表单里**根本没有**行动权限这一栏（2026-10）', () => {
  test('★ 表单不再提交那三个键（写了就是 400；D41 之前它还预勾过一个动作）', () => {
    // ⚠️ 这条原来钉的是"新建审核者的默认权限是空的"（D41：没有内置动作可预勾了，
    //    所以表单初值必须是 `[]`）。2026-10 之后**连那一栏都没有了**——动作只属于
    //    组，新建一个 agent 时没有任何动作要配。判据因此从"初值是空数组"变成
    //    "这三个键压根不出现在表单里"：留一个 `allowedActions: []` 看着无害，实际
    //    会让提交撞上 400「不认识的字段」。
    //
    //    判据读的是**组件源码**：那两处（初值与提交后的复位）在表单里，而这个
    //    仓库里 `apps/web` 没有组件级测试的跑法（Svelte 组件在 node 里渲不出来），
    //    所以只能把"不要再长出预勾"钉在文本上——它比"我记得我删了"结实，
    //    而且红的时候直接指到那一行。
    const src = readFileSync(
      new URL('../components/NewAgentForm.svelte', import.meta.url),
      'utf8',
    )
    assert.deepEqual(
      codeLinesMentioning(src, ['allowedActions', 'actionParams', 'debugActions']),
      [],
      '★ 新建表单里不该再有那三个键（它们已经搬到组上了）',
    )
    assert.doesNotMatch(src, /import ActionPicker/, '新建表单里不再画那个选择器')
    assert.doesNotMatch(src, /DEFAULT_ALLOWED_ACTIONS/, '预勾那一档（D41）早已作废')
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

describe('★ 使用者库里的真实情形：一份配置带着两个已经失效的内置动作名', () => {
  /**
   * 实测过的库：那份行动权限是 `['comment.create', 'issue.add_label']`
   * （内置动作时代的默认）。D41 把内置动作整组移除之后，这两个名字**既不是内置
   * 动作、也没装对应的包**，于是会出现那条"很坑的路径"：
   *
   *   打开「行动权限」→ 那两个旧名字还在 → 改个名字点保存 → 400，
   *   而使用者觉得自己什么都没动。
   *
   * ⚠️ 2026-10：这条路径现在**挂在组上**（动作只属于组），所以这一组不再造一条
   *    "带老字段的 agent 记录"：判据直接喂那份**真实的值**给显示层——那正是界面
   *    照它画的东西。
   */
  const LEGACY_PAIR = ['comment.create', 'issue.add_label']

  test('★ 两个都解析不出来（没装包、也再没有内置动作）⇒ 必须显式列出来', () => {
    const split = splitAllowedActions(LEGACY_PAIR, [])
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
