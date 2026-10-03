import type { TextCatalog } from '../text.ts'

/**
 * 「第一句话模版」这一栏：`components/FirstSentenceTemplate.svelte` 与
 * `components/WorkspaceSettings.svelte`。
 *
 * ⚠️ zh 的值改之前先看一眼**有没有东西钉着它**：中文是默认语言，既有测试、布局
 *    探针与文档都引用它。⚠️ 但"与迁移之前逐字一致"**不再是判据**（2026-09 的文案
 *    改写把那批文字按"这句话是给谁看的"重写了一遍：去掉开发口径、机器取值与
 *    markdown 残留）。有引用就一起改，没有就按读者改。
 *
 * ⚠️ **模版记号与契约值不进词表**：`{{prompt}}` / `{{#instructions}}…{{/instructions}}`
 *    这类是模版的语法（界面上由 `varToken()` 或字符串字面量直接渲染，两种语言下必须
 *    是同一个字面量），`pass` / `needs_human` 这类是机器值，同样一个字都不翻。
 *
 * ⚠️ 长句被 `<strong>` / `<code>` 切成几段（`xxxBefore` / 加粗那段 / `xxxAfter`）：
 *    标记里那几段挨着写，拼出来与迁移之前逐字相同。
 *
 * ⚠️ 键名的形状由 i18n.test.ts 守着：**第一段必须是全小写的单词**，点后面随便
 *    （可以再分层）。所以设置抽屉那一组是 `tpl.settings.…`（不是 `tplSettings.…`）；
 *    长句被切成几段的那种**用点分层**（`tpl.settings.hint.all.before`），
 *    不再把段名叠成 camelCase。
 */
