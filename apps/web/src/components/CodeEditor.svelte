<script lang="ts">
  /**
   * CodeEditor —— 编排代码的编辑框：**语法高亮 + 行号 + Tab 缩进**。
   *
   * 使用者 2026-11："编排代码的显示需要有代码高亮等专业编辑"。
   *
   * ══════════════════════════════════════════════════════════════════
   * 怎么做的（两行说明，详细在 `lib/code-highlight.ts` 顶部）
   * ══════════════════════════════════════════════════════════════════
   *
   * 下面一层 `<pre>` 画带颜色的代码（`highlightJs` 生成的 HTML），上面一层
   * **文字透明、光标可见**的 `<textarea>` 负责真正的输入。两层必须**逐字对齐**：
   *   · 同一套字体度量（`--font-mono` / `--fs-sm` / `line-height`）；
   *   · 都是 `white-space: pre`（**不折行**——折行会让两层的字符位置错开）；
   *   · 同样的 `padding`；
   *   · textarea 滚动时把 `<pre>` 的 `scrollTop/Left` 一起搬（`onscroll`）。
   *
   * ⚠️ 不用 CodeMirror / Monaco：本项目要求**离线、无 CDN 依赖**，而那两者都是几百 KB。
   *    编排代码只有几十行、语法也是我们自己的六个原语——行内高亮足够，而且
   *    "看到的就是我写的那段"这件事由 `highlightJs` 的假设（剥标签后逐字相同）钉着。
   *
   * ⚠️ Tab 插入**两个空格**而不是焦点跳走：代码里 Tab 就是缩进，跳走等于把这一行写歪。
   */
  import { highlightJs } from '../lib/code-highlight.ts'

  /** 正文（`bind:value`）。 */
  export let value = ''
  /** 内部 textarea 的 id（外面 `<label for>` 指过来用）。 */
  export let id = ''
  /** 显示行数（只影响最小高度）。 */
  export let rows = 12
  export let placeholder = ''
  export let ariaLabel = ''
  /** 只读（采纳面板里预览时用）。 */
  export let readonly = false

  let ta: HTMLTextAreaElement | null = null
  let pre: HTMLElement | null = null

  /** 行号：按换行数算，至少 1 行。 */
  $: lines = value === '' ? 1 : value.split('\n').length
  $: highlighted = highlightJs(value)

  /** 滚动同步：textarea 是滚动权威，`<pre>` 跟着走。 */
  function syncScroll(): void {
    if (!ta || !pre) return
    pre.scrollTop = ta.scrollTop
    pre.scrollLeft = ta.scrollLeft
  }

  /** Tab = 插入两个空格（不跳焦点），并保持光标位置。 */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || readonly) return
    event.preventDefault()
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const next = `${value.slice(0, start)}  ${value.slice(end)}`
    value = next
    // 光标挪到插入点之后（等 DOM 更新一拍）
    queueMicrotask(() => {
      if (!ta) return
      ta.selectionStart = start + 2
      ta.selectionEnd = start + 2
    })
  }
</script>

<div class="editor" style="--rows:{rows}">
  <!-- 行号列：与正文同一套行高，滚到哪儿都对齐 -->
  <div class="gutter" aria-hidden="true">
    {#each Array(lines) as _, i (i)}<span>{i + 1}</span>{/each}
  </div>
  <div class="code">
    <!-- 高亮层：不参与交互（pointer-events: none），只负责上色 -->
    <pre class="hl" bind:this={pre} aria-hidden="true">{@html highlighted}</pre>
    <textarea
      bind:this={ta}
      id={id === '' ? undefined : id}
      class="input"
      {placeholder}
      {readonly}
      aria-label={ariaLabel}
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      wrap="off"
      bind:value
      onscroll={syncScroll}
      onkeydown={onKeydown}
    ></textarea>
  </div>
</div>

<style>
  .editor {
    display: flex;
    align-items: stretch;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--surface-2);
    overflow: hidden;
    /* 最小高度 = 行数 × 行高 + 上下内距（`--rows` 由调用方给） */
    min-height: calc(var(--rows) * 1.5em + var(--sp-3) * 2);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.5;
  }
  .editor:focus-within {
    /* D202：里面那层 textarea 是**透明文字**叠在彩色代码上的（见 `.gutter` 与 `.input`
       的注释），给它画 2px 环会横跨在代码上；所以环画在外层这块上（`outline-offset: -1px`
       让它贴着内缘，不撑破布局）。里层的 `outline: none` 就是这么来的。 */
    outline: 2px solid var(--accent);
    outline-offset: -1px;
    border-color: var(--accent);
  }
  /* 行号列：与正文同色系的淡字，不抢视线 */
  .gutter {
    display: flex;
    flex-direction: column;
    padding: var(--sp-3) var(--sp-2) var(--sp-3) var(--sp-3);
    color: var(--text-faint);
    text-align: right;
    user-select: none;
    border-right: 1px solid var(--line);
    overflow: hidden;
  }
  .gutter span {
    display: block;
    height: 1.5em;
  }
  .code {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  /* 两层共用的度量：padding / 字体 / 不折行——任何一处不同都会让颜色错位 */
  .hl,
  .input {
    margin: 0;
    padding: var(--sp-3);
    font: inherit;
    line-height: inherit;
    white-space: pre;
    overflow: auto;
    tab-size: 2;
  }
  .hl {
    position: absolute;
    inset: 0;
    pointer-events: none;
    color: var(--text-dim);
  }
  .input {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 100%;
    border: 0;
    background: transparent;
    /* ★ 文字透明、光标可见：看到的是下面那层上色后的代码，输入还是真的输入 */
    color: transparent;
    caret-color: var(--text);
    resize: vertical;
    outline: none;
  }
  .input::selection {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }

  /* 配色用 app.css 的代码高亮令牌（与文件查看器同一套，换主题自动跟着走） */
  .hl :global(.tok-comment) {
    color: var(--text-faint);
    font-style: italic;
  }
  .hl :global(.tok-string) {
    color: var(--hl-string);
  }
  .hl :global(.tok-number) {
    color: var(--hl-number);
  }
  .hl :global(.tok-keyword) {
    color: var(--hl-keyword);
    font-weight: 600;
  }
  .hl :global(.tok-primitive) {
    color: var(--accent);
    font-weight: 600;
  }
</style>
