import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { MAX_SKILL_BYTES } from '@agentdeck/agent-core'

// 转出去，好让"安装"这条链路的其它地方（接口、测试）也从这里取同一个数，
// 而不是各自 import 一次 agent-core——两处都是同一个值，但只有一处是"来源"
export { MAX_SKILL_BYTES }

/**
 * skill 的**来源解析**：把一个来源（本地路径 / GitHub 链接 / 远端目录条目）
 * 变成一个可安装的技能——也就是"一个含 SKILL.md 的目录"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 一条规则统管三种来源
 * ══════════════════════════════════════════════════════════════════
 *
 * **没有 SKILL.md 就不是技能。** 三种来源都要过这一关，而且失败时要说清
 * "我在哪个目录里找了、那里到底有什么"。
 *
 * 这不是形式主义：技能是靠"把目录摆对"让 CLI 自己发现的（FR-CLI-19），
 * 目录里没有 SKILL.md 等于这个技能永远不会生效——而使用者会以为自己装好了。
 * 所以宁可当场拒绝，并把目录内容列出来让他能改对。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这是 daemon 第一次对外发请求，边界必须写死
 * ══════════════════════════════════════════════════════════════════
 *
 * 此前 daemon 一个对外请求都不发（D19/D20）。支持"给一个 GitHub 路径"
 * 就必须让 daemon 自己下载——本地目录路径页面根本读不到磁盘，而"下载到本地"
 * 本来就发生在 daemon 这台机器上。
 *
 * 但**只放开 GitHub 的三个主机**，不做通用 URL 下载器：
 *
 *   - 通用抓取 = 一个本地服务替别人访问任意地址（SSRF：内网、云元数据、
 *     本机其它端口）。做对它需要 IP 段判断、DNS 重绑定防护等一整套东西，
 *     那是另一件事，不该被"顺手支持一下"带进来；
 *   - GitHub 上的公开技能仓库是使用者的实际需求，白名单足够覆盖。
 *
 * 除了主机白名单，还有：只允许 https、每一跳跳转都重新校验主机、
 * 限单文件/总量/文件数/超时。**测试一律注入 fetch，绝不联网**（NFR-T-01）。
 */

// ─────────────────────────────────────────────────────────────
// 限额
// ─────────────────────────────────────────────────────────────

/**
 * 单个支持文件的上限。
 *
 * SKILL.md 的上限**从 agent-core 复用**（`MAX_SKILL_BYTES`），不在这里另写一份：
 * 安装时按一个数收下、注入时按另一个数拒绝，就会出现"装得上但跑任务时炸"的
 * 技能——而那种失败发生在很久以后、离原因很远。
 */
export const MAX_SUPPORT_FILE_BYTES = 256 * 1024
/**
 * 一个技能所有文件加起来的字节上限。
 *
 * ⚠️ 2026-10 从 1 MB 提到 8 MB：真实技能仓库（fireworks-tech-graph 那一类）是
 * **完整仓库**——SKILL.md 在根、测试/示例/脚本照常带，实测文本部分就有 2.4 MB。
 * 1 MB 会把它挡在门外。8 MB 仍是硬护栏：一段塞满的正文库照样会被拒。
 */
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024
/**
 * 文件数上限（含 SKILL.md）。
 *
 * ⚠️ 2026-10 从 64 提到 512：同样因为完整仓库（上面那句的实测是 234 个文本
 * 文件）。512 仍是硬护栏：一个塞满东西的目录照样会被拒，只是不再误伤正经的
 * 完整仓库。
 */
export const MAX_FILES = 512
/** 目录递归深度上限。 */
export const MAX_DEPTH = 4
/** 单次 HTTP 请求的超时。 */
export const FETCH_TIMEOUT_MS = 15_000

/** GitHub 允许的三个主机——**这是白名单，不是示例**。 */
const ALLOWED_HOSTS = new Set(['github.com', 'raw.githubusercontent.com', 'api.github.com'])

/** 递归时跳过的目录名：版本库内部结构与依赖，都不是技能内容。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github'])

// ─────────────────────────────────────────────────────────────
// 错误
// ─────────────────────────────────────────────────────────────

/** 来源错误都带一个稳定的 code，界面据此决定怎么提示。 */
export type SkillSourceErrorCode =
  | 'bad_input'
  | 'not_found'
  | 'not_a_directory'
  | 'missing_skill_md'
  | 'bad_slug'
  | 'binary_file'
  | 'too_large'
  | 'too_many_files'
  | 'unsupported_url'
  | 'blocked_host'
  | 'github_rate_limited'
  | 'fetch_failed'

