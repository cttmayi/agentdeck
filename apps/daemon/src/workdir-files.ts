import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

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
 */

/** 单次列目录的上限——一个目录里塞几千个文件时别把页面拖垮。 */
export const MAX_ENTRIES = 500
/** 单个文件的读取上限（图片/文本够用；更大的请去磁盘上看）。 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024

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
   * 是不是**平台注入**的东西（`.claude/**`、`CLAUDE.md`）。
   *
   * 界面据此弱化显示：它们是"这个任务在什么标准下跑的"，不是 agent 的产出。
   * 注意这里**不用一段文字去说明**——弱化 + 悬停提示就够，正文里少一行字。
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
}

/** 平台自己写进去的路径（不删除技能之后，这些会一直在）。 */
function isManaged(relPath: string): boolean {
  return relPath === 'CLAUDE.md' || relPath === '.claude' || relPath.startsWith('.claude/')
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
export async function listWorkDir(workDir: string, dir = ''): Promise<WorkDirListing> {
  const root = await realpath(workDir).catch(() => resolve(workDir))
  const target = dir === '' ? root : await resolveWorkFilePath(workDir, dir)

  const info = await stat(target).catch(() => null)
  if (info === null) {
    // 顶层目录不存在（工作目录被清理掉了、或还没建）⇒ 给一个空列表而不是报错：
    // 界面那一栏显示"这个目录还是空的"，比弹一个错更贴合事实
    if (dir === '') return { workDir, dir, entries: [], truncated: false }
    throw new UnsafePathError(`目录不存在：${dir}`)
  }
  if (!info.isDirectory()) throw new UnsafePathError(`不是一个目录：${dir}`)

  let items
  try {
    items = await readdir(target, { withFileTypes: true })
  } catch {
    // 读不了就当成空目录：列文件失败不该让整个视图报错
    return { workDir, dir, entries: [], truncated: false }
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
      managed: isManaged(rel),
    })
  }

  // 目录在前、再按名字：找产出时先看结构
  entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
  )
  return { workDir, dir, entries, truncated }
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

  // 绝对路径直接拒绝，而不是"把它当相对的"——静默纠正会让调用方以为自己对了
  if (relPath.startsWith('/')) throw new UnsafePathError('path 必须是相对工作目录的路径')

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

/** 读一个文件（有大小上限）。 */
export async function readWorkFile(workDir: string, relPath: string): Promise<Buffer> {
  const full = await resolveWorkFilePath(workDir, relPath)
  const info = await stat(full)
  if (!info.isFile()) throw new UnsafePathError(`不是一个文件：${relPath}`)
  if (info.size > MAX_FILE_BYTES) {
    throw new UnsafePathError(
      `文件有 ${Math.round(info.size / 1024)}KB，超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 的读取上限。` +
        `请直接在磁盘上打开它。`,
    )
  }
  return readFile(full)
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
