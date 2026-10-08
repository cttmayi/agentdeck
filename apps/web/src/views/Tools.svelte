<script lang="ts">
  import { onDestroy } from 'svelte'
  import {
    loadError,
    loading,
    loadTools,
    tools,
    uninstallTool,
  } from '../lib/stores.ts'
  import { isLoggedIn } from '../lib/remote.ts'
  import { remoteCatalog, remoteError, refreshRemote } from '../lib/remote-store.ts'
  import { clearPageActions, setPageActions } from '../lib/page-actions.ts'
  import { showToast } from '../lib/view.ts'
  import { t, tx } from '../lib/i18n.ts'
  import { Table, SourceRef, ExpandToggle } from '@agentdeck/ui/components'
  import { askConfirm } from '../lib/confirm.ts'
  import { absoluteTime, relativeTime } from '../lib/time.ts'
  import {
    ToolInstallError,
    installToolFromCatalog,
    installToolFromPath,
    toolInstallErrorHint,
    type TextMessage,
    type ToolInstallResult,
  } from '../lib/tool-install.ts'
  import { actionCountOf, actionsOf, boundParams, openParams } from '../lib/tool-view.ts'
  // 「有没有更新」的判据是纯函数、有测试；界面只负责把它的结论画成按钮
  import { toolUpdateState } from '../lib/tool-update.ts'
  import type { CatalogEntryState } from '../lib/skill-catalog.ts'
  import type { Tool } from '../lib/api.ts'

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
   *      完整名字（`<slug>.<动作名>`，**契约值不翻译**）、它做什么、以及一条
   *      会改变"能不能用它"的标记：`reversible: false`（不可回滚）。
   *   3. **它有没有新版本**：远端目录里那一版比本地新时，这一行多一个「更新到
   *      x.y.z」。判据在 `tool-update.ts`（纯函数、有测试）。
   *
   *      ⚠️ 这里原来是"**谁在用它**"（`mountedBy`：哪些执行者挂着它）。挂载能力
   *      撤掉之后那个字段不再存在，那一列与这一段一起删了。
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

  // ── 安装面板 ──
  /**
   * ⚠️ 2026-10：与技能页同步——它**不再是右侧抽屉**，而是主区里的就地面板。
   *
   * 使用者的话：「技能和工具的安装都是右侧弹框，需要改成类似新建智能体那样，在主区
   * 显示，而不是弹框」。打开安装 = 主区换成面板（列表让位），头部一个「← 返回工具列表」。
   * 当初做成抽屉的顾虑（"表单插在页头和列表之间会把列表推到看不见的地方"）现在由
   * "面板**取代**列表"解决：列表一行都没被推走，而是整块让开；装进来的动作与文件在
   * 结果块里逐条列出来，返回时列表已经刷新过。
   */
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
  /** 正在更新哪一个（按钮转圈 + 防重复点击）；null = 没有在更新。 */
  let updating: string | null = null

  /**
   * 一进这一页就把远端目录拉一次（登录了的话）。
   *
   * ⚠️ 这一页**必须**自己拉：远端目录在别处是"打开安装抽屉时才拉"（Skills 页也
   *    是这样），但"有没有新版本"是**列表上**的事——不拉的话那一列按钮永远不出现，
   *    而"没有更新"和"根本没去问"在界面上长得一模一样。
   *
   * ⚠️ 失败**不在这里报错**：目录拉不到只意味着"这次不知道有没有更新"，页面其余
   *    部分照常能用。真正的报错留给安装抽屉（那里是使用者主动要装东西的地方）。
   *    `askedRemote` 是"只问一次"的闸门——不设它，这条反应式语句会自己触发自己。
   */
  let askedRemote = false
  /** 相对时间的「现在」——每次响应式更新重算一遍。 */
  $: now = Date.now()
  $: if (!askedRemote && isLoggedIn() && $remoteCatalog === null) {
    askedRemote = true
    void refreshRemote()
  }
  /** 卸载的失败：原样显示后端给的原文。 */
  let uninstallError = ''

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

  /**
   * 每一行的更新状态：`工具 id → 状态`（查不到 = 不给按钮）。
   *
   * ★ 判据全在 `tool-update.ts` 里（纯函数、有测试）：**界面不自己比版本号**。
   *   版本比较容易写错的地方正是"看起来新"与"真的新"之间的差别——`1.10.0` 与
   *   `1.9.9` 按字符串比是更旧，按数字比才是更新。比错了的后果不是显示难看，
   *   而是点一下就把手上的包**覆盖**掉。
   *
   * ⚠️⚠️ **必须在 `$:` 里算成一张表，不能在标记里写 `{#if updateOf(tool)}`。**
   *   远端目录是**异步**到的：首屏渲染时它还是 null。Svelte 只在标记里那个表达式
   *   **自己出现过的**变量上建依赖，函数体里读的 `$remoteCatalog` 它看不见——
   *   于是"目录取回来了"不会让那一行重画。
   *
   *   这个坑的实际症状（实测过）：目录明明取到了（安装抽屉里能看到 1.1.0），列表上
   *   却**一个「更新」按钮都没有**，点刷新也没有用（刷新确实重新取了目录，但重画
   *   依然不会发生）。代码读起来完全正确，只有真的渲染一次才看得见。
   */
  $: updateStates = new Map(
    $tools.map((t) => [t.id, toolUpdateState(t, $remoteCatalog?.tools ?? [])]),
  )

  /**
   * 更新 = 从远端目录**同名替换**这个包。
   *
   * ⚠️ `overwrite` 必须为 true：更新在服务端就是"同名冲突时允许覆盖"这一条路。
   *   不传的话会被"同名已存在"拒掉，而界面上的症状是"点了更新没反应"。
   *
   * ⚠️ 这里**不弹确认框**：`uninstall` 会弹，因为删掉就没了；更新是把同一个包换成
   *   新版，按钮上已经写明了要更新到哪一版，而且换坏了还能再装回来。
   */
  async function updateFromCatalog(tool: Tool): Promise<void> {
    const entry = $remoteCatalog?.tools.find((t) => t.slug === tool.slug)
    if (!entry) {
      errorMessage = tx('tools.errNoRemoteEntry', { slug: tool.slug })
      return
    }
    updating = tool.id
    errorMessage = ''
    errorDetail = ''
    try {
      result = await installToolFromCatalog({ ...entry, overwrite: true })
      await loadTools()
      showToast(tx('tools.updated', { slug: entry.slug, version: entry.version ?? '' }))
    } catch (err) {
      if (err instanceof ToolInstallError) {
        errorMessage = err.message
        errorDetail = err.detail ?? ''
        errorHint = toolInstallErrorHint(err.code)
      } else {
        errorMessage = err instanceof Error ? err.message : String(err)
      }
    } finally {
      updating = null
    }
  }

  function openPanel(): void {
    panelOpen = true
    resetFeedback()
  }

  /**
   * 「刷新」——顶栏那一个。
   *
   * ★ 目录也要一起刷：更新提示来自远端目录，只刷本地列表的话，远端刚发的新版本
   *   要等下次进这一页才看得见。
   */
  function refreshTools(): void {
    void loadTools()
    if (isLoggedIn()) void refreshRemote()
  }

  /**
   * 顶栏那一排动作（机制见 `lib/page-actions.ts`）。
   *
   * ⚠️ 写在 `$:` 里并读 `$t(...)`：语言一变就重新登记一遍（整体覆盖，不是追加）。
   *
   * ⚠️ 卸载时收回来：登记里存的是**闭包**（`onActivate` 抓着这一页的状态），
   *    留在 store 里等于把已经关掉的这一页连同它的数据一起按住不放。
   *    顶栏读的时候本来就按视图名过滤（`actionsFor`），所以这不是"防残留"，
   *    是"不留着不用"。
   */
  // ★ 与技能页/智能体页同一读法：**主线动作（primary）在最前**，刷新跟在后面。
  $: setPageActions('tools', [
    {
      id: 'install',
      label: $t('tools.install'),
      kind: 'primary',
      icon: 'plus',
      // ⚠️ 面板开着时置灰（与智能体页「新建智能体」同一个做法）：它已经开着，
      //    再点一次什么都不发生——那是最容易让人以为卡片坏了的一种状态。
      disabled: panelOpen,
      onActivate: openPanel,
    },
    {
      id: 'refresh',
      label: $t('common.refresh'),
      kind: 'secondary',
      icon: 'refresh',
      onActivate: refreshTools,
    },
  ])
  onDestroy(() => clearPageActions('tools'))

  function closePanel(): void {
    panelOpen = false
  }

  /**
   * Esc 关掉安装面板。
   *
   * ★ 与 `Skills.svelte` 里那条一模一样。安装面板已经是主区的就地内容（按返回就能
   *   回去），但 Esc 照旧关掉它：技能页也这么做，两页同一件事必须同一手感。
   *   ⚠️ 这一页没有别的浮层由本视图渲染（设置抽屉只在技能页）。
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
    // ★ 平台自己的确认框（居中），不是 `window.confirm`——理由见 `lib/confirm.ts`
    if (
      !(await askConfirm({
        title: tx('tools.confirmUninstallTitle', { slug }),
        message: tx('tools.confirmUninstallBody'),
        confirmLabel: tx('common.uninstall'),
        danger: true,
      }))
    )
      return
    removing = id
    uninstallError = ''
    try {
      await uninstallTool(id)
      showToast(tx('tools.uninstalled', { slug }))
    } catch (err) {
      uninstallError = err instanceof Error ? err.message : String(err)
    } finally {
      removing = null
    }
  }

</script>

<svelte:window onkeydown={onKeydown} />

<div class="view-intro">
  <!--
    ⚠️ 这里原来是一个 `<h2>工具</h2>` + 一排按钮。两样都搬走了：
       · 按钮 → 顶栏里、紧跟着页名（各视图登记，见 `lib/page-actions.ts`）
       · 标题 → 顶栏左侧的页名，与侧栏共用同一个词条（`lib/view.ts`）
    留下的这一段是**这一页是什么**，它只属于这里。
  -->
  <p>
    {$t('tools.headIntro')}<strong>{$t('tools.headStrongGroup')}</strong>{$t('tools.headOutro')}
  </p>
</div>

{#if uninstallError}
  <div class="notice bad" style="margin-bottom:var(--sp-3)">{uninstallError}</div>
{/if}

<!--
  ══════════════════════════════════════════════════════════════════
  安装面板：主区**就地**显示（2026-10，不再是右侧抽屉）
  ══════════════════════════════════════════════════════════════════

  与「安装技能」同一个形状（那边写着完整的理由）：面板**取代**列表，头部一个一直
  可见的「← 返回工具列表」。没有遮罩、没有 `role="dialog"` / `aria-modal`——后面的
  列表是被"换掉"的，不是被挡住的，读屏器不该被告知这里有个模态框。
-->
{#if panelOpen}
  <section class="main-panel" aria-label={$t('tools.install')}>
    <header class="main-panel-head">
      <button
        type="button"
        class="ghost small panel-back"
        onclick={closePanel}>{$t('tools.backToList')}</button
      >
      <h2>{$t('tools.install')}</h2>
    </header>

    <div class="main-panel-body">
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
          <!-- ★ 与技能页的远端目录表同一套表格样式（全局 `thead th` / `tbody td`）：
               原来这里自带一份 `.remote-tools`（表头字重 600 vs 500、内边距更小、
               分隔线用 `--line` 而不是 `--line-strong`），两张"同一种表"长得不一样。 -->
          <table>
            <thead>
              <tr>
                <th scope="col">{$t('tools.colPackage')}</th>
                <th scope="col">{$t('tools.colActions')}</th>
                <th scope="col">{$t('tools.colVersion')}</th>
                <th scope="col" aria-label={$t('tools.colRowActions')}></th>
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
                  <td class="faint small">{entry.version ? `v${entry.version}` : $t('common.noVersion')}</td>
                  <td>
                    <button
                      type="button"
                      class="secondary small"
                      disabled={installing !== null}
                      title={installing !== null ? $t('tools.installingBusy') : $t('tools.actionInstall')}
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

    <!-- 主操作在面板自己的底部（`.main-panel-foot`）：与「安装 skill」同一个布局。
         ⚠️ 它原来贴住视口底部（弹框的手感），就地面板里它是"表单的最后一步"。 -->
    <div class="main-panel-foot">
      <button type="button" disabled={busy} onclick={submitPath}>
        {busy ? $t('tools.installing') : $t('tools.installCheck')}
      </button>
    </div>
  </section>
{:else}

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
  <Table
    tableClass="tool-table"
    columns={[
      { label: $t('tools.colGroup') },
      { label: $t('tools.colName') },
      { label: $t('tools.colSource') },
      { label: $t('tools.colVersion') },
      { label: $t('tools.colActionCount') },
      { label: $t('tools.colUpdatedAt') },
      { label: '', ariaLabel: $t('tools.colRowActions') },
    ]}
  >
    {#snippet rows()}
      {#each $tools as tool (tool.id)}
          {@const count = actionCountOf(tool)}
          <tr class="tool-row">
            <td>
              <!--
                ★ 展开动作的入口从行尾那格挪到首格：原来「看动作」是个文字按钮，
                跟「更新」「卸载」挤在一格，两个以上就折成竖排（56x56）。
                现在这一列只留**动作相关**的按钮；展开由首格这个 chevron 管。
                ⚠️ 用**真按钮**（不是 `onclick` 挂整行）：tab 能到、读屏器能读、
                aria-expanded 能报状态——整行可点对键盘用户是死的。
              -->
              <div class="row-title">
                <ExpandToggle
                  expanded={expanded === tool.id}
                  labelExpand={$t('tools.viewActions')}
                  labelCollapse={$t('tools.hideActions')}
                  onclick={() => (expanded = expanded === tool.id ? null : tool.id)}
                />
                <code class="tool-slug">{tool.slug}</code>
              </div>
            </td>
            <td>
              <!-- D69：名称与技能页同一档（faint small）——slug 才是主标识 -->
              <div class="faint small">{tool.name}</div>
              <!-- ★ 与技能页同一格式：说明最多两行，全文在 `title` 里 -->
              {#if tool.description}
                <div class="faint small desc-clamp" title={tool.description}>{tool.description}</div>
              {/if}
            </td>
            <!-- 动作数：一眼看出"这一组装了几个动作"。与展开后那条清单必须对得上 -->
            <td class="tool-action-count">{$t('tools.actionCount', { count })}</td>
            <td>
              <!-- D69：来源徽标统一配方——同步/远端 = 默认灰徽章，本地 = accent -->
              <span class="badge" class:local={tool.source === 'local'}>
                {tool.source === 'local' ? $t('tools.sourceLocal') : $t('tools.sourceRemote')}
              </span>
              {#if tool.sourceRef}
                <!-- 来源标识要能看见：出问题时第一件事就是"它到底从哪儿来的"。
                     ⚠️ 路径/URL 可能很长，**不许换行**（一折这行就变高）——单行
                     省略 + hover 悬浮出全文（`title` 就是完整值）。
                     ★ 2026-10（紧凑性）：`source-ref` 从 div 改成 span、与徽章
                     同行——原来它块级换行，凡带 sourceRef 的行都比实际高一整行。 -->
                <SourceRef value={tool.sourceRef} />
              {/if}
            </td>
            <td class="faint small">
              {tool.version ? `v${tool.version}` : $t('common.noVersion')}
            </td>
            <!-- 更新于：与技能页同一列同一格式 -->
            <td class="faint small" title={absoluteTime(tool.updatedAt)}>{relativeTime(tool.updatedAt, now)}</td>
            <!--
              ★ 这里原来有一格「被哪些执行者挂载」。撤掉了：使用者的决定是
                「不需要"被哪些执行者挂载"，因为我已经移除了此功能」——挂载这个
                能力已经整个撤掉（入口先撤、详情里那一段再撤），所以这一列对
                每一个工具包都只会永远显示「未挂给任何智能体」，是一列死字。
            -->
            <!-- ⚠️ 同上：flex 在内层 div 上 -->
            <td>
              <div class="row-actions">
                <!--
                  「更新」只在**远端目录里真的有更新**时出现（判据见 `tool-update.ts`）。
                  按钮上的字与那句说明都由它给**键**，所以这里必须用 `$t` 渲染——
                  切语言时这一列要跟着变（与 Skills 页同一做法）。
                -->
                {#if updateStates.get(tool.id)}
                  {@const update = updateStates.get(tool.id)!}
                  <button
                    type="button"
                    class="small"
                    disabled={updating !== null}
                    title={$t(update.hintId, update.hintParams)}
                    onclick={() => void updateFromCatalog(tool)}
                  >
                    {updating === tool.id
                      ? $t('common.saving')
                      : $t(update.labelId, update.labelParams)}
                  </button>
                {/if}
                <button
                  type="button"
                  class="ghost small danger"
                  disabled={removing === tool.id}
                  title={$t('tools.uninstallTitle')}
                  onclick={() => void uninstall(tool.id, tool.slug)}
                >
                  {removing === tool.id ? $t('common.uninstalling') : $t('common.uninstall')}
                </button>
              </div>
            </td>
          </tr>

          {#if expanded === tool.id}
            <tr class="tool-detail-row">
              <td colspan="7">
                <div class="tool-actions">
                  <div class="actions-intro">
                  <h4 class="tool-actions-heading">{$t('tools.actionsHeading')}</h4>
                  <!--
                    ★ 「平台绑定」「模型可填」这两组**各是什么意思**，在这里说**一次**。
                      原来这两句解释写在每一个动作卡片里，而它们的文字**每个动作都
                      一模一样**——实测（1400 视口、2 个动作）面板 445px，其中 124px
                      是这两句话重复了两遍。动作越多重复越多，而重复的部分不携带
                      任何新信息。
                  -->
                  <dl class="param-legend">
                    <dt>{$t('tools.paramsBoundHeading')}</dt>
                    <dd>{$t('tools.paramsBoundNote')}</dd>
                    <dt>{$t('tools.paramsOpenHeading')}</dt>
                    <dd>{$t('tools.paramsOpenNote')}</dd>
                  </dl>
                  </div>
                  {#each actionsOf(tool) as item (item.type)}
                    <div class="tool-action">
                      <div class="tool-action-head">
                        <!-- ★ 契约值：判决里写的就是这一串，不翻译 -->
                        <code class="tool-action-type">{item.type}</code>
                        {#if item.action.reversible === false}
                          <span class="badge bad flag-irreversible">{$t('tools.actionIrreversible')}</span>
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
    {/snippet}
  </Table>
{/if}

{/if}

<style>
  /* 面板内部与结果块。容器（`.main-panel*` / `.table-wrap` / `.notice`）由全局
     `app.css` 提供——这里只管这一页独有的那几块。 */

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

  /* ★ 「1 个动作」不许断行。这一列去掉左右 padding 只剩 42px，而「1 个动作」
     要 55px，不 nowrap 就一定折成「1 个动」/「作」两行。
     ⚠️ 原来这一对下面还有 `.tool-mounted` 与 `.chip`（「被哪些执行者挂载」那一格
     用的小标签），那一列撤掉之后一并删了——留着就是给不存在的 DOM 写样式。 */
  .tool-action-count { white-space: nowrap; }

  /* ★ 动作卡片**并排**：这一块宽 1070px（详情行占满整张表），而一个卡片只要
     500 出头就放得下——竖着排等于白白空掉一半宽度，代价是面板高一倍。
     `auto-fit` + `minmax(26rem, 1fr)`：宽了就两列、窄了自动退回一列，
     不需要断点，也不会有"两列挤成一团"的中间状态。 */
  .tool-actions {
    padding: var(--sp-2) 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(26rem, 1fr));
    gap: var(--sp-2);
    align-items: start;
  }
  /* 标题与图例横跨整行——它们是"整块面板"的话，不是某一个动作的（见 `.actions-intro`） */

  .tool-actions-heading {
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    margin-bottom: var(--sp-2);
  }

  /* ★ 标题与图例**同一行**：两块都是"整块面板"的话，各自占一行就是白占两行。
     实测（1400 视口）：分开时 16+8+38+8 = 70px，并成一行后 19+8 = 27px。 */
  .actions-intro {
    grid-column: 1 / -1;
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
    flex-wrap: wrap;
    margin-bottom: var(--sp-2);
  }
  .actions-intro .tool-actions-heading { margin-bottom: 0; }

  /* 两组参数各是什么意思——**整块面板只说一次**（见上面那段注释里的实测数字）。
     ⚠️ `repeat(2, auto 1fr)`：两组并排成**一行**（宽的时候一行放得下，实测两对
     加起来 860px < 1070px）。窄了会自动把文字折在单元格里，不会挤爆。 */
  .param-legend {
    display: grid;
    grid-template-columns: repeat(2, auto 1fr);
    gap: 0 var(--sp-2);
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }
  .param-legend dt {
    font-weight: 600;
    color: var(--text-dim);
  }
  .param-legend dd {
    margin: 0;
  }

  .tool-action {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    /* ⚠️ 上下内边距只留 --sp-1（4px）：这一块是"看细节"用的，一屏要装下好几个
       动作。8px 的上下留白在这里换不来可读性——边框已经把它框住了。 */
    padding: var(--sp-1) var(--sp-3);
    /* ⚠️ 卡片之间的间距由 `.tool-actions` 的 `gap` 给（原来这里是 margin-bottom：
       并排之后 margin 会让最后一行多出一截，而 gap 不会）。 */
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

  /* 「不可回滚」用 bad 色：它改变的是"能不能用它" */
  .flag-irreversible {
    color: var(--bad);
  }

  .tool-action-summary {
    margin: var(--sp-1) 0 0;
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }

  .param-groups {
    display: grid;
    /* ★ 15rem → 19rem：卡片并排之后每个只有 ~500px，两列会把参数行挤到换行
       （实测 `label` 那一行带 5 个枚举值时换成了 4 行、79px）。抬到 19rem 之后
       卡片里的两组**竖着排**、每组独占整行宽度，行不再换行——总高反而更矮。 */
    grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr));
    gap: var(--sp-2) var(--sp-3);
    margin-top: var(--sp-2);
  }

  .param-group {
    border-left: 2px solid var(--line-strong);
    padding-left: var(--sp-2);
    /* ★ 组标签与**第一行参数同排**，不再自己占一行。
       实测（1400 视口、2 个动作、每组各 1 行）：标签独占一行时每组 19px，四个组
       就是 76px——而标签只有四个字（「平台绑定」），旁边空着整整一行。
       两列网格：标签钉在第 1 列第 1 行，其余孩子全去第 2 列，于是多行参数在
       第 2 列自然堆叠，标签与第一行**基线对齐**。 */
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px var(--sp-2);
    align-items: baseline;
  }
  .param-group > *:not(.group-label) { grid-column: 2; }

  .param-group .group-label {
    grid-column: 1;
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-dim);
    white-space: nowrap;
  }

  .param-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
    /* ⚠️ 行距由 `.param-group` 的 `gap` 给，这里不再另加下边距——两处都加就会
       变成 2px + 4px，而"多出来的那几像素"正是把面板顶高一截的原因。 */
    margin-bottom: 0;
  }
  /* 行内的代码片段去掉上下内边距：一行的行高几乎全是它撑起来的 */
  .param-row code { padding-block: 0; }

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
</style>
