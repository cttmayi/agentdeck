import type { Agent, Tool } from './api.ts'
import { effectiveAllowedActions, splitAllowedActions } from './agent-actions.ts'

/**
 * 「执行 → 审核 → 行动」这条链的**推导**（新建任务页）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是独立一个纯函数文件，而不是 `.svelte` 里的几个 `$:`
 * ══════════════════════════════════════════════════════════════════
 *
 * 这一页要推出来的东西有三件，而且它们**互相依赖**：② 的审核者是谁（取决于
 * ① 选了谁、以及执行者长期配的是谁），③ 显示哪些动作（取决于 ② 最终那个人），
 * 以及**提交时那个 key 到底写不写**（取决于 ② 是"跟随"还是"这一次换人"）。
 *
 * 写成组件里的 `$:` 之后，这三件事都只能靠"打开页面点一遍"来验证，而这个仓库
 * 的 `apps/web` **没有组件级测试的跑法**（Svelte 组件在 node 里渲不出来，见
 * `agent-actions.test.ts` 里那段说明）。而这里推错一格的后果不是排版难看：
 * "跟随"被错推成"换人"会**悄悄把长期安排固化成一次覆盖**；"不审"被错推成
 * "跟随"会让一条本该被审的产出看起来正常结束。所以判据放进纯函数，用
 * `node --test` 钉住（见 `newtask-chain.test.ts`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三态是**意图**，不是"有值 / 没值"（协议里那段注释是同一件事）
 * ══════════════════════════════════════════════════════════════════
 *
 * `SubmitRunRequest.reviewerAgentId` 的三态各有后果，所以这里的 `ReviewerChoice`
 * 跟着它一一对应，并且**不合并**：
 *
 *   · `follow`  ⇒ 请求体里**不出现这个 key**（照执行者的长期安排走）；
 *   · `none`    ⇒ `reviewerAgentId: null`（这一次明确不审）；
 *   · `pick`    ⇒ `reviewerAgentId: '<id>'`（这一次换人，**不改**长期配置）。
 *
 * ★ "跟随"**不等于**"把当前解析出来的那个 id 写进请求体"：那会把一件长期安排
 *   冻结成这一次的覆盖——下一个人在智能体页把审核者换掉之后，这条路上仍然按
 *   老那个人跑。所以 `reviewer`（推出来给界面显示的人）与**请求体里写什么**
 *   是两件事，后者只看 `ReviewerChoice`（`reviewerRunField()`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * ③ 上是**同一件事的第二遍**（`SubmitRunRequest.allowedActions`）
 * ══════════════════════════════════════════════════════════════════
 *
 * ③ 原来只读，现在是**可勾的**，而它的"改没改过"与 ② 的"跟随不跟随"是同源的
 * 一份规矩：勾选结果与审核者当前那份**一致** ⇒ 请求体里同样**不出现**
 * `allowedActions`；不一致 ⇒ 带上那一份（一个都不勾 ⇒ `[]`，它是"这一次一个动作
 * 都不许触发"，**合法而且有意义**）。判据同样是纯函数（`picksMatchReviewer()` /
 * `actionsRunField()`），理由与上面那段一个字都不差——把"没改"判成"改了"，
 * 长期安排就被静默冻结成一次覆盖。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里**不做**服务端那三条校验（存在性 / 角色 / INV-1）
 * ══════════════════════════════════════════════════════════════════
 *
 * 服务端在写入之前会校验"指定的审核者不存在 / 角色不是 reviewer / 等于执行者"
 * 并回 400 原文（`apps/daemon/src/server.ts` 的 `POST /api/runs`）。页面**不重写
 * 这三条**：两处各写一遍必然分叉，而分叉的表现是"页面放行、服务端拒绝"——
 * 使用者点了提交，界面上却什么都没说。所以这里的职责只有两件：
 *
 *   1. 把**界面要显示的事实**推出来（谁审、会不会审、能触发什么）；
 *   2. 把服务端那句话**原样显示**（现有的 `error = err.message`，没改）。
 *
 * ⚠️ 因此 `pick` 只按 id 查人，**不查角色**：下拉里本来就只有 `role === 'reviewer'`
 *    的候选（`reviewerCandidates()` 负责筛），而万一选中的那个被别人改了角色，
 *    该说话的是服务端那条 `reviewer_role_mismatch`，不是这里再编一句。
 */

