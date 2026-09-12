import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  loadPlugins,
  validateManifest,
  type LoadedPlugin,
  type PluginManifest,
} from './plugins.ts'

/**
 * 插件加载器（P1：`entry` 指向的代码**真的被执行**）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一步为什么值得做
 * ══════════════════════════════════════════════════════════════════
 *
 * 在此之前，插件系统只做了"声明"这一半：manifest 被校验、非法插件被拒绝，
 * 但 `entry: "index.js"` 里的代码**从来没有被求值过**——插件的实现体是
 * 宿主用 `impl` 对象注入进去的。
 *
 * 那样的插件系统只对宿主自己的代码有用。真正的第三方拿到它，写一个
 * `plugin.json` + `index.js` 放进目录里，**什么也不会发生**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条硬规则（都与"这是陌生人写的代码"有关）
 * ══════════════════════════════════════════════════════════════════
 *
 * **① 入口必须留在插件目录内。**
 *    `entry` 是插件自己写的字符串。`"../../../etc/passwd"` 或者一个绝对
 *    路径都能把它指到目录外面去。判据是**解析后的真实路径**仍然位于插件
 *    目录之下——字符串前缀判断挡不住 `..`（`/a/plugins/b/../../../x` 以
 *    `/a/plugins` 开头，但它跑到了 `/x`）。
 *
 * **② 只加载真正的文件，且只认 `.js` / `.mjs`。**
 *    目录、缺失的文件都要**明确报错**，而不是让 `import()` 抛一个难懂的
 *    ERR_UNSUPPORTED_DIR_IMPORT。`.ts` 也刻意不收：宿主自己跑在
 *    Node 的类型剥离下，但第三方的 `.ts` 会因缺少配置而失败——与其让它
 *    以奇怪的方式半死不活，不如在加载时就拒绝。
 *
 * **③ 加载失败必须隔离到单个插件。**
 *    一个插件的语法错误不能让远端服务起不来。它只是自己 `enabled: false`
 *    并带上可读的 `error`，其余插件照常工作。这与 `loadPlugins` 的
 *    失败隔离是同一条原则，只是这里多了一个"代码求值"的失败来源。
 *
 * ⚠️ **不做沙箱**（D26 的倾向）：插件跑在宿主进程里，能力边界靠 manifest
 *    的 `scopes` 白名单**声明式**约束，而不是靠运行时隔离。这一点必须在
 *    文档里如实披露，不能让插件作者以为自己被沙箱保护着。
 */

export interface PluginLoadOptions {
  /** 插件根目录。下级每个子目录是一个插件。 */
  pluginDir: string
  /** 是否允许执行插件代码。`false` 时只校验 manifest（只读模式）。 */
  allowCode?: boolean
  onWarn?: (message: string) => void
}

export interface PluginLoadReport {
  plugins: LoadedPlugin[]
  /** 逐个插件的加载结果，供设置页面展示。 */
  scanned: number
}

/** 从目录里读出所有插件。 */
export async function loadPluginDirectory(
  options: PluginLoadOptions,
): Promise<PluginLoadReport> {
  const warn = options.onWarn ?? ((): void => {})
  const allowCode = options.allowCode ?? true

  const entries = await readdir(options.pluginDir, { withFileTypes: true }).catch(
    () => [] as never[],
  )

  const prepared: { manifest: unknown; impl: unknown; error?: string }[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(options.pluginDir, entry.name)

    let manifestRaw: string
    try {
      manifestRaw = await readFile(join(dir, 'plugin.json'), 'utf8')
    } catch {
      // 没有 manifest 的目录不是插件（可能是 .git、node_modules 之类）
      continue
    }

    let manifestJson: unknown
    try {
      manifestJson = JSON.parse(manifestRaw)
    } catch (err) {
      prepared.push({
        manifest: { name: entry.name },
        impl: null,
        error: `plugin.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }

    // manifest 先校验一次：非法就没必要再去执行它的代码了。
    let manifest: PluginManifest
    try {
      manifest = validateManifest(manifestJson)
    } catch (err) {
      prepared.push({ manifest: manifestJson, impl: null, error: errorText(err) })
      continue
    }

    if (!allowCode || !manifest.entry) {
      // 纯声明式插件（或只读模式）：没有代码可跑，但不是错误。
      prepared.push({ manifest, impl: null })
      continue
    }

    try {
      const impl = await importPluginEntry(dir, manifest.entry)
      prepared.push({ manifest, impl })
    } catch (err) {
      // ★ 隔离：只影响这一个插件。
      prepared.push({ manifest, impl: null, error: errorText(err) })
      warn(`插件 ${manifest.name} 加载失败：${errorText(err)}`)
    }
  }

  const plugins = loadPlugins(prepared.map((p) => ({ manifest: p.manifest, impl: p.impl })))

  // `loadPlugins` 只认识 manifest 层面的失败。这里补上**更具体的那一条**：
  // 比如 plugin.json 根本不是合法 JSON 时，`loadPlugins` 只能报
  // "apiVersion undefined"——那是症状，不是病。给人看的必须是根因。
  //
  // 所以 declared error **优先于** loadPlugins 的错误，而不管后者怎么说。
  const merged = plugins.map((p, i) => {
    const declaredError = prepared[i]?.error
    if (!declaredError) return p
    return { ...p, enabled: false, error: declaredError }
  })

  return { plugins: merged, scanned: entries.length }
}

/**
 * 求值一个插件入口。
 *
 * 导出形态有约定，但**不强制**：插件可以导出 `default`，也可以直接导出
 * 具名函数。取不到可用的实现体时明确报错——"加载成功但什么也不能做"
 * 是最难排查的一种失败。
 */
async function importPluginEntry(dir: string, entry: string): Promise<unknown> {
  const full = resolveInPluginDir(dir, entry)

  const info = await stat(full).catch(() => null)
  if (!info) {
    throw new Error(`entry 指向的文件不存在：${entry}`)
  }
  if (info.isDirectory()) {
    throw new Error(`entry 指向的是一个目录，不是文件：${entry}`)
  }
  if (!/\.(m?js)$/.test(full)) {
    throw new Error(
      `entry 只支持 .js / .mjs（收到 ${entry}）。` +
        `插件不应依赖宿主之外的转译配置——请在发布前自行编译。`,
    )
  }

  const mod = (await import(pathToFileURL(full).href)) as Record<string, unknown>
  const impl = (mod['default'] ?? mod) as unknown

  if (impl === null || impl === undefined) {
    throw new Error(`entry ${entry} 没有导出任何东西`)
  }
  return impl
}

/**
 * 把 `entry` 解析到插件目录**之内**的真实路径。
 *
 * ★ 这条判断是整份加载器里最要紧的一行逻辑。
 *   字符串层面的"以插件目录开头"是**错的**：
 *   `/plugins/evil/../../../etc/x` 确实以 `/plugins` 开头，
 *   但它落在 `/etc/x`。必须解析成绝对路径之后再比。
 */
export function resolveInPluginDir(dir: string, entry: string): string {
  if (isAbsolute(entry)) {
    throw new Error(`entry 不能是绝对路径：${entry}`)
  }
  const base = resolve(dir)
  const full = resolve(base, entry)
  const rel = relative(base, full)
  if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`entry 越出了插件目录：${entry}`)
  }
  return full
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
