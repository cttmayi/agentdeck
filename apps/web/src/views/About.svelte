<script lang="ts">
  /**
   * 关于页（2026-11，使用者立项）：版本 · 环境 · 边界。
   *
   * 收拢散在各处的诊断信息——侧栏底部状态块（设备名 / CLI 版本 / 环境问题）与
   * 设置抽屉「关于」折叠区（webBuild / protocolVersion）**移到这一页**，加上
   * 文档里才有的存储目录与安全边界——"这一台是怎么搭的"在一页讲完。
   *
   * ⚠️ 数据全部来自 daemon 的 `/api/identity`（界面不猜值）：老 daemon 不带
   *    `nodeVersion` / `workDir` 等新键 ⇒ 对应行隐藏（见 `api.ts` 的注释）。
   *   安全边界是静态产品文案（提炼自根 README「安全边界」，原文是必读）。
   */
  import { identity, syncStatus } from '../lib/stores.ts'
  import { t, tx } from '../lib/i18n.ts'
  import type { RuntimeView } from '../lib/api.ts'

  /** CLI 一行：命令 + 版本 + 可用性徽标（罗列侦测到的，不强调"当前"）。 */
  function cliLine(rt: RuntimeView): { cmd: string; version: string | null; state: string; ok: boolean } {
    if (rt.available) {
      return {
        cmd: rt.command,
        version: rt.cliVersion,
        state: tx('about.cliAvailable'),
        ok: true,
      }
    }
    return { cmd: rt.command, version: null, state: tx('about.cliMissing'), ok: false }
  }

  function localeName(locale?: string): string {
    return locale === 'en' ? tx('about.localeEn') : tx('about.localeZh')
  }

  /** 诊断区默认折叠（排查"两边都不报错"的版本错位才看）。 */
  let diagnosticsOpen = false
</script>

<div class="view-intro">
  <p>{$t('about.sub')}</p>
</div>

