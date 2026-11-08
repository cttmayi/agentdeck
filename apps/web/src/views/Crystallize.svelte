<script lang="ts">
  /**
   * 沉淀页（D80 三轮）——导航列工具之下的独立一页，**沉淀的整个过程在此页进行**。
   *
   * 左栏 = 沉淀任务列表（未入库的起草 run，使用者定稿：已入库的不显示），
   * 点一条右栏进入它的流程页（地址 `#/crystallize/<runId>`——切页回来 / 刷新 /
   * 分享链接都还在）；右上角「新建沉淀」（顶栏主操作，与「新对话」「新建任务」
   * 同位置同款）选来源对话/任务再进入目标步骤。
   *
   * 入口：聊天页 / 任务页的「沉淀技能&智能体」按钮跳到这一页并选中对应
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
   *   · 起点（选来源 / 从空白起）不再是浮层，而是 `#/crystallize/new` 页面里的第一问（U4b）。
   *   · 主操作放顶栏（`setPageActions`），不在列表顶上自插一条按钮——
   *     聊天「新对话」、任务「新建任务」都在顶栏那一格。
   */
  import { onMount, onDestroy } from 'svelte'
  import { t } from '../lib/i18n.ts'
  import { loadSkills } from '../lib/stores.ts'
  import { api } from '../lib/api.ts'
  import { absoluteTime, relativeTime } from '../lib/time.ts'
  import { crystallizeState, crystallizeStateClass, crystallizeStateKey } from '../lib/crystallize-state.ts'
  import { crystallize, go, goCrystallize } from '../lib/view.ts'
  import { clearPageActions, setPageActions } from '../lib/page-actions.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import { showToast } from '../lib/view.ts'
  import ListPane from '../components/ListPane.svelte'
  import ListRow from '../components/ListRow.svelte'
  import MainArea from '../components/MainArea.svelte'
  import CrystallizeView from '../components/CrystallizeView.svelte'
  import CrystallizeArtifactPane from '../components/CrystallizeArtifactPane.svelte'
  import CrystallizeSettings from '../components/CrystallizeSettings.svelte'

  /**
   * GET /api/crystallize/drafts 的行 —— ★ 分批第 17 批起**一行一个沉淀任务**（不是一版一行）。
   *
   * 使用者判定：「给意见后点重新起草，新增加了一个沉淀任务，而不是在原沉淀任务中执行」。
   * 服务端按"同一来源 + 同一目标"分好组，这里只负责显示版本数与"点进去落在最新那一版"。
   */
  interface DraftRow {
    /** 最新那一版的 run id（点进去落在它上面）。 */
    runId: string
    /** 这个任务的第一版那条 run（任务目录以它命名）。 */
    taskRunId: string
    /** 最新那一版是第几版（1 起）。 */
    version: number
    /** 这个任务的全部版本 run id（停在历史版本上也能认出"这是哪一行"）。 */
    versionRunIds: string[]
    status: string
    queuedAt: number
    target: { kind: 'new' } | { kind: 'update'; skillId: string } | null
    source: { kind: 'conversation' | 'issue'; label: string } | null
    /**
     * ★ 分批第 133 批：「从空白/材料起」的沉淀任务（**没有来源 run**）。
     * 与 `source === null`（源 run 被删了）分开说——两件事在界面上是不同的说法。
     */
    startFromBlank?: boolean
  }

  let drafts: DraftRow[] = []
  let loading = false
  let loadError: string | null = null
  let now = Date.now()
  let filter = ''

  /** 列表行目标摘要：新建 / 更新 <slug>。 */
  function targetLabel(row: DraftRow): string {
    if (row.target === null) return $t('crystallize.rowNew')
    if (row.target.kind === 'new') return $t('crystallize.rowNew')
    return $t('crystallize.rowUpdate', { slug: row.target.skillId })
  }

  /** 起草 run → 沉淀任务状态（待审阅 ≠ 已完成，见 lib/crystallize-state.ts）。 */
  function stateOf(row: DraftRow): ReturnType<typeof crystallizeState> {
    return crystallizeState(row.status)
  }

  /**
   * 列表行来源摘要：来源类型 + 标题（源 run 丢了时兜底）。
   *
   * ⚠️ 2026-10-21 修：标签是空串时原来的写法会渲染成「任务 **·**」——分隔符后面什么都没有，
   *    一行标题就剩一个孤零零的点（探针夹具里量到过；真实场景＝来源 run 被删、标题取不到）。
   *    分隔符**只在真有标题时**才拼。
   */
  function sourceLabel(row: DraftRow): string {
    if (row.startFromBlank === true) return '空白起'
    if (row.source === null) return $t('crystallize.sourceUnknown')
    const kind =
      row.source.kind === 'conversation'
        ? $t('crystallize.scopeConversation')
        : $t('crystallize.scopeTask')
    const label = row.source.label.trim()
    return label === '' ? kind : `${kind} · ${label}`
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

  /**
   * 流程页入库完成：草稿从列表消失，**技能库里多了一条（或改了一条）**。
   *
   * ★ 分批第 237 批（使用者："我新入库的 SKILL，必须要重新刷新才可以看到，不合理"）：
   *   这里原来只重拉**沉淀列表**，于是"入库"这件写操作在别的页面上看不见——
   *   「技能」页读的是启动时载入的那张共享表（`$skills`），新对话的执行者下拉也读它。
   *   一次入库是**库变了**，不是只有这一页的列表变了。
   */
  function reloadQuiet(): void {
    void refresh()
    void loadSkills()
  }

  /**
   * 放弃一条起草（沉淀任务）。
   *
   * ★ 三轮：起草 run 完成 ≠ 沉淀完成，没入库的草稿原来**没有出口**——旧版流程页的
   * 「放弃」只重置本地状态，草稿仍在库里、仍在左栏（使用者看到"很多沉淀任务标注
   * 已完成、实际没完成"）。这里给列表一个真出口：先确认，再让服务端打
   * `discarded`（还在跑会先停），然后刷新列表。
   */
  async function discard(row: DraftRow): Promise<void> {
    if (
      !(await askConfirm({
        title: $t('crystallize.discard'),
        message: $t('crystallize.discardConfirm', { label: sourceLabel(row) }),
        confirmLabel: $t('crystallize.discard'),
        danger: true,
      }))
    )
      return
    try {
      await api('/api/crystallize/discard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId: row.runId }),
      })
      // 正开着的那条被放弃了 ⇒ 右栏回到空态（地址也回列表）
      if ($crystallize?.runId === row.runId) go('crystallize')
      showToast($t('crystallize.discarded'))
      void refresh()
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * ★ 分批第 147 批（§12.14："两处必须由同一份数据现算，否则必漂"）：材料被改过的计数。
   *
   * 材料在两处显示——中间那栏的「依据」块（`CrystallizeView`）与右栏产物栏的材料清单
   * （`CrystallizeArtifactPane`）——数据都来自 `GET /api/crystallize/material`。谁改了都把这
   * 个数 +1，另一边读到就重拉：一处显示"追加了/删掉了"、另一处还是旧的，使用者只会以为
   * 操作没生效。
   */
  let materialRev = 0

  /**
   * ★ 分批第 171 批（使用者："能从中间消息拿宽度，改成可动态调节"）：**产物栏宽度可拖**。
   *
   * 为什么不是写死一个更宽的值：右栏装的是编辑器（树 + 正文），中间那栏装的是消息流，
   * "多宽才够"取决于这一刻在干什么——改 SKILL.md 时要宽，看日志时要窄。试过写死 26–32rem，
   * 中间那栏被挤到 352px，结论条从 y=704 掉到 1397（探针当场红）。所以给别人一个把手。
   *
   * 存 `localStorage`（键固定）：它是"我的窗口多大、我习惯多宽"，换条草稿不该重置。
   */
  const ARTIFACT_W_KEY = 'agentdeck.crystallize.artifactW'
  const ARTIFACT_W_MIN = 320
  const ARTIFACT_W_MAX = 760
  const clampW = (px: number): number => Math.min(ARTIFACT_W_MAX, Math.max(ARTIFACT_W_MIN, px))
  let artifactW = (() => {
    try {
      const raw = Number(localStorage.getItem(ARTIFACT_W_KEY))
      return Number.isFinite(raw) && raw >= ARTIFACT_W_MIN ? clampW(raw) : 448
    } catch {
      return 448
    }
  })()

  /**
   * 拖动把手：`pointerdown` 记起点，`pointermove` 换算成宽度（**反向**：鼠标左移 ⇒ 栏变宽），
   * `pointerup` 收尾并存档。⚠️ 监听挂在 `window` 上：拖动时鼠标很快离开那个 8px 的把手，
   * 挂在把手上会"拖一下就断"。
   */
  function startResize(event: PointerEvent): void {
    event.preventDefault()
    const startX = event.clientX
    const startW = artifactW
    const move = (ev: PointerEvent): void => {
      artifactW = clampW(startW - (ev.clientX - startX))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem(ARTIFACT_W_KEY, String(artifactW))
      } catch {
        // 存不上不影响用（下次开是默认值）
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const bumpMaterial = (): void => {
    materialRev += 1
  }

  /** 当前选中条目的来源标签（流程页副题）。 */
  // ⚠️ 按**任务**匹配，不是按"最新那一版"匹配：深链可以停在历史版本上（那一条 id 不是任何行的
  //    `runId`）⇒ 只比 `runId` 会读不到来源标签、那一行也不高亮。
  $: viewedRow = drafts.find((d) => d.versionRunIds.includes($crystallize?.runId ?? ''))
  $: selectedLabel = viewedRow?.source?.label ?? ''

  // ★ 顶栏主操作：与聊天「新对话」、任务「新建任务」同一格、同一款（primary）。
  //   标签读 `$t(...)` 放在 `$:` 里 ⇒ 切语言时自动重新登记（setPageActions 是整体覆盖）。
  $: setPageActions('crystallize', [
    {
      id: 'new',
      label: $t('crystallize.newEntry'),
      kind: 'primary',
      icon: 'plus',
      // ★ 分批第 141 批（U4b，§12.7）：**「新建沉淀」不再弹 Modal**——起点变成页面内的第一问
      //   （`#/crystallize/new`：选一个来源，或从空白/材料起）。删掉 Modal 是因为它把
      //   "从哪开始"做成了流程页外面的一个动作；对话式页面里，这件事就该是一条消息。
      onActivate: () => goCrystallize('new'),
    },
    {
      id: 'settings',
      // ★ 分批第 175 批（使用者：把一键安装放进"沉淀设置"）：设置是路由 `#/crystallize/settings`。
      label: $t('crystallize.settingsEntry'),
      kind: 'ghost',
      onActivate: () => goCrystallize('settings'),
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
  /**
   * 选中的那条沉淀对应的列表行（产物栏要它的"第 N 版"）。
   *
   * ⚠️ 用电 `versionRunIds.includes(...)` 判，而不是 `runId === ...`：点进来可能停在
   *   历史某一版上（`row.runId` 只是最新那版），而列表行是**一条沉淀一行**。
   */
  $: selectedRow = filtered.find((r) => r.versionRunIds.includes($crystallize?.runId ?? '')) ?? null
</script>

<div
  class="split-layout with-detail"
  class:with-artifact={$crystallize !== null}
  style="--artifact-w:{artifactW}px"
>
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
            active={row.versionRunIds.includes($crystallize?.runId ?? '')}
            onclick={() => goCrystallize(row.runId)}
          >
            {#snippet children()}
              <!-- 标题单行省略 + `title` 兜底（与聊天/任务列表同一条：列表是用来扫的） -->
              <span class="crystal-title" title={sourceLabel(row)}>{sourceLabel(row)}</span>
              <span class="crystal-meta">
                <!-- ★ 这一格是**沉淀任务**的状态，不是起草 run 的状态：
                     run 跑完只说明草稿写出来了，活还没完（要审阅、要入库）——
                     显示 run 的「已完成」会让使用者以为已经沉淀完了（见
                     lib/crystallize-state.ts 顶部那段）。 -->
                <span class="badge {crystallizeStateClass(stateOf(row))}">{$t(crystallizeStateKey(stateOf(row)))}</span>
                <!-- ★ 分批第 174 批（使用者："第 N 版只是统计吗，没用就先不用显示"）：**去掉了**。
                     `version` 是"这个沉淀任务里有几版"的计数，**没有任何行为依赖它**
                     （快照/差异/回滚都按 run id 走，不按序号）⇒ 只当装饰的话就是噪音。 -->

                <span class="faint fs-xs">{targetLabel(row)}</span>
                <span class="faint fs-xs" title={absoluteTime(row.queuedAt)}
                  >{relativeTime(row.queuedAt, now)}</span
                >
              </span>
            {/snippet}
            {#snippet action()}
              <!-- 右侧动作钮：与聊天/任务的删除钮同一格同一款（默认几乎不可见，
                   hover 才露出）。没入库的草稿要能收尾，否则左栏只增不减。 -->
              <button
                type="button"
                class="list-row-action"
                title={$t('crystallize.discard')}
                aria-label={$t('crystallize.discard')}
                onclick={() => void discard(row)}
              >
                ×
              </button>
            {/snippet}
          </ListRow>
        {/each}
      </ul>
    {/snippet}
  </ListPane>

  <!-- ══════════════════ 右栏：流程页 / 空态 ══════════════════ -->
  {#if $crystallize !== null && $crystallize.runId === 'settings'}
    <CrystallizeSettings onback={() => go('crystallize')} />
  {:else if $crystallize !== null}
    <CrystallizeView
      runId={$crystallize.runId}
      sourceLabel={selectedLabel}
      materialRev={materialRev}
      onmaterialchange={bumpMaterial}
      onback={() => go('crystallize')}
      ondone={() => reloadQuiet()}
    />
    <!-- ★ 分批第 92 批：产物提成常驻的第三列（设计 §12.3）。U1 只搬位置，
         数据仍走 `GET /api/crystallize/artifacts`——与流程页同一份产出与同一份校验。
         ★ 分批第 147 批：材料可以在这里删（只有使用者给的），删完把 `materialRev` +1，
           中间那栏的「依据」跟着重读。 -->
    <!-- ★ 分批第 171 批：右栏宽度可拖。把手贴在右栏的左缘（绝对定位在网格上），
         拖的是 `--artifact-w`（界面里唯一使用它的地方）——不引入第二套宽度来源。 -->
    <button
      type="button"
      class="pane-resizer"
      aria-label={$t('crystallize.artifactResize')}
      title={$t('crystallize.artifactResize')}
      onpointerdown={startResize}
    ></button>
    <CrystallizeArtifactPane draftRunId={$crystallize.runId} />
  {:else}
    <MainArea empty={true} emptyTitle={$t('crystallize.pickHint')} emptyHint={$t('crystallize.listEmptyHint')}>
      {#snippet body()}
        <p class="faint">{$t('crystallize.listEmptyHint')}</p>
      {/snippet}
    </MainArea>
  {/if}
</div>

<!-- ★ 分批第 141 批（U4b）：来源选择器 Modal 已删——起点变成 `#/crystallize/new` 的第一问
     （§12.7「明确删掉的东西」：新建沉淀 Modal）。 -->

<style>
  /* 可拖的产物栏宽度（分批第 171 批）：把手 8px 宽，贴在右栏左缘；拖动时整页别选中文字 */
  .split-layout {
    position: relative;
  }

  .pane-resizer {
    position: absolute;
    top: 0;
    bottom: 0;
    right: calc(var(--artifact-w, 28rem) - 4px);
    width: 8px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: col-resize;
    z-index: 5;
  }

  .pane-resizer:hover {
    background: var(--line-strong);
  }

  /* 窄屏（右栏变抽屉）时没有"两栏之间"这回事，把手不显示 */
  @media (max-width: 73.99rem) {
    .pane-resizer {
      display: none;
    }
  }

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

</style>
