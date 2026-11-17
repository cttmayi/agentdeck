/**
 * **编排生成者的领域逻辑**（2026-11，设计 `docs/tmp/workflow-maker-design.md`）。
 *
 * 与 `agent-maker.ts` 同构、同一条分工：这里只管"草稿怎么解析、代码怎么校验"，
 * 起 run / 落库在 `server.ts` 的两条路由里（读草稿 / 采纳）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 产物是什么
 * ══════════════════════════════════════════════════════════════════
 *
 * 编排生成者在聊天里把"要什么流程"问清楚，然后把**编排代码**写进工作目录的
 * `workflow-draft/` 目录（与 `agent-draft/` 同一条纪律：一个生成产物一个目录，
 * 不散在工作目录顶层与别的文件混在一起）：
 *
 *   workflow-draft/
 *     workflow-draft.md    ← frontmatter `name`（+ 可选 `summary`），正文 = 编排代码
 *
 * 正文允许包在 ```js 围栏里（聊天里贴代码天然带围栏）——解析时剥掉。
 *
 * ══════════════════════════════════════════════════════════════════
 * 采纳前校验三道（使用者拍板："语法 + 节点名"）
 * ══════════════════════════════════════════════════════════════════
 *
 *   ① **语法**：用与引擎**同一条构造路径**（`AsyncFunction`）**只编译不执行**
 *      ——采纳一个语法错的编排，代价是使用者点「运行」时才看见"SyntaxError"；
 *   ② **节点名**：代码里 `agent('名字')` 引用的名字必须是**现有智能体**
 *      （引擎在提交那一步找不到人只会让整条跑挂，而那时候已经烧了一条 run）；
 *   ③ **名字**：frontmatter 的 `name` 非空、≤100。
 *
 * ⚠️ ② 只做**保守的静态提取**（正则抓字面量）——`agent(某个变量)` 这种拼出来的引用
 *    数不清，落进 `unverifiable`（响应里如实带出去），**不拒绝**。宁可少校验，
 *    也不要把好好的代码拒掉（"名字是拼出来的"在编排里很常见，比如按模块名循环）。
 */

/** 生成产物包目录（生成者写 `workflow-draft/`，确认路由与界面都认这个名字）。 */
export const WORKFLOW_DRAFT_DIR = 'workflow-draft'

/** 草稿文件名（在 `workflow-draft/` 目录内）。 */
export const WORKFLOW_DRAFT_FILE = 'workflow-draft.md'

/** 编排代码里允许出现的原语（与引擎 `AsyncFunction` 的参数表一字不差）。 */
export const WORKFLOW_PRIMITIVES = ['agent', 'gate', 'flow', 'parallel', 'loop', 'route'] as const

/** 解析结果：失败给 `error`（界面据此说清哪里不对，不猜）。 */
export type WorkflowDraftParsed =
  | { ok: true; name: string; summary: string; code: string }
  | { ok: false; error: string }