export class SkillSourceError extends Error {
  readonly code: SkillSourceErrorCode
  /** 可以给使用者看的补充信息（比如"这个目录里其实有这些文件"）。 */
  readonly detail: string | null

  constructor(code: SkillSourceErrorCode, message: string, detail: string | null = null) {
    super(message)
    this.name = 'SkillSourceError'
    this.code = code
    this.detail = detail
  }
}

// ─────────────────────────────────────────────────────────────
// 结果
// ─────────────────────────────────────────────────────────────

export interface ResolvedSkillSource {
  /** 权威 slug（来源名派生，或显式指定）。 */
  slug: string
  /** SKILL.md 原文。 */
  body: string
  /** 支持文件：相对路径 → UTF-8 文本。 */
  files: Record<string, string>
  /** 写进 `Skill.sourceRef` 的来源标识。 */
  sourceRef: string
  /** 人可读：来源解析到了哪里。 */
  resolvedFrom: string
  /** 装进来的文件（含字节数）——界面要如实显示装了什么。 */
  included: Array<{ path: string; bytes: number }>
  /** **明确没装**的东西及原因（二进制、超限、跳过的目录）。 */
  ignored: Array<{ path: string; reason: string }>
}

export interface ResolveDeps {
  /** 注入 fetch 以便测试（NFR-T-01：测试绝不联网）。 */
  fetchImpl?: typeof fetch
  /** GitHub 令牌（可选：私有仓库，或提高匿名限额）。 */
  githubToken?: string | null
}

// ─────────────────────────────────────────────────────────────
// slug
// ─────────────────────────────────────────────────────────────

/**
 * 把任意名字收敛成合法 slug。
 *
 * slug 有严格格式（kebab-case、≤63 字符），它同时是**磁盘上的目录名**
 * （注入到 `.claude/skills/<slug>/`）。而来源名是任意的：`My_Skill`、
 * `技能`、`foo.bar` 都可能出现。
 *
 * 收敛规则刻意保守：非 `[a-z0-9]` 一律变 `-`，压掉连续 `-`，去掉首尾 `-`。
 * 收敛后仍不合法就报错要求显式指定，**不瞎猜**。
 */
export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

export function assertValidSlug(slug: string, hint: string | null = null): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new SkillSourceError(
      'bad_slug',
      `slug「${slug}」不合法：只能是小写字母、数字与连字符，并以字母或数字开头（最长 63 字符）。` +
        `它同时是磁盘上的目录名。`,
      hint,
    )
  }
}

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

/**
 * 大小写不对时给一句人话。
 *
 * macOS 的文件系统默认不分大小写，`skill.md` 也能被 `readFile('SKILL.md')`
 * 读到——于是同一个技能在 macOS 上装得上、在 Linux 上装不上，而 Claude Code
 * 找的也是**大写**那个名字。所以显式判别并说清，而不是"在 mac 上碰巧能用"。
 */
function skillMdCaseHint(names: readonly string[]): string | null {
  const wrong = names.find((n) => n.toLowerCase() === 'skill.md' && n !== 'SKILL.md')
  if (!wrong) return null
  return (
    `目录里有个「${wrong}」，但要求的是大写「SKILL.md」——macOS 上不分大小写所以能碰巧读到，` +
    `Linux 上就不行，CLI 找的也是大写那个。请改名。`
  )
}

function describeDir(names: readonly string[]): string {
  if (names.length === 0) return '这个目录是空的。'
  const shown = names.slice(0, 12).join('、')
  return `目录里有：${shown}${names.length > 12 ? ` …（共 ${names.length} 项）` : ''}`
}

/**
 * 判断是不是文本。
 *
 * 两个判据一起用，因为任一单独用都会误判：
 *   - **NUL 字节**：几乎所有二进制格式都含 0x00，而合法 UTF-8 文本不含；
 *   - **UTF-8 往返**：解码再编码回来不一致，说明不是合法 UTF-8（比如 GBK
 *     编码的中文）。直接当文本写进去会变成乱码，而且**是静默的**。
 */
export function isProbablyText(buf: Buffer): boolean {
  if (buf.includes(0)) return false
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)
}

