<script lang="ts">
  import { ICONS, type IconId } from '../lib/icons.ts'

  /**
   * 一个小图标（内联 SVG，路径表在 `lib/icons.ts`）。
   *
   * ★ 只做装饰：名字由按钮自己的文字或 `aria-label` 给读屏器，所以这里 `aria-hidden`。
   *   同一个图标在"有文字"和"没文字"两种按钮里都能用——**图标不该携带语义**，
   *   携带语义的话，同一个 ↻ 在两种按钮里就要读成两个不同的名字。
   *
   * ⚠️ 大小与颜色都跟着当前文字色走（`1em` + `currentColor`）：这样它天然随
   *    按钮的 hover / 选中 / 禁用态一起变，不需要为每一种状态再写一遍图标颜色。
   */
  export let name: IconId
</script>

<svg aria-hidden="true" viewBox="0 0 24 24" class="ico">
  {#each ICONS[name] as d (d)}
    <path {d} />
  {/each}
</svg>

<style>
  .ico {
    width: 1em;
    height: 1em;
    fill: none;
    stroke: currentColor;
    /* 与顶栏右边那两个（通知 / 设置）同一套画法：描边 2、圆头圆角 */
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex: none;
  }
</style>
