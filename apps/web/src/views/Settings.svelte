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
  import { LOCALES, LOCALE_LABEL, isLocale, type Locale, type WebTextId } from '@agentdeck/i18n'
  import { locale, setLocale, t, tx } from '../lib/i18n.ts'
  import { setThemePref, themePref, type ThemePref } from '@agentdeck/ui'
  import { markdownHtmlMode, setMarkdownHtmlMode } from '../lib/markdown-html.ts'
  import {
    ARTIFACT_PANE,
    LIST_PANES,
    paneWidth,
    resetAllPaneWidths,
    resetPaneWidth,
  } from '../lib/pane-resize.ts'
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

  /**
   * ★ D176：布局那一节的行——**全部可拖的位置** + 它现在存下来的宽度。
   * 位置清单只在一处（`lib/pane-resize.ts` 的 `LIST_PANES`，那边有判据盯着与视图
   * 模板里的 `data-list-key` 一致），这里不另抄一份。
   * `width === null` 就是"没拖过 = 默认"，这一行是**读存档**得来的，不是猜的。
   */
  type LayoutRow = { name: string; labelId: WebTextId }
  const LAYOUT_ROWS: readonly LayoutRow[] = [
    ...LIST_PANES,
    { name: ARTIFACT_PANE, labelId: 'settings.layoutArtifact' },
  ]
  function layoutRows(): Array<LayoutRow & { width: number | null }> {
    return LAYOUT_ROWS.map((row) => ({ ...row, width: paneWidth(row.name) }))
  }
  let layout = layoutRows()

  function resetLayout(name: string): void {
    resetPaneWidth(name)
    layout = layoutRows()
    showToast(tx('settings.layoutResetDone'))
  }

  function resetAllLayout(): void {
    resetAllPaneWidths()
    layout = layoutRows()
    showToast(tx('settings.layoutResetDone'))
  }

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
  <!-- ★ D174：外壳用 `.main-panel`（与三个设置面板同一个壳，见 ui-style.md §2 "主区面板"），
       原来是页面私有的 `.set-card`（边框还误用了填充档 `--surface-2`）。 -->
  <section class="main-panel" data-set-general>
    <header class="main-panel-head">
      <h2>{$t('settings.general')}</h2>
    </header>
    <div class="main-panel-body">

    <!-- 主题三档：跟随系统 / 手动定死 -->
    <section class="drawer-section">
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
    </section>

    <!-- Markdown 里 HTML 的三档（默认关，可开白名单/原始） -->
    <section class="drawer-section">
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
    </section>

    <!-- 界面语言（唯一入口） -->
    <section class="drawer-section">
      <h3>{$t('settings.language')}</h3>
      <div class="field">
        <label for="set-language">{$t('settings.languageLabel')}</label>
        <select
          id="set-language"
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
      </div>
      <p class="hint">{$t('settings.languageHint')}</p>
    </section>

    <!-- 全局 runtime 默认值（agent 记 'default' 时用它；三级解析） -->
    <section class="drawer-section" data-default-runtime>
      <h3>{$t('settings.defaultRuntime')}</h3>
      <div class="field">
        <label for="set-default-runtime">{$t('settings.defaultRuntimeLabel')}</label>
        <select
          id="set-default-runtime"
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
      </div>
      <p class="hint">{$t('settings.defaultRuntimeHint')}</p>
    </section>
    </div>
  </section>

  <!-- ══════════ 成本 ══════════ -->
  <section class="main-panel" data-set-costs>
    <header class="main-panel-head">
      <h2>{$t('settings.costs')}</h2>
    </header>
    <div class="main-panel-body">
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
    </div>
  </section>

  <!-- ══════════ 布局 ══════════ -->
  <!-- ★ D176（使用者选的那件事）：宽度原来只有"拖过才知道能拖"，拖坏了也没有回去的路。
       这一节把**全部可拖的位置**列出来，并给"恢复默认"（删存档，不是写一个新数字进去）。 -->
  <section class="main-panel" data-set-layout>
    <header class="main-panel-head">
      <h2>{$t('settings.layoutHeading')}</h2>
      {#if layout.some((row) => row.width !== null)}
        <button type="button" class="btn btn--ghost btn--sm" onclick={resetAllLayout}
          >{$t('settings.layoutResetAll')}</button
        >
      {/if}
    </header>
    <div class="main-panel-body">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{$t('settings.layoutColWhere')}</th>
              <th>{$t('settings.layoutColWidth')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each layout as row (row.name)}
              <tr>
                <td>{$t(row.labelId)}</td>
                <td class="fs-xs faint">
                  {row.width === null ? $t('settings.layoutDefault') : `${row.width}px`}
                </td>
                <td class="layout-action">
                  <button
                    type="button"
                    class="btn btn--ghost btn--sm"
                    disabled={row.width === null}
                    onclick={() => resetLayout(row.name)}>{$t('settings.layoutReset')}</button
                  >
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="hint">{$t('settings.layoutHint')}</p>
    </div>
  </section>

  <!-- ══════════ 远端能力 ══════════ -->
  <section class="main-panel" data-set-remote>
    <header class="main-panel-head">
      <h2>{$t('settings.remoteSection')}</h2>
      {#if $remoteError}
        <span class="bad fs-xs">{$remoteError}</span>
      {:else if $remoteCatalog}
        <span class="faint fs-xs">{$t('settings.connected', { url: getRemoteUrl() })}</span>
      {/if}
    </header>
    <div class="main-panel-body">

    {#if !$remoteLoggedIn}
      <p class="hint">
        {$t('settings.remoteProcessBefore')}<strong>{$t('settings.remoteProcessStrong')}</strong>{$t('settings.remoteProcessAfter')}
      </p>
      <form onsubmit={(e) => { e.preventDefault(); void submitLogin(false) }}>
        <div class="field">
          <label for="set-email">{$t('settings.email')}</label>
          <input id="set-email" bind:value={email} type="email" required autocomplete="username" />
        </div>
        <div class="field">
          <label for="set-password">{$t('settings.password')}</label>
          <input id="set-password" bind:value={password} type="password" required autocomplete="current-password" />
        </div>
        <div class="field-row">
          <button type="submit">{$t('settings.signIn')}</button>
          <button type="button" class="btn btn--secondary" onclick={() => void submitLogin(true)}>{$t('settings.register')}</button>
        </div>
      </form>
      <!-- 保存按钮与地址输入框同排（原抽屉 2026-10 紧凑性） -->
      <div class="field">
        <label for="set-remote-url">{$t('settings.remoteUrl')}</label>
        <div class="field-row">
          <input id="set-remote-url" bind:value={$remoteUrlValue} />
          <button type="button" class="btn btn--secondary" onclick={saveRemoteUrl}>
            {$t('settings.saveUrl')}
          </button>
        </div>
      </div>
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
    </div>
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
  /* ★ D174：`.set-card` / `.set-block` 两套页面私有的样式已删——卡片改用全局 `.main-panel`
     （与三个设置面板同一个壳），分段改用全局 `.drawer-section`（面板里那 9 段同一个定义）。
     这里只剩**页面布局**（两列网格 + 远端卡跨行），符合"页面只决定放什么、放在哪"。 */
  [data-set-remote] {
    grid-column: 1 / -1;
  }
  /* 布局那一节是一张"位置 / 宽度 / 动作"的表，短——跨满整行，别在右边留一个空格子 */
  [data-set-layout] {
    grid-column: 1 / -1;
  }
  /* 最后一列（恢复默认）贴右缘：每行的按钮竖着对齐，不跟着位置名长短跑 */
  .layout-action {
    text-align: right;
  }
</style>
