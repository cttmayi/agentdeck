import type { RuntimeProtocol } from '@alpha-helper/protocol'

/**
 * runtime 描述表（FR-CLI-47）—— **本项目最重要的一张表**。
 *
 * 参考材料里有一句总结说得很准：
 *
 *   这套东西的价值不在"支持了 Claude Code"——支持一个 CLI 不难。
 *   价值在于**把"支持一个新 runtime"变成一道填空题**。
 *
 * 而"把每个 runtime 的差异集中到几张表里，而不是散在调用点"，比协议适配
 * 难得多：因为协议有规范，而"怎么在不破坏使用者环境的前提下把自己的东西
 * 塞进去"没有标准答案，只能一个 bug 一个 bug 地攒。
 *
 * 所以首版只填一行（claude），但**表本身必须完整存在**——包括当前的
 * 禁用位。留扩展位时一定要写清楚**为什么没启用**，否则它会消失在
 * "以后再说"里。
 */

export type BlockedArgMode = 'standalone' | 'withValue'

/**
 * 该 runtime 的**证据等级**。
 *
 * 加这个字段的直接原因：第二个 runtime（generic）在落地时**没有任何可运行的
 * 真实 CLI 可对照**，字段名只能按公开文档的形状写。如果表里不记录这件事，
 * 它就会和 claude 那一行长得一模一样，而使用者无法分辨"已验证"与"猜的"。
 *
 * 所以等级写在**数据里**，而不是只写在注释里——注释不会出现在 UI 与审计记录上。
 */
export type RuntimeEvidence =
  /** 逐字段对照过真实 CLI 的输出。 */
  | 'verified'
  /** 从文档/公开形状推导，**尚未在真实 CLI 上跑过**。 */
  | 'provisional'

/** 一个注入位的开关状态。 */
export interface InjectionSlot {
  enabled: boolean
  /** 未启用的原因——必填，这是"留扩展位"的可评审形式。 */
  reason?: string
  /** 该位的证据等级。缺省 = `verified`（只对本来就验证过的 claude 成立）。 */
  evidence?: RuntimeEvidence
}

/**
 * 平台受管参数使用的**旗标名**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这必须是数据，而不能写死在 `argv.ts` 里
 * ══════════════════════════════════════════════════════════════════
 *
 * 首个实现里 `argv.ts` 直接 `push('--model', ...)` / `push('--max-turns', ...)`。
 * 对 claude 完全正确，但它把**一个 CLI 的旗标拼写**固化进了"通用"代码——
 * 第二个 runtime 如果叫 `-m` / `--max-steps`，就只能去改 `argv.ts`，
 * 而那正是 FR-CLI-47 明令禁止的"散落在调用点"。
 *
 * 所以旗标名回到表里。默认值保持 claude 的拼写，这样老行为逐字节不变。
 */
export interface ManagedFlags {
  /** 模型参数名。 */
  model: string
  /** 轮次上限参数名。 */
  maxTurns: string
  /**
   * 恢复会话的参数名。
   *
   * 之所以在这里**重复**一份 `resume.flag`：`resume.flag` 是权威定义，
   * 本字段只是它在 argv 组装侧的视图。`loadRuntimeDescriptor` 会把两者对齐，
   * 避免出现"表里一个值、拼参数用另一个值"的静默不一致。
   */
  resume: string
}

/**
 * claude 用的受管旗标。
 *
 * ⚠️ 它**不再是缺省值**（`managedFlags` 已改成必填，见 `RuntimeDescriptor`）。
 *    留着这个导出的原因只有一个：claude 那一行显式地引用它，好让"这是谁的选择"
 *    看得见。新加 runtime 时**必须自己写全**这三个旗标。
 */
export const DEFAULT_MANAGED_FLAGS: ManagedFlags = {
  model: '--model',
  maxTurns: '--max-turns',
  resume: '--resume',
}

