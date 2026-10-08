import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * 工作目录的文件浏览（任务详情右边那一栏，以及 Markdown 里引用的图片）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个模块里最要紧的不是"列文件"，是**不许跑出工作目录**
 * ══════════════════════════════════════════════════════════════════
 *
 * 被读的是**使用者工作目录里的文件**，而路径来自 HTTP 查询参数。两种逃逸都要封：
 *
 *   1. **`..` / 绝对路径**：`path=../../../../etc/passwd`。用 `resolve` 之后比
 *      前缀能挡住，但要按**路径分隔符**比，不能按字符串前缀——否则
 *      `/work-other` 会被当成 `/work` 的子路径（这是最经典的一个错法）；
 *   2. **符号链接**：工作目录里放一个指向 `/etc/passwd` 的软链，路径检查
 *      一切正常。所以最终要比**真实路径**（`realpath`），而不只是拼出来的路径。
 *
 * ══════════════════════════════════════════════════════════════════
 * 第二个要紧的：发出去的 Content-Type 不能让它在本源里跑脚本
 * ══════════════════════════════════════════════════════════════════
 *
 * 这些文件是**agent 写的**，而页面由 daemon 托管 ⇒ 与 daemon 接口**同源**。
 * 一个 `.html`（或带脚本的 `.svg`）如果被当作 `text/html` 打开，里面的脚本就能
 * 拿到这个源，进而直接调 `/api/*`——那等于把"agent 写的文件"变成了一个能操作
 * 本机 daemon 的入口。
 *
 * 所以每个响应都带 `sandbox` 的 CSP（脚本一律不执行）与 `nosniff`。
 * 这样即使被当作文档打开，它也只是"一张静态图/一段静态文本"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 第三个要紧的（2026-10）：**音视频要流着发，而且要有 Range**
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者报的是「展示页面目前不支持视频文件显示」。查下来是两件事叠在一起：
 *
 *   1. 后缀表里**没有**任何 `video/*` / `audio/*` ⇒ 一个 `.mp4` 被回成
 *      `application/octet-stream` ⇒ 界面按"二进制"处理，给一屏十六进制；
 *   2. 这条路由**先把整份文件读进内存**（8MB 上限）再发 ⇒ 就算认出了类型，
 *      一段几十 MB 的视频会被"超过读取上限"挡掉，而且浏览器没法 seek。
 *
 * 所以音视频走另一条路：**不读进内存**，直接 `createReadStream` 流出去，
 * 并且认 `Range`（206 + `content-range`）。这不是优化，是**能不能播**的问题——
 * 没有 Range 就没有 seek，而"看一段视频却不能拖"等于没支持。
 *
 * ⚠️ 而且媒体响应**不带**那条 `sandbox` 的 CSP，理由写在 `MEDIA_FILE_HEADERS`
 *    上面（那条 CSP 是给"agent 写的**文档**"用的，媒体不是文档，而它会把浏览器
 *    在新标签页里为媒体合成的那张文档自己的 `media-src` 一起挡掉）。
 */

/** 单次列目录的上限——一个目录里塞几千个文件时别把页面拖垮。 */
export const MAX_ENTRIES = 500
/** 单个文件的读取上限（图片/文本够用；更大的请去磁盘上看）。 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024
/**
 * 音视频的上限——它们**不读进内存**（流着发），所以上限只防"离谱的大文件"，
 * 不防内存。8MB 那一档对视频毫无意义：一段 1080p 一分钟就有几十 MB。
 */
export const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024

export interface WorkDirEntry {
  /** 相对工作目录的路径，POSIX 风格（`/` 分隔）。 */
  path: string
  /** 目录名/文件名（不含路径）——界面显示它，层级靠缩进。 */
  name: string
  kind: 'file' | 'dir'
  sizeBytes: number
  modifiedAt: number
  /**
   * 目录里还有没有东西——界面据此决定要不要画那个展开箭头。
   *
   * 不画"点了才知道是空"的箭头：那是一次白点的交互。
   */
  hasChildren: boolean
  /**
   * 是不是**平台注入**的东西（技能目录、CLI 的状态目录、上下文文件）。
   *
   * 界面据此弱化显示：它们是"这个任务在什么标准下跑的"，不是 agent 的产出。
   * 注意这里**不用一段文字去说明**——弱化 + 悬停提示就够，正文里少一行字。
   *
   * ★ 判据来自**该 run 的 runtime 描述表**，不是写死的 `.claude/`：
   *   换一个 CLI，注入物落在别的目录里（`.agent/skills`、`AGENT.md`…），
   *   写死的规则会把它们当成 agent 的产出显示出来。
   */
  managed: boolean
}

