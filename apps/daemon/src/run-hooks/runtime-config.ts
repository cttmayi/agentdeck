/**
 * ★ 分批第 64 批：**两个 runtime 的「配置隔离」走同一条逻辑**（使用者要求：代码尽量复用）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有这一层
 * ══════════════════════════════════════════════════════════════════
 *
 * claude 与 codex 的隔离原来是 executor 里**两段并列的 if**，各自拼 note、各自注入 env、
 * 各自处理失败。行为确实一样（"把配置搬到受管目录，再把 CLI 指过去"），但代码是两份：
 * 加一条新规则（比如"关掉自带的技能"）就得在两处各写一遍，而**两处不同步**的表现是
 * "claude 关了、codex 没关"——这个仓库已经踩过好几次同款（起草者/审核者各一份、
 * `resolveSpawnTarget` 的选项两份）。
 *
 * 这一层把**流程**收成一条：`resolveManagedHome` → `sync` → 「notes + env」。
 * 两个 runtime 的差异退化成**策略表里的数据**（`POLICY`），而不是两段实现。
 *
 * ══════════════════════════════════════════════════════════════════
 * 唯一一处**故意不同**：受管目录按不按工作目录分
 * ══════════════════════════════════════════════════════════════════
 *
 * | runtime | 受管目录 | 为什么 |
 * | --- | --- | --- |
 * | codex | **按工作目录分**（`<root>/<workDir 的哈希>`） | 每轮要写 `[projects."<本次工作目录>"] trust` ⇒ 内容每轮不同；全局一份时两条不同目录的 run 并行会互相覆盖（分批第 60 批量到过） |
 * | claude | **按工作目录分**（分批第 77 批；原来是全局一份） | 技能与任务隔离 hook 都写在这份 home 里，而技能集按 agent 变 ⇒ 全局一份时并发会互相顶掉。会话状态按 cwd 索引（实测 2.1.302），per-workdir 下 `--resume` 照样成立 |
 *
 * 所以"不按工作目录分"不是漏了，而是策略表里明写的一条（`perWorkDir` + `why`）：
 * 想统一成一种形态时，改的是表里那个布尔值，**不是**再写一段代码。
 */

import type { Agent } from '@agentdeck/protocol'
import { profileFor } from './runtime-profile.ts'
import type { HostSkill } from './codex-config.ts'
import { workDirHomeFor } from './managed-home.ts'

/**
 * 支持"配置隔离"的 runtime（其它 runtime 没有这个概念）。
 *
 * ★ 分批第 67 批：差异从"表 + if"换成了 `RuntimeProfile` 的**子类**——
 *   这一层只负责"按 profile 给的 plan 干活"，不再持有策略数据。
 */
export type IsolatedRuntimeKey = 'claude' | 'codex'

/** 这个 runtime 的受管目录（按 profile 决定要不要按工作目录分）。 */
export function managedHomeFor(
  runtimeKey: IsolatedRuntimeKey,
  rootDir: string,
  workDir: string | null,
): string {
  const profile = profileFor(runtimeKey)
  if (profile === null || !profile.isolationPerWorkDir()) return rootDir
  // ★ 分批第 77 批：命名规则只有一份（`managed-home.ts`）——claude 现在也按工作目录分
  return workDirHomeFor(rootDir, workDir ?? rootDir)
}

export interface RuntimeConfigSyncInput {
  runtimeKey: IsolatedRuntimeKey
  /** 受管根（`dataDir/claude-config` 或 `dataDir/codex-config`）。 */
  rootDir: string
  /** 本次 run 的工作目录（claude 不用它，codex 拿它算 trust 段与目录名）。 */
  workDir: string | null
  /** 源：claude 是 `~/.claude/settings.json` 的路径；codex 是 `~/.codex` 目录。 */
  sourcePath: string
  /** codex 用：宿主级技能（`$HOME/.agents/skills` 下扫出来的），claude 没有这个概念。 */
  hostSkills?: readonly HostSkill[]
}

