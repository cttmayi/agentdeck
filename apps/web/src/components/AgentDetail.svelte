<script lang="ts">
  import type { Agent, MemoryEntryView } from '../lib/api.ts'
  import {
    agents,
    identity,
    loadError,
    loading,
    skills,
    tools,
    deleteAgent,
    loadAgents,
    loadSkills,
    updateAgent,
  } from '../lib/stores.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import { t, tx } from '../lib/i18n.ts'
  // ★ 分批第 208 批：起草者的「沉淀用技能」可以从**这一页**直接装（使用者定：安装入口留两处，
  //   另一处是「沉淀设置」）。装的是同一个上游地址，走的是同一个接口。
  import { api } from '../lib/api.ts'
  import { DISTILLY_SOURCE } from '../lib/crystallize-editor.svelte.ts'
  import { showToast } from '../lib/view.ts'
  import ChatMemoryTidy from './ChatMemoryTidy.svelte'

  /**
   * 智能体详情 / 编辑（FR-AGENT-19）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这一版重做了**显示**，重点在三件事
   * ══════════════════════════════════════════════════════════════════
   *
   * ★ 2026-10（使用者拍板）：**没有预览页了**——选中即编辑，与智能体组页同款。
   *   没有 hero 头、没有「编辑」按钮、没有查看/编辑两态：右栏进来就是一张
   *   可编辑的卡片（两列网格，对齐「新建私有」），保存 / 取消在底部。
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

  let busy = false
  let error = ''

  /** 正在装「沉淀用技能」（防连点）。 */
  let installingSkill = false

  /**
   * ★ 分批第 208 批（使用者定：**安装入口留两处**——「沉淀设置」与本页）：
   * 从起草者这一格直接装它该挂的那条技能。装完 daemon 会**自动把它挂到起草者身上**
   * （`syncDrafterSkillMount`），所以这里只要重读列表即可。
   */
  async function installDrafterSkill(): Promise<void> {
    if (installingSkill) return
    installingSkill = true
    try {
      await api('/api/skills/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // ⚠️ `source` 是**对象**（`{kind:'url', url}`）；传字符串会被 400 拒
        body: JSON.stringify({ source: { kind: 'url', url: DISTILLY_SOURCE } }),
      })
      await Promise.all([loadAgents(), loadSkills()])
      showToast($t('agents.skillInstallDone'))
    } catch (err) {
      showToast($t('agents.skillInstallFailed', { error: String(err instanceof Error ? err.message : err) }))
    } finally {
      installingSkill = false
    }
  }

  /**
   * ★ 分批第 207 批：起草者**应该挂**的那条技能的 slug（`distilly`）。
   * 从 `/api/identity` 拿，不在前端硬编码——两处写同一个 slug，迟早漂。
   * 老 daemon 不带这个字段 ⇒ 退化成"未安装"的通用说法（不编名字）。
   */
  $: expectedDrafterSkill = $identity?.drafterSkillSlug ?? ''

  const blankDraft = () => ({
    name: agent.name,
    role: agent.role,
    instructions: agent.instructions,
    skillIds: [...agent.skillIds],
    // ⚠️ 2026-10（使用者的决定）：`reviewerAgentId` / `model` / `workDir` 不再进
    // 编辑草稿——这三个"执行者设定"从界面上整段拿掉了（审核走智能体组；模型用
    // CLI 默认；工作目录是任务级的）。协议字段原样保留，老数据继续有效。
    runtimeKey: agent.runtimeKey,
    /**
     * ★ 分批第 245 批：记忆功能的总开关。
     *
     * ⚠️ 缺省（老记录没有这个键）= **开**：`agent.memoryEnabled !== false`。
     *    写成 `=== true` 会让所有现存智能体在这一版之后"打开页面就显示关着"，
     *    而它们的记忆其实一直在用——那种不一致比没有开关更糟。
     */
    memoryEnabled: agent.memoryEnabled !== false,
    // D37：审核标准（只对审核者有意义）
    reviewStandard: agent.reviewStandard ? { ...agent.reviewStandard } : null,
    // ⚠️ 2026-10：这里原来还有行动权限那三个（`allowedActions` / `actionParams` /
    //    `debugActions`）。整个能力从 agent 上撤掉了（它在**组**上，见 `blankDraft`
    //    上面那段编辑语义的说明与表单里那一句指路），草稿里不再有它们——留着只会
    //    让 `buildPatch` 把它们写进一个必然被 400 的请求里。
  })

  /**
   * ★ 分批第 240 批：**记忆的草稿**。
   *
   * 它与 `draft` 一样是"进这一页时拍的一张表"，但**逐条**：每条有自己的 key、
   * 原 id（新加的是 `null`）、正文、类型、置顶、以及"待删除"标记。
   * 保存时它被折算成**差量**（`add` / `remove` / `pin`）——服务端的记忆存储是
   * append-only 的，"改"= 新增一条 + 删掉旧的（不是原地改）。
   *
   * ⚠️ 为什么要一张本地表而不是直接改 `agent.memory`：这一页的写语义是
   *    **表单 + 保存**（与「指令」一致）。逐条即时写会让这一页出现两套写语义，
   *    而"改了没保存"与"保存了没改"都会变得说不清。
   */
  interface MemRow {
    /** 本地稳定 key（`agent.memory` 的 id，或新加时生成的临时串）。 */
    key: string
    /** 库里的 id；`null` = 这一条是本页新加的（保存时进 `add`）。 */
    id: string | null
    kind: 'preference' | 'fact' | 'lesson' | 'commitment'
    text: string
    pinned: boolean
    /** 进这一页时就是这样（用来算差量：只把**真的变了**的放进 patch）。 */
    origPinned: boolean
    /** 被"改"替换/被删掉的旧条目：保存时进 `remove`，界面上划掉。 */
    drop: boolean
  }

  function memoryRows(source: readonly MemoryEntryView[] | undefined): MemRow[] {
    return (source ?? []).map((m) => ({
      key: m.id,
      id: m.id,
      kind: m.kind,
      text: m.text,
      pinned: m.pinned,
      origPinned: m.pinned,
      drop: false,
    }))
  }

  let memRows = memoryRows(agent.memory)
  /** 新加一条用的输入框（类型 + 正文）。 */
  let memNewKind: MemRow['kind'] = 'fact'
  let memNewText = ''
  /** 「预览第一句话」抽屉：`null` = 关着。 */
  let memPreview: string | null = null
  /** 这一轮带进去几条 / 裁掉几条（服务端算的，与真的投递同一个函数）。 */
  /**
   * ★ 分批第 266 批：不再有"被裁掉的条数"（字数预算去掉了，全部带上）。
   *   还留 `chars` 与 `pinned`：它们说明"这一块现在多大、里面几条是置顶的"，
   *   记忆变长时人能看见代价。
   */
  let memPreviewStats: { used: number; chars: number; pinned: number } | null = null
  let memPreviewBusy = false
  /**
   * ★ 分批第 269 批（使用者："只是先要有类似任务和聊天那页的 Title 顶栏"）：
   *   名字移到**标题栏**，改名就在那儿就地改（与聊天页的「改名」同一个做法）。
   *
   * ⚠️ 卡片里那个「名称」输入框删掉了：同一个值有两个输入点，迟早出现"标题写一个、
   *   卡片里是另一个"，而没人能说清哪个才算数。
   */
  let renaming = false
  /** 改名的草稿（点「改名」时从库里那份起，**不是**从 draft 起——draft 可能已经有别的改动）。 */
  let renameValue = ''

  function startRename(): void {
    renameValue = draft.name
    renaming = true
  }
  /** 提交：只落进草稿，**不写库**（与卡片里其它字段一致：点「保存」才生效）。 */
  function commitRename(): void {
    const next = renameValue.trim()
    if (next !== '') draft.name = next
    renaming = false
  }
  /** ★ 第 260 批：「合并同类」对话框（读它的全部记忆，同义的并成一条）。 */
  let consolidateOpen = false
  let memPreviewError = ''
  let memSeq = 0
  /**
   * ★ 分批第 253 批：标记了但**还没保存**的条数。
   *
   * 「删」不是立刻删——它是"划掉 + 点保存才生效"（与「指令」同一套写语义）。这一点
   * 不写出来就是个坑：使用者点了删、看到卡片还在，就会以为按钮坏了（实测就是这么报的）。
   */
  $: memDroppedCount = memRows.filter((r) => r.drop && r.id !== null).length
  $: memAddedCount = memRows.filter((r) => !r.drop && r.id === null && r.text.trim() !== '').length
  $: memPending = memDroppedCount > 0 || memAddedCount > 0

  /** 记忆脏了没有（只为了禁用/启用"保存"与提示）。 */
  $: memDirty =
    memRows.some((r) => r.drop || r.id === null || r.pinned !== r.origPinned) ||
    memRows.some((r) => {
      const orig = (agent.memory ?? []).find((m) => m.id === r.id)
      return r.id !== null && orig !== undefined && orig.text !== r.text
    })

  const MEMORY_KINDS_UI = ['commitment', 'preference', 'fact', 'lesson'] as const

  /** 界面上"活着"的那些行（被"改"替换掉或被删的旧行不列）。 */
  $: activeMemRows = memRows.filter((r) => !r.drop)
  /** 记住失败（超上限 / 正文太长）时的原话——服务端说的，不自己编。 */
  let memError = ''

  function memMetaFor(row: MemRow): string {
    const orig = (agent.memory ?? []).find((m) => m.id === row.id)
    if (orig === undefined) return $t('agents.memoryMetaNew')
    const used = orig.useCount === 0 ? $t('agents.memoryNeverUsed') : $t('agents.memoryUsed', { n: String(orig.useCount) })
    return used
  }

  /** 悬停里给全文 + 出处（界面上那一行只说正文，出处**不进视线**）。 */
  function memTitleFor(row: MemRow): string {
    const orig = (agent.memory ?? []).find((m) => m.id === row.id)
    const lines = [row.text]
    if (orig !== undefined) lines.push(memMetaFor(row))
    if (orig?.evidence !== undefined && orig.evidence !== '') {
      lines.push($t('agents.memoryEvidence', { run: orig.evidence.slice(0, 6) }))
    }
    return lines.join('\n')
  }

  /**
   * ★ 分批第 253 批（使用者报："记忆我点『删』，没有反应"）：**必须整份重赋值**。
   *
   * 这一页是 legacy 反应式（`$:`），就地改 `row.drop = true` **不会**触发重渲染：
   * 点了「删」数据其实变了、界面纹丝不动。同一个坑在「★ 置顶」上也在（点了星不亮）。
   * 「改」之所以看起来正常，是因为它紧接着**重新赋值了 `memRows`**（顺带把划掉那一行
   * 也画了出来）——也就是说，一个 bug 被另一个副作用暂时遮住了。
   *
   * 判据：改数组里的一项，就要给 `memRows` 一个新数组。
   */
  function patchRow(key: string, next: Partial<MemRow>): void {
    memRows = memRows.map((r) => (r.key === key ? { ...r, ...next } : r))
    memError = ''
  }

  function togglePin(row: MemRow): void {
    patchRow(row.key, { pinned: !row.pinned })
  }

  function addRow(): void {
    const text = memNewText.trim()
    if (text === '') return
    memSeq += 1
    memRows = [
      ...memRows,
      {
        key: `new-${memSeq}`,
        id: null,
        kind: memNewKind,
        text,
        pinned: false,
        origPinned: false,
        drop: false,
      },
    ]
    memNewText = ''
    memError = ''
  }

  /**
   * 「改」= **新增一条 + 删掉旧的那条**。
   *
   * 所以这里做两件事：把旧行标成 `drop`（保存时进 `remove`，界面上划掉），
   * 再补一条**预填原文**的新行（保存时进 `add`）——人改的是这条新的。
   * 为什么不是原地改：记忆是 append-only 的记录，"这条被换掉过"本身是可查的事实。
   */
  function editRow(row: MemRow): void {
    // 先划掉旧的（`patchRow` 会重赋值——别只改 `row.drop`，见上面那段注释）
    patchRow(row.key, { drop: true })
    memSeq += 1
    memRows = [
      ...memRows,
      {
        key: `new-${memSeq}`,
        id: null,
        kind: row.kind,
        text: row.text,
        pinned: row.pinned,
        origPinned: false,
        drop: false,
      },
    ]
    memError = ''
  }

  function removeRow(row: MemRow): void {
    patchRow(row.key, { drop: true })
  }

  /** 把"划掉"的那一行放回原样（**保存前**才有意义——保存之后它就真的删了）。 */
  function undropRow(row: MemRow): void {
    patchRow(row.key, { drop: false })
  }

  /**
   * 预览第一句话（**只读**）：问服务端用**这个 agent 已保存的**指令与记忆渲染一次 ②。
   *
   * ⚠️ 它预览的是**库里的那一份**，不是界面上的草稿——预览与投递必须同一个来源，
   *   否则"我看到的"与"它会收到的"就是两件事。草稿改完点保存，再看这里。
   */
  async function openMemoryPreview(): Promise<void> {
    if (memPreviewBusy) return
    memPreviewBusy = true
    memPreviewError = ''
    try {
      const res = await api<{
        text: string
        memoryUsed?: number
        memoryChars?: number
        memoryPinned?: number
      }>('/api/first-sentence/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'execute', block: 'identity', agentId: agent.id }),
      })
      memPreview = res.text
      memPreviewStats =
        res.memoryUsed === undefined
          ? null
          : {
              used: res.memoryUsed,
              chars: res.memoryChars ?? 0,
              pinned: res.memoryPinned ?? 0,
            }
    } catch (err) {
      memPreviewError = err instanceof Error ? err.message : String(err)
    } finally {
      memPreviewBusy = false
    }
  }

  type Draft = ReturnType<typeof blankDraft>
  let draft = blankDraft()

  /**
   * ══════════════════════════════════════════════════════════════════
   * 草稿属于**某一个人**：换 agent 就作废
   * ══════════════════════════════════════════════════════════════════
   *
   * `draft` 是进详情时从 `agent` 拷的一份**快照**，而 `Agents.svelte` 是
   * `{#if selected}<AgentDetail agent={selected} …/>{/if}` —— 换一个 agent 时
   * `{#if}` 仍然是真，于是**组件实例被复用**：`agent` 换了，`draft` 还是
   * **上一个人**的。点「保存」会把**上一个人的**名字、指令、角色 PATCH 到
   * 这个人身上（`buildPatch()` 拿 `draft.*` 与**新的** `agent.*` 比，于是这些
   * 字段全都判成"变了"）。这是**改错人**，不是显示错。
   *
   * 判据是 `agent.id` —— 不是 `role`、也不是 `name`：同一个人刷新之后还是同一份
   * 草稿（改到一半被 `loadAgents()` 刷一下不该把输入清空），换人才作废。
   *
   * ⚠️ 在父组件写 `{#key selected.id}` 也能治，但那是**绕过**：组件自己持有了一份
   *    会过期的拷贝，就该由它自己作废。否则换个地方复用这个组件，同一个坑再来一次。
   */
  let draftOwner = agent.id
  $: if (agent.id !== draftOwner) {
    draftOwner = agent.id
    draft = blankDraft()
    error = ''
    memRows = memoryRows(agent.memory)
    void loadMemory(agent.id)
  }

  /**
   * ★ 分批第 240 批：**记忆要自己读一次**（详情接口带着它）。
   *
   * ⚠️ 不能指望 `agent.memory` 一定有值：`Agents.svelte` 传给这一页的是
   * **列表接口**那一份（`GET /api/agents`），它只带 `memoryCount`（一条正文都不搬，
   * 列表不该背这个）。所以这一页进来先按 id 读一次详情，把记忆铺进草稿。
   *
   * 第一版就是漏了这一步：界面上「记忆 0 条」，而接口里明明有——预览（它也打接口）
   * 却有内容，探针把这对矛盾量出来了。
   */
  async function loadMemory(id: string): Promise<void> {
    try {
      const detail = await api<{ memory?: MemoryEntryView[] }>(
        `/api/agents/${encodeURIComponent(id)}`,
      )
      if (agent.id !== id) return // 中途换人了：这一份不要了
      memRows = memoryRows(detail.memory)
    } catch {
      // 读不到就让那一节保持空的（下一步的保存/报错会说话，不在这里吵）
    }
  }
  void loadMemory(agent.id)

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

  /**
   * ★ 分批第 273 批（使用者："内置智能体不能修改，原则上应该『保存』『删除』这些按钮都是置灰的，
   *   其他很多位置不能修改的，也应该要置灰（除了 CLI，应该都不可以改才对）"）：
   *
   * 服务端的事实比使用者记的还严：`PATCH /api/agents/{id}` 对内置 agent **整份拒绝**
   * （`builtin_agent_readonly`，见 `server.ts` 里那段），连 CLI 也改不了；能做的只有
   * 「恢复成默认值」（那是重置，不是编辑），以及 retired 那条（已下线的 skill 审核者）的删除。
   *
   * 而界面上原来把这些都画成**可编辑**：改了再点保存 ⇒ 400。那是本仓库最忌讳的一类——
   * 界面上看着能改、实际改不了。所以这里按事实把整张卡片切成只读态。
   */
  $: readOnly = agent.builtin === true
  /** retired 的内置审核者：没有默认值可恢复，但允许删（它已经不被任何链路使用）。 */
  $: retiredBuiltin = readOnly && agent.role === 'skill-reviewer'
  /**
   * 草稿有没有改动（没改动时「保存」置灰——点了也不会有事发生，那是假按钮）。
   *
   * ⚠️⚠️ **必须把 `draft` / `agent` 当参数传进去**。本组件是 legacy 反应式（`$:`），
   *   编译器靠**语句里静态出现的变量名**判断依赖：写成 `Object.keys(buildPatch())`
   *   一个依赖都没提到 ⇒ 这一句只在初始化时算一次，之后草稿怎么改它都不变 ⇒
   *   「保存」永远置灰、点了毫无反应（探针 273 批量到：保存之后老提示还在、
   *   `reviewStandard` 还是 `still-there`、勾了技能也不落库——三处说的都是这件事）。
   */
  $: dirty = isDirty(draft, agent, memRows)

  /** 内置 agent 的真实角色名（它不是 executor/reviewer 二选一，所以那个选择器对它不适用）。 */
  function roleLabelOf(a: Agent): string {
    if (a.role === 'reviewer') return $t('agents.roleReviewer')
    if (a.role === 'drafter') return $t('agents.roleDrafter')
    if (a.role === 'memory-tidy') return $t('agents.roleMemoryTidy')
    if (a.role === 'skill-reviewer') return $t('agents.roleSkillReviewer')
    return $t('agents.roleExecutor')
  }
  /** 只读态下的角色徽标颜色（与列表里那套一致）。 */
  function roleBadgeOf(a: Agent): string {
    return a.role === 'reviewer' || a.role === 'skill-reviewer' ? 'in_review' : 'in_progress'
  }

  function cancelEdit(): void {
    // ★ 2026-10：没有查看态了（选中即编辑，与组页同款）——「取消」= 放弃草稿、
    //   退出这一栏（回到空态）。改动直接丢，不逐个字段回滚。
    onclose()
  }

  /** 草稿有没有改动（`dirty` 的判据，参数化是为了让 legacy 反应式看得见依赖）。 */
  function isDirty(dr: Draft, ag: Agent, mr: MemRow[]): boolean {
    return Object.keys(buildPatch(dr, ag, mr)).length > 0
  }

  /** 只把**真的变了**的字段放进 patch。 */
  function buildPatch(dr: Draft = draft, ag: Agent = agent, mr: MemRow[] = memRows): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    if (dr.name !== ag.name) patch['name'] = dr.name
    if (dr.instructions !== ag.instructions) patch['instructions'] = dr.instructions
    if (dr.role !== ag.role) patch['role'] = dr.role
    // ⚠️ 2026-10：`workDir` / `model` / `reviewerAgentId` 三个设置从界面拿掉了
    // （见 `blankDraft`），PATCH 里不再生成——编辑一个 agent 不会碰它们。
    if (dr.runtimeKey !== ag.runtimeKey) patch['runtimeKey'] = dr.runtimeKey
    // ★ 分批第 245 批：总开关变了才发（保存语义与「指令」一致：一份表单一次提交）
    if (dr.memoryEnabled !== (ag.memoryEnabled !== false)) {
      patch['memoryEnabled'] = dr.memoryEnabled
    }
    if (dr.skillIds.slice().sort().join() !== ag.skillIds.slice().sort().join())
      patch['skillIds'] = dr.skillIds
    // 标准按值比较（它是对象，直接比引用永远不相等）
    if (JSON.stringify(dr.reviewStandard) !== JSON.stringify(ag.reviewStandard ?? null))
      patch['reviewStandard'] = dr.reviewStandard
    // ⚠️ 2026-10：这里原来还有三段——行动权限（`allowedActions`）、它的固定参数
    //    （`actionParams`）与调试勾选（`debugActions`）。三者一起撤掉了：**动作只
    //    属于组**（`AgentGroup`），从这里提交它们现在只会得到 400「不认识的字段」。
    //
    //    ★ 那三段里有一条真实的教训值得留在这里（它不再有代码，但换个字段还会
    //      再遇到同样的坑）：当年"按界面上显示的有效值去比"，会让**保存动作本身**
    //      触发一次数据迁移——老数据的有效值来自 `reviewStandard.allowedActions`，
    //      保存时把标准写成新形状，老字段就没了，那份权限在保存的一瞬间消失。
    //      判据必须落在"库里的事实"上，而不是"界面上显示的东西"。
    /**
     * ★ 分批第 240 批：记忆的**差量**（只有 add / remove / pin 三种动作）。
     *
     * 折算规则：
     *   · 新加的（`id === null` 且没被删） ⇒ `add`
     *   · 标了 `drop` 的（被"改"替换掉的、或点了"删"的） ⇒ `remove`
     *   · 置顶开关真的变了 ⇒ `pin`（它是标记，不是内容——所以能有第三种动作）
     *
     * ⚠️ **没有"改正文"这条**：改一条 = 加一条 + 删旧的（界面上的「改」就是这么做的）。
     */
    const add = mr
      .filter((r) => r.id === null && !r.drop)
      .map((r) => ({ kind: r.kind, text: r.text.trim(), ...(r.pinned ? { pinned: true } : {}) }))
      .filter((r) => r.text !== '')
    const remove = mr.filter((r) => r.drop && r.id !== null).map((r) => r.id as string)
    const pin = mr
      .filter((r) => r.id !== null && !r.drop && r.pinned !== r.origPinned)
      .map((r) => ({ id: r.id as string, pinned: r.pinned }))
    if (add.length > 0 || remove.length > 0 || pin.length > 0) {
      patch['memory'] = { add, remove, pin }
    }
    return patch
  }

  /**
   * ★ 2026-10：保存按钮与组页同款，就写「保存」——不做「保存(有改动)」的计数。
   *    （`changedCount` 那一套是给"查看/编辑两态"用的，两态没了它就没意义了。）
   */
  async function save(): Promise<void> {
    const patch = buildPatch()
    if (Object.keys(patch).length === 0) {
      return
    }
    busy = true
    error = ''
    /**
     * ⚠️⚠️ 这两个基准值必须在**发请求之前**取，不能在 `await` 之后取。
     *
     * `updateAgent()` 内部会 `loadAgents()`（见 `lib/stores.ts`），store 一刷新，
     * 这个组件的 `agent` prop **当场就是服务端那一份**了——所以"服务端有没有改写"
     * 这件事，用 `await` 之后的 `agent` 去比**永远比出来相等**（自己跟自己比）。
     * 第一版就是这么写的：代码在、条件不成立、界面纹丝不动。探针把它量出来了
     * （`fold.editorVsApiSamples`：接口那份有正文、输入框里没有），这是"断言写了、
     * 但被比较的两边其实是同一个东西"那类缺陷的又一例。
     */
    const intendedInstructions =
      (patch['instructions'] as string | undefined) ?? agent.instructions
    const hadLegacyStandard = draft.reviewStandard !== null
    try {
      const updated = await updateAgent(agent.id, patch)
    /**
     * ★ 分批第 240 批：保存成功之后用**服务端返回的那份记忆**重铺草稿。
     *
     * 两个理由：① "改 = 加一条 + 删旧的"之后，界面上那些划掉的旧行不该再留着；
     * ② 这期间聊天里可能又记了一条（别的入口在写）——不重铺就看不到它，
     *   而"它记得什么"这件事必须只有一份真相（服务端那份）。
     */
    memRows = memoryRows((updated as { memory?: MemoryEntryView[] }).memory)
      /**
       * ★ 分批第 250 批：有"已经记过所以没加"的条目就**说出来**。
       *   不说的话表现为"我加了一条，保存后又不见了"——而它其实一直在库里。
       */
      const skipped = (updated as { memorySkipped?: string[] }).memorySkipped ?? []
      if (skipped.length > 0) {
        showToast($t('agents.memorySkipped', { n: String(skipped.length) }))
      }
      /**
       * ★★ 2026-10-19：**服务端会在保存时顺手改写两个字段，所以这里必须把它的返回值收下。**
       *
       * ══════════════════════════════════════════════════════════════════
       * 它在改写什么（`apps/daemon/src/server.ts` 的 `foldInOnSave`）
       * ══════════════════════════════════════════════════════════════════
       * 老数据里"判断依据写在 `reviewStandard` 字段里"的审核者，保存一次就会被
       * 并进「指令」（正文一字不变）、老字段清成 `null`。也就是说：**我们发出去的
       * 是 `{name}`，回来的那一份里 `instructions` 已经变了**。
       *
       * ══════════════════════════════════════════════════════════════════
       * 两轮代价（都是探针在真浏览器里量到的，不是推演）
       * ══════════════════════════════════════════════════════════════════
       * `draft` 是进详情时拍的一份快照，只在**换人**（`agent.id` 变）时作废——
       * 保存同一个人不刷新它。于是：
       *   ① 并进来的那段正文**在界面上看不见**（那一格还是旧的指令）——
       *      使用者没法确认"我的判断依据还在"；
       *   ② 更糟：他在那格旧文字上接着改一个字再保存 ⇒ `buildPatch()` 判成
       *      "指令变了"，把**不带正文**的那份写回去，而老字段已经被清空 ⇒
       *      并进来的那段判断依据**再也回不来**。第二轮的形状是"老字段又被整份
       *      PATCH 回去"（`draft.reviewStandard` 还是老对象 ⇒ `buildPatch` 判成
       *      它变了），界面上那条老提示重新出现——**平台刚做的清理被界面自动撤销**。
       *
       * ══════════════════════════════════════════════════════════════════
       * 为什么这是"收下返回值"而不是"每次保存后重读一遍 agent"
       * ══════════════════════════════════════════════════════════════════
       * 重读会把**使用者正在改的东西**也一起覆盖（"改到一半被列表刷新清空"）。这里
       * 只认**服务端改过的那两处**：判据是"回来的那份 ≠ 我们本来要它存的那份"，
       * 普通保存回来的就是我们发出去的值 ⇒ 一个字段都不会被动。
       * ⚠️ 以后服务端再加"保存时顺手改写"的字段，就要在这里多收一个——那条
       *    `foldInOnSave` 的注释里写着"三个不收工的地方"，它是唯一一处保存期改写。
       */
      const adoptedInstructions =
        updated.instructions !== intendedInstructions ? updated.instructions : draft.instructions
      // 老字段被清掉（并进「指令」）⇒ 草稿里那个对象也得跟着清，否则下一次保存
      // 会把刚清理掉的形状整份写回去（上面 ② 那条）。
      // ⚠️ 只在"这次请求没带 `reviewStandard`"时收：带了就是使用者自己在写它
      //    （服务端那种情况**刻意不并**，见那三个不收工的地方），回来的那份就是
      //    他写的那份，草稿不该被它替掉。
      const legacyCleared =
        patch['reviewStandard'] === undefined &&
        (updated.reviewStandard ?? null) === null &&
        hadLegacyStandard
      if (adoptedInstructions !== draft.instructions || legacyCleared) {
        // ⚠️ **整份赋值**，不是逐字段改（`draft.instructions = …`）。本组件是
        //    **legacy 模式**（`export let agent`，没有 runes），"给对象里的一个字段
        //    赋值会不会让界面重渲染"取决于编译产物：第一版就是逐字段改的，
        //    服务端那份被收进了草稿对象、**界面却纹丝不动**（探针量到
        //    `fold.editorShowsMerged` 仍然红），而使用者接着在那格旧文字上打字会把
        //    刚收下的那段正文**覆盖掉** ⇒ 再保存一次判断依据就没了。
        //    整份赋值在任何模式下都作废草稿，用最不容易漂的那条路。
        draft = {
          ...draft,
          instructions: adoptedInstructions,
          reviewStandard: legacyCleared ? null : draft.reviewStandard,
        }
      }
      showToast(tx('agents.saved'))
      onchanged()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  /** 删除（2026-11）：先确认，再删；删完退出这一栏（列表已随 store 刷新）。 */
  async function remove(): Promise<void> {
    const ok = await askConfirm({
      title: tx('agents.confirmDeleteTitle'),
      message: tx('agents.confirmDeleteBody', { name: agent.name }),
      confirmLabel: tx('agents.confirmDelete'),
    })
    if (!ok) return
    error = ''
    try {
      await deleteAgent(agent.id)
      onclose()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * 「恢复成默认值」（2026-10，定稿第 ② / ⑥ 条）：把内置 agent 的指令/名字/技能集合
   * 恢复成平台默认。
   *
   * 为什么必须有这个按钮：平台升级**不覆盖**使用者改过的指令（那是他的资产），
   * 所以"改坏了想回原样"必须有一条路——没有它的话，唯一的办法是删了重建，而它**删不掉**。
   */
  async function restoreDefault(): Promise<void> {
    const ok = await askConfirm({
      title: tx('agents.restoreDefaultTitle'),
      message: tx('agents.restoreDefaultBody', { name: agent.name }),
      confirmLabel: tx('agents.restoreDefault'),
    })
    if (!ok) return
    error = ''
    busy = true
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/restore-default`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error(await res.text())
      // 拉回最新记录：草稿里可能还留着被改过的指令，不刷新的话界面上看着"恢复没生效"
      await loadAgents()
      onclose()
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
   * ★ 2026-10：库里**每一条都能挂**（"不可选"这个概念随"本地技能目录改成显式
   *   安装"一起撤掉了）——所以这里就是全部技能。以前要在这里判 `selectable`，
   *   是因为本地目录那条可能"来源目录取消了勾选"而变得不可选；现在装进来的
   *   就是一条普通技能，没有这回事了。
   */
  $: pickableSkills = $skills
  $: isReviewer = agent.role === 'reviewer'

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
</script>

<form
  class="agent-form"
  onsubmit={(e) => {
    e.preventDefault()
    void save()
  }}
>
  <!--
    ══════════════════════════════════════════════════════════════════
    ★ 2026-10（使用者拍板）：**没有预览页了**——选中即编辑，与智能体组页同款：
    没有 hero 头、没有「编辑」按钮，进来就是一张可编辑的卡片（两列网格，对齐
    「新建私有」），保存 / 取消在底部。查看态那一整套（只读值、chips、老标准
    的详情展示与一键并进按钮）随这次改造一起删了。
    ══════════════════════════════════════════════════════════════════
  -->
  <!--
    ★ 分批第 269 批（使用者："只是先要有类似任务和聊天那页的 Title 顶栏"）：
    **栏头** = 标题（名字 + 角色徽标 + 改名）+ 一行副题 + 右侧一条工具条。
    与任务页 / 聊天页那一排同一种长相（`.detail-head` 的样式在 `app.css`，那条工具条
    与顶栏、聊天页那排是同一套）。

    ★ 保存 / 取消 / 删除**从页面底部上移到这里**：
      · 这一页是一整页滚动，"保存"经常滚出视口；
      · 任务页的「沉淀技能 / 删除任务」本来就在栏头——同一个位置放同一类动作用户不用找。
    ⚠️ 「保存」仍是 `type="submit"`：表单里按 Enter 提交的行为没有变。
    ⚠️ 改名只改**草稿**（与卡片里其它字段一致）：点「保存」才写库。
  -->
  <header class="detail-head agent-head">
    {#if renaming}
      <input
        class="agent-rename-input"
        bind:value={renameValue}
        aria-label={$t('agents.nameLabel')}
        autocomplete="off"
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commitRename()
          } else if (e.key === 'Escape') {
            renaming = false
          }
        }}
        onblur={commitRename}
      />
    {:else}
      <h2>
        <span class="agent-head-name" data-agent-head-name>{draft.name}</span>
        {#if !agent.builtin}
          <!--
            ★ 分批第 273 批：内置 agent 不画「执行 / 审核」这枚徽标——它的角色是
            `drafter` / `memory-tidy` / `skill-reviewer`，画成「执行」是错的（使用者正是
            因为"内置都是执行智能体"才去角色格里找它，然后发现两边都不亮）。
            它的真实角色在卡片「角色」那一格用真实徽标显示。
          -->
          <span class="badge {draft.role === 'reviewer' ? 'in_review' : 'in_progress'}"
            >{draft.role === 'reviewer' ? $t('agents.roleReviewer') : $t('agents.roleExecutor')}</span
          >
        {/if}
        {#if agent.builtin}
          <span class="badge in_review" data-agent-builtin-badge
            >{agent.role === 'skill-reviewer'
              ? $t('agents.retiredReviewerBadge')
              : $t('agents.builtinBadge')}</span
          >
        {/if}
        {#if draft.name !== agent.name}
          <span class="faint small" data-agent-rename-pending>{$t('agents.renamePending')}</span>
        {/if}
        {#if !readOnly}
          <button type="button" class="btn-link" data-agent-rename onclick={startRename}
            >{$t('agents.rename')}</button
          >
        {/if}
      </h2>
    {/if}
    <p
      class="detail-sub"
      data-agent-head-sub
      title={draft.runtimeKey === 'default' ? $t('agents.runtimeFollowDefaultHint') : ''}
    >
      {$t('agents.headSub', {
        cli: draft.runtimeKey === 'default' ? $t('agents.runtimeFollowDefault') : draft.runtimeKey,
        memory: draft.memoryEnabled
          ? $t('agents.headMemoryOn', { n: String(activeMemRows.length) })
          : $t('agents.headMemoryOff'),
        skills: String(draft.skillIds.length),
      })}
    </p>
    <div class="detail-actions">
      {#if readOnly}
        <!--
          ★ 分批第 273 批：内置 agent **没有「保存」**——服务端整份拒绝它的 PATCH，
            留着这颗按钮就是"点了必然 400"的假动作（使用者："保存/删除这些按钮都是置灰的"）。
          能做的只有：删（仅已下线的 skill 审核者）、恢复成默认值、取消。
        -->
        {#if retiredBuiltin}
          <button type="button" class="danger" data-agent-delete onclick={() => void remove()}
            >{$t('agents.deleteButton')}</button
          >
        {:else}
          <button
            type="button"
            data-agent-restore
            disabled={busy}
            title={$t('agents.restoreDefaultTitle')}
            onclick={() => void restoreDefault()}>{$t('agents.restoreDefault')}</button
          >
        {/if}
        <button type="button" data-agent-cancel onclick={cancelEdit}>{$t('common.close')}</button>
      {:else}
        <button
          type="submit"
          class="primary"
          data-agent-save
          disabled={busy || !dirty}
          title={dirty ? $t('agents.saveTitle') : $t('agents.saveNothing')}
          >{busy ? $t('common.saving') : $t('common.save')}</button
        >
        <button type="button" data-agent-cancel onclick={cancelEdit}>{$t('common.cancel')}</button>
        <button type="button" class="danger" data-agent-delete onclick={() => void remove()}
          >{$t('agents.deleteButton')}</button
        >
      {/if}
    </div>
  </header>

  {#if error}
    <div class="notice bad">{error}</div>
  {/if}

  <section class="card agent-card">
    <!-- ★ 第 269 批：内置徽标移到**标题栏**（名字旁边），卡片里不再画一遍 -->
    <!-- ★ 角色是智能体比「新建私有」多出的一维（私有表单由槽位决定角色），
         占一整行。 -->
    <div class="cell role-cell">
          <span class="cell-label">{$t('agents.roleLabel')}</span>
          {#if readOnly}
            <!--
              ★ 分批第 273 批（使用者："我记得内置智能体都是执行智能体，我怎么没看到被选择"）：
              内置 agent 的角色是 `drafter` / `memory-tidy` / `skill-reviewer`，**不是**执行/审核
              二选一 ⇒ 那个两按钮选择器对它两边都不亮，看起来"没被选中"。只读态直接显示真实角色。
            -->
            <div class="role-readonly" data-agent-role-badge>
              <span class="badge {roleBadgeOf(agent)}">{roleLabelOf(agent)}</span>
              <span class="faint small">{$t('agents.builtinReadOnly')}</span>
            </div>
          {:else}
          <div class="role-picker">
            <!--
              ★ 第 269 批（使用者："需要精简文字"）：两张卡里的副说明（"接到任务后动手干活" /
                "按判断依据审别人的产出"）挪进 `title`——「执行」「审核」四个字已经够了。
            -->
            <button
              type="button"
              class="role-card"
              class:active={draft.role === 'executor'}
              title={$t('agents.roleExecutorHint')}
              onclick={() => (draft.role = 'executor')}
            >
              <strong>{$t('agents.roleExecutor')}</strong>
            </button>
            <button
              type="button"
              class="role-card"
              class:active={draft.role === 'reviewer'}
              title={$t('agents.roleReviewerHintShort')}
              onclick={() => (draft.role = 'reviewer')}
            >
              <strong>{$t('agents.roleReviewer')}</strong>
            </button>
          </div>
          {/if}
        </div>

        <!--
          ★ 分批第 272 批（使用者："整体布局有变化（指令被挤到右边了）"）：
          名字上移到标题栏之后，这一格成了"**半行没人陪**"的那一个——网格自动排布会把
          CLI 放在第 1 列，于是**指令落到第 2 列**（跑到右边），"指令 | 技能"的配对散掉、
          还空出半个格子。所以 CLI 自己占整行：角色 → CLI → 指令|技能 → 记忆 → 行动权限，
          每一行都是满的（探针 `agents.cardNoHoles` 钉着这件事）。
        -->
        <label class="cell runtime-cell" class:locked={readOnly}>
          {$t('agents.runtimeRowLabel')}
          <!-- 服务端连 CLI 都不许改（内置整份只读），界面就别让它看起来能改。 -->
          <select id="agent-runtime" bind:value={draft.runtimeKey} disabled={readOnly}>
            <!-- ★ `default` = 跟随全局默认（2026-10 第 ⑦ 条）。它在最上面：新建的
                 agent 记的就是它，不给这一项的话下拉会落到第一个具体 runtime ——
                 那等于"打开编辑页什么都没做，保存就把它的默认改掉了"。 -->
            <option value="default" title={$t('agents.runtimeFollowDefaultHint')}
              >{$t('agents.runtimeFollowDefault')}</option
            >
            {#each runtimeOptions as key (key)}
              <option value={key}>{key}</option>
            {/each}
            <!--
              ⚠️ ★ 分批第 270 批（使用者："CLI 有一个『跟随全局默认』和『Default 当前』，
                 这个不是重复的吗？"）：**是重复的**，而且是这一支造成的。

              `default` 是**伪值**（"跟随全局默认"），它已经在上面第一条里了；而
              `runtimeOptions` 只含**身份接口里那几个具体 runtime**，永远不含 `default`
              ⇒ `!runtimeOptions.includes('default')` 恒为真 ⇒ 这里又画了一个
              `value="default"` 的「default（当前）」。同一个值两行，选哪个都一样。

              这一支真正要覆盖的是"当前值是个**具体 runtime**、但它不在身份接口那张表里"
              （还没装上 / 已被摘掉 / 老的未验证 runtime），所以 `default` 必须排除。
            -->
            {#if draft.runtimeKey !== 'default' && !runtimeOptions.includes(draft.runtimeKey)}
              <option value={draft.runtimeKey}>{$t('agents.runtimeCurrent', { key: draft.runtimeKey })}</option>
            {/if}
          </select>
          {#if evidenceWarnings[draft.runtimeKey]}
            <p class="row-hint warn">{evidenceWarnings[draft.runtimeKey]}</p>
          {/if}
        </label>

        <label class="cell instructions-cell">
          {$t('agents.instructionsLabel')}
          <!-- ★ 与 `NewAgentForm.svelte` 里那一栏**同一个字段、同一个要求**（D48）：
               指令是一份几百到上千字的文档，不是一行备注。 -->
          <textarea
            id="agent-instructions"
            class="instructions"
            class:locked={readOnly}
            readonly={readOnly}
            bind:value={draft.instructions}
            rows="6"
          ></textarea>
          <!--
            ★ 分批第 254 批（使用者："文字解释太多，不需要写那么细致"）：原来这里是**两行**
            说明（"这一段就是它的「指令」：平台每派一次活都会带上它（不用你在别处再配一遍）。
            留空也行——那就只剩任务本身；但审核者留空就拿不到审核任务。" + 另一行讲模版）。
            现在压成**一行**，全文进 `title`：要查的人悬停就有，不查的人不占版面。
          -->
          <p
            class="row-hint"
            data-instructions-identity
            title={$t('agents.instructionsHintTitle')}
          >{$t('agents.instructionsHint')}</p>
          {#if legacyStandardPending}
            <!-- ★ 编辑态**只提示**（按钮在只读态，理由见只读态那段注释：搬移会清空
                 `skillIds`，而草稿里还留着旧的那份 ⇒ 保存会把挂载写回去，正文被投递两遍）。 -->
            <p class="row-hint std-legacy" data-standard-merged data-legacy-standard>
              {$t('agents.standardFoldInEditHint')}
            </p>
          {/if}
        </label>


        <div class="cell skills-cell" class:locked={agent.builtin}>
          <span class="cell-label">{$t('agents.attachedSkillsLabel')}</span>
          {#if agent.builtin}
            <!--
              ★ 分批第 207 批（使用者定："就挂在 Agent 上，而不是在沉淀做特别处理"）：
              起草者的**沉淀用技能现在真的挂在它身上**（`Agent.skillIds`），所以这一格不再写
              "内置不挂 skill"——它挂什么，起草 run 就注入什么。
              ⚠️ 内置 agent 仍然只读（分批第 190 批）：这一格是**展示**，挂载由平台维护
                （装/卸技能、daemon 启动时对齐）。
            -->
            {#if agent.role === 'drafter'}
              {@const mounted = $skills.filter((sk) => agent.skillIds.includes(sk.id))}
              {#if mounted.length > 0}
                <p class="builtin-skills">
                  {#each mounted as sk (sk.id)}
                    <span class="skill-chip">{sk.name}</span>
                  {/each}
                </p>
                <span class="hint">{$t('agents.drafterSkillHint')}</span>
              {:else}
                <p class="builtin-skills">
                  <span class="skill-chip missing"
                    >{expectedDrafterSkill}{$t('agents.skillNotInstalled')}</span
                  >
                </p>
                <span class="hint">{$t('agents.drafterSkillMissingHint')}</span>
                <button
                  type="button"
                  class="ghost small"
                  data-install-drafter-skill
                  disabled={installingSkill}
                  onclick={() => void installDrafterSkill()}
                >{installingSkill ? $t('common.saving') : $t('agents.skillInstallNow')}</button>
              {/if}
            {:else}
              <p class="empty-value">{$t('agents.builtinNoSkills')}</p>
            {/if}
          {:else if $skills.length === 0}
            <p class="empty-value">{$t('agents.noSkillsYet')}</p>
          {:else if pickableSkills.length === 0}
            <!-- 库非空、但一条都不能挂：不能复用上面那句"还没有任何 skill" -->
            <p class="empty-value">{$t('agents.noSelectableSkills')}</p>
          {:else}
            <div class="skill-picker">
              {#each pickableSkills as s (s.id)}
                <label class="skill-option">
                  <input type="checkbox" value={s.id} bind:group={draft.skillIds} />
                  <!--
                    ★ 分批第 209 批（使用者："挂载的技能显示「browser-use（来自
                    /Users/ling/.claude/skills）」，不需要显示这个，信息不重要"）：
                    **不再把来源目录印在选项上**——一长串绝对路径占了半行，而它几乎从不是
                    选择时要看的判断依据（要挂哪条技能，看的是名字与说明）。
                    ⚠️ 信息来源没有丢：仍挂在 `title` 里（悬停能看到），因为"同名两条、各自
                    来自不同目录"这件事真的存在——真到需要分辨的那一次，鼠标一停就够。
                  -->
                  <span title={s.localDir ?? s.slug}>
                    <!-- ★ 2026-10：技能以**名字**为主显示（与组里「新建私有」同款）。
                         已安装技能的名字常常就是 slug（如 `fireworks-tech-graph`），
                         之前同时印 slug + name 会重复成两个一模一样的东西。slug 只在
                         和名字不同时才作为机器名补充——名字相同的场合它纯属噪音。 -->
                    {s.name}{#if s.name !== s.slug}<code class="skill-slug">{s.slug}</code>{/if}
                  </span>
                </label>
              {/each}
            </div>
          {/if}
        </div>

        <!--
          ══════════ 记忆（分批第 240 批）══════════
          ★ 位置（分批第 254 批调整）：**在「指令 | 技能」那一对之后，整行宽**。
            原来它紧贴「指令」下面——但那会把它插进两列网格的配对中间（指令只剩左半列、
            右边空着，记忆横在下面再让技能单独占半列）。整行宽的块只能放在**配对之后**，
            否则必然留洞（探针 `agents.cardNoHoles` 钉着）。
          ★ 一条一行（悬停看全文与出处），动作在悬停时才出现；★ = 置顶（预算紧张时
            最后才裁）。**没有"停用/退役"**：久不用的靠注入顺序自然沉底。
          ★ 与「指令」一起随页面底部那个「保存」提交，提交的是**差量**。
        -->
        <section class="cell memory-cell" data-agent-memory>
          <!--
            ★ 分批第 257 批（使用者："又发现了居中的选择框，比如『启用记忆』的选择框布局很奇怪"）：
            这一行原来是**一堆 inline 元素挤在一个普通 `<span>` 里**（`记忆` / `条数` / 说明 /
            勾选框 / 按钮），没有 flex ⇒ 勾选框跟着文字流走、换行时飘在句子中间；
            而 `<label class="mem-switch">` 又没有任何样式，于是吃到了全局那条
            `label { display: block; margin-bottom: var(--sp-3) }` ⇒ 它自成一块、上下各顶一行。
            现在拆成两行：**控件那一行只放单行短内容**（可以用 `align-items: center`），
            **会换行的说明单独一行**放下面——"会换行的子元素不许跟控件挤在一行"这条规矩
            （见 `tools/layout-probe/README.md` 的坑清单）就是这么落地的。
          -->
          <span class="cell-label mem-head">
            <span title={$t('agents.memoryHint')}>{$t('agents.memoryLabel')}</span>
            <span class="mem-count" data-memory-count>
              {$t('agents.memoryCount', { n: String(activeMemRows.length) })}
            </span>
            <span class="spacer"></span>
            <!--
              ★ 分批第 245 批：**总开关**（使用者要求："配置页面里面有个选项，表示是否使能记忆功能"）。
                关掉 = 不带入第一句话 + 不能手写 + 不能整理（三处一起关，后端也各拒一遍）；
                已有的条目**不删**，只是暂时不用——所以关掉之后这一节照样列出来，
                但整节压暗、写入口收起来，并且明说"不会被带进第一句话"。
            -->
            {#if readOnly}
              <!-- 内置 agent 整份只读（服务端连 PATCH 都拒），开关摆出来只会让人白点。 -->
              <span class="mem-state" data-memory-state
                >{draft.memoryEnabled
                  ? $t('agents.headMemoryOn', { n: String(activeMemRows.length) })
                  : $t('agents.headMemoryOff')}</span
              >
            {:else}
            <label class="mem-switch" title={$t('agents.memoryEnabledHint')}>
              <!--
                ⚠️ 必须用 `bind:checked`，不能写 `checked={…}` + `onchange` 里赋值：
                   在这一页（legacy 反应式）里 `draft.memoryEnabled = x` **不会**触发重渲染，
                    于是勾掉之后"记下一条"那一行还在——探针量到 `addGone:false`，而
                    手点界面的人只会觉得"这个开关没用"。`bind:` 才会生成 `$$invalidate`。
              -->
              <input type="checkbox" data-memory-enabled bind:checked={draft.memoryEnabled} />
              <span>{$t('agents.memoryEnabled')}</span>
            </label>
            {/if}
            <!--
              ★ 分批第 260 批：「合并同类…」——让整理者读**它的全部记忆**，把同义的并成一条、
                把过时的标成"忘掉"，摆给人确认。比手工删十几条现实得多。
                只在"记忆开着 + 至少两条"时出现：一条没什么可并的，关着则根本不该动。
            -->
            {#if !readOnly && draft.memoryEnabled && activeMemRows.length >= 2}
              <button
                type="button"
                class="btn-link"
                data-memory-consolidate
                onclick={() => (consolidateOpen = true)}
              >{$t('agents.memoryConsolidate')}</button>
            {/if}
            <button
              type="button"
              class="btn-link"
              data-memory-preview
              disabled={memPreviewBusy}
              onclick={() => void openMemoryPreview()}
            >{$t('agents.memoryPreview')}</button>
          </span>
          <!-- ★ 第 269 批：这句（"会进第一句话（排在指令之后）"）挪进标题行的 title，
               标题行只留"记忆 + 条数"——一行扫过去要能读完。 -->

          {#if !draft.memoryEnabled}
            <p class="row-hint warn" data-memory-off-hint>{$t('agents.memoryOffHint')}</p>
          {/if}

          {#if memPending}
            <p class="row-hint warn" data-memory-pending>
              {$t('agents.memoryPending', {
                dropped: String(memDroppedCount),
                added: String(memAddedCount),
              })}
            </p>
          {/if}
          {#if memRows.length === 0}
            <p class="row-hint" data-memory-empty>{$t('agents.memoryEmpty')}</p>
          {:else}
            <div class="mem-list">
              {#each memRows as row (row.key)}
                <div
                  class="mem-row"
                  class:dropped={row.drop}
                  data-mem-row
                  data-dropped={row.drop ? '1' : '0'}
                  data-pinned={row.pinned ? '1' : '0'}
                >
                  <button
                    type="button"
                    class="mem-pin"
                    data-mem-pin
                    class:on={row.pinned}
                    title={$t('agents.memoryPinTitle')}
                    aria-pressed={row.pinned}
                    disabled={readOnly || row.drop}
                    onclick={() => togglePin(row)}
                  >★</button>
                  <span class="mem-kind" data-kind={row.kind}>{$t(`agents.memoryKind.${row.kind}` as never)}</span>
                  {#if row.id === null}
                    <input
                      class="mem-text-input"
                      bind:value={row.text}
                      aria-label={$t('agents.memoryTextLabel')}
                      autocomplete="off"
                    />
                  {:else}
                    <span class="mem-text" title={memTitleFor(row)}>{row.text}</span>
                  {/if}
                  <span class="mem-meta">{memMetaFor(row)}</span>
                  {#if !readOnly}
                  <span class="mem-actions">
                    {#if row.drop}
                      <button type="button" class="btn-mini" data-mem-undo onclick={() => undropRow(row)}>
                        {$t('agents.memoryUndo')}
                      </button>
                    {:else}
                      {#if row.id !== null}
                        <button type="button" class="btn-mini" data-mem-edit onclick={() => editRow(row)}>
                          {$t('agents.memoryEdit')}
                        </button>
                      {/if}
                      <button type="button" class="btn-mini" data-mem-remove onclick={() => removeRow(row)}>
                        {$t('agents.memoryRemove')}
                      </button>
                    {/if}
                  </span>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          {#if draft.memoryEnabled && !readOnly}
          <div class="mem-add">
            <select bind:value={memNewKind} aria-label={$t('agents.memoryKindLabel')} data-mem-new-kind>
              {#each MEMORY_KINDS_UI as k (k)}
                <option value={k}>{$t(`agents.memoryKind.${k}` as never)}</option>
              {/each}
            </select>
            <input
              bind:value={memNewText}
              placeholder={$t('agents.memoryAddPlaceholder')}
              aria-label={$t('agents.memoryTextLabel')}
              data-mem-new-text
              autocomplete="off"
              onkeydown={(e) => {
                if (e.key === 'Enter') addRow()
              }}
            />
            <button type="button" class="btn-small" data-mem-add disabled={memNewText.trim() === ''} onclick={addRow}>
              {$t('agents.memoryAdd')}
            </button>
          </div>
          {/if}
          {#if memError !== ''}
            <p class="row-hint warn" data-memory-error>{memError}</p>
          {/if}
        </section>

        {#if draft.role === 'reviewer'}
          <!--
            ⚠️ 2026-10：这里原来有一整段「行动权限」（`ActionPicker`：允许触发的
            动作 + 固定参数 + 调试勾选）。**整个能力从 agent 上撤掉了**——动作属于
            **这条链**（这队人的活判过之后允许做什么），不属于某个审核者个人：同一个
            审核者在不同组里本来就该配不同的权限，挂在人身上只能共用一份。

            唯一权威是 `AgentGroup.allowedActions` / `actionParams` / `debugActions`，
            配的地方是**智能体组页的 ③ 行动**（那里也带同样的选择器）。

            ★ 所以这里只留一句指路，而**不复用那个选择器**：两处长得一模一样、只有
              一处生效，是最坏的一种界面（使用者会在这里勾一遍，然后在组里再勾一遍）。
          -->
          <div class="cell actions-cell">
            <span class="cell-label">{$t('agents.sectionActions')}</span>
            <p class="row-hint">{$t('agents.actionsMovedToGroup')}</p>
          </div>
        {/if}
  </section>

  <!-- 主操作在底部（与组页同款）：保存 / 删除 / 取消 -->
</form>

<!--
  ★ 分批第 240 批：「预览第一句话」抽屉（**只读**）。
  ★ 为什么只读：它要回答的是"它这一轮到底会收到什么"——能在这里改就会变成第二个
    编辑入口，而"改"的地方只有「记忆」那一节（与「指令」一起保存）。
  ★ 内容是服务端按**库里已保存的**那份指令 + 记忆渲染的 ②（身份 + 经验）——
    与真正投递出去的那一段同一台渲染器，不是前端拼的。
-->
<!--
  ★ 分批第 260 批：「合并同类」对话框。
  ★ 与聊天页那个「整理成记忆」是**同一个组件**（同一套分析 run、同一套核对、同一个写入口），
    只是 `mode="consolidate"`：它读的不是一段对话，而是**它的全部记忆**。
  ★ 确认之后由这一页落库：先删"忘掉"的那几条，再把合并出来的新条目连同 `replaces` 一起提交
    ——平台那边是"先加新的、再删旧的"，与「改一条」同一条纪律。
-->
<ChatMemoryTidy
  bind:open={consolidateOpen}
  mode="consolidate"
  agentId={agent.id}
  onconfirm={(items, forget) => {
    void (async () => {
      try {
        await api(`/api/agents/${encodeURIComponent(agent.id)}/memory`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            entries: items.map((it) => ({
              text: it.text,
              kind: it.kind,
              ...(it.replaces === undefined ? {} : { replaces: it.replaces }),
            })),
            ...(forget === undefined || forget.length === 0 ? {} : { forget }),
          }),
        })
        showToast($t('agents.memoryConsolidated'))
        // 记忆变了 ⇒ 重新读一次记忆，让这一节跟着服务端走（不拿本地状态假装成功）
        await loadMemory(agent.id)
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err))
      }
    })()
  }}
  oncancel={() => {}}
/>

{#if memPreview !== null}
  <div class="mem-preview-backdrop" role="presentation" onclick={() => (memPreview = null)}></div>
  <div class="mem-preview" role="dialog" aria-label={$t('agents.memoryPreviewTitle')} data-memory-preview-panel>
    <div class="mem-preview-head">
      <div>
        <h2>{$t('agents.memoryPreviewTitle')}</h2>
        <p class="row-hint">{$t('agents.memoryPreviewHint')}</p>
      </div>
      <span class="spacer"></span>
      <button type="button" class="ghost" onclick={() => (memPreview = null)}>{$t('common.close')}</button>
    </div>
    <div class="mem-preview-body">
      {#if memPreviewStats !== null}
        <p class="row-hint mem-preview-stats" data-memory-preview-stats>
          {$t('agents.memoryPreviewStats', {
            used: String(memPreviewStats.used),
            chars: String(memPreviewStats.chars),
            pinned: String(memPreviewStats.pinned),
          })}
        </p>
      {/if}
      <pre class="mem-preview-text" data-memory-preview-text>{memPreview}</pre>
    </div>
  </div>
{/if}
{#if memPreviewError !== ''}
  <p class="row-hint warn" data-memory-preview-error>{memPreviewError}</p>
{/if}

<style>
  /* ★ 第 269 批：内置徽标移到标题栏（名字旁边），这里那条常驻说明的样式随之删掉 */
  .skills-cell.locked { opacity: 0.85; }

  /**
   * ★ 分批第 255 批（使用者："技能出现了滚动条，高度明显小于左侧的指令；既然是左右，
   *   应该一样高"）：
   *
   * 两格并排之后，行高由**高的那一格**（指令，`min-height: 22rem`）决定；而技能那一格的
   * 列表钉了 `max-height: 11rem` + `overflow-y: auto` ⇒ 它比左边矮一大截，还平白多出一根
   * 滚动条。并排的两格就该**同高**：
   *   · 两格都 `align-self: stretch`（铺满行高）；
   *   · 列表改成"**填满剩下的高度**"，只有在真的装不下时才滚（那根滚动条才是有效信息：
   *     "还有更多技能"）；
   *   · 上限仍留一个（22rem，与指令同高）——不然技能特别多时会把整张卡顶穿。
   */
  .cell.instructions-cell,
  .cell.skills-cell {
    align-self: stretch;
    min-height: 0;
  }
  .skills-cell .skill-picker {
    flex: 1 1 auto;
    max-height: 22rem;
    min-height: 0;
    /**
     * ⚠️ ★ 分批第 258 批（使用者："挂载的技能里面每个技能的上下间隔太大，很丑"）：
     *   **`align-content: start` 必须写**。这是 grid 的默认行为在作怪——`align-content`
     *   默认是 `stretch`，于是"行数不够填满容器高度时，**每一行都被拉开**去铺满"：
     *   技能少的时候每个技能之间就出现一大段空白（看着像间距被设得很大，其实是行被拉长）。
     *   加上 `align-content: start` 之后，行按自然高度**贴顶**排列，多出来的高度留在
     *   容器底部（容器本身仍然是满高的——"和左边的指令框一样高"那条不变）。
     */
    align-content: start;
    align-items: start;
  }

  /* ★ 分批第 207 批：内置起草者挂的那条「沉淀用技能」（展示，不可编辑） */
  .builtin-skills {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
    margin: 0 0 var(--sp-1);
  }
  .skill-chip {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    padding: 2px 8px;
    font-size: var(--fs-sm);
  }
  /* 未安装：虚线框 + 弱化（"应该挂但没装"，不是一条真技能） */
  .skill-chip.missing {
    border-style: dashed;
    color: var(--text-faint);
    background: transparent;
  }
  .skills-cell .hint {
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }
  /* ══════════════════════════════════════════════════════════════════
     布局
     ══════════════════════════════════════════════════════════════════

     ⚠️ 2026-09：**不再设 `max-width`**（原来钉死 52rem）。任务详情那一栏是
     占满右栏的，而智能体详情被那条上限卡在 832px——宽窗口下右栏右侧空出
     一大片（1920 宽实测 400px+），使用者报「主区不满屏」。去掉之后：
        · `.card.agent-card` 的两列网格直接跟着撑满；
        · 长文字（指令 / 提示）由各自的 `46ch` 上限管着，不会拉成整屏长行。
     与任务的详情栏保持同一套行为。

     2026-10：字段区改成一张卡片（两列网格，对齐「新建私有」），不再是
     `.field-row` 的 9rem 定宽 label 表——那套规则随重构一起删掉了。 */
  .agent-form {
    /* 与组表单同款：纵向一列（卡片 → 底部操作），宽度拉通右栏 */
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }

  /* ── 标题栏（分批第 269 批）── */

  /**
   * `.detail-head` 的网格/副题/动作排布在 `app.css`（任务页、聊天页共用同一份）。
   * 这里只补这一页特有的两样：改名的输入框、以及"名字改过但没保存"的那句提示。
   */
  .agent-head h2 {
    /* 标题里塞了徽标与「改名」，允许折行——但名字本身仍然不换行（超长省略） */
    flex-wrap: wrap;
    row-gap: var(--sp-1);
  }
  .agent-head-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .agent-rename-input {
    grid-column: 1;
    font: inherit;
    font-size: var(--fs-lg);
    font-weight: 600;
    padding: var(--sp-1) var(--sp-2);
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    max-width: 24rem;
  }

  /* ── 卡片 + 网格（2026-10：对齐组里「新建私有」的 `.grid-form`）── */



  /**
   * ★ 一张卡片包住全部字段：两列网格，每个字段一格（label 在上、控件在下）。
   *
   * 与 `MemberSlotForm.svelte` 里「新建私有」的 `.grid-form` 同一套布局——
   * 名字 / CLI 一行，指令 / 技能一行；角色（编辑态）与行动权限（审核者）占整行。
   */
  .card.agent-card {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-3);
    align-items: start;
    margin: 0;
    padding: var(--sp-4);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }

  .cell {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    min-width: 0;
    /**
     * ★ 分批第 255 批：**必须清掉全局那条 `label { margin-bottom: var(--sp-3) }`**。
     *
     * 「指令」「名称」这些格子是 `<label>`，于是它们比 `div`/`section` 的格子多出 12px
     * 下边距——并排时表现是"右边那格明明铺满了，左边那格底边矮一截"（实测指令 431、
     * 技能 443，顶边一样、底边差 12：差的正是这个 margin）。网格自己已经有 `gap`，
     * 格子不需要再带外边距。
     */
    margin-bottom: 0;
  }

  .cell-label {
    font-size: 0.9em;
    color: var(--text-faint);
  }

  /**
   * ★ 分批第 254 批（使用者："加入记忆后，布局乱了" / "为什么不能保持之前的一半一半"）：
   *   **两列配对要保住，洞是"插在配对中间"造成的，不是"用两列"造成的**。
   *
   * 卡片是两列网格，原来的配对是「名称 | CLI」「指令 | 挂载的技能」——两列都填满。
   * 第 240 批把**整行宽**的「记忆」插在「指令」与「技能」**中间**，配对被打散：
   * 指令只剩左半列、右边空着，然后一整块记忆横在下面。
   *
   * 第一版修法（第 254 批）是把指令与技能都拉成整行——洞是没了，但**整张卡变成单列**，
   * 又高又空，使用者当场问"为什么不能保持之前的一半一半"。他说得对：那是治错了地方。
   *
   * 现在的规矩：
   *   · 「名称 | CLI」「指令 | 挂载的技能」保持**相邻的配对**（这就是"一半一半"）；
   *   · **整行宽**的那些（角色 / 记忆 / 行动权限指路 / 内置徽标）只能放在**配对的后面**，
   *     不许插进任意两格之间——插进去就必然留洞（探针 `agents.cardNoHoles` 会红）。
   */
  .cell.role-cell,
  .cell.runtime-cell,
  .cell.actions-cell {
    grid-column: 1 / -1;
  }

  /* 行动权限（审核者）：占整行（选择器"左选右配"，最需要宽度） */

  /* 行动权限的展开/收起（2026-10：与顶栏「列表 / 看板」同款分段轨——
     与组里「选已有的/新建私有」、任务里「智能体/智能体组」同一套样式） */


  /* ── 值的呈现 ── */

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

  /**
   * ★ 分批第 273 批：只读的指令框**不压暗文字**（它是给人读的，读的人比写的人多），
   *   只把底色与光标换成"不可编辑"的样子——`readonly` 保留了选中/复制/滚动，
   *   用 `disabled` 会连滚动一起废掉长指令的后半段。
   */
  .instructions.locked {
    background: var(--surface-2);
    cursor: default;
  }

  /* CLI 那一格没有单独的只读外观，整格压暗一档就够（与「内置」技能那格同一手法）。 */
  .runtime-cell.locked {
    opacity: 0.75;
  }

  /* ── 编辑控件 ── */

  /**
   * ★ 技能区：**固定两列**的框内网格（2026-10 起与组里「新建私有」的
   *   `.skill-picker` 同款 —— 列数、间距、框、滚动上限都一样）。原来用
   *   `repeat(auto-fill, minmax(11rem, 1fr))`，窄格子里会自动缩成一列，
   *   使用者要求的就是"两列"，钉死列数。
   */
  .skill-picker {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-1) var(--sp-2);
    max-height: 11rem;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2);
    background: var(--bg);
    text-align: left;
  }


  /* 补充显示的名字之外的机器名：弱化，不抢主显示的存在感 */
  .skill-slug {
    margin-left: var(--sp-1);
    font-size: 0.9em;
    color: var(--text-faint);
  }
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

  /**
   * ★ 分批第 273 批：只读态的角色（内置 agent 的角色不是执行/审核二选一）。
   *   与 `.role-picker` 的两张卡不同高，所以不能共用同一格：这里只要一行徽标 + 一句
   *   "内置只读"的灰字，竖排对齐 `align-items: baseline` 免得徽标比文字飘高半行。
   */
  .role-readonly {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--sp-2);
    margin-top: 2px;
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

  .role-card.active {
    border-color: var(--accent);
    background: var(--surface-2);
  }

  .role-card.active strong {
    color: var(--accent);
  }

  /* ══════════ 记忆（分批第 240 批）══════════ */
  .memory-cell {
    border-top: 1px solid var(--line);
    padding-top: var(--sp-3);
    /* 整行宽：一行一条记忆 + 它下面的出处，半列宽会折成三行（见上面那段说明） */
    grid-column: 1 / -1;
  }
  /**
   * ★ 分批第 257 批：「记忆」这一节的头部。
   *
   * 这一行里**只有单行短内容**（标题、条数、开关、预览按钮），所以 `align-items: center`
   * 在这里是对的——标题行里**只有单行短内容**（说明挪进了 title）。
   * 判据永远问同一句：**行里有没有会换行的子元素**？没有 ⇒ 居中安全；有 ⇒ 用栅格 + 顶部对齐。
   */
  .memory-cell .cell-label.mem-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    /* 窄屏时允许折行，但折的是整块控件，不会让勾选框飘进句子中间 */
    flex-wrap: wrap;
  }
  .memory-cell .cell-label.mem-head .spacer {
    flex: 1;
  }
  .mem-count {
    color: var(--text-faint);
    font-size: var(--fs-xs);
  }
  /**
   * ★ 分批第 257 批：`<label class="mem-switch">` 原来**没有样式**，于是继承了全局的
   *   `label { display: block; margin-bottom: var(--sp-3) }`——勾选框自成一块、上下各顶
   *   一行，看着像"布局坏了"。这里把它收成行内的小开关。
   */
  .mem-switch {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-dim);
    cursor: pointer;
    white-space: nowrap;
  }
  .mem-switch input {
    margin: 0;
  }

  /* 只读态没有开关，用同一行同一字号显示"开/关"，否则这一行会比编辑态塌掉一截。 */
  .mem-state {
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  /**
   * ★ 分批第 254 批：列表**限高 + 内部滚动**。
   *   上限是 100 条（第 267 批；单条压到 80 字）——真攒满时这一节会把整页顶到看不见底，
   *   而"它还记着什么"这件事不需要一次摊满整屏。
   */
  .mem-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    /* ⚠️ 这里原来写的是 `overflow: hidden`（那是给圆角裁切的）——它会把下面的
       `overflow-y: auto` 覆盖掉，于是"限高滚动"这条规则失效。合成一条写清楚。 */
    overflow-x: hidden;
    overflow-y: auto;
    max-height: 22rem;
    overscroll-behavior: contain;
  }
  /* 一条一行：★ + 类型 + 正文（省略号）+ 右侧极小的"用过几次"；动作悬停才出 */
  .mem-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: 2rem;
    padding: var(--sp-1) var(--sp-2) var(--sp-1) var(--sp-2);
    border-top: 1px solid var(--line);
    background: var(--surface);
  }
  .mem-list .mem-row:first-child {
    border-top: 0;
  }
  .mem-row:hover,
  .mem-row:focus-within {
    background: var(--surface-hover);
  }
  .mem-row[data-pinned='1'] {
    box-shadow: inset 2px 0 0 var(--warn);
  }
  .mem-row.dropped {
    opacity: 0.55;
  }
  .mem-row.dropped .mem-text {
    text-decoration: line-through;
  }
  .mem-pin {
    flex: 0 0 auto;
    width: 1rem;
    padding: 0;
    border: 0;
    background: none;
    color: transparent;
    cursor: pointer;
    font-size: var(--fs-sm);
    line-height: 1;
  }
  .mem-row:hover .mem-pin {
    color: var(--text-faint);
  }
  .mem-pin.on {
    color: var(--warn);
  }
  .mem-kind {
    flex: 0 0 auto;
    font-size: var(--fs-xs);
    padding: 0 var(--sp-2);
    border-radius: 999px;
    border: 1px solid var(--line-strong);
    color: var(--text-dim);
    white-space: nowrap;
  }
  .mem-kind[data-kind='preference'] { color: var(--status-review); }
  .mem-kind[data-kind='commitment'] { color: var(--good); }
  .mem-kind[data-kind='lesson'] { color: var(--warn); }
  .mem-kind[data-kind='fact'] { color: var(--accent); }
  .mem-text {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mem-text-input {
    flex: 1 1 auto;
    min-width: 0;
    font: inherit;
    font-size: var(--fs-base);
    padding: 0 var(--sp-2);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
  }
  .mem-meta {
    flex: 0 0 auto;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    white-space: nowrap;
  }
  .mem-actions {
    flex: 0 0 auto;
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .mem-row:hover .mem-actions,
  .mem-row:focus-within .mem-actions {
    opacity: 1;
  }
  .btn-mini {
    font: inherit;
    font-size: var(--fs-xs);
    padding: 0 var(--sp-1);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    white-space: nowrap;
  }
  .btn-mini:hover {
    color: var(--text);
    background: var(--surface-2);
  }
  .mem-add {
    display: flex;
    gap: var(--sp-2);
    align-items: center;
    margin-top: var(--sp-2);
  }
  .mem-add select {
    flex: 0 0 auto;
    width: auto;
    font-size: var(--fs-sm);
  }
  .mem-add input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .btn-small {
    font: inherit;
    font-size: var(--fs-sm);
    padding: var(--sp-1) var(--sp-2);
    border-radius: var(--radius);
    border: 1px solid var(--line-strong);
    background: var(--surface-2);
    color: var(--text-dim);
    cursor: pointer;
    white-space: nowrap;
  }
  .btn-small:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .btn-link {
    font: inherit;
    font-size: var(--fs-xs);
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    cursor: pointer;
  }
  .btn-link:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* 预览抽屉（只读） */
  .mem-preview-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 40;
  }
  .mem-preview {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(52rem, 94vw);
    z-index: 50;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-left: 1px solid var(--line);
    box-shadow: var(--shadow-2);
  }
  .mem-preview-head {
    flex: 0 0 auto;
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
    padding: var(--sp-4) var(--sp-5);
    border-bottom: 1px solid var(--line);
  }
  .mem-preview-head h2 {
    font-size: var(--fs-lg);
  }
  .mem-preview-head .spacer {
    flex: 1;
  }
  .mem-preview-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--sp-4) var(--sp-5);
  }
  .mem-preview-stats {
    margin: 0 0 var(--sp-2);
  }
  .mem-preview-text {
    margin: 0;
    padding: var(--sp-3);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.65;
    white-space: pre-wrap;
    color: var(--text-dim);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }
</style>
