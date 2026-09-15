import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  enabledPluginsFor,
  loadPlugins,
  type LoadedPlugin,
  type PluginCapability,
} from './plugins.ts'
import { collectPending } from './pending.ts'
import { PluginStore } from './plugin-store.ts'
/**
 * 远端服务（M3，D19/D20）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它只做五件事
 * ══════════════════════════════════════════════════════════════════
 *
 * 1. 账号与登录
 * 2. 用户设定
 * 3. 公共 SKILL/TOOL 目录
 * 4. 第三方查询（转发）
 * 5. 记录与统计接收
 *
 * ══════════════════════════════════════════════════════════════════
 * 它绝不做的事（否则整个架构就退化成"又一个云平台"）
 * ══════════════════════════════════════════════════════════════════
 *
 * - **不保存任何 payload**。第三方查询是"你来问、我转发、答完即弃"。
 *   正因为不留存，才不需要 TTL、不需要过期策略、不需要清理任务。
 *   （需求方原话："不需要暂存，有需求的时候，远端重新调用端口去询问第3方"。）
 * - **不决定谁来审、审成什么样**。审核标准与判决都在 daemon 侧。
 *   远端若也存一份标准，两边会漂移。
 * - **不主动推任何东西**。daemon 不向远端发起请求；本服务永远是被动的。
 *
 * ══════════════════════════════════════════════════════════════════
 * 认证：为什么是 token 而不是 cookie
 * ══════════════════════════════════════════════════════════════════
 *
 * daemon 的 Web UI 跑在 `http://127.0.0.1:<port>`，是**明文 http**。
 * 带 `Secure` 的 cookie 在明文 http 上不会被发送；不带 `Secure` 就等于
 * 把凭证暴露给同机的任何进程去嗅探。所以用 localStorage + `Authorization`
 * 头，把"凭证放哪里"这件事交回页面自己控制。
 */

export interface RemoteAccount {
  id: string
  email: string
  displayName: string
  createdAt: string
}

export interface RemoteOptions {
  /** 数据目录；`null` 表示纯内存（测试用）。 */
  dataDir?: string | null
  port?: number
  host?: string
  /** 预置插件。 */
  plugins?: LoadedPlugin[]
  now?: () => Date
}

interface StoredAccount extends RemoteAccount {
  /** 口令哈希（scrypt-like 简化：sha256(salt + password)）。 */
  salt: string
  secret: string
}

interface StoredToken {
  token: string
  accountId: string
  createdAt: string
}

