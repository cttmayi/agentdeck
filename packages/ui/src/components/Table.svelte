<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { TableColumn } from './table-types.ts'

  /**
   * 数据表壳（2026-11 抽进 `@agentdeck/ui`，两个前端共 5 张数据表共用）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么抽的是"壳"而不是"通用网格"
   * ══════════════════════════════════════════════════════════════════
   *
   * 5 张表（web 技能主表 / web 远端目录表 / web 工具表 / remote 技能表 /
   * remote 工具表）的**列集合各不相同**（slug/version/files/synced vs
   * group/name/actionCount/source/updated…），行形态也不同（web 主表有 chevron
   * 展开行、remote 没有）。这正是"差异是真差异，硬抽会把差异塞回 props 和插槽"
   * 的那条教训——所以：
   *
   *   · **壳进组件**：`.table-wrap` + `<table>` + thead（`scope="col"` 给读屏器、
   *     操作列用 `aria-label` 起名——这两条无障碍约定 5 处各写一遍，迟早有人
   *     漏一处）+ `<tbody>`；
   *   · **内容进 snippet**：`rows` 由页面给（行标记类如 `tool-row` / `skill-slug`
   *     保留，探针依赖它们）。
   *
   * ⚠️ 探针兼容：行类名、`.expand-toggle`、`.tool-table` 等选择器不能动。
   */

  let {
    columns,
    rows,
    tableClass = '',
  }: {
    columns: TableColumn[]
    rows: Snippet
    tableClass?: string
  } = $props()
</script>

<div class="table-wrap">
  <table class={tableClass}>
    <thead>
      <tr>
        {#each columns as col (col.label + (col.ariaLabel ?? ''))}
          <th scope="col" aria-label={col.ariaLabel}>{col.label}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {@render rows()}
    </tbody>
  </table>
</div>
