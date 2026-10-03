import type { TextCatalog } from '../text.ts'

/**
 * 工具（D40）：`apps/web/src/views/Tools.svelte`（列表 + 安装抽屉）、
 * `apps/web/src/lib/tool-install.ts`（安装结果的说明、错误码的下一步建议）、
 * `apps/web/src/components/AgentDetail.svelte`（「行动权限」那一段）与
 * `apps/web/src/components/ActionPicker.svelte`（可勾的工具动作）。
 *
 * ⚠️ 导航那两条（`tools.navTitle` / `tools.navHint`）**按说该在 `shell.ts`**里
 *    （"一个区域一份"的分法就是照代码结构来的）。放这里是因为这一轮 D40 的交界
 *    只允许改 `tools.ts`：并行工作流里 `shell.ts` 在别人手上，为一个侧边栏条目
 *    去动那张表会把两条线搅在一起。等 D40 收口时按"同一句话只有一个出处"归位。
 *
 * ⚠️ **契约值不翻译**：`slug`、`<slug>.<动作名>`（`example-note.append-note`）、
 *    `dryRun: 'unsupported'`、`from: 'workdir'` 这些是机器值，界面上原样显示，
 *    这里只给它们**旁边**的标签。所以下面那些带 `{from}` / `{value}` 的词条
 *    只是"把契约值摆进一句话里"，不是把契约值本身译成中文。
 *
 * ⚠️ zh 是默认语言，也是探针断言的依据：改这些字之前先看 `tools/layout-probe/`
 *    里那一节在断言什么。
 */
