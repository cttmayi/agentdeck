<script lang="ts">
  import {
    allowUnpreviewedActions,
    loadError,
    loading,
    loadTools,
    setAllowUnpreviewedActions,
    tools,
    uninstallTool,
  } from '../lib/stores.ts'
  import { isLoggedIn } from '../lib/remote.ts'
  import { remoteCatalog, remoteError, refreshRemote } from '../lib/remote-store.ts'
  import { showToast } from '../lib/view.ts'
  import { t, tx } from '../lib/i18n.ts'
  import {
    ToolInstallError,
    ToolInUseError,
    installToolFromCatalog,
    installToolFromPath,
    toolInstallErrorHint,
    type TextMessage,
    type ToolInstallResult,
  } from '../lib/tool-install.ts'
  import {
    actionCountOf,
    actionsOf,
    boundParams,
    cannotRunAutomatically,
    openParams,
  } from '../lib/tool-view.ts'

  /**
   * 工具（D40）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 一个包 = 一个组，组内多个动作
   * ══════════════════════════════════════════════════════════════════
   *
   * 这一页要回答三个问题，而且必须**当场**回答：
   *
   *   1. **它是什么**：组名（slug）、名称、版本、组里有几个动作；
   *   2. **它能干什么**：点开一行就是组内动作的清单——每个动作显示它在判决里的
   *      完整名字（`<slug>.<动作名>`，**契约值不翻译**）、它做什么、以及两条
   *      会改变"能不能用它"的标记：`reversible: false`（不可回滚）与
   *      `dryRun: 'unsupported'`（不支持预演 ⇒ 没有自动执行资格）；
   *   3. **谁在用它**：`mountedBy`。挂载关系住在 agent 上，而"这个包能不能卸"
   *      完全取决于它——所以它必须在这一行上，而不是让人去智能体页一个个翻。
   *
   * ══════════════════════════════════════════════════════════════════
   * 装 / 卸两件事的反馈是这一页的重点
   * ══════════════════════════════════════════════════════════════════
   *
   *   - **装**：失败时把后端给的 `error` 与 `detail`（可能是多行）**一起**显示，
   *     再按 `code` 补一句"那我该怎么做"。只显示一句"安装失败"的话，使用者在
   *     一个连字段名都没听过的 schema 错误面前无事可做——而 detail 里写的正是
   *     哪一条不对。装成功则列清**装进来了什么**（动作 + 文件）与**明确没装什么**。
   *   - **卸**：还有 agent 挂着时后端拒绝并给出 `holders`，界面按 Skills 那套
   *     **指名道姓**地说出来，而不是把 400 原文丢给使用者。
   *
   * ⚠️ 安装抽屉是**本视图自己渲染**的（状态住在这儿），所以 Esc 由下面那个
   *    `svelte:window` 处理——不在 `App.svelte` 的 `$openDrawer` 里。与 Skills
   *    页同一个做法（不写这一条，Esc 对它就没反应）。
   */
  /** 展开了哪一个包的动作清单；null = 都收着。 */
  let expanded: string | null = null

  // ── 安装抽屉 ──
  let panelOpen = false

  /**
   * 安装面板的两个页签（D40）。
   *
   * ★ 与「安装 skill」同构：**路径**与**远端目录**是两条来源，不是两种能力——
   *   表单字段一样多，并排摆只会让人以为要填两处。远端那一页的内容随列表
   *   一起下来（`CatalogTool.manifest/files/docs`），装的时候原样交给本机 daemon。
   */
  let tab: 'path' | 'remote' = 'path'

  /** 正在从远端装的包（按钮转圈 + 防重复点击）。 */
  let installing: string | null = null
  let sourceInput = ''
  let slugInput = ''
  /** 允许替换同名工具。理由见词表里那两条词条的注释（卸载会被挂载挡住）。 */
  let overwrite = false
  let busy = false

  /**
   * 失败信息分三段显示：后端的原文、它的 detail（多行）、以及按错误码给的下一步。
   *
   * ★ `errorHint` 存的是**键 + 插值**而不是句子：这条提示是界面的一部分，切语言
   *   时要跟着变，渲染交给标记里的 `$t`（与 `Skills.svelte` 同一条规矩）。
   */
  let errorMessage = ''
  let errorDetail = ''
  let errorHint: TextMessage | null = null
  let result: ToolInstallResult | null = null

  /** 正在卸载哪一个（按钮转圈用）；null = 没有在卸。 */
  let removing: string | null = null
  /**
   * 卸载被拒：还挂着它的那些 agent。
   *
   * ★ 存**名单**而不是拼好的句子：这句"还挂着它的有 X、Y"要跟着界面语言走，
   *   所以连接符（中文的顿号 / 英文的逗号）也得按当前语言取——在回调里拼死
   *   就没有这个余地了。
   */
  let inUse: { slug: string; names: string[] } | null = null
  /** 卸载的**其它**失败（不是"还挂着"）：原样显示后端给的原文。 */
  let uninstallError = ''

  /**
   * 准入开关的写回错误（D40）。
   *
   * ★ 失败**不回滚**复选框的显示：服务端返回的值才是权威，所以这里只记一条提示，
   *   并让 store 保持服务端那份（`setAllowUnpreviewedActions` 用返回值对齐）。
   */
  let allowError = ''

  async function toggleAllowUnpreviewed(allow: boolean): Promise<void> {
    allowError = ''
    try {
      await setAllowUnpreviewedActions(allow)
      showToast(
        tx(allow ? 'tools.allowUnpreviewedOn' : 'tools.allowUnpreviewedOff'),
      )
    } catch (err) {
      allowError = err instanceof Error ? err.message : String(err)
    }
  }

  function resetFeedback(): void {
    errorMessage = ''
    errorDetail = ''
    errorHint = null
    result = null
  }

  /**
   * 从远端目录装一个包。
   *
   * ★ 远端目录**可能还没取过**（页面启动时那次可能没登录/远端没起），所以先
   *   按需刷一次——否则"点开就是空表"，而空表与"远端真的没有包"看起来一模一样。
   */
  async function installFromCatalog(slug: string): Promise<void> {
    const entry = $remoteCatalog?.tools.find((t) => t.slug === slug)
    if (!entry) {
      errorMessage = tx('tools.errNoRemoteEntry', { slug })
      return
    }
    installing = slug
    errorMessage = ''
    errorDetail = ''
    try {
      // ⚠️ 同名冲突的判定交给**服务端**：它才知道本地有没有同 slug 的包，
      //   而界面上那个「允许替换」勾选框就是使用者的显式同意。
      const outcome = await installToolFromCatalog({ ...entry, overwrite })
      result = outcome
      await loadTools()
      showToast(tx('tools.installed', { slug: outcome.tool.slug }))
    } catch (err) {
      if (err instanceof ToolInstallError) {
        errorMessage = err.message
        errorDetail = err.detail ?? ''
        errorHint = toolInstallErrorHint(err.code)
      } else {
        errorMessage = err instanceof Error ? err.message : String(err)
      }
    } finally {
      installing = null
    }
  }

  function openPanel(): void {
    panelOpen = true
    resetFeedback()
  }

  function closePanel(): void {
    panelOpen = false
  }

  /**
   * Esc 关抽屉。
   *
   * ★ 与 `Skills.svelte` 里那条一模一样：抽屉由视图自己渲染，就不在 App 的
   *   `$openDrawer` 处理里。顶栏那两个抽屉都能 Esc 关，同一页里两种手感说不通。
   */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && panelOpen) closePanel()
  }

  function submitPath(): void {
    const value = sourceInput.trim()
    if (value === '') {
      errorMessage = tx('tools.errEmptySource')
      errorDetail = ''
      errorHint = null
      return
    }
    void runInstall(value)
  }

  async function runInstall(path: string): Promise<void> {
    busy = true
    resetFeedback()
    try {
      result = await installToolFromPath({
        path,
        ...(slugInput.trim() ? { slug: slugInput.trim() } : {}),
        ...(overwrite ? { overwrite: true } : {}),
      })
      // 装完立刻刷新列表：不然使用者看着"已安装"却看不到它出现在下面
      await loadTools()
    } catch (err) {
      if (err instanceof ToolInstallError) {
        errorMessage = err.message
        // detail 可能是**多行**（清单校验会把几条问题一起列出来），所以它单独
        // 占一块（`white-space: pre-wrap`），而不是塞进一句话里被折成一坨。
        errorDetail = err.detail ?? ''
        errorHint = toolInstallErrorHint(err.code)
      } else {
        errorMessage = err instanceof Error ? err.message : String(err)
      }
    } finally {
      busy = false
    }
  }

  /**
   * 卸载一个工具包。
   *
   * 服务端拒绝"还有 agent 挂着它"时给的是**结构化名单**（`holders`），所以这里
   * 能指名道姓；其它失败按原文显示，与别的写入口一致。
   */
  async function uninstall(id: string, slug: string): Promise<void> {
    if (!confirm(tx('tools.confirmUninstall', { slug }))) return
    removing = id
    inUse = null
    uninstallError = ''
    try {
      await uninstallTool(id)
      showToast(tx('tools.uninstalled', { slug }))
    } catch (err) {
      if (err instanceof ToolInUseError) {
        inUse = { slug, names: err.holders.map((h) => h.name) }
      } else {
        uninstallError = err instanceof Error ? err.message : String(err)
      }
    } finally {
      removing = null
    }
  }

  /** 挂着的 agent 名字——用当前语言的分隔符连接（顿号 / 逗号）。 */
  function namesOf(list: string[]): string {
    return list.join(tx('install.listSeparator'))
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="view-head">
  <div>
    <h2>{$t('tools.title')}</h2>
    <p>
      {$t('tools.headIntro')}<strong>{$t('tools.headStrongGroup')}</strong>{$t('tools.headOutro')}
    </p>
  </div>
  <div style="display:flex;gap:var(--sp-2)">
    <button type="button" class="secondary" onclick={loadTools}>{$t('common.refresh')}</button>
    <button type="button" onclick={openPanel}>{$t('tools.install')}</button>
  </div>
</div>

<!--
  准入开关（D40）：声明"不支持预演"的动作默认**不自动执行**。
  ★ 这段必须在页面上，不能只藏在文档里：动作被拒时服务端的报错就指着这里
    （"在「工具」页显式打开…"）。开关是**准入**不是偏好，所以文案要说清代价。
-->
<div class="admission">
  <label class="admission-row">
    <input
      type="checkbox"
      checked={$allowUnpreviewedActions}
      onchange={(e) => void toggleAllowUnpreviewed(e.currentTarget.checked)}
    />
    <span>{$t('tools.allowUnpreviewed')}</span>
  </label>
  <p class="faint small">{$t('tools.allowUnpreviewedHint')}</p>
  {#if allowError}
    <p class="notice bad small">{$t('tools.allowUnpreviewedFailed', { error: allowError })}</p>
  {/if}
</div>

<!--
  卸载被拒：**指名道姓**。
  说清"是哪几个 agent 挂着它"，因为下一步就是在那些 agent 上把它摘掉——
  一句"卸载失败"会让使用者无处下手（Skills 页那条路径同理）。
-->
{#if inUse}
  <div class="notice bad col" style="margin-bottom:var(--sp-3)">
    <strong>{$t('tools.errInUseTitle')}</strong>
    <p class="tool-error-msg">{$t('tools.errInUse', { slug: inUse.slug, names: namesOf(inUse.names) })}</p>
  </div>
{/if}
{#if uninstallError}
  <div class="notice bad" style="margin-bottom:var(--sp-3)">{uninstallError}</div>
{/if}

{#if panelOpen}
  <!-- 点背景关掉：抽屉遮住列表时，"我怎么回去"必须有答案 -->
  <div class="drawer-backdrop" onclick={closePanel} role="presentation"></div>

  <!--
    ★ 与「安装 skill」同构：右侧抽屉 + `wide`（46rem）。
      里面那张表要放"组名 / 名称 / 版本 / 动作数 / 来源 / 被哪些执行者挂载"，窄版会只剩
      横向滚动条；而装完最想看的正是下面那张表——抽屉浮在它上面，关掉就回到原地。

      正文里只剩一个「安装工具」按钮：表单插在页头和列表之间的那版，一打开就把
      列表推到看不见的地方。
  -->
  <div class="drawer wide" role="dialog" aria-modal="true" aria-label={$t('tools.install')}>
    <div class="drawer-head">
      <h2>{$t('tools.install')}</h2>
      <button type="button" class="ghost" onclick={closePanel}>{$t('common.close')}</button>
    </div>

    <div class="drawer-body">
      <!--
        两个来源页签（D40）：**路径** 与 **远端目录**。
        它们不是"两种能力"，是同一件事的两条来源——并排摆字段会让人以为要填两处。
      -->
      <div class="tabs">
        <button
          type="button"
          class={tab === 'path' ? 'tab active' : 'tab'}
          onclick={() => (tab = 'path')}>{$t('tools.tabPath')}</button
        >
        <button
          type="button"
          class={tab === 'remote' ? 'tab active' : 'tab'}
          onclick={() => {
            tab = 'remote'
            if (!isLoggedIn() || $remoteCatalog === null) void refreshRemote()
          }}>{$t('tools.tabRemote')}</button
        >
      </div>

      {#if tab === 'remote'}
        {#if $remoteError}
          <div class="notice bad col">
            <strong>{$t('tools.remoteUnavailableTitle')}</strong>
            <p class="small">{$t('tools.remoteUnavailable', { error: $remoteError })}</p>
          </div>
        {:else if $remoteCatalog === null}
          <p class="faint small">{$t('tools.remoteReading')}</p>
        {:else if $remoteCatalog.tools.length === 0}
          <!-- 空目录是**真话**，不是错误：说清"远端目录里现在没有包"比留一片空白好 -->
          <p class="faint small">{$t('tools.remoteEmpty')}</p>
        {:else}
          <table class="remote-tools">
            <thead>
              <tr>
                <th>{$t('tools.colPackage')}</th>
                <th>{$t('tools.colActions')}</th>
                <th>{$t('tools.colVersion')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each $remoteCatalog.tools as entry (entry.slug)}
                <tr>
                  <td>
                    <code>{entry.slug}</code>
                    <div class="faint small">{entry.name}</div>
                    <div class="faint small">{entry.summary}</div>
                  </td>
                  <td>
                    <!-- 动作名是**契约值**（判决里就这么写），原样显示 -->
                    {#each (entry.manifest.actions ?? []) as a (a.name)}
                      <div><code>{entry.slug}.{a.name}</code></div>
                    {/each}
                  </td>
                  <td>{entry.version ?? '—'}</td>
                  <td>
                    <button
                      type="button"
                      disabled={installing !== null}
                      onclick={() => void installFromCatalog(entry.slug)}
                    >
                      {installing === entry.slug ? $t('common.saving') : $t('tools.actionInstall')}
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          <p class="faint small">{$t('tools.remoteHint')}</p>
        {/if}
      {:else}
      <div class="field">
        <label for="tool-source">{$t('tools.pathLabel')}</label>
        <input
          id="tool-source"
          bind:value={sourceInput}
          placeholder={$t('tools.sourcePlaceholder')}
          onkeydown={(e) => e.key === 'Enter' && submitPath()}
        />
        <p class="faint small">
          {$t('tools.pathHintBefore')}<code>tool.json</code>{$t('tools.pathHintAfter')}
        </p>
      </div>

      <div class="field">
        <label for="tool-slug">{$t('tools.slugLabel')}</label>
        <input id="tool-slug" bind:value={slugInput} placeholder="my-tool" />
      </div>

      <div class="field">
        <label class="check-row">
          <input type="checkbox" bind:checked={overwrite} />
          {$t('tools.overwriteLabel')}
        </label>
        <p class="faint small">
          {$t('tools.overwriteHint')}
        </p>
      </div>

      <p class="faint small" style="margin:0">{$t('tools.footHint')}</p>

      {/if}

      {#if errorMessage}
        <div class="notice bad col" style="margin-top:var(--sp-3)">
          <strong>{$t('tools.failedTitle')}</strong>
          <p class="tool-error-msg">{errorMessage}</p>
          <!--
            ★ `detail` **必须显示**，而且可能多行：清单校验把"哪一条不对、为什么"
              写在这里。只显示一句概括（"清单无效"）等于把唯一的线索丢掉。
          -->
          {#if errorDetail}
            <span class="faint small">{$t('tools.errorDetailLabel')}</span>
            <pre class="tool-error-detail">{errorDetail}</pre>
          {/if}
          <!-- 认不出的错误码 ⇒ `toolInstallErrorHint()` 返回 null（没有建议可说），
               这里什么都不显示，而不是显示半句话。 -->
          {#if errorHint}
            <p class="faint small">{$t(errorHint.id, errorHint.params)}</p>
          {/if}
        </div>
      {/if}

      {#if result}
        <div class="notice good col" style="margin-top:var(--sp-3)">
          <strong>{$t('tools.installedTitle')}</strong>
          <p>
            <code>{result.tool.slug}</code>
            {result.tool.name}
            {#if result.tool.version}<span class="faint small">v{result.tool.version}</span>{/if}
          </p>
          <!--
            ★ **装进来了什么**：动作与文件都列出来。
              只说"安装完成"会让使用者以为拿到了完整的一包——而实际可能少了
              入口脚本（这时的症状是"判决里那个动作执行不了"，离安装差着十万八千里）。
          -->
          <p class="faint small">
            {$t('tools.resultActions', { count: actionCountOf(result.tool) })}
            {#each actionsOf(result.tool) as a (a.type)}<code>{a.type}</code>{/each}
          </p>
          <p class="faint small">
            {$t('tools.resultFiles', { count: result.included.length })}
            {#each result.included as f (f.path)}<code>{f.path}</code>{/each}
          </p>
          <!-- ★ **明确没装什么**：被跳过的二进制、符号链接、版本库目录都在这里。 -->
          {#if result.ignored.length > 0}
            <p class="faint small">
              {$t('tools.ignoredHeading')}
              {#each result.ignored as i (i.path)}<code>{i.path}</code>{$t('install.ignoredReason', { reason: i.reason })}{/each}
            </p>
          {:else if !result.ignoredKnown}
            <!--
              退回路径：这一版接口只回了 `tool.files`（= 真正收下的那些）。这时
              "没装什么"无从得知——所以**明说拿不到**，而不是让使用者把"没显示"
              读成"全都装进来了"。
            -->
            <p class="faint small">{$t('tools.ignoredNotReported')}</p>
          {/if}
          {#if result.tool.sourceRef}
            <p class="faint small">{$t('tools.resultSource', { ref: result.tool.sourceRef })}</p>
          {/if}
        </div>
      {/if}
    </div>

    <!-- 主操作常驻底部（`.drawer-foot`）：与「安装 skill」同一个布局 -->
    <div class="drawer-foot">
      <button type="button" disabled={busy} onclick={submitPath}>
        {busy ? $t('tools.installing') : $t('tools.installCheck')}
      </button>
    </div>
  </div>
{/if}

{#if $loading['tools'] && $tools.length === 0}
  <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
  <div class="skeleton" style="width:55%"></div>
{:else if $loadError['tools']}
  <div class="notice bad">{$loadError['tools']}</div>
{:else if $tools.length === 0}
  <div class="empty">
    <strong>{$t('tools.emptyTitle')}</strong>
    {$t('tools.emptyHint')}
    <p class="faint small" style="margin-top:var(--sp-3)">
      {$t('tools.emptyExampleBefore')}<code>examples/tools/example-note/</code>{$t('tools.emptyExampleAfter')}
    </p>
  </div>
{:else}
  <div class="table-wrap">
    <table class="tool-table">
      <thead>
        <tr>
          <th>{$t('tools.colGroup')}</th>
          <th>{$t('tools.colName')}</th>
          <th>{$t('tools.colVersion')}</th>
          <th>{$t('tools.colActionCount')}</th>
          <th>{$t('tools.colSource')}</th>
          <th>{$t('tools.colMountedBy')}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each $tools as tool (tool.id)}
          {@const count = actionCountOf(tool)}
          <tr class="tool-row">
            <td><code class="tool-slug">{tool.slug}</code></td>
            <td>
              {tool.name}
              {#if tool.description}
                <div class="faint small">{tool.description}</div>
              {/if}
            </td>
            <td class="faint small">
              {tool.version ? `v${tool.version}` : $t('tools.versionNone')}
            </td>
            <!-- 动作数：一眼看出"这一组装了几个动作"。与展开后那条清单必须对得上 -->
            <td class="tool-action-count">{$t('tools.actionCount', { count })}</td>
            <td>
              <span class="badge {tool.source === 'local' ? 'todo' : 'in_review'}">
                {tool.source === 'local' ? $t('tools.sourceLocal') : $t('tools.sourceRemote')}
              </span>
              {#if tool.sourceRef}
                <!-- 来源标识要能看见：出问题时第一件事就是"它到底从哪儿来的" -->
                <div class="faint small" title={tool.sourceRef}>{tool.sourceRef}</div>
              {/if}
            </td>
            <!-- ★ 挂给了哪些 agent：卸载能不能成功、这个组到底在给谁用，全看这一格 -->
            <td class="tool-mounted">
              {#if tool.mountedBy.length === 0}
                <span class="faint small">{$t('tools.mountedByNone')}</span>
              {:else}
                {#each tool.mountedBy as m (m.id)}
                  <span class="chip">{m.name}</span>
                {/each}
              {/if}
            </td>
            <td class="row-actions">
              <button
                type="button"
                class="ghost small"
                onclick={() => (expanded = expanded === tool.id ? null : tool.id)}
              >
                {expanded === tool.id ? $t('tools.hideActions') : $t('tools.viewActions')}
              </button>
              <button
                type="button"
                class="ghost small danger"
                disabled={removing === tool.id}
                title={$t('tools.uninstallTitle')}
                onclick={() => void uninstall(tool.id, tool.slug)}
              >
                {removing === tool.id ? $t('common.uninstalling') : $t('common.uninstall')}
              </button>
            </td>
          </tr>

          {#if expanded === tool.id}
            <tr class="tool-detail-row">
              <td colspan="7">
                <div class="tool-actions">
                  <h4 class="tool-actions-heading">{$t('tools.actionsHeading')}</h4>
                  {#each actionsOf(tool) as item (item.type)}
                    <div class="tool-action">
                      <div class="tool-action-head">
                        <!-- ★ 契约值：判决里写的就是这一串，不翻译 -->
                        <code class="tool-action-type">{item.type}</code>
                        {#if item.action.reversible === false}
                          <span class="badge bad flag-irreversible">{$t('tools.actionIrreversible')}</span>
                        {/if}
                        {#if cannotRunAutomatically(item.action)}
                          <span class="badge bad flag-no-dry-run">{$t('tools.actionNoDryRun')}</span>
                        {/if}
                        {#if item.action.timeoutMs}
                          <span class="faint small">{$t('tools.actionTimeout', { ms: item.action.timeoutMs })}</span>
                        {/if}
                      </div>
                      <p class="tool-action-summary">{item.action.summary}</p>

                      <!--
                        参数分两组显示，判据是**模型能不能看见**：绑定参数不进模型可见
                        的契约（模型看不见也填不了），开放参数每一项都有界。两组混在一起
                        显示的话，"这个字段模型能不能动"就要逐个去读 `from` 才知道。
                      -->
                      <div class="param-groups">
                        <div class="param-group params-bound">
                          <span class="group-label">{$t('tools.paramsBoundHeading')}</span>
                          <p class="faint small">{$t('tools.paramsBoundNote')}</p>
                          {#if boundParams(item.action).length === 0}
                            <span class="faint small">{$t('tools.paramsNone')}</span>
                          {:else}
                            {#each boundParams(item.action) as p (p.name)}
                              <div class="param-row">
                                <code>{p.name}</code>
                                <span class="faint small">{$t(p.label.id, p.label.params)}</span>
                              </div>
                            {/each}
                          {/if}
                        </div>

                        <div class="param-group params-open">
                          <span class="group-label">{$t('tools.paramsOpenHeading')}</span>
                          <p class="faint small">{$t('tools.paramsOpenNote')}</p>
                          {#if openParams(item.action).length === 0}
                            <span class="faint small">{$t('tools.paramsNone')}</span>
                          {:else}
                            {#each openParams(item.action) as p (p.name)}
                              <div class="param-row">
                                <code>{p.name}</code>
                                <span class="faint small">{$t(p.label.id, p.label.params)}</span>
                                {#if p.required}
                                  <span class="badge">{$t('common.required')}</span>
                                {:else}
                                  <span class="faint small">{$t('tools.paramOptional')}</span>
                                {/if}
                                {#each p.values as v (v)}<code>{v}</code>{/each}
                              </div>
                            {/each}
                          {/if}
                        </div>
                      </div>
                    </div>
                  {/each}
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  /* 抽屉内部与结果块。容器（`.drawer` / `.table-wrap` / `.notice`）由全局
     `app.css` 提供——这里只管这一页独有的那几块。 */

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

  .check-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: var(--fs-sm);
    cursor: pointer;
    margin-bottom: 0;
  }

  .check-row input {
    width: auto;
    margin: 0;
  }

  /* 竖排的 notice：结论一行、正文一行、detail 一块，横排会挤成并排的三列 */
  .notice.col {
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-2);
  }

  .notice.col p,
  .notice.col pre {
    margin: 0;
  }

  .tool-error-msg {
    /* 后端原文可能很长（一条路径 + 一句解释），允许换行而不是横着撑出去 */
    overflow-wrap: anywhere;
  }

  /* ★ 多行的 detail：`pre-wrap` 保住它自己的换行，同时跟着宽度折行 */
  .tool-error-detail {
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: var(--fs-xs);
    line-height: 1.6;
    max-height: 16rem;
    overflow-y: auto;
  }

  .row-actions { display: flex; gap: var(--sp-1); }
  .row-actions .danger { color: var(--bad); }

  /* 「被哪些执行者挂载」：名字排成一行小标签，多了就换行 */
  .tool-mounted { display: flex; flex-wrap: wrap; gap: var(--sp-1); }

  .chip {
    display: inline-flex;
    align-items: baseline;
    gap: var(--sp-2);
    padding: 0 var(--sp-2);
    border: 1px solid var(--line-strong);
    border-radius: 100px;
    background: var(--surface);
    font-size: var(--fs-xs);
  }

  .tool-actions {
    padding: var(--sp-2) 0;
  }

  .tool-actions-heading {
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    margin-bottom: var(--sp-2);
  }

  .tool-action {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    padding: var(--sp-3);
    margin-bottom: var(--sp-2);
  }

  .tool-action-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }

  .tool-action-type {
    font-size: var(--fs-sm);
  }

  /* 「不可回滚」「不支持预演」用 bad 色：它们改变的是"能不能用它" */
  .flag-irreversible,
  .flag-no-dry-run {
    color: var(--bad);
  }

  .tool-action-summary {
    margin: var(--sp-2) 0 0;
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }

  .param-groups {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: var(--sp-3);
    margin-top: var(--sp-3);
  }

  .param-group {
    border-left: 2px solid var(--line-strong);
    padding-left: var(--sp-3);
  }

  .param-group .group-label {
    display: block;
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-dim);
  }

  .param-group p {
    margin: var(--sp-1) 0 var(--sp-2);
  }

  .param-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
    margin-bottom: var(--sp-1);
  }

  /* 准入开关：一段独立的、带边框的提醒——它不是普通设置项，是"放行第三方代码" */
  .admission {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--sp-2) var(--sp-3);
    margin-bottom: var(--sp-3);
  }
  .admission-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    cursor: pointer;
  }

  /* 两个来源页签 + 远端目录表（D40） */
  /* 与「安装 skill」那对页签同款（同一套 token，别自己发明变量名） */
  .tabs {
    display: flex;
    gap: var(--sp-3);
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
  .remote-tools {
    width: 100%;
    border-collapse: collapse;
  }
  .remote-tools th {
    text-align: left;
    font-weight: 600;
    padding: var(--sp-1) var(--sp-2);
    border-bottom: 1px solid var(--line);
  }
  .remote-tools td {
    padding: var(--sp-2);
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
</style>
