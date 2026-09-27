import { readFile, stat } from 'node:fs/promises'

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
  /** 这个响应该带什么缓存头——见 `cacheHeadersFor`。 */
  cacheControl: string
  /**
   * 内容指纹（`W/"<mtimeMs>-<size>"`）。
   *
   * ⚠️ 这不是优化，是**正确性**：没有 ETag 也没有 Last-Modified 时，浏览器对
   *    这份响应没有任何"这是哪一版"的依据，也就没有办法判断自己手上那份是不是
   *    旧的。这个项目已经**两次**被"界面与 daemon 各是哪一版"咬到（第一次是
   *    能力标志，第二次是下面这段注释写的事故）。
   */
  etag: string
}

/**
 * 静态资源的缓存策略。
 *
 * ══════════════════════════════════════════════════════════════════
 * 起因：一次"任务页能用、聊天页不能用"的误判
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者报告聊天页那一栏不工作、任务页那栏正常。查下来：**daemon 是好的**
 * （接口 200、内容正确），**当前这份前端也是好的**（干净浏览器里量到那一栏在、
 * 5 项、几何正常）——他看的是一个**旧前端**：页面早就开着，而重建前端不会通知
 * 已经打开的标签页。
 *
 * 而这里原本**一个缓存头都不发**：`index.html` 没有 `Cache-Control`、没有
 * `ETag`、没有 `Last-Modified`。于是浏览器拿它没有任何办法——既不知道能不能
 * 复用，也没有依据去问"变了没有"。
 *
 * 现在的规矩按"文件名有没有内容哈希"分：
 *
 *   · **`/assets/*`**（Vite 产物带内容哈希）⇒  `immutable` + 一年。文件内容
 *     变了文件名就变了，所以这是安全的——也是唯一能让重建之后**不必**让使用者
 *     手动清缓存的一档。
 *   · **其余（含 `index.html`）** ⇒  `no-cache`。注意它**不是**"不缓存"，而是
 *     "可以存，但每次都要回来问一句"。这一档是**外壳**：它指向哪个 `/assets/`
 *     包决定了界面是哪一版，所以它必须每次核对。
 *
 * ⚠️ 别把 `index.html` 也设成 `immutable`：那样重建之后浏览器会一直用旧外壳，
 *    而旧外壳指向的旧包**已经不存在了**（Vite 每次构建会清空 dist）——症状是
 *    一个白页，或者更坏：一个仍然跑着旧逻辑的页面。
 */
export function cacheHeadersFor(pathname: string): { cacheControl: string } {
  if (pathname.startsWith('/assets/')) {
    return { cacheControl: 'public, max-age=31536000, immutable' }
  }
  return { cacheControl: 'no-cache' }
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
    const target = new URL(normalized.slice(1), DIST_DIR)
    const body = await readFile(target)
    const info = await stat(target).catch(() => null)
    return {
      contentType,
      body,
      cacheControl: cacheHeadersFor(normalized).cacheControl,
      etag: `W/"${Math.round(info?.mtimeMs ?? 0)}-${body.length}"`,
    }
  } catch {
    // 文件不存在是**正常路径**（浏览器会请求 favicon 之类），返回 null
    // 让调用方去 404，而不是抛异常把请求处理打挂
    return null
  }
}

/**
 * 这份界面是**哪一版**（构建产物的文件名），给 `/api/identity` 用。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么值得把它暴露出来
 * ══════════════════════════════════════════════════════════════════
 *
 * "界面与 daemon 各是哪一版"在这个项目里已经咬过两次（能力标志、以及那次
 * "任务页能用、聊天页不能用"）。两次的现场都有同一个特征：**两边都不报错**，
 * 只能靠人去猜"你刷新过没有"。
 *
 * 把这一版的名字放在身份接口里，"我现在跑的是哪一版前端"就变成一句可查的话，
 * 而不是一场猜测。拿不到（没构建）时返回 `null`——那时该说的是"界面没构建"。
 */
export async function webBuildId(): Promise<string | null> {
  try {
    const html = await readFile(new URL('index.html', DIST_DIR), 'utf8')
    // 外壳里引用的是 `./assets/index-<hash>.js`；取那一段就够回答"哪一版"
    const m = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html)
    return m ? m[1]! : null
  } catch {
    return null
  }
}
