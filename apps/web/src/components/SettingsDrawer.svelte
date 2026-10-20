<script lang="ts">
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
  /** 设定页要列出的 runtime（身份接口给的那份清单） */
  $: runtimeOptions = $identity?.runtimes.map((r) => r.key) ?? []
  /**
   * **启动时侦测到的**那个（探测有结论、且是当前那条）。
   * 拿不到就退化成 `$identity?.currentRuntime`——界面上宁可说"未知"，
   * 也不要显示一个猜的值（猜错的话使用者会照它去理解 agent 的行为）。
   */
  // ⚠️ `RuntimeView` 里**没有** `isCurrent` 这种字段（我第一版按"应该有"写，类型检查当场
  //    拦下）。判据用 `currentRuntime`——它就是 daemon 启动时选中/侦测到的那个 key。
  $: detectedRuntime = $identity?.currentRuntime ?? '?'
  import { setThemePref, themePref, type ThemePref } from '@agentdeck/ui'

  /** 主题三档：**存键、不存渲染好的句子**（切语言时标签要跟着变，渲染交给 $t）。 */
  const THEME_CHOICES = [
    { value: 'light', labelId: 'settings.themeLight' },
    { value: 'dark', labelId: 'settings.themeDark' },
    { value: 'system', labelId: 'settings.themeSystem' },
  ] as const satisfies ReadonlyArray<{ value: ThemePref; labelId: string }>

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
      ★ 界面主题（亮 / 暗 / 跟随系统）：**唯一入口**在这里——顶栏不再放
        第二个开关（语言那份就是"设置里已有、顶栏不重复"撤掉的）。三档
        是"跟随系统 / 手动定死"，不是两种颜色；见 `lib/theme.ts` 顶部。
    -->
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

    <!--
      ★ 界面语言（D39）：这里是**唯一入口**（顶栏那份 2026-09 已撤——不是常用
        设置）。切换器本身说不清"prompt 不变"这件事，所以这里多给一句说明。
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

    <!--
      ★ claude 的 WebSearch / WebFetch 开关（D77，默认开）。

      WebSearch/WebFetch 是 Anthropic **服务端**工具：官方端点真执行；第三方
      兼容端点（DeepSeek / 阿里云百炼）没有执行器、模型会**幻觉搜索结果**。
      默认开 = 尊重功能（调研类任务是刚需）；在第三方端点上真出幻觉死循环时，
      关掉它让 claude 退化为 Bash+curl 调研（执行在本地、任何端点都能干活）。
    -->
    <section class="drawer-section" data-web-search>
      <h3>{$t('settings.webSearch')}</h3>
      <label>
        <input
          type="checkbox"
          checked={$identity?.webSearchEnabled ?? true}
          onchange={(e) => {
            const next = (e.currentTarget as HTMLInputElement).checked
            void api('/api/workspace/web-search', {
              method: 'PUT',
              body: JSON.stringify({ enabled: next }),
            })
              .then(() => void loadIdentity())
              .catch((err) =>
                showToast(err instanceof Error ? err.message : String(err)),
              )
          }}
        />
        {$t('settings.webSearchLabel')}
      </label>
      <p class="hint">{$t('settings.webSearchHint')}</p>
    </section>

    <!--
      ★ 全局 runtime 默认值（2026-10，定稿第 ⑦ 条）。

      agent 的 `runtimeKey` 记 `'default'` 时用它，**三级解析**：
      `agent 的值 ⇒ 这一项 ⇒ 启动时侦测到的那个`。所以"自动侦测"必须是**一个能选的
      选项**（空串），而不是"没设过"——不给这一项的话，使用者想回到自动就只能猜一个
      具体 CLI 填进去，而那不是他想要的。

      ⚠️ 侦测到的那个是**启动时**定的（`currentRuntime`）。所以这里如实说"当前 X"，
      不假装实时。
    -->
    <section class="drawer-section" data-default-runtime>
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
    </section>

    <!--
      ★ 「关于」这一小段是为一次真实误判加的。

      使用者报"聊天页不工作、任务页正常"，查下来 daemon 与当前前端都是好的——
      他看的是一个**早就开着、没有刷新**的标签页。这类错位（界面与 daemon 各是
      哪一版）在这个项目里已经咬过两次，而两次都是**两边都不报错**。

      所以把"这一版界面叫什么"写在界面上：它由 daemon 从构建产物里读出来
      （`/api/identity` 的 `webBuild`），所以"我到底在跑哪一版"从此是一句可查的
      话，而不是一场猜测。它是只读的——这里没有任何可改的东西。

      ⚠️ 但它**默认收起**（2026-09）：构建文件名与协议版本号是排查用的东西，
      平时摊在设置里就是两条没人看得懂的字（`index-CKNBcUzP.js` / `1`）。
      信息一个字没少，只是要主动点开——判据仍然是"这句话给谁看"。
    -->
    {#if $identity}
      <section class="drawer-section" data-about>
        <h3>{$t('settings.about')}</h3>
        <details>
          <summary class="hint" style="cursor:pointer">{$t('settings.diagnostics')}</summary>
          <p class="hint">
            {$t('settings.webBuildLabel')}
            <code data-web-build>{$identity.webBuild ?? $t('settings.webBuildUnknown')}</code>
          </p>
          <p class="hint">
            {$t('settings.protocolLabel')} <code>{$identity.protocolVersion}</code>
          </p>
        </details>
      </section>
    {/if}

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
        <!-- 2026-10（紧凑性）：保存按钮不再独占一行——与地址输入框同排 -->
        <label style="margin-top:var(--sp-3)">
          {$t('settings.remoteUrl')}
          <div style="display:flex;gap:var(--sp-2)">
            <input bind:value={$remoteUrlValue} style="flex:1;min-width:0" />
            <button type="button" class="secondary" style="flex:none" onclick={saveRemoteUrl}>
              {$t('settings.saveUrl')}
            </button>
          </div>
        </label>
      {:else}
        <p>{$t('settings.signedInAs')}<strong>{$remoteAccount?.displayName}</strong> <span class="faint">{$remoteAccount?.email}</span></p>
        <button type="button" class="secondary" onclick={doLogout}>{$t('settings.signOut')}</button>

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
        {$t('settings.reportingBefore2')}{$t('settings.reportingAfter2')}<strong>{$t('settings.reportingStrong5')}</strong>{$t('settings.reportingEnd')}
      </p>
    </section>
  </div>
</aside>