/**
 * ② 上选了什么。
 *
 * ⚠️ 三种模式的**后果不同**，所以这是一个可辨识联合而不是"一个可空 id"：
 *    可空 id 表达不了"照旧"与"这次不审"的区别（那正是整个设计的关键）。
 */
export type ReviewerChoice =
  | { mode: 'follow' }
  | { mode: 'none' }
  | { mode: 'pick'; agentId: string }

/**
 * 推出来的那条链。
 *
 * 它是**界面显示用的唯一来源**：② 的状态说明与 ③ 的动作清单都从这里取，
 * 组件里不再自己 join 一遍 `$agents` / `$tools`（join 两遍就会有两份真相）。
 */
export interface NewTaskChain {
  /** 最终会去审的那个；`null` = 这次不会审。 */
  reviewer: Agent | null
  /**
   * 这个结果是从哪来的。
   *
   * ⚠️ 它说的是**决定走的是哪条路**（跟随 / 这一次换人 / 这一次不审），不是
   *    "解析成功了没有"——解析失败由 `notReviewing` 说（`dangling`）。
   */
  reviewerSource: 'follow' | 'override' | 'none'
  /**
   * 为什么这次不会有审核结论；`null` = 会审。
   *
   *   · `not_configured` ⇒ 执行者没配「由谁来审它」（**长期**就没配）；
   *   · `explicit_none`  ⇒ 使用者在 ② 上明确选了「不自动审核」；
   *   · `dangling`       ⇒ 指向的那个 agent 已经不存在了（执行者配的、或者
   *                        ② 上选的那个被人删了）。★ 这一档必须是**独立状态**：
   *                        静默退回"跟随"等于替使用者做了一个他没做过的决定。
   */
  notReviewing: 'not_configured' | 'explicit_none' | 'dangling' | null
  /**
   * 生效且**现在解析得出定义**的动作。
   *
   * ★ 它同时是 ③ 的两件事：**勾选框里有哪几项是勾着的**（初值，见
   *   `defaultActionPicks()`），以及提交时判"改没改过"的**比较基准**
   *   （见 `picksMatchReviewer()`）。所以它必须真的来自
   *   `splitAllowedActions(effectiveAllowedActions(reviewer))`——换个来源就会
   *   出现"界面上的勾与提交时比的不是同一份"。
   */
  actions: readonly string[]
  /** 生效但**现在解析不出定义**的动作（包被卸载了，或名字来自很早以前的配置）。 */
  unavailableActions: readonly string[]
  /**
   * 审核者当前配的**动作固定参数**（D43）：`动作名 → 参数名 → 值`。
   *
   * 与 `actions` 同一条规矩：它是 ③ 的两件事——固定参数表单的**初值**
   * （`defaultActionParams()`），以及提交时判"改没改过"的**比较基准**
   * （`paramsMatchReviewer()`）。所以它必须真的来自 `reviewer.actionParams`，
   * 换个来源就会出现"界面上的表单与提交时比的不是同一份"。
   */
  actionParams: Record<string, Record<string, unknown>>
}

export interface NewTaskChainInput {
  /** ① 上选中的执行者；还没选（一个执行者都没有）时是 `null`。 */
  executor: Agent | null
  choice: ReviewerChoice
  agents: readonly Agent[]
  tools: readonly Tool[]
}

/**
 * 把三个输入推成那条链。
 *
 * ⚠️ 动作那一份**复用** `agent-actions.ts`：`effectiveAllowedActions()`（有效值，
 *    含老数据从 `reviewStandard.allowedActions` 的回退）与 `splitAllowedActions()`
 *    （按"现在能不能解析"分两拨）。自己在这里再判一遍"这个动作名认不认识"，
 *    迟早与智能体页那一栏分叉——而分叉的表现是"同一个审核者，两页显示的权限
 *    不一样"。
 */
