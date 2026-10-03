<script lang="ts">
  /**
   * 折叠区块（D69.9 任务详情重构）——"重要资讯直接展示、非重要资讯折叠"的载体。
   *
   * ★ 头部是**真按钮**（tab 能到、读屏器能读、`aria-expanded` 能报状态）——
   *   与表格的 `ExpandToggle` 同一纪律。
   * ★ `open` 只是**初始值**：区块自己管折叠状态；要按内容复位时由外层用
   *   `{#key}` 重建（任务详情页换任务时就是这样——折叠态不能跟到下一条任务）。
   *   探针兼容：`.fold-section` / `.fold-head` / `.fold-body` 类名与
   *   `aria-expanded` 不能动。
   */
  import type { Snippet } from 'svelte'

  let {
    title,
    summary,
    open = false,
    children,
  }: {
    title: string
    summary?: string
    open?: boolean
    children: Snippet
  } = $props()

  // `open` 只是初始值（刻意不追踪：折叠态归组件自己，复位靠外层 `{#key}`）。
  // eslint-disable-next-line svelte/no-state-referenced-locally
  // svelte-ignore state_referenced_locally
  let isOpen = $state(open)
</script>

<section class="fold-section">
  <button type="button" class="fold-head" aria-expanded={isOpen} onclick={() => (isOpen = !isOpen)}>
    <span class="chevron" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
    <span class="fold-title">{title}</span>
    {#if summary}
      <span class="fold-summary">{summary}</span>
    {/if}
  </button>
  {#if isOpen}
    <div class="fold-body">
      {@render children()}
    </div>
  {/if}
</section>
