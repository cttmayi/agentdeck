<script lang="ts">
  /**
   * 技能目录（只读）+ **重新同步**按钮。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这一页为什么是只读的，但同步按钮可以点
   * ══════════════════════════════════════════════════════════════════
   *
   * 目录的内容不是"远端的数据"，而是一个**独立工具**抓下来写进目录的文件
   * （`pnpm run sync-skills`，见 `tools/skill-catalog-sync/`）。所以：
   *
   *   · **装 / 卸**技能在 daemon 界面里做（那边才有使用者本机的技能库），这一页不做；
   *   · 但"重新抓一遍"这件事**本来就发生在远端这台机器上**（工具写的正是远端读的
   *     那个目录），把它做成按钮是合理的——只是服务**不 import** 抓取代码，
   *     而是把那个工具当**子进程**跑（`apps/remote/src/server.ts` 的说明）。
   */
  import { onDestroy, onMount } from 'svelte'
  import { api, type Catalog, type CatalogSkill, type SyncStatus } from '../lib/api.ts'
  import { absoluteTime, relativeTime } from '../lib/format.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import { currentLanguageTag } from '../lib/locale.ts'
  // ⚠️ 两个都要：标记里用 `$t(...)`（订阅，语言一变就重渲染），**回调里用 `tx(...)`**
  //    ——`t` 是 derived store，**不是函数**，`t('remote.x')` 会抛
  //    "t is not a function"，而症状是**整页白屏**（第一版就是这么挂的）。
  //    这与 daemon 那边的约定完全一样（`apps/web/src/lib/i18n.ts` 顶部写着同一条）。
  import { t, tx } from '../lib/locale.ts'
  import { SourceRef, ExpandToggle } from '@agentdeck/ui/components'
  import CatalogPane from '../components/CatalogPane.svelte'

  let catalog: Catalog | null = null
  let error = ''
  let loading = true
  let detail: CatalogSkill | null = null
  let sync: SyncStatus | null = null
  let busy = false

  // ── 手动装 / 卸（D52）──
  // 装的落在远端目录的**本地层**（与同步来的并列、互不干涉）；卸只对本地装的开口子
  // ——同步来的要改清单再同步（服务端会 409 拒绝，这里把理由显示出来）。
  let installUrl = ''
  let installName = ''
  let installSummary = ''
  let installNeeds = ''
  let installBusy = false
  /** 一次性反馈：成功/失败都要说清是哪一条、为什么。 */
  let installNote = ''
  let installNoteBad = false
  let uninstalling: string | null = null

  /** 同步中时定时刷新状态（同步跑在一个独立进程里，可能几十秒到几分钟）。 */
  let poll: ReturnType<typeof setInterval> | null = null

  async function load(): Promise<void> {
    loading = true
    try {
      catalog = await api.catalog()
      error = ''
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  async function loadSync(): Promise<void> {
    try {
      sync = await api.syncStatus()
      const running = sync.state === 'running'
      if (running && poll === null) {
        poll = setInterval(() => void loadSync(), 2000)
      }
      if (!running && poll !== null) {
        clearInterval(poll)
        poll = null
        // 跑完了把目录也刷一遍（成功的新内容要立刻看得见）
        await load()
      }
    } catch {
      // 状态取不到不影响看目录：这里刻意不覆盖 `error`（那是目录的错）
    }
  }

  async function startSync(): Promise<void> {
    busy = true
    try {
      sync = await api.startSync()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function doInstall(): Promise<void> {
    if (installUrl.trim() === '') return
    installBusy = true
    installNote = ''
    try {
      const done = await api.installSkill({
        url: installUrl.trim(),
        ...(installName.trim() !== '' ? { name: installName.trim() } : {}),
        ...(installSummary.trim() !== '' ? { summary: installSummary.trim() } : {}),
        ...(installNeeds.trim() !== '' ? { needs: installNeeds.trim() } : {}),
      })
      installNoteBad = false
      installNote = tx('remote.installOk', { slug: done.slug, count: done.files.length })
      installUrl = ''
      installName = ''
      installSummary = ''
      installNeeds = ''
      await load()
    } catch (err) {
      installNoteBad = true
      installNote = err instanceof Error ? err.message : String(err)
    } finally {
      installBusy = false
    }
  }

  async function doUninstall(slug: string): Promise<void> {
    // 卸载是**不可逆**的（目录里那份会被删掉），所以问一句；文案里说清"影响的只是目录"
    const ok = await askConfirm({
      title: tx('remote.uninstall'),
      message: tx('remote.uninstallConfirm', { slug }),
      confirmLabel: tx('remote.uninstall'),
      danger: true,
    })
    if (!ok) return
    uninstalling = slug
    try {
      await api.uninstallSkill(slug)
      installNoteBad = false
      installNote = tx('remote.uninstallOk', { slug })
      if (detail?.slug === slug) detail = null
      await load()
    } catch (err) {
      installNoteBad = true
      installNote = err instanceof Error ? err.message : String(err)
    } finally {
      uninstalling = null
    }
  }

  onMount(() => {
    void load()
    void loadSync()
    return () => {
      if (poll !== null) clearInterval(poll)
    }
  })

  // ★ 目录就绪后的派生量（CatalogPane 的四态在它内部处理；snippet 是函数
  //   拿不到 `{#if}` 的收窄，所以直接用**非空数组**）
  $: skills = catalog?.skills ?? []
  $: emptyText = catalog !== null && skills.length === 0 ? $t('remote.skillsEmpty') : ''
  $: titleCount = `${$t('remote.skillsTitle')} · ${$t('remote.skillsCount', { count: skills.length })}`

  onDestroy(() => {
    if (poll !== null) clearInterval(poll)
  })

  const runningSeconds = (): number => {
    if (!sync || sync.state !== 'running' || !sync.startedAt) return 0
    const started = Date.parse(sync.startedAt)
    return Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0
  }

  /** 按钮为什么不能点——**必须有理由**（项目纪律：置灰的按钮要写清为什么）。 */
  const syncDisabledReason = (): string => {
    if (sync === null) return tx('remote.loading')
    if (sync.state === 'unavailable') return tx('remote.syncUnavailable')
    if (sync.state === 'running') return tx('remote.syncBusy', { seconds: runningSeconds() })
    return ''
  }
</script>

<div class="page-actions">
  <button
    type="button"
    class="small"
    disabled={busy || syncDisabledReason() !== ''}
    title={syncDisabledReason()}
    onclick={() => void startSync()}
  >
    {sync?.state === 'running'
      ? $t('remote.syncBusy', { seconds: runningSeconds() })
      : $t('remote.syncNow')}
  </button>
  <span class="faint small">
    <!-- ⚠️ 这里只放这句话：**页面不知道清单的"核对于"是哪天**（那是清单文件的字段），
         所以不许在这儿编一个日期（第一版我就那么写了，随即撤掉——"编一个值"正是
         这个仓库最防的东西）。条数由表格标题那块如实显示（`共 N 条`）。 -->
    {#if sync === null}
      {$t('remote.loading')}
    {:else if sync.state === 'unavailable'}
      {$t('remote.syncUnavailable')}
    {:else if sync.state === 'running'}
      {$t('remote.syncStarted', { time: relativeTime(sync.startedAt, Date.now()) })}
    {:else if sync.state === 'ok'}
      {$t('remote.syncOk', { time: relativeTime(sync.finishedAt, Date.now()) })}
    {:else if sync.state === 'failed'}
      {$t('remote.syncFailed', { reason: `${sync.exitCode ?? '?'}` })}
    {:else}
      {$t('remote.syncNever')}
    {/if}
  </span>
</div>
<!-- ★ 这句单独一行（2026-10 审查时量的）：它原来和按钮**同一行**，于是按钮被挤到
     745px 之外、标签折成两行 ⇒ 实测 54px 高（daemon 那一档是 32px）。长句自己占一行，
     按钮就不会被挤。这句本身是使用者问过"同步的是什么"之后补的，必须看得见。 -->
<p class="faint small" style="margin:var(--sp-2) 0 0">{$t('remote.syncWhat')}</p>
<!-- ★ 清单这一行来自**接口给的真实数据**（D54）：条数、核对于哪天、文件在哪。
     以前这里写的是仓库里的路径，而且我一度想写死一个日期——那是编值，被自己撤了。
     三种状态分开说：有配置 / 还没转存 / 读不了。 -->
<p class="faint small manifest-line">
  {#if catalog?.manifest && !catalog.manifest.exists}
    {$t('remote.manifestMissing', { path: catalog.manifest.path })}
  {:else if catalog?.manifest?.error}
    {$t('remote.manifestBroken', { error: catalog.manifest.error })}
  {:else if catalog?.manifest}
    {$t('remote.manifestLine', {
      count: catalog.manifest.count,
      verified: catalog.manifest.verifiedAt ?? $t('remote.manifestNoVerified'),
      path: catalog.manifest.path,
    })}
  {/if}
</p>

<details class="install-box" open={installNoteBad || installNote !== ''}>
  <summary>{$t('remote.installTitle')}</summary>
  <div class="install-form">
    <label for="install-url">{$t('remote.installUrlLabel')}</label>
    <input
      id="install-url"
      bind:value={installUrl}
      placeholder="https://github.com/owner/repo/tree/main/skills/name"
    />
    <p class="faint small">{$t('remote.installUrlHint')}</p>
    <div class="install-row">
      <div>
        <label for="install-name">{$t('remote.installNameLabel')}</label>
        <input id="install-name" bind:value={installName} />
      </div>
      <div>
        <label for="install-needs">{$t('remote.installNeedsLabel')}</label>
        <input id="install-needs" bind:value={installNeeds} />
      </div>
    </div>
    <label for="install-summary">{$t('remote.installSummaryLabel')}</label>
    <input id="install-summary" bind:value={installSummary} />
    <p>
      <button
        type="button"
        disabled={installBusy || installUrl.trim() === ''}
        onclick={() => void doInstall()}
      >
        {installBusy ? $t('remote.installing') : $t('remote.installSubmit')}
      </button>
    </p>
  </div>
</details>

{#if installNote !== ''}
  <div class={installNoteBad ? 'notice bad' : 'notice good'}>{installNote}</div>
{/if}

{#if sync && sync.tail.length > 0}
  <details class="faint small">
    <summary>{$t('remote.syncLogTitle', { count: sync.tail.length })}</summary>
    <pre class="log-tail">{sync.tail.join('\n')}</pre>
  </details>
{/if}

<CatalogPane
  loading={loading}
  error={error}
  empty={emptyText}
  titleCount={titleCount}
  columns={[
    { label: $t('remote.colSlug') },
    { label: $t('remote.colSource') },
    { label: $t('remote.colVersion') },
    { label: $t('remote.colFiles') },
    { label: $t('remote.colSynced') },
    { label: '', ariaLabel: $t('remote.detailContent') },
  ]}
  footer={$t('remote.whereToInstall')}
  loadingText={$t('remote.loading')}
  retryText={$t('remote.retry')}
  closeText={$t('remote.close')}
  onretry={() => void load()}
  detailTitle={detail ? detail.name || detail.slug : ''}
  detailRef={detail ? detail.sourceRef : ''}
  onclose={() => (detail = null)}
>
  {#snippet rows()}
    {#each skills as s (s.slug)}
      {@const fileCount = Object.keys(s.files).length}
        <tr>
          <td>
            <!-- D69.6：技能列只放技能本身（slug + 名称 + 内容不完整提示）——
                 来源相关（徽章 + `github:…`）都挪去「来源」列，与 daemon 主表同一布局。 -->
            <div class="row-title">
              <!-- D69.8：remote 补上 ▸ 入口（与 daemon 同一入口）——点它开抽屉；
                   抽屉开着时箭头朝下。查看按钮仍保留。 -->
              <ExpandToggle
                expanded={detail?.slug === s.slug}
                labelExpand={$t('remote.expandDetail')}
                labelCollapse={$t('remote.collapseDetail')}
                onclick={() => (detail = detail?.slug === s.slug ? null : s)}
              />
              <code>{s.slug}</code>
            </div>
            {#if s.name}<div class="faint small">{s.name}</div>{/if}
            {#if s.excluded && s.excluded.length > 0}
              <div class="warn small" title={s.excluded.join('\n')}>
                {$t('remote.incomplete', { count: s.excluded.length })}
              </div>
            {/if}
          </td>
          <td>
            <!-- ★ 来源列：徽章（推荐清单/本地添加）与 `github:…` 来源标识都在这里，
                 和 daemon 主表的「来源」列是同一件事。 -->
            <span class="badge" class:local={s.source === 'local'}>
              {s.source === 'local' ? $t('remote.sourceLocal') : $t('remote.sourceSynced')}
            </span>
            <SourceRef value={s.sourceRef} />
          </td>
          <td class="faint small">{s.version ? `v${s.version}` : $t('remote.noVersion')}</td>
          <td class="faint small">
            <!-- D69.5：与 daemon 同一档显示——`files` 都是**不含 SKILL.md** 的支持
                 文件（同一个 resolveLocalPath 规则），所以同一套格式：SKILL.md + N，
                 0 个支持文件时只写 SKILL.md（不写刺眼的 0 个文件）。 -->
            SKILL.md{#if fileCount > 0} +{fileCount}{/if}
          </td>
          <td class="faint small" title={absoluteTime(s.fetchedAt, currentLanguageTag())}>
            {relativeTime(s.fetchedAt, Date.now())}
          </td>
          <td>
            <div class="row-actions">
              <button type="button" class="secondary small" onclick={() => (detail = s)}>
                {$t('remote.view')}
              </button>
              {#if s.source === 'local'}
                <button
                  type="button"
                  class="ghost small danger"
                  disabled={uninstalling === s.slug}
                  onclick={() => void doUninstall(s.slug)}
                >
                  {$t('remote.uninstall')}
                </button>
              {:else}
                <!-- ⚠️ 同步来的**不给卸载按钮**，但要说明该怎么做（项目纪律：不能做的
                     事要说清为什么、以及替代路径）。推荐清单里去掉它再点"重新同步"。 -->
                <button type="button" class="ghost small" disabled title={$t('remote.syncedNotRemovable')}>
                  {$t('remote.uninstall')}
                </button>
              {/if}
            </div>
          </td>
        </tr>
    {/each}
  {/snippet}
  {#snippet drawerBody()}
    <h3>{$t('remote.detailContent')}</h3>
    <pre class="file-text">{detail!.content}</pre>
    {#if detail!.needs}
      <!-- ★ 装完还得自己配的东西必须在装之前/刚打开时就看得见（web 目录表在装前
           就显示）：装完才发现不能用，比不推荐更糟。 -->
      <h3>{$t('remote.detailNeeds')}</h3>
      <p class="warn small">{detail!.needs}</p>
    {/if}
    <h3>{$t('remote.detailFiles')}</h3>
    <ul class="faint small">
      {#each Object.keys(detail!.files).sort() as path (path)}
        <li><code>{path}</code></li>
      {/each}
    </ul>
    {#if detail!.excluded.length > 0}
      <h3>{$t('remote.detailExcluded')}</h3>
      <ul class="warn small">
        {#each detail!.excluded as path (path)}
          <li><code>{path}</code></li>
        {/each}
      </ul>
    {/if}
  {/snippet}
</CatalogPane>
<style>
  /* 安装表单与来源徽标：只放这一页独有的部分，表格/抽屉/按钮/提示条全部来自
     共用样式（`@agentdeck/ui`）。 */
  .install-box {
    border: 1px solid var(--line);
    border-radius: var(--radius-1);
    padding: var(--sp-2) var(--sp-3);
    margin-bottom: var(--sp-3);
  }
  .install-box summary {
    cursor: pointer;
  }
  .install-form {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }
  .manifest-line {
    margin: 0 0 var(--sp-3);
    /* 路径可能很长：允许折行，但不要撑出横向滚动 */
    overflow-wrap: anywhere;
  }
  .install-row {
    display: grid;
    /* 窄屏自动折成一列（原来是写死的 `1fr 1fr`：窗口一窄两格就互相挤） */
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: var(--sp-3);
  }

  /* 只放这一页独有的两块：同步输出与 SKILL.md 正文的滚动盒子。
     表格、抽屉、提示条、按钮全部来自共用样式（`@agentdeck/ui`）。 */
  .log-tail {
    max-height: 16rem;
    overflow: auto;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-1);
    padding: var(--sp-2);
    margin: var(--sp-2) 0;
    white-space: pre-wrap;
  }
  .file-text {
    max-height: 24rem;
    overflow: auto;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-1);
    padding: var(--sp-3);
    white-space: pre-wrap;
  }
</style>
