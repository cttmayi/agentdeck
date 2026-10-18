<script lang="ts">
  /**
   * 聊天/任务沉淀 skill（D80）——沉淀目标面板 → 起草 → 审阅，三态一体。
   *
   * 流程（设计文档 `docs/design/skill-crystallization.md`）：
   *   ① target：选「新建 skill」（必填作用描述）或「更新本次加载的 skill」
   *     （对话/任务实际注入的；提炼的=进化、安装的=存为你的版本并遮蔽）；
   *   ② drafting：复用 RunLog 显示起草 run 的实时日志（现成能力），可停止；
   *   ③ review：草稿预览/编辑（slug/name/description/body）→ 确认入库
   *     （skills-mine 根 + git commit）；新建撞提炼根同 slug → 提示切"更新"。
   *
   * 素材硬要求：消息 + 工具调用及其结果（daemon 端 `crystallize.ts` 打包，
   * 这里只负责展示与确认）。
   */

  import { api, ApiError, type Skill } from '../lib/api.ts'
  import { t } from '../lib/i18n.ts'
  import { renderMarkdown } from '../lib/markdown.ts'
  import { showToast } from '../lib/view.ts'
  import Drawer from './Drawer.svelte'
  import RunLog from './RunLog.svelte'

  /** 目标面板信息（对应 `GET /api/crystallize/targets`）。 */
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
  }

  export let open = false
  /** 源 run（对话轮次或任务执行 run）的 id。 */
  export let runId = ''
  /** 入库成功后的回调（父组件刷新技能列表）。 */
  export let ondone: () => void = () => {}
  export let onclose: () => void = () => {}

  let phase: 'target' | 'drafting' | 'review' = 'target'
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
  let materialStats: { turns: number; toolCalls: number } | null = null

  // ── 审阅 ──
  let slug = ''
  let name = ''
  let description = ''
  let body = ''
  let saving = false
  /** 审阅里的冲突提示（新建撞提炼根同 slug）。 */
  let clash: { slug: string; name: string; id: string } | null = null

  $: title =
    phase === 'target'
      ? $t('crystallize.title')
      : phase === 'drafting'
        ? $t('crystallize.title')
        : $t('crystallize.reviewTitle')

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

  $: if (open && runId) void loadTargets()

  async function startDraft(): Promise<void> {
    error = ''
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
      phase = 'drafting'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 服务端 400 带 {error, code}——把 code 说出口（前端不认识 code 也照显示）。
      error = $t('crystallize.errDraftRejected', { error: msg })
    }
  }

  async function stopDraft(): Promise<void> {
    try {
      await api(`/api/runs/${draftRunId}/cancel`, { method: 'POST' })
    } catch {
      // 停止失败不阻塞：回到目标面板，让使用者决定下一步
    }
    phase = 'target'
  }

  /** 起草 run 到终态：completed → 取草稿进审阅；否则回目标面板并说明。 */
  async function onDraftTerminal(status: string): Promise<void> {
    if (status !== 'completed') {
      phase = 'target'
      error = $t('crystallize.draftFailed')
      return
    }
    try {
      const res = await api<{ messages: Array<{ type: string; content: string }> }>(
        `/api/runs/${draftRunId}/messages`,
      )
      // 产出 = 最后一条非空 text 消息（与任务详情页同一口径）。
      let candidate = ''
      for (const m of res.messages) {
        if (m.type === 'text' && m.content.trim() !== '') candidate = m.content
      }
      if (candidate.trim() === '') {
        phase = 'target'
        error = $t('crystallize.errEmptyMaterial')
        return
      }
      // 拆 frontmatter：name / description 直接进编辑框，正文可改。
      const parsed = parseFrontmatter(candidate)
      slug = parsed.name ?? defaultSlug(parsed.name ?? '')
      name = parsed.name ?? ''
      description = parsed.description ?? ''
      body = parsed.body
      clash = null
      phase = 'review'
    } catch (err) {
      phase = 'target'
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
            body,
          }),
        },
      )
      if (res.versioning?.enabled) {
        showToast($t('crystallize.saved', { name: res.skill.name }))
      } else {
        showToast($t('crystallize.savedVersioningOff', { name: res.skill.name }))
      }
      ondone()
      reset()
      onclose()
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

  function reset(): void {
    phase = 'target'
    targets = null
    purpose = ''
    userFeedback = ''
    selectedSkillId = ''
    draftRunId = ''
    materialStats = null
    slug = ''
    name = ''
    description = ''
    body = ''
    clash = null
    error = ''
  }
</script>

