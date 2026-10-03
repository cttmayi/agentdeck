import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { ToolManifest, type Tool } from '@agentdeck/protocol'
import {
  MAX_DEPTH,
  MAX_FILES,
  MAX_SUPPORT_FILE_BYTES,
  MAX_TOTAL_BYTES,
  assertValidSlug,
  isProbablyText,
  toSlug,
} from '@agentdeck/skill-source'

/**
 * 工具包的来源解析（D40）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它与 `skill-source.ts` 是**两条并行的路**，刻意没有合并
 * ══════════════════════════════════════════════════════════════════
 *
 * 两者都要"把一个目录读成一组文本文件"，所以看起来该合并。但它们的
 * **必需文件**与**错误语义**都不同：
 *
 *   · skill 缺 `SKILL.md` ⇒ `missing_skill_md`（"它不是技能"）；
 *   · 工具缺 `tool.json`、或清单里写了不存在的入口 ⇒ `manifest_invalid`
 *     （"它是工具，但这份工具是坏的"）。
 *
 * 把这两套判断塞进一个函数，最后会变成"用一个可选参数切换语义"的形状，
 * 改一边就会动到另一边。**共享的是规则常量**（限额、跳过的目录、文本判据），
 * 不是循环本身——这三条才是真正必须一致的东西。
 */

export type ToolSourceErrorCode =
  | 'bad_input'
  | 'not_found'
  | 'not_a_directory'
  | 'missing_tool_json'
  | 'bad_json'
  | 'manifest_invalid'
  | 'missing_entry'
  | 'binary_file'
  | 'too_large'
  | 'too_many_files'

export class ToolSourceError extends Error {
  readonly code: ToolSourceErrorCode
  /** 给使用者看的补充说明（比如"这个目录里其实有这些文件"）。 */
  readonly detail: string | null

  constructor(code: ToolSourceErrorCode, message: string, detail: string | null = null) {
    super(message)
    this.name = 'ToolSourceError'
    this.code = code
    this.detail = detail
  }
}

/** 解析出来的一份包。 */
export interface ResolvedToolPackage {
  manifest: ToolManifest
  /** 除 `tool.json` / `TOOL.md` 之外的文件（含入口脚本）。 */
  files: Record<string, string>
  /** `TOOL.md` 的正文（没有就是空串）。 */
  docs: string
  sourceRef: string
  resolvedFrom: string
  included: Array<{ path: string; bytes: number }>
  /** 明确没装的东西及原因。 */
  ignored: Array<{ path: string; reason: string }>
}

const MANIFEST_FILE = 'tool.json'
const DOCS_FILE = 'TOOL.md'

/** 递归时跳过的目录：版本库内部结构与依赖，都不是工具内容。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github', '.venv', '__pycache__'])

function describeDir(names: readonly string[]): string {
  if (names.length === 0) return '这个目录是空的。'
  const shown = names.slice(0, 12).join('、')
  return `目录里有：${shown}${names.length > 12 ? ` …（共 ${names.length} 项）` : ''}`
}

/**
 * 大小写不对时给一句人话。
 *
 * 与 `SKILL.md` 同一个坑：macOS 的文件系统默认不分大小写，`Tool.json`
 * 也能被 `readFile('tool.json')` 读到——于是同一个包在 macOS 上装得上、
 * 在 Linux 上装不上（远端目录、CI 都可能是 Linux）。
 */
function manifestCaseHint(names: readonly string[]): string | null {
  const wrong = names.find((n) => n.toLowerCase() === MANIFEST_FILE && n !== MANIFEST_FILE)
  if (!wrong) return null
  return `目录里有个「${wrong}」，但要求的是全小写「${MANIFEST_FILE}」——macOS 上不分大小写所以能碰巧读到，Linux 上就不行。请改名。`
}

// ─────────────────────────────────────────────────────────────
// 清单：把 zod 的错误翻成"人话 + 判据"
// ─────────────────────────────────────────────────────────────

/**
 * 校验一份清单文本。
 *
 * zod 的报错是给开发者看的（`Invalid literal value`），而这份东西的读者是
 * **写工具包的人**——所以每个错误都要说清"哪一条判据没过、怎么改"。
 * 这也是"标准格式"能起作用的地方：拒得具体，人才知道怎么改对。
 */
export function parseToolManifestText(text: string, where: string): ToolManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new ToolSourceError(
      'bad_json',
      `${where} 不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`,
      '清单必须是一个 JSON 对象（键与字符串都要双引号，不能写注释、不能有尾逗号）。',
    )
  }

  const parsed = ToolManifest.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      const at = i.path.map(String).join('.') || '(根)'
      return `${at}：${i.message}`
    })
    throw new ToolSourceError(
      'manifest_invalid',
      `${where} 不是一份适配本平台的工具清单，有 ${issues.length} 处不合规。`,
      [
        '逐条对照下面的问题改（判据来自 `packages/protocol/src/tools.ts`）：',
        ...issues.map((s) => `· ${s}`),
      ].join('\n'),
    )
  }
  return parsed.data
}

