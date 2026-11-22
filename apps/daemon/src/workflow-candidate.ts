/**
 * **候选编排**：读聊天工作目录里的 `workflow-draft/<名字>/`，校验，给界面用（2026-11，D255）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么产物是"目录"而不是一张草稿 md
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者：「在聊天的工作目录生成**存储的格式**，等人点确认后再入库」。
 * 于是生成者写的就是**存储同构**的东西：
 *
 *   workflow-draft/<编排名>/
 *     workflow.json      { name, summary }
 *     main.js            编排代码（= Workflow.code）
 *     agents/<名字>/     agent.json + instructions.md（+ 自己的 skills/**）
 *
 * 入库 = **校验 + 整目录搬 + 补字段**（`workflow-adopt.ts`）。不解析自定义格式、
 * 不做"草稿 md → 目录"的翻译（翻译就有两处形状要同步）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 校验的两条纪律（都是从这一族的老坑里抄的）
 * ══════════════════════════════════════════════════════════════════
 *
 *   1. **宁可少校验，也不要把好好的东西拒掉**：数不清的（`agent(变量)`）记成
 *      `warn` 放行，只有确定错的才 `error`（语法错、引用了不存在的内建人、
 *      调用了不存在的原语）。`warn` 也让入库通过。
 *   2. **入库时再算一遍**：界面那份是预检（每轮结束顺手跑），服务端在采纳那一步
 *      重新校验——UI 只是省一次往返，不是判据。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { WORKFLOW_DRAFT_DIR, WORKFLOW_PRIMITIVES } from './workflow-maker.ts'

/** 一个 candidate 只由目录名标识（人点的是那个子目录）。 */
export interface WorkflowCandidateAgent {
  /** 名字（= 目录名；生成者的写法）。 */
  name: string
  /** 指令前两行（卡片上给人看"这个人是谁"）。 */
  instructionsPreview: string
  /** 自己带的技能名（`skills/<名字>/SKILL.md`）。 */
  skills: string[]
}

/** 一条问题：`error` 挡住入库，`warn` 只提示。 */
export interface WorkflowCandidateProblem {
  level: 'error' | 'warn'
  message: string
}

/** 预检结果（也直接进对话详情给界面用）。 */
export interface WorkflowCandidate {
  /** 子目录名（入库时原样传回）。 */
  dir: string
  name: string
  summary: string
  agents: WorkflowCandidateAgent[]
  problems: WorkflowCandidateProblem[]
  /** 绝对路径（"打开目录"用；不含它界面就没法把文件夹递给操作系统）。 */
  absDir: string
  /** 代码行数（卡片上"这有多长"用；读不到是 0）。 */
  codeLines: number
}

/** 人数软上限：超了不拒，只在卡片上说一句（使用者拍板）。 */
export const AGENT_SOFT_LIMIT = 8

/** 编排生成者的产物目录里，一个候选 = 一个**目录**（`workflow-draft.md` 那种老文件不算）。 */
export async function listCandidateDirs(workDir: string): Promise<string[]> {
  const root = join(workDir, WORKFLOW_DRAFT_DIR)
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return [] // 还没有生成产物 ≠ 出错
  }
  const out: string[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    try {
      if ((await stat(join(root, name))).isDirectory()) out.push(name)
    } catch {
      // 读不到就跳过（坏一条不牵连别的）
    }
  }
  out.sort((a, b) => a.localeCompare(b))
  return out
}

/**
 * 读一个候选并校验它。
 *
 * 不抛错：读不到的东西一律变成 `problems` 里的一条 `error`（界面据此说清"哪里不对"）。
 */
