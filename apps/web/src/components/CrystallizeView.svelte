<script lang="ts">
  /**
   * 聊天/任务沉淀 skill（D80）——全页流程（设计 §4.1.1 界面改版）。
   *
   * 形态：任务详情式全页（MainArea 壳），不再是抽屉。
   *   · 栏头：返回（回对话/任务）+ 标题 + 来源副题 + **随流程变的操作**；
   *   · 正文：步骤条 ①沉淀目标 → ②起草 run → ③审阅入库 + 分节渐进展开
   *     （素材摘要 / 沉淀目标 / 起草 run 日志常驻 / 草稿审阅 / 完成态）。
   *
   * 流程（设计文档 `docs/design/skill-crystallization.md`）：
   *   ① target：选「新建 skill」（必填作用描述）或「更新本次加载的 skill」
   *     （对话/任务实际注入的；提炼的=进化、安装的=存为你的版本并遮蔽）；
   *     素材统计（N 轮 · M 次工具调用）**起草前就可见**，空素材直接禁用开始；
   *   ② drafting：复用 RunLog 显示起草 run 的实时日志（现成能力），可停止；
   *   ③ review（四轮重做）：产出是**文件集合**——文件树 + 选中文件编辑/预览。
   *     name/description/slug **从 SKILL.md 的 frontmatter 解析**（不再手填：
   *     同一份内容两个出处必然漂）；入库只传 files，服务端复算。
   *     顶部给校验结论与变更集（新增/修改/删除）；多文件产物不再是"一段大文本"。
   *
   * 恢复进行中的起草（§4.1.1）：targets 给 activeDraft（最近的、未入库的草稿，
   * 含起草时落库的目标）——顶部提示「继续 / 新起草」；「继续」把草稿挂回本页
   * （起草中 → 看日志；已完成 → 直接进审阅）。
   *
   * ⚠️ 沉淀不是任务：起草 run 不在任务列表里（kind execute + subject
   *   skill-draft + 无 issueId），进度只在这页，关页即离场、重开按 source 找回。
   */

  import { FoldSection } from '@agentdeck/ui/components'
  import { api, ApiError, type Skill } from '../lib/api.ts'
  import { t } from '../lib/i18n.ts'
  import { go, goCrystallize } from '../lib/view.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import { showToast } from '../lib/view.ts'
  import { runStatusClass, runStatusKey } from '../lib/run-status.ts'
  // ★ 「最后结果」要按 Markdown 渲染（与任务详情页的最终产出同一观感）。
  //   ⚠️ 批次 2 删预览时把这个 import 一起删了——那是对的（预览是"同一份内容的第二种
  //   渲染"），这里是另一个用途：**起草 run 的最终产出**。两件事不要混。
  import { tick, onDestroy, onMount } from 'svelte'
  import { renderMarkdown } from '../lib/markdown.ts'
  import { draftIsLive } from '../lib/draft-live.ts'
  import { finalResultText } from '../lib/final-output.ts'
  import { crystallizeState, crystallizeStateKey } from '../lib/crystallize-state.ts'
  // ★ 分批第 140 批（U4a）：顶栏状态徽标的词条表——用 `satisfies Record<string, WebTextId>`
  //   把"键必须是真词条"交给类型检查（写错一个键 svelte-check 当场报）。
  import type { WebTextId } from '@agentdeck/i18n'
  import MainArea from './MainArea.svelte'
  import RunLog from './RunLog.svelte'
  import CrystallizeIntake from './CrystallizeIntake.svelte'

  /** 目标面板信息（对应 `GET /api/crystallize/targets`，含界面改版新增字段）。 */
  interface CrystallizeTargets {
    loadedSkills: Array<{
      id: string
      slug: string
      name: string
      description: string | null
      source: Skill['source']
    }>
    reviewed: boolean
    hasUserFeedback: boolean
    scope: 'conversation' | 'task'
    materialStats: { turns: number; toolCalls: number } | null
    activeDraft: {
      runId: string
      status: string
      target:
        | { kind: 'new' }
        | { kind: 'update'; skillId: string }
        | { kind: 'agent'; agentId: string }
    } | null
    /**
     * ★ 分批第 37 批：「沉淀成 Agent」的候选——这条 run 上真实用到的那两条。
     * `reviewer` 可能是 null（没选过审核者的任务）。
     */
    agentTargets: {
      executor: AgentTargetBrief
      reviewer: AgentTargetBrief | null
    }
  }

  /** 「沉淀成 Agent」候选（与服务端 `AgentTargetBrief` 同形）。 */
  interface AgentTargetBrief {
    id: string
    name: string
    role: string
    instructionsChars: number
    builtin: boolean
  }

  /** 源 run（对话轮次或任务执行 run）的 id。 */
  export let runId = ''
  /** 来源副题（对话标题 / 任务标题）。 */
  export let sourceLabel = ''
  /** 栏头返回按钮文案。 */
  export let backLabel = ''
  /** 返回（父组件关掉本页，回到来源视图）。 */
  export let onback: () => void = () => {}
  /** 入库成功后的回调（父组件刷新技能列表）。 */
  export let ondone: () => void = () => {}
  /** 放弃了一条起草的回调（父组件刷新沉淀列表）。 */
  export let ondiscarded: () => void = () => {}
  /**
   * ★ 分批第 147 批（§12.14：材料的两个显示处必须由同一份数据现算）：
   * 父组件给的"材料被**别处**改过"的信号——右栏产物栏里删掉了一份材料。
   * 变了就重读一次素材清单，中间那栏的「依据」块跟着更新。
   */
  export let materialRev = 0
  /** 本组件改了材料（追加）时通知父组件：右栏那一栏也要重读（否则"追加了但右栏看不见"）。 */
  export let onmaterialchange: () => void = () => {}
  /** 已经处理过的 `materialRev`（只认增量，不重复拉）。 */
  let seenMaterialRev = 0

  $: if (materialRev !== seenMaterialRev) {
    seenMaterialRev = materialRev
    // 父组件的 rev 只增不减；这里重读一次素材清单即可（`loadMaterial` 自己挡并发）
    if (draftRunId !== '') void loadMaterial()
  }

  let step: 'target' | 'drafting' | 'review' | 'done' = 'target'
  let targets: CrystallizeTargets | null = null
  let error = ''
  let loading = false

  // ── 目标选择 ──
  /**
   * 三种目标：新建 skill / 更新 skill / **优化一条已有智能体的指令**（分批第 37 批）。
   *
   * 使用者的口径：agent 指执行者或审核者；只优化它的指令、不碰它挂的 skill；
   * **不新建 agent，只更新当前这一条**。所以这一支下面没有"新建"，只有候选二选一。
   */
  let targetKind: 'new' | 'update' | 'agent' = 'new'
  let purpose = ''
  let userFeedback = ''
  let selectedSkillId = ''
  /** 要优化哪条智能体（候选来自这条 run 上真实用到的执行者 / 审核者）。 */
  let selectedAgentId = ''

  // ── 起草 ──
  let draftRunId = ''
  /** 起草 run 的终态（completed/failed/cancelled）——徽标与失败态用。 */
  let draftStatus: string | null = null
  let draftFailedReason = ''
  let materialStats: { turns: number; toolCalls: number } | null = null
  /** 已处理过终态（防 RunLog 重复触发 / 已手动处理过）。 */
  let handledTerminal = false

  /**
   * 审核区的**日志开关**（§10.5 第 ⑤ 步；2026-10-21 使用者："审核的过程看不到，
   * 感觉一直没结束呢"）。
   *
   * 跑着的时候**不给**这个开关：那时日志必须直接铺开——"过程看不见"正是原来的毛病。
   * 它只在跑完之后用，让人回看这一版是怎么被审的（与任务页「最后结果 / 完整日志」
   * 同一个交互：换的是同一块位置里的内容）。
   */
  /**
   * ★ 分批第 143 批（U4d，§12.7「删掉的东西：tab 机制」）：审阅态的 `草稿 / 依据 / 过程`
   *   三个 tab **已删**。现在这一屏只有两块：**消息流里的产物消息**（树 + 编辑/差异并排）与
   *   **右栏的常驻产物栏**（文件 / 体检 / 版本 / 材料清单）。依据在右栏（§12.14「右栏是正式清单」），
   *   起草过程在它自己的**系统消息**里（U3b 已经搬过去，这一批让它跑到审阅态也还在）。
   */


  /**
   * 起草中那一屏的两个 tab：`产出` / `依据`（2026-10-21 第 4 批）。
   *
   * 裁定与审阅屏同一条轴——哪些必须同时看到：
   *   · 产出 = 那条 run 的**实时输出**（跑着的时候它是唯一的实时信息，所以默认停在这里）；
   *   · 依据 = 起草者据以干活的东西：**目标摘要**（新建 / 更新谁）+ **素材**（它按需读的文件）。
   * ⚠️ 审阅屏的「依据」只有素材——因为那边"目标是谁"已经在结论条上了（`新建 skill` / `更新 x`）。
   *    起草中这一屏**没有结论条**，所以目标摘要归到依据里：同一件事不在两处重复，也不凭空消失。
   */

  /**
   * 「起草 run」那一块的两态（2026-10-21 使用者："下面的起草run 的日志，应该类似任务中
   * 的最后结果和完整日志一样的切换方式"）。
   *
   * 默认给**最后结果**：审阅这一屏人要看的是"它交了什么"，而原始流水是回查用的。
   * 与任务详情页同一个交互与同一批措辞（`tasks.finalResult` / `tasks.showRawLog`…）。
   */
  let draftLogOpen = false
  /** 起草 run 的最后一段正文（剥掉判决围栏后的那一段）。 */
  let draftFinalText = ''
  /** 最后结果取到了没有（`'loading'` 与"确实没有文字产出"必须分开说）。 */
  let draftFinalState: 'loading' | 'ready' | 'empty' = 'loading'

  // ── 恢复进行中的起草 ──
  let attached = false

  // ── 审阅（四轮：产出 = 文件集合）──
  /** `GET /api/crystallize/artifacts` 的返回（服务端已解析 + 已校验）。 */
  let artifacts: Artifacts | null = null
  /** 当前选中的文件（相对 skill/ 目录）。 */
  let selectedFile = 'SKILL.md'
  /** 编辑区内容（与 selectedFile 联动；写入即回写 artifacts.files）。 */
  let editText = ''
  /** 每次编辑 +1：让"从文件里解析出的 frontmatter 摘要"能重算（普通对象不触发响应）。 */
  let filesVersion = 0
  /**
   * 有未保存的改动（分批第 8 批：人改草稿要能落盘）。
   *
   * ⚠️ `artifacts.files` 是**就地改**的（`onEditInput` 直接写它），所以"改过没有"这件事
   *    没有任何现成的信号——必须自己记。第一版我打算用"与磁盘上那版比 diff"来推，
   *    但 diff 是**异步**拉的（停 500ms 才算），保存按钮的状态会跟着它一跳一跳的。
   */
  let dirty = false
  /** 正在保存改动（防连点：保存是写盘，连点会让"最后一次"变得不确定）。 */
  let savingDraft = false
  /** 变更集 diff（后端算）：对当前已入库版本，或对比上一版草稿。 */
  let diff: DiffResult | null = null
  let diffLoading = false
  /** 对比对象：对当前版本（入库会产生的变化）或上一版草稿（改版对比）。 */
  /** 当前停在哪条基线：原 skill / 上一版草稿 / 当前已入库版本（分批第 18 批起三条）。 */
  let diffAgainst: 'current' | 'previous' | 'original' = 'current'
  /** 素材分节（文件清单 + 预览）。 */
  let material: {
    dir: string
    /** 目录短名（只显示末两级，整条路径放进 title）——折叠行摘要里不能塞绝对路径。 */
    dirLabel: string
    items: Array<{ relPath: string; bytes: number; text: string; truncated: boolean }>
  } | null = null
  /** 主区窗格的分段：内容 / 差异（同一位置切换，见 markup 里的三条规矩）。 */
  let reviewTab: 'content' | 'diff' = 'content'

  /**
   * ★ 分批第 121 批（U3d）：栏脚输入条真的接线了。
   *
   * 意图路由**规则优先、不让模型猜**（§12.12）：能对上一条已有动作的，就直接走那条动作；
   * 对不上的**不假装懂**——回一条"我把它当成补充，但目前没有落点"。每句话都留一行回执，
   * 使用者才知道平台怎么理解的。
   *
   * ★ 分批第 130 批：「追加材料」也有落点了（`POST /api/crystallize/material`）——它不再是
   * "如实说没有写接口"，而是真的把正文写进这一条草稿的素材、登记进索引、右栏立刻看得见。
   */
  let composerText = ''
  let composerReceipt = ''
  /** 「追加材料」正在写（防连点：它会写盘 + 让右栏重读素材）。 */
  let appendingMaterial = false
  /** 「按意见改一版」的输入框是否展开（不常驻，见结论条）。 */
  let reviseOpen = false
  /**
   * 「按意见改一版」的意见框（填清单后把光标放进去，见 `fillFeedbackFromAudit`）。
   *
   * ⚠️ 这里**不能**写 `$state`：本组件用的是 `export let`（legacy 模式），混进 `$state`
   *    会被 Svelte 判成 runes 模式而整个组件报 `Cannot use 'export let' in runes mode`，
   *    连带着 `views/Crystallize.svelte` 传进来的 props 全变成 `never`（一堆看不懂的错误）。
   *    `bind:this` 只需要一个普通变量——它不需要驱动渲染。
   */
  let feedbackBox: HTMLTextAreaElement | null = null
  /** 问题清单是否展开（结论常驻、明细折叠，与全站其它地方同一条规矩）。 */
  // （`auditDetailOpen` / `auditLogOpen` 随第 3 批删掉了：问题清单与审核日志现在住在
  //   「过程」tab 里，结论条上那两个按钮改成**切到那个 tab**——不再各有一个折叠开关。）
  let materialPick = ''
  let materialLoading = false
  /** 「按意见改一版」的意见输入。 */
  let reviseFeedback = ''
  let revising = false
  /** 这一版是基于哪条草稿改的（界面显示"改自上一版"用；真值在 run.revisedFrom 上）。 */
  let previousDraftId = ''
  /** 编辑 → diff 的防抖计时器。 */
  let diffTimer: ReturnType<typeof setTimeout> | null = null
  let saving = false
  /** 入库用的 slug：默认取 SKILL.md 的 name，新建时可改（更新不允许改，服务端会拦）。 */
  let slug = ''
  /** 审阅里的冲突提示（新建撞提炼根同 slug）。 */
  let clash: { slug: string; name: string; id: string } | null = null

  /** 草稿产出的接口形状（与 `apps/daemon/src/crystallize-artifacts.ts` 对齐）。 */
  interface Artifacts {
    status: string
    mode: 'files' | 'text' | 'refused' | 'agent'
    refusalReason?: string
    files: Record<string, string>
    skillMd: { name: string; description: string; body: string; raw: string }
    validation: { ok: boolean; problems: Array<{ file: string; message: string }> }
    target:
      | { kind: 'new' }
      | { kind: 'update'; skillId: string }
      | { kind: 'agent'; agentId: string }
      | null
    baseline: { slug: string; files: Record<string, string> } | null
    materialDir: string
    /** 「按意见改一版」来的草稿：上一版 run id（有它才给"对比上一版"）。 */
    revisedFrom: string | null
  }

  /** 变更集（`POST /api/crystallize/diff` 的返回，后端算好、这里只画）。 */
  interface DiffFile {
    rel: string
    change: 'A' | 'M' | 'D' | 'same'
    added: number
    removed: number
    hunks: Array<{
      oldStart: number
      newStart: number
      lines: Array<{ kind: ' ' | '+' | '-'; text: string; oldNo: number | null; newNo: number | null }>
    }>
    coarse: boolean
  }
  interface DiffResult {
    against: 'current' | 'previous' | 'original'
    baselineLabel: string
    files: DiffFile[]
    totals: { added: number; removed: number; changed: number }
  }

  // ── 完成态 ──
  let doneSkillName = ''
  let doneVersioningNote = ''

  /** 素材统计（起草前用 targets 的，起草后用手头的，两者同源）。 */
  $: stats = materialStats ?? targets?.materialStats ?? null
  $: statsLine =
    stats === null
      ? ''
      : $t('crystallize.materialSummary', {
          turns: String(stats.turns),
          tools: String(stats.toolCalls),
        })

  /**
   * 结论条的标记（一个字符说清"能不能入库"）：只看**机械体检**。
   *
   * ★ 分批第 137 批（§12.42 第 ③ 步）：沉淀线的「审核」整条删掉之后，结论条不再有"审核结论"，
   * 剩下的唯一判据是 `validateArtifactFiles`（frontmatter / 必填节 / 引用 / 连线平衡…）。
   * `○` 只在还没读到产出时出现——画 ✓ 或 ✗ 都是撒谎。
   */
  $: conclusionMark =
    artifacts === null ? '○' : artifacts.validation.ok ? '✓' : '✗'
  $: conclusionBad = conclusionMark === '✗'

  /**
   * ★ 分批第 140 批（U4a，§12.6/§12.7）：**步骤条删除**。设计原文是
   *   「3 步步骤条 → 删除（对话流里由消息位置表达进度；顶栏只留状态徽标）」——
   *   进度不再靠一个横向的三段式控件说，而是：消息流里"问到哪、答到哪"本身就说明了进度，
   *   顶栏只挂一个状态徽标（提问中 / 起草中 / 待审阅 / 已入库 / 失败）。
   */
  const STATUS_KEYS = {
    asking: 'crystallize.status.asking',
    drafting: 'crystallize.state.drafting',
    review: 'crystallize.state.review',
    done: 'crystallize.state.done',
    failed: 'crystallize.state.failed',
    stopped: 'crystallize.state.stopped',
  } as const satisfies Record<string, WebTextId>

  $: stepStatusKey =
    step === 'done'
      ? STATUS_KEYS.done
      : step === 'review'
        ? STATUS_KEYS.review
        : step === 'drafting'
          ? draftStatus === 'failed'
            ? STATUS_KEYS.failed
            : draftStatus === 'cancelled'
              ? STATUS_KEYS.stopped
              : STATUS_KEYS.drafting
          : STATUS_KEYS.asking
  $: stepStatusClass = (() => {
    if (step === 'done') return 'done'
    if (step === 'review') return 'in_review'
    if (step === 'drafting') {
      if (draftStatus === 'failed') return 'failed'
      if (draftStatus === 'cancelled') return 'cancelled'
      return 'in_progress'
    }
    return 'in_progress'
  })()

  /*
   * ⚠️ 这里原来有一个 `auditState`（把审核画成步骤条的第 3 步：✓ / ✗ / 进行中）。
   *    2026-10-21 步骤条回到 3 步之后它没有使用者了，**直接删掉**——本仓库最不缺的
   *    就是"字段还在、就是没有代码路径让它发生"（规则 5）。审核的态由审核块自己说
   *    （`auditStatus` / `auditRunning` / `auditSettled`），同一件事只有一个判据。
   */

  /**
   * "不通过且**额度已用尽**"（判决状态是 `escalated`）——这是唯一该出现
   * 「重新起草 / 明知未通过仍入库」两个按钮的时刻。
   *
   * ⚠️ 与 `rework_requested` 分得清：那个状态表示**平台已经自动重新起草了一版**，
   *   这时再给"重新起草"按钮，等于把人又推进同一条自动流程（他刚看过的那一版已经作废）。
   */
  /**
   * 起草那一版是不是**还在跑**（分批第 29 批）。
   *
   * `draftStatus === null` = 还没收到终态（`resumeDraft` 接上在跑的 run、或者刚跟到新版），
   * 这与"跑完/失败/取消"必须分开：前者要显示**实时日志**，后者才有"最后结果"可看。
   * 判据里不写死某个状态名，而是"没进终态即在跑"——状态机加一个非终态值不会让这里失准。
   */
  // 判据抽到 `lib/draft-live.ts`：组件里的行为要真浏览器夹具才量得到，
  // 而这条判据（状态未知/非终态 ⇒ 显示实时日志）在单测里就能钉死。
  $: draftLiveNow = draftIsLive(draftStatus)

  // ★ 分批第 150 批：原来这里有一个 `canStart`（顶栏「开始沉淀」按钮的 `disabled`）。
  //   按钮搬进目标态那一问之后它就是死代码，删掉。**它守的两件事没有丢**：
  //   ① 任务门槛（§4.3：有用户反馈或审核过才可沉淀）——`startDisabledReason` 把它说成一句话，
  //      `CrystallizeIntake` 的「开始提炼」按它禁用；服务端 `POST /api/crystallize/draft` 也拦
  //      （`task_gate`），前端这道只是让人**在点之前**就知道原因；
  //   ② "更新要选一个技能 / 优化指令要选一条智能体"——那是 intake 的必答项，没选就不会到 ready。

  /**
   * 审阅是否可入库：**校验通过**才行。
   *
   * ★ 改之前这里是 `slug/name/body 都非空`——那是"四个输入框"时代的口径。
   *   现在前端不再自己拼正文：文件集合与问题清单都来自服务端，前端只负责显示与
   *   "编辑哪个文件"。所以可入库的条件换成"服务端说没问题"，并且 slug 有值。
   */
  $: isAgentDraft = artifacts !== null && artifacts.mode === 'agent'
  // 智能体草稿没有 slug 这回事（不新建、不改名）⇒ 可入库只看服务端校验那三条
  $: reviewValid = isAgentDraft
    ? artifacts !== null && artifacts.validation.ok
    : artifacts !== null && artifacts.validation.ok && slug.trim() !== ''

  /** 开始沉淀按钮的悬停解释：素材为空 / 任务门槛不过，分开说清。 */
  $: startDisabledReason =
    targets !== null && targets.materialStats === null
      ? $t('crystallize.noMaterial')
      : targets !== null && targets.scope === 'task' && !(targets.reviewed || targets.hasUserFeedback)
        ? $t('crystallize.taskGated')
        : undefined

  $: runShort = draftRunId !== '' ? draftRunId.slice(0, 4) : ''

  /** 状态徽标的字（共享词表，与任务详情的 run 徽标同一份）。 */
  function statusLabel(status: string): string {
    return $t(runStatusKey(status))
  }

  async function loadTargets(): Promise<void> {
    // ★ 分批第 133 批：空白起**没有来源 run** ⇒ 没有可算的目标面板（`GET /crystallize/targets`
    //   按 runId 查，给它 `blank` 只会 404）。targets 保持 null，目标面板换成空白起的那一问。
    // ★ 分批第 141 批：起点屏（`new`）同样没有来源 run，也不问 targets。
    if (blankMode || newMode) {
      loading = false
      targets = null
      error = ''
      if (newMode) void loadSources()
      return
    }
    loading = true
    error = ''
    try {
      targets = await api<CrystallizeTargets>(
        `/api/crystallize/targets?runId=${encodeURIComponent(runId)}`,
      )
      /**
       * ★ 分批第 141 批（U4b，§12.7）：**删掉「恢复进行中的起草」这条显式路径**——
       *   设计原文是"状态在列表行上 + 直接点进去（不再有'恢复'这个动作）"。
       *   所以进到一条有进行中草稿的来源页时**直接接上**，不再问「继续 / 新起草」。
       */
      autoAttachOnce()
    } catch (err) {
      error = $t('crystallize.errTargets', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      loading = false
    }
  }

  /** 整页状态清零（换来源 / 重来时用；目标选择与草稿全丢，从目标态重新开始）。 */
  function resetFlow(): void {
    step = 'target'
    error = ''
    targetKind = 'new'
    purpose = ''
    userFeedback = ''
    selectedSkillId = ''
    draftRunId = ''
    draftStatus = null
    draftFailedReason = ''
    materialStats = null
    handledTerminal = false
    attached = false
    // ★ 分批第 143 批：自动接上的护栏是**每个 run 一次**——换了 runId 必须复位，
    //   否则同一组件实例里换屏之后永远不再自动接（探针用 iframe 连续切换多条夹具，当场量到）。
    autoAttached = false
    artifacts = null
    selectedFile = 'SKILL.md'
    editText = ''
    filesVersion = 0
    diff = null
    diffAgainst = 'current'
    material = null
    materialPick = ''
    reviewTab = 'content'
    reviseOpen = false
    reviseFeedback = ''
    revising = false
    previousDraftId = ''
    slug = ''
    saving = false
    clash = null
    doneSkillName = ''
    doneVersioningNote = ''
  }

  // ★ 换了来源 run（任务列表里点另一条，流程页还开着）：整页清零重来，
  //   不然上个来源的步骤/草稿会残留在这条新来源上。
  let loadedRunId = ''
  $: if (runId !== '' && runId !== loadedRunId) {
    loadedRunId = runId
    resetFlow()
    void loadTargets()
  }

  /**
   * ★ 分批第 27 批：**详情页自己轮询**，链上出现新版就自动跟过去。
   *
   * 使用者原话：「在多轮 起草-审核 过程中，界面没有更新，看不出来是否已经结束了。」
   *
   * 根子是可量的：这个组件里**一个定时器都没有**（`grep setInterval` 为空），只在
   * 「进页面 / 点按钮 / RunLog 报终态」时读一次。于是自动返工起第 N+1 版、审核跑完、
   * 循环停掉——界面全都不动，人只能靠切页面撞运气。列表页（`Crystallize.svelte`）
   * 有 6 秒轮询，所以**列表变了、详情没变**，看起来就更像"卡住了"。
   *
   * `GET /api/crystallize/targets` 实测 25ms，5 秒一次完全不心疼。
   *
   * ⚠️ 正在编辑正文（`dirty`）时不抢：自动切走会把没保存的字丢掉。这时候只挂一条
   *    「已经有新版」的提示，点一下再过去。
   */
  let pollTimer: ReturnType<typeof setInterval> | null = null
  /** 轮询发现链上出现新版、但因为正在编辑而没自动切过去。 */
  let pendingNewVersion = ''
  // ⚠️ 不自己算"改没改"：组件里本来就有 `dirty`（读盘时清、输入时置 true）。
  //    我第一版在这写了 `$: dirty = editText !== diskText`，等于把一个**已经在用**的
  //    变量重新定义了——它会让「保存改动」按钮的显示条件跟着一个不存在的 `diskText` 走。

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  /** 链上出现了比我现在看的更新的一版 ⇒ 跟过去（除非正在编辑）。 */
  function followNewVersion(nextRunId: string): void {
    if (nextRunId === '' || nextRunId === draftRunId) return
    if (dirty) {
      pendingNewVersion = nextRunId
      return
    }
    pendingNewVersion = ''
    draftRunId = nextRunId
    handledTerminal = false
    /**
     * ★ 分批第 29 批：**必须把上一版的状态清掉**。
     *
     * 使用者报的：「在草稿-审核的循环中，只能看到审核过程，草稿的日志在UI上一直没有更新」。
     *
     * 我就是在这儿漏的：跟到新一版时只换了 `draftRunId`，`draftStatus` 还留着上一版的
     * `completed` ⇒ 草稿那一格走"最后结果"分支（上一版的旧文本），永远不会挂实时日志；
     * 而审核那一格有自己的日志流 ⇒ 表现正是"只看得到审核过程"。
     * 现在按"这一版状态未知（= 在跑）"重置，草稿格就会自动显示实时日志。
     */
    draftStatus = null
    draftFinalText = ''
    draftFinalState = 'loading'
    artifacts = null
    diff = null
    void loadMaterial()
    void loadDraftOutput()
    void loadDraftFinalText()
  }

  async function pollOnce(): Promise<void> {
    try {
      const t2 = await api<CrystallizeTargets>(
        `/api/crystallize/targets?runId=${encodeURIComponent(runId)}`,
      )
      targets = t2
      // ① 链上冒出新版（自动返工）⇒ 跟过去，别让界面停在上一版
      const ad = t2.activeDraft
      if (attached && ad) followNewVersion(ad.runId)
      // ★ 分批第 137 批：审核删掉之后，轮询只需要"链上冒出新版就跟过去"这一件事
    } catch {
      // 轮询失败不打扰人（网络抖一下很常见）：下一次再试
    }
  }

  onMount(() => {
    void loadTargets()
    pollTimer = setInterval(() => void pollOnce(), 5000)
  })
  onDestroy(stopPolling)

  /** 自动接上的护栏：只做一次（轮询会反复把 targets 读回来，不能每次都接一遍）。 */
  let autoAttached = false
  function autoAttachOnce(): void {
    if (autoAttached || attached) return
    if (step !== 'target') return
    if (!targets?.activeDraft) return
    autoAttached = true
    resumeDraft()
  }

  /** 挂回进行中的起草（§4.1.1；★ 分批第 141 批起**自动**接，不再是一个按钮）。 */
  function resumeDraft(): void {
    const ad = targets?.activeDraft
    if (!ad) return
    attached = true
    draftRunId = ad.runId
    handledTerminal = false
    // 素材在起草开始前就已经落盘：起草中也让使用者能翻同一份（而不是等审阅）
    void loadMaterial()
    // 还原起草时的目标（commit 按它走：更新 = 复用原 id 进化；agent = 只覆盖指令）
    if (ad.target.kind === 'new') {
      targetKind = 'new'
    } else if (ad.target.kind === 'agent') {
      targetKind = 'agent'
      selectedAgentId = ad.target.agentId
    } else {
      targetKind = 'update'
      selectedSkillId = ad.target.skillId
    }
    if (ad.status === 'completed') {
      // 已完成待审阅 → 直接进审阅（草稿在 run 消息里）
      draftStatus = 'completed'
      handledTerminal = true // RunLog 挂上会重放终态，别二次处理
      void loadDraftOutput()
      /**
       * ★ 分批第 33 批：这里原来**漏了**读"最后结果"。
       *
       * `draftFinalState` 的初值是 `'loading'`，只有 `loadDraftFinalText()` 会把它改掉；
       * 接上一条**已完成**的草稿走的是这一支，它只读了产出与审核 ⇒ 「过程 → 草稿过程」
       * 那一格**永远停在骨架**（探针量到 `.draft-final` 是 null 才发现的：格子 457px、
       * 内容 0px）。这条路径是审阅屏的默认入口，所以不是边缘情况。
       */
      void loadDraftFinalText()
    } else if (ad.status === 'failed' || ad.status === 'cancelled') {
      draftStatus = ad.status
      step = 'drafting'
      void fetchDraftFailure(ad.runId)
    } else {
      // 起草中 → 看实时日志，终态由 onterminal 接
      draftStatus = null
      step = 'drafting'
    }
  }

  /** 向导答完 → 落回原有目标状态 → 走原提交路径（`startDraft`）。 */
  /**
   * ★ 分批第 133 批（「从空白/材料起」）：「起点」是空白起时 `runId` prop 是哨兵值 `blank`，
   * 这一批把"无来源 run 的草稿"接到界面上（daemon 那一半已在第 133 批里）。
   *
   * 为什么哨兵值而不是新开一个路由：`#/crystallize/<id>` 的 id 本来就可以是任何串（深链用），
   * `blank` 不是合法 ULID ⇒ 与真 run id 不可能撞。新增一条路由会让"返回/刷新/分享"多一处要维护。
   */
  const BLANK_RUN_ID = 'blank'
  $: blankMode = runId === BLANK_RUN_ID
  /**
   * ★ 分批第 141 批（U4b，§12.7）：**「新建沉淀」不再弹 Modal** ⇒ 用一个哨兵路由
   * `#/crystallize/new` 承接"还没选来源"的那一屏：页面里一条消息问「这一次要沉淀什么？」，
   * 选项 = 最近的会话/任务 + 「从空白或材料起」。选中来源就跳到那一条来源的页面
   * （`#/crystallize/<sourceRunId>`），从空白起就跳 `#/crystallize/blank`。
   */
  const NEW_RUN_ID = 'new'
  $: newMode = runId === NEW_RUN_ID
  /** 起点屏的来源清单（`GET /api/crystallize/sources`）。 */
  let sourceOptions: Array<{ kind: 'conversation' | 'task'; label: string; runId: string }> = []
  let sourcesLoading = false

  /** 读"可以从哪条会话/任务沉淀"（只在起点屏用）。 */
  async function loadSources(): Promise<void> {
    if (!newMode) return
    sourcesLoading = true
    try {
      const res = await api<{
        items: Array<{ kind: 'conversation' | 'task'; label: string; runId: string }>
      }>('/api/crystallize/sources')
      sourceOptions = res.items
    } catch {
      sourceOptions = []
    } finally {
      sourcesLoading = false
    }
  }
  let blankMaterialText = ''
  let blankStart = false
  /**
   * `CrystallizeIntake` 的实例：栏脚输入条把作答**直接交给它**（`answerFromComposer` 返回
   * 被落到哪一问、或 `null` 表示"这一问不是文字题"）。
   *
   * ⚠️ 为什么不用 `bind:stage` 回传"问到了哪一步"：父组件是 legacy 模式、子组件是 runes，
   *    实测 `bind:` 没把子组件的 stage 变化写回父级（回执会说错是哪一问；方法调用没有这问题）。
   */
  let intakeRef: {
    answerFromComposer?: (text: string) => 'purpose' | 'blankMaterial' | null
  } | null = null

  function applyIntake(payload: {
    kind: 'new' | 'update' | 'agent'
    skillId: string
    agentId: string
    purpose: string
    feedback: string
    /** 空白起才有的两项（见 CrystallizeIntake 的 blank 流程）。 */
    blank?: boolean
    material?: string
  }): void {
    targetKind = payload.kind
    purpose = payload.purpose
    selectedSkillId = payload.skillId
    selectedAgentId = payload.agentId
    userFeedback = payload.feedback
    blankStart = payload.blank === true
    blankMaterialText = payload.material ?? ''
    void startDraft()
  }

  async function startDraft(): Promise<void> {
    error = ''
    attached = true // 点了开始 = 放弃旧的提示
    if (targetKind === 'update' && selectedSkillId === '') {
      error = $t('crystallize.targetUpdate')
      return
    }
    if (targetKind === 'agent' && selectedAgentId === '') {
      error = $t('crystallize.targetAgent')
      return
    }
    try {
      const target =
        targetKind === 'new'
          ? { kind: 'new' as const, purpose: purpose.trim() }
          : targetKind === 'agent'
            ? { kind: 'agent' as const, agentId: selectedAgentId }
            : { kind: 'update' as const, skillId: selectedSkillId }
      /**
       * ★ 分批第 133 批：空白起走 `startFrom: 'blank'`——**没有来源 run**，素材是使用者
       * 在提问里给的那一段（可空）。不带 `runId`（两者只能二选一，daemon 会 400）。
       */
      const body =
        blankStart || blankMode
          ? {
              startFrom: 'blank' as const,
              target: { kind: 'new' as const, purpose: purpose.trim() },
              ...(blankMaterialText.trim() === ''
                ? {}
                : { materials: [{ text: blankMaterialText.trim() }] }),
            }
          : {
              runId,
              target,
              ...(userFeedback.trim() !== '' ? { userFeedback: userFeedback.trim() } : {}),
            }
      const res = await api<{ draftRunId: string; materialStats: { turns: number; toolCalls: number } }>(
        '/api/crystallize/draft',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      draftRunId = res.draftRunId
      materialStats = res.materialStats
      draftStatus = null
      draftFailedReason = ''
      handledTerminal = false
      step = 'drafting'
      // 新起草一律从「产出」开始：跑起来的时候实时输出是唯一的信息（依据是"回头再看"的）
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      error = $t('crystallize.errDraftRejected', { error: msg })
    }
  }

  async function stopDraft(): Promise<void> {
    try {
      await api(`/api/runs/${draftRunId}/cancel`, { method: 'POST' })
    } catch {
      // 停止失败不阻塞：回到目标面板，让使用者决定下一步
    }
    draftStatus = 'cancelled'
    handledTerminal = true
    step = 'target'
  }

  /** 重新起草：回目标态（选择保留），开始按钮重发。 */
  function retryDraft(): void {
    step = 'target'
    draftRunId = ''
    draftStatus = null
    draftFailedReason = ''
    handledTerminal = false
    error = ''
  }

  /**
   * 放弃草稿：**真的**把它从列表里去掉，然后回目标态。
   *
   * ★ 三轮修：原来这里只重置本地状态——草稿仍在库里、仍在左栏（使用者看到"很多
   * 沉淀任务标注已完成、实际没完成"）。现在打 `/api/crystallize/discard`（服务端
   * 记 `discarded: true`，还在跑会先停），列表那边的「×」走同一条路。
   */
  async function abandonReview(): Promise<void> {
    if (draftRunId !== '') {
      if (
        !(await askConfirm({
          title: $t('crystallize.abandon'),
          message: $t('crystallize.discardConfirm', { label: sourceLabel }),
          confirmLabel: $t('crystallize.abandon'),
          danger: true,
        }))
      )
        return
      try {
        await api('/api/crystallize/discard', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ draftRunId }),
        })
        ondiscarded()
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
        return
      }
    }
    step = 'target'
    draftRunId = ''
    draftStatus = null
    handledTerminal = false
    artifacts = null
    selectedFile = 'SKILL.md'
    editText = ''
    slug = ''
    clash = null
    error = ''
  }

  /** 起草 run 到终态：completed → 取草稿进审阅；否则留在起草节显示失败态。 */
  async function onDraftTerminal(status: string): Promise<void> {
    // 起草刚跑完：把「最后结果」也读回来（否则切到审阅态时那一段是空的）
    if (status === 'completed') void loadDraftFinalText()
    if (handledTerminal || step === 'done') return
    handledTerminal = true
    if (status === 'completed') {
      draftStatus = 'completed'
      await loadDraftOutput()
    } else {
      draftStatus = status === 'cancelled' ? 'cancelled' : 'failed'
      step = 'drafting'
      void fetchDraftFailure(draftRunId)
    }
  }

  async function fetchDraftFailure(id: string): Promise<void> {
    try {
      const run = await api<{ failureReason: string | null }>(`/api/runs/${id}`)
      draftFailedReason = run.failureReason ?? ''
    } catch {
      draftFailedReason = ''
    }
  }

  /**
   * 取草稿产出（四轮：`GET /api/crystallize/artifacts`）。
   *
   * ★ 改之前这里自己拉 run 的消息、自己拆 frontmatter——解析规则被复制到前端，
   *   而且 `===== FILE: xxx =====` 那段多文件约定**从来没被解析**（多文件产物被
   *   塞进正文丢掉）。现在服务端读 `skill/` 目录、解析 frontmatter、跑校验，前端只画。
   */
  async function loadDraftOutput(): Promise<void> {
    try {
      const res = await api<Artifacts>(
        `/api/crystallize/artifacts?draftRunId=${encodeURIComponent(draftRunId)}`,
      )
      artifacts = res
      // 目标以**落库的目标**为准（恢复的草稿按它还原）；界面上的 targetKind 跟着走
      if (res.target !== null && res.target !== undefined) {
        if (res.target.kind === 'update') {
          targetKind = 'update'
          selectedSkillId = res.target.skillId
        } else if (res.target.kind === 'agent') {
          // ★ 分批第 37 批：优化指令的草稿没有 slug 这回事（不新建、不改名）
          targetKind = 'agent'
          selectedAgentId = res.target.agentId
        }
      }
      slug = res.skillMd.name
      // 改版草稿默认对比上一版（那才是使用者此刻在问的问题）；否则对比当前版本
      // ★ 分批第 18 批把默认从「上一版」翻成「原 skill」：这是使用者的定稿
    //    （"skill 差异对比也应该是原 skill 变化"）。"上一版"只回答"我这轮反馈改了什么"，
    //    而"相对原来那一份变成了什么样"才是他盯着一个新版本时要判断的事。
    //    ⚠️ 这翻掉了第 14 批"默认停在对比上一版草稿"那条决定（连探针判据一起改，见 §10.34）。
    diffAgainst = res.revisedFrom !== null ? 'original' : 'current'
      void loadDiff(diffAgainst)
      void loadMaterial()
      const first = pickDefaultFile(res)
      selectedFile = first
      editText = res.files[first] ?? ''
      filesVersion += 1
      // 刚读到的就是磁盘上的那一份 ⇒ 没有未保存的改动（换版/重读之后必须清，
      // 否则「保存改动」会挂着一个上一版留下的状态，点下去写的是同一份内容）
      dirty = false
      clash = null
      error = ''
      step = 'review'
      // 「最后结果」跟着一起读：这一屏默认显示的就是它（不读就会先闪一句"没有文字产出"）
      void loadDraftFinalText()
    } catch (err) {
      step = 'drafting'
      error = $t('crystallize.errTargets', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * 只重读「机械体检」那一份（保存改动之后用）。
   *
   * 为什么不是整份 `loadDraftOutput()`：那个会重置编辑现场（`editText` / `selectedFile` /
   * `dirty`），而保存之后磁盘上现在就是使用者刚存的内容——他要看到的只是"体检还过不过"。
   */
  async function refreshValidation(): Promise<void> {
    if (draftRunId === '') return
    try {
      artifacts = await api<Artifacts>(
        `/api/crystallize/artifacts?draftRunId=${encodeURIComponent(draftRunId)}`,
      )
    } catch {
      // 读不到就保留上一次的体检结果（下次进入这一屏会重读）；不把失败画成"通过"
    }
  }

  /**
   * 读起草 run 的**最后结果**（最后一段正文）。
   *
   * 与任务页 `loadResult` 同一条规矩：取**最后一条** text 而不是拼接——中间那些
   * "我先看一下目录"的过程话不属于结论。判决围栏由 `finalResultText` 剥掉
   * （起草 run 不带判决，传 `false` ⇒ 原样；留这个参数是为了与任务页同源）。
   */
  async function loadDraftFinalText(): Promise<void> {
    draftFinalState = 'loading'
    try {
      const out = await api<{ messages: Array<{ type: string; content: string }> }>(
        `/api/runs/${encodeURIComponent(draftRunId)}/messages`,
      )
      const texts = (out.messages ?? []).filter(
        (m) => m.type === 'text' && m.content.trim() !== '',
      )
      const last = texts.length > 0 ? texts[texts.length - 1]!.content : ''
      draftFinalText = finalResultText(last, false)
      draftFinalState = draftFinalText.trim() === '' ? 'empty' : 'ready'
    } catch {
      // 读不到就如实说"没有文字产出"（附带的提示里让人去看完整日志）——不要假装在加载
      draftFinalText = ''
      draftFinalState = 'empty'
    }
  }

  /** 默认选中 SKILL.md；没有就选第一个文件（起草者写歪时也别给空白页）。 */
  function pickDefaultFile(res: Artifacts): string {
    if (res.files['SKILL.md'] !== undefined) return 'SKILL.md'
    const first = Object.keys(res.files).sort()[0]
    return first ?? ''
  }

  /** 切换选中文件：把编辑区内容换过去（当前文件的编辑已经回写进 files）。 */
  function selectFile(rel: string): void {
    // 点文件 = 想看内容；留在「差异」标签会让人以为点错了
    reviewTab = 'content'
    selectedFile = rel
    editText = artifacts?.files[rel] ?? ''
  }

  /** 编辑回写：入库传的就是这份 files（服务端还会再校验一遍）。 */
  function onEditInput(): void {
    if (artifacts === null || selectedFile === '') return
    artifacts.files[selectedFile] = editText
    filesVersion += 1
    dirty = true
    // diff 跟着内容走，但**不要每敲一个字发一次请求**：停下来 500ms 再算
    if (diffTimer !== null) clearTimeout(diffTimer)
    diffTimer = setTimeout(() => {
      diffTimer = null
      void loadDiff()
    }, 500)
    // 改的就是 SKILL.md → slug 跟着 frontmatter 的 name 走（新建时才允许改）
    if (selectedFile === 'SKILL.md') {
      const name = parseFrontmatterName(editText)
      if (name !== '' && slug !== '') slug = name
    }
  }

  /** 极简 frontmatter 取 name（只用于"改 SKILL.md 时 slug 跟着变"）。 */
  function parseFrontmatterName(text: string): string {
    const m = text.match(/^name\s*:\s*(.+)$/m)
    return m?.[1] ? m[1].trim().replace(/^["']|["']$/g, '') : ''
  }

  /**
   * 拉变更集 diff（后端算，`text-diff.ts`）。
   *
   * 传的是**当前编辑后的文件**：使用者在审阅里改了一行，diff 就得反映改完的样子，
   * 而不是磁盘上的原稿。`against` = 对当前已入库版本（入库会发生什么）或上一版草稿
   * （"按意见改一版"后新旧对比）、`original` = **这个任务开始时的那一份**
   * （"这份 skill 相对原来那一份变了什么"，使用者的原话是"差异对比也应该是原 skill 变化"）。
   */
  async function loadDiff(
    against: 'current' | 'previous' | 'original' = diffAgainst,
  ): Promise<void> {
    if (artifacts === null) return
    diffAgainst = against
    diffLoading = true
    try {
      diff = await api<DiffResult>('/api/crystallize/diff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          draftRunId,
          files: artifacts.files,
          against,
        }),
      })
    } catch {
      // diff 是辅助信息，拉不到不挡入库（校验与文件本身才是硬门槛）
      diff = null
    } finally {
      diffLoading = false
    }
  }

  /** 当前选中文件在变更集里的那一项（没有就是"没变/无基线"）。 */
  $: selectedDiff = diff === null ? null : (diff.files.find((f) => f.rel === selectedFile) ?? null)
  /** 文件树上的 +n −m 从 diff 来（与详情面板同一份数字，不会两处对不上）。 */
  $: diffByRel = new Map((diff?.files ?? []).map((f) => [f.rel, f]))

  /** 拉素材清单（"素材"分节用：能核"这句话是从哪一轮来的"）。 */
  async function loadMaterial(): Promise<void> {
    if (draftRunId === '' || materialLoading) return
    materialLoading = true
    try {
      const res = await api<{
        dir: string
        items: Array<{ relPath: string; bytes: number; text: string; truncated: boolean }>
      }>(`/api/crystallize/material?draftRunId=${encodeURIComponent(draftRunId)}`)
      material = {
        ...res,
        // 折叠行只有一行：绝对路径塞进去会把"8 个文件"挤没。末段够用
        // （固定叫 material，前面那截是 30 字符的草稿目录名，是噪音）。
        dirLabel: res.dir.split('/').filter((x) => x !== '').slice(-1)[0] ?? '',
      }
      materialPick = material.items[0]?.relPath ?? ''
    } catch {
      material = null
    } finally {
      materialLoading = false
    }
  }

  /** 读审核结论（进入审阅时与每次审核 ran 之后调）。 */
  /**
   * 开/收「按意见改一版」的意见框。
   *
   * ★ 分批第 137 批（§12.42 第 ③ 步）：沉淀线的审核删掉之后，**没有"审核者的反馈"可预填**
   * ——意见完全由人写（这也是 §12.15 定下的："人看、可就地改"）。以前那段"打开框就填好
   * 审核意见"的逻辑随审核一起删除，连同它的单测（`lib/crystallize-feedback.ts`）。
   */
  async function toggleReviseBox(): Promise<void> {
    reviseOpen = !reviseOpen
    if (!reviseOpen) return
    // 光标落在框里：人点开这个框就是要写意见
    await tick()
    feedbackBox?.focus()
  }

  /**
   * 把编辑器里的改动**写回**草稿小屋（分批第 8 批）。
   *
   * 为什么要这一步（使用者原话：「缺少一个可以改的地方」）：编辑器一直都在，但改动只活在
   * 内存里，而审核者读的是磁盘 ⇒ 改完直接入库，入库的是改后的内容、结论却是磁盘上那一版的，
   * 没人知道这两件事已经不是一个东西。写回之后：审核能看到你改的，指纹一比就知道结论过期了。
   *
   * ⚠️ 保存之后**不自动重审**：重审要花钱（真机一轮 ≈ $1.32），这笔钱该由人决定。
   *    界面给的是「重新审核」按钮，不是自动跑。
   */
  async function saveDraftEdits(): Promise<void> {
    if (artifacts === null || draftRunId === '' || savingDraft) return
    savingDraft = true
    error = ''
    try {
      await api('/api/crystallize/save-draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId, files: artifacts.files }),
      })
      dirty = false
      // 保存之后重读一次产出（**只**为了刷新"机械体检"：人改完往往就是修体检问题）
      void refreshValidation()
      void loadDiff()
      showToast($t('crystallize.saveDraftDone'))
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      savingDraft = false
    }
  }

  /** 按意见再起草一版：新 run 复用同一份素材 + 把上一版产出放进 material/previous-draft/。 */
  /**
   * 把栏脚那句话路由到一个**已有动作**上。
   *
   * · 「这里不对：…」/「再炼一版 …」⇒ 复用「按意见改一版」（`reviseDraft`，走 /api/crystallize/revise）
   * · 「追加材料：…」⇒ 写进这一条草稿的素材（`POST /api/crystallize/material`，见 `appendMaterialText`）
   * · 「回到 vN」⇒ 版本回滚在技能页（这里只说明去哪）
   * · 其余 ⇒ 当成"补充"，同样如实说没有落点
   */
  function submitComposer(): void {
    const text = composerText.trim()
    if (text === '') return
    const says =
      (re: RegExp) => re.test(text)
    if (says(/^(这里不对|不对|应该|再炼)/)) {
      if (draftRunId === '' || step === 'target') {
        composerReceipt = '还没有草稿可以改——先答完问题、点「开始提炼」。'
        return
      }
      reviseFeedback = text
      composerText = ''
      composerReceipt = '按你这句改一版（走的是同一条「按意见改一版」）。'
      void reviseDraft()
      return
    }
    if (says(/^追加材料/)) {
      // 正文 = 前缀之后的部分（「追加材料：…」/「追加材料 …」都认）。
      // ⚠️ 前缀后面什么都不写**不猜**：材料是"要落进素材的正文"，猜成一句空话就是
      //    往素材里塞垃圾（起草者会把它当依据读）。空 ⇒ 回执教怎么说，不写盘。
      const rest = text.replace(/^追加材料[：:\s]*/, '').trim()
      if (rest === '') {
        composerReceipt =
          '追加材料：在「追加材料」后面写要追加进素材的正文，比如「追加材料：上周复盘的结论是…」。'
        return
      }
      if (draftRunId === '' || step === 'target') {
        composerReceipt = '还没有草稿——追加的材料要落进这一条草稿的素材里，先答完问题、点「开始提炼」。'
        return
      }
      void appendMaterialText(rest)
      return
    }
    if (says(/^回到\s*v\d+/)) {
      composerReceipt = '版本回滚在「技能」页的历史里（这里只改草稿，不切版本）。'
      return
    }
    /**
     * ★ 分批第 145 批（U4c 补，§12.5）：**还有必答项没答 ⇒ 这句话就是答案**。
     *
     * 设计的口径是"自由作答走输入条"——问的是文字时（作用描述 / 材料），栏脚这一句
     * 就该落进那一问，而不是被当成"补充、没有落点"打发掉。
     */
    if (step === 'target') {
      const applied = intakeRef?.answerFromComposer?.(text) ?? null
      if (applied !== null) {
        composerText = ''
        composerReceipt =
          applied === 'purpose'
            ? '收到：这句会当作「作用描述」记下，接着往下问。'
            : '收到：这句会当作「材料」记下（起草时会给起草者读）。'
        return
      }
      composerReceipt = '这一问不是文字题——点上面的选项（或「开始提炼」）更准。'
      return
    }
    composerReceipt = '我把它当成"补充"，但目前没有落点——能落地的只有「这里不对：…」「再炼一版」「追加材料：…」。'
  }

  /**
   * 把一段正文追加进**这条草稿**的素材（daemon 侧校验，见 `POST /api/crystallize/material`）。
   *
   * 为什么成功之后必须重读素材：右栏的「素材」清单是"它现在手上有什么"的**唯一**显示，
   * 不刷新的话使用者看到的是"追加了但看不见"——那和"没有落点"在体感上一模一样。
   * 而且清单是**同一份数据现算**（§12.14）：对话里那句摘要与右栏必须同源，不能只在
   * 本地拼一行。
   */
  async function appendMaterialText(body: string): Promise<void> {
    if (appendingMaterial) return
    appendingMaterial = true
    try {
      const res = await api<{ relPath: string; bytes: number }>('/api/crystallize/material', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId, text: body }),
      })
      composerText = ''
      await loadMaterial()
      // 选中刚追加的那一份：人点「追加材料」之后最想看的就是它（预览跟手上动作对上）
      materialPick = res.relPath
      // ★ 分批第 147 批：右栏产物栏里的材料清单是同一份数据，也得重读
      //   （否则"追加成功"与"右栏没有它"同时成立——§12.14 两处必须同源）。
      onmaterialchange()
      composerReceipt = `已追加为素材 ${res.relPath}（${res.bytes} 字节）：登记进了素材索引、右栏能看到，下一版起草会读它。`
    } catch (err) {
      composerReceipt = `追加材料没成功：${err instanceof Error ? err.message : String(err)}`
    } finally {
      appendingMaterial = false
    }
  }

  async function reviseDraft(): Promise<void> {
    if (reviseFeedback.trim() === '' || draftRunId === '') return
    revising = true
    error = ''
    try {
      const res = await api<{ draftRunId: string }>('/api/crystallize/revise', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId, feedback: reviseFeedback.trim() }),
      })
      const previous = draftRunId
      draftRunId = res.draftRunId
      draftStatus = null
      draftFailedReason = ''
      handledTerminal = false
      artifacts = null
      diff = null
      material = null
      reviseFeedback = ''
      step = 'drafting'
      // 记下"上一版是哪个 run"——它已经随新 run 落库（revisedFrom），这里只是让
      // 起草中的界面能说清"这是在改第几版"
      previousDraftId = previous
    } catch (err) {
      error = $t('crystallize.errDraftRejected', {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      revising = false
    }
  }

  /** 变更集：新增 / 修改 / 删除（对着更新场景的当前版本算；新建 = 全新增）。 */
  /**
   * 文件树的行 = 文件清单 + **变更徽标**。
   *
   * ⚠️ 徽标的判据跟着 `diff` 走（也就是跟着"对比当前版本 / 对比上一版草稿"的切换），
   *    不自己另算一套：曾经这里对着"入库基线"算，而旁边的 +n −m 来自 diff——切到
   *    "对比上一版"时同一行就变成「新增 +1 −1」，自相矛盾。现在只有一处判据：
   *    diff 有就用 diff 的 change，diff 没到（还没拉/拉失败）才退回入库基线。
   */
  $: fileRows = (() => {
    const a = artifacts
    if (a === null) return [] as Array<{ rel: string; change: '' | 'A' | 'M' | 'D'; bytes: number }>
    void filesVersion
    const byteLen = (text: string): number => new TextEncoder().encode(text).length
    if (diff !== null) {
      // 文本兜底草稿不认"删除"（服务端入库时合并保留），与下面的基线分支同一口径
      const rows = diff.files.filter((f) => a.mode === 'files' || f.change !== 'D')
      return rows.map((f) => ({
        rel: f.rel,
        change: (f.change === 'same' ? '' : f.change) as '' | 'A' | 'M' | 'D',
        bytes: a.files[f.rel] === undefined ? 0 : byteLen(a.files[f.rel] as string),
      }))
    }
    const base = a.baseline?.files ?? null
    const rows = Object.keys(a.files)
      .sort((x, y) => (x === 'SKILL.md' ? -1 : y === 'SKILL.md' ? 1 : x < y ? -1 : 1))
      .map((rel) => {
        const text = a.files[rel] ?? ''
        const old = base?.[rel]
        const change: '' | 'A' | 'M' = old === undefined ? 'A' : old === text ? '' : 'M'
        return { rel, change, bytes: byteLen(text) }
      })
    // 草稿里没有、当前版本里有的 → 删除（更新 = 整目录替换，必须看得见）。
    // ⚠️ **只有多文件产出（files）才这么算**：文本兜底草稿本来就没抓到支持文件，
    //    入库时服务端会把当前的保留下来（不是"决定了要删"）。这里若也标 D，等于
    //    对着一条没能力写文件的草稿吓唬使用者"要删 3 个文件"。
    if (a.mode !== 'files') return rows
    const deleted = Object.keys(base ?? {})
      .filter((rel) => a.files[rel] === undefined)
      .sort()
      .map((rel) => ({ rel, change: 'D' as const, bytes: 0 }))
    return [...rows, ...deleted]
  })()

  $: fileCount = artifacts === null ? 0 : Object.keys(artifacts.files).length
  $: totalBytes = fileRows.reduce((sum, r) => sum + r.bytes, 0)

  /** 变更徽标的文案（A/M/D → 中文；空串 = 未改动）。 */
  function changeLabel(change: '' | 'A' | 'M' | 'D'): string {
    if (change === 'A') return $t('crystallize.changeAdded')
    if (change === 'M') return $t('crystallize.changeModified')
    if (change === 'D') return $t('crystallize.changeDeleted')
    return ''
  }

  /** 目标摘要里的智能体名（候选来自 targets；找不到就回退 id）。 */
  function agentNameFor(id: string): string {
    const a = targets?.agentTargets
    if (a === undefined) return id
    if (a.executor.id === id) return a.executor.name
    if (a.reviewer?.id === id) return a.reviewer.name
    return id
  }

  /** 更新目标摘要里的技能名（可能已不在 loadedSkills 里，回退 id）。 */
  function skillNameFor(id: string): string {
    const s = targets?.loadedSkills.find((x) => x.id === id)
    return s ? `${s.name}（${s.slug}）` : id
  }

  async function save(): Promise<void> {
    saving = true
    error = ''
    clash = null
    try {
      if (artifacts === null) return
      /**
       * ★ 分批第 37 批：智能体草稿的入库**只传 draftRunId**。
       *
       * 内容由服务端从磁盘上的 `agent/instructions.md` 读（与 skill 那条"入库只认产出
       * 文件本身"同一条纪律），目标来自 run 上落库的 `crystallizeTarget`——前端不传，
       * 也就不存在"界面传的和当初起草的不是同一个目标"这种事。
       */
      if (isAgentDraft) {
        const res = await api<{
          agent: { id: string; name: string; instructionsChars: number }
          previousInstructionsChars: number
          snapshot: { id: string | null; restorable: boolean; note?: string }
          versioning: { enabled: boolean; note?: string }
        }>('/api/crystallize/commit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ draftRunId }),
        })
        doneSkillName = `${res.agent.name}（${res.previousInstructionsChars} → ${res.agent.instructionsChars} 字符）`
        doneVersioningNote = res.snapshot.restorable
          ? $t('crystallize.doneAgentSnapshot')
          : (res.snapshot.note ?? '')
        step = 'done'
        ondone()
        return
      }
      const target = targetKind === 'new' ? { kind: 'new' as const } : { kind: 'update' as const, skillId: selectedSkillId }
      // 四轮：只传整份文件 + 确认过的 slug。name / description 由服务端从 SKILL.md
      // 的 frontmatter 现解析——前端不再"拆出来再传回去"（那是两个出处的根源）。
      const res = await api<{ skill: Skill; versioning: { enabled: boolean; note?: string } }>(
        '/api/crystallize/commit',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            draftRunId,
            target,
            ...(slug.trim() !== '' ? { slug: slug.trim() } : {}),
            files: artifacts.files,
          }),
        },
      )
      doneSkillName = res.skill.name
      doneVersioningNote = res.versioning?.enabled
        ? $t('crystallize.doneVersioningOn')
        : (res.versioning?.note ?? '')
      step = 'done'
      ondone()
    } catch (err) {
      // 409 撞提炼根同 slug：服务端把"已存在的那条"放在 body.existing 里，
      // 前端据此切到「更新它」（进化）——那条不一定是本次加载的，不能从
      // loadedSkills 里找。
      const msg = err instanceof Error ? err.message : String(err)
      const body =
        err instanceof ApiError && typeof err.body === 'object' && err.body !== null
          ? (err.body as { existing?: { slug: string; name: string; id: string } })
          : null
      const existing = body?.existing
      if (err instanceof ApiError && err.status === 409 && existing) {
        clash = { slug: existing.slug, name: existing.name, id: existing.id }
        error = $t('crystallize.clashMine', { slug: existing.slug })
      } else {
        error = $t('crystallize.errSave', { error: msg })
      }
    } finally {
      saving = false
    }
  }

  /** 撞 slug 时切到"更新它"：重新起草（素材会带上旧版 SKILL.md 作进化基线）。 */
  async function switchToUpdate(): Promise<void> {
    if (!clash || clash.id === '') return
    targetKind = 'update'
    selectedSkillId = clash.id
    clash = null
    error = ''
    await startDraft()
  }

  function goSkills(): void {
    go('skills')
  }
