import { mkdir, readdir, rename, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Run, SubjectRef } from '@agentdeck/protocol'

/**
 * 工作目录的解析（D27）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这条规则改过一次，改的是默认行为
 * ══════════════════════════════════════════════════════════════════
 *
 * D20 原来的说法是"**工作目录由使用者指定**，平台不做仓库检出"。那在
 * "把 agent 接进自己的仓库"这个用法下是对的，但它把**每建一个任务都要先想
 * 一个目录**变成了必须动作——而绝大多数任务只是"让 agent 做点事"，它需要的
 * 是一块空白的、属于它自己的工作区。
 *
 * 现在改成：**每个任务默认自动获得一个独立目录**，不必也不该由使用者操心。
 * 想接自己的仓库时仍然可以显式指定（那是高级用法，不是必经之路）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么目录按**任务**分，而不是按 run 分
 * ══════════════════════════════════════════════════════════════════
 *
 * 用户的原话是"每个**任务**默认生成一个单独的目录"。所以粒度是 `subject`，
 * 不是 run。这个选择带来两个正好需要的行为：
 *
 *   - **同一个任务的重试能看到上次留下的文件。** 按 run 分的话，一次重试
 *     就是一间全新的空房间，agent 上次做到哪儿全丢了——而"重试"的语义
 *     恰恰是"接着做"。
 *   - **同一任务的并发被自动串行化**，因为工作目录锁（FR-RUN-04）本来就是
 *     按目录加的。`waiting_local_directory` 因此从"罕见的例外"变成
 *     "同一个任务上的正常排队"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 目录名用 id，不拼标题
 * ══════════════════════════════════════════════════════════════════
 *
 * 拼标题看起来更友好，但标题是**使用者输入的任意文本**：里面有 `/`、
 * `..`、emoji、超长串。要安全就得做转义，而转义规则一旦有缝就是路径穿越。
 * 用 id 则天然安全，而且 ULID 字典序就是时间序——`ls` 出来自动按时间排。
 * 可读性交给界面：路径显示在任务旁边。
 */

/** 目录名前缀：让 `ls` 一眼看出这是哪类对象的工作区。 */
const SUBJECT_PREFIX: Record<SubjectRef['type'], string> = {
  issue: 'issue',
  report: 'report',
  run: 'run',
  // ★ 聊天那一轮的 run 也走这条分配：`<workRoot>/chat-<对话 id>`。
  //   用 `chat-` 而不是 `conversation-`：目录名是给人 `ls` 看的，
  //   短的那个一眼认得出，而且它和界面上那三个字（「聊天」）对得上。
  conversation: 'chat',
  // ★ 起草 run（D80）：`<workRoot>/skill-draft-<run id>`。草稿 run 是
  //   一条普通 execute run，工作目录按 subject 自动分配一间专用小屋。
  'skill-draft': 'skill-draft',
  // ★ 审核起草的那条 run（§10 第 ②.5 步）：它的工作目录**就是草稿小屋**（模板见
  //   下面的注释：`draftRoot()` 直接给出 `skill-draft-<draftRunId>`）——
  //   审核者要读的 `skill/` 与 `material/` 都在那里，另开一间屋就什么都看不到。
  //   这里的前缀只是"万一有人按 subject 分配"时的兜底，正常路径走 `draftRoot`。
  'skill-draft-review': 'skill-draft-review',
}

/**
 * 把 id 收敛成安全的目录名片段。
 *
 * id 本来都是 ULID（纯 ASCII），所以这里的替换在正常数据下**永远不会触发**。
 * 它的存在是因为**这条路径会拼进文件系统**：只要有一天某个 id 来自别处
 * （导入的历史数据、第三方写入的引用），一个没被过滤的 `../` 就会让工作目录
 * 跑到别的地方去。防御性检查写在这里的成本近乎为零，出事的成本是路径穿越。
 */
export function sanitizeIdPart(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, '_')
  // 全是非法字符时不能返回空串——空串会让 `join(root, '')` 变成根本身，
  // 于是所有这类任务**共用同一个目录**，而且是根目录
  if (cleaned === '' || /^[._-]+$/.test(cleaned)) return 'unknown'
  return cleaned.slice(0, 128)
}

