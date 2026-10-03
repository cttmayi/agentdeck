<script lang="ts">
  import type { Agent } from '../lib/api.ts'
  import {
    agents,
    identity,
    loadError,
    loading,
    skills,
    tools,
    updateAgent,
    adoptReviewStandard,
  } from '../lib/stores.ts'
  import { showToast } from '../lib/view.ts'
  import { go } from '../lib/view.ts'
  import ActionPicker from './ActionPicker.svelte'
  import { t, tx } from '../lib/i18n.ts'
  import {
    allowedActionsFromLegacyStandard,
    describeAllowedActions,
    effectiveAllowedActions,
    splitAllowedActions,
  } from '../lib/agent-actions.ts'
  /**
   * ★ "它有没有判断依据"那条判据（决定顶上要不要挂红警告）：抽成纯函数放在
   *   `lib/`，由 `agent-identity.test.ts` 钉住——`apps/web` 没有组件级测试，
   *   判据留在标记里就没人守得住（这条判据写错过一次，见下面 `headline`）。
   */
  import { hasReviewIdentity } from '../lib/agent-identity.ts'

  /**
   * 智能体详情 / 编辑（FR-AGENT-19）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这一版重做了**显示**，重点在三件事
   * ══════════════════════════════════════════════════════════════════
   *
   * **① 分组，而不是一长串字段。**
   *    初版把八个字段平铺成一个两列网格（`dl.meta-grid`），于是"角色"这种
   *    一个词的字段和"指令"这种一整段的字段挤在同一种排版里。更糟的是
   *    它们之间**没有层次**——使用者扫完一整屏才知道哪些是一类。
   *    现在分成四组：身份 / 行为 / 关系 / 运行环境。
   *
   * **② 只读与编辑用**同一套骨架**。**
   *    初版的两个视图结构不同（一个是 dl 网格、一个是竖排 label），
   *    点「编辑」之后布局整个重排，眼睛得重新找位置。现在两者共用同样的
   *    分组与字段行，切换时只有"值"变成"输入框"。
   *
   * **③ 字段行统一对齐。**
   *    label 定宽、值左对齐，所有行的值与值在同一个竖线上——这是让一张
   *    配置表"看起来是整理过的"最省力也最有效的一招。初版用
   *    `grid-template-columns: max-content 1fr`，label 宽度随内容变，
   *    竖线是歪的。
   *
   * 顺带清掉了散落的 `style="..."`——它们绕过了设计令牌，是"看起来不齐"
   * 的另一个常见来源。
   *
   * ══════════════════════════════════════════════════════════════════
   * 编辑用 PATCH 语义（这一半没变）
   * ══════════════════════════════════════════════════════════════════
   *
   * 只提交**改动过的**字段。整体提交的话，两个人同时编辑时后保存的会把
   * 前一个的改动抹掉——而这里没有并发控制，减少提交面是最省事的缓解。
   * 而且"只改名字却把指令清空"那种坑也不会发生。
   */
  export let agent: Agent
  export let onclose: () => void
  export let onchanged: () => void

  let editing = false
  let busy = false
  let error = ''
  /** 正在把"来自 skill 的标准"固化到 agent 上（D38 的迁移按钮）。 */
  let adopting = false

  const blankDraft = () => ({
    name: agent.name,
    role: agent.role,
    instructions: agent.instructions,
    skillIds: [...agent.skillIds],
    reviewerAgentId: agent.reviewerAgentId ?? '',
    runtimeKey: agent.runtimeKey,
    workDir: agent.workDir ?? '',
    model: agent.model ?? '',
    // D37：审核标准（只对审核者有意义）
    reviewStandard: agent.reviewStandard ? { ...agent.reviewStandard } : null,
    // D40 收口：行动权限（只对审核者有意义）。★ 初值取**有效值**——老数据那份
    // 写在标准里，从空数组开始的话使用者会看到自己配过的动作全没了。
    allowedActions: effectiveAllowedActions(agent),
    // D43：动作的固定参数（只对审核者有意义）。初值取**自己的**那份（D43 没有
    // "老数据回退"这回事——字段是新的，缺 = 没设）。深拷贝：`params` 在界面上
    // 会被就地改，直接引用 `agent.actionParams` 会改到只读对象上去。
    actionParams: agent.actionParams
      ? JSON.parse(JSON.stringify(agent.actionParams)) as Record<string, Record<string, unknown>>
      : {},
    // ★ 调试动作（2026-09）：自己的那份（缺 = 没设，没有"老数据回退"这回事）。
    debugActions: [...(agent.debugActions ?? [])],
  })

  let draft = blankDraft()

  /**
   * ══════════════════════════════════════════════════════════════════
   * ★ 草稿属于**某一个人**：换 agent 就作废（连编辑态一起退掉）
   * ══════════════════════════════════════════════════════════════════
   *
   * `draft` 是进编辑态时从 `agent` 拷的一份**快照**，而 `Agents.svelte` 是
   * `{#if selected}<AgentDetail agent={selected} …/>{/if}` —— 换一个 agent 时
   * `{#if}` 仍然是真，于是**组件实例被复用**：`agent` 换了，`editing` 还是 true、
   * `draft` 还是**上一个人**的。
   *
   * 两个后果，第二个比第一个严重得多：
   *
   *   ① 段落判据读的是 `draft.role` —— 那是**上一个人**的角色。于是"编辑到一半
   *      换成执行者"，执行者的详情里仍然挂着「行动权限」那一段。
   *      （使用者的原话：「智能体详情，点『编辑』就可以看见」。）
   *   ② 点「保存」会把**上一个人的**名字、指令、角色 PATCH 到这个人身上：
   *      `buildPatch()` 拿 `draft.*` 与**新的** `agent.*` 比，于是这些字段全都
   *      判成"变了"。这是**改错人**，不是显示错。
   *
   * 判据是 `agent.id` —— 不是 `role`、也不是 `name`：同一个人刷新之后还是同一份
   * 草稿（改到一半被 `loadAgents()` 刷一下不该把输入清空），换人才作废。
   *
   * `editing` 一起退回只读：编辑到一半换了对象，继续留在编辑态本身就是个陷阱
   * —— 界面上写着 B 的名字，而每个输入框里都是 A 的内容。
   *
   * ⚠️ 在父组件写 `{#key selected.id}` 也能治，但那是**绕过**：组件自己持有了一份
   *    会过期的拷贝，就该由它自己作废。否则换个地方复用这个组件，同一个坑再来一次。
   */
  let draftOwner = agent.id
  $: if (agent.id !== draftOwner) {
    draftOwner = agent.id
    draft = blankDraft()
    editing = false
    error = ''
  }

  /**
   * 可选的 runtime —— **从身份接口来，不写死**。
   *
   * ★ 原来是两个写死的 `<option value="claude">` / `"generic"`。那意味着
   *   加一个 runtime（描述表一行 + 适配器包 + 装配表一行）之后，**界面上
   *   根本选不到它**——只有直接调接口才行。而"接口支持、界面没有入口"
   *   是这个仓库里最常见的那类缺陷。
   */
  $: runtimeOptions = $identity?.runtimes.map((r) => r.key) ?? []

  /**
   * 该 runtime 的"未验证"提示；已验证 / 还不知道时**不在表里**。
   *
   * ★ 判据是描述表里的 `evidence`，不是 `runtimeKey === 'generic'`。
   *   写死 runtime 名的那种判断，在加入第三个 runtime 时会**静默失效**：
   *   一个未验证的 CLI 会被显示得像验证过一样——而那正是 `evidence`
   *   这个字段存在的理由。
   *
   * ⚠️ 整张表用 `$:` 先算好（D39），而不是在标记里调函数：函数体里读 `$t`
   *    对编译器是**看不见的依赖**——切语言时那几行不会重渲染。表是 `$:`
   *    算出来的，标记里读表就订阅上了。表里没有这个 key（= 不该提示）
   *    时取值是 `undefined`，与原来返回 `null` 的语义一致（都是假值）。
   */
  $: evidenceWarnings = Object.fromEntries(
    ($identity?.runtimes ?? [])
      .filter((r) => r.evidence !== 'verified')
      .map((r) => [r.key, r.evidenceNote ?? $t('agents.evidenceNoteFallback')]),
  ) as Record<string, string>

  function startEdit(): void {
    // 每次进入编辑都重新拷一份——否则上一次取消留下的改动会残留
    draft = blankDraft()
    editing = true
    error = ''
  }

  function cancelEdit(): void {
    editing = false
    error = ''
  }

  /** 只把**真的变了**的字段放进 patch。 */
  function buildPatch(): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    if (draft.name !== agent.name) patch['name'] = draft.name
    if (draft.instructions !== agent.instructions) patch['instructions'] = draft.instructions
    if (draft.role !== agent.role) patch['role'] = draft.role
    if ((draft.workDir || '') !== (agent.workDir ?? '')) patch['workDir'] = draft.workDir
    if ((draft.model || '') !== (agent.model ?? '')) patch['model'] = draft.model
    if (draft.runtimeKey !== agent.runtimeKey) patch['runtimeKey'] = draft.runtimeKey
    if (draft.skillIds.slice().sort().join() !== agent.skillIds.slice().sort().join())
      patch['skillIds'] = draft.skillIds
    if ((draft.reviewerAgentId || null) !== (agent.reviewerAgentId ?? null))
      patch['reviewerAgentId'] = draft.reviewerAgentId || null
    // 标准按值比较（它是对象，直接比引用永远不相等）
    if (JSON.stringify(draft.reviewStandard) !== JSON.stringify(agent.reviewStandard ?? null))
      patch['reviewStandard'] = draft.reviewStandard
    /**
     * 行动权限走**同一个 PATCH**（`allowedActions`），不另开一条接口。
     *
     * ★ 比的是 `agent.allowedActions`（**库里的事实**），不是界面上显示的那份
     *   （那份在老数据上是从标准里回退来的）。理由有一次真实的丢失场景：老数据
     *   的有效值来自 `reviewStandard.allowedActions`，而保存标准时会写成
     *   `{name, body}`——服务端**不写**老字段，于是那份权限会在保存的一瞬间
     *   消失。按事实比较之后，"保存"这件事本身就会把它写进新字段（老数据上的
     *   第一句提示也把这件事说明了），所以那种丢失不会发生。
     *
     * ⚠️ 角色改成执行者时**必须一起清空**：服务端对"执行者带动作"是 400
     *   （执行者的能力是工具），而界面上那段会随角色藏起来——藏起来的勾选若还
     *   原样提交，使用者会撞上一句他没法理解的拒绝。
     */
    const nextActions = draft.role === 'executor' ? [] : draft.allowedActions
    if (
      nextActions.slice().sort().join() !==
      (agent.allowedActions ?? []).slice().sort().join()
    )
      patch['allowedActions'] = nextActions

    /**
     * 固定参数走**同一个 PATCH**（`actionParams`，D43）。
     *
     * 两条规矩：
     *   ① **只送"勾上的动作"的参数**——没勾的动作参数没有落点（服务端按已装
     *      工具校验会放行，但那份固定参数永远不会被用上，还会让"我到底固定了
     *      什么"在界面上失真）。
     *   ② **角色改成执行者时必须一起清空**（与服务端那条 400 对齐）。
     */
    const nextParams: Record<string, Record<string, unknown>> = {}
    if (draft.role === 'reviewer') {
      for (const action of nextActions) {
        if (draft.actionParams[action] && Object.keys(draft.actionParams[action]).length > 0) {
          nextParams[action] = { ...draft.actionParams[action] }
        }
      }
    }
    if (!actionParamsEqual(nextParams, agent.actionParams ?? {}))
      patch['actionParams'] = nextParams

    /**
     * 调试动作走**同一个 PATCH**（`debugActions`，2026-09）。
     *
     * 与固定参数同两条规矩：① 只送**白名单里勾了「调试」**的动作（调试是允许的
     * 子集，服务端也这么校验）；② 角色改成执行者时必须清空（服务端 400）。
     */
    const nextDebug =
      draft.role === 'executor' ? [] : draft.debugActions.filter((a) => nextActions.includes(a))
    if (nextDebug.slice().sort().join() !== (agent.debugActions ?? []).slice().sort().join())
      patch['debugActions'] = nextDebug

    return patch
  }

  /** 深比较两份固定参数（键序无关——键序不同不等于改过）。 */
  function actionParamsEqual(
    a: Record<string, Record<string, unknown>>,
    b: Record<string, Record<string, unknown>>,
  ): boolean {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    for (const action of ka) {
      if (!(action in b)) return false
      // ⚠️ `noUncheckedIndexedAccess` 下索引取出来可能带 `| undefined`；`in` 判过
      //    存在性之后这里安全（JSON 值里不会有 `undefined` 这种不可序列化的东西）。
      const mine = a[action] as Record<string, unknown>
      const theirs = b[action] as Record<string, unknown>
      const na = Object.keys(mine)
      const nb = Object.keys(theirs)
      if (na.length !== nb.length) return false
      for (const name of na) {
        if (!(name in theirs)) return false
        if (mine[name] !== theirs[name]) return false
      }
    }
    return true
  }

  /** 某个动作当前钉的固定参数（空 = 没钉）。模板里用——模板不会做索引窄化。 */
  function fixedEntriesOf(type: string): Array<[string, unknown]> {
    const params = agent.actionParams?.[type]
    return params ? Object.entries(params) : []
  }

  /** 有几处改动——用在保存按钮上，让"要不要保存"一眼可见。 */
  $: changedCount = editing ? Object.keys(buildPatch()).length : 0

  async function save(): Promise<void> {
    const patch = buildPatch()
    if (Object.keys(patch).length === 0) {
      editing = false
      return
    }
    busy = true
    error = ''
    try {
      await updateAgent(agent.id, patch)
      editing = false
      showToast(tx('agents.saved'))
      onchanged()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  $: attached = $skills.filter((s) => agent.skillIds.includes(s.id))
  /**
   * 能挂上去的 skill。
   *
   * ★ 规则是「**现在能选的** ∪ **这个智能体已经挂着的**」，两半都不能少：
   *
   *   · 少了前半 —— 本地目录里读进来的 skill 挂不上；
   *   · 少了后半 —— 使用者取消勾选一个目录之后，那个智能体上挂着的那条会在
   *     这里**消失**。它其实还挂着（能力没被抽走），但界面上看不见，于是
   *     "我明明挂过它"变成了一件无法查证的事，也再也没法在这里把它摘掉。
   *
   * ⚠️ `!== false` 不是 `=== true`：老 daemon 不返回这个字段，按"能选"处理。
   */
  $: pickableSkills = $skills.filter(
    (s) => s.selectable !== false || agent.skillIds.includes(s.id),
  )
  $: reviewers = $agents.filter((a) => a.role === 'reviewer' && a.id !== agent.id)
  $: chosenReviewer = $agents.find((a) => a.id === agent.reviewerAgentId) ?? null
  $: isReviewer = agent.role === 'reviewer'

  /**
   * 行动权限（`Agent.allowedActions`，D40 收口）——**审核者自己的一个字段**。
   *
   * ★ 它原来长在审核标准里面（一组 checkbox）。搬出来之后"按什么判"与"判完允许
   *   动什么"在界面上是**两段**，于是"我改了标准正文"与"我放宽了能动的范围"
   *   分得开——这正是这次搬家的目的。
   *
   * ★ 只读态显示的是**有效值**：`Agent.allowedActions` 为空时回退到
   *   `reviewStandard.allowedActions`（老数据，见 `lib/agent-actions.ts`）。
   *   不回退的话，老工作区的使用者点开审核者会看到一片空白，以为自己配过的
   *   动作丢了。
   */
  $: legacyActions = allowedActionsFromLegacyStandard(agent)
  $: visibleActions = describeAllowedActions(effectiveAllowedActions(agent), $tools)

  /**
   * ══════════════════════════════════════════════════════════════════
   * 老数据那份「审核标准」：**不再有单独一段**，它归到「指令」那一栏里
   * ══════════════════════════════════════════════════════════════════
   *
   * ★ 使用者的要求（原话）：「移除审核智能体的『审核标准』」。这一步之所以能删，
   *   是因为判断依据已经并进 ② 身份（= 那个 agent 的「指令」）：界面上一件事
   *   只该有一个出处，而留一段"标准"只会让人在两个框之间来回搬文字。
   *
   * ⚠️ 但**投递链条上它还在**：老数据的 `Agent.reviewStandard`（以及"正文来自挂载
   *   skill"那种更老的形态）仍然会被执行器合成进 ②（`reviewerIdentity`）。所以
   *   删掉那一段之后必须把这两件事**搬到「指令」那一栏里说清**，否则界面会开始
   *   撒谎：使用者看着一段指令，以为那就是全部依据，而实际投递出去的还多出一段。
   *   这也是"宁可显示得啰嗦，也不静默少一段"的那条老规矩。
   *
   * ★ 一并给出**一步并进来**的按钮（`adopt-from-skills` 那个端点现在也收"内联
   *   老标准"这一种，见下）：原来只有在"正文来自挂载 skill"时才给按钮，于是带
   *   内联老标准的审核者（使用者的库里正好有一个）只能自己抄——而"看得见但搬不动"
   *   正是这次改造要消掉的那种状态。
   *
   * ⚠️ 按钮**只在只读态**出现。编辑态里点它会导致一次数据打架：搬移会在服务端把
   *   `skillIds` 清空，而草稿里还留着旧的那份 ⇒ 接着点「保存」会把挂载又写回去，
   *   于是同一段正文既在「指令」里、又在 skill 里被投递**两遍**（服务端那句注释
   *   说的就是这个）。所以编辑态只提示、不提供入口，并说清去哪儿点。
   */
  $: legacyStandardBody = isReviewer ? (agent.reviewStandard?.body ?? '') : ''
  $: legacyFromSkills = isReviewer && !agent.reviewStandard && attached.length > 0
  /** 这份判断依据还走在老形态上（内联老标准，或来自挂载的 skill）⇒ 可以并进来 */
  $: legacyStandardPending = legacyStandardBody !== '' || legacyFromSkills

  /**
   * ★ 那几行里**哪些是"配过、但现在解析不出来"的**（D41 收尾）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么只读态也必须说这件事
   * ══════════════════════════════════════════════════════════════════
   *
   * 只读那一行显示的是**有效值**（自己的 `allowedActions`，为空时回退到审核标准
   * 里那份老配置）。老配置里的动作名现在可能已经没有出处了：平台的内置动作整组
   * 被移除（`comment.create` 之类再也不是动作），或者提供它的工具包被卸载了。
   *
   * 两种做法都不对：
   *   · **静默过滤掉**——那等于把"配过"这件事抹掉，使用者以为自己的配置丢了；
   *   · **照原样显示、不加标记**——那它与一条真的能触发的动作长得一模一样，
   *     而判到它时运行时会找不到实现。
   * 所以是第三种：**契约值原样留着 + 明说它当前不可用**，并且给出下一步。
   *
   * ⚠️ 判据与编辑态那一栏**同一个函数**（`splitAllowedActions`）：两处对"能不能
   *    解析"的判断必须一致，否则会出现"只读说不可用、编辑里却勾着"这种自相矛盾。
   * ⚠️ 清单没到手（或取失败）时**一个都不标**：那时"解析不出来"无从谈起。
   */
  $: toolsKnown = !$loading['tools'] && !$loadError['tools']
  $: unresolvedTypes = toolsKnown
    ? new Set(splitAllowedActions(effectiveAllowedActions(agent), $tools).unavailable)
    : new Set<string>()

  /**
   * ★ **更老的一层兜底**：动作白名单写在**挂载的 skill** 里（D40 之前更早的形态）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么这一条必须说出来（否则界面看着像坏了）
   * ══════════════════════════════════════════════════════════════════
   *
   * 服务端的解析链是**逐层回退**（不是并集）：`Agent.allowedActions` →（空）
   * `reviewStandard.allowedActions` →（还空）挂载 skill 里的 `allowedActions`。
   * 于是有一种 agent：这一段**一个都没勾**，而它判完**仍然**能触发动作——
   * 那些动作来自它挂着的 skill。使用者看到的就是"勾选坏了"。
   *
   * ★ 判据与真实解析链对齐：**这一行显示出来的那份是空的**（= agent 上没有、
   *   标准里也没有 ⇒ 服务端会走到 skill 那一层），而且**确实挂着 skill**。
   *   `reviewStandard` 那份非空时不提示：那时列表不是空的，句子会说反话。
   *
   * ⚠️ 界面**不**替服务端算"那些 skill 到底带不带动作"（那要看 skill 的老字段，
   *    而 `Skill` 上已经不再有这个字段了）：界面只说明**出处**，不假装自己是
   *    解析器。这也是这段提示用"来自"而不是"允许了 X"的原因。
   */
  $: skillActionsLegacy =
    (agent.allowedActions ?? []).length === 0 &&
    (agent.reviewStandard?.allowedActions ?? []).length === 0 &&
    attached.length > 0

  /**
   * ══════════════════════════════════════════════════════════════════
   * 执行者的详情里**没有**工具那一段了
   * ══════════════════════════════════════════════════════════════════
   *
   * ★ 使用者的要求（原话）：「执行智能体不支持"行动"，去掉」。
   *
   *   他在「智能体」页选「助手」、点「编辑」，看到的是那一栏「可挂载的工具组」。
   *   先撤掉勾选栏，再整段撤掉——**两段都撤的理由不一样**：
   *     ① 勾选栏是"能改"，撤掉之后这一段只剩"能看"；
   *     ② 而"能看"那半截对一个使用者**永远是同一句空话**：`toolIds` 只能由
   *        `PUT /api/agents/:id/tools` 写，而那条接口没有界面、CLI 和 MCP 都
   *        没有入口（查过 `apps/cli`、`apps/mcp`，一处引用都没有）。所以它对他
   *        建的每个智能体都会一直显示"还没挂任何工具"——而"还没"是在许诺一件
   *        界面做不到的事，正是这一轮误解的来源。
   *
   * ★★ **后续（已做完）**：使用者随后定了"不需要挂载，因为我已经移除了此功能"，
   *    于是那条链**整个清掉了**，这一段的"后果"不再是"悬着的事"：
   *      - `Agent.toolIds` 从协议里删除（老数据不用迁移：`Agent` 不是 strict）；
   *      - `PUT /api/agents/:id/tools` 删除；
   *      - `executor.ts` 里"把挂载的脚本送进工作目录"那段与
   *        `syncInjectedTools` / `removeInjectedTools` 一起删除；
   *      - 「工具」页的「被哪些执行者挂载」那一列、以及"卸载被拒"那条分支删除
   *        （卸载现在一律放行——那条拒绝是一把**没有钥匙的锁**：它叫人"去摘掉"，
   *        而摘掉的地方已经不存在了）。
   *
   *    恢复界面入口：把这一段、`{#if editing}` 那个勾选栏，以及上面这一整条链
   *    一起加回来（见 `packages/protocol/src/entities.ts` 里 `Agent` 上那段说明）。
   */

  /**
   * 哪些执行者指向了这个审核者。
   *
   * 这个**反向查询**在看审核者时很有用：审核者是"被动"的一方，光看它自己
   * 的配置看不出它在为谁服务。没有它，一个审核者的详情页会说不出它到底
   * 在审谁——而"我建了这个审核者，它怎么没动静"是最常见的问题。
   */
  $: executorsPointingHere = $agents.filter((a) => a.reviewerAgentId === agent.id)

  /**
   * 摘要里最该被看到的那一处问题——没有就不显示。
   *
   * ⚠️ 审核者那一半的判据**换过**（2026-09）。它原来是
   *   `isReviewer && !agent.reviewStandard && agent.skillIds.length === 0`
   * ——两半都在看**老形态**。而判断依据早已并进 ② 身份（= 那个 agent 的「指令」），
   * 于是一个**完全正常**的审核者（写了指令、没有标准字段、也没挂 skill）会被挂上
   *
   *   「它审不了任何东西：没有审核标准，平台不会把产出交给它审。点「编辑」写一条。」
   *
   * 而它审得好好的。★ 使用者的原话就是「这个提示有问题」。这类"指向一个不存在的
   * 故障"的警告比没有警告更糟：它会让人去找一个不需要修的问题——同一条链路上，
   * 列表里那个「未挂 skill」徽标已经因为同一类过时判据被整段删掉了
   * （见 `views/Agents.svelte`）。
   *
   * ★ 判据现在是纯函数（`lib/agent-identity.ts`）：三种形态（「指令」/ 内联老标准 /
   *   挂载的 skill）都算有依据，只有真的空才算没有。
   */
  $: headline =
    isReviewer && !hasReviewIdentity(agent)
      ? {
          tone: 'bad',
          text: $t('agents.headlineNoInstructions'),
        }
      : !isReviewer && !agent.reviewerAgentId
        ? { tone: 'warn', text: $t('agents.headlineNoReviewer') }
        : null
</script>

<div class="detail">
  <!-- ══════════════ 头部：它是谁 ══════════════ -->
  <header class="hero">
    <div class="hero-main">
      <button type="button" class="ghost small back" onclick={onclose}>{$t('agents.backToList')}</button>

      <div class="hero-title">
        <span class="avatar {agent.role}">{agent.name.slice(0, 1).toUpperCase()}</span>
        <div>
          <h2>{agent.name}</h2>
          <p class="role-line">
            <span class="badge {isReviewer ? 'in_review' : 'in_progress'}">
              {isReviewer ? $t('agents.roleReviewer') : $t('agents.roleExecutor')}
            </span>
            <span class="faint">
              {isReviewer ? $t('agents.roleReviewerHint') : $t('agents.roleExecutorHint')}
            </span>
          </p>
        </div>
      </div>
    </div>

    <div class="hero-actions">
      {#if !editing}
        <button type="button" onclick={startEdit}>{$t('common.edit')}</button>
      {:else}
        <button
          type="button"
          class="secondary"
          onclick={cancelEdit}
          disabled={busy}
          title={busy ? $t('common.busyHint') : undefined}
          >{$t('common.cancel')}</button
        >
        <button type="button" onclick={save} disabled={busy}>
          {busy
            ? $t('common.saving')
            : changedCount > 0
              ? $t('agents.saveWithCount', { count: changedCount })
              : $t('common.save')}
        </button>
      {/if}
    </div>
  </header>

  {#if headline && !editing}
    <div class="notice {headline.tone} headline">{headline.text}</div>
  {/if}

  {#if error}
    <div class="notice bad headline">{error}</div>
  {/if}

  <div class="panes">
    <!-- ══════════════ 它怎么干活 ══════════════ -->
    <section class="section">
      <h3>{$t('agents.sectionBehavior')}</h3>

      {#if editing}
        <div class="field-row">
          <label for="agent-name">{$t('agents.nameLabel')}</label>
          <input id="agent-name" bind:value={draft.name} />
        </div>

        <div class="field-row">
          <span class="row-label">{$t('agents.roleLabel')}</span>
          <div class="role-picker">
            <button
              type="button"
              class="role-card"
              class:active={draft.role === 'executor'}
              onclick={() => (draft.role = 'executor')}
            >
              <strong>{$t('agents.roleExecutor')}</strong><span>{$t('agents.roleExecutorHint')}</span>
            </button>
            <button
              type="button"
              class="role-card"
              class:active={draft.role === 'reviewer'}
              onclick={() => (draft.role = 'reviewer')}
            >
              <strong>{$t('agents.roleReviewer')}</strong><span>{$t('agents.roleReviewerHintShort')}</span>
            </button>
          </div>
        </div>

        <div class="field-row">
          <label for="agent-instructions">{$t('agents.instructionsLabel')}</label>
          <div>
            <!--
              ★ 与 `NewAgentForm.svelte` 里那一栏**同一个字段、同一个要求**（D48）：
                指令是一份几百到上千字的文档，不是一行备注。这里原来是 `rows="4"`
                （约 4 行），于是"新建的时候能读、改的时候读不了"——同一个东西在
                两处给不同的可读性，是最没必要的不一致。
            -->
            <textarea id="agent-instructions" class="instructions" bind:value={draft.instructions} rows="6"></textarea>
            <p class="row-hint">{$t('agents.instructionsHintBefore')}<strong>{$t('agents.instructionsFieldStrong')}</strong>{$t('agents.instructionsHintAfter')}</p>
            {#if legacyStandardPending}
              <!--
                ★ 编辑态**只提示**（按钮在只读态，理由见上面那段注释：搬移会清空
                  `skillIds`，而草稿里还留着旧的那份 ⇒ 保存会把挂载写回去，正文被投递两遍）。
              -->
              <p class="row-hint std-legacy" data-standard-merged data-legacy-standard>
                {$t('agents.standardFoldInEditHint')}
              </p>
            {/if}
          </div>
        </div>
      {:else}
        <div class="field-row">
          <span class="row-label">{$t('agents.instructionsLabel')}</span>
          <div>
            {#if agent.instructions.trim()}
              <p class="prose">{agent.instructions}</p>
            {:else if isReviewer}
              <!-- ★ 审核者的资格判据就是这一条：指令非空。空 ⇒ 拿不到审核任务 -->
              <p class="empty-value" data-no-instructions>
                {$t('agents.noStandardBefore')}<strong>{$t('agents.noStandardStrong')}</strong>{$t('agents.noStandardAfter')}
              </p>
            {:else}
              <p class="empty-value">{$t('agents.noInstructionsHint')}</p>
            {/if}

            <!-- ── 老数据：判断依据还带着一段（内联老标准 / 来自挂载的 skill）── -->
            <!--
              ★ 它显示在**这一栏**里，而不是另开一段：投递时它本来就与指令合成 ②，
                摆在别处会让人以为那是"另一个设置"。
            -->
            {#if legacyStandardBody !== ''}
              <p class="row-hint std-legacy" data-legacy-standard>{$t('agents.standardLegacyNoticeInline')}</p>
              <!-- ⚠️ 这份正文**照旧显示**：它此刻仍然会被合成进 ② 一起投递，
                   藏起来等于让人看不见自己那份判断依据去哪了。 -->
              <details open>
                <summary>{$t('agents.standardBodySummary')}</summary>
                <pre class="tpl-text">{legacyStandardBody}</pre>
              </details>
            {:else if legacyFromSkills}
              <p class="row-hint" data-legacy-standard>{$t('agents.standardLegacyNoticeFromSkill')}</p>
              <p class="row-hint">
                {$t('agents.legacyInlineBefore')}<strong>{$t('agents.legacyInlineStrong')}</strong>{$t('agents.legacyInlineAfter')}
                {#each attached as s, i (s.id)}{i > 0 ? $t('agents.listSeparator') : ''}<code>{s.slug}</code>{/each}{$t('agents.legacyInlineEnd')}
              </p>
            {/if}
            {#if legacyStandardPending}
              <!--
                ★ 一步做完迁移（D38）：把判断依据**原样**并进「指令」（审核者那一段），
                  并摘掉挂载。没有这一步，"卸载那条 skill"会先把审核者变成没依据的
                  状态——而"没依据"意味着平台不再把产出交给它审。
                  解析在服务端做（同一个 `resolveReviewStandard`），前端不重算。
              -->
              <!--
                ★ 2026-10（紧凑性）：按钮不再独占一整行——与下面那句提示
                  并排（flex-wrap 兜底：提示太长时自然换行，按钮留在行首）。
              -->
              <div style="display:flex;align-items:center;gap:var(--sp-2);flex-wrap:wrap">
                <button
                  type="button"
                  class="secondary small"
                  disabled={adopting}
                  title={adopting ? $t('common.busyHint') : undefined}
                  onclick={async () => {
                    adopting = true
                    error = ''
                    try {
                      await adoptReviewStandard(agent.id)
                      showToast(tx('agents.standardAdopted'))
                      onchanged()
                    } catch (err) {
                      error = err instanceof Error ? err.message : String(err)
                    } finally {
                      adopting = false
                    }
                  }}
                >
                  {adopting ? $t('agents.adopting') : $t('agents.adoptStandard')}
                </button>
                <p class="row-hint" style="margin:0">
                  {$t('agents.adoptHintBefore')}<strong>{$t('agents.adoptHintStrong')}</strong>{$t('agents.adoptHintAfter')}
                </p>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </section>

    <!-- ══════════════ 挂载的 skill ══════════════ -->
    <!--
      ★ 原来它与「审核标准」挤在同一段里（那段叫「用什么标准」）。标准搬进「指令」之后，
        这一段只剩下它自己的事：**这个 agent 干活时能翻哪些资料包**。
        审核者挂 skill 是可选的（判断依据在「指令」里），执行者挂 skill 才是常态。
    -->
    <section class="section">
      <h3>{$t('agents.sectionSkills')}</h3>

      {#if editing}
        <div class="field-row">
          <span class="row-label">{$t('agents.attachedSkillsLabel')}</span>
          {#if $skills.length === 0}
            <p class="empty-value">{$t('agents.noSkillsYet')}</p>
          {:else if pickableSkills.length === 0}
            <!-- 库非空、但一条都不能挂：不能复用上面那句"还没有任何 skill" -->
            <p class="empty-value">{$t('agents.noSelectableSkills')}</p>
          {:else}
            <div class="skill-picker">
              {#each pickableSkills as s (s.id)}
                <label class="skill-option">
                  <input type="checkbox" value={s.id} bind:group={draft.skillIds} />
                  <span>
                    <code>{s.slug}</code>
                    <!-- ★ 同 slug 可以有好几条（每个来源目录各一条，实测
                         ~/.claude、~/.codex、~/.cursor 里都有 browser-use）。
                         只显示 slug 的话选择器里会出现三个一模一样的东西，
                         使用者只能靠猜——所以这里要带上它住在哪个目录。 -->
                    {#if s.localDir}
                      <span class="faint small skill-option-from" title={s.localDir}>
                        {$t('agents.skillFromDir', { dir: s.localDir })}
                      </span>
                    {/if}
                  </span>
                </label>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <div class="field-row">
          <span class="row-label">{$t('agents.attachedSkillsLabel')}</span>
          <div>
            {#if attached.length === 0}
              <p class="empty-value">
                {isReviewer ? $t('agents.reviewerNoSkills') : $t('agents.executorNoSkills')}
              </p>
            {:else}
              <div class="chips">
                {#each attached as s (s.id)}
                  <span class="chip"><code>{s.slug}</code><span class="chip-sub">{s.name}</span></span>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </section>

    <!-- ══════════════ 行动权限：判完之后允许做什么（D40 收口）══════════════ -->
    <!--
      ★ 它是**审核者自己的一个字段**（`Agent.allowedActions`），所以是**独立一段**，
        不再挂在「用什么标准」里面。两件事：标准回答"按什么判"，这一段回答"判完
        允许动什么"——分开之后，"我改了标准正文"与"我放宽了能动的范围"在页面上
        与审计里都分得开。

      ★ 这一段**只给审核者**（`{#if isReviewer}`），与下面「工具」那一段只给执行者
        正好对称：执行者的能力是**工具**（它干活时用的），动作是**判完之后**由平台
        执行的——服务端对"执行者带动作"是 400，所以界面不该给出一个必然失败的开关。

        "显示但禁用 + 一句说明"在这里更差：禁用态的控件会让人以为"是我权限不够"
        或者"哪里没配对"，而这在结构上就不是执行者能有的东西；详情页头部已经写着
        "执行者接到任务后动手干活"，再挂一个永远点不动的勾选只会让人多问一次。
        （下面「工具」那一段用的是同一个取舍，两段的手感一致。）

      ⚠️ 老数据（搬走之前动作写在标准里）：只读态显示的是**回退后的那一份**，并且
        明说它来自老配置。少了这句话，使用者会以为"保存之后权限还在不在"是个谜
        ——服务端只写新字段，保存时并不替他把老字段搬过去；而按事实比较的
        `buildPatch()` 会在保存时把它写进新字段（理由见那段注释）。
    -->
    {#if editing ? draft.role === 'reviewer' : isReviewer}
      <section class="section">
        <h3>{$t('agents.sectionActions')}</h3>

        {#if editing}
          <div class="field-row">
            <span class="row-label">{$t('agents.actionsLabel')}</span>
            <div>
              <ActionPicker
                value={draft.allowedActions}
                onchange={(next) => {
                  draft.allowedActions = next
                  draft = { ...draft }
                }}
                params={draft.actionParams}
                onparams={(next) => {
                  draft.actionParams = next
                  draft = { ...draft }
                }}
                debug={draft.debugActions}
                ondebug={(next) => {
                  draft.debugActions = next
                  draft = { ...draft }
                }}
              />
              {#if legacyActions}
                <p class="row-hint">{unresolvedTypes.size > 0 ? $t('agents.actionsLegacyNoteUnresolved') : $t('agents.actionsLegacyNote')}</p>
              {/if}
            </div>
          </div>
        {:else}
          <div class="field-row">
            <span class="row-label">{$t('agents.actionsLabel')}</span>
            <div>
              {#if visibleActions.length === 0}
                {#if $tools.length === 0 && !skillActionsLegacy}
                  <!--
                    ★ D41 的空态：**一个工具包都没装**，而动作只能来自装进来的包
                      ⇒ 现在真的没有任何动作可以授权。这句话与编辑态那一栏的空态是
                      同一个口径（`ActionPicker.svelte`），只是这里不能勾、只能看。

                    ⚠️ 不能只说「一个都没有」：那一句在老现实里意味着"这个人还很保守"，
                      而现在是"整个平台此刻没有可授权的动作"——两件事的下一步不一样
                      （一个去勾，一个去装包），所以必须分开说。
                  -->
                  <!--
                    ★ 2026-10（紧凑性）：原来「去『工具』页装一个」按钮独占一行
                    ——并进空态文字做行内 CTA，省掉一整行。
                  -->
                  <p class="empty-value">
                    <strong>{$t('agents.actionsNoToolsStrong')}</strong>{$t('agents.actionsNoToolsHint')}
                    <button
                      type="button"
                      class="secondary small"
                      style="margin-left:var(--sp-2)"
                      onclick={() => go('tools')}
                    >
                      {$t('agents.actionsGoTools')}
                    </button>
                  </p>
                {:else}
                  <!-- ⚠️ 老数据（动作来自挂载的 skill）时**不说**"只报告、不动作"：
                       那句话此刻是**假的**——列表空是因为白名单住在 skill 里。下面
                       那条提示会说清出处，所以这里只留"一个都没有"这个事实。 -->
                  <p class="empty-value">
                    <strong>{$t('agents.noActionsStrong')}</strong>{#if !skillActionsLegacy}{$t('agents.noActionsHint')}{/if}
                  </p>
                {/if}
              {:else}
                <!-- 契约值（`<包 slug>.<动作名>`）原样显示、不翻译：
                     判决里写的就是这一串。动作后面跟它的 `summary`（D41 之后内置动作整组没有了，所以这里列出的每一条都来自某个已装工具包）——
                     只给机器名的话，没人知道这一条到底允许干什么。 -->
                <div class="chips">
                  {#each visibleActions as item (item.type)}
                    <span class="chip">
                      <code>{item.type}</code>
                      {#if item.summary}
                        <span class="chip-sub">{item.summary}</span>
                      {:else if unresolvedTypes.has(item.type)}
                        <!-- ★ 配过、但现在没有出处：契约值照原样留着（那是"配过"的
                             证据），旁边明说它当前不可用——不能让它看着还能用。 -->
                        <span class="chip-sub bad">{$t('agents.actionsUnresolvedChip')}</span>
                      {/if}
                      {#if fixedEntriesOf(item.type).length > 0}
                        <span class="chip-sub fixed"
                          >{$t('tools.paramFixedChip')}:
                          {#each fixedEntriesOf(item.type) as [name, value] (name)}
                            <code>{name}={value as string | number | boolean}</code>
                          {/each}
                        </span>
                      {/if}
                      {#if (agent.debugActions ?? []).includes(item.type)}
                        <span class="chip-sub debug">{$t('agents.actionsDebug')}</span>
                      {/if}
                    </span>
                  {/each}
                </div>
                {#if unresolvedTypes.size > 0}
                  <!-- 解释放在 chips **外面**：进 `.chips` 就成了一个"胶囊" -->
                  <p class="row-hint warn">{$t('agents.actionsUnresolvedHint')}{$t('agents.actionsUnresolvedFixReadOnly')}</p>
                {/if}
              {/if}
              {#if legacyActions}
                <p class="row-hint">{unresolvedTypes.size > 0 ? $t('agents.actionsLegacyNoteUnresolved') : $t('agents.actionsLegacyNote')}</p>
              {/if}
            </div>
          </div>
        {/if}

        <!--
          ★ 老数据里**更早的一层**：动作白名单写在挂载的 skill 里（见 `skillActionsLegacy`）。
            这一句就放在「行动权限」这一段的**下面**——使用者正是在这里看到"一个都
            没勾"的，提示放到别处等于没放。词条里那句"勾选上面那一段「行动权限」"
            指的就是上面那一栏。

          ⚠️ 它与标准那一段里的老提示（"沿用挂载的 skill 当标准"）说的是**两件事**：
            那条讲判断依据的出处，这条讲动作权限的出处。两条同时出现是对的。
        -->
        {#if skillActionsLegacy}
          <p class="row-hint">
            {$t('agents.legacySkillActionsBefore')}
            {#each attached as s, i (s.id)}{i > 0 ? $t('agents.listSeparator') : ''}<code>{s.slug}</code>{/each}
          </p>
        {/if}
      </section>
    {/if}

    <!-- ══════════════ 与其他智能体的关系 ══════════════ -->
    <section class="section">
      <h3>{$t('agents.sectionRelations')}</h3>

      {#if editing}
        {#if draft.role === 'executor'}
          <div class="field-row">
            <label for="agent-reviewer">{$t('agents.reviewerFieldLabel')}</label>
            <div>
              <select id="agent-reviewer" bind:value={draft.reviewerAgentId}>
                <option value="">{$t('agents.noAutoReview')}</option>
                {#each reviewers as r (r.id)}
                  <option value={r.id}>{r.name}</option>
                {/each}
              </select>
              <p class="row-hint">
                {$t('agents.reviewerHintDetail')}
              </p>
            </div>
          </div>
        {:else}
          <div class="field-row">
            <span class="row-label">{$t('agents.reviewerFieldLabel')}</span>
            <p class="empty-value">
              {$t('agents.reviewerNotApplicableBefore')}<strong>{$t('agents.reviewerNotApplicableStrong')}</strong>{$t('agents.reviewerNotApplicableAfter')}
            </p>
          </div>
        {/if}
      {:else if isReviewer}
        <div class="field-row">
          <span class="row-label">{$t('agents.reviewsWhoLabel')}</span>
          <div>
            {#if executorsPointingHere.length === 0}
              <p class="empty-value">
                {$t('agents.noExecutorsPointing')}
              </p>
            {:else}
              <div class="chips">
                {#each executorsPointingHere as e (e.id)}
                  <span class="chip">{e.name}</span>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {:else}
        <div class="field-row">
          <span class="row-label">{$t('agents.reviewerFieldLabel')}</span>
          <div>
            {#if chosenReviewer}
              <strong>{chosenReviewer.name}</strong>
              <p class="row-hint">{$t('agents.reviewerChosenHint')}</p>
            {:else if agent.reviewerAgentId}
              <span class="bad">{$t('agents.reviewerGoneWithId', { id: agent.reviewerAgentId })}</span>
            {:else}
              <p class="empty-value">
                {$t('agents.noReviewerChosen')}
              </p>
            {/if}
          </div>
        </div>
      {/if}
    </section>

    <!-- ══════════════ 运行环境 ══════════════ -->
    <section class="section">
      <h3>{$t('agents.sectionRuntime')}</h3>

      {#if editing}
        <div class="field-row">
          <label for="agent-runtime">{$t('agents.runtimeRowLabel')}</label>
          <div>
            <select id="agent-runtime" bind:value={draft.runtimeKey}>
              {#each runtimeOptions as key (key)}
                <option value={key}>{key}</option>
              {/each}
              {#if !runtimeOptions.includes(draft.runtimeKey)}
                <!-- 身份还没到（或这个 runtime 已被摘掉）：把当前值显示出来。
                     少了这一支，select 会静默落到第一项 —— 那等于偷偷改了
                     这个 agent 的 runtime。 -->
                <option value={draft.runtimeKey}>{$t('agents.runtimeCurrent', { key: draft.runtimeKey })}</option>
              {/if}
            </select>
            {#if evidenceWarnings[draft.runtimeKey]}
              <p class="row-hint warn">{evidenceWarnings[draft.runtimeKey]}</p>
            {/if}
          </div>
        </div>

        <div class="field-row">
          <label for="agent-model">{$t('agents.modelLabel')}</label>
          <div>
            <input id="agent-model" bind:value={draft.model} placeholder={$t('agents.modelPlaceholder')} />
          </div>
        </div>

        <div class="field-row">
          <label for="agent-workdir">{$t('agents.workDirLabel')}</label>
          <div>
            <input id="agent-workdir" bind:value={draft.workDir} placeholder={$t('agents.workDirPlaceholder')} />
            <p class="row-hint">
              {$t('agents.workDirHint')}
            </p>
          </div>
        </div>
      {:else}
        <div class="field-row">
          <!--
            ⚠️ 这里原来硬编码着 `runtime`（编辑态的同一栏 906 行早就走词表了）：
            只读态与编辑态是同一个字段的两张面孔，没有理由一边说人话、一边留
            英文内部叫法（2026-09）。
          -->
          <span class="row-label">{$t('agents.runtimeRowLabel')}</span>
          <div>
            <code>{agent.runtimeKey}</code>
            {#if evidenceWarnings[agent.runtimeKey]}
              <span class="warn small">{evidenceWarnings[agent.runtimeKey]}</span>
            {/if}
          </div>
        </div>

        <div class="field-row">
          <span class="row-label">{$t('agents.modelLabel')}</span>
          <span class:empty-value={!agent.model}>{agent.model ?? $t('agents.cliDefault')}</span>
        </div>

        <div class="field-row">
          <span class="row-label">{$t('agents.workDirLabel')}</span>
          {#if agent.workDir}
            <code class="path">{agent.workDir}</code>
          {:else}
            <span class="empty-value">{$t('agents.autoWorkDir')}</span>
          {/if}
        </div>
      {/if}
    </section>
  </div>
</div>

<style>
  /* ══════════════════════════════════════════════════════════════════
     布局
     ══════════════════════════════════════════════════════════════════

     ⚠️ 2026-09：**不再设 `max-width`**（原来钉死 52rem）。任务详情那一栏是
     占满右栏的，而智能体详情被那条上限卡在 832px——宽窗口下右栏右侧空出
     一大片（1920 宽实测 400px+），使用者报「主区不满屏」。去掉之后：
        · `.field-row` 的值列本来就是 `minmax(0, 1fr)`，直接跟着撑满；
        · 长文字（指令 / 提示）由各自的 `46ch` 上限管着，不会拉成整屏长行；
        · label 定宽 9rem 不变，值列起点不变，行对齐不受影响。
     与任务的详情栏保持同一套行为。 */
  .detail {
    min-width: 0;
  }

  /* ── 头部 ── */

  .hero {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-4);
    /* D69.15.2 与任务/聊天栏头同款通栏：hero 在 pane-body 里，用负边距抵消
       pane-body 的留白（与裁决条 `.decide-bar` 同一模式）——头与栏顶对齐、
       分隔线横贯整栏（否则缩在 24px 留白里，比任务/聊天栏头窄 48px）。
       padding 补回内容留白（顶/左右），位置与任务/聊天标题一致（y=68, x=681）。 */
    /* D69.15.2 与任务/聊天栏头同款通栏：hero 在 pane-body 里，用负边距抵消
       pane-body 的留白（与裁决条 `.decide-bar` 同一模式）——头与栏顶对齐、
       分隔线横贯整栏（否则缩在 24px 留白里，比任务/聊天栏头窄 48px）。
       padding 补回内容留白（顶/左右），位置与任务/聊天标题一致（y=68, x=681）。 */
    margin: calc(-1 * var(--sp-4)) calc(-1 * var(--sp-5)) 0;
    padding: var(--sp-4) var(--sp-5) var(--sp-4);
    border-bottom: 1px solid var(--line);
  }

  .back {
    padding-left: 0;
    margin-bottom: var(--sp-3);
  }

  .hero-title {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
  }

  /* 头像用角色着色：一眼能分出"审的"和"干的"，比读文字快 */
  .avatar {
    width: 2.5rem;
    height: 2.5rem;
    flex: none;
    border-radius: var(--radius);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--fs-lg);
    font-weight: 600;
    color: #fff;
    background: var(--accent-dim);
  }

  .avatar.reviewer {
    background: #5b4a86;
  }

  .hero-title h2 {
    /* D69.15：栏头标题统一 fs-lg——全局 h2 是 fs-xl（22px），聊天/列表栏头
       都是 fs-lg（17px），这里不钉字号标题就比别的栏头大一圈 */
    margin: 0 0 2px;
    font-size: var(--fs-lg);
  }

  .role-line {
    margin: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }

  .hero-actions {
    display: flex;
    gap: var(--sp-2);
    flex: none;
  }

  .headline {
    margin-bottom: var(--sp-3);
  }

  /* ── 分组 ── */

  .panes {
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
  }

  .section h3 {
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    font-weight: 600;
    margin-bottom: var(--sp-1);
    padding-bottom: var(--sp-2);
    border-bottom: 1px solid var(--line);
  }

  /**
   * ★ 字段行：label 定宽、值左对齐。
   *
   * 这是让一张配置表"看起来是整理过的"最省力也最有效的一招——
   * 所有行的值都落在同一条竖线上。初版用 `max-content` 让 label 宽度
   * 随内容变，于是那条竖线是歪的，整片看起来就"没对齐"。
   */
  .field-row {
    display: grid;
    /* ⚠️ 右列必须是 `minmax(0, 1fr)`，不能是 `1fr`：网格项的默认 `min-width:auto`
       会让**固有宽度大的内容**（D44 那个"左选右配"的 ActionPicker 就是）把这一列
       顶出容器——实测 picker 950px 撑破了 725px 的 `.field-row`，内容溢出到栏外。 */
    grid-template-columns: 9rem minmax(0, 1fr);
    gap: var(--sp-4);
    align-items: start;
    padding: var(--sp-3) 0;
  }

  .field-row + .field-row {
    border-top: 1px solid var(--line);
  }

  .row-label,
  .field-row > label {
    color: var(--text-faint);
    font-size: var(--fs-sm);
    /* 与右侧首行文字对齐：右侧多是 fs-base，行高不同会让 label 看起来偏高 */
    padding-top: 2px;
  }

  /* ── 值的呈现 ── */

  .prose {
    margin: 0;
    white-space: pre-wrap;
    color: var(--text-dim);
    /* ⚠️ 2026-09：**不再限宽**（原来 `max-width: 46ch` ≈ 23 个汉字/行）。右栏
       撑满之后，指令正文还被卡在 406px 会让文字在行中间就换行、右侧空一大片
       （使用者报「指令显示的文字中间就被换行了」）。去掉上限后它填满值列：
       作者自己写的换行由 `pre-wrap` 保留，超长行按容器宽度折行。 */
  }

  .empty-value {
    margin: 0;
    color: var(--text-faint);
    font-size: var(--fs-sm);
  }

  .row-hint {
    margin: var(--sp-2) 0 0;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    max-width: 46ch;
  }

  /**
   * 指令输入框：要能读完一份 800 字的角色设定（D48）。
   *
   * 22rem = 352px 是实测值（13px 字号 / 行高 1.6 ⇒ 16 行），与
   * `NewAgentForm.svelte` 里那一份**必须一致**。
   *
   * ⚠️ 两个文件里各有一份这个规则，因为 Svelte 的 `<style>` 默认**不外泄**，
   *    两个组件没法共用一条作用域规则（提到全局 `app.css` 也不对：那里放的是
   *    通用元素样式，不是某一个字段的高度）。所以只能靠注释互相指认。
   */
  .instructions {
    min-height: 22rem;
    line-height: 1.6;
    resize: vertical;
  }

  .path {
    word-break: break-all;
  }

  /* ── skill 标签 ── */

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }

  .chip {
    display: inline-flex;
    align-items: baseline;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-3);
    border: 1px solid var(--line-strong);
    border-radius: 100px;
    background: var(--surface);
    font-size: var(--fs-sm);
  }

  .chip-sub {
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }

  /* 固定参数（D43）：与「已固定」chip 同一条可视语言——它也是"这个动作
     执行时用的值"的一部分，只是模型不许碰（平台注入）。 */
  .chip-sub.fixed {
    color: var(--accent);
    display: inline-flex;
    align-items: baseline;
    gap: var(--sp-1);
  }

  /* 调试（2026-09）：不抢「固定参数」的存在感——它是"这条动作不真跑、只看
     参数"的标记，用弱一点的颜色与不加边框表示"不是日常状态" */
  .chip-sub.debug {
    color: var(--text-dim);
    border: 1px dashed var(--line-strong);
    border-radius: 999px;
    padding: 0 6px;
    white-space: nowrap;
  }

  /* ── 编辑控件 ── */

  .skill-picker {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
    gap: var(--sp-1);
    max-height: 11rem;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2);
    background: var(--bg);
  }

  .skill-option-from { margin-left: var(--sp-1); }
  .skill-option {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0;
    cursor: pointer;
    font-size: var(--fs-sm);
  }

  .skill-option input {
    width: auto;
    margin: 0;
  }

  /* 原来这里有一组 `.tool-picker / .tool-option / .tool-save` 的规则，给执行者
     详情里那个「可挂载的工具组」勾选栏用。整段撤掉之后一并删了——留着就是给
     不存在的 DOM 写样式。 */

  /* 角色选择：两个等宽卡片。这是"选边"的决定，值得占视觉重量 */
  .role-picker {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-2);
  }

  .role-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
    text-align: left;
    padding: var(--sp-3);
    background: var(--bg);
    border: 1px solid var(--line-strong);
    color: var(--text-dim);
  }

  .role-card strong {
    color: var(--text);
    font-size: var(--fs-md);
  }

  .role-card span {
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }

  .role-card.active {
    border-color: var(--accent);
    background: var(--surface-2);
  }

  .role-card.active strong {
    color: var(--accent);
  }
</style>
