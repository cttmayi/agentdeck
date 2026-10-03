<script lang="ts">
  /**
   * 行内展开按钮（chevron）——web 技能主表与工具主表同一份（2026-11 抽进
   * `@agentdeck/ui`）。
   *
   * ★ 用**真按钮**（不是 `onclick` 挂整行）：tab 能到、读屏器能读、
   *   `aria-expanded` 能报状态——整行可点对键盘用户是死的。
   *
   * ⚠️ 探针兼容：`.expand-toggle` / `.chevron` 类名与 `aria-expanded` 不能动。
   */
  let {
    expanded,
    labelExpand,
    labelCollapse,
    onclick,
  }: {
    expanded: boolean
    labelExpand: string
    labelCollapse: string
    onclick: () => void
  } = $props()
</script>

<button
  type="button"
  class="expand-toggle"
  aria-expanded={expanded}
  aria-label={expanded ? labelCollapse : labelExpand}
  onclick={onclick}
>
  <span class="chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
</button>
