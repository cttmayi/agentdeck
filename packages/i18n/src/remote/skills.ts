import type { TextCatalog } from '../text.ts'

/** 远端管理页：技能目录（推荐清单抓下来的那份）。 */
export const remoteSkillsText = {
  'remote.skillsTitle': { zh: '技能（推荐目录）', en: 'Skills (recommended catalog)' },
  'remote.skillsCount': { zh: '共 {count} 条', en: '{count} entries' },
  'remote.skillsEmpty': {
    zh: '目录里现在没有技能：维护者还没同步推荐清单。',
    en: 'No skills in the catalog yet: the maintainer has not synced the list.',
  },
  'remote.colSlug': { zh: '技能', en: 'Skill' },
  'remote.colVersion': { zh: '版本', en: 'Version' },
  'remote.colSource': { zh: '来源', en: 'Source' },
  'remote.colFiles': { zh: '文件', en: 'Files' },
  'remote.colSynced': { zh: '抓取于', en: 'Fetched' },
  'remote.incomplete': {
    zh: '内容不完整：跳过了 {count} 项（清单里声明的排除）',
    en: 'Incomplete: {count} item(s) skipped (declared exclusions)',
  },
  // ⚠️ 行内按钮叫「查看」，**不叫**「SKILL.md 正文」：那是表头/抽屉里那一节的标题，
  //    把它当按钮名等于每行重复一遍表头（2026-10 审查时量的就是这个）。
  'remote.view': { zh: '查看', en: 'View' },
  'remote.expandDetail': { zh: '展开详情', en: 'Expand details' },
  'remote.collapseDetail': { zh: '收起详情', en: 'Collapse details' },
  'remote.detailContent': { zh: 'SKILL.md 正文', en: 'SKILL.md' },
  'remote.detailNeeds': { zh: '需要配置', en: 'Needs configuration' },
  'remote.detailFiles': { zh: '装进来的文件', en: 'Files included' },
  'remote.detailExcluded': { zh: '被清单排除的文件', en: 'Excluded by the manifest' },
  // ⚠️ 按钮名要**自解释**：使用者 2026-10 问过"重新同步是什么功能呀，同步的是什么"——
  //    那一问说明"重新同步"这四个字没把"同步的是那份清单"说出来。
  'remote.syncNow': { zh: '按推荐清单重新抓取', en: 'Re-fetch from the recommended list' },
  'remote.syncWhat': {
    zh: '它做的是：按推荐清单从 GitHub 重新抓一遍，整目录替换目录。不动你手动装的那些，也不碰任何人本机的技能库。',
    en: "It re-fetches every entry of the recommended list from GitHub and replaces the catalog directory atomically. It does not touch your manual installs, nor anyone's local skill library.",
  },
  /** 清单摘要这一行：条数 / 核对于 / 文件在哪 —— 全部由接口给的**真实数据**渲染。 */
  'remote.manifestLine': {
    zh: '清单：{count} 条，核对于 {verified}　·　文件：{path}',
    en: 'List: {count} entries, verified {verified} · file: {path}',
  },
  'remote.manifestNoVerified': { zh: '未记录', en: 'not recorded' },
  'remote.manifestMissing': {
    zh: '清单还没转存到配置位置（{path}）。第一次跑同步（或手动跑工具）时会把内置默认转存过去，那之后它就是可配置的那一份。',
    en: 'The list has not been copied to its config location yet ({path}). The first sync (or a manual tool run) seeds it from the built-in default; from then on that file is the configurable one.',
  },
  'remote.manifestBroken': { zh: '清单读不了：{error}', en: 'Could not read the list: {error}' },
  'remote.syncBusy': {
    zh: '正在同步…（已跑 {seconds} 秒）',
    en: 'Syncing… ({seconds}s)',
  },
  'remote.syncAlreadyRunning': {
    zh: '已经有一次同步在跑（本页一次只允许一个）。',
    en: 'A sync is already running (one at a time).',
  },
  'remote.syncNever': { zh: '这一进程里还没触发过同步。', en: 'No sync triggered in this process yet.' },
  'remote.syncOk': { zh: '上次同步成功：{time}', en: 'Last sync succeeded: {time}' },
  'remote.syncFailed': { zh: '上次同步失败：{reason}', en: 'Last sync failed: {reason}' },
  'remote.syncUnavailable': {
    zh: '这个部署没配同步工具，按钮不可用（服务启动时用 --sync-tool 指定）。',
    en: 'No sync tool configured for this deployment (start the service with --sync-tool).',
  },
  'remote.syncStarted': { zh: '已开始同步：{time}', en: 'Sync started: {time}' },
  'remote.syncLogTitle': { zh: '同步输出（末尾 {count} 行）', en: 'Sync output (last {count} lines)' },
  'remote.installTitle': { zh: '手动装一条技能', en: 'Install a skill manually' },
  'remote.installUrlLabel': { zh: 'GitHub 链接', en: 'GitHub link' },
  'remote.installUrlHint': {
    zh: '仓库根、目录或 SKILL.md 的链接都行（与 daemon 装技能同一套规则：只允许 GitHub、必须有 SKILL.md）。',
    en: 'Repo root, a directory, or a SKILL.md link (same rules as the daemon: GitHub only, SKILL.md required).',
  },
  'remote.installNameLabel': { zh: '名字（可选）', en: 'Name (optional)' },
  'remote.installSummaryLabel': { zh: '一句话说明（可选）', en: 'One-line summary (optional)' },
  'remote.installNeedsLabel': { zh: '装完还得自己配什么（可选）', en: 'What still needs configuring (optional)' },
  'remote.installSubmit': { zh: '装进远端目录', en: 'Install into the catalog' },
  'remote.installing': { zh: '正在抓取…', en: 'Fetching…' },
  'remote.installOk': { zh: '已装进远端目录：{slug}（{count} 个文件）', en: 'Installed: {slug} ({count} file(s))' },
  'remote.uninstall': { zh: '卸载', en: 'Uninstall' },
  'remote.uninstallConfirm': {
    zh: '确定从远端目录里卸掉「{slug}」？它只是从目录里移除（装在别人本机上的那份不受影响）。',
    en: 'Remove "{slug}" from the remote catalog? Only the catalog entry is removed (installs on other machines are unaffected).',
  },
  'remote.uninstallOk': { zh: '已从远端目录卸载：{slug}', en: 'Removed from the catalog: {slug}' },
  'remote.sourceSynced': { zh: '推荐清单', en: 'Recommended list' },
  'remote.sourceLocal': { zh: '本地添加', en: 'Added locally' },
  'remote.syncedNotRemovable': {
    zh: '这一条来自推荐清单：要删就把它从清单里去掉，再点「按推荐清单重新抓取」。',
    en: 'This one comes from the recommended list: remove it there and re-fetch.',
  },
  'remote.verifiedAt': { zh: '核对于 {date}', en: 'verified {date}' },
  'remote.syncedAt': { zh: '同步于 {time}', en: 'synced {time}' },
  'remote.neverSynced': { zh: '还没同步过', en: 'never synced' },
} as const satisfies TextCatalog
