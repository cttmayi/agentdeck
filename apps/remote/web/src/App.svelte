<script lang="ts">
  /**
   * 远端管理页的外壳：顶栏 + 侧边栏 + 两个只读页（技能 / 工具）。
   *
   * ⚠️ 路由用 **hash**（`#/skills`），与 daemon 界面同一种做法：产物是静态文件，
   *    不依赖服务端支持 SPA 回退（服务端只把未知路径回 index.html，那是兜底）。
   */
  import { onMount } from 'svelte'
  import { locale, setLocale, t } from './lib/locale.ts'
  import { themePref, setThemePref, type ThemePref } from '@agentdeck/ui'
  import { LOCALES, LOCALE_LABEL } from '@agentdeck/i18n'
  import { ConfirmDialog } from '@agentdeck/ui/components'
  import Skills from './views/Skills.svelte'
  import Tools from './views/Tools.svelte'

  type View = 'skills' | 'tools'

  function viewFromHash(): View {
    return location.hash === '#/tools' ? 'tools' : 'skills'
  }

  let view: View = viewFromHash()

  onMount(() => {
    const onHash = (): void => {
      view = viewFromHash()
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  })

  function go(next: View): void {
    location.hash = `#/${next}`
    view = next
  }

  const themeChoices: Array<{ value: ThemePref; id: 'remote.themeSystem' | 'remote.themeLight' | 'remote.themeDark' }> = [
    { value: 'system', id: 'remote.themeSystem' },
    { value: 'light', id: 'remote.themeLight' },
    { value: 'dark', id: 'remote.themeDark' },
  ]
</script>

<div class="topbar">
  <div class="topbar-left">
    <span class="brand">AgentDeck</span>
    <!-- ★ `h1` 而不是 `strong`：这是页面标题，读屏器与"文档大纲"靠它认页
         （2026-10 审查时量到 `h1` 数量是 0）。daemon 界面的页名也是 `h1.page-name`。 -->
    <h1 class="page-name">{view === 'skills' ? $t('remote.navSkills') : $t('remote.navTools')}</h1>
  </div>
  <div class="topbar-right">
    <div class="page-actions">
      <!-- 语言：与 daemon 界面同一个 localStorage 键 ⇒ 两页语言一致 -->
      <label class="faint small" for="remote-locale">{$t('remote.language')}</label>
      <select
        id="remote-locale"
        value={$locale}
        onchange={(e) => setLocale((e.currentTarget as HTMLSelectElement).value as 'zh' | 'en')}
      >
        {#each LOCALES as code (code)}
          <option value={code}>{LOCALE_LABEL[code]}</option>
        {/each}
      </select>
      <!-- 主题：三档（跟随系统 / 亮 / 暗），与 daemon 界面共用同一份判定 -->
      <label class="faint small" for="remote-theme">{$t('remote.theme')}</label>
      <select
        id="remote-theme"
        value={$themePref}
        onchange={(e) => setThemePref((e.currentTarget as HTMLSelectElement).value as ThemePref)}
      >
        {#each themeChoices as c (c.value)}
          <option value={c.value}>{$t(c.id)}</option>
        {/each}
      </select>
    </div>
  </div>
</div>

<div class="shell">
  <nav class="sidebar">
    <div class="nav-title">{$t('remote.title')}</div>
    <button
      type="button"
      class="nav-item"
      class:active={view === 'skills'}
      onclick={() => go('skills')}
    >
      {$t('remote.navSkills')}
      <span class="nav-hint">{$t('remote.subtitle')}</span>
    </button>
    <button
      type="button"
      class="nav-item"
      class:active={view === 'tools'}
      onclick={() => go('tools')}
    >
      {$t('remote.navTools')}
    </button>
    <div class="sidebar-foot faint small">{$t('remote.servedBy')}</div>
  </nav>

  <main class="main">
    {#if view === 'skills'}
      <Skills />
    {:else}
      <Tools />
    {/if}
  </main>
</div>

<!-- 确认对话框（卸载这类破坏性动作走它；不用 window.confirm）。
     ★ 与 daemon 界面是**同一个组件**（`@agentdeck/ui`），按钮文案是本端的
     （webText / remoteText 有意分开，由挂载处传入）。 -->
<ConfirmDialog cancelLabel={$t('remote.cancel')} closeLabel={$t('remote.close')} />
