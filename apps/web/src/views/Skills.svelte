<script lang="ts">
  import { loadSkills, loadError, loading, skills, uninstallSkill } from '../lib/stores.ts'
  import { showToast } from '../lib/view.ts'
  import { remoteCatalog, remoteError, refreshRemote } from '../lib/remote-store.ts'
  import { isLoggedIn } from '../lib/remote.ts'
  import { catalogEntryState } from '../lib/skill-catalog.ts'
  import { t, tx } from '../lib/i18n.ts'
  import {
    InstallError,
    describeInstallMessages,
    installErrorHintMessage,
    installFromPathOrUrl,
    installRemoteEntry,
    renderInstallMessage,
    type InstallMessage,
    type InstallResult,
  } from '../lib/skill-install.ts'

  /**
   * Skills。
   *
   * ★ 这一页只管**资料包**：装什么、装成什么、从哪儿装的。它**不配任何权限**——
   *   "判完允许动什么"是审核者的能力（智能体页 → 点开审核者），D40 收口之前它
   *   一度长在安装表单里，那时"装一份参考资料"与"授权改状态"是同一件事，
   *   而它们本来不该在一起。
   */
  let expanded: string | null = null

  // ── 安装面板 ──
  /**
   * ══════════════════════════════════════════════════════════════════
   * 两个来源放在同一个面板里，而不是各做一个入口
   * ══════════════════════════════════════════════════════════════════
   *
   * "我要装一个 skill"是一个念头，不该先让使用者去判断"我这算远端还是本地"。
   * 所以一个按钮打开一个面板，里面两个页签：**路径 / GitHub** 与**远端目录**。
   */
  let panelOpen = false
  let tab: 'path' | 'remote' = 'path'
  let sourceInput = ''
  let slugInput = ''
  /** 正在卸载哪一条（按钮转圈用）；null = 没有在卸。 */
  let removing: string | null = null
  /**
   * 允许替换同名 skill。
   *
   * ★ 这个勾选框不是可选项，是**必要的逃生口**：daemon 对同名一律拒绝写入
   *   （避免"下载顺手覆盖了你自己的东西"），而它要求"确实要替换请显式传
   *   overwrite: true"。界面若不提供这个开关，同名冲突在浏览器里就是一条**死路**——
   *   使用者看到的是一句"请显式传 overwrite: true"，而他根本没有地方传。
   */
  let overwrite = false
  let busy = false
  let errorMessage = ''
  /**
   * 失败时"那我该怎么做"的**键 + 插值**（认不出的错误码是 `null`）。
   *
   * ★ 存键、不存渲染好的句子：这条提示是界面的一部分，切语言时要跟着变，所以渲染
   *   交给标记里的 `$t`。库层那种"取词那一刻就定下来"的快照是给错误**记录**用的
   *   （见 `errors.ts` 顶部），这里不适用。
   */
  let errorHint: InstallMessage | null = null
  let result: InstallResult | null = null
  /**
   * 安装结果的几段话，同样是**键 + 插值**（`describeInstallMessages()` 产出）。
   *
   * ★ 理由同上：装完之后切语言，这几行字必须跟着变，不能在装的那一刻就被写成中文。
   */
  let note: InstallMessage[] = []

  function resetFeedback(): void {
    errorMessage = ''
    errorHint = null
    result = null
    note = []
  }

  async function runInstall(fn: () => Promise<InstallResult>): Promise<void> {
    busy = true
    resetFeedback()
    try {
      result = await fn()
      const messages = describeInstallMessages(result)
      // 空数组是它说"什么都没发生"的方式。空**不等于**没话说：不补这一句，装了一趟
      // 而结果毫无改动的技能会只留一片空白。
      note = messages.length > 0 ? messages : [{ id: 'install.noChange' }]
      // 装完立刻刷新列表：不然使用者看着"已安装"却看不到它出现在下面
      await loadSkills()
    } catch (err) {
      if (err instanceof InstallError) {
        errorMessage = err.message
        errorHint = installErrorHintMessage(err.code)
        // 括号（以及英文侧的前导空格）在词条里：写死在标记里的话，英文界面就会
        // 冒出全角括号——那正是 D39 要消掉的"一半中文"。
        if (err.detail) errorMessage += tx('install.errDetail', { detail: err.detail })
        note = [{ id: 'skills.noteFailed', params: { code: err.code } }]
      } else {
        errorMessage = err instanceof Error ? err.message : String(err)
      }
    } finally {
      busy = false
    }
  }

  /**
   * 从输入的内容猜是路径还是链接。
   *
   * 让使用者多做一次"选定类型"的下拉是没必要的：`/` 开头或 `~` 开头就是路径，
   * 有 `://` 就是链接。猜错也不要紧——填错了服务端会明确告诉他。
   */
  function submitPath(): void {
    const value = sourceInput.trim()
    if (value === '') {
      errorMessage = tx('skills.errEmptySource')
      return
    }
    const kind = /^[a-z]+:\/\//i.test(value) ? 'url' : 'path'
    void runInstall(() =>
      installFromPathOrUrl({
        kind,
        value,
        ...(slugInput.trim() ? { slug: slugInput.trim() } : {}),
        ...(overwrite ? { overwrite: true } : {}),
      }),
    )
  }

  function installFromCatalog(slug: string): void {
    const entry = $remoteCatalog?.skills.find((s) => s.slug === slug)
    if (!entry) {
      errorMessage = tx('skills.errNoRemoteEntry', { slug })
      return
    }
    // ★ 状态由 `catalogEntryState` 统一判定：它是纯函数、有测试。
    //   界面**不自己**拼"要不要 overwrite"——那正是"更新/替换"这类动作
    //   容易写错的地方（漏了 overwrite 会被拒，多加了会覆盖不该覆盖的东西）。
    const state = catalogEntryState(
      $skills.find((s) => s.slug === entry.slug),
      { slug: entry.slug, version: entry.version },
    )
    void runInstall(() =>
      installRemoteEntry({
        slug: entry.slug,
        // 远端目录给的是 SKILL.md 的正文；空的话服务端会拒绝并说清楚
        body: entry.content ?? '',
        version: entry.version,
        sourceRef: `remote:${entry.slug}@${entry.version}`,
        ...(state.needsOverwrite || overwrite ? { overwrite: true } : {}),
      }),
    )
  }

  /**
   * 卸载一条 skill（D38）。
   *
   * 服务端会拒掉"还有 agent 挂着它"，并把它们列出来——那条错误原文要**带回来**
   * 显示，不在前端改写。
   */
  async function uninstall(id: string, slug: string): Promise<void> {
    if (!confirm(tx('skills.confirmUninstall', { slug }))) return
    removing = id
    errorMessage = ''
    try {
      await uninstallSkill(id)
      showToast(tx('skills.uninstalled', { slug }))
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
    } finally {
      removing = null
    }
  }

  function openPanel(): void {
    panelOpen = true
    resetFeedback()
    // 打开时顺手拉一次目录：远端可能没起、或者刚登录，看到的应当是当下的状态
    if (!isLoggedIn() || $remoteCatalog === null) void refreshRemote()
  }

  function closePanel(): void {
    panelOpen = false
  }

  /**
   * Esc 关抽屉。
   *
   * ★ 这个抽屉由本视图自己渲染（状态就住在这儿），所以它**不在**
   *   `App.svelte` 那个 `$openDrawer` 的 Esc 处理里——不写这一条，
   *   Esc 对它就没反应，而顶栏那两个抽屉都能 Esc 关掉，同一页里两种
   *   手感是说不通的。
   */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && panelOpen) closePanel()
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="view-head">
  <div>
    <h2>{$t('skills.title')}</h2>
    <p>
      {$t('skills.headIntro')}<strong>{$t('skills.headStrongBody')}</strong> + <strong>{$t('skills.headStrongFiles')}</strong>{$t('skills.headOutro')}
    </p>
  </div>
  <div style="display:flex;gap:var(--sp-2)">
    <button type="button" class="secondary" onclick={loadSkills}>{$t('common.refresh')}</button>
    <button type="button" onclick={openPanel}>{$t('skills.install')}</button>
  </div>