/**
 * prompt 的投递方式（FR-CLI-05 的对应物）。
 *
 * claude 走 `--input-format stream-json` + stdin；第二个 runtime 走 argv。
 * 这个差异**不是可以统一掉的**（FR-CLI-39：不得为上游差异造统一抽象层），
 * 所以它是一条数据，由各适配器自己解释。
 */
export type PromptDelivery = 'stdin-ndjson' | 'argv'

/**
 * 技能投递能力。
 *
 * `directory`：这个 CLI 会自己扫某个目录、把里面的 `<dir>/<slug>/SKILL.md`
 * 当成技能（claude 就是 `.claude/skills`）。
 * `none`：它没有这个机制（或者我们**没验证过**它有，那在效果上等同——
 * 见 `RuntimeDescriptor.skills` 的说明）。这时一个文件都不写。
 */
export type SkillDelivery =
  | { kind: 'directory'; dir: string }
  | { kind: 'none'; reason: string }

/** 会话状态三态——见 `RuntimeDescriptor.sessionState` 的说明。 */
export type SessionState = 'stateful' | 'stateless' | 'unknown'

/**
 * 受支持的 CLI 版本范围（FR-CLI-07）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 需求原文里最要紧的是那半句附加说明
 * ══════════════════════════════════════════════════════════════════
 *
 * 「**以实际版本验证，不得凭文档推断**」。
 *
 * 所以这个结构的重点不是 `range` 本身，而是 **`verifiedWith`**：
 * 它要求填表的人写下**真的跑通过的具体版本号**。一个只有 `range` 而没有
 * `verifiedWith` 的行，是在凭文档推断——`checkVersionSupport()` 会把
 * 这种行报成 `undeclared`，不认它是声明。
 */
export interface SupportedVersions {
  /** 版本范围表达式。见 `matchesVersionRange` 支持的语法（不是完整 semver）。 */
  range: string
  /**
   * ★ **实测过**的具体版本——空数组等于没有声明。
   *
   * 这是"不得凭文档推断"的可执行形式：没有实测版本，就没有声明。
   */
  verifiedWith: readonly string[]
  /**
   * 版本落到范围之外时怎么办。
   *
   * - `'warn'`（默认）：照常跑，但**必须留下可见痕迹**（启动日志、身份接口、
   *   审计记录）。选它是因为使用者自己装了那个 CLI，拒绝运行会变成
   *   "我只是升级了一下就用不了了"，而多数升级其实不破坏兼容。
   * - `'refuse'`：拒绝执行。只应在**已知会坏事**的地方用（例如某个版本起
   *   改了输出协议，硬跑只会产出一堆不可解析的东西，那时早点报错更好）。
   */
  onMismatch?: 'warn' | 'refuse'
}

export interface RuntimeDescriptor {
  /** provider 键。 */
  key: string
  /** 探测用的命令名。 */
  command: string
  protocol: RuntimeProtocol

  /**
   * 协议族——决定"输出用什么解析器读"。
   *
   * 与 `protocol` 分开是因为二者并不一一对应：`stream-json` 这个协议名对
   * claude 意味着"事件对象嵌套 message.content 块数组"，而对第二个 runtime
   * 意味着"扁平的 NDJSON 事件"。把这条差异显式化，解析器选择就不再是
   * 调用点里的 `if (key === 'claude')`。
   */
  family: 'claude-stream-json' | 'generic-ndjson'

  /** 证据等级——**未验证的 runtime 不得被当成已验证**。 */
  evidence: RuntimeEvidence
  /** `evidence` 不是 `verified` 时，说明缺什么证据。 */
  evidenceNote?: string

