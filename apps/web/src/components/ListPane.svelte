<script lang="ts">
  /* ════════════════════════════════════════════════════════════════════
     ListPane —— 列表栏的**栏头带 + 主体壳**（D66 标准控件）

     聊天 / 任务（列表模式）/ 智能体的左栏是同一副骨架：
       `pane list-pane` ＞ 单行栏头带（计数 + 搜索，`--list-head-h` 51px）＞
       `pane-body`（加载 / 报错 / 空 / 过滤空 / 行 五态）。
     页面的差异（数据流、行内容、任务的分组与看板）以 snippet 传进来。

     边界：
       · 栏头带**没有标题**（D61~D64 定）：三页同款才像一个整体——"这一栏装的
         是什么"由顶栏页名 + 行内信息承担；看板模式**不走这个组件**（它是另一种
         呈现，栏头有标题说明，见 Tasks 自己的看板分支）。
       · 五态判定由页面算（`loading` / `loadError` / `empty` / `emptyFiltered`
         四个布尔），本组件只按状态渲染——判定依赖每页自己的 store 形状。
       · `rows` 是必给 snippet；`top` / `loadingSkeleton` / `readyTop` / `bottom`
         可选：top = 主体最上方的一块（智能体的环境预检），readyTop = 行之前的一块
         （智能体的「设为默认」失败提示），loadingSkeleton = 各自的加载骨架
         （聊天 1 块 / 任务、智能体 2 块），bottom = 列表阶梯之后的一块
         （智能体的 Runtime 概览，恒显）。
     ════════════════════════════════════════════════════════════════════ */
  import type { Snippet } from 'svelte'

  let {
    countLabel,
    searchPlaceholder,
    filter,
    onFilter,
    loading,
    loadError,
    empty,
    emptyTitle,
    emptyHint,
    emptyFiltered,
    emptyFilteredTitle,
    emptyFilteredHint,
    top,
    loadingSkeleton,
    rows,
    readyTop,
    bottom,
  }: {
    countLabel: string
    searchPlaceholder: string
    filter: string
    onFilter: (v: string) => void
    loading: boolean
    loadError?: string | null
    empty: boolean
    emptyTitle: string
    emptyHint: string
    emptyFiltered: boolean
    emptyFilteredTitle: string
    emptyFilteredHint: string
    top?: Snippet
    loadingSkeleton?: Snippet
    rows: Snippet
    readyTop?: Snippet
    bottom?: Snippet
  } = $props()
</script>

<section class="pane list-pane">
  <!-- 栏头带：三页同款（D61 起）——计数 + 搜索。计数数的是**当前显示**的条数
       （过滤之后），不是仓库里全部。 -->
  <div class="pane-head list-toolbar">
    <span class="faint small">{countLabel}</span>
    <input
      value={filter}
      oninput={(e) => onFilter((e.currentTarget as HTMLInputElement).value)}
      placeholder={searchPlaceholder}
      style="max-width:16rem;align-self:center"
      autocomplete="off"
    />
  </div>
  <div class="pane-body">
    {#if top}{@render top()}{/if}
    {#if loading}
      {#if loadingSkeleton}
        {@render loadingSkeleton()}
      {:else}
        <div class="skeleton" style="height:4rem"></div>
      {/if}
    {:else if loadError}
      <p class="notice bad">{loadError}</p>
    {:else if empty}
      <div class="empty">
        <strong>{emptyTitle}</strong>
        <p class="faint small">{emptyHint}</p>
      </div>
    {:else if emptyFiltered}
      <!-- 有东西、但搜索一个都没命中：说"还没有"是假话——两种空态必须分开说 -->
      <div class="empty">
        <strong>{emptyFilteredTitle}</strong>
        <p class="faint small">{emptyFilteredHint}</p>
      </div>
    {:else}
      {#if readyTop}{@render readyTop()}{/if}
      {@render rows()}
    {/if}
    {#if bottom}{@render bottom()}{/if}
  </div>
</section>

<style>
  /* D66：行栏左右内距统一 `--sp-2`——原来聊天 8px、任务/智能体 24px
     （三页行栏各差 16px）。看板模式不走这个组件，保持全局 `.pane-body` 的内距。 */
  .pane-body {
    padding-left: var(--sp-2);
    padding-right: var(--sp-2);
  }
</style>