</div>

{#if panelOpen}
  <!-- 点背景关掉：抽屉遮住列表时，"我怎么回去"必须有答案 -->
  <div class="drawer-backdrop" onclick={closePanel} role="presentation"></div>

  <!--
    ★ 安装面板做成抽屉，而不是正文里一块展开的方块。

      原来它插在页头和列表之间：打开一次，下面的 skill 列表就被推到看不见
      的地方——而使用者装完 skill 第一件想做的事，正是看它有没有出现在列表里。
      抽屉浮在列表上面，装完关掉就还在原地。

      `wide`：里面那张远端目录表有五列，34rem 会只剩横向滚动条。
  -->
  <div class="drawer wide" role="dialog" aria-modal="true" aria-label={$t('skills.install')}>
    <div class="drawer-head">
      <h2>{$t('skills.install')}</h2>
      <button type="button" class="ghost" onclick={closePanel}>{$t('common.close')}</button>
    </div>

    <div class="drawer-body">
    <div class="tabs">
      <button
        type="button"
        class={tab === 'path' ? 'tab active' : 'tab'}
        onclick={() => {
          tab = 'path'
          resetFeedback()
        }}
      >
        {$t('skills.tabPath')}
      </button>
      <button
        type="button"
        class={tab === 'remote' ? 'tab active' : 'tab'}
        onclick={() => {
          tab = 'remote'
          resetFeedback()
          void refreshRemote()
        }}
      >
        {$t('skills.tabRemote')}
      </button>
    </div>

    {#if tab === 'path'}
      <div class="field">
        <label for="skill-source">{$t('skills.pathLabel')}</label>
        <input
          id="skill-source"
          bind:value={sourceInput}
          placeholder={$t('skills.sourcePlaceholder')}
          onkeydown={(e) => e.key === 'Enter' && submitPath()}
        />
        <p class="faint small">
          {$t('skills.pathHintBefore')}<strong>{$t('skills.pathHintStrong')}</strong>{$t('skills.pathHintMid')}<strong>{$t('skills.pathHintSupportStrong')}</strong>{$t('skills.pathHintAfter')}
        </p>
      </div>

      <div class="field">
        <label for="skill-slug">{$t('skills.slugLabel')}</label>
        <input id="skill-slug" bind:value={slugInput} placeholder="my-skill" />
      </div>
    {:else}
      <div class="field">
        {#if remoteError}
          <div class="notice bad">
            <!-- ⚠️ 这里的 `$remoteError` 是**修掉一个既有的漏订**：原来插值写的是裸的
                 `{remoteError}`，渲染出来是 `[object Object]`。上面的 `{#if remoteError}`
                 同样是裸的（对象恒为真），那是另一处既有问题，**不在本次文案迁移的范围里**，
                 所以原样保留——不要以为它是对的。 -->
            {$t('skills.remoteUnavailable', { error: $remoteError })}
            <p class="faint small" style="margin:var(--sp-2) 0 0">
              {$t('skills.remoteDownBefore')}<strong>{$t('skills.remoteDownStrong')}</strong>{$t('skills.remoteDownAfter')}
            </p>
          </div>
        {:else if !isLoggedIn()}
          <div class="notice warn">
            {$t('skills.notSignedIn')}
            <p class="faint small" style="margin:var(--sp-2) 0 0">
              {$t('skills.notSignedInHint')}
            </p>
          </div>
        {/if}

        {#if $remoteCatalog}
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>slug</th><th>{$t('skills.colVersion')}</th><th>{$t('skills.colSummary')}</th><th>{$t('skills.colLocal')}</th><th></th></tr>
              </thead>
              <tbody>
                {#each $remoteCatalog.skills as s (s.slug)}
                  {@const local = $skills.find((x) => x.slug === s.slug)}
                  {@const state = catalogEntryState(local, { slug: s.slug, version: s.version })}
                  <tr>
                    <td><code>{s.slug}</code></td>
                    <td class="faint small">{s.version}</td>
                    <td class="faint small">{s.summary}</td>
                    <td class="faint small">
                      {#if local}
                        {local.version
                          ? $t('skills.installedVersion', { version: local.version })
                          : $t('skills.installedNoVersion')}
                      {:else}
                        —
                      {/if}
                    </td>
                    <td>
                      <!-- 按钮上的字与那句说明都由 `catalogEntryState` 给**键**，
                           所以这里必须用 `$t` 渲染：切语言时这一列要跟着变。 -->
                      <button
                        type="button"
                        class={state.action === 'update' ? 'small' : 'secondary small'}
                        disabled={busy || state.disabled}
                        title={$t(state.hintId, state.hintParams)}
                        onclick={() => installFromCatalog(s.slug)}
                      >
                        {$t(state.labelId, state.labelParams)}
                      </button>
                    </td>
                  </tr>
                  <tr>
                    <td colspan="5" class="faint small" style="padding-top:0">{$t(state.hintId, state.hintParams)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/if}

    <div class="field">
      <label class="action-chip">
        <input type="checkbox" bind:checked={overwrite} />
        {$t('skills.overwriteLabel')}
      </label>
      <p class="faint small">
        {$t('skills.overwriteHint')}
      </p>
    </div>

    {#if tab === 'path'}
      <p class="faint small" style="margin:0">{$t('skills.pathFootHint')}</p>
    {:else}
      <p class="faint small" style="margin:0">{$t('skills.remoteFootHint')}</p>
    {/if}

    {#if errorMessage}
      <div class="notice bad" style="margin-top:var(--sp-3)">
        <strong>{$t('skills.failedTitle')}</strong>
        <p style="margin:var(--sp-2) 0 0">{errorMessage}</p>
        <!-- 错误码认不出来时 `installErrorHintMessage()` 给的是 `null`（= 没有建议
             可说，词表里也没有一条空词条），所以这里什么都不显示，而不是显示半句。 -->
        {#if errorHint}<p class="faint small" style="margin:var(--sp-2) 0 0">{renderInstallMessage(errorHint, (id, params) => $t(id, params))}</p>{/if}
      </div>
    {/if}

    {#if result}
      <div class="notice {result.installed.length > 0 ? 'good' : 'warn'}" style="margin-top:var(--sp-3)">
        <strong>{result.installed.length > 0 ? $t('skills.installedTitle') : $t('skills.noChangesTitle')}</strong>
        <!-- 几段话按原顺序拼起来即可（`；` 这些标点已经在各条词条里）。插值里有
             **列表**（已装的 slug、被忽略的文件），由 `renderInstallMessage()`
             按渲染方语言取 `install.listSeparator` 连接——所以传进去的是 `$t`：
             分隔符跟着语言走，这几行也才会跟着语言重渲染。 -->
        <p style="margin:var(--sp-2) 0 0">{#each note as message (message)}{renderInstallMessage(message, (id, params) => $t(id, params))}{/each}</p>

        <!-- ★ 装了什么、什么没装，都要列出来。只说"安装完成"会让使用者以为
             拿到了完整的技能，而实际可能只装了 SKILL.md。 -->
        {#if result.included.length > 0}
          <p class="faint small" style="margin:var(--sp-2) 0 0">
            {$t('skills.includedCount', { count: result.included.length })}
            {#each result.included as f (f.path)}<code>{f.path}</code>{/each}
          </p>
        {/if}
        {#if result.ignored.length > 0}
          <p class="faint small" style="margin:var(--sp-2) 0 0">
            {$t('skills.ignoredHeading')}
            {#each result.ignored as i (i.path)}<code>{i.path}</code>{$t('install.ignoredReason', { reason: i.reason })}{/each}
          </p>
        {/if}
        {#if result.sourceRef}
          <p class="faint small" style="margin:var(--sp-2) 0 0">{$t('skills.source', { ref: result.sourceRef })}</p>
        {/if}
      </div>
    {/if}
    </div>

    <!-- 主操作常驻底部（`.drawer-foot`）：正文一长就不该让使用者先滚到底才能按。
         反馈（上面那两个 notice）正好落在按钮正上方，按下就能看见。 -->
    <div class="drawer-foot">
      {#if tab === 'path'}
        <button type="button" disabled={busy} onclick={submitPath}>
          {busy ? $t('skills.installing') : $t('skills.installCheck')}
        </button>
      {:else}
        <span class="faint small">
          {$t('skills.remoteFootNote')}
        </span>
      {/if}
    </div>
  </div>
{/if}

{#if $loading['skills'] && $skills.length === 0}
  <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
  <div class="skeleton" style="width:55%"></div>
{:else if $loadError['skills']}
  <div class="notice bad">{$loadError['skills']}</div>
{:else if $skills.length === 0}
  <div class="empty">
    <strong>{$t('skills.emptyTitle')}</strong>
    {$t('skills.emptyHint')}
    <strong>{$t('skills.emptyAuditStrong')}</strong>{$t('skills.emptyAuditAfter')}
  </div>
{:else}
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>slug</th><th>{$t('skills.colName')}</th><th>{$t('skills.colSource')}</th><th>{$t('skills.colFiles')}</th><th>{$t('skills.colUpdatedAt')}</th><th></th></tr>
      </thead>
      <tbody>
        {#each $skills as s (s.id)}
          {@const fileCount = Object.keys(s.files ?? {}).length}
          <tr>
            <td><code>{s.slug}</code></td>
            <td>{s.name}</td>
            <td>
              <span class="badge {s.source === 'local' ? 'todo' : 'in_review'}">
                {s.source === 'local' ? $t('skills.sourceLocal') : $t('skills.sourceRemote')}
              </span>
              {#if s.version}
                <!-- 版本要显示：远端目录那条能不能点「更新」，全靠它比 -->
                <div class="faint small">v{s.version}</div>
              {/if}
              {#if s.sourceRef}
                <!-- 来源标识要能看见：出问题时第一件事就是"它到底从哪儿来的" -->
                <div class="faint small" title={s.sourceRef}>{s.sourceRef}</div>
              {/if}
            </td>
            <td class="faint small">
              SKILL.md{#if fileCount > 0} +{fileCount}{/if}
            </td>
            <td class="faint small">{new Date(s.updatedAt).toLocaleString()}</td>
            <td class="row-actions">
              <button
                type="button"
                class="ghost small"
                onclick={() => (expanded = expanded === s.id ? null : s.id)}
              >
                {expanded === s.id ? $t('skills.collapseStandard') : $t('skills.viewStandard')}
              </button>
              <!-- 卸载（D38）：README 里挂着的"没有卸载，要删只有改库"到这里补上 -->
              <button
                type="button"
                class="ghost small danger"
                disabled={removing === s.id}
                title={$t('skills.uninstallTitle')}
                onclick={() => void uninstall(s.id, s.slug)}
              >
                {removing === s.id ? $t('common.uninstalling') : $t('common.uninstall')}
              </button>
            </td>
          </tr>
          {#if expanded === s.id}
            <tr>
              <!-- 6 列：动作那一列随"skill 不再带动作"一起去掉了 -->
              <td colspan="6">
                <pre class="skill-body">{s.body}</pre>
                {#if fileCount > 0}
                  <details class="support">
                    <summary>{$t('skills.supportFiles', { count: fileCount })}</summary>
                    {#each Object.entries(s.files ?? {}) as [path, content] (path)}
                      <p class="faint small" style="margin:var(--sp-2) 0 0"><code>{path}</code></p>
                      <pre class="skill-body">{content}</pre>
                    {/each}
                  </details>
                {/if}
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  /* 安装面板的容器样式由全局的 `.drawer` 提供（见 app.css）——这里只管
     抽屉**内部**那几块。原来那个 `.install-panel`（带边框的正文方块）
     随抽屉改版一起删掉了：抽屉自己就是容器，再套一层边框是多余的。 */
  .tabs {
    display: flex;
    gap: var(--sp-1);
    align-items: center;
    border-bottom: 1px solid var(--line);
    margin-bottom: var(--sp-3);
  }

  .tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    padding: var(--sp-2) var(--sp-3);
    color: var(--text-faint);
    cursor: pointer;
    font-size: var(--fs-sm);
  }

  .tab.active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }

  .field {
    margin-bottom: var(--sp-3);
  }

  .field > label {
    display: block;
    margin-bottom: var(--sp-1);
    font-size: var(--fs-sm);
    color: var(--text-faint);
  }

  .field > input {
    width: 100%;
  }

  /* ⚠️ 这里原来还有 `.group` / `.actions` 两条：它们只服务那一块"允许这个 skill
     触发的动作"的 fieldset（legend + 一排 checkbox）。那块 UI 随 D40 收口整块删掉了
     ——留着这两条会变成两个**选不中任何元素**的选择器（`svelte-check` 直接报未使用）。 */

  .action-chip {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    font-size: var(--fs-xs);
    cursor: pointer;
  }

  .row-actions { display: flex; gap: var(--sp-1); }
  .row-actions .danger { color: var(--bad); }

  .skill-body {
    margin: 0;
    padding: var(--sp-3);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    white-space: pre-wrap;
    font-size: var(--fs-xs);
    line-height: 1.6;
    max-height: 24rem;
    overflow-y: auto;
  }

  .support {
    margin-top: var(--sp-2);
  }

  .support summary {
    cursor: pointer;
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }
</style>
