/**
 * 远端服务客户端（跨源）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这一跳是跨源的，而 daemon 那一跳不是
 * ══════════════════════════════════════════════════════════════════
 *
 * 页面由 daemon 托管，所以调 daemon 全是相对路径、同源、无需协商。
 * 而**远端服务在另一个地址上**，且 daemon 刻意不向远端发请求（D20）——
 * 这一跳只能由浏览器自己走，是真跨源，必须由远端那侧放行回环来源
 * （见 `apps/remote/src/server.ts` 的 `isLoopbackOrigin`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 凭证放 localStorage 而不是 cookie
 * ══════════════════════════════════════════════════════════════════
 *
 * 页面跑在明文 http 上：带 `Secure` 的 cookie 不会被发送，不带 `Secure`
 * 就等于把凭证暴露给同机任何进程。所以用 localStorage + `Authorization` 头。
 */
import { renderText, webText } from '@agentdeck/i18n'
import { currentLocale } from './locale.ts'
import type { ToolManifest } from './api.ts'

const REMOTE_URL_KEY = 'agentdeck.remote-url'
const REMOTE_TOKEN_KEY = 'agentdeck.remote-token'
const DEFAULT_REMOTE_URL = 'http://127.0.0.1:4518'

export function getRemoteUrl(): string {
  return localStorage.getItem(REMOTE_URL_KEY) || DEFAULT_REMOTE_URL
}

export function setRemoteUrl(url: string): void {
  localStorage.setItem(REMOTE_URL_KEY, url.replace(/\/+$/, ''))
}

export function getToken(): string {
  return localStorage.getItem(REMOTE_TOKEN_KEY) || ''
}

export function setToken(token: string): void {
  if (token) localStorage.setItem(REMOTE_TOKEN_KEY, token)
  else localStorage.removeItem(REMOTE_TOKEN_KEY)
}

export function isLoggedIn(): boolean {
  return getToken() !== ''
}

export class RemoteError extends Error {
  readonly status: number | null
  /** `network` 表示远端没起来；`auth` 表示凭证过期。两者的处置完全不同。 */
  readonly kind: 'network' | 'auth' | 'business'

  constructor(message: string, status: number | null, kind: RemoteError['kind']) {
    super(message)
    this.name = 'RemoteError'
    this.status = status
    this.kind = kind
  }
}

