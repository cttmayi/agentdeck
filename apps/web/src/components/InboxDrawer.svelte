<script lang="ts">
  import { inbox, loading, loadError, markInboxRead } from '../lib/stores.ts'
  import { t } from '../lib/i18n.ts'
  import type { WebTextId } from '@alpha-helper/i18n'

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

  async function markRead(id: string): Promise<void> {
    await markInboxRead(id)
  }
</script>

<aside class="drawer">
  <div class="drawer-head">
    <h2>{$t('inbox.title')}</h2>
    <button type="button" class="ghost" onclick={onclose}>{$t('common.close')}</button>
  </div>

  <div class="drawer-body">
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
          </div>
          <strong style="color:var(--text)">{item.title}</strong>
          {#if item.body}
            <p class="hint" style="white-space:pre-wrap;margin:0">{item.body}</p>
          {/if}
          <button type="button" class="ghost small" onclick={() => markRead(item.id)}>
            {$t('inbox.markRead')}
          </button>
        </article>
      {/each}
    {/if}
  </div>
</aside>
