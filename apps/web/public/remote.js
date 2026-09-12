/**
 * 远端能力面板（M3 的浏览器侧）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这里是**跨源**的，而页面其余部分不是
 * ══════════════════════════════════════════════════════════════════
 *
 * 本页面由 daemon 托管（`http://127.0.0.1:4517`），所以访问 daemon 的接口
 * 全是相对路径、同源、不需要任何协商。
 *
 * 但**远端服务在另一个地址上**。而 daemon 刻意不向远端发起任何请求
 * （D20），所以这一跳只能由浏览器自己走——它是真跨源，必须由远端那侧
 * 放行回环来源（见 apps/remote/src/server.ts 的 isLoopbackOrigin）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 凭证放 localStorage，不放 cookie
 * ══════════════════════════════════════════════════════════════════
 *
 * 页面跑在明文 http 上。带 `Secure` 的 cookie 在明文 http 上根本不会被
 * 发送；不带 `Secure` 就等于把凭证暴露给同机的任何进程。所以用
 * localStorage + `Authorization` 头，把"凭证放哪里"交回页面自己控制。
 * 代价是 XSS 可读——而页面本身的脚本就是同源的，这个风险本来就在。
 */

const REMOTE_URL_KEY = 'alpha-helper.remote-url'
const REMOTE_TOKEN_KEY = 'alpha-helper.remote-token'

/** 默认远端地址：与 daemon 端口相邻（4517 → 4518）。 */
const DEFAULT_REMOTE_URL = 'http://127.0.0.1:4518'

export function getRemoteUrl() {
  return localStorage.getItem(REMOTE_URL_KEY) || DEFAULT_REMOTE_URL
}

export function setRemoteUrl(url) {
  localStorage.setItem(REMOTE_URL_KEY, url.replace(/\/+$/, ''))
}

function getToken() {
  return localStorage.getItem(REMOTE_TOKEN_KEY) || ''
}

function setToken(token) {
  if (token) localStorage.setItem(REMOTE_TOKEN_KEY, token)
  else localStorage.removeItem(REMOTE_TOKEN_KEY)
}

export function isLoggedIn() {
  return getToken() !== ''
}

/**
 * 调远端接口。
 *
 * 网络层失败（远端没起来）与业务失败（401/400）必须**分开报**：
 * 前者是"去把远端服务启动起来"，后者是"账号或参数不对"。
 * 混成一句"操作失败"会让人往完全错误的方向排查。
 */
async function remoteApi(path, options = {}) {
  const base = getRemoteUrl()
  const token = getToken()
  let res
  try {
    res = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    })
  } catch (err) {
    const error = new Error(
      `连不上远端服务（${base}）。请确认它已经启动：pnpm run remote`,
    )
    error.kind = 'network'
    error.cause = err
    throw error
  }

  const text = await res.text()
  const body = text ? JSON.parse(text) : null
  if (!res.ok) {
    // 401 单独标出来：页面据此把界面切回登录态，而不是弹一个哑错误
    const error = new Error(body?.error ?? `${res.status} ${res.statusText}`)
    error.status = res.status
    error.body = body
    throw error
  }
  return body
}

export const remote = {
  catalog: () => remoteApi('/api/catalog'),
  me: () => remoteApi('/api/me'),
  settings: () => remoteApi('/api/settings'),
  saveSettings: (patch) =>
    remoteApi('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  async login(email, password) {
    const out = await remoteApi('/api/accounts/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    setToken(out.token)
    return out.account
  },
  async register(email, password) {
    await remoteApi('/api/accounts/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    return this.login(email, password)
  },
  /** 拉待处理项（FR-REG-06/07）：远端按需问第三方，答完即弃。 */
  pending: () => remoteApi('/api/pending'),
  /** 上报记录（FR-REG-12）。远端只存摘要，不存正文。 */
  ingestRecords: (records) =>
    remoteApi('/api/records', { method: 'POST', body: JSON.stringify({ records }) }),
  setPluginEnabled: (name, enabled) =>
    remoteApi(`/api/plugins/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`, {
      method: 'POST',
    }),
  logout: () => setToken(''),
}