// ─────────────────────────────────────────────────────────────
// 从一组文件组装出包
// ─────────────────────────────────────────────────────────────

/**
 * 组装 + 校验一个已经读成文本的包。
 *
 * 除了 schema 那几道判据，这里还有一条**schema 判不了的事**：清单里声明的
 * 入口文件必须真的在包里。不查这一条，装进来的包会在**第一次真的触发动作时**
 * 才失败——而那时人早就忘了自己装过什么。
 */
export function buildToolPackage(input: {
  files: Record<string, string>
  manifestText: string
  docs?: string
  sourceRef: string
  resolvedFrom: string
  ignored?: Array<{ path: string; reason: string }>
}): ResolvedToolPackage {
  const manifest = parseToolManifestText(input.manifestText, `${input.resolvedFrom} 的 ${MANIFEST_FILE}`)

  const files: Record<string, string> = {}
  for (const [relPath, text] of Object.entries(input.files)) {
    if (relPath === MANIFEST_FILE || relPath === DOCS_FILE) continue
    // 纵深防御：清单已校验过路径，但这里是"文件真的从外部来的"那一层
    if (relPath.startsWith('/') || relPath.includes('..')) {
      throw new ToolSourceError(
        'bad_input',
        `包里的路径不合法：${relPath}`,
        '文件必须待在包目录里面。',
      )
    }
    files[relPath] = text
  }

  const entries = [
    { action: '(包级 entry)', path: manifest.entry },
    ...manifest.actions.map((a) => ({ action: a.name, path: a.entry ?? manifest.entry })),
  ]
  const missing = entries.filter((e) => !(e.path in files))
  if (missing.length > 0) {
    throw new ToolSourceError(
      'missing_entry',
      `清单里声明的入口文件不在包里：${missing.map((m) => `${m.path}（${m.action}）`).join('、')}`,
      `${describeDir(Object.keys(files))}\n入口是相对包根的路径（例如 scripts/run.mjs），且必须是包里的真实文件。`,
    )
  }

  const included = [
    { path: MANIFEST_FILE, bytes: Buffer.byteLength(input.manifestText, 'utf8') },
    ...(input.docs !== undefined && input.docs !== ''
      ? [{ path: DOCS_FILE, bytes: Buffer.byteLength(input.docs, 'utf8') }]
      : []),
    ...Object.entries(files).map(([p, t]) => ({ path: p, bytes: Buffer.byteLength(t, 'utf8') })),
  ]

  return {
    manifest,
    files,
    docs: input.docs ?? '',
    sourceRef: input.sourceRef,
    resolvedFrom: input.resolvedFrom,
    included,
    ignored: input.ignored ?? [],
  }
}

// ─────────────────────────────────────────────────────────────
// 来源：本地目录
// ─────────────────────────────────────────────────────────────