const stripQuotes = (raw: string): string => {
  const t = raw.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

/** 剥掉包着整段代码的 ```lang … ``` 围栏（聊天里贴代码天然带它）。 */
function stripFence(body: string): string {
  const trimmed = body.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const lines = trimmed.split('\n')
  if (lines.length < 2) return trimmed
  const closing = lines[lines.length - 1]!.trim()
  if (closing !== '```') return trimmed
  return lines.slice(1, -1).join('\n').trim()
}

/**
 * 解析草稿：frontmatter 的 `name`（+ 可选 `summary`）+ 正文（= 代码，可带围栏）。
 *
 * 与 `parseAgentDraft` 同一套极简 frontmatter 规则（`---` 头块、必须闭合、必须第一行）：
 * 前面多一行就是"草稿没被认出来"，而那种失败在界面上表现为"按钮不出现"。
 */
export function parseWorkflowDraft(text: string): WorkflowDraftParsed {
  const trimmed = text.replace(/^\uFEFF/, '').trimStart()
  if (!trimmed.startsWith('---')) {
    return { ok: false, error: 'frontmatter 必须在第一行（现在开头不是 `---`）' }
  }
  const end = trimmed.indexOf('\n---', 3)
  if (end < 0) {
    return { ok: false, error: 'frontmatter 没有闭合（缺少第二个 `---`）' }
  }
  const head = trimmed.slice(3, end)
  let name = ''
  let summary = ''
  for (const line of head.split('\n')) {
    const mName = line.match(/^name\s*:\s*(.+)$/)
    if (mName?.[1]) name = stripQuotes(mName[1].trim())
    const mSummary = line.match(/^summary\s*:\s*(.+)$/)
    if (mSummary?.[1]) summary = stripQuotes(mSummary[1].trim())
  }
  const code = stripFence(trimmed.slice(end + 4))
  if (name === '') return { ok: false, error: 'frontmatter 缺少 `name`（编排名，如"周报流水线"）' }
  if (name.length > 100) return { ok: false, error: '编排名太长了（上限 100 字符）' }
  if (code === '') return { ok: false, error: '没有编排代码（frontmatter 之后应当就是代码）' }
  return { ok: true, name, summary, code }
}

/** 校验结果：`unknown` 是**确定有问题**的引用，`unverifiable` 是数不清的（放行但如实说）。 */
export interface WorkflowCodeCheck {
  ok: boolean
  /** 语法错误（有就是硬失败）。 */
  syntaxError: string | null
  /** 代码里引用了、但智能体里不存在的名字（硬失败）。 */
  unknownAgents: string[]
  /** 拼出来的引用（`agent(变量)`）有多少处——放行，但界面上要说一句。 */
  unverifiable: number
}

/**
 * 校验编排代码：语法 + 节点名（使用者拍板"语法 + 节点名"）。
 *
 * @param code        编排代码
 * @param agentNames  现有智能体的名字（引擎在提交那一步就是按名字找人的）
 *
 * ⚠️ 语法检查用 `new AsyncFunction(...)` **只构造不调用**：与 `engine.ts` 里执行用户
 *    代码是同一条构造路径，所以"这里过了、运行时炸"这件事不会发生；而且不调用 ⇒
 *    不提交任何 run（NFR-T-01）。
 */
export function validateWorkflowCode(
  code: string,
  agentNames: readonly string[],
): WorkflowCodeCheck {
  const check: WorkflowCodeCheck = { ok: true, syntaxError: null, unknownAgents: [], unverifiable: 0 }

  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => unknown
    // eslint-disable-next-line no-new -- 只构造不调用：语法错误在这一步抛出来
    new AsyncFunction(...WORKFLOW_PRIMITIVES, code)
  } catch (err) {
    check.ok = false
    check.syntaxError = err instanceof Error ? err.message : String(err)
    return check
  }

  // ── 节点名：只抓 `agent('字面量')`；`agent(变量)` 数不清，记成 unverifiable ──
  const literal = /agent\s*\(\s*(['"])([^'"]*)\1\s*[,)]/g
  const seen = new Set<string>()
  for (const m of code.matchAll(literal)) {
    const name = m[2]!.trim()
    if (name === '') continue
    seen.add(name)
  }
  const known = new Set(agentNames)
  for (const name of seen) {
    if (!known.has(name)) check.unknownAgents.push(name)
  }
  if (check.unknownAgents.length > 0) check.ok = false

  // 拼出来的引用：`agent(` 后面不是引号的那些
  const total = [...code.matchAll(/agent\s*\(/g)].length
  check.unverifiable = Math.max(0, total - seen.size)
  return check
}

/** 读草稿产物（工作目录 → 目录内那个文件）；没有就 `null`。 */
export async function readWorkflowDraft(dir: string): Promise<{
  text: string | null
} & WorkflowDraftParsed> {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  let text: string
  try {
    text = await readFile(join(dir, WORKFLOW_DRAFT_DIR, WORKFLOW_DRAFT_FILE), 'utf8')
  } catch {
    return { text: null, ok: false, error: '还没有草稿' }
  }
  return { text, ...parseWorkflowDraft(text) }
}
