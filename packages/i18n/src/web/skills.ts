import type { TextCatalog } from '../text.ts'

/**
 * Skills 视图：`apps/web/src/views/Skills.svelte`（列表 + 安装抽屉）。
 *
 * ⚠️ 分文件的依据是**代码结构**（一个区域一份），所以"界面上那句话在代码哪儿"
 *    是直接的：看到 `skills.install` 就知道去 `Skills.svelte` 找调用点。
 *
 * ⚠️ zh 的值改之前先看一眼**有没有东西钉着它**：中文是默认语言，既有测试、布局
 *    探针与文档都引用它。⚠️ 但"与迁移之前逐字一致"**不再是判据**（2026-09 的文案
 *    改写把那批文字按"这句话是给谁看的"重写了一遍：去掉开发口径、机器取值与
 *    markdown 残留）。有引用就一起改，没有就按读者改。
 *
 * ⚠️ 被 `<strong>` 拆开的句子按 `…Before` / `…Strong` / `…After` 分段（标记里的
 *    粗体结构原样保留）：分段值里的空格与标点是**渲染结果的一部分**，拼接后必须
 *    与原来那句一字不差。
 */
export const skillsText = {
  /**
   * ⚠️ 这里**原有一个 `skills.title`**（= 侧栏那一项的写法），2026-09 改版时删了：
   *    页名现在由顶栏显示，而顶栏与侧栏**共用同一个词条**（`shell.navSkills`，
   *    见 `apps/web/src/lib/view.ts` 的 `VIEW_TITLE_KEYS`）。留着它就等于同一句话
   *    有两个来源，改一处不会报错，只会让两处慢慢不一样。
   *    同一次删掉的还有主区里那行重复的 `<h2>Skills</h2>`。
   */
  /**
   * ⚠️ 这句原本列的是 skill 的"三要素"（审核标准 + 判决结构引用 + 允许执行的
   *    动作子集）。D37 把标准搬走、D40 收口又把动作权限搬走之后，那三样里有两样
   *    **根本不在 skill 上了**——句子留着就会对使用者说反话（他会去 skill 里找
   *    权限，而那里没有）。所以它改成如实描述：skill 是**资料包**（正文 + 支持
   *    文件），并明说另外两样住在审核者身上。
   */
  'skills.headIntro': {
    zh: '技能是执行者干活时参考的资料包：',
    en: 'A skill is a reference pack the executor consults: ',
  },
  'skills.headStrongBody': { zh: '正文（SKILL.md）', en: 'the body (SKILL.md)' },
  'skills.headStrongFiles': { zh: '支持文件', en: 'support files' },
  'skills.headOutro': {
    zh: '。它不决定审核者的判断依据（那在审核者的「指令」里；智能体页 → 点开审核者），也不决定「判完允许动什么」（那是智能体组的事；智能体组页 → ③ 行动）。',
    en: '. It decides neither the reviewer’s judging criteria (that lives in the reviewer’s Instructions; Agents page → open the reviewer) nor what a verdict may trigger (that belongs to the agent group; Groups page → 3 Act).',
  },
  'skills.install': { zh: '安装技能', en: 'Install skill' },
  /*
   * ★ 2026-10：安装面板从右侧抽屉改成主区的就地面板，于是需要一句"怎么回去"。
   *   它**必须一直可见**（面板把列表换掉了）——与任务页/智能体页的「← …列表」
   *   同一个说法，只是那边的按钮只在窄屏出现。
   */
  'skills.backToList': { zh: '← 返回技能列表', en: '← Back to skills' },

  'skills.tabPath': { zh: '从路径 / GitHub 安装', en: 'Install from a path / GitHub' },
  'skills.tabRemote': { zh: '从远端目录安装', en: 'Install from the remote catalog' },
  /*
   * ★ 第三个页签：一份**仓库自带**的 JSON 清单，每条写一个安装方法（GitHub 链接
   *   或本地路径）。它**不需要**远端服务、同步工具或登录——点一下由 daemon 现去取。
   */
  'skills.tabList': { zh: '从本地清单安装', en: 'Install from a local list' },
  'skills.pathLabel': {
    zh: '本地目录的绝对路径，或 GitHub 链接',
    en: 'Absolute path of a local directory, or a GitHub link',
  },
  'skills.sourcePlaceholder': {
    zh: 'https://github.com/owner/repo/tree/main/skills/foo 或 /Users/me/dev/my-skill',
    en: 'https://github.com/owner/repo/tree/main/skills/foo or /Users/me/dev/my-skill',
  },
  'skills.pathHintBefore': { zh: '指向的目录里', en: 'The target directory ' },
  'skills.pathHintStrong': { zh: '必须有 SKILL.md', en: 'must contain SKILL.md' },
  'skills.pathHintMid': {
    zh: '（大写）——技能就是靠「目录里有它」被 CLI 发现的，没有它装进来也不会生效，所以会当场拒绝。同目录下的其它文本文件会作为',
    en: ' (uppercase) — that is how the CLI discovers a skill, and without it the install would not take effect, so it is rejected on the spot. Other text files in the same directory are installed as ',
  },
  'skills.pathHintSupportStrong': { zh: '支持文件', en: 'support files' },
  'skills.pathHintAfter': {
    zh: '一起装上（二进制会被跳过并列出）。',
    en: ' along with it (binaries are skipped and listed).',
  },
  /**
   * ⚠️ 这里原来直接写着 `slug`（2026-09 改写）：那是我们自己代码里的叫法，界面上
   *    一律说「标识」——它在这一页就是"这条 skill 叫什么名字"。
   */
  'skills.slugLabel': { zh: '标识（留空则用目录名）', en: 'ID (empty = use the directory name)' },
  'skills.colSlug': { zh: '技能', en: 'Skill' },

  'skills.remoteUnavailable': { zh: '远端不可用：{error}', en: 'Remote unavailable: {error}' },
  'skills.remoteDownBefore': { zh: '远端目录在', en: 'The remote catalog runs in ' },
  'skills.remoteDownStrong': { zh: '另一个进程', en: 'another process' },
  'skills.remoteDownAfter': {
    zh: '上（默认 127.0.0.1:4518）。它没起来不影响本机——也可以直接用左边那个页签从 GitHub 或本地路径装。',
    en: ' (default 127.0.0.1:4518). It being down does not affect this machine — you can also use the tab on the left to install from GitHub or a local path.',
  },
  'skills.notSignedIn': { zh: '还没有登录远端账号。', en: 'You are not signed in to the remote account yet.' },
  'skills.notSignedInHint': {
    zh: '目录是公开的，但登录后才会用你的账号去取。可以在顶栏的「远端」里登录；或者直接用「从路径 / GitHub 安装」。',
    en: 'The catalog is public, but it is fetched with your account only once you sign in. Sign in under "Remote" in the top bar; or just use "Install from a path / GitHub".',
  },
  'skills.colVersion': { zh: '版本', en: 'Version' },
  'skills.colSummary': { zh: '说明', en: 'Summary' },
  'skills.colLocal': { zh: '本地', en: 'Local' },
  'skills.installedVersion': { zh: '已装 {version}', en: 'Installed {version}' },
  'skills.installedNoVersion': { zh: '已装（无版本）', en: 'Installed (no version)' },

  /**
   * ⚠️ 这里原来有三条只服务那一块"允许这个 skill 触发的动作"的词条
   *    （`actionsLegend` / `actionsHintBefore` / `actionsHintAfter`）：那块 UI 随
   *    D40 收口整块删掉了——动作权限是审核者的能力，装 skill 不再收它，所以给那段
   *    勾选写的说明也一并删掉（留着就是"界面上没有、词表里还在"的死词条）。
   */
  'skills.overwriteLabel': {
    zh: '允许替换同名的技能（会覆盖已有那个的内容）',
    en: 'Allow replacing a skill with the same name (this overwrites the existing one)',
  },
  'skills.overwriteHint': {
    zh: '默认不勾：同名一律拒绝写入，避免「下载顺手覆盖了你自己的东西」。确实要用新版本顶掉旧的（比如你自己改过一版、现在想换回目录里那一版）才勾上。',
    en: 'Off by default: the same name is always refused, so a download cannot quietly overwrite your own work. Tick it only when you really want the new version to replace the old one (say you edited your copy and now want the catalog version back).',
  },
  'skills.pathFootHint': {
    zh: '填好上面的来源，点右下角「检查并安装」。',
    en: 'Fill in the source above, then click "Check and install" at the bottom right.',
  },
  'skills.remoteFootHint': {
    zh: '选一个条目，点它右侧的按钮把它装进来。',
    en: 'Pick an entry and click the button on its right to install it.',
  },

  // ── 本地清单（第三个页签）──
  'skills.listFootHint': {
    zh: '清单按类别分组。点一下类别把它展开，再选一条、点它右侧的按钮装进来——装的时候会现去 GitHub（或你写的那条路径）取。',
    en: 'The list is grouped by category. Click a category to expand it, then pick an entry and click the button on its right to install it — it is fetched on the spot from GitHub (or the path you wrote).',
  },
  /**
   * 类别名（分组折叠区的标题）。
   *
   * ★ 类别 id 是**清单里的机器值**（英文，如 `software`）——它一个字都不翻，翻译只
   *   加在这些标签上（D39）。清单里出现了这里没有的 id 时，界面**原样显示那个 id**
   *   （显示一个英文 id 好过显示一片空白），所以这几个键只管"认得的"那些。
   * ★ emoji 与文字一起放在值里（两种语言同一份）：它只是个视觉锚点，不翻译。
   */
  'skills.catSoftware': { zh: '🧑💻 软件开发 & 工程', en: '🧑💻 Software & engineering' },
  'skills.catDocs': { zh: '📄 文档 & 数据处理', en: '📄 Documents & data' },
  'skills.catSlides': { zh: '🎞️ 幻灯片 & 演示', en: '🎞️ Slides & decks' },
  'skills.catResearch': { zh: '🔍 调研 & 分析', en: '🔍 Research & analysis' },
  'skills.catPlanning': { zh: '📊 项目管理 & 规划', en: '📊 Planning & project management' },
  'skills.catPersona': { zh: '🧑 角色蒸馏 & 人格模拟', en: '🧑 Persona & role-play' },
  'skills.catWriting': { zh: '✍️ 写作、创意 & 媒体', en: '✍️ Writing, creative & media' },
  'skills.catSecurity': { zh: '🛡️ 安全 & 运维', en: '🛡️ Security & ops' },
  'skills.catOther': { zh: '📦 其它', en: '📦 Other' },
  'skills.listEmpty': { zh: '本地清单里没有条目', en: 'The local list has no entries' },
  'skills.listEmptyHint': {
    zh: '清单文件里现在没有可安装的条目（可能被改空了，或每一条都写得不合法）。',
    en: 'The list file has no installable entries right now (it may have been emptied, or every entry is invalid).',
  },
  /**
   * 清单**本身**坏掉（读不了 / 不是 JSON / 顶层格式不对）。
   * ⚠️ 与"清单是空的"必须分开：那是"读到了，里面就是没有"，这是"根本没读到"——
   *    两者的下一步完全不同（改清单内容 vs 修文件本身）。
   */
  'skills.listLoadFailed': { zh: '本地清单读不了：{error}', en: 'Could not read the local list: {error}' },
  /**
   * 清单里有条目**没**列出来（缺 url/path、主机不在白名单……）。
   * ⚠️ 必须说出来：静默跳过会让"我写了 12 条怎么只有 11 条"无从解释。
   */
  'skills.listSkipped': { zh: '没列出来的条目：{list}', en: 'Entries not listed: {list}' },
  'skills.listFootNote': {
    zh: '上面每一条右侧的按钮就是安装入口。清单是仓库自带的，改它即可增删条目。',
    en: 'The button on the right of each row above is the install entry point. The list ships with the repo; edit it to add or remove entries.',
  },

  'skills.failedTitle': { zh: '没有装上', en: 'Not installed' },
  'skills.installedTitle': { zh: '已安装', en: 'Installed' },
  'skills.noChangesTitle': { zh: '没有改动', en: 'No changes' },
  'skills.includedCount': { zh: '装进来 {count} 个文件：', en: 'Installed {count} file(s):' },
  'skills.ignoredHeading': { zh: '没装进来：', en: 'Not installed:' },
  'skills.source': { zh: '来源：{ref}', en: 'Source: {ref}' },
  'skills.installing': { zh: '正在检查并安装…', en: 'Checking and installing…' },
  'skills.installCheck': { zh: '检查并安装', en: 'Check and install' },
  'skills.remoteFootNote': {
    zh: '上面每一条右侧的按钮就是安装入口。',
    en: 'The button on the right of each row above is the install entry point.',
  },

  'skills.emptyTitle': { zh: '还没有技能', en: 'No skills yet' },
  'skills.emptyHint': {
    zh: '技能是执行者干活时参考的资料包（可安装、带版本、可带支持文件）。',
    en: 'A skill is a reference pack the executor consults while working (installable, versioned, optionally with support files).',
  },
  'skills.emptyAuditStrong': { zh: '判断依据不在这里', en: 'Judging criteria are not here' },
  'skills.emptyAuditAfter': {
    zh: '——它写在审核者的「指令」里（智能体页 → 点开那个审核者）。',
    en: ' — they live in the reviewer’s Instructions (Agents page → open that reviewer).',
  },

  'skills.colName': { zh: '名称', en: 'Name' },
  'skills.colSource': { zh: '来源', en: 'Source' },
  'skills.colFiles': { zh: '文件', en: 'Files' },
  // ⚠️ 这里原来还有一条 `colAllowedActions`（列表里那一列动作）——那一列随
  //    "skill 不再带动作"一起去掉了。
  'skills.colUpdatedAt': { zh: '更新于', en: 'Updated' },
  /** 最后一列是按钮列、没有可见表头，读屏器用这个 aria-label（与工具页同一做法）。 */
  'skills.colActions': { zh: '操作', en: 'Actions' },
  'skills.sourceLocal': { zh: '本机', en: 'Local' },
  'skills.sourceRemote': { zh: '远端', en: 'Remote' },
  /**
   * ⚠️ 这两个键名还带着 `Standard`，而它们按的其实是**这个 skill 的正文**
   *    （`SKILL.md` 展开/收起）。键名留着是为了少改一处调用点，**措辞必须准**：
   *    界面上写「看标准」会让人以为标准还住在 skill 里——D37 之后它就不在那儿了。
   */
  'skills.viewStandard': { zh: '看正文', en: 'View body' },
  'skills.collapseStandard': { zh: '收起正文', en: 'Hide body' },
  'skills.uninstallTitle': {
    zh: '卸载：还有智能体挂着它时会被拒（会告诉你还挂着的是谁）',
    en: 'Uninstall: refused while agents still mount it (it tells you which ones)',
  },
  // ★ 「卸载」/「卸载中…」不放这儿：`common.uninstall` / `common.uninstalling` 就是这两句，
  //   再写一份就有两个出处（改一处漏一处）。只有这句带说明的标题是本区域独有的。
  'skills.supportFiles': { zh: '支持文件（{count}）', en: 'Support files ({count})' },

  // ── 「从本地安装」页签（把别的 AI 工具那儿的 skill 装进来）──
  /**
   * ★ 这一页签**不做自动同步**（2026-10 改的）：它扫那几个目录、列出里面的技能，
   *   逐条装。装完就是一条普通技能（正文落在 `~/.agentdeck/skills/` 下），与其它
   *   来源一致——所以这里没有勾选框、没有"导入"，只有「安装」。
   */
  'skills.tabDirs': { zh: '从本地安装', en: 'Install from local dirs' },
  'skills.dirsToolClaude': { zh: 'Claude Code', en: 'Claude Code' },
  'skills.dirsToolCodex': { zh: 'Codex', en: 'Codex' },
  'skills.dirsToolCursor': { zh: 'Cursor', en: 'Cursor' },
  'skills.dirsToolAgents': { zh: 'AGENTS 约定目录', en: 'AGENTS convention' },
  'skills.dirsNoSkill': { zh: '里面没有技能', en: 'No skills inside' },
  /** 目录本身读不了（不存在 / 没权限）——说清是哪个目录、为什么。 */
  'skills.dirReadError': { zh: '这个目录读不了：{error}', en: 'This directory could not be read: {error}' },
  /** 一条待安装技能的按钮。 */
  'skills.dirInstall': { zh: '安装', en: 'Install' },
  /** 库里已经有同 slug 的了。 */
  'skills.dirInstalled': { zh: '已安装', en: 'Installed' },
  /** 看到却没列出来的东西（没有 SKILL.md、太深、解析不了…），带原因。 */
  'skills.dirsSkipped': { zh: '跳过：{list}', en: 'Skipped: {list}' },
  'skills.dirsFootHint': {
    zh: '这些是别的 AI 工具（Claude Code / Codex / Cursor / AGENTS）放技能的目录。装进来的技能正文会落在 AgentDeck 自己的 skills 目录下，之后就是一条普通技能——想在那边改了也生效，就再装一次，或直接改我们这份。',
    en: 'These are the directories where other AI tools (Claude Code / Codex / Cursor / AGENTS) keep their skills. Installed skills are copied into AgentDeck’s own skills directory and then behave like any other skill — to pick up later edits over there, install again or edit our copy.',
  },
  'skills.dirsFootNote': {
    zh: '逐个安装：装完就是一条普通技能，不再跟着源目录走。',
    en: 'Install one by one: once installed it behaves like any other skill and no longer follows the source directory.',
  },

  // ── 列表里"这条是从本地目录来的" ──
  'skills.fromDir': { zh: '来自 {dir}', en: 'From {dir}' },

  // ── 命令式文案：toast / confirm / 就地错误（事件回调里用 `tx`）──
  'skills.errEmptySource': {
    zh: '请填一个本地目录的绝对路径，或一个 GitHub 链接。',
    en: 'Enter an absolute path of a local directory, or a GitHub link.',
  },
  'skills.errNoRemoteEntry': { zh: '远端目录里没有 {slug}', en: 'No {slug} in the remote catalog' },
  /** 目录里是精选推荐（2026-10：推荐清单），不是投稿目录。 */
  'skills.remotePickedNote': {
    zh: '目录里是维护者核过来源的推荐项；每条都写着它的原始 GitHub 来源，装的时候也按那个来源记档。',
    en: 'The catalog holds picks whose sources were checked by the maintainer; each row shows its original GitHub source, which is also recorded when you install it.',
  },
  /**
   * 目录里现在没有条目。
   * ⚠️ 与"远端不可用""未登录"**必须分开**：那是"没拉到 / 没问到"，这是
   *    "问到了，目录里就是空的"——三者的下一步不同。
   */
  /**
   * 「内容不完整」：维护者在清单里声明了 exclude，所以有几个文件**没有**装进来。
   * ⚠️ 必须在装之前就看得见——装了的东西少了零件而界面上不说，跑起来才知道。
   */
  'skills.remoteIncomplete': {
    // ⚠️ 说"项"而不是"个文件"：维护者写的排除图案可以是**整目录**（`docs/**`），
    //    那时被剪掉的是那一棵子树，报出来的也是目录。
    zh: '内容不完整：跳过了 {count} 项（清单里声明的排除）',
    en: 'Incomplete: {count} item(s) skipped (declared exclusions)',
  },
  'skills.remoteEmpty': { zh: '远端目录里现在没有条目', en: 'The remote catalog has no entries right now' },
  'skills.remoteEmptyHint': {
    zh: '维护者还没同步推荐清单（或清单是空的）。要装东西可以直接在上面那一栏填 GitHub 链接。',
    en: 'The maintainer has not synced the recommended list yet (or it is empty). You can install from a GitHub link in the tab above.',
  },
  'skills.confirmUninstallTitle': { zh: '卸载「{slug}」', en: 'Uninstall "{slug}"' },
  'skills.confirmUninstallBody': {
    zh: '工作目录里的技能副本会在下一次 run 开始时同步掉。',
    en: 'The copy in the working directory is synced away when the next run starts.',
  },
  'skills.uninstalled': { zh: '已卸载 {slug}', en: 'Uninstalled {slug}' },
  'skills.noteFailed': { zh: '失败：{code}', en: 'Failed: {code}' },
} as const satisfies TextCatalog
