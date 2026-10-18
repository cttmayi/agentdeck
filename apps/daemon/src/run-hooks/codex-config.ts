/**
 * codex 个人配置目录的隔离（2026-10，D78 的 codex 版）。
 *
 * 背景：与 claude 同理（见 claude-config.ts）——codex 的**用户级**配置是全局
 * 总是加载的：`~/.codex/skills/` 下的个人 skill（本机是 `browser-use`）在每次
 * 会话里都可见、可用，`~/.codex/config.toml` 里还挂着用户的 model_providers
 * （端点和 key）。这在 AgentDeck 的任务里是越界的：个人 skill 会在任务里
 * 拉起浏览器等动作，而任务隔离（D76）只拦路径工具，管不到 skill 工具。
 *
 * 机制：codex 支持 `CODEX_HOME` 环境变量重定向整个配置目录（~/.codex →
 * $CODEX_HOME）。把它指到一个平台受管的干净目录，用户级 skill 自然不加载；
 * 项目级 skill（任务目录 `.codex/skills/`，含平台注入的）照常加载——它跟
 * thread 的 cwd 走，不跟 CODEX_HOME 走。
 *
 * 受管目录需要两个文件（**只 copy 认证与端点，不 copy 用户级行为**）：
 *
 *   - `auth.json`：认证（OPENAI_API_KEY）。codex 没它起不来。
 *   - `config.toml`：端点和模型配置。**必须整份 copy**——`model_providers.*`
 *     的 base_url / api_key 混在同一份 toml 里（本仓库没有 toml 解析器，按
 *     字段拆的风险大于收益）；`projects.*` 信任列表与 `sandbox_mode` 一并带
 *     进去无害（trust 是"允许在哪些目录干活"，不 copy 反而会让 codex 对
 *     工作目录不信任；sandbox 由 thread/start.sandbox 与 turn/start 覆盖）。
 *
 *   用户级 skill（`~/.codex/skills/`）与运行时状态（app-server-control 等）
 *   **不 copy**——前者正是要隔离的，后者让 codex 在新目录重建。
 *
 * 目录与生命周期（与 claude D78 相同的两个硬约束）：
 *
 *   1. 受管目录**绝不放任务工作目录**——agent 能读自己的工作目录，放那里
 *      等于把 key 递给 agent 自己。它落在 daemon 数据目录下（server.ts 装配
 *      时传 `join(dataDir, 'codex-config')`），工作区外、agent 不可见。
 *   2. 受管目录**全局复用一个、跨 run 稳定**——codex 的线程 rollout / 会话
 *      状态存在 CODEX_HOME 下，每 run 新建目录会让 `thread/resume` 找不到
 *      线程、重试退化成新线程。不同任务 thread 的 cwd 不同，天然隔离。
 *
 * 失败语义与 D78 同原则：同步失败**不**让 run 失败（隔离是增强不是核心），
 * 但调用方要记一条 note 让使用者知道这次没有隔离。
 */

import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 受管配置目录里 codex 读的文件（相对 configDir）。 */
export const CODEX_CONFIG_FILES = ['auth.json', 'config.toml'] as const

export interface CodexConfigSyncResult {
  ok: boolean
  /** ok=false 时的原因（进 note，让人知道为什么这次没有隔离）。 */
  reason?: string
  /** ok=true 时 copy 进受管目录的文件名。 */
  copied: string[]
  /** 受管目录（进 note，使用者可自查）。 */
  configDir: string
}

/**
 * 把 `~/.codex/` 的认证与端点配置同步进受管配置目录。
 *
 * 幂等（每次 run 覆盖重写——使用者改 key/端点即时生效，不用重启 daemon）。
 * `auth.json` 与 `config.toml` 都必需：auth.json 是 codex 的认证入口，
 * config.toml 里的 model_providers 定义端点和 key——少任何一个，codex 在
 * 受管目录下都起不到"和平时一样"的状态，宁可明说没隔离、不悄悄跑偏。
 *
 * 源文件缺失时返回 `ok: false`（带原因），不抛异常。
 */
export async function syncCodexConfigDir(
  configDir: string,
  sourceHomeDir: string,
): Promise<CodexConfigSyncResult> {
  await mkdir(configDir, { recursive: true })
  const copied: string[] = []
  const missing: string[] = []
  for (const name of CODEX_CONFIG_FILES) {
    const source = join(sourceHomeDir, name)
    const target = join(configDir, name)
    try {
      await copyFile(source, target)
      // ★ 两个文件里都有真实 key（auth.json 的 OPENAI_API_KEY、config.toml
      //   的 model_providers api_key），只给属主读。
      await chmod(target, 0o600)
      copied.push(name)
    } catch {
      missing.push(name)
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `源配置缺 ${missing.join('、')}（在 ${sourceHomeDir}）`,
      copied,
      configDir,
    }
  }
  return { ok: true, copied, configDir }
}