async function remoteApi<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const base = getRemoteUrl()
  const token = getToken()
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
    })
  } catch (err) {
    // 这句话会是顶栏/设置抽屉上给使用者看的提示（`remoteError`），所以要跟着
    // 界面语言走；地址本身是值，用插值带进去。
    throw new RemoteError(
      renderText(webText, 'err.remoteUnreachable', currentLocale(), { base }),
      null,
      'network',
    )
  }

  const text = await res.text()
  let body: unknown = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = { raw: text.slice(0, 500) }
    }
  }

  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`
    // 401 要单独标出来：页面据此把界面切回登录态，而不是弹一个哑错误
    throw new RemoteError(message, res.status, res.status === 401 ? 'auth' : 'business')
  }
  return body as T
}

export interface RemoteAccount {
  id: string
  email: string
  displayName: string
}

export interface PluginInfo {
  name: string
  capability: string
  version: string
  /** 代码**加载**成功了吗。 */
  loaded: boolean
  /** 使用者**启用**了吗。与 `loaded` 必须分开看。 */
  enabled: boolean
  error: string | null
  /** 只给键名，**不给值**（密钥值绝不经过读取接口）。 */
  secretKeys: string[]
}

/**
 * 远端目录里的一个**技能**条目（2026-10：推荐清单）。
 *
 * ★ 与工具包那条路的关键区别：技能的取包规则在 daemon 侧
 *   （`@agentdeck/skill-source`），而写目录的那个独立工具**用同一份实现**
 *   把内容抓下来放进目录。所以条目里带的 `sourceRef` 是**原始 GitHub 来源**，
 *   不是 `remote:…`——远端在这里是中转，不是出处。
 *
 * ⚠️ `files` **必须一起带下去装**：技能可以带支持文件（pptx 有 `scripts/`、
 *    `LICENSE.txt`），少了它装进来只有 `SKILL.md`。那种技能是坏的，而且坏得很
 *    安静——界面显示"已安装"，跑起来才发现少东西。
 */
export interface CatalogSkill {
  slug: string
  /** 上游那个目录最近一次提交的短 sha；取不到时是 null。 */
  version: string | null
  /** 给人看的名字（清单里写的）。 */
  name?: string
  summary: string
  /** SKILL.md 的正文。 */
  content: string
  /** 支持文件（相对路径 → 内容）。 */
  files?: Record<string, string>
  /** 清单里声明排除、没有装进来的文件（相对路径）。非空 ⇒ 这一条**内容不完整**。 */
  excluded?: string[]
  /** 原始来源标识（`github:owner/repo@ref:dir`）——落库时原样交给 daemon。 */
  sourceRef?: string
  category?: string
  origin?: 'official' | 'community'
  /** 相对"你已经有的能力"补什么。 */
  fills?: string | null
  /** 装完还得自己配的东西（**必须在装之前显示**）。 */
  needs?: string | null
  /** 这份内容是什么时候抓的（ISO）。 */
  fetchedAt?: string
}

/**
 * 远端目录里的一个**工具包**条目（D40）。
 *
 * 一个包 = 一个组，装一次整组可用。形状与 `apps/remote/src/server.ts` 的
 * `catalog.tools`（源头是 `apps/remote/src/catalog.ts` 的 `CatalogToolEntry`）
 * 一一对应。
 *
 * ★ `manifest` / `files` / `docs` 是**随列表一起给**的（与 skill 那条路同形）：
 *   装的时候直接把它们交给本机 daemon（`POST /api/tools {source:'payload'}`），
 *   中间**没有第二次取内容的机会**——两次取会让"页面看到的那份"与"装进去的
 *   那份"可以不一样，而那种不一致没有任何报错。
 */
export interface CatalogTool {
  slug: string
  name: string
  version: string | null
  summary: string
  /** 清单元件（原样）；本地会用**同一份 schema**再校验一遍。 */
  manifest: ToolManifest
  /** 包里的文本文件（相对路径 → 内容），含入口脚本。 */
  files: Record<string, string>
  /** `TOOL.md` 的正文（没有就是空串）。 */
  docs: string
}

export interface Catalog {
  skills: CatalogSkill[]
  tools: CatalogTool[]
  loginMethods: Array<{ name: string; summary: string }>
}

export const remote = {
  catalog: () => remoteApi<Catalog>('/api/catalog'),
  me: () => remoteApi<{ account: RemoteAccount; plugins: PluginInfo[] }>('/api/me'),
  settings: () => remoteApi<Record<string, unknown>>('/api/settings'),
  saveSettings: (patch: Record<string, unknown>) =>
    remoteApi('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  async login(email: string, password: string): Promise<RemoteAccount> {
    const out = await remoteApi<{ token: string; account: RemoteAccount }>('/api/accounts/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    setToken(out.token)
    return out.account
  },

  async register(email: string, password: string): Promise<RemoteAccount> {
    await remoteApi('/api/accounts/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    return this.login(email, password)
  },

  pending: () =>
    remoteApi<{ items: unknown[]; warnings: Array<{ plugin: string; reason: string }>; queried: string[] }>(
      '/api/pending',
    ),

  ingestRecords: (records: unknown[]) =>
    remoteApi('/api/records', { method: 'POST', body: JSON.stringify({ records }) }),

  setPluginEnabled: (name: string, enabled: boolean) =>
    remoteApi(`/api/plugins/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`, {
      method: 'POST',
    }),

  logout: () => setToken(''),
}
