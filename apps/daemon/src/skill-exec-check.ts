/**
 * **可执行性定检**（分批第 20 批）：平台先把"能机械判定的事实"跑出来，再交给审核者。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一层为什么必须由平台做，而不是继续让审核者做
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者的一条真实链（`trace-topic-to-primary-source`，10 版 / $29.81）里量到两件事：
 *
 *   ① 同一份内容被审出**不同结论**：第 4 版 11:44 通过、12:36 通过、13:09 不通过，
 *      而 `SKILL.md` 的修改时间是 11:41:01——三审之间内容**一个字节都没动**。
 *      第 8 版更极端：3 分钟内 needs_human → 通过 → 不通过。原因是"审什么"全靠模型
 *      每轮自己找落脚点，而"脚本语法对不对""引用的文件在不在"这类问题**本来是确定性的**，
 *      不该由判断给出。
 *   ② 它的定检成本随轮次涨（单轮 $0.98 → $6.11），其中一大截花在重复做这些确定性检查上。
 *
 * 所以这一层只做**没有判断余地、不需要模型**的那部分：语法解析、引用文件是否存在、
 * 占位符有没有解释过、骨架是否齐全、有没有吞掉错误的写法。做成事实清单交给审核者；
 * 审核者的力气留给它真正不可替代的那部分（命令的参数与输入形态、反规避、步骤衔接）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 硬约束：**只解析，不执行**
 * ══════════════════════════════════════════════════════════════════
 *
 * 这里跑的三条命令全是**解析器**，都不会执行被检脚本的一行代码：
 *   · python：`ast.parse`（⚠️ **不用** `py_compile`——它会往被检目录里写 `__pycache__`，
 *     等于"检查动作改了现场"。使用者的草稿目录里就躺着 `scripts/__pycache__/`，
 *     那是审核者自己跑出来的，不是起草者写的）。
 *   · node：`node --check`（只解析）。实测 node 24.19：**带 `import` 的 `.js` 也过**
 *     ——所以这里**不加** ESM 回退分支（我原本准备写一个 `--input-type=module` 重试，
 *     实测多余；留着它是"永远不生效的分支"，本仓库第 5 条纪律点名不许留）。
 *   · bash：`bash -n`（noexec）。
 *
 * "真的跑一遍脚本"仍然由审核者做（它要真输入、要读输出判断行为），开关在工作区设置里
 * （`allowReviewerScriptRun`）。这一层做的只是"连解析都过不了"这种一票否决。
 *
 * ⚠️ **工具不存在时必须报"没查"，不许报通过**：把 `skipped` 混进 `ok` 会让"机器上没装
 *    python3"看起来像"脚本语法没问题"——那正是本仓库最恨的"看起来生效了"。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** 一项定检结果的性质。`note` = 只陈述事实、不判好坏（判定留给审核者）。 */
export type ExecCheckStatus = 'ok' | 'fail' | 'skipped' | 'note'

/** 检的是哪一类。名字是稳定的机器标识，给日志与测试用，不是给人看的句子。 */
export type ExecCheckKind =
  | 'skeleton'
  | 'script_syntax'
  | 'referenced_file'
  | 'placeholder'
  | 'error_swallowing'

export type ExecCheckItem = {
  kind: ExecCheckKind
  /** 位置：`文件` 或 `文件:行`（与判决里 `evidence.locator` 同一套写法） */
  target: string
  status: ExecCheckStatus
  /** 一句中文：判成这样**为什么**（`skipped` 必须说清"缺什么所以没查"） */
  detail: string
}

export type ExecCheckReport = {
  at: number
  skillDir: string
  items: ExecCheckItem[]
}

/**
 * 跑外部命令的口子（默认真的 spawn）。
 *
 * 留这个口子是为了**能测那条"工具不存在"的路**：真实世界里 `python3` 可能没装，
 * 而"没装"必须与"语法没问题"区分开（见文件头）。不给口子就只能靠环境碰运气，
 * 那条分支永远没人测——那正是"死接口"的来源。
 */
export type ExecCheckIo = {
  run?: (
    cmd: string,
    args: string[],
    opts: { cwd: string },
  ) => Promise<{ code: number | null; out: string }>
}

/** 脚本后缀 ⇒ 用哪个解析器（解析器缺了 ⇒ 这一项报 skipped 而不是 ok）。 */
const SCRIPT_TOOLS = {
  '.py': { tool: 'python3', kind: 'python' },
  '.js': { tool: 'node', kind: 'node' },
  '.mjs': { tool: 'node', kind: 'node' },
  '.cjs': { tool: 'node', kind: 'node' },
  '.sh': { tool: 'bash', kind: 'bash' },
} as const

