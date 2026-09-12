<script lang="ts">
  import type { Agent } from '../lib/api.ts'
  import { agents, skills, updateAgent } from '../lib/stores.ts'
  import { showToast } from '../lib/view.ts'

  /**
   * 智能体详情 / 编辑（FR-AGENT-19）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么要"点开"而不是在表格里直接改
   * ══════════════════════════════════════════════════════════════════
   *
   * agent 有九个可配字段，全塞进表格会让每一行都很高、很难扫。而"看配置"
   * 与"扫一遍有哪些 agent"是两个不同的动作——前者偶尔做一次且要看全，
   * 后者经常做且只看名字。
   *
   * 所以表格保持紧凑（点名字进详情），详情里给全。
   *
   * ══════════════════════════════════════════════════════════════════
   * 编辑用 PATCH 语义
   * ══════════════════════════════════════════════════════════════════
   *
   * 只提交**改动过的**字段。整体提交的话，两个人同时编辑时后保存的会把
   * 前一个的改动抹掉——而这里没有并发控制，减少提交面是最省事也最有效的
   * 缓解。而且"只改名字却把指令清空"那种坑也不会发生。
   */
  export let agent: Agent
  export let onclose: () => void
  export let onchanged: () => void

  let editing = false
  let busy = false
  let error = ''

  // 编辑缓冲：进入编辑时从 agent 拷一份，取消时直接丢弃
  const blankDraft = () => ({
    name: agent.name,
    role: agent.role,
    instructions: agent.instructions,
    skillIds: [...agent.skillIds],
    reviewerAgentId: agent.reviewerAgentId ?? '',
    runtimeKey: agent.runtimeKey,
    workDir: agent.workDir ?? '',
    model: agent.model ?? '',
  })

  let draft = blankDraft()

  function startEdit(): void {
    // 每次进入编辑都重新拷一份——否则上一次取消留下的改动会残留
    draft = blankDraft()
    editing = true
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
    return patch
  }

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
      showToast('已保存')
      onchanged()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  $: attached = $skills.filter((s) => agent.skillIds.includes(s.id))
  $: reviewers = $agents.filter((a) => a.role === 'reviewer' && a.id !== agent.id)
  $: chosenReviewer = $agents.find((a) => a.id === agent.reviewerAgentId) ?? null
  $: roleLabel = agent.role === 'reviewer' ? '审核' : '执行'
</script>

