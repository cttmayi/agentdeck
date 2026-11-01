<script lang="ts">
  /**
   * 栏脚的**折叠清单**（"这个工作目录里有什么"那块）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么抽成组件（分批第 197 批，使用者点名要一致）
   * ══════════════════════════════════════════════════════════════════
   *
   * 使用者原话：「材料现在在右栏，我想用类似聊天页一样，将工作目录放在「发送」的上方。
   * 可展开显示。关于「发送」一起，用相同的控件，不然不一致」。
   *
   * 聊天页那块叫「工作目录的文件」，沉淀页那块叫「材料」——**同一件事**（"这一轮它手上有什么"），
   * 却各写一套折叠头与样式。现在两边共用这一份：
   *
   *   ▸ 材料 12 项            ← 头部：按钮 + 展开箭头 + 标题 + 计数（+ 右侧动作）
   *     ├ a.md         3 KB
   *     └ b.md         1 KB
   *
   * 几条纪律（都是从聊天页那边搬来的）：
   *   · 头部是**真按钮**：`aria-expanded` 报状态，键盘能到；
   *   · 展开箭头**定宽**——不定宽时标题会随 ▸/▾ 的宽度左右抖（聊天页踩过）；
   *   · 默认**展开**（`.collapsible` 的数据就在这儿，收起是人的选择，不是默认态）。
   */
  import type { Snippet } from 'svelte'

  let {
    /** 标题（「工作目录的文件」/「材料」）。 */
    title = '',
    /** 右括号里那个计数（`12 项`）；空串 = 不画。 */
    count = '',
    open = $bindable(true),
    /** 头部右侧的动作（刷新 / 追加…）。 */
    actions,
    /** 正文（清单本身）。 */
    children,
  }: {
    title?: string
    count?: string
    open?: boolean
    actions?: Snippet
    children?: Snippet
  } = $props()
</script>

<section class="foot-files" data-foot-files>
  <div class="foot-files-head">
    <button
      type="button"
      class="ghost"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      <span class="twisty">{open ? '▾' : '▸'}</span>
      {title}
      {#if count !== ''}
        <span class="faint small">{count}</span>
      {/if}
    </button>
    {#if actions}{@render actions()}{/if}
  </div>
  <!--
    ⚠️ 正文**一直挂着**（收起只是 `hidden`），不是 `{#if open}`。
    聊天页那边有一段实测留下来的理由：折叠头那行要写出「N 项」，而条数**只有清单自己知道**
    ——`{#if}` 会在收起时把它卸载掉，计数就永远停在 0，收起状态下那一行看起来像"这个目录空的"。
    （分批第 197 批抽组件时我先写成了 `{#if}`，聊天页那 11 条文件判据当场全红。）
  -->
  {#if children}
    <div class="foot-files-body" hidden={!open}>{@render children()}</div>
  {/if}
</section>

<style>
  .foot-files {
    border-top: 1px solid var(--line);
    padding: var(--sp-2) var(--sp-3);
    font-size: var(--fs-sm);
    flex-shrink: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .foot-files-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }

  .foot-files-head :global(.ghost) {
    padding: var(--sp-1) var(--sp-2);
  }

  /* 展开箭头定宽：不定宽时，标题会随着 ▸/▾ 的宽度差左右抖 */
  .twisty {
    display: inline-block;
    width: 0.75rem;
    color: var(--text-faint);
  }

  /* 清单自己滚：栏脚是"常驻的一小块"，不许把中间那栏的对话挤没 */
  .foot-files-body {
    max-height: 12rem;
    overflow: auto;
    min-height: 0;
  }
</style>
