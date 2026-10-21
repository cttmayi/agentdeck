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
  import { renderMarkdown } from '../lib/markdown.ts'
  import { go } from '../lib/view.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import { runStatusClass, runStatusKey } from '../lib/run-status.ts'
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
    /** 同一份来源素材上已经起草过几版（自动返工的轮次上限是 2）。 */
    versions: number
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
  /** 变更集 diff（后端算）：对当前已入库版本，或对比上一版草稿。 */
  let diff: DiffResult | null = null
  let diffLoading = false
  /** 对比对象：对当前版本（入库会产生的变化）或上一版草稿（改版对比）。 */
  let diffAgainst: 'current' | 'previous' = 'current'
  /** 素材分节（文件清单 + 预览）。 */
  let material: {
    dir: string
    /** 目录短名（只显示末两级，整条路径放进 title）——折叠行摘要里不能塞绝对路径。 */
    dirLabel: string
    items: Array<{ relPath: string; bytes: number; text: string; truncated: boolean }>
  } | null = null
  /** 主区窗格的分段：内容 / 差异（同一位置切换，见 markup 里的三条规矩）。 */
  let reviewTab: 'content' | 'diff' = 'content'
  /** 「按意见改一版」的输入框是否展开（不常驻，见结论条）。 */
  let reviseOpen = false
  /**
   * 起草审核的结论（§10.5 第 ⑤ 步：界面上要看到"审核说了什么"）。
   *
   * `null` = 还没读回来（= 面板还在加载）；`review === null` = **还没审过** ——
   * 这两件事必须分开：把"没审过"画成"不通过"，人会去改一份根本没被审过的稿子。
   */
  let reviewInfo: DraftReviewInfo | null = null
  let reviewBusy = false
  /** 问题清单是否展开（结论常驻、明细折叠，与全站其它地方同一条规矩）。 */
  let auditDetailOpen = false
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
    against: 'current' | 'previous'
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

  /**
   * 「审核」那一步的态：`done`（通过了）/ `bad`（不通过或无法判定）/ `current` / `pending`。
   *
   * ⚠️ `needs_human`（判决不合规）也画成 `bad`，不画成 `done`：那一步**没有通过**，
   *   而画成 ✓ 会让人以为"审核过了、可以入库了"。
   */
  $: auditState = (() => {
    if (reviewInfo?.review) {
      return reviewInfo.review.conclusion === 'pass' ? 'done' : 'bad'
    }
    if (reviewInfo?.reviewRunId) return 'current'
    return draftStatus === 'completed' ? 'current' : 'pending'
  })()

  /**
   * "不通过且**额度已用尽**"（判决状态是 `escalated`）——这是唯一该出现
   * 「重新起草 / 明知未通过仍入库」两个按钮的时刻。
   *
   * ⚠️ 与 `rework_requested` 分得清：那个状态表示**平台已经自动重新起草了一版**，
   *   这时再给"重新起草"按钮，等于把人又推进同一条自动流程（他刚看过的那一版已经作废）。
   */
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
      diffAgainst = res.revisedFrom !== null ? 'previous' : 'current'
      void loadDiff(diffAgainst)
      void loadMaterial()
      const first = pickDefaultFile(res)
      selectedFile = first
      editText = res.files[first] ?? ''
      filesVersion += 1
      clash = null
      error = ''
      step = 'review'
    } catch (err) {
      step = 'drafting'
      error = $t('crystallize.errTargets', { error: err instanceof Error ? err.message : String(err) })
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
   * （"按意见改一版"后新旧对比）。
   */
  async function loadDiff(against: 'current' | 'previous' = diffAgainst): Promise<void> {
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
    } catch {
      // 读不到就如实留空（面板会显示"还没审过"）——**不要**把失败画成"通过"
      reviewInfo = null
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
   * 审核额度用尽后的「按意见重新起草」：把审核意见**原文**填进"按意见改一版"的输入框，
   * 再走那条现成的路（同一份素材、同一条链、同一套落盘规则）。
   *
   * 为什么不另写一份提交：那是同一个动作的两种实现，迟早分叉 —— 而使用者只会看到
   * "自动返工改的那版"与"我点的那版"结果不一样。
   */
  async function redraftFromAudit(): Promise<void> {
    const r = reviewInfo?.review
    if (!r) return
    reviseFeedback = [
      `审核不通过（理由码：${r.reasonCode}）。请按下面每一条改：`,
      ...r.findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.summary}`),
    ].join('\n')
    await reviseDraft()
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

<MainArea
  headClass="detail-head"
  backLabel={backLabel}
  onBack={onback}
  title={$t('crystallize.title')}
  bodyClass="detail-scroll"
>
  {#snippet sub()}
    <span class="faint">
      {sourceLabel} · {runId.slice(0, 8)}…{statsLine !== '' ? ` · ${statsLine}` : ''}
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
      <!-- ── 步骤条：① 沉淀目标 → ② 起草 run → ③ 审阅入库 ── -->
      <ol class="crystal-steps" aria-label="流程步骤">
        <li class={stepStates[0]}>
          <span class="step-no" aria-hidden="true">{stepStates[0] === 'done' ? '✓' : 1}</span>
          <span class="step-label">{$t('crystallize.stepTarget')}</span>
        </li>
        <li class={stepStates[1]}>
          <span class="step-no" aria-hidden="true">{stepStates[1] === 'done' ? '✓' : 2}</span>
          <span class="step-label">{$t('crystallize.stepDraft')}</span>
        </li>
        <!--
          「审核」是 §10.5 新加的一步（②.5）：起草完之后由**内置审核者**先过一遍。
          ⚠️ 它**不是入库的门**：结论是"预筛"，入库仍然由人点（评审在人是这条链的前提）。
        -->
        <li class={auditState}>
          <span class="step-no" aria-hidden="true">{auditState === 'done' ? '✓' : 3}</span>
          <span class="step-label">{$t('crystallize.stepAudit')}</span>
        </li>
        <li class={stepStates[2]}>
          <span class="step-no" aria-hidden="true">{stepStates[2] === 'done' ? '✓' : 4}</span>
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

      <!-- ── 素材摘要：只在目标态显示——那是"能不能开始"的判据。
             起草/审阅态有「素材」折叠分节（同一件事的可展开版本），
             两处都常驻就是白占高度（实测 87px）。── -->
      {#if step === 'target'}
      <section class="drawer-section">
        <h3>{$t('crystallize.materialSection')}</h3>
        <div class="section-body">
          {#if loading}
            <div class="skeleton" style="height:1.1rem"></div>
          {:else if targets}
            {#if targets.materialStats}
              <p class="faint">
                {$t('crystallize.materialSummary', {
                  turns: String(targets.materialStats.turns),
                  tools: String(targets.materialStats.toolCalls),
                })}
                · {targets.scope === 'conversation'
                  ? $t('crystallize.scopeConversation')
                  : $t('crystallize.scopeTask')}
                {#if targets.scope === 'task'}
                  · {targets.reviewed ? $t('crystallize.reviewedYes') : $t('crystallize.reviewedNo')}
                  · {$t('crystallize.feedbackNo')}
                {/if}
              </p>
            {:else}
              <div class="notice bad small">{ $t('crystallize.noMaterial') }</div>
            {/if}
          {/if}
        </div>
      </section>
      {/if}

      <!-- ── 沉淀目标：目标/起草态可编辑；审阅态并入结论条（那一行已经写了
             "更新 release-check"，再单占 68px 就是重复）── -->
      {#if step !== 'review'}
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
          ── 审核结论（§10.5 第 ⑤ 步）──
          三条规矩：① 结论常驻（一行）+ 问题清单折叠 ② "还没审过"与"审过但没判决"分开说
          ③ 不通过且额度用尽时才给「重新起草」按钮（自动返工还在跑时不该出现）。
        -->
        <section class="drawer-section audit-block">
          <h3>{$t('crystallize.auditTitle')}</h3>
          {#if reviewInfo === null}
            <p class="muted">…</p>
          {:else if reviewInfo.review === null}
            <div class="notice">
              <p>{$t('crystallize.auditNotYet')}</p>
              {#if reviewInfo.reviewRunId !== null}
                <p class="muted">{$t('crystallize.auditRunning')}</p>
              {/if}
              <div class="row-end">
                <button class="ghost small" disabled={reviewBusy} onclick={() => void startAudit()}>
                  {$t('crystallize.auditStart')}
                </button>
                <button class="ghost small" onclick={() => void loadReview()}>
                  {$t('crystallize.auditRefresh')}
                </button>
              </div>
            </div>
          {:else}
            <div
              class="review-bar"
              class:bad={reviewInfo.review.conclusion !== 'pass'}
            >
              <span class="bar-mark" aria-hidden="true">
                {reviewInfo.review.conclusion === 'pass' ? '✓' : '✗'}
              </span>
              <span class="bar-text">
                <strong>
                  {reviewInfo.review.conclusion === 'pass'
                    ? $t('crystallize.auditPass')
                    : reviewInfo.review.conclusion === 'fail'
                      ? $t('crystallize.auditFail')
                      : $t('crystallize.auditNeedsHuman')}
                </strong>
                <span class="muted">{reviewInfo.review.reasonCode}</span>
                {#if reviewInfo.review.status === 'rework_requested'}
                  <span class="muted">
                    {$t('crystallize.auditReworked', { n: String(reviewInfo.versions) })}
                  </span>
                {:else if auditFailedStuck}
                  <span class="muted">{$t('crystallize.auditExhausted')}</span>
                {/if}
              </span>
              {#if reviewInfo.review.findings.length > 0}
                <button
                  class="ghost small"
                  onclick={() => (auditDetailOpen = !auditDetailOpen)}
                >
                  {auditDetailOpen
                    ? $t('crystallize.auditHideDetail')
                    : $t('crystallize.auditShowDetail', {
                        n: String(reviewInfo.review.findings.length),
                      })}
                </button>
              {/if}
            </div>
            {#if reviewInfo.review.conclusion === 'needs_human' && reviewInfo.review.escalateReason}
              <p class="muted">
                {$t('crystallize.auditNotRun', { reason: reviewInfo.review.escalateReason })}
              </p>
            {/if}
            {#if auditDetailOpen}
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
            {/if}
            {#if auditFailedStuck}
              <div class="row-end">
                <button class="ghost small" onclick={() => void redraftFromAudit()}>
                  {$t('crystallize.auditRedraft')}
                </button>
              </div>
            {/if}
          {/if}
        </section>

        <!-- 起草者判定"不可沉淀"：这是结论，不是失败——只给重新起草 / 放弃 -->
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
        {:else if artifacts}
          <!-- ── 结论条：一行说完"能不能入库 / 改了什么 / 目标是谁" ── -->
          <section class="review-bar-block">
            <div class="review-bar" class:bad={!artifacts.validation.ok}>
              <span class="bar-mark" aria-hidden="true">{artifacts.validation.ok ? '✓' : '✗'}</span>
              <span class="bar-text">
                {#if artifacts.validation.ok}
                  {fileCount} {$t('crystallize.filesUnit')}
                  {#if diff !== null && (diff.totals.added > 0 || diff.totals.removed > 0)}
                    · {diffAgainst === 'previous'
                      ? $t('crystallize.vsPreviousShort')
                      : $t('crystallize.vsCurrentShort')}
                    <span class="num-tag add">+{diff.totals.added}</span>
                    <span class="num-tag del">−{diff.totals.removed}</span>
                  {:else}
                    · {Math.max(1, Math.round(totalBytes / 1024))} KB
                  {/if}
                  {#if artifacts.mode === 'text'}
                    · {$t('crystallize.textModeHint')}
                  {/if}
                {:else}
                  {$t('crystallize.problemsTitle')}（{artifacts.validation.problems.length}）
                {/if}
                · {#if targetKind === 'new'}
                  {$t('crystallize.targetNew')}
                {:else}
                  {$t('crystallize.targetUpdate')} {skillNameFor(selectedSkillId)}
                {/if}
              </span>
              <span class="bar-actions">
                <button
                  class="ghost small"
                  class:active={reviseOpen}
                  onclick={() => (reviseOpen = !reviseOpen)}
                >{$t('crystallize.reviseTitle')}</button>
              </span>
            </div>

            <!-- 问题列表：只在不过时说，最多 4 条（再多就该先改了） -->
            {#if !artifacts.validation.ok}
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

            <!-- slug：唯一需要人确认的字段（默认 = SKILL.md 的 name）；
                 name/description 只读展示——要改就改文件，一处真相 -->
            <div class="review-meta">
              <label class="slug-inline">
                <span class="faint small">{$t('crystallize.slugLabel')}</span>
                <input bind:value={slug} autocomplete="off" class="mono" />
              </label>
              {#if artifacts.skillMd.name !== '' || artifacts.skillMd.description !== ''}
                <span class="faint small frontmatter-line">
                  <code>{artifacts.skillMd.name}</code>
                  {#if artifacts.skillMd.description !== ''}
                    <span class="desc-clip">{artifacts.skillMd.description}</span>
                  {/if}
                </span>
              {/if}
            </div>
          </section>

          <!-- ── 主区：树 + 窗格（内容 / 差异 同位置切换） ── -->
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

          {#if selectedFile.endsWith('.md') && editText.trim() !== '' &&
            fileRows.find((r) => r.rel === selectedFile)?.change !== 'D'}
            <FoldSection title={$t('crystallize.previewTitle')}>
              <div class="preview markdown">{@html renderMarkdown(editText)}</div>
            </FoldSection>
          {/if}
        {/if}
      {/if}

      <!-- ── 素材（四轮 P1）：agent 读的就是这些文件，人也能翻同一份。
             折叠行常驻（一行摘要），展开后是"清单 + 预览"——与审阅的文件树同一套观感。 ── -->
      {#if draftRunId !== '' && material !== null}
        <FoldSection
          title={$t('crystallize.materialTitle')}
          summary={`${material.items.length} ${$t('crystallize.filesUnit')} · ${material.dirLabel}`}
        >
          {#if material.items.length === 0}
            <p class="faint small">{$t('crystallize.materialEmpty')}</p>
          {:else}
            <div class="file-pane">
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
            </div>
          {/if}
        </FoldSection>
      {/if}

      <!-- ── 起草 run：起草中常驻展开（那时它是唯一的信息）；审阅态折成一行
             （那时它只是历史，占 129px 只为了让审阅沉到第二屏以下）── -->
      {#if draftRunId !== '' && step !== 'done'}
        {#if step === 'review'}
          <FoldSection
            title={$t('crystallize.draftSection')}
            summary={`run ${runShort}…${draftStatus ? ` · ${statusLabel(draftStatus)}` : ''}${statsLine ? ` · ${statsLine}` : ''}`}
          >
            <div class="log-box">
              <RunLog runId={draftRunId} onterminal={(st) => void onDraftTerminal(st)} />
            </div>
          </FoldSection>
        {:else}
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
  .crystal-steps {
    display: flex;
    align-items: center;
    list-style: none;
    /* 分节靠 margin，步骤条同理：给下一块留出与分节之间一样的间距 */
    margin: 0 0 var(--sp-4);
    padding: 0;
    font-size: var(--fs-sm);
  }
  .crystal-steps li {
    flex: 1;
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
    flex: 1;
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
  .preview {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: var(--sp-3);
    max-height: 20rem;
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

  .review-bar-block {
    margin-bottom: var(--sp-4);
  }

  /* 结论条：一行说完"能不能入库 / 改了什么 / 目标是谁"。 */
  /*
   * 审核那一段的样式（§10.5 第 ⑤ 步）。
   *
   * ⚠️ 这里刻意**不设 max-width**：这一页在 D80 之后是整页宽，宽度约束写在别处会
   *    变成"只有这一块窄"的布局缺陷（`svelte-check` 看不见这类问题，只有浏览器量得出来）。
   *    结论条复用 `.review-bar`（同一位置、同一个视觉语言），只补问题清单的样式。
   */
  .audit-block .bar-text {
    /* 结论 + 理由码 + "额度用完"这句会变长：让它换行而不是把按钮挤出面板 */
    flex-wrap: wrap;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }

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

  .review-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--line);
    border-left: 3px solid var(--good);
    border-radius: var(--radius-sm);
    background: var(--panel);
  }

  .review-bar.bad {
    border-left-color: var(--bad);
  }

  .bar-mark {
    flex: 0 0 auto;
    color: var(--good);
    font-weight: 600;
  }

  .review-bar.bad .bar-mark {
    color: var(--bad);
  }

  .bar-text {
    flex: 1 1 auto;
    min-width: 0;
    font-size: var(--fs-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bar-actions {
    flex: 0 0 auto;
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