</script>

  <!--
    ── 素材正文（只读）：清单 + 预览，两处共用 ──
    ① 审阅屏的「依据」tab（2026-10-21 第 3 批新增）；
    ② 其他状态的折叠行「素材」（原来是唯一一处，标记就写在那里）。
    抽成片段是为了"同一份标记只有一份"：两处各写一遍，早晚改成一处忘一处。
  -->
  <!--
    ── 审阅态的起草 run（最后结果 / 完整日志 两态）──
    2026-10-21 第 3 批：从页面下半部搬进「过程」tab。它和审核日志是同一类东西
    （"这一版是怎么做出来的"），而对"能不能入库"这个当场的决定没有直接作用。
  -->
  {#snippet draftRunPane()}
          <section class="drawer-section">
            <h3>
              {$t('crystallize.draftSection')}
              <span class="faint small">
                run {runShort}…
                {#if draftStatus}
                  <span class="badge {runStatusClass(draftStatus)}">{statusLabel(draftStatus)}</span>
                {/if}
                <!--
                  ⚠️ 2026-10-21 删掉了这里的 `· {statsLine}`（原来是 `· 1 轮 · 0 次工具调用`）。
                  两宗罪：① 它和副标题里那句是**同一个变量**——同一份数字在一屏里写两遍
                  （探针 `crystal.statsHits` 实测 2 次）；② 更要紧的是**错标**：`statsLine` 来自
                  `collectMaterial`，说的是**素材**有多少轮/多少次工具调用，摆在 `run 01M5…`
                  旁边会被读成"这条 run 干了多少活"。要显示 run 自己的统计，得取 run 记录里的
                  数（那属于「过程」tab 的事），不能拿素材的数顶上。
                -->
              </span>
              <!--
                ★ 分批第 29 批：在跑的时候不给这个按钮——那一格已经是实时日志了，
                按钮点下去什么都不会变，只会让人以为"点了才有日志"。
              -->
              {#if !draftLiveNow}
                <button
                  type="button"
                  class="ghost small"
                  style="margin-left:var(--sp-3)"
                  onclick={() => (draftLogOpen = !draftLogOpen)}
                >
                  {draftLogOpen ? $t('tasks.showFinalResult') : $t('tasks.showRawLog')}
                </button>
              {/if}
            </h3>
            {#if draftLiveNow}
              <!--
                ★ 分批第 29 批：这一版还在跑 ⇒ **直接显示实时日志**。
                原来这里只有「完整日志」按钮后面才有 `RunLog`，默认显示的是"最后结果"
                （= 上一版写下的最后一段文本）⇒ 循环中草稿那一格一动不动，人只能去看审核。
              -->
              <p class="faint small">{$t('crystallize.draftLiveHint')}</p>
              <div class="log-box">
                <RunLog runId={draftRunId} onterminal={(st) => void onDraftTerminal(st)} />
              </div>
            {:else if draftLogOpen}
              <div class="log-box">
                <RunLog runId={draftRunId} onterminal={(st) => void onDraftTerminal(st)} />
              </div>
            {:else if draftFinalState === 'loading'}
              <div class="skeleton"></div>
            {:else if draftFinalState === 'empty'}
              <div class="empty">
                <strong>{$t('tasks.noTextOutput')}</strong>
                {$t('tasks.noTextOutputHint')}
              </div>
            {:else}
              <article class="markdown draft-final">{@html renderMarkdown(draftFinalText)}</article>
            {/if}
          </section>
  {/snippet}

  <!-- 目标摘要（只读）：起草态的「依据」里用它——"这一版是照着什么做的" -->
  {#snippet targetSummary()}
    <p class="faint">
      {#if targetKind === 'new'}
        {$t('crystallize.targetNew')}
        {#if purpose.trim() !== ''}· {purpose.trim()}{/if}
      {:else}
        {$t('crystallize.targetUpdate')} · {skillNameFor(selectedSkillId)}
      {/if}
    </p>
  {/snippet}

  {#snippet materialPane()}
    {#if material === null || material.items.length === 0}
      <p class="faint small">{$t('crystallize.materialEmpty')}</p>
    {:else}
      <ul class="file-tree">
        {#each material.items as item (item.relPath)}
          <li>
            <button
              type="button"
              class="file-row"
              class:active={materialPick === item.relPath}
              onclick={() => (materialPick = item.relPath)}
            >
              <span class="file-name mono">{item.relPath}</span>
              <span class="faint small">{Math.max(1, Math.round(item.bytes / 1024))} KB</span>
            </button>
          </li>
        {/each}
      </ul>
      <div class="file-body">
        {#each material.items as item (item.relPath)}
          {#if item.relPath === materialPick}
            <pre class="file-pre mono">{item.text}</pre>
            {#if item.truncated}
              <p class="faint small">{$t('crystallize.materialTruncated')}</p>
            {/if}
          {/if}
        {/each}
      </div>
    {/if}
  {/snippet}

<MainArea
  headClass="detail-head"
  backLabel={backLabel}
  onBack={onback}
  title={$t('crystallize.title')}
  bodyClass="detail-scroll"
>
  {#snippet sub()}
    <!--
      ★ 2026-10-21 布局重排：run id（`01M5HYG3…`）从这一行**撤下来**。
      这一行是使用者第一眼看的地方，而他在这里问的是"这条沉淀在做什么"——run id 对
      这个决定没有价值，还会把来源标题挤进省略号。id 没丢：收进 `title`，要查日志
      对账时悬停就有。
    -->
    <span class="faint" title={`run ${runId}`}>
      {sourceLabel}{statsLine !== '' ? ` · ${statsLine}` : ''}
    </span>
    <!-- ★ 分批第 140 批（U4a）：顶栏的**状态徽标**——步骤条删掉之后，"现在到哪了"由它说 -->
    <span class="badge {stepStatusClass}" data-cryst-status={step}>{$t(stepStatusKey)}</span>
  {/snippet}

  <!--
    ★ 分批第 150 批（§12.12/§12.17："动作在消息里，不在页头"）：**顶栏动作整块删掉**。
    原来栏头右侧挂着「开始提炼 / 停止 / 重新起草 / 放弃 / 确认入库」——那是流程页的习惯：
    把"这一步能做什么"做成页面外壳的一部分。而这一页的形状是"消息流 + 栏脚"：
      · 开始提炼 ⇒ 目标态最后一问就是它（`CrystallizeIntake` 的 ready 那一问，门禁也说在那里）；
      · 停止 / 重新起草 ⇒ 起草那条系统消息里（状态就在旁边，谁能做什么一目了然）；
      · 放弃 / 确认入库 ⇒ 审阅那条产物消息底部（结论、改动、出口在同一块里）。
    ⚠️ 不要为"好找"再把它们搬回栏头：动作离结论远了，人会先看见结论再去找按钮。
  -->

  {#snippet body()}
    <!--
      ★ 分批第 96 批：**状态锚点**。这一层不加节点、不加样式——只是把"现在是哪一屏"
      写进 DOM（`target | drafting | review | done`），探针据此定位。

      为什么需要它：探针原来靠"旧表单里有没有某个控件"判断"现在哪一屏"
      （`.radio-row input`、`.crystal-material-line`…）。界面一换形态，这些锚点就消失，
      于是定位失败、跨屏判据连锁变红（试做时 87 项红，见 §12.22）。
      换成状态锚点之后，跨屏判据与界面形态解耦。

      ⚠️ **不要为了这个去多包一层 div**：上一版就是这么干的，结果打断了 `detail-scroll`
      的高度链，过程格当场缩了 105–113px（探针量的）。挂在已有的 `.crystal-flow` 上就行。
    -->
    <!-- ★ 分批第 106 批（U3a）：中间栏套上消息流外壳。这一批只加外壳、不换内容（§12.27）。
         ⚠️ 外壳必须接住高度链：两层都显式写成 flex 列 + flex:1 + min-height:0。 -->
    <div class="crystal-chat">
      <div class="crystal-msg" data-msg-role="assistant">
        <div class="crystal-flow" data-crystallize-step={step}>
      <!-- ★ 分批第 140 批（U4a）：步骤条已删（§12.6：「3 步步骤条 → 删除」）。
           进度由消息流的位置表达；状态在顶栏的状态徽标里（见 MainArea 的 sub 片段）。 -->

      {#if error && targets === null}
        <div class="notice bad crystal-notice">{error}</div>
      {/if}

      <!-- ★ 分批第 141 批（U4b）：「继续 / 新起草」提示**已删**（§12.7：状态在列表行上、
           点进去直接接上）。现在进到有进行中草稿的来源页会**自动接上**，见 `autoAttachOnce`。 -->

      <!--
        ── 起点屏（`#/crystallize/new`）：**「新建沉淀」不再弹 Modal**（§12.7）──
        这一屏就是"对话的第一条"：问一句「这一次要沉淀什么？」，选项 = 最近的会话/任务
        + 「从空白或材料起」。选中就跳到那一条来源的页面，从空白起就跳 `#/crystallize/blank`。
      -->
      {#if newMode}
        <section class="crystal-intake-msg" data-crystallize-step="new">
          <p class="intake-q">这一次要沉淀什么？</p>
          {#if sourcesLoading}
            <p class="faint small">正在读最近的会话与任务…</p>
          {:else}
            <div class="intake-choices">
              <button
                type="button"
                class="intake-choice"
                onclick={() => goCrystallize(BLANK_RUN_ID)}
              >
                {$t('crystallize.newStartBlank')}
                <span class="faint small">{$t('crystallize.newStartBlankHint')}</span>
              </button>
              {#each sourceOptions as opt (opt.runId)}
                <button type="button" class="intake-choice" onclick={() => goCrystallize(opt.runId)}>
                  {$t('crystallize.newStartFrom', {
                    kind: opt.kind === 'conversation' ? $t('crystallize.scopeConversation') : $t('crystallize.scopeTask'),
                    label: opt.label,
                  })}
                </button>
              {/each}
              {#if sourceOptions.length === 0}
                <p class="faint small">{$t('crystallize.newStartEmpty')}</p>
              {/if}
            </div>
          {/if}
        </section>
      {/if}

      <!--
        ── 素材那一行：目标态才显示（它是"能不能开始"的判据）──

        ★ 2026-10-21 重排：这里原来是一个**分节**（h3「素材摘要」+ 一节内容），
        可它那行字（`1 轮 · 0 次工具调用 · 对话`）在副标题里**已经写过一遍**
        （实测同一句话在一屏里出现两次），而分节外壳（h3 + 上下间距）白占 87px。
        现在降成一行：判据还在，外壳不要。
      -->
      {#if step === 'target' && !loading && targets}
        {#if targets.materialStats}
          <p class="faint small crystal-material-line">
            <!-- ⚠️ 这里**不再**写轮次/工具调用数：副标题已经写过一遍（实测同一句话
                 在一屏里出现两次）。这一行只留副标题没有的"判据"部分：来源是对话还是
                 任务、任务有没有审核结论与反馈。 -->
            {targets.scope === 'conversation'
              ? $t('crystallize.scopeConversation')
              : $t('crystallize.scopeTask')}
            {#if targets.scope === 'task'}
              · {targets.reviewed ? $t('crystallize.reviewedYes') : $t('crystallize.reviewedNo')}
              · {$t('crystallize.feedbackNo')}
            {/if}
          </p>
        {:else}
          <div class="notice bad small">{$t('crystallize.noMaterial')}</div>
        {/if}
      {/if}

      <!--
        ── 沉淀目标：**只在目标态**（可编辑的表单）──
        ⚠️ 2026-10-21（第 4 批）：起草态的只读摘要搬进了「依据」tab（它与素材是同一件事：
           "这一版是照着什么做的"）；审阅态早先就并进了结论条（那一行写着"新建 skill"）。
           于是这一节只在目标态出现——起草中那一屏现在整块地方都归 tab。
      -->
      {#if step === 'target'}
      <!-- ★ 分批第 103 批：目标表单换成**逐个问**（§12.13）。向导只负责问，发请求仍由
           `applyIntake → startDraft` 做，目标状态所有权留在原处——不产生第二套入口。
           ★ 分批第 133 批：空白起（`blank`）没有 targets，但 intake 要照画——`blank` 告诉它
           "不是还在加载，而是没有来源 run"。 -->
      <!-- ⚠️ 用 `{#key blankMode}` 强制重挂：`blank` 决定的是**起始 stage**（空白起直接问作用描述），
           而它在组件里只在初始化时算一次。路由从 `#/crystallize/new` 切到 `#/crystallize/blank`
           时两屏用的是同一个组件实例 ⇒ 不重挂就还停在"这次要沉淀成什么？"那一问（探针当场量到）。 -->
      {#key blankMode}
        <CrystallizeIntake
          {targets}
          blank={blankMode}
          blocked={loading ? undefined : startDisabledReason}
          bind:this={intakeRef}
          onfinish={applyIntake}
        />
      {/key}
      {/if}

      <!-- ══════════════════ 草稿审阅 ══════════════════

           排版的三条规矩（2026-10-19 重排）：

           ① **结论常驻，明细折叠**（本仓库 D69.9 的既有纪律）：一行结论条说完
              "能不能入库 + 改了哪些 + 目标是什么"，问题列表与"按意见改一版"的
              输入框都收进这条里，点开才占高度。
           ② **主区自己滚，页面不整页滚**：树 + 窗格固定高度，编辑/文件多了在窗格
              内部滚。改之前整页 2030px 高、审阅起点在 932px——首屏看不到要动手的地方。
           ③ **编辑与差异同位置切换**：785px 的正文列放不下"树 + 编辑 + 差异"三块并排
              （每块 240px 没法读），所以用分段控件在同一个窗格里切；两者都吃满宽度，
              而且切换不滚动（改之前 diff 在编辑器下方 519px 处）。
      -->
      {#if step === 'drafting'}
        

        <!-- ★ 分批第 115 批（U3c-2 第 5 步·起草态）：依据不再分 tab —— 它就在日志下面。
             ★ 分批第 143 批（U4d）：`data-process-pane="evidence"` 这个名字保留给探针定位用
             （它量的是"起草时能看到目标摘要与素材"），但它现在不是"过程 tab"的内容了。 -->
        <div class="process-pane" data-process-pane="evidence">
            <div class="proc-block">
              <div class="proc-head">{$t('crystallize.stepTarget')}</div>
              {@render targetSummary()}
            </div>
            <div class="proc-block">
              <div class="proc-head">{$t('crystallize.materialTitle')}</div>
              {#if material === null}
                <div class="skeleton"></div>
              {:else}
                <div class="file-pane">
                  {@render materialPane()}
                </div>
              {/if}
            </div>
          </div>
      {/if}

      {#if draftRunId !== '' && (step === 'drafting' || step === 'review' || step === 'done')}
      <!-- ★ 分批第 107 批（U3b）：起草日志从"分节折叠"变成**一条系统消息**。
           日志本身（RunLog + 可展开）不动，只是它现在挂在消息流里的一个"系统消息"上，
           而不是页面上的一个抽屉分节——这样它和后面的"起草完成"是同一条时间线上的东西。 -->
      <div class="crystal-msg" data-msg-role="system">
        {#if step === 'drafting'}
        <section class="drawer-section">
          <h3>
            {$t('crystallize.draftSection')}
            <span class="faint small">
              run {runShort}…
              {#if draftStatus}
                <span class="badge {runStatusClass(draftStatus)}">{statusLabel(draftStatus)}</span>
              {/if}
            </span>
          </h3>
          <div class="section-body">
            {#if draftStatus === 'failed' || draftStatus === 'cancelled'}
              <div class="notice bad small">
                {draftStatus === 'failed' ? $t('crystallize.draftFailed') : $t('crystallize.draftStopped')}
                {#if draftFailedReason !== ''}：{draftFailedReason}{/if}
                <button class="ghost small" onclick={retryDraft}>{$t('crystallize.retryDraft')}</button>
              </div>
            {:else}
              <!-- ★ 分批第 150 批：停止从这里走（原来挂在栏头——动作离它说明的东西太远） -->
              <div class="row-end msg-actions" data-msg-actions>
                <p class="faint small">{$t('crystallize.drafting')}</p>
                <button class="ghost small" onclick={() => void stopDraft()}>{$t('chat.stop')}</button>
              </div>
            {/if}
            <div class="log-box">
              <RunLog runId={draftRunId} onterminal={(st) => void onDraftTerminal(st)} />
            </div>
          </div>
        </section>
        {:else}
          <!-- 审阅/完成态：起草那条 run 的过程（默认"最后结果"，可切完整日志）仍在**时间线**里 -->
          {@render draftRunPane()}
        {/if}
      </div>
      {/if}

      {#if step === 'review'}
      <!-- ★ 分批第 109 批（U3c-1）：审阅态整体是**一条产物消息**（只包不删；删 review-tabs 是 U3c-2）。
           边界用 Svelte 自己的 AST 量出来的（58328 → 89030），不是靠正则数块——
           正则会被注释与字符串里的块标记污染，这个坑踩过两次。 -->
      <div class="crystal-msg" data-msg-role="artifact">
        {#if clash}
          <div class="notice">
            {error}
            <button class="ghost small" onclick={() => void switchToUpdate()}>
              {$t('crystallize.switchToUpdate')}
            </button>
          </div>
        {:else if error}
          <div class="notice bad">{error}</div>
        {/if}

        <!--
          ── ★ 一条结论条（2026-10-21 布局重排）──

          这一块原来是把**三条横条**竖着摞起来（实测加起来 ~240px 高）：
          ① 审核结论块（h3「审核结论（预筛）」+ 42px 说明段 + 结论条 / 日志 / 按钮）
          ② 草稿校验条（`✓ 3 个文件 · 对比上一版 · 新建 skill` + 按意见再改一版）
          ③ frontmatter 摘要（slug 输入 + name + description）
          结果编辑器从 y≈490 才开始，首屏能编辑的只有 ~280px。

          现在合成**一块两行**（~76px 高），判据就是使用者给的轴——"哪些必须同时看到"：
            · 常驻（必须同时看到）：过没过（审核结论 + 草稿校验合成一句话）、目标是谁、
              slug（入库前唯一要确认的字段）、以及"这一步能做什么"的按钮；
            · 折叠（不必同时看）：审核问题清单、审核日志、问题定位列表、按意见改一版的输入框。
          规矩没变：① 结论常驻 + 明细折叠 ② "还没审过"与"审过但没判决"分开说
          ③ 不通过且额度用尽才给「重新起草」。
        -->
        {#if pendingNewVersion !== ''}
          <!--
            ★ 分批第 27 批：链上冒出了新版，但你正在改正文 ⇒ **不抢**，只挂一条提示。
            自动切走会把没保存的字丢掉（那比"没跟上"严重得多）；而完全不提，人就以为
            界面卡住了——这正是使用者报的那个问题的一半。
          -->
          <div class="new-version-bar" data-new-version-hint>
            <span>{$t('crystallize.newVersionHint')}</span>
            <button
              type="button"
              class="linkish"
              onclick={() => {
                dirty = false
                followNewVersion(pendingNewVersion)
              }}>{$t('crystallize.newVersionGo')}</button
            >
          </div>
        {/if}
        <section class="conclusion-block">
          <div class="conclusion-bar" class:bad={conclusionBad}>
            <span class="bar-mark" aria-hidden="true">{conclusionMark}</span>
            <span class="bar-text">
              {#if artifacts === null}
                <span class="muted">…</span>
              {:else if artifacts.validation.ok}
                <strong>{$t('crystallize.checkPassed')}</strong>
                <span class="faint small">（{$t('crystallize.checkTitle')}）</span>
              {:else}
                <strong>{$t('crystallize.checkProblems', { n: String(artifacts.validation.problems.length) })}</strong>
              {/if}
              {#if artifacts}
                <span class="bar-sep">·</span>
                {#if artifacts.validation.ok}
                  <span class="muted">
                    {fileCount} {$t('crystallize.filesUnit')}
                    {#if diff !== null && (diff.totals.added > 0 || diff.totals.removed > 0)}
                      · {diff.against === 'previous'
                        ? $t('crystallize.vsPreviousShort')
                        : diff.against === 'original'
                          ? $t('crystallize.vsOriginalShort')
                          : $t('crystallize.vsCurrentShort')}
                      <span class="num-tag add">+{diff.totals.added}</span>
                      <span class="num-tag del">−{diff.totals.removed}</span>
                    {:else}
                      · {Math.max(1, Math.round(totalBytes / 1024))} KB
                    {/if}
                    {#if artifacts.mode === 'text'}
                      · {$t('crystallize.textModeHint')}
                    {/if}
                  </span>
                {:else}
                  <span class="muted">
                    {$t('crystallize.problemsTitle')}（{artifacts.validation.problems.length}）
                  </span>
                {/if}
                <span class="bar-sep">·</span>
                <span class="muted">
                  {#if targetKind === 'new'}
                    {$t('crystallize.targetNew')}
                  {:else if targetKind === 'agent'}
                    <!-- ★ 分批第 38 批：结论条原来只有"新建 / 更新 <slug>"两支 ⇒
                         智能体草稿在这里显示成「更新本次加载的 skill」（探针量到的原话） -->
                    {$t('crystallize.targetAgent')} {agentNameFor(selectedAgentId)}
                  {:else}
                    {$t('crystallize.targetUpdate')} {skillNameFor(selectedSkillId)}
                  {/if}
                </span>
              {/if}
            </span>
            <span class="bar-actions">
              <!--
                ⚠️ 2026-10-21（第 3 批）：这两个按钮原来是**各自的折叠开关**
                   （`auditDetailOpen` / `auditLogOpen`）。问题清单与审核日志搬进「过程」tab 之后，
                   它们改成**切到那个 tab**——一个东西只有一个开关，否则"折起来的问题清单"
                   与"tab 里的问题清单"会同时存在，人分不清哪个是真的。
              -->
              <!-- ★ 分批第 143 批（U4d）：`看体检明细` 这个跳转按钮删了——它原来只是切到「过程」tab，
                   而 tab 机制已删；体检的问题清单本来就常驻在结论条正下方（不需要再跳一次）。 -->
              <!--
                ★ 分批第 8 批：「保存改动」。
                只在**有未保存改动**时出现（`dirty`）：没有改动时它是个不该被点的按钮，
                而"点不动的按钮"比"没有按钮"更让人困惑。
              -->
              {#if artifacts && dirty}
                <button
                  class="ghost small primary-ghost"
                  disabled={savingDraft}
                  title={$t('crystallize.saveDraftHint')}
                  onclick={() => void saveDraftEdits()}
                >{$t('crystallize.saveDraft')}</button>
              {/if}
              {#if artifacts}
                <!-- ★ 点它 ⇒ 意见框打开，里面**默认已经填好**审核者的反馈（见 `toggleReviseBox`）。 -->
                <button
                  class="ghost small"
                  class:active={reviseOpen}
                  onclick={() => void toggleReviseBox()}
                >{$t('crystallize.reviseTitle')}</button>
              {/if}
              <!--
                ★ 分批第 150 批（§12.17："四种续法都只是一句话"）：**这一版的出口就在结论这一行**。
                原来「放弃 / 确认入库」挂在栏头——人先在结论里读到"体检通过、3 个文件"，再抬头去
                右上角找按钮。搬进结论条这一行之后，读结论与收尾是同一件事。
                ⚠️ 放在**结论条这一行**而不是消息底部：试过底部（`.msg-actions`），编辑格被顶上去
                35px，探针的"主区底边贴内容盒底"当场差 135px——那条判据量的正是"窗格吃满剩余高度"。
              -->
              <span class="bar-actions" data-msg-actions>
                <button class="ghost small" onclick={() => void abandonReview()}
                  >{$t('crystallize.abandon')}</button
                >
                <button
                  class="primary small"
                  disabled={saving || !reviewValid}
                  title={reviewValid ? undefined : $t('crystallize.confirmBlocked')}
                  onclick={() => void save()}
                >{$t('crystallize.confirm')}</button>
              </span>
            </span>
          </div>

          <!--
            第二行：入库前唯一要人确认的字段（slug）+ 只读的 name/描述。
            它属于"这条结论"的一部分（能不能入库），所以与结论同块；但不占结论那一行——
            结论那一行要留给"过没过"，那是人第一眼要找的东西。
          -->
          {#if artifacts}
            <div class="conclusion-meta">
              <label class="slug-inline">
                <span class="faint small">{$t('crystallize.slugLabel')}</span>
                <input bind:value={slug} autocomplete="off" class="mono" />
              </label>
              {#if artifacts.skillMd.name !== '' || artifacts.skillMd.description !== ''}
                <span class="faint small frontmatter-line">
                  <code>{artifacts.skillMd.name}</code>
                  {#if artifacts.skillMd.description !== ''}
                    <span class="desc-clip" title={artifacts.skillMd.description}
                      >{artifacts.skillMd.description}</span
                    >
                  {/if}
                </span>
              {/if}
            </div>
          {/if}

          <!-- ★ 分批第 137 批：沉淀线的审核删掉后，这里只剩**机械体检的问题清单**
               （能机器判的那几条）。语义层不判——由人看（§12.15）。 -->

          <!-- 问题定位列表：只在不过时说，最多 4 条（再多就该先改了） -->
          {#if artifacts && !artifacts.validation.ok}
            <ul class="problem-list">
              {#each artifacts.validation.problems.slice(0, 4) as p (p.file + p.message)}
                <li>
                  {#if p.file !== ''}<code>{p.file}</code>：{/if}{p.message}
                </li>
              {/each}
              {#if artifacts.validation.problems.length > 4}
                <li class="faint">
                  {$t('crystallize.moreProblems', { count: String(artifacts.validation.problems.length - 4) })}
                </li>
              {/if}
            </ul>
          {/if}

          <!-- 按意见改一版：输入框点开才展开（它属于"这版不行"的动作，不常驻） -->
          {#if reviseOpen}
            <div class="revise-row">
              <textarea
                bind:this={feedbackBox}
                bind:value={reviseFeedback}
                rows="2"
                placeholder={$t('crystallize.revisePlaceholder')}
              ></textarea>
              <div class="row-end">
                <button
                  class="ghost small"
                  disabled={revising || reviseFeedback.trim() === ''}
                  onclick={() => void reviseDraft()}
                >{$t('crystallize.reviseSubmit')}</button>
              </div>
            </div>
          {/if}
        </section>

        <!--
          起草者判定"不可沉淀"：这是结论，不是失败——只给重新起草 / 放弃。
          ⚠️ 2026-10-21：它原来是上面那条 if-chain 的第一支；结论条不再属于那条链
          （结论条在 artifacts 还没到时也要能显示审核那部分），所以这里单独成一个 if。
        -->
        {#if artifacts && artifacts.mode === 'refused'}
          <section class="drawer-section">
            <h3>{$t('crystallize.reviewTitle')}</h3>
            <div class="notice warn">
              <strong>{$t('crystallize.refusedTitle')}</strong>
              <p>{artifacts.refusalReason ?? ''}</p>
              <div class="row-end">
                <button class="ghost small" onclick={retryDraft}>{$t('crystallize.retryDraft')}</button>
                <button class="ghost small" onclick={() => void abandonReview()}>
                  {$t('crystallize.abandon')}
                </button>
              </div>
            </div>
          </section>
        {/if}

        {#if artifacts && artifacts.mode !== 'refused'}
          <!--
            ── ★ 审阅屏的三个 tab（2026-10-21 第 3 批）──

            使用者的轴："哪些必须一起显示、哪些可以切 tab。"这一屏的裁定：
              · 常驻（结论条那一块）：过没过 / 能不能入库 / 目标是谁 / slug / 能做什么；
              · 切 tab：**要动手的**（草稿）、**起草者读过什么**（依据）、
                **怎么走到这一步的**（过程 = 问题清单 + 审核日志 + 起草 run）。
            三块原来竖着摞：编辑器在 y≈490 起、素材折在 y≈842、起草 run 在 y≈1002——
            "过程"那两块把编辑器往下推了 300 多像素，而它们只在"我要追过程"时才看。
          -->
          <!-- ★ 分批第 143 批（U4d）：tab 条已删（§12.7「删掉的东西：tab 机制」）。
               这一屏只剩"要动手的那一块"：树 + 窗格（内容 / 差异 并排）。 -->
          <!-- ── 草稿：树 + 窗格（内容 / 差异 同位置切换） ── -->
          <div class="review-pane">
            <ul class="file-tree">
              {#each fileRows as row (row.rel)}
                <li>
                  <button
                    type="button"
                    class="file-row"
                    class:active={row.rel === selectedFile}
                    title={row.rel}
                    onclick={() => selectFile(row.rel)}
                  >
                    {#if row.change !== ''}
                      <span
                        class="change-tag"
                        class:add={row.change === 'A'}
                        class:mod={row.change === 'M'}
                        class:del={row.change === 'D'}
                      >{changeLabel(row.change)}</span>
                    {/if}
                    <span class="file-name mono">{row.rel}</span>
                    {#if row.change !== 'D'}
                      {@const d = diffByRel.get(row.rel)}
                      {#if d && (d.added > 0 || d.removed > 0)}
                        <span class="num-tag add">+{d.added}</span>
                        <span class="num-tag del">−{d.removed}</span>
                      {/if}
                    {/if}
                  </button>
                </li>
              {/each}
            </ul>

            <div class="file-body">
              <div class="pane-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={reviewTab === 'content'}
                  class:tabs-active={reviewTab === 'content'}
                  onclick={() => (reviewTab = 'content')}
                >{$t('crystallize.tabContent')}</button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={reviewTab === 'diff'}
                  class:tabs-active={reviewTab === 'diff'}
                  onclick={() => (reviewTab = 'diff')}
                >{$t('crystallize.tabDiff')}</button>
                {#if reviewTab === 'diff'}
                  <span class="tabs-right">
                    {#if selectedDiff && (selectedDiff.added > 0 || selectedDiff.removed > 0)}
                      <span class="num-tag add">+{selectedDiff.added}</span>
                      <span class="num-tag del">−{selectedDiff.removed}</span>
                    {/if}
                    <!--
                      「对比原 skill」什么时候给：
                        · 改版草稿（`revisedFrom !== null`）⇒ 原 skill = **第一版的快照**，比得出东西；
                        · 更新场景（`baseline !== null`）⇒ 原 skill = 任务开始时库里那一份。
                      ⚠️ 我第一版让它**常驻**，探针那条"新建目标的草稿不给一个永远空的切换"当场红：
                        新建目标的**首版**没有"原来那一份"（服务端会退回当前版本 = 空）⇒ 这个按钮
                        点了什么都不会变，正是这条判据要挡的死接口。判据在探针里，别在这里放宽。
                    -->
                    {#if artifacts.revisedFrom !== null || artifacts.baseline !== null}
                      <button
                        type="button"
                        class="ghost small"
                        class:active={diffAgainst === 'original'}
                        onclick={() => void loadDiff('original')}
                      >{$t('crystallize.diffVsOriginal')}</button>
                    {/if}
                    {#if artifacts.revisedFrom !== null}
                      <button
                        type="button"
                        class="ghost small"
                        class:active={diffAgainst === 'current'}
                        onclick={() => void loadDiff('current')}
                      >{$t('crystallize.diffVsCurrent')}</button>
                      <button
                        type="button"
                        class="ghost small"
                        class:active={diffAgainst === 'previous'}
                        onclick={() => void loadDiff('previous')}
                      >{$t('crystallize.diffVsPrevious')}</button>
                    {/if}
                  </span>
                {/if}
              </div>

              <!-- ★ 分批第 120 批（U3c-2 审阅态并排）：内容与差异并排；窄屏只显示激活那一格 -->
              <div class="review-side" data-review-tab={reviewTab}>
              <div class="review-cell" data-cell="content">
                {#if selectedFile === ''}
                  <p class="faint small">{$t('crystallize.noFiles')}</p>
                {:else if fileRows.find((r) => r.rel === selectedFile)?.change === 'D'}
                  <p class="faint small pad">{$t('crystallize.deletedHint')}</p>
                {:else}
                  <textarea
                    bind:value={editText}
                    oninput={onEditInput}
                    class="mono editor"
                    spellcheck="false"
                  ></textarea>
                {/if}
              </div>
              <div class="review-cell" data-cell="diff">
              {#if diffLoading}
                <p class="faint small pad">{$t('crystallize.diffLoading')}</p>
              {:else if selectedDiff && selectedDiff.hunks.length > 0}
                <div class="diff-box mono">
                  {#each selectedDiff.hunks as hunk (hunk.oldStart + ':' + hunk.newStart)}
                    <div class="hunk-head">@@ −{hunk.oldStart} +{hunk.newStart} @@</div>
                    {#each hunk.lines as line (line.oldNo + '/' + line.newNo + '/' + line.kind)}
                      <div class="diff-line {line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : ''}">
                        <span class="gutter">{line.oldNo ?? ''}</span>
                        <span class="gutter">{line.newNo ?? ''}</span>
                        <span class="sign">{line.kind === ' ' ? ' ' : line.kind}</span>
                        <span class="text">{line.text}</span>
                      </div>
                    {/each}
                  {/each}
                </div>
              {:else if diff === null}
                <p class="faint small pad">{$t('crystallize.diffLoading')}</p>
              {:else}
                <p class="faint small pad">{$t('crystallize.diffUnchanged')}</p>
              {/if}
              </div>
              </div>
            </div>
          </div>

          <!--
            ⚠️ 2026-10-21 使用者："不需要「预览」" —— 这里原来有一段折叠的 Markdown 预览
               （`.preview`，20rem 高、还要往下滚）。删掉的理由不只是"多余"：
               审阅这一屏要动手的只有**编辑器**（② 差异在同一个窗格里切），而预览是
               同一份内容的**第二种渲染**——它离编辑器几百像素、还各自滚，读完预览
               再回去改一个字要来回跳。删掉之后这一屏只剩"改 / 比"两件事。
               （`.preview` 的 CSS 与 `renderMarkdown` 的 import 一并删了——留着就是死代码，
               本仓库最防的就是"东西都在、就是没有路径让它发生"。）
          -->

        {/if}
            </div>
{/if}

      <!-- ── 素材（四轮 P1）：agent 读的就是这些文件，人也能翻同一份。
             ⚠️ 2026-10-21（第 3 批）：审阅态不再把它折在编辑器下面——它成了「依据」tab 的
                内容（点一下就看，不必滚到 y≈842 再展开一层）。所以这里排掉 review，
                而内容本身抽成片段 `materialPane`，两处共用一份标记（不许复制两份）。 ── -->
      {#if draftRunId !== '' && material !== null && step === 'target'}
        <FoldSection
          title={$t('crystallize.materialTitle')}
          summary={`${material.items.length} ${$t('crystallize.filesUnit')} · ${material.dirLabel}`}
        >
          <div class="file-pane">
            {@render materialPane()}
          </div>
        </FoldSection>
      {/if}

      <!--
        ── ★ 起草中那一屏：两个 tab（产出 / 依据），2026-10-21 第 4 批 ──

        原来这一屏是"目标摘要 + 起草 run + 素材折叠"竖着摞；素材折在下面、目标摘要在上面，
        而"跑着的时候唯一的实时信息"（run 的输出）被夹在中间。现在：
          · 产出（默认）= 那条 run 的状态 + 实时输出（跑完自动进审阅态，这里不用两态）；
          · 依据 = 目标摘要（新建 / 更新谁）+ 素材（不折叠：进了 tab 再折一层就是多一次点击）。
      -->


      {#if step === 'done'}
        <section class="notice good done-box">
          <strong>{$t('crystallize.doneTitle')}</strong>
          <p>{$t('crystallize.doneText', { name: doneSkillName })}</p>
          {#if doneVersioningNote !== ''}
            <p class="faint small">{doneVersioningNote}</p>
          {/if}
          <div class="row-end">
            <button class="primary" onclick={goSkills}>{$t('crystallize.viewSkill')}</button>
            <button class="ghost" onclick={onback}>{$t('crystallize.backToSource')}</button>
          </div>
        </section>
      {/if}
        </div>
      </div>
      <!-- 栏脚输入条：U3d 才接线，先只占位（不做成能按但没反应的按钮） -->
      <form
        class="crystal-composer"
        onsubmit={(e) => {
          e.preventDefault()
          submitComposer()
        }}
      >
        <input
          class="crystal-composer-input"
          type="text"
          bind:value={composerText}
          placeholder={$t('crystallize.chatPlaceholder')}
          aria-label={$t('crystallize.chatPlaceholder')}
        />
        <button class="primary" type="submit" disabled={composerText.trim() === ''}>
          {$t('crystallize.chatSend')}
        </button>
      </form>
      {#if composerReceipt !== ''}
        <!-- 回执：平台怎么理解这句话，使用者要看得见（不是 toast，会随页面消失）。
             ⚠️ 它是栏脚的**第二块**（不包一层 div）：组件里 §12.22 的教训——多包一层会打断
             高度链、过程格缩 100px。所以探针的"栏脚高"要把这两块一起算（见 probe.html 的
             `crystal.composerH` 那条注释）。 -->
        <p class="faint small composer-receipt">{composerReceipt}</p>
      {/if}
    </div>
  {/snippet}
</MainArea>

<style>
  /* ★ 分批第 150 批：动作搬进消息之后的间距——要和上面的日志分开一点，
     但不要另起一块"工具栏"（动作贴在内容尾巴上，不抢视觉） */
  .msg-actions {
    margin-top: var(--sp-2);
    gap: var(--sp-2);
  }
  .msg-actions p {
    margin: 0;
  }
  /* 结论条里的动作组：与「保存改动 / 反馈」同一行，中间留一点呼吸 */
  .conclusion-bar .bar-actions[data-msg-actions] {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    margin-left: var(--sp-2);
  }

  /* ★ 分批第 27 批：「链上出了新版，但你正在改」的提示条。
     做得比结论条**轻**（一行、无边框强调）：它是提示，不是状态本身。 */
  .new-version-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin: 0 0 8px;
    padding: 6px 10px;
    border-radius: 6px;
    background: var(--surface-2, #f4f4f5);
    font-size: 12px;
  }
  .new-version-bar .linkish {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent, #2563eb);
    cursor: pointer;
    font-size: 12px;
    text-decoration: underline;
  }

  /* ★ 纵向间距**只有一个来源**：`.drawer-section` 的全局 `margin-bottom`（任务
     详情就是这么排的）。这里若再给 `gap`，两种间距会叠加成双倍——所以用
     `display: block` 的普通流，非分节块（步骤条 / 恢复条 / 完成态 / 提示条）
     各自带下边距。 */
  /* ⚠️ 2026-10：这里原来钉着 `max-width: 56rem`（896px）——宽屏上正文停在中间、
     右侧留一片空白，使用者看到的是"这一页没铺满"，而原因在样式表里、界面上看不出来。
     撤掉它，与 `AgentDetail.svelte` 的 2026-09 同一条理由（**详情类全页不再钉死宽度**：
     那一处原来钉的是 52rem，撤掉时记的就是这件事）。
     正文仍然是普通流（不是 flex/grid 的多栏），所以铺满不会把行长拉到读不下去——
     行宽由字号与栏宽共同决定，而这一页正文段落本来就短。 */
  /* ══════════════════════════════════════════════════════════════════
     ★ 分批第 30 批：`.crystal-flow` 现在是**可伸缩的一列**（界面自适应高度）
     ══════════════════════════════════════════════════════════════════

     使用者：「沉淀成 skill 的页面需要自适应高度」。

     原来这一条规则**故意不存在**（"它铺满主区，间距由子块给"），而下面三个主区格子
     各自钉死 `height: clamp(22rem, 58vh, 40rem)` —— 面板高度按"视口的一个固定比例"估，
     跟"上面已经吃掉多少"没关系。实测（探针 1400×1200 窗口 ⇒ 视口高 880）：主区起点
     y=363（顶栏 + 步骤条 + 结论条 + tabs 吃掉 41%），主区高 510 = 58vh，底边 873，只剩 7px。
     窗口一高就露馅（`40rem` 一到顶不再长，1600 高时下面空 277px）；窗口一矮就溢出
     （视口 380 时 `22rem` 保底 352 ⇒ 主区底边 715 > 380，整页滚动、结论条被推出屏幕）。

     现在：这一列 `min-height: 100%` 吃掉 `.pane-body` 的可用高度，主区格子
     `flex: 1 1 auto; min-height: 22rem` 吃掉**剩余**的那部分。窗口变大 ⇒ 主区跟着长；
     窗口太矮 ⇒ 先压到 22rem 保底，再不行才让 `.pane-body` 滚动（可接受的退化：
     顶栏/步骤条/结论条永远在视口里）。 */
  /* U3a 消息流外壳：flex 列 + 撑满，接住原来的高度链（§12.22 踩过：多一层就缩 105px） */
  .crystal-chat {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .crystal-msg {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  /* 系统消息（起草日志）：自然高度、不吃剩余空间；内部日志框自己滚 */
  .crystal-msg[data-msg-role='system'] {
    flex: 0 0 auto;
  }

  /* 产物消息（审阅态）：占满剩余高度，内部各块自己滚 */
  .crystal-msg[data-msg-role='artifact'] {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
  }

  .crystal-composer {
    flex-shrink: 0;
    display: flex;
    gap: var(--sp-2);
    border-top: 1px solid var(--line);
    padding-top: var(--sp-2);
    margin-top: var(--sp-2);
  }

  .composer-receipt {
    flex-shrink: 0;
    margin: var(--sp-1) 0 0;
  }

  .crystal-composer-input {
    flex: 1;
    font: inherit;
    font-size: var(--fs-base);
    padding: var(--sp-2);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
  }

  .crystal-flow {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }

  /* ★ 分批第 140 批（U4a）：步骤条整套样式随步骤条删除（§12.6）。
     顶栏徽标复用全局 `.badge` 的语义色（in_progress / in_review / done / failed / cancelled）。 */

  /* ★ 分节**不重定义** `.drawer-section`（那是全局的：边距 + h3 边距）——
     任务详情的分节就是朴素 `<section class="drawer-section"><h3>…</h3>`，
     流程页照抄同一个壳，别再自己长成"卡片"。
     `.section-body` 只负责这一步内容的纵向节奏，不是新的容器样式。 */
  .section-body {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }

  /* 读失败提示条：与分节之间留一格（原来是行内 style，这里收成类） */
  .crystal-notice {
    margin-bottom: var(--sp-3);
  }

  /* ══════════ 恢复提示（继续 / 新起草） ══════════ */
  .resume {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    flex-wrap: wrap;
    margin-bottom: var(--sp-4);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    padding: var(--sp-3) var(--sp-4);
  }
  .resume-text {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .resume-actions {
    display: flex;
    gap: var(--sp-2);
  }

  /* ══════════ 目标选项：卡片列表 ══════════ */
  .option-group {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .radio-row {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
    margin: 0;
    padding: var(--sp-3);
    cursor: pointer;
    font-size: var(--fs-sm);
  }
  .radio-row + .radio-row {
    border-top: 1px solid var(--line);
  }
  .radio-row:hover {
    background: var(--surface-hover);
  }
  .radio-row:has(input:checked) {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .radio-row.disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  /* ★ 全局 `input` 规则把 radio 撑成通栏宽、还带边框与 padding——这里逐条 reset
     （与 NewAgentForm 的 `.skill-option input { width: auto }` 同一处方）。 */
  .radio-row input[type='radio'],
  .skill-row input[type='radio'] {
    width: auto;
    margin: 0.15em 0 0;
    padding: 0;
    border: none;
    background: none;
    accent-color: var(--accent);
    flex-shrink: 0;
  }
  .opt-text {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    min-width: 0;
  }
  /* 选中「新建」后的作用描述：缩进到与选项文字对齐（radio 列宽 + gap） */
  .sub-field {
    padding: 0 var(--sp-3) var(--sp-3) calc(var(--sp-3) + 1.6rem);
    border-top: 1px solid var(--line);
  }
  .field-inner {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    margin: 0;
  }
  .field-inner textarea {
    margin-top: 0;
  }

  /* ══════════ 更新目标：技能行列表 ══════════ */
  .skill-list {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    max-height: 16rem;
    overflow-y: auto;
  }
  .skill-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0;
    padding: var(--sp-2) var(--sp-3);
    cursor: pointer;
    font-size: var(--fs-sm);
  }
  .skill-row + .skill-row {
    border-top: 1px solid var(--line);
  }
  .skill-row:hover {
    background: var(--surface-hover);
  }
  .skill-row:has(input:checked) {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .skill-info {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    min-width: 0;
  }
  .skill-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .badge.mine {
    background: var(--accent);
    color: var(--bg);
    border-radius: var(--radius-sm);
    padding: 0 var(--sp-1);
    font-size: 0.85em;
  }

  /* ══════════ 表单字段（审阅态） ══════════ */
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    margin: 0;
  }
  .field textarea {
    font: inherit;
    margin-top: 0;
    padding: var(--sp-1) var(--sp-2);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
  }
  .row-end {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }
  .log-box {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    max-height: 24rem;
    overflow: auto;
  }
  /* ══════════════════════════════════════════════════════════════════
     ★ 分批第 33 批：过程格里的内容要**跟着格子长**（使用者："草稿过程和审核过程
       的高度没有适应"）
     ══════════════════════════════════════════════════════════════════

     第 30 批已经把**格子本身**改成吃剩余高度（实测：视口 880 时两个格子都是 457px、
     底边差 0 ✓），但格子**里面**的东西没跟上——日志框只有一句「max-height: 24rem」，
     内容少就是 51px（实测），于是 457px 的格子里躺着一条 51px 的细条，看起来就是
     "高度没适应"。

     口径：日志框吃格子的剩余高度（`flex: 1 1 0`），上面的问题清单按内容高、
     但最多占一半（`max-height: 50%`，自己滚）——判决条目多时不能让日志被挤没。
  */
  .process-pane > .drawer-section {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    /* 折叠区那套下边距是为了文档流里的分节；在格子里它会把日志框往下推 */
    margin-bottom: 0;
  }
  .process-pane .log-box,
  .process-pane .draft-final {
    flex: 1 1 0;
    min-height: 8rem;
    max-height: none;
  }
  .process-pane > .proc-block {
    flex: 0 1 auto;
    min-height: 0;
    /* 问题清单：按内容高，但**最多占一半**——判决条目多时不许把日志挤没 */
    max-height: 50%;
    overflow: auto;
  }
  /* 带日志的那一块：吃剩余高度（它是这个格子里唯一"越长越好"的东西） */
  .process-pane > .proc-log {
    flex: 1 1 0;
    max-height: none;
    min-height: 8rem;
  }
  .process-pane > .proc-log > .log-box {
    min-height: 0;
  }
  /*
   * 起草 run 的「最后结果」。
   *
   * ⚠️ **必须限高自己滚**：这一页的纪律是"页面不整页滚、主区自己滚"，而一段没有上限的
   *    Markdown 会把整页撑长、把审阅区挤出首屏——探针里 `crystal.pageFitsViewport`
   *    正是钉这条的（改前实测整页 2030px）。它与 `.log-box` 用同一档高度，
   *    切换两态时**不跳**。
   */
  .draft-final {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--panel);
    padding: var(--sp-3);
    max-height: 24rem;
    overflow-y: auto;
  }
  .mono {
    font-family: var(--font-mono);
  }

  /* ══════════ 审阅：文件树 + 编辑区（四轮）══════════
     ★ 只用全局变量与既有观感（--panel/--line/--radius/--font-mono），不自造卡片：
     这一块是"多文件产物的呈现"，不是另一套设计语言。 */
  /* ── 变更集 diff（P1）：行号 gutter + 符号 + 文本，三色只区分增删 ── */
  .num-tag {
    font-size: 11px;
    padding: 0 4px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .num-tag.add {
    color: #1a7f37;
    background: rgba(26, 127, 55, 0.1);
  }
  .num-tag.del {
    color: #b42318;
    background: rgba(180, 35, 24, 0.1);
  }
  .diff-box {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    font-size: 12px;
    line-height: 1.5;
  }
  .hunk-head {
    padding: 0.15rem 0.5rem;
    color: var(--fg-faint);
    background: var(--bg-sunken, #f6f6f6);
    border-top: 1px solid var(--border);
    user-select: none;
  }
  .hunk-head:first-child {
    border-top: 0;
  }
  .diff-line {
    display: grid;
    grid-template-columns: 3rem 3rem 1rem minmax(0, 1fr);
    gap: 0.25rem;
    padding: 0 0.5rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .diff-line.add {
    background: rgba(26, 127, 55, 0.08);
  }
  .diff-line.del {
    background: rgba(180, 35, 24, 0.08);
  }
  .diff-line .gutter {
    color: var(--fg-faint);
    text-align: right;
    user-select: none;
  }
  .diff-line .sign {
    color: var(--fg-faint);
    user-select: none;
  }
  .diff-line.add .sign {
    color: #1a7f37;
  }
  .diff-line.del .sign {
    color: #b42318;
  }

  /* ══════════ 审阅重排（2026-10-19）：结论条 + 主区 + 折叠 ══════════

     三条规矩写在 markup 的注释里（结论常驻 / 主区自己滚 / 编辑与差异同位置切换）。
     这里只落尺寸：树 240px 固定、窗格吃满剩下的、主区高度跟窗口走但**不整页滚**。 */

  /*
   * ── 一条结论条（2026-10-21）──
   * 原来是三条横条竖着摞（审核块 + 校验条 + frontmatter 摘要），加起来 ~240px；
   * 现在一块两行 ~76px。宽度按内容排（结论那一行**不许换行**——原来「开始审核」按钮在
   * 69px 宽里折成 3 行，高 54px，就是这里没管住 `flex` 的结果）。
   */
  /*
   * ── 审阅屏的外层三个 tab：草稿 / 依据 / 过程（2026-10-21 第 3 批）──
   * 观感与窗格内的「内容 / 差异」同一套（同字号、同 hover），差别只在它是**下划线式**
   * 而不是底色块：这两层是嵌套的，都用底色块会分不清"我现在在切哪一层"。
   */
  .review-tabs {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    margin: 0 0 var(--sp-2);
    border-bottom: 1px solid var(--line);
  }
  .review-tabs > button {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    padding: 4px 12px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--fg-soft);
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  .review-tabs > button:hover {
    color: var(--fg);
  }
  .review-tabs > button.tabs-active {
    color: var(--fg);
    font-weight: 600;
    border-bottom-color: var(--fg);
  }
  .tab-count {
    padding: 0 5px;
    border-radius: 999px;
    background: var(--panel-sunken, rgba(0, 0, 0, 0.06));
    font-size: var(--fs-xs);
  }
  /* 审核跑着时 tab 上的点：切到草稿去改字也不会忘了它还在跑 */
  .tab-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--good);
  }

  /*
   * ── 依据 tab（素材）──
   * 复用 `.file-pane` 的两栏网格，只多一行 head：head **跨两列**（grid-column: 1/-1）。
   * ⚠️ 第一版把 head 当成第三个网格项塞进两栏网格里，它会自己占掉"第二行第一列"，
   *    把文件树挤到下面去——这类错 svelte-check 看不见，只有量位置才发现。
   */
  .evidence-pane {
    grid-template-rows: auto minmax(0, 1fr);
  }
  .evidence-pane > .evi-head {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }
  .evidence-pane .grow {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /*
   * ── 过程 tab（问题清单 + 审核日志 + 起草 run）──
   * 高度与草稿窗格同档（`clamp(22rem, 58vh, 40rem)`）：两个 tab 换的是同一块地方，
   * 换过去时页面不该跳高跳矮（这一页的纪律是"页面不整页滚"，`crystal.pageFitsViewport` 钉着）。
   * 内容多的时候**在块内滚**。
   */
  /*
   * 「过程」那一格的子 tab 行（分批第 19 批）。
   *
   * ⚠️ `.pane-tabs` 自己带 `flex: 0 0 auto` 与 `padding: 2px`，那是给文件窗格里的
   *    内容/差异切换用的（那里外面是固定高度的 `file-body`）；这里上面贴着**页面级**的
   *    `.review-tabs`、下面贴着 `.process-pane`，两行 tab 直接相邻时容易被当成同一个
   *    tablist（外层选"看哪一格"、内层选"看这格里的哪一半"，是两层不同的选择）
   *    ⇒ 给子 tab 行加一点上间距，把两层分开。
   */
  .process-subtabs {
    margin-top: var(--sp-2);
    padding-bottom: 0;
  }
  .process-pane {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    /* 吃剩余高度（理由见 `.crystal-flow`）；22rem 是保底：再矮就整页滚，不把内容压没。
       ⚠️ 必须是 `flex-basis: 0` 而不是 `auto`：`auto` 时内容比剩余空间高就**顶穿**
       （实测「依据」那一格被内容顶到 1133px，比视口还高，整页滚）——
       basis 0 才让"高度由剩余空间决定、内容在里面自己滚"。 */
    flex: 1 1 0;
    min-height: 22rem;
    margin-top: var(--sp-1);
    overflow: auto;
  }
  .proc-block {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .proc-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: var(--fs-sm);
    font-weight: 600;
  }

  .conclusion-block {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin: 0 0 var(--sp-4);
  }
  .conclusion-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--line);
    /* 左边一条强调色：沿用原来那条结论条的视觉语言（过 = 绿、不过 = 红） */
    border-left: 3px solid var(--good);
    border-radius: var(--radius);
    background: var(--panel);
    font-size: var(--fs-sm);
  }
  .conclusion-bar.bad {
    border-left-color: var(--bad);
    border-color: color-mix(in srgb, var(--bad) 35%, var(--line));
  }
  .conclusion-bar .bar-mark {
    flex: 0 0 auto;
    color: var(--good);
    font-weight: 600;
  }
  .conclusion-bar.bad .bar-mark {
    color: var(--bad);
  }
  .conclusion-bar .bar-text {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    overflow: hidden;
    white-space: nowrap;
  }
  .conclusion-bar .bar-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    flex-shrink: 0;
  }
  /* 按钮里的字**不许折行**（这是上面那个 69×54 的直接病因） */
  .conclusion-bar .bar-actions button {
    white-space: nowrap;
    flex-shrink: 0;
    /*
     * 纵向收紧：站里 `.small` 按钮是 35px 高（padding 6+6 + 行高），而结论条是**常驻的
     * 摘要行**——它高 53px 就为了托住按钮的 35px，把编辑器又往下推。改成 3px 之后
     * 按钮 ~29px、条 ~47px（实测 y 从 345 往回收，见探针 `crystal.paneTopY`）。
     * ⚠️ 只在这一条上收紧，不动站里 `.small` 的通用定义：别处按钮是"动作"，这里是"摘要上的动作"。
     */
    padding-top: 3px;
    padding-bottom: 3px;
  }
  .bar-sep {
    color: var(--line-strong);
  }
  .conclusion-meta {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: 0 var(--sp-1);
    font-size: var(--fs-sm);
  }
  /*
   * slug 是入库前唯一要人确认的字段，但它在这一行里只需要"看得清、点得中"。
   * 站里输入框是 33px 高（padding 6+6），这一行因此 43px——比结论条还高。
   * 收到 3px ⇒ ~26px，整块从 120px 降到 ~97px（实测见探针 `crystal.paneTopY`）。
   */
  .conclusion-meta input {
    padding-top: 3px;
    padding-bottom: 3px;
  }
  /*
   * ⚠️ 这一条是**量出来才发现**的：`.conclusion-meta` 明明只有 label(30.8) 和
   *    frontmatter(20.8) 两个子元素，行高却是 42.8。逐个子元素藏掉才看出是 label——
   *    它自己量着 30.8，但**全局 `label` 规则带着下边距**，占位是 42.8。
   *    （只看高度差永远猜不到：差值 12 刚好等于 `--sp-3`，很容易误判成 gap。）
   */
  .conclusion-meta .slug-inline {
    margin: 0;
  }
  .conclusion-meta .frontmatter-line {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /*
   * ⚠️ 这里刻意**不设 max-width**：这一页在 D80 之后是整页宽，宽度约束写在别处会
   *    变成"只有这一块窄"的布局缺陷（`svelte-check` 看不见这类问题，只有浏览器量得出来）。
   *
   * ⚠️ 2026-10-21：`review-bar-block` / `.review-bar` / `.audit-block .bar-text` 这几条
   *    随"三条横条"一起退休了。**是 svelte-check 的 `Unused CSS selector` 当场点名的**
   *    （警告数从 12 涨到 14）——留着的死样式比死字段更难发现，因为界面上看不出差别。
   */

  .audit-findings {
    margin: var(--sp-2) 0 0;
    padding-left: var(--sp-4);
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }

  .audit-findings .sev {
    display: inline-block;
    margin-right: var(--sp-2);
    padding: 0 var(--sp-1);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }

  .audit-evidence {
    font-size: var(--fs-xs);
    padding-left: var(--sp-3);
  }

  /* slug + frontmatter 摘要：都只占一行（描述超长就省略，要看全文点文件名看文件） */
  .review-meta {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin-top: var(--sp-2);
    min-width: 0;
  }

  .slug-inline {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    flex: 0 0 auto;
  }

  .slug-inline input {
    width: 12rem;
    padding: 2px 6px;
    font-size: var(--fs-sm);
  }

  .frontmatter-line {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    min-width: 0;
  }

  .frontmatter-line .desc-clip {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 32rem;
  }

  /* 按意见改一版：展开的那一行 */
  .revise-row {
    margin-top: var(--sp-2);
  }

  .revise-row textarea {
    width: 100%;
    box-sizing: border-box;
  }

  /* ── 主区：树 240px + 窗格 ──
     高度跟窗口走（min 420 保证编辑器不至于只有几行；max 与窗口高对齐），
     两个子块各自 overflow: auto——页面**不因为文件多而整页变长**。 */
  .review-pane,
  .file-pane {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    gap: var(--sp-2);
    /* 同上：吃剩余高度（basis 0：高度由剩余空间定，内容在格子里自己滚），22rem 保底 */
    flex: 1 1 0;
    min-height: 22rem;
    margin-top: var(--sp-1);
  }

  /* ⚠️ 素材折叠区里那份**保持固定高度**：它在文档流里（展开才出现），不能吃"剩余高度"，
     否则一展开就把主区压扁、而折叠本身又让页面高度跳变。这一条比上面的 `flex` 更具体，
     所以能盖住（`.fold-body` 在 FoldSection 组件内部，scoped 样式够不到，必须 :global 打洞）。 */
  :global(.fold-body) .file-pane {
    flex: 0 0 auto;
    height: clamp(16rem, 38vh, 26rem);
  }

  .file-tree {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow-y: auto;
    background: var(--panel);
  }

  /* 文件行是真按钮（tab 能到、读屏器能读）——与列表行同一纪律，只是密度更高 */
  .file-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--line);
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .file-tree li:last-child .file-row {
    border-bottom: 0;
  }

  .file-row:hover {
    background: var(--hover);
  }

  .file-row.active {
    background: var(--active, var(--hover));
    font-weight: 600;
  }

  .file-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8125rem;
  }

  /* 变更标记：A/M/D 用 git 的说法，颜色靠全局 badge 的语义色 */
  .change-tag {
    flex: 0 0 auto;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 0.6875rem;
    line-height: 1.5;
    border: 1px solid var(--line);
  }

  .change-tag.add {
    color: var(--good);
    border-color: var(--good);
  }

  .change-tag.mod {
    color: var(--warn);
    border-color: var(--warn);
  }

  .change-tag.del {
    color: var(--bad);
    border-color: var(--bad);
  }

  /* 窗格：分段控件常驻，下面那一块自己滚 */
  .file-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--panel);
  }

  .pane-tabs {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    padding: 2px var(--sp-1);
    border-bottom: 1px solid var(--line);
    flex: 0 0 auto;
  }

  .pane-tabs > button {
    padding: 3px 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-soft);
    font-size: var(--fs-sm);
    cursor: pointer;
  }

  .pane-tabs > button.tabs-active {
    background: var(--panel-sunken, rgba(0, 0, 0, 0.05));
    color: var(--fg);
    font-weight: 600;
  }

  .tabs-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--sp-1);
  }

  /*
   * 「结论已过期」这个标记：**要显眼**，因为它是"别照这个结论做决定"的提示。
   * 用告警色（与失败结论同一个色系），不用灰色——灰色在这里等于"可以不看"。
   */
  .conclusion-bar .stale-tag {
    color: var(--warn, #b45309);
    font-weight: 600;
  }
  /* 「保存改动」比同排的其他 ghost 按钮重要一点：它是"你刚做的事还没算数"的出口。 */
  .conclusion-bar .primary-ghost {
    border-color: var(--accent, #2563eb);
    color: var(--accent, #2563eb);
  }

  .file-body textarea.editor {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    box-sizing: border-box;
    border: 0;
    border-radius: 0;
    resize: none;
    padding: var(--sp-2) var(--sp-3);
    font-size: 0.8125rem;
    line-height: 1.55;
  }

  .file-pre {
    margin: 0;
    padding: var(--sp-2) var(--sp-3);
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    font-size: 0.75rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .file-body .pad {
    padding: var(--sp-3);
    margin: 0;
  }

  .problem-list {
    margin: 6px 0 0;
    padding-left: 18px;
  }

  .problem-list li + li {
    margin-top: 4px;
  }

  /* ══════════ 完成态 ══════════
     ★ 底色/描边/内距吃全局 `.notice`（`.good` 那档），这里只管"竖着排"——
     再自造一张卡片就又多一套边距，是使用者说的"和任务不一样"的来源之一。 */
  .done-box {
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-2);
    padding: var(--sp-4);
  }

  /* U3c-2·审阅态：内容与差异并排（宽屏）；窄屏只显示激活那一格 */
  .review-side {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--sp-2);
    flex: 1;
    min-height: 0;
  }

  .review-cell {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  /* ⚠️ 断点统一 96rem（1536px）：探针视口 1280 属于窄屏，那里应当"只剩激活那一格" */
  @media (max-width: 96rem) {
    .review-side {
      grid-template-columns: minmax(0, 1fr);
    }

    .review-side[data-review-tab='content'] .review-cell[data-cell='diff'],
    .review-side[data-review-tab='diff'] .review-cell[data-cell='content'] {
      display: none;
    }
  }
</style>
