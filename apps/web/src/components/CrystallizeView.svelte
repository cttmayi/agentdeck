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

  // ★ 分批第 194 批：气泡形状与聊天页**同一份**（`packages/ui` 的 ChatBubble）——
  //   沉淀页原来是第二套（`.qa-msg`）、第三套（抽屉分节），于是"同一个对话"在两页里长得不一样。
  import { ChatBubble, FoldSection } from '@agentdeck/ui/components'
  import { api, ApiError, type Skill } from '../lib/api.ts'
  import { t } from '../lib/i18n.ts'
  import { go, goCrystallize } from '../lib/view.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import { showToast } from '../lib/view.ts'
  // ★ 分批第 193 批：`runStatusClass` 不再 import——起草那一轮的抬头不再挂状态徽标
  //   （顶栏那个徽标已经说了"起草中 / 待审阅"，消息里再挂一个就是同一句话说两遍）。
  import { runStatusKey } from '../lib/run-status.ts'
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
  // ★ 分批第 153 批：编辑器搬进右栏 ⇒ 它的状态住在一个 runes 模块里（两个组件读同一份，
  //   见该文件头：legacy 父 → runes 子的 prop 更新不传播）
  import CrystallizeDraftState from './CrystallizeDraftState.svelte'
  import CrystallizeDraftEditor from './CrystallizeDraftEditor.svelte'
  import { draftSkill, editor } from '../lib/crystallize-editor.svelte.ts'

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
      target: { kind: 'new' } | { kind: 'update'; skillId: string }
    } | null
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
   * 两种目标：新建 skill / 更新一份已有 skill。
   *
   * ⚠️ 分批第 191 批删掉了第三种「优化智能体指令」——沉淀只产出 skill。
   */
  let targetKind: 'new' | 'update' = 'new'
  let purpose = ''
  let userFeedback = ''
  let selectedSkillId = ''

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
  /**
   * ★ 分批第 153 批（§12.53 选项 2）：**编辑器那一套状态搬到右栏去了**，它现在住在
   * `lib/crystallize-editor.svelte.ts`（两个组件读同一份：legacy 组件 → runes 子组件的
   * prop 更新不传播，§12.50 坑 4，所以状态既不能挂在这里、也不能挂在右栏）。
   *
   * 这里保留的是**一份镜像**：`CrystallizeDraftEditor` 用 `$effect` 把编辑现场推上来
   * （`syncFromEditor`），结论条据此说"能不能入库 / 改了哪些 / 目标是谁"。
   * ⚠️ 不能用 `$: artifacts = editor.artifacts` 这种"直接读模块信号"的写法：legacy 的 `$:`
   *    跟踪不到跨模块信号，实测结论条会一直画 "○ …"、树与 slug 全不出现（20 条判据连锁红）。
   */
  let artifacts: Artifacts | null = null
  let fileRows: Array<{ rel: string; change: '' | 'A' | 'M' | 'D'; bytes: number }> = []
  let fileCount = 0
  let totalBytes = 0
  let diff: DiffResult | null = null
  let diffAgainst: 'current' | 'previous' | 'original' = 'current'
  let diffLoading = false
  let dirty = false
  let savingDraft = false
  /**
   * ★ 分批第 168 批（回归修复）：右栏是不是"真列"。
   * 窄窗口里右栏是抽屉（移出视口）⇒ 编辑器必须回到**中间那条产物消息**里，
   * 否则使用者看不到草稿内容、也没法在输入条里就着内容反馈。
   */
  let paneWide = true
  /**
   * ★ 分批第 173 批（按你定的模型："它有疑问就可以发问，类似聊天窗口"）：**它在等回答**。
   *
   * `questions !== ''` ⇒ 中间消息流把它显示成一条助手消息、栏脚输入条变成"回答它"。
   * 为什么不是一个新 step：`step` 表示"这一屏在干什么"（目标/起草/审阅/完成），
   * 而"等回答"是**起草这条链上的一个瞬时状态**——它仍然在 `drafting` 那一屏里，
   * 只是最后一条消息从"日志"变成了"问题"。多一个 step 会把所有 `step ===` 的判断
   * 都得改一遍，收益却只是换个名字。
   */
  let questions = ''
  let answering = false

  /** 编辑器（子组件）把编辑现场推上来。见上面那段：为什么必须是回调。 */
  function syncFromEditor(s: {
    artifacts: Artifacts | null
    fileRows: Array<{ rel: string; change: '' | 'A' | 'M' | 'D'; bytes: number }>
    fileCount: number
    totalBytes: number
    diff: DiffResult | null
    diffAgainst: 'current' | 'previous' | 'original'
    diffLoading: boolean
    dirty: boolean
    savingDraft: boolean
    paneWide: boolean
  }): void {
    artifacts = s.artifacts
    fileRows = s.fileRows
    fileCount = s.fileCount
    totalBytes = s.totalBytes
    diff = s.diff
    diffAgainst = s.diffAgainst
    diffLoading = s.diffLoading
    dirty = s.dirty
    savingDraft = s.savingDraft
    paneWide = s.paneWide
  }

  /**
   * ★ 分批第 155 批：把**实际挂上的草稿 run** 告诉右栏（路由里可能给的是来源 run）。
   * 右栏照着它取产物，否则从"来源"进来那一屏右栏是空的（`GET artifacts` 对来源 run 是 404）。
   */
  $: editor.attachedRunId = draftRunId

  /**
   * 改 SKILL.md 时 slug 跟着 frontmatter 的 name 走。
   * 归属仍在这边（slug 是"入库"的字段），编辑器只负责报告"名字变了"。
   */
  editor.onSlugName = (name: string) => {
    if (name !== '' && slug !== '') slug = name
  }
  /** 素材分节（文件清单 + 预览）。 */
  let material: {
    dir: string
    /** 目录短名（只显示末两级，整条路径放进 title）——折叠行摘要里不能塞绝对路径。 */
    dirLabel: string
    items: Array<{ relPath: string; bytes: number; text: string; truncated: boolean }>
  } | null = null

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
    mode: 'files' | 'text' | 'refused'
    refusalReason?: string
    files: Record<string, string>
    skillMd: { name: string; description: string; body: string; raw: string }
    validation: { ok: boolean; problems: Array<{ file: string; message: string }> }
    target: { kind: 'new' } | { kind: 'update'; skillId: string } | null
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
  /**
   * ★ 分批第 194 批：**refused 不是"没通过"**。
   *
   * 起草者判定"这里没有可沉淀的内容"时写的是 `REFUSED.md`，而 `validation.ok` 因此为 false
   * ⇒ 结论条原来画 `✗` 并写「体检发现 1 处问题 · 校验未通过（1）」，看起来像**审核不通过**。
   * 使用者当场问"当前还有审核吗，为什么还有提示…"。它是**结论**（"这次没什么可沉淀的"），
   * 所以标记用 `–`（中性）而不是 `✗`（失败），文案走 `crystallize.refusedTitle`。
   */
  $: refused = artifacts !== null && artifacts.mode === 'refused'
  $: conclusionMark =
    artifacts === null ? '○' : refused ? '–' : artifacts.validation.ok ? '✓' : '✗'
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
  $: reviewValid = artifacts !== null && artifacts.validation.ok && slug.trim() !== ''

  /** 开始沉淀按钮的悬停解释：素材为空 / 任务门槛不过，分开说清。 */
  $: startDisabledReason =
    targets !== null && targets.materialStats === null
      ? $t('crystallize.noMaterial')
      : targets !== null && targets.scope === 'task' && !(targets.reviewed || targets.hasUserFeedback)
        ? $t('crystallize.taskGated')
        : undefined

  $: runShort = draftRunId !== '' ? draftRunId.slice(0, 4) : ''

  /**
   * 「你那一轮」说的话（见时间线里 `data-crystal-request` 那段注释）。
   *
   * ⚠️ 作用描述与反馈**不落库**（`crystallizeTarget` 只记 new/update + skillId），所以从
   *    深链恢复一条草稿时这两截是空的 ⇒ 只说"新建一份技能"。宁可少说，不要编。
   */
  $: requestLine = (() => {
    const head =
      targetKind === 'new'
        ? $t('crystallize.requestNew')
        : $t('crystallize.requestUpdate', { skill: skillNameFor(selectedSkillId) })
    const detail = targetKind === 'new' ? purpose.trim() : userFeedback.trim()
    if (detail === '') {
      // 空白起的材料是"我给它的东西"，说在这儿比单独一行更像对话
      if (blankStart && blankMaterials.length > 0) {
        return $t('crystallize.requestWithMaterials', {
          head,
          n: String(blankMaterials.length),
        })
      }
      return head
    }
    return `${head}：${detail}`
  })()

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
    editor.reset()
    material = null
    materialPick = ''
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
    editor.reset()
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
    // 还原起草时的目标（commit 按它走：更新 = 复用原 id 进化）
    if (ad.target.kind === 'new') {
      targetKind = 'new'
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
  /**
   * ★ 分批第 166 批（§12.59）：空白起的材料是**一组**。以前只有 `blankMaterialText` 一段，
   * 于是"我手上有三份笔记"只能先自己合并——而材料本该原样交给起草者。
   */
  let blankMaterials: Array<{ text: string }> = []
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
    kind: 'new' | 'update'
    skillId: string
    purpose: string
    feedback: string
    /** 空白起才有的（见 CrystallizeIntake 的 blank 流程）。 */
    blank?: boolean
    /** ★ 分批第 166 批：材料是**一组**（可零份、可多份）。 */
    materials?: Array<{ text: string }>
  }): void {
    /**
     * ★ 分批第 175 批（使用者定：**没装 distilly 之前不应该能沉淀**）：
     * 起草者是"按技能干活"的，没有那份技能它就没有"怎么写"的依据 ⇒ 在**发起之前**拦住，
     * 并说清去哪儿装（沉淀页右上「沉淀设置」）。服务端的二次拦截是下一步（要同步改夹具）。
     */
    if (draftSkill.id === '') {
      error = '还没安装「沉淀用技能」——先去右上角「沉淀设置」里一键安装，再回来点开始提炼。'
      step = 'target'
      return
    }
    targetKind = payload.kind
    purpose = payload.purpose
    selectedSkillId = payload.skillId
    userFeedback = payload.feedback
    blankStart = payload.blank === true
    blankMaterials = payload.materials ?? []
    void startDraft()
  }

  async function startDraft(): Promise<void> {
    error = ''
    attached = true // 点了开始 = 放弃旧的提示
    if (targetKind === 'update' && selectedSkillId === '') {
      error = $t('crystallize.targetUpdate')
      return
    }
    try {
      const target =
        targetKind === 'new'
          ? { kind: 'new' as const, purpose: purpose.trim() }
          : { kind: 'update' as const, skillId: selectedSkillId }
      /**
       * ★ 分批第 133 批：空白起走 `startFrom: 'blank'`——**没有来源 run**，素材是使用者
       * 在提问里给的那一段（可空）。不带 `runId`（两者只能二选一，daemon 会 400）。
       */
      const body =
        blankStart || blankMode
          ? {
              startFrom: 'blank' as const,
              // ★ 分批第 165 批（§12.58）：空白起也能"改一份已有技能"——目标照 `target` 传，
              //   只有"优化智能体指令"在空白起不可选（没有来源 run 就没有候选，daemon 拒绝）。
              target,
              ...(blankMaterials.length === 0 ? {} : { materials: blankMaterials }),
            }
          : {
              runId,
              target,
              ...(userFeedback.trim() !== '' ? { userFeedback: userFeedback.trim() } : {}),
            }
      // ★ 分批第 173 批：装了"沉淀用技能"就注入（不装也能沉淀：注入是可选的）
      if (draftSkill.id !== '') {
        ;(body as Record<string, unknown>)['skillIds'] = [draftSkill.id]
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
    editor.reset()
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
      // ★ 分批第 173 批：**先问"它是不是在提问"**——只提问的那一轮没有产出，
      //   直接走 `loadDraftOutput()` 会把它画成"审阅态但空草稿"（人看不出它在等自己）。
      if (await loadQuestions()) return
      await loadDraftOutput()
    } else {
      draftStatus = status === 'cancelled' ? 'cancelled' : 'failed'
      step = 'drafting'
      void fetchDraftFailure(draftRunId)
    }
  }

  /**
   * 读"它在等回答吗"（`GET /api/crystallize/questions`）。
   *
   * 返回 `true` = 有开放问题 ⇒ 调用方**不要**进审阅态（那一轮没产出）。
   */
  async function loadQuestions(): Promise<boolean> {
    if (draftRunId === '') return false
    try {
      const res = await api<{ questions: string | null }>(
        `/api/crystallize/questions?draftRunId=${encodeURIComponent(draftRunId)}`,
      )
      questions = res.questions ?? ''
      return questions !== ''
    } catch {
      questions = ''
      return false
    }
  }

  /**
   * ★ 分批第 173 批：**回答起草者的问题**（`POST /api/crystallize/answer`）。
   *
   * 它起的是一条**新 run**（并接上刚才那条会话）——所以这里要像起草一样把终态处理清干净：
   * `handledTerminal` 复位、`questions` 清空，否则新 run 完成时会被上一轮的"已处理"挡住。
   */
  async function answerQuestion(text: string): Promise<void> {
    if (answering || draftRunId === '') return
    answering = true
    error = ''
    try {
      const res = await api<{ draftRunId: string }>('/api/crystallize/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId, answer: text.trim() }),
      })
      draftRunId = res.draftRunId
      draftStatus = null
      draftFailedReason = ''
      handledTerminal = false
      questions = ''
      step = 'drafting'
      composerText = ''
      composerReceipt = '收到，已经转给它了（如果还有没问清的，它会再问一轮）。'
    } catch (err) {
      composerReceipt = `回答没送出去：${err instanceof Error ? err.message : String(err)}`
    } finally {
      answering = false
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
   * 取草稿产出并进入审阅态（四轮：`GET /api/crystallize/artifacts`）。
   *
   * ★ 改之前这里自己拉 run 的消息、自己拆 frontmatter——解析规则被复制到前端，
   *   而且 `===== FILE: xxx =====` 那段多文件约定**从来没被解析**（多文件产物被
   *   塞进正文丢掉）。现在服务端读 `skill/` 目录、解析 frontmatter、跑校验，前端只画。
   *
   * ★ 分批第 153 批：产出与编辑现场在 `lib/crystallize-editor.svelte.ts`（右栏读同一份）。
   *   这里只做"读完之后界面怎么摆"：目标、slug、步骤、素材、最后结果。
   */
  async function loadDraftOutput(): Promise<void> {
    try {
      const res = await editor.open(draftRunId)
      // 目标以**落库的目标**为准（恢复的草稿按它还原）；界面上的 targetKind 跟着走
      if (res.target !== null && res.target !== undefined) {
        if (res.target.kind === 'update') {
          targetKind = 'update'
          selectedSkillId = res.target.skillId
        }
      }
      slug = res.skillMd.name
      void loadMaterial()
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

  /**
   * ★ 分批第 162 批（§12.14）：**对话里那行「我当时给了它什么」**。
   *
   * 设计原文：「对话里一行摘要回答*我当时给了它什么*（审计用）；右栏清单回答*它现在手上
   * 有什么*（操作用）」，并且——**两处必须由同一份数据现算，否则必漂**。右栏清单已经是
   * `GET /api/crystallize/material` 现算的，这行摘要也必须从**同一份 `material`** 推出来，
   * 不能另拼一个数（第一版只写了"几轮几次工具调用"，删掉一份材料它不会变——使用者看不出
   * 自己刚删的那份算不算数）。
   *
   * 分类口径与右栏一致：`turns/` + `task-run.md` + `verdict.md` + `feedback.md` 是**轨迹**
   * （平台从来源 run 切出来的），`appended/` 是**使用者给的**（空白起/追加/拖进来/仓库），
   * 剩下的是平台自己的登记文件（索引页 / meta / 技能清单 / `existing-*`）。
   */
  $: givenCount =
    material === null ? 0 : material.items.filter((i) => i.relPath.startsWith('appended/')).length
  $: traceCount =
    material === null
      ? 0
      : material.items.filter(
          (i) =>
            i.relPath.startsWith('turns/') ||
            i.relPath === 'task-run.md' ||
            i.relPath === 'verdict.md' ||
            i.relPath === 'feedback.md',
        ).length
  $: materialCountLine = (() => {
    if (material === null) return ''
    const total = material.items.length
    if (total === 0) return $t('crystallize.materialCountNone')
    // 轨迹那一档在**空白起**的草稿里恒为 0 ⇒ 不写出来（否则屏幕上会多一行"轨迹 0"，
    // 而探针有一条判据专门钉"空白起不许出现轨迹字样"）
    const parts: string[] = []
    if (traceCount > 0) parts.push($t('crystallize.materialCountTrace', { n: String(traceCount) }))
    if (givenCount > 0) parts.push($t('crystallize.materialCountGiven', { n: String(givenCount) }))
    return parts.length === 0
      ? $t('crystallize.materialCount', {
          n: String(total),
          parts: $t('crystallize.materialCountGiven', { n: '0' }),
        })
      : $t('crystallize.materialCount', { n: String(total), parts: parts.join(' · ') })
  })()

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
    /**
     * ★ 分批第 173 批：**它在等回答时，栏脚这句话就是回答**（不要求「这里不对：」前缀）。
     * 顺序很关键：这条判断必须在"意图路由"之前——否则"这里不对"会被当成改稿意见，
     * 而此刻真正该做的是把话转给它（§12.12："显式动作先于隐式答题"的反面同样成立）。
     */
    if (questions !== '' && draftRunId !== '') {
      void answerQuestion(text)
      return
    }
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
      editor.reset()
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
    ── 起草这一轮：**一条助手消息**（分批第 193 批，使用者："目前沉淀还是显示「起草 run
    run 01M6… 已完成 完整日志」 更像任务，不像是对话方式"）──

    改之前它是一块抽屉分节：抬头 `起草 run`、后面跟 `run 01M6…` + 状态徽标 + 「完整日志」按钮，
    正文是最后结果。那套抬头是**任务页 run 面板**的形状（"这条 run 跑成什么样"），
    而沉淀是对话——同一条消息流里别的消息都是"谁在说话 + 说了什么"，只有这一条在报 run id
    与状态徽标，读起来就是任务日志嵌进了聊天窗。

    现在的形状是**三种状态都用一句人话开头**：
      · 正在写 → 「正在把素材写成 skill…」+ 实时过程（它此刻的正文）+ [停止]
      · 没写成 → 「这次没写成：<原因>」+ [重新起草]
      · 写好了 → 「写好了 · 3 个文件」+ 最后结果（正文），过程收在消息末尾一行小字后面

    三处刻意的取舍：
      ① **run id 不在抬头上**（那是排查用的）：挪进展开后的过程里当注脚。
      ② **状态徽标不在消息里重复**：顶栏那个徽标已经说了「起草中 / 待审阅」，这里再挂一个
         同一个状态的徽标，就是"同一句话在一屏里说两遍"（这类重复本仓库删过好几处）。
      ③ **过程默认收起、按钮是一行小字**：「它怎么做的」是回看时才要的，不是读产出时要的。
  -->
  {#snippet draftTurn()}
    <!--
      ★ 分批第 194 批：形状与聊天页**逐行对齐**（`Chat.svelte` 的 turn 是同一套）：
        · 跑着 → `who`（起草者 · 正在写 [停止]）+ 实时日志（与聊天页 `RunLog` 同位）；
        · 写完 → `who`（起草者 · 写好了 · 3 个文件）+ 气泡（Markdown）+ 一行小字「它怎么做的」；
        · 失败 → `who`（起草者 · 这次没写成）+ 气泡里是原因与动作。
      这套形状来自 `@agentdeck/ui` 的 `ChatBubble`，两页共用一份定义。
    -->
    <ChatBubble
      role="agent"
      who={`${$t('crystallize.speakerDrafter')} · ${
        refused
          ? $t('crystallize.refusedHead')
          : draftLiveNow
            ? $t('crystallize.draftTurnLive')
            : draftStatus === 'failed'
              ? $t('crystallize.draftFailed')
              : draftStatus === 'cancelled'
                ? $t('crystallize.draftStopped')
                : $t('crystallize.draftTurnDone')
      }${
        !refused && !draftLiveNow && draftStatus === 'completed' && fileCount > 0
          ? ` · ${fileCount} ${$t('crystallize.filesUnit')}`
          : ''
      }`}
    >
      {#snippet whoExtra()}
        {#if draftLiveNow}
          <!-- ★ 分批第 150 批：停止在这条消息上（它说明的正是"这一轮跑到哪了"） -->
          <button class="ghost small stop" onclick={() => void stopDraft()}>{$t('chat.stop')}</button>
        {:else}
          <button
            type="button"
            class="draft-turn-toggle"
            data-draft-process-toggle
            onclick={() => (draftLogOpen = !draftLogOpen)}
          >
            {draftLogOpen ? $t('crystallize.draftProcessHide') : $t('crystallize.draftProcessShow')}
          </button>
        {/if}
      {/snippet}

      {#if refused}
        <!--
          ★ 分批第 195 批：**起草者拒绝时，理由只说一次，而且就在它嘴里**。

          改之前这条理由出现三处：结论条「起草者判定：这里没有可沉淀的内容」、中间一条气泡
          （`REFUSED.md` 原文）、右栏「体检」里又把同一段当成"问题"。使用者问"有必要显示
          REFUSED.md 的内容吗"——**有必要，但只该有一处**：它是"为什么不做"的唯一解释，
          删了就只剩下"它没给东西"。所以留下这一处（气泡正文），另外两处不再复述。

          ⚠️ 顺便修掉一个错话：拒绝的草稿没有"最后一段正文"，于是原来会落进
             「这次执行没有留下文字产出」那一支——而它明明写了 REFUSED.md。
             那条空态现在只在**真没有产出**时出现。
        -->
        <p class="draft-turn-reason">{artifacts?.refusalReason ?? ''}</p>
        <div class="row-end msg-actions" data-msg-actions>
          <button class="ghost small" onclick={retryDraft}>{$t('crystallize.retryDraft')}</button>
          <button class="ghost small" onclick={() => void abandonReview()}>
            {$t('crystallize.abandon')}
          </button>
        </div>
      {:else if draftLiveNow}
        <div class="log-box">
          <RunLog runId={draftRunId} onterminal={(st) => void onDraftTerminal(st)} />
        </div>
      {:else if draftStatus === 'failed' || draftStatus === 'cancelled'}
        {#if draftFailedReason !== ''}
          <p class="draft-turn-reason">{draftFailedReason}</p>
        {/if}
        <div class="row-end msg-actions" data-msg-actions>
          <button class="ghost small" onclick={retryDraft}>{$t('crystallize.retryDraft')}</button>
        </div>
      {:else if draftFinalState === 'loading'}
        <div class="skeleton"></div>
      {:else if draftFinalState === 'empty'}
        <p class="empty">
          <strong>{$t('tasks.noTextOutput')}</strong>
          {$t('tasks.noTextOutputHint')}
        </p>
      {:else}
        {@html renderMarkdown(draftFinalText)}
      {/if}

      {#if !draftLiveNow && draftLogOpen}
        <!-- run id 只在这里露脸（排查用），不进抬头 -->
        <p class="faint small draft-turn-runid">run {runShort}…</p>
        <div class="log-box">
          <RunLog runId={draftRunId} onterminal={(st) => void onDraftTerminal(st)} />
        </div>
      {/if}
    </ChatBubble>
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

  <!--
    ★ 分批第 195 批：**「入库 / 反馈 / 放弃」搬回栏头右侧**（使用者 2026-11："「入库」的按钮
      不应该在对话下面，可能放顶上右侧比较合理"）。

    翻转的是分批第 150 批那条口径（那一批把它们从栏头搬进了消息底部，理由是"动作离结论
    远了"）。为什么这次反过来是对的：第 193–194 批把中间栏变成了**一段对话**
    （你 / 起草者 / 它的提问），消息区里再摆一排动作按钮，就又把"对话"挤回了任务面板的样子
    ——而这三个动作**不属于某一条消息**，它们属于"这一版草稿"（整页）。页级的动作放页级的位置，
    这是本仓库一直在用的规矩（聊天「新对话」、任务「新建任务」都在栏头）。

    ⚠️ 留在消息里的仍然留在消息里（它们属于那一条消息的状态）：起草中的「停止」、失败时的
    「重新起草」、目标态最后一问的「开始提炼」。
  -->
  {#snippet headActions()}
    {#if step === 'review' && artifacts !== null && !refused}
      <div class="head-actions" data-review-actions>
        <button
          type="button"
          class="ghost small"
          class:active={reviseOpen}
          data-review-feedback
          onclick={() => void toggleReviseBox()}
        >{$t('crystallize.reviseTitle')}</button>
        <button type="button" class="ghost small" data-review-abandon onclick={() => void abandonReview()}>
          {$t('crystallize.abandon')}
        </button>
        <button
          type="button"
          class="primary small"
          data-review-commit
          disabled={saving || !reviewValid}
          title={reviewValid ? undefined : $t('crystallize.confirmBlocked')}
          onclick={() => void save()}
        >{$t('crystallize.confirm')}</button>
      </div>
    {/if}
  {/snippet}


<MainArea
  headClass="detail-head"
  backLabel={backLabel}
  onBack={onback}
  title={$t('crystallize.title')}
  bodyClass="detail-scroll"
  actions={headActions}
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
      <!--
        ★ 分批第 194 批：这一层的 `data-msg-role` 从 `assistant` 改成 `stream`。

        它是 U3a 那时的**外壳**（"消息流的容器"），却挂着 `assistant` 这个角色——而第 194 批
        起时间线里真的有助手消息了（`[data-draft-turn-msg]`），于是探针的
        `.crystal-msg[data-msg-role="assistant"] ...` 全都会先命中这个外壳，再在里面
        找错的那一条（实测：量"起草那一轮的抬头"拿到的是"你"）。容器不是消息，
        给它自己的名字。
      -->
      <div class="crystal-msg" data-msg-role="stream">
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
      <!-- ★ 分批第 173 批：**它在问**——问题是一条助手消息（与"提问/材料"同一种形状），
           下面是栏脚输入条；人回答之后平台起下一条 run 并接上会话。 -->
      {#if questions !== ''}
        <div class="crystal-msg" data-msg-role="assistant" data-crystal-questions>
          <ChatBubble
            role="agent"
            who={$t('crystallize.speakerDrafter')}
            html={renderMarkdown(questions)}
          />
          <p class="faint small">它在等你回答——直接写在下面的输入条里（一行也行，多行也行）。</p>
        </div>
      {/if}
      <!--
        ★ 分批第 194 批：**你把话说清楚了，它才能开始**——这条是"你那一轮"。

        改之前起草一开始，目标屏那串问答（这次要沉淀成什么 / 作用描述…）就整块消失了：
        中间栏只剩"起草 run 01M6…"，读起来像任务创建完就没有前因后果了。而沉淀是对话，
        一段对话的第一条应该是**人说的话**。这里就是那句：
          · 新建 → 「新建一份技能：<作用描述>」
          · 更新 → 「优化「<哪一份技能>」：<希望改什么>」
        作用描述与反馈**不落库**（`purpose` 只影响起草 prompt），所以从深链恢复的草稿上
        这一条只说"新建一份技能"——那是实话，不编。
      -->
      <div class="crystal-msg" data-msg-role="user" data-crystal-request>
        <ChatBubble role="user" who={$t('crystallize.speakerYou')} text={requestLine} />
        <!-- ★ 分批第 162 批（§12.14）：一行说清「我当时给了它什么」（与右栏清单同一份数据）。 -->
        {#if materialCountLine !== ''}
          <p class="faint small crystal-material-line" data-crystal-material-line>
            {materialCountLine}
          </p>
        {/if}
      </div>
      <!-- ★ 分批第 193 批：起草这一轮是一条**助手消息**（见 `draftTurn` 上方的注释）。 -->
      <div class="crystal-msg" data-msg-role="assistant" data-draft-turn-msg>
        {@render draftTurn()}
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
                // 换版之后磁盘上是新版的内容 ⇒ 旧版的"未保存改动"不再成立（状态在模块里）
                editor.dirty = false
                followNewVersion(pendingNewVersion)
              }}>{$t('crystallize.newVersionGo')}</button
            >
          </div>
        {/if}
        {#if !refused}
        <section class="conclusion-block">
          <div class="conclusion-bar" class:bad={conclusionBad}>
            <span class="bar-mark" aria-hidden="true">{conclusionMark}</span>
            <span class="bar-text">
              {#if artifacts === null}
                <span class="muted">…</span>
              {:else if refused}
                <!-- ★ 分批第 194 批：**这是结论，不是失败**（`REFUSED.md`）。
                     原来它走的是"体检没通过"那一支 ⇒ 红条写着「体检发现 1 处问题 ·
                     校验未通过（1）」，看起来像审核没过。 -->
                <strong>{$t('crystallize.refusedTitle')}</strong>
              {:else if artifacts.validation.ok}
                <strong>{$t('crystallize.checkPassed')}</strong>
                <span class="faint small">（{$t('crystallize.checkTitle')}）</span>
              {:else}
                <strong>{$t('crystallize.checkProblems', { n: String(artifacts.validation.problems.length) })}</strong>
              {/if}
              {#if artifacts}
                <span class="bar-sep">·</span>
                {#if artifacts.validation.ok || refused}
                  <span class="muted">
                    {fileCount} {$t('crystallize.filesUnit')}
                    {#if refused}
                      <!-- ⚠️ 拒绝的草稿**不画对比**：它只有一份 REFUSED.md，而基线是"当前技能"，
                           算出来的 `+3 −0` 是拿"拒绝说明"跟技能正文比的数字，纯噪音。
                           （探针实测到了它：`– 起草者判定… · 1 个文件 · 对比当前版本 +3 −0`。） -->
                    {:else if diff !== null && (diff.totals.added > 0 || diff.totals.removed > 0)}
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
                  <!-- ★ 分批第 194 批：这里原来又写一遍「校验未通过（N）」——紧跟在前面的
                       「体检发现 N 处问题」后面，等于同一件事说两遍，而且"校验"这个说法让人
                       以为还有一道审核。改成指路（问题清单在哪看），不复述数字。 -->
                  <span class="muted">{$t('crystallize.problemsWhere')}</span>
                {/if}
                <span class="bar-sep">·</span>
                <span class="muted">
                  {#if targetKind === 'new'}
                    {$t('crystallize.targetNew')}
                  {:else}
                    {$t('crystallize.targetUpdate')} {skillNameFor(selectedSkillId)}
                  {/if}
                </span>
              {/if}
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
        {/if}

        <!--
          起草者判定"不可沉淀"：这是结论，不是失败——只给重新起草 / 放弃。
          ⚠️ 2026-10-21：它原来是上面那条 if-chain 的第一支；结论条不再属于那条链
          （结论条在 artifacts 还没到时也要能显示审核那部分），所以这里单独成一个 if。
        -->
        <!-- ★ 分批第 195 批：这里的「起草者判定」气泡删了——拒绝的理由已经在**起草那一轮**
             的消息里说过一次（`draftTurn` 的 refused 分支）。同一句话在一屏里出现两遍，
             正是"有点乱"的来源之一。 -->

        <!-- ★ 分批第 153 批（§12.12 / §12.53 选项 2）：编辑器抽成 `CrystallizeDraftEditor`，
             它自己也带"有没有产出 / 是不是 refused"的判断。
             ⚠️ **不要**把它包在 `{#if artifacts && ...}` 里：`artifacts` 这份镜像正是由它推上来的
             （`onstate`），包起来就成了"镜像要等编辑器挂载、编辑器要等镜像"的死锁——
             实测 37 条判据连锁红（结论条 "○ …"、树空、slug 不出现）。
             这一批先渲染在原位（行为不变）；下一批把它挂进右栏产物栏，中间只留结论与出口。 -->
        <!-- ★ 分批第 155 批：编辑器搬进右栏；这里只留一个**什么也不画**的状态推送器
             （legacy 组件的 `$:` 读不到模块信号，必须由 runes 组件回调推上来）。 -->
        <CrystallizeDraftState onstate={syncFromEditor} />
        <!-- ★ 分批第 168 批：窄窗口（右栏是抽屉）时，编辑器回到这条产物消息里 -->
        {#if !paneWide}
          <CrystallizeDraftEditor />
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
  /* ★ 分批第 193 批：`.msg-actions p` 删了——起草那一轮抬头不再是 `<p class="faint small">`
     挂在动作条里（现在是 `draft-turn-head`），那条选择器已经没有宿主。 */
  /* ★ 分批第 195 批：`.conclusion-bar .bar-actions*` 那三条样式删了——动作（入库 / 反馈 /
     放弃）搬到了**栏头右侧**（`[data-review-actions]`）。结论条现在只是一行状态字。 */
  .head-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    margin-left: auto;
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

  /* 「你那一轮」+ 素材那一行、以及起草那一轮：都自然高度、不吃剩余空间。
     ★ 分批第 194 批：`data-msg-role="system"` 那条消失了（素材行并进了"你那一轮"），
     换成 user / assistant 两条——它们的 flex 必须仍在下面那两条规则里管住。 */
  .crystal-msg[data-msg-role='user'] {
    flex: 0 0 auto;
  }
  /**
   * ★ 分批第 193 批：起草那一轮的消息也是**自然高度**，不吃剩余空间。
   *
   * ⚠️ 不给这条的话它会吃到 `.crystal-msg` 的默认 `flex: 1`——审阅态里那条消息会跟
   *    **产物消息**平分高度，而真正要占满的是产物（编辑器）。正文自己有 `max-height:
   *    24rem`，多出来的空间只会变成一块空白。
   */
  .crystal-msg[data-draft-turn-msg] {
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
  .radio-row:hover {
    background: var(--surface-hover);
  }
  .radio-row.disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  /* ★ 全局 `input` 规则把 radio 撑成通栏宽、还带边框与 padding——这里逐条 reset
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
  .skill-row:hover {
    background: var(--surface-hover);
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
  .row-end {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
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
  /* ★ 分批第 159 批：`.process-pane .log-box` 这条删了——起草日志现在挂在**系统消息**里
     （U3b），`.process-pane` 底下只剩"依据"两块（`> .proc-block`），日志框的选择器已经指不到东西。 */
  .process-pane > .proc-block {
    flex: 0 1 auto;
    min-height: 0;
    /* 问题清单：按内容高，但**最多占一半**——判决条目多时不许把日志挤没 */
    max-height: 50%;
    overflow: auto;
  }
  /* 带日志的那一块：吃剩余高度（它是这个格子里唯一"越长越好"的东西） */
  /* ══════════════════════════════════════════════════════════════════
     ★ 分批第 194 批：气泡本身的观感搬到 `@agentdeck/ui` 的 `ChatBubble`（两页共用），
     这里只剩三样沉淀**特有**的小东西：过程开关、失败原因、run id 注脚。
     ⚠️ 193 批那套 `.draft-turn*`（抬头/脉动/末尾一行）随"抬头改成 who 行"一起删——
        形状让给了聊天页那一套，不再有两份。
     ══════════════════════════════════════════════════════════════════ */
  /* 过程开关：`who` 行里的一行小字（不是 h3 里的动作按钮——那是任务面板的做法） */
  .draft-turn-toggle {
    background: none;
    border: 0;
    padding: 0;
    margin-left: auto;
    color: var(--text-faint);
    cursor: pointer;
    font-size: var(--fs-xs);
    font-family: inherit;
    text-decoration: underline;
  }
  .draft-turn-toggle:hover {
    color: var(--text-muted);
  }
  /* 「停止」在 who 行右侧（与聊天页 `.stop` 同一位置、同一作用） */
  .stop {
    margin-left: auto;
  }
  .draft-turn-reason {
    margin: 0 0 var(--sp-2);
    white-space: pre-wrap;
  }
  .draft-turn-runid {
    margin: var(--sp-2) 0 0;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
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
  /*
   * ★ 分批第 195 批：`.conclusion-bar .bar-actions`（动作组）与它的取整规则删了——
   * 动作搬到栏头右侧（`[data-review-actions]`），结论条不再托按钮，也就不需要为它
   * 把 `.small` 压到 3px。**这条结论条现在是一行纯文本**（体检结果 · 文件数 · 目标）。
   */
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
  /* 「保存改动」比同排的其他 ghost 按钮重要一点：它是"你刚做的事还没算数"的出口。 */


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

  /* ★ 分批第 159 批：`.review-side` / `.review-cell` 的样式**跟着编辑器走了**
     （`CrystallizeDraftEditor.svelte`）——元素由那个组件渲染，样式留在这里一条都不生效
     （Svelte 的 `<style>` 按组件作用域，§12.55 坑 4 的同一件事）。这里连同那条按视口判的
     `@media` 一起删掉：右栏只有 24–30rem，编辑器里永远是单列切换，没有"并排"这回事。 */
</style>