export interface WorkDirListing {
  workDir: string
  /** 这次列的是哪个子目录（相对工作目录；空串 = 顶层）。 */
  dir: string
  /** **直接子项**，不是整棵树。 */
  entries: WorkDirEntry[]
  /** 因为条数上限而没列全。 */
  truncated: boolean
  /**
   * 这个目录**存在吗**。
   *
   * ★ 与「存在但是空的」分开：聊天里对话刚建、第一轮还没跑，目录还没被建出来，
   *   而两种情况都是空列表。界面上那两句话给出的下一步完全不同（"再等等" vs
   *   "它确实没产出"），所以这个事实由服务端给，不让界面猜。
   */
  exists: boolean
}

/**
 * 平台会往工作目录里写哪些路径——**从描述表算**，不是写死。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么值得抽出来
 * ══════════════════════════════════════════════════════════════════
 *
 * 原来这里是 `isManaged()`：一个写死 `CLAUDE.md` 与 `.claude/**` 的函数。
 * 对 claude 正确，对任何别的 CLI 都是错的——而错的方式是**静默的**：
 * 界面会把平台注入物当成 agent 的产出显示，使用者据此判断"它做了什么"。
 *
 * 这三处正是描述表里已有的字段（技能投递目录、CLI 状态目录、上下文文件名），
 * 所以这里不需要新数据，只需要**别写死**。
 */
export interface ManagedPaths {
  /** 平台注入的目录（相对工作目录，不带尾部斜杠）。 */
  dirs: readonly string[]
  /** 平台注入的文件（相对工作目录）。 */
  files: readonly string[]
}

export function managedPathsFor(descriptor: {
  skills: { kind: 'directory'; dir: string } | { kind: 'none'; reason: string }
  stateDir?: string
}): ManagedPaths {
  const dirs: string[] = []
  if (descriptor.skills.kind === 'directory') dirs.push(descriptor.skills.dir)
  if (descriptor.stateDir) dirs.push(descriptor.stateDir)
  // 我们自己的上下文副本（每次 run 一份，见 D29）。
  // ⚠️ 它**不是** CLI 的项目记忆文件——名字是我们自己起的，CLI 不认识它。
  dirs.push(CONTEXT_DIR)
  return { dirs: [...new Set(dirs)], files: [] }
}

/** 我们自己放上下文副本的地方（相对工作目录）。 */
export const CONTEXT_DIR = '.agentdeck'

function isManaged(relPath: string, managed: ManagedPaths): boolean {
  if (managed.files.includes(relPath)) return true
  return managed.dirs.some((dir) => relPath === dir || relPath.startsWith(`${dir}/`))
}

/**
 * 列**一个目录的直接子项**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么改成"一层一层列"而不是一次递归整棵树
 * ══════════════════════════════════════════════════════════════════
 *
 * 第一版递归整棵树（深度 4，最多 500 项）。实测的问题不是性能，是**读不了**：
 * 一个技能目录就能带出 `.claude/skills/algorithmic-art/templates/viewer.html`
 * 这种一长串路径，把真正的产出（`bubble-sort.js` 之类）淹掉十几行里。
 * 使用者的原话是"格式不好，建议还是默认第一级文件和目录，目录可以点击展开"。
 *
 * 所以：默认只给第一级；要往下看就点那个目录（`dir` 参数），一次一层。
 * 顺带把 `hasChildren` 算出来，让界面只在真有空子目录时才画箭头。
 */
