import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  enabledPluginsFor,
  loadPlugins,
  type LoadedPlugin,
  type PluginCapability,
} from './plugins.ts'
import { collectPending } from './pending.ts'
import { PluginStore } from './plugin-store.ts'
import { loadCatalogSkills, loadCatalogTools, type CatalogSkillEntry, type CatalogToolEntry } from './catalog.ts'
import { CONFIG_FILE_NAME, summarizeManifest } from '../../../tools/skill-catalog-sync/src/manifest-config.ts'
import {
  LocalSkillConflict,
  describeInstallError,
  installLocalSkill,
  listLocalSkills,
  uninstallLocalSkill,
} from './local-skills.ts'
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
 * - **不保存任何 payload**（**一处例外见下**）。第三方查询是"你来问、我转发、答完即弃"。
 *   正因为不留存，才不需要 TTL、不需要过期策略、不需要清理任务。
 *   （需求方原话："不需要暂存，有需求的时候，远端重新调用端口去询问第3方"。）
 *   ⚠️ 唯一例外是**公共技能目录**：内容由一个**独立工具**
 *   （`tools/skill-catalog-sync/`，`pnpm run sync-skills`）从推荐的 GitHub 技能抓下来，
 *   写进数据目录（`CATALOG_SKILLS_SUBDIR`）。那是"公共目录"这件事本身要的东西，
 *   **不是**使用者的 payload。本服务**不抓取技能**（不碰 `api.github.com`、
 *   没有一行抓取代码）：它只读那个目录（每次请求重扫），写它的那个进程是谁跟它无关
 *   （D50 / 2026-10 A 案）。
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

/**
 * 公共目录里工具包的默认根目录。
 *
 * 它指向**仓库里那份**（`apps/remote/catalog/tools`），里面有一个可装的简单
 * 范例。部署时用 `toolsDir` 覆盖；指向不存在的目录是合法的（空目录 = 空目录）。
 */
const DEFAULT_TOOLS_DIR = fileURLToPath(new URL('../catalog/tools', import.meta.url))

/**
 * 公共目录里**技能**（推荐清单）的默认根目录。
 *
 * ⚠️ 与工具包不同，它**不在仓库里**：技能内容由一个**独立工具**
 *    （`tools/skill-catalog-sync/`）从上游抓下来，写进这个目录。仓库里只有清单
 *    （`tools/skill-catalog-sync/recommended-skills.json`，只有 URL 与我们自己写的说明）。
 *
 * ⚠️ 这个目录是**两个进程之间唯一的约定**：工具写、本服务读。工具用 `--out`
 *    改到别处、或本服务用 `--data-dir` 改了数据目录，两边就对不上了——那时的
 *    表现是"界面里目录是空的"，而两个进程都不觉得自己错了。所以工具会把写到了
 *    哪儿打出来。
 *
 * 纯内存模式（测试）没有数据目录：这时它指向一个不存在的路径——"目录里什么都
 * 没有"是一句真话，界面要有空态，这与工具包那条路同一个口径。
 */
const CATALOG_SKILLS_SUBDIR = 'catalog-skills'

/**
 * 手动安装的技能落在**另一个子目录**（D52）：同步工具独占 `catalog-skills`，
 * 它整目录原子替换，手动塞进去的东西下次同步就没了（而且是静默消失）。
 * 详见 `local-skills.ts` 顶部那段。
 */
const CATALOG_SKILLS_LOCAL_SUBDIR = 'catalog-skills-local'

/**
 * 管理页的构建产物目录（`apps/remote/web/dist`）。
 *
 * ⚠️ 相对本文件解析（`import.meta.url`），不是相对 `process.cwd()`：服务可能从
 *    任何目录启动，而"管理页在哪儿"只跟代码在哪儿有关。
 */
const DEFAULT_WEB_DIR = fileURLToPath(new URL('../web/dist', import.meta.url))

/**
 * 同步工具（`tools/skill-catalog-sync/src/cli.ts`）。
 *
 * ★ **服务不 import 它**，而是当子进程跑：2026-10 的定案是"抓取与远端服务分开"
 *   （使用者原话："还是单独工具吧，不要和 remote 连在一起"）。把它当子进程跑，
 *   这条线仍然成立——抓取崩了不影响服务，服务也不必为抓取装任何东西。
 *   文件不在（比如部署时只带了 apps/）⇒ 按钮置灰并说明原因，**不是**静默失败。
 */