{#if !$identity}
  <div class="skeleton"></div>
{:else}
  {@const id = $identity}

  <!-- ★ 2026-11（使用者拍板"关于也改成 2 列"）：六卡流式两列。
       ★ D179：网格与卡片外壳都改用全局的（`.card-grid` + `.main-panel`）——当时"与设置页
       同款"只写在这行注释里：网格在页面里各写了一份逐字相同的 `.ab-grid`/`.set-grid`，
       卡片外壳一个是页面私有的 `.ab-card`（标题 15px、边框还拿填充档 `--surface-2` 当线），
       另一个是全局 `.main-panel`（标题 17px、边框 `--line`）。 -->
  <div class="card-grid">

  <!-- ① 应用 -->
  <section class="main-panel" data-ab-app>
    <header class="main-panel-head">
      <h2>{$t('about.app')}</h2>
    </header>
    <div class="main-panel-body">
      <div class="ab-row"><span class="ab-k">{$t('about.appName')}</span></div>
      <div class="ab-row">
        <span class="ab-k">{$t('about.protocolVersion')}</span>
        <span class="ab-v"><code>v{id.protocolVersion ?? tx('about.unknown')}</code></span>
      </div>
      <div class="ab-row">
        <span class="ab-k">{$t('about.device')}</span>
        <span class="ab-v">{id.deviceName} <span class="ab-badge ab-badge--good">{$t('about.currentDevice')}</span></span>
      </div>
      <div class="ab-row">
        <span class="ab-k">{$t('about.locale')}</span>
        <span class="ab-v">{localeName(id.locale)}</span>
      </div>
    </div>
  </section>

  <!-- ② 运行环境：罗列侦测到的 CLI（不强调"当前"） -->
  <section class="main-panel" data-ab-env>
    <header class="main-panel-head">
      <h2>{$t('about.env')}</h2>
    </header>
    <div class="main-panel-body">
      {#if id.runtimes.length > 0}
        <div class="ab-row">
          <span class="ab-k">{$t('about.runtimesLabel')}</span>
          <span class="ab-v">
            {#each id.runtimes as rt (rt.key)}
              <span class="ab-cli">
                {cliLine(rt).cmd}
                {#if cliLine(rt).version}<code>{cliLine(rt).version}</code>{/if}
                <span class:ab-badge--good={cliLine(rt).ok} class:ab-badge--bad={!cliLine(rt).ok} class="ab-badge">
                  {cliLine(rt).state}
                </span>
              </span>
            {/each}
          </span>
        </div>
      {/if}
      {#if id.nodeVersion || id.platform}
        <div class="ab-row">
          <span class="ab-k">{$t('about.nodePlatform')}</span>
          <span class="ab-v">{id.nodeVersion ?? tx('about.unknown')} · {id.platform ?? tx('about.unknown')}</span>
        </div>
      {/if}
      <div class="ab-row">
        <span class="ab-k">{$t('about.envPreflight')}</span>
        <span class="ab-v">
          {#if id.environment && id.environment.issues.length > 0}
            <span class="ab-badge ab-badge--warn">{$t('about.envIssuesCount', { n: id.environment.issues.length })}</span>
          {:else}
            <span class="ab-badge ab-badge--good">{$t('about.envNoIssues')}</span>
          {/if}
        </span>
      </div>
      {#if id.environment && id.environment.issues.length > 0}
        <ul class="ab-issues">
          {#each id.environment.issues as issue (issue.subject)}
            <li class:ab-issue--err={issue.severity === 'error'}>
              <span class="ab-issue-subj">{issue.subject}</span> — {issue.summary}
              {#if issue.action}
                <div class="ab-issue-act">{$t('about.issueAction')}{issue.action}</div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </section>

  <!-- ③ 存储与目录 -->
  <section class="main-panel" data-ab-storage>
    <header class="main-panel-head">
      <h2>{$t('about.storage')}</h2>
    </header>
    <div class="main-panel-body">
      {#if id.workDir}
        <div class="ab-row"><span class="ab-k">{$t('about.workDir')}</span><span class="ab-v"><code>{id.workDir}</code></span></div>
      {/if}
      {#if id.dataDir}
        <div class="ab-row"><span class="ab-k">{$t('about.dataDir')}</span><span class="ab-v"><code>{id.dataDir}</code></span></div>
      {/if}
      {#if id.skillsDir}
        <div class="ab-row"><span class="ab-k">{$t('about.skillsDir')}</span><span class="ab-v"><code>{id.skillsDir}</code></span></div>
      {/if}
      <div class="ab-row">
        <span class="ab-k">{$t('about.sync')}</span>
        <span class="ab-v">
          {#if $syncStatus?.error}
            {$t('about.syncError')}
          {:else if $syncStatus}
            {$t('about.syncReported', { n: $syncStatus.reported })}
            {#if $syncStatus.queued > 0}· {$t('about.syncQueued', { n: $syncStatus.queued })}{/if}
          {:else}
            {$t('about.syncNever')}
          {/if}
        </span>
      </div>
    </div>
  </section>

  <!-- ④ 安全边界（静态文案，原文在根 README） -->
  <section class="main-panel" data-ab-security>
    <header class="main-panel-head">
      <h2>{$t('about.security')}</h2>
    </header>
    <div class="main-panel-body">
      <p class="ab-lead">{$t('about.securityLead')}</p>
      <div class="ab-row"><span class="ab-k">{$t('about.securityFiles')}</span><span class="ab-v">{$t('about.securityFilesValue')}</span></div>
      <div class="ab-row"><span class="ab-k">{$t('about.securityIsolation')}</span><span class="ab-v">{$t('about.securityIsolationValue')}</span></div>
      <div class="ab-row"><span class="ab-k">{$t('about.securityVerdict')}</span><span class="ab-v">{$t('about.securityVerdictValue')}</span></div>
    </div>
  </section>

  <!-- ⑤ 诊断（默认折叠：排查版本错位才看） -->
  <section class="main-panel" data-ab-diagnostics>
    <header class="main-panel-head">
      <h2>{$t('about.diagnostics')}</h2>
    </header>
    <div class="main-panel-body">
      <details>
        <summary class="hint" style="cursor:pointer">{$t('about.diagnosticsNote')}</summary>
        <div class="ab-row" style="margin-top:var(--sp-2)">
          <span class="ab-k">{$t('about.webBuildLabel')}</span>
          <span class="ab-v"><code data-web-build>{id.webBuild ?? tx('about.unknown')}</code></span>
        </div>
        <div class="ab-row">
          <span class="ab-k">{$t('about.protocolVersion')}</span>
          <span class="ab-v"><code>{id.protocolVersion ?? tx('about.unknown')}</code></span>
        </div>
        {#if id.capabilities && id.capabilities.length > 0}
          <div class="ab-row">
            <span class="ab-k">{$t('about.capabilitiesLabel')}</span>
            <span class="ab-v">
              {#each id.capabilities as cap (cap)}
                <span class="ab-chip">{cap}</span>
              {/each}
            </span>
          </div>
        {/if}
      </details>
    </div>
  </section>

  <!-- ⑥ 文档与决策 -->
  <section class="main-panel" data-ab-docs>
    <header class="main-panel-head">
      <h2>{$t('about.docs')}</h2>
    </header>
    <div class="main-panel-body">
      <div class="ab-row"><span class="ab-k">{$t('about.docsDeveloper')}</span><span class="ab-v">{$t('about.docsDeveloperHint')}</span></div>
      <div class="ab-row"><span class="ab-k">{$t('about.docsDecisions')}</span><span class="ab-v">{$t('about.docsDecisionsHint')}</span></div>
      <div class="ab-row"><span class="ab-k">{$t('about.docsSecurity')}</span><span class="ab-v">{$t('about.docsSecurityHint')}</span></div>
      <div class="ab-row"><span class="ab-k">{$t('about.docsUiStyle')}</span><span class="ab-v">{$t('about.docsUiStyleHint')}</span></div>
      <p class="ab-note">{$t('about.docsNote')}</p>
    </div>
  </section>

  </div>
{/if}

<style>
  /**
   * 关于页布局（页面专属；控件样式不进这里——见 ui-style.md §2）。
   * ★ D179：`.ab-grid` / `.ab-card` / `.ab-card h2` 三条**已删**——网格用全局 `.card-grid`，
   *   卡片外壳用全局 `.main-panel`（与设置页同一套）。顺带修掉一条同 D174 的错：边框原来写的
   *   是 `border: 1px solid var(--surface-2)`（拿填充档当线），现在是 `.main-panel` 里的 `--line`。
   */
  .ab-row {
    display: flex;
    justify-content: space-between;
    gap: var(--sp-4);
    padding: var(--sp-2) 0;
    border-bottom: 1px solid var(--line);
  }
  .ab-row:last-child { border-bottom: 0; }
  .ab-k { color: var(--text-dim); white-space: nowrap; }
  .ab-v { text-align: right; word-break: break-all; }
  .ab-v code {
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    padding: 1px var(--sp-2);
    font-size: var(--fs-xs);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .ab-badge {
    display: inline-block;
    font-size: var(--fs-2xs);
    border-radius: var(--radius-pill);
    padding: 1px var(--sp-2);
    margin-left: var(--sp-2);
  }
  .ab-badge--good { color: var(--good); background: color-mix(in srgb, var(--good) 12%, transparent); }
  .ab-badge--warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent); }
  .ab-badge--bad { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); }
  .ab-cli { margin-left: var(--sp-3); }
  .ab-cli code { margin: 0 var(--sp-2); }
  .ab-issues {
    list-style: none;
    margin: var(--sp-2) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .ab-issues li {
    border: 1px solid var(--line);
    border-left: 3px solid var(--warn);
    border-radius: var(--radius-md);
    padding: var(--sp-2) var(--sp-3);
    font-size: var(--fs-sm);
  }
  .ab-issues li.ab-issue--err { border-left-color: var(--bad); }
  .ab-issue-subj { font-weight: 600; }
  .ab-issue-act { color: var(--text-dim); font-size: var(--fs-xs); margin-top: var(--sp-1); }
  .ab-chip {
    display: inline-block;
    font-size: var(--fs-2xs);
    background: var(--surface-2);
    border-radius: var(--radius-pill);
    padding: 1px var(--sp-2);
    color: var(--text-dim);
    margin: var(--sp-1);
  }
  .ab-lead { font-size: var(--fs-sm); margin-bottom: var(--sp-2); }
  .ab-note {
    font-size: var(--fs-xs);
    color: var(--text-dim);
    margin-top: var(--sp-2);
  }
</style>
