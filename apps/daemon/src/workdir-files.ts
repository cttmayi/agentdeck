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

/** 列出文件的上限——不能让一个装满 node_modules 的工作目录把内存和页面拖垮。 */
export const MAX_ENTRIES = 500
/** 递归深度上限。 */
export const MAX_DEPTH = 4
/** 单个文件的读取上限（图片/文本够用；更大的请去磁盘上看）。 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024

export interface WorkDirEntry {
  /** 相对工作目录的路径，POSIX 风格（`/` 分隔）。 */
  path: string
  kind: 'file' | 'dir'
  sizeBytes: number
  modifiedAt: number
  /**
   * 是不是**平台注入**的东西（`.claude/**`、`CLAUDE.md`）。
   *
   * 界面据此把它们弱化显示：它们是"这个任务在什么标准下跑的"，不是 agent 的产出。
   * 这两类混在一起列，使用者会分不清哪个是"它做出来的"。
   */
  managed: boolean
}

export interface WorkDirListing {
  workDir: string
  entries: WorkDirEntry[]
  /** 因为条数/深度上限而没列全——**要说出来**，否则界面看起来像"就这些"。 */
  truncated: boolean
}

/** 平台自己写进去的路径（不删除技能之后，这些会一直在）。 */
function isManaged(relPath: string): boolean {
  return relPath === 'CLAUDE.md' || relPath === '.claude' || relPath.startsWith('.claude/')
}

/**
 * 列目录。
 *
 * 目录也列出来（`kind: 'dir'`）：使用者找东西时，"这里有三个子目录"本身是信息。
 * 但**不**下钻到 `.git`：那是版本库内部结构，列出来只会淹掉真正的产出。
 */
export async function listWorkDir(workDir: string): Promise<WorkDirListing> {
  const entries: WorkDirEntry[] = []
  let truncated = false

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      return
    }
    let items
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch {
      return // 读不了就跳过：列文件失败不该让整个视图报错
    }

    for (const item of items) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true
        return
      }
      const full = join(dir, item.name)
      const rel = relative(workDir, full).split(sep).join('/')
      if (item.name === '.git') continue

      // 软链：不跟随（可能指到目录外面去，也可能成环）。当成一个普通条目列出。
      if (item.isSymbolicLink()) {
        const info = await stat(full).catch(() => null)
        entries.push({
          path: rel,
          kind: info?.isDirectory() ? 'dir' : 'file',
          sizeBytes: info?.size ?? 0,
          modifiedAt: info?.mtimeMs ?? 0,
          managed: isManaged(rel),
        })
        continue
      }

      const info = await stat(full).catch(() => null)
      if (!info) continue

      if (item.isDirectory()) {
        entries.push({
          path: rel,
          kind: 'dir',
          sizeBytes: 0,
          modifiedAt: info.mtimeMs,
          managed: isManaged(rel),
        })
        if (depth + 1 <= MAX_DEPTH) await walk(full, depth + 1)
        else truncated = true
        continue
      }

      if (!item.isFile()) continue // 管道/设备之类：不是"产出"
      entries.push({
        path: rel,
        kind: 'file',
        sizeBytes: info.size,
        modifiedAt: info.mtimeMs,
        managed: isManaged(rel),
      })
    }
  }

  await walk(workDir, 0)
  // 目录在前、再按路径排序：使用者找产出时先看结构
  entries.sort((a, b) =>
    a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'dir' ? -1 : 1,
  )
  return { workDir, entries, truncated }
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
 * `Content-Security-Policy: sandbox` 是这里的重点：它让浏览器把这个响应当成
 * **独立沙箱**里的文档，脚本一律不执行、也没有同源身份。于是"agent 写了一个
 * 带脚本的 html/svg，使用者点开它就获得了对本机 daemon 的调用能力"这条路被堵死。
 */
export const WORK_FILE_HEADERS: Record<string, string> = {
  'content-security-policy': "sandbox; default-src 'none'; img-src data: blob:",
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
}