export const toolsText = {
  // ── 侧边栏第五项（D40）──────────────────────────────────────────
  // ★ 使用者的决定：原来"恰好四项"（新建任务 / 任务清单 / 智能体 / Skills），
  //   D40 起改成五项，「工具」排在 Skills 之后。
  'tools.navTitle': { zh: '工具', en: 'Tools' },
  'tools.navHint': { zh: '一组动作 · 装一次整组可用', en: 'Action groups · install once' },

  // ── 页头 ──
  /**
   * ⚠️ 这里**原有一个 `tools.title`**，2026-09 改版时删了：页名由顶栏显示，而顶栏
   *    与侧栏共用同一个词条（`tools.navTitle`，见 `apps/web/src/lib/view.ts` 的
   *    `VIEW_TITLE_KEYS`）。主区里那行重复的 `<h2>工具</h2>` 同一次删掉。
   */
  'tools.headIntro': { zh: '工具是', en: 'A tool is ' },
  'tools.headStrongGroup': { zh: '一组动作', en: 'a group of actions' },
  // ★ D42：同一个包有两种身份，措辞必须把两个行为面分开——
  //   · 执行者那一侧（工具挂载）：**干活时**把包的脚本与说明送进它的工作目录；
  //   · 审核者那一侧（行动权限）：**判完之后**让平台触发包里的动作。
  //   合在一起说"挂给智能体 = 把动作交给它"会让人把两件事混成一个。
  // ⚠️ 原文说「它有两种用法——给执行者干活时用（挂载后把包的脚本与说明送进它的
  //    工作目录），或给审核者判完之后触发组里的动作」。第一种用法已经不存在了：
  //    挂载这个能力整个撤掉了（使用者的决定），界面上没有任何入口能把工具包挂给
  //    执行者。留着那半句就是在页头许诺一件做不到的事。
  'tools.headOutro': {
    zh: '：一次安装装进整组。装进来之后，组里的动作才能在审核者的「行动权限」里勾选——判决说「通过」时由平台触发。',
    en: ': one install brings in the whole group. Once installed, the group’s actions can be ticked under a reviewer’s action permissions — the platform triggers them when a verdict says "pass".',
  },


  // ── 列表 ──
  'tools.colGroup': { zh: '组名', en: 'Group' },
  'tools.colName': { zh: '名称', en: 'Name' },
  'tools.colVersion': { zh: '版本', en: 'Version' },
  'tools.colActionCount': { zh: '动作数', en: 'Actions' },
  'tools.colSource': { zh: '来源', en: 'Source' },
  // ★ 与技能页同列（`skills.colUpdatedAt` 同一个中文）：两页列表按同一套格式摆
  'tools.colUpdatedAt': { zh: '更新于', en: 'Updated' },
  // 最后一列只有按钮、没有可见表头，这个名字是给它 `aria-label` 用的
  'tools.colRowActions': { zh: '操作', en: 'Row actions' },
  'tools.sourceLocal': { zh: '本机', en: 'Local' },
  'tools.sourceRemote': { zh: '远端', en: 'Remote' },
  'tools.actionCount': { zh: '{count} 个动作', en: '{count} action(s)' },
  'tools.viewActions': { zh: '看动作', en: 'View actions' },
  'tools.hideActions': { zh: '收起动作', en: 'Hide actions' },
  'tools.uninstallTitle': { zh: '卸载这个工具包', en: 'Uninstall this tool package' },

  'tools.emptyTitle': { zh: '还没有装任何工具', en: 'No tools installed yet' },
  'tools.emptyHint': {
    // ⚠️ 这里原来说"也才能被**审核标准**勾选"：那说的是动作权限还长在审核标准
    //    那一栏里的年代（D40 收口把它搬成了审核者自己的「行动权限」段，D41 又把
    //    内置动作整组移除）。现在动作只有这一个来源，所以句子说的是**行动权限**
    //    ——界面上的那一栏就叫这个名字。
    zh: '工具是一个包、一组动作：装进来之后，组内动作才能被判决触发、也才能在审核者的「行动权限」里勾选。首版从本地目录安装（目录里要有 tool.json）。',
    en: 'A tool is one package holding a group of actions: only once it is installed can those actions be triggered by a verdict and ticked under a reviewer’s action permissions. For now they are installed from a local directory (which must contain tool.json).',
  },
  'tools.emptyExampleBefore': { zh: '示例包在 ', en: 'There is an example package at ' },
  'tools.emptyExampleAfter': { zh: '，可以先拿它试一次。', en: ' — you can try it first.' },

  // ── 展开：组内动作 ──
  'tools.actionsHeading': { zh: '组内动作', en: 'Actions in this group' },
  'tools.actionIrreversible': { zh: '不可回滚', en: 'Not reversible' },
  // ── 安装：两个来源页签（D40）──────────────────────────────────────
  'tools.actionInstall': { zh: '安装', en: 'Install' },
  /** 安装按钮置灰时的 `title`：说清「为什么现在不能点」。 */
  'tools.installingBusy': { zh: '正在装另一个工具包，装完再点这个', en: 'Another tool is installing — this one after it finishes' },
  'tools.tabPath': { zh: '从本机目录安装', en: 'Install from a local directory' },
  'tools.tabRemote': { zh: '从远端目录安装', en: 'Install from the remote catalog' },
  'tools.remoteReading': { zh: '正在读远端目录…', en: 'Reading the remote catalog…' },
  'tools.remoteEmpty': {
    zh: '远端目录里现在没有任何工具包。',
    en: 'The remote catalog currently has no tool packages.',
  },
  'tools.remoteUnavailableTitle': { zh: '远端不可用', en: 'Remote unavailable' },
  'tools.remoteUnavailable': { zh: '取不到远端目录：{error}', en: 'Could not load the remote catalog: {error}' },
  'tools.remoteHint': {
    zh: '包里带的是清单与脚本原文，装的时候原样交给本机 daemon 再校验一遍——远端说的和装进来的必须是同一份。',
    en: 'The entry carries the manifest and scripts verbatim; the local daemon validates them again on install — what the remote lists and what gets installed must be the same thing.',
  },
  'tools.errNoRemoteEntry': { zh: '远端目录里没有 {slug}', en: 'No {slug} in the remote catalog' },
  'tools.installed': { zh: '已安装工具包 {slug}', en: 'Installed tool package {slug}' },
  // 更新是**同名替换**，说清是替换到了哪一版：只说"已安装"的话，
  // 使用者分不清这次点击是装了新的还是又装了一遍旧的。
  'tools.updated': {
    zh: '已把 {slug} 更新到 {version}',
    en: 'Updated {slug} to {version}',
  },
  'tools.colActions': { zh: '组内动作', en: 'Actions in the group' },
  'tools.colPackage': { zh: '包名（组）', en: 'Package (group)' },
  'tools.actionTimeout': { zh: '超时 {ms} ms', en: 'Timeout {ms} ms' },
  'tools.paramsBoundHeading': { zh: '平台绑定', en: 'Bound by the platform' },
  'tools.paramsBoundNote': {
    zh: '模型看不到也填不了——这些值由平台按事实填。',
    en: 'The model can neither see nor fill these — the platform fills them from facts.',
  },
  'tools.paramsOpenHeading': { zh: '模型可填', en: 'The model may fill' },
  'tools.paramsOpenNote': {
    zh: '每一项都有上限，模型只能在这个范围内填。',
    en: 'Each one is bounded; the model can only fill within that range.',
  },
  'tools.paramsNone': { zh: '无', en: 'None' },
  'tools.paramBoundFrom': { zh: '来自 {from}', en: 'from {from}' },
  'tools.paramBoundLiteral': { zh: '固定值 {value}', en: 'literal {value}' },
  'tools.paramTypeString': { zh: '字符串，最长 {max}', en: 'string, up to {max}' },
  'tools.paramTypeInteger': { zh: '整数 {min} – {max}', en: 'integer {min} – {max}' },
  'tools.paramTypeBoolean': { zh: '是 / 否', en: 'true / false' },
  'tools.paramTypeEnum': { zh: '枚举', en: 'enum' },
  'tools.paramOptional': { zh: '可选', en: 'Optional' },
  // ── 固定参数（D43）──
  'tools.paramFixedHeading': { zh: '固定参数', en: 'Fixed parameters' },
  'tools.paramFixedUnset': { zh: '不固定（模型填）', en: 'Unset (model fills)' },
  'tools.paramFixedHint': {
    zh: '设了固定值的参数：执行时由平台注入，模型不许写（写了会被判不合规）。留空 = 模型在判决时填。',
    en: 'Fixed values are injected by the platform; the model may not write them (writing one invalidates the verdict). Leave empty = the model fills it at verdict time.',
  },
  'tools.paramFixedNone': {
    zh: '这个动作没有开放参数，没有可固定的东西（绑定参数由平台按事实注入）。',
    en: 'This action has no open parameters to fix (bound parameters are injected by the platform).',
  },
  'tools.paramFixedCollapse': { zh: '参数固定', en: 'Fix parameters' },
  'tools.paramFixedChip': { zh: '已固定', en: 'fixed' },
  // ★ D43（界面反馈）：字符串/整数参数的"固定"必须是一个**显式开关**，不能只靠
  //   输入框 placeholder 暗示——否则使用者看到的就只有"不固定（模型填）"。
  'tools.paramFixedYes': { zh: '固定', en: 'Fixed' },
  'tools.paramFixedValuePlaceholder': {
    zh: '填固定值（执行时注入）',
    en: 'Type the fixed value (injected at execution)',
  },
  // ★ D43（界面反馈第二轮）：选了「固定」但还没填值，必须明说——不然使用者以为
  //   钉上了，其实那个键还没进参数，保存了也等于没设。
  'tools.paramFixedPending': {
    zh: '已选「固定」，但还没填值——在输入框里填了才生效（留空 = 不保存）。',
    en: 'Fixed is selected but no value yet — type one in the box to take effect (leave empty = not saved).',
  },

  // ── 行动配置的「左选右配」（D44）──
  'tools.pickerSearch': { zh: '搜索动作 / 工具…', en: 'Search actions / tools…' },
  'tools.pickerFilterAll': { zh: '全部', en: 'All' },
  'tools.pickerFilterAllowed': { zh: '已允许', en: 'Allowed' },
  'tools.pickerFilterFixed': { zh: '有固定参数', en: 'Fixed params' },
  'tools.pickerFilterDead': { zh: '不可用', en: 'Unresolved' },
  'tools.pickerCount': {
    zh: '已允许 {allowed}/{total} · 已固定 {fixed} 个参数',
    en: 'Allowed {allowed}/{total} · {fixed} with fixed params',
  },
  'tools.pickerGroupCount': {
    zh: '{allowed}/{total} 允许',
    en: '{allowed}/{total} allowed',
  },
  'tools.pickerExpandAll': { zh: '全部展开', en: 'Expand all' },
  'tools.pickerCollapseAll': { zh: '全部折叠', en: 'Collapse all' },
  'tools.pickerBadgeFixed': { zh: '已固定 {n}', en: '{n} fixed' },
  'tools.pickerSelectHint': {
    zh: '← 从左侧选一个动作，在这里配置「是否允许」与「固定参数」',
    en: '← Select an action on the left to configure its allowance and fixed params',
  },
  'tools.pickerNoMatch': { zh: '没有匹配的动作', en: 'No matching actions' },
  'tools.pickerAllowAgent': {
    zh: '允许这个审核者触发此动作',
    en: 'Allow this reviewer to trigger this action',
  },
  'tools.pickerAllowTask': {
    zh: '允许这一次任务触发此动作',
    en: 'Allow this action for this task',
  },
  'tools.pickerOn': { zh: '已允许', en: 'Allowed' },
  'tools.pickerOff': { zh: '未允许', en: 'Not allowed' },
  'tools.pickerOpenHeading': {
    zh: '开放参数 —— 固定值由平台在执行时注入，模型不许写；留空 = 模型在判决时填',
    en: 'Open params — fixed values are injected by the platform; leave empty = the model fills at verdict time',
  },
  'tools.pickerBoundHeading': {
    zh: '绑定参数（平台注入 · 只读）',
    en: 'Bound params (platform-injected · read-only)',
  },
  'tools.pickerNoBound': { zh: '没有绑定参数。', en: 'No bound params.' },
  'tools.pickerLocked': {
    zh: '这个动作还没被允许——打开开关后才能配固定参数。',
    en: 'This action is not allowed yet — turn on the switch to configure fixed params.',
  },
  'tools.pickerFootAgent': {
    zh: '这里的改动是草稿：点这一页的「保存」后生效，平台执行时按这份注入。',
    en: 'These edits are a draft: they take effect after you click Save on this page, and the platform injects them at execution.',
  },
  'tools.pickerFootTask': {
    zh: '这里的改动会在点「创建并派发」后生效，审核者的长期配置不会被改动。',
    en: 'These edits take effect after you create the run; the reviewer’s long-term config is untouched.',
  },

  // ── 安装抽屉 ──
  'tools.install': { zh: '安装工具', en: 'Install tool' },
  'tools.pathLabel': { zh: '本地目录的绝对路径', en: 'Absolute path of a local directory' },
  'tools.sourcePlaceholder': { zh: '/Users/me/dev/my-tool', en: '/Users/me/dev/my-tool' },
  'tools.pathHintBefore': { zh: '指向的目录里必须有 ', en: 'The target directory must contain ' },
  'tools.pathHintAfter': {
    zh: '（平台判断「是不是适配本平台的工具」就看它：一个组、组内若干动作）。缺了它、或清单里有非法字段，会被整份拒绝并说清是哪一条；二进制文件会被明确跳过并列出。',
    en: ' (that is how the platform decides whether a package is a tool it can run: one group, several actions in it). If it is missing, or the manifest has an invalid field, the whole package is refused with the offending entry named; binary files are explicitly skipped and listed.',
  },
  'tools.slugLabel': { zh: '标识（留空则用清单里的标识）', en: 'ID (empty = the one in the manifest)' },
  // ★ 这个勾选框不是可选项，是**必要的逃生口**：想改包里那个脚本再装一遍，
  //   如果没有这条出路就只能卸载再装，而卸载会被"还有别的地方指着它"挡住。
  //   ⚠️ 原来这条注释与下面那句提示说的是"挂载会被挡住 / 挂载关系会保留"——
  //   挂载能力已经整个撤掉（D41），那套说法现在是一句**过期的话**：使用者读到
  //   "挂载它的智能体会继续挂着"只会去找一个不存在的挂载入口。替换复用同一条
  //   记录，如今真正被保住的是**判决与审计里写过的 `<包 slug>.<动作名>`**。
  //   （服务端要求显式传 overwrite: true；界面不提供这个开关，同名冲突在浏览器里
  //   就是一条死路，而使用者看到的是一句"请显式传 overwrite: true"。）
  'tools.overwriteLabel': {
    zh: '允许替换同名的工具（会覆盖已有那个的内容）',
    en: 'Allow replacing a tool with the same name (this overwrites the existing one)',
  },
  'tools.overwriteHint': {
    zh: '默认不勾：同名一律拒绝写入，避免「装的时候顺手覆盖了你自己的东西」。替换会复用同一条记录，所以已经授权过这些动作的审核者不受影响。',
    en: 'Off by default: a duplicate name is always refused, so installing cannot quietly overwrite your own work. A replacement reuses the same record, so reviewers already allowed these actions keep working.',
  },
  'tools.installCheck': { zh: '检查并安装', en: 'Check and install' },
  'tools.installing': { zh: '正在检查并安装…', en: 'Checking and installing…' },
  'tools.footHint': {
    zh: '工具是整组装进来的，不能只装组里某一个动作。',
    en: 'A tool is installed as a whole group — you cannot install just one action from it.',
  },
  'tools.failedTitle': { zh: '没有装上', en: 'Not installed' },
  'tools.errorDetailLabel': { zh: '详情：', en: 'Details:' },
  'tools.errEmptySource': {
    zh: '请填一个本地目录的绝对路径。',
    en: 'Enter the absolute path of a local directory.',
  },

  // ── 安装结果：装进来了什么 / 明确没装什么 ──
  'tools.installedTitle': { zh: '已安装', en: 'Installed' },
  'tools.resultActions': { zh: '装进来 {count} 个动作：', en: 'Installed {count} action(s):' },
  'tools.resultFiles': { zh: '装进来 {count} 个文件：', en: 'Installed {count} file(s):' },
  'tools.ignoredHeading': { zh: '没装进来：', en: 'Not installed:' },
  'tools.ignoredNotReported': {
    zh: '二进制等非文本文件不会被装进来（只收脚本与文档这类文本）；上面列的是真正收下的文件。',
    en: 'Non-text files such as binaries are never installed (only text — scripts and docs — is taken); the files above are the ones actually taken in.',
  },
  'tools.resultSource': { zh: '来源：{ref}', en: 'Source: {ref}' },

  // ── 安装失败：按错误码给"那我该怎么做" ──
  // 错误码本身（`manifest_invalid`…）是契约值，不翻译；翻译的是下一步。
  'tools.errBadInput': {
    zh: '看一下上面那条原文：路径要指向一个含 tool.json 的本地目录；如果是「已有同名工具包」，就勾上「允许替换同名的工具」再装一次。',
    en: 'Read the message above: the path must point at a local directory containing tool.json; if it says a tool with the same name already exists, tick "Allow replacing a tool with the same name" and install again.',
  },
  'tools.errNotFound': {
    zh: '检查路径：目录是否存在、有没有写错（这里只读本机上的目录）。',
    en: 'Check the path: whether the directory exists and is spelled correctly (only local directories on this machine are read).',
  },
  'tools.errNotADirectory': {
    zh: '要指向工具的那个目录（里面放着 tool.json），不是单个文件。',
    en: 'Point at the tool directory (the one holding tool.json), not at a single file.',
  },
  'tools.errMissingToolJson': {
    zh: '工具包里必须有全小写的 tool.json。请指向那个目录，或先把清单补上。',
    en: 'A tool package must contain tool.json in lowercase. Point at that directory, or write the manifest first.',
  },
  'tools.errBadJson': {
    zh: 'tool.json 不是合法的 JSON——先把它修好，再装一次。',
    en: 'tool.json is not valid JSON — fix it first, then install again.',
  },
  'tools.errManifestInvalid': {
    zh: '清单里有一处不合规（上面那条详情说的是哪一处）。平台按清单判断「是不是适配的工具」，所以整份拒绝，不会只装一半。',
    en: 'One entry in the manifest is invalid (the details above name it). The platform decides from the manifest whether a package is a tool it can run, so the whole package is refused rather than half-installed.',
  },
  'tools.errMissingEntry': {
    zh: '清单声明了动作，但入口脚本不在包里。检查 entry 的路径与文件是否都在。',
    en: 'The manifest declares actions, but the entry script is not in the package. Check the entry paths and whether the files are there.',
  },
  'tools.errBinaryFile': {
    zh: '首版只收文本（脚本与文档）：二进制文件装进来会写坏，所以明确拒绝。',
    en: 'Only text (scripts and docs) is accepted for now: a binary would be written incorrectly, so it is explicitly refused.',
  },
  'tools.errTooLarge': {
    zh: '工具应当是一小组文本文件。请精简后再装。',
    en: 'A tool should be a small set of text files. Trim it down and install again.',
  },

  // ⚠️ 这里原来有「不能卸载」/「还挂在 X 上」两句（`tools.errInUseTitle` /
  //    `tools.errInUse`）。服务端那条"还挂着就拒"的规则已经删掉、卸载一律放行，
  //    所以这两句没有触发的地方了，一并删掉。
  'tools.confirmUninstallTitle': { zh: '卸载工具「{slug}」', en: 'Uninstall the tool "{slug}"' },
  'tools.confirmUninstallBody': {
    zh: '这一组动作会一起消失。',
    en: 'Its whole group of actions goes with it.',
  },
  'tools.uninstalled': { zh: '已卸载 {slug}', en: 'Uninstalled {slug}' },

  // ── 智能体详情里的「干活时能用的工具包」段（D40 挂载，D42 接线）──
  //
  // ⚠️ 这一段**只出现在执行者**的详情/编辑页（审核者不挂工具）。D42 之后，
  //    "挂载"的意思从"把整组动作交给它"（那是审核者那一侧的事）改成
  //    "把包的脚本与说明送进它的工作目录，干活时可以调用"——两个行为面必须
  //    在措辞上分开，不然"工具"这个字在两个角色身上各说一半，最容易让人误会。
  // ⚠️ 这里原来有 8 条只属于**执行者详情里"工具包"那一段**的词：
  //    detailSection「干活时能用的工具包」/ detailMountedLabel「干活时能用的工具组」/
  //    detailNoTools / detailPickLabel「可挂载的工具组」/ detailNoInstalled /
  //    detailMountHint / detailSave「保存挂载」/ detailSaved。
  //    使用者的要求是「执行智能体不支持"行动"，去掉」——先撤勾选栏、再整段撤掉，
  //    这 8 条就没有渲染点了，一并删掉。留着就是"词表里有一条谁也渲染不出来的话"，
  //    下一个人会以为哪里漏了。
  //    要恢复那个界面入口，这 8 条连同 AgentDetail 里那一段一起加回来。

  // ── 行动权限：可勾已装工具的动作 ──
  //
  // ⚠️ 这几条原来挂在**审核标准**那一栏里（键名里的 `std` 就是"standard"）。
  //    D40 收口之后那一块搬成了审核者自己的「行动权限」段（见
  //    `components/ActionPermissions.svelte`），所以下面 `stdToolsNote` 里那句
  //    "审核标准管的是……"改成说"这一段管的是……"——不然界面上会出现一句
  //    指向别处的话，而那一处已经不在了。
  'tools.stdToolsHeading': { zh: '已装工具的动作', en: 'Actions from installed tools' },
  'tools.stdToolsHintBefore': { zh: '勾上一个动作 = 允许触发它；契约值是 ', en: 'Ticking an action allows triggering it; its contract value is ' },
  'tools.stdToolsHintAfter': { zh: '（等宽那一串，判决里写的就是它）。', en: ' (the monospaced string — that is what goes in a verdict).' },
  'tools.stdToolsNote': {
    zh: '这里列的是已安装的全部工具动作：行动权限管的是「判完允许触发什么」，与哪个执行者挂了它无关。',
    en: 'This lists every action of every installed tool: action permissions govern what a verdict may trigger, regardless of which executor mounts it.',
  },
  // ⚠️ 这里原来还有一条 `tools.stdToolsNone`（"还没有装任何工具——只有上面那些内置
  //    动作可以勾"）。D41 把内置动作整组移除之后，那句话里的"上面那些内置动作"
  //    已经不存在了，而空态的句子也换了地方：它现在说的是"动作只能来自装进来的
  //    工具包 ⇒ 现在没有动作可授权"（`agents.actionsNoTools*`，因为说这句话的
  //    两处界面都在智能体那一边：编辑态那一栏与详情里的只读那一行）。
} as const satisfies TextCatalog