interface CollectedFile {
  /** 相对技能根目录的路径（POSIX 风格，`/` 分隔）。 */
  relPath: string
  bytes: number
  text: string
}

/** 校验 SKILL.md 本身。空文件也是"没有 SKILL.md"——它同样不会生效。 */
function checkSkillMd(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_SKILL_BYTES) {
    throw new SkillSourceError(
      'too_large',
      `SKILL.md 有 ${bytes} 字节，超过上限 ${MAX_SKILL_BYTES}。`,
      '技能正文是要被模型读进去的，过大的技能会挤掉真正的内容。',
    )
  }
  if (content.trim() === '') {
    throw new SkillSourceError('missing_skill_md', 'SKILL.md 是空的，装进来也不会生效。')
  }
}

/** 校验其余文件的大小、数量与总量。 */
function checkOthers(files: readonly CollectedFile[]): void {
  if (files.length + 1 > MAX_FILES) {
    throw new SkillSourceError(
      'too_many_files',
      `文件太多：含 SKILL.md 共 ${files.length + 1} 个，上限 ${MAX_FILES} 个。`,
      '支持文件应当是技能需要的少量文本（脚本、参考文档），不是整个仓库。',
    )
  }
  let total = 0
  for (const file of files) {
    if (file.bytes > MAX_SUPPORT_FILE_BYTES) {
      throw new SkillSourceError(
        'too_large',
        `支持文件 ${file.relPath} 有 ${file.bytes} 字节，超过单文件上限 ${MAX_SUPPORT_FILE_BYTES}。`,
      )
    }
    total += file.bytes
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new SkillSourceError(
      'too_large',
      `所有文件加起来 ${total} 字节，超过总量上限 ${MAX_TOTAL_BYTES}。`,
    )
  }
}

function assemble(input: {
  slug: string
  sourceRef: string
  resolvedFrom: string
  skillMd: string
  others: readonly CollectedFile[]
  ignored: Array<{ path: string; reason: string }>
}): ResolvedSkillSource {
  const files: Record<string, string> = {}
  for (const file of input.others) files[file.relPath] = file.text

  return {
    slug: input.slug,
    body: input.skillMd,
    files,
    sourceRef: input.sourceRef,
    resolvedFrom: input.resolvedFrom,
    included: [
      { path: 'SKILL.md', bytes: Buffer.byteLength(input.skillMd, 'utf8') },
      ...input.others.map((f) => ({ path: f.relPath, bytes: f.bytes })),
    ],
    ignored: input.ignored,
  }
}

// ─────────────────────────────────────────────────────────────
// 来源①：本地目录
// ─────────────────────────────────────────────────────────────

interface Collected {
  skillMd: string | null
  others: CollectedFile[]
  ignored: Array<{ path: string; reason: string }>
  /** 顶层条目的名字（缺 SKILL.md 时用来说清"这里有什么"）。 */
  topLevelNames: string[]
}

/**
 * 读一个本地目录。
 *
 * 路径必须**绝对**（`~` 会展开）。相对路径不能用：daemon 的当前目录是启动它的
 * 地方，同一个相对路径"从项目目录启动"和"从别处启动"指向完全不同的位置——
 * 那是最难查的一类"为什么装到别处去了"。
 */
