<script lang="ts">
  /**
   * 沉淀页（D80 三轮）——导航列工具之下的独立一页，**沉淀的整个过程在此页进行**。
   *
   * 左栏 = 沉淀任务列表（未入库的起草 run，使用者定稿：已入库的不显示），
   * 点一条右栏进入它的流程页（地址 `#/crystallize/<runId>`——切页回来 / 刷新 /
   * 分享链接都还在）；列表上方「新建沉淀」选来源对话/任务再进入目标步骤。
   *
   * 入口：聊天页「沉淀成 skill」/ 任务页「优化 skill」按钮跳到这一页并选中对应
   * 那条；二轮的旧子路由（`#/chat/crystallize/<runId>`）由 `syncRoute` 重定向过来。
   *
   * 与任务页的关系：起草 run 的 subject 是 `skill-draft`，**不进任务列表**——
   * "沉淀不是任务"（设计 §4.1.1），这条列表是沉淀自己的列表。
   */
  import { onMount, onDestroy } from 'svelte'
  import { t } from '../lib/i18n.ts'
  import { api } from '../lib/api.ts'
  import type { WebTextId } from '@agentdeck/i18n'
  import { absoluteTime, relativeTime } from '../lib/time.ts'
  import { crystallize, go, goCrystallize } from '../lib/view.ts'
  import ListPane from '../components/ListPane.svelte'
  import MainArea from '../components/MainArea.svelte'
  import CrystallizeView from '../components/CrystallizeView.svelte'

  /** GET /api/crystallize/drafts 的行。 */
  interface DraftRow {
    runId: string
    status: string
    queuedAt: number
    target: { kind: 'new' } | { kind: 'update'; skillId: string } | null
    source: { kind: 'conversation' | 'issue'; label: string } | null
  }

  /** GET /api/crystallize/sources 的行（新建沉淀的来源选择器）。 */
  interface SourceRow {
    kind: 'conversation' | 'task'
    id: string
    label: string
    runId: string
    turns: number | null
  }

  let drafts: DraftRow[] = []
  let loading = false
  let loadError: string | null = null
  let now = Date.now()
  let pickOpen = false
  let sources: SourceRow[] = []
  let sourcesLoading = false
  let sourcesError: string | null = null

  function statusLabel(status: string): string {
    return $t(`term.runStatus.${status}` as WebTextId)
  }

  /** 列表行目标摘要：新建 / 更新 <slug>。 */
  function targetLabel(row: DraftRow): string {
    if (row.target === null) return $t('crystallize.rowNew')
    return row.target.kind === 'new'
      ? $t('crystallize.rowNew')
      : $t('crystallize.rowUpdate', { slug: row.target.skillId })
  }

  /** 列表行来源摘要：来源类型 + 标题（源 run 丢了时兜底）。 */
  function sourceLabel(row: DraftRow): string {
    if (row.source === null) return $t('crystallize.sourceUnknown')
    return `${row.source.kind === 'conversation' ? $t('crystallize.scopeConversation') : $t('crystallize.scopeTask')} · ${row.source.label}`
  }

  async function refresh(): Promise<void> {
    try {
      const res = await api<{ items: DraftRow[] }>('/api/crystallize/drafts')
      drafts = res.items
      loadError = null
    } catch (e) {
      loadError = String(e instanceof Error ? e.message : e)
    } finally {
      loading = false
    }
  }

  /** 选中了一条 / 流程页入库完成（草稿从列表消失）都值得重拉一次。 */
  function reloadQuiet(): void {
    void refresh()
  }

  async function openPicker(): Promise<void> {
    pickOpen = true
    sourcesLoading = true
    sourcesError = null
    try {
      const res = await api<{ items: SourceRow[] }>('/api/crystallize/sources')
      sources = res.items
    } catch (e) {
      sourcesError = String(e instanceof Error ? e.message : e)
    } finally {
      sourcesLoading = false
    }
  }

  function pick(row: SourceRow): void {
    pickOpen = false
    goCrystallize(row.runId)
  }

  /** 当前选中条目的来源标签（流程页副题）。 */
  $: selectedLabel = drafts.find((d) => d.runId === $crystallize?.runId)?.source?.label ?? ''

  // 列表每 6 秒轻刷新一次：起草中的 run 完成/失败时徽标要跟着动
  // （流程页自己的状态走它内部的轮询，这里只管列表行）。
  let timer: ReturnType<typeof setInterval>
  let tick: ReturnType<typeof setInterval>
  onMount(() => {
    loading = true
    void refresh()
    timer = setInterval(() => void refresh(), 6000)
    tick = setInterval(() => (now = Date.now()), 30_000)
  })

  onDestroy(() => {
    clearInterval(timer)
    clearInterval(tick)
  })

  let filter = ''
  $: filtered = drafts.filter((d) => {
    const q = filter.trim().toLowerCase()
    if (q === '') return true
    return (d.source?.label ?? '').toLowerCase().includes(q)
  })
  $: convSources = sources.filter((s) => s.kind === 'conversation')
  $: taskSources = sources.filter((s) => s.kind === 'task')

  /** 列表行状态徽标的颜色档（活跃 / 完成 / 失败，与流程页步骤条同一套语义）。 */
  function statusClass(status: string): string {
    if (status === 'running' || status === 'queued' || status === 'dispatched') return 'active'
    if (status === 'completed') return 'done'
    if (status === 'failed' || status === 'cancelled') return 'blocked'
    return ''
  }
