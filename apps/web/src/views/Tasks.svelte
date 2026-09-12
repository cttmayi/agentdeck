<script lang="ts">
  import { api, type RunSummary, type VerdictView } from '../lib/api.ts'
  import { agents, issues, loadIssues, loadRuns, loading, loadError, runs } from '../lib/stores.ts'
  import { selectedIssueId } from '../lib/view.ts'
  import { PIPELINE_COLUMNS as COLUMNS, stageOf } from '../lib/pipeline.ts'
  import RunLog from '../components/RunLog.svelte'

  /**
   * 任务清单 + 任务详情。
   *
   * ══════════════════════════════════════════════════════════════════
   * 两种视图各有各的用途，都要有（FR-ISSUE-04）
   * ══════════════════════════════════════════════════════════════════
   *
   * 列表适合"找一条具体的任务"，看板适合"看整体堆在哪里"。只留一个会逼着
   * 使用者用错误的工具回答其中一半的问题。
   *
   * 执行记录与实时日志放在**任务详情**里，而不是单独一栏——执行属于某个
   * 任务，"我在看哪个任务的执行"这个问题本来就不该由使用者自己拼。
   */
  const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled']
  const LABELS: Record<string, string> = {
    backlog: '待办池',
    todo: '待做',
    in_progress: '进行中',
    in_review: '待审核',
    done: '已完成',
    blocked: '受阻',
    cancelled: '已取消',
  }

  $: staged = visible.map((issue) => ({ issue, info: stageOf(issue.id, $runs) }))

  const VIEW_KEY = 'alpha-helper.issue-view'
  let mode: 'list' | 'board' = localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list'

  function setMode(next: 'list' | 'board'): void {
    mode = next
    localStorage.setItem(VIEW_KEY, next)
  }

  let filter = ''

  $: visible = $issues.filter((i) => {
    if (!filter.trim()) return true
    const q = filter.trim().toLowerCase()
    return i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)
  })

  $: selected = $issues.find((i) => i.id === $selectedIssueId) ?? null
  $: issueRuns = selected ? $runs.filter((r) => r.subject?.id === selected.id) : []

  function agentName(id: string | null): string {
    if (!id) return '未指派'
    return $agents.find((a) => a.id === id)?.name ?? id
  }

  // ── 任务详情 ──

  let activeRun: RunSummary | null = null
  let verdicts: VerdictView[] = []
  let verdictsFor: string | null = null

  $: if (issueRuns.length > 0 && (!activeRun || !issueRuns.some((r) => r.runId === activeRun!.runId))) {
    activeRun = issueRuns[0]!
  }

  async function loadVerdicts(runId: string): Promise<void> {
    verdictsFor = runId
    try {
      const out = await api<{ verdicts: VerdictView[] }>(`/api/runs/${runId}/verdicts`)
      verdicts = out.verdicts ?? []
    } catch {
      verdicts = []
    }
  }

  async function cancel(runId: string): Promise<void> {
    await api(`/api/runs/${runId}/cancel`, { method: 'POST' })
    await loadRuns()
  }

  async function selectRun(run: RunSummary): Promise<void> {
    activeRun = run
    await loadVerdicts(run.runId)
  }

  async function refresh(): Promise<void> {
    await Promise.all([loadIssues(), loadRuns()])
    if (activeRun) await loadVerdicts(activeRun.runId)
  }
</script>