export async function readCandidate(workDir: string, dir: string): Promise<WorkflowCandidate> {
  const absDir = join(workDir, WORKFLOW_DRAFT_DIR, dir)
  const problems: WorkflowCandidateProblem[] = []
  const agents: WorkflowCandidateAgent[] = []
  let name = ''
  let summary = ''
  let code = ''

  // ── ① workflow.json ──
  try {
    const raw = await readFile(join(absDir, 'workflow.json'), 'utf8')
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (err) {
      problems.push({
        level: 'error',
        message: `workflow.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
      })
      json = null
    }
    if (json !== null) {
      const obj = json as Record<string, unknown>
      name = typeof obj['name'] === 'string' ? obj['name'].trim() : ''
      summary = typeof obj['summary'] === 'string' ? obj['summary'].trim() : ''
      if (name === '') problems.push({ level: 'error', message: 'workflow.json 缺 `name`（编排名）' })
      else if (name.length > 100)
        problems.push({ level: 'error', message: `编排名太长（${name.length} 字，上限 100）` })
    }
  } catch {
    problems.push({ level: 'error', message: '缺 `workflow.json`（编排名与一句话说明写在这里）' })
  }

  // ── ② main.js ──
  try {
    code = await readFile(join(absDir, 'main.js'), 'utf8')
  } catch {
    problems.push({ level: 'error', message: '缺 `main.js`（编排代码）' })
  }

  // ── ③ agents/<名字>/ ──
  let agentDirs: string[] = []
  try {
    agentDirs = (await readdir(join(absDir, 'agents'))).filter((d) => !d.startsWith('.'))
  } catch {
    agentDirs = [] // 一个内建人都没有也合法（纯 gate 的编排）
  }
  /**
   * ★ 2026-11（D262）：**有没有人负责交付**（原则 1，`material/orchestration/principles.md`）。
   *
   * 判据是一个**写明的约定**：那个人 `instructions.md` 里单独一行 `落盘：<文件名>`。
   * 为什么用约定而不是猜代码：静态看代码猜不出"哪一步的产出会写成文件"，而"有没有人写文件"
   * 恰是这次翻车的根（文章只活在 run 日志里）。
   */
  let hasDeliverable = false
  for (const agentDir of agentDirs) {
    const base = join(absDir, 'agents', agentDir)
    try {
      if (!(await stat(base)).isDirectory()) continue
    } catch {
      continue
    }
    let instructions = ''
    try {
      instructions = await readFile(join(base, 'instructions.md'), 'utf8')
      if (/^\s*落盘[:：]\s*\S/m.test(instructions)) hasDeliverable = true
    } catch {
      problems.push({ level: 'error', message: `内建智能体「${agentDir}」缺 instructions.md` })
    }
    if (instructions.trim() === '' && instructions !== '') {
      problems.push({ level: 'error', message: `内建智能体「${agentDir}」的 instructions.md 是空的` })
    }
    // agent.json 可缺（名字就是目录名）；有就要求名字与目录一致
    try {
      const raw = await readFile(join(base, 'agent.json'), 'utf8')
      const obj = JSON.parse(raw) as Record<string, unknown>
      const declared = typeof obj['name'] === 'string' ? obj['name'].trim() : ''
      if (declared !== '' && declared !== agentDir) {
        problems.push({
          level: 'error',
          message: `内建智能体目录叫「${agentDir}」，但 agent.json 里的 name 是「${declared}」（两者要一致）`,
        })
      }
    } catch {
      // 没有 agent.json = 用目录名，合法
    }
    // 自己带的技能
    const skills: string[] = []
    try {
      for (const s of await readdir(join(base, 'skills'))) {
        if (s.startsWith('.')) continue
        try {
          const body = await readFile(join(base, 'skills', s, 'SKILL.md'), 'utf8')
          skills.push(s)
          if (!/^---\s*$/m.test(body) || !/\bname\s*:/.test(body) || !/\bdescription\s*:/.test(body)) {
            problems.push({
              level: 'error',
              message: `「${agentDir}」的技能 \`${s}/SKILL.md\` 缺 frontmatter（name / description）`,
            })
          }
        } catch {
          problems.push({
            level: 'error',
            message: `「${agentDir}」的技能目录 \`skills/${s}/\` 里没有 SKILL.md`,
          })
        }
      }
    } catch {
      // 没有 skills/ 目录 = 这个人不带自己的技能，合法
    }
    const preview = instructions
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .slice(0, 2)
      .join(' / ')
    agents.push({ name: agentDir, instructionsPreview: preview, skills })
  }

  if (agents.length > AGENT_SOFT_LIMIT) {
    problems.push({
      level: 'warn',
      message: `这条编排有 ${agents.length} 个人（超过 ${AGENT_SOFT_LIMIT} 个）：考虑拆成两条编排，一条流程里的人太多时不好排查`,
    })
  }

  /**
   * ⚠️ 只作 **warn**：一条纯研究的编排可能真的不需要文件（人只想看一段话），拒掉会误伤；
   *   但卡片上必须写着"这条编排没有交付物落盘"，让收的人知道自己在收什么。
   */
  if (agents.length > 0 && !hasDeliverable) {
    problems.push({
      level: 'warn',
      message:
        '这条编排没有任何人负责**把产出落成文件**：`agents/` 里没有一份 instructions 写了 `落盘：<文件名>`。' +
        '运行完之后正文只会停在 run 日志里，工作目录里不会有文件（原则 1，见 `material/orchestration/principles.md`）。',
    })
  }

  // ── ④ 代码：语法 + 只引用这里的人 + 只调用六个原语 ──
  if (code.trim() !== '') {
    const inlineNames = new Set(agents.map((a) => a.name))
    const check = checkCandidateCode(code, inlineNames)
    if (check.syntaxError !== null) {
      problems.push({ level: 'error', message: `main.js 有语法错误：${check.syntaxError}` })
    }
    for (const unknown of check.unknownAgents) {
      problems.push({
        level: 'error',
        message: `\`agent('${unknown}')\` 在 \`agents/\` 下没有这个人——要么改名，要么在 \`agents/${unknown}/\` 给他写一份 instructions.md`,
      })
    }
    for (const bad of check.unknownCalls) {
      problems.push({
        level: 'error',
        message: `\`${bad}(…)\` 不是编排原语（作用域里只有：${WORKFLOW_PRIMITIVES.join(' / ')}）`,
      })
    }
    if (check.topLevelReturns > 0) {
      problems.push({
        level: 'warn',
        message:
          `代码里有 ${check.topLevelReturns} 处 \`return\`：**返回值不会出现在任何地方**（平台执行完就丢掉，「main.js」不是一个"返回结果"的函数）——loop / flow 的结果都保留在**步骤里**。那段拼出来的字用不上就删掉，要用就让它成为某一步的产出（再挂一个人把结论写出来）。`,
      })
    }
    if (check.unverifiable > 0) {
      problems.push({
        level: 'warn',
        message: `有 ${check.unverifiable} 处 \`agent(变量)\` 的引用是拼出来的，平台没法静态核对名字（运行时才解析）`,
      })
    }
  }

  return {
    dir,
    name: name === '' ? dir : name,
    summary,
    agents,
    problems,
    absDir,
    codeLines: code === '' ? 0 : code.split('\n').length,
  }
}

