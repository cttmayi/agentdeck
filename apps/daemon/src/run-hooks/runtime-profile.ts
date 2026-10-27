/**
 * ★ 分批第 67 批：平台侧的 **runtime 配置档**（差异用继承表达，不在 executor 里写 `if key ===`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有它
 * ══════════════════════════════════════════════════════════════════
 *
 * 上一批（64）把"配置隔离"的流程收成了一条，但**差异仍然是 `if (key === 'claude')`**：
 * 受管根从哪来、源是哪份文件、要不要按工作目录分、要不要扫宿主级技能——四个问题写在
 * 两个 if 分支里。这一批把它们挪进类：
 *
 *   RuntimeProfile（基类：默认值 + 公共方法）
 *     ├── ClaudeProfile（不按工作目录分、不扫宿主级、有任务隔离 hook）
 *     └── CodexProfile （按工作目录分、扫宿主级、无 hook 机制）
 *
 * executor 那边于是变成"问配置档"，而不是"按名字判断"：
 *
 *     const profile = profileFor(runtime.descriptor.key)
 *     if (profile?.injectsRunHooks()) await injectRunHooks(...)
 *
 * ⚠️ 新增第四个 runtime 时：写一个 profile 子类，**不动 executor**。
 * ⚠️ 默认值刻意选"最少副作用"的那一档（不注入 hook、不扫宿主级、不做隔离），
 *    这样新 runtime 不会因为漏写而**多**做一件没人预期的事。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { syncClaudeConfigDir } from './claude-config.ts'
import {
  codexHomeFor,
  findSkillFiles,
  pruneCodexHomes,
  removeCodexHomeFor,
  syncCodexConfigDir,
  type HostSkill,
} from './codex-config.ts'

/** 配置隔离要用到的几个路径（由 daemon 装配时注入，测试可覆盖）。 */
export interface IsolationDeps {
  /** 受管根（`dataDir/claude-config` 之类）。null = 这个 runtime 没有受管目录（关掉隔离）。 */
  rootDir: string | null
  /** 源配置路径（claude 是 settings.json 路径，codex 是 `~/.codex` 目录）。 */
  sourcePath: string
  /** 宿主级技能根（codex 会扫 `$HOME/.agents/skills`；claude 实测不读）。 */
  hostSkillRoots: string[]
}

export interface IsolationPlan {
  /** 受管目录（null = 不做隔离）。 */
  rootDir: string | null
  /** 从哪份配置复制/读取。 */
  sourcePath: string
  /** 受管目录要不要按工作目录分（决定并行 run 会不会互相覆盖）。 */
  perWorkDir: boolean
  /** 要不要扫宿主级技能根并逐条禁用。 */
  scanHostSkills: boolean
}

/** 一次隔离同步的产物（notes/env 都由 profile 自己给，调用方只负责打印与注入）。 */
export interface IsolationSyncOutcome {
  ok: boolean
  reason: string | null
  home: string
  env: Record<string, string>
  notes: string[]
}

export interface IsolationSyncContext {
  /** 受管目录（已按 `perWorkDir` 算好）。 */
  home: string
  sourcePath: string
  workDir: string | null
  hostSkills: readonly HostSkill[]
}

export abstract class RuntimeProfile {
  /**
   * 这个 runtime 有没有"配置隔离"这回事（有没有受管目录可搬）。
   *
   * ★ 分批第 67 批：`isIsolatedRuntime()` 原来写死 `key === 'claude' || 'codex'`——
   *   那就是又一处"新增 runtime 得记得改这里"。现在由 profile 自己声明。
   */
  readonly isolated: boolean = false

  /** 这个 runtime 有没有"任务隔离 hook"这条机制（只有 claude 有 PreToolUse hook）。 */
  injectsRunHooks(): boolean {
    return false
  }

  /**
   * 配置隔离怎么算。
   *
   * 默认实现 = **不做隔离**（`rootDir: null`）：新 runtime 先别动使用者环境，
   * 想做的子类自己覆盖。
   */
  isolation(_deps: IsolationDeps): IsolationPlan {
    return { rootDir: null, sourcePath: '', perWorkDir: false, scanHostSkills: false }
  }