{#if selected}
  <!-- ══════════ 任务详情 ══════════ -->
  <div class="view-head">
    <div>
      <button type="button" class="ghost small" onclick={() => selectedIssueId.set(null)}>
        ← 返回任务清单
      </button>
      <h2 style="margin-top:var(--sp-2)">{selected.title}</h2>
      <p>
        <span class="badge {selected.status}">{LABELS[selected.status] ?? selected.status}</span>
        <span style="margin-left:var(--sp-2)">{agentName(selected.assignee?.id ?? null)}</span>
      </p>
    </div>
    <button type="button" class="secondary" onclick={refresh}>刷新</button>
  </div>

  {#if selected.description}
    <section class="drawer-section">
      <h3>说明</h3>
      <p class="hint" style="white-space:pre-wrap">{selected.description}</p>
    </section>
  {/if}

  <section class="drawer-section">
    <h3>执行记录 <span class="faint small">（{issueRuns.length}）</span></h3>

    {#if issueRuns.length === 0}
      <div class="empty">
        <strong>这个任务还没有执行过</strong>
        在「新建任务」里创建时会自动派发一次。
      </div>
    {:else}
      <div class="run-tabs">
        {#each issueRuns as run (run.runId)}
          <button
            type="button"
            class="run-tab"
            class:active={activeRun?.runId === run.runId}
            onclick={() => selectRun(run)}
          >
            <span class="badge {run.status}">{run.status}</span>
            <span class="mono faint small">{run.runId.slice(-8)}</span>
          </button>
        {/each}
      </div>
    {/if}
  </section>

  {#if activeRun}
    <section class="drawer-section">
      <h3>
        实时输出
        <span class="faint small mono">run {activeRun.runId.slice(-8)}</span>
      </h3>

      <dl class="meta-grid">
        <dt>工作目录</dt>
        <dd class="mono">{activeRun.workDir ?? '—'}</dd>
        <dt>类型</dt>
        <dd>{activeRun.kind === 'review' ? '审核' : '执行'}</dd>
        {#if activeRun.finishedAt}
          <dt>耗时</dt>
          <dd>{((activeRun.finishedAt - activeRun.queuedAt) / 1000).toFixed(1)} 秒</dd>
        {/if}
      </dl>

      <RunLog
        runId={activeRun.runId}
        since={activeRun.lastSeq}
        onterminal={() => void refresh()}
      />

      <div style="margin-top:var(--sp-3);display:flex;gap:var(--sp-2)">
        <button
          type="button"
          class="danger"
          disabled={['completed', 'failed', 'cancelled'].includes(activeRun.status)}
          onclick={() => cancel(activeRun!.runId)}
        >
          取消这次执行
        </button>
        <button type="button" class="secondary" onclick={() => loadVerdicts(activeRun!.runId)}>
          读取判决
        </button>
      </div>

      {#if verdictsFor === activeRun.runId && verdicts.length > 0}
        <h4 style="margin-top:var(--sp-4)">判决</h4>
        {#each verdicts as v (v.id)}
          <article class="notice" style="margin-bottom:var(--sp-2);flex-direction:column">
            <div style="display:flex;gap:var(--sp-2);align-items:center">
              <span class="badge {v.conclusion === 'pass' ? 'done' : v.conclusion === 'fail' ? 'failed' : 'blocked'}">
                {v.conclusion}
              </span>
              <span class="mono small faint">{v.reasonCode}</span>
              <span class="faint small">置信度 {Math.round(v.confidence * 100)}%</span>
            </div>
            {#if v.action}
              <div class="small">建议动作：<code>{v.action.type}</code></div>
            {/if}
            {#if v.escalateReason}
              <div class="small warn">需要你判断：{v.escalateReason}</div>
            {/if}
            {#if v.findings.length > 0}
              <ul class="plain small" style="margin:0">
                {#each v.findings as f}
                  <li>[{f.severity}] {f.summary}</li>
                {/each}
              </ul>
            {:else}
              <div class="faint small">（没有具体发现项）</div>
            {/if}
          </article>
        {/each}
      {/if}
    </section>
  {/if}

{:else}
  <!-- ══════════ 清单 / 看板 ══════════ -->
  <div class="view-head">
    <div>
      <h2>任务清单</h2>
      <p>
        按<strong>实际进行到哪一步</strong>分列——不是按人工维护的状态字段，
        而是从执行记录推出来的事实。点任意一条看它的执行记录与实时输出。
      </p>
    </div>
    <div style="display:flex;gap:var(--sp-2)">
      <button type="button" class="ghost" class:active={mode === 'list'} onclick={() => setMode('list')}>
        列表
      </button>
      <button type="button" class="ghost" class:active={mode === 'board'} onclick={() => setMode('board')}>
        看板
      </button>
      <button type="button" class="secondary" onclick={refresh}>刷新</button>
    </div>
  </div>

  <input
    bind:value={filter}
    placeholder="搜索标题或说明…"
    style="max-width:22rem;margin-bottom:var(--sp-4)"
    autocomplete="off"
  />

  {#if $loading['issues'] && $issues.length === 0}
    <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
    <div class="skeleton" style="width:70%"></div>
  {:else if $loadError['issues']}
    <div class="notice bad">{$loadError['issues']}</div>
  {:else if visible.length === 0}
    <div class="empty">
      <strong>{filter ? '没有匹配的任务' : '还没有任务'}</strong>
      {filter ? '换个关键词试试。' : '去「新建任务」建一个，它会立刻派给 agent。'}
    </div>
  {:else if mode === 'board'}
    <div class="board board-3">
      {#each COLUMNS as col (col.id)}
        {@const items = staged.filter((x) => x.info.stage === col.id)}
        <div class="column">
          <h4>
            <span>{col.title} <span class="faint">{items.length}</span></span>
            <span class="col-hint">{col.hint}</span>
          </h4>

          {#if items.length === 0}
            <p class="col-empty faint small">（空）</p>
          {/if}

          {#each items as { issue, info } (issue.id)}
            <button type="button" class="card" onclick={() => selectedIssueId.set(issue.id)}>
              <span class="card-title">{issue.title}</span>
              <span class="card-meta">
                <span class="faint small">{agentName(issue.assignee?.id ?? null)}</span>
                <span class="faint small">{info.detail}</span>
              </span>
              {#if info.warning}
                <span class="card-warning">{info.warning}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/each}
    </div>

  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>任务</th><th>状态</th><th>指派给</th><th>更新于</th></tr>
        </thead>
        <tbody>
          {#each visible as issue (issue.id)}
            <tr onclick={() => selectedIssueId.set(issue.id)} style="cursor:pointer">
              <td><strong>{issue.title}</strong></td>
              <td><span class="badge {issue.status}">{LABELS[issue.status] ?? issue.status}</span></td>
              <td class="muted">{agentName(issue.assignee?.id ?? null)}</td>
              <td class="faint small">{new Date(issue.updatedAt).toLocaleString()}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}

<style>
  /* ── 三列流水线 ── */
  .board-3 {
    /* 固定三列（而不是 auto-fit）：三列就是流水线的三个阶段，
       少一列会让人以为那一阶段不存在 */
    grid-template-columns: repeat(3, 1fr);
    gap: var(--sp-4);
  }

  .col-hint {
    display: block;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    margin-top: 2px;
  }

  .column h4 {
    flex-direction: column;
    align-items: flex-start;
    gap: 0;
  }

  .col-empty {
    padding: var(--sp-3) var(--sp-2);
    margin: 0;
  }

  .card-meta {
    display: flex;
    justify-content: space-between;
    gap: var(--sp-2);
  }

  /* 需要留意的情况用一条左侧色条，而不是整块变红——
     整块变红会让"有一处小问题"看起来像"这张卡坏了" */
  .card-warning {
    display: block;
    font-size: var(--fs-xs);
    color: var(--warn);
    border-left: 2px solid var(--warn);
    padding-left: var(--sp-2);
    margin-top: var(--sp-1);
  }

  /* ── 看板 ── */
  .board {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--sp-3);
    align-items: start;
  }

  .column {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2);
    min-height: 5rem;
  }

  .column h4 {
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-faint);
    margin: var(--sp-1) var(--sp-2) var(--sp-2);
    display: flex;
    justify-content: space-between;
  }

  .card {
    display: block;
    width: 100%;
    text-align: left;
    background: var(--surface-2);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: var(--sp-2);
    margin-bottom: var(--sp-1);
    cursor: pointer;
    color: var(--text);
  }

  .card:hover {
    background: var(--surface-hover);
    border-color: var(--line-strong);
    filter: none;
  }

  .card-title {
    display: block;
    font-size: var(--fs-sm);
    margin-bottom: 2px;
  }

  /* ── 执行记录标签 ── */
  .run-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }

  .run-tab {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    background: var(--surface);
    border: 1px solid var(--line);
    color: var(--text-dim);
    padding: var(--sp-1) var(--sp-3);
    border-radius: 100px;
  }

  .run-tab.active {
    border-color: var(--accent);
    color: var(--text);
  }

  /* ── 元信息栅格 ── */
  .meta-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--sp-1) var(--sp-4);
    margin: 0 0 var(--sp-3);
    font-size: var(--fs-sm);
  }

  .meta-grid dt { color: var(--text-faint); }
  .meta-grid dd { margin: 0; word-break: break-all; }

  :global(button.ghost.active) {
    background: var(--surface-2);
    color: var(--text);
  }
</style>