export async function resolveLocalToolPath(
  inputPath: string,
  options: { slug?: string | null } = {},
): Promise<ResolvedToolPackage> {
  const expanded = expandHome(inputPath)

  if (!isAbsolute(expanded)) {
    throw new ToolSourceError(
      'bad_input',
      `路径必须是绝对路径：${inputPath}`,
      '相对路径取决于 daemon 是从哪个目录启动的，同一个路径可能指向完全不同的地方。',
    )
  }

  let info
  try {
    info = await stat(expanded)
  } catch {
    throw new ToolSourceError('not_found', `路径不存在：${expanded}`)
  }

  // 允许直接指向 tool.json：从编辑器里复制过来的常常是文件路径
  let dir = expanded
  if (info.isFile()) {
    if (basename(expanded) !== MANIFEST_FILE) {
      throw new ToolSourceError(
        'not_a_directory',
        `这是一个文件，不是工具包目录：${expanded}`,
        `工具包是一个目录，里面至少要有 ${MANIFEST_FILE}。`,
      )
    }
    dir = dirname(expanded)
  } else if (!info.isDirectory()) {
    throw new ToolSourceError('not_a_directory', `既不是文件也不是目录：${expanded}`)
  }

  const collected = await collectDir(dir)
  if (collected.manifestText === null) {
    const names = collected.topLevelNames.length > 0 ? collected.topLevelNames : collected.emptyDirNames
    const hint = manifestCaseHint(names)
    throw new ToolSourceError(
      'missing_tool_json',
      `这里没有 ${MANIFEST_FILE}，所以它不是一个工具包：${dir}`,
      [describeDir(names), hint].filter(Boolean).join('\n'),
    )
  }

  checkLimits(collected)

  const pkg = buildToolPackage({
    files: collected.files,
    manifestText: collected.manifestText,
    docs: collected.docs ?? '',
    sourceRef: `path:${dir}`,
    resolvedFrom: dir,
    ignored: collected.ignored,
  })

  // slug 以**清单为准**（它是组名、也是动作的命名空间）；显式覆盖时才用覆盖值，
  // 因为一份工具的标识不该随"我是从哪个目录装进来的"变。
  if (options.slug != null) {
    assertValidSlug(options.slug, `你指定的是「${options.slug}」。`)
    if (options.slug !== pkg.manifest.slug) {
      throw new ToolSourceError(
        'bad_input',
        `你指定的 slug「${options.slug}」与清单里的「${pkg.manifest.slug}」不一致。`,
        '动作名是 `<slug>.<动作名>`——两处不一致时，判决里该写哪个就没有答案了。请改清单，别用覆盖值。',
      )
    }
  }

  return pkg
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

interface Collected {
  manifestText: string | null
  docs: string | null
  files: Record<string, string>
  ignored: Array<{ path: string; reason: string }>
  topLevelNames: string[]
  emptyDirNames: string[]
  fileCount: number
  totalBytes: number
}

async function collectDir(root: string): Promise<Collected> {
  const out: Collected = {
    manifestText: null,
    docs: null,
    files: {},
    ignored: [],
    topLevelNames: [],
    emptyDirNames: [],
    fileCount: 0,
    totalBytes: 0,
  }

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      out.ignored.push({ path: relative(root, dir) || '.', reason: '目录读不了（权限？），已跳过' })
      return
    }
    if (entries.length === 0 && depth > 0) {
      out.emptyDirNames.push(relative(root, dir))
    }

    for (const entry of entries) {
      const full = join(dir, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (depth === 0) out.topLevelNames.push(entry.name)

      // 符号链接一律不跟随：既可能指到包外面，也可能成环
      if (entry.isSymbolicLink()) {
        out.ignored.push({ path: rel, reason: '符号链接，未跟随' })
        continue
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          out.ignored.push({ path: rel, reason: '版本库/依赖目录，不属于工具内容' })
          continue
        }
        if (depth + 1 > MAX_DEPTH) {
          out.ignored.push({ path: rel, reason: `超过递归深度上限 ${MAX_DEPTH}` })
          continue
        }
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) {
        out.ignored.push({ path: rel, reason: '不是普通文件' })
        continue
      }

      const buf = await readFile(full)
      if (!isProbablyText(buf)) {
        // 清单本身是二进制 ⇒ 不能说"没有 tool.json"（它明明在，只是内容不对）
        if (rel === MANIFEST_FILE) {
          throw new ToolSourceError(
            'binary_file',
            `${MANIFEST_FILE} 不是文本文件（含二进制内容）：${full}`,
            '清单必须是 UTF-8 文本的 JSON。',
          )
        }
        out.ignored.push({
          path: rel,
          reason: '二进制文件，首版只支持文本（脚本与文档），装进来会写坏所以明确没装',
        })
        continue
      }

      const text = buf.toString('utf8')
      out.fileCount += 1
      out.totalBytes += buf.length
      if (rel === MANIFEST_FILE) out.manifestText = text
      else if (rel === DOCS_FILE) out.docs = text
      else out.files[rel] = text
    }
  }

  await walk(root, 0)
  return out
}

function checkLimits(collected: Collected): void {
  if (collected.fileCount > MAX_FILES) {
    throw new ToolSourceError(
      'too_many_files',
      `文件太多：共 ${collected.fileCount} 个，上限 ${MAX_FILES} 个。`,
      '工具包应当是一个脚本加少量支持文件，不是整个仓库。',
    )
  }
  if (collected.totalBytes > MAX_TOTAL_BYTES) {
    throw new ToolSourceError(
      'too_large',
      `所有文件加起来 ${collected.totalBytes} 字节，超过上限 ${MAX_TOTAL_BYTES}。`,
    )
  }
  for (const [rel, text] of Object.entries(collected.files)) {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > MAX_SUPPORT_FILE_BYTES) {
      throw new ToolSourceError(
        'too_large',
        `文件 ${rel} 有 ${bytes} 字节，超过单文件上限 ${MAX_SUPPORT_FILE_BYTES}。`,
      )
    }
  }
}

/** 把解析结果变成一条待写入的 `Tool` 记录（id / 时间戳由调用方给）。 */
export function toToolRecord(
  pkg: ResolvedToolPackage,
  ids: Pick<Tool, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt'>,
): Tool {
  return {
    id: ids.id,
    workspaceId: ids.workspaceId,
    slug: pkg.manifest.slug,
    name: pkg.manifest.name,
    description: pkg.manifest.description,
    version: pkg.manifest.version,
    manifest: pkg.manifest,
    files: pkg.files,
    docs: pkg.docs,
    source: pkg.sourceRef.startsWith('remote:') ? 'remote' : 'local',
    sourceRef: pkg.sourceRef,
    createdAt: ids.createdAt,
    updatedAt: ids.updatedAt,
  }
}

/** 给界面用：一句话说明这次是从哪儿装的。 */
export function describeToolSource(sourceRef: string): string {
  if (sourceRef.startsWith('path:')) return `本机目录：${sourceRef.slice('path:'.length)}`
  if (sourceRef.startsWith('remote:')) return `远端目录：${sourceRef.slice('remote:'.length)}`
  return sourceRef
}

/** slug 收敛（与 skill 同一套规则，导出给界面提示用）。 */
export { toSlug }
