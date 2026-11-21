<script lang="ts">
  /**
   * 大编辑器弹层（2026-11 使用者："每个 prompt 的编辑框太小，想弹出编辑器来编辑"）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 语义：**快照 + 确认**（使用者拍板）——打开那刻把原值定格成快照，弹层里
   * 只改 draft；「保存」把 draft 写回、关闭；「取消」（或 Esc / 点遮罩）不改
   * 原值、关闭。没有"实时同步"：被定制/复用的 prompt（智能体指令、定时任务
   * 模板）起草时不想动到原值，改坏了也不会污染。
   *
   * 定时任务的模板变量（{{date}} 等）：传 `vars` 数组，组件自己在弹层底部
   * 渲染 chips 并**插到光标处**（selectionStart/selectionEnd）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 观感（2026-11 用户两轮："太丑像玩具"→"还是不专业"）：按编辑器来，
   * 不是文本框——
   *   · **行号 gutter**：左侧行号列，与 textarea 同步滚动；
   *   · **模板变量高亮**：textarea 文字透明 + 下层 pre 着色（{{…}} 用主题色），
   *     caret 仍可见；高亮层宽度补偿滚动条（textarea clientWidth）；
   *   · **状态栏**：底部一条（行数 / 字数），编辑器式收尾。
   *
   * ⚠️ 快照为什么用 `$effect.pre`（2026-11 用户报"刚编辑完，点开是空的，
   *   重新打开又好"）：`$effect` 在 DOM 更新**后**跑，textarea 挂载那一帧读到
   *   的是旧 draft；`pre` 在 DOM 更新**前**跑，挂载帧即是快照。
   * ══════════════════════════════════════════════════════════════════
   */
  import { t } from '../lib/i18n.ts'

  let {
    open,
    title,
    value,
    onSave,
    onCancel,
    vars = null,
  }: {
    open: boolean
    title: string
    /** 打开时的原值（快照来源）。弹层里只改 draft，原值不动。 */
    value: string
    /** 保存：把 draft 写回（父组件自己落字段，然后置 open=false）。 */
    onSave: (v: string) => void
    /** 取消：不改原值、关闭。 */
    onCancel: () => void
    /** 可选：模板变量 chips（定时任务用）。 */
    vars?: Array<{ label: string; title: string }> | null
  } = $props()

  // ⚠️ runes 模式 `let draft = ''` 不是自动 $state（Svelte 5.57 实测：编译成普通
  //   变量，赋值不触发任何模板更新——2026-11 用户「白底白字」就是它：draft 更新了
  //   但高亮层/字数统计全不响应）。显式 $state 才会响应。
  let draft = $state('')
  let ta: HTMLTextAreaElement | null = null
  // ⚠️ 滚动容器是 `.pe-hl` / `.pe-gutter`（overflow hidden 的盒子），不是里面的 pre：
  //   pre 是块级元素，scrollTop 设置无效（2026-11 用户"滚动条有问题，内容没滚动"——
  //   textarea 滚了、高亮层/行号原地不动）。
  let hlBox: HTMLDivElement | null = null
  let gutterBox: HTMLDivElement | null = null
  let hlPre: HTMLPreElement | null = null

  // 快照：打开（open 变 true）那一刻把 value 落进 draft（时机见头注释）
  $effect.pre(() => {
    if (open) draft = value
  })

  /** 高亮层文本：先转义（用户文本可含 <>&），再给 {{…}} 包主题色 span。 */
  function highlighted(text: string): string {
    const esc = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    return esc.replace(/\{\{[^}\n]*\}\}/g, (m) => `<span class="pe-hl-var">${m}</span>`)
  }

  const hl = $derived(highlighted(draft))
  const lineNos = $derived(
    Array.from({ length: draft.split('\n').length }, (_, i) => String(i + 1)).join('\n'),
  )

  function syncScroll(): void {
    const top = ta?.scrollTop ?? 0
    if (hlBox) hlBox.scrollTop = top
    if (gutterBox) gutterBox.scrollTop = top
  }

  function save(): void {
    onSave(draft)
    onCancel()
  }

  function cancel(): void {
    onCancel()
  }

  function insertVarAtCursor(label: string): void {
    const el = ta
    if (!el) return
    const start = el.selectionStart ?? draft.length
    const end = el.selectionEnd ?? start
    draft = draft.slice(0, start) + label + draft.slice(end)
    requestAnimationFrame(() => {
      el.focus()
      el.selectionStart = el.selectionEnd = start + label.length
      syncScroll()
    })
  }

  // 键盘：Esc 取消、Cmd/Ctrl+Enter 保存（textarea 里回车仍是换行）
  $effect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // 打开后：高亮层宽度补偿滚动条（textarea clientWidth 不含滚动条，高亮层要
  // 同宽才对齐换行），并聚焦
  $effect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => {
      if (ta && hlPre) hlPre.style.width = `${ta.clientWidth}px`
      ta?.focus()
      syncScroll()
    })
    return () => cancelAnimationFrame(raf)
  })
</script>