/** 记录接收：只存**计数与摘要**，不存正文（见文件头的"不保存 payload"）。 */
interface IngestRecord {
  accountId: string
  kind: 'run' | 'verdict' | 'action'
  /** 摘要的 sha256——用于去重与校验，不可逆推正文。 */
  digest: string
  conclusion?: string
  reasonCode?: string
  actionType?: string
  occurredAt: string
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const

function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function deriveSecret(password: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${password}`).digest('hex')
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export class RemoteService {
  readonly #accounts = new Map<string, StoredAccount>()
  readonly #tokens = new Map<string, StoredToken>()
  readonly #settings = new Map<string, Record<string, unknown>>()
  readonly #records: IngestRecord[] = []
  readonly #dataDir: string | null
  readonly #port: number
  readonly #host: string
  readonly #now: () => Date
  #plugins: LoadedPlugin[]
  /**
   * 插件状态与密钥（FR-PLUGIN-09/11）。
   *
   * ★ 单独一个存储：密钥不能和普通设定混在 `remote.json` 里——
   *   那样它会跟着设定一起被备份、导出、贴进 issue。见 plugin-store.ts。
   */
  readonly #pluginStore: PluginStore
  #server: Server | null = null
  #loaded = false

  constructor(options: RemoteOptions = {}) {
    this.#dataDir = options.dataDir === undefined ? null : options.dataDir
    this.#port = options.port ?? 0
    this.#host = options.host ?? '127.0.0.1'
    this.#now = options.now ?? (() => new Date())
    this.#plugins = options.plugins ?? []
    this.#pluginStore = new PluginStore(this.#dataDir)
  }

  get plugins(): readonly LoadedPlugin[] {
    return this.#plugins
  }

  /** 插件状态与密钥的存取口（测试与 CLI 用）。 */
  get pluginStore(): PluginStore {
    return this.#pluginStore
  }

  /**
   * 现在**真正可用**的插件 = 加载成功 **且** 使用者没有停用。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么"停用"必须在这里生效，而不是只改个显示字段
   * ══════════════════════════════════════════════════════════════════
   *
   * FR-PLUGIN-09 要求"插件必须能独立启用 / 停用"。最容易做错的做法是
   * 只在清单视图里把 `enabled` 改掉——那样界面显示已停用，而**查询照旧
   * 走那个插件**。使用者以为自己关掉了它，实际上没有。
   *
   * 这与本项目反复在防的那类失败同源：**界面说的和实际做的不一致**。
   * 所以判据收敛到这一个方法上，调用方不可能绕过。
   */
  async activePlugins(capability: PluginCapability): Promise<LoadedPlugin[]> {
    await this.#pluginStore.load()
    return enabledPluginsFor(this.#plugins, capability).filter((p) =>
      this.#pluginStore.isEnabled(p.manifest.name),
    )
  }

  /** 清单视图：把"加载成功"与"使用者启用"两件事**分开**呈现。 */
  async pluginInventory(): Promise<
    Array<{
      name: string
      capability: PluginCapability
      version: string
      loaded: boolean
      enabled: boolean
      error: string | null
      secretKeys: string[]
    }>
  > {
    await this.#pluginStore.load()
    return this.#plugins.map((p) => ({
      name: p.manifest.name,
      capability: p.manifest.capability,
      version: p.manifest.version,
      // 两个字段必须分开：一个插件可能"加载成功但被停用"，
      // 也可能"加载失败所以谈不上启用"。混成一个布尔就分不清了。
      loaded: p.enabled,
      enabled: p.enabled && this.#pluginStore.isEnabled(p.manifest.name),
      error: p.error,
      // ★ 只给键名，不给值。见 plugin-store.ts 的说明。
      secretKeys: this.#pluginStore.secretKeysOf(p.manifest.name),
    }))
  }

  /** 从 manifest 列表加载插件（失败隔离，见 plugins.ts）。 */
  loadPluginManifests(entries: ReadonlyArray<{ manifest: unknown; impl: unknown }>): void {
    this.#plugins = loadPlugins(entries)
  }

  /**
   * 直接接收**已经加载完成**的插件。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么不能只留 `loadPluginManifests`
   * ══════════════════════════════════════════════════════════════════
   *
   * `loadPluginManifests` 会**重新校验一遍 manifest**，而它看不到加载器
   * 那边发生的失败——代码求值失败、`entry` 越界、语法错误等等。
   *
   * 后果是实测出来的：一个 `entry` 越界的插件，加载器已经明确拒绝了它，
   * 但 `/api/me` 的插件清单里它显示成 `enabled: true, error: null`。
   *
   * 这个谎的代价不小：**插件清单是运维唯一的排查入口**（FR-PLUGIN-10）。
   * 一个坏掉的插件显示成"已启用"，会让人去别处找一个根本不存在的 bug。
   */
  setPlugins(plugins: LoadedPlugin[]): void {
    this.#plugins = plugins
  }

  async #persist(): Promise<void> {
    if (this.#dataDir === null) return
    const path = join(this.#dataDir, 'remote.json')
    await writeFile(
      path,
      JSON.stringify(
        {
          accounts: [...this.#accounts.values()],
          tokens: [...this.#tokens.values()],
          settings: [...this.#settings.entries()],
        },
        null,
        2,
      ),
      'utf8',
    )
  }

  async #load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    if (this.#dataDir === null) return
    await mkdir(this.#dataDir, { recursive: true })
    try {
      const raw = await readFile(join(this.#dataDir, 'remote.json'), 'utf8')
      const parsed = JSON.parse(raw) as {
        accounts?: StoredAccount[]
        tokens?: StoredToken[]
        settings?: [string, Record<string, unknown>][]
      }
      for (const a of parsed.accounts ?? []) this.#accounts.set(a.id, a)
      for (const t of parsed.tokens ?? []) this.#tokens.set(t.token, t)
      for (const [k, v] of parsed.settings ?? []) this.#settings.set(k, v)
    } catch {
      // 首次启动，无文件——正常路径，不是错误。
    }
  }

  // ── 职责 1：账号与登录 ────────────────────────────────────────────

  async register(email: string, password: string, displayName?: string): Promise<RemoteAccount> {
    await this.#load()
    if (email.trim() === '' || !email.includes('@')) throw new Error('需要合法的邮箱')
    if ([...this.#accounts.values()].some((a) => a.email === email)) {
      throw new Error('该邮箱已注册')
    }
    if (password.length < 8) throw new Error('口令至少 8 位')
    const id = `acc_${randomBytes(8).toString('hex')}`
    const salt = randomBytes(16).toString('hex')
    const account: StoredAccount = {
      id,
      email,
      displayName: displayName ?? email.split('@')[0] ?? email,
      createdAt: this.#now().toISOString(),
      salt,
      secret: deriveSecret(password, salt),
    }
    this.#accounts.set(id, account)
    await this.#persist()
    return this.#publicAccount(account)
  }

  async login(email: string, password: string): Promise<{ token: string; account: RemoteAccount }> {
    await this.#load()
    const account = [...this.#accounts.values()].find((a) => a.email === email)
    if (!account) throw new Error('邮箱或口令不正确')
    if (!constantTimeEqual(account.secret, deriveSecret(password, account.salt))) {
      throw new Error('邮箱或口令不正确')
    }
    const token = randomBytes(24).toString('hex')
    this.#tokens.set(token, { token, accountId: account.id, createdAt: this.#now().toISOString() })
    await this.#persist()
    return { token, account: this.#publicAccount(account) }
  }

  /**
   * 插件登录入口。
   *
   * 内置口令登录**始终可用**——插件是扩展，不是替代。
   * 若某个 login 插件挂了，`enabledPluginsFor` 会把它滤掉，
   * 口令登录不受影响（失败隔离的对外表现）。
   */
  async loginPlugins(): Promise<LoadedPlugin[]> {
    return this.activePlugins('login')
  }

  #publicAccount(a: StoredAccount): RemoteAccount {
    return { id: a.id, email: a.email, displayName: a.displayName, createdAt: a.createdAt }
  }

  #authenticate(header: string | undefined): RemoteAccount | null {
    if (!header || !header.startsWith('Bearer ')) return null
    const token = header.slice('Bearer '.length)
    const rec = this.#tokens.get(token)
    if (!rec) return null
    const account = this.#accounts.get(rec.accountId)
    return account ? this.#publicAccount(account) : null
  }

  // ── 职责 2：用户设定 ──────────────────────────────────────────────

  async getSettings(accountId: string): Promise<Record<string, unknown>> {
    await this.#load()
    return this.#settings.get(accountId) ?? {}
  }

  async putSettings(accountId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.#load()
    const next = { ...(this.#settings.get(accountId) ?? {}), ...patch }
    this.#settings.set(accountId, next)
    await this.#persist()
    return next
  }

  // ── 职责 3：公共 SKILL/TOOL 目录 ─────────────────────────────────

  /**
   * 目录只提供"有哪些、怎么拿"，**不提供审核标准**。
   * 审核标准是每个工作区的判断，属于 daemon 侧（见文件头）。
   */
  catalog = {
    /**
     * ★ 公共目录里**不再有** `general-review`（D38）。
     *
     * 那一份是"审核标准"，而审核标准属于 daemon 侧——它内联在每个审核者身上
     * （`Agent.reviewStandard`，D37）。放在这里会重新制造一个我们已经去掉的
     * 混淆：让使用者以为"要审东西先得装一份 skill"。
     *
     * ⚠️ 目录**可以为空**，界面要有对应的空态——"目录里什么都没有"是一句
     *    真话，比放一份已经不该用的东西强。
     */
    skills: [],

    tools: [
      { name: 'report.get', summary: '读取报告正文' },
      { name: 'issue.update_status', summary: '变更 issue 状态' },
    ],
  }

  // ── 职责 4：第三方查询（转发，不落盘） ───────────────────────────

  async queryThirdParty(
    pluginName: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.#load()
    const plugin = (await this.activePlugins('third-party')).find(
      (p) => p.manifest.name === pluginName,
    )
    if (!plugin) {
      // 区分"不存在"与"被停用"——两者的下一步动作完全不同
      const known = this.#plugins.find((p) => p.manifest.name === pluginName)
      if (known) {
        throw new Error(
          known.enabled
            ? `第三方插件 ${pluginName} 已被停用。要使用它请先启用。`
            : `第三方插件 ${pluginName} 不可用：${known.error ?? '加载失败'}`,
        )
      }
      throw new Error(`没有可用的第三方插件：${pluginName}`)
    }
    const impl = plugin.impl as
      | { query?: (params: Record<string, unknown>) => Promise<Record<string, unknown>> }
      | null
    if (!impl || typeof impl.query !== 'function') {
      throw new Error(`插件 ${pluginName} 未实现 query`)
    }
    // 刻意不做任何缓存——"答完即弃"。
    return impl.query(params)
  }

  // ── 职责 5：记录与统计接收 ───────────────────────────────────────

  async ingest(accountId: string, records: IngestRecord[]): Promise<{ accepted: number }> {
    await this.#load()
    for (const r of records) {
      this.#records.push({
        ...r,
        accountId,
        digest: r.digest || digestOf({ kind: r.kind, at: r.occurredAt }),
        occurredAt: r.occurredAt || this.#now().toISOString(),
      })
    }
    const tail = this.#records.slice(-5000)
    this.#records.length = 0
    this.#records.push(...tail)
    await this.#persist()
    return { accepted: records.length }
  }

  async stats(accountId: string): Promise<Record<string, unknown>> {
    await this.#load()
    const mine = this.#records.filter((r) => r.accountId === accountId)
    const by = (k: 'kind' | 'conclusion' | 'actionType'): Record<string, number> => {
      const out: Record<string, number> = {}
      for (const r of mine) {
        const key = r[k]
        if (typeof key === 'string') out[key] = (out[key] ?? 0) + 1
      }
      return out
    }
    return {
      total: mine.length,
      byKind: by('kind'),
      byConclusion: by('conclusion'),
      byActionType: by('actionType'),
    }
  }

  // ── HTTP ─────────────────────────────────────────────────────────

  get port(): number {
    const addr = this.#server?.address()
    return typeof addr === 'object' && addr !== null ? addr.port : this.#port
  }

  async start(): Promise<number> {
    await this.#load()
    const server = createServer((req, res) => {
      void this.#handle(req, res)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.#port, this.#host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.#server = server
    return this.port
  }

  async close(): Promise<void> {
    const server = this.#server
    if (!server) return
    this.#server = null
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin
    const allowed = isLoopbackOrigin(origin)
    if (allowed && origin) {
      res.setHeader('access-control-allow-origin', origin)
      // 带上 Authorization 的跨源请求必然触发预检，必须显式允许这两个头。
      res.setHeader('access-control-allow-headers', 'authorization, content-type')
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS')
      // 回环域名之间的来源各不相同（端口不同），缓存预检结果没有意义。
      res.setHeader('vary', 'Origin')
    }

    // 预检：即使来源不被允许也返回 204 且不带 CORS 头——
    // 浏览器会据此拒绝真正的请求，而服务端无需多说什么。
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const send = (status: number, body: unknown): void => {
      res.writeHead(status, JSON_HEADERS)
      res.end(JSON.stringify(body))
    }
    try {
      const url = new URL(req.url ?? '/', `http://${this.#host}:${this.port}`)
      const path = url.pathname
      const account = this.#authenticate(req.headers.authorization)

      if (req.method === 'GET' && path === '/api/health') {
        send(200, { ok: true, apiVersion: 1 })
        return
      }

      // 公开端点（无需登录）
      if (req.method === 'POST' && path === '/api/accounts/register') {
        const body = (await this.#readJson(req)) as {
          email?: string
          password?: string
          displayName?: string
        }
        const created = await this.register(
          String(body.email ?? ''),
          String(body.password ?? ''),
          body.displayName,
        )
        send(201, created)
        return
      }
      if (req.method === 'POST' && path === '/api/accounts/login') {
        const body = (await this.#readJson(req)) as { email?: string; password?: string }
        send(200, await this.login(String(body.email ?? ''), String(body.password ?? '')))
        return
      }

      // 目录是公开的——它只是"有哪些能力"，不含任何用户数据。
      if (req.method === 'GET' && path === '/api/catalog') {
        send(200, {
          ...this.catalog,
          // 登录插件列表也公开：页面需要据此渲染登录方式。
          loginMethods: [
            { name: 'password', summary: '邮箱 + 口令（内置）' },
            ...(await this.loginPlugins()).map((p) => ({
              name: p.manifest.name,
              summary: `插件 ${p.manifest.version}`,
            })),
          ],
        })
        return
      }

      if (!account) {
        send(401, { error: '未登录', code: 'unauthenticated' })
        return
      }

      if (path === '/api/me' && req.method === 'GET') {
        send(200, { account, plugins: await this.pluginInventory() })
        return
      }

      // ── 插件启停（FR-PLUGIN-09）──
      const pluginToggle = /^\/api\/plugins\/([^/]+)\/(enable|disable)$/.exec(path)
      if (pluginToggle && req.method === 'POST') {
        const name = decodeURIComponent(pluginToggle[1]!)
        const known = this.#plugins.find((p) => p.manifest.name === name)
        if (!known) {
          send(404, { error: `没有名为 ${name} 的插件` })
          return
        }
        await this.#pluginStore.setEnabled(name, pluginToggle[2] === 'enable')
        // 回整个清单而不是单个结果：启用/停用会影响"哪些登录方式可用"，
        // 只回一个布尔会让页面拿不到它真正要重画的东西。
        send(200, { ok: true, plugins: await this.pluginInventory() })
        return
      }

      // ── 插件密钥（FR-PLUGIN-11）──
      //
      // 写入可以，**读取不行**：GET 只回"哪些键已设置"。
      // 原因见 plugin-store.ts——密钥一旦进了响应就会出现在浏览器内存、
      // 日志、截图里，而调用方通常只想知道"配好了没有"。
      const pluginSecrets = /^\/api\/plugins\/([^/]+)\/secrets$/.exec(path)
      if (pluginSecrets) {
        const name = decodeURIComponent(pluginSecrets[1]!)
        const known = this.#plugins.find((p) => p.manifest.name === name)
        if (!known) {
          send(404, { error: `没有名为 ${name} 的插件` })
          return
        }
        if (req.method === 'GET') {
          send(200, { name, keys: this.#pluginStore.secretKeysOf(name) })
          return
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const body = (await this.#readJson(req)) as Record<string, unknown>
          for (const [key, value] of Object.entries(body)) {
            if (typeof value !== 'string') {
              send(400, { error: `密钥 ${key} 的值必须是字符串` })
              return
            }
            await this.#pluginStore.setSecret(name, key, value)
          }
          send(200, { ok: true, keys: this.#pluginStore.secretKeysOf(name) })
          return
        }
        if (req.method === 'DELETE') {
          const url3 = new URL(req.url ?? '/', 'http://localhost')
          const key = url3.searchParams.get('key')
          if (!key) {
            send(400, { error: '删除密钥需要 ?key=<名称>' })
            return
          }
          send(200, { ok: await this.#pluginStore.clearSecret(name, key) })
          return
        }
      }

      if (path === '/api/settings') {
        if (req.method === 'GET') {
          send(200, await this.getSettings(account.id))
          return
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const body = (await this.#readJson(req)) as Record<string, unknown>
          send(200, await this.putSettings(account.id, body))
          return
        }
      }

      // ── 待处理项（FR-REG-06/07/11）──
      //
      // 页面定期来问"这台机器有没有要处理的东西"。远端**按需去问第三方**，
      // 答完即弃——**绝不暂存**（FR-REG-07）。正因为不留存，才不需要 TTL、
      // 不需要清理任务、也不需要"谁的队列"这个概念。
      //
      // 一个第三方失败不影响其他的（FR-REG-11）：跳过并把原因放进 warnings。
      // warnings 必须**返回给调用方**而不只是写日志——页面要据此发通知，
      // 只写日志等于静默丢弃。
      if (path === '/api/pending' && req.method === 'GET') {
        const result = await collectPending({
          plugins: await this.activePlugins('third-party'),
          store: this.#pluginStore,
          account: { id: account.id, email: account.email, displayName: account.displayName },
        })
        send(200, result)
        return
      }

      if (path === '/api/third-party/query' && req.method === 'POST') {
        const body = (await this.#readJson(req)) as {
          plugin?: string
          params?: Record<string, unknown>
        }
        const result = await this.queryThirdParty(
          String(body.plugin ?? ''),
          body.params ?? {},
        )
        send(200, result)
        return
      }

      if (path === '/api/records' && req.method === 'POST') {
        const body = (await this.#readJson(req)) as { records?: IngestRecord[] }
        send(202, await this.ingest(account.id, body.records ?? []))
        return
      }

      if (path === '/api/stats' && req.method === 'GET') {
        send(200, await this.stats(account.id))
        return
      }

      send(404, { error: `没有这个端点：${path}`, code: 'not_found' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 认证类错误返回 401，其余 400——让客户端能区分"该重新登录"与"参数不对"。
      const status = /邮箱或口令|未登录/.test(message) ? 401 : 400
      send(status, { error: message })
    }
  }

  async #readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    if (raw.trim() === '') return {}
    return JSON.parse(raw)
  }
}


/**
 * 回环来源判定（M3）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这里**必须**有 CORS，而 daemon 那边**必须没有**
 * ══════════════════════════════════════════════════════════════════
 *
 * daemon 的 Web UI 与 daemon 的 API 同源（都是 `127.0.0.1:<daemon端口>`），
 * 所以 daemon 侧不需要 CORS，FR-BRIDGE-11 也明确禁止它主动放宽——
 * 同源策略本身就是那道防线。
 *
 * 但页面要访问的**远端**在另一个地址上（`code ② 远端接口（跨源）`），
 * 这是真正的跨源请求。它不能被"同源策略自动解决"，只能显式放行。
 *
 * 放行的范围刻意收窄到 **回环来源**：发起方是跑在本机浏览器里的页面，
 * 它的 Origin 一定是 `http://127.0.0.1:*` / `http://localhost:*` / `[::1]`。
 * 任意公网站点都不在名单里——否则任何一个网页都能拿着用户的 token 打远端。
 *
 * `Authorization` 头会让浏览器先发 OPTIONS 预检，所以预检必须被正确应答，
 * 否则带 token 的请求在浏览器里根本发不出去（且错误信息很难懂）。
 */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

export { digestOf }