export async function resolveLocalPath(
  inputPath: string,
  options: { slug?: string | null } = {},
): Promise<ResolvedSkillSource> {
  const expanded = expandHome(inputPath)

  if (!isAbsolute(expanded)) {
    throw new SkillSourceError(
      'bad_input',
      `路径必须是绝对路径：${inputPath}`,
      '相对路径取决于 daemon 是从哪个目录启动的，同一个路径可能指向完全不同的地方。',
    )
  }

  let info
  try {
    info = await stat(expanded)
  } catch {
    throw new SkillSourceError('not_found', `路径不存在：${expanded}`)
  }

  // 允许直接指向 SKILL.md：从编辑器/Finder 复制过来的常常是文件路径
  let dir = expanded
  if (info.isFile()) {
    if (basename(expanded) !== 'SKILL.md') {
      throw new SkillSourceError(
        'not_a_directory',
        `这是一个文件，不是技能目录：${expanded}`,
        '技能是一个目录，里面至少要有 SKILL.md。',
      )
    }
    dir = dirname(expanded)
  } else if (!info.isDirectory()) {
    throw new SkillSourceError('not_a_directory', `既不是文件也不是目录：${expanded}`)
  }

  const collected = await collectLocal(dir)
  const fallback = basename(dir)
  const slug = options.slug ?? toSlug(fallback)
  assertValidSlug(
    slug,
    `来源目录名是「${fallback}」，收敛后是「${toSlug(fallback)}」。如果这不对，请显式指定 slug。`,
  )
  return finish(collected, {
    slug,
    sourceRef: `path:${dir}`,
    resolvedFrom: dir,
    emptyDirNames: [],
  })
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

async function collectLocal(root: string): Promise<Collected> {
  const others: CollectedFile[] = []
  const ignored: Array<{ path: string; reason: string }> = []
  const topLevelNames: string[] = []
  let skillMd: string | null = null

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // 读不了的子目录算"没装进来"，不是失败——但必须如实记下来
      ignored.push({ path: relative(root, dir) || '.', reason: '目录读不了（权限？），已跳过' })
      return
    }

    for (const entry of entries) {
      const full = join(dir, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (depth === 0) topLevelNames.push(entry.name)

      // 符号链接一律不跟随：既可能指到技能目录外面，也可能成环
      if (entry.isSymbolicLink()) {
        ignored.push({ path: rel, reason: '符号链接，未跟随' })
        continue
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          ignored.push({ path: rel, reason: '版本库/依赖目录，不属于技能内容' })
          continue
        }
        if (depth + 1 > MAX_DEPTH) {
          ignored.push({ path: rel, reason: `超过递归深度上限 ${MAX_DEPTH}` })
          continue
        }
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) {
        ignored.push({ path: rel, reason: '不是普通文件' })
        continue
      }

      const buf = await readFile(full)
      if (!isProbablyText(buf)) {
        // ★ SKILL.md 是二进制时**不能**笼统地报"没有 SKILL.md"：它明明在，
        //   只是内容不对。说成"没有"会让人一遍遍检查文件名和路径，
        //   而真正的问题在文件内容。
        if (rel === 'SKILL.md') {
          throw new SkillSourceError(
            'binary_file',
            `SKILL.md 不是文本文件（含二进制内容）：${full}`,
            '技能正文会被读进模型上下文，必须是 UTF-8 文本。',
          )
        }
        ignored.push({
          path: rel,
          reason: '二进制文件，首版只支持文本支持文件（装进来会写坏，所以明确没装）',
        })
        continue
      }
      const text = buf.toString('utf8')
      if (rel === 'SKILL.md') skillMd = text
      else others.push({ relPath: rel, bytes: buf.length, text })
    }
  }

  await walk(root, 0)
  return { skillMd, others, ignored, topLevelNames }
}

/** 公共收尾：SKILL.md 存在性检查 + 限额 + 组装。 */
function finish(
  collected: Collected,
  meta: { slug: string; sourceRef: string; resolvedFrom: string; emptyDirNames: string[] },
): ResolvedSkillSource {
  if (collected.skillMd === null) {
    const names = collected.topLevelNames.length > 0 ? collected.topLevelNames : meta.emptyDirNames
    const hints = [describeDir(names), skillMdCaseHint(names)].filter(Boolean)
    throw new SkillSourceError(
      'missing_skill_md',
      `这里没有 SKILL.md，所以它不是技能：${meta.resolvedFrom}`,
      hints.join(' '),
    )
  }

  checkSkillMd(collected.skillMd)
  checkOthers(collected.others)

  return assemble({
    slug: meta.slug,
    sourceRef: meta.sourceRef,
    resolvedFrom: meta.resolvedFrom,
    skillMd: collected.skillMd,
    others: collected.others,
    ignored: collected.ignored,
  })
}

// ─────────────────────────────────────────────────────────────
// 来源②：GitHub 链接
// ─────────────────────────────────────────────────────────────

export interface GithubTarget {
  owner: string
  repo: string
  /** 分支/标签/提交。没给就用仓库默认分支。 */
  ref: string | null
  /** 仓库内的**目录**路径（`''` 表示仓库根）。 */
  dir: string
  /** 链接直接指向的文件（`blob`/`raw` 形态），否则 null。 */
  file: string | null
  /** 原始链接的形态——用于给出更贴切的错误提示。 */
  form: 'repo' | 'tree' | 'blob' | 'raw' | 'api'
}

