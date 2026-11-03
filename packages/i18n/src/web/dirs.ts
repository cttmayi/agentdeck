import type { TextCatalog } from '../text.ts'

/**
 * 目录浏览（分批第 229 批）：「新建对话 / 新建任务」里那个工作目录输入框的**选择框**。
 *
 * 为什么词条单独一张表：它是**两个表单共用的一个控件**（对话与任务各挂一次），
 * 词条既不属于 `chat` 也不属于 `newtask`——放进任何一边，另一边的调用点读着就别扭。
 *
 * ⚠️ 这里的措辞有个反复拿捏过的分寸：**"列的是这台机器上的真实目录"**这句必须留着。
 *   使用者第一次打开会以为这是"平台里的某个目录树"（预览/浏览器一类），而它其实直连
 *   磁盘——选出什么，agent 就会在那一处读写。说清楚这件事比省一行字重要。
 */
export const dirsText = {
  /** 输入框旁边那颗按钮（对话与任务两处同一颗）。 */
  'dirs.browse': { zh: '浏览…', en: 'Browse…' },
  'dirs.title': { zh: '选择一个目录', en: 'Pick a directory' },
  'dirs.subtitle': {
    zh: '列的是这台机器上的真实目录。选中之后，那个绝对路径会填进「工作目录」——它读、它写，都在那一处。',
    en: 'These are real directories on this machine. The absolute path you confirm goes into the working directory — that is where it reads and writes.',
  },
  'dirs.pathLabel': { zh: '路径', en: 'Path' },
  'dirs.up': { zh: '上一级', en: 'Up one level' },
  'dirs.home': { zh: '家目录', en: 'Home' },
  'dirs.workRoot': { zh: '工作区', en: 'Workspace' },
  'dirs.go': { zh: '去', en: 'Go' },
  'dirs.refresh': { zh: '刷新', en: 'Refresh' },
  'dirs.pick': { zh: '选这个目录', en: 'Use this directory' },
  /** 目录在前、文件在后：文件只是"这里确实是那个仓库"的佐证，不能选。 */
  'dirs.filesPreview': {
    zh: '文件列出来只为了让你确认「是不是这个目录」，不能选。',
    en: 'Files are listed only to confirm this is the right directory; they cannot be picked.',
  },
  'dirs.count': {
    zh: '{dirs} 个目录 · {files} 个文件',
    en: '{dirs} directories · {files} files',
  },
  'dirs.truncated': {
    zh: '只列了前 {n} 项（这个目录很大）。要精确到某一层，直接在路径框里打。',
    en: 'Only the first {n} entries are listed (large directory). Type the path directly to go deeper.',
  },
  'dirs.empty': {
    zh: '这个目录里没有可列的东西（空目录，或者只有隐藏项）。',
    en: 'Nothing to list here (empty, or only hidden entries).',
  },
  'dirs.loading': { zh: '读取中…', en: 'Loading…' },
  /**
   * ★ 失败按**码**说话，不把服务端那句中文原样转出来：
   *   界面可能切到英文（`/api/fs/dirs` 的 `error` 只有中文），而"不存在 / 不是目录 /
   *   没权限 / 路径不是绝对的"这四种处置完全不同。码是稳定的契约，原话只是兜底。
   */
  'dirs.err.not_found': { zh: '这个目录不存在。', en: 'That directory does not exist.' },
  'dirs.err.not_a_dir': { zh: '这是一个文件，不是目录。', en: 'That is a file, not a directory.' },
  'dirs.err.denied': { zh: '没有权限读这个目录。', en: 'No permission to read that directory.' },
  'dirs.err.not_absolute': {
    zh: '需要一个绝对路径（以 / 开头）。',
    en: 'An absolute path is required (starting with /).',
  },
  /**
   * ★ 404 且**没有错误码** = 这个 daemon 还没有这条接口（先起的 daemon、后换的界面）。
   *   与"目录不存在"必须分开说：一个要重启 daemon，一个要改路径，处置完全不同。
   */
  'dirs.err.noRoute': {
    zh: '这个 daemon 还不认识目录选择（它是这次更新之前起的）。重启一次 daemon，「浏览…」就能用了。',
    en: 'This daemon does not know directory browsing yet (it started before this update). Restart the daemon and Browse… will work.',
  },
  'dirs.err.unknown': { zh: '读不出这个目录：{reason}', en: 'Could not read that directory: {reason}' },
} as const satisfies TextCatalog
