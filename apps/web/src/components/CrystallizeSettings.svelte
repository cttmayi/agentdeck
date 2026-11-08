<script lang="ts">
  /**
   * 沉淀线的**设置页**（分批第 175 批；使用者："一键安装放到沉淀的设置里，当前没有设置，请在沉淀页增加设置页"）。
   *
   * 现在只有一项：**沉淀用技能**。为什么它必须是设置而不是栏头的一个按钮——
   * 它是"这条线能不能开始"的前提（使用者定：没装 distilly 就不该能沉淀），
   * 这种"一次配好、之后每条沉淀都按它跑"的东西属于设置；而"改这一版"属于操作。
   *
   * ⚠️ 技能**不随项目发布**：装的是上游仓库那份（`DISTILLY_SOURCE`），平台不 vendored。
   */
  import { t } from '../lib/i18n.ts'
  import { api } from '../lib/api.ts'
  import { DISTILLY_SOURCE, draftSkill } from '../lib/crystallize-editor.svelte.ts'
  import SettingsPanel from './SettingsPanel.svelte'

  /**
   * ★ 296 批：返回交给页面（沉淀页的"回去"就是回到空态 / 上一屏）。
   */
  let { onback }: { onback: () => void } = $props()

  let busy = $state(false)
  let note = $state('')

  /**
   * ★ 分批第 187 批（使用者：把加速器做成设置项）：**GitHub 加速器**。
   * 空 = 直连（默认）；填了就"装技能时下载走它"。它是第三方——能看也能改内容，
   * 所以默认关、且走代理时不带我们的 token（那三条硬规矩没变）。
   */
  let proxyUrl = $state('')
  let proxyNote = $state('')
  let proxyBusy = $state(false)
  const DEFAULT_PROXY = 'https://gh-proxy.org'

  async function loadProxy(): Promise<void> {
    try {
      const id = await api<{ githubProxy?: string }>('/api/identity')
      proxyUrl = id.githubProxy ?? ''
    } catch {
      // 读不到就按"没设过"显示（不影响安装那条路自己的读取）
    }
  }

  async function saveProxy(): Promise<void> {
    if (proxyBusy) return
    proxyBusy = true
    proxyNote = ''
    try {
      const res = await api<{ url: string }>('/api/workspace/github-proxy', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: proxyUrl.trim() }),
      })
      proxyUrl = res.url
      proxyNote =
        res.url === '' ? $t('crystallize.settingsProxyOff') : $t('crystallize.settingsProxyOn', { url: res.url })
    } catch (err) {
      proxyNote = String(err instanceof Error ? err.message : err)
    } finally {
      proxyBusy = false
    }
  }

  async function reload(): Promise<void> {
    try {
      const res = await api<{ skills: Array<{ id: string; slug: string; name: string }> }>('/api/skills')
      const found = res.skills.find((sk) => sk.slug === 'distilly' || sk.slug.startsWith('distilly'))
      draftSkill.id = found?.id ?? ''
      draftSkill.slug = found?.slug ?? ''
      draftSkill.name = found?.name ?? ''
      draftSkill.error = ''
    } catch (err) {
      draftSkill.error = String(err instanceof Error ? err.message : err)
    }
  }

  async function install(): Promise<void> {
    if (busy) return
    busy = true
    note = ''
    try {
      await api('/api/skills/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // ⚠️ `POST /api/skills/install` 的 `source` 是**对象**（`{kind:'url', url}`），
        //    传字符串会被 400「需要 source（对象）」——第一版就是这么错的。
        body: JSON.stringify({ source: { kind: 'url', url: DISTILLY_SOURCE } }),
      })
      await reload()
      note = $t('crystallize.settingsInstalled')
    } catch (err) {
      draftSkill.error = String(err instanceof Error ? err.message : err)
    } finally {
      busy = false
    }
  }

  $effect(() => {
    void reload()
    void loadProxy()
  })
</script>

<!--
  ★ 296 批：与聊天 / 智能体设置**同一副外壳**（`SettingsPanel`）——三处终于长得一样，
  头部那颗返回也是同一颗。业务分段仍是各自的内容。
-->
<SettingsPanel
  title={$t('crystallize.settingsEntry')}
  subtitle={$t('crystallize.settingsSubtitle')}
  onback={onback}
>
  {#snippet body()}
  <section class="drawer-section">
    <h3>{$t('crystallize.settingsSkill')}</h3>
    <p class="faint small">{$t('crystallize.settingsSkillHint')}</p>
    {#if draftSkill.id !== ''}
      <p>
        {$t('crystallize.draftSkillInstalled', { name: draftSkill.name || draftSkill.slug })}
      </p>
    {:else}
      <div class="notice warn small">
        <p>{$t('crystallize.settingsSkillRequired')}</p>
        <button type="button" class="primary small" disabled={busy} onclick={() => void install()}>
          {busy ? '…' : $t('crystallize.draftSkillInstall')}
        </button>
      </div>
    {/if}
    {#if note !== ''}<p class="notice good small">{note}</p>{/if}
    {#if draftSkill.error !== ''}<p class="notice bad small">{draftSkill.error}</p>{/if}
    <p class="faint small mono">{DISTILLY_SOURCE}</p>
  </section>

  <section class="drawer-section">
    <h3>{$t('crystallize.settingsProxy')}</h3>
    <p class="faint small">{$t('crystallize.settingsProxyHint')}</p>
    <div class="proxy-row">
      <input type="text" bind:value={proxyUrl} placeholder={DEFAULT_PROXY} spellcheck="false" />
      <button type="button" class="ghost small" disabled={proxyBusy} onclick={() => void saveProxy()}>
        {$t('crystallize.settingsProxySave')}
      </button>
      <button
        type="button"
        class="ghost small"
        disabled={proxyBusy || proxyUrl === ''}
        onclick={() => {
          proxyUrl = ''
          void saveProxy()
        }}>{$t('crystallize.settingsProxyClear')}</button
      >
    </div>
    {#if proxyNote !== ''}<p class="faint small">{proxyNote}</p>{/if}
  </section>
  {/snippet}
</SettingsPanel>

<style>
  .proxy-row {
    display: flex;
    gap: var(--sp-1);
    align-items: center;
  }

  .proxy-row input {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-sm);
  }
</style>
