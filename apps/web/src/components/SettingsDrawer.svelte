<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type CostReport } from '../lib/api.ts'
  import {
    getRemoteUrl,
    isLoggedIn,
    remote,
    setRemoteUrl,
    type Catalog,
    type PluginInfo,
    type RemoteAccount,
  } from '../lib/remote.ts'
  import { syncStatus } from '../lib/stores.ts'
  import { showToast } from '../lib/view.ts'

  export let onclose: () => void

  /**
   * 设置抽屉：成本、审计导出、远端账号、目录、插件、同步说明。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么这些放在抽屉里而不是各占一栏
   * ══════════════════════════════════════════════════════════════════
   *
   * 它们都是**低频**的：设一次、看一眼，然后就不管了。占着侧边栏会让
   * 高频的四项被稀释。抽屉的好处是"随时能开、开完就走"，不改变当前在看的
   * 东西——这正是设置该有的存在感。
   *
   * ══════════════════════════════════════════════════════════════════
   * 远端不可用**不能挡住本机功能**
   * ══════════════════════════════════════════════════════════════════
   *
   * 所以这一整块是独立加载的：远端挂了只让"远端能力"那一段显示一段提示，
   * 成本与审计导出照常工作。
   */

  // ── 成本 ──
  let costs: CostReport | null = null
  let costsError = ''

  // ── 远端 ──
  let remoteUrl = getRemoteUrl()
  let loggedIn = isLoggedIn()
  let account: RemoteAccount | null = null
  let plugins: PluginInfo[] = []
  let catalog: Catalog | null = null
  let remoteError = ''
  let remoteNote = ''
  let email = ''
  let password = ''
  let settingKey = ''
  let settingValue = ''

  onMount(async () => {
    try {
      costs = await api<CostReport>('/api/costs')
    } catch (err) {
      costsError = err instanceof Error ? err.message : String(err)
    }
    await refreshRemote()
  })

  async function refreshRemote(): Promise<void> {
    remoteError = ''
    try {
      catalog = await remote.catalog()
    } catch (err) {
      remoteError = err instanceof Error ? err.message : String(err)
      return
    }
    if (!loggedIn) return
    try {
      const me = await remote.me()
      account = me.account
      plugins = me.plugins
    } catch (err) {
      // 401 是"凭证过期了"，不是"远端坏了"——要区别对待，
      // 否则使用者会去重启服务，而真正该做的是重新登录
      if (err instanceof Error && 'status' in err && (err as { status: number }).status === 401) {
        remote.logout()
        loggedIn = false
        remoteError = '登录已失效，请重新登录'
      } else {
        remoteError = err instanceof Error ? err.message : String(err)
      }
    }
  }

  async function doLogin(register: boolean): Promise<void> {
    remoteError = ''
    try {
      account = register
        ? await remote.register(email, password)
        : await remote.login(email, password)
      loggedIn = true
      password = ''
      await refreshRemote()
      showToast(register ? '已注册并登录' : '已登录')
    } catch (err) {
      remoteError = err instanceof Error ? err.message : String(err)
    }
  }

  async function saveRemoteUrl(): Promise<void> {
    setRemoteUrl(remoteUrl.trim())
    await refreshRemote()
  }

  async function togglePlugin(p: PluginInfo): Promise<void> {
    try {
      await remote.setPluginEnabled(p.name, !p.enabled)
      await refreshRemote()
    } catch (err) {
      remoteError = err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * 把远端目录里的 skill 交给**本机 daemon**。
   *
   * 冲突必须**看得见**：daemon 那边对同名一律拒绝写入（不覆盖你的东西），
   * 而如果界面只说"下载完成"，使用者就会以为装上了——那就是静默。
   */
  async function installSkill(slug: string): Promise<void> {
    remoteNote = `正在下载 ${slug}…`
    try {
      const skill = catalog?.skills.find((s) => s.slug === slug)
      if (!skill) {
        remoteNote = `目录里没有 ${slug}`
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
              sourceRef: `remote:${skill.slug}@${skill.version}`,
            },
          ],
        }),
      })
      const skipped = out.skipped ?? []
      remoteNote =
        (out.installed?.length ?? 0) > 0
          ? `已安装 ${slug}` + (skipped.length ? `；跳过：${skipped.map((s) => s.reason).join('；')}` : '')
          : `未安装：${skipped.map((s) => s.reason).join('；') || '未知原因'}`
    } catch (err) {
      remoteNote = `安装失败：${err instanceof Error ? err.message : String(err)}`
    }
  }

  async function saveSetting(): Promise<void> {
    const key = settingKey.trim()
    if (!key) return
    try {
      // 值按 JSON 解析；解析不了就当字符串——这样 `false` 与 `false`（字符串）
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
      showToast('设定已保存，立即生效')
    } catch (err) {
      remoteError = err instanceof Error ? err.message : String(err)
    }
  }
