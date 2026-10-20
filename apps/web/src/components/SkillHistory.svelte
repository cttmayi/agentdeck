<script lang="ts">
  /**
   * 「历史（git）」——技能页展开行里的那一节（P2，§7.4）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它解决的是哪件事
   * ══════════════════════════════════════════════════════════════════
   *
   * `skills-mine` 从 D80 起就是 git 仓库（每次沉淀/进化一条 commit），历史一直
   * 在那儿——但**没有入口**，于是"更新之后看不出改了什么"，进化等于盲签。
   * 这一节把入口做出来：列出提交 ⇒ 选中一条 ⇒ 看它相对**上一版**的逐文件差异。
   *
   * ══════════════════════════════════════════════════════════════════
   * 三条判断写在前面（都是"少写一句就会误导"的那种）
   * ══════════════════════════════════════════════════════════════════
   *
   *   · **差异由后端算**（`/compare`）：这里只渲染。前端再算一遍必然漂，而漂的
   *     表现是同一份改动在两处显示成不同行数——最难查的一种错。
   *   · **"还没有历史"与"版本管理未启用"是两句不同的话**：前者是这条技能还没沉淀
   *     入库过，后者是系统没有 git（设计 §7.3.1 说的**正常状态**）。合成一句会让
   *     使用者去装 git，而他的技能其实只是刚建。
   *   · **首次入库那一版对比的是空目录**（`from=empty`）：最早那条 commit 没有
   *     "上一版"，但"新建了什么"恰恰是最该看得见的一眼——不能显示成"没有可看的"。
   *
   * ⚠️ 懒加载：历史要 spawn git，只有展开行打开、且这一节被点开时才去取
   *    （列表里十几条技能，不能每条都发一次请求）。
   */
  import { onMount } from 'svelte'
  import { api } from '../lib/api.ts'
  // ⚠️ `t` 是 store（模板里用 `$t`），`tx` 是**命令式**版本（脚本里用）——
  //    第一版在 `changeLabel` 里直接写 `t(...)`，svelte-check 报
  //    "This expression is not callable" ×10（store 不是函数）。
  import { t, tx } from '../lib/i18n.ts'
  import { relativeTime } from '../lib/time.ts'
  import { FoldSection } from '@agentdeck/ui/components'

  /** 技能（只要 id / slug / source——历史只对 `source: 'mine'` 有意义）。 */
  export let skill: { id: string; slug: string; source?: string }

  interface Entry {
    rev: string
    short: string
    when: string
    message: string
  }
  interface FileRow {
    rel: string
    change: 'A' | 'M' | 'D' | 'same'
    added: number
    removed: number
    hunks: Array<{
      oldStart: number
      newStart: number
      lines: Array<{ kind: 'add' | 'del' | 'ctx'; text: string }>
    }>
  }

  let state: 'idle' | 'loading' | 'ready' = 'idle'
  let entries: Entry[] = []
  /** `available:false` 时的理由（"没有 git" 或 "这条技能不是提炼来的"）。 */
  let offReason: string | null = null
  let selectedRev: string | null = null
  let rows: FileRow[] = []
  let rowsError: string | null = null
  let rowsLoading = false

  /**
   * 挂载时取一次历史。
   *
   * ⚠️ 为什么不是"点开折叠时才取"：`FoldSection` 只有
   *    `title / summary / open / children` 四个 props（**没有** onToggle），而
   *    "折叠着就不渲染"是它自己的事——拿不到那个时机。所幸这个组件本来就是
   *    **行展开之后**才挂载的（列表里十几条技能不会各发一次请求），所以挂载时
   *    取一次就是懒加载。
   */
  async function loadOnce(): Promise<void> {
    if (state !== 'idle') return
    state = 'loading'
    try {
      const got = await api<
        { available: true; entries: Entry[] } | { available: false; reason: string }
      >(`/api/skills/${encodeURIComponent(skill.id)}/history`)
      if (got.available) {
        entries = got.entries
        offReason = null
      } else {
        entries = []
        offReason = got.reason
      }
      state = 'ready'
      // 默认选中最新那一版：打开这一节的人想问的通常是"最近改了什么"
      if (entries.length > 0) void select(entries[0]!)
    } catch (err) {
      offReason = err instanceof Error ? err.message : String(err)
      state = 'ready'
    }
  }

  /**
   * 选中一条：算它**相对上一版**的差异。
   *
   * ⚠️ 「上一版」= 列表里的**下一条**（历史是新的在前）。最早那条没有下一条 ⇒
   *    基线用 `empty`（空目录 = 全部新增），而不是"没有上一版可看"。
   */
  async function select(entry: Entry): Promise<void> {
    selectedRev = entry.rev
    rowsLoading = true
    rowsError = null
    rows = []
    const idx = entries.findIndex((e) => e.rev === entry.rev)
    const previous = idx >= 0 ? entries[idx + 1] : undefined
    const from = previous ? previous.rev : 'empty'
    try {
      const got = await api<
        { available: true; files: FileRow[] } | { available: false; reason: string }
      >(
        `/api/skills/${encodeURIComponent(skill.id)}/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(entry.rev)}`,
      )
      if (got.available) {
        // `same` 的文件不占地方（这一节要回答的是"改了什么"）
        rows = got.files.filter((f) => f.change !== 'same')
      } else {
        rowsError = got.reason
      }
    } catch (err) {
      rowsError = err instanceof Error ? err.message : String(err)
    } finally {
      rowsLoading = false
    }
  }

  onMount(() => {
    void loadOnce()
  })

  function changeLabel(change: FileRow['change']): string {
    if (change === 'A') return tx('crystallize.changeAdded')
    if (change === 'D') return tx('crystallize.changeDeleted')
    return tx('crystallize.changeModified')
  }
