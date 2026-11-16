<script lang="ts">
  /**
   * 设置页（2026-11，使用者立项：侧栏加「设置」、从右侧抽屉改为**主窗口视图**）。
   *
   * 内容从 `components/SettingsDrawer.svelte` 整块搬来（主题 / Markdown HTML /
   * 语言 / 默认运行时 / 成本+审计导出 / 远端能力：登录·注册·同步）。原抽屉
   * 组件删除——设置与登录都在这页，顶栏三个按钮（齿轮/账户/登录）跳这里。
   *
   * ⚠️ 远端能力区保持原来的容错：远端挂了只让那一段显示提示，成本与审计
   *    导出照常工作。
   */
  import { onMount } from 'svelte'
  import { api, type CostReport } from '../lib/api.ts'
  import { getRemoteUrl, setRemoteUrl } from '../lib/remote.ts'
  import {
    doLogin,
    doLogout,
    doRegister,
    refreshRemote,
    remoteAccount,
    remoteCatalog,
    remoteError,
    remoteLoggedIn,
    remoteUrlValue,
  } from '../lib/remote-store.ts'
  import { identity, loadIdentity, syncStatus } from '../lib/stores.ts'
  import { showToast } from '../lib/view.ts'
  import { LOCALES, LOCALE_LABEL, isLocale, type Locale } from '@agentdeck/i18n'
  import { locale, setLocale, t, tx } from '../lib/i18n.ts'
  import { setThemePref, themePref, type ThemePref } from '@agentdeck/ui'
  import { markdownHtmlMode, setMarkdownHtmlMode } from '../lib/markdown-html.ts'
  import type { MarkdownHtmlMode } from '../lib/markdown.ts'

  /** 设定页要列出的 runtime（身份接口给的那份清单） */
  $: runtimeOptions = $identity?.runtimes.map((r) => r.key) ?? []
  /**
   * **启动时侦测到的**那个（探测有结论、且是当前那条）。
   * 拿不到就退化成 `$identity?.currentRuntime`——界面上宁可说"未知"，
   * 也不要显示一个猜的值。
   */
  $: detectedRuntime = $identity?.currentRuntime ?? '?'

  const THEME_CHOICES = [
    { value: 'light', labelId: 'settings.themeLight' },
    { value: 'dark', labelId: 'settings.themeDark' },
    { value: 'system', labelId: 'settings.themeSystem' },
  ] as const satisfies ReadonlyArray<{ value: ThemePref; labelId: string }>

  const MARKDOWN_HTML_CHOICES = [
    { value: 'off', labelId: 'settings.markdownHtmlOff' },
    { value: 'allowlist', labelId: 'settings.markdownHtmlAllowlist' },
    { value: 'raw', labelId: 'settings.markdownHtmlRaw' },
  ] as const satisfies ReadonlyArray<{ value: MarkdownHtmlMode; labelId: string }>

  let costs: CostReport | null = null
  let costsError = ''

  let email = ''
  let password = ''

  onMount(async () => {
    try {
      costs = await api<CostReport>('/api/costs')
    } catch (err) {
      costsError = err instanceof Error ? err.message : String(err)
    }
    await refreshRemote()
  })

  async function submitLogin(register: boolean): Promise<void> {
    try {
      if (register) await doRegister(email, password)
      else await doLogin(email, password)
      password = ''
      showToast(register ? tx('settings.registeredAndSignedIn') : tx('settings.signedIn'))
    } catch (err) {
      remoteError.set(err instanceof Error ? err.message : String(err))
    }
  }

  async function saveRemoteUrl(): Promise<void> {
    setRemoteUrl($remoteUrlValue.trim())
    await refreshRemote()
  }
</script>

<div class="view-intro">
  <p>{$t('settings.headIntro')}</p>
</div>