export interface ResolveWorkDirInput {
  /** 请求里显式给的目录（优先级最高）。 */
  requested?: string | null
  /**
   * **审核 run 继承的目录**：被审那条 run 实际用的工作目录。
   *
   * ★ 为什么它排在"agent 默认目录"**前面**
   *
   *   审核的前提是**能看到被审的东西**。执行者把产出写在自己的工作目录里，
   *   审核者若落在另一个目录，它拿到手的就只有报告正文那一段文字——
   *   产出文件、中间结果、它自己那次执行的痕迹，一概看不见。
   *   那就不叫"审核"，叫"读一份转述"。
   *
   *   所以当两者冲突时，**继承赢**，而冲突本身要在日志里说出来（静默地
   *   忽略掉操作者配的目录是不可接受的）。
   */
  inheritFrom?: string | null
  /** 该 agent 配置的默认目录（操作者的显式选择）。 */
  agentDefault?: string | null
  /** 自动分配时的根目录。 */
  workRoot: string
  /** 目录按这个对象分组（D27：一个任务一个目录）。 */
  subject: SubjectRef
  /** subject 缺失时的兜底标识（一般用 runId）。 */
  fallbackId: string
}

export interface ResolvedWorkDir {
  path: string
  /** 这个路径是怎么来的——要显示给人看，也要写进审计。 */
  origin: 'requested' | 'inherited' | 'agent-default' | 'auto'
  /** 一句可直接展示的说明。 */
  explanation: string
}

/**
 * 决定这次 run 用哪个目录。**纯函数，不碰文件系统**——便于测试与复用。
 *
 * 优先级：
 *   1. 请求里显式给的（使用者就是要用这个目录）
 *   2. **审核继承被审 run 的目录**（`inheritFrom`）——审核必须看得见产出
 *   3. 该 agent 配置的默认目录（操作者明确表达过"这个 agent 总在这里干活"）
 *   4. **自动分配**：`<workRoot>/<subjectType>-<subjectId>`（默认路径）
 *
 * ★ 第 2 条是补上来的一个**真实缺陷**：审核 run 的 subject 是
 *   `{type:'run', id}`，于是自动分配会按 run 的 id 建一个目录
 *   （`run-<被审的runId>`），而执行者用的是 `issue-<任务id>`——两个目录。
 *   结果审核者在**一间空屋子**里审一份转述，产出文件一个也看不到。
 *
 * 注意第 2 条仍然保留而不是被砍掉：它是一种**显式配置**，不是"没填时的兜底"。
 * 一个被钉在某个仓库上的 agent（比如"只在这个项目里干活的 agent"）正是
 * 这样表达的，而它与"每个任务一个新目录"并不冲突——前者是操作者的选择，
 * 后者是没人选择时的合理默认。
 */
export function resolveWorkDir(input: ResolveWorkDirInput): ResolvedWorkDir {
  const requested = input.requested?.trim()
  if (requested) {
    return {
      path: requested,
      origin: 'requested',
      explanation: '使用显式指定的工作目录',
    }
  }

  const inherited = input.inheritFrom?.trim()
  if (inherited) {
    return {
      path: inherited,
      origin: 'inherited',
      explanation: '继承被审 run 的工作目录（审核必须看得见执行留下的文件）',
    }
  }

  const agentDefault = input.agentDefault?.trim()
  if (agentDefault) {
    return {
      path: agentDefault,
      origin: 'agent-default',
      explanation: '使用该 agent 配置的默认工作目录',
    }
  }

  const id = input.subject?.id ? sanitizeIdPart(input.subject.id) : sanitizeIdPart(input.fallbackId)
  const prefix = input.subject?.type ? SUBJECT_PREFIX[input.subject.type] : 'run'
  return {
    path: join(input.workRoot, `${prefix}-${id}`),
    origin: 'auto',
    explanation:
      '自动分配的工作目录（D27）：每个任务一个独立目录，' +
      '同一个任务的重试会看到上次留下的文件',
  }
}

/**
 * 确保目录存在。
 *
 * 在**受理时**创建而不是等到执行时：使用者提交任务后立刻就能在界面上看到
 * 它要去哪儿，而不是等到跑起来才知道（FR-BRIDGE-06：先落盘再返回受理）。
 */
export async function ensureWorkDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