/** `readCandidate` 的批量版（按目录名排）。 */
export async function readCandidates(workDir: string): Promise<WorkflowCandidate[]> {
  const dirs = await listCandidateDirs(workDir)
  const out: WorkflowCandidate[] = []
  for (const dir of dirs) out.push(await readCandidate(workDir, dir))
  return out
}

/* ══════════════════════════════════════════════════════════════════
 * 代码校验（与 engine 同一条构造路径）
 * ══════════════════════════════════════════════════════════════════ */

export interface CandidateCodeCheck {
  syntaxError: string | null
  /** 引用了、但 `agents/` 下没有的名字。 */
  unknownAgents: string[]
  /** 调用了、但不是六个原语的名字（`inline`、`Flow` 这种拼错/不存在的）。 */
  unknownCalls: string[]
  /** `agent(变量)` 的处数（放行，只提示）。 */
  unverifiable: number
  /**
   * 顶层 `return` 的处数（★ 2026-11，D261）。
   *
   * 引擎执行用户代码是 `await fn(...)`——**返回值被丢掉**（`engine.ts`）。也就是说
   * `main.js` 里 `return '…'` 拼出来的那段话**谁也不会看到**：编排的产出是每一步 run 的产出，
   * 按步骤列在运行画面上。
   *
   * 踩到的真机例子（使用者贴出来的生成结果）：生成者把"两轮审校未通过 ⚠️ … 审校意见 …"
   * 拼成一段字符串 `return` 出去 —— 两个分支都只是拼这段没人看的字，整段 `if` 是死代码。
   * 这类"看起来在交付、其实什么也没发生"的写法必须提示出来，否则使用者只会觉得
   * "编排跑完了，但我没看到它说的那句提醒"。
   */
  topLevelReturns: number
}

/** 作用域里合法的"全局"（JS 自带的那几个），除此之外的标识符调用都算可疑。 */
const JS_GLOBALS = new Set([
  'Array','Object','String','Number','Boolean','Promise','Math','JSON','Date','Map','Set','WeakMap','WeakSet',
  'RegExp','Error','TypeError','RangeError','Symbol','BigInt','Reflect','Proxy','Intl','URL','URLSearchParams',
  'parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent','structuredClone',
  'console','setTimeout','clearTimeout','setInterval','clearInterval','queueMicrotask','fetch',
])

/** 关键字里长得像调用的那几个（`if (` / `for (` / `while (` …）——不许当成未定义调用。 */
const KEYWORDS = new Set([
  'if','for','while','switch','catch','function','return','typeof','instanceof','in','of','new','do','else',
  'await','async','yield','delete','void','throw','case','try','finally','class','super','this','import','export',
])

