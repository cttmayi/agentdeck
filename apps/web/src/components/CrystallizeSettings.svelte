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

  let busy = $state(false)
  let note = $state('')

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
        body: JSON.stringify({ source: DISTILLY_SOURCE }),
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
  })
</script>

<div class="detail-scroll settings-body">
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
</div>

<style>
  .settings-body {
    padding: var(--sp-4);
  }

  .settings-body p {
    margin: 0 0 var(--sp-2);
  }
</style>
