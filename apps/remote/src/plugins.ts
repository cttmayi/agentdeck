import type { PluginCapability } from '@alpha-helper/protocol'

export type { PluginCapability }

/**
 * 插件系统（FR-PLUGIN、D25/D26）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么用插件取代专用扩展位
 * ══════════════════════════════════════════════════════════════════
 *
 * 登录方式与第三方接入**形状相似**——都是"接入一种外部能力"。给每类各写
 * 一套扩展位，加第三类时又要写一套。统一成插件后：
 * **新增一类能力 = 新增一类 capability + 写一个插件**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条硬规则
 * ══════════════════════════════════════════════════════════════════
 *
 * **① 未声明即拒绝**：宿主不认识的能力或 scope 一律拒绝加载。
 *    白名单和黑名单不是风格问题——黑名单要求你预见别人会做什么，
 *    白名单只要求你知道自己支持什么。
 *
 * **② 主版本门禁**：不认识的主 `apiVersion` 拒绝加载。
 *
 * **③ 失败隔离**：一个插件坏了**不影响**其他插件与宿主功能。
 *    某个 login 插件挂掉，邮箱登录仍须可用。
 *
 * ⚠️ 边界：**不要做成"什么都要插件化"**。CLI 适配层是编译进 daemon 的
 *    内部表（FR-CLI-47），改成插件会引入版本兼容与加载时序问题。
 *    **只有当"外部第三方要自己写"时才值得做成插件。**
 */

export const PLUGIN_API_VERSION = 1

export interface PluginManifest {
  apiVersion: number
  name: string
  capability: PluginCapability
  version: string
  /** 代码入口（可执行代码；纯声明式插件可省略）。 */
  entry?: string
  /** 所需权限，闭合白名单。 */
  scopes: string[]
  /** 配置项声明（宿主据此渲染设置表单）。 */
  config?: Record<string, unknown>
}

export interface LoadedPlugin {
  manifest: PluginManifest
  enabled: boolean
  /** 加载失败的原因（成功时为 null）。 */
  error: string | null
  /** 实现体——由具体的 capability 决定形状。 */
  impl: unknown
}

/** 宿主已知的 capability —— 白名单。 */
export const KNOWN_CAPABILITIES: readonly PluginCapability[] = ['login', 'third-party']

/** 宿主已知的 scope —— 白名单。未在其中一律拒绝。 */
export const KNOWN_SCOPES: readonly string[] = [
  'account:identify',
  'thirdparty:query',
  'settings:read',
]

export class PluginRejected extends Error {
  constructor(name: string, reason: string) {
    super(`插件 ${name} 被拒绝：${reason}`)
    this.name = 'PluginRejected'
  }
}

/**
 * 校验 manifest。
 *
 * 这里刻意**逐条给出拒绝理由**而不是笼统的"manifest 不合法"——
 * 插件作者需要知道自己少声明了什么。
 */
export function validateManifest(input: unknown): PluginManifest {
  if (input === null || typeof input !== 'object') {
    throw new PluginRejected('(未知)', 'manifest 不是对象')
  }
  const m = input as Record<string, unknown>
  const name = typeof m['name'] === 'string' ? m['name'] : '(未命名)'

  if (m['apiVersion'] !== PLUGIN_API_VERSION) {
    throw new PluginRejected(
      name,
      `不支持的 apiVersion ${String(m['apiVersion'])}（本宿主只认识 ${PLUGIN_API_VERSION}）`,
    )
  }

  const capability = m['capability']
  if (typeof capability !== 'string' || !KNOWN_CAPABILITIES.includes(capability as PluginCapability)) {
    throw new PluginRejected(
      name,
      `未知能力 ${String(capability)}（宿主支持：${KNOWN_CAPABILITIES.join(', ')}）`,
    )
  }

  const scopes = m['scopes']
  if (!Array.isArray(scopes)) throw new PluginRejected(name, 'scopes 必须是数组')
  const unknownScope = scopes.find(
    (s) => typeof s !== 'string' || !KNOWN_SCOPES.includes(s),
  )
  if (unknownScope !== undefined) {
    throw new PluginRejected(
      name,
      `未声明的 scope ${String(unknownScope)}（宿主支持：${KNOWN_SCOPES.join(', ')}）`,
    )
  }

  if (typeof m['version'] !== 'string' || m['version'].length === 0) {
    throw new PluginRejected(name, '缺少 version')
  }

  return {
    apiVersion: PLUGIN_API_VERSION,
    name,
    capability: capability as PluginCapability,
    version: m['version'],
    ...(typeof m['entry'] === 'string' ? { entry: m['entry'] } : {}),
    scopes: scopes as string[],
    ...(m['config'] && typeof m['config'] === 'object'
      ? { config: m['config'] as Record<string, unknown> }
      : {}),
  }
}

/**
 * 加载一批插件。
 *
 * **失败隔离**：单个插件出错只记在它自己身上（`error` 非 null，
 * `enabled: false`），不会让整批加载失败。这是"某个 login 插件坏了，
 * 邮箱登录仍须可用"的落地形态。
 */
export function loadPlugins(
  entries: ReadonlyArray<{ manifest: unknown; impl: unknown }>,
): LoadedPlugin[] {
  return entries.map(({ manifest, impl }) => {
    try {
      const validated = validateManifest(manifest)
      return { manifest: validated, enabled: true, error: null, impl }
    } catch (err) {
      const name =
        manifest && typeof manifest === 'object' && typeof (manifest as Record<string, unknown>)['name'] === 'string'
          ? ((manifest as Record<string, unknown>)['name'] as string)
          : '(未命名)'
      return {
        manifest: {
          apiVersion: PLUGIN_API_VERSION,
          name,
          capability: 'login',
          version: '0.0.0',
          scopes: [],
        },
        enabled: false,
        error: err instanceof Error ? err.message : String(err),
        impl: null,
      }
    }
  })
}

/** 按能力筛选**已启用**的插件。 */
export function enabledPluginsFor(
  plugins: readonly LoadedPlugin[],
  capability: PluginCapability,
): LoadedPlugin[] {
  return plugins.filter((p) => p.enabled && p.manifest.capability === capability)
}