</script>

<div class="split-layout with-detail">
  <!-- ══════════════════ 左栏：沉淀任务列表 ══════════════════ -->
  <ListPane
    countLabel={$t('crystallize.listCount', { n: String(drafts.length) })}
    searchPlaceholder={$t('crystallize.searchPlaceholder')}
    filter={filter}
    onFilter={(v) => (filter = v)}
    loading={loading && drafts.length === 0}
    loadError={loadError}
    empty={!filter && drafts.length === 0}
    emptyTitle={$t('crystallize.listEmptyTitle')}
    emptyHint={$t('crystallize.listEmptyHint')}
    emptyFiltered={filter !== '' && filtered.length === 0}
    emptyFilteredTitle={$t('crystallize.listEmptyTitle')}
    emptyFilteredHint={$t('crystallize.listEmptyHint')}
  >
    {#snippet top()}
      <!-- 新建沉淀：选来源对话/任务再进入目标步骤（使用者定稿：本页可新建）。 -->
      <div class="crystal-list-actions">
        <button class="primary small" onclick={() => void openPicker()}>
          {$t('crystallize.newEntry')}
        </button>
      </div>
    {/snippet}
    {#snippet loadingSkeleton()}
      <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
      <div class="skeleton" style="width:70%"></div>
    {/snippet}
    {#snippet rows()}
      <ul class="crystal-draft-list">
        {#each filtered as row (row.runId)}
          {@render rowItem(row)}
        {/each}
      </ul>
    {/snippet}
  </ListPane>

  <!-- ══════════════════ 右栏：流程页 / 空态 ══════════════════ -->
  {#if $crystallize !== null}
    <CrystallizeView
      runId={$crystallize.runId}
      sourceLabel={selectedLabel}
      onback={() => go('crystallize')}
      ondone={() => reloadQuiet()}
    />
  {:else}
    <MainArea
      empty={true}
      emptyTitle={$t('crystallize.pickHint')}
      emptyHint={$t('crystallize.listEmptyHint')}
    >
      {#snippet body()}
        <p class="faint">{$t('crystallize.listEmptyHint')}</p>
      {/snippet}
    </MainArea>
  {/if}
</div>

<!-- ══════════════════ 新建沉淀：来源选择器 ══════════════════ -->
{#if pickOpen}
  <div class="crystal-picker-backdrop" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) pickOpen = false }}>
    <div class="crystal-picker" role="dialog" aria-modal="true" tabindex="-1">
      <header class="crystal-picker-head">
        <strong>{$t('crystallize.pickTitle')}</strong>
        <span class="faint small">{$t('crystallize.pickHint')}</span>
        <button class="ghost small" onclick={() => (pickOpen = false)}>{$t('crystallize.cancel')}</button>
      </header>
      {#if sourcesLoading}
        <div class="pane-body"><div class="skeleton"></div></div>
      {:else if sourcesError}
        <div class="pane-body"><p class="err-text">{$t('crystallize.errTargets', { error: sourcesError })}</p></div>
      {:else}
        <div class="crystal-picker-groups">
          <section>
            <h4>{$t('crystallize.scopeConversation')}</h4>
            {#if convSources.length === 0}
              <p class="faint small">{$t('crystallize.pickNoConversations')}</p>
            {:else}
              <ul>
                {#each convSources as s (s.id)}
                  <li>
                    <button class="crystal-pick-row" onclick={() => pick(s)}>
                      <span class="crystal-pick-label" title={s.label}>{s.label}</span>
                      <span class="faint small">{s.turns !== null ? $t('crystallize.pickTurns', { turns: String(s.turns) }) : ''}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
          <section>
            <h4>{$t('crystallize.scopeTask')}</h4>
            {#if taskSources.length === 0}
              <p class="faint small">{$t('crystallize.pickNoTasks')}</p>
            {:else}
              <ul>
                {#each taskSources as s (s.id)}
                  <li>
                    <button class="crystal-pick-row" onclick={() => pick(s)}>
                      <span class="crystal-pick-label" title={s.label}>{s.label}</span>
                      <span class="faint small">{$t('crystallize.reviewedYes')}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        </div>
      {/if}
    </div>
  </div>
{/if}

{#snippet rowItem(row: DraftRow)}  <li>
    <button
      class="crystal-draft-row"
      class:active={$crystallize?.runId === row.runId}
      onclick={() => goCrystallize(row.runId)}
    >
      <span class="crystal-draft-main">
        <span class="crystal-draft-title" title={sourceLabel(row)}>{sourceLabel(row)}</span>
        <span class="crystal-draft-meta">
          <span class="status-tag {statusClass(row.status)}">{statusLabel(row.status)}</span>
          <span class="faint small">{targetLabel(row)}</span>
          <span class="faint small" title={absoluteTime(row.queuedAt)}>{relativeTime(row.queuedAt, now)}</span>
        </span>
      </span>
    </button>
  </li>
{/snippet}

<style>
  .crystal-list-actions {
    padding: var(--sp-2) var(--sp-3) 0;
  }
  .crystal-list-actions button {
    width: 100%;
  }
  .crystal-draft-list {
    list-style: none;
    margin: 0;
    padding: 0 0 var(--sp-3);
  }
  .crystal-draft-row {
    display: block;
    width: 100%;
    text-align: left;
    padding: var(--sp-2) var(--sp-3);
    background: transparent;
    border: none;
    cursor: pointer;
  }
  .crystal-draft-row:hover {
    background: var(--surface-hover);
  }
  .crystal-draft-row.active {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .crystal-draft-main {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .crystal-draft-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .crystal-draft-meta {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: var(--fs-sm);
  }
  .status-tag {
    padding: 1px var(--sp-1);
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
  }
  .status-tag.active {
    color: var(--status-active);
    border-color: color-mix(in srgb, var(--status-active) 40%, transparent);
  }
  .status-tag.done {
    color: var(--status-done);
    border-color: color-mix(in srgb, var(--status-done) 40%, transparent);
  }
  .status-tag.blocked {
    color: var(--status-blocked);
    border-color: color-mix(in srgb, var(--status-blocked) 40%, transparent);
  }

  /* ── 新建沉淀：来源选择器（简单模态） ── */
  .crystal-picker-backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
  }
  .crystal-picker {
    width: min(34rem, 90vw);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    box-shadow: 0 8px 30px rgb(0 0 0 / 0.18);
    overflow: hidden;
  }
  .crystal-picker-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--line);
  }
  .crystal-picker-head .ghost {
    margin-left: auto;
  }
  .crystal-picker-groups {
    overflow-y: auto;
    padding: var(--sp-3) var(--sp-4);
  }
  .crystal-picker-groups section + section {
    margin-top: var(--sp-4);
  }
  .crystal-picker-groups h4 {
    margin: 0 0 var(--sp-2);
    font-size: var(--fs-sm);
    color: var(--text-faint);
  }
  .crystal-picker-groups ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .crystal-pick-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--sp-2);
    width: 100%;
    text-align: left;
    padding: var(--sp-2) var(--sp-3);
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: var(--radius-sm);
  }
  .crystal-pick-row:hover {
    background: var(--surface-hover);
  }
  .crystal-pick-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
