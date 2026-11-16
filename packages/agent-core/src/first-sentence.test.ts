import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TEMPLATES,
  SAMPLE_EXECUTE_INPUT,
  TEMPLATE_VARIABLES,
  TemplateInvalidError,
  buildBlocks,
  firstSentenceKindFor,
  isBlankBlock,
  isKnownVariable,
  migrateTemplate,
  renderDelivery,
  renderFirstSentence,
  templateVariablesFor,
  validateTemplate,
} from './first-sentence.ts'

/**
 * 第一句话的组装与投递。
 *
 * ══════════════════════════════════════════════════════════════════
 * 2026-09 的改造：从"一段模版插值"改成"三块显式组装"
 * 2026-10 的改造：三块各有一个**独立的模版框**（`BlockTemplates`）
 * ══════════════════════════════════════════════════════════════════
 *
 *   · **① 框架**：每轮都发，工作区级（模版就是它）；
 *   · **② 身份**：agent 的「指令」；（审核者）其中已并入审核标准；
 *   · **③ 任务**：这次要干的事；审核时还有那句声明、两个材料标记与材料本身。
 *
 * 三块的**内容**仍由平台组装（安全件不交给模版），但**位置、标题与包装**现在由
 * 各框的模版决定：`{{identity}}`（② 身份框）与 `{{task}}`（③ 任务框）两个新变量
 * 把整块插进作者想放的地方。默认框 = `{{identity}}` / `{{task}}` ⇒ 与三框改造前
 * **逐字节相同**。
 *
 * 两档投递：`A` = ①② 进系统提示、③ 进用户消息；`B` = 三块合成一段（兜底）。
 * ⚠️ 实测（claude 2.0.14）：系统提示**活不过 `--resume`** ⇒ A 档必须**每轮都带**。
 *
 * 三件这一版必须钉住的事：
 *
 *   1. **②③ 的内容不交给模版** ⇒ 老模版里写它们（`{{instructions}}` 那六个）会被
 *      **专门拒绝**（"已经退役"），`migrateTemplate` 能把它们摘掉；想摆放 ②③
 *      用 `{{identity}}` / `{{task}}`（只属于各自的框）；
 *   2. **材料绝不进 ①（系统提示）**——它是第三方内容，进"规则"那一层就是注入的靶子；
 *   3. **块边界是显式的**（B 档有块名），所以"这段是谁给的"在日志/副本里看得出来。
 */

/** 执行档的 ①（示例输入下逐字）。 */
const EXECUTE_FRAME = `# 任务

- run：\`01M2EXEC000000000000000001\`
- 对象：issue \`01M2ISSUE00000000000000001\`

能用到的技能：algorithmic-art、writing-notes

请用简体中文回答。`

const EXECUTE_IDENTITY = '你是一个严谨的协作者。先理解任务，再动手。'
const EXECUTE_TASK = `冒泡排序

用 JS 写一个冒泡排序，并解释复杂度。`

/*
 * ⚠️ 2026-11（D125）：这里原来是审核档的三份夹具（`REVIEW_FRAME` / `REVIEW_IDENTITY` /
 *   `REVIEW_TASK`）与 `withContract()`（把判决契约塞进 ① 的占位符）。
 *   审核链路退场 ⇒ 整段删。
 */

// ══════════════════════════════════════════════════════════════════
// 三块的内容归属
// ══════════════════════════════════════════════════════════════════