  /**
   * 把源配置写进受管目录，并给出「日志说明 + 要注入的 env」。
   *
   * ★ 分批第 67 批：这段原来在 `syncRuntimeConfig()` 里按 `runtimeKey === 'claude'` 分派。
   *   现在由各子类**自己实现**——写入器与 note 文案都是这个 runtime 的私事。
   * 默认实现 = 不做隔离（诚实：没写就是没有）。
   */
  async syncIsolation(ctx: IsolationSyncContext): Promise<IsolationSyncOutcome> {
    return { ok: false, reason: '这个 runtime 没有配置隔离', home: ctx.home, env: {}, notes: [] }
  }

  /** 删实体时清掉这份受管目录（只有 `perWorkDir` 才有意义）。返回是否真的删了。 */
  async forgetHome(rootDir: string, workDir: string | null): Promise<boolean> {
    if (!this.isolationPerWorkDir()) return false
    if (workDir === null || workDir === '') return false
    const result = await removeCodexHomeFor(rootDir, workDir)
    return result.removed
  }

  /** 清理太旧的受管目录（同样只有 `perWorkDir` 才有意义）。 */
  async pruneHomes(rootDir: string, keepHome: string, keep = 8): Promise<string[]> {
    if (!this.isolationPerWorkDir()) return []
    return await pruneCodexHomes(rootDir, keepHome, keep)
  }

  /** 扫宿主级技能（要不要扫由 `scanHostSkills` 决定）。 */
  async hostSkills(roots: readonly string[]): Promise<HostSkill[]> {
    if (!this.isolation({ rootDir: '', sourcePath: '', hostSkillRoots: [] }).scanHostSkills) return []
    return await findSkillFiles(roots)
  }

  /** 受管目录按不按工作目录分（从 plan 里取，避免子类重复声明）。 */
  isolationPerWorkDir(): boolean {
    return this.isolation({ rootDir: '', sourcePath: '', hostSkillRoots: [] }).perWorkDir
  }

  /** 默认源路径（daemon 没注入覆盖时用）。默认空串 = 没有。 */
  defaultSourcePath(_home: string): string {
    return ''
  }

  /** 为什么是这个形态——**每一条差异都要能说出理由**（写在类上，别再散到注释里）。 */
  abstract readonly why: string
}

/**
 * claude：受管目录**全局一份**。
 *
 * 每轮写出来的内容完全一样（env + 固定的 enabledPlugins），没有"这次"的变量；
 * 而 `CLAUDE_CONFIG_DIR/projects/` 是**会话状态**，`--resume` 要靠它全局稳定。
 */
export class ClaudeProfile extends RuntimeProfile {
  override readonly isolated = true
  readonly why =
    '每轮内容完全一样（env + 固定 enabledPlugins）；CLAUDE_CONFIG_DIR/projects 是会话状态，--resume 要它全局稳定'

  override injectsRunHooks(): boolean {
    return true
  }

  override isolation(deps: IsolationDeps): IsolationPlan {
    return {
      rootDir: deps.rootDir,
      sourcePath: deps.sourcePath,
      perWorkDir: false,
      // claude 实测**不读** `$HOME/.agents/skills`（假端点抓请求体验过）⇒ 不用扫
      scanHostSkills: false,
    }
  }

  override defaultSourcePath(home: string): string {
    return join(home, '.claude', 'settings.json')
  }