export function resolveNewTaskChain(input: NewTaskChainInput): NewTaskChain {
  const { executor, choice, agents, tools } = input
  const byId = (id: string): Agent | null => agents.find((a) => a.id === id) ?? null

  let reviewer: Agent | null = null
  let notReviewing: NewTaskChain['notReviewing'] = null

  switch (choice.mode) {
    case 'none':
      // 明确不审：不需要去解析任何人——这正是"选了 none 之后 ③ 没有动作"的原因。
      notReviewing = 'explicit_none'
      break
    case 'pick':
      reviewer = byId(choice.agentId)
      // ★ 选了的人不在了（界面开着的时候被删掉）：说它没了，而不是当作"没选"。
      if (!reviewer) notReviewing = 'dangling'
      break
    case 'follow': {
      // 老数据里这个键可能整个不存在 ⇒ `?? null` 与 `null` 同义（"没配"）。
      const wanted = executor?.reviewerAgentId ?? null
      if (!wanted) {
        notReviewing = 'not_configured'
      } else {
        reviewer = byId(wanted)
        if (!reviewer) notReviewing = 'dangling'
      }
      break
    }
  }

  const reviewerSource: NewTaskChain['reviewerSource'] =
    choice.mode === 'follow' ? 'follow' : choice.mode === 'pick' ? 'override' : 'none'

  // 没有审核者 ⇒ 一份动作都没有：动作是**审核者**的能力（判完之后由平台执行），
  // 没有审核者就没有判决，也就没有可谈的动作。这比"列出某个人的权限"更诚实。
  const split = reviewer
    ? splitAllowedActions(effectiveAllowedActions(reviewer), tools)
    : { available: [], unavailable: [] }

  return {
    reviewer,
    reviewerSource,
    notReviewing,
    actions: split.available,
    unavailableActions: split.unavailable,
    // D43：审核者长期配的固定参数（可能是老记录里没有的键 ⇒ `{}`）。
    actionParams: reviewer?.actionParams ?? {},
  }
}

/**
 * ② 的候选：**审核者角色**，且**排除当前选中的执行者**（INV-1）。
 *
 * ★ 排除执行者不是省事，是不给一个**必然失败**的选项：INV-1（reviewer ≠
 *   executor）由服务端强制（`POST /api/runs` 会回 `reviewer_must_differ`），
 *   自己审自己在 S1 的闭环里等于没有审核。把它列在下拉里，使用者能选中，
 *   然后被 400 拒——那是"界面允许了一件它知道不该允许的事"。
 *
 * ⚠️ 只按**当前选中的**执行者排除：换 ① 之后候选跟着重算（这是"后一步由前一步
 *    推出来"的一部分）。
 */
export function reviewerCandidates(
  executor: Agent | null,
  agents: readonly Agent[],
): Agent[] {
  return agents.filter((a) => a.role === 'reviewer' && a.id !== executor?.id)
}

/**
 * 下拉的取值编码。
 *
 * `<select>` 只能绑字符串，而 `ReviewerChoice` 是一个对象——把三态编码成三个
 * 取值，比在下拉那里传一个"看起来像 id 的哨兵字符串"结实：agent id 万一哪天
 * 变得可自定义，`'follow'` 这种哨兵就会与真的 id 撞上。
 */
export type ReviewerPick = 'follow' | 'none' | `pick:${string}`

const PICK_PREFIX = 'pick:'

export function toReviewerPick(choice: ReviewerChoice): ReviewerPick {
  switch (choice.mode) {
    case 'follow':
      return 'follow'
    case 'none':
      return 'none'
    case 'pick':
      return `${PICK_PREFIX}${choice.agentId}`
  }
}

/**
 * 解码下拉的值。
 *
 * ⚠️ 认不出来的一律当 **`follow`**（"照旧"）：取不到值只可能是 DOM 被改坏，
 *    而三种结果里只有"跟随"是**不会凭空多出一个审核者、也不会凭空少掉审核**的
 *    那一个——跟随是这一页的默认，也是唯一与"这个值坏了"后果最轻的一档。
 */
export function reviewerChoiceOf(pick: string): ReviewerChoice {
  if (pick === 'none') return { mode: 'none' }
  if (pick.startsWith(PICK_PREFIX) && pick.length > PICK_PREFIX.length) {
    return { mode: 'pick', agentId: pick.slice(PICK_PREFIX.length) }
  }
  return { mode: 'follow' }
}

/**
 * 提交时**请求体里写什么**——三态的关键就在这个函数里。
 *
 * ══════════════════════════════════════════════════════════════════
 * "跟随"必须让那个 key **根本不出现**（省略 ≠ null）
 * ══════════════════════════════════════════════════════════════════
 *
 * 省略的意思是"照执行者的长期安排"（daemon 去读 `reviewerAgentId` 配置），
 * `null` 的意思是"这一次不审"。两者后果差得很远（一个会派生审核 run、
 * 一个不会），在库里也是两条不同的记录。所以"跟随"**不能**写成
 * `reviewerAgentId: null`，也不能写成"把当前解析出来的那个 id 传过去"：
 *
 *   · 传 `null` ⇒ 使用者以为自己只是照旧，实际把审核关掉了；
 *   · 传 id   ⇒ 使用者以为改了长期安排就生效，实际这一条被冻结成覆盖。
 *
 * ★ 判据只看 `choice`（使用者选了什么），**不看** `chain.reviewer`：跟随模式下
 *   `reviewer` 通常非空（那是拿来显示的），而请求体里绝不能出现它。
 *
 * ⚠️ `pick` 指向一个已经不存在的 id 时**照样把它传过去**：让服务端回
 *    `reviewer_not_found` 的原文（页面上显示的就是它）。在这里悄悄改成"跟随"
 *    或 `null`，等于替使用者做了一个他没做过的决定——而且那条产出会**看起来
 *    正常结束**。
 */