/** 被检目录里要跳过的目录与文件（`__pycache__` 见文件头；`.git` 与编辑器残留同理）。 */
const SKIP_DIRS = new Set(['__pycache__', '.git', 'node_modules', '.claude'])

/**
 * 取一个文件里的围栏代码块与其余文字。
 *
 * 为什么两样都要：占位符检查要问"这个 `<ID1>` 只在代码块里出现过吗"——
 * 只在代码块里出现（而正文从没解释过）就是执行者不知道该填什么的那种缺陷。
 */
function splitFences(text: string): { code: string; prose: string } {
  const lines = text.split('\n')
  const code: string[] = []
  const prose: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    ;(inFence ? code : prose).push(line)
  }
  return { code: code.join('\n'), prose: prose.join('\n') }
}

/** 文件树（相对路径、已排序、跳过 `SKIP_DIRS`）。 */
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(join(dir, entry.name))
        continue
      }
      out.push(relative(root, join(dir, entry.name)))
    }
  }
  await walk(root).catch(() => undefined)
  return out.sort()
}

/** 默认的 spawn 实现（不在测试里走这条路：NFR-T-01 禁的是**真 CLI**，不是解析器）。 */
async function defaultRun(
  cmd: string,
  args: string[],
  opts: { cwd: string },
): Promise<{ code: number | null; out: string }> {
  const { spawn } = await import('node:child_process')
  return await new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { cwd: opts.cwd })
    } catch {
      resolve({ code: null, out: '无法启动这个命令' })
      return
    }
    let out = ''
    child.stdout?.on('data', (b: Buffer) => (out += b.toString()))
    child.stderr?.on('data', (b: Buffer) => (out += b.toString()))
    child.on('error', () => resolve({ code: null, out: '命令不存在或不可执行' }))
    child.on('close', (code) => resolve({ code, out }))
  })
}

/** 把多行输出压成一行（判决正文里塞整段 traceback 没有意义；要的是第一句原因）。 */
function firstReason(out: string): string {
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  const useful = lines.find((l) => /Error|error|invalid|unexpected/i.test(l)) ?? lines[0] ?? ''
  return useful.slice(0, 300)
}

/** 骨架：frontmatter 与两节标题（定稿里"缺了入库会被拒"的那几条）。 */
function checkSkeleton(text: string | null): ExecCheckItem[] {
  const target = 'SKILL.md'
  if (text === null) {
    return [{ kind: 'skeleton', target, status: 'fail', detail: '读不到 SKILL.md（产出目录里没有它）' }]
  }
  const items: ExecCheckItem[] = []
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)
  // ⚠️ `fm[1]` 在 `noUncheckedIndexedAccess` 下是 `string | undefined`：这是"下标访问"
  //    不是"解构"，得先落到局部变量再窄化（写成 `fm ? ... fm[1] : undefined` 过不了类型检查）。
  const frontmatter = fm?.[1]
  const name = frontmatter === undefined ? undefined : /^name:\s*(\S+)\s*$/m.exec(frontmatter)?.[1]
  const description =
    frontmatter === undefined ? undefined : /^description:\s*(.+)$/m.exec(frontmatter)?.[1]
  items.push(
    fm
      ? {
          kind: 'skeleton',
          target,
          status: name === undefined ? 'fail' : 'ok',
          detail:
            name === undefined
              ? 'frontmatter 里没有 name'
              : /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)
                ? `frontmatter 的 name 是 kebab-case：${name}`
                : `frontmatter 的 name 不是 kebab-case：${name}`,
        }
      : { kind: 'skeleton', target, status: 'fail', detail: '没有 frontmatter（文件开头不是 --- 包起来的元信息）' },
  )
  items.push({
    kind: 'skeleton',
    target,
    status: description === undefined ? 'fail' : 'ok',
    detail: description === undefined ? 'frontmatter 里没有 description' : 'frontmatter 里有 description',
  })
  for (const heading of ['## When to Use', '## Procedure']) {
    items.push({
      kind: 'skeleton',
      target,
      status: new RegExp(`^${heading}\\s*$`, 'm').test(text) ? 'ok' : 'fail',
      detail: new RegExp(`^${heading}\\s*$`, 'm').test(text) ? `有 ${heading} 这一节` : `缺 ${heading} 这一节`,
    })
  }
  return items
}

