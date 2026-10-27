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

import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
  /**
   * ★ 分批第 55 批：这次把哪个**工作目录**标成了 trusted（没有就是 null）。
   *
   * 为什么要它：codex 对项目级 `.codex/config.toml` / hooks / exec policies 有一道
   * "项目未 trusted 就整个不读"的门（真机 stderr 原话：
   * `Project-local config, hooks, and exec policies are disabled … until the project is trusted,
   *  but skills still load`）。所以"项目级配置有没有生效"必须**可见**——它改变的是
   * 这一轮到底读了什么，不是内部细节。
   */
  trustedProject: string | null
  /** trusted 那个项目里的 `.codex/config.toml` 指纹（文件不存在 = null）。 */
  trustedProjectConfigHash: string | null
  /**
   * 这次有没有把 codex **自带**的 system skills 关掉（分批第 56 批）。
   *
   * `'disabled'` = 我们写了 `[skills.bundled] enabled = false`；
   * `'already-configured'` = 使用者自己的配置里已经有这一段（**我们没改**，
   *   所以它到底开没开由他那份决定——日志里要说清，否则"以为关了其实没关"）。
   */
  bundledSkills: 'disabled' | 'already-configured'
  /**
   * 这次**逐条禁用**的宿主级技能（`$HOME/.agents/skills` 那些）。
   *
   * 为什么需要它出现在结果里：这些技能不属于平台、也不在任何受管目录里，
   * 它们**本来会**出现在模型的技能清单里。禁用是有副作用的动作，日志必须说出来。
   */
  hostSkillsDisabled: string[]
  /** 使用者自己在 config 里已经写过开关的（我们不碰他的取值）。 */
  hostSkillsAlreadyListed: string[]
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
/**
 * ★ 分批第 55 批：往 `config.toml` 文本里补一段"信任这个项目"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 真机上量到的事实（不是猜的）
 * ══════════════════════════════════════════════════════════════════
 *
 * 在工作目录里放一份 `.codex/config.toml`，启动 `codex app-server` 时它压根不读，
 * 只吐一句 error：
 *
 *     Project-local config, hooks, and exec policies are disabled in the following folders
 *     until the project is trusted, but skills still load.
 *     To load project-local config … add <workDir> as a trusted project in <CODEX_HOME>/config.toml.
 *
 * 而**技能照旧加载**（所以从前"删技能"才被当成隔离手段）。实测：在受管
 * `CODEX_HOME/config.toml` 里加
 *
 *     [projects."<workDir>"]
 *     trust_level = "trusted"
 *
 * 之后，同一个项目级 `.codex/config.toml` 立刻被读（实测方式：往里塞一个不存在的键，
 * 未 trusted 时一声不响，trusted 后 codex 会报 `project (…/.codex/config.toml): xxx is ignored`）。
 *
 * ⚠️ **trusted 是打包开关**：它同时启用项目级 **hooks 与 exec policies**，不只是 config。
 *    也就是说工作目录里那份文件从"没人看"变成"会被执行"。这件事必须在 run 日志里说出来
 *    （调用方负责），不能在后台悄悄发生。
 * ⚠️ 幂等：已经存在同名 `[projects."…"]` 段就不再追加——TOML 里重复定义同一个表是**错误**，
 *    追加两次会让 codex 直接起不来。
 * ⚠️ 路径要按 TOML 基本字符串转义（Windows 的 `C:\…` 必须写成 `C:\\…`，否则 config.toml
 *    直接解析失败，而失败信息只说"配置坏了"）。
 */
export function withTrustedProject(
  configText: string,
  projectDir: string,
): { text: string; added: boolean } {
  const key = `[projects."${escapeTomlBasicString(projectDir)}"]`
  if (configText.includes(key)) return { text: configText, added: false }
  const trimmed = configText.endsWith('\n') ? configText : `${configText}\n`
  return {
    text: `${trimmed}\n${key}\ntrust_level = "trusted"\n`,
    added: true,
  }
}

