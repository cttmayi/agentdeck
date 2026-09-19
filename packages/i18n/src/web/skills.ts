import type { TextCatalog } from '../text.ts'

/**
 * Skills 视图：`apps/web/src/views/Skills.svelte`（列表 + 安装抽屉）。
 *
 * ⚠️ 分文件的依据是**代码结构**（一个区域一份），所以"界面上那句话在代码哪儿"
 *    是直接的：看到 `skills.install` 就知道去 `Skills.svelte` 找调用点。
 *
 * ⚠️ zh 的值**必须与迁移之前逐字一致**：中文是这个项目的默认语言，也是所有既有
 *    测试、布局探针与文档断言的依据——改一个字就会有东西变红，而那种红不是这个
 *    功能要的。
 *
 * ⚠️ 被 `<strong>` 拆开的句子按 `…Before` / `…Strong` / `…After` 分段（标记里的
 *    粗体结构原样保留）：分段值里的空格与标点是**渲染结果的一部分**，拼接后必须
 *    与原来那句一字不差。
 */
export const skillsText = {
  'skills.title': { zh: 'Skills', en: 'Skills' },
  /**
   * ⚠️ 这句原本列的是 skill 的"三要素"（审核标准 + 判决结构引用 + 允许执行的
   *    动作子集）。D37 把标准搬走、D40 收口又把动作权限搬走之后，那三样里有两样
   *    **根本不在 skill 上了**——句子留着就会对使用者说反话（他会去 skill 里找
   *    权限，而那里没有）。所以它改成如实描述：skill 是**资料包**（正文 + 支持
   *    文件），并明说另外两样住在审核者身上。
   */
  'skills.headIntro': {
    zh: 'skill 是执行者干活时参考的资料包：',
    en: 'A skill is a reference pack the executor consults: ',
  },
  'skills.headStrongBody': { zh: '正文（SKILL.md）', en: 'the body (SKILL.md)' },
  'skills.headStrongFiles': { zh: '支持文件', en: 'support files' },
  'skills.headOutro': {
    zh: '。它不决定审核标准，也不决定"判完允许动什么"——那两样都写在审核者自己身上（智能体页 → 点开审核者）。',
    en: '. It decides neither the review standard nor what a verdict may trigger — both live on the reviewer itself (Agents page → open the reviewer).',
  },
  'skills.install': { zh: '安装 skill', en: 'Install skill' },

  'skills.tabPath': { zh: '从路径 / GitHub 安装', en: 'Install from a path / GitHub' },
  'skills.tabRemote': { zh: '从远端目录安装', en: 'Install from the remote catalog' },
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
    zh: '（大写）——技能就是靠"目录里有它"被 CLI 发现的，没有它装进来也不会生效，所以会当场拒绝。同目录下的其它文本文件会作为',
    en: ' (uppercase) — that is how the CLI discovers a skill, and without it the install would not take effect, so it is rejected on the spot. Other text files in the same directory are installed as ',
  },
  'skills.pathHintSupportStrong': { zh: '支持文件', en: 'support files' },
  'skills.pathHintAfter': {
    zh: '一起装上（二进制会被跳过并列出）。',
    en: ' along with it (binaries are skipped and listed).',
  },
  'skills.slugLabel': { zh: 'slug（留空则用目录名）', en: 'slug (empty = use the directory name)' },

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
    zh: '允许替换同名的 skill（会**覆盖**已有那个的内容）',
    en: 'Allow replacing a skill with the same name (this overwrites the existing one)',
  },
  'skills.overwriteHint': {
    zh: '默认不勾：同名一律拒绝写入，避免"下载顺手覆盖了你自己的东西"。确实要用新版本顶掉旧的（比如你自己改过一版、现在想换回目录里那一版）才勾上。',
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

  'skills.emptyTitle': { zh: '还没有 skill', en: 'No skills yet' },
  'skills.emptyHint': {
    zh: '技能是执行者干活时参考的资料包（可安装、带版本、可带支持文件）。',
    en: 'A skill is a reference pack the executor consults while working (installable, versioned, optionally with support files).',
  },
  'skills.emptyAuditStrong': { zh: '审核标准不在这里', en: 'Audit criteria are not here' },
  'skills.emptyAuditAfter': {
    zh: '——它写在审核者自己身上（智能体页 → 点开审核者）。',
    en: ' — they live on the reviewer itself (Agents page → open the reviewer).',
  },

  'skills.colName': { zh: '名称', en: 'Name' },
  'skills.colSource': { zh: '来源', en: 'Source' },
  'skills.colFiles': { zh: '文件', en: 'Files' },
  // ⚠️ 这里原来还有一条 `colAllowedActions`（列表里那一列动作）——那一列随
  //    "skill 不再带动作"一起去掉了。
  'skills.colUpdatedAt': { zh: '更新于', en: 'Updated' },
  'skills.sourceLocal': { zh: '本机自建', en: 'Built locally' },
  'skills.sourceRemote': { zh: '远端下载', en: 'Downloaded' },
  'skills.viewStandard': { zh: '看标准', en: 'View criteria' },
  'skills.collapseStandard': { zh: '收起标准', en: 'Hide criteria' },
  'skills.uninstallTitle': {
    zh: '卸载：还有智能体挂着它时会被拒（会告诉你还挂着的是谁）',
    en: 'Uninstall: refused while agents still mount it (it tells you which ones)',
  },
  // ★ 「卸载」/「卸载中…」不放这儿：`common.uninstall` / `common.uninstalling` 就是这两句，
  //   再写一份就有两个出处（改一处漏一处）。只有这句带说明的标题是本区域独有的。
  'skills.supportFiles': { zh: '支持文件（{count}）', en: 'Support files ({count})' },

  // ── 命令式文案：toast / confirm / 就地错误（事件回调里用 `tx`）──
  'skills.errEmptySource': {
    zh: '请填一个本地目录的绝对路径，或一个 GitHub 链接。',
    en: 'Enter an absolute path of a local directory, or a GitHub link.',
  },
  'skills.errNoRemoteEntry': { zh: '远端目录里没有 {slug}', en: 'No {slug} in the remote catalog' },
  'skills.confirmUninstall': {
    zh: '卸载「{slug}」？工作目录里的技能副本会在下一次 run 开始时同步掉。',
    en: 'Uninstall "{slug}"? The copy in the working directory is synced away when the next run starts.',
  },
  'skills.uninstalled': { zh: '已卸载 {slug}', en: 'Uninstalled {slug}' },
  'skills.noteFailed': { zh: '失败：{code}', en: 'Failed: {code}' },
} as const satisfies TextCatalog