{#if open}
  <!-- 点遮罩 = 取消（与 Esc 一致：不改原值） -->
  <div
    class="pe-overlay"
    role="dialog"
    aria-modal="true"
    onclick={(e) => {
      if (e.target === e.currentTarget) cancel()
    }}
  >
    <div class="pe-panel">
      <header class="pe-head">
        <div class="pe-head-title">
          <span class="pe-head-mark">✎</span>
          <span class="pe-head-name ellipsis">{title}</span>
        </div>
        <div class="pe-head-right">
          <button type="button" class="pe-close" title={$t('common.close')} onclick={cancel}>✕</button>
        </div>
      </header>

      <div class="pe-body">
        <div class="pe-gutter" aria-hidden="true" bind:this={gutterBox}>
          <pre>{lineNos}</pre>
        </div>
        <div class="pe-code">
          <div class="pe-hl" aria-hidden="true" bind:this={hlBox}>
            <pre bind:this={hlPre}>{@html hl}</pre>
          </div>
          <textarea
            class="pe-textarea mono"
            bind:this={ta}
            bind:value={draft}
            onscroll={syncScroll}
            spellcheck="false"
          ></textarea>
        </div>
      </div>

      <footer class="pe-foot">
        <div class="pe-toolbar">
          {#if vars}
            {#each vars as v (v.label)}
              <button type="button" class="pe-var-chip" title={v.title} onclick={() => insertVarAtCursor(v.label)}>
                {v.label}
              </button>
            {/each}
          {/if}
        </div>
        <div class="pe-actions">
          <span class="pe-shortcut">{$t('editor.shortcut')}</span>
          <button type="button" class="btn btn--ghost" onclick={cancel}>{$t('common.cancel')}</button>
          <button type="button" class="btn btn--primary" onclick={save}>{$t('common.save')}</button>
        </div>
      </footer>

      <div class="pe-status">
        <span>{lineNos.split('\n').length} {$t('editor.lines')}</span>
        <span>{$t('editor.count', { n: draft.length })}</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .pe-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .pe-panel {
    /* 宽度留视口边距（2026-11 用户："右边边框不见了"——92vw + 深阴影在窄窗下
       右缘被阴影吞掉）：calc(100vw - 48px) 保证两侧各留 24px，边框必然可见 */
    width: min(880px, calc(100vw - 48px));
    height: 78vh;
    min-height: 440px;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    box-shadow:
      0 12px 40px rgba(0, 0, 0, 0.25),
      0 1px 4px rgba(0, 0, 0, 0.1);
    overflow: hidden;
  }

  .pe-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--line);
    flex-shrink: 0;
  }
  .pe-head-title {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }
  .pe-head-mark {
    color: var(--accent);
    font-size: var(--fs-base);
    flex-shrink: 0;
  }
  /* ★ D194：这里原来写的是 `.pe-head h3`——用 `<h3>` 画一行 14/600 的说明，既不是标题档
     （17/600）也不是标签档（13/500）。它不是标题（标题说的是"这一段在讲什么"的层级），
     而是工具条上"我在编辑什么"的一行说明 ⇒ 换成非标题元素，视觉一字不改
     （14/600 + margin 0，另把原来从 h1–h4 继承来的 `line-height: var(--lh-tight)` 补上）。 */
  .pe-head-name {
    /* D191：截断三条收进全局 `.ellipsis`（markup 已带） */
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 600;
    line-height: var(--lh-tight);
  }
  .pe-head-right {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    flex-shrink: 0;
  }
  .pe-close {
    background: none;
    border: 0;
    cursor: pointer;
    font-size: var(--fs-base);
    color: var(--text-faint);
    padding: var(--sp-1);
    line-height: 1;
    border-radius: var(--radius);
  }
  .pe-close:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  /* ── 编辑区：行号 + 高亮层 + textarea 三层 ── */
  .pe-body {
    flex: 1;
    min-height: 0;
    display: flex;
    margin: var(--sp-3) var(--sp-4);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--surface);
  }

  .pe-gutter {
    width: 3.25rem;
    flex-shrink: 0;
    overflow: hidden;
    border-right: 1px solid var(--line);
    background: var(--surface-2);
    user-select: none;
  }
  .pe-gutter pre {
    margin: 0;
    padding: var(--sp-3) var(--sp-2);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.7;
    text-align: right;
    color: var(--text-faint);
  }

  .pe-code {
    position: relative;
    flex: 1;
    min-width: 0;
    /* D202：里层 textarea 是透明文字叠在高亮层上（见 `.pe-textarea`），环画在它身上会横跨
       在代码上 ⇒ 有焦点时环画在这块外层（与 `CodeEditor` 同一个做法）。 */
    border-radius: var(--radius-sm);
  }
  .pe-code:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }
  .pe-hl {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .pe-hl pre {
    margin: 0;
    padding: var(--sp-3);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.7;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* ⚠️ @html 插入的 span 没有组件 scoped 类名，scoped 选择器 `.pe-hl-var.svelte-*`
     匹配不上 ⇒ {{date}} 不高亮（2026-11 用户报）。必须 :global。 */
  :global(.pe-hl-var) {
    color: var(--accent);
  }

  .pe-textarea {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    color: transparent;
    caret-color: var(--text);
    resize: none;
    outline: none;
    border: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.7;
    padding: var(--sp-3);
    white-space: pre-wrap;
    word-break: break-word;
    overflow: auto;
  }

  /* ── 底部：工具条 + 操作 + 状态栏 ── */
  .pe-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    border-top: 1px solid var(--line);
    flex-shrink: 0;
  }
  .pe-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
  .pe-var-chip {
    font-size: var(--fs-xs);
    padding: 2px var(--sp-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-pill);
    background: none;
    color: var(--text-dim);
    cursor: pointer;
    font-family: var(--font-mono);
    transition:
      border-color 120ms ease,
      color 120ms ease;
  }
  .pe-var-chip:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .pe-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-shrink: 0;
  }
  .pe-shortcut {
    font-size: var(--fs-xs);
    color: var(--text-faint);
    margin-right: var(--sp-2);
    white-space: nowrap;
  }

  .pe-status {
    display: flex;
    justify-content: space-between;
    padding: var(--sp-1) var(--sp-4);
    border-top: 1px solid var(--line);
    background: var(--surface-2);
    font-size: var(--fs-xs);
    color: var(--text-faint);
    flex-shrink: 0;
  }
</style>
