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

  // 打开那刻定格快照：value 是打开时的原值（父组件在置 open=true 前已同步）。
  // 用 $effect（runes 模式禁 `$:`）：open 变 true 时把当前 value 拷进 draft。
  $effect(() => {
    if (open) draft = value
  })

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
    const el = ta
    if (el) requestAnimationFrame(() => el.focus())
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
        <h3>{title}</h3>
        <button type="button" class="pe-close" title={$t('common.close')} onclick={cancel}>✕</button>
      </header>
      <textarea
        class="pe-textarea mono"
        bind:this={ta}
        bind:value={draft}
        spellcheck="false"
      ></textarea>
      <footer class="pe-foot">
        <div class="pe-vars">
          {#if vars}
            {#each vars as v (v.label)}
              <button type="button" class="pe-var-chip" title={v.title} onclick={() => insertVarAtCursor(v.label)}>
                {v.label}
              </button>
            {/each}
          {/if}
        </div>
        <div class="pe-actions">
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
    background: color-mix(in srgb, var(--surface) 60%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 60;
  }

  .pe-panel {
    width: min(720px, 92vw);
    max-height: 82vh;
    display: flex;
    flex-direction: column;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
    overflow: hidden;
  }

  .pe-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--line);
  }
  .pe-head h3 {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pe-close {
    background: none;
    border: 0;
    cursor: pointer;
    font-size: var(--fs-lg);
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
    min-height: 45vh;
    margin: var(--sp-3) var(--sp-4);
    padding: var(--sp-3);
    resize: vertical;
    font-size: var(--fs-sm);
    line-height: 1.6;
  }

  .pe-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    border-top: 1px solid var(--line);
  }
  .pe-vars {
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
  }
  .pe-var-chip:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .pe-actions {
    display: flex;
    gap: var(--sp-2);
    flex-shrink: 0;
  }
</style>
