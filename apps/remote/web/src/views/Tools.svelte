<script lang="ts">
  /**
   * 工具包目录（只读）。
   *
   * 与技能那条路的区别要说清：工具包**是仓库里的文件**（`apps/remote/catalog/tools/`），
   * 不是抓下来的内容——所以这一页既没有"重新同步"，也没有"内容不完整"那类字段。
   * 改它要提交改动，这一页只负责让人看清目录里到底有什么。
   */
  import { onMount } from 'svelte'
  import { api, type Catalog, type CatalogTool } from '../lib/api.ts'
  import CatalogPane from '../components/CatalogPane.svelte'
  import { ExpandToggle } from '@agentdeck/ui/components'
  import { t } from '../lib/locale.ts'

  let catalog: Catalog | null = null
  let error = ''
  let loading = true
  let detail: CatalogTool | null = null

  async function load(): Promise<void> {
    loading = true
    try {
      catalog = await api.catalog()
      error = ''
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void load()
  })

  // ★ 目录就绪后的派生量（CatalogPane 的四态在它内部处理，这里只算"空不空 /
  //   条数"——snippet 是函数拿不到 `{#if}` 的收窄，所以直接用**非空数组**）
  $: tools = catalog?.tools ?? []
  $: emptyText = catalog !== null && tools.length === 0 ? $t('remote.toolsEmpty') : ''
  $: titleCount = `${$t('remote.toolsTitle')} · ${$t('remote.toolsCount', { count: tools.length })}`

  /** 清单里声明的入口脚本在不在包里（不在 = 这个包装不上，要看得见）。 */
  function entryOf(tool: CatalogTool): string | null {
    const manifest = tool.manifest as unknown as { entry?: unknown; actions?: Array<{ entry?: unknown }> }
    const first = manifest.actions?.find((a) => typeof a.entry === 'string')?.entry
    if (typeof first === 'string') return first
    return typeof manifest.entry === 'string' ? manifest.entry : null
  }

  const entryIncluded = (tool: CatalogTool): boolean => {
    const entry = entryOf(tool)
    return entry === null ? true : entry in tool.files
  }
</script>

<CatalogPane
  loading={loading}
  error={error}
  empty={emptyText}
  titleCount={titleCount}
  columns={[
    { label: $t('remote.colPackage') },
    { label: $t('remote.colActions') },
    { label: $t('remote.colVersion') },
    { label: '', ariaLabel: $t('remote.view') },
  ]}
  footer={$t('remote.toolsFromRepo')}
  loadingText={$t('remote.loading')}
  retryText={$t('remote.retry')}
  closeText={$t('remote.close')}
  onretry={() => void load()}
  detailTitle={detail ? detail.name || detail.slug : ''}
  onclose={() => (detail = null)}
>
  {#snippet rows()}
    {#each tools as tool (tool.slug)}
        <tr>
          <td>
            <div class="row-title">
              <ExpandToggle
                expanded={detail?.slug === tool.slug}
                labelExpand={$t('remote.expandDetail')}
                labelCollapse={$t('remote.collapseDetail')}
                onclick={() => (detail = detail?.slug === tool.slug ? null : tool)}
              />
              <code>{tool.slug}</code>
            </div>
            {#if tool.name}<div class="faint small">{tool.name}</div>{/if}
            {#if tool.summary}
              <div class="faint small desc-clamp" title={tool.summary}>{tool.summary}</div>
            {/if}
          </td>
          <td class="faint small">
            {#each tool.manifest.actions as action (action.name)}
              <div><code>{tool.slug}.{action.name}</code></div>
            {/each}
          </td>
          <td class="faint small">{tool.version ? `v${tool.version}` : $t('remote.noVersion')}</td>
          <td>
            <div class="row-actions">
              <!-- ★ 按钮叫「查看」，与技能页那一列同一句话：两页的同一件事应该长得一样，
                   而且原来这里是每行重复一遍「清单（tool.json）」（等于重复表头）。 -->
              <button type="button" class="secondary small" onclick={() => (detail = tool)}>
                {$t('remote.view')}
              </button>
            </div>
          </td>
        </tr>
    {/each}
  {/snippet}
  {#snippet drawerBody()}
    <p class="faint small">
      {entryIncluded(detail!)
        ? $t('remote.toolEntryFound')
        : $t('remote.toolEntryMissing', { entry: entryOf(detail!) ?? '—' })}
    </p>
    <h3>{$t('remote.toolManifest', { file: 'tool.json' })}</h3>
    <pre class="file-text">{JSON.stringify(detail!.manifest, null, 2)}</pre>
    <h3>{$t('remote.toolDocs', { file: 'TOOL.md' })}</h3>
    <pre class="file-text">{detail!.docs}</pre>
    <h3>{$t('remote.detailFiles')}</h3>
    <ul class="faint small">
      {#each Object.keys(detail!.files).sort() as path (path)}
        <li><code>{path}</code></li>
      {/each}
    </ul>
  {/snippet}
</CatalogPane>
<style>
  .file-text {
    max-height: 20rem;
    overflow: auto;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-1);
    padding: var(--sp-3);
    white-space: pre-wrap;
  }
</style>
