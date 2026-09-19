<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type CostReport } from '../lib/api.ts'
  import { getRemoteUrl, remote, setRemoteUrl } from '../lib/remote.ts'
  import {
    doLogin,
    doLogout,
    doRegister,
    refreshRemote,
    remoteAccount,
    remoteCatalog,
    remoteError,
    remoteLoggedIn,
    remotePlugins,
    remoteUrlValue,
  } from '../lib/remote-store.ts'
  import { syncStatus } from '../lib/stores.ts'
  import { showToast } from '../lib/view.ts'
  import { LOCALES, LOCALE_LABEL, isLocale, type Locale } from '@alpha-helper/i18n'
  import { locale, setLocale, t, tx } from '../lib/i18n.ts'

  /**
   * 设置抽屉。
   *
   * ══════════════════════════════════════════════════════════════════
   * `focus` 让它兼任"登录面板"
   * ══════════════════════════════════════════════════════════════════
   *
   * 顶栏点「登录」时，使用者要看到的是登录表单，而不是"成本 → 审计导出 →
   * 远端能力"这样一路翻下去。所以同一个组件接一个 `focus`：
   * `'remote'` 就只渲染远端那一段。
   *
   * 为什么不干脆做两个组件：那样登录表单要在两处各写一遍，而**两处迟早
   * 不一致**——改了一处的校验、忘了另一处，是最经典的那类 bug。
   *
   * ══════════════════════════════════════════════════════════════════
   * 远端不可用**不能挡住本机功能**
   * ══════════════════════════════════════════════════════════════════
   *
   * 远端那一整块是独立加载的：远端挂了只让那一段显示提示，成本与审计导出
   * 照常工作。
   */
  export let onclose: () => void
  export let focus: 'all' | 'remote' = 'all'

  let costs: CostReport | null = null
  let costsError = ''

  let email = ''
  let password = ''
  let settingKey = ''
  let settingValue = ''
  let remoteNote = ''

  onMount(async () => {
    // 聚焦远端时不必去读成本——那是另一段的事，白读一次还慢
    if (focus === 'all') {
      try {
        costs = await api<CostReport>('/api/costs')
      } catch (err) {
        costsError = err instanceof Error ? err.message : String(err)
      }
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

  async function togglePlugin(name: string, enabled: boolean): Promise<void> {
    try {
      await remote.setPluginEnabled(name, !enabled)
      await refreshRemote()
    } catch (err) {
      remoteError.set(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * 把远端目录里的 skill 交给**本机 daemon**。
   *
   * 冲突必须**看得见**：daemon 那边对同名一律拒绝写入（不覆盖你的东西），
   * 而如果界面只说"下载完成"，使用者就会以为装上了——那就是静默。
   */
  async function installSkill(slug: string): Promise<void> {
    remoteNote = tx('settings.downloadingSkill', { slug })
    try {
      const skill = $remoteCatalog?.skills.find((s) => s.slug === slug)
      if (!skill) {
        remoteNote = tx('settings.notInCatalog', { slug })
        return
      }
      const out = await api<{
        installed: unknown[]
        skipped: Array<{ slug: string; reason: string }>
      }>('/api/skills', {
        method: 'POST',
        body: JSON.stringify({
          batchId: `dl-${Date.now()}`,
          skills: [
            {
              slug: skill.slug,
              name: skill.slug,
              body: skill.content ?? '',
              source: 'remote',
              // ★ 版本必须一起带上。
              //
              //   这里原来没有 `version`，而 Skills 视图那条路（走
              //   `/api/skills/install`）**带了** —— 于是从同一份远端目录下载
              //   同一个 skill：一条路装完显示「已安装」，另一条路永远显示
              //   「替换本地同名」（因为本地这条的 version 是 null，界面没法比）。
              //   两条路行为不一致，而且都没有报错。
              version: skill.version,
              sourceRef: `remote:${skill.slug}@${skill.version}`,
            },
          ],
        }),
      })
      const skipped = out.skipped ?? []
      remoteNote =
        (out.installed?.length ?? 0) > 0
          ? tx('settings.installedSkill', { slug }) +
            (skipped.length
              ? tx('settings.skippedReasons', { reasons: skipped.map((s) => s.reason).join('；') })
              : '')
          : tx('settings.notInstalled', {
              reasons: skipped.map((s) => s.reason).join('；') || tx('settings.unknownReason'),
            })
    } catch (err) {
      remoteNote = tx('settings.installFailed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function saveSetting(): Promise<void> {
    const key = settingKey.trim()
    if (!key) return
    try {
      // 值按 JSON 解析；解析不了就当字符串——这样 `false` 与 `"false"`
      // 不会悄悄混为一谈
      let value: unknown = settingValue.trim()
      try {
        value = JSON.parse(settingValue)
      } catch {
        /* 当字符串 */
      }
      await remote.saveSettings({ [key]: value })
      settingKey = ''
      settingValue = ''
      showToast(tx('settings.settingSaved'))
    } catch (err) {
      remoteError.set(err instanceof Error ? err.message : String(err))
    }
  }
</script>

<aside class="drawer">
  <div class="drawer-head">
    <h2>{focus === 'remote' ? $t('settings.titleRemote') : $t('settings.title')}</h2>
    <button type="button" class="ghost" onclick={onclose}>{$t('common.close')}</button>
  </div>

  <div class="drawer-body">
    <!-- ══════════ 成本 ══════════ -->
    {#if focus === 'all'}
    <!--
      ★ 界面语言（D39）：顶栏也有一份，两处指向**同一个 store**（不会各存一份）。
        这里多给一句说明——切换器本身说不清"prompt 不变"这件事。
    -->
    <section class="drawer-section">
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
      <p class="hint">
        {$t('settings.languageHint')}
      </p>
    </section>

    <section class="drawer-section">
      <h3>{$t('settings.costs')}</h3>
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
                    <td class="faint small">{b.estimatedRuns > 0 ? $t('settings.estimatedRuns', { count: b.estimatedRuns }) : '—'}</td>
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
        <button type="button" class="secondary">{$t('settings.exportAudit')}</button>
      </a>
      <p class="hint">
        {$t('settings.exportHintBefore')}<strong>{$t('settings.exportHintStrong')}</strong>{$t('settings.exportHintAfter')}
      </p>
    </section>

    <hr />
    {/if}

    <!-- ══════════ 远端能力 ══════════ -->
    <section class="drawer-section">
      <h3>
        {$t('settings.remoteSection')}
        {#if $remoteError}
          <span class="bad small">{$remoteError}</span>
        {:else if $remoteCatalog}
          <span class="faint small">{$t('settings.connected', { url: getRemoteUrl() })}</span>
        {/if}
      </h3>

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
            <button type="button" class="secondary" onclick={() => void submitLogin(true)}>{$t('settings.register')}</button>
          </div>
        </form>
        <label style="margin-top:var(--sp-3)">
          {$t('settings.remoteUrl')}
          <input bind:value={$remoteUrlValue} />
        </label>
        <button type="button" class="secondary" onclick={saveRemoteUrl}>{$t('settings.saveUrl')}</button>
      {:else}
        <p>{$t('settings.signedInAs')}<strong>{$remoteAccount?.displayName}</strong> <span class="faint">{$remoteAccount?.email}</span></p>
        <button type="button" class="secondary" onclick={doLogout}>{$t('settings.signOut')}</button>

        <h4>{$t('settings.mySettings')}</h4>
        <form onsubmit={(e) => { e.preventDefault(); void saveSetting() }}>
          <label>
            {$t('settings.key')}
            <input bind:value={settingKey} placeholder="pollIntervalMs / reportingEnabled" autocomplete="off" />
          </label>
          <label>
            {$t('settings.value')}
            <input bind:value={settingValue} placeholder={$t('settings.valuePlaceholder')} autocomplete="off" />
          </label>
          <button type="submit">{$t('settings.saveImmediate')}</button>
        </form>
        <p class="hint">
          {$t('settings.commonSettingsBefore')}<code>pollIntervalMs</code>{$t('settings.commonSettingsBetween')}<code>reportingEnabled: false</code>
          {$t('settings.commonSettingsAfter')}
        </p>

        <h4>{$t('settings.pluginsHeading')}</h4>
        {#if $remotePlugins.length === 0}
          <p class="faint small">{$t('settings.noPlugins')}</p>
        {:else}
          <div class="table-wrap">
            <table>
              <thead><tr><th>{$t('settings.colPlugin')}</th><th>{$t('settings.colCapability')}</th><th>{$t('settings.colStatus')}</th><th>{$t('settings.colSecretKeys')}</th><th></th></tr></thead>
              <tbody>
                {#each $remotePlugins as p (p.name)}
                  <tr>
                    <td><code>{p.name}</code></td>
                    <td class="faint small">{p.capability}</td>
                    <!-- 「加载成功」与「使用者启用」必须分开显示：混成一个布尔
                         就分不清"代码坏了"和"我自己关掉了" -->
                    <td>
                      {#if !p.loaded}
                        <span class="bad">{$t('settings.loadFailed')}</span>
                      {:else if p.enabled}
                        <span class="good">{$t('settings.enabled')}</span>
                      {:else}
                        <span class="faint">{$t('settings.disabled')}</span>
                      {/if}
                    </td>
                    <!-- 只显示**键名**，绝不显示值 -->
                    <td class="faint small">{p.secretKeys.join(', ') || '—'}</td>
                    <td>
                      {#if p.loaded}
                        <button type="button" class="ghost small" onclick={() => togglePlugin(p.name, p.enabled)}>
                          {p.enabled ? $t('settings.disable') : $t('settings.enable')}
                        </button>
                      {/if}
                    </td>
                  </tr>
                  {#if p.error}
                    <tr><td colspan="5" class="hint">{p.error}</td></tr>
                  {/if}
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/if}

      <h4>{$t('settings.publicCatalog')}</h4>
      {#if !$remoteCatalog}
        <p class="faint small">{$t('settings.catalogUnavailable')}</p>
      {:else}
        <ul class="plain">
          {#each $remoteCatalog.skills as s (s.slug)}
            <li style="display:flex;justify-content:space-between;align-items:center;gap:var(--sp-2);padding:var(--sp-2) 0;border-bottom:1px solid var(--line)">
              <span>
                <code>{s.slug}</code> <span class="faint small">{s.version}</span>
                <br /><span class="faint small">{s.summary}</span>
              </span>
              <button type="button" class="secondary small" onclick={() => installSkill(s.slug)}>
                {$t('settings.downloadToLocal')}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if remoteNote}
        <div class="notice" style="margin-top:var(--sp-2)">{remoteNote}</div>
      {/if}

      <h4>{$t('settings.syncHeading')}</h4>
      {#if $syncStatus?.error}
        <div class="notice warn">{$syncStatus.error}</div>
      {:else if $syncStatus}
        <p class="faint small">
          {$t('settings.syncReported', { count: $syncStatus.reported })}
          {#if $syncStatus.queued > 0}{$t('settings.syncQueued', { count: $syncStatus.queued })}{/if}
          {#if $syncStatus.fetched > 0}{$t('settings.syncFetched', { count: $syncStatus.fetched })}{/if}
          {#if $syncStatus.skippedReporting}{$t('settings.syncReportingOff')}{/if}
        </p>
        {#if $syncStatus.warnings.length > 0}
          <ul class="plain small">
            {#each $syncStatus.warnings as w}
              <li><code>{w.plugin}</code>：<span class="bad">{w.reason}</span></li>
            {/each}
          </ul>
        {/if}
      {/if}
      <p class="hint">
        <strong>{$t('settings.reportingStrong1')}</strong>{$t('settings.reportingAfter1')}<strong>{$t('settings.reportingStrong2')}</strong>{$t('settings.reportingMid1')}<strong>{$t('settings.reportingStrong3')}</strong>{$t('settings.reportingMid2')}<strong>{$t('settings.reportingStrong4')}</strong>{$t('settings.reportingMid3')}<br />
        {$t('settings.reportingBefore2')}<code>reportingEnabled: false</code>{$t('settings.reportingAfter2')}<strong>{$t('settings.reportingStrong5')}</strong>{$t('settings.reportingEnd')}
      </p>
    </section>
  </div>
</aside>
