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
 * | claude | **全局一份**（`<root>`） | 每轮写出来的内容**完全一样**（env + 固定的 enabledPlugins），没有"这次"的变量；而且 `CLAUDE_CONFIG_DIR/projects/` 是**会话状态**，`--resume` 要靠它全局稳定 |
 *
 * 所以"不按工作目录分"不是漏了，而是策略表里明写的一条（`perWorkDir` + `why`）：
 * 想统一成一种形态时，改的是表里那个布尔值，**不是**再写一段代码。
 */

import type { Agent } from '@agentdeck/protocol'
import { syncClaudeConfigDir } from './claude-config.ts'
import {
  codexHomeFor,
  findSkillFiles,
  pruneCodexHomes,
  removeCodexHomeFor,
  syncCodexConfigDir,
  type HostSkill,
} from './codex-config.ts'

/** 支持"配置隔离"的 runtime（其它 runtime 没有这个概念）。 */
export type IsolatedRuntimeKey = 'claude' | 'codex'

/** 每个 runtime 的策略——**唯一一处差异**，别再散到 executor 里。 */
export const POLICY: Record<
  IsolatedRuntimeKey,
  { perWorkDir: boolean; why: string }
> = {
  claude: {
    perWorkDir: false,
    why:
      '每轮写出来的内容完全一样（env + 固定的 enabledPlugins），没有"这次"的变量；' +
      '而 CLAUDE_CONFIG_DIR/projects/ 是会话状态，--resume 要靠它全局稳定',
  },
  codex: {
    perWorkDir: true,
    why:
      '每轮要写 [projects."<本次工作目录>"] trust ⇒ 内容每轮不同；' +
      '全局一份时两条不同目录的 run 并行会互相覆盖（分批第 60 批）',
  },
}

