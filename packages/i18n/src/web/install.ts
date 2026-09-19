import type { TextCatalog } from '../text.ts'

/**
 * skill 安装：`apps/web/src/lib/skill-catalog.ts`（目录条目该显示什么动作）
 * 与 `apps/web/src/lib/skill-install.ts`（安装结果的说明、错误码的下一步建议）。
 *
 * ⚠️ 这两份文案原来长在**库层**（`catalogEntryState()` 的 `label` / `hint`、
 *    `describeInstall()` / `installErrorHint()` 拼出来的句子）。库层不知道当前
 *    界面语言，所以现在改由库层产出**键 + 插值**，界面用 `$t(id, params)` /
 *    `tx(id, params)` 渲染（那两个函数在 `apps/web/src/lib/i18n.ts`）。
 *
 * ⚠️ zh 的值**必须与迁移之前逐字一致**：中文是这个项目的默认语言，也是既有测试、
 *    布局探针与文档（`README.md` / `docs/design.md` 的"装 / 更新 / 退回"那张表）
 *    断言的依据——改一个字就会有东西变红。
 *
 * ⚠️ 过渡成员已经删掉了（D39 收尾）：`CatalogEntryState.label` / `.hint`、
 *    `describeInstall()` / `installErrorHint()`、以及它们里面那份固定的 `zh` 渲染器。
 *    现在这条链上**只有一份中文**——就是下面这些词条，库层只产出键 + 插值。
 */