  override async syncIsolation(ctx: IsolationSyncContext): Promise<IsolationSyncOutcome> {
    const sync = await syncClaudeConfigDir(ctx.home, ctx.sourcePath)
    const env = { CLAUDE_CONFIG_DIR: ctx.home, CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' }
    return {
      ok: sync.ok,
      reason: sync.reason ?? null,
      home: ctx.home,
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
}

/**
 * codex：受管目录**按工作目录分**。
 *
 * 每轮要写 `[projects."<本次工作目录>"] trust` ⇒ 内容每轮不同；全局一份时两条
 * 不同目录的 run 并行会互相覆盖（分批第 60 批量到过）。
 * 另：codex 会扫 `$HOME/.agents/skills`（跨 agent 全局目录）⇒ 要逐条禁用。
 */
export class CodexProfile extends RuntimeProfile {
  override readonly isolated = true
  readonly why =
    '每轮要写 [projects."<本次工作目录>"] trust ⇒ 内容每轮不同，全局一份会被并行覆盖；另会扫 $HOME/.agents/skills'

  override isolation(deps: IsolationDeps): IsolationPlan {
    return {
      rootDir: deps.rootDir,
      sourcePath: deps.sourcePath,
      perWorkDir: true,
      scanHostSkills: true,
    }
  }

  override defaultSourcePath(home: string): string {
    return join(home, '.codex')
  }

  override async syncIsolation(ctx: IsolationSyncContext): Promise<IsolationSyncOutcome> {
    const sync = await syncCodexConfigDir(
      ctx.home,
      ctx.sourcePath,
      ctx.workDir ?? undefined,
      ctx.hostSkills,
    )
    const env = { CODEX_HOME: ctx.home }
    const notes: string[] = []
    if (!sync.ok) {
      notes.push(
        `⚠️ codex 个人配置隔离未生效（${sync.reason ?? '未知原因'}）——` +
          '本次 run 会看到用户级 skill（如 browser-use）。',
      )
      return { ok: false, reason: sync.reason ?? null, home: ctx.home, env, notes }
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
    return { ok: true, reason: null, home: ctx.home, env, notes }
  }
}

/**
 * generic：**不做配置隔离**（它是"自带 CLI 的通用壳"，没有已知的个人配置目录）。
 *
 * ⚠️ 它以前在 executor 里根本进不了隔离分支（判据是 `key === 'claude'` / `'codex'`），
 *    但那是**隐式**的"没写"。这里显式声明一个 profile：语义从"漏了"变成"决定"。
 */
export class GenericProfile extends RuntimeProfile {
  readonly why = '通用壳：没有已知的个人配置目录，因此不做隔离（显式声明，而不是"漏了"）'
}

const PROFILES: Readonly<Record<string, RuntimeProfile>> = {
  claude: new ClaudeProfile(),
  codex: new CodexProfile(),
  generic: new GenericProfile(),
}

/** 取这个 runtime 的配置档；没有（未知 runtime）= null（调用方按"什么都不做"处理）。 */
export function profileFor(runtimeKey: string): RuntimeProfile | null {
  return PROFILES[runtimeKey] ?? null
}

/** 所有已知 profile 的 key（诊断与测试用）。 */
export function knownProfileKeys(): string[] {
  return Object.keys(PROFILES)
}

/**
 * 受管根：daemon 装配时给两个路径（claude / codex 各一个），按 runtime 取。
 *
 * ★ 分批第 67 批：原来 executor 与 server 各写一遍
 *   `runtimeKey === 'claude' ? claudeConfigDir : codexConfigDir`（两处、还要处理 undefined）。
 *   现在只有这一处，而且"哪个 runtime 有受管根"由 profile 的 `isolated` 决定。
 */
export function isolationRootFor(
  runtimeKey: string,
  roots: { claude: string | null; codex: string | null },
): string | null {
  const profile = profileFor(runtimeKey)
  if (profile === null || !profile.isolated) return null
  // 名字 → 装配时给的那个根；表里没有 = 没有受管目录（不是"猜一个"）
  return (roots as Record<string, string | null>)[runtimeKey] ?? null
}

/** 默认的隔离依赖（真实路径）：daemon 装配时可以用别的值覆盖（测试注入）。 */
export function defaultIsolationDeps(input: {
  runtimeKey: 'claude' | 'codex'
  rootDir: string | null
  settingsSource?: string | null
  codexSource?: string | null
  hostSkillRoots?: string[]
}): IsolationDeps {
  const home = homedir()
  // ★ 分批第 67 批：源路径由 profile 的 `defaultSourcePath()` 给（原来是按名字选）。
  const injected =
    input.runtimeKey === 'claude' ? input.settingsSource : input.codexSource
  return {
    rootDir: input.rootDir,
    sourcePath: injected ?? profileFor(input.runtimeKey)?.defaultSourcePath(home) ?? '',
    hostSkillRoots: input.hostSkillRoots ?? [join(home, '.agents', 'skills')],
  }
}