/**
 * 解析 GitHub 链接。
 *
 * 支持四种形态，因为这四种都是使用者会真的复制到的东西：
 *
 *   https://github.com/{o}/{r}                                    （仓库根）
 *   https://github.com/{o}/{r}/tree/{ref}/{dir}                    （目录，最常用）
 *   https://github.com/{o}/{r}/blob/{ref}/{dir}/SKILL.md           （文件）
 *   https://raw.githubusercontent.com/{o}/{r}/{ref}/{dir}/SKILL.md （Raw 按钮）
 *
 * `blob` 与 `raw` 都指向文件，所以会**取它所在的目录**——这样支持文件也能
 * 一起装上，而不是"同一个技能因为链接形态不同装出两种结果"。
 *
 * ⚠️ 已知限制：`ref` 只取**第一段**。分支名本身含斜杠（`feature/x`）时会被切错，
 *    此时 GitHub API 返回 404，我们会明确说出来。要正确处理得拿候选 ref 逐个
 *    探测（更多请求、更多失败模式），而含斜杠的分支名很少见。
 */
export function parseGithubUrl(url: string): GithubTarget {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SkillSourceError('unsupported_url', `这不是一个合法的链接：${url}`)
  }

  if (parsed.protocol !== 'https:') {
    throw new SkillSourceError(
      'unsupported_url',
      `只支持 https 链接：${url}`,
      '技能正文会直接进模型的上下文，明文下载的内容无法与来源建立可信关联。',
    )
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new SkillSourceError(
      'blocked_host',
      `目前只支持 GitHub 的链接（github.com / raw.githubusercontent.com），收到的是：${parsed.hostname}`,
      '让本地服务去抓任意地址会变成一个对内网的访问跳板。要装本机上的技能，请用「本地目录」那条路径。',
    )
  }

  const segments = parsed.pathname.split('/').filter((s) => s !== '')
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }

  if (parsed.hostname === 'raw.githubusercontent.com') {
    const [owner, repo, ref, ...rest] = segments
    if (!owner || !repo || !ref || rest.length === 0) {
      throw new SkillSourceError('unsupported_url', `Raw 链接缺少必要部分：${url}`)
    }
    const file = rest.map(decode).join('/')
    return { owner, repo, ref, dir: parentDir(file), file, form: 'raw' }
  }

  if (parsed.hostname === 'api.github.com') {
    // 有人会直接复制 API 链接。认识的形态是 /repos/{o}/{r}/contents/{path}?ref=
    const [head, owner, repo, contents, ...rest] = segments
    if (head !== 'repos' || !owner || !repo) {
      throw new SkillSourceError('unsupported_url', `不认识的 GitHub API 链接：${url}`)
    }
    const ref = parsed.searchParams.get('ref')
    if (contents !== 'contents') return { owner, repo, ref, dir: '', file: null, form: 'api' }
    const dir = rest.map(decode).join('/')
    return { owner, repo, ref, dir, file: null, form: 'api' }
  }

  const [owner, repo, marker, ref, ...rest] = segments
  if (!owner || !repo) {
    throw new SkillSourceError('unsupported_url', `链接里没有仓库：${url}`)
  }
  if (marker === undefined) return { owner, repo, ref: null, dir: '', file: null, form: 'repo' }
  if (marker !== 'tree' && marker !== 'blob') {
    throw new SkillSourceError(
      'unsupported_url',
      `不支持的链接形态（${marker}）：${url}`,
      '请给出仓库根、目录（…/tree/<ref>/<目录>）或 SKILL.md（…/blob/<ref>/…/SKILL.md）的链接。',
    )
  }
  if (ref === undefined) {
    throw new SkillSourceError('unsupported_url', `${marker} 链接缺少分支/标签：${url}`)
  }

  const restPath = rest.map(decode).join('/')
  if (marker === 'blob') {
    if (restPath === '') {
      throw new SkillSourceError('unsupported_url', `blob 链接缺少文件路径：${url}`)
    }
    return { owner, repo, ref, dir: parentDir(restPath), file: restPath, form: 'blob' }
  }
  return { owner, repo, ref, dir: restPath, file: null, form: 'tree' }
}

function parentDir(filePath: string): string {
  return filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : ''
}

/** GitHub contents API 的条目——只声明用得到的字段。 */
interface GithubEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  size?: number
  download_url?: string | null
}

