<script lang="ts">
  import { inbox, loading, loadError, markInboxRead } from '../lib/stores.ts'
  import { t } from '../lib/i18n.ts'
  import type { WebTextId } from '@agentdeck/i18n'

  export let onclose: () => void

  /**
   * 通知中心。
   *
   * INV-8 要求通知必须**稀缺**——只有"需要你介入"或"需要留意"的事才进来。
   * 所以这里刻意不做分组、不做筛选：数量本来就该少到不需要那些。
   */
  /** 严重度 → 词条 id。严重度本身是**契约值**（`action_required` 等），不翻译。 */
  const SEVERITY_LABEL: Record<string, WebTextId> = {
    action_required: 'inbox.severityActionRequired',
    attention: 'inbox.severityAttention',
    info: 'inbox.severityInfo',
  }

  /**
   * 标记已读失败时的那句话。
   *
   * ★ 原来这里是裸 `await markInboxRead(id)`：失败时是一个 unhandled rejection，
   *   抽屉里**什么都不显示**——而"标记已读"失败的样子与"点错了"一模一样
   *   （那条还在，看起来只是没反应），使用者只会反复点。
   */
  let actionError = ''

  async function markRead(id: string): Promise<void> {
    actionError = ''
    try {
      await markInboxRead(id)
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err)
    }
  }
</script>

<aside class="drawer">
  <div class="drawer-head">
    <h2>{$t('inbox.title')}</h2>
    <button type="button" class="ghost" onclick={onclose}>{$t('common.close')}</button>
  </div>

  <div class="drawer-body">
    <!-- ★ 「标记已读」失败：就在抽屉里说出来（触发它的地方） -->
    {#if actionError}
      <div class="notice bad" style="margin-bottom:var(--sp-2)">{actionError}</div>
    {/if}
    {#if $loading['inbox']}
      <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
      <div class="skeleton" style="width:70%"></div>
    {:else if $loadError['inbox']}
      <div class="notice bad">{$loadError['inbox']}</div>
    {:else if $inbox.length === 0}
      <div class="empty">
        <strong>{$t('inbox.emptyTitle')}</strong>
        {$t('inbox.emptyHint')}
      </div>
    {:else}
      {#each $inbox as item (item.id)}
        {@const severityId = SEVERITY_LABEL[item.severity]}
        <article class="notice" style="margin-bottom:var(--sp-2);flex-direction:column">
          <div style="display:flex;gap:var(--sp-2);align-items:center;width:100%">
            <span class="badge {item.severity === 'action_required' ? 'blocked' : 'in_review'}">
              {severityId ? $t(severityId) : item.severity}
            </span>
            <span class="faint small mono">{item.type}</span>
            <!-- 2026-10（紧凑性）：「标为已读」不再独占一行——并入第一行靠右 -->
            <button
              type="button"
              class="ghost small"
              style="margin-left:auto"
              onclick={() => markRead(item.id)}
            >
              {$t('inbox.markRead')}
            </button>
          </div>
          <strong style="color:var(--text)">{item.title}</strong>
          {#if item.body}
            <p class="hint" style="white-space:pre-wrap;margin:0">{item.body}</p>
          {/if}
        </article>
      {/each}
    {/if}
  </div>
</aside>
