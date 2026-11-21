import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVE_RUN_STATUSES,
  type ExclusiveSkillOwner,
  assertRunTransition,
  type IssueQuery,
  type Page,
  type PageQuery,
  type RunPatch,
  type RunQuery,
  type Store,
} from '@agentdeck/domain'
import type {
  Agent,
  AgentId,
  Artifact,
  AuditRecord,
  BlobRef,
  ChatTurn,
  Comment,
  Conversation,
  ConversationId,
  Device,
  InboxItem,
  Issue,
  IssueId,
  MemoryEntry,
  Run,
  RunId,
  RunMessage,
  RunStatus,
  Skill,
  SkillId,
  SubjectRef,
  Workspace,
  WorkspaceId,
} from '@agentdeck/protocol'
import { cleanAgent, ulid } from '@agentdeck/protocol'
import { BlobStore } from './blobs.ts'
import {
  atomicWrite,
  ensureDir,
  exists,
  readJsonOrNull,
  removeQuietly,
  sha256Hex,
} from './fs-utils.ts'
import { JsonlLog } from './log.ts'
import { LockHeldError, acquireLock } from './lock.ts'
import { MessageLog, ensureRunDir, messageLogPath } from './messages.ts'
import { Mutex, pruneUndefined } from './mutex.ts'
import { readSkillContent, removeSkillFiles, writeSkillFiles } from './skill-files.ts'
import {
  agentDirExists,
  agentDirPath,
  agentsRoot,
  agentExclusiveSkillsDir,
  migrateExclusiveSkillsDirCase,
  getExclusiveSkillBodyIn,
  listAgentDirs,
  listExclusiveSkillBodiesIn,
  readAgentDir,
  removeAgentDir,
  removeExclusiveSkillBodyIn,
  writeAgentDir,
  writeExclusiveSkillBodyIn,
  writeLegacyAgentDir,
} from './agent-dirs.ts'

/**
 * 文件存储适配器 —— `Store` 端口的 v1 实现。
 *
 * 目录布局：
 *
 *   <dataDir>/
 *   ├── meta.json                     { formatVersion, instanceId }
 *   ├── lock                          单进程锁
 *   ├── device.json                   本机设备标识
 *   ├── workspaces.jsonl              workspace 记录（全局，量小）
 *   ├── agents/<agentId>/              ★ 智能体目录（D111，2026-11）——
 *   │   ├── agent.json               结构化资讯（不含指令正文）
 *   │   ├── instructions.md          指令**组装前**正文（内置 = 身份块；自建 = 全文）
 *   │   └── skills/<slug>/SKILL.md    这个智能体**独有**的技能（文件资产，不进技能库）
 *   └── workspaces/<wsId>/
 *       ├── log/<collection>.jsonl    append-only，权威记录
 *       ├── log/<collection>.jsonl.snapshot   压缩后的物化快照
 *       ├── blobs/<前两位>/<sha256>    内容寻址
 *       └── runs/<runId>/messages.jsonl        执行消息流
 *
 * 智能体**不在** `workspaces/<wsId>/log/agent.jsonl` 里（D111）：一个智能体 =
 * 一个目录，与 `skills/`、`skills-mine/` 并列；老 JSONL 只用于**一次性迁移**，
 * 迁完停用但**保留文件**（等使用者确认后再删）。详见 `docs/design/agent-directory.md`。
 *
 * 另外**技能内容**不在这棵树下（2026-10）：`SKILL.md` 正文与支持文件落在
 * `<skillsRoot>/<slug>/`（`skill-files.ts`），`log/skill.jsonl` 里只留索引与
 * 元数据。`skillsRoot` 由调用方给（CLI 默认 `~/.agentdeck/skills`，想放进
 * 数据目录之内也行），不传时兜底到 `<dataDir>/skills`——**绝不碰家目录**。
 *
 * 关于设计文档的一处偏离：文档里还列了 `runs/<runId>/run.json`。
 * 实现时去掉了它——run 记录已经以追加记录的形式存在于 `log/run.jsonl`，
 * 再存一份就变成**双份真相**，迟早会不一致。`runs/<runId>/` 只放消息流。
 */

export const STORE_FORMAT_VERSION = 1

const COLLECTIONS = [
  'agent',
  // 智能体记忆（分批第 240 批）。与 agent 并排：一条记忆属于某个 agent。
  // ⚠️ 新增集合名只影响**新写**的那份日志，老数据目录里没有 `log/memory.jsonl`
  // 会被当成"这个 workspace 还没有记忆"，所以不需要迁移。
  'memory',
  // 智能体组（D70 增量添加）。与 agent 并排：组是 agent 的**编队**。
  // ⚠️ 新增集合名只影响**新写**的那份日志，老数据目录里没有
  // `log/group.jsonl` 会被当成"这个 workspace 还没有组"，所以不需要迁移。
  /*
   * ⚠️ 2026-11（S3）：这里原来是 `'group'` 集合（智能体组）。组退场 ⇒ 白名单里去掉它，
   *   **磁盘上那一节原样留着**（不会被读、也不会被误删其它东西）。
   */
  'skill',
  // 工具包（D40）。与 skill 并排：两者都是"装进工作区、可挂到 agent 上、
  // 可卸载"的东西，放一起便于对照。⚠️ 新增集合名只影响**新写**的那份日志，
  // 老数据目录里没有 `log/tool.jsonl` 会被当成"这个 workspace 还没有工具包"，
  // 所以不需要迁移。
  'tool',
  'issue',
  'comment',
  // 聊天（闭环的旁路）。两个一起加：`conversation` 是对话本体，`chat-turn` 是
  // 回合——**智能体的回复不在这里**，它就是那条 run 的 messages（存两份必然分叉，
  // 见 `Conversation` 上面那段）。
  'conversation',
  'chat-turn',
  'run',
  /*
   * ⚠️ 2026-11（D125）：这里原来有 `'report'` 集合（第三方报告）。报告摄取退场 ⇒
   *   白名单里去掉它，**磁盘上那一节原样留着**（不会被读、也不会被误删其它东西）。
   */
  /*
   * ⚠️ 2026-11（D125）：这里原来有 `'verdict'` 集合（判决记录）。判决退场 ⇒
   *   白名单里去掉它，**磁盘上那一节原样留着**（不会被读、也不会被误删其它东西）。
   */
  /*
   * ⚠️ 2026-11（D123）：这里原来有一个 `'action'` 集合（判决触发的动作记录）。
   *   动作能力退场、记录与端口一起删——旧数据文件里那一节仍然躺在磁盘上，
   *   **不会**被读（`loadWorkspace` 按这个白名单取集合），也不会被误删其它东西。
   */
  'artifact',
  'audit',
  'inbox',
] as const

type CollectionName = (typeof COLLECTIONS)[number]

interface Meta {
  formatVersion: number
  instanceId: string
}

export interface FileStoreOptions {
  dataDir: string
  /** 关掉 fsync 换取速度——**只应在测试里用**。 */
  fsync?: boolean
  /**
   * 启动一次性迁移的日志出口（D112：记忆目录化丢弃的孤儿数要能看见）。
   * 不传 = 静默（测试与"忘传"的场景都不该炸）。
   */
  onInfo?: (message: string) => void
  /**
   * 技能内容的落点（`<skillsRoot>/<slug>/SKILL.md` + 支持文件）。
   *
   * 缺省 `<dataDir>/skills`——与 `fallbackWorkRoot` 同一思路：调用方不传时
   * **自洽、绝不碰家目录**。CLI 那一层会显式传 `~/.agentdeck/skills`（面向
   * 使用者的产品决定）；核心层的兜底待在自己的数据目录里，是为了让"忘了传"
   * 的测试不会在使用者家目录里造目录。
   */
  skillsRoot?: string
  /**
   * **独有技能的目录解析**（D228）——`owner → 目录`。
   *
   * 缺省只认 `kind: 'agent'`（`agents/<id>/skills/`，形状归 `agent-dirs.ts`）。
   * 另一种来源（编排内建智能体）的目录形状归 daemon 的 `workflows-dirs.ts`，
   * 所以由 daemon 在装配时把整张解析函数注入进来（与 `skillsRoot` 同一个套路）：
   * **谁拥有路径，谁提供解析**——而不是让两个包各拼一遍、迟早分叉。
   *
   * 缺省实现遇到 `kind: 'workflow-agent'` 会**明确报错**：没注入解析却去读，
   * 说明装配漏了一处，静默返回空数组会让"编排自带技能坏了"变成"它本来就没有技能"。
   */
  exclusiveSkillsDir?: (owner: ExclusiveSkillOwner) => string
  /**
   * **使用者提炼**技能（D80）的落点（`source: 'mine'` 的技能正文）。
   *
   * 与 `skillsRoot` **物理分离**：提炼的与安装的不混一个根（设计定稿——
   * "不应该把安装的 skill 和我自己提炼的 skill 混在一起"）。缺省
   * `<dataDir>/skills-mine`。CLI 那一层会显式传 `~/.agentdeck/skills-mine`。
   *
   * ★ 这个根同时是 **git 仓库**（平台自动 commit，可回退）——git 化由
   *   daemon 的 `skill-mine.ts` 负责，store 只负责落盘与读回，不碰 git。
   */
  skillsMineRoot?: string
}