</script>

<FoldSection title={$t('skills.historyTitle')}>
  {#if state === 'loading'}
    <p class="faint small">{$t('skills.historyLoading')}</p>
  {:else if offReason !== null}
    <!-- "版本管理未启用：<理由>"——理由必须原样带出来（是"没有 git"还是别的） -->
    <p class="faint small">{$t('skills.historyOff', { reason: offReason })}</p>
  {:else if entries.length === 0}
    <p class="faint small">{$t('skills.historyEmpty')}</p>
  {:else}
    <p class="faint small history-hint">{$t('skills.historyPickHint')}</p>
    <ul class="history-list">
      {#each entries as entry, i (entry.rev)}
        <li>
          <button
            type="button"
            class="history-row"
            class:active={selectedRev === entry.rev}
            onclick={() => void select(entry)}
          >
            <code class="rev">{entry.short}</code>
            <span class="msg">{entry.message}</span>
            <!-- 列表用相对时间、准确时间放 `title`（全站约定）；这里 title 直接用 git
                 给的 ISO 串——提交时间是"要能精确到分秒"的那种信息（核对"哪次改的"）。
                 ⚠️ `relativeTime` 要两个参数（`at, now`）：第一版只传了时间戳，
                 svelte-check 报 "Expected 2 arguments, but got 1"。 -->
            <span class="faint small when" title={entry.when}
              >{relativeTime(entry.when, Date.now())}</span
            >
            {#if i === entries.length - 1}
              <!-- 最早那条：它对比的是空目录，说清楚免得被读成"改了什么" -->
              <span class="faint small first">{$t('skills.historyFirstVersion')}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>

    {#if selectedRev !== null}
      <div class="rev-diff">
        {#if rowsLoading}
          <p class="faint small">{$t('skills.historyLoading')}</p>
        {:else if rowsError !== null}
          <div class="notice warn">{$t('skills.historyCompareFailed', { reason: rowsError })}</div>
        {:else if rows.length === 0}
          <p class="faint small">{$t('skills.historyNoChanges')}</p>
        {:else}
          <p class="faint small">{$t('skills.historyChanges', { n: rows.length })}</p>
          {#each rows as row (row.rel)}
            <div class="file-diff">
              <div class="file-head">
                <span class="change" class:add={row.change === 'A'} class:del={row.change === 'D'}>
                  {changeLabel(row.change)}
                </span>
                <code>{row.rel}</code>
                <span class="faint small counts">+{row.added} −{row.removed}</span>
              </div>
              {#each row.hunks as hunk (hunk.oldStart + ':' + hunk.newStart)}
                <div class="hunk-head">@@ −{hunk.oldStart} +{hunk.newStart} @@</div>
                {#each hunk.lines as line (line.kind + line.text + Math.random())}
                  <div
                    class="diff-line"
                    class:add={line.kind === 'add'}
                    class:del={line.kind === 'del'}
                  >
                    {line.text}
                  </div>
                {/each}
              {/each}
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  {/if}
</FoldSection>

<style>
  /* 提交列表：一条一行，整行可点（与全站"整行可点"一致）。
     时间在右、消息可折行——提交消息是我们自己写的，长起来会很长。 */
  .history-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .history-row {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    padding: var(--sp-2);
    background: none;
    border: 1px solid transparent;
    border-radius: var(--r-2, 6px);
    text-align: left;
    cursor: pointer;
  }
  .history-row:hover {
    background: var(--surface-2);
  }
  .history-row.active {
    border-color: var(--accent);
  }
  .rev {
    flex: none;
  }
  .msg {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .when,
  .first {
    flex: none;
  }
  .rev-diff {
    margin-top: var(--sp-3);
  }
  .file-diff {
    margin-top: var(--sp-3);
    border: 1px solid var(--line);
    border-radius: var(--r-2, 6px);
    overflow: hidden;
  }
  .file-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2);
    background: var(--surface-2);
    flex-wrap: wrap;
  }
  .change {
    flex: none;
    padding: 0 var(--sp-1);
    border-radius: var(--r-1, 4px);
    border: 1px solid var(--line);
  }
  .change.add {
    color: var(--ok, #2a7);
  }
  .change.del {
    color: var(--bad, #c33);
  }
  .counts {
    margin-left: auto;
  }
  /* 逐行差异：等宽、行号不在（这一节回答"改了什么"，不要求逐行追溯） */
  .hunk-head,
  .diff-line {
    font-family: var(--font-mono);
    font-size: var(--fs-small);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 0 var(--sp-2);
  }
  .hunk-head {
    color: var(--fg-faint);
    background: var(--surface-2);
  }
  .diff-line.add {
    background: color-mix(in srgb, var(--ok, #2a7) 12%, transparent);
  }
  .diff-line.del {
    background: color-mix(in srgb, var(--bad, #c33) 12%, transparent);
  }
</style>