/** 去掉字符串与注释（只为了"扫标识符"这一步不被文本里的字骗到）。 */
function stripStringsAndComments(code: string): string {
  let out = ''
  let i = 0
  const n = code.length
  while (i < n) {
    const c = code[i]!
    const next = code[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && code[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      i++
      while (i < n) {
        if (code[i] === '\\') {
          i += 2
          continue
        }
        if (code[i] === quote) {
          i++
          break
        }
        i++
      }
      out += '""'
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * 顶层 `return` 的处数（D261）：**交给平台而平台不要的那几个**。
 *
 * 判据不是"花括号深度"——`if (…) { return … }` 的深度也是 1，可它仍然是编排函数体的
 * 返回值（第一版就这么写，于是把使用者贴的那段代码数成了 1 处而不是 2 处）。
 * 正确的口径是"**在不在嵌套函数里**"：函数体（`function (…) {` / `(…) => {`）里的
 * `return` 归那个函数，正常；其余（顶层、`if` / `for` / `try` 块里）都归编排、
 * 而引擎 `await fn(...)` 之后**把返回值丢掉**。
 *
 * `cleaned` 已经把字符串与注释换掉，所以这里只需要认 `=>` / `function` / `{` / `}`。
 */
function countTopLevelReturns(cleaned: string): number {
  const fnDepth: boolean[] = []
  let count = 0
  let pendingArrow = false
  let pendingFunction = false
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]!
    const prev = cleaned[i - 1] ?? ''
    if (ch === '=' && cleaned[i + 1] === '>') {
      pendingArrow = true
      i += 1
      continue
    }
    if (ch === '{') {
      fnDepth.push(pendingArrow || pendingFunction)
      pendingArrow = false
      pendingFunction = false
      continue
    }
    if (ch === '}') {
      fnDepth.pop()
      continue
    }
    if (/[\w$]/.test(prev)) continue
    if (ch === 'r' && /^return\b/.test(cleaned.slice(i, i + 6))) {
      if (!fnDepth.some(Boolean)) count += 1
      i += 5
      continue
    }
    if (ch === 'f' && /^function\b/.test(cleaned.slice(i, i + 8))) {
      pendingFunction = true
      i += 7
    }
  }
  return count
}

/** 收集代码里"定义了"的名字：const/let/var/function/class + 解构 + 参数 + catch 参数。 */
function declaredNames(code: string): Set<string> {
  const out = new Set<string>()
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]!)
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const name = part.split(':').pop()?.trim().replace(/=.*$/, '').trim() ?? ''
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name)
    }
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const name = part.trim().replace(/=.*$/, '').trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name)
    }
  }
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]!)
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]!)
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]!)
  // 参数：`(a, b) =>` / `function (a)` / `function name(a)` / `x => ...`
  for (const m of code.matchAll(/(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*=>/g)) {
    for (const part of (m[1] ?? m[2] ?? '').split(',')) {
      const name = part.split('=')[0]?.trim() ?? ''
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name)
    }
  }
  for (const m of code.matchAll(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const name = part.split('=')[0]?.trim() ?? ''
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name)
    }
  }
  return out
}

/**
 * 校验一段候选编排代码。
 *
 * 与引擎**同一条构造路径**（`AsyncFunction(...primitives, code)` 只构造不调用）：
 * 所以"这里过了、跑起来炸"只可能剩下语义问题，不会是语法问题。
 */
export function checkCandidateCode(code: string, inlineNames: ReadonlySet<string>): CandidateCodeCheck {
  const out: CandidateCodeCheck = {
    syntaxError: null,
    unknownAgents: [],
    unknownCalls: [],
    unverifiable: 0,
    topLevelReturns: 0,
  }
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => unknown
    // eslint-disable-next-line no-new -- 只构造不调用：语法错误在这一步抛出来
    new AsyncFunction(...WORKFLOW_PRIMITIVES, code)
  } catch (err) {
    out.syntaxError = err instanceof Error ? err.message : String(err)
    return out
  }

  const cleaned = stripStringsAndComments(code)

  // ① `agent('字面量')` 的名字必须在本编排的 agents/ 里
  const literal = /agent\s*\(\s*(['"])([^'"]*)\1/g
  const seen = new Set<string>()
  let literalCount = 0
  for (const m of code.matchAll(literal)) {
    const nm = (m[2] ?? '').trim()
    if (nm === '') continue
    literalCount += 1
    seen.add(nm)
  }
  for (const nm of seen) if (!inlineNames.has(nm)) out.unknownAgents.push(nm)

  // ② `agent(` 里不是字面量的那些：数得清"有几处"，数不清"是谁"
  const totalAgentCalls = [...cleaned.matchAll(/\bagent\s*\(/g)].length
  out.unverifiable = Math.max(0, totalAgentCalls - literalCount)

  // ③ 标识符调用只许是六个原语（或代码自己定义的 / 参数 / JS 自带的那几个）
  const declared = declaredNames(cleaned)
  const calls = new Set<string>()
  for (const m of cleaned.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const nm = m[2]!
    if (KEYWORDS.has(nm)) continue
    if ((WORKFLOW_PRIMITIVES as readonly string[]).includes(nm)) continue
    if (JS_GLOBALS.has(nm)) continue
    if (declared.has(nm)) continue
    calls.add(nm)
  }
  out.unknownCalls = [...calls].sort()
  out.topLevelReturns = countTopLevelReturns(cleaned)
  return out
}