async function githubFetch(
  url: string,
  deps: ResolveDeps,
  accept = 'application/vnd.github+json',
): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch
  const headers: Record<string, string> = {
    accept,
    'user-agent': 'agentdeck',
    'x-github-api-version': '2022-11-28',
  }
  if (deps.githubToken) headers['authorization'] = `Bearer ${deps.githubToken}`

  let current = url
  // 手动跟随跳转：**每一跳都要重新校验主机**，否则一个 302 就能把我们带到
  // 白名单之外去——白名单就形同虚设了
  for (let hop = 0; hop < 4; hop++) {
    const target = new URL(current)
    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
      throw new SkillSourceError(
        'blocked_host',
        `跳转到了白名单之外：${target.hostname}`,
        '只允许跳转回 GitHub 自己的主机。',
      )
    }

    let res: Response
    try {
      res = await doFetch(current, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      throw new SkillSourceError(
        'fetch_failed',
        `下载失败：${(err as Error).message}`,
        `地址：${current}`,
      )
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new SkillSourceError('fetch_failed', `跳转但没有 Location：${current}`)
      current = new URL(location, current).toString()
      continue
    }

    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining')
      throw new SkillSourceError(
        'github_rate_limited',
        remaining === '0'
          ? 'GitHub 的匿名访问次数用完了（每小时 60 次）。'
          : 'GitHub 拒绝了这次请求（403/429）。',
        '等一会儿再试，或设置环境变量 AGENTDECK_GITHUB_TOKEN 用令牌提高限额。',
      )
    }
    return res
  }

  throw new SkillSourceError('fetch_failed', `跳转次数过多：${url}`)
}

/**
 * 带上限地读响应体。
 *
 * 用 `getReader()` 而不是 `for await`：超限时要能真的 `cancel()` 把下载停掉，
 * 而 `for await` 迭代期间流是锁住的，`cancel()` 会直接抛错——那样"超限中止"
 * 就只是表面功夫，连接与下载都还在继续。
 */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SkillSourceError(
      'too_large',
      `响应声明的长度是 ${declared} 字节，超过上限 ${maxBytes}。`,
    )
  }

  const body = res.body
  if (!body) return Buffer.alloc(0)

  const reader = body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    const buf = Buffer.from(value)
    size += buf.length
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new SkillSourceError('too_large', `下载内容超过上限 ${maxBytes} 字节。`)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

function contentsUrl(target: GithubTarget, path: string): string {
  const ref = target.ref ? `?ref=${encodeURIComponent(target.ref)}` : ''
  return `https://api.github.com/repos/${target.owner}/${target.repo}/contents/${path}${ref}`
}

async function listGithubDir(
  target: GithubTarget,
  path: string,
  deps: ResolveDeps,
): Promise<GithubEntry[]> {
  const url = contentsUrl(target, path)
  const res = await githubFetch(url, deps)

  if (res.status === 404) {
    throw new SkillSourceError(
      'not_found',
      `GitHub 上找不到：${target.owner}/${target.repo}${path ? `/${path}` : ''}` +
        `${target.ref ? `（ref=${target.ref}）` : ''}`,
      '仓库不存在、是私有的，或者分支/路径写错了（分支名本身含斜杠时也会走到这里）。',
    )
  }
  if (!res.ok) {
    throw new SkillSourceError('fetch_failed', `GitHub 返回 ${res.status}：${url}`)
  }

  const payload = JSON.parse((await readCapped(res, 4 * 1024 * 1024)).toString('utf8')) as
    | GithubEntry
    | GithubEntry[]

  // 指向文件时 API 返回单个对象而不是数组：说明路径落在文件上而不是目录上
  if (!Array.isArray(payload)) {
    throw new SkillSourceError(
      'not_a_directory',
      `GitHub 上的 ${path || '（仓库根）'} 是一个文件，不是目录。`,
      '技能是一个目录。如果这是 SKILL.md，请给出它所在的目录链接。',
    )
  }
  return payload
}