describe('第一句话：三块的内容归属', () => {
  test('★ 执行档：① 框架 / ② 身份 / ③ 任务，各是各的', () => {
    const blocks = buildBlocks(SAMPLE_EXECUTE_INPUT)
    assert.equal(blocks.frame, EXECUTE_FRAME)
    assert.equal(blocks.identity, EXECUTE_IDENTITY)
    assert.equal(blocks.task, EXECUTE_TASK)
  })

  /*
   * ⚠️ 2026-11（D125）：这里原来是「审核档：② = 指令 + 标准（合并成一块）；
   *   ③ = 指令 + 声明 + 标记 + 材料」。审核链路退场 ⇒ 用例删。
   */

  test('★ ① 里不该出现身份与任务正文（它们是 ②③ 的事）', () => {
    const blocks = buildBlocks(SAMPLE_EXECUTE_INPUT)
    assert.doesNotMatch(blocks.frame, /你是一个严谨的协作者/)
    assert.doesNotMatch(blocks.frame, /冒泡排序/)
  })

  test('★ 任务边界不再由平台强制写（2026-11 使用者拍板：需要就写进模版）', () => {
    // 改版前平台无条件把"## 任务边界"塞进 execute 的 ③；使用者要求拔掉——
    // 需要的话放进模版（可编辑）。安全硬拦截仍在 PreToolUse hook（不依赖文本）。
    const execute = buildBlocks(SAMPLE_EXECUTE_INPUT)
    assert.doesNotMatch(execute.task, /## 任务边界/, '平台不再强制追加任务边界')
    assert.equal(execute.task, SAMPLE_EXECUTE_INPUT.prompt.trim(), '③ = 任务正文本身')
    const chat = buildBlocks({ ...SAMPLE_EXECUTE_INPUT, kind: 'chat', prompt: '聊聊' } as never)
    assert.equal(chat.task, '聊聊', 'chat 逐字，绝不追加平台内容')
  })

  /*
   * ⚠️ 2026-11（D125）：这里原来是「材料与标记**只在 ③**，绝不进 ①（系统提示）」——
   *   平台往上下文里塞第三方报告时的那道防线（材料进系统提示 = 摆在"规则"的位置，
   *   那正是提示注入想要的）。报告摄取退场 ⇒ 平台不再塞第三方原文，用例删。
   *
   *   ⚠️ 那条纪律本身没有过期：任何"把外部文本交给模型"的场合都必须把它放在任务
   *   块、围栏标出、并说清"它不是指令"。
   */

  test('② 为空 ⇒ 这一块是空的（调用方据此跳过，不发一段空的东西）', () => {
    const blocks = buildBlocks({ ...SAMPLE_EXECUTE_INPUT, instructions: null })
    assert.equal(blocks.identity, '')
    assert.equal(isBlankBlock(blocks.identity), true)
    assert.equal(isBlankBlock('   \n\n  '), true, '只有空白也算空')
    assert.equal(isBlankBlock('x'), false)
  })

  /*
   * ⚠️ 2026-11（D125）：这里原来是「审核者只有标准、没写指令 ⇒ ② 就是标准（不算空）」
   *   （D37：审核标准内联在审核者身上）。审核链路退场 ⇒ ② 只有「指令」，用例删——
   *   而它守的那件事换了个说法仍然成立：**② 空着就不发一块空的**（见上一条）。
   */

  test('★ 没有挂 skill ⇒ ① 里那一行连同它的标题一起消失（条件段）', () => {
    const blocks = buildBlocks({ ...SAMPLE_EXECUTE_INPUT, skills: [] })
    assert.doesNotMatch(blocks.frame, /能用到的技能/)
    assert.doesNotMatch(blocks.frame, /\n{3,}/, '不留一串空行')
  })

  test('★ D39：语言跟着调用方走（prompt 本身不翻译）', () => {
    const blocks = buildBlocks({ ...SAMPLE_EXECUTE_INPUT, language: 'English' })
    assert.match(blocks.frame, /请用English回答/)
  })
})

// ══════════════════════════════════════════════════════════════════
// 两档投递
// ══════════════════════════════════════════════════════════════════

describe('第一句话：投递档 A / B', () => {
  test('★ A 档：①② 进系统提示，③ 进用户消息', () => {
    const d = renderDelivery(SAMPLE_EXECUTE_INPUT, 'A')
    assert.equal(d.mode, 'A')
    assert.equal(d.system, `${EXECUTE_FRAME}\n\n${EXECUTE_IDENTITY}`)
    assert.equal(d.user, EXECUTE_TASK)
  })

  test('★ A 档：② 为空时系统提示里不留空档', () => {
    const d = renderDelivery({ ...SAMPLE_EXECUTE_INPUT, instructions: null }, 'A')
    assert.equal(d.system, EXECUTE_FRAME)
    assert.ok(!d.system.endsWith('\n\n'))
  })

  test('★ B 档：三块合成一段，块名显式（"这段是谁给的"要看得出来）', () => {
    const d = renderDelivery(SAMPLE_EXECUTE_INPUT, 'B')
    assert.equal(d.system, '', 'B 档没有系统提示')
    assert.equal(
      d.user,
      [
        `===== ① 框架 =====\n\n${EXECUTE_FRAME}`,
        `===== ② 身份 =====\n\n${EXECUTE_IDENTITY}`,
        `===== ③ 任务 =====\n\n${EXECUTE_TASK}`,
      ].join('\n\n'),
    )
  })

  test('B 档：空的块不出现（连它的块名也不出现）', () => {
    const d = renderDelivery({ ...SAMPLE_EXECUTE_INPUT, instructions: null }, 'B')
    assert.doesNotMatch(d.user, /② 身份/)
    assert.match(d.user, /① 框架/)
    assert.match(d.user, /③ 任务/)
  })

  test('renderFirstSentence = B 档的用户消息（迁移期的单一出口）', () => {
    assert.equal(
      renderFirstSentence(SAMPLE_EXECUTE_INPUT),
      renderDelivery(SAMPLE_EXECUTE_INPUT, 'B').user,
    )
  })
})

// ══════════════════════════════════════════════════════════════════
// 值不被重扫 / 转义 / 字面大括号
// ══════════════════════════════════════════════════════════════════

describe('第一句话：插进去的值不被重扫（安全性质）', () => {
  /*
   * ⚠️ 2026-11（D125）：这里原来是「材料里写 `{{verdict}}` 就原样是那几个字，契约不会
   *   多出一份」——报告摄取的第三方材料进上下文之后，"值不被重扫"那条性质最硬的
   *   证据。报告摄取退场 ⇒ 用例删。
   *
   *   ⚠️ 那条性质**仍然成立且仍然被测**：见下面「任务正文里带 `{{...}}` 时同样原样
   *   落地」。它是安全性质，不是实现细节：重扫的话，任何能往上下文里塞一段文本的人
   *   都能决定模版变量插在哪。
   */

  test('任务正文里带 `{{...}}` 时同样原样落地', () => {
    const d = renderDelivery(
      { ...SAMPLE_EXECUTE_INPUT, prompt: '把这个模版里的 {{prompt}} 换成实际任务' },
      'B',
    )
    assert.match(d.user, /\{\{prompt\}\}/, '任务正文里的花括号是内容，不是变量')
  })

  test('★ HTML 转义必须关掉（`&` / `<` / `"` 原样）', () => {
    const d = renderDelivery(
      { ...SAMPLE_EXECUTE_INPUT, prompt: 'a & b < c > d "e"' },
      'B',
    )
    assert.match(d.user, /a & b < c > d "e"/)
    assert.doesNotMatch(d.user, /&amp;|&lt;|&quot;/)
  })

  test('`{{{{` 写出一对字面大括号（模版里要描述标记时用得上）', () => {
    const blocks = buildBlocks({
      ...SAMPLE_EXECUTE_INPUT,
      template: { frame: '# 框架\n\n字面量：{{{{runId}}}}\n\n{{runId}}' },
    })
    assert.match(blocks.frame, /\{\{runId\}\}/, '{{{{ 渲染成一个字面 {')
    assert.match(blocks.frame, /01M2EXEC000000000000000001/, '而真的变量照常插值')
  })
})

// ══════════════════════════════════════════════════════════════════
// 默认模版 = 只有框架
// ══════════════════════════════════════════════════════════════════

describe('第一句话：默认模版', () => {
  const KINDS = ['execute', 'chat', 'workflow'] as const

  test('★ 三块默认模版自己必须通过校验（否则「填入默认模版」会立刻被拒）', () => {
    for (const kind of KINDS) {
      for (const block of ['frame', 'identity', 'task'] as const) {
        const check = validateTemplate(kind, block, DEFAULT_TEMPLATES[kind][block] ?? '')
        assert.equal(check.ok, true, `${kind} ${block} 默认模版不合法：${check.ok ? '' : check.error}`)
      }
    }
  })

  test('★ 默认模版里**不再有**任何退役变量（它们由平台组装）', () => {
    for (const kind of KINDS) {
      for (const name of ['instructions', 'prompt', 'standards', 'tools', 'material', 'materialTitle']) {
        for (const block of ['frame', 'identity', 'task'] as const) {
          assert.ok(
            !(DEFAULT_TEMPLATES[kind][block] ?? '').includes(`{{${name}}}`),
            `${kind} ${block} 默认模版里不该还有 {{${name}}}`,
          )
        }
      }
    }
    // 也不该再有那段恒不渲染的工具包段（2026-09 审计）
    assert.doesNotMatch(DEFAULT_TEMPLATES.execute.frame ?? '', /\{\{#tools\}\}/)
    assert.doesNotMatch(DEFAULT_TEMPLATES.execute.frame ?? '', /干活时能用的工具包/)
  })

  test('★ ② 身份框与 ③ 任务框的默认就是 `{{identity}}` / `{{task}}`（改造前逐字节相同）', () => {
    for (const kind of KINDS) {
      assert.equal(DEFAULT_TEMPLATES[kind].identity, '{{identity}}', `${kind} 身份框默认`)
      assert.equal(DEFAULT_TEMPLATES[kind].task, '{{task}}', `${kind} 任务框默认`)
    }
  })

  test('★ 把默认模版填回模版字段，渲染结果一模一样（默认模版真的是模版）', () => {
    const plain = buildBlocks(SAMPLE_EXECUTE_INPUT)
    const explicit = buildBlocks({
      ...SAMPLE_EXECUTE_INPUT,
      template: DEFAULT_TEMPLATES.execute,
    })
    assert.deepEqual(explicit, plain)
  })

  test('模版为空 / null / 只有空白 = 平台默认（三种"没填"都算，逐块）', () => {
    const base = buildBlocks(SAMPLE_EXECUTE_INPUT)
    for (const template of [null, { frame: '' }, { identity: '' }, { task: '' }]) {
      assert.deepEqual(buildBlocks({ ...SAMPLE_EXECUTE_INPUT, template }), base)
    }
  })

  test('★ 默认模版里的段标签一律**独立成行**（行内写法会吃掉后面的空行）', () => {
    for (const kind of KINDS) {
      for (const line of (DEFAULT_TEMPLATES[kind].frame ?? '').split('\n')) {
        const isTag = /^\s*\{\{[#/][a-zA-Z]+\}\}\s*$/.test(line)
        const hasTag = /\{\{[#/][a-zA-Z]+\}\}/.test(line)
        assert.equal(hasTag, isTag, `这一行把段标签和别的东西写在了一起：${line}`)
      }
    }
  })

  /*
   * ⚠️ 2026-11（D125）：这里原来是「审核默认模版里那句话**不许把 skill 说成"标准"**」
   *   （D37：审核标准内联在审核者身上，不挂在 skill 上）。审核默认模版退场 ⇒ 用例删。
   */

  test('★ 护栏的措辞不许提「上面／下面」（三块重排之后位置变了）', () => {
    for (const kind of ['execute', 'chat', 'workflow'] as const) {
      assert.doesNotMatch(
        DEFAULT_TEMPLATES[kind].frame ?? '',
        /上面描述的事|按上面的审核标准/,
        '① 排在 ③ 之前（A 档里还是系统提示）⇒ 说「上面」就把位置说反了',
      )
    }
  })
})

// ══════════════════════════════════════════════════════════════════
// 校验：退役变量要被"专门拒绝"
// ══════════════════════════════════════════════════════════════════

describe('第一句话：模版校验（坏模版进不了库）', () => {
  const RETIRED = ['instructions', 'prompt', 'standards', 'tools', 'material', 'materialTitle']
  const v = (kind: Parameters<typeof validateTemplate>[0], text: string) =>
    validateTemplate(kind, 'frame', text)

  test('★★ 六个退役变量被**专门拒绝**，而且说清去哪儿了', () => {
    for (const name of RETIRED) {
      const check = v('execute', `# 框架\n\n{{${name}}}`)
      assert.equal(check.ok, false, `{{${name}}} 该被拒`)
      const error = check.ok ? '' : check.error
      assert.match(error, /已经退役/, `要说清它退役了：${error}`)
      assert.match(error, /identity|task|②|③/, `要指出去处：${error}`)
      assert.match(error, /删掉/, `要给出动作：${error}`)
    }
  })

  /*
   * ⚠️ 2026-11（D125）：这里原来是「审核档也一样（同一个说法，不分角色）」。
   *   审核链路退场 ⇒ 只剩三种档，那条"跨档一致"的用例没有第二个档可比，删。
   */

  test('不认识的变量被拒，并把可用的列出来', () => {
    const check = v('execute', '{{promt}}')
    assert.equal(check.ok, false)
    const error = check.ok ? '' : check.error
    assert.match(error, /promt/)
    assert.match(error, /runId|subjectType/, '要把可用的名字列出来')
  })

  /*
   * ⚠️ 2026-11（D125）：这里原来是三条围着 `verdict` 转的用例——
   *   「另一种角色专有的变量被拒」、「缺必需变量（verdict）被拒，而且说清'缺了会怎样'」、
   *   「必需变量不能只出现在条件段里」。
   *
   *   审核链路退场 ⇒ 那个"角色专有的、而且必需的"变量没有了（`{{task}}` 对三种档
   *   都必需，见下面那条）。**但"必需变量不许只写在条件段里"这条规则还在**，它的
   *   用例改由 `{{task}}` 承载。
   */
  test('★ 必需变量不能只出现在条件段里（段不成立时它会消失）', () => {
    const check = validateTemplate('execute', 'task', '{{#skills}}\n{{task}}\n{{/skills}}')
    assert.equal(check.ok, false)
    assert.match(check.ok ? '' : check.error, /task/)
  })

  test('`{{` 没写完会被拒，而且**报得出位置**', () => {
    const check = v('execute', '# 框架\n\n{{runId')
    assert.equal(check.ok, false)
    assert.match(check.ok ? '' : check.error, /第 \d+ 个字符附近/)
  })

  test('段不配对 / 段名不认识 都被拒', () => {
    assert.equal(v('execute', '{{#skills}}xxx').ok, false)
    assert.equal(v('execute', '{{#nosuch}}x{{/nosuch}}').ok, false)
  })

  test('★ 不支持的语法当场拒（静默按另一套语义渲染比报错糟）', () => {
    assert.equal(v('execute', '{{> partial}}').ok, false)
    assert.equal(v('execute', '{{=<% %>=}}').ok, false)
  })

  test('★ 原型链上的名字挡在白名单外', () => {
    for (const name of ['constructor', '__proto__', 'toString']) {
      assert.equal(v('execute', `{{${name}}}`).ok, false, `${name} 不该放行`)
    }
  })

  test('合法的自定义模版通过（含条件段、转义、以及不含任何变量）', () => {
    for (const text of [
      '# 框架\n\n- run：`{{runId}}`\n\n{{#skills}}\n技能：{{skills}}\n{{/skills}}\n\n请用{{language}}回答。',
      '# 框架\n\n{{{{字面大括号}}',
      '一句没有变量的话。',
    ]) {
      assert.equal(v('execute', text).ok, true, `该通过：${text}`)
    }
  })

  // ── 2026-10：三框各自的变量（{{identity}} / {{task}} 只属于各自的框）──

  test('★ {{identity}} / {{task}} 只属于各自的框：写错框被当场拒', () => {
    const identityInFrame = v('execute', '## 角色\n\n{{identity}}')
    assert.equal(identityInFrame.ok, false)
    assert.match(identityInFrame.ok ? '' : identityInFrame.error, /② 身份/, '要说清属于哪一框')

    const taskInFrame = v('execute', '## 干活\n\n{{task}}')
    assert.equal(taskInFrame.ok, false)
    assert.match(taskInFrame.ok ? '' : taskInFrame.error, /③ 任务/)

    // 同一框里合法
    assert.equal(validateTemplate('execute', 'identity', '## 角色\n\n{{identity}}').ok, true)
    assert.equal(validateTemplate('execute', 'task', '## 干活\n\n{{task}}').ok, true)
    // 三种链路都认这两个变量
    for (const kind of ['execute', 'chat', 'workflow'] as const) {
      assert.equal(validateTemplate(kind, 'identity', '{{identity}}').ok, true)
      assert.equal(validateTemplate(kind, 'task', '{{task}}').ok, true)
    }
  })

  test('★ {{task}} 对三种链路都必需（缺了这条 run 就没有任务）', () => {
    for (const kind of ['execute', 'chat', 'workflow'] as const) {
      const check = validateTemplate(kind, 'task', '## 干这个')
      assert.equal(check.ok, false, `${kind} 任务框没有 {{task}} 该被拒`)
      assert.match(check.ok ? '' : check.error, /task/, '要说清缺的是哪个')
      assert.match(check.ok ? '' : check.error, /没有任务/, '要解释缺了会怎样')
    }
    // 只出现在条件段里也不行（段不成立时它不渲染）
    const inSection = validateTemplate('execute', 'task', '{{#skills}}\n{{task}}\n{{/skills}}')
    assert.equal(inSection.ok, false)
  })

  test('★ {{identity}} 是**可选**的：作者可以写死一段固定身份，不必放变量', () => {
    assert.equal(validateTemplate('execute', 'identity', '我固定这么说。').ok, true)
    // 空框（= 平台默认）当然也合法
    assert.equal(validateTemplate('execute', 'identity', '').ok, true)
  })

  test('★ 退役变量在 ②③ 框里同样被专门拒绝', () => {
    for (const block of ['identity', 'task'] as const) {
      const check = validateTemplate('execute', block, `## 标题\n\n{{instructions}}`)
      assert.equal(check.ok, false, `${block} 框里 {{instructions}} 该被拒`)
      assert.match(check.ok ? '' : check.error, /已经退役/)
    }
  })

  test('★ 变量表与实施一致：声明的都渲染得出来，没声明的用不了', () => {
    assert.deepEqual(
      TEMPLATE_VARIABLES.map((v) => v.name),
      [
        'runId',
        'subjectType',
        'subjectId',
        'language',
        'skills',
        'identity',
        'task',
      ],
      '框架五条 + ②③ 各自的 {{identity}} / {{task}} 两条 = 七条',
    )
    // 每条声明都属于一个块
    for (const v of TEMPLATE_VARIABLES) {
      assert.ok(['frame', 'identity', 'task'].includes(v.block), `${v.name} 要有块归属`)
    }
    // 每一条都必须在渲染时真的有值：把某个 (kind, block) 的全部变量写满，渲染后不该留 `{{`
    for (const kind of ['execute', 'chat', 'workflow'] as const) {
      for (const block of ['frame', 'identity', 'task'] as const) {
        const names = templateVariablesFor(kind, block).map((v) => v.name)
        const template = names.map((n) => `${n}={{${n}}}`).join('\n')
        const check = validateTemplate(kind, block, template)
        assert.equal(check.ok, true, `${kind} ${block} 的"写满全部变量"模版该合法：${check.ok ? '' : check.error}`)
        const blocks = buildBlocks({
          ...(kind === 'chat'
            ? { ...SAMPLE_EXECUTE_INPUT, kind: 'chat' as const, prompt: '你好' }
            : SAMPLE_EXECUTE_INPUT),
          template: { [block]: template },
        }, kind)
        assert.doesNotMatch(blocks[block], /\{\{/, `${kind} ${block}：不该有变量残留（说明表里有条目没被填值）`)
      }
    }
    // 没声明的用不了
    assert.equal(isKnownVariable('tools', 'execute'), false)
    assert.equal(isKnownVariable('verdict', 'execute'), false)
    /*
     * ⚠️ 2026-11（D125）：这里原来还有 `isKnownVariable('verdict', 'review') === true`。
     *   审核链路退场 ⇒ `verdict` 与 `review` 都不存在了，那条断言删。
     */
    assert.equal(isKnownVariable('identity', 'execute'), true)
    assert.equal(isKnownVariable('task', 'execute'), true)
  })
})

// ══════════════════════════════════════════════════════════════════
// 迁移
// ══════════════════════════════════════════════════════════════════

describe('第一句话：老模版一次性迁移', () => {
  test('★ 整行只有退役变量时，连那一行一起摘掉（段标签也是整行）', () => {
    const old = [
      '# 任务',
      '',
      '{{instructions}}',
      '',
      '## 要做的事',
      '',
      '{{prompt}}',
      '',
      '{{#tools}}',
      '## 干活时能用的工具包',
      '',
      '{{tools}}',
      '{{/tools}}',
      '',
      '请用{{language}}回答。',
    ].join('\n')
    const out = migrateTemplate(old)
    assert.deepEqual(out.removed, ['instructions', 'prompt', 'tools'], '按出现顺序、去重')
    assert.doesNotMatch(out.next, /\{\{instructions\}\}|\{\{prompt\}\}|\{\{tools\}\}|\{\{#tools\}\}/)
    assert.match(out.next, /请用\{\{language\}\}回答。/, '没退役的变量原样留着')
    assert.equal(out.changed, true)
  })

  test('★ 行内出现时只摘变量本身（那一行其余的字一个字不丢）', () => {
    const out = migrateTemplate('# 任务\n\n你的角色：{{instructions}}\n\n技能：{{skills}}')
    assert.deepEqual(out.removed, ['instructions'])
    assert.match(out.next, /你的角色：/, '行还在')
    assert.match(out.next, /技能：\{\{skills\}\}/, '别的变量不动')
  })

  test('★ 摘完之后剩下的空标题要**报出来**（不报的话模型会看到一行空标题）', () => {
    const out = migrateTemplate('## 你的角色\n{{instructions}}\n\n正文在下面。')
    assert.deepEqual(out.orphanLines, ['## 你的角色'])
  })

  test('★ 迁移结果必须能过校验（否则"自动调整"等于把模版弄坏）', () => {
    const old = [
      '# 任务',
      '',
      '{{instructions}}',
      '',
      '{{prompt}}',
      '',
      '{{#skills}}',
      '技能：{{skills}}',
      '{{/skills}}',
      '',
      '{{tools}}',
      '',
      '请用{{language}}回答。',
    ].join('\n')
    const out = migrateTemplate(old)
    assert.equal(validateTemplate('execute', 'frame', out.next).ok, true)
  })

  test('没有退役变量时不改动（changed=false，一个字都不动）', () => {
    const text = '# 框架\n\n- run：`{{runId}}`\n\n请用{{language}}回答。'
    const out = migrateTemplate(text)
    assert.deepEqual(out.removed, [])
    assert.equal(out.changed, false)
    assert.equal(out.next, text)
  })

  test('★ 真实的老模版（使用者存下来的那份）迁移后仍然是一份能用的框架', () => {
    // 这份是使用者实际存过的形状（执行档）
    const stored = [
      '# 任务',
      '',
      '{{instructions}}',
      '',
      '## 要做的事',
      '',
      '{{prompt}}',
      '',
      '{{#skills}}',
      '能用到的技能：{{skills}}',
      '{{/skills}}',
      '',
      '{{#tools}}',
      '## 干活时能用的工具包',
      '',
      '{{tools}}',
      '{{/tools}}',
      '',
      '请用{{language}}回答。',
      '',
      '## 护栏',
      '',
      '- 只做上面描述的事，不要扩大范围。',
    ].join('\n')
    const out = migrateTemplate(stored)
    assert.deepEqual(out.removed, ['instructions', 'prompt', 'tools'])
    assert.equal(validateTemplate('execute', 'frame', out.next).ok, true)
    assert.match(out.next, /## 要做的事/, '结构还在（只是里面不再由模版插值）')
    assert.match(out.next, /## 护栏/)
  })
})

// ══════════════════════════════════════════════════════════════════
// 2026-10：三块各有一个模版框——渲染行为
// ══════════════════════════════════════════════════════════════════

describe('第一句话：② 身份框 / ③ 任务框（三框渲染行为）', () => {
  test('★ 身份框默认 = {{identity}}：渲染出 ② 整块，逐字不变', () => {
    const blocks = buildBlocks(SAMPLE_EXECUTE_INPUT)
    assert.equal(blocks.identity, EXECUTE_IDENTITY)
    // 显式写同一份也一样
    const explicit = buildBlocks({
      ...SAMPLE_EXECUTE_INPUT,
      template: { identity: '{{identity}}' },
    })
    assert.equal(explicit.identity, EXECUTE_IDENTITY)
  })

  test('★ 身份框可以自己写标题与前后文字', () => {
    const blocks = buildBlocks({
      ...SAMPLE_EXECUTE_INPUT,
      template: { identity: '## 你的角色\n\n{{identity}}\n\n（这是平台组装的身份）' },
    })
    assert.equal(
      blocks.identity,
      `## 你的角色\n\n${EXECUTE_IDENTITY}\n\n（这是平台组装的身份）`,
    )
  })

  test('★ 身份框写死固定文本（不放变量）⇒ 指令不进 ②（作者自控）', () => {
    const blocks = buildBlocks({
      ...SAMPLE_EXECUTE_INPUT,
      template: { identity: '我固定这么说。' },
    })
    assert.equal(blocks.identity, '我固定这么说。')
    assert.ok(!blocks.identity.includes('严谨的协作者'), '指令没被插进来')
  })

  test('★ 任务框默认 = {{task}}：渲染出 ③ 整块，逐字不变', () => {
    const blocks = buildBlocks(SAMPLE_EXECUTE_INPUT)
    assert.equal(blocks.task, EXECUTE_TASK)
  })

  test('★ 任务框可以自己写标题；任务正文仍由平台放进 ③', () => {
    const blocks = buildBlocks({
      ...SAMPLE_EXECUTE_INPUT,
      template: { task: '## 你要做的是\n\n{{task}}\n\n（任务在上面的框架里）' },
    })
    assert.equal(
      blocks.task,
      `## 你要做的是\n\n${EXECUTE_TASK}\n\n（任务在上面的框架里）`,
    )
    // 任务正文仍然在 ③ 里（平台组装，不因标题改动而丢）
    assert.ok(blocks.task.includes('冒泡排序'))
  })

  /*
   * ⚠️ 2026-11（D125）：这里原来还有两条「材料与标记只在 ③，绝不进 ①」的用例
   *   （报告摄取的第三方材料进上下文时的那道防线）。报告摄取退场 ⇒ 删；
   *   那条纪律仍然写在 `taskBlock` 的注释里。
   */

  test('★ 身份/任务框空着时（= 平台默认）与改造前逐字节相同', () => {
    const plain = buildBlocks(SAMPLE_EXECUTE_INPUT)
    const boxed = buildBlocks({ ...SAMPLE_EXECUTE_INPUT, template: {} })
    assert.deepEqual(boxed, plain)
  })
})

// ══════════════════════════════════════════════════════════════════
// 绕过校验（不该发生，但要说清）
// ══════════════════════════════════════════════════════════════════

describe('第一句话：绕过校验直接塞坏模版', () => {
  test('★ 渲染期遇到不认识的变量 ⇒ 明确失败，而不是渲染出半截文本', () => {
    // 走到这里说明库里存着一条没通过校验的模版。宁可让 run 明确失败并说清原因，
    // 也不要渲染出半截文本——那会表现成"模型乱答"，排查方向会指向模型。
    assert.throws(
      () =>
        buildBlocks({
          ...SAMPLE_EXECUTE_INPUT,
          template: { frame: '# 框架\n\n{{nosuch}}' },
        }),
      (err: unknown) => err instanceof TemplateInvalidError,
    )
  })

  test('★ 身份/任务框里塞坏模版同样明确失败（三个框都过同一道关）', () => {
    assert.throws(
      () =>
        buildBlocks({
          ...SAMPLE_EXECUTE_INPUT,
          template: { identity: '{{nosuch}}' },
        }),
      (err: unknown) => err instanceof TemplateInvalidError,
    )
    assert.throws(
      () =>
        buildBlocks({
          ...SAMPLE_EXECUTE_INPUT,
          template: { task: '{{nosuch}}' },
        }),
      (err: unknown) => err instanceof TemplateInvalidError,
    )
  })
})

// ══════════════════════════════════════════════════════════════════
// 哪条 run 用哪份模版（分批第 210 批：判据只有一处）
// ══════════════════════════════════════════════════════════════════

describe('firstSentenceKindFor：三份模版，没有第四份给沉淀', () => {
  test('★★ 沉淀与对话走**同一份**聊天模版（它不是第三种链路）', () => {
    assert.equal(
      firstSentenceKindFor({ kind: 'execute', subject: { type: 'skill-draft' } }),
      'chat',
    )
    assert.equal(
      firstSentenceKindFor({ kind: 'execute', subject: { type: 'conversation' } }),
      'chat',
    )
  })

  test('★ 派活走任务那份（别把聊天那份灌进派活的链）', () => {
    assert.equal(firstSentenceKindFor({ kind: 'execute', subject: { type: 'issue' } }), 'execute')
    assert.equal(firstSentenceKindFor({ kind: 'execute', subject: { type: 'run' } }), 'execute')
    /*
     * ⚠️ 2026-11（D125）：这里原来还有
     *   `firstSentenceKindFor({ kind: 'review', subject: { type: 'run' } }) === 'review'`。
     *   审核 run 退场 ⇒ 那条断言删（现在没有 `kind: 'review'` 这种 run）。
     */
  })

  test('★ 判据只看种类与 subject 类型（不看 prompt 内容，也不看有没有技能）', () => {
    // 同一种 subject 永远同一份模版——否则"这条 run 到底被交代了什么"要靠猜。
    assert.equal(firstSentenceKindFor({ kind: 'execute', subject: { type: 'skill-draft' } }), 'chat')
    assert.equal(firstSentenceKindFor({ kind: 'execute', subject: { type: 'skill-draft' } }), 'chat')
  })

  test('★ 编排链路（2026-11）：workflow 标记 → 编排模版（优先于执行/聊天）', () => {
    // 编排 run（issue source = workflow）——用编排模版
    assert.equal(
      firstSentenceKindFor({ kind: 'execute', subject: { type: 'issue' } }, { workflow: true }),
      'workflow',
    )
    // 没标记 = 照旧（组/任务）
    assert.equal(
      firstSentenceKindFor({ kind: 'execute', subject: { type: 'issue' } }),
      'execute',
    )
    // 编排模版默认存在（框架+身份+任务）
    assert.ok((DEFAULT_TEMPLATES.workflow.frame ?? '').length > 0)
    assert.equal(DEFAULT_TEMPLATES.workflow.identity, '{{identity}}')
    assert.equal(DEFAULT_TEMPLATES.workflow.task, '{{task}}')
  })
})

// ══════════════════════════════════════════════════════════════════
// 「经验」（分批第 240 批）：记忆进第一句话的位置与从属声明
// ══════════════════════════════════════════════════════════════════

describe('第一句话：「经验」那一块', () => {
  const MEMORY = [
    { kind: 'commitment' as const, text: '报告里不许出现"赋能"这类词' },
    { kind: 'fact' as const, text: '这个仓库跑测试用 pnpm' },
  ]

  test('★★ 记忆接在 ②（身份）后面、③（任务）之前——人设是人定的，记忆是长出来的', () => {
    const blocks = buildBlocks({ ...SAMPLE_EXECUTE_INPUT, memory: MEMORY })
    assert.match(blocks.identity, /你是一个严谨的协作者/, '② 里先是人设')
    assert.match(blocks.identity, /过去记下的经验/, '然后才是经验')
    assert.ok(
      blocks.identity.indexOf('你是一个严谨的协作者') < blocks.identity.indexOf('过去记下的经验'),
      '顺序：人设 → 经验',
    )
    assert.doesNotMatch(blocks.task, /过去记下的经验/, '经验不进 ③')
    assert.doesNotMatch(blocks.frame, /过去记下的经验/, '经验也不进 ①')
  })

  test('★★ 经验自带从属声明：可能过时、与身份/任务冲突时以它们为准', () => {
    const blocks = buildBlocks({ ...SAMPLE_EXECUTE_INPUT, memory: MEMORY })
    assert.match(blocks.identity, /可能已经过时/)
    assert.match(blocks.identity, /以它们为准/)
  })

  test('★★ 每行带类型标记（约定 / 事实），而且顺序与注入顺序一致', () => {
    const blocks = buildBlocks({ ...SAMPLE_EXECUTE_INPUT, memory: MEMORY })
    const commitment = blocks.identity.indexOf('- [约定] 报告里不许出现')
    const fact = blocks.identity.indexOf('- [事实] 这个仓库跑测试用 pnpm')
    assert.ok(commitment > 0 && fact > 0, '两条都在')
    assert.ok(commitment < fact, '约定排在事实前面')
  })

  test('★ 没有记忆 ⇒ ② 与原来逐字节相同（这一块整块不出现）', () => {
    const withNone = buildBlocks({ ...SAMPLE_EXECUTE_INPUT, memory: [] })
    const without = buildBlocks(SAMPLE_EXECUTE_INPUT)
    assert.equal(withNone.identity, without.identity)
    assert.equal(withNone.identity, EXECUTE_IDENTITY)
  })

  /*
   * ⚠️ 2026-11（D125）：这里原来是「审核档也会带上审核者自己的记忆」。审核链路退场
   *   ⇒ 删。记忆进 ② 的逻辑与档位无关（`identityBlock` 一处实现），上面那条
   *   「没有记忆 ⇒ ② 逐字节相同」已经钉住了它。
   */

  test('★★ 记忆里写 `{{verdict}}` 也原样落地（它走的是「值」的通道，不进解析器）', () => {
    const blocks = buildBlocks({
      ...SAMPLE_EXECUTE_INPUT,
      memory: [{ kind: 'fact' as const, text: '注意 {{verdict}} 这几个字' }],
    })
    assert.match(blocks.identity, /\{\{verdict\}\}/, '原样那几个字')
    assert.doesNotMatch(blocks.identity, /"verdict"/, '没有把判决契约插进来')
  })
})
