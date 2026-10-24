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
  import { go } from '../lib/view.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import { resolveAuditBar } from '../lib/audit-bar.ts'
  import { showToast } from '../lib/view.ts'
  import { runStatusClass, runStatusKey } from '../lib/run-status.ts'
  // ★ 「最后结果」要按 Markdown 渲染（与任务详情页的最终产出同一观感）。
  //   ⚠️ 批次 2 删预览时把这个 import 一起删了——那是对的（预览是"同一份内容的第二种
  //   渲染"），这里是另一个用途：**起草 run 的最终产出**。两件事不要混。
  import { tick } from 'svelte'
  import { buildFeedbackDraft } from '../lib/crystallize-feedback.ts'
  import { renderMarkdown } from '../lib/markdown.ts'
  import { finalResultText } from '../lib/final-output.ts'
  import { crystallizeState, crystallizeStateKey } from '../lib/crystallize-state.ts'
  import MainArea from './MainArea.svelte'
  import RunLog from './RunLog.svelte'

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

  let step: 'target' | 'drafting' | 'review' | 'done' = 'target'
  let targets: CrystallizeTargets | null = null
  let error = ''
  let loading = false

  // ── 目标选择 ──
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
   * 审阅屏的三个 tab：`草稿` / `依据` / `过程`（2026-10-21 使用者确认的信息分层）。
   * ⚠️ 名字不能叫 `reviewTab`——那个名字已经被下面"内容 / 差异"的内层切换占了
   *    （`js_parse_error: Identifier 'reviewTab' has already been declared`，svelte-check 当场报）。
   *    两层各叫各的：外层 `reviewSection`（草稿/依据/过程）、内层 `reviewTab`（内容/差异）。
   *
   * 常驻的只有结论条那一块；这三块互不"同时要看"——
   *   · 草稿 = 要动手的那一屏（树 + 编辑器 / 差异），默认停在这里；
   *   · 依据 = 起草者读过的素材（原来折在编辑器**下面** y≈842 处：要滚下去，
   *     还要先展开一层折叠；现在一进来点一下就有）；
   *   · 过程 = 审核问题清单 + 审核日志 + 起草 run（两态：最后结果 / 完整日志）。
   * ⚠️ 原来这三块是竖着摞的，其中"过程"那两块（日志、起草 run）还把编辑器往下推。
   */
  let reviewSection: 'draft' | 'evidence' | 'process' = 'draft'

  /**
   * 起草中那一屏的两个 tab：`产出` / `依据`（2026-10-21 第 4 批）。
   *
   * 裁定与审阅屏同一条轴——哪些必须同时看到：
   *   · 产出 = 那条 run 的**实时输出**（跑着的时候它是唯一的实时信息，所以默认停在这里）；
   *   · 依据 = 起草者据以干活的东西：**目标摘要**（新建 / 更新谁）+ **素材**（它按需读的文件）。
   * ⚠️ 审阅屏的「依据」只有素材——因为那边"目标是谁"已经在结论条上了（`新建 skill` / `更新 x`）。
   *    起草中这一屏**没有结论条**，所以目标摘要归到依据里：同一件事不在两处重复，也不凭空消失。
   */
  let draftTab: 'run' | 'evidence' = 'run'

  /**
   * 审核 run 的**实时**状态（来自事件流，见 `RunLog` 的 `onstatus`）。
   *
   * ⚠️ 为什么不能只用 `reviewInfo.reviewRunStatus`：那是"读接口那一刻"的快照。点「开始审核」
   *    时 run 还在 `queued`，徽标就会**一直**显示「排队中」——而日志已经在流了。
   *    实测（探针 `crystal.auditLiveBadge`）抓到过这一幕。
   *
   * ⚠️⚠️ 必须**连着 runId 一起存**（2026-10-23 使用者报的缺陷）：
   *    原来只存一个字符串。点「反馈」之后，新一版草稿由**平台自动**起审核，那一刻还没有判决，
   *    而缓存里还留着**上一版审核的终态** `completed` ⇒ `auditNoVerdict` 成立 ⇒ 结论条一口
   *    咬定「审核跑完了，但没有留下可用的判决……**这一步等于白跑**」。使用者原话正是
   *    「点反馈后，开始执行，但在其审核执行阶段，提示……」——那时审核**刚刚开始**。
   *    只在「开始审核」那里清空（`startAudit`）治不了这条路：反馈不经过它；而"再找几个地方
   *    补清空"是按下葫芦起了瓢 ⇒ 真正该钉的是**这条状态属于哪条 run**：runId 对不上就一律
   *    不采信，无论谁忘了清。
   */
  let auditLive: { runId: string; status: string } | null = null

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

  /**
   * `GET /api/crystallize/review` 的返回（服务端已把"两条 run 怎么对应"解析好）。
   *
   * 前端不自己去翻 run 列表找判决：那会把"审核 run 与起草 run 怎么对应"这条规则
   * 复制到前端（后端改一处、前端漏一处）。
   */
  interface DraftReviewInfo {
    review: {
      reviewRunId: string
      reviewRunStatus: string
      /** `verdict.status`：`advisory` / `rework_requested` / `escalated` / `invalid` … */
      status: string
      conclusion: string
      reasonCode: string
      findings: Array<{
        severity: string
        summary: string
        evidence: Array<{ locator: string | null; excerpt: string | null }>
      }>
      escalateReason: string | null
      createdAt: number
    } | null
    reviewRunId: string | null
    reviewRunStatus: string | null
    /**
     * 这个结论是不是"改之前的"（服务端拿"审核时钉下的指纹"与"此刻磁盘内容"比出来的）。
     * `null` = 判不出来（旧数据没有指纹 / 这条草稿还没审过）——**不显示任何提示**，
     * 因为编一个"没过期"会让界面安静地把可能对不上的结论当成有效结论。
     */
    stale: boolean | null
    /** 这条**链**上已经起草过几版（⛔ 2026-10-23 之前这里数的是"同来源"，混链时会虚高）。 */
    versions: number
    /**
     * 自动循环的可见面（分批第 23 批）。
     *
     * ⚠️ 为什么界面必须显示 `current/max` 与 `spentUsdMicros`：使用者定的是"默认 10 轮、
     *    无进展不早停"，而实测一条链 10 轮 ≈ $30 且每轮递增。"跑 N 轮"如果不带成本显示，
     *    就等于让人闭着眼睛花钱。
     * `stalled` = 同一处问题连续两轮被点名（只标注**不停**，使用者定的口径）。
     */
    autoRework?: {
      current: number
      max: number
      spentUsdMicros: number
      stopped: boolean
      stalled: Array<{ locator: string; rounds: number }> | null
    }
  }

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
   * ★ 分批第 19 批：「过程」那一格里的**子 tab**。
   *
   * 使用者："过程分成草稿过程和审核过程，分 2 tab 页显示"——原来那三块（审核问题清单、
   * 审核日志、起草 run）竖着摞在同一个 `process-pane` 里：想看"起草者当时怎么写的"得先
   * 划过一整份审核日志，反过来也一样。
   *
   * 默认停哪一格：**有审核（在跑/跑过/有判决）⇒ 审核过程，否则草稿过程**。
   * 为什么不是"永远停在草稿过程"：点「开始审核」会自动切到「过程」那一格——如果子 tab
   * 还停在草稿过程，人落回起草日志、看不到任何审核输出，正好回到第 ③ 批那条
   * "审核的过程看不到，感觉一直没结束"的老毛病。反过来，从来没审过还停在审核过程，
   * 那一格是空的（一句"还没审过"），也不对。
   */
  let processTab: 'draft' | 'audit' = 'draft'
  /** 使用者自己点过子 tab 没有——点过就不再被"读回结论"时的默认规则改掉他的选择。 */
  let processTabTouched = false
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
  /**
   * 起草审核的结论（§10.5 第 ⑤ 步：界面上要看到"审核说了什么"）。
   *
   * `null` = 还没读回来（= 面板还在加载）；`review === null` = **还没审过** ——
   * 这两件事必须分开：把"没审过"画成"不通过"，人会去改一份根本没被审过的稿子。
   */
  let reviewInfo: DraftReviewInfo | null = null
  let reviewBusy = false
  /** 「停止循环」正在发请求（防连点：它要写文件 + 可能取消一条 run）。 */
  let loopBusy = false
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
   * 结论条的标记（一个字符说清"能不能入库"）：
   * `✗` 草稿自己不过校验（它**先**挡住入库，比审核结论更要紧）；否则看审核结论；
   * 没有审核结论时是 `○`——"还没审过"既不是通过也不是被否，画 ✓ 或 ✗ 都是撒谎。
   */
  $: conclusionMark =
    artifacts === null || !artifacts.validation.ok
      ? '✗'
      : reviewInfo?.review
        ? (reviewInfo.review.conclusion === 'pass' ? '✓' : '✗')
        : '○'
  $: conclusionBad = conclusionMark === '✗'

  /** 步骤条三态：done / current / bad / pending（按 step 与起草终态推）。 */
  $: stepStates = (() => {
    const idx = step === 'target' ? 0 : step === 'drafting' ? 1 : step === 'review' ? 2 : 3
    const out: Array<'done' | 'current' | 'bad' | 'pending'> = []
    for (let n = 1; n <= 3; n += 1) {
      if (step === 'done') out.push('done')
      else if (n < idx + 1) out.push('done')
      else if (n === idx + 1)
        out.push(n === 2 && (draftStatus === 'failed' || draftStatus === 'cancelled') ? 'bad' : 'current')
      else out.push('pending')
    }
    return out
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
   * 审核 run 还在跑吗。
   *
   * ⚠️ 判据是**状态**，不是"有没有判决"：判决只在收口那一刻落库，而 run 可能失败、
   *    可能跑完却没留下判决。原来这里只判 `review === null`，于是**任何**非正常收尾
   *    都永远显示"审核中…（跑完再看这里）"——使用者的原话正是"感觉一直没结束呢"。
   */
  /**
   * 结论条的判定（在跑 / 收尾没判决 / 没跑成 / 有判决）**整块交给纯函数**。
   *
   * ⚠️ 原来这几条 `$:` 就写在这里，于是它错了一次没人发现：点「反馈」后新一版审核刚起，
   *    界面报的却是"审核跑完了……这一步等于白跑"（缓存里留着上一版的终态）。
   *    写进组件里的规则测不了（svelte-check 只管类型），拎到 `lib/audit-bar.ts` 才有单测
   *    钉住"上一版的终态不认"。见那个文件顶上的注释。
   */
  /**
   * 循环是不是**真的还在自己往下走**（决定要不要给「停止循环」）。
   *
   * ⚠️ 第一版只判 `autoRework.max > 1 && !stopped` ⇒ 探针量到"还没审核过"的草稿上也挂着
   *    一个「停止循环」按钮（`○ 还没审核过 · 3 个文件 · … 停止循环 开始审核`）。
   *    那不是"停止"而是"关掉设置"，而设置项在设置页里 —— 放在这里会让人以为
   *    点了它就能停掉一个并不存在的循环。
   */
  $: canStopLoop =
    reviewInfo?.autoRework !== undefined &&
    reviewInfo.autoRework.max > 1 &&
    !reviewInfo.autoRework.stopped &&
    reviewInfo.review === null &&
    (auditRunning || reviewInfo.autoRework.current > 1)

  $: auditBar = resolveAuditBar({
    live: auditLive,
    reviewRunId: reviewInfo?.reviewRunId ?? null,
    reviewRunStatus: reviewInfo?.reviewRunStatus ?? null,
    hasVerdict: reviewInfo !== null && reviewInfo.review !== null,
  })
  /** 徽标用的状态：事件流报过就用它，否则用接口快照。 */
  $: auditStatus = auditBar.status
  $: auditRunning = auditBar.running
  /** 审核 run 已经收尾（非进行中）——用来把"没跑成"与"还在跑"分开说。 */
  $: auditSettled = auditBar.settled
  /**
   * "跑完了但没留下判决"：run 是 `completed`，可是判决没有落库。
   *
   * ⚠️ 这一格必须与"还在跑"分开：它意味着**审核这一步白跑了**（判决不合规、收口时
   *    出错…），人得知道这件事，而不是继续等下去。
   */
  $: auditNoVerdict = auditBar.noVerdict

  $: auditFailedStuck =
    reviewInfo?.review?.conclusion === 'fail' && reviewInfo.review.status === 'escalated'

  $: canStart =
    targets !== null &&
    targets.materialStats !== null &&
    // ★ 任务场景的门槛（设计 §4.3）：有用户反馈 或 审核过才可沉淀。聊天场景无门槛。
    //   二轮只拦在「任务」页的按钮上；三轮导航页「新建沉淀」能选任意任务，门必须
    //   在流程页自己也拦一道（后端 draft 路由同样拦，见 server.ts 的 task_gate）。
    (targets.scope !== 'task' || targets.reviewed || targets.hasUserFeedback) &&
    // 新建不再要求「作用描述」（四轮定稿：留空则由 skill 从素材推断，审阅时确认）；
    // 更新仍然要求选一个目标技能。
    (targetKind === 'new' || selectedSkillId !== '')

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

  /** 状态徽标的字（共享词表，与任务详情的 run 徽标同一份）。 */
  function statusLabel(status: string): string {
    return $t(runStatusKey(status))
  }

  async function loadTargets(): Promise<void> {
    loading = true
    error = ''
    try {
      targets = await api<CrystallizeTargets>(
        `/api/crystallize/targets?runId=${encodeURIComponent(runId)}`,
      )
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
    artifacts = null
    selectedFile = 'SKILL.md'
    editText = ''
    filesVersion = 0
    diff = null
    diffAgainst = 'current'
    material = null
    materialPick = ''
    reviewTab = 'content'
    reviewSection = 'draft'
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

  /** 「继续」挂回进行中的起草（§4.1.1）。 */
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
      void loadReview()
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

  /** 「新起草」= 放弃旧的（还在跑就停掉），留在目标态。 */
  function newDraft(): void {
    const ad = targets?.activeDraft
    attached = true
    if (ad && !['completed', 'failed', 'cancelled'].includes(ad.status)) {
      void api(`/api/runs/${ad.runId}/cancel`, { method: 'POST' }).catch(() => {})
    }
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
      const res = await api<{ draftRunId: string; materialStats: { turns: number; toolCalls: number } }>(
        '/api/crystallize/draft',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            runId,
            target,
            ...(userFeedback.trim() !== '' ? { userFeedback: userFeedback.trim() } : {}),
          }),
        },
      )
      draftRunId = res.draftRunId
      materialStats = res.materialStats
      draftStatus = null
      draftFailedReason = ''
      handledTerminal = false
      step = 'drafting'
      // 新起草一律从「产出」开始：跑起来的时候实时输出是唯一的信息（依据是"回头再看"的）
      draftTab = 'run'
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
      void loadReview()
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
      if (res.target?.kind === 'update') {
        targetKind = 'update'
        selectedSkillId = res.target.skillId
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
    reviewSection = 'draft'
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
  async function loadReview(): Promise<void> {
    if (draftRunId === '') return
    try {
      reviewInfo = await api<DraftReviewInfo>(
        `/api/crystallize/review?draftRunId=${encodeURIComponent(draftRunId)}`,
      )
      // 默认子 tab：有审核（在跑 / 跑过 / 有判决）就停在审核过程。手动点过就不动它。
      if (!processTabTouched) {
        processTab =
          reviewInfo.review !== null || reviewInfo.reviewRunId !== null ? 'audit' : 'draft'
      }
    } catch {
      // 读不到就如实留空（面板会显示"还没审过"）——**不要**把失败画成"通过"
      reviewInfo = null
    }
  }

  /**
   * 取消正在跑的审核 run（2026-10-21 使用者："感觉一直没结束呢"）。
   *
   * ⚠️ 必须 try/catch：取消失败（run 已经收尾、网络断了）时裸 await 会变成
   *    **unhandled rejection** —— 界面上什么都不发生，使用者只会反复点。这条纪律
   *    来自任务页 `cancelRun` 的一次真实踩坑，这里照抄。
   */
  /**
   * 审核 run 收尾时的统一动作：**把实时状态设成终态，再重读判决**。
   *
   * ⚠️ 这里必须动实时状态，不能只 `loadReview()`：徽标优先用实时状态（见它的注释），
   *    如果收尾时只刷新接口快照而实时状态还停在 `running`，`auditRunning` 就永远为真
   *    ——界面上表现为"取消了，但它还在说审核正在进行"，一个按钮按下去**界面纹丝不动**。
   *    这是我自己改出来的缺陷，探针当场量到了（`crystal.auditAfterCancelStillRunning` 实测 true）。
   */
  async function onAuditTerminal(status: string): Promise<void> {
    // 连着 runId 记（见 `auditLive` 的注释）：收尾事件说的永远是"这条 run"的终态，
    // 记到别的 runId 上就等于凭空造一个终态出来。
    const runId = reviewInfo?.reviewRunId ?? null
    auditLive = runId === null ? null : { runId, status }
    await loadReview()
  }

  /**
   * 停止自动循环（分批第 23 批）。
   *
   * 两件事一起做：**落标记**（下一轮不再自动起草）+ **取消正在跑的审核**
   * （否则人点完还得等这一轮跑完，几分钟、真金白银）。
   * 与 `cancelAudit` 分开：那个只停"这一次 run"，循环还会继续。
   */
  async function stopLoop(): Promise<void> {
    if (draftRunId === '' || loopBusy) return
    loopBusy = true
    try {
      await api('/api/crystallize/stop-loop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId }),
      })
      await loadReview()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loopBusy = false
    }
  }

  async function cancelAudit(): Promise<void> {
    const id = reviewInfo?.reviewRunId
    if (id === null || id === undefined || id === '') return
    error = ''
    try {
      await api(`/api/runs/${id}/cancel`, { method: 'POST' })
      await loadReview()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * 起一条起草审核 run（§10.5 第 ②.5 步）。
   *
   * 审核是**预筛**，不是入库的门：它给结论，入库仍然由人点。所以这里只负责起 run 与
   * 把结论读回来；失败时如实报错，**不自动入库**。
   */
  async function startAudit(): Promise<void> {
    if (draftRunId === '' || reviewBusy) return
    reviewBusy = true
    // ★ 2026-10-21（第 3 批）：日志住在「过程」tab 里，所以**点开始审核就切过去**——
    //   否则人会停在"草稿"上，看不到任何输出，正好回到第 ① 条那个毛病（"感觉一直没结束"）。
    reviewSection = 'process'
    // ★ 第 19 批：子 tab 也必须跟到**审核过程**——只切外层的话人落回"草稿过程"那一格，
    //   看到的还是起草日志、审核输出一个字都没有（见 `processTab` 的注释）。
    processTab = 'audit'
    processTabTouched = true
    // 新的一条 run：上一条的实时状态必须丢掉，否则徽标会带着旧状态开始。
    // （⚠️ 光靠这句是不够的——「反馈」那条路不经过这里。真正兜住的是 `auditLive` 的
    //   runId 比对：对不上一律不采信。这句只是让状态干净一点。）
    auditLive = null
    error = ''
    try {
      await api<{ reviewRunId: string }>('/api/crystallize/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId }),
      })
      // 审核 run 是异步的：先读一次（多半还没判决），面板会显示"审核中"。
      // 之后由「刷新」或再次进入审阅时读到判决 —— 这里不装轮询：
      // 一条审核 run 可能跑几分钟，前端轮询只会让"看起来在动"变成假象。
      await loadReview()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      reviewBusy = false
    }
  }

  /**
   * 上次**自动填**进去的那段话（分批第 12 批）。
   *
   * 用来判断"框里现在这段是不是我们填的"：是 ⇒ 可以随判决更新；不是（人改过）⇒ **一个字都不动**。
   * 界面替人改过的字，比界面少填一点严重得多。
   */
  let lastAutoFill = ''

  /**
   * 审核者的反馈整理成意见框里的默认内容（`fail` 才有意义，其它一律返回空串 ⇒ 不填）。
   *
   * 拼法在 `lib/crystallize-feedback.ts`（纯函数 + 单测）：**位置与原文都要有**——只有结论没有
   * 位置的清单，起草者只能猜着改，而猜错的表现是"改完了问题还在"。
   */
  function feedbackFromReview(): string {
    const r = reviewInfo?.review
    if (!r || r.conclusion !== 'fail') return ''
    return buildFeedbackDraft(r.reasonCode, r.findings, {
      intro: (code) => $t('crystallize.feedbackIntro', { code }),
      where: $t('crystallize.feedbackWhere'),
      quote: $t('crystallize.feedbackQuote'),
      noEvidence: $t('crystallize.feedbackNoEvidence'),
      emptyFindings: $t('crystallize.feedbackEmptyFindings'),
      outro: $t('crystallize.feedbackOutro'),
    })
  }

  /**
   * 开/收「按意见改一版」的意见框。
   *
   * ★★ 开的时候**默认就把审核者的反馈填好**（分批第 12 批，使用者第二次纠正过的形状）。
   *
   * 这一块改过两版，两版都错在同一个地方——**多要了人一次点击**：
   *   ① 最早：点了「按意见重新起草」就**直接提交**（人连要发出去的话都没看见，更不能改）；
   *   ② 第一版修正：把这个按钮改成"只填不提交"（还改了名）——但人还是得先点它、
   *      再点「按意见再改一版」才看得到框里的东西，而使用者的预期是一句话说完的：
   *      「我期待意见框里面默认填充了审核者的反馈」。**打开框就该已经有内容**，
   *      那就不需要一个专门用来"填"的按钮了（同一个动作两个入口，迟早两边不一样）。
   *
   * ⚠️ 人改过的字**一个字都不覆盖**：只有框里是空的、或者还是我们上次填的那段，才跟着判决更新。
   */
  async function toggleReviseBox(): Promise<void> {
    reviseOpen = !reviseOpen
    if (!reviseOpen) return
    const filled = feedbackFromReview()
    if (filled !== '' && (reviseFeedback.trim() === '' || reviseFeedback === lastAutoFill)) {
      reviseFeedback = filled
      lastAutoFill = filled
    }
    // 光标落在框里：人点开这个框就是要改意见（而不是只看看）
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
      // 结论条上的"已过期"由服务端算 ⇒ 保存完重读一次审核信息（这一屏的判据都从它来）
      await loadReview()
      void loadDiff()
      showToast($t('crystallize.saveDraftDone'))
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      savingDraft = false
    }
  }

  /** 按意见再起草一版：新 run 复用同一份素材 + 把上一版产出放进 material/previous-draft/。 */
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
              <button
                type="button"
                class="ghost small"
                style="margin-left:var(--sp-3)"
                onclick={() => (draftLogOpen = !draftLogOpen)}
              >
                {draftLogOpen ? $t('tasks.showFinalResult') : $t('tasks.showRawLog')}
              </button>
            </h3>
            {#if draftLogOpen}
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
  {/snippet}

  {#snippet actions()}
    {#if step === 'target'}
      <button
        class="primary"
        disabled={!canStart || loading}
        title={startDisabledReason}
        onclick={() => void startDraft()}
      >
        {$t('crystallize.start')}
      </button>
    {:else if step === 'drafting'}
      {#if draftStatus === 'failed' || draftStatus === 'cancelled'}
        <button class="primary" onclick={retryDraft}>{$t('crystallize.retryDraft')}</button>
      {:else}
        <button class="ghost" onclick={() => void stopDraft()}>{$t('chat.stop')}</button>
      {/if}
    {:else if step === 'review'}
      <button class="ghost" onclick={() => void abandonReview()}>{$t('crystallize.abandon')}</button>
      <button class="primary" disabled={saving || !reviewValid} onclick={() => void save()}>
        {$t('crystallize.confirm')}
      </button>
    {/if}
  {/snippet}

  {#snippet body()}
    <div class="crystal-flow">
      <!--
        ── 步骤条：① 沉淀目标 → ② 起草 run → ③ 审阅入库 ──

        ⚠️ 2026-10-21 从 4 步改回 3 步：中间那一步「审核」撤掉了。
        理由正是使用者自己说的那个心理效果——「审核」**不是入库的门**（结论只是预筛，
        入库永远由人点），可一旦画成"第 3 步"，人就会以为必须等它；它跑着、或者跑挂了，
        看起来就是"卡在第三步不动"（他的原话："审核的过程看不到，感觉一直没结束呢"）。
        现在审核是**审阅屏里的一个动作**（结论条：开始审核 / 看日志 / 重试）、
        与「按意见重新起草」同级：随时可用、不挡入库。
      -->
      <ol class="crystal-steps" aria-label="流程步骤">
        <li class={stepStates[0]}>
          <span class="step-no" aria-hidden="true">{stepStates[0] === 'done' ? '✓' : 1}</span>
          <span class="step-label">{$t('crystallize.stepTarget')}</span>
        </li>
        <li class={stepStates[1]}>
          <span class="step-no" aria-hidden="true">{stepStates[1] === 'done' ? '✓' : 2}</span>
          <span class="step-label">{$t('crystallize.stepDraft')}</span>
        </li>
        <li class={stepStates[2]}>
          <span class="step-no" aria-hidden="true">{stepStates[2] === 'done' ? '✓' : 3}</span>
          <span class="step-label">{$t('crystallize.stepReview')}</span>
        </li>
      </ol>

      {#if error && targets === null}
        <div class="notice bad crystal-notice">{error}</div>
      {/if}

      <!-- ── 恢复进行中的起草（§4.1.1）：继续 / 新起草 ── -->
      {#if targets?.activeDraft && !attached && step === 'target' && !loading}
        <div class="notice resume">
          <div class="resume-text">
            <strong>
              {$t('crystallize.resumeNotice', {
                status: $t(crystallizeStateKey(crystallizeState(targets.activeDraft.status))),
              })}
            </strong>
            <span class="faint small">run {targets.activeDraft.runId.slice(0, 4)}…</span>
          </div>
          <div class="resume-actions">
            <button class="primary small" onclick={resumeDraft}>{$t('crystallize.resumeContinue')}</button>
            <button class="ghost small" onclick={newDraft}>{$t('crystallize.resumeNew')}</button>
          </div>
        </div>
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
      <section class="drawer-section">
        <h3><span>{$t('crystallize.stepTarget')}</span></h3>
        <div class="section-body">
        {#if step === 'target'}
          {#if targets === null}
            <div class="skeleton" style="height:1.1rem"></div>
          {:else}
            <!-- 两个目标选项做成一张"卡片列表"：选中项底色高亮、分隔线分明——
                 不用裸 radio 漂浮在空白上（裸 radio 会被全局 input 样式撑成
                 通栏宽、还带边框和 padding，见本文件底部 .radio-row 的 reset）。 -->
            <div class="option-group">
              <label class="radio-row">
                <input type="radio" bind:group={targetKind} value="new" />
                <span class="opt-text">
                  <strong>{$t('crystallize.targetNew')}</strong>
                  <span class="faint small">{$t('crystallize.purposeHint')}</span>
                </span>
              </label>
              {#if targetKind === 'new'}
                <div class="sub-field">
                  <label class="field-inner">
                    <span class="faint small">{$t('crystallize.purposeLabel')}</span>
                    <textarea
                      bind:value={purpose}
                      rows="2"
                      placeholder={$t('crystallize.purposePlaceholder')}
                    ></textarea>
                  </label>
                </div>
              {/if}
              <label class="radio-row" class:disabled={targets.loadedSkills.length === 0}>
                <input
                  type="radio"
                  bind:group={targetKind}
                  value="update"
                  disabled={targets.loadedSkills.length === 0}
                />
                <span class="opt-text">
                  <strong>{$t('crystallize.targetUpdate')}</strong>
                  <span class="faint small">{$t('crystallize.targetUpdateHint')}</span>
                </span>
              </label>
            </div>
            {#if targetKind === 'update'}
              {#if targets.loadedSkills.length === 0}
                <p class="notice">{ $t('crystallize.noLoadedSkills') }</p>
              {:else}
                {@const picked = targets.loadedSkills.find((x) => x.id === selectedSkillId)}
                <div class="skill-list">
                  {#each targets.loadedSkills as s (s.id)}
                    <label class="skill-row">
                      <input type="radio" bind:group={selectedSkillId} value={s.id} />
                      <span class="skill-info">
                        <span class="skill-head">
                          <code>{s.slug}</code>
                          <span class="badge" class:mine={s.source === 'mine'}>
                            {s.source === 'mine' ? $t('crystallize.badgeMine') : $t('crystallize.badgeInstalled')}
                          </span>
                        </span>
                        {#if s.description}
                          <span class="faint small">{s.description}</span>
                        {/if}
                      </span>
                    </label>
                  {/each}
                </div>
                <p class="faint small">
                  {picked?.source === 'mine'
                    ? $t('crystallize.updateIsEvolve')
                    : $t('crystallize.updateIsShadow')}
                </p>
              {/if}
            {/if}

            {#if targets.scope === 'task'}
              <label class="field">
                <span class="faint small">{$t('crystallize.userFeedbackLabel')}</span>
                <textarea
                  bind:value={userFeedback}
                  rows="2"
                  placeholder={$t('crystallize.userFeedbackPlaceholder')}
                ></textarea>
              </label>
            {/if}
          {/if}
        {:else}
          <!-- 只读摘要：目标已定（恢复的草稿按落库的目标还原） -->
          <p class="faint">
            {#if targetKind === 'new'}
              {$t('crystallize.targetNew')}
              {#if purpose.trim() !== ''}· {purpose.trim()}{/if}
            {:else}
              {$t('crystallize.targetUpdate')} · {skillNameFor(selectedSkillId)}
            {/if}
          </p>
        {/if}
        </div>
      </section>
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
      {#if step === 'review'}
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
        <section class="conclusion-block">
          <div class="conclusion-bar" class:bad={conclusionBad}>
            <span class="bar-mark" aria-hidden="true">{conclusionMark}</span>
            <span class="bar-text">
              {#if reviewInfo === null}
                <span class="muted">…</span>
              {:else if reviewInfo.review === null && auditRunning}
                <strong>{$t('crystallize.auditRunningShort')}</strong>
                <span class="badge {runStatusClass(auditStatus ?? '')}">
                  {statusLabel(auditStatus ?? '')}
                </span>
                <span class="muted">run {reviewInfo.reviewRunId?.slice(0, 4) ?? ''}…</span>
              {:else if reviewInfo.review === null && auditSettled}
                <strong>
                  {auditNoVerdict
                    ? $t('crystallize.auditNoVerdict')
                    : $t('crystallize.auditRunFailed', { status: statusLabel(auditStatus ?? '') })}
                </strong>
              {:else if reviewInfo.review === null}
                <!--
                  ★ "还没审核过"：原来这里是一整段说明（"审核是一个内置智能体按'能不能用'
                    过一遍，给出结论与问题清单；它不替你做入库决定"，42px 两行）。按确认的
                    设计，说明收进**按钮的悬停提示**，条上只留四个字。
                -->
                <strong title={$t('crystallize.auditNotYet')}
                  >{$t('crystallize.auditNotYetBrief')}</strong
                >
              {:else}
                <strong>
                  {reviewInfo.review.conclusion === 'pass'
                    ? $t('crystallize.auditPass')
                    : reviewInfo.review.conclusion === 'fail'
                      ? $t('crystallize.auditFail')
                      : $t('crystallize.auditNeedsHuman')}
                </strong>
                <!-- "（预筛）"留着：它说的是"这不是入库的门"，是这条链的前提，不是修饰 -->
                <span class="faint small">（{$t('crystallize.auditPrescreen')}）</span>
                {#if reviewInfo.autoRework && reviewInfo.autoRework.max > 0}
                  <span class="muted small">
                    {$t('crystallize.autoReworkRound', {
                      current: String(reviewInfo.autoRework.current),
                      max: String(reviewInfo.autoRework.max),
                    })}{$t('crystallize.autoReworkSpent', {
                      usd: (reviewInfo.autoRework.spentUsdMicros / 1e6).toFixed(2),
                    })}{reviewInfo.autoRework.stopped ? $t('crystallize.autoReworkStopped') : ''}
                  </span>
                {/if}
                {#if reviewInfo.autoRework?.stalled?.[0]}
                  <!--
                    ★ 分批第 23 批：「没进展」只**标注**、不停（使用者的选择）。
                    同一处（locator）在相邻两轮判决里都被点名 ⇒ 说明起草者改不动它，
                    这件事值得人看一眼；但产品不替人决定"到此为止"。
                  -->
                  <span class="hint small" data-auto-rework-stalled>
                    {$t('crystallize.autoReworkStalled', {
                      rounds: String(reviewInfo.autoRework.stalled[0].rounds),
                      locator: reviewInfo.autoRework.stalled[0].locator,
                    })}
                  </span>
                {/if}
                <span class="muted">{reviewInfo.review.reasonCode}</span>
                {#if reviewInfo.review.status === 'rework_requested'}
                  <span class="muted">
                    {$t('crystallize.auditReworked', { n: String(reviewInfo.versions) })}
                  </span>
                {:else if auditFailedStuck}
                  <span class="muted">{$t('crystallize.auditExhausted')}</span>
                {/if}
              {/if}
              <!--
                ★ 分批第 8 批：「这个结论是改之前的」。
                判据在服务端（审核时钉下的指纹 vs 此刻磁盘内容），界面只负责**说出来**：
                一个过期的结论如果安静地留在那儿，人就会照它决定入库。
              -->
              {#if reviewInfo?.stale === true}
                <span class="bar-sep">·</span>
                <span class="stale-tag">{$t('crystallize.auditStale')}</span>
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
              {#if reviewInfo?.review && reviewInfo.review.findings.length > 0}
                <!-- ⚠️ 分批第 19 批：这两个出口原来只切外层 tab（那时过程里只有一格）；
                     劈成两个子 tab 之后必须**一起**把子 tab 指到审核过程，否则点了「看 N 条问题」
                     会落到"草稿过程"、什么问题都看不到——一个出口指向别处，比没有出口更坏。 -->
                <button
                  class="ghost small"
                  onclick={() => {
                    reviewSection = 'process'
                    processTab = 'audit'
                    processTabTouched = true
                  }}
                >
                  {$t('crystallize.auditShowDetail', {
                    n: String(reviewInfo.review.findings.length),
                  })}
                </button>
              {/if}
              {#if reviewInfo?.review}
                <button
                  type="button"
                  class="ghost small"
                  onclick={() => {
                    reviewSection = 'process'
                    processTab = 'audit'
                    processTabTouched = true
                  }}
                >
                  {$t('crystallize.auditShowLog')}
                </button>
              {/if}
              {#if canStopLoop}
                <!--
                  ★ 分批第 23 批：循环进行中唯一的人工入口（使用者定的口径）。
                  「停止循环」与「取消审核」是两件事：后者只停这一次 run，
                  循环下一轮还会自动起草；前者是真的叫停整条自动流程。
                -->
                <button
                  class="ghost small"
                  disabled={loopBusy}
                  title={$t('crystallize.autoReworkStopHint')}
                  onclick={() => void stopLoop()}
                >
                  {$t('crystallize.autoReworkStop')}
                </button>
              {/if}
              {#if reviewInfo !== null && reviewInfo.review === null && auditRunning}
                <button class="ghost small" onclick={() => void cancelAudit()}>
                  {$t('crystallize.auditCancel')}
                </button>
              {:else if reviewInfo !== null && reviewInfo.review === null}
                <button
                  class="ghost small"
                  disabled={reviewBusy}
                  title={$t('crystallize.auditNotYet')}
                  onclick={() => void startAudit()}
                >
                  {auditSettled ? $t('crystallize.auditRetry') : $t('crystallize.auditStart')}
                </button>
              {/if}
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
              <!--
                ★ 分批第 8 批：「重新审核」。
                原来这个按钮只在**还没判决**时出现（`review === null`）⇒ 一旦审出结论，
                同一版再也审不了。现在改成"只要有判决就能再审"：改完草稿要它算数、
                或只是想让审核者再看一遍，都走这里。
                ⚠️ 不自动重审：真机一轮审核 ≈ $1.32，这笔钱由人决定（自动返工那条链另算）。
              -->
              {#if reviewInfo?.review !== null && reviewInfo !== null}
                <button
                  class="ghost small"
                  disabled={reviewBusy || dirty}
                  title={dirty ? $t('crystallize.auditRetryNeedsSave') : $t('crystallize.auditNotYet')}
                  onclick={() => void startAudit()}
                >{$t('crystallize.auditRetry')}</button>
              {/if}
              {#if artifacts}
                <!-- ★ 点它 ⇒ 意见框打开，里面**默认已经填好**审核者的反馈（见 `toggleReviseBox`）。 -->
                <button
                  class="ghost small"
                  class:active={reviseOpen}
                  onclick={() => void toggleReviseBox()}
                >{$t('crystallize.reviseTitle')}</button>
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

          <!--
            ⚠️ 2026-10-21（第 3 批）：这里原来还有两样——**审核日志**（跑着的时候铺开）
               与**问题清单**（折起来）。它们搬进了「过程」tab（见下面的 `process-pane`）：
               这一块的常驻纪律是"一行结论 + 一行入库信息"，日志和问题清单都属于"要看过程
               才看"的东西。跑起来时界面会**自动切到过程 tab**（`startAudit()` 里改），
               所以第 ① 条"审核的过程看不到"不会被这次搬家推翻。
          -->

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
                {#if lastAutoFill !== '' && reviseFeedback === lastAutoFill}
                  <span class="faint small">{$t('crystallize.revisePrefilledHint')}</span>
                {/if}
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
          <div class="review-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={reviewSection === 'draft'}
              class:tabs-active={reviewSection === 'draft'}
              onclick={() => (reviewSection = 'draft')}
            >{$t('crystallize.tabDraft')}</button>
            <button
              type="button"
              role="tab"
              aria-selected={reviewSection === 'evidence'}
              class:tabs-active={reviewSection === 'evidence'}
              onclick={() => (reviewSection = 'evidence')}
            >{$t('crystallize.tabEvidence')}</button>
            <button
              type="button"
              role="tab"
              aria-selected={reviewSection === 'process'}
              class:tabs-active={reviewSection === 'process'}
              onclick={() => (reviewSection = 'process')}
            >
              {$t('crystallize.tabProcess')}
              {#if reviewInfo?.review && reviewInfo.review.findings.length > 0}
                <span class="tab-count">{reviewInfo.review.findings.length}</span>
              {:else if reviewInfo !== null && reviewInfo.review === null && auditRunning}
                <!-- 跑着的时候在 tab 上留一个点：人切到草稿去改字，也不会"忘了它还在跑" -->
                <span class="tab-dot" aria-hidden="true"></span>
              {/if}
            </button>
          </div>

          {#if reviewSection === 'draft'}
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

              {#if reviewTab === 'content'}
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
              {:else if diffLoading}
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

          <!--
            ⚠️ 2026-10-21 使用者："不需要「预览」" —— 这里原来有一段折叠的 Markdown 预览
               （`.preview`，20rem 高、还要往下滚）。删掉的理由不只是"多余"：
               审阅这一屏要动手的只有**编辑器**（② 差异在同一个窗格里切），而预览是
               同一份内容的**第二种渲染**——它离编辑器几百像素、还各自滚，读完预览
               再回去改一个字要来回跳。删掉之后这一屏只剩"改 / 比"两件事。
               （`.preview` 的 CSS 与 `renderMarkdown` 的 import 一并删了——留着就是死代码，
               本仓库最防的就是"东西都在、就是没有路径让它发生"。）
          -->
          {:else if reviewSection === 'evidence'}
            <!-- ── 依据：起草者读过的素材（只读）。原来折在编辑器下面 y≈842 处 ── -->
            <div class="file-pane evidence-pane">
              <div class="evi-head">
                <code>material/</code>
                <span class="grow faint small">{$t('crystallize.evidenceHead')}</span>
                {#if material !== null}
                  <span class="faint small">
                    {material.items.length} {$t('crystallize.filesUnit')} · {material.dirLabel}
                  </span>
                {/if}
              </div>
              {#if material === null}
                <div class="skeleton"></div>
              {:else}
                {@render materialPane()}
              {/if}
            </div>
          {:else}
            <!--
              ── 过程：怎么走到这一步的 ──
              审核问题清单（有判决时）+ 审核日志 + 起草 run（最后结果 / 完整日志 两态）。
              跑起来的时候界面会**自动切到这里**（见 `startAudit()`）——这一 tab 就是第 ① 条
              "审核的过程看不到"的落点。
            -->
            <!--
              ★ 分批第 19 批：格子里的两个子 tab（使用者："过程分成草稿过程和审核过程，分 2 tab 页显示"）。

              内容怎么分（按"谁产生的"分，不按时间顺序堆）：
                · 审核过程 = 审核问题清单（有判决时）+ 审核日志（含实时输出）；
                · 草稿过程 = 起草 run（最后结果 / 完整日志 两态）。
              ⚠️ 顺序上"草稿在前、审核在后"（事情就是按这个顺序发生的），但默认可能停在后者
                 （有审核时）——见 `processTab` 的注释。
            -->
            <div class="pane-tabs process-subtabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={processTab === 'draft'}
                class:tabs-active={processTab === 'draft'}
                onclick={() => {
                  processTab = 'draft'
                  processTabTouched = true
                }}
              >{$t('crystallize.tabProcessDraft')}</button>
              <button
                type="button"
                role="tab"
                aria-selected={processTab === 'audit'}
                class:tabs-active={processTab === 'audit'}
                onclick={() => {
                  processTab = 'audit'
                  processTabTouched = true
                }}
              >{$t('crystallize.tabProcessAudit')}</button>
            </div>

            {#if processTab === 'audit'}
            <div class="process-pane">
              {#if reviewInfo?.review && reviewInfo.review.conclusion === 'needs_human' && reviewInfo.review.escalateReason}
                <p class="muted">
                  {$t('crystallize.auditNotRun', { reason: reviewInfo.review.escalateReason })}
                </p>
              {/if}

              {#if reviewInfo?.review && reviewInfo.review.findings.length > 0}
                <div class="proc-block">
                  <div class="proc-head">{$t('crystallize.auditFindingsTitle')}</div>
                  <ul class="audit-findings">
                    {#each reviewInfo.review.findings as f}
                      <li>
                        <span class="sev">{f.severity}</span>
                        <span>{f.summary}</span>
                        {#each f.evidence as e}
                          {#if e.locator !== null || e.excerpt !== null}
                            <div class="muted audit-evidence">
                              {e.locator ?? ''}{e.excerpt === null ? '' : `：${e.excerpt}`}
                            </div>
                          {/if}
                        {/each}
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}

              {#if reviewInfo?.review || (reviewInfo !== null && (auditRunning || auditSettled))}
                <div class="proc-block">
                  <div class="proc-head">
                    {$t('crystallize.auditShowLog')}
                    {#if auditRunning}
                      <span class="badge {runStatusClass(auditStatus ?? '')}">
                        {statusLabel(auditStatus ?? '')}
                      </span>
                    {/if}
                  </div>
                  {#if auditRunning}
                    <p class="faint small">{$t('crystallize.auditRunning')}</p>
                  {/if}
                  {#if reviewInfo.reviewRunId !== null}
                    <div class="log-box">
                      <RunLog
                        runId={reviewInfo.reviewRunId ?? ''}
                        onterminal={(st) => void onAuditTerminal(st)}
                        onstatus={(st) =>
                          (auditLive =
                            reviewInfo?.reviewRunId === null ||
                            reviewInfo?.reviewRunId === undefined
                              ? null
                              : { runId: reviewInfo.reviewRunId, status: st })}
                      />
                    </div>
                  {/if}
                </div>
              {:else if reviewInfo !== null}
                <p class="faint small">{$t('crystallize.processNoAuditYet')}</p>
              {/if}
            </div>
            {:else}
            <!-- ── 草稿过程：起草那条 run（默认"最后结果"，一点换"完整日志"） ── -->
            <div class="process-pane">
              {#if draftRunId !== ''}
                {@render draftRunPane()}
              {/if}
            </div>
            {/if}
          {/if}
        {/if}
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
      {#if step === 'drafting'}
        <div class="review-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={draftTab === 'run'}
            class:tabs-active={draftTab === 'run'}
            onclick={() => (draftTab = 'run')}
          >{$t('crystallize.tabOutput')}</button>
          <button
            type="button"
            role="tab"
            aria-selected={draftTab === 'evidence'}
            class:tabs-active={draftTab === 'evidence'}
            onclick={() => (draftTab = 'evidence')}
          >{$t('crystallize.tabEvidence')}</button>
        </div>

        {#if draftTab === 'evidence'}
          <div class="process-pane">
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
      {/if}

      {#if draftRunId !== '' && step === 'drafting' && draftTab === 'run'}
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
              <p class="faint small">{$t('crystallize.drafting')}</p>
            {/if}
            <div class="log-box">
              <RunLog runId={draftRunId} onterminal={(st) => void onDraftTerminal(st)} />
            </div>
          </div>
        </section>
      {/if}

      <!-- ── 完成态：已沉淀 + git 状态 + 查看技能 ── -->
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
  {/snippet}
</MainArea>

<style>
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
  /* 这一条规则**故意不存在**：`.crystal-flow` 不留任何自己的样式——它铺满主区，
     间距由子块的 `.drawer-section` 下边距给（见上）。留一个空规则只会让下一个人
     以为"这里本该有点什么"。 */

  /* ══════════ 步骤条：圆点 + 连线（走过 = 着强调色；当前步高亮；完成打勾） ══════════ */
  .crystal-material-line {
    margin: 0 0 var(--sp-4);
  }
  .crystal-steps {
    display: flex;
    align-items: center;
    list-style: none;
    /* 分节靠 margin，步骤条同理：给下一块留出与分节之间一样的间距 */
    margin: 0 0 var(--sp-4);
    padding: 0;
    font-size: var(--fs-sm);
  }
  /*
   * ★ 2026-10-21：`flex: 1` 去掉了。原来每一步都 `flex:1`（连线也 `flex:1`），
   *   四个词就被拉到横跨 735px、间距还随字数变成 279/205/155——信息量只有四个词，
   *   却占了整行宽度、还把下面整体推低一档。现在步与步按内容排、连线定宽 2rem。
   */
  .crystal-steps li {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
    color: var(--text-faint);
  }
  /* 步与步之间的连线。只有"上一档已走完"才着强调色（走过的路）——当前步还没走完，
     它到下一步的那一段仍是虚的（与"建任务三步链"那套同一个语义）。 */
  .crystal-steps li + li::before {
    content: '';
    flex: 0 0 2rem;
    height: 2px;
    border-radius: 1px;
    background: var(--line);
    margin-left: var(--sp-1);
    margin-right: var(--sp-3);
  }
  .crystal-steps li.done + li::before {
    background: var(--accent);
  }
  .step-no {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    border-radius: 50%;
    border: 1.5px solid var(--line-strong);
    font-size: 0.8em;
    font-weight: 600;
    flex-shrink: 0;
  }
  .step-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .crystal-steps li.current {
    color: var(--text);
    font-weight: 600;
  }
  .crystal-steps li.current .step-no {
    border-color: var(--accent);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .crystal-steps li.done {
    color: var(--status-done);
  }
  .crystal-steps li.done .step-no {
    background: var(--status-done);
    border-color: var(--status-done);
    color: var(--bg);
  }
  .crystal-steps li.bad {
    color: var(--status-blocked);
  }
  .crystal-steps li.bad .step-no {
    background: var(--status-blocked);
    border-color: var(--status-blocked);
    color: var(--bg);
  }

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
    height: clamp(22rem, 58vh, 40rem);
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
    height: clamp(22rem, 58vh, 40rem);
    margin-top: var(--sp-1);
  }

  /* 素材折叠区里的那份不需要整屏高（`.fold-body` 在 FoldSection 组件内部，
     scoped 样式够不到，必须用 :global 打洞） */
  :global(.fold-body) .file-pane {
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
</style>