/** 脚本语法（每个脚本一条；解析器不存在 ⇒ skipped，见文件头）。 */
async function checkScripts(
  root: string,
  files: string[],
  run: NonNullable<ExecCheckIo['run']>,
): Promise<ExecCheckItem[]> {
  const items: ExecCheckItem[] = []
  const scripts = files.filter((f) => f.startsWith('scripts/'))
  const missingTool = new Set<string>()
  for (const file of scripts) {
    const ext = file.slice(file.lastIndexOf('.'))
    const tool = SCRIPT_TOOLS[ext as keyof typeof SCRIPT_TOOLS]
    if (tool === undefined) {
      items.push({
        kind: 'script_syntax',
        target: file,
        status: 'note',
        detail: '这个后缀平台没有解析器（只列出来，语法请人工看）',
      })
      continue
    }
    if (missingTool.has(tool.tool)) {
      items.push({
        kind: 'script_syntax',
        target: file,
        status: 'skipped',
        detail: `${tool.tool} 不存在（上面那条已经说明）⇒ 这一项**没有结论**，不许当成通过`,
      })
      continue
    }
    const args =
      tool.kind === 'python'
        ? // 只解析：不用 py_compile（它会写 __pycache__，等于检查动作改了被检目录）
          ['-c', 'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read(), sys.argv[1])', file]
        : tool.kind === 'node'
          ? ['--check', file]
          : ['-n', file]
    const r = await run(tool.tool, args, { cwd: root })
    if (r.code === null) {
      missingTool.add(tool.tool)
      items.push({
        kind: 'script_syntax',
        target: file,
        status: 'skipped',
        detail: `${tool.tool} 跑不起来（${firstReason(r.out)}）⇒ 这一项**没有结论**，不许当成通过`,
      })
      continue
    }
    items.push({
      kind: 'script_syntax',
      target: file,
      status: r.code === 0 ? 'ok' : 'fail',
      detail:
        r.code === 0
          ? `${tool.tool} 解析通过（只解析，没有执行这个脚本）`
          : `${tool.tool} 解析失败（退出码 ${r.code}）：${firstReason(r.out)}`,
    })
  }
  return items
}

/**
 * 引用的支持文件是否存在。
 *
 * 只认"看起来是本 skill 内的相对路径"（`scripts/`、`references/`、`templates/` 开头 + 带后缀），
 * 这样不会把正文里的 `~/xxx`、URL、别人的技能名当成本地文件。
 */