  /**
   * 这个 CLI 的会话状态是什么。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么必须是三态而不是 `stateless?: boolean`
   * ══════════════════════════════════════════════════════════════════
   *
   * 二态的问题是 `undefined` 同时承担了两个意思："有会话"和"不知道"。
   * 于是**没验证过的 runtime 只能二选一**：
   *
   *   - 填 `false`（有会话）⇒ 撒谎。调用方会去尝试恢复一个可能不存在的会话；
   *   - 填 `true`（无会话）⇒ 也撒谎。把一个可能支持恢复的 CLI 说成不支持。
   *
   * 而真实答案是第三个："**不知道**"。这和 `rejectDetectable: false` 表达
   * "测不出是否被拒"是同一个道理——把测不出来的东西说成测出来了，
   * 比留空更糟。
   *
   * 所以三态各有明确后果：
   *   - `'stateful'`   → 允许恢复，且允许判定"恢复被拒"；
   *   - `'stateless'`  → **绝不尝试恢复**（不传恢复参数、不发恢复语义的输入），
   *                      `resumeRejected` 保持 `undefined`；
   *   - `'unknown'`    → 同 stateless 一样**不尝试恢复**，但审计与 UI 要能
   *                      看出原因是"没验证"而不是"确认不支持"。
   *
   * 把两种"不恢复"分开，是因为它们要的后续动作不同：前者要去核对真实 CLI，
   * 后者什么都不用做。
   */
  sessionState: SessionState

  /**
   * 受支持的 CLI 版本范围（FR-CLI-07）。
   *
   * 缺省表示"尚未声明"——**不等于"支持所有版本"**。
   * `checkVersionSupport()` 会把未声明如实报成 `undeclared`。
   */
  versions?: SupportedVersions

  /**
   * 这个 CLI **自己的状态目录**（相对用户主目录），没有就不写。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么要专门声明它
   * ══════════════════════════════════════════════════════════════════
   *
   * CLI 除了工作室目录之外，还会往自己的状态目录里写东西（会话环境、
   * 缓存、历史）。那个目录**不在我们的工作目录里**，也不受我们的沙箱
   * 管——而我们恰恰经常把它跑在受限环境里（容器、专用用户、沙箱）。
   *
   * 实测踩到过：`EPERM: operation not permitted, mkdir
   * '/Users/ling/.claude/session-env/<uuid>'`。这个错误从 agent 的工具输出
   * 里冒出来，**看起来像"工作目录没设成功"**，而实际上工作目录好好的，
   * 是 CLI 自己的家目录写不进去。错误指向了完全错误的方向。
   *
   * 声明它之后就能**在起 run 之前**检查并给出可读的诊断。
   */
  stateDir?: string

  /**
   * 技能怎么投递给这个 CLI（相对工作目录的目录名，或者"没有这个机制"）。
   *
   * ══════════════════════════════════════════════════════════════════
   * ★ 为什么是一个**能力**，而不是一个目录名
   * ══════════════════════════════════════════════════════════════════
   *
   * 原来这里是 `skillDir: string`（必填）。那等于假设**每个 CLI 都有**
   * "把目录摆对就会被发现"这个机制——而那是 claude 一家的约定。
   *
   * 遇到没有这个机制的 CLI，那份必填字段只留下一条路：填一个"它其实不读"的
   * 目录名。后果是最坏的那种——技能**写下去了、永远不生效、而且不报错**
   *（FR-CLI-40 那一类"写成功 ≠ 被读取"）。使用者会去查 prompt、查 skill 内容，
   * 而真正的问题是"这个 CLI 根本没有技能发现"。
   *
   * 所以允许显式声明"没有"：`{ kind: 'none' }`。执行器遇到它时**一个文件都不写**，
   * 并在 run 日志里说清"这个 runtime 没有技能发现机制"——连带把"该 agent 挂了
   * 技能但注入不了"这件事说出来。**宁可不支持，也不要假装支持。**
   *
   * 这与 `toolConfig` / `disableSwitch` 是同一个形状（`enabled: false` + 原因）。
   */
  skills: SkillDelivery
  /** 上下文文件名。 */
  contextFile: string

