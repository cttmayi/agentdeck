<script lang="ts">
  import { onDestroy } from 'svelte'
  import {
    loadLocalSkillScan,
    loadSkills,
    loadError,
    loading,
    localSkillScan,
    skills,
    uninstallSkill,
  } from '../lib/stores.ts'
  import { clearPageActions, setPageActions } from '../lib/page-actions.ts'
  import { showToast } from '../lib/view.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import { absoluteTime, relativeTime } from '../lib/time.ts'
  import { remoteCatalog, remoteError, refreshRemote } from '../lib/remote-store.ts'
  import { isLoggedIn } from '../lib/remote.ts'
  import { catalogEntryState } from '../lib/skill-catalog.ts'
  import { fetchSkillList, type SkillListEntry, type SkillListResult } from '../lib/skill-list.ts'
  import { t, tx } from '../lib/i18n.ts'
  import { Table, SourceRef, ExpandToggle } from '@agentdeck/ui/components'
  import SkillHistory from '../components/SkillHistory.svelte'
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
  import type { LocalSkillCandidate, LocalSkillScanDir } from '../lib/api.ts'

  /**
   * Skills。
   *
   * ★ 这一页只管**资料包**：装什么、装成什么、从哪儿装的。它**不配任何权限**——
   *   "判完允许动什么"属于**智能体组**（组配置页 ③ 行动），D40 收口之前它一度长在
   *   安装表单里，那时"装一份参考资料"与"授权改状态"是同一件事，而它们本来不该
   *   在一起。
   */
  let expanded: string | null = null
  // ── D80：列表分组（我提炼的 / 安装的）+ 遮蔽标注 ──
  /**
   * 双根之后列表要分组（设计 §1.1）：mine（我提炼的）在前、安装的在后，各自按
   * updatedAt 倒序。遮蔽标注：安装的 slug 若已有提炼版（注入时提炼版优先，
   * 见 daemon `loadAgentSkills`），在行尾点破"被你的版本遮蔽"。
   */
  $: mineSlugs = new Set($skills.filter((s) => s.source === 'mine').map((s) => s.slug))
  $: groupedSkills = [
    ...$skills
      .filter((s) => s.source === 'mine')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({ skill: s, group: 'mine' as const, shadowed: false })),
    ...$skills
      .filter((s) => s.source !== 'mine')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        skill: s,
        group: 'installed' as const,
        shadowed: mineSlugs.has(s.slug),
      })),
  ]
  // ── 安装面板 ──
  /**
   * ══════════════════════════════════════════════════════════════════
   * 三个来源放在同一个面板里，而不是各做一个入口
   * ══════════════════════════════════════════════════════════════════
   *
   * "我要装一个 skill"是一个念头，不该先让使用者去判断"我这算远端还是本地"。
   * 所以一个按钮打开一个面板，里面三个页签：**路径 / GitHub**、**远端目录**、
   * 以及**本地清单**（一份仓库自带的 JSON，列出可点的安装方法）。
   *
   * ★ 第三个页签**不需要**远端服务、同步工具或登录：它读的是 daemon 自带的一份
   *   安装方法清单（`apps/daemon/catalog/skills.json`），点一下由 daemon 现去取。
   *
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ 2026-10：它**不再是右侧抽屉**，而是主区里的就地面板
   * ══════════════════════════════════════════════════════════════════
   *
   * 使用者的原话：「技能和工具的安装都是右侧弹框，需要改成类似新建智能体那样，在主区
   * 显示，而不是弹框」。所以打开安装 = **主区换成安装面板**（与智能体页「新建」同一个
   * 行为），头部给一个「← 返回技能列表」。
   *
   * 当初做成抽屉的理由是"表单插在页头和列表之间会把列表推到看不见的地方"——那个
   * 顾虑现在换一种方式解决：面板**取代**列表（不是把它推下去），所以列表一行都不会
   * 被挤到视口外；而"装完看不见列表"这件事由**结果块**兜住（装了哪些文件、哪个 slug、
   * 来源逐条列出来），返回列表时它已经刷新过。
   */
  let panelOpen = false
  let tab: 'path' | 'dirs' | 'remote' | 'list' = 'path'
  let sourceInput = ''
  let slugInput = ''
  /**
   * 「本地清单」页签的内容。
   *
   * ★ 与远端目录（`remote-store.ts` 那个 store）不同，这里用**组件本地状态**：
   *   清单只有这一个组件读、只有这一个页签显示，没有跨视图共享的需要。
   *   `null` = 还没取过（首次切到这个页签才去取）。
   */
  let skillList: SkillListResult | null = null
  let skillListLoading = false
  /** 清单**本身**取不到（daemon 起不来 / 文件坏了）——渲染成一整块红字。 */
  let skillListError = ''
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
   * ★ 页面级错误（**卸载失败**）。
   *
   * ⚠️ 原来卸载失败也写进 `errorMessage`，而它**只有一个渲染点**——在「安装」
   *    抽屉里面。于是卸载失败时（抽屉通常是关着的）错误被彻底吞掉：使用者
   *    以为卸载成功了，而技能还在。工具页的同场景早就在页顶渲染（`Tools.svelte`
   *    的 `uninstallError`），这里是漏了第二个渲染点。
   *
   * 原则：**错误显示在触发它的地方**——卸载在列表行上触发 ⇒ 显示在列表上方；
   *      安装 / 扫描在面板里触发 ⇒ 显示在面板里（`errorMessage` / `skillListError`）。
   */
  let pageError = ''
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
        // ★ 支持文件要一起交下去（少了它技能是坏的，而且坏得很安静）
        ...(entry.files ? { files: entry.files } : {}),
        version: entry.version,
        // ★ 溯源：用目录给的**原始来源**（`github:owner/repo@ref:dir`），
        //   而不是 `remote:…`。远端是中转，不是出处——落库记录要指回上游。
        sourceRef: entry.sourceRef ?? `remote:${entry.slug}@${entry.version ?? 'unknown'}`,
        ...(state.needsOverwrite || overwrite ? { overwrite: true } : {}),
      }),
    )
  }

  /**
   * 从「本地清单」装一条。
   *
   * ★ 清单给的是**安装方法**（url / path），不是内容——所以这里走的是**老路**
   *   `installFromPathOrUrl`，由 daemon 现去取。与远端目录那条（内容已抓好、
   *   走 payload 路）是两条不同的路，只是最终都落到同一个安装接口。
   *
   * ★ 状态同样由 `catalogEntryState` 判：清单里**没有版本号**，所以传 `version: null`
   *   ——本地有同名时它给出「替换」并要求 overwrite，本地没有时是「安装」。
   *   界面不自己拼"要不要 overwrite"（那正是最容易写错的地方）。
   */
  function installFromList(entry: SkillListEntry): void {
    const state = catalogEntryState($skills.find((s) => s.slug === entry.slug), {
      slug: entry.slug,
      version: null,
    })
    void runInstall(() =>
      installFromPathOrUrl({
        kind: entry.source.kind,
        value: entry.source.value,
        ...(state.needsOverwrite || overwrite ? { overwrite: true } : {}),
      }),
    )
  }

  /** 取一次本地清单（切到那个页签、或清单取失败后重试时调）。 */
  async function refreshSkillList(): Promise<void> {
    skillListLoading = true
    skillListError = ''
    try {
      skillList = await fetchSkillList()
    } catch (err) {
      // 清单坏掉（读不了 / 不是 JSON / 顶层格式不对）时 daemon 返回非 2xx——
      // 原文带回来显示，不在前端改写。
      skillListError = err instanceof Error ? err.message : String(err)
    } finally {
      skillListLoading = false
    }
  }

  /**
   * ══════════════════════════════════════════════════════════════════
   * 「本地清单」按 category 分组、可折叠（默认折叠）
   * ══════════════════════════════════════════════════════════════════
   *
   * ★ 类别 id 是清单里的**机器值**（英文，如 `software`）。**先显示哪一组**是
   *   界面的事，所以顺序写死在这里；**显示名**在词表里（`skills.cat*`，D39）。
   *   认不出的 id（清单比界面新、加了新类别）排到最后、按字母序，并**原样显示
   *   那个 id**——显示一个英文 id 好过把它悄悄丢掉。
   */
  const CATEGORY_ORDER = [
    'software',
    'docs',
    'slides',
    'research',
    'planning',
    'persona',
    'writing',
    'security',
    'other',
  ]
  // ⚠️ 写成 `as const`（与上面 `DIR_TOOL_KEYS` 同一做法）：`tx` 只接受词表里**真的有**
  //    的键（字面量联合），`Record<string, string>` 会退化成 `string` 而被它拒。
  const CATEGORY_KEYS = {
    software: 'skills.catSoftware',
    docs: 'skills.catDocs',
    slides: 'skills.catSlides',
    research: 'skills.catResearch',
    planning: 'skills.catPlanning',
    persona: 'skills.catPersona',
    writing: 'skills.catWriting',
    security: 'skills.catSecurity',
    other: 'skills.catOther',
  } as const
  function catLabel(id: string): string {
    const key = CATEGORY_KEYS[id as keyof typeof CATEGORY_KEYS]
    return key ? tx(key) : id
  }

  interface SkillGroup {
    id: string
    entries: SkillListEntry[]
  }

  /** 把清单条目按 category 分组，按 `CATEGORY_ORDER` 排、未知的垫底。 */
  function groupSkillList(entries: SkillListEntry[]): SkillGroup[] {
    const byCat = new Map<string, SkillListEntry[]>()
    for (const e of entries) {
      const list = byCat.get(e.category)
      if (list) list.push(e)
      else byCat.set(e.category, [e])
    }
    const known = CATEGORY_ORDER.filter((c) => byCat.has(c))
    const unknown = [...byCat.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).sort()
    return [...known, ...unknown].map((id) => ({ id, entries: byCat.get(id)! }))
  }

  /**
   * 哪几组是展开的——**默认全折叠**（空对象）。
   *
   * ⚠️ 这一页是 **legacy 反应式**（用 `let` + `$:`，没有 runes）：改这个对象要
   *    **整体重新赋值**（`{ ...openCats, [id]: … }`）才会触发重渲染，就地改属性
   *    不会。这也是它写成对象而不是 `Set` 的原因（`Set` 就地增删同样不触发）。
   */
  let openCats: Record<string, boolean> = {}
  function toggleCat(id: string): void {
    openCats = { ...openCats, [id]: !openCats[id] }
  }
  $: skillGroups = groupSkillList(skillList?.entries ?? [])

  /**
   * 卸载一条 skill（D38）。
   *
   * 服务端会拒掉"还有 agent 挂着它"，并把它们列出来——那条错误原文要**带回来**
   * 显示，不在前端改写。
   */
  async function uninstall(id: string, slug: string): Promise<void> {
    // ★ 平台自己的确认框（居中），不是 `window.confirm`——理由见 `lib/confirm.ts`
    if (
      !(await askConfirm({
        title: tx('skills.confirmUninstallTitle', { slug }),
        message: tx('skills.confirmUninstallBody'),
        confirmLabel: tx('common.uninstall'),
        danger: true,
      }))
    )
      return
    removing = id
    pageError = ''
    try {
      await uninstallSkill(id)
      showToast(tx('skills.uninstalled', { slug }))
    } catch (err) {
      // ★ 写在**页面级**（列表上方会渲染）：卸载是从列表行触发的，错误就该在那儿
      pageError = err instanceof Error ? err.message : String(err)
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
   * ★ 两个按钮的权重是有讲究的：**安装是这一页的主线**（`primary`），刷新是配套动作
   *   （`secondary`）——原来它们挤在 `view-head` 里全是一个样子。
   *
   * ⚠️ 2026-10：原来还有一个「设置」按钮（打开"本地技能目录"抽屉）。那个抽屉已随
   *    "本地技能目录改成显式安装"撤掉——它的功能现在是安装面板里的一个页签
   *    （「从本地安装」），入口就是本来的「安装」按钮，所以这里不再有第二个按钮。
   */
  /** 相对时间的「现在」——每次响应式更新重算一遍。 */
  $: now = Date.now()
  // ★ 顺序：**主线动作（primary）排最前**，配套动作（secondary）跟后面——
  //   与智能体页一致。原来这里 primary 排在最后，于是"装一个技能"在顶栏里
  //   是最右边那个，而"智能体"那页最主要那个在最左边：同一排按钮，两页两种读法。
  $: setPageActions('skills', [
    {
      id: 'install',
      label: $t('skills.install'),
      kind: 'primary',
      icon: 'plus',
      /**
       * ⚠️ 面板开着时这个按钮置灰：与智能体页「新建智能体」同一个做法（那边也是
       *    `disabled: creating`）。它已经开着，再点一次没有意义，而"能点但什么都不
       *    发生"是最容易让人以为卡片坏了的一种状态。
       */
      disabled: panelOpen,
      onActivate: openPanel,
    },
    {
      id: 'refresh',
      label: $t('common.refresh'),
      kind: 'secondary',
      icon: 'refresh',
      onActivate: () => void loadSkills(),
    },
  ])
  onDestroy(() => clearPageActions('skills'))

  // ── 「从本地安装」页签 ──
  /**
   * ══════════════════════════════════════════════════════════════════
   * 这个页签解决的是"我别的工具里已经有一堆 skill 了"
   * ══════════════════════════════════════════════════════════════════
   *
   * Claude Code、Codex、Cursor 各自把 skill 放在自己的目录里。切到这个页签，
   * daemon 现扫那几个目录、把里面的技能列出来，**逐条安装**才进库。
   *
   * ★ 2026-10 之前它是"勾上目录 ⇒ 一直跟着磁盘读进来"（自动对账）。那套撤掉了：
   *   装进来之后就是一条**普通技能**（正文落在 `~/.agentdeck/skills/<slug>/`），
   *   与其它来源完全一致。所以这个页签**没有勾选框、没有"导入"按钮**——只有
   *   「安装」，一条一条点。
   */
  /** 正在装哪一条（按钮转圈用）；null = 没有在装。 */
  let installingDir: string | null = null

  /**
   * 「从本地安装」哪几个**目录**组是展开的——**默认全折叠**，与「本地清单」的类别组
   * 同一套做法。
   *
   * ⚠️ 与 `openCats` 一样：这一页是 legacy 反应式，改这个对象要**整体重新赋值**
   *    （就地改属性不触发重渲染）。键是目录的绝对路径（`dir.path`，组里唯一）。
   */
  let openDirs: Record<string, boolean> = {}
  function toggleDirGroup(path: string): void {
    openDirs = { ...openDirs, [path]: !openDirs[path] }
  }

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

  /**
   * 从「从本地安装」页签装一条。
   *
   * ★ 走的是**与手填路径同一条路**（`installFromPathOrUrl`）——`path` 指向那个技能
   *   目录，额外带上 `sourceRef: localdir:<根目录>`（来源标记）。daemon 那边解析、
   *   校验、落库都是同一套，所以 slug 规则只有一处。
   */
  async function installFromDir(dir: LocalSkillScanDir, candidate: LocalSkillCandidate): Promise<void> {
    installingDir = candidate.dir
    try {
      // `runInstall` 自己吞错误（写进 errorMessage），所以这里不会抛
      await runInstall(() =>
        installFromPathOrUrl({
          kind: 'path',
          value: candidate.dir,
          slug: candidate.slug,
          sourceRef: dir.sourceRef,
          ...(overwrite ? { overwrite: true } : {}),
        }),
      )
      // 装完重扫：那条要立刻变成「已安装」（`runInstall` 里已经刷过技能列表了）
      await loadLocalSkillScan()
    } finally {
      installingDir = null
    }
  }

  /**
   * Esc 关掉那个浮层。
   *
   * ★ 这里现在只剩**安装面板**：设置抽屉（本地技能目录）随"改成显式安装"撤掉了。
   *   面板本身就是"按返回就回去"的普通界面，但 Esc 照旧关掉它——这一页上 Esc
   *   一向就是"退出当前这件事"。
   */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    if (panelOpen) closePanel()
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

<!-- ★ 卸载失败要**在这儿**说出来（列表上方）。
     ⚠️ 原来它写进安装抽屉里的 `errorMessage`，抽屉关着时错误就彻底没了——
     使用者以为卸载成功，技能却还在。服务端"还有智能体挂着它"那条原文很长
     且带名单，正是最需要被看见的一类错误。 -->
{#if pageError}
  <div class="notice bad">{pageError}</div>
{/if}


<!--
  ══════════════════════════════════════════════════════════════════
  安装面板：主区**就地**显示（2026-10，不再是右侧抽屉）
  ══════════════════════════════════════════════════════════════════

  使用者报的是"安装是个弹框"，要的是与智能体页「新建智能体」同一种行为：**主区换
  成表单**。所以这里用 `{#if panelOpen} … {:else} …列表… {/if}`——面板取代列表，
  而不是浮在它上面。

  ⚠️ 与真正的对话框（`.drawer` / `.modal`）的差别不只是位置：
     · 没有遮罩、没有 `role="dialog"` / `aria-modal`——**底色之后的东西没有被挡住**，
       读屏器也不该被告诉"这里有个模态框"（那会让它把后面的列表当成不可达）；
     · 它随着页面滚，不贴视口（`position` 不是 fixed）——它现在就是主区的内容；
     · 唯一的"怎么回去"是头部那个**一直可见**的「← 返回技能列表」
       （`.back-to-list` 那个全局 class 只在窄屏才显示，这里不能用它）。
-->
{#if panelOpen}
  <section class="main-panel" aria-label={$t('skills.install')}>
    <header class="main-panel-head">
      <button
        type="button"
        class="ghost small panel-back"
        onclick={closePanel}>{$t('skills.backToList')}</button
      >
      <h2>{$t('skills.install')}</h2>
    </header>

    <div class="main-panel-body">
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
        class={tab === 'dirs' ? 'tab active' : 'tab'}
        onclick={() => {
          tab = 'dirs'
          resetFeedback()
          // 每次切过来都重扫：那几个目录里现在有什么，是这一刻的事实
          void loadLocalSkillScan()
        }}
      >
        {$t('skills.tabDirs')}
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
      <button
        type="button"
        class={tab === 'list' ? 'tab active' : 'tab'}
        onclick={() => {
          tab = 'list'
          resetFeedback()
          // 每次切过来都重取：清单是可编辑的（改文件即可增删），看到的不该是上一次的
          void refreshSkillList()
        }}
      >
        {$t('skills.tabList')}
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
    {:else if tab === 'dirs'}
      <!--
        从本地安装：扫别的 AI 工具的技能目录，列出里面的技能，逐条装。

        ★ 与「本地清单」**用同一个表格壳、同一组列**（技能 / 来源 / 说明 / 本地 /
          操作），也按目录分组、点标题折叠——两个页签是同一件事的两个来源，长得该像
          （2026-10 使用者："这两个列表差异太大，请调整"）。
        ★ 这里**没有勾选框**：装完就是一条普通技能（正文落在 `~/.agentdeck/skills/`
          下），与其它来源一致。所以每行只有「安装」这一个动作。
      -->
      <div class="field">
        {#if $loadError['localSkillScan']}
          <!-- ★ 读不到就说读不到（与其它页签同一原则）：静默给一张空表会让人以为
               "这几个目录里没有 skill"，而其实是这一趟没扫到。 -->
          <div class="notice bad">{$loadError['localSkillScan']}</div>
        {:else if $loading['localSkillScan'] && $localSkillScan.dirs.length === 0}
          <div class="skeleton" style="width:60%"></div>
        {:else}
          <Table
            columns={[
              { label: $t('skills.colSlug') },
              { label: $t('skills.colSource') },
              { label: $t('skills.colSummary') },
              { label: $t('skills.colLocal') },
              { label: '', ariaLabel: $t('skills.colActions') },
            ]}
          >
            {#snippet rows()}
              {#each $localSkillScan.dirs as dir (dir.path)}
                <tr class="cat-row">
                  <td colspan="5">
                    <!-- 整行一个真按钮（与「本地清单」的类别行同一做法）：点哪儿都能折叠。 -->
                    <button
                      type="button"
                      class="cat-toggle"
                      aria-expanded={openDirs[dir.path] ?? false}
                      onclick={() => toggleDirGroup(dir.path)}
                    >
                      <span class="chevron" aria-hidden="true">{openDirs[dir.path] ? '▾' : '▸'}</span>
                      <span class="cat-label">{dirToolLabel(dir.id)}</span>
                      <span class="faint small cat-count">{dir.skills.length}</span>
                      <span class="faint small dir-group-path" title={dir.path}>{dir.path}</span>
                    </button>
                  </td>
                </tr>
                {#if openDirs[dir.path]}
                  {#each dir.skills as s (s.dir)}
                    <tr>
                      <td>
                        <code>{s.slug}</code>
                        <!-- 目录名派生的 name 常常与 slug 相同，重复一行没有信息量。 -->
                        {#if s.name && s.name !== s.slug}
                          <div class="faint small">{s.name}</div>
                        {/if}
                      </td>
                      <!-- ★ 「来源」在这一列是**技能在目录里的相对位置**：目录本身已经
                           在组标题里了，逐条再写一遍那串路径只是重复。 -->
                      <td class="faint small">
                        <span class="list-source" title={s.rel}>{s.rel}</span>
                      </td>
                      <td class="faint small">
                        {#if s.description}
                          <div class="desc-clamp" title={s.description}>{s.description}</div>
                        {/if}
                      </td>
                      <td class="faint small">
                        {#if s.installed}{$t('skills.installedNoVersion')}{:else}—{/if}
                      </td>
                      <td>
                        {#if s.installed}
                          <!-- 目录装进来的没有版本号，只能如实说「已安装」并禁用。 -->
                          <button type="button" class="secondary small" disabled>
                            {$t('skills.dirInstalled')}
                          </button>
                        {:else}
                          <button
                            type="button"
                            class="secondary small"
                            disabled={busy || installingDir === s.dir}
                            onclick={() => void installFromDir(dir, s)}
                          >
                            {installingDir === s.dir ? $t('skills.installing') : $t('skills.dirInstall')}
                          </button>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                {/if}
                {#if dir.error}
                  <!-- ★ 目录读不了就说读不了，而且**不藏在折叠里**：折叠住的错误等于没报
                       （"读不到就说读不到"是这一页的一贯原则）。 -->
                  <tr>
                    <td colspan="5">
                      <div class="notice warn small">{$t('skills.dirReadError', { error: dir.error })}</div>
                    </td>
                  </tr>
                {:else}
                  {#if dir.skills.length === 0}
                    <tr>
                      <td colspan="5"><p class="faint small" style="margin:0">{$t('skills.dirsNoSkill')}</p></td>
                    </tr>
                  {/if}
                  {#if dir.skipped.length > 0}
                    <!-- ★ 一直挂在这儿：看到了却没列出来的东西，理由必须当场说清
                         （没有 SKILL.md、太深、解析不了…）——否则就是"少了一个"，
                         而且它会让人去查权限、查扫描是不是坏了。 -->
                    <tr>
                      <td colspan="5">
                        <div class="faint small dir-skip">
                          {$t('skills.dirsSkipped', {
                            list: dir.skipped.map((k) => `${k.rel}（${k.reason}）`).join('、'),
                          })}
                        </div>
                      </td>
                    </tr>
                  {/if}
                {/if}
              {/each}
            {/snippet}
          </Table>
        {/if}
      </div>
    {:else if tab === 'remote'}
      <div class="field">
        {#if $remoteError}
          <div class="notice bad">
            <!-- ⚠️ 曾经这里写的是 `{#if remoteError}`（**裸的 store 对象**，恒为真）：
                 于是这条"远端不可用"**无条件**显示，冒号后面还空着（因为压根没有错误）
                 ——使用者明明已经把远端起起来了，却一直被告知"远端不可用"
                 （2026-10 使用者报的就是这个）。同一处的 `{:else if !remoteError …}`
                 让下面的空态**永远走不到**，中间那个"未登录"分支也成了死代码。
                 改成订阅值（`$remoteError`）之后三个状态才真的分开。
                 ⚠️ 机器检查：`tests/web-template-stores.test.ts` 会抓这类裸用。 -->
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

        {#if $remoteCatalog && $remoteCatalog.skills.length > 0}
          <!-- ★ 目录里是**精选推荐**（2026-10）：来源由维护者在远端核过，每条都
               带着**原始 GitHub 来源**（下面那一格），装的时候落库记录也指回上游。
               所以这一页签不是"谁都能往里投稿的目录"，是"平台挑过的几条"。 -->
          <p class="faint small" style="margin:0 0 var(--sp-2)">{$t('skills.remotePickedNote')}</p>
          <Table
            columns={[
              { label: $t('skills.colSlug') },
              { label: $t('skills.colSource') },
              { label: $t('skills.colVersion') },
              { label: $t('skills.colSummary') },
              { label: $t('skills.colLocal') },
              { label: '', ariaLabel: $t('skills.colActions') },
            ]}
          >
            {#snippet rows()}
              {#each $remoteCatalog.skills as s (s.slug)}
                  {@const local = $skills.find((x) => x.slug === s.slug)}
                  {@const state = catalogEntryState(local, { slug: s.slug, version: s.version })}
                  <tr>
                    <td>
                      <code>{s.slug}</code>
                      {#if s.name}
                        <div class="faint small">{s.name}</div>
                      {/if}
                      <!-- ★ 「内容不完整」必须在**装之前**看得见（2026-10）：
                           维护者可以在清单里声明 exclude（仓库里混着营销素材/测试产物
                           时用得上）。装了的东西少了零件而界面上不说，正是这个仓库
                           最防的那种失败：跑起来才发现少东西。
                           全文在 title 里，行内只说个数。 -->
                      {#if s.excluded && s.excluded.length > 0}
                        <div
                          class="warn small"
                          title={s.excluded.join('\n')}
                        >{$t('skills.remoteIncomplete', { count: s.excluded.length })}</div>
                      {/if}
                    </td>
                    <td>
                      <!-- ★ 来源列（D69.6）：`github:…` 来源标识放这里，不塞在技能列
                           ——与主表同一布局。这张表是精选推荐，来源必须看得见。 -->
                      {#if s.sourceRef}
                        <SourceRef value={s.sourceRef} />
                      {/if}
                    </td>
                    <td class="faint small">{s.version ? `v${s.version}` : $t('common.noVersion')}</td>
                    <td class="faint small">
                      {s.summary}
                      <!-- ⚠️ 装完还得自己配的东西必须**在装之前**说：装完才发现不能用，
                           比不推荐更糟（如 firecrawl 那一类要 API key）。 -->
                      {#if s.needs}
                        <div class="warn small">{s.needs}</div>
                      {/if}
                    </td>
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
                    <!-- 2026-10（紧凑性）：原来每条 skill 在数据行之下还有一整行
                         状态提示（colspan=5），与按钮的 `title` 是同一句话——删掉，
                         悬停按钮仍能看到同样的说明。 -->
                  </tr>
            {/each}
            {/snippet}
          </Table>
        {:else if !$remoteError && isLoggedIn()}
          <!-- ★ 空态（2026-10）：`server.ts` 那条注释早就写着"目录可以为空，界面
               要有对应的空态——'目录里什么都没有'是一句真话"，而这张表一直只是
               渲染出一个空 `<tbody>`：一句话都没有，看起来像界面坏了。
               ⚠️ 与上面两种状态**必须分开**：远端不可用是"没拉到"，未登录是"没问到"，
               这里是"问到了，目录里现在没有条目"——三者的下一步完全不同。 -->
          <div class="empty">
            <strong>{$t('skills.remoteEmpty')}</strong>
            {$t('skills.remoteEmptyHint')}
          </div>
        {/if}
      </div>
    {:else}
      <!-- 本地清单：读的是 daemon 自带的一份「安装方法」JSON（可编辑）。
           ★ 与远端目录不同，这里**不需要**远端服务 / 同步工具 / 登录。 -->
      <div class="field">
        {#if skillListError}
          <!-- ★ 清单**本身**坏掉（读不了 / 不是 JSON / 顶层格式不对）时 daemon 返回
               非 2xx。那是一处配置错误，必须把原文显示出来，而不是给一张空表——
               空表会让使用者以为"清单里就是没有东西"。 -->
          <div class="notice bad">
            {$t('skills.listLoadFailed', { error: skillListError })}
          </div>
        {:else if skillListLoading && skillList === null}
          <div class="skeleton" style="width:60%"></div>
        {:else if skillList}
          {#if skillList.entries.length > 0}
            <Table
              columns={[
                { label: $t('skills.colSlug') },
                { label: $t('skills.colSource') },
                { label: $t('skills.colSummary') },
                { label: $t('skills.colLocal') },
                { label: '', ariaLabel: $t('skills.colActions') },
              ]}
            >
              {#snippet rows()}
                <!-- 按类别分组、每组一个可折叠的标题行（默认折叠）。`skillGroups`
                     是 `$:` 响应式的，`null` 不收窄也没关系（它不是 null）。 -->
                {#each skillGroups as group (group.id)}
                  <tr class="cat-row">
                    <td colspan="5">
                      <!-- 整行一个**真按钮**：tab 能到、读屏器能读、`aria-expanded`
                           报折叠状态——与表格的 `ExpandToggle`、`FoldSection` 同一纪律。 -->
                      <button
                        type="button"
                        class="cat-toggle"
                        aria-expanded={openCats[group.id] ?? false}
                        onclick={() => toggleCat(group.id)}
                      >
                        <span class="chevron" aria-hidden="true">{openCats[group.id] ? '▾' : '▸'}</span>
                        <span class="cat-label">{catLabel(group.id)}</span>
                        <span class="faint small cat-count">{group.entries.length}</span>
                      </button>
                    </td>
                  </tr>
                  {#if openCats[group.id]}
                    {#each group.entries as e (e.slug)}
                      {@const local = $skills.find((x) => x.slug === e.slug)}
                      {@const state = catalogEntryState(local, { slug: e.slug, version: null })}
                      <tr>
                        <td>
                          <code>{e.slug}</code>
                          {#if e.name}
                            <div class="faint small">{e.name}</div>
                          {/if}
                        </td>
                        <td>
                          <!-- ★ 来源是**安装方法**本身（GitHub 链接或本地路径），原样显示：
                               使用者要能核对"我点的这条到底从哪儿装"。长链接单行省略，
                               全文在 title 里。 -->
                          <span class="faint small list-source" title={e.source.value}>{e.source.value}</span>
                        </td>
                        <td class="faint small">
                          {e.summary}
                          <!-- ⚠️ 装完还得自己配的东西必须**在装之前**说（如某个 API key）。 -->
                          {#if e.needs}
                            <div class="warn small">{e.needs}</div>
                          {/if}
                        </td>
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
                            class={state.action === 'install' ? 'secondary small' : 'small'}
                            disabled={busy || state.disabled}
                            title={$t(state.hintId, state.hintParams)}
                            onclick={() => installFromList(e)}
                          >
                            {$t(state.labelId, state.labelParams)}
                          </button>
                        </td>
                      </tr>
                    {/each}
                  {/if}
                {/each}
              {/snippet}
            </Table>
          {:else}
            <!-- 空态：问到了，清单里现在就是没有条目（与"没取到"是两回事）。 -->
            <div class="empty">
              <strong>{$t('skills.listEmpty')}</strong>
              {$t('skills.listEmptyHint')}
            </div>
          {/if}

          {#if skillList.skipped.length > 0}
            <!-- ★ 明确**没**列出来的条目及原因：静默跳过是这类功能最容易让人困惑的
                 地方（"我清单里写了 12 条，怎么只有 11 条"）。 -->
            <p class="warn small" style="margin-top:var(--sp-2)">
              {$t('skills.listSkipped', {
                list: skillList.skipped.map((s) => `${s.path}（${s.reason}）`).join('、'),
              })}
            </p>
          {/if}
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
    {:else if tab === 'dirs'}
      <p class="faint small" style="margin:0">{$t('skills.dirsFootHint')}</p>
    {:else if tab === 'remote'}
      <p class="faint small" style="margin:0">{$t('skills.remoteFootHint')}</p>
    {:else}
      <p class="faint small" style="margin:0">{$t('skills.listFootHint')}</p>
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

    <!--
      主操作在**面板自己的底部**（`.main-panel-foot`）。
      ⚠️ 它原来贴住视口底部（`.drawer-foot` 是 flex 列的固定一截）——那是弹框才有的
         手感。就地面板里它是"表单的最后一步"，跟着内容走；而反馈（上面两个 notice）
         依然紧挨在它上面，按下就能看见。
    -->
    <div class="main-panel-foot">
      {#if tab === 'path'}
        <button type="button" disabled={busy} onclick={submitPath}>
          {busy ? $t('skills.installing') : $t('skills.installCheck')}
        </button>
      {:else if tab === 'dirs'}
        <span class="faint small">
          {$t('skills.dirsFootNote')}
        </span>
      {:else if tab === 'remote'}
        <span class="faint small">
          {$t('skills.remoteFootNote')}
        </span>
      {:else}
        <span class="faint small">
          {$t('skills.listFootNote')}
        </span>
      {/if}
    </div>
  </section>
{:else}

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
  <Table
    columns={[
      { label: $t('skills.colSlug') },
      { label: $t('skills.colName') },
      { label: $t('skills.colSource') },
      { label: $t('skills.colVersion') },
      { label: $t('skills.colFiles') },
      { label: $t('skills.colUpdatedAt') },
      { label: '', ariaLabel: $t('skills.colActions') },
    ]}
  >
    {#snippet rows()}
      {#each groupedSkills as entry, i (entry.skill.id)}
          {@const s = entry.skill}
          {@const fileCount = Object.keys(s.files ?? {}).length}
          {@const prev = groupedSkills[i - 1]}
          {#if i === 0 || !prev || prev.group !== entry.group}
            <tr class="group-head">
              <td colspan="7">
                <span class="faint small group-label">
                  {entry.group === 'mine'
                    ? $t('crystallize.groupMine')
                    : $t('crystallize.groupInstalled')}
                </span>
              </td>
            </tr>
          {/if}
          <tr>
            <td>
              <!-- ★ 与工具页同一个做法：展开入口从行尾挪到首格 chevron——
                   行尾那格只留卸载（和"为什么不能卸"的说明）。真按钮：
                   tab 能到、读屏器能读、aria-expanded 能报状态。 -->
              <!-- D69.8：chevron + slug 包进 flex（.row-title）——列一窄内联元素
                   会折行（table 是 width:100%），flex 永不折行 -->
              <div class="row-title">
                <ExpandToggle
                  expanded={expanded === s.id}
                  labelExpand={$t('skills.viewStandard')}
                  labelCollapse={$t('skills.collapseStandard')}
                  onclick={() => (expanded = expanded === s.id ? null : s.id)}
                />
                <code class="skill-slug">{s.slug}</code>
              </div>
            </td>
            <td>
              <!-- D69：名称与目录表 / remote 同一档（faint small）——slug 才是
                   主标识，名称是第二行 -->
              <div class="faint small">{s.name}</div>
              <!-- ★ 与工具页同一格式：名称下面跟一句说明（没有就不画）。
                   ⚠️ 说明可能很长（实测有 400+ 字符的），所以**最多两行**截断、
                   全文在 `title` 里——列表是用来扫的，一行被撑成十行就扫不动了。
                   完整内容在展开后的正文里。 -->
              {#if s.description}
                <div class="faint small desc-clamp" title={s.description}>{s.description}</div>
              {/if}
            </td>
            <td>
              {#if s.localDir}
                <!-- 来自某个本地技能目录：来源要写成**那个目录**，而不是笼统的
                     "本机自建"——使用者要能对上自己装它时点的那个目录。它只是一条
                     来源标记：装完就是普通技能，正文在我们自己的 skills/ 下。 -->
                <span class="badge local">
                  {$t('skills.fromDir', { dir: s.localDir })}
                </span>
              {:else if s.source === 'mine'}
                <!-- D80：我提炼的（skills-mine 根，git 版本管理）——与安装的分组
                     徽标，让"这是我的资产"一眼可辨。 -->
                <span class="badge mine">
                  {$t('crystallize.mineBadge')}
                </span>
              {:else}
                <!-- D69：来源徽标统一配方——同步/远端 = 默认灰徽章，本地 = accent。
                     不再借任务状态色 `todo/in_review`（那是给任务状态用的）。 -->
                <span class="badge" class:local={s.source === 'local'}>
                  {s.source === 'local' ? $t('skills.sourceLocal') : $t('skills.sourceRemote')}
                </span>
              {/if}
              {#if entry.shadowed}
                <!-- D80：安装的 slug 被提炼版遮蔽——注入用提炼版，这一条实际不生效 -->
                <span class="badge shadowed" title={$t('crystallize.shadowed')}>
                  {$t('crystallize.shadowed')}
                </span>
              {/if}
              {#if s.sourceRef && !s.localDir}
                <!-- 来源标识要能看见：出问题时第一件事就是"它到底从哪儿来的"。
                     ⚠️ 但来自本地目录的那条**不重复显示**：它的 `sourceRef` 就是
                     `localdir:<那个目录>`，而上面那个徽标已经把同一个路径写出来了
                     ——同一行里写两遍同一个路径，只会让人以为它们是两件事。
                     ⚠️ 长路径**不许换行**：单行省略，全文在 `title` 里。
                     ★ 2026-10（紧凑性）：与工具页同一做法——`span` 与徽章同行，
                     块级 div 换行会把整行撑高一截。 -->
                <SourceRef value={s.sourceRef} />
              {/if}
            </td>
            <td class="faint small">
              {s.version ? `v${s.version}` : $t('common.noVersion')}
            </td>
            <td class="faint small">
              SKILL.md{#if fileCount > 0} +{fileCount}{/if}
            </td>
            <td class="faint small" title={absoluteTime(s.updatedAt)}>{relativeTime(s.updatedAt, now)}</td>
            <!-- ⚠️ 与工具页同一做法：flex 放在**内层 div** 上，不放 td 上 -->
            <td>
              <div class="row-actions">
                <!-- 卸载（D38）：README 里挂着的"没有卸载，要删只有改库"到这里补上。
                   ★ 2026-10：从本地技能目录装进来的**也能卸**了——它现在是一条普通
                     技能（正文落在我们自己的 skills/ 下），卸掉就是卸掉，不会"自己
                     回来"。以前它每次读列表都会被重扫回来，所以那时不给卸。 -->
                <button
                  type="button"
                  class="ghost small danger"
                  disabled={removing === s.id}
                  title={$t('skills.uninstallTitle')}
                  onclick={() => void uninstall(s.id, s.slug)}
                >
                  {removing === s.id ? $t('common.uninstalling') : $t('common.uninstall')}
                </button>
              </div>
            </td>
          </tr>
          {#if expanded === s.id}
            <tr>
              <!-- 7 列：动作那一列随"skill 不再带动作"一起去掉了 -->
              <td colspan="7">
                <pre class="skill-body">{s.body}</pre>
                <!-- 历史（git）只对「我提炼的」有意义：安装来的是外部内容，重新装就行
                     （设计 §「版本管理」那一行）。所以 non-mine 连这一节都不出现——
                     点开一条装来的技能看到"版本管理未启用"是纯噪音。
                     ★ 2026-10：这一节就是 P2 的界面（历史一直躺在 skills-mine 的 git 里，
                       从前没有入口 ⇒ "更新之后看不出改了什么"，进化等于盲签）。 -->
                {#if s.source === 'mine'}
                  <SkillHistory skill={{ id: s.id, slug: s.slug, source: s.source }} />
                {/if}
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
    {/snippet}
  </Table>
{/if}

{/if}

<style>
  /* 面板的容器（边框 / 圆角 / 头部 / 底部）由全局的 `.main-panel*` 提供
     （见 `packages/ui/src/styles/app.css`，工具页用同一套）。这里只管面板
     **内部**那几块。 */
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

  /* 本地清单的「来源」列：一条 GitHub 链接或本地路径可能很长。单行省略、全文在
     title 里——列表是用来扫的，一行被撑成十行就扫不动了。 */
  .list-source {
    display: inline-block;
    max-width: 20rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
  }

  /* 本地清单：类别标题行（可折叠）。整行一个按钮，撑满宽度——点哪儿都行，
     不用瞄准那个小箭头。 */
  .cat-toggle {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 100%;
    background: none;
    border: none;
    border-radius: 0;
    padding: var(--sp-2) 0;
    color: var(--text);
    font-size: var(--fs-sm);
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }
  .cat-toggle:hover { color: var(--accent); }
  .cat-label { flex: 1; }
  /* 类别标题行与上面的组、与下面展开出来的行都要分得开：上边框 + 一层底色。
     底色用 `color-mix` 随主题自适应（与全站的扁平化描边同一套做法）。 */
  .cat-row td {
    background: color-mix(in srgb, var(--text) 4%, transparent);
    border-top: 1px solid var(--line);
  }

  /* ── 「从本地安装」页签 ── */
  /* 目录组标题里的路径（与「本地清单」的类别标题行是同一套 `.cat-toggle`）：靠右、
     单行省略，全文在 `title` 里——工具名就在旁边，扫描时看名字即可。 */
  .dir-group-path {
    min-width: 0;
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
  }
  /* "跳过了什么"缩进一行：它是对上面那个目录的补充，不是另一个目录 */
  .dir-skip { padding-left: var(--sp-3); padding-bottom: var(--sp-2); }

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

  /* D80：分组表头行（我提炼的 / 安装的）——不喧宾夺主，只把两摊分开 */
  .group-head td {
    padding-top: var(--sp-3);
    padding-bottom: var(--sp-1);
    border-bottom: 1px solid var(--line);
  }
  .group-label {
    text-transform: none;
    letter-spacing: 0.02em;
  }
  .badge.mine {
    color: var(--accent);
    border-color: var(--accent);
  }
  .badge.shadowed {
    color: var(--text-faint);
    border-color: var(--line);
    opacity: 0.85;
  }
</style>