/** TOML 基本字符串的转义：`\` 与 `"` 两个字符就够（其余原样）。 */
function escapeTomlBasicString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * ★ 分批第 56 批：关掉 codex **自带**的 system skills（`CODEX_HOME/skills/.system`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么（实测，不是推断）
 * ══════════════════════════════════════════════════════════════════
 *
 * `codex debug prompt-input`（codex 自带的"模型可见输入"导出器）在一个干净的
 * CODEX_HOME 里会列出**三个**技能根：
 *
 *   r0 = <workDir>/.codex/skills          ← 我们注入的（平台控制）
 *   r1 = $HOME/.agents/skills             ← 跨 agent 的全局目录（**隔离挡不住**，见下面）
 *   r2 = <CODEX_HOME>/skills/.system      ← codex 自带的 6 个（imagegen / openai-docs /
 *                                            plugin-creator / review-agent / skill-creator /
 *                                            skill-installer）
 *
 * 使用者当时看到"能看见 9 个 skill"，就是 3（r1）+ 6（r2）。r2 那 6 个**与任务无关**，
 * 却每次都在模型的技能清单里——它既稀释"平台给了什么技能"这个信号，也让每次 run 的提示词更长。
 *
 * 实测关法（上游 PR #13792 的落地键名，本机 0.157.1 验证过）：
 *
 *     [skills.bundled]
 *     enabled = false
 *
 * ⚠️ 只关 r2。`r0`（我们注入的）与 `r1`（`$HOME/.agents/skills`）照旧——
 *    r1 目前**没有任何配置键能关**（上游 issue #46414 / #24237 / #56659 都还开着），
 *    只能靠改 HOME，那会连带丢 `~/.ssh` 与 `~/.config`，不在这一步里做。
 * ⚠️ 幂等：使用者自己的 config.toml 里已经有 `[skills.bundled]` 段时**不追加**
 *    （TOML 重复定义同一个表是错误 ⇒ codex 直接起不来），而是如实回报"没被我们改写"。
 */
export function withBundledSkillsDisabled(configText: string): {
  text: string
  added: boolean
  alreadyConfigured: boolean
} {
  if (configText.includes('[skills.bundled]')) {
    return { text: configText, added: false, alreadyConfigured: true }
  }
  const trimmed = configText.endsWith('\n') ? configText : `${configText}\n`
  return {
    text: `${trimmed}\n[skills.bundled]\nenabled = false\n`,
    added: true,
    alreadyConfigured: false,
  }
}

/**
 * ★ 分批第 57 批：把**宿主级（跨 agent）技能**逐个禁用 —— 这是使用者实测出来的机制。
 *
 * ══════════════════════════════════════════════════════════════════
 * 怎么发现的
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者在自己机器的 `~/temp` 里跑 codex，用它的 `/skills` 命令关掉了 `find-skills`，
 * 然后问"它到底写了什么"。答案在 `~/.codex/config.toml`：
 *
 *     [[skills.config]]
 *     path = "/Users/ling/.agents/skills/find-skills/SKILL.md"
 *     enabled = false
 *
 * 也就是 codex 有**按 SKILL.md 绝对路径逐条开关**的机制（`skills.config` 数组表）。
 * 实测（`codex debug prompt-input` 复核）：
 *   · 单文件禁用 ⇒ 该 skill 立刻从"模型可见清单"里消失 ✅
 *   · **目录当 path 不行**（`path = "…/.agents/skills"` 无效）⇒ 必须逐条列 SKILL.md
 *   · 对 codex 自带的 `.system` 技能同样有效（但我们用 `[skills.bundled]` 一处关掉更省）
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它（隔离的真实缺口）
 * ══════════════════════════════════════════════════════════════════
 *
 * `$HOME/.agents/skills` 是一条**跨 agent 的全局技能目录**（vercel-labs/skills 那套装进去的），
 * `CODEX_HOME` 重定向**管不到它**（上游 issue #46414 还开着）。于是"执行者与审核者能看到
 * 彼此之外的技能"这件事，只能靠这个逐条禁用机制堵住。
 */