  /** 工具配置注入位。首版不启用。 */
  toolConfig: InjectionSlot
  /** 技能禁用开关注入位。首版不启用。 */
  disableSwitch: InjectionSlot

  /** 会话恢复。 */
  resume: { flag: string; rejectDetectable: boolean }

  /** prompt 怎么送进去。 */
  promptDelivery: PromptDelivery

  /** 协议基础参数——**属于平台，使用者不可覆盖**。 */
  baseArgs: readonly string[]
  /** 禁改参数表。 */
  blockedArgs: Readonly<Record<string, BlockedArgMode>>

  /**
   * 受管参数的旗标名。**必填**。
   *
   * ══════════════════════════════════════════════════════════════════
   * ★ 这里原来允许缺省，而缺省值是 claude 的拼写
   * ══════════════════════════════════════════════════════════════════
   *
   * 那时候"首版行为逐字节不变"是个好理由。但后果是：**新加一个 runtime 时
   * 忘了声明这三个旗标，就会按 claude 的拼写去拼**（`--model` / `--max-turns`
   * / `--resume`）——若那个 CLI 不认这些旗标，最好情况是起不来（大声），
   * 最坏情况是它**忽略未知旗标**、于是静默用了自己的默认模型与默认轮数，
   * 而审计与日志看起来一切正常。
   *
   * 缺省的方向必须是**安全的那一侧**：宁可加载描述表时就报错，也不要替一个
   * 没声明过的 CLI 猜旗标。所以它是必填，`loadRuntimeDescriptor` 还会在
   * 运行时再验一次（描述表可能来自仓库之外的对象）。
   */
  managedFlags: ManagedFlags
}

/**
 * Claude Code 的禁改表（FR-CLI-09）。
 *
 * 只列协议参数——首版不做 MCP 与技能禁用，所以没有 `--mcp-config` /
 * `--settings` / `--effort`。表是**声明式的**：将来启用一个受管功能，
 * 就是往这里加一行，而不是在拼参数的地方加一个 if。
 *
 * 「表能执行，文档不能」——把"请不要覆盖这些参数"写成表，而不是写成文档。
 */
export const CLAUDE_BLOCKED_ARGS: Readonly<Record<string, BlockedArgMode>> = {
  '-p': 'standalone', // 非交互模式
  '--output-format': 'withValue', // stream-json 协议
  '--input-format': 'withValue', // stream-json 协议
  '--permission-mode': 'withValue', // 无人值守
}

/**
 * 首版唯一启用的 runtime。
 *
 * `--disallowedTools AskUserQuestion` 的理由值得记下来：非交互模式下
 * 提问没有 UI 可渲染，调用只会返回一个空答案，然后 agent 开始
 * **静默推断**——使用者从头到尾看不到那个问题。要澄清就写进评论里。
 */