</script>

<aside class="drawer">
  <div class="drawer-head">
    <h2>设置</h2>
    <button type="button" class="ghost" onclick={onclose}>关闭</button>
  </div>

  <div class="drawer-body">
    <!-- ══════════ 成本 ══════════ -->
    <section class="drawer-section">
      <h3>成本</h3>
      {#if costsError}
        <div class="notice bad">{costsError}</div>
      {:else if !costs}
        <div class="skeleton" style="width:40%"></div>
      {:else}
        <p>
          总计 <strong>${(costs.total.costUsdMicros / 1e6).toFixed(4)}</strong>
          <span class="faint">· {costs.total.runs} 次执行</span>
          {#if costs.runsWithoutUsage > 0}
            <span class="bad">· 其中 {costs.runsWithoutUsage} 次没有上报用量</span>
          {/if}
        </p>
        {#if costs.byKind.length > 0}
          <div class="table-wrap">
            <table>
              <thead><tr><th>类型</th><th>次数</th><th>成本 (USD)</th><th>备注</th></tr></thead>
              <tbody>
                {#each costs.byKind as b (b.key)}
                  <tr>
                    <td>{b.key}</td>
                    <td>{b.runs}</td>
                    <td>{(b.costUsdMicros / 1e6).toFixed(4)}</td>
                    <td class="faint small">{b.estimatedRuns > 0 ? `${b.estimatedRuns} 条为估算` : '—'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        {#if costs.runsWithoutUsage > 0}
          <p class="hint">
            ⚠️ 没有上报用量的执行<strong>不计入</strong>成本。把缺失当零会让"总成本"
            变成一个误导性的数字。
          </p>
        {/if}
      {/if}

      <!-- 审计导出是**下载**，不是页面内渲染——用链接让浏览器走原生下载语义 -->
      <a href="/api/audits/export" download>
        <button type="button" class="secondary">导出审计链（JSON）</button>
      </a>
      <p class="hint">
        导出的文件自带校验和，改动任何一个字段都会被查出来。它同时把能力边界写在文件里
        ——审计链可追溯但<strong>不可复现</strong>（skill 记录不含指纹），argv 已脱敏。
      </p>
    </section>

    <hr />

    <!-- ══════════ 远端能力 ══════════ -->
    <section class="drawer-section">
      <h3>
        远端能力
        {#if remoteError}
          <span class="bad small">{remoteError}</span>
        {:else if catalog}
          <span class="faint small">已连接 {getRemoteUrl()}</span>
        {/if}
      </h3>

      {#if !loggedIn}
        <p class="hint">
          远端服务是<strong>另一个进程</strong>，本页面直接访问它（这一跳是跨源的，
          由远端放行回环来源）。daemon 自己不向远端发任何请求。
        </p>
        <form onsubmit={(e) => { e.preventDefault(); void doLogin(false) }}>
          <label>
            邮箱
            <input bind:value={email} type="email" required autocomplete="username" />
          </label>
          <label>
            口令（至少 8 位）
            <input bind:value={password} type="password" required autocomplete="current-password" />
          </label>
          <div style="display:flex;gap:var(--sp-2)">
            <button type="submit">登录</button>
            <button type="button" class="secondary" onclick={() => void doLogin(true)}>注册</button>
          </div>
        </form>
        <label style="margin-top:var(--sp-3)">
          远端地址
          <input bind:value={remoteUrl} />
        </label>
        <button type="button" class="secondary" onclick={saveRemoteUrl}>保存地址并重连</button>
      {:else}
        <p>已登录：<strong>{account?.displayName}</strong> <span class="faint">{account?.email}</span></p>
        <button
          type="button"
          class="secondary"
          onclick={() => {
            remote.logout()
            loggedIn = false
            account = null
            plugins = []
          }}
        >
          退出登录
        </button>

        <h4>我的设定</h4>
        <form onsubmit={(e) => { e.preventDefault(); void saveSetting() }}>
          <label>
            键
            <input bind:value={settingKey} placeholder="pollIntervalMs / reportingEnabled" autocomplete="off" />
          </label>
          <label>
            值（JSON；解析不了按字符串）
            <input bind:value={settingValue} placeholder="60000 或 false" autocomplete="off" />
          </label>
          <button type="submit">保存（立即生效）</button>
        </form>
        <p class="hint">
          常用：<code>pollIntervalMs</code>（最小 10000）、<code>reportingEnabled: false</code>
          关闭上报。
        </p>

        <h4>插件清单</h4>
        {#if plugins.length === 0}
          <p class="faint small">没有加载任何插件。</p>
        {:else}
          <div class="table-wrap">
            <table>
              <thead><tr><th>插件</th><th>能力</th><th>状态</th><th>密钥</th><th></th></tr></thead>
              <tbody>
                {#each plugins as p (p.name)}
                  <tr>
                    <td><code>{p.name}</code></td>
                    <td class="faint small">{p.capability}</td>
                    <!-- 「加载成功」与「使用者启用」必须分开显示：混成一个布尔
                         就分不清"代码坏了"和"我自己关掉了" -->
                    <td>
                      {#if !p.loaded}
                        <span class="bad">加载失败</span>
                      {:else if p.enabled}
                        <span class="good">已启用</span>
                      {:else}
                        <span class="faint">已停用</span>
                      {/if}
                    </td>
                    <!-- 只显示**键名**，绝不显示值 -->
                    <td class="faint small">{p.secretKeys.join(', ') || '—'}</td>
                    <td>
                      {#if p.loaded}
                        <button type="button" class="ghost small" onclick={() => togglePlugin(p)}>
                          {p.enabled ? '停用' : '启用'}
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

      <h4>公共 SKILL 目录</h4>
      {#if !catalog}
        <p class="faint small">远端不可用，目录暂时看不到。</p>
      {:else}
        <ul class="plain">
          {#each catalog.skills as s (s.slug)}
            <li style="display:flex;justify-content:space-between;align-items:center;gap:var(--sp-2);padding:var(--sp-2) 0;border-bottom:1px solid var(--line)">
              <span>
                <code>{s.slug}</code> <span class="faint small">{s.version}</span>
                <br /><span class="faint small">{s.summary}</span>
              </span>
              <button type="button" class="secondary small" onclick={() => installSkill(s.slug)}>
                下载到本机
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if remoteNote}
        <div class="notice" style="margin-top:var(--sp-2)">{remoteNote}</div>
      {/if}

      <h4>同步状态</h4>
      {#if $syncStatus?.error}
        <div class="notice warn">{$syncStatus.error}</div>
      {:else if $syncStatus}
        <p class="faint small">
          已上报 {$syncStatus.reported}
          {#if $syncStatus.queued > 0}· 暂存 {$syncStatus.queued} 条待补交{/if}
          {#if $syncStatus.fetched > 0}· 取回 {$syncStatus.fetched} 条待处理项{/if}
          {#if $syncStatus.skippedReporting}· 上报已关闭{/if}
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
        <strong>上报什么、去哪、算不算证据</strong>：页面定期把<strong>摘要</strong>送到你
        配置的远端服务——执行的用量与状态、任务的状态变更。<strong>不包含</strong> prompt
        正文、代码、报告原文。远端那份副本<strong>不具证据效力</strong>，权威记录在本机
        daemon 里。<br />
        上报可以用 <code>reportingEnabled: false</code> 关闭；关闭后本机功能完整可用。
        远端不可达时记录会<strong>本地暂存、恢复后补交</strong>。
      </p>
    </section>
  </div>
</aside>