<Drawer open={open} title={title} size="wide" onclose={() => { reset(); onclose() }}>
  {#if phase === 'target'}
    <!-- ── ① 沉淀目标面板 ── -->
    {#if loading}
      <div class="skeleton" style="height:1.2rem;margin-bottom:var(--sp-2)"></div>
      <div class="skeleton" style="height:1.2rem;width:70%"></div>
    {:else if error && targets === null}
      <div class="notice bad">{error}</div>
    {:else if targets}
      <div class="stack">
        <!-- 素材统计在起草受理后才有（targets 接口不打包素材——那是起草 run 的事），
             这里只放目标选择。 -->

        <label class="radio-row">
          <input type="radio" bind:group={targetKind} value="new" />
          <div>
            <strong>{$t('crystallize.targetNew')}</strong>
            <span class="faint small block">{$t('crystallize.purposeHint')}</span>
          </div>
        </label>
        {#if targetKind === 'new'}
          <label class="field">
            <span class="faint small">{$t('crystallize.purposeLabel')}</span>
            <textarea
              bind:value={purpose}
              rows="2"
              placeholder={$t('crystallize.purposePlaceholder')}
            ></textarea>
          </label>
        {/if}

        <label class="radio-row">
          <input type="radio" bind:group={targetKind} value="update" disabled={targets.loadedSkills.length === 0} />
          <div>
            <strong>{$t('crystallize.targetUpdate')}</strong>
            <span class="faint small block">{$t('crystallize.targetUpdateHint')}</span>
          </div>
        </label>
        {#if targetKind === 'update'}
          {#if targets.loadedSkills.length === 0}
            <p class="notice">{ $t('crystallize.noLoadedSkills') }</p>
          {:else}
            <div class="skill-list">
              {#each targets.loadedSkills as s (s.id)}
                <label class="radio-row compact">
                  <input type="radio" bind:group={selectedSkillId} value={s.id} />
                  <div>
                    <code>{s.slug}</code>
                    <span class="badge" class:mine={s.source === 'mine'}>
                      {s.source === 'mine' ? $t('crystallize.badgeMine') : $t('crystallize.badgeInstalled')}
                    </span>
                    {#if s.description}
                      <span class="faint small block">{s.description}</span>
                    {/if}
                  </div>
                </label>
              {/each}
            </div>
            <p class="faint small">{$t('crystallize.updateIsEvolve')}</p>
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

        {#if error}
          <div class="notice bad">{error}</div>
        {/if}

        <div class="row-end">
          <button
            class="primary"
            disabled={(targetKind === 'new' && purpose.trim() === '') || (targetKind === 'update' && selectedSkillId === '')}
            onclick={() => void startDraft()}
          >
            {$t('crystallize.start')}
          </button>
          <button class="ghost" onclick={() => { reset(); onclose() }}>{$t('crystallize.cancel')}</button>
        </div>
      </div>
    {/if}
  {:else if phase === 'drafting'}
    <!-- ── ② 起草中：实时日志（复用 RunLog 的 SSE）+ 可停止 ── -->
    <div class="drafting">
      <div class="row-between">
        <p class="faint small">
          {#if materialStats}
            {$t('crystallize.materialSummary', {
              turns: String(materialStats.turns),
              tools: String(materialStats.toolCalls),
            })} ·
          {/if}
          {$t('crystallize.drafting')}
        </p>
        <button class="ghost small" onclick={() => void stopDraft()}>{$t('chat.stop')}</button>
      </div>
      <div class="log-box">
        <RunLog runId={draftRunId} onterminal={(s) => void onDraftTerminal(s)} />
      </div>
    </div>
  {:else}
    <!-- ── ③ 草稿审阅 ── -->
    <div class="stack">
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
        <textarea bind:value={body} rows="14" class="mono"></textarea>
      </label>

      <details>
        <summary class="faint small">{$t('crystallize.reviewTitle')} · {$t('crystallize.bodyLabel')}</summary>
        <div class="preview markdown">{@html renderMarkdown(body)}</div>
      </details>

      <div class="row-end">
        <button class="primary" disabled={saving || slug.trim() === '' || name.trim() === '' || body.trim() === ''} onclick={() => void save()}>
          {$t('crystallize.confirm')}
        </button>
        <button class="ghost" onclick={() => { reset(); onclose() }}>{$t('crystallize.cancel')}</button>
      </div>
    </div>
  {/if}
</Drawer>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
  .radio-row {
    display: flex;
    gap: var(--sp-2);
    align-items: flex-start;
    cursor: pointer;
  }
  .radio-row.compact {
    padding: var(--sp-1) 0;
  }
  .block {
    display: block;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .field textarea,
  .field input {
    font: inherit;
    padding: var(--sp-1) var(--sp-2);
    border: 1px solid var(--line);
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
    gap: var(--sp-2);
  }
  .row-end {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }
  .row-between {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .skill-list {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: var(--sp-2);
    max-height: 16rem;
    overflow-y: auto;
  }
  .badge.mine {
    background: var(--accent);
    color: var(--bg);
    border-radius: var(--radius-sm);
    padding: 0 var(--sp-1);
    font-size: 0.85em;
  }
  .drafting {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .log-box {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    max-height: 26rem;
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
</style>