/**
 * 默认的工作区根目录：**家目录下一个可见的 `agentdeck-workspace/`**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这条规则改过两次，两次都是"位置不对"，但不对的方式不同
 * ══════════════════════════════════════════════════════════════════
 *
 * 最初是数据目录的**同级**（`<dataDir>/../work`）。默认下得到
 * `~/.agentdeck/work`，看着挺好——但那个"挺好"完全依赖数据目录恰好叫
 * `data` 这个巧合。换成别的就出事：
 *
 *   --data-dir /tmp/x        ⇒ /tmp/work          ← 跑到 /tmp 根上
 *   --data-dir .cache/dev/d  ⇒ .cache/dev/work    ← 跑到缓存目录里
 *
 * 于是第二版改成**数据目录之内**（`<dataDir>/work`）。这修掉了"跑到应用
 * 命名空间之外"，但代价是工作目录变成了 `<dataDir>/work`，默认下就是
 * `~/.agentdeck/data/work/`——**藏在一个点开头的目录里，还埋在 data 下面两层**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么"可见"是硬要求，不是审美问题
 * ══════════════════════════════════════════════════════════════════
 *
 * 数据目录装的是**程序内部状态**（SQLite、锁、blob 日志），没人需要进去看，
 * 藏起来是对的。但工作目录装的是 **agent 真正的产出**——它写的文件、
 * 它跑出来的结果。使用者要能直接用 Finder 打开、能在终端里 `cd` 进去、
 * 能把它拖到编辑器里。
 *
 * 一个 `~/.agentdeck/data/work/issue-01M2…/` 满足不了这三件事：
 * 点开头 ⇒ Finder 默认不显示；`data/work` 两层 ⇒ 得先知道有这么个约定。
 * **产出放在一个使用者找不到的地方，等于没有产出。**
 *
 * 所以：数据目录继续隐藏，工作目录**固定在家目录下的可见目录**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不从 `--data-dir` 推导了
 * ══════════════════════════════════════════════════════════════════
 *
 * 第二版之所以能从 dataDir 推导，是因为它要求"所有产物都在数据目录里"。
 * 现在工作目录**按定义就在外面**，推导这个动作本身就没有依据了——硬要推
 * 只会再推出一个"取决于 dataDir 恰好长什么样"的巧合。
 *
 * 于是规则变成：**默认是一个固定路径**，与任何选项都无关；要放别处
 * （单独挂一块盘、放进某个项目里）用 `--work-root` 显式指定。
 *
 * ⚠️ 测试必须显式传 `workRoot`（见 testWorkRoot）——否则跑一次测试就会在
 *    使用者的家目录里造出一堆工作目录。
 */
export function defaultWorkRoot(): string {
  return join(homedir(), 'agentdeck-workspace')
}

/**
 * 数据目录之内的 `work/`——**自洽的兜底**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它和 `defaultWorkRoot()` 是两个层次的东西，不要混
 * ══════════════════════════════════════════════════════════════════
 *
 * `defaultWorkRoot()` 回答"**人**运行 agentdeck 时工作目录在哪"——那是
 * 一条**面向使用者的产品决定**，所以它在 CLI 那一层。
 *
 * 这个函数回答的是"**调用 `startDaemon` 的人没给目录时**用什么"——它必须
 * 是自洽的：只用调用者自己给的 `dataDir`，**绝不碰家目录**。
 *
 * 为什么这个区分很重要：测试用的是一次性的临时数据目录。如果核心的兜底是
 * 家目录下的固定路径，那么任何一处忘了传 `workRoot` 的测试都会在使用者的
 * 家目录里造出目录——**测试污染真实环境**，而且只有哪天有人真的去 `ls`
 * 才会发现。让兜底待在 `dataDir` 之内，这类事故在结构上就不可能发生。
 */
export function fallbackWorkRoot(dataDir: string): string {
  return join(dataDir, 'work')
}

/**
 * 技能内容的默认落点：`~/.agentdeck/skills`（2026-10）。
 *
 * 与 `defaultWorkRoot()` 同一层次、同一个理由：技能正文（`SKILL.md`）与支持文件
 * 是**使用者会去翻、会去改**的东西——藏在数据目录里的 `log/skill.jsonl` 里
 * 等于翻不到。所以默认放在家目录下一个可见、可预期的路径，要换用 `--skills-root`。
 */
export function defaultSkillsRoot(): string {
  return join(homedir(), '.agentdeck', 'skills')
}

/**
 * 使用者提炼技能（D80）的**可见默认根**：`~/.agentdeck/skills-mine`。
 *
 * 与安装根 `~/.agentdeck/skills` **物理分离**（设计定稿——"不应该把安装的 skill
 * 和我自己提炼的 skill 混在一起"），并且这个根是 git 仓库（平台自动 commit，
 * 可回退）。CLI 在 `startDaemon` 时显式传它，核心层的兜底是数据目录内的
 * `skills-mine/`。
 */