export const installText = {
  // ── 目录条目的按钮：四种动作各有各的字 ──────────────────────────────
  // 拆成"四个完整动作名"而不是"一个动词 + 一个版本号"：中文里 `更新` 能直接加版本
  // 变成 `更新到 1.1.0`，英文的 Update + to 也是同理，但**不能**指望两种语言都能
  // 这样拼，所以带版本号的那两条写死成完整句子（`install.actionUpdateTo`）。
  'install.actionInstall': { zh: '安装', en: 'Install' },
  'install.actionReplace': { zh: '替换本地同名', en: 'Replace local copy' },
  'install.actionInstalled': { zh: '已安装', en: 'Installed' },
  'install.actionUpdate': { zh: '更新', en: 'Update' },
  'install.actionUpdateTo': { zh: '更新到 {version}', en: 'Update to {version}' },
  'install.actionDowngradeTo': { zh: '退回 {version}', en: 'Roll back to {version}' },

  // ── 目录条目的说明：为什么是那个动作 ──────────────────────────────
  'install.foundInDir': {
    zh: '目录里有 {slug} {version}，本地还没有。',
    en: 'The catalog has {slug} {version}, and nothing is installed locally yet.',
  },
  'install.replaceLocalHint': {
    zh: '本地已有一个同名的 {slug}，但它没有版本信息（本机自建，或从路径/GitHub 装的）——所以无法判断是不是同一份内容。替换会用目录里的 {version} 覆盖它。',
    en: 'A local {slug} with the same name already exists, but it carries no version information (built on this machine, or installed from a path/GitHub), so we cannot tell whether it is the same content. Replacing overwrites it with {version} from the catalog.',
  },
  'install.installedHint': {
    zh: '本地这份就是目录里的 {version}，目录里没有更新的版本。',
    en: 'The local copy is {version} from the catalog, and the catalog has no newer version.',
  },
  // 两个版本号认不出新旧时**不猜大小**，把两个字符串都摆出来让人自己看。
  'install.updateUnknownHint': {
    zh: '本地 {local} → 目录 {remote}（这两个版本号不是 x.y.z 形式，无法判断新旧，请自行确认）。',
    en: 'Local {local} → catalog {remote} (neither is an x.y.z version, so the order cannot be determined — please check yourself).',
  },
  'install.updateHint': {
    zh: '本地 {local} → 目录 {remote}。',
    en: 'Local {local} → catalog {remote}.',
  },
  // 降级不许说成"更新"：这里逐字保留那句"点下去是往回退"。
  'install.downgradeHint': {
    zh: '本地 {local} 比目录里的 {remote} **更新**。点下去是往回退，不是更新——确认这是你要的。',
    en: 'The local {local} is **newer** than {remote} in the catalog. Clicking goes backwards, not forwards — make sure that is what you want.',
  },

  // ── 安装结果的说明（`describeInstallMessages`）──────────────────────
  // 结果里可能有**一串** slug、**一串**被忽略的文件，所以列表由界面 join：
  // `{slugs}` / `{items}` 的值是数组，界面用下面这条分隔符连接（见
  // `skill-install.ts` 的 `renderInstallMessage`）。
  'install.installedList': { zh: '已安装 {slugs}', en: 'Installed {slugs}' },
  // 与 `agents.listSeparator` 同形同值，仍按"一个区域一份"单列：这里连接的是
  // skill slug，那边连接的是动作名，语境不同，不跟着词表走。
  'install.listSeparator': { zh: '、', en: ', ' },
  // zh 没有前导空格（中文全角括号自带间隔），en 有——空格是**渲染结果的一部分**。
  'install.fromSource': { zh: '（来自 {source}）', en: ' (from {source})' },
  'install.ignoredList': { zh: '；没装进来：{items}', en: '; not installed: {items}' },
  'install.ignoredItem': { zh: '{path}（{reason}）', en: '{path} ({reason})' },
  'install.skipped': { zh: '；跳过 {slug}：{reason}', en: '; skipped {slug}: {reason}' },
  'install.noChange': { zh: '没有任何改动', en: 'Nothing changed' },
  // ★ 下面两条是**只有括号**的词条（括号里装的是 daemon 给的值，值本身不翻译）。
  //   为什么要单独两条：`install.ignoredItem` 把路径包在句子里面，而界面上那处
  //   路径要用 `<code>` 包住（等宽字体）——想复用那条词条就得把 `<code>` 从标记里
  //   拿掉，等于为了词表改渲染结构。全角括号一旦写死在标记里，英文界面里就会冒出
  //   中文标点（这正是 D39 要消掉的那类"一半中文"）。
  'install.errDetail': { zh: '（{detail}）', en: ' ({detail})' },
  'install.ignoredReason': { zh: '（{reason}）', en: ' ({reason})' },

  // ── 安装失败时"那我该怎么做"（按错误码给）────────────────────────
  // 错误码本身（`blocked_host`…）是契约值，不翻译；翻译的是**下一步的建议**。
  'install.errBlockedHost': {
    zh: '只支持 GitHub 的公开仓库链接。本机上的技能请改用「本地目录」并填绝对路径。',
    en: 'Only public GitHub repository links are supported. For a skill on this machine, use "local directory" and enter an absolute path instead.',
  },
  'install.errRateLimited': {
    zh: 'GitHub 匿名访问有每小时 60 次的限制。等一会儿再试，或设置环境变量 ALPHA_HELPER_GITHUB_TOKEN。',
    en: 'Anonymous GitHub access is capped at 60 requests per hour. Wait a while and retry, or set the ALPHA_HELPER_GITHUB_TOKEN environment variable.',
  },
  'install.errMissingSkillMd': {
    zh: '技能是一个**目录**，里面必须有 SKILL.md（大写）。请把链接/路径指到那个目录。',
    en: 'A skill is a **directory**, and it must contain SKILL.md (uppercase). Point the link/path at that directory.',
  },
  'install.errBadSlug': {
    zh: 'slug 只能是小写字母、数字与连字符。可以显式指定一个。',
    en: 'A slug may only contain lowercase letters, digits and hyphens. You can specify one explicitly.',
  },
  'install.errNotFound': {
    zh: '检查路径/链接：仓库是否为私有、分支名与目录是否写对。',
    en: 'Check the path/link: whether the repository is private, and whether the branch name and directory are correct.',
  },
  'install.errTooLarge': {
    zh: '技能应当是少量文本文件。请精简后再装。',
    en: 'A skill should be a small number of text files. Trim it down and install it again.',
  },
} as const satisfies TextCatalog