export async function listWorkDir(
  workDir: string,
  dir = '',
  /**
   * 平台注入的路径——由调用方按**这个 run 的 runtime** 算好传进来
   * （`managedPathsFor`）。默认空：不确定的时候**不要**猜。
   */
  managed: ManagedPaths = { dirs: [], files: [] },
): Promise<WorkDirListing> {
  const root = await realpath(workDir).catch(() => resolve(workDir))
  const target = dir === '' ? root : await resolveWorkFilePath(workDir, dir)

  const info = await stat(target).catch(() => null)
  if (info === null) {
    // 顶层目录不存在（工作目录被清理掉了、或还没建）⇒ 给一个空列表而不是报错：
    // 界面那一栏显示"这个目录还是空的"，比弹一个错更贴合事实
    if (dir === '') return { workDir, dir, entries: [], truncated: false, exists: false }
    throw new UnsafePathError(`目录不存在：${dir}`)
  }
  if (!info.isDirectory()) throw new UnsafePathError(`不是一个目录：${dir}`)

  let items
  try {
    items = await readdir(target, { withFileTypes: true })
  } catch {
    // 读不了就当成空目录：列文件失败不该让整个视图报错
    // 目录在，只是读不了（权限等）——那是「存在但不是空的」这一档，不该说成
    // 「还不存在」（两者要采取的行动不一样）。
    return { workDir, dir, entries: [], truncated: false, exists: true }
  }

  const entries: WorkDirEntry[] = []
  let truncated = false

  for (const item of items) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    if (item.name === '.git') continue // 版本库内部结构只会淹掉真正的产出
    if (item.name === '.DS_Store') continue // macOS 的目录元数据，不是产出

    const full = join(target, item.name)
    const rel = dir === '' ? item.name : `${dir}/${item.name}`

    // 软链：不跟随（可能指到目录外面去，也可能成环），当成普通条目列出
    const statInfo = await stat(full).catch(() => null)
    if (!statInfo) continue

    const isDir = item.isDirectory() || (item.isSymbolicLink() && statInfo.isDirectory())
    let hasChildren = false
    if (isDir) {
      hasChildren = await readdir(full).then((kids) => kids.length > 0).catch(() => false)
    }

    entries.push({
      path: rel,
      name: item.name,
      kind: isDir ? 'dir' : 'file',
      sizeBytes: isDir ? 0 : statInfo.size,
      modifiedAt: statInfo.mtimeMs,
      hasChildren,
      managed: isManaged(rel, managed),
    })
  }

  // 目录在前、再按名字：找产出时先看结构
  entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
  )
  return { workDir, dir, entries, truncated, exists: true }
}

/** 路径不安全时的原因——直接给使用者看。 */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafePathError'
  }
}

/**
 * 把一个**相对路径**解析成工作目录内的真实绝对路径。
 *
 * 两道检查缺一不可（见文件头）：
 *   1. 拼接并 `resolve` 之后，必须在工作目录**之内**（按分隔符比前缀）；
 *   2. `realpath` 之后仍在之内——这一道才挡得住软链。
 */
export async function resolveWorkFilePath(workDir: string, relPath: string): Promise<string> {
  if (relPath === '') throw new UnsafePathError('缺少 path 参数')
  if (relPath.includes('\0')) throw new UnsafePathError('路径里有非法字符')

  // 绝对路径直接拒绝，而不是"把它当相对的"——静默纠正会让调用方以为自己对了。
  // ⚠️ 判据用 `isAbsolute` 而不是 `startsWith('/')`：Windows 上绝对路径还有
  //    `C:\…`、`\\server\share\…`、`\x` 三种形态，都不以 `/` 开头（2026-10
  //    Windows 兼容性审计）。用 `startsWith('/')` 时它们会落到下面那道"跑出了
  //    工作目录"——**拦住是拦住了**（真正管用的是下面 `resolve` + `sep` 比前缀那道），
  //    但报出来的原因是错的。
  if (isAbsolute(relPath)) throw new UnsafePathError('path 必须是相对工作目录的路径')

  const root = await realpath(workDir).catch(() => resolve(workDir))
  const target = resolve(root, relPath)

  // ★ 必须按分隔符比较，不能用 startsWith(root)：否则 /work-other 会被
  //   当成 /work 的子路径
  if (target !== root && !target.startsWith(root + sep)) {
    throw new UnsafePathError('path 跑出了工作目录')
  }

  const real = await realpath(target).catch(() => null)
  if (real === null) throw new UnsafePathError(`文件不存在：${relPath}`)
  if (real !== root && !real.startsWith(root + sep)) {
    // 走到这里说明中间有软链指向了工作目录之外
    throw new UnsafePathError('这个文件通过符号链接指向了工作目录之外，拒绝读取')
  }
  return real
}