export function withHostSkillsDisabled(
  configText: string,
  skills: readonly HostSkill[],
): { text: string; disabled: string[]; alreadyListed: string[] } {
  const disabled: string[] = []
  const alreadyListed: string[] = []
  let text = configText
  for (const skill of skills) {
    /**
     * ⚠️ **按路径关**（不是按 name）——理由见 `HostSkill` 上面那段实测：
     *    按 name 关会把**同名**的平台注入技能一起关掉，而那种失效没有报错。
     * ⚠️ **没有通配符**：`path` 写星号、写目录都不生效（实测），只能一条条列。
     */
    const key = `path = "${escapeTomlBasicString(skill.path)}"`
    if (text.includes(key)) {
      alreadyListed.push(skill.path)
      continue
    }
    const trimmed = text.endsWith('\n') ? text : `${text}\n`
    text = `${trimmed}\n[[skills.config]]\n${key}\nenabled = false\n`
    disabled.push(skill.path)
  }
  return { text, disabled, alreadyListed }
}

/**
 * 在若干**宿主级技能根**下递归找出 `SKILL.md`（codex 也认嵌套的那一份：
 * `fireworks-tech-graph` 就有两层，实测它把两份都列出来了）。
 *
 * 只读、深度有限（默认 4 层）：技能目录不该更深，而无限递归会在使用者的
 * 家目录里乱翻。找不到就返回空数组——**不抛**，那是正常情况（没装这类技能）。
 */
/**
 * ★ 分批第 59 批：宿主级技能**只能按路径关，不能按 name 关**（实测出来的坑）。
 *
 * 使用者的提问值一条实测：「如果只写名字，如果我加载的 skill 重名，是否会有问题」。
 *
 * 用受控 `HOME`（`$HOME/.agents/skills` = 夹具目录）+ 工作目录注入**同名**技能，实测：
 *
 *   · 基线：清单里出现**两条**同名条目（r0 平台注入、r1 宿主级），codex 不按名字去重；
 *   · `[[skills.config]] name = "find-skills" enabled = false`
 *     ⇒ **两条一起消失**（连平台注入的那份也被关掉了）；
 *   · `[[skills.config]] path = "<宿主那份 SKILL.md>" enabled = false`
 *     ⇒ 只剩平台注入的那条 ✅ 精确。
 *
 * 所以实现**只用 path**。代价是同名之外的"嵌套副本"要列两条（真机上
 * `fireworks-tech-graph` 有两层），但正确性优先——name 那条会让"用户恰好装过同名技能"
 * 这种无辜场景把平台自己注入的技能悄悄关掉，而那种失效**没有任何报错**。
 */
export interface HostSkill {
  /** frontmatter 里的 `name`（**只用于日志/诊断**，不写进 config）。 */
  name: string | null
  /** `SKILL.md` 的绝对路径 —— 写进 config 的就是它。 */
  path: string
}


/**
 * 在若干**宿主级技能根**下递归找出技能（`SKILL.md`）。
 *
 * ⚠️ 递归是必须的：codex 认嵌套那份（真机上 `fireworks-tech-graph` 有两层，
 *    它把两份都列出来了）。
 * ⚠️ 只读、深度有限（默认 4 层）：技能目录不该更深，无限递归会在家目录里乱翻。
 *    找不到就返回空数组——**不抛**，那是正常情况（没装这类技能）。
 * ⚠️ `name` 只为日志/诊断而读，**不参与禁用**（按 name 关不安全，见 `HostSkill` 那段实测）。
 */
export async function findSkillFiles(roots: readonly string[], maxDepth = 4): Promise<HostSkill[]> {
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
    if (entries === null) return
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.name === 'SKILL.md') found.push(full)
    }
  }
  for (const root of roots) await walk(root, 0)
  const out: HostSkill[] = []
  for (const path of found.sort()) out.push({ name: await readSkillName(path), path })
  return out
}

/**
 * 从 `SKILL.md` 的 frontmatter 里取 `name:`（取不到 = null）。
 *
 * ⚠️ **只用于日志/诊断**，不写进 config（按 name 关不安全，见 `HostSkill` 那段实测）。
 */
