<script lang="ts">
  import { onDestroy } from 'svelte'
  import {
    loadLocalSkillDirs,
    loadSkills,
    loadError,
    loading,
    localSkillDirs,
    saveLocalSkillDirs,
    skills,
    agents,
    uninstallSkill,
  } from '../lib/stores.ts'
  import { clearPageActions, setPageActions } from '../lib/page-actions.ts'
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
  import type { LocalSkillDirCandidate, ReconcileReport } from '../lib/api.ts'

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
   * 顶栏那一排动作（机制见 `lib/page-actions.ts`）。
   *
   * ⚠️ 写在 `$:` 里并读 `$t(...)`：语言一变就重新登记一遍（整体覆盖，不是追加）。
   * ⚠️ 卸载时收回来（登记里存的是抓着这一页状态的闭包）。顶栏读的时候本来就按
   *    视图名过滤，所以这不是"防残留"，是"不留着不用"。
   *
   * ★ 三个按钮的权重是有讲究的：**安装是这一页的主线**（`primary`），刷新与设置
   *   是配套动作（`secondary`）——原来它们挤在 `view-head` 里全是一个样子。
   */
  $: setPageActions('skills', [
    {
      id: 'refresh',
      label: $t('common.refresh'),
      kind: 'secondary',
      onActivate: () => void loadSkills(),
    },
    {
      id: 'settings',
      label: $t('skills.settings'),
      kind: 'secondary',
      onActivate: openDirs,
    },
    {
      id: 'install',
      label: $t('skills.install'),
      kind: 'primary',
      onActivate: openPanel,
    },
  ])
  onDestroy(() => clearPageActions('skills'))

  // ── 本地技能目录（「设置」抽屉）──
  /**
   * ══════════════════════════════════════════════════════════════════
   * 这个设置解决的是"我别的工具里已经有一堆 skill 了"
   * ══════════════════════════════════════════════════════════════════
   *
   * Claude Code、Codex、Cursor 各自把 skill 放在自己的目录里。勾上那些目录，
   * 这边的列表里就能看见、也能挂给智能体——不用一份份重新装。
   *
   * ★ 勾选状态是**存起来的**（工作区上），而**目录内容是每次都重扫的**：
   *   在那边改了、加了、删了，这边跟着变。所以这个抽屉里没有"导入"按钮——
   *   勾上就是"一直读这里"。
   */
  let dirsOpen = false
  let customInput = ''
  /** 正在保存勾选（勾选框转圈用）；null = 空闲。 */
  let savingDirs: string | null = null
  /**
   * 哪些智能体挂着这条 skill。
   *
   * ⚠️ 必须**算成值**，不能在标记里调函数：Svelte 只追踪表达式里**看得见**的
   *    标识符，函数体里读 `$agents` 它是看不见的——列表上那个"还有谁在用"就会
   *    停在第一次渲染的样子（这个坑在第 14 轮已经踩过一次）。
   */
  $: skillHolders = new Map(
    $skills.map((s) => [s.id, $agents.filter((a) => a.skillIds.includes(s.id)).map((a) => a.name)]),
  )

  /**
   * 这个候选目录的显示名。
   *
   * ★ daemon 只给 id 与路径，**中文名在词表里**——把显示名写在 daemon 那边等于
   *   让这个功能只有一种语言。认不出的 id（daemon 比界面新，加了新候选）就直接
   *   显示 id：显示一个英文 id 好过显示一片空白。
   */
  const DIR_TOOL_KEYS = {
    claude: 'skills.dirsToolClaude',
    codex: 'skills.dirsToolCodex',
    cursor: 'skills.dirsToolCursor',
    agents: 'skills.dirsToolAgents',
  } as const

  function dirToolLabel(id: string): string {
    const key = DIR_TOOL_KEYS[id as keyof typeof DIR_TOOL_KEYS]
    return key ? tx(key) : id
  }

  function openDirs(): void {
    dirsOpen = true
    // 打开时重扫一遍：目录里现在有几个 skill、什么东西被跳过了，是这一刻的事实
    void loadLocalSkillDirs()
  }

  function closeDirs(): void {
    dirsOpen = false
  }

  /** 勾 / 取消勾一个目录，然后立刻把结果说出来。 */
  async function toggleDir(path: string, checked: boolean): Promise<void> {
    const current = $localSkillDirs.enabled
    const next = checked
      ? [...current.filter((d) => d !== path), path]
      : current.filter((d) => d !== path)
    savingDirs = path
    try {
      // 报告只用来**说这一句**：扫描说明（跳过了什么、读不进来什么）跟着
      // `loadLocalSkillDirs()` 一起回来，所以它在抽屉里一直是齐的，不靠这一次
      announceDirs(await saveLocalSkillDirs(next))
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
    } finally {
      savingDirs = null
    }
  }

  async function addCustomDir(): Promise<void> {
    const value = customInput.trim()
    if (value === '') return
    await toggleDir(value, true)
    customInput = ''
  }

  /**
   * 把一次对账的结果讲成一句话。
   *
   * ★ 只说**有内容的**那几样：一次正常勾选不该弹四行字。但"跳过了""读不进来"
   *   一定要说——静默跳过正是这个功能最容易让人困惑的地方。
   */
  function announceDirs(report: ReconcileReport): void {
    const parts: string[] = []
    if (report.added.length + report.updated.length + report.removed.length > 0) {
      parts.push(
        tx('skills.dirsSaved', {
          added: report.added.length,
          updated: report.updated.length,
          removed: report.removed.length,
        }),
      )
    } else {
      parts.push(tx('skills.dirsSavedNothing'))
    }
    if (report.keptBecauseUsed.length > 0) {
      parts.push(
        tx('skills.dirsKept', {
          count: report.keptBecauseUsed.length,
          names: report.keptBecauseUsed.map((k) => k.slug).join('、'),
        }),
      )
    }
    showToast(parts.join('　'))
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
    if (event.key !== 'Escape') return
    if (panelOpen) closePanel()
    if (dirsOpen) closeDirs()
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="view-intro">
  <!--
    ⚠️ 这里原来是一个 `<h2>Skills</h2>` + 一排按钮。两样都搬走了：
       · 按钮 → 顶栏里、紧跟着页名（各视图登记，见 `lib/page-actions.ts`）
       · 标题 → 顶栏左侧的页名，与侧栏共用同一个词条（`lib/view.ts`）
    留下的这一段是**这一页是什么**，它只属于这里。
  -->
  <p>
    {$t('skills.headIntro')}<strong>{$t('skills.headStrongBody')}</strong> + <strong>{$t('skills.headStrongFiles')}</strong>{$t('skills.headOutro')}
  </p>
</div>

{#if dirsOpen}
  <div class="drawer-backdrop" onclick={closeDirs} role="presentation"></div>
  <aside class="drawer" aria-label={$t('skills.dirsTitle')}>
    <header>
      <h3>{$t('skills.dirsTitle')}</h3>
      <button type="button" class="ghost" onclick={closeDirs} aria-label={$t('common.close')}>×</button>
    </header>
    <div class="drawer-body">
      <p class="faint small" style="margin-top:0">{$t('skills.dirsIntro')}</p>

      {#if $loadError['localSkillDirs']}
        <!-- ★ 读不到就说读不到。
             ⚠️ 少了这一条，"接口出错/daemon 是旧的那版"会表现成**一个空的候选
                列表**——使用者看到的是"这里什么都没有"，而不是"这一趟没读到"，
                于是他会去猜是不是自己没有那些目录。 -->
        <div class="notice bad">{$loadError['localSkillDirs']}</div>
      {:else if $loading['localSkillDirs'] && $localSkillDirs.candidates.length === 0}
        <div class="skeleton" style="width:70%"></div>
      {:else}
        <!-- 内置候选：每个目录一行，勾选框 + 显示名 + 路径 + "里面有几个" -->
        {#each $localSkillDirs.candidates as c (c.path)}
          {@const checked = $localSkillDirs.enabled.includes(c.path)}
          <label class="dir-row">
            <input
              type="checkbox"
              {checked}
              disabled={savingDirs === c.path}
              onchange={(e) => void toggleDir(c.path, e.currentTarget.checked)}
            />
            <span class="dir-main">
              <strong>{dirToolLabel(c.id)}</strong>
              {#if !c.exists}
                <!-- 目录不存在也要能看见、能勾：可能还没建，或外置盘没挂上 -->
                <span class="badge todo">{$t('skills.dirsMissing')}</span>
              {:else if c.skillCount === 0}
                <span class="faint small">{$t('skills.dirsNoSkill')}</span>
              {:else}
                <span class="faint small">{$t('skills.dirsCount', { count: c.skillCount })}</span>
              {/if}
              <div class="faint small dir-path" title={c.path}>{c.path}</div>
              {#if c.skipped.length > 0}
                <!-- ★ 一直挂在这儿：勾了却"少一个"时，这句话是唯一的线索 -->
                <div class="faint small dir-skip">
                  {$t('skills.dirsSkipped', { list: c.skipped.map((k) => k.rel).join('、') })}
                </div>
              {/if}
            </span>
          </label>
        {/each}

        <!-- 自己填的路径：不在候选表里，但同样要能看见、能取消 -->
        {#if $localSkillDirs.custom.length > 0}
          <h4 class="dirs-h4">{$t('skills.dirsCustomHeading')}</h4>
          {#each $localSkillDirs.custom as dir (dir.path)}
            <div class="dir-row">
              <span class="dir-main">
                <div class="dir-path" title={dir.path}>{dir.path}</div>
                {#if !dir.exists}
                  <span class="badge todo">{$t('skills.dirsMissing')}</span>
                {:else if dir.skillCount === 0}
                  <span class="faint small">{$t('skills.dirsNoSkill')}</span>
                {:else}
                  <span class="faint small">{$t('skills.dirsCount', { count: dir.skillCount })}</span>
                {/if}
                {#if dir.skipped.length > 0}
                  <div class="faint small dir-skip">
                    {$t('skills.dirsSkipped', { list: dir.skipped.map((k) => k.rel).join('、') })}
                  </div>
                {/if}
              </span>
              <button
                type="button"
                class="ghost small danger"
                disabled={savingDirs === dir.path}
                onclick={() => void toggleDir(dir.path, false)}
              >{$t('skills.dirsRemove')}</button>
            </div>
          {/each}
        {/if}

        <div class="dir-add">
          <input
            type="text"
            bind:value={customInput}
            placeholder={$t('skills.dirsCustomPlaceholder')}
            onkeydown={(e) => {
              if (e.key === 'Enter') void addCustomDir()
            }}
          />
          <button type="button" class="secondary" onclick={() => void addCustomDir()}>
            {$t('skills.dirsAdd')}
          </button>
        </div>
      {/if}

      <!-- ★ 取消勾选**不会**怎样，必须写出来：使用者对"取消勾选"的直觉是"删掉"，
             而这里的行为是"不再出现在可选项里、正在用的留着"——不写他就不敢勾 -->
      <p class="notice small" style="margin-top:var(--sp-3)">{$t('skills.dirsUncheckNote')}</p>

      <!-- 读不进来的 / 读不了的：这两样只有"真的去读一遍内容"才知道，
           所以它们来自对账（每次读设置都会对一次账），而不是来自目录扫描。
           ⚠️ 读不进来的**必须带原因**（路径 + 括号里那句）：不然"勾了却少一个"
           就只能靠猜——真实案例是 fireworks-tech-graph 被文件数上限挡住，
           页面上只说"读不进来"没说为什么。dirsUnreadable 那行已经是
           `路径（原因）` 的形状，这里照抄同一种。 -->
      {#if $localSkillDirs.report.failed.length > 0}
        <p class="small" style="color:var(--warn)">
          {$t('skills.dirsFailed', {
            list: $localSkillDirs.report.failed
              .map((k) => `${k.rel}（${k.reason}）`)
              .join('、'),
          })}
        </p>
      {/if}
      {#if $localSkillDirs.report.dirErrors.length > 0}
        <p class="small" style="color:var(--warn)">
          {$t('skills.dirsUnreadable', {
            list: $localSkillDirs.report.dirErrors.map((k) => `${k.dir}（${k.reason}）`).join('、'),
          })}
        </p>
      {/if}
      {#if $localSkillDirs.report.keptBecauseUsed.length > 0}
        <p class="faint small">
          {$t('skills.dirsKept', {
            count: $localSkillDirs.report.keptBecauseUsed.length,
            names: $localSkillDirs.report.keptBecauseUsed.map((k) => k.slug).join('、'),
          })}
        </p>
      {/if}
    </div>
  </aside>
{/if}

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
                <tr><th>{$t('skills.colSlug')}</th><th>{$t('skills.colVersion')}</th><th>{$t('skills.colSummary')}</th><th>{$t('skills.colLocal')}</th><th></th></tr>
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
        <tr><th>{$t('skills.colSlug')}</th><th>{$t('skills.colName')}</th><th>{$t('skills.colSource')}</th><th>{$t('skills.colFiles')}</th><th>{$t('skills.colUpdatedAt')}</th><th></th></tr>
      </thead>
      <tbody>
        {#each $skills as s (s.id)}
          {@const fileCount = Object.keys(s.files ?? {}).length}
          <tr>
            <td>
              <!-- ★ 与工具页同一个做法：展开入口从行尾挪到首格 chevron——
                   行尾那格只留卸载（和"为什么不能卸"的说明）。真按钮：
                   tab 能到、读屏器能读、aria-expanded 能报状态。 -->
              <button
                type="button"
                class="expand-toggle"
                aria-expanded={expanded === s.id}
                aria-label={expanded === s.id
                  ? $t('skills.collapseStandard')
                  : $t('skills.viewStandard')}
                onclick={() => (expanded = expanded === s.id ? null : s.id)}
              >
                <span class="chevron" aria-hidden="true">
                  {expanded === s.id ? '▾' : '▸'}
                </span>
              </button>
              <code>{s.slug}</code>
            </td>
            <td>{s.name}</td>
            <td>
              {#if s.localDir}
                <!-- 来自某个被勾选的本地目录：来源要写成**那个目录**，
                     而不是笼统的"本机自建"——使用者要能对上自己勾的那个路径 -->
                <span class="badge {s.selectable === false ? 'todo' : 'in_review'}">
                  {$t('skills.fromDir', { dir: s.localDir })}
                </span>
              {:else}
                <span class="badge {s.source === 'local' ? 'todo' : 'in_review'}">
                  {s.source === 'local' ? $t('skills.sourceLocal') : $t('skills.sourceRemote')}
                </span>
              {/if}
              {#if s.selectable === false}
                <!-- ★ 这条还在、但已经不该出现在"可以选"的列表里：它之所以没被
                     移出去，是因为还有智能体挂着它。原因与"是谁"都要写出来，
                     否则它就是一条谁也解释不了的幽灵记录。 -->
                <div class="faint small" title={$t('skills.fromDirInactive', { names: (skillHolders.get(s.id) ?? []).join('、') })}>
                  {$t('skills.fromDirInactive', { names: (skillHolders.get(s.id) ?? []).join('、') })}
                </div>
              {/if}
              {#if s.version}
                <!-- 版本要显示：远端目录那条能不能点「更新」，全靠它比 -->
                <div class="faint small">v{s.version}</div>
              {/if}
              {#if s.sourceRef && !s.localDir}
                <!-- 来源标识要能看见：出问题时第一件事就是"它到底从哪儿来的"。
                     ⚠️ 但来自本地目录的那条**不重复显示**：它的 `sourceRef` 就是
                     `localdir:<那个目录>`，而上面那个徽标已经把同一个路径写出来了
                     ——同一行里写两遍同一个路径，只会让人以为它们是两件事。
                     ⚠️ 长路径**不许换行**：单行省略，全文在 `title` 里。 -->
                <div class="faint small source-ref" title={s.sourceRef}>{s.sourceRef}</div>
              {/if}
            </td>
            <td class="faint small">
              SKILL.md{#if fileCount > 0} +{fileCount}{/if}
            </td>
            <td class="faint small">{new Date(s.updatedAt).toLocaleString()}</td>
            <td class="row-actions">
              <!-- 卸载（D38）：README 里挂着的"没有卸载，要删只有改库"到这里补上。
                   ⚠️ 但**来自本地目录的这条不给卸**：它每次读列表都会被重扫回来，
                       "卸载"按下去只会让它消失一瞬间然后回来——那比没有按钮更糟
                       （使用者会以为卸载坏了）。要去那个目录里删。 -->
              {#if s.localDir}
                <button
                  type="button"
                  class="ghost small"
                  disabled
                  title={$t('skills.uninstallLocalDirTitle')}
                >{$t('common.uninstall')}</button>
              {:else}
                <button
                  type="button"
                  class="ghost small danger"
                  disabled={removing === s.id}
                  title={$t('skills.uninstallTitle')}
                  onclick={() => void uninstall(s.id, s.slug)}
                >
                  {removing === s.id ? $t('common.uninstalling') : $t('common.uninstall')}
                </button>
              {/if}
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

  /* ── 展开入口（首格 chevron，与工具页同一个做法）── */
  .expand-toggle {
    background: none;
    border: none;
    border-radius: var(--radius);
    padding: 0 var(--sp-1);
    margin-right: var(--sp-1);
    color: var(--text-faint);
    cursor: pointer;
    font-size: var(--fs-sm);
    line-height: 1;
    vertical-align: middle;
  }
  .expand-toggle:hover { color: var(--text); background: var(--surface-hover); }
  .expand-toggle[aria-expanded='true'] .chevron { color: var(--accent); }

  /* 来源标识：长路径/URL 单行省略，全文在 `title` 里（不许折行撑高这行） */
  .source-ref {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 16rem;
  }

  /* ── 本地技能目录（设置抽屉）── */
  .dir-row {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
    padding: var(--sp-2) 0;
    /* ⚠️ 原来写的是 `var(--border)`——这个变量**不存在**，border-color 落回
       currentColor（文字色），分隔线比该有的深一截。换回 `--line`。 */
    border-bottom: 1px solid var(--line);
  }
  .dir-row:last-of-type { border-bottom: none; }
  /**
   * ⚠️ 全局那条 `input, textarea, select { width: 100% }` **对勾选框一样生效**。
   *    不显式收回，勾选框会撑满整行（实测 480px），把右边的路径挤成 **0 宽**
   *    ——于是路径按 `break-all` 断成 22 行、整行 837px 高、抽屉横向溢出 87px。
   *    界面看起来只是"这一行怎么这么高"，根本联想不到是全局样式。
   *    （`AgentDetail.svelte` 的 `.skill-option input` 也是为同一个原因写的。）
   *
   *    顶对齐（`margin-top: 3px`）是因为右边的路径可能换行，居中会像飘着。
   */
  .dir-row input[type='checkbox'] {
    width: auto;
    flex: none;
    margin: 0;
    margin-top: 3px;
  }
  .dir-main { flex: 1; min-width: 0; }
  /* 路径要能换行显示完整——截断了使用者就核不对自己勾的是哪个目录 */
  .dir-path {
    margin-top: 2px;
    word-break: break-all;
    font-family: var(--font-mono);
  }
  /* "跳过了什么"缩进一行：它是对上面那个目录的补充，不是另一个目录 */
  .dir-skip { margin-top: 2px; padding-left: var(--sp-3); }
  .dirs-h4 { margin: var(--sp-3) 0 var(--sp-1); font-size: var(--fs-sm); }
  .dir-add { display: flex; gap: var(--sp-2); margin-top: var(--sp-3); }
  /* 同一个原因：`width: 100%` + `flex: 1` 会让输入框先按整行算再被拉伸，
     连同右边那个按钮一起顶出抽屉（实测横向溢出 87px） */
  .dir-add input { flex: 1; width: auto; min-width: 0; }

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