export function reviewerRunField(choice: ReviewerChoice): { reviewerAgentId?: string | null } {
  switch (choice.mode) {
    case 'follow':
      // ★ 空对象：`JSON.stringify` 之后这个 key 根本不在请求体里。
      return {}
    case 'none':
      return { reviewerAgentId: null }
    case 'pick':
      return { reviewerAgentId: choice.agentId }
  }
}

// ══════════════════════════════════════════════════════════════════════
// ③ 行动：勾了什么，以及提交时那个 key 到底写不写
// ══════════════════════════════════════════════════════════════════════
//
// 这三个函数与上面 `reviewerRunField()` 是一对：② 决定"谁审"，③ 决定"这一次
// 允许触发什么"，而两者的**省略语义完全相同**——省略 = 跟随那个审核者的长期
// 配置，给了值 = 只覆盖这一次。所以判据也必须同样"宁可不带"：多带一次覆盖的
// 代价是把长期安排冻死，少带一次覆盖的代价只是使用者这次改的没生效（而那种
// 情况只会发生在"他改的东西与原有那份一模一样"时——那时两者本来就没差别）。

/**
 * ③ 上勾了哪些（受控状态）。
 *
 * ★ 它是一份**动作名的集合**，而不是"相对于默认值的增删"。于是判"改没改过"靠
 *   `picksMatchReviewer()` 比集合，而不是靠"碰没碰过勾选框"：全取消之后又全勾
 *   回来，事实就是"没改"（请求体里不该出现覆盖），而一个"碰过"的标记会把它
 *   记成改过——那正是 ② 上做不到（也不需要）的那种区分。
 */
export type ActionPicks = readonly string[]

/**
 * 勾选状态的**默认值**：审核者当前那份里**现在解析得出定义**的动作。
 *
 * ⚠️ 只取 `chain.actions`（`splitAllowedActions` 的 `available` 那一份）：解析不出来的
 *    动作（包被卸载了、或者是很早以前的旧名字）预勾上的话，这一页会替使用者准备好
 *    一个**必然失败**的提交——daemon 的 `allowed_actions_unresolvable` 会把它整条拒掉
 *    （判据与 agent 的「行动权限」同一套）。
 *
 * ⚠️ 没有审核者时是空数组：动作是**审核者**的能力，那时 ③ 根本不可编辑
 *    （`chain.actions` 也是空的，两者一致 ⇒ 这个函数不会凭空造出一份来）。
 */
export function defaultActionPicks(chain: NewTaskChain): ActionPicks {
  return [...chain.actions]
}

/**
 * 勾选结果与"审核者当前那份"是否**一致**（集合相等）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是集合相等，而不是逐位比较或者 `JSON.stringify`
 * ══════════════════════════════════════════════════════════════════
 *
 * ★ 判据错一格的后果是**长期安排被冻成一次覆盖**（与 `reviewerRunField()` 那段
 *   注释里同一个坑）：只要把"其实没改"读成"改了"，请求体里就会多出一个
 *   `allowedActions`，以后在智能体页给这个审核者加了动作，从这一页建的任务
 *   仍然按老那份跑——而页面上什么都看不出来。
 *
 * 而"没改"这件事与**顺序无关**：使用者先勾哪个、`$tools` 按什么顺序列、审核者
 * 当初按什么顺序存的，三者都可能不同。`JSON.stringify` 一比就会把"顺序不同"
 * 读成"改过"——最难发现的一种误判，因为界面上两者完全一样。
 * 重复项同理：`['a','a']` 与 `['a']` 到了请求体里是同一份白名单。
 */
export function picksMatchReviewer(picks: ActionPicks, chain: NewTaskChain): boolean {
  const current = new Set(chain.actions)
  const picked = new Set(picks)
  if (picked.size !== current.size) return false
  for (const action of picked) if (!current.has(action)) return false
  return true
}