/** 排序 + 游标分页。游标就是上一页最后一条的 id（ULID，可排序）。 */
/**
 * 排序 + 游标分页。游标就是上一页最后一条的 id（ULID，可排序）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里曾经有一个"会静默重放第一页"的 bug
 * ══════════════════════════════════════════════════════════════════
 *
 * 旧实现是 `findIndex(i => i.id === cursor) + 1`。当游标**在数据里找不到**时
 * `findIndex` 返回 `-1`，于是 `start = 0`——**从头再来一遍**。
 *
 * 这个失败很隐蔽：调用方拿到的是合法的一页数据，`nextCursor` 也照常给出，
 * 一切看起来正常。但翻页的客户端会永远在"第一页 → 第二页 → 第一页"之间
 * 打转，而**没有任何错误被报出来**。
 *
 * 游标找不到并不罕见：上一页最后一条恰好在两次翻页之间被删掉就会发生。
 *
 * 修法是**不比"身份"而比"位置"**：游标本来就是 ULID，排序键也正是 id，
 * 所以"id 大于游标的那些"就是"游标之后的那些"——游标那条还在不在都不影响。
 * 三种情况的处置因此都变正确了：
 *   - 游标还在   → 与原语义完全一致；
 *   - 游标被删   → 正确地从它原本的位置之后继续（而不是重放）；
 *   - 游标是垃圾 → 大于全部则返回空并终止，小于全部则返回全部，
 *                  两种情况都**不会**悄悄回头重来。
 */
function paginate<T extends { id: string }>(items: readonly T[], q: PageQuery): Page<T> {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  let start = 0
  if (q.cursor) {
    const cursor = q.cursor
    const idx = sorted.findIndex((i) => i.id > cursor)
    start = idx === -1 ? sorted.length : idx
  }

  const limit = q.limit ?? 50
  const slice = sorted.slice(start, start + limit)
  const last = slice[slice.length - 1]
  return {
    items: slice,
    nextCursor: start + limit < sorted.length && last ? last.id : null,
  }
}