export interface RuntimeConfigSyncResult {
  ok: boolean
  /** ok=false 时的原因（直接进 note）。 */
  reason: string | null
  /** 这次用的受管目录。 */
  home: string
  /** 要注入给 CLI 的环境变量（**平台最后写**，覆盖 agent 自己配的同名项）。 */
  env: Record<string, string>
  /** 写进运行日志的说明（成功、失败都在这里，**不许静默**）。 */
  notes: string[]
}

/**
 * 一条流程覆盖两个 runtime：同步配置 → 产出「日志说明 + 要注入的 env」。
 *
 * ⚠️ `ok=false` 时**仍然返回 env**：与 claude 的老行为一致——隔离失败不失败 run，
 *    CLI 照常起（"隔离是增强不是核心"），但日志必须说清这次没有隔离。
 */
export async function syncRuntimeConfig(
  input: RuntimeConfigSyncInput,
): Promise<RuntimeConfigSyncResult> {
  const profile = profileFor(input.runtimeKey)
  if (profile === null) {
    return {
      ok: false,
      reason: `runtime ${input.runtimeKey} 没有配置档（不做隔离）`,
      home: input.rootDir,
      env: {},
      notes: [],
    }
  }
  const home = managedHomeFor(input.runtimeKey, input.rootDir, input.workDir)
  const outcome = await profile.syncIsolation({
    home,
    sourcePath: input.sourcePath,
    workDir: input.workDir,
    hostSkills: input.hostSkills ?? [],
  })
  return {
    ok: outcome.ok,
    reason: outcome.reason,
    home: outcome.home,
    env: outcome.env,
    notes: outcome.notes,
  }
}

/**
 * 实体被删时，清掉对应的工作目录状态（分批第 61 批）。
 *
 * · codex：那份 `CODEX_HOME` 里有 `auth.json` 的真实 key 副本 ⇒ 必须删；
 * · claude：分批第 77 批起**也按工作目录分**（那份 home 里有 `settings.json` 的
 *   `ANTHROPIC_*` 副本）⇒ 删实体同样要清；这一点靠 profile 的 `perWorkDir` 自动跟上
 *   （"按策略"而不是"按 runtime 名写 if"）。
 */
export async function forgetRuntimeConfigHome(
  runtimeKey: IsolatedRuntimeKey,
  rootDir: string,
  workDir: string | null,
): Promise<boolean> {
  const profile = profileFor(runtimeKey)
  if (profile === null) return false
  return await profile.forgetHome(rootDir, workDir)
}

/** 顺手清理太旧的受管目录（只有 perWorkDir 的策略才有意义）。 */
export async function pruneRuntimeConfigHomes(
  runtimeKey: IsolatedRuntimeKey,
  rootDir: string,
  keepHome: string,
  keep = 8,
): Promise<string[]> {
  const profile = profileFor(runtimeKey)
  if (profile === null) return []
  return await profile.pruneHomes(rootDir, keepHome, keep)
}

/**
 * 扫宿主级技能（要不要扫**由 profile 决定**：codex 扫、claude 实测不读）。
 *
 * ★ 分批第 67 批：这里原来是 `if (runtimeKey !== 'codex') return []`——一条按名字写死的分支。
 *   现在问 profile：`scanHostSkills` 是 `CodexProfile` 自己的声明。
 */
export async function hostSkillsFor(
  runtimeKey: IsolatedRuntimeKey,
  roots: readonly string[],
): Promise<HostSkill[]> {
  const profile = profileFor(runtimeKey)
  if (profile === null) return []
  return await profile.hostSkills(roots)
}


/**
 * 供 executor 判断"这个 runtime 有没有配置隔离这回事"。
 *
 * ★ 分批第 67 批：判据从"写死两个名字"改成"问 profile 的 `isolated`"。
 */
export function isIsolatedRuntime(key: string): key is IsolatedRuntimeKey {
  return profileFor(key)?.isolated === true
}

/** 未使用的类型导出（保持与 Agent 的关联，便于将来按 agent 定制策略）。 */
export type _AgentRef = Agent