/**
 * 一份**已经过全部守卫**的文件：真实路径、大小、类型，以及"该不该流着发"。
 *
 * ⚠️ 之所以要这个中间层，是为了让"守卫 / 上限 / 类型"三件事只有**一处**实现：
 *    路由那条现在有两条发法（流式 / 读进内存），两处各写一遍守卫就会分叉，
 *    而分叉的表现是"其中一条路上能读到工作目录外面的文件"——最难查的那种。
 */
export interface WorkFileHandle {
  /** 磁盘上的真实路径（软链已经解开、已经在工作目录之内）。 */
  path: string
  size: number
  contentType: string
  /** 音视频：流着发 + 认 Range（理由见文件顶上那一段）。 */
  streamable: boolean
}

/**
 * 媒体类型吗——判据是**类型**，不是后缀：`contentTypeFor` 是"这个文件是什么"的
 * 唯一出处（与界面那边 `file-view.ts` 的分工一致）。
 */
export function isStreamableType(contentType: string): boolean {
  const type = contentType.split(';')[0]!.trim().toLowerCase()
  return type.startsWith('video/') || type.startsWith('audio/')
}

/** 解开路径、查大小与类型，并按档检查上限。**所有守卫都在这里**。 */
export async function openWorkFile(workDir: string, relPath: string): Promise<WorkFileHandle> {
  const full = await resolveWorkFilePath(workDir, relPath)
  const info = await stat(full)
  if (!info.isFile()) throw new UnsafePathError(`不是一个文件：${relPath}`)
  const contentType = contentTypeFor(relPath)
  const streamable = isStreamableType(contentType)
  const cap = streamable ? MAX_MEDIA_BYTES : MAX_FILE_BYTES
  if (info.size > cap) {
    throw new UnsafePathError(
      `文件有 ${Math.round(info.size / 1024)}KB，超过 ${Math.round(cap / 1024 / 1024)}MB 的上限。` +
        `请直接在磁盘上打开它。`,
    )
  }
  return { path: full, size: info.size, contentType, streamable }
}

/** 读一个文件（有大小上限）——非媒体那条路（界面要的就是这串字节）。 */
export async function readWorkFile(workDir: string, relPath: string): Promise<Buffer> {
  const handle = await openWorkFile(workDir, relPath)
  return readFile(handle.path)
}

/**
 * 解析 `Range: bytes=…`。
 *
 * 只支持**单区间**：多区间要回 `multipart/byteranges`，而浏览器放媒体从来只问
 * 单区间；认不出来的区间就当"没有 Range"（回 200 整份），不当错误——那是
 * HTTP 允许的（服务器可以忽略 Range）。
 *
 * 三档返回值：
 *   · `null`            ⇒ 没有 Range 头（或认不出），回 200 整份；
 *   · `'unsatisfiable'` ⇒ 有 Range 但**越界**，必须回 **416** + `content-range: bytes *​/size`
 *     （回 200 整份是不合规的：客户端会以为拿到了它要的那一段）；
 *   · `{start,end}`     ⇒ 回 206，带 `content-range`。`end` 是**闭区间**（HTTP 语义）。
 */
