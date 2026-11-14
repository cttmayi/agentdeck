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
   * 渲染 chips 并**插到光标处**（selectionStart/selectionEnd）——小框里原来
   * 是"追加到末尾"（2026-11 使用者要求一并搬进弹层 + 光标插入）。
   *
   * ⚠️ 快照为什么用 textarea 的 `onmount` 而不是 `$effect`（2026-11 使用者
   *   报过"刚编辑完，点开是空的，重新打开又好"）：`$effect` 依赖 open/value 的
   *   变化时序，表单重建（切页回来、保存后立刻重开）时第一次打开可能读到旧的
   *   draft；而弹层是 `{#if open}` 渲染的——每次打开 textarea 都重新挂载，
   *   `onmount` 保证**这一帧**的 value 一定落进 draft，时序问题不存在。
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

  let draft = ''
  let ta: HTMLTextAreaElement | null = null

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
    })
  }

  // 快照：打开（open 变 true）那一刻把 value 落进 draft。
  // ⚠️ 用 `$effect.pre` 而不是 `$effect`（2026-11 使用者报"刚编辑完，点开是空的，
  //   重新打开又好"）：`$effect` 在 DOM 更新**后**跑，textarea 挂载那一帧读到的是
  //   旧 draft；`pre` 在 DOM 更新**前**跑，textarea 第一次渲染时 draft 已经是快照。
  $effect.pre(() => {
    if (open) draft = value
  })

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
          <h3>{title}</h3>
        </div>
        <div class="pe-head-right">
          <span class="pe-count">{$t('editor.count', { n: draft.length })}</span>
          <button type="button" class="pe-close" title={$t('common.close')} onclick={cancel}>✕</button>
        </div>
      </header>
      <textarea
        class="pe-textarea mono"
        bind:this={ta}
        bind:value={draft}
        spellcheck="false"
      ></textarea>
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
    </div>
  </div>
{/if}

<style>
  .pe-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .pe-panel {
    width: min(860px, 92vw);
    height: 78vh;
    min-height: 420px;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    box-shadow:
      0 16px 48px rgba(0, 0, 0, 0.35),
      0 2px 8px rgba(0, 0, 0, 0.15);
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
  .pe-head h3 {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pe-head-right {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    flex-shrink: 0;
  }
  .pe-count {
    font-size: var(--fs-xs);
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
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

  .pe-textarea {
    flex: 1;
    margin: var(--sp-3) var(--sp-4);
    padding: var(--sp-3);
    resize: none;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    color: var(--text);
    font-size: var(--fs-sm);
    line-height: 1.7;
    outline: none;
    transition: border-color 120ms ease;
  }
  .pe-textarea:focus {
    border-color: var(--accent);
  }

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
</style>
