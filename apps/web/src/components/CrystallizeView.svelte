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

  // ── 审阅（四轮：产出 = 文件集合）──
  /** `GET /api/crystallize/artifacts` 的返回（服务端已解析 + 已校验）。 */
  let artifacts: Artifacts | null = null
  /** 当前选中的文件（相对 skill/ 目录）。 */
  let selectedFile = 'SKILL.md'
  /** 编辑区内容（与 selectedFile 联动；写入即回写 artifacts.files）。 */
  let editText = ''
  /** 每次编辑 +1：让"从文件里解析出的 frontmatter 摘要"能重算（普通对象不触发响应）。 */
  let filesVersion = 0
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
    selectedFile = rel
    editText = artifacts?.files[rel] ?? ''
  }

  /** 编辑回写：入库传的就是这份 files（服务端还会再校验一遍）。 */
  function onEditInput(): void {
    if (artifacts === null || selectedFile === '') return
    artifacts.files[selectedFile] = editText
    filesVersion += 1
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

  /** 变更集：新增 / 修改 / 删除（对着更新场景的当前版本算；新建 = 全新增）。 */
  $: fileRows = (() => {
    const a = artifacts
    if (a === null) return [] as Array<{ rel: string; change: '' | 'A' | 'M' | 'D'; bytes: number }>
    void filesVersion
    const base = a.baseline?.files ?? null
    const rows = Object.keys(a.files)
      .sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a < b ? -1 : 1))
      .map((rel) => {
        const text = a.files[rel] ?? ''
        const old = base?.[rel]
        const change: '' | 'A' | 'M' = old === undefined ? 'A' : old === text ? '' : 'M'
        return { rel, change, bytes: new TextEncoder().encode(text).length }
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

      <!-- ── 素材摘要：起草前就可见（§4.1.1），空素材 = 无法开始 ── -->
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

      <!-- ── 沉淀目标：目标态可编辑；起草后收成只读摘要 ── -->
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

      <!-- ── 起草 run：日志常驻（审阅时也看得见）；失败/停止 = 失败态 + 重新起草 ── -->
      {#if draftRunId !== '' && step !== 'done'}
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
              <RunLog runId={draftRunId} onterminal={(s) => void onDraftTerminal(s)} />
            </div>
          </div>
        </section>
      {/if}

      <!-- ── 草稿审阅 ── -->
      {#if step === 'review'}
        <section class="drawer-section">
          <h3>{$t('crystallize.reviewTitle')}</h3>
          <div class="section-body">
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

            <!-- 起草者判定"不可沉淀"：这是结论，不是失败——只给重新起草 / 放弃 -->
            {#if artifacts && artifacts.mode === 'refused'}
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
            {:else if artifacts}
              <!-- 结论优先：校验通过 / 不通过，永远在最上面 -->
              {#if artifacts.validation.ok}
                <p class="faint small">
                  ✓ {fileCount} {$t('crystallize.filesUnit')} · {Math.max(1, Math.round(totalBytes / 1024))} KB
                  {#if artifacts.mode === 'text'}
                    · {$t('crystallize.textModeHint')}
                  {/if}
                </p>
              {:else}
                <div class="notice bad">
                  <strong>{$t('crystallize.problemsTitle')}</strong>
                  <ul class="problem-list">
                    {#each artifacts.validation.problems as p (p.file + p.message)}
                      <li>
                        {#if p.file !== ''}<code>{p.file}</code>：{/if}{p.message}
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}

              <!-- slug：唯一需要人确认的字段（默认 = SKILL.md 的 name） -->
              <label class="field">
                <span class="faint small">{$t('crystallize.slugLabel')} · {$t('crystallize.slugFromFrontmatter')}</span>
                <input bind:value={slug} autocomplete="off" class="mono" />
              </label>

              <!-- frontmatter 摘要：只读，来自 SKILL.md 本身（要改就改文件） -->
              {#if artifacts.skillMd.name !== '' || artifacts.skillMd.description !== ''}
                <p class="faint small frontmatter-line">
                  <span>{$t('crystallize.nameLabel')}：<code>{artifacts.skillMd.name}</code></span>
                  {#if artifacts.skillMd.description !== ''}
                    <span>{$t('crystallize.descriptionLabel')}：{artifacts.skillMd.description}</span>
                  {/if}
                </p>
              {/if}

              <!-- 文件树 + 选中文件：多文件产物的呈现 -->
              <div class="file-pane">
                <ul class="file-tree">
                  {#each fileRows as row (row.rel)}
                    <li>
                      <button
                        type="button"
                        class="file-row"
                        class:active={row.rel === selectedFile}
                        onclick={() => selectFile(row.rel)}
                      >
                        <span class="file-name mono">{row.rel}</span>
                        {#if row.change !== ''}
                          <span
                            class="change-tag"
                            class:add={row.change === 'A'}
                            class:mod={row.change === 'M'}
                            class:del={row.change === 'D'}
                          >{changeLabel(row.change)}</span>
                        {/if}
                        {#if row.change !== 'D'}
                          <span class="faint small">{Math.max(1, Math.round(row.bytes / 1024))} KB</span>
                        {/if}
                      </button>
                    </li>
                  {/each}
                </ul>
                <div class="file-body">
                  {#if selectedFile === ''}
                    <p class="faint small">{$t('crystallize.noFiles')}</p>
                  {:else if fileRows.find((r) => r.rel === selectedFile)?.change === 'D'}
                    <p class="faint small">{$t('crystallize.deletedHint')}</p>
                  {:else}
                    <textarea
                      bind:value={editText}
                      oninput={onEditInput}
                      rows="16"
                      class="mono"
                      spellcheck="false"
                    ></textarea>
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
  .crystal-flow {
    max-width: 56rem;
  }

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
  .field textarea,
  .field input {
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
  .frontmatter-line {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .file-pane {
    display: grid;
    grid-template-columns: minmax(180px, 260px) minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }

  .file-tree {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
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

  .file-body textarea {
    width: 100%;
    box-sizing: border-box;
    font-size: 0.8125rem;
    line-height: 1.55;
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