export function parseByteRange(
  header: string | null | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return null
  // 空 size：任何区间都越界
  if (size <= 0) return 'unsatisfiable'

  if (rawStart === '') {
    // `bytes=-N`：**最后** N 个字节
    const n = Number(rawEnd)
    if (!Number.isFinite(n) || n <= 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable'
  if (rawEnd === '') return { start, end: size - 1 }
  const end = Number(rawEnd)
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

/**
 * 音视频响应的头。
 *
 * ⚠️ **没有**那条 `sandbox` 的 CSP，这是刻意的：`WORK_FILE_HEADERS` 里那条 CSP
 *    是给**文档**用的（挡住 agent 写的 html/svg 在本源里跑脚本）。媒体不是文档，
 *    而那条 CSP 会把浏览器在新标签页里为媒体合成的那张文档自己也一起管住
 *    （`default-src 'none'` ⇒ 它自己的 `media-src` 落回 `none`，视频放不出来）。
 *    安全性并没有因此变松：`nosniff` + 正确的 `video/*` 类型 ⇔ 浏览器**不会**
 *    把它当文档解析，所以"agent 写的文件反过来操作 daemon"那条路依然是断的。
 */
export const MEDIA_FILE_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  /** 让浏览器知道可以按区间来取（seek 就靠它）。 */
  'accept-ranges': 'bytes',
}

/**
 * 后缀 → Content-Type。
 *
 * ⚠️ 覆盖不到的一律给 `application/octet-stream`（**不是**猜成 text/plain）：
 *    猜错类型会让浏览器去渲染一个本来不该渲染的东西。
 */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.mmd': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  // ── 音视频（2026-10）──────────────────────────────────────────────
  //
  // ⚠️ 这里给的是**容器**的类型，不是编码的：能不能播由浏览器决定（`.mkv`、
  //    `.avi` 这类容器 Chrome 多半放不了，那是浏览器的事，界面会把"放不出来"
  //    如实说一句，而不是假装它坏了）。给类型这件事我们只说"这是什么文件"。
  //
  // ⚠️ 刻意**没有** `.ts`：那个后缀在本项目里绝大多数时候是 TypeScript 源码，
  //    把它当 MPEG-TS 视频会让一堆代码文件变成播放器。
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
}

export function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return 'application/octet-stream'
  return CONTENT_TYPES[name.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 每个工作目录文件响应都要带上的头。
 *
 * ══════════════════════════════════════════════════════════════════
 * 关键在 `sandbox` **允许脚本、但不允许同源**
 * ══════════════════════════════════════════════════════════════════
 *
 * 这些文件是 **agent 写的**，而页面由 daemon 托管 ⇒ 与接口**同源**。所以一个
 * agent 写出来的 `html`/`svg` 被当文档打开时，**默认**就拿到了这个源：能读所有
 * run 日志、能装 skill、能提交任务。这是需要堵住的东西。
 *
 * 第一版把脚本一律禁掉（`sandbox; default-src 'none'`），安全但**把产出也废了**：
 * 实测有任务产出的是一个 p5.js 画布页（`bubble-sort-art.html`，39KB、两个
 * `<script>`、从 CDN 载 p5），禁掉脚本之后点开是**一片空白**——使用者会以为
 * 又坏了，而那是他真正想看的交付物。
 *
 * 现在的取舍：
 *
 *   - **`sandbox allow-scripts`**（**没有** `allow-same-origin`）⇒ 文档落在
 *     一个**不透明源**里。脚本能跑，页面能画出来；但它读不到这个源的任何东西：
 *     `fetch('/api/…')` 变成跨源请求，而 daemon 不发任何 CORS 头 ⇒ **响应不可读**；
 *     cookie 与 localStorage 也拿不到。于是"agent 写的页面反过来操作 daemon"
 *     这条路仍然是断的；
 *   - ⚠️ **绝不要加 `allow-same-origin`**：加上它就等于把上面那条断掉的路接回去。
 *     测试里专门钉了这一条。
 *   - 资源指令放宽到 `'unsafe-inline'` 与 `https:`：离线单文件页面里的样式与
 *     内联脚本是常态，而它们在这个隔离里已经拿不到我们的数据。
 *
 * 残留的能力（已知且接受）：不透明源里的脚本**仍能发出请求**（只是读不到响应）。
 * 这对本机 daemon 不是新增威胁——任何网站都能这么干（回环地址 + 无 CSRF 令牌），
 * 而这个页面至少是你自己机器上、你自己让它跑出来的东西写的。
 */
export const WORK_FILE_HEADERS: Record<string, string> = {
  'content-security-policy': [
    'sandbox allow-scripts',
    "default-src 'none'",
    "script-src 'unsafe-inline' https:",
    "style-src 'unsafe-inline' https: data:",
    'img-src data: blob: https:',
    'font-src data: https:',
    'connect-src https:',
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
}
