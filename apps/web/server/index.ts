import { readFile } from 'node:fs/promises'

/**
 * 静态资源服务（Vite 构建产物）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么守着**白名单**而不是"认不出来就发 index.html"
 * ══════════════════════════════════════════════════════════════════
 *
 * SPA 常见的做法是"任何前端路由都回 index.html"。这里**不做**，两个原因：
 *
 *   - **它会把 404 消灭掉。** 请求一个写错的资源路径，得到的是一份 HTML
 *     而不是"文件不存在"——浏览器报的是 MIME 类型错误，排查方向完全跑偏。
 *   - **前端路由不需要它。** 本应用的视图走 hash（`#/tasks`），`#` 之后
 *     的东西**根本不会发给服务端**。所以"路径不存在"永远是真的不存在，
 *     没有需要兜底的场景。
 *
 * ══════════════════════════════════════════════════════════════════
 * 构建产物缺失时**大声报错**，不发一个空白页
 * ══════════════════════════════════════════════════════════════════
 *
 * Vite 产物在 `dist/`，而它是 gitignore 的——所以克隆下来直接 `pnpm run daemon`
 * 会**没有界面**。这种情况必须说清楚怎么做（跑一次构建），而不是发一个
 * 空白页让人以为是 daemon 坏了。
 *
 * 这与本项目其他地方一脉相承：**宁可失败得体面，不可静默降级**。
 */

/** dist/ 相对于本模块——用 import.meta.url 拼，不要用文件路径再转 URL。 */
const DIST_DIR = new URL('../dist/', import.meta.url)

export interface StaticAsset {
  contentType: string
  body: Buffer
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/**
 * 路径安全。
 *
 * 不逐个列文件名（Vite 产物带内容哈希，列名字意味着每次构建都要改代码），
 * 而是限制**形状**：不许 `..`、不许空字节、必须是绝对路径形式。
 * 加上扩展名必须在白名单里，能发出去的就只剩 dist/ 下的静态资源。
 */
function isSafePath(pathname: string): boolean {
  if (pathname.includes('..')) return false
  if (pathname.includes('\0')) return false
  return pathname.startsWith('/')
}

/**
 * 构建产物是否就位。daemon 启动时检查一次，好在日志里给出可读提示。
 *
 * 查一个必然存在的文件而不是读整个目录：`index.html` 一定有，
 * 而读目录在有几千个产物文件时不划算。
 */
export async function isWebBuilt(): Promise<boolean> {
  try {
    await readFile(new URL('index.html', DIST_DIR))
    return true
  } catch {
    return false
  }
}

/** 给使用者的可读提示——由 daemon 在启动时打出来。 */
export const NOT_BUILT_HINT =
  'Web UI 尚未构建（找不到 apps/web/dist/）。请先运行：pnpm run build:web\n' +
  '  提示：构建产物不进版本库，所以每次 clone 之后都要跑一次。'

export async function loadStatic(pathname: string): Promise<StaticAsset | null> {
  const normalized = pathname === '/' ? '/index.html' : pathname
  if (!isSafePath(normalized)) return null

  const lastDot = normalized.lastIndexOf('.')
  if (lastDot === -1) return null
  const ext = normalized.slice(lastDot)
  const contentType = CONTENT_TYPES[ext]
  if (!contentType) return null

  try {
    const body = await readFile(new URL(normalized.slice(1), DIST_DIR))
    return { contentType, body }
  } catch {
    // 文件不存在是**正常路径**（浏览器会请求 favicon 之类），返回 null
    // 让调用方去 404，而不是抛异常把请求处理打挂
    return null
  }
}