export const templatesText = {
  // ── FirstSentenceTemplate：栏头与状态 ──
  'tpl.label': { zh: '第一句话模版', en: 'First-sentence template' },
  /**
   * ── 「平台替你调整过这份模版」──
   *
   * 2026-09 三块组装：六个变量退役（`{{instructions}}` / `{{prompt}}` /
   * `{{standards}}` / `{{tools}}` / `{{material}}` / `{{materialTitle}}`），它们的
   * 内容现在由平台放在固定位置。老模版读出来就迁移，迁移**不丢一个字**——但必须
   * 让使用者知道发生了什么，否则他看到的是一份"写了却不起作用"的文本。
   */
  'tpl.adjusted.before': {
    zh: '平台替你调整过这份模版：这些变量已经退役 ',
    en: 'The platform adjusted this template: these variables are retired ',
  },
  'tpl.adjusted.after': {
    zh: '——它们的内容现在由平台自己放在该在的位置，一个字都没丢，模版里不再需要它们。',
    en: ' — their content is now placed by the platform where it belongs. Nothing was lost; the template no longer needs them.',
  },
  'tpl.adjusted.orphan': {
    zh: '另外，这几行现在成了空标题，建议删掉或补上内容：{lines}',
    en: 'Also, these lines are now empty headings — delete them or fill them in: {lines}',
  },
  'tpl.custom': { zh: '自定义', en: 'Custom' },
  'tpl.platformDefault': { zh: '平台默认', en: 'Platform default' },

  // ── FirstSentenceTemplate：说明那一段（按块，见 tpl.settings.hint.{frame,identity,task}.*）──
  'tpl.hintVarsOnly': { zh: '变量只给内容', en: 'Variables carry content only' },
  'tpl.hintVarsOnlyAfter': {
    zh: '——标题、标签、材料标记、说明那句话都写在模版里，',
    en: ' — the title, the labels, the material markers and that explanatory sentence all live in the template,',
  },
  'tpl.hintDefaultGuardsLead': { zh: '，默认里的', en: ', and the guardrails in the default' },
  'tpl.hintDefaultGuards': {
    zh: '「完成后给出一份报告」那类护栏也一并没了，需要自己写进去。',
    en: ' — things like “write a report when you are done” — go away with it, so write them in yourself.',
  },

  // ── FirstSentenceTemplate：输入框与工具行 ──
  'tpl.placeholder': {
    zh: '留空 = 用平台默认模版。点下面的「填入默认模版」可以从默认那段改起。',
    en: 'Empty = the platform default template. Click “Fill with the default” below to start from that default block.',
  },
  'tpl.fillDefault': { zh: '填入默认模版', en: 'Fill with the default' },
  'tpl.clearToDefault': { zh: '清空（回到平台默认）', en: 'Clear (back to the platform default)' },
  'tpl.hideVars': { zh: '收起变量', en: 'Hide variables' },
  'tpl.showVars': { zh: '可用的变量', en: 'Available variables' },

  // ── FirstSentenceTemplate：变量清单（写法与条件段） ──
  'tpl.varsUnavailable': {
    zh: '拿不到变量表（daemon 可能没起来）。变量写法是 ',
    en: 'Could not load the variable table (the daemon may not be running). Variables are written as ',
  },
  'tpl.varsSyntax': { zh: '写法是 ', en: 'Written as ' },
  'tpl.varsSyntaxAfter': {
    zh: '，插值发生在每次 run：同一个模版，',
    en: ', and interpolation happens on every run: the same template',
  },
  'tpl.varsSyntaxAfter2': {
    zh: '模型拿到的是这一次的值。',
    en: 'gives the model this run’s values.',
  },
  'tpl.condHintTitle': { zh: '可选的东西用条件段', en: 'Use conditional sections for optional things' },
  'tpl.condHintBody': { zh: '——里面那个变量为空时，', en: '— when that variable is empty, ' },
  'tpl.condHintStrong': {
    zh: '整段连标题一起不出现',
    en: 'the whole section, heading included, disappears',
  },
  'tpl.condHintQuote1': { zh: '（所以「没写指令就', en: '(so you never have to worry about “' },
  'tpl.condHintQuote2': {
    zh: '别留一个空标题」这件事不用你操心）。反向写法是 ',
    en: 'leaving an empty heading behind” when the instructions are empty). The reverse form is ',
  },
  'tpl.requiredVarsBefore': { zh: '必需的那几个变量得在段', en: 'Required variables must appear ' },
  'tpl.requiredVarsOutside': { zh: '外面', en: 'outside' },
  'tpl.requiredVarsAfter': { zh: '至少出现一次。', en: ' the section at least once.' },

  // ── FirstSentenceTemplate：变量条目与预览 ──
  'tpl.multiline': { zh: '多行', en: 'Multi-line' },
  'tpl.singleValue': { zh: '单值', en: 'Single value' },
  'tpl.previewHeading': { zh: '渲染出来是这样', en: 'This is how it renders' },
  'tpl.previewNote1': { zh: '—— 用的是', en: '— using ' },
  'tpl.sampleValues': { zh: '示例值', en: 'sample values' },
  'tpl.previewNote2': {
    zh: '（一个假任务 / 一份假报告），不是你的真实任务；',
    en: '(a fake task / a fake report), not your real task;',
  },
  'tpl.previewNote3': {
    zh: '但渲染器与真的那次是同一个。',
    en: 'but the renderer is the same one the real run uses.',
  },

  // ── WorkspaceSettings：抽屉外壳 ──
  'tpl.settings.title': { zh: '设置', en: 'Settings' },
  'tpl.settings.subtitle': {
    zh: '这里的设置都是平台行为：改一次，对所有智能体生效。',
    en: 'Everything here is platform behaviour: change it once and it applies to every agent.',
  },

  // ── WorkspaceSettings：第一句话模版那一段的说明（2026-10 三框改造后的整段说明）──
  'tpl.settings.sectionTitle': { zh: '第一句话模版', en: 'First-sentence template' },
  'tpl.settings.hint.threeBlocks.before': {
    zh: '第一句话是平台交给模型的',
    en: 'The first sentence is what the platform hands the model — ',
  },
  'tpl.settings.hint.threeBlocks.strong': { zh: '三块', en: 'three blocks' },
  'tpl.settings.hint.threeBlocks.after': {
    zh: '：① 框架（每轮都一样）、② 身份（这个智能体是谁）、③ 任务（这次要干的事）。三条链路（执行 / 审核 / 聊天）各有一套，在下面按「链路 × 块」分别设置。',
    en: ': ① the frame (the same every run), ② the identity (who this agent is), ③ the task (what this run is to do). Each of the three kinds (execute / review / chat) has its own set — configure them below by kind × block.',
  },
  'tpl.settings.hint.blocksPlatform.before': {
    zh: '三块的内容仍由平台组装（材料标记、标准合成这些安全件不交给模版），模版只决定',
    en: 'The three blocks’ content is still assembled by the platform (material markers, standard merging and the like never go into the template) — the template only decides ',
  },
  'tpl.settings.hint.blocksPlatform.strong': {
    zh: '位置、标题与包装',
    en: 'position, headings and wrapping',
  },
  'tpl.settings.hint.blocksPlatform.after': {
    zh: '；',
    en: '; ',
  },
  'tpl.settings.hint.emptyMeans': { zh: '留空 = ', en: 'empty = ' },
  'tpl.settings.hint.platformDefault': { zh: '平台默认', en: 'the platform default' },
  'tpl.settings.hint.isGlobal': { zh: '它是', en: 'It is ' },
  'tpl.settings.hint.global.strong': { zh: '通用配置', en: 'shared configuration' },
  'tpl.settings.hint.global.colon': { zh: '：设一次，', en: ': set it once and ' },
  'tpl.settings.hint.everyAgent.strong': { zh: '所有智能体', en: 'every agent' },
  'tpl.settings.hint.everyAgent.short': {
    zh: '都按它来，包括已经建好的那些。',
    en: ' follows it, including the ones already created.',
  },
  /**
   * ★ 2026-10 三框改造：每条链路三块模版各一份（① 框架 / ② 身份 / ③ 任务）。
   * 页面上的页签现在是「链路 × 块」两排。
   */
  'tpl.settings.tabFrame': { zh: '① 框架', en: '① Frame' },
  'tpl.settings.tabIdentity': { zh: '② 身份', en: '② Identity' },
  'tpl.settings.tabTask': { zh: '③ 任务', en: '③ Task' },
  'tpl.settings.hint.frame.before': {
    zh: '这一块是框架：',
    en: 'This block is the frame: ',
  },
  'tpl.settings.hint.frame.strong': { zh: '每轮都一样', en: 'the same every run' },
  'tpl.settings.hint.frame.after': {
    zh: '的骨架（run/对象头、回答语言、技能清单、护栏，审核那份还有判决契约）。',
    en: ' (run/object header, answer language, skill list, guardrails, and for reviews the verdict contract).',
  },
  'tpl.settings.hint.identity.before': {
    zh: '这一块是身份：',
    en: 'This block is the identity: ',
  },
  'tpl.settings.hint.identity.strong': {
    zh: '这个智能体是谁',
    en: 'who this agent is',
  },
  'tpl.settings.hint.identity.after': {
    // ⚠️ 反引号去掉（同上：纯文本渲染，记号会原样显示）
    zh: '——放一个 {{identity}} 就行（审核者会自动接上它的审核标准，合成同一块）。',
    en: ' — place {{identity}} once (for reviewers it also merges in their review standard).',
  },
  'tpl.settings.hint.task.before': { zh: '这一块是任务：', en: 'This block is the task: ' },
  'tpl.settings.hint.task.strong': {
    zh: '这次要干的事',
    en: 'what this run is to do',
  },
  'tpl.settings.hint.task.after': {
    zh: '——放一个 {{task}} 就行（审核时它会带着声明、材料标记与材料，或文件引用）。',
    en: ' — place {{task}} once (for reviews it carries the disclaimer, material markers and material, or file refs).',
  },
  'tpl.settings.hint.requiredTask.before': {
    zh: '⚠️ ',
    en: '⚠️ ',
  },
  'tpl.settings.hint.requiredTask.strong': {
    zh: '{{task}} 是必需的',
    en: '{{task}} is required',
  },
  'tpl.settings.hint.requiredTask.after': {
    zh: '：少了它这条 run 就没有任务（执行没有活、审核没有可审、聊天没有可答）。',
    en: ': without it the run has no task at all.',
  },
  /**
   * 第三个页签：**聊天**那一份（2026-09）。
   *
   * ⚠️ 它不是"任务的又一次投递"：任务那份框架含 run/对象头、"完成后给出一份报告"
   *    与判决契约，而聊天不产出判决、也没有报告可交。所以它有自己的 ①。
   */
  'tpl.settings.tabChat': { zh: '聊天', en: 'Chat' },

  // ── WorkspaceSettings：页签与底部 ──
  'tpl.settings.tabExecute': { zh: '执行', en: 'Execute' },
  'tpl.settings.tabReview': { zh: '审核', en: 'Review' },
  'tpl.settings.kitUnavailable': {
    zh: '拿不到变量表（daemon 可能没起来）——先重启 daemon 再改模版。',
    en: 'Could not load the variable table (the daemon may not be running) — restart the daemon before editing the template.',
  },
  'tpl.settings.savedHint.before': { zh: '保存后', en: 'After saving, ' },
  'tpl.settings.savedHint.strong': { zh: '对所有智能体生效', en: 'it applies to every agent' },
  'tpl.settings.savedHint.after': { zh: '，包括已经建好的那些。', en: ', including the ones already created.' },

  // ── WorkspaceSettings：保存成功的提示（命令式，走 tx()） ──
  'tpl.settings.savedToast': {
    zh: '设置已保存（对所有智能体生效）',
    en: 'Settings saved (they apply to every agent)',
  },
} as const satisfies TextCatalog