<div class="detail">
  <div class="view-head" style="margin-bottom:var(--sp-4)">
    <div>
      <button type="button" class="ghost small" onclick={onclose}>← 返回智能体列表</button>
      <h2 style="margin-top:var(--sp-2)">{agent.name}</h2>
      <p>
        {#if agent.isFallbackReviewer}<span class="badge in_review">兜底审核者</span>{/if}
        {#if agent.autoReview}<span class="badge done">执行后自动审核</span>{/if}
        {#if agent.kindPatterns.length === 0}
          <span class="badge blocked">谁也接不到</span>
        {/if}
      </p>
    </div>
    {#if !editing}
      <button type="button" onclick={startEdit}>编辑</button>
    {:else}
      <div style="display:flex;gap:var(--sp-2)">
        <button type="button" onclick={save} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        <button type="button" class="secondary" onclick={() => (editing = false)}>取消</button>
      </div>
    {/if}
  </div>

  {#if error}
    <div class="notice bad" style="margin-bottom:var(--sp-3)">{error}</div>
  {/if}

  {#if !editing}
    <!-- ── 只读视图 ── -->
    <dl class="meta-grid">
      <dt>角色</dt>
      <dd>
        <span class="badge {agent.role === 'reviewer' ? 'in_review' : 'in_progress'}">{roleLabel}</span>
        <span class="faint small">
          {agent.role === 'reviewer' ? '按标准审别人的产出' : '接到任务后动手干活'}
        </span>
      </dd>

      {#if agent.role === 'executor'}
        <dt>由谁来审它</dt>
        <dd>
          {#if chosenReviewer}
            <strong>{chosenReviewer.name}</strong>
          {:else if agent.reviewerAgentId}
            <span class="bad">指定的审核者已不存在（{agent.reviewerAgentId}）</span>
          {:else}
            <span class="muted">不自动审核</span>
            <span class="hint">——执行产出不会被自动审。这是明确的选择，不是错误。</span>
          {/if}
        </dd>
      {/if}

      <dt>指令</dt>
      <dd style="white-space:pre-wrap">{agent.instructions || '（未设置）'}</dd>

      <dt>挂载的 skill</dt>
      <dd>
        {#if attached.length === 0}
          {#if agent.role === 'reviewer'}
            <span class="bad">没有挂 skill</span>
            <span class="hint">——它审不了任何东西：审核标准就写在 skill 里。</span>
          {:else}
            <span class="muted">没有挂 skill</span>
            <span class="hint">——执行者可以不挂，产出由审核者按标准来判。</span>
          {/if}
        {:else}
          {#each attached as s (s.id)}
            <div><code>{s.slug}</code> <span class="faint small">{s.name}</span></div>
          {/each}
        {/if}
      </dd>

      <dt>runtime</dt>
      <dd><code>{agent.runtimeKey}</code></dd>
      <dt>模型</dt>
      <dd>{agent.model ?? '（用 CLI 默认）'}</dd>
      <dt>工作目录</dt>
      <dd class="mono faint small">{agent.workDir ?? '每个任务自动分配（D27）'}</dd>
    </dl>

  {:else}
    <!-- ── 编辑视图 ── -->
    <label>
      名称
      <input bind:value={draft.name} />
    </label>

    <div class="field">
      <span class="field-label">它是做什么的</span>
      <div class="role-picker">
        <button
          type="button"
          class="role-card"
          class:active={draft.role === 'executor'}
          onclick={() => (draft.role = 'executor')}
        >
          <strong>执行</strong><span>接到任务后动手干活</span>
        </button>
        <button
          type="button"
          class="role-card"
          class:active={draft.role === 'reviewer'}
          onclick={() => (draft.role = 'reviewer')}
        >
          <strong>审核</strong><span>按标准审别人的产出，给判决</span>
        </button>
      </div>
    </div>

    {#if draft.role === 'executor'}
      <label>
        由谁来审它
        <select bind:value={draft.reviewerAgentId}>
          <option value="">不自动审核</option>
          {#each reviewers as r (r.id)}
            <option value={r.id}>{r.name}</option>
          {/each}
        </select>
      </label>
    {/if}

    <label>
      指令
      <textarea bind:value={draft.instructions} rows="4"></textarea>
    </label>

    <label>
      挂载的 skill
      <div class="skill-picker">
        {#each $skills as s (s.id)}
          <label class="skill-option">
            <input type="checkbox" value={s.id} bind:group={draft.skillIds} />
            <span><code>{s.slug}</code></span>
          </label>
        {/each}
      </div>
    </label>

    <div class="row">
      <label>
        用哪个 runtime
        <select bind:value={draft.runtimeKey}>
          <option value="claude">claude</option>
          <option value="generic">generic（未对照真实程序）</option>
        </select>
      </label>
      <label>
        默认工作目录（留空 = 每任务自动分配）
        <input bind:value={draft.workDir} />
      </label>
    </div>
    <label>
      模型（留空 = 用 CLI 默认）
      <input bind:value={draft.model} />
    </label>
  {/if}
</div>

<style>
  .detail {
    max-width: 50rem;
  }

  .meta-grid { gap: var(--sp-3) var(--sp-5); }

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-3);
  }

  .inline { display: flex; align-items: center; gap: var(--sp-2); }
  .inline input { width: auto; }

  .skill-picker {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: var(--sp-1);
    margin-top: var(--sp-2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2);
    background: var(--bg);
    max-height: 12rem;
    overflow-y: auto;
  }

  .field { margin-bottom: var(--sp-3); }

  .field-label {
    display: block;
    font-size: var(--fs-sm);
    color: var(--text-dim);
    margin-bottom: var(--sp-1);
  }

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

  .role-card strong { color: var(--text); font-size: var(--fs-md); }
  .role-card span { font-size: var(--fs-xs); color: var(--text-faint); }
  .role-card.active { border-color: var(--accent); background: var(--surface-2); }
  .role-card.active strong { color: var(--accent); }

  .skill-option { display: flex; align-items: center; gap: var(--sp-2); margin: 0; cursor: pointer; }
  .skill-option input { width: auto; }
</style>