export function defaultSkillsMineRoot(): string {
  return join(homedir(), '.agentdeck', 'skills-mine')
}

/**
 * 数据目录之内的 `skills/`——**自洽的兜底**（与 `fallbackWorkRoot` 逐字对应）。
 *
 * 调用 `startDaemon` 的人没给 `skillsRoot` 时用它。它只用调用者给的 `dataDir`，
 * **绝不碰家目录**——否则任何一处忘了传 `skillsRoot` 的测试都会在使用者家目录里
 * 造技能目录。
 */
export function fallbackSkillsRoot(dataDir: string): string {
  return join(dataDir, 'skills')
}

/**
 * 一次性把**旧位置**的工作目录搬到新位置。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要迁移：目录是"算出来"的，不是"记下来"的
 * ══════════════════════════════════════════════════════════════════
 *
 * 自动目录的路径由 `<workRoot>/<subjectType>-<subjectId>` **推导**而来，
 * 而不是存在 run 记录里查出来的（这是 D27 刻意的设计：同一个任务的重试
 * 因此能落回同一个目录，看到上次留下的文件）。
 *
 * 好处是重试天然"接着做"；代价是**根目录一改，所有旧任务的目录就都换了地方**——
 * 重试会得到一个全新的空目录，看起来像"上次的产出丢了"。
 *
 * 所以改名这件事必须连带把旧目录搬过去，否则就是一次静默的数据丢失。
 *
 * ══════════════════════════════════════════════════════════════════
 * 只在**完全安全**的情况下搬
 * ══════════════════════════════════════════════════════════════════
 *
 * 三个条件缺一不可，任何一个不满足就原样不动：
 *
 *   - 新根不存在，或者是个空目录（**绝不覆盖使用者已经放进去的东西**——
 *     那可能正是他手动指定的工作区）；
 *   - 旧根存在且非空（没东西可搬就不搬，也免得白建一个新目录）；
 *   - `rename` 成功（同盘是原子的；跨盘会 EXDEV，此时只警告、不删源）。
 *
 * 用 `rename` 而不是递归复制 + 删除：复制过程中断电会留下一个半成品，
 * 而 `rename` 要么完成要么没发生。
 */
export async function migrateLegacyWorkRoot(input: {
  legacyRoot: string
  workRoot: string
  onInfo?: (message: string) => void
  onWarn?: (message: string) => void
}): Promise<'moved' | 'skipped' | 'failed'> {
  const info = input.onInfo ?? ((): void => {})
  const warn = input.onWarn ?? ((): void => {})
  const { legacyRoot, workRoot } = input

  // 同一个目录（或者新根就在旧根里面）就别动——搬了等于把它挪进自己
  if (legacyRoot === workRoot || workRoot.startsWith(`${legacyRoot}/`)) return 'skipped'

  let legacyEntries: string[]
  try {
    legacyEntries = await readdir(legacyRoot)
  } catch {
    return 'skipped' // 旧根不存在：全新安装，没什么可搬
  }
  if (legacyEntries.length === 0) return 'skipped'

  const targetEntries = await readdir(workRoot).catch(() => null)
  if (targetEntries !== null && targetEntries.length > 0) {
    // 新根已经有东西了：那是使用者的地盘，什么都不碰
    warn(
      `工作目录已经迁到 ${workRoot}，但旧目录 ${legacyRoot} 里还有 ${legacyEntries.length} 项，` +
        `因为新目录非空所以没有搬。旧目录里的内容没有丢，需要的话自行合并。`,
    )
    return 'skipped'
  }

  try {
    await mkdir(workRoot, { recursive: true })
    // 新根刚才可能是"存在但是空的"，rename 到一个已存在的空目录在 POSIX 下
    // 会失败（ENOTEMPTY/EEXIST 视实现），所以先把它去掉
    if (targetEntries !== null) await rmdir(workRoot).catch(() => undefined)
    await rename(legacyRoot, workRoot)
  } catch (err) {
    // ⚠️ 这里只警告、**不删源**：搬不动就维持原样，旧目录仍然可用
    warn(
      `工作目录迁移失败（${legacyRoot} → ${workRoot}）：${(err as Error).message}。` +
        `旧内容原样保留，新任务会使用新位置。`,
    )
    return 'failed'
  }

  info(`工作目录已迁移：${legacyRoot} → ${workRoot}（${legacyEntries.length} 项）`)
  return 'moved'
}
