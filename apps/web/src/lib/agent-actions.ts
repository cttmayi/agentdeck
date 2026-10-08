import type { Tool } from './api.ts'
import { actionsOf } from './tool-view.ts'

/**
 * 行动权限（`AgentGroup.allowedActions`）的**展示层纯函数**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它服务的是**组**的行动权限（2026-10 起的唯一出处）
 * ══════════════════════════════════════════════════════════════════
 *
 * ⚠️ 这个模块的名字与它的历史：这里原来叫"`Agent.allowedActions` 的展示层"——
 *    动作权限当时是**审核者个人的能力**（再早一轮是"装 skill 时勾的一组
 *    checkbox"）。2026-10 那个字段连同概念一起撤掉了：动作属于**这条链**，
 *    唯一权威是 `AgentGroup` 上那三个同名字段（组配置页 ③ 行动）。
 *
 *    搬家的直接后果：文件里那两个针对"人"的函数（`effectiveAllowedActions` ——
 *    从 `reviewStandard.allowedActions` 回退，以及 `allowedActionsFromLegacyStandard`
 *    ——"这份是从老标准回退来的吗"）**一起删了**：agent 上已经没有那份配置，
 *    回退没有对象。剩下的是与"一份动作名清单怎么显示"有关的纯函数，它们与
 *    "清单挂在谁身上"无关，所以组页与新任务页照旧用。
 *
 * ══════════════════════════════════════════════════════════════════
 * D41：内置动作**整组不存在了**，于是这里也没有那份表了
 * ══════════════════════════════════════════════════════════════════
 *
 * 这个文件里原来有一张 `BUILTIN_ACTIONS`（那六个裸名）与一条
 * `DEFAULT_ALLOWED_ACTIONS`（新建审核者时预勾 `comment.create`）。使用者把平台的
 * 内置动作**全部移除**之后：
 *
 *   · 动作名**只有** `<包 slug>.<动作名>` 一种形状（`ActionType` 在协议里已经
 *     删掉，`packages/domain` 的注册表也换成了 `definition.ts`）——所以
 *     `BUILTIN_ACTIONS` 守的那份表**没有对应物**了，留着它就是第二份真相；
 *   · 预勾的那一档也**随之作废**：`comment.create` 已不是一个动作名，而工具动作
 *     有没有、叫什么，取决于使用者装了哪个包（装之前表单根本不该替他勾）。
 *     于是新建审核者的行动权限默认回到**空**——这也正是协议 schema 的默认值。
 *
 * ⚠️ 这里**只产出值 + 文案键**，不产出中文句子（D39）：库层不知道当前界面语言，
 *    渲染交给界面用 `$t(...)` / `<code>` 做。与 `skill-install.ts` 同一条规矩。
 */

/** 一条动作在界面上怎么显示：**契约值** + 它的说明。 */
export interface ActionEntry {
  /** 判决里写的那个字符串（`<包 slug>.<动作名>`）。原样显示、不翻译。 */
  type: string
  /**
   * 已装工具的动作取清单里的 `summary`。
   *
   * ⚠️ 查不到时是 `null`——**包括**"这条权限指向一个已经卸载的包"以及"它指向
   *    当年那些内置动作"（老工作区里存下来的值）：没有清单可查，就没有说明。
   */
  summary: string | null
}

/**
 * 把一串动作名变成**要显示的那几行**。
 *
 * ★ 动作一律**要带上 `summary`**：只给 `probe-tool.append-note` 这种机器名的话，
 *   "它允许的到底是什么"就只能靠猜。取值走 `actionsOf()`——`<slug>.<动作名>`
 *   的拼法只有那一处，自己再拼一遍迟早差一个字符（而契约值差一个字符，
 *   判决里那个动作就永远找不到）。
 */
export function describeAllowedActions(
  actions: readonly string[],
  tools: readonly Tool[],
): ActionEntry[] {
  return actions.map((type) => ({ type, summary: summaryOfAction(type, tools) }))
}

/**
 * 一个动作**在这一次任务上**的完整样子（③ 那一行要显示的东西）。
 *
 * ★ 为什么不是 `ActionEntry` 加几个可选字段：这四个值回答的是同一个问题——
 *   "这一次到底允许它做什么"，而界面上它们是**同一个胶囊**里的四样东西。
 *   拆成两个类型只会让调用方把它们拼起来时漏掉一两样（漏掉"固定值"那一样，
 *   使用者就看不到"这次它会带着 `reason=巡检` 去关单"）。
 */