<div class="set-grid">
  <!-- ══════════ 通用 ══════════ -->
  <section class="set-card" data-set-general>
    <h2>{$t('settings.general')}</h2>

    <!-- 主题三档：跟随系统 / 手动定死 -->
    <div class="set-block">
      <h3>{$t('settings.theme')}</h3>
      <div class="theme-picker" role="radiogroup" aria-label={$t('settings.theme')}>
        {#each THEME_CHOICES as c (c.value)}
          <button
            type="button"
            class:active={$themePref === c.value}
            role="radio"
            aria-checked={$themePref === c.value}
            onclick={() => setThemePref(c.value)}
          >
            {$t(c.labelId)}
          </button>
        {/each}
      </div>
      <p class="hint">{$t('settings.themeHint')}</p>
    </div>

    <!-- Markdown 里 HTML 的三档（默认关，可开白名单/原始） -->
    <div class="set-block">
      <h3>{$t('settings.markdownHtml')}</h3>
      <div class="theme-picker" role="radiogroup" aria-label={$t('settings.markdownHtml')}>
        {#each MARKDOWN_HTML_CHOICES as c (c.value)}
          <button
            type="button"
            class:active={$markdownHtmlMode === c.value}
            role="radio"
            aria-checked={$markdownHtmlMode === c.value}
            onclick={() => setMarkdownHtmlMode(c.value)}
          >
            {$t(c.labelId)}
          </button>
        {/each}
      </div>
      <p class="hint">{$t('settings.markdownHtmlHint')}</p>
      {#if $markdownHtmlMode === 'raw'}
        <p class="hint warn">{$t('settings.markdownHtmlRawWarn')}</p>
      {/if}
    </div>

    <!-- 界面语言（唯一入口） -->
    <div class="set-block">
      <h3>{$t('settings.language')}</h3>
      <label>
        {$t('settings.languageLabel')}
        <select
          value={$locale}
          onchange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value
            if (isLocale(v)) void setLocale(v as Locale)
          }}
        >
          {#each LOCALES as l (l)}
            <option value={l}>{LOCALE_LABEL[l]}</option>
          {/each}
        </select>
      </label>
      <p class="hint">{$t('settings.languageHint')}</p>
    </div>

    <!-- 全局 runtime 默认值（agent 记 'default' 时用它；三级解析） -->
    <div class="set-block" data-default-runtime>
      <h3>{$t('settings.defaultRuntime')}</h3>
      <label>
        {$t('settings.defaultRuntimeLabel')}
        <select
          value={$identity?.defaultRuntimeKey ?? ''}
          onchange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value
            void api('/api/workspace/default-runtime', {
              method: 'PUT',
              body: JSON.stringify({ runtimeKey: v }),
            })
              .then(() => void loadIdentity())
              .catch((err) =>
                showToast(err instanceof Error ? err.message : String(err)),
              )
          }}
        >
          <option value="">{$t('settings.defaultRuntimeAuto', { key: detectedRuntime })}</option>
          {#each runtimeOptions as key (key)}
            <option value={key}>{key}</option>
          {/each}
        </select>
      </label>
      <p class="hint">{$t('settings.defaultRuntimeHint')}</p>
    </div>
  </section>

  <!-- ══════════ 成本 ══════════ -->
  <section class="set-card" data-set-costs>
    <h2>{$t('settings.costs')}</h2>
    {#if costsError}
      <div class="notice bad">{costsError}</div>
    {:else if !costs}
      <div class="skeleton" style="width:40%"></div>
    {:else}
      <p>
        {$t('settings.costsTotalBefore')}<strong>${(costs.total.costUsdMicros / 1e6).toFixed(4)}</strong>
        <span class="faint">· {$t('settings.runsCount', { count: costs.total.runs })}</span>
        {#if costs.runsWithoutUsage > 0}
          <span class="bad">· {$t('settings.runsWithoutUsage', { count: costs.runsWithoutUsage })}</span>
        {/if}
      </p>
      {#if costs.byKind.length > 0}
        <div class="table-wrap">
          <table>
            <thead><tr><th>{$t('settings.colKind')}</th><th>{$t('settings.colRuns')}</th><th>{$t('settings.colCost')}</th><th>{$t('settings.colNote')}</th></tr></thead>
            <tbody>
              {#each costs.byKind as b (b.key)}
                <tr>
                  <td>{b.key}</td>
                  <td>{b.runs}</td>
                  <td>{(b.costUsdMicros / 1e6).toFixed(4)}</td>
                  <td class="faint fs-xs">{b.estimatedRuns > 0 ? $t('settings.estimatedRuns', { count: b.estimatedRuns }) : '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      {#if costs.runsWithoutUsage > 0}
        <p class="hint">
          {$t('settings.usageHintBefore')}<strong>{$t('settings.usageHintStrong')}</strong>{$t('settings.usageHintAfter')}
        </p>
      {/if}
    {/if}

    <!-- 审计导出是**下载**，不是页面内渲染——用链接让浏览器走原生下载语义 -->
    <a href="/api/audits/export" download>
      <button type="button" class="btn btn--secondary">{$t('settings.exportAudit')}</button>
    </a>
    <p class="hint">
      {$t('settings.exportHintBefore')}<strong>{$t('settings.exportHintStrong')}</strong>{$t('settings.exportHintAfter')}
    </p>
  </section>

  <!-- ══════════ 远端能力 ══════════ -->
  <section class="set-card" data-set-remote>
    <h2>
      {$t('settings.remoteSection')}
      {#if $remoteError}
        <span class="bad fs-xs">{$remoteError}</span>
      {:else if $remoteCatalog}
        <span class="faint fs-xs">{$t('settings.connected', { url: getRemoteUrl() })}</span>
      {/if}
    </h2>

    {#if !$remoteLoggedIn}
      <p class="hint">
        {$t('settings.remoteProcessBefore')}<strong>{$t('settings.remoteProcessStrong')}</strong>{$t('settings.remoteProcessAfter')}
      </p>
      <form onsubmit={(e) => { e.preventDefault(); void submitLogin(false) }}>
        <label>
          {$t('settings.email')}
          <input bind:value={email} type="email" required autocomplete="username" />
        </label>
        <label>
          {$t('settings.password')}
          <input bind:value={password} type="password" required autocomplete="current-password" />
        </label>
        <div style="display:flex;gap:var(--sp-2)">
          <button type="submit">{$t('settings.signIn')}</button>
          <button type="button" class="btn btn--secondary" onclick={() => void submitLogin(true)}>{$t('settings.register')}</button>
        </div>
      </form>
      <!-- 保存按钮与地址输入框同排（原抽屉 2026-10 紧凑性） -->
      <label style="margin-top:var(--sp-3)">
        {$t('settings.remoteUrl')}
        <div style="display:flex;gap:var(--sp-2)">
          <input bind:value={$remoteUrlValue} style="flex:1;min-width:0" />
          <button type="button" class="btn btn--secondary" style="flex:none" onclick={saveRemoteUrl}>
            {$t('settings.saveUrl')}
          </button>
        </div>
      </label>
    {:else}
      <p>{$t('settings.signedInAs')}<strong>{$remoteAccount?.displayName}</strong> <span class="faint">{$remoteAccount?.email}</span></p>
      <button type="button" class="btn btn--secondary" onclick={doLogout}>{$t('settings.signOut')}</button>
    {/if}

    <h4>{$t('settings.syncHeading')}</h4>
    {#if $syncStatus?.error}
      <div class="notice warn">{$syncStatus.error}</div>
    {:else if $syncStatus}
      <p class="faint fs-xs">
        {$t('settings.syncReported', { count: $syncStatus.reported })}
        {#if $syncStatus.queued > 0}{$t('settings.syncQueued', { count: $syncStatus.queued })}{/if}
        {#if $syncStatus.skippedReporting}{$t('settings.syncReportingOff')}{/if}
      </p>
      {#if $syncStatus.warnings.length > 0}
        <ul class="plain fs-xs">
          {#each $syncStatus.warnings as w}
            <li><code>{w.plugin}</code>：<span class="bad">{w.reason}</span></li>
          {/each}
        </ul>
      {/if}
    {/if}
    <p class="hint">
      <strong>{$t('settings.reportingStrong1')}</strong>{$t('settings.reportingAfter1')}<strong>{$t('settings.reportingStrong2')}</strong>{$t('settings.reportingMid1')}<strong>{$t('settings.reportingStrong3')}</strong>{$t('settings.reportingMid2')}<strong>{$t('settings.reportingStrong4')}</strong>{$t('settings.reportingMid3')}<br />
      {$t('settings.reportingBefore2')}{$t('settings.reportingAfter2')}<strong>{$t('settings.reportingStrong5')}</strong>{$t('settings.reportingEnd')}
    </p>
  </section>
</div>

<style>
  /* 设置页布局（页面专属；控件样式在 app.css，见 ui-style.md §2） */
  /* ★ 2026-11（使用者拍板"分左右 2 列"）：固定两列——三卡排法为
     通用 | 成本 第一行，远端能力（登录表单 + 同步说明，内容最多）跨满整行。 */
  .set-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-4);
    align-items: start;
  }
  .set-card {
    background: var(--surface);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius);
    padding: var(--sp-4) var(--sp-5);
  }
  [data-set-remote] {
    grid-column: 1 / -1;
  }
  .set-card > h2 {
    font-size: var(--fs-md);
    margin-bottom: var(--sp-3);
  }
  .set-block {
    padding: var(--sp-2) 0;
    border-top: 1px solid var(--surface-2);
  }
  .set-block:first-child { border-top: 0; }
  .set-block h3 {
    font-size: var(--fs-sm);
    margin-bottom: var(--sp-2);
  }
</style>