/**
 * 提交时**请求体里写什么**——③ 的关键就在这个函数里。
 *
 * ══════════════════════════════════════════════════════════════════
 * "没改"必须让那个 key **根本不出现**（省略 ≠ 空数组）
 * ══════════════════════════════════════════════════════════════════
 *
 * 省略 = 跟随那个审核者的「行动权限」（权威说明见协议里
 * `SubmitRunRequest.allowedActions` / `Run.allowedActions` 那两段注释）；
 * 给了数组 = 这一次就用这一份。★ 把当前解析出来的那份**原样传过去**是最容易犯的
 * 错：它把一件长期安排**冻结成一次覆盖**，以后在智能体页给这个审核者加了动作，
 * 从这一页建的任务仍然按老那份跑（`reviewerAgentId` 上已经踩过一次同一个坑）。
 *
 * ⚠️ **空数组是合法而且有意义的**："这一次一个动作都不许触发"（判决只能给结论）。
 *    它与"省略"是两件事，所以"一个都不勾"必须发 `[]`，**不能**靠"数组是空的就
 *    省掉"来偷懒——那个偷懒会让使用者的收紧静默失效，而这类任务的产出只是
 *    "看起来正常结束"。
 *    只有一种情况省略是**对的**：审核者那份本来就是空的——那属于"一致"，
 *    `picksMatchReviewer()` 已经把它判掉了。
 */
export function actionsRunField(
  picks: ActionPicks,
  chain: NewTaskChain,
): { allowedActions?: string[] } {
  // ★ 空对象：`JSON.stringify` 之后 `allowedActions` 这个 key 根本不在请求体里。
  if (picksMatchReviewer(picks, chain)) return {}
  return { allowedActions: [...picks] }
}

// ══════════════════════════════════════════════════════════════════════
// ③ 行动 · 固定参数（D43）：与动作白名单同一套"省略 = 跟随"语义
// ══════════════════════════════════════════════════════════════════════
//
// 固定参数与白名单是同一件事的两半（"这一次允许触发什么 + 用什么参数触发"），
// 所以三个函数与上面的 `defaultActionPicks` / `picksMatchReviewer` /
// `actionsRunField` **一一对应**，判据也同一个：
//
//   · 没改 ⇒ `actionParams` 这个 key 根本不出现（省略 = 跟随审核者长期那份）；
//   · 改了 ⇒ 带上这一份（空对象 = 这一次不固定任何参数，是**明确的选择**）。
//
// ⚠️ 把"其实没改"读成"改了"的代价与白名单同一个：长期配置被冻成一次覆盖。

/** 固定参数表单的**默认值**：审核者当前配的那份（可能是 `{}` = 没设）。 */
export function defaultActionParams(
  chain: NewTaskChain,
): Record<string, Record<string, unknown>> {
  return chain.actionParams
}

/**
 * 深比较两份固定参数是否**一致**。
 *
 * 值是 JSON 原始值（string / number / boolean），所以逐项 `!==` 就够；键的
 * 顺序与 `JSON.stringify` 无关——两次 `JSON.stringify` 可能因键序不同而不同，
 * 而"顺序不同"绝不等于"改过"。
 */
export function paramsMatchReviewer(
  params: Record<string, Record<string, unknown>>,
  chain: NewTaskChain,
): boolean {
  const current = chain.actionParams
  const actions = Object.keys(params)
  const currentActions = Object.keys(current)
  if (actions.length !== currentActions.length) return false
  for (const action of actions) {
    if (!(action in current)) return false
    // ⚠️ `noUncheckedIndexedAccess` 下索引取出来可能带 `| undefined`；`in` 判过
    //    存在性之后这里安全（JSON 值里不会有 `undefined` 这种不可序列化的东西）。
    const mine = params[action] as Record<string, unknown>
    const theirs = current[action] as Record<string, unknown>
    const names = Object.keys(mine)
    const currentNames = Object.keys(theirs)
    if (names.length !== currentNames.length) return false
    for (const name of names) {
      if (!(name in theirs)) return false
      if (mine[name] !== theirs[name]) return false
    }
  }
  return true
}

/** 提交时**请求体里写什么**——没改就让 key 根本不出现（省略 ≠ 空对象）。 */
export function paramsRunField(
  params: Record<string, Record<string, unknown>>,
  chain: NewTaskChain,
): { actionParams?: Record<string, Record<string, unknown>> } {
  if (paramsMatchReviewer(params, chain)) return {}
  return { actionParams: params }
}
