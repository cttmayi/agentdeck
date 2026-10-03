<script lang="ts">
  /**
   * 来源标识（单行省略 + hover 出全文）——remote 技能表、web 远端目录表、
   * web 工具表同一份（2026-11 抽进 `@agentdeck/ui`）。
   *
   * ⚠️ 探针兼容：`.source-ref` 类名（单行省略、`title` 是完整值）不能动。
   */
  let { value }: { value: string } = $props()
</script>

{#if value}
<span class="faint small source-ref" title={value}>{value}</span>
{/if}