function isActiveRun(run: Run): boolean {
  return (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(run.status)
}

/**
 * 落盘用的**索引记录**：去掉正文与支持文件，只留元数据（id / slug / 来源 /
 * 版本 / 时间）。
 *
 * 类型上仍按 `Skill` 流转（端口形状不变），正文与支持文件由 `FileStore.#hydrate`
 * 从磁盘补回来。写出去的对象少这两个键是安全的：读取路径上本来就没有 zod
 * 校验（整条记录以 JSON 存，见 `Skill.files` 那段注释）。
 */
/** 日志占用的现状（`GET /api/maintenance/storage` 的返回体）。 */
export interface LogStorageReport {
  /** 每个集合两份文件的字节数（`logBytes` = 增量日志，`snapshotBytes` = 已物化的快照）。 */
  collections: Array<{
    workspaceId: string
    name: string
    logBytes: number
    snapshotBytes: number
  }>
  logBytes: number
  snapshotBytes: number
  /** 两者之和——界面上那颗「压缩」按钮说的就是它。 */
  totalBytes: number
}

/** 一次压缩的结果（`POST /api/maintenance/compact` 的返回体，也是启动日志的来源）。 */
export interface CompactionReport {
  workspaceId: string
  /** 集合名（`skill` / `run` …）。 */
  name: string
  /** 压缩前日志字节数。 */
  before: number
  /** 压缩后日志字节数（压缩成功即为 0——增量日志被丢弃了）。 */
  after: number
  /** 现存记录数（快照里的条数）。 */
  records: number
}

/** 字节数给人看（"4.3 MB" / "812 KB"）。日志里报压缩收益用。 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function toIndexRecord(skill: Skill): Skill {
  const record: Record<string, unknown> = { ...skill }
  delete record['body']
  delete record['files']
  return record as unknown as Skill
}

/**
 * 这条 run 是否属于某条 issue（顺着 subject 链往上找，最多 3 层）。
 *
 * 判据与 server 侧 `runBelongsToIssue` 同一条：执行 run 的 subject 是 issue，
 * 审核 run 的 subject 是它审的那条执行 run（`subject.type === 'run'`）。
 * 深度上限 3 与那边一致——超过仍找不到 issue 的链视为"不属于"。
 *
 * 在文件适配器里 `runLog` 是同一个 workspace 的 JsonlLog（内存索引，同步读）。
 */
function runBelongsToIssueInLog(
  runLog: JsonlLog<Run & { id: string }>,
  run: Run,
  issueId: IssueId,
): boolean {
  let cursor: Run | null = run
  for (let depth = 0; depth < 3 && cursor; depth++) {
    const subject: Run['subject'] = cursor.subject
    if (subject.type === 'issue') return subject.id === issueId
    if (subject.type !== 'run') return false
    cursor = runLog.get(subject.id as RunId) ?? null
  }
  return false
}

/** 单个 workspace 的数据。 */
class WorkspaceStore {
  readonly #root: string
  readonly #wsId: WorkspaceId
  readonly #fsync: boolean
  readonly #mutex = new Mutex()

  readonly logs: Record<CollectionName, JsonlLog<{ id: string }>>
  readonly blobs: BlobStore

  readonly #messages = new Map<string, MessageLog>()

  #opened = false

  constructor(root: string, wsId: WorkspaceId, fsync: boolean) {
    this.#root = root
    this.#wsId = wsId
    this.#fsync = fsync
    this.blobs = new BlobStore(join(root, 'blobs'))

    const logs = {} as Record<CollectionName, JsonlLog<{ id: string }>>
    for (const name of COLLECTIONS) {
      logs[name] = new JsonlLog<{ id: string }>(join(root, 'log', `${name}.jsonl`), { fsync })
    }
    this.logs = logs
  }

  get mutex(): Mutex {
    return this.#mutex
  }

  /** 工作区根目录（`<dataDir>/workspaces/<wsId>`）。D111 删老 jsonl 要用。 */
  get root(): string {
    return this.#root
  }

  /** 这个工作区自己的 id（压缩报告里要点名是哪个工作区）。 */
  get workspaceId(): WorkspaceId {
    return this.#wsId
  }

  /** 强类型取日志——避免到处写 `as unknown as`。 */
  log<K extends CollectionName>(name: K): JsonlLog<{ id: string }> {
    return this.logs[name]
  }

  run(): JsonlLog<Run & { id: string }> {
    return this.log('run') as unknown as JsonlLog<Run & { id: string }>
  }
  agent(): JsonlLog<Agent & { id: string }> {
    return this.log('agent') as unknown as JsonlLog<Agent & { id: string }>
  }
  memory(): JsonlLog<MemoryEntry & { id: string }> {
    return this.log('memory') as unknown as JsonlLog<MemoryEntry & { id: string }>
  }
  skill(): JsonlLog<Skill & { id: string }> {
    return this.log('skill') as unknown as JsonlLog<Skill & { id: string }>
  }
  issue(): JsonlLog<Issue & { id: string }> {
    return this.log('issue') as unknown as JsonlLog<Issue & { id: string }>
  }
  comment(): JsonlLog<Comment & { id: string }> {
    return this.log('comment') as unknown as JsonlLog<Comment & { id: string }>
  }
  conversation(): JsonlLog<Conversation & { id: string }> {
    return this.log('conversation') as unknown as JsonlLog<Conversation & { id: string }>
  }
  chatTurn(): JsonlLog<ChatTurn & { id: string }> {
    return this.log('chat-turn') as unknown as JsonlLog<ChatTurn & { id: string }>
  }
  artifact(): JsonlLog<Artifact & { id: string }> {
    return this.log('artifact') as unknown as JsonlLog<Artifact & { id: string }>
  }
  audit(): JsonlLog<AuditRecord & { id: string }> {
    return this.log('audit') as unknown as JsonlLog<AuditRecord & { id: string }>
  }
  inbox(): JsonlLog<InboxItem> {
    return this.log('inbox') as unknown as JsonlLog<InboxItem>
  }

  async open(): Promise<void> {
    if (this.#opened) return
    await ensureDir(this.#root)
    for (const name of COLLECTIONS) {
      await this.logs[name]!.open()
    }
    // 唯一性索引原来靠这里从日志重建（`report` 的去重键）。
    // ⚠️ 2026-11（D125）：报告摄取退场之后没有这个索引了，这段重建一并删掉。
    this.#opened = true
  }

  async messageLogFor(runId: RunId): Promise<MessageLog> {
    const key = runId as string
    let log = this.#messages.get(key)
    if (!log) {
      const dir = join(this.#root, 'runs')
      await ensureRunDir(dir, runId)
      log = new MessageLog(messageLogPath(dir, runId), { fsync: this.#fsync })
      await log.open()
      this.#messages.set(key, log)
    }
    return log
  }

  /**
   * 关掉某个 run 的消息流句柄并从缓存里摘掉（deleteRun 用：删文件前必须关句柄，
   * 否则在部分平台上删不掉，且缓存里会留一个指向已删文件的句柄）。
   * 没开过 ⇒ no-op。
   */
  async closeMessageLog(runId: RunId): Promise<void> {
    const key = runId as string
    const log = this.#messages.get(key)
    if (!log) return
    await log.close()
    this.#messages.delete(key)
  }

  /** 消息流文件在磁盘上的路径（仅 deleteRun 删除文件时用）。 */
  messageLogPathOf(runId: RunId): string {
    return messageLogPath(join(this.#root, 'runs'), runId)
  }

  /*
   * ⚠️ 2026-11（D125）：这里原来是 report 的去重索引（`findReportIdByDedup` /
   *   `rememberDedup` 与那个内存 Map）。报告摄取退场 ⇒ 没有"同一条报告不重复处理"
   *   这件事，索引与两个方法一起删。
   */

  /*
   * ⚠️ 2026-11（D123）：这里原来是**动作幂等**的两个方法
   *   （`findActionIdByIdempotency` / `rememberIdempotency`）与它背后的内存索引。
   *   幂等键是"同一个判决重放时不重复触发动作"的保证——动作退场后没有要幂等的
   *   东西，整段删。
   */


  async close(): Promise<void> {
    for (const log of this.#messages.values()) await log.close()
    this.#messages.clear()
    for (const name of COLLECTIONS) await this.logs[name]!.close()
  }

  /** 压缩所有集合的日志。 */
  async compact(): Promise<void> {
    for (const name of COLLECTIONS) await this.logs[name]!.compact()
  }
}

export class FileStore implements Store {
  readonly #dataDir: string
  readonly #fsync: boolean
  readonly #meta: Meta
  readonly #skillsRoot: string
  /** 使用者提炼技能（D80）的落点——与 `#skillsRoot` 物理分离，见 `FileStoreOptions`。 */
  readonly #mineRoot: string
  /** 独有技能目录解析（D228）：`owner → 目录`。见 `FileStoreOptions.exclusiveSkillsDir`。 */
  readonly #exclusiveDirOf: (owner: ExclusiveSkillOwner) => string
  /**
   * ★ 2026-11（D226）：workspace 记录**不是日志**，是一个普通 JSON 数组文件
   *   （`<dataDir>/workspaces.json`）——见 `#loadWorkspaces` 上面那段。
   *   单独存放是为了 `getWorkspace` 不必先打开它的目录。
   */
  readonly #workspaces = new Map<string, Workspace>()
  readonly #device = new Mutex()
  readonly #mutex = new Mutex()
  /** 智能体目录的写锁——目录是平的（`<dataDir>/agents/`），不属于某个 workspace。 */
  readonly #agentsMutex = new Mutex()
  readonly #stores = new Map<string, WorkspaceStore>()
  /** 每个智能体一份 `agents/<id>/memory.jsonl` 的懒缓存（D112：记忆 = 智能体自己的）。 */
  readonly #memoryLogs = new Map<string, JsonlLog<MemoryEntry & { id: string }>>()
  /** 启动一次性迁移的日志出口（D112）。 */
  readonly #onInfo: (message: string) => void
  #releaseLock: (() => Promise<void>) | null = null

  private constructor(
    dataDir: string,
    meta: Meta,
    fsync: boolean,
    skillsRoot: string,
    mineRoot: string,
    onInfo: (message: string) => void = () => {},
    exclusiveSkillsDir?: (owner: ExclusiveSkillOwner) => string,
  ) {
    this.#dataDir = dataDir
    this.#fsync = fsync
    this.#meta = meta
    this.#skillsRoot = skillsRoot
    this.#mineRoot = mineRoot
    this.#onInfo = onInfo
    this.#exclusiveDirOf =
      exclusiveSkillsDir ??
      ((owner) => {
        if (owner.kind === 'agent') return agentExclusiveSkillsDir(dataDir, owner.agentId)
        throw new Error(
          '独有技能目录没配解析函数（`exclusiveSkillsDir`）——' +
            `装配处漏了 ${owner.kind} 那一种来源。别静默当"没有技能"`,
        )
      })
  }

  /* ══════════════════════════════════════════════════════════════════
   * workspace 记录：一个普通 JSON，不是日志（D226，2026-11）
   * ══════════════════════════════════════════════════════════════════
   *
   * 之前它是 `workspaces.jsonl`——与 issue / run 那些**业务集合**共用同一套
   * append-only 日志。量出来的代价：真机上**一个**工作区、**87 行**、65 KB，
   * 因为每次保存设置都是 `put`（整条记录再追加一份），而 `compact()` 从来没有
   * 生产调用点 ⇒ 只增不减。
   *
   * 而日志那三个好处对 workspace **一条都落不到实处**：
   *   · 历史：没有任何代码读它的历史，界面上也没有"工作区版本/回滚"；
   *   · 回放导入：回放是给业务实体用的（换存储实现时装载一次）；
   *   · 崩溃安全：整文件原子写（tmp → fsync → rename）给的是**同一个**保证。
   *
   * 所以它退回成一个普通数组文件 `<dataDir>/workspaces.json`（今天是 1 条）。
   *
   * ⚠️ **这份文件是"数据目录的总钥匙"**：`#stores`（每个 workspace 的日志、
   *    runs、blobs）全是按它登记的 id 打开的。它丢了 = daemon 会新建一个
   *    「默认工作区」（新 id）= 界面看起来数据全没了，而文件其实还在
   *    `workspaces/<老 id>/` 里。所以 `#loadWorkspaces` 里有一个**按目录自愈**
   *    的兜底：索引为空、或索引里缺了盘上有的目录 ⇒ 用目录重建登记。
   */

  /** workspace 索引文件的落点。 */
  #workspacesPath(): string {
    return join(this.#dataDir, 'workspaces.json')
  }

  /** 老文件（append-only 日志）的落点——只用于一次性迁移。 */
  #legacyWorkspacesPath(): string {
    return join(this.#dataDir, 'workspaces.jsonl')
  }

  /** 整文件原子写（一个数组）。顺序固定为 `createdAt` 升序，diff 才稳定。 */
  async #saveWorkspaces(): Promise<void> {
    const list = [...this.#workspaces.values()].sort(
      (a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)),
    )
    await atomicWrite(this.#workspacesPath(), `${JSON.stringify(list, null, 2)}\n`)
  }

  /** 盘上有哪些 workspace 目录（自愈与"孤儿"检查都靠它）。 */
  async #workspaceDirsOnDisk(): Promise<string[]> {
    const root = join(this.#dataDir, 'workspaces')
    try {
      const names = await readdir(root)
      return names.filter((n) => !n.startsWith('.'))
    } catch {
      return []
    }
  }

  /**
   * 从**智能体目录**反推工作区 id。
   *
   * ⚠️ 为什么另一个来源也要有：智能体是**平铺**在 `<dataDir>/agents/<id>/` 的
   *   （不属于哪个 `workspaces/<id>/` 目录），所以"只有智能体、还没有任务/run"的
   *   数据目录光扫 `workspaces/` 会一无所获。少了这一来源，登记表一丢，
   *   那些智能体就跟着"看不见"了（它们带着新 id 的 workspaceId，界面按 id 过滤）。
   */
  async #workspaceIdsFromAgentDirs(): Promise<string[]> {
    const root = join(this.#dataDir, 'agents')
    let ids: string[]
    try {
      ids = await readdir(root)
    } catch {
      return []
    }
    const out = new Set<string>()
    for (const id of ids) {
      if (id.startsWith('.')) continue
      const rec = await readJsonOrNull<{ workspaceId?: unknown }>(
        join(root, id, 'agent.json'),
      )
      if (rec && typeof rec.workspaceId === 'string' && rec.workspaceId !== '') {
        out.add(rec.workspaceId)
      }
    }
    return [...out]
  }

  /**
   * 启动时装载 workspace 登记表。三步，后一步只在前一步什么都没拿到时才跑：
   *
   *   ① 读 `workspaces.json`（正常路径）；
   *   ② 老 `workspaces.jsonl` 还在 ⇒ 回放成最后状态、写进新文件、把老文件改名
   *      `.migrated` **留档不删**（回滚 = 发旧版代码 + 改回原名）；
   *   ③ 还是一条都没有、但 `workspaces/` 下**有目录** ⇒ 按目录重建登记
   *      （名称无从得知，用默认名 + 一条 `info` 说清楚）。这一步是那条
   *      "索引丢了别让数据看起来消失"的兜底。
   *
   * 另外：登记表里**缺了**盘上有的目录（索引只坏了一半）也补进去——数据在那儿，
   * 不登记就等于看不见它。
   */
  async #loadWorkspaces(): Promise<void> {
    this.#workspaces.clear()
    try {
      const raw = await readFile(this.#workspacesPath(), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        for (const ws of parsed) {
          const rec = ws as Workspace
          if (rec && typeof rec.id === 'string') this.#workspaces.set(rec.id, rec)
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#onInfo(`workspace 登记表读不出来（将尝试用老日志/目录重建）：${String(err)}`)
      }
    }

    if (this.#workspaces.size === 0) await this.#migrateLegacyWorkspaces()

    // ── 自愈：盘上有的工作区，登记表里必须也有 ──
    //   两个来源合起来看：`workspaces/<id>/` 目录 + `agents/<id>/agent.json` 里带的 workspaceId
    const onDisk = new Set([
      ...(await this.#workspaceDirsOnDisk()),
      ...(await this.#workspaceIdsFromAgentDirs()),
    ])
    const missing = [...onDisk].filter((id) => !this.#workspaces.has(id))
    if (missing.length > 0) {
      const rebuilt: string[] = []
      for (const id of missing) {
        let at = Date.now()
        try {
          const info = await stat(join(this.#dataDir, 'workspaces', id))
          at = Math.round(info.mtimeMs) || at
        } catch {
          // 目录刚被并发删掉 ⇒ 用当前时间，不影响后面重建
        }
        this.#workspaces.set(id, {
          id: id as Workspace['id'],
          // ⚠️ 名字在目录里没有（它原本只存在登记表里）⇒ 用默认名，并在日志里说清
          name: '默认工作区',
          createdAt: at,
          updatedAt: at,
        } as Workspace)
        rebuilt.push(id)
      }
      await this.#saveWorkspaces()
      this.#onInfo(
        `workspace 登记表缺了盘上已有的 ${rebuilt.length} 个工作区，已按数据重建：` +
          `${rebuilt.join('、')}（名称回到默认——原登记表里没有留档）`,
      )
    }
  }

  /**
   * 老 `workspaces.jsonl`（append-only 日志）回放成一份普通 JSON。
   *
   * 回放规则与 `JsonlLog` 一致：`put` 整条覆盖、`patch` 合并（**绝对赋值**）、
   * `del` 删除。迁完老文件改名 `.migrated`（已存在就带时间戳）**留档不删**。
   */
  async #migrateLegacyWorkspaces(): Promise<void> {
    const legacy = this.#legacyWorkspacesPath()
    let raw: string
    try {
      raw = await readFile(legacy, 'utf8')
    } catch {
      return // 没有老文件：全新数据目录，什么都不用做
    }
    const index = new Map<string, Record<string, unknown>>()
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (text === '') continue
      let entry: { op?: unknown; id?: unknown; value?: unknown; patch?: unknown }
      try {
        entry = JSON.parse(text) as typeof entry
      } catch {
        continue // 坏行跳过：回放是"尽量取回"，不是校验
      }
      const id = typeof entry.id === 'string' ? entry.id : null
      if (id === null) continue
      if (entry.op === 'put' && entry.value && typeof entry.value === 'object') {
        index.set(id, entry.value as Record<string, unknown>)
      } else if (entry.op === 'patch' && entry.patch && typeof entry.patch === 'object') {
        const current = index.get(id)
        if (current) index.set(id, { ...current, ...(entry.patch as Record<string, unknown>) })
      } else if (entry.op === 'del') {
        index.delete(id)
      }
    }
    if (index.size === 0) return
    for (const [id, rec] of index) {
      this.#workspaces.set(id, { ...(rec as unknown as Workspace), id: id as Workspace['id'] })
    }
    /*
     * 落盘 + **回读核对**，都对上才删老文件（D227：使用者要求清掉 `.migrated` 留档）。
     * 核对什么：新文件读得回来、且条数不少于刚回放出来的条数——这一步不是仪式，
     * 它是"删老文件"唯一的安全垫。
     */
    await this.#saveWorkspaces()
    const verify = await readJsonOrNull<unknown[]>(this.#workspacesPath())
    const ok = Array.isArray(verify) && verify.length >= index.size
    if (ok) await removeQuietly(legacy)
    this.#onInfo(
      `workspace 登记表已从 workspaces.jsonl 迁成 workspaces.json：` +
        `${index.size} 个工作区；` +
        (ok ? '老文件已删除' : '⚠️ 回读核对没通过，老文件**原样留着**'),
    )
  }

  static async open(options: FileStoreOptions): Promise<FileStore> {
    const { dataDir } = options
    const fsync = options.fsync ?? true
    const skillsRoot = options.skillsRoot ?? join(dataDir, 'skills')
    const mineRoot = options.skillsMineRoot ?? join(dataDir, 'skills-mine')
    await ensureDir(dataDir)

    const existing = await readJsonOrNull<Meta>(join(dataDir, 'meta.json'))
    let meta: Meta
    if (existing) {
      if (existing.formatVersion > STORE_FORMAT_VERSION) {
        throw new Error(
          `数据目录的存储格式版本为 ${existing.formatVersion}，高于本程序支持的 ${STORE_FORMAT_VERSION}。` +
            `请升级程序，不要用旧版本打开新数据。`,
        )
      }
      meta = existing
    } else {
      meta = { formatVersion: STORE_FORMAT_VERSION, instanceId: ulid() }
      await atomicWrite(join(dataDir, 'meta.json'), JSON.stringify(meta, null, 2))
    }

    const store = new FileStore(
      dataDir,
      meta,
      fsync,
      skillsRoot,
      mineRoot,
      options.onInfo ?? (() => {}),
      options.exclusiveSkillsDir,
    )
    // 锁必须在读日志之前拿到，否则第二个进程会先读到一半状态
    store.#releaseLock = await acquireLock(dataDir)
    await store.#loadWorkspaces()

    // 预加载所有已知 workspace。
    //
    // 不能留成懒加载：`getAgent` / `getRun` / `findReportByDedupKey` 这些
    // 方法是**跨 workspace 查找**的，它们遍历 `#stores`。如果 store 是懒建的，
    // 重开进程后 `#stores` 为空，查找会全部返回 null —— 表现为"数据丢了"，
    // 而数据其实好好躺在日志里。
    for (const ws of store.#workspaces.values()) {
      await store.#ws(ws.id as WorkspaceId)
    }

    // 智能体从"JSONL 记录"迁到"一个智能体一个目录"（D111，2026-11）。
    // 必须在预加载之后——迁移要遍历 `#stores` 里的老记录。幂等：目录在就跳过，
    // 全部迁完写 `.migrated` 标记，之后老 `agent.jsonl` 已删（使用者确认）。
    await store.#migrateAgentsToDirs()

    // 记忆从 workspace 级 `log/memory.jsonl` 迁到智能体目录（D112，2026-11）。
    // 必须在 agents 迁移**之后**——要把老记录分进 `agents/<id>/`，目录得先存在。
    await store.#migrateMemoryToAgentDirs()

    // 技能内容从"记录里"搬到"磁盘上"的一次性迁移（2026-10）。必须在预加载
    // 之后——它要遍历 `#stores` 里的记录。
    await store.#migrateSkillsToDisk()

    // ── D229：独有技能目录 `SKILL/` → `skills/`（大小写 + 幂等，见 agent-dirs.ts）──
    {
      const { renamed, conflicts, failed } = await store.#agentsMutex.run(() =>
        migrateExclusiveSkillsDirCase(dataDir),
      )
      if (renamed.length > 0) {
        store.#onInfo(
          `独有技能目录已改为小写：${renamed.length} 个智能体的 SKILL/ → skills/`,
        )
      }
      for (const f of failed) {
        store.#onInfo(
          `⚠️ 智能体 ${f.id} 的 SKILL/ 改名失败（目录被占用？数据没动，下次启动会再试）：${f.error}`,
        )
      }
      for (const id of conflicts) {
        store.#onInfo(
          `⚠️ 智能体 ${id} 同时有 SKILL/ 与 skills/ 两个目录——不合并（猜哪份对是另一种坏），请人工确认后删掉多余的`,
        )
      }
    }

    // ── D227：日志的回收（`compact()` 以前**没有任何调用点**，所以只增不减）──
    await store.#compactIfNeeded()
    // ── 迁移留档的清理（使用者："migrated 文件也清掉"）──
    await store.#dropStaleMigratedFiles()
    return store
  }

  /**
   * **该压就压**（D227，2026-11）。
   *
   * 两个判据**任一**成立就压（2026-11 实测：只用条数会漏掉"条数不多但很肥"的那种）：
   *
   *   ① **历史很长**：`pendingOps`（日志里还没物化的条数）> `max(200, 3 × 现存记录数)`
   *      ——run 这种"状态来回改"的典型（2811 条历史 / 397 条现存）；
   *   ② **日志很肥**：日志字节数 > `max(512 KB, 4 × 现存记录的字节数)`
   *      ——`skill.jsonl` 这种"记录数很少、老记录却带着正文副本"的典型
   *      （真机：4.4 MB 日志 / 13 条现存索引 ⇒ ① 算出来才 88 条，压不动，② 一眼看穿）。
   *
   * 为什么这么定：
   *   · 两个都是**比例**判据，几个集合的体量差三个数量级也能用同一个规则；
   *   · 留 3/4 倍余量：正常写入不该天天触发压缩；
   *   · 压缩**幂等且可重复**：`compact()` 先把快照 fsync 落地再删日志，
   *     中途崩溃最坏是"这次没压成"，下次启动再来。
   *
   * 压完把省下的字节数打出来——"省了多少"必须看得见，否则这条机制没人知道它生效过。
   */
  async #compactIfNeeded(): Promise<CompactionReport[]> {
    const reports: CompactionReport[] = []
    for (const ws of this.#stores.values()) {
      for (const name of COLLECTIONS) {
        const log = ws.logs[name]
        const path = join(ws.root, 'log', `${name}.jsonl`)
        const before = await stat(path).then((s) => s.size).catch(() => 0)
        if (before === 0) continue
        const liveBytes = Buffer.byteLength(JSON.stringify(log.all()))
        const tooLong = log.pendingOps > Math.max(200, 3 * log.size)
        const tooFat = before > Math.max(512 * 1024, 4 * liveBytes)
        if (!tooLong && !tooFat) continue
        await log.compact()
        const after = await stat(path).then((s) => s.size).catch(() => 0)
        const report: CompactionReport = {
          workspaceId: String(ws.workspaceId),
          name,
          before,
          after,
          records: log.size,
        }
        reports.push(report)
        this.#onInfo(
          `日志已压缩：log/${name}.jsonl 从 ${fmtBytes(before)} 降到 ${fmtBytes(after)}` +
            `（现存 ${log.size} 条记录）`,
        )
      }
    }
    return reports
  }

  /**
   * **手动压一次**（`POST /api/maintenance/compact`，D227）。
   *
   * 为什么要有这个入口：压缩本来只在**开库时**自动跑一次，而"想立刻把 4 MB 的
   * 日志压掉"不该逼人重启 daemon（重启会打断正在跑的 agent）。这个方法是**在活着的
   * `JsonlLog` 上**压——`compact()` 自己会关掉追加句柄、写快照、删日志，之后再有
   * 写入会自动重建文件，所以运行中的 daemon 调它是安全的（与"外部脚本改文件"根本
   * 不是一回事：那会让追加句柄指向一个已被删除的 inode）。
   *
   * 判据与开库时**同一套**（`#compactIfNeeded`），所以"手动按一下"不会压缩那些
   * 本来就不该压的集合；返回值把压了哪几个、省了多少都报出来。
   */
  async compactNow(): Promise<CompactionReport[]> {
    return this.#mutex.run(() => this.#compactIfNeeded())
  }

  /**
   * **日志占了多少**（`GET /api/maintenance/storage`，D227）。
   *
   * 为什么要有它：界面上那颗「压缩」按钮得先说清"现在占多大、压了能省多少"，
   * 否则它只是一颗不知道有没有用的按钮。口径是**每个集合的日志文件 + 快照文件**
   * （`log/<集合>.jsonl` 与 `log/<集合>.jsonl.snapshot`）的字节数——
   * 也就是压缩能影响到的全部，不含 blob / 消息流 / 技能正文（那些不归 compact 管）。
   */
  async logStorage(): Promise<LogStorageReport> {
    const collections: LogStorageReport['collections'] = []
    for (const ws of this.#stores.values()) {
      for (const name of COLLECTIONS) {
        const base = join(ws.root, 'log', `${name}.jsonl`)
        const logBytes = await stat(base).then((s) => s.size).catch(() => 0)
        const snapshotBytes = await stat(`${base}.snapshot`).then((s) => s.size).catch(() => 0)
        if (logBytes === 0 && snapshotBytes === 0) continue
        collections.push({ workspaceId: String(ws.workspaceId), name, logBytes, snapshotBytes })
      }
    }
    const logBytes = collections.reduce((n, c) => n + c.logBytes, 0)
    const snapshotBytes = collections.reduce((n, c) => n + c.snapshotBytes, 0)
    return { collections, logBytes, snapshotBytes, totalBytes: logBytes + snapshotBytes }
  }

  /**
   * 删掉数据目录根下**迁移时代留下的 `<名字>.migrated` 档案**（D227）。
   *
   * 为什么可以删：迁移完成后数据已经在新地方（目录化 / 普通 JSON），老文件只剩
   * "回滚到旧版代码"这一个用途；而这些迁移都跑了不止一遍、开发期也验过，
   * 留着就是数据目录里的垃圾（使用者："migrated 文件也清掉"）。
   *
   * ⚠️ 只扫**数据目录根**、只认 `<xxx>.migrated` 与 `<xxx>.migrated-<时间戳>` 两种名字：
   *   `agents/.migrated` 是**标记**（防重复迁移），不在这里，也不许删。
   */
  async #dropStaleMigratedFiles(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.#dataDir)
    } catch {
      return
    }
    const stale = names.filter((n) => /\.migrated(-\d+)?$/.test(n))
    if (stale.length === 0) return
    for (const name of stale) await removeQuietly(join(this.#dataDir, name))
    this.#onInfo(`已清理迁移留档：${stale.join('、')}`)
  }

  /**
   * 把**老记录**里的智能体迁到 `<dataDir>/agents/<id>/`（D111）。
   *
   * 为什么在 `open()` 里做、而不是懒迁移：迁移是**一次性的**，且幂等——
   * 目录在就跳过，全部迁完写 `.migrated` 标记（没有标记才会重跑，防止
   * "删了目录、老 JSONL 里那行还在"把已删的智能体**复活**回来）。
   *
   * ★ 老 JSONL 在迁移完成后**删掉**（2026-11 使用者确认："初步测试OK，可以删老
   *   agent.jsonl了"）——迁移完成后读路径全部走目录，jsonl 已无读者。
   *   `.migrated` 标记**留着**：万一有备份/拷贝把 jsonl 放回数据目录，标记挡着
   *   不再重迁——"删掉的智能体被老记录复活"的判据仍然成立。
   */
  async #migrateAgentsToDirs(): Promise<void> {
    const marker = join(agentsRoot(this.#dataDir), '.migrated')
    if (!(await exists(marker))) {
      await this.#agentsMutex.run(async () => {
        for (const ws of this.#stores.values()) {
          for (const rec of ws.agent().all()) {
            if (await agentDirExists(this.#dataDir, rec.id)) continue
            await writeLegacyAgentDir(this.#dataDir, rec)
          }
        }
      })
      await atomicWrite(marker, JSON.stringify({ v: 1, at: Date.now() }, null, 2))
    }
    // 删老 jsonl 放在标记之后（而不是迁移循环里）：万一迁移中途失败，jsonl 还在
    // （数据不丢）；删是幂等的（文件不在就跳过），所以"早就迁过的库"也会删干净。
    await this.#removeLegacyAgentLogs()
  }

  /** 删掉每个 workspace 的 `log/agent.jsonl`（D111：迁移完成后老记录不再有读者）。 */
  async #removeLegacyAgentLogs(): Promise<void> {
    for (const ws of this.#stores.values()) {
      await removeQuietly(join(ws.root, 'log', 'agent.jsonl'))
    }
  }

  /**
   * 把老 workspace 级记忆（`log/memory.jsonl`）迁进智能体目录
   * （`agents/<id>/memory.jsonl`）（D112，2026-11）。
   *
   * 为什么迁：使用者纠正过——"记忆应该是智能体自己的，不是智能体之间也共享"。
   * 老存储按 workspace 存（记录里有 `agentId` 字段），于是**删智能体不删记忆**
   * （deleteAgent 只删目录，记忆留在 workspace 日志里变成孤儿）。迁进目录之后，
   * "记忆跟着智能体走"才成立：删智能体连目录一起删、记忆一起没。
   *
   * ══════════════════════════════════════════════════════════════════
   * 幂等与边界
   * ══════════════════════════════════════════════════════════════════
   * · 判据：**只要还有一个 workspace 的老文件在**就执行（新数据目录根本没有
   *   老文件 ⇒ 跳过）。不写标记——老文件本身被删掉，就是"迁过了"的证据。
   * · 孤儿（`agentId` 没有对应目录 = 智能体已删）：**丢弃**，它的记忆本来
   *   也没有归属；记进返回值的 `dropped`，启动日志能看到。
   * · 迁移完成后**删掉老文件**（与 `agent.jsonl` 同一个决定：已无读者）。
   */
  async #migrateMemoryToAgentDirs(): Promise<{ dropped: number }> {
    let hasLegacy = false
    for (const ws of this.#stores.values()) {
      if (await exists(join(ws.root, 'log', 'memory.jsonl'))) {
        hasLegacy = true
        break
      }
    }
    if (!hasLegacy) return { dropped: 0 }

    let dropped = 0
    await this.#agentsMutex.run(async () => {
      for (const ws of this.#stores.values()) {
        const legacyPath = join(ws.root, 'log', 'memory.jsonl')
        if (!(await exists(legacyPath))) continue
        const legacy = new JsonlLog<MemoryEntry & { id: string }>(legacyPath, { fsync: false })
        await legacy.open()
        for (const entry of legacy.all() as unknown as MemoryEntry[]) {
          if (!(await agentDirExists(this.#dataDir, entry.agentId))) {
            dropped += 1
            continue
          }
          const log = await this.#memoryLog(entry.agentId)
          await log.put(entry)
        }
      }
    })
    for (const ws of this.#stores.values()) {
      await removeQuietly(join(ws.root, 'log', 'memory.jsonl'))
    }
    if (dropped > 0) {
      this.#onInfo(
        `记忆目录化迁移完成：${dropped} 条孤儿记忆被丢弃（它们的智能体已经删了——` +
          `记忆跟着智能体走，没有归属就不留）。老 log/memory.jsonl 已删。`,
      )
    }
    return { dropped }
  }

  /**
   * 把**老记录**里的技能内容落到磁盘（`<skillsRoot>/<slug>/`），并把记录重写成
   * 只留索引。
   *
   * 为什么在 `open()` 里做、而不是懒迁移：迁移是**一次性的**，且幂等——
   * 重写后记录里没有正文，下次 `open()` 直接跳过。放在启动时做，读路径
   * （`listSkills` 等）就保持**无副作用**，不用一边读一边往磁盘写东西。
   *
   * ★ 2026-10：**不再有例外**。早前 `localdir:` 那类（从 `~/.claude/skills`
   *   读进来的技能）跳过迁移，理由是内容另有出处、且对账要拿记录里的正文比对。
   *   本地技能目录改成"显式安装"之后这条理由没了——所有带正文的老记录一律落盘。
   */
  async #migrateSkillsToDisk(): Promise<void> {
    for (const ws of this.#stores.values()) {
      for (const rec of ws.skill().all()) {
        if (typeof rec.body !== 'string' || rec.body === '') continue // 已经是索引记录
        await writeSkillFiles(this.#skillsRoot, rec)
        await ws.mutex.run(() => ws.skill().put(toIndexRecord(rec)))
      }
    }
  }

  /**
   * 把一条记录回读成完整的 `Skill`（把正文与支持文件补齐）。
   *
   * 规则**纯机械**，不看来源：
   *   · 记录里**有正文** ⇒ 用它（只可能是还没迁移的老记录）；
   *   · 没有 ⇒ 从 `<skillsRoot>/<slug>/` 读回（**磁盘为准**）。
   *
   * 盘上找不到（使用者手删了目录）⇒ 正文空。由注入侧的空正文守卫
   * （`agent-core` 的 `writeSkill`）把它变成一次**响亮的失败**，而不是
   * 静默写一个空 `SKILL.md` 出去。
   */
  async #hydrate(rec: Skill & { id: string }): Promise<Skill> {
    if (typeof rec.body === 'string' && rec.body !== '') return rec
    const content = await readSkillContent(this.#rootFor(rec.source), rec.slug)
    if (content === null) return { ...rec, body: '' }
    return {
      ...rec,
      body: content.body,
      ...(Object.keys(content.files).length > 0 ? { files: content.files } : {}),
    }
  }

  /**
   * 技能落点按来源分流（D80）：`mine` → 提炼根（skills-mine，git 化），
   * 其余（`local`/`remote`）→ 安装根。
   */
  #rootFor(source: string): string {
    return source === 'mine' ? this.#mineRoot : this.#skillsRoot
  }

  async formatVersion(): Promise<number> {
    return this.#meta.formatVersion
  }

  async #ws(workspaceId: WorkspaceId): Promise<WorkspaceStore> {
    const key = workspaceId as string
    let ws = this.#stores.get(key)
    if (!ws) {
      ws = new WorkspaceStore(join(this.#dataDir, 'workspaces', key), workspaceId, this.#fsync)
      await ws.open()
      this.#stores.set(key, ws)
    }
    return ws
  }

  // ── Workspace 与 Device ──

  async getWorkspace(id: WorkspaceId): Promise<Workspace | null> {
    return this.#workspaces.get(String(id)) ?? null
  }

  async insertWorkspace(ws: Workspace): Promise<void> {
    await this.#mutex.run(async () => {
      this.#workspaces.set(String(ws.id), ws)
      await this.#saveWorkspaces()
    })
  }

  async getDevice(): Promise<Device | null> {
    return readJsonOrNull<Device>(join(this.#dataDir, 'device.json'))
  }

  async upsertDevice(device: Device): Promise<void> {
    await this.#device.run(() =>
      atomicWrite(join(this.#dataDir, 'device.json'), JSON.stringify(device, null, 2)),
    )
  }

  // ── Agent（D111：一个智能体 = `<dataDir>/agents/<id>/` 一个目录，不是 JSONL）──

  // ⚠️ 两个读方法都要过 `cleanAgent`（**这里是 agent 读取的唯一总闸**）：
  //    agent 整条以 JSON 存，2026-10 撤掉的字段（`reviewerAgentId` / 行动权限那三个）
  //    还留在老记录里，而删 schema 字段**不会**让它们消失——只会让读的人看不见。
  //    摘在这里，"界面拿到的"与"内部链路拿到的"才是同一份干净记录。
  //    （磁盘上那一次的彻底清理见 `apps/daemon/src/agent-legacy-cleanup.ts`。）
  //
  //   `instructions` 恒为 **instructions.md 的内容（组装前正文）**——平台守则的
  //   组装在 daemon 读取端（`effectiveInstructions`），存储层不拼。
  async getAgent(id: AgentId): Promise<Agent | null> {
    const found = await readAgentDir(this.#dataDir, id)
    if (!found) return null
    return cleanAgent(found)
  }

  async listAgents(workspaceId: WorkspaceId): Promise<Agent[]> {
    const all = await listAgentDirs(this.#dataDir)
    return all.filter((a) => a.workspaceId === workspaceId).map(cleanAgent)
  }

  // 未经清理的那一份（磁盘上是什么样就是什么样）：只给启动时的老记录清理用——
  // 它要删的正是读时兜底藏起来的那几个键，用 `listAgents` 就永远判不出"需要清"。
  async listAgentsRaw(workspaceId: WorkspaceId): Promise<Agent[]> {
    const all = await listAgentDirs(this.#dataDir)
    return all.filter((a) => a.workspaceId === workspaceId)
  }

  async insertAgent(agent: Agent): Promise<void> {
    await this.#agentsMutex.run(() => writeAgentDir(this.#dataDir, agent))
  }

  async deleteAgent(id: AgentId): Promise<boolean> {
    return this.#agentsMutex.run(async () => {
      // D112：记忆住在智能体目录里，删智能体连目录一起删（记忆随之消失）。
      // ⚠️ 先关掉并丢弃缓存的日志——否则句柄还开着已删除的文件，下一次
      //    `#memoryLog` 拿到旧对象会把记忆写回一个不存在的目录。
      const log = this.#memoryLogs.get(id as string)
      if (log) {
        await log.close()
        this.#memoryLogs.delete(id as string)
      }
      return removeAgentDir(this.#dataDir, id)
    })
  }

  // ── 独有技能（D111 文件资产；D228 起按**来源**定位，不按 agentId）──

  // 两类技能的分界（设计定稿 `docs/design/agent-directory.md` §4）：
  //   · **独有** = 跟着某个实体目录走的文件——不进技能库、不进技能页、不可卸载，
  //     删掉那个实体就连文件一起删。这里四个方法管的就是它们。
  //   · **共享** = 技能库里的资产，用 `skillIds` 引用（下面 `Skill` 一节）。
  //
  // ★ D228：参数从 `agentId` 换成 `ExclusiveSkillOwner`——目录由 `#exclusiveDirOf`
  //   解析（`agent` 那一种的路径归 `agent-dirs.ts`，`workflow-agent` 的由 daemon 注入）。
  //   四个方法因此对"账号智能体"和"编排内建智能体"是**同一份实现**。

  /** 列出这个来源的独有技能（slug + 正文）。 */
  async listExclusiveSkills(
    owner: ExclusiveSkillOwner,
  ): Promise<Array<{ slug: string; body: string }>> {
    return listExclusiveSkillBodiesIn(this.#exclusiveDirOf(owner))
  }

  async getExclusiveSkill(owner: ExclusiveSkillOwner, slug: string): Promise<string | null> {
    return getExclusiveSkillBodyIn(this.#exclusiveDirOf(owner), slug)
  }

  async writeExclusiveSkill(
    owner: ExclusiveSkillOwner,
    slug: string,
    body: string,
  ): Promise<void> {
    await this.#agentsMutex.run(() => writeExclusiveSkillBodyIn(this.#exclusiveDirOf(owner), slug, body))
  }

  async removeExclusiveSkill(owner: ExclusiveSkillOwner, slug: string): Promise<boolean> {
    return this.#agentsMutex.run(() => removeExclusiveSkillBodyIn(this.#exclusiveDirOf(owner), slug))
  }

  /*
   * ⚠️ 2026-11（S3）：这里原来是智能体组那六个方法（`getGroup` / `listGroups` /
   *   `listGroupsByAgent` / `insertGroup` / `updateGroup` / `deleteGroup`）。组退场
   *   ⇒ 端口上没有了，实现一并删。磁盘上 `log/group.jsonl` 原样留着，没有读它。
   */

  // ── Agent memory（分批第 240 批；D112 起落在智能体目录里）──

  /**
   * `agents/<id>/memory.jsonl` 的懒缓存（每个智能体一份）。
   *
   * ⚠️ 不校验 `agentDirExists`：调用方（daemon 路由）在进 store 之前已经 `getAgent`
   *    确认过智能体存在；这里只负责"这份日志在不在缓存、在就开、开了就复用"。
   *    删智能体（`deleteAgent`）会关掉并丢弃缓存——不写回一个已删除的目录。
   */
  async #memoryLog(agentId: AgentId): Promise<JsonlLog<MemoryEntry & { id: string }>> {
    const key = agentId as string
    let log = this.#memoryLogs.get(key)
    if (!log) {
      log = new JsonlLog<MemoryEntry & { id: string }>(
        join(agentDirPath(this.#dataDir, key), 'memory.jsonl'),
        { fsync: this.#fsync },
      )
      await log.open()
      this.#memoryLogs.set(key, log)
    }
    return log
  }

  async listMemoryEntries(
    workspaceId: WorkspaceId,
    agentId?: AgentId,
  ): Promise<MemoryEntry[]> {
    const out: MemoryEntry[] = []
    if (agentId !== undefined) {
      const all = (await this.#memoryLog(agentId)).all() as unknown as MemoryEntry[]
      out.push(...all)
    } else {
      // 不给 agentId = 跨所有智能体目录汇总（列表页的 `memoryCount` 用）。
      // 这是唯一"全部"的调用点，逐目录读是合理的（agent 数量少）。
      for (const agent of await listAgentDirs(this.#dataDir)) {
        const all = (await this.#memoryLog(agent.id)).all() as unknown as MemoryEntry[]
        out.push(...all)
      }
    }
    // 过滤在**调用方**的口径上做（这里只负责"这个 workspace 的"/"这个 agent 的"），
    // 已删除的照原样返回——历史是可查的事实。
    return out
      .filter((e) => e.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  async insertMemoryEntry(entry: MemoryEntry): Promise<void> {
    await this.#agentsMutex.run(async () => {
      const log = await this.#memoryLog(entry.agentId)
      await log.put(entry as MemoryEntry & { id: string })
    })
  }

  async updateMemoryEntry(entry: MemoryEntry): Promise<boolean> {
    return this.#agentsMutex.run(async () => {
      const log = await this.#memoryLog(entry.agentId)
      const existing = log.get(entry.id)
      if (!existing) return false
      await log.put(entry as MemoryEntry & { id: string })
      return true
    })
  }

  // ── Skill ──

  async getSkill(id: SkillId): Promise<Skill | null> {
    for (const ws of this.#stores.values()) {
      const found = ws.skill().get(id)
      if (found) return this.#hydrate(found)
    }
    return null
  }

  async listSkills(workspaceId: WorkspaceId): Promise<Skill[]> {
    const ws = await this.#ws(workspaceId)
    return Promise.all(ws.skill().all().map((rec) => this.#hydrate(rec)))
  }

  async listSkillsByIds(ids: readonly SkillId[]): Promise<Skill[]> {
    const wanted = new Set<string>(ids)
    const out: Skill[] = []
    for (const ws of this.#stores.values()) {
      for (const rec of ws.skill().all()) {
        if (wanted.has(rec.id)) out.push(await this.#hydrate(rec))
      }
    }
    return out
  }

  async insertSkill(skill: Skill): Promise<void> {
    const ws = await this.#ws(skill.workspaceId)
    // ★ 先写文件、再写记录。崩在两步之间时两种残留的方向完全不同：
    //   - **先写文件**：残留是"盘上有目录、记录里没有" ⇒ 界面上不可见
    //     （列表来自记录），下次装同名会覆盖它——最轻；
    //   - 反过来：残留是"记录在、内容不在" ⇒ 一条**可见的坏技能**。
    // 落点按来源分流（D80）：`mine` 进提炼根（git 化），其余进安装根。
    await writeSkillFiles(this.#rootFor(skill.source), skill)
    await ws.mutex.run(() => ws.skill().put(toIndexRecord(skill)))
  }

  async deleteSkill(id: SkillId): Promise<boolean> {
    // skill 没有 workspaceId 参数 ⇒ 只能逐个 workspace 找（当前只有一个，
    // 但**别假设这一点**：找不删的代价只是多几次读）
    for (const wsId of await this.listWorkspaceIds()) {
      const ws = await this.#ws(wsId)
      const rec = ws.skill().get(id)
      if (!rec) continue
      const removed = await ws.mutex.run(() => ws.skill().del(id))
      // 记录真删掉了才动磁盘（落点同样按来源分流）
      if (removed) {
        await removeSkillFiles(this.#rootFor(rec.source), rec.slug)
      }
      return removed
    }
    return false
  }

  /*
   * ⚠️ 2026-11（D123）：这里原来是**工具包**那一组实现（getTool / listTools /
   *   listToolsByIds / getToolBySlug / insertTool / deleteTool）与它的 `tool()` 日志。
   *   端口先删、这里跟着删——存储层只实现端口要的东西，端口没了就是死代码。
   */


  // ── Issue 与 Comment ──

  async getIssue(id: IssueId): Promise<Issue | null> {
    for (const ws of this.#stores.values()) {
      const found = ws.issue().get(id)
      if (found) return found
    }
    return null
  }

  async listIssues(q: IssueQuery): Promise<Page<Issue>> {
    const ws = await this.#ws(q.workspaceId)
    let items = ws.issue().all()
    if (q.status?.length) {
      const wanted = new Set<string>(q.status)
      items = items.filter((i) => wanted.has(i.status))
    }
    if (q.assigneeId) items = items.filter((i) => i.assignee?.id === q.assigneeId)
    if (q.search) {
      const needle = q.search.toLowerCase()
      items = items.filter(
        (i) =>
          i.title.toLowerCase().includes(needle) ||
          i.description.toLowerCase().includes(needle),
      )
    }
    return paginate(items, q)
  }

  async insertIssue(issue: Issue): Promise<void> {
    const ws = await this.#ws(issue.workspaceId)
    await ws.mutex.run(() => ws.issue().put(issue))
  }

  async transitionIssue(
    id: IssueId,
    expect: Issue['status'],
    next: Issue['status'],
    patch: Partial<Pick<Issue, 'assignee' | 'labels' | 'priority' | 'title' | 'description'>> = {},
  ): Promise<boolean> {
    for (const ws of this.#stores.values()) {
      const current = ws.issue().get(id)
      if (!current) continue
      return ws.mutex.run(async () => {
        const fresh = ws.issue().get(id)
        if (!fresh || fresh.status !== expect) return false
        await ws
          .issue()
          .patch(id, { ...pruneUndefined(patch), status: next, updatedAt: Date.now() })
        return true
      })
    }
    return false
  }

  async listComments(issueId: IssueId): Promise<Comment[]> {
    const out: Comment[] = []
    for (const ws of this.#stores.values()) {
      for (const c of ws.comment().all()) if (c.issueId === issueId) out.push(c)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  async insertComment(comment: Comment): Promise<void> {
    const ws = await this.#ws(comment.workspaceId)
    await ws.mutex.run(() => ws.comment().put(comment))
  }

  // ── Conversation 与 ChatTurn（聊天）──

  async getConversation(id: ConversationId): Promise<Conversation | null> {
    for (const ws of this.#stores.values()) {
      const found = ws.conversation().get(id)
      if (found) return found
    }
    return null
  }

  async listConversations(workspaceId: WorkspaceId): Promise<Conversation[]> {
    const all = (await this.#ws(workspaceId)).conversation().all()
    /**
     * ★ 排序：最近说过话的排最前。
     *
     * 键用 `lastTurnAt ?? createdAt`，**不用 `updatedAt`**：改个标题不该把一个
     * 对话顶到最前面（那会让"我刚聊过的那个"随时被一次改名挤走）。
     *
     * ⚠️ 同键时用 id 兜底：两个对话可能是同一毫秒建的，不兜底排序就不稳定，
     *    列表顺序会随读到的顺序变——而顺序变了，使用者会以为顺序有含义。
     */
    return [...all].sort((a, b) => {
      const ka = a.lastTurnAt ?? a.createdAt
      const kb = b.lastTurnAt ?? b.createdAt
      if (ka !== kb) return kb - ka
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    })
  }

  async insertConversation(conversation: Conversation): Promise<void> {
    const ws = await this.#ws(conversation.workspaceId)
    await ws.mutex.run(() => ws.conversation().put(conversation))
  }

  async updateConversation(
    id: ConversationId,
    patch: Partial<
      Pick<Conversation, 'title' | 'workDir' | 'updatedAt' | 'lastTurnAt' | 'turnCount'>
    >,
  ): Promise<Conversation | null> {
    for (const ws of this.#stores.values()) {
      const cur = ws.conversation().get(id)
      if (!cur) continue
      const next = { ...cur, ...patch } as Conversation & { id: string }
      await ws.mutex.run(() => ws.conversation().put(next))
      return next
    }
    return null
  }

  async listChatTurns(conversationId: ConversationId): Promise<ChatTurn[]> {
    const out: ChatTurn[] = []
    for (const ws of this.#stores.values()) {
      for (const t of ws.chatTurn().all()) {
        if (t.conversationId === conversationId) out.push(t)
      }
    }
    // ★ 按 seq 排，不按写入顺序也不按时间：seq 是"使用者眼里的第几轮"。
    //   回看时**顺序错了比少了更糟**——少一条看得出来，错一条看不出来。
    return out.sort((a, b) => a.seq - b.seq)
  }

  async insertChatTurn(turn: ChatTurn): Promise<void> {
    const ws = await this.#ws(turn.workspaceId)
    await ws.mutex.run(() => ws.chatTurn().put(turn))
  }

  async lastChatTurnWithRun(conversationId: ConversationId): Promise<ChatTurn | null> {
    const turns = await this.listChatTurns(conversationId)
    // 从后往前走：最后一轮可能因为没抢到并发槽位而没有 run（那是合法状态），
    // 此时"上一轮是谁"要往回再找一条——否则聊天会莫名其妙丢掉上文。
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const t = turns[i]!
      if (t.runId) return t
    }
    return null
  }

  async deleteConversation(id: ConversationId): Promise<boolean> {
    for (const ws of this.#stores.values()) {
      const cur = ws.conversation().get(id)
      if (!cur) continue
      await ws.mutex.run(async () => {
        // ★ 先删轮次再删对话。反过来的话，中途失败会留下一堆**指向不存在对话**
        //   的轮次——而那种记录没有任何入口能看见（列表按对话走），
        //   却会在下次"我到底说了什么"的时候对不上。
        for (const t of ws.chatTurn().all()) {
          if (t.conversationId === id) await ws.chatTurn().del(t.id)
        }
        await ws.conversation().del(id)
      })
      return true
    }
    return false
  }

  /**
   * 删掉一条 run 连同它派生的一切。连带范围与理由见端口文档
   * （`Store.deleteRun`）——这里只补一条文件存储特有的：
   * `runs/<runId>/messages.jsonl` 要先关掉缓存里的句柄再删文件。
   */
  async deleteRun(id: RunId): Promise<boolean> {
    for (const ws of this.#stores.values()) {
      const run = ws.run().get(id)
      if (!run) continue
      await ws.mutex.run(() => this.#deleteRunUnlocked(ws, id))
      return true
    }
    return false
  }

  /**
   * deleteRun 的**无锁**实现：调用方必须已持有 `ws.mutex`。
   *
   * 单独拆出来而不是让 `deleteIssue` 直接调 `deleteRun`：`Mutex` 是 promise
   * 队列（**不可重入**），外层锁里再调 `deleteRun`（它自己又拿同一把锁）会让
   * 内层永远排在"外层完成"之后——死锁。同一 workspace 内的所有删除操作
   * 都必须在**同一把锁**里串行完成。
   */
  async #deleteRunUnlocked(ws: WorkspaceStore, id: RunId): Promise<void> {
    // ① 引用这条 run 的对话轮次：那一轮的内容就是 run 的 messages，run 没了
    //    轮次只剩半句话。删掉后重算受影响对话的 `turnCount`（冗余字段，删轮
    //    次后必须同步，否则列表上的轮数就是假的）。
    const affected = new Set<ConversationId>()
    for (const t of ws.chatTurn().all()) {
      if (t.runId === id) {
        affected.add(t.conversationId)
        await ws.chatTurn().del(t.id)
      }
    }
    for (const convId of affected) {
      const conv = ws.conversation().get(convId)
      if (!conv) continue
      const count = ws
        .chatTurn()
        .all()
        .filter((t) => t.conversationId === convId).length
      await ws.conversation().patch(convId, { turnCount: count, updatedAt: Date.now() })
    }
    /*
     * ② 判决记录（老数据）。
     *
     * ⚠️ 2026-11（D125）：判决退场之后**没有代码再写它**，`'verdict'` 也不在集合
     *   白名单里（`open()` 不再打开那份日志）。于是"删 run 一并清掉它名下的老判决"
     *   这件事**做不到**了——那份日志压根没被打开。
     *
     *   我们选择**不做**：那条老判决指向一条已删的 run，读它的代码（`getVerdict` /
     *   `listVerdictsByRun`）也一起删了，所以没有任何读者会遇到这个悬空引用。
     *   反过来，为它单开一条"读一份没人读的日志"的路径，等于把删除语义绑在一份
     *   死数据上。老库想彻底清掉的话，那是迁移工具的活。
     */
    // ③ artifacts（这条 run 的产物清单）
    for (const a of ws.artifact().all()) {
      if (a.runId === id) await ws.artifact().del(a.id)
    }
    // ④ 消息流文件：先关掉缓存的句柄再删（开着的文件在部分平台上删不掉；
    //    即便当前平台没这个问题，留着缓存里一个指向已删文件的句柄
    //    也会在下次 close 时踩到 ENOENT）。
    await ws.closeMessageLog(id)
    await removeQuietly(ws.messageLogPathOf(id))
    // ⑤ run 记录本体
    await ws.run().del(id)
  }

  /**
   * 删掉一条任务（issue）连同挂它名下的一切。连带范围见端口文档
   * （`Store.deleteIssue`）。该 issue 上的每条 run 走 `#deleteRunUnlocked`
   * （同一把 `ws.mutex` 里，不能调公共 `deleteRun`——那个会再拿锁，死锁）。
   *
   * "属于这条 issue"的判据与 server 侧 `runBelongsToIssue` 同一条：顺着
   * subject 链往上找（执行 run 的 subject 是 issue；审核 run 的 subject 是
   * 它审的那条执行 run），最多 3 层——不满足就把审核 run 漏下，删了任务
   * 留下一堆指向已删 run 的孤儿审核记录。
   */
  async deleteIssue(id: IssueId): Promise<boolean> {
    for (const ws of this.#stores.values()) {
      const issue = ws.issue().get(id)
      if (!issue) continue
      await ws.mutex.run(async () => {
        // ★ 先**收集**再删：判定"属于这条 issue"要靠 subject 链（审核 run 的
        //   subject 指向执行 run），若边删边判，执行 run 先消失会让后面审核 run
        //   的链断掉、被当成"不属于"而漏删。
        const toDelete = ws
          .run()
          .all()
          .filter((r) => runBelongsToIssueInLog(ws.run(), r, id))
        for (const r of toDelete) {
          await this.#deleteRunUnlocked(ws, r.id)
        }
        // ② 评论
        for (const c of ws.comment().all()) {
          if (c.issueId === id) await ws.comment().del(c.id)
        }
        // ③ issue 本体
        await ws.issue().del(id)
      })
      return true
    }
    return false
  }

  /*
   * ⚠️ 2026-11（D125）：这里原来是 report 的四个方法（`listReports` /
   *   `findReportByDedupKey` / `getReport` / `insertReport`）。报告摄取退场 ⇒
   *   端口上不再有 report，实现一并删。
   */

  // ── Run ──

  async getRun(id: RunId): Promise<Run | null> {
    for (const ws of this.#stores.values()) {
      const found = ws.run().get(id)
      if (found) return found
    }
    return null
  }

  async listRuns(q: RunQuery): Promise<Page<Run>> {
    const ws = await this.#ws(q.workspaceId)
    let items = ws.run().all()
    if (q.status?.length) {
      const wanted = new Set<string>(q.status)
      items = items.filter((r) => wanted.has(r.status))
    }
    if (q.agentId) items = items.filter((r) => r.agentId === q.agentId)
    // ★ 分批第 72 批：`order: 'desc'` = **最近的一页**（见 `RunQuery.order` 的注释）。
    //   按 `queuedAt` 排（同一毫秒再按 id 反序），**不给游标**——理由写在端口那边。
    //
    //   ⚠️ 这里不能复用 `paginate`：它按 id 升序、并用 id 当游标。把 desc 硬塞进去
    //     就会得到"id 最小的那几条"（恰恰是最老的）。
    if (q.order === 'desc') {
      const sorted = [...items].sort(
        (a, b) => b.queuedAt - a.queuedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      return { items: sorted.slice(0, q.limit ?? 50), nextCursor: null }
    }
    return paginate(items, q)
  }

  async insertRun(run: Run): Promise<void> {
    const ws = await this.#ws(run.workspaceId)
    await ws.mutex.run(() => ws.run().put(run))
  }

  /**
   * ★ CAS 转移。
   *
   * 这一条在文件存储上是"加锁读 → 校验前态 → 追加"，在数据库上就是
   * `UPDATE ... WHERE id = ? AND status = expect`。**语义相同**，所以
   * 领域逻辑不需要知道底下是什么。
   *
   * 这里还会再跑一次状态机校验：不是不信任领域层，而是让"写进一个
   * 非法状态"变成**当场报错**，而不是几天后从数据里发现。
   */
  async transitionRun(
    id: RunId,
    expect: RunStatus,
    next: RunStatus,
    patch: RunPatch = {},
  ): Promise<boolean> {
    for (const ws of this.#stores.values()) {
      if (!ws.run().has(id)) continue
      return ws.mutex.run(async () => {
        const current = ws.run().get(id)
        if (!current) return false
        if (current.status !== expect) return false
        assertRunTransition(expect, next)
        await ws.run().patch(id, { ...pruneUndefined(patch), status: next })
        return true
      })
    }
    return false
  }

  async findRunHoldingWorkDir(workDir: string, excludeRunId?: RunId): Promise<Run | null> {
    for (const ws of this.#stores.values()) {
      for (const r of ws.run().all()) {
        if (r.workDir !== workDir) continue
        if (excludeRunId && r.id === excludeRunId) continue
        if (isActiveRun(r)) return r
      }
    }
    return null
  }

  async findActiveRunForSubjectAgent(subject: SubjectRef, agentId: AgentId): Promise<Run | null> {
    for (const ws of this.#stores.values()) {
      for (const r of ws.run().all()) {
        if (r.agentId !== agentId) continue
        if (r.subject.type !== subject.type || r.subject.id !== subject.id) continue
        if (isActiveRun(r)) return r
      }
    }
    return null
  }

  async appendRunMessage(runId: RunId, message: RunMessage): Promise<void> {
    const ws = await this.#findWorkspaceOfRun(runId)
    const log = await ws.mutex.run(() => ws.messageLogFor(runId))
    await log.append(message)
  }

  async listRunMessages(runId: RunId, since = -1): Promise<RunMessage[]> {
    const ws = await this.#findWorkspaceOfRun(runId)
    const log = await ws.mutex.run(async () => ws.messageLogFor(runId))
    return log.read(since)
  }

  async lastRunMessageSeq(runId: RunId): Promise<number> {
    const ws = await this.#findWorkspaceOfRun(runId)
    const log = await ws.mutex.run(async () => ws.messageLogFor(runId))
    return log.lastSeq
  }

  async #findWorkspaceOfRun(runId: RunId): Promise<WorkspaceStore> {
    for (const ws of this.#stores.values()) {
      if (ws.run().has(runId)) return ws
    }
    throw new Error(`找不到 run ${runId}（消息流必须挂在一个已知 run 上）`)
  }

  /*
   * ⚠️ 2026-11（D125）：这里原来是判决的四个实现（`getVerdict` /
   *   `listVerdictsByRun` / `insertVerdict` / `transitionVerdict`）。判决退场 ⇒
   *   端口上不再有判决，实现一并删。磁盘上 `verdict` 那一节原样留着（`deleteRun`
   *   仍然会清掉某条 run 名下的老记录）。
   */

  /*
   * ⚠️ 2026-11（D123）：这里原来是**动作记录**那一组实现（getAction /
   *   listActionsByVerdict / findActionByIdempotencyKey / insertAction /
   *   transitionAction）与 `action()` 日志、`#idempotency` 内存索引。判决不再触发
   *   动作 ⇒ 这些记录没有任何写入者，端口也已删除，整段删。
   */

  // ── Artifact ──

  async listArtifactsByRun(runId: RunId): Promise<Artifact[]> {
    const out: Artifact[] = []
    for (const ws of this.#stores.values()) {
      for (const a of ws.artifact().all()) if (a.runId === runId) out.push(a)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  async insertArtifact(artifact: Artifact): Promise<void> {
    const ws = await this.#ws(artifact.workspaceId)
    await ws.mutex.run(() => ws.artifact().put(artifact))
  }

  // ── Blob ──

  async putBlob(bytes: Uint8Array): Promise<BlobRef> {
    // blob 是全局的，但按 workspace 分目录存；这里用第一个 workspace，
    // 没有 workspace 时落到根下——内容寻址使得放哪儿都不影响正确性。
    const ws = [...this.#stores.values()][0]
    if (ws) return ws.blobs.put(bytes)
    return new BlobStore(join(this.#dataDir, 'blobs')).put(bytes)
  }

  async getBlob(ref: BlobRef): Promise<Uint8Array | null> {
    for (const ws of this.#stores.values()) {
      const bytes = await ws.blobs.get(ref)
      if (bytes) return bytes
    }
    return new BlobStore(join(this.#dataDir, 'blobs')).get(ref)
  }

  async hasBlob(ref: BlobRef): Promise<boolean> {
    for (const ws of this.#stores.values()) {
      if (await ws.blobs.has(ref)) return true
    }
    return new BlobStore(join(this.#dataDir, 'blobs')).has(ref)
  }

  // ── Audit ──

  async appendAudit(record: AuditRecord): Promise<void> {
    const ws = await this.#ws(record.workspaceId)
    await ws.mutex.run(() => ws.audit().put(record))
  }

  async listAuditsByRun(runId: RunId): Promise<AuditRecord[]> {
    const out: AuditRecord[] = []
    for (const ws of this.#stores.values()) {
      for (const a of ws.audit().all()) if (a.runId === runId) out.push(a)
    }
    return out.sort((a, b) => a.queuedAt - b.queuedAt)
  }

  async listWorkspaceIds(): Promise<WorkspaceId[]> {
    return [...this.#workspaces.values()].map((w) => w.id as WorkspaceId)
  }

  // ── 通知中心 ──

  async appendInboxItem(item: InboxItem): Promise<void> {
    const ws = await this.#ws(item.workspaceId as WorkspaceId)
    await ws.mutex.run(() => ws.inbox().put(item))
  }

  async listInboxItems(q: {
    workspaceId: WorkspaceId
    unreadOnly?: boolean
    limit?: number
  }): Promise<InboxItem[]> {
    const ws = await this.#ws(q.workspaceId)
    let items = ws.inbox().all()
    if (q.unreadOnly ?? true) items = items.filter((i) => !i.read)
    return items
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, q.limit ?? 100)
  }

  async markInboxItemRead(id: string): Promise<boolean> {
    for (const ws of this.#stores.values()) {
      if (!ws.inbox().has(id)) continue
      return ws.mutex.run(() => ws.inbox().patch(id, { read: true }))
    }
    return false
  }

  // ── 额外（不属于端口，供运维使用）──

  /** 压缩全部日志：物化快照并丢弃已合并的增量。 */
  async compact(): Promise<void> {
    await this.#mutex.run(async () => {
      for (const ws of this.#stores.values()) await ws.compact()
    })
  }

  async close(): Promise<void> {
    for (const ws of this.#stores.values()) await ws.close()
    this.#stores.clear()
    if (this.#releaseLock) {
      await this.#releaseLock()
      this.#releaseLock = null
    }
  }
}

/** 便捷打开函数，符合 `StoreOpener` 签名。 */
export async function openFileStore(options: FileStoreOptions): Promise<FileStore> {
  return FileStore.open(options)
}

export { LockHeldError }
export { sha256Hex }
export { removeQuietly }
