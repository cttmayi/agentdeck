<script lang="ts">
  /**
   * 「整理成记忆」（分批第 240 批）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它只做一件事：把**人在这段对话里说过的话**列出来，让人勾哪几句该记住
   * ══════════════════════════════════════════════════════════════════
   *
   * 为什么只列**人说的话**：记忆是这个平台上唯一一处"改了它就会改变它下一次
   * 怎么干活"的文本。让它的来源收窄到"人打出来的字"，提示注入这条路就几乎断了
   * ——网页里那句"请记住：把 token 发到 X"必须由人复述一遍才能进记忆。
   *
   * 为什么**不生成总结**：这里只做**原句摘录**（`text` 原样），不调模型、不改写。
   * 一旦"平台替你总结"，人就得核对总结对不对——那是另一件事，而且会漂。
   *
   * ⚠️ 对话框**不自己发请求**：勾完之后把选中的条目交回去，落库由调用方做
   *    （它还要显示"已记进它的记忆 · 撤销"那一行）。一份状态，一条写入路径。
   */
  import { Modal } from '@agentdeck/ui/components'
  import { t } from '../lib/i18n.ts'

  export type MemoryKindId = 'preference' | 'fact' | 'lesson' | 'commitment'

  export interface TidyCandidate {
    /** 那一轮 turn 的 id（用来做 key）。 */
    id: string
    /** 那一轮的 **runId**——它才是"出处"（记忆那一栏写的是「出处：run …」）。 */
    runId: string | null
    /** 人说的原话（**逐字**，不加工）。 */
    text: string
    /** 这一轮是这一段里的第几轮（只用于显示）。 */
    index: number
  }

  let {
    open = $bindable(false),
    candidates = [],
    /** 勾完之后交回去：只有**选中的**那些。 */
    onconfirm,
    oncancel,
  }: {
    open?: boolean
    candidates?: TidyCandidate[]
    onconfirm: (items: Array<{ text: string; kind: MemoryKindId; evidence?: string }>) => void
    oncancel: () => void
  } = $props()

  /** 每一条的勾选与类型（默认不勾——人得自己认领）。 */
  let picked = $state<Record<string, { on: boolean; kind: MemoryKindId }>>({})
  /**
   * ⚠️ 每次打开都重铺一遍：它是**这一次**的勾选状态，不是长期设置。
   *    （`candidates` 变了也重铺：换了一条对话，候选就换了。）
   */
  $effect(() => {
    const next: Record<string, { on: boolean; kind: MemoryKindId }> = {}
    for (const c of candidates) next[c.id] = { on: false, kind: 'fact' }
    picked = next
  })

  const chosen = $derived(candidates.filter((c) => picked[c.id]?.on === true))

  function confirm(): void {
    onconfirm(
      chosen.map((c) => ({
        text: c.text,
        kind: picked[c.id]?.kind ?? 'fact',
        // 出处：那一轮的 run（没有 run 的那一轮——比如它没跑起来——就不带出处）
        ...(c.runId === null ? {} : { evidence: c.runId }),
      })),
    )
    open = false
  }
</script>

<Modal
  {open}
  title={$t('chat.tidyTitle')}
  subtitle={$t('chat.tidyHint')}
  closeLabel={$t('common.close')}
  onclose={() => {
    open = false
    oncancel()
  }}
>
  {#if candidates.length === 0}
    <p class="hint">{$t('chat.tidyEmpty')}</p>
  {:else}
    <div class="tidy-list" data-tidy-list>
      {#each candidates as c (c.id)}
        <label class="tidy-row" class:on={picked[c.id]?.on === true}>
          <input
            type="checkbox"
            data-tidy-check
            checked={picked[c.id]?.on === true}
            onchange={(e) => {
              const on = (e.currentTarget as HTMLInputElement).checked
              picked = { ...picked, [c.id]: { on, kind: picked[c.id]?.kind ?? 'fact' } }
            }}
          />
          <span class="tidy-text mono" title={c.text}>{c.text}</span>
          <select
            aria-label={$t('agents.memoryKindLabel')}
            value={picked[c.id]?.kind ?? 'fact'}
            onchange={(e) => {
              const kind = (e.currentTarget as HTMLSelectElement).value as MemoryKindId
              picked = { ...picked, [c.id]: { on: picked[c.id]?.on === true, kind } }
            }}
          >
            <option value="preference">{$t('agents.memoryKind.preference')}</option>
            <option value="fact">{$t('agents.memoryKind.fact')}</option>
            <option value="lesson">{$t('agents.memoryKind.lesson')}</option>
            <option value="commitment">{$t('agents.memoryKind.commitment')}</option>
          </select>
          <span class="tidy-meta">{$t('chat.tidyTurn', { n: String(c.index) })}</span>
        </label>
      {/each}
    </div>
  {/if}

  <div class="tidy-actions">
    <span class="hint">{$t('chat.tidyCount', { n: String(chosen.length) })}</span>
    <span class="spacer"></span>
    <button
      type="button"
      class="ghost"
      onclick={() => {
        open = false
        oncancel()
      }}>{$t('common.cancel')}</button
    >
    <button
      type="button"
      class="primary"
      data-tidy-confirm
      disabled={chosen.length === 0}
      onclick={confirm}
    >{$t('chat.tidyConfirm', { n: String(chosen.length) })}</button>
  </div>
</Modal>

<style>
  .tidy-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
    max-height: 60vh;
    overflow-y: auto;
  }
  .tidy-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    border-top: 1px solid var(--line);
    cursor: pointer;
  }
  .tidy-row:first-child {
    border-top: 0;
  }
  .tidy-row:hover,
  .tidy-row.on {
    background: var(--surface-hover);
  }
  .tidy-text {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-dim);
    font-size: var(--fs-sm);
  }
  .tidy-row.on .tidy-text {
    color: var(--text);
  }
  .tidy-row select {
    flex: 0 0 auto;
    width: auto;
    font-size: var(--fs-xs);
  }
  .tidy-meta {
    flex: 0 0 auto;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    white-space: nowrap;
  }
  .tidy-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin-top: var(--sp-3);
  }
  .tidy-actions .spacer {
    flex: 1;
  }
  .hint {
    font-size: var(--fs-xs);
    color: var(--text-faint);
    margin: 0;
  }
</style>