export interface ActionPickEntry extends ActionEntry {
  /** 钉死的固定值（`name → value`），空数组 = 没钉。 */
  fixed: Array<[string, unknown]>
  /**
   * 配过、但**现在解析不出来**（提供它的包被卸载了，或者名字来自很早以前的配置）。
   *
   * ⚠️ 它与 `summary === null` 不是同一件事：`summary` 缺失只说明"没有说明可显示"，
   *    而这个字段说的是"它现在**不会被执行**"——两者必须分开，否则界面会把
   *    "还配着、但已经失效"画成"还配着、只是没写说明"。
   */
  unavailable: boolean
}

/**
 * 把**这一次生效的勾选**变成要显示的胶囊：契约值 + 说明 + 固定值 + 还能不能用。
 *
 * 与 `describeAllowedActions` 的分工：那个回答"这一串名字各是什么"，这个回答
 * "这一次的配置**长什么样**"——后者是 ③ 那一行收起来之后唯一能看见配置的地方
 * （选择器进了对话框，不点开就什么都看不到）。
 *
 * ⚠️ 参数按**动作**取（`params[type]`），不是把整份参数摊平：摊平之后每个胶囊上
 *    都会挂着所有动作的固定值，而"哪个值属于哪个动作"就看不出来了。
 */
export function describeActionPicks(
  picks: readonly string[],
  tools: readonly Tool[],
  params: Readonly<Record<string, Record<string, unknown>>>,
  unavailable: readonly string[],
): ActionPickEntry[] {
  const dead = new Set(unavailable)
  return picks.map((type) => ({
    type,
    summary: summaryOfAction(type, tools),
    fixed: Object.entries(params[type] ?? {}),
    unavailable: dead.has(type),
  }))
}

function summaryOfAction(type: string, tools: readonly Tool[]): string | null {
  // D41 之后动作只有一种来源：**已装工具包的清单**。所以这里只有一次查表——
  // 原来那一步"先判是不是内置动作"（内置动作的名字里也有点，不能靠"有没有点"
  // 分类）随内置动作一起没有了。
  for (const tool of tools) {
    for (const item of actionsOf(tool)) {
      if (item.type === type) return item.action.summary
    }
  }
  // 找不到：包已被卸载（或这条权限是很早以前配的、指向已经不存在的动作名）。
  // **不编**一句说明——显示契约值本身已经足够可读，而编一句会把"它指向的东西
  // 不在了"盖掉。
  return null
}

/**
 * 把"当前存着的动作"按**现在能不能解析**分成两拨（D41 收尾）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须有它：界面上会出现"看不见、也去不掉"的权限
 * ══════════════════════════════════════════════════════════════════
 *
 * 编辑态那一栏只画**已装工具的动作**（勾选框从清单来）。而组上存着的值
 * 可能指向一个已经不存在的动作（很早以前配的动作名、或者那个包被卸载了）：
 * 它**不在勾选框里**，于是使用者既看不见它、也没法取消它——一保存就被服务端拒
 * （"不认识的动作"），而错误里说的那个名字在界面上**根本不存在**。
 *
 * 所以这一层把它们分出来，界面据此**显式列出来**并给一个"移除"入口。
 * ⚠️ 注意：**不在保存时静默剔除**。那等于使用者没同意就改了权限——
 *    平台既不替他放宽，也不替他收紧。
 */
export interface AllowedActionsSplit {
  /** 现在解析得出来的（勾选框里能勾的那些）。 */
  available: string[]
  /** 存着但**现在解析不出来**的（要显式处理：移除，或者去装那个包）。 */
  unavailable: string[]
}

/** 已装工具声明过的全部动作名。 */
export function availableActionTypes(tools: readonly Tool[]): Set<string> {
  const set = new Set<string>()
  for (const tool of tools) for (const item of actionsOf(tool)) set.add(item.type)
  return set
}

export function splitAllowedActions(
  actions: readonly string[],
  tools: readonly Tool[],
): AllowedActionsSplit {
  const available = availableActionTypes(tools)
  const out: AllowedActionsSplit = { available: [], unavailable: [] }
  for (const type of actions) {
    if (available.has(type)) out.available.push(type)
    else out.unavailable.push(type)
  }
  return out
}
