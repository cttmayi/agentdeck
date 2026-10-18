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
   *   ③ review：草稿预览/编辑（slug/name/description/body）→ 确认入库
   *     （skills-mine 根 + git commit）；新建撞提炼根同 slug → 提示切"更新"。
   *
   * 恢复进行中的起草（§4.1.1）：targets 给 activeDraft（最近的、未入库的草稿，
   * 含起草时落库的目标）——顶部提示「继续 / 新起草」；「继续」把草稿挂回本页
   * （起草中 → 看日志；已完成 → 直接进审阅）。
   *
   * ⚠️ 沉淀不是任务：起草 run 不在任务列表里（kind execute + subject
   *   skill-draft + 无 issueId），进度只在这页，关页即离场、重开按 source 找回。
   */

  import type { WebTextId } from '@agentdeck/i18n'
  import { api, ApiError, type Skill } from '../lib/api.ts'
  import { t } from '../lib/i18n.ts'
  import { renderMarkdown } from '../lib/markdown.ts'
  import { go } from '../lib/view.ts'
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

  // ── 审阅 ──
  let slug = ''
  let name = ''
  let description = ''
  let skillBody = ''
  let saving = false
  /** 审阅里的冲突提示（新建撞提炼根同 slug）。 */
  let clash: { slug: string; name: string; id: string } | null = null

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
    (targetKind === 'new' ? purpose.trim() !== '' : selectedSkillId !== '')
  $: reviewValid = slug.trim() !== '' && name.trim() !== '' && skillBody.trim() !== ''

  $: runShort = draftRunId !== '' ? draftRunId.slice(0, 4) : ''

  function statusLabel(status: string): string {
    return $t(`term.runStatus.${status}` as WebTextId)
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
    slug = ''
    name = ''
    description = ''
    skillBody = ''
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
    if (targetKind === 'new' && purpose.trim() === '') {
      error = $t('crystallize.purposeLabel')
      return
    }
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

  /** 放弃草稿：回目标态重新来过（退出用栏头返回）。 */
  function abandonReview(): void {
    step = 'target'
    draftRunId = ''
    draftStatus = null
    handledTerminal = false
    slug = ''
    name = ''
    description = ''
    skillBody = ''
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

  /** 取草稿产出 = 起草 run 最后一条非空 text 消息（与任务详情页同一口径）。 */
  async function loadDraftOutput(): Promise<void> {
    try {
      const res = await api<{ messages: Array<{ type: string; content: string }> }>(
        `/api/runs/${draftRunId}/messages`,
      )
      let candidate = ''
      for (const m of res.messages) {
        if (m.type === 'text' && m.content.trim() !== '') candidate = m.content
      }
      if (candidate.trim() === '') {
        step = 'target'
        error = $t('crystallize.errEmptyMaterial')
        return
      }
      // 拆 frontmatter：name / description 直接进编辑框，正文可改。
      const parsed = parseFrontmatter(candidate)
      slug = parsed.name ?? defaultSlug(parsed.name ?? '')
      name = parsed.name ?? ''
      description = parsed.description ?? ''
      skillBody = parsed.body
      clash = null
      error = ''
      step = 'review'
    } catch (err) {
      step = 'drafting'
      error = $t('crystallize.errTargets', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 极简 frontmatter 拆解：`---` 头块里的 `name:` / `description:`。 */
  function parseFrontmatter(text: string): { name: string; description: string; body: string } {
    const trimmed = text.trimStart()
    if (!trimmed.startsWith('---')) return { name: '', description: '', body: text }
    const end = trimmed.indexOf('\n---', 3)
    if (end < 0) return { name: '', description: '', body: text }
    const head = trimmed.slice(3, end)
    const bodyText = trimmed.slice(end + 4)
    let name = ''
    let description = ''
    for (const line of head.split('\n')) {
      const mName = line.match(/^name\s*:\s*(.+)$/)
      if (mName) name = (mName[1] ?? '').trim()
      const mDesc = line.match(/^description\s*:\s*(.+)$/)
      if (mDesc) description = (mDesc[1] ?? '').trim()
    }
    return { name, description, body: bodyText }
  }

  function defaultSlug(n: string): string {
    return n
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63)
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
      const target = targetKind === 'new' ? { kind: 'new' as const } : { kind: 'update' as const, skillId: selectedSkillId }
      const res = await api<{ skill: Skill; versioning: { enabled: boolean; note?: string } }>(
        '/api/crystallize/commit',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            draftRunId,
            target,
            slug: slug.trim(),
            name: name.trim(),
            description: description.trim(),
            skillBody,
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
        title={!canStart && targets?.materialStats === null ? $t('crystallize.noMaterial') : undefined}
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
      <button class="ghost" onclick={abandonReview}>{$t('crystallize.abandon')}</button>
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
        <div class="notice bad" style="margin-bottom:var(--sp-3)">{error}</div>
      {/if}

      <!-- ── 恢复进行中的起草（§4.1.1）：继续 / 新起草 ── -->
      {#if targets?.activeDraft && !attached && step === 'target' && !loading}
        <div class="notice resume">
          <div class="resume-text">
            <strong>
              {$t('crystallize.resumeNotice', { status: statusLabel(targets.activeDraft.status) })}
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
        <h3><span>{$t('crystallize.materialSection')}</span></h3>
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
            <span>{$t('crystallize.draftSection')}</span>
            <span class="section-meta">
              run {runShort}…
              {#if draftStatus}
                <span class="badge {draftStatus === 'completed' ? 'done' : draftStatus === 'cancelled' ? 'cancelled' : 'failed'}">
                  {statusLabel(draftStatus)}
                </span>
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
          <h3><span>{$t('crystallize.reviewTitle')}</span></h3>
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

            <div class="grid-2">
              <label class="field">
                <span class="faint small">{$t('crystallize.slugLabel')}</span>
                <input bind:value={slug} autocomplete="off" />
              </label>
              <label class="field">
                <span class="faint small">{$t('crystallize.nameLabel')}</span>
                <input bind:value={name} autocomplete="off" />
              </label>
            </div>
            <label class="field">
              <span class="faint small">{$t('crystallize.descriptionLabel')}</span>
              <textarea bind:value={description} rows="2"></textarea>
            </label>
            <label class="field">
              <span class="faint small">{$t('crystallize.bodyLabel')}</span>
              <textarea bind:value={skillBody} rows="14" class="mono"></textarea>
            </label>

            <details>
              <summary class="faint small">{$t('crystallize.reviewTitle')} · {$t('crystallize.bodyLabel')}</summary>
              <div class="preview markdown">{@html renderMarkdown(skillBody)}</div>
            </details>
          </div>
        </section>
      {/if}

      <!-- ── 完成态：已沉淀 + git 状态 + 查看技能 ── -->
      {#if step === 'done'}
        <section class="done-box">
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
  .crystal-flow {
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
    max-width: 56rem;
  }

  /* ══════════ 步骤条：圆点 + 连线（走过 = 着强调色；当前步高亮；完成打勾） ══════════ */
  .crystal-steps {
    display: flex;
    align-items: center;
    list-style: none;
    margin: 0;
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

  /* ══════════ 分节卡片：栏头行（标题 + 右侧状态）+ 正文块 ══════════ */
  .drawer-section {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    overflow: hidden;
  }
  .drawer-section > h3 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    margin: 0;
    padding: var(--sp-2) var(--sp-4);
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text);
    border-bottom: 1px solid var(--line);
    line-height: 1.6;
  }
  .section-meta {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    font-weight: 400;
    color: var(--text-faint);
    min-width: 0;
    white-space: nowrap;
  }
  .section-body {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-4);
  }

  /* ══════════ 恢复提示（继续 / 新起草） ══════════ */
  .resume {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    flex-wrap: wrap;
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
  .field textarea.mono {
    font-family: var(--font-mono);
    font-size: 0.9em;
    line-height: 1.5;
  }

  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-3);
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

  /* ══════════ 完成态 ══════════ */
  .done-box {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    padding: var(--sp-5) var(--sp-4);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
</style>
