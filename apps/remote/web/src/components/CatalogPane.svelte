<script lang="ts">
  import { get } from 'svelte/store'
  import type { Snippet } from 'svelte'
  import { Table, type TableColumn } from '@agentdeck/ui/components'
  import { pendingConfirm } from '../lib/confirm.ts'

  /**
   * 目录页的**壳**（远端管理页的技能 / 工具两页共用，2026-11）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它装什么、不装什么
   * ══════════════════════════════════════════════════════════════════
   *
   * 两页相同的部分：加载 / 错误 / 空 / 就绪四态、标题行、`Table` 壳、表格底部
   * 那句说明、详情抽屉的骨架（遮罩 + 头部 + 滚动正文）、Esc 关抽屉（且确认框
   * 开着时不抢 Esc）。
   *
   * 两页不同的部分（留在各自视图里）：技能页的同步按钮 / 状态 / 安装表单 /
   * 清单行，以及两页各自的**行**与**抽屉正文**——都走 snippet，由页面给。
   *
   * ⚠️ 文案（loading / retry / close / empty / titleCount / footer）全部由页面
   *    拼好传入：本组件不依赖任何文案表（webText / remoteText 有意分开）。
   * ⚠️ 探针兼容：`.table-wrap` / `.drawer-backdrop` / `.drawer.wide` /
   *    `.drawer-head` / `.drawer-body` / `.file-text` 结构不能动。
   */
  let {
    loading,
    error,
    empty,
    titleCount,
    columns,
    footer,
    loadingText,
    retryText,
    closeText,
    onretry,
    /** 空字符串 = 抽屉关着；非空 = 抽屉开着，同时是 `h2` 与 `aria-label`。 */
    detailTitle = '',
    /** 抽屉里标题下面那一行小字（来源等）；没有就不画。 */
    detailRef = '',
    onclose,
    rows,
    drawerBody,
  }: {
    loading: boolean
    error: string
    /** 空态文案；空字符串 = 目录不空（有行要画）。 */
    empty: string
    /** 表格上方「标题 · 共 N 条」那半句（含 ` · `，由页面拼好）。 */
    titleCount: string
    columns: TableColumn[]
    /** 表格底部那句说明（"去哪装 / 来自仓库"）。 */
    footer: string
    loadingText: string
    retryText: string
    closeText: string
    onretry: () => void
    detailTitle?: string
    detailRef?: string
    onclose: () => void
    rows: Snippet
    drawerBody: Snippet
  } = $props()

  /**
   * Esc 关抽屉——与 daemon 那边的抽屉同一条习惯（探针断言了这一条）。
   * ⚠️ 确认框开着时**不动抽屉**：那时 Esc 该关的是确认框（`ConfirmDialog` 自己
   *    处理），否则一次 Esc 会把两样一起关掉。
   */
  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return
    if (get(pendingConfirm) !== null) return
    onclose()
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if loading}
  <p class="faint">{loadingText}</p>
{:else if error}
  <div class="notice bad">
    {error}
    <p class="faint small" style="margin:var(--sp-2) 0 0">
      <button type="button" class="small" onclick={onretry}>{retryText}</button>
    </p>
  </div>
{:else if empty}
  <div class="empty">{empty}</div>
{:else}
  <p class="faint small">{titleCount}</p>
  <!-- ★ snippet 直接按属性转给 Table（`rows={rows}`）：重新 `{#snippet}` 一层
       反而会遮蔽同名 prop，得不偿失。 -->
  <Table {columns} rows={rows} />
  <p class="faint small" style="margin-top:var(--sp-3)">{footer}</p>
{/if}

{#if detailTitle !== ''}
  <div class="drawer-backdrop" role="presentation" onclick={onclose}></div>
  <div class="drawer wide" role="dialog" aria-modal="true" aria-label={detailTitle}>
    <div class="drawer-head">
      <h2>{detailTitle}</h2>
      <button type="button" class="small" onclick={onclose}>{closeText}</button>
    </div>
    <div class="drawer-body">
      {#if detailRef !== ''}<p class="faint small">{detailRef}</p>{/if}
      {@render drawerBody()}
    </div>
  </div>
{/if}