export const CLAUDE_DESCRIPTOR: RuntimeDescriptor = {
  key: 'claude',
  command: 'claude',
  protocol: 'stream-json',
  family: 'claude-stream-json',
  evidence: 'verified',
  // claude 的会话恢复是它被设计成参考实现的原因之一，且 rejectDetectable 已实现
  sessionState: 'stateful',
  /**
   * FR-CLI-07 要求的版本范围声明。
   *
   * ⚠️ **`verifiedWith` 刻意为空**，而这不是遗漏。
   *
   * 需求原文写着「以实际版本验证，**不得凭文档推断**」。而本仓库的测试
   * **禁止调用真实 CLI**（NFR-T-01：会消耗使用者真实额度、还可能让 agent
   * 改动文件）。两者叠加的结论是：**没有人在本仓库里端到端跑通过任何
   * 一个真实 Claude Code 版本**。
   *
   * 所以这里不能填一个范围就说"支持"——那正是该需求要防的事，而且它
   * 比不填更有害：填了之后看起来像验证过了。空数组让
   * `checkVersionSupport()` 如实报成 `undeclared`。
   *
   * 怎么把它变成真正的声明：用 `pnpm run daemon --verify-runtime claude`
   * 跑一次真实的自检，把实测通过的版本号填进来。这是一个**明确的一次性
   * 动作**，而不是"回头再看看"。
   */
  versions: {
    range: '>=2.0.0 <3.0.0',
    verifiedWith: [],
    onMismatch: 'warn',
  },
  stateDir: '.claude',
  skills: { kind: 'directory', dir: '.claude/skills' },
  contextFile: 'CLAUDE.md',
  toolConfig: {
    enabled: false,
    reason: '首版不做 MCP 工具配置（范围决策）；启用时需追加受管参数并生成受管配置文件',
  },
  disableSwitch: {
    enabled: false,
    reason: '首版不做技能禁用策略；启用时需生成策略文件、追加参数、并把该参数动态加入禁改表',
  },
  resume: { flag: '--resume', rejectDetectable: true },
  promptDelivery: 'stdin-ndjson',
  baseArgs: [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--disallowedTools',
    'AskUserQuestion',
  ],
  blockedArgs: CLAUDE_BLOCKED_ARGS,
  // 显式写出来而不是靠缺省：第二个 runtime 就在隔壁，缺省值会让"这是谁的选择"
  // 变得看不出来。DEFAULT_MANAGED_FLAGS 的值与这里逐字相同。
  managedFlags: DEFAULT_MANAGED_FLAGS,
}

/**
 * 第二个 runtime 的禁改表（FR-CLI-08~13 在非 claude CLI 上的形态）。
 *
 * 和 claude 那张表的关键差异值得记下来：claude 禁的是"协议旗标"，
 * 而这里第一优先禁的是 **`--prompt`**。理由不是协议，而是**注入面**——
 * 这个 CLI 从 argv 读 prompt，如果使用者能塞自己的 `--prompt`，
 * 他就等于替换了**整个任务的输入内容**，而平台还按自己那份 prompt
 * 记账（审计记录、promptHash）。那种不一致比"输出解析失败"更难查。
 *
 * `--api-key` 一类凭据参数**不进这张表**：凭据不是我们不让他改，
 * 而是不走命令行传（见 GENERIC_DESCRIPTOR.evidenceNote）。
 */
export const GENERIC_BLOCKED_ARGS: Readonly<Record<string, BlockedArgMode>> = {
  '--prompt': 'withValue', // 任务输入由平台掌控，不允许被替换
  '--output': 'withValue', // NDJSON 输出格式，解析器按它写
  '--input-format': 'withValue', // 输入投递方式
  '--yolo': 'standalone', // 无人值守：非交互下不会有人来确认
  '--non-interactive': 'standalone', // 同上，别名写法
  '-y': 'standalone', // 同上，短旗标
}

/**
 * 第二个 runtime：OpenAI 兼容的通用 agent CLI。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一行**没有对照过真实 CLI**——请把它当成一份待验证的填表作业
 * ══════════════════════════════════════════════════════════════════
 *
 * 任务要求是"证明适配层真的可插拔"，而不是"再多支持一个厂商"。所以这里的
 * 每个字段都刻意按**一类 CLI 的公开形状**填写（argv 传 prompt、NDJSON 输出、
 * 走环境变量拿凭据），凡是无法在本仓库里跑起来验证的，都在下面逐条标了
 * `[未验证]`。`evidence: 'provisional'` 就是这个事实的机器可读形式：
 *
 *   - 它不会假装自己和 claude 一样可信（UI / 审计可以据此提示）；
 *   - 首次接入真实 CLI 时，需要的动作是**逐个字段核对并删掉标记**，
 *     这是一份可勾选的清单，而不是"回头再看看"。
 *
 * 反过来说：**它已经能跑**——测试用 `--fake-cli` 这个假可执行文件把
 * 拼参数、进程管理、NDJSON 解析、失败分级整条链路都真跑了一遍（NFR-T-01
 * 要求测试不得调用真实 CLI）。未验证的是"字段名与真实 CLI 一致"，
 * 而不是"代码能不能工作"。这两件事必须分开说，否则会把可测的东西一起否掉。
 */