/** 这个 runtime 的受管目录（按策略决定要不要按工作目录分）。 */
export function managedHomeFor(
  runtimeKey: IsolatedRuntimeKey,
  rootDir: string,
  workDir: string | null,
): string {
  if (!POLICY[runtimeKey].perWorkDir) return rootDir
  // perWorkDir 的策略必须有工作目录可用；拿不到就退回 runId 之类的稳定值（调用方保证传）
  return codexHomeFor(rootDir, workDir ?? rootDir)
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
  const home = managedHomeFor(input.runtimeKey, input.rootDir, input.workDir)
  if (input.runtimeKey === 'claude') {
    const sync = await syncClaudeConfigDir(home, input.sourcePath)
    const env = { CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' }
    return {
      ok: sync.ok,
      reason: sync.reason ?? null,
      home,
      env,
      notes: sync.ok
        ? [
            `claude 个人配置隔离：已启用受管配置目录（${sync.configDir}）——` +
              `用户级 skill/MCP 不可见，env ${String(sync.envCount ?? 0)} 项已同步。`,
            'claude 自带的 skills：已关闭（CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1 + 受管 settings 里的 ' +
              'enabledPlugins.plugin-authoring@builtin=false）——这次的技能清单只剩平台注入的那些。',
          ]
        : [
            `⚠️ claude 个人配置隔离未生效（${sync.reason ?? '未知原因'}）——` +
              '本次 run 会看到用户级 skill/MCP（如 rea、个人 skill）。',
          ],
    }
  }

  const sync = await syncCodexConfigDir(
    home,
    input.sourcePath,
    input.workDir ?? undefined,
    input.hostSkills,
  )
  const env = { CODEX_HOME: home }
  const notes: string[] = []
  if (!sync.ok) {
    notes.push(
      `⚠️ codex 个人配置隔离未生效（${sync.reason ?? '未知原因'}）——` +
        '本次 run 会看到用户级 skill（如 browser-use）。',
    )
    return { ok: false, reason: sync.reason ?? null, home, env, notes }
  }

  notes.push(
    `codex 个人配置隔离：已启用受管配置目录（${sync.configDir}）——` +
      '`CODEX_HOME` 下的用户级 skill 不可见，' +
      `已同步 ${sync.copied.join('、')}；` +
      '⚠️ `$HOME/.agents/skills`（跨 agent 的全局目录）**不在隔离范围内**，那些技能仍然可见。',
  )
  if (sync.hostSkillsDisabled.length > 0) {
    notes.push(
      `宿主级技能：已逐条禁用 ${String(sync.hostSkillsDisabled.length)} 个` +
        '（`$HOME/.agents/skills` 下的 SKILL.md；它们不属于平台，但 codex 会扫到）——' +
        `${sync.hostSkillsDisabled
          .map((p) => p.replace(/^.*\.agents\/skills\//u, ''))
          .join('、')}`,
    )
  }
  if (sync.hostSkillsAlreadyListed.length > 0) {
    notes.push(
      `宿主级技能：${String(sync.hostSkillsAlreadyListed.length)} 个你已经在 config 里写过开关，` +
        '平台**不覆盖**你的取值。',
    )
  }
  notes.push(
    sync.bundledSkills === 'disabled'
      ? 'codex 自带的 system skills：已关闭（受管 config 里写了 [skills.bundled] enabled = false）——' +
          '这次的技能清单只剩平台注入的 + $HOME/.agents/skills。'
      : '⚠️ codex 自带的 system skills：**没有关掉**（你自己的 config.toml 里已经有 ' +
          '[skills.bundled] 段，平台不覆盖你的配置）——它们会出现在这次的技能清单里。',
  )
  if (sync.trustedProject !== null) {
    notes.push(
      `codex 项目级配置：已把工作目录标为 trusted（${sync.trustedProject}）——` +
        '项目级 config / hooks / exec policies **会加载**' +
        (sync.trustedProjectConfigHash === null
          ? '；这个目录里没有 `.codex/config.toml`（只开了门、没装东西）。'
          : `；那份 \`.codex/config.toml\` 的指纹是 ${sync.trustedProjectConfigHash}。`),
    )
  }
  return { ok: true, reason: null, home, env, notes }
}

/**
 * 实体被删时，清掉对应的工作目录状态（分批第 61 批）。
 *
 * · codex：那份 `CODEX_HOME` 里有 `auth.json` 的真实 key 副本 ⇒ 必须删；
 * · claude：**全局一份**，删实体不影响它（会话状态在 `projects/` 下、不含 key）⇒ 无操作。
 *   ——这就是"按策略"而不是"按 runtime 名写 if"的好处：以后谁改成 perWorkDir，这里自动跟上。
 */
export async function forgetRuntimeConfigHome(
  runtimeKey: IsolatedRuntimeKey,
  rootDir: string,
  workDir: string | null,
): Promise<boolean> {
  if (!POLICY[runtimeKey].perWorkDir) return false
  if (workDir === null || workDir === '') return false
  const result = await removeCodexHomeFor(rootDir, workDir)
  return result.removed
}

/** 顺手清理太旧的受管目录（只有 perWorkDir 的策略才有意义）。 */
export async function pruneRuntimeConfigHomes(
  runtimeKey: IsolatedRuntimeKey,
  rootDir: string,
  keepHome: string,
  keep = 8,
): Promise<string[]> {
  if (!POLICY[runtimeKey].perWorkDir) return []
  return await pruneCodexHomes(rootDir, keepHome, keep)
}

/** 扫宿主级技能（目前只有 codex 需要；claude 不读 `~/.agents/skills`，实测过）。 */
export async function hostSkillsFor(
  runtimeKey: IsolatedRuntimeKey,
  roots: readonly string[],
): Promise<HostSkill[]> {
  if (runtimeKey !== 'codex') return []
  return await findSkillFiles(roots)
}

/** 供 executor 判断"这个 runtime 有没有配置隔离这回事"。 */
export function isIsolatedRuntime(key: string): key is IsolatedRuntimeKey {
  return key === 'claude' || key === 'codex'
}

/** 未使用的类型导出（保持与 Agent 的关联，便于将来按 agent 定制策略）。 */
export type _AgentRef = Agent
