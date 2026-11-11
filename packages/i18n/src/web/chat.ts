import type { TextCatalog } from '../text.ts'

/**
 * 聊天（`views/Chat.svelte`）。
 *
 * ⚠️ 这里说的「聊天」是**闭环的旁路**：没有判决，因此也没有动作。凡是会让人以为
 *    "这里也能动手"的地方都要写清楚——使用者刚刚看着一个智能体跑完一堆命令，
 *    最容易误会的就是这一点。
 *
 *    ⚠️ 2026-09：**页面上那句常驻的边界提示去掉了**（原来是左栏底部那一行
 *    `chat.noActionsHint`，每一屏都在说同一件事）。
 *    ⚠️ 2026-10：**「派发任务」也去掉了**（两个按钮：把整个对话派出去 / 用这个去派活，
 *    它们把内容预填进「新建任务」）。所以现在页面上不再有任何说明边界的话——
 *    想动手就直接去「新建任务」写，两页之间没有任何隐藏通道。
 *
 * ⚠️ zh / en 两边都要有，占位符要一致（`i18n.test.ts` 逐条守着）。
 */
export const chatText = {
  /**
   * ⚠️ 这里**原有一个 `chat.listTitle`**（`对话` / `Conversations`）——2026-10（D64）
   *    按要求整条删了：聊天栏头的「对话」二字去掉，栏头变成与任务/智能体**完全同款**
   *    的「计数 + 搜索」。"这一栏装的是什么"由顶栏页名（聊天）+ 行内信息承担。
   *    删的时候探针也加了判据：三页栏头带里**都不许有 h2**（`skeleton.headsTitleless`）。
   */
  'chat.newConversation': { zh: '新建对话', en: 'New conversation' },
  /**
   * 栏头带（D63 加计数搜索、D64 去掉标题后）：与任务/智能体**完全同款**的
   * 「计数 + 搜索」。计数数的是**当前显示**的条数（过滤之后）。
   */
  'chat.listCount': { zh: '共 {count} 条', en: '{count} conversations' },
  'chat.search': { zh: '搜索标题…', en: 'Search titles…' },
  'chat.emptyFiltered': { zh: '没有匹配的对话', en: 'No matching conversations' },
  'chat.emptyFilteredHint': {
    zh: '换个关键词，或清空搜索框。',
    en: 'Try another keyword, or clear the search box.',
  },
  'chat.empty': { zh: '还没有对话', en: 'No conversations yet' },
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
  'chat.agentGroup': { zh: '执行者', en: 'Executors' },
  'chat.skillGroup': {
    zh: '或者按技能选（装着几条就有几条）',
    en: 'Or pick a skill (one entry per installed skill)',
  },
  'chat.skillOptionOwned': { zh: '{skill}（→ {agent}）', en: '{skill} (→ {agent})' },
  'chat.skillOptionSelf': { zh: '{skill}（没挂给谁）', en: '{skill} (attached to nobody)' },
  'chat.skillOwner': {
    zh: '将使用 {agent}——它挂着 {skill}。',
    en: 'Will use {agent} — it has {skill}.',
  },
  'chat.skillSelfCarried': {
    zh: '将使用 {agent} + {skill}——没有执行者挂它，这条技能跟着这个对话走。',
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
  // ★ 分批第 206 批：`chat.filesRefresh` 搬成了 `files.refresh`（聊天页与沉淀页同一颗按钮）。
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
  // ★ 分批第 227 批：`chat.filesNotAnAction`（「这一栏是……聊天仍然不触发任何登记过的
  //   动作」）删了——和它旁边那条风险披露一起从栏脚撤下来。理由写在那段模板注释里：
  //   常驻说明读三遍就是噪音，而"这不是动作"由界面上**根本没有动作**这一点自己说明。
  'chat.skillsNeedRestart': {
    zh: '{skills} 现在选不到：这个对话自带技能的功能要重启本机的 daemon 之后才有（现在跑着的那个还不认识它）。',
    en: '{skills} cannot be picked right now: per-conversation skills need a restart of the local daemon — the one running now does not know about them yet.',
  },

  // ★ 分批第 222 批：`chat.workDirLabel`（页头那行的「工作目录」标签）删了——路径搬到
  //   栏脚「工作目录的文件」的标题行右侧，那一栏的名字自己就说明了这是哪个目录。
  // 「新对话」界面上的设定（2026-10 起工作目录只在这里设；详情页只读）。
  'chat.draftWorkDirLabel': { zh: '工作目录（可选）', en: 'Working directory (optional)' },
  'chat.workDirAuto': { zh: '自动分配', en: 'Chosen automatically' },
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
  'chat.notRunYet': { zh: '还没跑过', en: 'Not run yet' },

  // ── 记忆（分批第 240 批）：聊天里的两个写入口 ──
  'chat.memoryChipLabel': { zh: '将记进它的记忆', en: 'Will be remembered' },
  'chat.memoryChipEdit': { zh: '改', en: 'Edit' },
  'chat.memoryChipSkip': { zh: '不记', en: 'Skip' },
  'chat.memoryChipEditTitle': { zh: '改成"下次也成立"的说法', en: 'Reword it so it stays true next time' },
  'chat.memorySaved': { zh: '已记进它的记忆', en: 'Remembered' },
  'chat.memoryUndo': { zh: '撤销', en: 'Undo' },
  'chat.memorySavedMany': { zh: '已记进它的记忆 {n} 条', en: '{n} entries remembered' },
  /**
   * ★ 分批第 264 批（使用者："『整理成记忆...』改成『整理记忆』"）：词条缩短。
   *   去掉"成"（它已经是记忆这一类的动作，不必再说一遍结果）与省略号
   *   （它在对话头那排工具条里，与「沉淀技能&智能体」并列，靠位置说明"这是个入口"）。
   */
  'chat.tidyAction': { zh: '整理记忆', en: 'Tidy memory' },
  /**
   * 按钮在「沉淀技能」左侧；两种"不能用"都用**置灰 + 说明**表达，不隐藏。
   * ⚠️ 这块位置翻过一次车（262 批按"关着就不该有"改成不渲染，使用者回头又问
   *    "为什么不见了"）——结论：**关着就置灰并说清去哪儿打开**，别再翻。
   */
  'chat.tidyDisabledHint': {
    zh: '这段对话还没有内容可整理——先说几句。',
    en: 'Nothing to tidy yet — say a few things first.',
  },
  'chat.tidyMemoryOffTitle': {
    zh: '这个智能体的记忆关着——去「智能体 → 它的配置」打开「启用记忆」，这颗按钮就能用。',
    en: "This agent's memory is off — enable it in the agent's settings and this button works.",
  },
  'chat.tidyTitle': { zh: '整理成记忆', en: 'Turn this chat into memory' },
  /**
   * ★ 分批第 243 批：整理从"把你的原话列出来"改成"分析整段对话"（使用者要求：
   *   「类似沉淀技能一样，分析整段对话，然后整理出要添加的记忆」）。所以文案也要
   *   跟着说清"它会读整段对话、挑出下次还用得上的判断，不会记这次做了什么"。
   */
  'chat.tidyHint': {
    zh: '它会读整段对话，挑出下次还用得上的判断（怎么对你、环境事实、踩过的坑、答应过的约定）——不是这次做了什么。挑完你可以改、可以否掉，确认才写进去。',
    en: 'It reads the whole conversation and picks out judgements worth keeping (how to treat you, environment facts, lessons, promises) — not what happened this time. You can reword or drop any of them; nothing is saved until you confirm.',
  },
  'chat.tidyExplain': {
    zh: '整理会给这个智能体起一轮分析（要花掉一次调用，几十秒到几分钟）。它会读整段对话，把值得长期记住的判断挑出来给你看。',
    en: 'Tidying starts one analysis run for this agent (it costs one call and takes from tens of seconds to a few minutes). It reads the whole conversation and shows you the judgements worth keeping.',
  },
  'chat.tidyStart': { zh: '开始分析', en: 'Start analysis' },
  'chat.tidyRunning': { zh: '正在分析这段对话…（{s} 秒）', en: 'Analysing this conversation… ({s}s)' },
  'chat.tidyRunningHint': {
    zh: '它要把整段对话读一遍，慢一点是正常的。可以关掉这个框——分析会在后台跑完，再打开还能看结果。',
    en: 'It has to read the whole conversation, so this can take a while. You can close this box — the analysis keeps running and the result is still here when you reopen it.',
  },
  'chat.tidyRetry': { zh: '再分析一次', en: 'Analyse again' },
  'chat.tidyNone': {
    zh: '它没挑出值得长期记住的东西。这段对话可能都是这次的具体事情——那本来就该留在记录里，不该进记忆。',
    en: 'It found nothing worth keeping long-term. This conversation may be all about the task at hand — that belongs in the record, not in memory.',
  },
  'chat.tidyUnparsed': {
    zh: '它没有按要求的格式输出（界面上拿不到候选）。可以再分析一次；如果一直这样，是那条 CLI 的产出格式问题。',
    en: "It did not answer in the required format, so there are no candidates to show. Try again; if it keeps happening, that CLI's output format is the problem.",
  },
  'chat.tidyDropped': {
    zh: '另有 {n} 条没列出来（类型不认识、太长、重复，或者看起来像密钥）。',
    en: '{n} more were left out (unknown kind, too long, duplicated, or looking like a secret).',
  },
  'chat.tidyNoConversation': {
    zh: '先打开一段对话再整理。',
    en: 'Open a conversation first.',
  },
  /**
   * ★ 分批第 244 批：**出处**（记忆的源头必须是人的话）。
   *
   * 使用者的例子：他只说了一句「分析 https://…，让我理解其做法和功能」，平台却整理出了
   * 记忆——那是它自己查到的。所以每条候选都要显示"它说这是你说的哪一句"，
   * 且由**平台核对**（对不上就默认不勾）。
   */
  'chat.tidyFrom': { zh: '出自你说过的话：「{quote}」', en: 'From what you said: "{quote}"' },
  /**
   * 列表里那**一行**出处（分批第 246 批）：只显示一行、超长省略、全文在 title 里。
   * 「对不上」这条要短——长句会被省略号吃掉，而"它不是你说的"这个结论必须一眼看见。
   */
  'chat.tidyFromUnverifiedShort': {
    zh: '对不上：{quote}',
    en: 'not found in your messages: {quote}',
  },
  'chat.tidyFromUnverified': {
    zh: '它说这句出自你的话，但对话里找不到：「{quote}」——默认不勾',
    en: 'It claims this came from you, but the conversation does not contain it: "{quote}" — unchecked by default',
  },
  /**
   * ★ 分批第 248 批：这条候选提到了**这次对话的对象**（调研的那个项目/工具）。
   *   使用者两次打回的都是这种（"调研对象不该成为教训本体"），所以标出来、默认不勾。
   */
  'chat.tidySubject': {
    zh: '提到这次的对象「{term}」——只对这次成立就默认不勾',
    en: 'Mentions this conversation’s subject "{term}" — unchecked unless it holds beyond this task',
  },
  'chat.tidySubjectHint': {
    zh: '把对象名删掉，这条还成立吗？不成立就说明它是这次的记录，不是经验。',
    en: 'Delete the subject from the sentence — does it still hold? If not, it is a record of this task, not a lesson.',
  },
  /**
   * ★ 分批第 250 批：这条候选**已经在它的记忆里**了（同一段对话整理两次时第二次全是这种）。
   *   默认不勾——重复条目白占 40 条的预算，而"删旧的再加新的"才是改一条的正路。
   */
  /**
   * ★ 分批第 251 批：这条是**某条已有记忆的新版**（整理时它读到了 existing-memory.md）。
   *   平台已核对旧条目确实存在；确认后先加新的、再删旧的（本平台唯一的改法）。
   */
  /**
   * ★ 分批第 252 批（使用者提的做法）：**按"人的原话"查重**。
   *
   * 同一句原话已经产出过条目 ⇒ 标出来、默认不勾。它比按正文查重可靠：中文改写之间的
   * 字符重合度太低（同义句 0.17–0.53），而"原话"是逐字抄自对话的，三次整理都一样。
   */
  'chat.tidySameSource': {
    zh: '这句原话已经记过 {n} 条（如「{first}」）——默认不勾',
    en: 'This sentence already produced {n} entry(ies), e.g. "{first}" — unchecked by default',
  },
  /**
   * ★ 分批第 260 批：两项新能力（都是从 Mem0 的 ADD/UPDATE/DELETE/NONE 那套动作里取的）。
   *   · `forget` = 它认为这条过时了/被推翻了 ⇒ 建议忘掉（**默认不勾**，删除是破坏性的）；
   *   · `replaces` 现在可以是**好几条**（合并同类）。
   */
  /**
   * ★ 分批第 260 批：「合并同类」模式（同一个对话框，读的是**它的全部记忆**而不是一段对话）。
   */
  'chat.consolidateTitle': { zh: '合并同类的记忆', en: 'Merge duplicate memories' },
  'chat.consolidateHint': {
    zh: '它会把在说同一件事的几条并成一条更完整的说法，把明显过时的标成"忘掉"。合并出来的那一条由你确认，旧的那几条才会删。',
    en: 'It merges entries that say the same thing into one fuller statement and marks clearly stale ones as "forget". Nothing changes until you confirm.',
  },
  'chat.consolidateExplain': {
    zh: '这会读它现有的全部记忆（要花一次调用）。没有可合并的就什么都不提——那也是正常结果。',
    en: 'This reads all of its current memory (one call). If nothing can be merged it proposes nothing — that is a normal result.',
  },
  'chat.consolidateStart': { zh: '开始合并', en: 'Start merging' },
  'chat.tidyForget': { zh: '忘掉：「{old}」', en: 'Forget: "{old}"' },
  'chat.tidyReplaces': {
    zh: '替换 {n} 条旧条目（如「{old}」）',
    en: 'Replaces {n} existing entries (e.g. "{old}")',
  },
  'chat.tidyReplacesHint': {
    zh: '确认之后平台会先记下这一条新的、再删掉旧的那条（删是打时间戳，可追溯）。',
    en: 'On confirm the platform adds this new entry, then removes the old one (removal is timestamped, so it stays traceable).',
  },
  'chat.tidyExists': { zh: '已经记过了（不重复添加）', en: 'Already remembered' },
  'chat.tidyExistsHint': {
    zh: '这条与它现有的某条记忆相同。要换说法就先在「智能体 → 记忆」里删掉旧的。',
    en: 'This matches an entry it already has. To reword it, delete the old one in the agent’s memory first.',
  },
  'chat.tidyNoFrom': {
    zh: '它没给出处——大概率是它自己查到的，不是你说的。默认不勾。',
    en: 'No source given — most likely something it looked up itself, not something you said. Unchecked by default.',
  },
  'chat.tidyCount': { zh: '选中 {n} 条', en: '{n} selected' },
  /**
   * ★ 分批第 248 批：给人同一把尺子（"换个对象还成立吗"）。
   *   使用者打回过一条只对这次调研对象成立的经验——那种条目会挤掉通用的。
   */
  'chat.tidyGeneralizeHint': {
    zh: '尺子：把这次的对象名删掉，这条还成立吗？只对这次成立的，是记录不是经验。',
    en: 'Test: delete this conversation’s subject from the sentence — does it still hold? If only for this one, it is a record, not a lesson.',
  },
  'chat.tidyConfirm': { zh: '记下选中的 {n} 条', en: 'Remember {n}' },

  /**
   * ── 聊天页自己的「设置」抽屉（分批第 242 批）──
   *
   * ★ 记忆触发词那几条原来在 `settings.memory*`（全局 App 设置抽屉里）。搬过来是因为
   *   使用者找的地方是**聊天页**：「聊天有个设置，里面有触发词的设置」。配置本身
   *   仍然是全局一份（所有对话共用），抽屉副标题把这件事写在脸上。
   */
  'chat.settingsAction': { zh: '设置', en: 'Settings' },
  'chat.settingsTitle': { zh: '聊天设置', en: 'Chat settings' },
  'chat.settingsSubtitle': {
    zh: '这些设定对所有对话都生效（不是只管当前这一段）。',
    en: 'These apply to every conversation, not just the one you have open.',
  },
  'chat.settingsMemoryHeading': { zh: '记忆触发词', en: 'Memory triggers' },
  'chat.settingsMemoryHint': {
    zh: '聊天里以这些词开头的句子，会被记进正在聊的那个智能体的记忆。只认开头，不做语义猜测；前缀本身不写进记忆。改完立刻生效。',
    en: 'A chat message starting with one of these words is remembered by the agent you are chatting with. Only the beginning is matched — no guessing — and the prefix itself is not stored. Changes take effect immediately.',
  },
  'chat.settingsMemoryAdd': { zh: '加', en: 'Add' },
  'chat.settingsMemoryAddPlaceholder': {
    zh: '加一个开头，例如「记得」',
    en: 'Add a trigger, e.g. "remember"',
  },
  'chat.settingsMemoryRemove': { zh: '删掉触发词「{word}」', en: 'Remove the trigger "{word}"' },
  'chat.settingsMemoryReset': { zh: '恢复默认', en: 'Restore defaults' },
  'chat.settingsMemoryOff': { zh: '（空：这个功能关着）', en: '(empty: this feature is off)' },
  'chat.placeholder': { zh: '说点什么…（Enter 发送，Shift+Enter 换行）', en: 'Say something… (Enter to send, Shift+Enter for a new line)' },
  'chat.send': { zh: '发送', en: 'Send' },
  // ★ 分批第 232 批：`chat.enterHint`（输入框下面那行"Enter 发送 · Shift+Enter 换行"）
  //   删了——使用者要求那一行不要（太占高度），而这句约定本来就在 `chat.placeholder` 里。
  'chat.sending': { zh: '发送中…', en: 'Sending…' },
  'chat.stop': { zh: '停止', en: 'Stop' },
  'chat.you': { zh: '你', en: 'You' },
  'chat.toolsUsed': { zh: '用了 {count} 个工具', en: '{count} tool call(s)' },
  'chat.running': { zh: '正在跑', en: 'Running' },
  // ★ 分批第 232 批：`chat.runningHint`（栏脚那行"正在跑：可以先写下来…"）也删了——
  //   使用者："也不需要下面的『正在跑』这样的信息"。这一轮的状态在消息流里那一行
  //   （带「停止」按钮）已经有了；而"能不能发"由发送按钮的禁用态与它的 title 说明。
  'chat.sendWhileRunning': {
    zh: '这一轮还在跑，跑完才能发（写好的字会留着）',
    en: 'This turn is still running; you can send once it finishes (what you typed is kept)',
  },
  /**
   * ══════════════ 语音口述（分批第 278 批）══════════════
   *
   * ★ 一切都围绕一句话：**按钮点了必须有反应**。所以每种状态都有词，包括"用不了"
   *   ——一个点了什么都不发生的麦克风按钮，是这次最想避免的那种失败。
   *
   * ⚠️ 这些词条由 `VoiceButton` 用，而它是**页面组件**（`apps/web`）。所以词表放在
   *   `chat.*` 下是"先服务聊天页"；等它接进任务页时，这些词条可以整体搬到 `voice.*`
   *   （那时才搬——现在搬只会让两个页面各有一半）。
   */
  'chat.voiceLabel': { zh: '语音输入', en: 'Voice input' },
  'chat.voiceStartTitle': {
    zh: '点一下开始口述（说完自动结束；再点一下是提前结束，Esc 是取消）',
    en: 'Click to start dictating (stops on silence; click again to stop early, Esc cancels)',
  },
  'chat.voiceStopTitle': { zh: '结束并转写（Esc 取消这一次）', en: 'Stop and transcribe (Esc cancels)' },
  'chat.voiceTranscribingTitle': { zh: '正在转写…', en: 'Transcribing…' },
  'chat.voiceRecordingShort': { zh: '{s}s', en: '{s}s' },
  'chat.voiceTranscribingShort': { zh: '转写…', en: 'Transcribing…' },
  /** daemon 太旧、没有 `/api/voice/*`（界面据此**不画**按钮；这条只在悬停/诊断时用）。 */
  'chat.voiceUnsupported': {
    zh: '这个 daemon 还不支持语音，重启 daemon 之后就有了',
    en: 'This daemon does not support voice yet — restart it',
  },
  'chat.voiceStartFailed': { zh: '开不了录音（原因没给出来）', en: 'Could not start recording' },
  'chat.voiceStartFailedDetail': { zh: '开不了录音：{error}', en: 'Could not start recording: {error}' },
  'chat.voiceLost': {
    zh: '和 daemon 的连接断了，这一段录音没能取回来',
    en: 'Lost the daemon connection, so this recording could not be retrieved',
  },
  'chat.voiceFailedNoReason': { zh: '转写失败（没给原因）', en: 'Transcription failed (no reason given)' },
  /**
   * ★ 分批第 279 批：聊天页设置抽屉里的「语音输入」一节。
   *   模型 / 语言 / 灵敏度 / 降噪 / 试录自检——每一档都要有词，否则下拉里是空白。
   */
  'chat.voiceSettingsHeading': { zh: '语音输入', en: 'Voice input' },
  'chat.voiceSettingsHint': {
    zh: '说完自动结束（也可以再点一下提前结束）。识别结果只放进输入框，发不发由你决定。',
    en: 'Stops on silence (or click again to stop early). The text only goes into the input box; sending is up to you.',
  },
  'chat.voiceSettingsChecking': { zh: '正在检查…', en: 'Checking…' },
  'chat.voiceSettingsReady': { zh: '可以用（麦克风与模型都就绪）', en: 'Ready (microphone and model are in place)' },
  'chat.voiceSettingsModel': { zh: '模型', en: 'Model' },
  'chat.voiceSettingsLanguage': { zh: '语言', en: 'Language' },
  /**
   * ★ 分批第 292 批（用 small-q5_1 实测后改的口径）：
   *   · 中英混说：`zh` 与 `auto` **结果一样**（英文术语都保留），原来那句
   *     "中英混说容易判错"是不准的；
   *   · 真正的坑是**整段说英文**：`zh` 会把整段**翻译成中文**（实测："Let us ship the
   *     AgentDeck VAD fix today" → "当我们发行的 AgentDeck…评论给你"），而 `auto` 会判成英文。
   *   ⇒ 说明改成"说整段英文时用它"，这才是它存在的理由。
   */
  'chat.voiceLanguageZh': { zh: '中文（中英混说够用；整段英文会被翻成中文）', en: 'Chinese (fine for mixed speech; English-only gets translated)' },
  'chat.voiceLanguageEn': { zh: '英文（中文会被翻成英文，别选错）', en: 'English (Chinese gets translated — pick deliberately)' },
  'chat.voiceLanguageAuto': {
    zh: '自动判断（整段说英文时用它；短句可能判成英文）',
    en: 'Auto-detect (use for English-only speech; short clips may be judged as English)',
  },
  'chat.voiceSettingsSensitivity': { zh: '灵敏度', en: 'Sensitivity' },
  'chat.voiceSensitivityStable': { zh: '稳（不容易被打断，收尾慢一点）', en: 'Steady (harder to cut off, stops a bit later)' },
  'chat.voiceSensitivityNormal': { zh: '中（默认）', en: 'Normal (default)' },
  'chat.voiceSensitivityQuick': { zh: '快（收尾干脆，句中的停顿可能被当句尾）', en: 'Quick (stops sooner; mid-sentence pauses may end it)' },
  /**
   * ★ 分批第 286 批：用**当前对话里的标识符**辅助识别（默认开）。
   *   说清"它只往 prompt 里补词、不改写任何文本"，否则容易被当成又一个改写层。
   */
  'chat.voiceSettingsContext': { zh: '用对话里的词', en: 'Use terms from the chat' },
  'chat.voiceSettingsContextHint': {
    zh: '从当前对话里挑出像标识符的词（AgentDeck、whisper.cpp、wiki-capture…）塞进识别提示，让它更容易听对。只补词、不改写文本；手动词表优先。',
    en: 'Picks identifier-looking words from the current chat (AgentDeck, whisper.cpp, …) into the recognition prompt so they are heard correctly. It only adds hints — it never rewrites your text, and your own term list comes first.',
  },
  /** 识别完成的一句回执（286 批；只在真的用上了对话词/纠正过词时才出现）。 */
  'chat.voiceDoneSummary': {
    zh: '识别完成：用了 {ctx} 个对话里的词，纠正 {fixed} 处',
    en: 'Done: {ctx} term(s) from the chat, {fixed} fix(es) applied',
  },
  'chat.voiceSettingsDenoise': { zh: '降噪', en: 'Noise reduction' },
  'chat.voiceSettingsDenoiseHint': {
    zh: '默认关：它会让轻声变小甚至消失。房间安静就别开。',
    en: 'Off by default: it can swallow soft speech. Leave it off in a quiet room.',
  },
  'chat.voiceSettingsDownload': { zh: '下载模型（约 {mb} MiB）', en: 'Download model (~{mb} MiB)' },
  'chat.voiceSettingsDownloading': { zh: '正在下载…', en: 'Downloading…' },
  'chat.voiceSettingsDownloadPercent': { zh: '正在下载… {pct}%', en: 'Downloading… {pct}%' },
  /** ★ 283 批：直连官方不通时 daemon 会自动换镜像——用的是哪条要说出来。 */
  'chat.voiceSettingsDownloadedFrom': {
    zh: '下好了（{mb} MiB，来自 {host}）——之后全程离线',
    en: 'Downloaded ({mb} MiB, from {host}) — offline from now on',
  },
  'chat.voiceSettingsDownloaded': { zh: '下好了（{mb} MiB），之后全程离线', en: 'Downloaded ({mb} MiB) — offline from now on' },
  'chat.voiceSettingsSelfTest': { zh: '试录 3 秒', en: 'Test record 3s' },
  'chat.voiceSettingsSelfTestRecording': { zh: '录 3 秒…', en: 'Recording 3s…' },
  'chat.voiceSettingsSelfTestHeard': { zh: '听到：「{text}」', en: 'Heard: "{text}"' },
  'chat.voiceSettingsSelfTestFailed': { zh: '试录失败', en: 'Test recording failed' },
  'chat.voiceSettingsSelfTestTimeout': {
    zh: '试录超时：转写 30 秒还没回来（模型是不是太大/CPU 太忙？）',
    en: 'Test recording timed out: no result after 30s (model too large, or the CPU is busy?)',
  },
  /**
   * ★ 分批第 280 批：**词典那一节**（两层矫正的可编辑面）+ 从手改里提规则的 chip。
   *   两张表是一句话的两半：上面那行说"这是干什么的"，下面那些说"分两层"。
   */
  'chat.voiceVocabHeading': { zh: '专有名词', en: 'Proper nouns' },
  'chat.voiceVocabHint': {
    zh: '两层：词表让模型更容易听对；替换规则把它已经固定下来的错形态改回来（改了几处会在识别后提示）。',
    en: 'Two layers: the term list helps the model hear it correctly; rules rewrite the errors it still makes (you will see how many were fixed).',
  },
  'chat.voiceVocabPromptLabel': { zh: '词表（正确写法）', en: 'Term list (correct spelling)' },
  'chat.voiceVocabRuleLabel': { zh: '替换规则（听错的样子 → 正确写法）', en: 'Rewrite rules (misheard → correct)' },
  /**
   * ★ 289 批（使用者："预览改一个位置，可以放在录制按钮的下面，名字可能要改一下，
   *   不应该还叫预览。它就可以预览当前对话的取词"）：
   *   **不再叫"预览"**——它不是"预览某件将要发生的事"，而是"这一句识别会带上哪些词"。
   *   位置也搬到麦克风按钮**下面**，名字就叫**取词**。
   */
  'chat.voiceTermsLabel': { zh: '取词', en: 'terms' },
  'chat.voiceTermsLabelN': { zh: '取词 {n}', en: 'terms {n}' },
  'chat.voiceTermsTitle': {
    zh: '这一句识别会带上的专有名词（从当前对话抽出来的标识符）——点一下看是哪些',
    en: 'Proper nouns this dictation will hint at (identifiers picked from this chat) — click to see them',
  },
  'chat.voiceTermsBusy': { zh: '正在取…', en: 'Collecting…' },
  'chat.voiceTermsOff': { zh: '「用对话里的词」是关着的，所以不带。', en: '"Use terms from the chat" is off.' },
  'chat.voiceTermsNone': {
    zh: '这个对话里没有可用的标识符（只取 AgentDeck、whisper.cpp 这类词；普通中文与常见英文词不收）。',
    en: 'No usable identifiers here (only things like AgentDeck / whisper.cpp; plain Chinese and common English words are skipped).',
  },
  'chat.voiceTermsSource': {
    zh: '素材：{u} 条你说的话 + {a} 段它的回复',
    en: 'Sources: {u} message(s) from you + {a} repl(y/ies) from it',
  },
  'chat.voiceTermsNoConv': { zh: '（先打开一个对话才有取词）', en: '(open a chat to get terms)' },
  /** 取词失败也要说出来（否则浮层一直"正在取…"，和"点了没反应"一样糟）。 */
  'chat.voiceTermsFailed': { zh: '取词失败（HTTP {code}）', en: 'Could not collect terms (HTTP {code})' },
  'chat.voiceTermsFailedDetail': { zh: '取词失败：{error}', en: 'Could not collect terms: {error}' },
  'chat.voiceVocabEmpty': { zh: '还没加', en: 'Nothing yet' },
  'chat.voiceVocabTermPlaceholder': { zh: '例如：AgentDeck', en: 'e.g. AgentDeck' },
  'chat.voiceVocabFromPlaceholder': { zh: '听成的样子，如 微思普', en: 'As heard, e.g. "agent deck"' },
  'chat.voiceVocabToPlaceholder': { zh: '正确写法，如 Whisper', en: 'Correct, e.g. "AgentDeck"' },
  // 从"人手动改过的那一处"提规则（`lib/dictation.ts`）
  /**
   * ★ 分批第 281 批：`via-skill` 输出方式（3 秒倒计时 + 撤销）。
   *   数字在文案里是写死的 3——改 `AUTO_SEND_SECONDS` 要一起改（两处都有注释）。
   */
  'chat.voiceSettingsOutput': { zh: '识别完', en: 'After transcription' },
  'chat.voiceSettingsOutputHint': {
    zh: '「先发一条消息」= 替你按回车（消息会交给那个对话里的 skill 处理，比如 wiki-capture）；发送前有 3 秒可撤销。',
    en: '"Send a message" = presses Enter for you (the message goes to whatever skill that chat uses, e.g. wiki-capture); you get 3 seconds to cancel.',
  },
  'chat.voiceOutputInput': { zh: '只放进输入框（默认）', en: 'Just fill the input box (default)' },
  'chat.voiceOutputViaSkill': { zh: '先发一条消息', en: 'Send it as a message' },
  'chat.voiceAutoSendLabel': { zh: '{s} 秒后发送：', en: 'Sending in {s}s:' },
  'chat.voiceAutoSendUndo': { zh: '撤销', en: 'Cancel' },
  'chat.voiceAutoSendCancelled': { zh: '已取消自动发送，字还在输入框里', en: 'Auto-send cancelled — the text is still in the box' },
  'chat.voiceAutoSendBlocked': {
    zh: '这一轮还在跑，所以没自动发：字留在输入框里了',
    en: 'A turn is still running, so nothing was sent — the text is in the box',
  },
  'chat.voiceRuleLabel': { zh: '这是你改的：', en: 'You changed this:' },
  'chat.voiceRuleSave': { zh: '记进词典', en: 'Add to dictionary' },
  'chat.voiceRuleSkip': { zh: '不用', en: 'Not now' },
  'chat.voiceRuleSaved': { zh: '已记进词典：「{from}」→「{to}」', en: 'Saved: "{from}" → "{to}"' },
  'chat.voiceRuleFailed': { zh: '没记上：{error}', en: 'Could not save: {error}' },
  'chat.noOutput': { zh: '这一轮没有文字产出。', en: 'This turn produced no text.' },
  'chat.turnFailed': { zh: '这一轮没跑起来', en: "This turn didn't start" },
  'chat.duration': { zh: '用时 {seconds} 秒', en: '{seconds}s' },

  'chat.rename': { zh: '改名', en: 'Rename' },
  'chat.renameSave': { zh: '保存', en: 'Save' },
  'chat.renamed': { zh: '已改名', en: 'Renamed' },
  // 2026-11：改名入口从「改名」按钮改成**点标题**（长标题下按钮会被挤到第二行）。
  // 这条是标题悬浮提示——"能点"的暗示。
  'chat.renameHint': { zh: '点击改名', en: 'Click to rename' },
  // 300 批：确认框的"确定"按钮与它那一行动作按钮**同名**（`chat.delete` = 删除对话，
  //   组 / 任务那边也是这么写的）。原来是「确认删除」——同一个位置三种措辞，
  //   一页一页看过去才会发现不一致。
  'chat.deleteConfirmYes': { zh: '删除对话', en: 'Delete' },
  'chat.deleted': { zh: '对话已删除', en: 'Conversation deleted' },
  // ⚠️ 这四条是**误删后从构建产物里恢复的**（2026-10）：我用正则批量删 bridge 词条时，
  //    非贪婪匹配吃到了这几条。教训写在 D57 里：删词条要**按模块解析**，不要用正则扫文本。
  'chat.renameCancel': { zh: '取消', en: 'Cancel' },
  'chat.delete': { zh: '删除对话', en: 'Delete conversation' },
  // D80：沉淀成 skill 按钮在对话没有任何已结束轮次时的提示（按钮置灰）
  'chat.crystallizeDisabledHint': {
    zh: '至少有一轮对话已结束，才能提炼',
    en: 'Finish at least one turn before crystallizing',
  },
  'chat.deleteConfirm': {
    zh: '这个对话和它的全部轮次会被删掉。执行记录会留着（审计与成本统计还认得它）。',
    en: 'This conversation and all its turns will be deleted. The run records stay (audit and cost still know about them).',
  },
  /**
   * ★ 分批第 203 批：上传文件到这段对话的工作目录（`uploads/`）。与沉淀页同一个控件
   * （`ChatComposer` 的 📎 / `FootFiles` 的拖拽），落点不同。
   */
  'chat.uploadDone': { zh: '上传了 {n} 个文件到 uploads/', en: 'Uploaded {n} file(s) to uploads/' },
  'chat.uploadFailed': { zh: '上传失败：{error}', en: 'Upload failed: {error}' },
  'chat.sendNotReady': {
    zh: '先输入内容；这一轮跑完之前不能再发',
    en: 'Type something first; you cannot send again until this turn finishes',
  },

  /**
   * ⚠️ 这里原有 `chat.noActionsHint`（"这里不动手：聊天不产出判决，而动作的门槛
   *    就是判决。"），2026-09 按要求删掉了：它常驻左栏底部，每一屏都在说同一件事。
   *
   *    边界**本身没有变**（聊天里跑的东西不产判决，因此不触发动作）。2026-10 又
   *    按要求去掉了「派发任务」那两个按钮（`chat.bridgeAll` / `chat.bridgeTurn`），
   *    所以现在这一页**既不产出判决，也不往「新建任务」送东西**——边界只剩"这里是闲聊"。
   */
  'chat.summary': { zh: '{turns} 轮 · 最近 {when}', en: '{turns} turn(s) · last {when}' },
  // ⚠️ 相对时间那四条（刚刚/分钟前/小时前/天前）已提升到 `common.*`：
  //    它不只是聊天的东西——任务/技能/工具列表都要用（见 `lib/time.ts`）。

  /**
   * ★ 2026-11 设计定稿（§3.6）：智能体生成者的「确认生成智能体」按钮与内联审阅面板。
   * 按钮按条件出现（agent-draft/ 目录有 agent-draft.md 才出现），不搞置灰——没有素材时置灰
   * 按钮是一种半开的门（设计稿 §9.7）。
   */
  'chat.agentMakerAction': { zh: '确认生成智能体', en: 'Confirm agent' },
  'chat.agentMakerPanelTitle': { zh: '确认生成智能体 · 岗位卡 + 配套技能', en: 'Confirm the agent · job card + skills' },
  'chat.agentMakerDraftNote': {
    zh: '岗位卡已由智能体生成者起草（规则由它描述，你确认过）——改一改，然后确认生成。',
    en: 'The job card was drafted by the agent maker (it described the rules, you confirmed them) — tweak, then confirm.',
  },
  'chat.agentMakerNameLabel': { zh: '岗位名', en: 'Name' },
  'chat.agentMakerRoleLabel': { zh: '角色', en: 'Role' },
  'chat.agentMakerInstructionsLabel': {
    zh: '指令（一段）· 边界 / 输出格式都在这一段里',
    en: 'Instructions (one block) · boundary and output format live in here',
  },
  'chat.agentMakerBoundaryHint': {
    zh: '草稿不是合同——检查「边界」段（生成者按最小权限缺省描述，你确认过）。',
    en: 'The draft is not a contract — check the "boundary" section (the maker described it with minimal-permission defaults, which you confirmed).',
  },
  'chat.agentMakerSkillsLabel': { zh: '配套技能（AI 起草 · 随智能体一起确认）', en: 'Accompanying skills (AI-drafted, confirmed together)' },
  'chat.agentMakerSkillsWarn': {
    zh: '技能草稿未经验证——建议先让智能体干几轮，再用沉淀结晶正式版（提示，不是校验）。',
    en: 'Skill drafts are unverified — run the agent a few times first, then crystallize the official version (a hint, not a gate).',
  },
  'chat.agentMakerSkillBodyPlaceholder': {
    zh: 'SKILL.md 正文（When to Use / Procedure）',
    en: 'SKILL.md body (When to Use / Procedure)',
  },
  'chat.agentMakerRemoveSkill': { zh: '去掉这条', en: 'Drop this one' },
  'chat.agentMakerConfirm': { zh: '确认生成', en: 'Confirm & create' },
  'chat.agentMakerConfirmHint': {
    zh: '配套技能作为新智能体的内置技能（不进共享技能池）· 人确认是唯一入口',
    en: 'Companion skills become the new agent\'s built-in skills (not in the shared pool) · a human confirm is the only way in',
  },
  'chat.agentMakerDone': {
    zh: '已创建智能体「{name}」+ {n} 条配套技能作为它的内置技能',
    en: 'Created agent "{name}" with {n} companion skill(s) as its built-in skills',
  },
  'chat.agentMakerFail': { zh: '生成失败：{error}', en: 'Creation failed: {error}' },
  'chat.agentMakerLoading': { zh: '正在读岗位卡…', en: 'Loading the job card…' },
} as const satisfies TextCatalog