export const GENERIC_DESCRIPTOR: RuntimeDescriptor = {
  key: 'generic',
  command: 'agent-cli',
  protocol: 'stream-json',
  family: 'generic-ndjson',
  evidence: 'provisional',
  /**
   * ★ `'unknown'` 而不是 `'stateless'`。
   *
   * 没有真实 CLI 就无法知道它到底有没有会话 ID。填 `'stateless'` 会把
   * "不知道"说成"确认不支持"，填 `'stateful'` 会让人去尝试恢复一个可能
   * 不存在的会话。两种都是在替真实 CLI 回答我们答不上来的问题。
   *
   * 后果是明确的：调用方**不尝试恢复**（与 stateless 相同），但审计与 UI
   * 能看出原因是"没验证"而不是"确认不支持"——这两者需要的后续动作不同。
   */
  sessionState: 'unknown',
  versions: {
    // 未验证 → 声明也是空的。见 CLAUDE_DESCRIPTOR.versions 的说明。
    range: '*',
    verifiedWith: [],
    onMismatch: 'warn',
  },
  evidenceNote:
    '未对照真实 CLI 验证：命令名 agent-cli、旗标拼写（-m / --max-steps / --resume-session / ' +
    '--no-color）、NDJSON 事件名与字段名、凭据环境变量名均为按公开形状推导。' +
    '测试用假可执行文件覆盖了整条链路（NFR-T-01），但"字段名对得上"必须首次接入真实 CLI 时逐条核对。',
  /**
   * ★ `'none'` 而不是 `.agent/skills`。
   *
   *   这个目录名是按公开形状**猜的**：谁也没验证过该 CLI 会不会扫它。
   *   按新规矩（`RuntimeDescriptor.skills` 的说明），"猜它支持"与"确认它不支持"
   *   在效果上一样糟——都会把技能写进一个可能没人读的目录，然后静默地不生效。
   *   所以这里如实声明"没有"，等真的接上那个 CLI、逐条核对之后再改成
   *   `{ kind: 'directory', dir: … }`。
   *
   *   收益不只是诚实：这条分支因此在**生产表**里被真的走到，不会腐烂成
   *   只在测试里存在的能力。
   */
  skills: {
    kind: 'none',
    reason:
      '未对照真实 CLI 验证过任何技能发现机制：`.agent/skills` 是按公开形状猜的目录名。' +
      '在真实 CLI 上确认"把目录摆对就会被发现"之前不写文件——写进一个没人读的目录' +
      '等于假装支持（FR-CLI-40）。',
  },
  contextFile: 'AGENT.md',
  toolConfig: {
    enabled: false,
    reason:
      '未验证该 CLI 是否有工具白名单机制（claude 走 --mcp-config / --settings）。' +
      '在真实 CLI 上确认存在对应旗标之前不得启用——猜出来的受管参数会让整个 run 起不来',
    evidence: 'provisional',
  },
  disableSwitch: {
    enabled: false,
    reason: '同上：未验证是否存在"禁用某类工具"的开关，启用时需生成策略文件 + 参数 + 动态加入禁改表',
    evidence: 'provisional',
  },
  /**
   * 恢复位：`rejectDetectable: false` —— **这是刻意的，不是偷懒**。
   *
   * 没有真实 CLI 就没有"恢复被拒时长什么样"的样本，因此**测不出**拒绝。
   * 表里承认这一点，后端就会把 `resumeRejected` 留成 `undefined`，
   * 调用方看到的是"无法判断"（FR-CLI-06）。反过来，若这里填 `true`，
   * 就等于声明了一个我们根本没实现的探测能力——那正是该需求要防的
   * "把测不出来当成没被拒"。
   */
  resume: { flag: '--resume-session', rejectDetectable: false },
  promptDelivery: 'argv',
  baseArgs: [
    '--non-interactive',
    '--output',
    'ndjson',
    '--no-color',
    // 与 claude 那条同源的推理：非交互模式下没有人能回答提问，调用只会
    // 返回空答案、agent 转而静默推断（FR-CLI-03）。旗标拼写未验证。
    '--no-ask-user',
  ],
  blockedArgs: GENERIC_BLOCKED_ARGS,
  managedFlags: {
    model: '-m', // [未验证] claude 用 --model
    maxTurns: '--max-steps', // [未验证] claude 用 --max-turns
    resume: '--resume-session', // 与 resume.flag 保持一致（由 loadRuntimeDescriptor 强制）
  },
}

