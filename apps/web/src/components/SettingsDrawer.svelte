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

  /**
   * ★ 分批第 47 批：「默认工作守则」的草稿与保存。
   *
   * ⚠️ 与"运行时配置"那个开关同一套纪律：**不拿本地变量假装成功**——
   *    存完重新拉 identity，界面显示永远以服务端为准（存失败时保持旧值 + toast）。
   */
  /** 主题三档：**存键、不存渲染好的句子**（切语言时标签要跟着变，渲染交给 $t）。 */
  /**
   * ★ 分批第 242 批：**记忆触发词搬走了**——入口在聊天页的「设置」抽屉
   *   （`components/ChatSettings.svelte`）。使用者的原话是「聊天有个设置，里面有
   *   触发词的设置」：配置找不着就等于没有。这里不再保留第二份编辑入口
   *   （同一份数据两个编辑处，"我改的是哪一个"迟早要问一次）。
   *
   * ⚠️ 配置本身没有搬：仍然是 `Workspace.memoryPrefixes`，全局一份。
   */

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
      ★ 分批第 188 批（使用者："去掉通用设置中的「联网搜索」和「沉淀审核」选项"）：
        这两块**已删**。
        · 联网搜索（`webSearchEnabled`）：claude 的 WebSearch 开关，属于运行时细节，
          不该出现在"通用设置"里；
        · 沉淀审核（`allowReviewerScriptRun`）：沉淀线的评审早就整条下线（§12.15/§12.49），
          这个开关控制的是"审核者能不能跑草稿脚本"——没有审核者，它就是死的。
        服务端那两条 PUT 路由与字段**保留**（老数据还在，删字段要做迁移；而且它们是兼容面），
        只是界面上不再有入口。
    -->

    <!--
      ★ 分批第 47 批：「默认工作守则」——新建智能体时预填到它的指令里。

      使用者要的是「让它尽量和执行者通用」：内置起草者/审核者已经带上那段守则，
      使用者自己新建的执行者也不该"什么规矩都没有"。

      ⚠️ 语义必须写在界面上：这是**预填**（文本拷贝），不是"所有 agent 共享的一条规则"。
         改这里**不会**回头改已存在的 agent——否则使用者改过的身份会被悄悄覆盖。
      ⚠️ 允许存空（= 不预填）：`emptyHint` 会把这件事说出来，不然"存了空的"看起来像没保存。
    -->

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
      <!-- ★ 分批第 242 批：记忆触发词那一节搬到了聊天页的「设置」抽屉
         （`components/ChatSettings.svelte`）——这里不留第二份入口，见上面状态区的说明。 -->

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

<style>
  /* ★ 分批第 242 批：触发词的 chip / 加 / 恢复默认那几段 CSS 跟着那一节搬到了
     `components/ChatSettings.svelte`——留在这里就是一段没人用的样式。 */
</style>