async function readSkillName(skillFile: string): Promise<string | null> {
  const text = await readFile(skillFile, 'utf8').catch(() => null)
  if (text === null) return null
  // 只看 frontmatter（第一个 --- 到第二个 --- 之间），避免正文里那种同名行误命中
  const end = text.indexOf('\n---', 3)
  const head = end === -1 ? text.slice(0, 400) : text.slice(0, end)
  const match = /^name:\s*(.+)$/m.exec(head)
  if (match === null) return null
  const name = (match[1] ?? '').trim().replace(/^["']|["']$/g, '')
  return name === '' ? null : name
}

/**
 * ★ 分批第 60 批：**每个工作目录一份 CODEX_HOME**（从"全局一份"改成"按任务分"）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么改（使用者选的方案）
 * ══════════════════════════════════════════════════════════════════
 *
 * 全局一份时有个隐蔽缺陷：`CODEX_HOME/config.toml` 是全平台共享的，而两条**不同工作目录**
 * 的 codex run 可以并行（工作目录锁是按目录的）⇒ 两条 run 同时从源重建这份文件，
 * 后写的那条赢 ⇒ **先写那条 run 的 `[projects."<它的目录>"]` 信任段被抹掉**，它的项目级
 * 配置于是静默不生效。这种"不报错、只是没生效"正是这个仓库最贵的一类缺陷。
 *
 * 按工作目录分目录之后：同一 workdir 的 run 之间本来就由工作目录锁串行，跨 workdir 互不相干
 * ⇒ 竞争从结构上消失。
 *
 * ⚠️ **绝不能放进工作目录本身**：里面有 `auth.json`（真实 key），而 agent 能读自己的工作目录
 *    （D78 的硬约束）。所以放数据目录下，用工作目录路径的哈希当目录名。
 * ⚠️ 跨目录 `thread/resume` 会因此断——现在没有这种用法（沉淀返工在同一个小屋里、
 *    聊天在同一对话目录、审核继承被执行 run 的目录），但以后写新功能要记住这条。
 */
export function codexHomeFor(rootDir: string, workDir: string): string {
  const key = createHash('sha256').update(workDir).digest('hex').slice(0, 16)
  return join(rootDir, key)
}

/**
 * 清掉太旧的 per-workdir CODEX_HOME（codex 会在里面生成 `sessions/`、`*.sqlite`、
 * `skills/.system/`，不清理就会一直长）。
 *
 * 只删**名字形如 16 位十六进制**的目录（我们自己的命名），`keepDir` 永不删，
 * 最多保留 `keep` 个（按 mtime）。失败只忽略——清理失败不该让 run 失败。
 */
export async function pruneCodexHomes(
  rootDir: string,
  keepDir: string,
  keep = 8,
): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => null)
  if (entries === null) return []
  const ours: Array<{ path: string; at: number }> = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{16}$/u.test(entry.name)) continue
    const path = join(rootDir, entry.name)
    if (path === keepDir) continue
    const info = await stat(path).catch(() => null)
    ours.push({ path, at: info?.mtimeMs ?? 0 })
  }
  ours.sort((a, b) => b.at - a.at)
  const removed: string[] = []
  for (const stale of ours.slice(Math.max(0, keep - 1))) {
    if (await rm(stale.path, { recursive: true, force: true }).then(() => true, () => false)) {
      removed.push(stale.path)
    }
  }
  return removed
}

/**
 * ★ 分批第 61 批：删掉某个工作目录对应的那份 `CODEX_HOME`（对话/任务/run 被删时）。
 *
 * 为什么必须删（使用者提的）：
 *   · 那份目录里有 `auth.json`——**真实 API key 的副本**。任务都删了还留着一份 key，
 *     是那种"看不见、但一直在"的残留；
 *   · 目录名是工作目录路径的哈希，工作目录本身如果被删/被复用，这份就永远对不上号了。
 *
 * 安全边界（与 `pruneCodexHomes` 同一条纪律）：
 *   · 只认**我们自己命名的目录**（16 位十六进制）——传进来一个奇怪的路径也不会去删别的东西；
 *   · 删不掉只忽略（调用方是"删除实体"的路由，不该因为清理失败而回 500）；
 *   · 返回是否真的删了，便于日志与测试。
 */
