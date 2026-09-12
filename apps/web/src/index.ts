import { readFile } from 'node:fs/promises'

/**
 * 静态资源服务。
 *
 * M0 的 UI 是**零构建**的：纯 HTML + 原生 ES 模块，由 daemon 直接托管。
 * 这样做有三个好处，都跟 D19 的架构选择直接相关：
 *
 *   1. **同源** —— 页面与本地接口同源，跨源那一整套（Origin 白名单、
 *      一次性令牌、私有网络访问预检）都不需要；
 *   2. **离线可用** —— 资源在本机，断网照常工作；
 *   3. **版本天然匹配** —— UI 与 daemon 一起升级，不存在协议新旧不一致。
 *
 * 设计文档里写的是 Next.js。M0 先用零构建版本跑通闭环；等 UI 复杂到
 * 需要组件化与路由时再换，而**换的代价被这层挡住了**——替换本文件即可。
 */

/** public/ 相对于本模块——用 import.meta.url 拼，不要用文件路径再转 URL。 */
const PUBLIC_DIR = new URL('../public/', import.meta.url)

export interface StaticAsset {
  contentType: string
  body: Buffer
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

/** 允许被请求的文件白名单——避免把 public 目录变成任意文件读取。 */
const ALLOWED = new Set([
  '/',
  '/index.html',
  '/app.js',
  '/remote.js',
  '/remote-panel.js',
  '/sync.js',
  '/style.css',
  '/logo.svg',
])

export async function loadStatic(pathname: string): Promise<StaticAsset | null> {
  const normalized = pathname === '/' ? '/index.html' : pathname
  if (!ALLOWED.has(pathname) && !ALLOWED.has(normalized)) return null

  const ext = normalized.slice(normalized.lastIndexOf('.'))
  const contentType = CONTENT_TYPES[ext]
  if (!contentType) return null

  try {
    const body = await readFile(new URL(normalized.slice(1), PUBLIC_DIR))
    return { contentType, body }
  } catch {
    return null
  }
}
