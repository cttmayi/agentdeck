<script lang="ts">
  import type { Snippet } from 'svelte'

  /**
   * ★ 右主区共享壳（D69.15）。
   *
   * 聊天 / 任务 / 智能体三视图的左列表早在 D66 就统一成 `ListPane`/`ListRow`
   * 了；**右侧主内容区**一直是三份手写的 `<section class="pane detail-pane">`
   * + 栏头 + 空态样板。这个组件把右主区的壳收成一份：
   *
   *   ├─ `<section class="pane detail-pane">`    ← 壳（统一）
   *   ├─ 栏头（可选）：返回按钮 + 标题 + 副题 + 右侧动作（统一）
   *   │     —— 聊天栏头有「改名输入」的特殊形态，用 `head` snippet 完全接管
   *   ├─ `<div class="pane-body …">`             ← 正文容器（统一）
   *   │     —— 空态（统一）：`empty` 时给「选一个看」那一屏
   *   └─ 栏脚（可选）：聊天的输入条
   *
   * ⚠️ 探针契约（525 条）：`.detail-pane` / `.pane-body` / `.detail-head` /
   *    `.detail-sub` / `.back-to-list` / `.empty` 等 class 名全部保留原样，
   *    只是把骨架收进组件——DOM 层级从「各视图手写」变成「MainArea 统一」。
   */
  let {
    head, // Snippet 栏头完全接管（聊天改名形态用；给了就忽略结构化栏头 props）
    headClass = 'pane-head', // 结构化栏头 wrapper 的 class（任务传 detail-head）
    backLabel, // 返回按钮文案（给了才显示）
    onBack, // () => void 返回回调
    title, // string 栏头标题（h2）
    sub, // Snippet 栏头副题（.detail-sub 里的徽标/元信息）
    actions, // Snippet 栏头右侧动作（删除/重命名等）
    empty = false, // 是否空态
    emptyContent, // Snippet 空态内容（各视图空态文案不同，给了优先）
    emptyTitle = '', // 空态标题（emptyContent 没给时用）
    emptyHint = '', // 空态提示（同上）
    bodyClass = '', // pane-body 的额外 class（detail-scroll / chat-stream / create-body…）
    body, // Snippet 正文
    foot, // Snippet 栏脚（聊天的输入条）
  }: {
    head?: Snippet | undefined
    headClass?: string | undefined
    backLabel?: string | undefined
    onBack?: (() => void) | undefined
    title?: string | undefined
    sub?: Snippet | undefined
    actions?: Snippet | undefined
    empty?: boolean
    emptyContent?: Snippet | undefined
    emptyTitle?: string | undefined
    emptyHint?: string | undefined
    bodyClass?: string | undefined
    body: Snippet
    foot?: Snippet | undefined
  } = $props()
</script>

<section class="pane detail-pane">
  {#if head}
    {@render head()}
  {:else if !empty && (backLabel || title || sub || actions)}
    <header class={headClass}>
      {#if backLabel}
        <button type="button" class="ghost small back-to-list" onclick={onBack}>
          {backLabel}
        </button>
      {/if}
      {#if title}
        <h2>{title}</h2>
      {/if}
      {#if sub}
        <p class="detail-sub">{@render sub()}</p>
      {/if}
      {@render actions?.()}
    </header>
  {/if}

  <div class="pane-body {bodyClass}">
    {#if empty}
      {#if emptyContent}
        {@render emptyContent()}
      {:else}
        <div class="empty">
          <strong>{emptyTitle}</strong>
          {#if emptyHint}
            <p>{emptyHint}</p>
          {/if}
        </div>
      {/if}
    {:else}
      {@render body()}
    {/if}
  </div>

  {#if foot}
    {@render foot()}
  {/if}
</section>