export async function removeCodexHomeFor(
  rootDir: string,
  workDir: string,
): Promise<{ removed: boolean; path: string }> {
  const path = codexHomeFor(rootDir, workDir)
  if (!/^[0-9a-f]{16}$/u.test(path.slice(path.lastIndexOf('/') + 1))) {
    return { removed: false, path }
  }
  const removed = await rm(path, { recursive: true, force: true }).then(
    () => true,
    () => false,
  )
  return { removed, path }
}

export async function syncCodexConfigDir(
  configDir: string,
  sourceHomeDir: string,
  /**
   * 要标成 trusted 的**工作目录**（缺省不标）。
   *
   * 为什么是"每次 run 现算"而不是写死在受管 config 里：受管 config.toml 每轮都从
   * 使用者的 `~/.codex/config.toml` **重新复制**（幂等覆盖 ⇒ 改 key 即时生效），
   * 所以 trust 段也必须每轮重写；否则要么攒成几十条（使用者那份文件里已经攒了一屏），
   * 要么在复制那一刻被覆盖掉。
   */
  trustProjectDir?: string,
  /**
   * 要逐条禁用的宿主级 `SKILL.md` 绝对路径（缺省 = 不禁用）。
   *
   * 调用方（executor）拿 `findSkillFiles([$HOME/.agents/skills])` 的结果传进来——
   * 为什么不在这个函数里自己扫：这个模块不该知道"哪些目录算宿主级"，
   * 那是**平台策略**（`$HOME/.agents/skills` 是跨 agent 的全局目录），
   * 写在这里会让"再加一个宿主根"变成改底层库。
   */
  hostSkills?: readonly HostSkill[],
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
      trustedProject: null,
      trustedProjectConfigHash: null,
      bundledSkills: 'already-configured',
      hostSkillsDisabled: [],
      hostSkillsAlreadyListed: [],
    }
  }

  // ── 项目级配置的门：把这次的工作目录标成 trusted ──
  let trustedProject: string | null = null
  let trustedProjectConfigHash: string | null = null
  if (trustProjectDir !== undefined && trustProjectDir.trim() !== '') {
    const configPath = join(configDir, 'config.toml')
    const original = await readFile(configPath, 'utf8')
    const patched = withTrustedProject(original, trustProjectDir)
    if (patched.added) await writeFile(configPath, patched.text, 'utf8')
    trustedProject = trustProjectDir
    // 记项目级 config 的指纹：它是"agent 写的、还是使用者写的"的唯一线索，
    // 也是"这一轮 trusted 之后到底会加载什么"的可审计证据（内容不进日志）。
    const projectConfig = await readFile(join(trustProjectDir, '.codex', 'config.toml')).catch(
      () => null,
    )
    trustedProjectConfigHash =
      projectConfig === null
        ? null
        : createHash('sha256').update(projectConfig).digest('hex').slice(0, 12)
  }

  // ── codex 自带的 system skills：一律关掉（与项目 trust 那一步无关）──
  let bundledSkills: CodexConfigSyncResult['bundledSkills'] = 'already-configured'
  {
    const configPath = join(configDir, 'config.toml')
    const current = await readFile(configPath, 'utf8')
    const patched = withBundledSkillsDisabled(current)
    if (patched.added) await writeFile(configPath, patched.text, 'utf8')
    bundledSkills = patched.added ? 'disabled' : 'already-configured'
  }

  // ── 宿主级技能：逐条禁用（`$HOME/.agents/skills` 那些，见上面那段说明）──
  let hostSkillsDisabled: string[] = []
  let hostSkillsAlreadyListed: string[] = []
  if (hostSkills !== undefined && hostSkills.length > 0) {
    const configPath = join(configDir, 'config.toml')
    const current = await readFile(configPath, 'utf8')
    const patched = withHostSkillsDisabled(current, hostSkills)
    if (patched.disabled.length > 0) await writeFile(configPath, patched.text, 'utf8')
    hostSkillsDisabled = patched.disabled
    hostSkillsAlreadyListed = patched.alreadyListed
  }

  return {
    ok: true,
    copied,
    configDir,
    trustedProject,
    trustedProjectConfigHash,
    bundledSkills,
    hostSkillsDisabled,
    hostSkillsAlreadyListed,
  }
}