/**
 * 已编译进来的 runtime 表。
 *
 * 为什么是**编译进程序的表**而不是插件：登录与第三方查询是插件（FR-AUTH、
 * FR-BRIDGE），因为它们的差异是**外部世界**的；而 CLI 适配层的差异是
 * **协议形状**的，它决定了平台自己的解析器、失败分级与禁改表怎么工作。
 * 把它做成插件，等于让一段外部代码决定"输出不可解析算不算失败"。
 * 所以加一个 runtime = 在仓库里加一个包 + 在这里加一行（FR-CLI-47）。
 */
export const RUNTIMES: Readonly<Record<string, RuntimeDescriptor>> = {
  claude: CLAUDE_DESCRIPTOR,
  generic: GENERIC_DESCRIPTOR,
}

/**
 * 返回**可直接消费**的描述符：校验必填项、并对齐两个视图。
 *
 * 1. `managedFlags` 是必填。缺了就**抛**，而不是回落到 claude 的拼写——
 *    替一个没声明过的 CLI 猜旗标，正是"看起来能用、实际用错了"的来源。
 *    类型上它已经必填，这里再验一次是因为描述符也可能是仓库之外传进来的对象。
 * 2. `managedFlags.resume` 与 `resume.flag` 是同一件事的两个视图。
 *    在这里**强制对齐**，就不会出现"表里写 A、拼参数用 B"的静默不一致。
 */
export function loadRuntimeDescriptor(keyOrDescriptor: string | RuntimeDescriptor): RuntimeDescriptor {
  const desc =
    typeof keyOrDescriptor === 'string' ? getRuntimeDescriptor(keyOrDescriptor) : keyOrDescriptor
  const resumeFlag = desc.resume.flag
  const flags = desc.managedFlags
  if (!flags || !flags.model || !flags.maxTurns) {
    throw new Error(
      `runtime ${desc.key} 的描述符缺少 managedFlags（model / maxTurns / resume）。` +
        `它们是必填的：**这里不能替它猜**——按另一个 CLI 的旗标拼参数，` +
        `轻则起不来，重则静默用了默认值而日志看起来一切正常。` +
        `请在该 runtime 的表行里写明实际的旗标名。`,
    )
  }
  return {
    ...desc,
    managedFlags: {
      model: flags.model,
      maxTurns: flags.maxTurns,
      // 与 `resume.flag` 对齐：两者是同一件事的两个视图
      resume: resumeFlag || flags.resume,
    },
  }
}

export function getRuntimeDescriptor(key: string): RuntimeDescriptor {
  const desc = RUNTIMES[key]
  if (!desc) {
    throw new Error(
      `未知的 runtime：${key}。当前支持：${Object.keys(RUNTIMES).join(', ')}`,
    )
  }
  return desc
}

/** 所有已知 runtime 的键——探测与 UI 用它枚举。 */
export function knownRuntimeKeys(): string[] {
  return Object.keys(RUNTIMES)
}