async function fetchFile(entry: GithubEntry, target: GithubTarget, deps: ResolveDeps): Promise<Buffer> {
  // API 正常会给 download_url；没给就自己拼一个，**不用 HEAD 之类猜**——
  // 猜错会静默拿到别的东西
  const url =
    entry.download_url ??
    `https://raw.githubusercontent.com/${target.owner}/${target.repo}/` +
      `${target.ref ?? 'HEAD'}/${entry.path}`
  const res = await githubFetch(url, deps, 'application/vnd.github.raw')
  if (!res.ok) {
    throw new SkillSourceError('fetch_failed', `下载文件失败（${res.status}）：${entry.path}`)
  }
  return readCapped(res, MAX_SUPPORT_FILE_BYTES + 1)
}

/**
 * 从一个 GitHub 链接解析技能。
 *
 * 只装**目标目录**里的文件，不做"在仓库里递归找 SKILL.md"：一个仓库里可能
 * 有十几个技能，替你挑一个是在猜。找不到 SKILL.md 时会把目录内容列出来，
 * 让使用者把链接改对。
 */
export async function resolveGithubUrl(
  url: string,
  options: { slug?: string | null } = {},
  deps: ResolveDeps = {},
): Promise<ResolvedSkillSource> {
  const target = parseGithubUrl(url)

  // blob/raw 指向文件：必须是 SKILL.md，然后按**它所在的目录**解析
  // （这样支持文件会一起装上，而不是只有那一个文件）
  if (target.file !== null && basename(target.file) !== 'SKILL.md') {
    throw new SkillSourceError(
      'unsupported_url',
      `这个链接指向的是「${basename(target.file)}」，不是 SKILL.md。`,
      '请给出 SKILL.md 的链接，或者它所在目录的链接。',
    )
  }

  const entries = await listGithubDir(target, target.dir, deps)
  const names = entries.map((e) => e.name)
  const skillMdEntry = entries.find((e) => e.name === 'SKILL.md' && e.type === 'file')

  if (!skillMdEntry) {
    const hints = [describeDir(names), skillMdCaseHint(names)].filter(Boolean)
    // SKILL.md 在、但不是普通文件（符号链接/子模块）时说清，否则"目录里有
    // SKILL.md 却报没有"会让人怀疑是程序坏了
    const odd = entries.find((e) => e.name === 'SKILL.md' && e.type !== 'file')
    if (odd) hints.push(`SKILL.md 是存在的，但它在仓库里是个 ${odd.type}，不是普通文件。`)
    throw new SkillSourceError(
      'missing_skill_md',
      `这里没有 SKILL.md，所以它不是技能：` +
        `${target.owner}/${target.repo}${target.dir ? `/${target.dir}` : '（仓库根）'}`,
      hints.join(' '),
    )
  }

  const others: CollectedFile[] = []
  const ignored: Array<{ path: string; reason: string }> = []
  let skillMd: string | null = null

  const walk = async (path: string, list: GithubEntry[], depth: number): Promise<void> => {
    for (const entry of list) {
      if (entry.type === 'dir') {
        if (SKIP_DIRS.has(entry.name)) {
          ignored.push({ path: entry.path, reason: '版本库/依赖目录，不属于技能内容' })
          continue
        }
        if (depth + 1 > MAX_DEPTH) {
          ignored.push({ path: entry.path, reason: `超过递归深度上限 ${MAX_DEPTH}` })
          continue
        }
        await walk(entry.path, await listGithubDir(target, entry.path, deps), depth + 1)
        continue
      }
      if (entry.type !== 'file') {
        ignored.push({ path: entry.path, reason: `不是普通文件（${entry.type}），未跟随` })
        continue
      }

      const buf = await fetchFile(entry, target, deps)
      const relPath = target.dir === '' ? entry.path : entry.path.slice(target.dir.length + 1)

      if (entry.name === 'SKILL.md') {
        if (!isProbablyText(buf)) {
          throw new SkillSourceError('binary_file', 'SKILL.md 不是文本文件。')
        }
        if (buf.length > MAX_SKILL_BYTES) {
          throw new SkillSourceError(
            'too_large',
            `SKILL.md 有 ${buf.length} 字节，超过上限 ${MAX_SKILL_BYTES}。`,
          )
        }
        skillMd = buf.toString('utf8')
        continue
      }
      if (!isProbablyText(buf)) {
        ignored.push({ path: relPath, reason: '二进制文件，首版只支持文本支持文件' })
        continue
      }
      others.push({ relPath, bytes: buf.length, text: buf.toString('utf8') })
    }
  }

  await walk(target.dir, entries, 0)

  const fallback = target.dir === '' ? target.repo : basename(target.dir)
  const slug = options.slug ?? toSlug(fallback)
  assertValidSlug(slug, `来源名是「${fallback}」，收敛后是「${toSlug(fallback)}」。要改请显式指定 slug。`)

  return finish(
    { skillMd, others, ignored, topLevelNames: names },
    {
      slug,
      sourceRef:
        `github:${target.owner}/${target.repo}@${target.ref ?? 'default'}` +
        `${target.dir ? `:${target.dir}` : ''}`,
      resolvedFrom:
        `${target.owner}/${target.repo}${target.ref ? `@${target.ref}` : ''}` +
        `${target.dir ? `:${target.dir}` : ':（仓库根）'}`,
      emptyDirNames: names,
    },
  )
}

