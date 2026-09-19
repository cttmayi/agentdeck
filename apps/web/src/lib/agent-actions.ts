import type { Tool } from './api.ts'
import { actionsOf } from './tool-view.ts'

/**
 * 行动权限（`Agent.allowedActions`）的**展示层纯函数**（D40 收口、D41 收窄）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它为什么从 `skill-install.ts` 搬到这里
 * ══════════════════════════════════════════════════════════════════
 *
 * 那六个内置动作原来住在 `skill-install.ts` 里，因为那时候"允许触发哪些动作"
 * 是**装 skill 时勾的一组 checkbox**。D40 收口之后它成了**审核者的能力**
 * （`Agent.allowedActions`）——留在"安装 skill"那个模块里，会让人以为装 skill
 * 还要配动作（那时已经没有这回事了）。所以搬到这里：一个模块只回答一件事，
 * "行动权限怎么显示、怎么取"就是这一件。
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

/**
 * 一个 agent 身上与"行动权限"有关的那两处。
 *
 * 都按"可能没有"收：`allowedActions` 是后加的字段，老工作区的记录里
 * **根本没有这个键**（store 不做 schema 迁移，读取路径也不补默认值），所以
 * `undefined` 与 `[]` 同义。`reviewStandard` 同理（老数据可能整个是 null）。
 */
export interface ActionCapableAgent {
  /** ★ 它的行动权限（D40 收口之后住在这里）。 */
  allowedActions?: readonly string[] | undefined
  /** 内联标准；`allowedActions` 那个键是**老数据的只读兼容字段**。 */
  reviewStandard: { allowedActions?: readonly string[] | undefined } | null
}

/**
 * ★ 一个 agent 的**有效**行动权限——界面显示与编辑的初值都用它。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么界面要做这个回退（以及它**只做显示**）
 * ══════════════════════════════════════════════════════════════════
 *
 * 动作权限搬走之前写在审核标准里，所以老工作区里那份配置还在
 * `reviewStandard.allowedActions` 上。界面若只读新字段，那些使用者会看到
 * 一片空白——**以为自己的配置丢了**，然后重新配一遍（或者更糟：以为平台
 * 不再允许任何动作）。所以显示时回退。
 *
 * ⚠️ 回退**只到显示与编辑初值为止**：写入口永远只写 `Agent.allowedActions`
 *    （见 `AgentDetail.svelte` 的 `buildPatch()`），界面上任何一处都不会去写
 *    老字段。于是"哪个优先"这件事在界面这一侧根本不需要回答——它只在这里出现
 *    一次，与服务端 `resolveReviewStandard` 的那一条顺序说的是同一件事。
 */
export function effectiveAllowedActions(agent: ActionCapableAgent): string[] {
  const own = agent.allowedActions ?? []
  if (own.length > 0) return [...own]
  return [...(agent.reviewStandard?.allowedActions ?? [])]
}

/**
 * 显示的那份是**从老字段回退来的**吗。
 *
 * ★ 界面据此说一句"它来自老配置，保存时会写到行动权限上"。少了这一句，
 *   使用者会以为自己在看新字段，而"保存之后权限还在不在"就成了一个谜
 *   ——服务端只写新字段，保存时并不替他把老字段搬过去。
 */
export function allowedActionsFromLegacyStandard(agent: ActionCapableAgent): boolean {
  return (
    (agent.allowedActions ?? []).length === 0 &&
    (agent.reviewStandard?.allowedActions ?? []).length > 0
  )
}

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
 * 编辑态那一栏只画**已装工具的动作**（勾选框从清单来）。而 agent 身上存着的值
 * 可能指向一个已经不存在的动作（老数据里的内置动作名、或者那个包被卸载了）：
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