async function checkReferences(root: string, files: string[], texts: string[]): Promise<ExecCheckItem[]> {
  const items: ExecCheckItem[] = []
  const found = new Set<string>()
  for (const text of texts) {
    for (const m of text.matchAll(/(?:^|[\s`(])((?:scripts|references|templates)\/[\w./-]+\.[a-z0-9]+)/g)) {
      const path = m[1]
      // `noUncheckedIndexedAccess`：捕获组按下标访问是 `string | undefined`；
      // 判空而不是 `!`——真拿不到就跳过（少一条检查，不能让整轮定检崩）。
      if (path !== undefined) found.add(path)
    }
  }
  const missing = [...found].filter((p) => !files.includes(p))
  for (const p of missing) {
    items.push({
      kind: 'referenced_file',
      target: p,
      status: 'fail',
      detail: '正文引用了这个文件，但产出目录里没有它（执行者照做会读不到）',
    })
  }
  if (missing.length === 0) {
    items.push({
      kind: 'referenced_file',
      target: found.size === 0 ? '（没有引用）' : `${found.size} 处引用`,
      status: 'ok',
      detail: found.size === 0 ? '正文没有引用同目录下的支持文件' : '正文引用的支持文件都在',
    })
  }
  return items
}

/**
 * 占位符有没有在代码块之外解释过。
 *
 * ⚠️ 判据刻意保守：**只报"代码块之外一次都没出现过"的占位符**，措辞也说"可能没解释"。
 *    把"没解释"当成确定的缺陷会冤枉那些在代码块注释里定义、或在表格里列出的写法——
 *    机械检查不该假装比它实际知道的更多（这条是审核者要复核的地方，不是它的结论）。
 */
function checkPlaceholders(name: string, text: string): ExecCheckItem[] {
  const { code, prose } = splitFences(text)
  const inCode = new Set([...code.matchAll(/<([A-Z][A-Z0-9_]*)>/g)].map((m) => m[1]))
  if (inCode.size === 0) return []
  const unexplained = [...inCode].filter((tok) => !new RegExp(`<${tok}>`).test(prose))
  if (unexplained.length === 0) {
    return [
      {
        kind: 'placeholder',
        target: name,
        status: 'ok',
        detail: `代码块里用的 ${inCode.size} 个占位符，在代码块之外都出现过（有解释的迹象）`,
      },
    ]
  }
  return [
    {
      kind: 'placeholder',
      target: name,
      status: 'note',
      detail:
        `这些占位符只在代码块里出现过，代码块之外一次都没有，**可能没解释**：` +
        unexplained.map((t) => `<${t}>`).join('、'),
    },
  ]
}

/**
 * 吞掉错误的写法（只陈述事实）。
 *
 * ⚠️ 它**不判不合格**：合法的 `2>/dev/null` 到处都是。它列出来是给审核者做"反规避"那一条
 *    用的——"为了跑通而让命令不再做那件事"正是这条链上反复出现的修法（使用者那条链最后一轮
 *    的修法就是往命令里加兜底）。判不判由审核者定，平台只把现场摆出来。
 */
function checkErrorSwallowing(files: string[], texts: string[]): ExecCheckItem[] {
  const hits: string[] = []
  const patterns: Array<[RegExp, string]> = [
    [/\|\|\s*true\b/, '|| true'],
    [/2>\s*\/dev\/null/, '2>/dev/null'],
    [/\bset\s+\+e\b/, 'set +e'],
  ]
  files.forEach((file, i) => {
    const { code } = splitFences(texts[i] ?? '')
    for (const [re, label] of patterns) {
      if (re.test(code)) hits.push(`${file}（${label}）`)
    }
  })
  if (hits.length === 0) return []
  return [
    {
      kind: 'error_swallowing',
      target: `${hits.length} 处`,
      status: 'note',
      detail: `代码块里有吞掉错误的写法（事实，不是结论）：${hits.join('、')}`,
    },
  ]
}

/** 跑一轮定检。**任何一步失败都不抛**——定检挂了不该让"起审核"这件事失败。 */
export async function runSkillExecCheck(skillDir: string, io?: ExecCheckIo): Promise<ExecCheckReport> {
  const run = io?.run ?? defaultRun
  const files = await listFiles(skillDir)
  const readText = async (rel: string): Promise<string | null> =>
    await readFile(join(skillDir, rel), 'utf8').catch(() => null)

  const items: ExecCheckItem[] = []
  const main = await readText('SKILL.md')
  items.push(...checkSkeleton(main))

  const docFiles = ['SKILL.md', ...files.filter((f) => f.startsWith('references/') && f.endsWith('.md'))]
  const texts: string[] = []
  for (const f of docFiles) texts.push((await readText(f)) ?? '')

  items.push(...(await checkReferences(skillDir, files, texts)))
  docFiles.forEach((f, i) => items.push(...checkPlaceholders(f, texts[i] ?? '')))
  items.push(...checkErrorSwallowing(docFiles, texts))
  items.push(...(await checkScripts(skillDir, files, run)))

  const scripts = files.filter((f) => f.startsWith('scripts/'))
  if (scripts.length === 0) {
    items.push({
      kind: 'script_syntax',
      target: '（没有脚本）',
      status: 'note',
      detail: '产出目录里没有 scripts/ 下的脚本可查',
    })
  }

  return { at: Date.now(), skillDir, items }
}

/** 定检报告 ⇒ 给审核者读的 Markdown（**事实在前、结论不许越界**）。 */
export function renderExecCheckMarkdown(report: ExecCheckReport): string {
  const mark = (s: ExecCheckStatus): string =>
    s === 'ok' ? '通过' : s === 'fail' ? '**不通过**' : s === 'skipped' ? '**没查**' : '事实'
  const lines = [
    '# 平台定检（可执行性里能机械判定的那部分）',
    '',
    '这一份由**平台**在起审核之前跑出来，是**事实**，不是判断：',
    '语法解析、引用的文件在不在、占位符有没有解释过、骨架齐不齐、有没有吞掉错误的写法。',
    '',
    '⚠️ 标「**没查**」的项**没有结论**——不要把"没查"当成"通过"。',
    '⚠️ 标「事实」的项只列出**现场**（例如吞掉错误的写法），判不判由你定。',
    '',
    ...report.items.map((it) => `- [${mark(it.status)}] \`${it.target}\` — ${it.detail}`),
    '',
    `（定检时间 ${new Date(report.at).toISOString()}；被检目录 \`skill/\`）`,
    '',
  ]
  return lines.join('\n')
}

/** 给日志用的一句话摘要（"这轮定检查出了什么"，不打整份报告）。 */
export function summarizeExecCheck(report: ExecCheckReport): string {
  const n = (s: ExecCheckStatus): number => report.items.filter((i) => i.status === s).length
  return `定检：通过 ${n('ok')}、不通过 ${n('fail')}、没查 ${n('skipped')}、事实 ${n('note')}`
}

/** 定检里是否有硬故障（给调用方决定要不要吭声用；不改"起不起审核"这件事）。 */
export function execCheckHasFailure(report: ExecCheckReport): boolean {
  return report.items.some((i) => i.status === 'fail')
}