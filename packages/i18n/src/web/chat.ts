import type { TextCatalog } from '../text.ts'

/**
 * 聊天（`views/Chat.svelte`）。
 *
 * ⚠️ 这里说的「聊天」是**闭环的旁路**：没有判决，因此也没有动作。凡是会让人以为
 *    "这里也能动手"的地方都要写清楚——使用者刚刚看着一个智能体跑完一堆命令，
 *    最容易误会的就是这一点。
 *
 *    ⚠️ 2026-09：**页面上那句常驻的边界提示去掉了**（原来是左栏底部那一行
 *    `chat.noActionsHint`，每一屏都在说同一件事）。现在这个边界的落点是
 *    「带过去」那条路：想动手就得预填到新建任务那一页，那里才定审核者与动作。
 *
 * ⚠️ zh / en 两边都要有，占位符要一致（`i18n.test.ts` 逐条守着）。
 */
export const chatText = {
  'chat.listTitle': { zh: '对话', en: 'Conversations' },
  'chat.newConversation': { zh: '新对话', en: 'New conversation' },
  'chat.empty': { zh: '还没有对话。', en: 'No conversations yet.' },
  'chat.emptyHint': {
    zh: '选一个执行者，说第一句话——对话就从那句话开始。',
    en: 'Pick an executor and say the first thing — the conversation starts there.',
  },
  'chat.noSelection': { zh: '左边选一个对话，或者新建一个。', en: 'Pick a conversation on the left, or start a new one.' },
  'chat.turnCount': { zh: '{count} 轮', en: '{count} turn(s)' },
  'chat.neverUsed': { zh: '还没说过话', en: 'Nothing said yet' },

  'chat.agentLabel': { zh: '执行者', en: 'Executor' },
  'chat.agentHint': {
    zh: '对话绑定一个执行者，中途不换——上文的延续是那个 CLI 的会话，换人接不上。要换就新建对话。',
    en: "A conversation is bound to one executor and it can't be switched mid-way: the context lives in that CLI's session. Start a new conversation to switch.",
  },
  'chat.pickAgent': { zh: '选执行者', en: 'Choose an executor' },
  'chat.agentGroup': { zh: '执行者', en: 'Executors' },
  'chat.skillGroup': {
    zh: '或者按 skill 选（装着几条就有几条）',
    en: 'Or pick a skill (one entry per installed skill)',
  },
  'chat.skillOptionOwned': { zh: '{skill}（→ {agent}）', en: '{skill} (→ {agent})' },
  'chat.skillOptionSelf': { zh: '{skill}（没挂给谁）', en: '{skill} (attached to nobody)' },
  'chat.skillOwner': {
    zh: '将使用 {agent}——它挂着 {skill}。',
    en: 'Will use {agent} — it has {skill}.',
  },
  'chat.skillSelfCarried': {
    zh: '将使用 {agent} + {skill}——没有执行者挂它，这条 skill 跟着这个对话走。',
    en: 'Will use {agent} + {skill} — no executor has it, so this conversation carries it.',
  },
  'chat.noExecutor': { zh: '还没有执行者。先去「智能体」建一个。', en: 'No executor yet. Create one under Agents first.' },
  /**
   * ── 右栏底部那一栏「工作目录的文件」──
   *
   * 标题与树里的词条在 `files.ts` 里（那一栏的组件是任务页与聊天**共用**的），
   * 这里只放聊天这一侧特有的几句：条数、刷新、以及这台 daemon 还没有那条接口。
   */
  'chat.filesCount': { zh: '· {count} 项', en: '· {count} items' },
  'chat.filesRefresh': { zh: '刷新', en: 'Refresh' },
  'chat.filesRunningHint': {
    zh: '它正在这个目录里干活——点「刷新」看现在的样子。',
    en: 'It is working in this directory right now — hit Refresh to see the current state.',
  },
  /**
   * ⚠️ 这句只在**能力标志不在**时出现（旧 daemon）。不让它去撞 404 再报错：
   *    任务页那边撞过一次，而那一栏把失败画成了骨架屏 ⇒ "取不到"与"还在加载"
   *    长得一模一样，使用者看到的就是"这一栏什么都没有"。
   */
  'chat.filesNeedRestart': {
    zh: '这一栏要重启本机的 daemon 之后才有：现在跑着的那个还不认识它。',
    en: 'This needs a restart of the local daemon: the one running now does not know about it yet.',
  },
  /**
   * ★ 这一栏会列出 **agent 自己写的文件**，那不是平台的"动作"。
   *
   *   聊天仍然不产出判决、因此不触发任何登记过的动作（见这一页顶上那段）。
   *   这句话就是为了不让那一栏被读成"这次动了什么"——那是一个它兑现不了的
   *   说法，而"看起来对、实际错"正是这个项目的老毛病。
   */
  'chat.filesNotAnAction': {
    zh: '这一栏是这个目录里现在有什么（含它自己写的文件）。聊天仍然不触发任何登记过的动作。',
    en: 'This shows what is in the directory now — including files it wrote itself. Chat still triggers no registered actions.',
  },
  'chat.skillsNeedRestart': {
    zh: '{skills} 现在选不到：这个对话自带 skill 的功能要重启本机的 daemon 之后才有（现在跑着的那个还不认识它）。',
    en: '{skills} cannot be picked right now: per-conversation skills need a restart of the local daemon — the one running now does not know about them yet.',
  },
  'chat.reviewerCannotChat': {
    zh: '审核者不能用来聊天：聊天不产出判决，让它闲聊会让人以为它说的话有判决的分量。',
    en: "A reviewer can't be used for chat: chat produces no verdict, and chatting with one makes its words look like a decision.",
  },

  'chat.workDirLabel': { zh: '工作目录', en: 'Working directory' },
  'chat.workDirAuto': { zh: '平台分配', en: 'Chosen by the platform' },
  'chat.workDirAutoHint': {
    zh: '留空 = 平台给这个对话分配一个专属目录。填路径 = 把它接进你的仓库，那个目录里的东西它会读、会改。',
    en: 'Empty = the platform gives this conversation its own directory. A path = point it at your repo, where it can read and write.',
  },
  /**
   * ⚠️ 这段是**风险披露**，信息量一个字都不能少：它要回答的是"我填了这个目录
   *    之后，它到底能对我的文件做什么"。原文写的是实现细节（"跳过权限确认"、
   *    "沙箱默认是关的"，2026-09 改写）——那两句对读界面的人不构成信息，
   *    换成"能改、能删、和你自己在终端里一样"这种能据它做决定的话。
   */
  'chat.workDirWarning': {
    zh: '注意：它在这个目录里不只是读——它能改、能删、能新建，权限和你自己在终端里跑命令一样。',
    en: 'Heads up: inside this directory it does not just read — it can change, delete and create files, with the same rights you have when running commands in a terminal.',
  },
  'chat.workDirSave': { zh: '保存目录', en: 'Save directory' },
  'chat.workDirReset': { zh: '改回平台分配', en: 'Back to platform-chosen' },
  'chat.notRunYet': { zh: '还没跑过', en: 'Not run yet' },

  'chat.placeholder': { zh: '说点什么…（Enter 发送，Shift+Enter 换行）', en: 'Say something… (Enter to send, Shift+Enter for a new line)' },
  'chat.send': { zh: '发送', en: 'Send' },
  // ⚠️ 与「新建任务」的「要做什么」**正好相反**（那边 Enter 换行），所以两处
  //    都写在输入框下面，靠位置猜是不负责任的。
  'chat.enterHint': { zh: 'Enter 发送 · Shift+Enter 换行', en: 'Enter to send · Shift+Enter for a new line' },
  'chat.sending': { zh: '发送中…', en: 'Sending…' },
  'chat.stop': { zh: '停止', en: 'Stop' },
  'chat.stopping': { zh: '正在停…', en: 'Stopping…' },
  'chat.you': { zh: '你', en: 'You' },
  'chat.toolsUsed': { zh: '用了 {count} 个工具', en: '{count} tool call(s)' },
  'chat.running': { zh: '正在跑', en: 'Running' },
  'chat.noOutput': { zh: '这一轮没有文字产出。', en: 'This turn produced no text.' },
  'chat.turnFailed': { zh: '这一轮没跑起来', en: "This turn didn't start" },
  'chat.duration': { zh: '用时 {seconds} 秒', en: '{seconds}s' },

  'chat.rename': { zh: '改名', en: 'Rename' },
  'chat.renameSave': { zh: '保存', en: 'Save' },
  'chat.renameCancel': { zh: '取消', en: 'Cancel' },
  'chat.delete': { zh: '删除对话', en: 'Delete conversation' },
  'chat.deleteConfirm': {
    zh: '删掉这个对话和它的全部轮次？执行记录会留着（审计与成本统计还认得它）。',
    en: 'Delete this conversation and all its turns? The run records stay (audit and cost still know about them).',
  },
  'chat.deleteConfirmYes': { zh: '确认删除', en: 'Delete' },
  'chat.deleted': { zh: '对话已删除', en: 'Conversation deleted' },

  'chat.bridgeTurn': { zh: '用这个去派活', en: 'Turn this into a task' },
  'chat.bridgeAll': { zh: '把整个对话派出去', en: 'Turn the whole conversation into a task' },
  'chat.bridgeHint': {
    zh: '只是把内容预填进「新建任务」：审核者和动作白名单仍然要你自己在那一页定，聊天这边不会替你决定。',
    en: 'This only pre-fills the New task page: the reviewer and the action whitelist are still yours to set there. Chat never decides that for you.',
  },
  'chat.bridged': { zh: '已经预填到「新建任务」，确认后提交。', en: 'Pre-filled on the New task page — review and submit there.' },

  /**
   * ⚠️ 这里原有 `chat.noActionsHint`（"这里不动手：聊天不产出判决，而动作的门槛
   *    就是判决。"），2026-09 按要求删掉了：它常驻左栏底部，每一屏都在说同一件事。
   *
   *    边界**本身没有变**（聊天里跑的东西不产判决，因此不触发动作），但落点只剩
   *    「带过去」那一条路——上面那句 `chat.bridgeHint` 仍然写着"审核者和动作白名单
   *    要你在新建任务那一页定"，想动手就得走那儿。
   */
  'chat.summary': { zh: '{turns} 轮 · 最近 {when}', en: '{turns} turn(s) · last {when}' },
  'chat.justNow': { zh: '刚刚', en: 'just now' },
  'chat.minutesAgo': { zh: '{count} 分钟前', en: '{count} min ago' },
  'chat.hoursAgo': { zh: '{count} 小时前', en: '{count} h ago' },
  'chat.daysAgo': { zh: '{count} 天前', en: '{count} d ago' },
} as const satisfies TextCatalog
