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
    /**
     * ★ 分批第 222 批（使用者定）：**这个目录的路径**，画在标题行的右侧。
     *
     * 从前它挂在页头（聊天页 `.chat-dir` 那一行），和被它描述的"工作目录的文件"隔着一整片消息区
     * ——使用者：「顶上有一个「工作目录」的路径，我想统一移动到下面的「工作目录的文件」的右侧」。
     * 两页现在共用一个位置：标题行右端、刷新钮左边；`title` 给完整路径（窄窗口会省略中间）。
     */
    path = '',
    open = $bindable(true),
    /** 头部右侧的动作（刷新 / 追加…）。 */
    actions,
    /** 正文（清单本身）。 */
    children,
    /**
     * ★ 分批第 203 批：**把文件拖进这一栏**（两页共用）。
     *
     * 给了它就接拖拽：悬停时整块加一道虚线框（看得见"这里收东西"），松手把 `File[]`
     * 交回去——上传本身由调用方做（落点与接口两页不同）。
     * 不传就完全不接拖拽（浏览器默认行为，比如把文件拖进输入框）。
     */
    ondropfiles,
    /**
     * ★ 分批第 204 批：**可发现性**。拖拽区只在悬停时才有虚线框——不看不知道能拖。
     * 给了 `ondropfiles` 再给这句话，标题行末尾就多一句极淡的提示（两页共用一句词条）。
     */
    dropHint = '',
    /**
     * ★ 分批第 234 批（使用者定）：「打开」——在**系统文件管理器**里打开这个目录。
     *
     * 为什么不是组件自己发请求：`@agentdeck/ui` 不认识 daemon 的接口（远端管理页也在用它），
     * 所以这里只给一颗按钮，动作与文案都由挂载端给（与 `ondropfiles` / `actions` 同一口径）。
     * 不给就**什么都不画**（聊天页草稿态还没有目录）。
     */
    onreveal,
    /** 「打开」那颗按钮的字与悬停说明（空串 = 不画）。 */
    revealLabel = '',
    revealTitle = '',
  }: {
    title?: string
    count?: string
    path?: string
    open?: boolean
    actions?: Snippet
    children?: Snippet
    ondropfiles?: ((files: File[]) => void) | undefined
    dropHint?: string
    onreveal?: (() => void) | undefined
    revealLabel?: string
    revealTitle?: string
  } = $props()

  /** 有文件悬在这一栏上（给一点反馈：这一块收文件）。 */
  let dragging = $state(false)
</script>

<section
  class="foot-files"
  class:dragging={dragging && ondropfiles !== undefined}
  data-foot-files
  role={ondropfiles ? 'group' : undefined}
  ondragover={(e) => {
    if (!ondropfiles) return
    e.preventDefault()
    dragging = true
  }}
  ondragleave={() => (dragging = false)}
  ondrop={(e) => {
    if (!ondropfiles) return
    e.preventDefault()
    dragging = false
    const files = [...(e.dataTransfer?.files ?? [])]
    if (files.length > 0) ondropfiles(files)
  }}
>
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
        <span class="faint fs-xs">{count}</span>
      {/if}
      {#if dropHint !== '' && ondropfiles !== undefined}
        <span class="faint fs-xs drop-hint">{dropHint}</span>
      {/if}
    </button>
    {#if path !== ''}
      <!-- 省略号截左边太多不好认 ⇒ 用 `text-overflow` 截尾，完整路径在 `title` 里 -->
      <code class="foot-files-path mono" data-workdir-path title={path}>{path}</code>
    {/if}
    {#if actions}{@render actions()}{/if}
    {#if onreveal && revealLabel !== ''}
      <!-- 最右侧那颗：把这一栏指向的目录交给系统文件管理器（分批第 234 批） -->
      <button
        type="button"
        class="ghost"
        data-workdir-reveal
        title={revealTitle}
        onclick={onreveal}
      >{revealLabel}</button>
    {/if}
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
    /**
     * ★ 分批第 200 批（使用者："工作目录的文件的位置是透明的，完全透出下面的文章了"）：
     * **必须有不透明底色**。它自己是一块"常驻的栏脚"，而上面那块消息区的内容会溢出自己的盒子
     * （`.crystal-flow` 是 `min-height:100%` 的普通流）——底色一透明，正文就从缝里透出来，
     * 看起来像这一栏坏掉了。用 `.pane-foot` 同一档（`--surface`），两处叠在一起也没有色差。
     */
    background: var(--surface);
    padding: var(--sp-2) var(--sp-3);
    font-size: var(--fs-sm);
    flex-shrink: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
    z-index: 1;
  }

  .foot-files-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }

  /**
   * 路径那一格：**吃掉标题行剩下的宽度**，自己不再换行。
   *
   * `flex-wrap: wrap` 是头部自带的（窄窗口里"刷新"要能换到下一行）——路径**不能**跟着换行，
   * 否则一条长路径会把栏头顶成两行。所以它 `flex: 1 1 0; min-width: 0` + 末尾省略号，
   * 完整路径在 `title` 里（悬停可见）。
   */
  .foot-files-path {
    flex: 1 1 0;
    min-width: 0;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-dim);
    font-size: var(--fs-xs);
  }

  .foot-files-head :global(.ghost) {
    padding: var(--sp-1) var(--sp-2);
    /**
     * ★ 分批第 230 批：标题那颗按钮与右侧的「刷新 / 上传」都**不许被挤窄**。
     *
     * 与模态框那颗「关闭」同一个根因：它们都是 flex 项，而中文的最小内容宽度是
     * **一个字**——空间一紧，标题就折成两行，按钮上的「刷新」也折成两行。
     * 这一行本来就允许整体换行（`flex-wrap: wrap`），所以收缩没有意义。
     */
    flex: 0 0 auto;
    white-space: nowrap;
  }

  /* 展开箭头定宽：不定宽时，标题会随着 ▸/▾ 的宽度差左右抖 */
  .twisty {
    display: inline-block;
    width: 0.75rem;
    color: var(--text-faint);
  }

  /* 拖拽提示：极淡，跟着标题走（不是第二个标题） */
  .drop-hint {
    opacity: 0.7;
  }

  /* 拖文件悬停：整块给一道虚线框（"这里收东西"），松手就交给调用方 */
  .foot-files.dragging {
    outline: 2px dashed var(--accent);
    outline-offset: -4px;
  }

  /* 清单自己滚：栏脚是"常驻的一小块"，不许把中间那栏的对话挤没 */
  .foot-files-body {
    max-height: 12rem;
    overflow: auto;
    min-height: 0;
  }
</style>
