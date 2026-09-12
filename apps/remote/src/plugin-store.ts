import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 插件状态与插件密钥（FR-PLUGIN-09 / FR-PLUGIN-11）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么密钥要**单独一个文件**
 * ══════════════════════════════════════════════════════════════════
 *
 * 最省事的做法是把插件的 `apiKey` 和普通设定一起塞进 `remote.json`。
 * 那样做的问题不在"能不能加密"，而在**它会跟着普通设定到处跑**：
 *
 *   - 有人备份一份设定，顺手就把密钥带走了；
 *   - 排查问题时把设定贴进 issue，密钥一起公开；
 *   - 将来做个"导出我的设定"功能，密钥默认就在里面。
 *
 * 所以 FR-PLUGIN-11 要的是**分开存放 + 权限更严**。分成两个文件之后，
 * "普通设定"这个对象里在结构上就不可能含有密钥——这比"记得脱敏"可靠。
 *
 * ⚠️ 如实说明这里的边界：文件权限（0600）挡的是**同机其他用户**，
 *    挡不住同一个用户下的其他进程，也挡不住 root。它是纵深防御的一层，
 *    不是保管库。真需要更强保护请用系统钥匙串——那不在本项目范围内。
 */

/** 普通插件状态：启用/停用、非敏感配置。 */
interface PluginStateFile {
  /** 插件名 → 是否启用。缺省视为启用（加载器已判过可用性）。 */
  enabled: Record<string, boolean>
  /** 插件名 → 非敏感配置。**这里不放密钥**。 */
  config: Record<string, Record<string, unknown>>
}

interface PluginSecretsFile {
  /** 插件名 → 密钥键 → 值。 */
  secrets: Record<string, Record<string, string>>
}

const STATE_FILE = 'plugins.state.json'
const SECRETS_FILE = 'plugins.secrets.json'

/**
 * 密钥文件权限。
 *
 * `0o600` = 只有属主可读写。之所以显式设而不是依赖 umask：
 * umask 是使用者环境的一部分，可能是 0022（同组可读）甚至更松。
 * 一个装着 API key 的文件不该由使用者的 shell 配置来间接决定谁能读。
 */
const SECRETS_MODE = 0o600

export class PluginStore {
  readonly #dir: string | null
  #state: PluginStateFile = { enabled: {}, config: {} }
  #secrets: PluginSecretsFile = { secrets: {} }
  #loaded = false

  constructor(dataDir: string | null) {
    this.#dir = dataDir
  }

  async load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    if (this.#dir === null) return
    await mkdir(this.#dir, { recursive: true })

    const state = await this.#read<PluginStateFile>(STATE_FILE)
    if (state) {
      this.#state = {
        enabled: state.enabled ?? {},
        config: state.config ?? {},
      }
    }
    const secrets = await this.#read<PluginSecretsFile>(SECRETS_FILE)
    if (secrets) this.#secrets = { secrets: secrets.secrets ?? {} }
  }

  async #read<T>(file: string): Promise<T | null> {
    if (this.#dir === null) return null
    try {
      return JSON.parse(await readFile(join(this.#dir, file), 'utf8')) as T
    } catch {
      // 首次启动没有文件——正常路径，不是错误
      return null
    }
  }

  async #persistState(): Promise<void> {
    if (this.#dir === null) return
    await writeFile(
      join(this.#dir, STATE_FILE),
      JSON.stringify(this.#state, null, 2),
      'utf8',
    )
  }

  async #persistSecrets(): Promise<void> {
    if (this.#dir === null) return
    const path = join(this.#dir, SECRETS_FILE)
    await writeFile(path, JSON.stringify(this.#secrets, null, 2), {
      encoding: 'utf8',
      // 创建时就带上权限，避免出现"先 644 再改 600"那一小段窗口
      mode: SECRETS_MODE,
    })
    // 文件已存在时 `mode` 不生效——所以还要显式 chmod 一次。
    // 少这一句，第二次写入之后权限就回到默认值了。
    await chmod(path, SECRETS_MODE)
  }

  // ── FR-PLUGIN-09：独立启用 / 停用 ──────────────────────────────

  /**
   * 插件是否被使用者启用。缺省 = 启用。
   *
   * 缺省启用的理由：装进来就是"想用它"。要求逐个点开会让"装了没反应"
   * 变成一个常见困惑，而停用是一个**刻意的动作**，值得显式记下来。
   */
  isEnabled(name: string): boolean {
    return this.#state.enabled[name] !== false
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.load()
    this.#state.enabled[name] = enabled
    await this.#persistState()
  }

  async configOf(name: string): Promise<Record<string, unknown>> {
    await this.load()
    return this.#state.config[name] ?? {}
  }

  async setConfig(name: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.load()
    const next = { ...(this.#state.config[name] ?? {}), ...patch }
    this.#state.config[name] = next
    await this.#persistState()
    return next
  }

  // ── FR-PLUGIN-11：密钥 ────────────────────────────────────────

  /**
   * ★ **只回"设没设"，不回值**。
   *
   * 密钥一旦进了 API 响应，就会出现在浏览器内存、日志、截图、以及任何
   * 往里加 `console.log` 的调试里。而调用方真正需要的通常只是
   * "这个插件配好了没有"——那就只给这个。
   *
   * 需要真值的只有插件自己的代码，它在宿主进程内直接走 `secretOf()`。
   */
  secretKeysOf(name: string): string[] {
    return Object.keys(this.#secrets.secrets[name] ?? {})
  }

  hasSecret(name: string, key: string): boolean {
    const value = this.#secrets.secrets[name]?.[key]
    return typeof value === 'string' && value !== ''
  }

  /** 供**插件实现体**在进程内取用。绝不经过 API。 */
  secretOf(name: string, key: string): string | null {
    return this.#secrets.secrets[name]?.[key] ?? null
  }

  async setSecret(name: string, key: string, value: string): Promise<void> {
    await this.load()
    const forPlugin = this.#secrets.secrets[name] ?? {}
    forPlugin[key] = value
    this.#secrets.secrets[name] = forPlugin
    await this.#persistSecrets()
  }

  async clearSecret(name: string, key: string): Promise<boolean> {
    await this.load()
    const forPlugin = this.#secrets.secrets[name]
    if (!forPlugin || !(key in forPlugin)) return false
    delete forPlugin[key]
    await this.#persistSecrets()
    return true
  }

  /** 插件被移除时清掉它的状态与密钥——留着只会变成将来的困惑。 */
  async forget(name: string): Promise<void> {
    await this.load()
    delete this.#state.enabled[name]
    delete this.#state.config[name]
    delete this.#secrets.secrets[name]
    await this.#persistState()
    await this.#persistSecrets()
  }

  /** 密钥文件的绝对路径，供启动日志提示使用者它在哪里。 */
  secretsPath(): string | null {
    return this.#dir === null ? null : join(this.#dir, SECRETS_FILE)
  }
}
