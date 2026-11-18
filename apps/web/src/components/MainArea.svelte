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
    /**
     * 结构化栏头 wrapper 的 class。
     *
     * ⚠️ 2026-11（D139）：默认值原来是 `'pane-head'`，而 `.detail-head` 那一整套（两列网格、
     *    动作轨道、标题省略号）都挂在 `.detail-head` 上 ⇒ **没显式传这个 prop 的页面
     *    一直在用 `.pane-head`**（标题与动作不是左右两列、动作没有轨道），看起来与范例
     *    那一屏完全不同。使用者报的就是这个："主区的 Title 细节有问题，和 demo 不同"。
     *    现在默认 `'detail-head'`：结构化栏头的默认长相就是那一套；要别的形状再显式传
     *    （任务页的新建态就是 `'detail-head create-head'`）。
     */
    headClass = 'detail-head',
    backLabel, // 返回按钮文案（给了才显示）
    onBack, // () => void 返回回调
    title, // string 栏头标题（h2）
    /**
     * 栏头副题（`.detail-sub` 里的徽标 / 元信息）。
     *
     * ⚠️ **只在真有内容时传**：给一个"有时什么都不渲染"的 snippet，栏头会多出一行空白
     *    （D139 的缺陷）。条件渲染要写在调用处：`sub={hasSub ? subSnippet : undefined}`。
     */
    sub,
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
        <button type="button" class="btn btn--ghost btn--sm back-to-list" onclick={onBack}>
          {backLabel}
        </button>
      {/if}
      <!--
        ★ 2026-11（D139）：标题与副题包进**同一个格子**（`.detail-head-main`）。
        改之前它们是两个网格子项，`.detail-actions` 又靠 `grid-row: 1 / span 2` 跨两行对齐
        ——于是"副题有没有内容"会改变整个栏头的行数与按钮的垂直位置（空副题 ⇒ 栏头
        多出一行空白，标题看着偏高、按钮离标题更远）。
        现在动作对齐的是**文字块**，与副题几行无关。
      -->
      <div class="detail-head-main">
        {#if title}
          <h2>{title}</h2>
        {/if}
        {#if sub}
          <p class="detail-sub">{@render sub()}</p>
        {/if}
      </div>
      <!--
        ★ 分批第 197 批：动作渲进一个**有名字的容器**（`.detail-actions`）。
        改之前它是一串裸元素，而 `.detail-head` 是块级流——于是"页头动作"永远掉在标题与副题
        **下面那一行**（使用者："「放弃」和「确认入库」位置还是不对，依然在第 3 行，而不是右侧"）。
        有了这个容器，CSS 才能把"标题+副题"和"动作"排成两列（见 app.css 的 `.detail-head`）。
      -->
      {#if actions}
        <div class="detail-actions">{@render actions()}</div>
      {/if}
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