// ─────────────────────────────────────────────────────────────
// 来源③：远端目录交过来的条目
// ─────────────────────────────────────────────────────────────

/**
 * 远端目录那条来源。
 *
 * daemon 不向 agentdeck 的远端服务发请求（D20），所以这条路仍然是
 * **页面把内容取好交过来**。但"必须有 SKILL.md"这一关一样要过：条目里的
 * `files['SKILL.md']` 优先，没有就要求 `body` 非空——`body` 的定义本来就是
 * "SKILL.md 的内容"。
 */
export function resolvePayloadEntry(input: {
  slug: string
  body: string
  files?: Record<string, string> | null
  sourceRef: string
  slugOverride?: string | null
}): ResolvedSkillSource {
  const filesIn = { ...(input.files ?? {}) }
  const fromFiles = filesIn['SKILL.md']
  delete filesIn['SKILL.md']
  const body = fromFiles ?? input.body

  if (typeof body !== 'string' || body.trim() === '') {
    throw new SkillSourceError(
      'missing_skill_md',
      `远端条目「${input.slug}」没有 SKILL.md 的内容（files['SKILL.md'] 与 body 都是空的）。`,
      '远端目录必须给出 SKILL.md 的正文，否则装进来的技能永远不会生效。',
    )
  }

  const others: CollectedFile[] = []
  for (const [relPath, text] of Object.entries(filesIn)) {
    // 远端内容是外部输入：不许用 `..` 或绝对路径跑到技能目录外面去
    if (relPath.includes('..') || relPath.startsWith('/')) {
      throw new SkillSourceError(
        'bad_input',
        `远端条目的支持文件路径不合法：${relPath}`,
        '支持文件必须待在技能目录里面。',
      )
    }
    others.push({ relPath, bytes: Buffer.byteLength(text, 'utf8'), text })
  }

  const slug = input.slugOverride ?? toSlug(input.slug)
  assertValidSlug(slug, `远端条目给的 slug 是「${input.slug}」。`)

  return finish(
    { skillMd: body, others, ignored: [], topLevelNames: [] },
    {
      slug,
      sourceRef: input.sourceRef,
      resolvedFrom: `远端目录：${input.slug}`,
      emptyDirNames: [],
    },
  )
}

// ─────────────────────────────────────────────────────────────
// 统一入口
// ─────────────────────────────────────────────────────────────

export type SkillSourceSpec =
  | { kind: 'path'; path: string }
  | { kind: 'url'; url: string }
  | {
      kind: 'payload'
      slug: string
      body: string
      files?: Record<string, string> | null
      sourceRef: string
      /** 远端目录给的版本——不参与"能不能装"，只用于界面判断"是否已装/可更新"。 */
      version?: string | null
    }

/** 解析任意一种来源。`slug` 给使用者一个纠偏的机会。 */
export async function resolveSkillSource(
  spec: SkillSourceSpec,
  options: { slug?: string | null } = {},
  deps: ResolveDeps = {},
): Promise<ResolvedSkillSource> {
  switch (spec.kind) {
    case 'path':
      return resolveLocalPath(spec.path, options)
    case 'url':
      return resolveGithubUrl(spec.url, options, deps)
    case 'payload':
      return resolvePayloadEntry({ ...spec, slugOverride: options.slug ?? null })
  }
}

/** 给界面用：一句话说明这次是从哪儿装的。 */
export function describeSource(spec: SkillSourceSpec): string {
  switch (spec.kind) {
    case 'path':
      return `本地目录 ${spec.path}`
    case 'url':
      return `链接 ${spec.url}`
    case 'payload':
      return `远端目录 ${spec.slug}`
  }
}
