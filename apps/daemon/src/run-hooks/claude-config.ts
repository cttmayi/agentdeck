/**
 * claude 个人配置目录的隔离（2026-10，D78）。
 *
 * 背景：claude 的**用户级**配置是全局总是加载的——`~/.claude/skills/` 下
 * 的个人 skill 和 `~/.claude.json` 里的 `mcpServers`（本机是 `rea`）在每次
 * 会话里都可见、可用。这在 AgentDeck 的任务里是越界的：rea 会拉起 npx、
 * browser-use 会开浏览器，而任务隔离 hook（D76）只拦 Bash/Read 等路径工具，
 * 管不到这些 skill/MCP 工具——它们天然在任务边界之外。
 *
 * 为什么用 `CLAUDE_CONFIG_DIR` 而不是 settings 字段：2026-10-18 全网排查 +
 * 实测（2.1.143、2.1.302 两个版本都验过），claude 对"禁用用户级 skill/MCP"
 * 没有任何在发布版生效的 settings 字段——官方文档里的 `deniedMcpServers` /
 * `skillOverrides`（标 "Any file"）在 user/project 两个层级写都无效（文档
 * 超前于发布版），系统级 managed-settings.json 又需要 root（个人不可行）。
 * `CLAUDE_CONFIG_DIR` 指到一个平台受管的干净目录，是**唯一实测有效**的机制：
 *
 *   - 用户级 skill / MCP **不加载**（`mcp_servers: []`、只剩 claude 内置 skill）；
 *   - 项目级 skill（任务目录 `.claude/skills/`，含平台注入的）照常加载——
 *     它跟 cwd 走，不跟 config dir 走；
 *   - 认证不丢：用户的 `ANTHROPIC_*` 等 key 住在 `~/.claude/settings.json` 的
 *     `env` 里，本模块每次 run 把它 copy 进受管目录的 `settings.json`。
 *
 * 目录与生命周期（两个硬约束）：
 *
 *   1. 受管目录**绝不放任务工作目录**——agent 能读自己的工作目录，放那里
 *      等于把 key 递给 agent 自己。它落在 daemon 数据目录下（server.ts 装配
 *      时传 `join(dataDir, 'claude-config')`），工作区外、agent 不可见。
 *   2. 受管目录**全局复用一个、跨 run 稳定**（不是每 run 新建+删除）——claude
 *      的会话状态（`--resume` 依赖的 `projects/` 记录）存在 config dir 下，
 *      每 run 新建目录会让恢复会话找不到、重试退化成新会话。claude 按项目
 *      路径（cwd）分目录存会话，不同任务 cwd 不同，天然隔离不冲突。
 *
 * 已知边界（2026-10-18 记录）：官方 issue #79233/#80580 说 CLAUDE_CONFIG_DIR
 * 不隔离 `~/.claude/rules/*.md` 与 `$HOME/.claude/CLAUDE.md`——本机这两条
 * 路径都不存在，实际泄漏面为零；文档记录在案，将来出现再补对策。
 *
 * 失败语义与 D76 hook 同原则：同步失败**不**让 run 失败（隔离是增强不是
 * 核心），但调用方要记一条 note 让使用者知道这次没有隔离。
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 受管配置目录里的 claude settings 落点（claude 读它）。 */
export const MANAGED_SETTINGS_REL = 'settings.json'

export interface ClaudeConfigSyncResult {
  ok: boolean
  /** ok=false 时的原因（进 note，让人知道为什么这次没有隔离）。 */
  reason?: string
  /** ok=true 时同步的 env 键数。 */
  envCount?: number
  /** 受管目录（进 note，使用者可自查）。 */
  configDir: string
}

/**
 * 把 `~/.claude/settings.json` 的 `env` 同步进受管配置目录的 `settings.json`。
 *
 * 幂等（每次 run 覆盖重写——使用者改 key/base url 即时生效，不用重启 daemon）。
 * 只 copy `env` 一个对象：认证、端点、行为开关全在里头；`enabledPlugins` /
 * marketplaces / thinking 开关等其余键是用户级行为配置，本来就要隔离掉。
 *
 * 源文件缺失 / JSON 损坏时返回 `ok: false`（带原因），不抛异常——
 * 调用方 catch 的是"写不进受管目录"这一类，源文件坏是另一回事，分开说。
 */
export async function syncClaudeConfigDir(
  configDir: string,
  sourceSettingsPath: string,
): Promise<ClaudeConfigSyncResult> {
  let source: string
  try {
    source = await readFile(sourceSettingsPath, 'utf8')
  } catch {
    return {
      ok: false,
      reason: `读不到源配置 ${sourceSettingsPath}`,
      configDir,
    }
  }
  let parsed: { env?: Record<string, string> }
  try {
    parsed = JSON.parse(source) as { env?: Record<string, string> }
  } catch {
    return {
      ok: false,
      reason: `源配置 ${sourceSettingsPath} 不是合法 JSON`,
      configDir,
    }
  }
  const env = parsed.env
  if (env === undefined || typeof env !== 'object' || Array.isArray(env)) {
    return {
      ok: false,
      reason: `源配置 ${sourceSettingsPath} 没有 env 对象`,
      configDir,
    }
  }
  // 只挑字符串值：settings.json 的 env 语义是字符串键值对，混进别的类型
  // 会让 claude 读配置时行为不可预期。
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') clean[k] = v
  }
  const settingsPath = join(configDir, MANAGED_SETTINGS_REL)
  await mkdir(configDir, { recursive: true })
  /**
   * ★ 分批第 63 批：受管 settings 里**多写一项** `enabledPlugins`，把 claude 自带的
   * 那一个插件技能也关掉。
   *
   * 实测（假 Anthropic 端点抓请求体，不花 token；claude 2.1.302）：
   *   · 只有 `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` 时，技能清单里还留着 `plugin-authoring`
   *     （它是 claude **内置插件**贡献的技能，不是 bundled skill）；
   *   · 在受管 settings.json 里加 `{"enabledPlugins":{"plugin-authoring@builtin":false}}`
   *     ⇒ 清单里只剩**平台注入的那些**（实测 1 条 = 我们注入的那条）；
   *   · ⚠️ 键必须带 `@builtin`——只写 `"plugin-authoring": false` **不生效**（实测过）。
   *
   * ⚠️ 为什么不把使用者自己的 `enabledPlugins` 抄过来：D78 的边界——用户级行为配置
   *    （plugins / marketplaces）不复制进任务，任务里只看项目级与平台注入。
   */
  await writeFile(
    settingsPath,
    JSON.stringify({ env: clean, enabledPlugins: { 'plugin-authoring@builtin': false } }, null, 2) +
      '\n',
    'utf8',
  )
  // ★ settings.json 里有真实 key（ANTHROPIC_AUTH_TOKEN 等），只给属主读。
  await chmod(settingsPath, 0o600)
  return { ok: true, envCount: Object.keys(clean).length, configDir }
}