const DEFAULT_SYNC_TOOL = fileURLToPath(
  new URL('../../../tools/skill-catalog-sync/src/cli.ts', import.meta.url),
)

/** 静态文件的类型表（少到不需要引依赖）。 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/** 同步状态（一个进程里同时只允许一次）。 */
export interface SyncStatus {
  state: 'idle' | 'running' | 'ok' | 'failed' | 'unavailable'
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
  /** 子进程输出里**末尾**若干行（界面直接显示，不加工、不截断成一句话）。 */
  tail: string[]
}

/** 同步输出最多留多少行（够看清失败原因，又不会把内存与界面撑爆）。 */
const SYNC_TAIL_LINES = 200

export interface RemoteOptions {
  /** 数据目录；`null` 表示纯内存（测试用）。 */
  dataDir?: string | null
  port?: number
  host?: string
  /** 预置插件。 */
  plugins?: LoadedPlugin[]
  /**
   * 管理页的静态产物目录；`null` = 不托管页面（纯 API）。
   * 缺省 `apps/remote/web/dist`（见 `DEFAULT_WEB_DIR`）。
   */
  webDir?: string | null
  /**
   * 注入 fetch，供"手动装一条技能"用（**测试用**，与 `DaemonOptions.fetchImpl`
   * 同一个理由：单元测试绝不联网，NFR-T-01）。
   */
  fetchImpl?: typeof fetch
  /**
   * 推荐清单的**配置文件**路径；`null` = 不读清单（页面就只说"看不到清单"）。
   * 缺省 `<dataDir>/recommended-skills.json`——与工具那边的默认一致
   * （工具会**转存**内置默认到这里，服务只读）。见 `manifest-config.ts`。
   */
  manifest?: string | null
  /**
   * 同步工具的入口脚本；`null` = 不提供"重新同步"按钮。
   * 缺省自动探测仓库里的 `tools/skill-catalog-sync/src/cli.ts`（见 `DEFAULT_SYNC_TOOL`）。
   * ⚠️ 服务**不 import** 它，只把它当子进程跑——见 `DEFAULT_SYNC_TOOL` 的说明。
   */
  syncTool?: string | null
  /**
   * 公共目录里**工具包**的根目录（D40）。
   *
   * 缺省是仓库里的 `apps/remote/catalog/tools`——那里放着一个可装的简单范例
   * （`hello-tool`）。测试与部署都可以覆盖它；指向不存在的目录是合法的
   * （"目录里什么都没有"是一句真话，界面要有空态）。
   */
  toolsDir?: string
  /**
   * 公共目录里**技能**的根目录（推荐清单）。
   *
   * 缺省是 `<dataDir>/catalog-skills`——**不在代码仓库里**，见
   * `CATALOG_SKILLS_SUBDIR` 那段注释。测试与部署都可以覆盖它。
   */
  skillsDir?: string
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
  /** 公共目录里工具包的根目录（见 `RemoteOptions.toolsDir`）。 */
  readonly #toolsDir: string
  /** 公共目录里技能的根目录（见 `RemoteOptions.skillsDir`）。 */
  readonly #skillsDir: string
  /** 管理页产物目录；`null` = 不托管页面。 */
  readonly #webDir: string | null
  /** 手动安装的技能的目录（本地层，D52）。 */
  readonly #localSkillsDir: string
  /** 注入的 fetch（测试用；不给就是全局 fetch）。 */
  readonly #fetchImpl: typeof fetch | undefined
  /** 推荐清单的配置文件（只读；工具才转存）。 */
  readonly #manifestPath: string | null
  /** 同步工具入口；`null` = 不提供同步按钮。 */
  readonly #syncTool: string | null
  /** 同步状态（一个进程里同时只允许一次）。 */
  #sync: SyncStatus = { state: 'idle', startedAt: null, finishedAt: null, exitCode: null, tail: [] }
  #syncChild: ReturnType<typeof spawn> | null = null
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
    // ★ 一律转成**绝对路径**（`resolve`）：`loadCatalogSkills` / `resolveLocalPath`
    //   （共用取包规则）**只收绝对路径**——这是它刻意的规定（相对路径取决于调用方从
    //   哪个目录启动）。2026-10 实测撞到：`--data-dir .cache/x`（相对）时，本地装的
    //   技能**一条都列不出来**（服务日志里有一句"本地装的技能没有列出去：…路径必须是
    //   绝对路径"）。第二次踩同一类坑了——所以这里一次把四个目录都转绝对。
    this.#dataDir =
      options.dataDir === undefined || options.dataDir === null ? options.dataDir ?? null : resolve(options.dataDir)
    this.#port = options.port ?? 0
    this.#host = options.host ?? '127.0.0.1'
    this.#now = options.now ?? (() => new Date())
    this.#plugins = options.plugins ?? []
    this.#toolsDir = resolve(options.toolsDir ?? DEFAULT_TOOLS_DIR)
    this.#skillsDir = resolve(
      options.skillsDir ??
        (this.#dataDir === null
          ? join(homedir(), '.agentdeck', 'remote', CATALOG_SKILLS_SUBDIR)
          : join(this.#dataDir, CATALOG_SKILLS_SUBDIR)),
    )
    this.#fetchImpl = options.fetchImpl
    this.#localSkillsDir = resolve(
      this.#dataDir === null
        ? join(homedir(), '.agentdeck', 'remote', CATALOG_SKILLS_LOCAL_SUBDIR)
        : join(this.#dataDir, CATALOG_SKILLS_LOCAL_SUBDIR),
    )
    this.#manifestPath =
      options.manifest === undefined
        ? (this.#dataDir === null
            ? join(homedir(), '.agentdeck', 'remote', CONFIG_FILE_NAME)
            : join(this.#dataDir, CONFIG_FILE_NAME))
        : options.manifest
    this.#webDir = options.webDir === undefined ? DEFAULT_WEB_DIR : options.webDir
    this.#syncTool = options.syncTool === undefined ? DEFAULT_SYNC_TOOL : options.syncTool
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
     * ★ 技能目录（2026-10：推荐清单）。
     *
     * ⚠️ 这一段是**占位**：真正的内容在 `/api/catalog` 那条路由里由
     *    `loadCatalogSkills(this.#skillsDir)` 现扫现给（每次请求重扫，与工具包
     *    同一条理由）。这里留 `[]` 是为了"目录的形状有一处确定的答案"。
     *
     * 两条历史，都还在生效：
     *   · 公共目录里**不再有** `general-review`（D38）——那一份是"审核标准"，
     *     而审核标准内联在每个审核者身上（`Agent.reviewStandard`，D37）。放进
     *     目录会重新制造那个我们已经去掉的混淆："要审东西先得装一份 skill"。
     *   · 目录**可以为空**，界面要有对应的空态——"目录里什么都没有"是一句真话，
     *     比放一份已经不该用的东西强。
     */
    skills: [] as CatalogSkillEntry[],

    /**
     * ★ 工具包目录（D40）。
     *
     * ══════════════════════════════════════════════════════════════════
     * 这一节只回答"目录里**可以**列工具"，不提供安装
     * ══════════════════════════════════════════════════════════════════
     *
     * 一个条目就是**一个包**（一段可以装进来的目录），不是单个动作：
     *
     *   · `slug`     —— 包名，同时是动作的命名空间（动作名是 `<slug>.<动作名>`）
     *   · `name`     —— 给人看的名字
     *   · `version`  —— 清单里的版本（`x.y.z`），没有就是 null
     *   · `summary`  —— 一句话说明
     *
     * ⚠️ 它**现在是空的**，而且**不打算**在这里长出"点一下就装"的能力：
     *    装工具包会在使用者的机器上落盘、并让那些脚本真的被执行，所以判据
     *    （清单 schema、限额、入口文件必须在包里）全部在 daemon 侧的
     *    `apps/daemon/src/tool-source.ts` 里。远端只负责"有哪些、叫什么"。
     *
     * 为什么还要先立这一节：形状要有一处**确定的**答案。等到真的有包可发的
     * 那天再临时决定它长什么样，就会变成"远端说 A、daemon 按 B 解析"，
     * 而那种不一致的表现是装进来的包少了一个动作。
     *
     * ⚠️ 原来这里的两条（`report.get` / `issue.update_status`）是**动作名**，
     *    不是包。D40 里这个位置放整个包，留着它们会让"tools 里的是包"这条
     *    读法在第一条记录上就破功（`report` 这个包根本不存在）。
     */
    /**
     * ★ 工具包目录（D40）：**从磁盘上的包读出来**，内容是原样带下去的。
     *
     * 一个条目就是**一个包**（一段可以装进来的目录），不是单个动作：
     * 本地装的是同一个格式（`tool.json` + 入口脚本），判据也是同一份 schema
     * （`packages/protocol/src/tools.ts`）——所以"远端说 A、daemon 按 B 解析"
     * 这类不一致在这里没有立足之地。
     *
     * ⚠️ 远端**不做安装**：装工具包会在使用者机器上落盘、并让那些脚本真的被
     *    执行，那件事只能由本机的 daemon 做（`apps/daemon/src/tool-source.ts`）。
     *    这里只回答"有哪些包、内容是什么"。
     *
     * ⚠️ 内容随列表一起给（与 skill 那条路同形）：多一次往返换来的是"页面拿到
     *    的东西就是装进去的东西"，中间没有"再取一次内容"的机会去漂移。
     */
    tools: [] as CatalogToolEntry[],
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
    // 同步还在跑就把它收掉：服务关了却留一个子进程在写目录，是最容易漏的那种残留
    if (this.#syncChild !== null) {
      this.#syncChild.kill('SIGTERM')
      this.#syncChild = null
    }
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
        // ★ 每次都重扫目录：远端目录是可以被人往里加包的，缓存住会让
        //   "我刚放进去的包怎么不出现"变成一个需要重启才能解释的谜。
        const loaded = await loadCatalogTools(this.#toolsDir)
        for (const item of loaded.skipped) {
          console.warn(`[warn] 目录里的包没有列出去：${item.path} —— ${item.reason}`)
        }
        // ★ 技能也**每次重扫**（与工具包同一条理由）：远端目录是可以被维护者
        //   往里放东西的，缓存住会让"我刚同步完怎么不出现"变成需要重启才能解释的谜。
        //
        // ★ 两层合并（D52）：同步来的（`<dataDir>/catalog-skills`，工具独占）与
        //   手动装的（`<dataDir>/catalog-skills-local`）。**同名时同步来的优先**
        //   ——那是维护者在清单里核过的；本地那条不列出并记一条 warning（"被顶掉了"
        //   要说出来，不能让它在目录里变成看不见的条目）。
        const loadedSkills = await loadCatalogSkills(this.#skillsDir)
        for (const item of loadedSkills.skipped) {
          console.warn(`[warn] 目录里的技能没有列出去：${item.path} —— ${item.reason}`)
        }
        const loadedLocal = await loadCatalogSkills(this.#localSkillsDir)
        for (const item of loadedLocal.skipped) {
          console.warn(`[warn] 本地装的技能没有列出去：${item.path} —— ${item.reason}`)
        }
        const syncedSlugs = new Set(loadedSkills.skills.map((s) => s.slug))
        const localSkills: CatalogSkillEntry[] = []
        for (const entry of loadedLocal.skills) {
          if (syncedSlugs.has(entry.slug)) {
            console.warn(
              `[warn] 本地装的技能「${entry.slug}」没有列出去：推荐清单里已经有同名的（同步来的优先）`,
            )
            continue
          }
          localSkills.push(entry)
        }
        send(200, {
          ...this.catalog,
          tools: loaded.tools,
          skills: [
            ...loadedSkills.skills.map((e) => ({ ...e, source: 'synced' as const })),
            ...localSkills.map((e) => ({ ...e, source: 'local' as const })),
          ],
          // ★ 清单摘要（D54）：页面要说清"按哪一份清单、几条、核对于哪天"。
          //   服务**只读**它（转存发生在工具里），读不到就如实说 —— 见 `summarizeManifest`。
          manifest:
            this.#manifestPath === null
              ? null
              : await summarizeManifest(this.#manifestPath),
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

      // ── 管理页：技能 / 工具的公共目录（只读，2026-10）──
      if (path === '/api/catalog/skills/sync') {
        if (req.method === 'GET') {
          send(200, await this.syncStatus())
          return
        }
        if (req.method === 'POST') {
          // ★ 跨源页面不许触发同步：浏览器对 `text/plain` 那种"简单请求"不做预检，
          //   所以光靠 CORS 拦不住"恶意页面的 POST"。这里显式要求**来源是回环**
          //   （本机自己的脚本没有 Origin，照常放行）。
          if (origin !== undefined && !allowed) {
            send(403, { error: '只允许回环来源触发同步', code: 'forbidden_origin' })
            return
          }
          const result = await this.syncCatalogSkills()
          send(result.status, result.body)
          return
        }
      }

      // ── 手动安装 / 卸载一条技能（D52）──
      //
      // ★ 为什么这两条**不属于**"目录归同步工具独占"的例外：它们写的是**另一个目录**
      //   （`<dataDir>/catalog-skills-local`），同步工具永远不碰它。
      // ★ 与同步触发同一条来源规矩：非回环 Origin 一律 403（浏览器对简单请求
      //   不做预检，光靠 CORS 拦不住）。
      if (path.startsWith('/api/catalog/skills/local')) {
        if (origin !== undefined && !allowed) {
          send(403, { error: '只允许回环来源改动远端目录', code: 'forbidden_origin' })
          return
        }

        if (req.method === 'POST' && path === '/api/catalog/skills/local') {
          const body = (await this.#readJson(req)) as {
            url?: unknown
            name?: unknown
            summary?: unknown
            needs?: unknown
            category?: unknown
          }
          const url = typeof body.url === 'string' ? body.url.trim() : ''
          if (url === '') {
            send(400, { error: '需要一个 GitHub 链接（url）', code: 'bad_request' })
            return
          }
          // 撞名判定要**两层都看**：同步目录里已经有同名的也算撞（否则本地那条
          // 永远列不出来，等于装了个隐形条目）
          const synced = await loadCatalogSkills(this.#skillsDir)
          const local = await listLocalSkills(this.#localSkillsDir)
          const taken = new Set([...synced.skills.map((s) => s.slug), ...local.map((s) => s.slug)])
          try {
            const item = await installLocalSkill(this.#localSkillsDir, {
              url,
              takenSlugs: taken,
              ...(this.#fetchImpl ? { fetchImpl: this.#fetchImpl } : {}),
              ...(typeof body.name === 'string' ? { name: body.name } : {}),
              ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
              ...(typeof body.category === 'string' ? { category: body.category } : {}),
              ...(typeof body.needs === 'string' || body.needs === null
                ? { needs: body.needs as string | null }
                : {}),
            })
            send(201, { installed: { slug: item.slug, sourceRef: item.sourceRef, files: item.files } })
          } catch (err) {
            if (err instanceof LocalSkillConflict) {
              send(409, {
                error:
                  `已经有一个叫「${err.slug}」的技能了（推荐清单里或本地装的）。` +
                  '要换内容请先卸掉那一条，或者改用别的来源目录。',
                code: 'conflict',
              })
              return
            }
            // 取包失败的原话照给（含 detail）——"为什么装不上"是使用者唯一能行动的信息
            send(400, { error: describeInstallError(err), code: 'install_failed' })
          }
          return
        }

        if (req.method === 'DELETE' && path.startsWith('/api/catalog/skills/local/')) {
          const slug = decodeURIComponent(path.slice('/api/catalog/skills/local/'.length))
          // ⚠️ 同步来的**不在这一层**，删不到——要说清"该怎么删"，而不是回一个 404
          const synced = await loadCatalogSkills(this.#skillsDir)
          if (synced.skills.some((s) => s.slug === slug)) {
            send(409, {
              error:
                `「${slug}」是推荐清单同步下来的，不能在页面上删：` +
                '把它从清单里去掉、再跑一次同步即可（页面上那个「重新同步」按钮）。',
              code: 'synced_entry',
            })
            return
          }
          const removed = await uninstallLocalSkill(this.#localSkillsDir, slug)
          if (!removed) {
            send(404, { error: `本地装的技能里没有「${slug}」`, code: 'not_found' })
            return
          }
          send(200, { removed: slug })
          return
        }

        send(405, { error: '只支持 POST（装一条）与 DELETE（卸一条）', code: 'method_not_allowed' })
        return
      }

      // ── 不是 /api/ ⇒ 当作静态资源（管理页）──
      if (!path.startsWith('/api/')) {
        await this.#serveStatic(path, res)
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

  /**
   * 发一个静态文件（管理页）。
   *
   * 三条要守住的：
   *   1. **不许穿出去**：解析后必须仍在 web 目录之内（`..` 与编码过的 `%2e%2e`
   *      都走同一条判据）。裸拼路径是这个仓库最不愿意见到的那种洞。
   *   2. **未知路径回 index.html**（hash 路由的兜底）；`/api/` 不走这里（那是接口）。
   *   3. **产物不存在时说清怎么办**：`pnpm run build:remote-web`。一句"404"会让
   *      维护者以为是路由写错了。
   */
  async #serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const webDir = this.#webDir
    if (webDir === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('这个远端服务没有托管管理页（启动时未指定 web 目录）。')
      return
    }

    let decoded = pathname
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      // 编码坏了就按原样试；反正下面还有"必须在目录内"那道闸
    }
    const root = resolve(webDir)
    const wanted = normalize(decoded).replace(/^\/+/, '')
    const target = resolve(root, wanted)
    // ★ 判据只有一条：**解析之后**必须仍在 root 里。前缀比较用 sep 收尾，
    //   否则 `/a/bc` 会被误判成在 `/a/b` 之内。
    const inside = target === root || target.startsWith(root + sep)

    const file = inside && wanted !== '' ? await this.#readIfFile(target) : null
    if (file !== null) {
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(file.length),
        // 带内容哈希的静态资源可以长缓存；入口文件不缓存（否则刷新看不到新版）
        'cache-control': /\.(js|css|woff2|svg|png|webp)$/.test(target)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      })
      res.end(file)
      return
    }

    const index = await this.#readIfFile(join(root, 'index.html'))
    if (index === null) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(
        `管理页还没构建：${root} 里没有 index.html。\n` +
          '先跑 `pnpm run build:remote-web`（或直接用接口：GET /api/catalog）。',
      )
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
    res.end(index)
  }

  /** 读一个普通文件；不存在/不是普通文件/读不了 ⇒ `null`（调用方决定怎么答）。 */
  async #readIfFile(path: string): Promise<Buffer | null> {
    try {
      const info = await stat(path)
      if (!info.isFile()) return null
      return await readFile(path)
    } catch {
      return null
    }
  }

  /** 同步状态（管理页轮询它）。工具不在 ⇒ `unavailable`（按钮据此置灰并说明原因）。 */
  async syncStatus(): Promise<SyncStatus> {
    if (this.#syncTool === null || (await this.#readIfFile(this.#syncTool)) === null) {
      return { ...this.#sync, state: 'unavailable', tail: this.#sync.tail }
    }
    return { ...this.#sync, tail: this.#sync.tail }
  }

  /**
   * 触发一次同步：把**独立工具**当子进程跑（服务不 import 抓取代码，见
   * `DEFAULT_SYNC_TOOL` 的说明）。
   *
   * ★ 三条行为：
   *   · **单飞**：已经有一次在跑时返回 409（并带上当下状态），不排队、不重复跑；
   *   · **输出留着**：子进程 stdout/stderr 的末尾若干行进 `tail`，失败时界面直接
   *     显示"为什么失败"，而不是一句"同步失败"；
   *   · **失败不静默**：非零退出记 `failed` + 退出码；"失败就一个字都不写"那条
   *     规矩在工具里（P7），服务只负责如实转述。
   */
  async syncCatalogSkills(): Promise<{ status: number; body: SyncStatus }> {
    const status = await this.syncStatus()
    if (status.state === 'unavailable') return { status: 409, body: status }
    if (this.#sync.state === 'running') return { status: 409, body: status }

    const tool = this.#syncTool
    if (tool === null) return { status: 409, body: status }

    const startedAt = this.#now().toISOString()
    this.#sync = { state: 'running', startedAt, finishedAt: null, exitCode: null, tail: [] }

    // ★ 显式把清单路径交给工具：这样"页面上说的那份清单"与"真正被抓的那份"是同一个文件
    //   （工具自己也会按同一套规则找，但显式传过去就不存在两边各自解析出不同结果的可能）。
    const args = [
      tool,
      '--out',
      this.#skillsDir,
      ...(this.#manifestPath === null ? [] : ['--manifest', this.#manifestPath]),
    ]
    const proxy = process.env['AGENTDECK_GITHUB_PROXY']
    if (proxy !== undefined && proxy.trim() !== '') args.push('--github-proxy', proxy.trim())

    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.#syncChild = child
    const push = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() === '') continue
        this.#sync.tail = [...this.#sync.tail, line].slice(-SYNC_TAIL_LINES)
      }
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)
    child.on('error', (err) => {
      push(Buffer.from(`启动同步工具失败：${err.message}`))
      this.#sync = {
        ...this.#sync,
        state: 'failed',
        exitCode: null,
        finishedAt: this.#now().toISOString(),
      }
      this.#syncChild = null
    })
    child.on('close', (code) => {
      this.#sync = {
        ...this.#sync,
        state: code === 0 ? 'ok' : 'failed',
        exitCode: code,
        finishedAt: this.#now().toISOString(),
      }
      this.#syncChild = null
    })

    return { status: 202, body: await this.syncStatus() }
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
