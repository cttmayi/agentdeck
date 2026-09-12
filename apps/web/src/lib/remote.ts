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

const REMOTE_URL_KEY = 'alpha-helper.remote-url'
const REMOTE_TOKEN_KEY = 'alpha-helper.remote-token'
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
    throw new RemoteError(
      `连不上远端服务（${base}）。请确认它已经启动：pnpm run remote`,
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

export interface CatalogSkill {
  slug: string
  version: string
  summary: string
  content: string
}

export interface Catalog {
  skills: CatalogSkill[]
  tools: Array<{ name: string; summary: string }>
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
