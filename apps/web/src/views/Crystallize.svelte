<script lang="ts">
  /**
   * 沉淀页（D80 三轮）——导航列工具之下的独立一页，**沉淀的整个过程在此页进行**。
   *
   * 左栏 = 沉淀任务列表（未入库的起草 run，使用者定稿：已入库的不显示），
   * 点一条右栏进入它的流程页（地址 `#/crystallize/<runId>`——切页回来 / 刷新 /
   * 分享链接都还在）；右上角「新建沉淀」（顶栏主操作，与「新对话」「新建任务」
   * 同位置同款）选来源对话/任务再进入目标步骤。
   *
   * 入口：聊天页「沉淀成 skill」/ 任务页「优化 skill」按钮跳到这一页并选中对应
   * 那条；二轮的旧子路由（`#/chat/crystallize/<runId>`）由 `syncRoute` 重定向过来。
   *
   * 与任务页的关系：起草 run 的 subject 是 `skill-draft`，**不进任务列表**——
   * "沉淀不是任务"（设计 §4.1.1），这条列表是沉淀自己的列表。
   *
   * ★★ 控件纪律（使用者指出"UI 风格和任务差很多"之后重写）：
   *   · 行壳用 `ListRow`（聊天/任务/智能体三页同一副骨架：hover / 选中框 /
   *     行高下限都在它里面）——**不要自己写 `li > button` + 一套行样式**；
   *   · 状态徽标用全局 `.badge` + `lib/run-status.ts` 的映射（与任务详情
   *     的 run 徽标同一份，别自造 `.status-tag`）；
   *   · 选来源的浮层用 `@agentdeck/ui` 的 `Modal`（遮罩 / Esc / 关闭按钮它做一次）；
   *   · 主操作放顶栏（`setPageActions`），不在列表顶上自插一条按钮——
   *     聊天「新对话」、任务「新建任务」都在顶栏那一格。
   */
  import { onMount, onDestroy } from 'svelte'
  import { Modal } from '@agentdeck/ui/components'
  import { t } from '../lib/i18n.ts'
  import { api } from '../lib/api.ts'
  import { absoluteTime, relativeTime } from '../lib/time.ts'
  import { runStatusClass, runStatusKey } from '../lib/run-status.ts'
  import { crystallize, go, goCrystallize } from '../lib/view.ts'
  import { clearPageActions, setPageActions } from '../lib/page-actions.ts'
  import ListPane from '../components/ListPane.svelte'
  import ListRow from '../components/ListRow.svelte'
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
  let filter = ''

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

  /** 流程页入库完成（草稿从列表消失）值得重拉一次。 */
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

  // ★ 顶栏主操作：与聊天「新对话」、任务「新建任务」同一格、同一款（primary）。
  //   标签读 `$t(...)` 放在 `$:` 里 ⇒ 切语言时自动重新登记（setPageActions 是整体覆盖）。
  $: setPageActions('crystallize', [
    {
      id: 'new',
      label: $t('crystallize.newEntry'),
      kind: 'primary',
      icon: 'plus',
      onActivate: () => void openPicker(),
    },
  ])
  onDestroy(() => clearPageActions('crystallize'))

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

  $: filtered = drafts.filter((d) => {
    const q = filter.trim().toLowerCase()
    if (q === '') return true
    return (d.source?.label ?? '').toLowerCase().includes(q)
  })
  $: convSources = sources.filter((s) => s.kind === 'conversation')
  $: taskSources = sources.filter((s) => s.kind === 'task')
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
    {#snippet loadingSkeleton()}
      <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
      <div class="skeleton" style="width:70%"></div>
    {/snippet}
    {#snippet rows()}
      <ul class="crystal-list">
        {#each filtered as row (row.runId)}
          <ListRow
            rowClass="crystal-row"
            active={$crystallize?.runId === row.runId}
            onclick={() => goCrystallize(row.runId)}
          >
            {#snippet children()}
              <!-- 标题单行省略 + `title` 兜底（与聊天/任务列表同一条：列表是用来扫的） -->
              <span class="crystal-title" title={sourceLabel(row)}>{sourceLabel(row)}</span>
              <span class="crystal-meta">
                <span class="badge {runStatusClass(row.status)}">{$t(runStatusKey(row.status))}</span>
                <span class="faint small">{targetLabel(row)}</span>
                <span class="faint small" title={absoluteTime(row.queuedAt)}
                  >{relativeTime(row.queuedAt, now)}</span
                >
              </span>
            {/snippet}
          </ListRow>
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
    <MainArea empty={true} emptyTitle={$t('crystallize.pickHint')} emptyHint={$t('crystallize.listEmptyHint')}>
      {#snippet body()}
        <p class="faint">{$t('crystallize.listEmptyHint')}</p>
      {/snippet}
    </MainArea>
  {/if}
</div>

<!-- ══════════════════ 新建沉淀：来源选择器（共享 Modal） ══════════════════ -->
<Modal
  open={pickOpen}
  title={$t('crystallize.pickTitle')}
  subtitle={$t('crystallize.pickHint')}
  closeLabel={$t('crystallize.cancel')}
  onclose={() => (pickOpen = false)}
>
  {#if sourcesLoading}
    <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
    <div class="skeleton" style="width:70%"></div>
  {:else if sourcesError}
    <p class="err-text">{$t('crystallize.errTargets', { error: sourcesError })}</p>
  {:else}
    <div class="crystal-pick-groups">
      <section>
        <h4>{$t('crystallize.scopeConversation')}</h4>
        {#if convSources.length === 0}
          <p class="faint small">{$t('crystallize.pickNoConversations')}</p>
        {:else}
          <ul class="crystal-list">
            {#each convSources as s (s.id)}
              <ListRow rowClass="crystal-pick-row" onclick={() => pick(s)}>
                {#snippet children()}
                  <span class="crystal-title" title={s.label}>{s.label}</span>
                  <span class="crystal-meta">
                    {#if s.turns !== null}
                      <span class="faint small"
                        >{$t('crystallize.pickTurns', { turns: String(s.turns) })}</span
                      >
                    {/if}
                  </span>
                {/snippet}
              </ListRow>
            {/each}
          </ul>
        {/if}
      </section>
      <section>
        <h4>{$t('crystallize.scopeTask')}</h4>
        {#if taskSources.length === 0}
          <p class="faint small">{$t('crystallize.pickNoTasks')}</p>
        {:else}
          <ul class="crystal-list">
            {#each taskSources as s (s.id)}
              <ListRow rowClass="crystal-pick-row" onclick={() => pick(s)}>
                {#snippet children()}
                  <span class="crystal-title" title={s.label}>{s.label}</span>
                  <span class="crystal-meta">
                    <span class="faint small">{$t('crystallize.reviewedYes')}</span>
                  </span>
                {/snippet}
              </ListRow>
            {/each}
          </ul>
        {/if}
      </section>
    </div>
  {/if}
</Modal>

<style>
  /* ── 行内容（壳不在这里：hover / 选中框 / 行高下限归 ListRow） ── */
  .crystal-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .crystal-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .crystal-meta {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: var(--fs-sm);
  }

  /* ── 选择器：两组之间留白（Modal 的壳与内滚归共享控件） ── */
  .crystal-pick-groups section + section {
    margin-top: var(--sp-4);
  }
  .crystal-pick-groups h4 {
    margin: 0 0 var(--sp-2);
    font-size: var(--fs-sm);
    color: var(--text-faint);
  }
</style>
