import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  ACTIVE_RUN_STATUSES,
  assertActionTransition,
  assertRunTransition,
  assertVerdictTransition,
  type ActionPatch,
  type IssueQuery,
  type ReportQuery,
  type Page,
  type RunPatch,
  type RunQuery,
  type Store,
} from '@agentdeck/domain'
import type {
  Action,
  ActionId,
  ActionStatus,
  Agent,
  AgentGroup,
  AgentGroupId,
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
  Report,
  Run,
  RunId,
  RunMessage,
  RunStatus,
  Skill,
  SkillId,
  SubjectRef,
  Tool,
  ToolId,
  VerdictId,
  VerdictRecord,
  VerdictStatus,
  Workspace,
  WorkspaceId,
} from '@agentdeck/protocol'
import { cleanAgent } from '@agentdeck/protocol'

/**
 * SQLite 存储适配器 —— `Store` 端口的 v2 实现（`node:sqlite`）。
 *
 * 与 `@agentdeck/store-file` 的**行为契约完全一致**：同一个端口，
 * 换一种存储。领域层不需要知道底下是文件还是数据库，这正是端口存在的理由
 * （FR-STOR-03）。`port-thinness.test.ts` 里跑了一份差分测试，把同一串操作
 * 分别在两个适配器上执行并逐项对比结果。
 *
 * ══════════════════════════════════════════════════════════════
 * 三个关键取舍
 * ══════════════════════════════════════════════════════════════
 *
 * **1. JSON 是唯一真相，派生列由 SQLite 自己算。**
 *
 * 每张表只有 `id` / `workspace_id` / `json` 三列是真正写进去的，其余
 * （`status`、`work_dir`、`dedup_key` …）都是 VIRTUAL 生成列：
 *
 *     status TEXT GENERATED ALWAYS AS (json_extract(json,'$.status')) VIRTUAL
 *
 * 为什么不手写冗余列：那是**双份真相**，迟早不一致。文件适配器就为同一个
 * 理由删掉了文档里写的 `runs/<runId>/run.json`——run 已经作为追加记录存在，
 * 再存一份只会互相打架。生成列由 SQLite 在读取时从 JSON 求值，物理上不可能
 * 与 JSON 不一致；而虚拟生成列**照样能建索引**，所以查询仍然走索引。
 *
 * **2. `DatabaseSync` 是同步的，所以不需要互斥锁。**
 *
 * 文件适配器必须有一个进程内 `Mutex`，因为它的"加锁读 → 校验前态 → 追加"
 * 中间有 `await`，别的调用能插进来。这里的 SQL 调用是同步的：一个方法体内
 * 只要不 `await`，它读到的状态和它写下的状态之间就**不可能**插进另一个调用。
 * 所以本文件里所有方法体内**一个 `await` 都没有**——这是有意的约束，不是
 * 忘了写。CAS 仍然落在 `UPDATE ... WHERE id = ? AND status = ?` 上，因为
 * 那个保证对**另一个进程**同样成立（SQLite 的文件锁只保护单条语句）。
 *
 * **3. 没有内存态，所以"重开后数据看起来丢了"那一类 bug 结构上不存在。**
 *
 * 文件适配器踩过一次：每个 workspace 的存储是懒建的，而 `getAgent` 这类
 * 方法是跨 workspace 遍历内存里的 store 集合，于是重开进程后集合为空，
 * 所有跨 workspace 查询都返回 null——数据好好躺在日志里，却表现为"丢了"。
 * 这里所有查询都直接打数据库，没有需要重建的缓存，也没有"先列举才会被加载"
 * 的对象。即便如此，`open()` 仍然把每张表真读一次（见 `#warmUp`）。
 *
 * ══════════════════════════════════════════════════════════════
 * 运行期要求
 * ══════════════════════════════════════════════════════════════
 *
 * `node:sqlite` 是 Node 内置模块，但**不是所有 Node 版本都能直接用**：
 *
 *   Node ≥ 24      直接可用，不需要任何开关（本包在此验证：SQLite 3.53.4）
 *   Node 22.5–23   需要 `--experimental-sqlite`，否则 `node:sqlite` 不存在
 *
 * 之所以写在这里而不是写个"检测不到就安静跳过"的分支：本项目的存储换错版本
 * 是**不能静默降级**的事情——安静跳过的测试等于没有测试。Node 22 上跑会直接
 * 报 `No such built-in module: node:sqlite`，那条消息已经把原因说清楚了；
 * 需要支持 22.x 时在启动脚本里加开关即可。
 *
 * ══════════════════════════════════════════════════════════════
 * 与文件适配器的存储目录关系
 * ══════════════════════════════════════════════════════════════
 *
 * 本适配器只写 `<dataDir>/store.sqlite`（外加 WAL 的 `-wal` / `-shm`），
 * 不碰 `meta.json` / `lock` / `workspaces.jsonl`。两个适配器可以指向同一个
 * dataDir 而不互相破坏文件，但**这不是一种可用的混用方式**：两边各存各的，
 * 谁也看不见谁写的数据。要在两种存储之间搬家，走的是导出/导入（FR-STOR-05），
 * 不是共用目录。
 */

export const SQLITE_STORE_FORMAT_VERSION = 1

/** 数据库文件名。WAL 的两个附属文件由 SQLite 自己管理。 */
export const SQLITE_FILE_NAME = 'store.sqlite'

export interface SqliteStoreOptions {
  dataDir: string
  /**
   * 换掉文件名（运维/测试用）。默认 `store.sqlite`。
   */
  fileName?: string
  /**
   * `true`（默认）= `synchronous = FULL`，每次提交都 fsync；
   * `false` = `NORMAL`（WAL 模式下的推荐值），**只应在测试里用**。
   *
   * 选项名与文件适配器的 `fsync` 保持一致，好让调用方在两套存储之间
   * 切换时不用改代码。语义也一致：用性能换"崩溃后不丢最近几条"。
   */
  fsync?: boolean
}

/**
 * 去掉值为 `undefined` 的键。
 *
 * ⚠️ 这是**刻意与 `store-file/src/mutex.ts` 重复**的一份实现，不要合并：
 * 两个适配器之间不允许互相依赖（否则"换存储"就变成"换一半还要拖着另一半"）。
 * 但语义必须逐字对齐——`patch` 里 `undefined` 表示"没提到这个字段"，
 * `null` 才表示"清空"。改动时必须两边同时改，`port-thinness.test.ts` 的
 * 差分测试会盯着这一点。
 */
function pruneUndefined(obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

/** 与文件适配器同一算法（`node:crypto` sha256 十六进制），保证同一份内容得到同一个引用。 */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// ─────────────────────────────────────────────────────────────
// 表结构
// ─────────────────────────────────────────────────────────────

const FORMAT_VERSION_KEY = 'formatVersion'

/**
 * 只有 meta 表先建：要读到版本号，才知道这份数据是不是"未来的程序写的"。
 * 版本过高时必须在**任何其他写入之前**退出，否则就等于用旧程序改新数据。
 */
const META_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
] as const

/** 有 workspace 归属的实体表。键名即表名，下文用它拼通用语句。 */
const ENTITY_TABLES = [
  'agent',
  // 智能体组（D70 增量添加）。与文件适配器的 `COLLECTIONS` 同序摆放。
  'group',
  'skill',
  'tool',
  'issue',
  'comment',
  /**
   * 聊天（闭环的旁路）。与文件适配器的 `COLLECTIONS` 同序摆放：两者一起加，
   * 因为 `chat_turn` 离开 `conversation` 没有意义。
   *
   * ⚠️ 表名用下划线（`chat_turn`），文件适配器那边叫 `chat-turn`——那是**日志
   *    文件名**，这里是 SQL 标识符，两者不必同名（同 `run_message` 的先例）。
   */
  'conversation',
  'chat_turn',
  'run',
  'verdict',
  'action',
  'artifact',
  'audit',
  'inbox',
] as const

type EntityTable = (typeof ENTITY_TABLES)[number]

/** 通用 upsert 覆盖的表。report 不在其中——它必须走"去重键唯一"那条语句。 */
const GENERAL_PUT_TABLES = ENTITY_TABLES

/** 需要"按 workspace 列举"的表：端口里只有 agent / skill / tool / report 有这种列法。 */
const WORKSPACE_LIST_TABLES = ['agent', 'group', 'skill', 'tool', 'report'] as const

const ALL_TABLES = [
  'meta',
  'device',
  'workspace',
  ...ENTITY_TABLES,
  'report',
  'run_message',
  'blob',
] as const

/**
 * 活动状态占位符。
 *
 * ★ 状态集合**取自领域层的 `ACTIVE_RUN_STATUSES`，不在这里抄一份**。
 * 抄一份的话，将来领域层改了"什么算占用目录"，适配器会静默地继续用旧定义，
 * 而这种不一致只会在很后面的地方以"目录没串行化"的形式暴露出来。
 */
const ACTIVE_STATUS_PLACEHOLDERS = ACTIVE_RUN_STATUSES.map(() => '?').join(', ')

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS device (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     json TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS workspace (
     id TEXT PRIMARY KEY,
     json TEXT NOT NULL
   )`,

  // ── 无查询条件的实体表：JSON 里没有需要索引的字段 ──
  `CREATE TABLE IF NOT EXISTS agent (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS agent_workspace ON agent(workspace_id)`,

  // ── 无查询条件的实体表：JSON 里没有需要索引的字段 ──
  `CREATE TABLE IF NOT EXISTS "group" (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS group_workspace ON "group"(workspace_id)`,

  `CREATE TABLE IF NOT EXISTS skill (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS skill_workspace ON skill(workspace_id)`,

  /**
   * 工具包（D40）。slug 提成生成列，是为了让 `getToolBySlug` 走索引——
   * 否则每次判决解析都要把一个 workspace 的包全读出来再比字符串。
   *
   * ⚠️ 这个索引**故意不是唯一索引**，尽管"一个 workspace 内 slug 唯一"是
   *    端口的语义。理由与下面 action 的幂等键那条一致：唯一约束会把"调用方
   *    装了一个同 slug 的包"从"查得到那条（文件适配器就是这么做的：按 id
   *    覆盖写入）"变成"写失败、抛错"。那是行为改变，而且恰好是文件适配器
   *    做不到的改变——两个适配器对同一串操作必须给出同样的结果。
   *    slug 的唯一性由安装侧把关（安装是它唯一写入这个表的路径）。
   */
  `CREATE TABLE IF NOT EXISTS tool (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     json TEXT NOT NULL,
     slug TEXT GENERATED ALWAYS AS (json_extract(json, '$.slug')) VIRTUAL
   )`,
  `CREATE INDEX IF NOT EXISTS tool_workspace_slug ON tool(workspace_id, slug)`,

  // ── issue：目录管理要按状态 / 指派人过滤，还要子串检索 ──
  `CREATE TABLE IF NOT EXISTS issue (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     json TEXT NOT NULL,
     status TEXT GENERATED ALWAYS AS (json_extract(json, '$.status')) VIRTUAL,
     assignee_id TEXT GENERATED ALWAYS AS (json_extract(json, '$.assignee.id')) VIRTUAL
   )`,
  `CREATE INDEX IF NOT EXISTS issue_workspace_status ON issue(workspace_id, status)`,
  `CREATE INDEX IF NOT EXISTS issue_assignee ON issue(assignee_id)`,

  `CREATE TABLE IF NOT EXISTS comment (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     json TEXT NOT NULL,
     issue_id TEXT GENERATED ALWAYS AS (json_extract(json, '$.issueId')) VIRTUAL,
     created_at INTEGER GENERATED ALWAYS AS (json_extract(json, '$.createdAt')) VIRTUAL
   )`,
  `CREATE INDEX IF NOT EXISTS comment_issue ON comment(issue_id, created_at)`,

  /**
   * ── 聊天：conversation 与 chat_turn ──
   *
   * ★ `sort_at` 这一列是本组的关键：列表按 `lastTurnAt ?? createdAt` 倒序，
   *   而 `ORDER BY COALESCE(last_turn_at, created_at)` 这种**表达式**用不上
   *   建在单列上的索引。把合并后的排序键落成一个虚拟生成列，索引才真的能
   *   服务这条排序（虚拟生成列照样可建索引，见文件头第 1 条取舍）。
   *
   * ⚠️ 用 `lastTurnAt` 而不是 `updatedAt` 当排序键：改个标题不该把对话顶到
   *    最前面。排序键的语义是**领域层的决定**，适配器只负责照做。
   *
   * `id` 作为 ORDER BY 的第二关键字（倒序）不是装饰：两个对话可能是同一毫秒
   * 建的，不兜底排序就不稳定。索引里把 `id DESC` 也写上，让这条排序整个由
   * 索引承担。
   */
  `CREATE TABLE IF NOT EXISTS conversation (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     json TEXT NOT NULL,
     sort_at INTEGER GENERATED ALWAYS AS (
       COALESCE(json_extract(json, '$.lastTurnAt'), json_extract(json, '$.createdAt'))
     ) VIRTUAL
   )`,
  `CREATE INDEX IF NOT EXISTS conversation_workspace_recent
     ON conversation(workspace_id, sort_at DESC, id DESC)`,

  /**
   * 回合表。`seq` 是"使用者眼里的第几轮"，排序与"最后一条带 run 的"都看它。
   *
   * ★ 这里**故意不建 `(conversation_id, seq)` 唯一约束**：端口的语义是"追加"，
   *   文件适配器允许同一个 `seq` 追加两条（读取时按 seq 稳定排序、两条都返回）。
   *   加唯一约束会把"调用方给重了 seq"从一个调用方 bug 升级成存储报错，
   *   那是行为改变——与 `run_message` 的 seq 同一条理由。
   */
  `CREATE TABLE IF NOT EXISTS chat_turn (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     json TEXT NOT NULL,
     conversation_id TEXT GENERATED ALWAYS AS (json_extract(json, '$.conversationId')) VIRTUAL,
     seq INTEGER GENERATED ALWAYS AS (json_extract(json, '$.seq')) VIRTUAL,
     run_id TEXT GENERATED ALWAYS AS (json_extract(json, '$.runId')) VIRTUAL
   )`,
  `CREATE INDEX IF NOT EXISTS chat_turn_conversation_seq ON chat_turn(conversation_id, seq)`,
  /**
   * `lastChatTurnWithRun` 走的是"这个对话里 `run_id` 非空、seq 最大"那条，
   * 所以索引把 `run_id` 放在 `seq` **前面**：过滤先于排序，扫描量从"整个对话
   * 的轮次"降到"有 run 的那几轮"。一个对话几百轮时这不是小事。
   */
  `CREATE INDEX IF NOT EXISTS chat_turn_with_run ON chat_turn(conversation_id, run_id, seq)`,

  /**
   * ★ report 的去重键必须是**数据库**层的唯一约束。
   *
   * 不能写成"先查有没有、再插入"：那是应用层判断，两个进程同时摄取同一条
   * report 时会双双认为自己没查到、双双写进去，FR-REPORT-03 的保证就没了。
   * 唯一索引 + `ON CONFLICT ... DO NOTHING` 才是并发下也成立的幂等。
   *
   * 唯一键含 `workspace_id`：文件适配器的去重是"每个 workspace 内"的
   * （`insertReport` 只查自己的 workspace，不同 workspace 的同名去重键
   * 各自都能写进去）。这里对齐同一语义，不擅自升级成全局唯一。
   */
  `CREATE TABLE IF NOT EXISTS report (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     json TEXT NOT NULL,
     dedup_key TEXT GENERATED ALWAYS AS (json_extract(json, '$.dedupKey')) VIRTUAL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS report_dedup ON report(workspace_id, dedup_key)`,

  `CREATE TABLE IF NOT EXISTS run (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     json TEXT NOT NULL,
     status TEXT GENERATED ALWAYS AS (json_extract(json, '$.status')) VIRTUAL,
     agent_id TEXT GENERATED ALWAYS AS (json_extract(json, '$.agentId')) VIRTUAL,
     subject_type TEXT GENERATED ALWAYS AS (json_extract(json, '$.subject.type')) VIRTUAL,
     subject_id TEXT GENERATED ALWAYS AS (json_extract(json, '$.subject.id')) VIRTUAL,
     work_dir TEXT GENERATED ALWAYS AS (json_extract(json, '$.workDir')) VIRTUAL
   )`,
  `CREATE INDEX IF NOT EXISTS run_workspace ON run(workspace_id, status)`,
  `CREATE INDEX IF NOT EXISTS run_work_dir ON run(work_dir, status)`,
  `CREATE INDEX IF NOT EXISTS run_subject_agent ON run(subject_type, subject_id, agent_id, status)`,

  `CREATE TABLE IF NOT EXISTS verdict (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     json TEXT NOT NULL,
     run_id TEXT GENERATED ALWAYS AS (json_extract(json, '$.runId')) VIRTUAL,
     status TEXT GENERATED ALWAYS AS (json_extract(json, '$.status')) VIRTUAL,
     created_at INTEGER GENERATED ALWAYS AS (json_extract(json, '$.createdAt')) VIRTUAL
   )`,
  `CREATE INDEX IF NOT EXISTS verdict_run ON verdict(run_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS action (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     json TEXT NOT NULL,
     verdict_id TEXT GENERATED ALWAYS AS (json_extract(json, '$.verdictId')) VIRTUAL,
     status TEXT GENERATED ALWAYS AS (json_extract(json, '$.status')) VIRTUAL,
     idempotency_key TEXT GENERATED ALWAYS AS (json_extract(json, '$.idempotencyKey')) VIRTUAL,
     created_at INTEGER GENERATED ALWAYS AS (json_extract(json, '$.createdAt')) VIRTUAL
   )`,
  `CREATE INDEX IF NOT EXISTS action_verdict ON action(verdict_id, created_at)`,
  /**
   * 幂等键上**只建普通索引**，不建唯一索引。
   *
   * 文件适配器的幂等键是一张"最后写入者赢"的内存映射：同一个 id 再写一次
   * 只是换掉映射指向。而 `insertAction` 本身在端口里没有"仅插入一次"的语义
   * （只有 report 有）。加唯一约束会把"调用方重放"从"可查回同一条"变成
   * "写失败"，那是行为改变，不是加固。
   */
  `CREATE INDEX IF NOT EXISTS action_idempotency ON action(idempotency_key)`,

  `CREATE TABLE IF NOT EXISTS artifact (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     json TEXT NOT NULL,
     run_id TEXT GENERATED ALWAYS AS (json_extract(json, '$.runId')) VIRTUAL,
     created_at INTEGER GENERATED ALWAYS AS (json_extract(json, '$.createdAt')) VIRTUAL
   )`,
  `CREATE INDEX IF NOT EXISTS artifact_run ON artifact(run_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS audit (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     json TEXT NOT NULL,
     run_id TEXT GENERATED ALWAYS AS (json_extract(json, '$.runId')) VIRTUAL,
     queued_at INTEGER GENERATED ALWAYS AS (json_extract(json, '$.queuedAt')) VIRTUAL
   )`,
  `CREATE INDEX IF NOT EXISTS audit_run ON audit(run_id, queued_at)`,

  `CREATE TABLE IF NOT EXISTS inbox (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     json TEXT NOT NULL,
     is_read INTEGER GENERATED ALWAYS AS (json_extract(json, '$.read')) VIRTUAL,
     created_at INTEGER GENERATED ALWAYS AS (json_extract(json, '$.createdAt')) VIRTUAL
   )`,
  `CREATE INDEX IF NOT EXISTS inbox_workspace ON inbox(workspace_id, is_read, created_at)`,

  /**
   * 消息流：与实体表分开，理由与文件适配器一致——消息是**高写入量**数据
   * （一次 run 上千条），实体记录是低频状态变更，混在一起会让两边都难做。
   *
   * ⚠️ 这里**故意不建 `(run_id, seq)` 唯一约束**。端口的语义是"追加"，
   * 文件适配器允许同 seq 追加两条（读取时按 seq 稳定排序、两条都返回）。
   * 加唯一约束会把"调用方给重了 seq"从"多一条消息"变成"写失败"——那是把
   * 一个调用方 bug 升级成存储报错，改变了端口行为。seq 单调是**调用方**的
   * 责任（FR-BRIDGE-18），存储不替它做判断。
   */
  `CREATE TABLE IF NOT EXISTS run_message (
     run_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS run_message_seq ON run_message(run_id, seq)`,

  // ── 内容寻址 blob：ref 就是 sha256，天然幂等且不可变 ──
  `CREATE TABLE IF NOT EXISTS blob (
     ref TEXT PRIMARY KEY,
     bytes BLOB NOT NULL
   )`,
] as const

// ─────────────────────────────────────────────────────────────
// 语句
// ─────────────────────────────────────────────────────────────

/**
 * 固定语句。
 *
 * 键名是字面量类型，所以 `#named()` 的参数拼错会在**编译期**报错，而不是
 * 变成一句运行期才发现拼错了的 SQL。所有语句在 `open()` 时统一 prepare
 * （见 `#prepare`），schema 不对就在 open 炸，而不是等第一次写入。
 *
 * ⚠️ 过滤条件一律用"参数开关"（`?2 IS NULL OR ...`）而不是拼 SQL 字符串：
 * 拼字符串既容易漏掉转义，也会让语句无法复用。状态集合通过 `json_each(?)`
 * 传 JSON 数组进去，一条语句覆盖"过滤 / 不过滤 / 过滤多个"三种情况。
 * 代价是 status 上的复合索引第二列用不上（规划器看不穿 json_each），
 * 本机单用户规模下这点扫描量无所谓——**行为一致**比查询计划重要。
 */
const NAMED_SQL = {
  metaGet: `SELECT value FROM meta WHERE key = ?`,
  metaPut: `INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,

  deviceGet: `SELECT json FROM device WHERE id = 1`,
  devicePut: `INSERT INTO device(id, json) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`,

  workspaceGet: `SELECT json FROM workspace WHERE id = ?`,
  workspacePut: `INSERT INTO workspace(id, json) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
  /**
   * 某个 agent 属于哪些组（D70）。
   *
   * `members` 是 JSON 数组，用 `json_each` 展开后按元素匹配。⚠️ 必须用
   * `EXISTS` 而不是 `json_each(json) ... WHERE` 直接 join：后者一行组会产生
   * 多行结果，还要去重；EXISTS 一行一组，语义直接。
   */
  groupListByAgent: `SELECT json FROM "group"
     WHERE EXISTS (
       SELECT 1 FROM json_each(json_extract("group".json, '$.members')) WHERE value = ?
     ) ORDER BY rowid`,
  /**
   * ★ 按**插入顺序**返回，不是按 id 排序。
   *
   * `listWorkspaceIds()` 的顺序有语义：daemon 取 `ids[0]` 当默认工作区
   * （`executor.#defaultWorkspaceId`）。文件适配器返回的是 workspaces.jsonl
   * 的写入顺序，也就是"最先建的那个"。排序换成 id 就会悄悄换掉默认工作区。
   */
  workspaceIds: `SELECT id FROM workspace ORDER BY rowid`,

  // ── Run 的 CAS：★ 这一条是本适配器的支点 ──
  runGet: `SELECT json, status FROM run WHERE id = ?`,
  runExists: `SELECT 1 AS present FROM run WHERE id = ?`,
  /**
   * `WHERE id = ? AND status = ?` —— 校验前态与写入是同一条语句，中间没有
   * 任何缝隙。就算另一个进程正好在两句之间改了状态，这条 UPDATE 也会因为
   * `changes = 0` 而失败，不会覆盖掉别人的写入。这就是"CAS 语义在文件存储
   * 与数据库上相同"的落点（端口文档 §支点）。
   */
  runCas: `UPDATE run SET json = ? WHERE id = ? AND status = ?`,
  runHoldingDir: `SELECT json FROM run
     WHERE work_dir = ? AND status IN (${ACTIVE_STATUS_PLACEHOLDERS})
     ORDER BY rowid LIMIT 1`,
  runHoldingDirExcept: `SELECT json FROM run
     WHERE work_dir = ? AND status IN (${ACTIVE_STATUS_PLACEHOLDERS}) AND id <> ?
     ORDER BY rowid LIMIT 1`,
  runActiveForSubject: `SELECT json FROM run
     WHERE agent_id = ? AND subject_type = ? AND subject_id = ?
       AND status IN (${ACTIVE_STATUS_PLACEHOLDERS})
     ORDER BY rowid LIMIT 1`,

  // ── Issue 的 CAS：注意没有状态机校验，与文件适配器一致 ──
  issueGet: `SELECT json, status FROM issue WHERE id = ?`,
  issueCas: `UPDATE issue SET json = ? WHERE id = ? AND status = ?`,

  /**
   * ── 列表：游标是"上一页最后一条的 id"，`id > ?` 即"从它之后开始" ──
   *
   * 游标那条还在不在都成立：> 全部 ⇒ 空页（调用方据此终止），< 全部 ⇒ 从头。
   * 文件适配器现在是同一套判定（它原先用 `findIndex(id === cursor) + 1`，
   * 游标不存在时会退回起点、让客户端在第一页上打转）。
   *
   * ⚠️ 一个**已知且不可达**的差异，写在这里免得后人重新发现一遍：
   * `ORDER BY id` 用的是 SQLite 的 BINARY 排序规则（UTF-8 字节序），而 JS 的
   * `<` / `>` 比的是 UTF-16 代码单元。两者只在 id 含 **U+FFFF 以上**的字符
   * （星平面，如 emoji）时不同：`U+1F600` 的代码单元是 `D83D DE00`（小于
   * `U+FFFD`），UTF-8 字节却是 `F0 9F 98 80`（大于 `EF BF BD`）。实测两边顺序
   * 因此相反。不修它，是因为端口的游标约定就是"ULID，天然可排序"——ULID 是
   * ASCII，此时两种序完全一致；而要在 SQL 侧对齐 UTF-16 顺序，就得存一列
   * 手工算出来的排序键，那正是本文件开头反对的"双份真相"，代价换不到任何
   * 可达场景。`sqlite-store.test.ts` 里有一条测试把这个已知差异钉住了。
   */
  issueList: `SELECT json FROM issue
     WHERE workspace_id = ?1
       AND (?2 IS NULL OR status IN (SELECT value FROM json_each(?2)))
       AND (?3 IS NULL OR assignee_id = ?3)
       AND id > ?4
     ORDER BY id`,
  runList: `SELECT json FROM run
     WHERE workspace_id = ?1
       AND (?2 IS NULL OR status IN (SELECT value FROM json_each(?2)))
       AND (?3 IS NULL OR agent_id = ?3)
       AND id > ?4
     ORDER BY id`,

  // ── Report 去重 ──
  reportDedup: `SELECT json FROM report WHERE dedup_key = ? ORDER BY rowid LIMIT 1`,
  /**
   * 第一个 ON CONFLICT 管去重键，第二个管"同一个 id 再写一次"。
   *
   * SQLite 允许多个 upsert 子句，按顺序匹配，这正好把文件适配器的两条规则
   * 一次说完：去重键已存在 ⇒ `DO NOTHING`，`changes = 0` ⇒ 返回 false
   * （幂等，不是错误）；否则按 id 覆盖（与文件适配器"同一 id 再写一次是覆盖"
   * 一致）。
   *
   * ⚠️ 有一处**有意的偏离**：同一个 id 带着**新**去重键再写一次时，这里的
   * 旧键会随之失效（生成列始终等于实体自己的去重键），而文件适配器的去重
   * 映射只增不减，旧键会继续指向那条 report。实践中不可达——report 的 id 是
   * ULID、去重键是内容摘要，同一个 id 换键意味着"同一条 ULID 的内容变了"。
   * 与其复制那份"永远指向过去"的映射，不如保住"查到的就是那条键的 report"。
   */
  reportInsert: `INSERT INTO report(id, workspace_id, json) VALUES(?, ?, ?)
     ON CONFLICT(workspace_id, dedup_key) DO NOTHING
     ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, json = excluded.json`,

  // ── Verdict / Action ──
  verdictGet: `SELECT json, status FROM verdict WHERE id = ?`,
  verdictCas: `UPDATE verdict SET json = ? WHERE id = ? AND status = ?`,
  actionGet: `SELECT json, status FROM action WHERE id = ?`,
  actionCas: `UPDATE action SET json = ? WHERE id = ? AND status = ?`,
  /**
   * `ORDER BY rowid DESC LIMIT 1`：文件适配器的幂等映射是"最后写入者赢"，
   * 重开后按日志顺序回放重建，同样是最后一条赢。这里用插入顺序的倒序对齐它。
   */
  actionIdempotency: `SELECT json FROM action WHERE idempotency_key = ? ORDER BY rowid DESC LIMIT 1`,

  // ── 按外键列的列表（排序与文件适配器的 JS 稳定排序一致：时间相同则按插入顺序）──
  commentsByIssue: `SELECT json FROM comment WHERE issue_id = ? ORDER BY created_at, rowid`,
  /**
   * 删任务（issue）时遍历全部 run、按 subject 链判定归属（与文件适配器同一个
   * 判据：执行 run 的 subject 是 issue，审核 run 的 subject 是它审的那条执行
   * run，最多 3 层）。`runsBySubjectIssue` 只匹配第一层，会漏掉审核 run——
   * 所以这里取全表在内存里判定，删除是罕见操作，量级无所谓。
   */
  runsAll: `SELECT json FROM run ORDER BY rowid`,
  /** 删任务时连带删掉它的评论。 */
  commentsDeleteByIssue: `DELETE FROM comment WHERE issue_id = ?`,
  verdictsByRun: `SELECT json FROM verdict WHERE run_id = ? ORDER BY created_at, rowid`,
  actionsByVerdict: `SELECT json FROM action WHERE verdict_id = ? ORDER BY created_at, rowid`,
  artifactsByRun: `SELECT json FROM artifact WHERE run_id = ? ORDER BY created_at, rowid`,
  auditsByRun: `SELECT json FROM audit WHERE run_id = ? ORDER BY queued_at, rowid`,

  // ── Conversation 与 ChatTurn（聊天）──

  /**
   * 列表：`sort_at` 就是 `lastTurnAt ?? createdAt`（见建表处），倒序。
   *
   * `id DESC` 是**同键兜底**，不是可有可无的：两个对话同一毫秒建的（或同一
   * 毫秒说过话的）若不兜底，顺序就由扫描顺序决定，使用者会以为顺序有含义。
   *
   * ⚠️ 一处**已知且不可达**的差异，与上面 `issueList` 那条同源：`id DESC` 用的
   *    是 SQLite 的 BINARY 排序规则（UTF-8 字节序），文件适配器比的是 JS 的
   *    UTF-16 代码单元。两者只在 id 含 U+FFFF 以上的字符（星平面）时相反。
   *    端口的 id 是 ULID（ASCII），此时两种序完全一致；不为了对齐 UTF-16 去
   *    存一列手工算出来的排序键——那是本文件开头反对的"双份真相"。
   */
  conversationList: `SELECT json FROM conversation
     WHERE workspace_id = ?
     ORDER BY sort_at DESC, id DESC`,

  /**
   * 回合列表：按 `seq` **升序**，同 seq 时按插入顺序（rowid）。
   *
   * 不按时间排：同一个时间戳下连着两轮时，时间分不出先后。文件适配器那边是
   * JS 的 `Array#sort`（ES2019 起稳定），稳定的语义正是"同 seq 保持写入顺序"，
   * 所以这里补 `rowid` 才能逐项对上。
   */
  chatTurnsByConversation: `SELECT json FROM chat_turn
     WHERE conversation_id = ?
     ORDER BY seq, rowid`,

  /**
   * "上一轮是谁"：`seq` 最大的那条**带 run 的**轮次。
   *
   * ★ 不能写成"取最后一条，如果它没 run 就返回 null"：最后一轮可能因为没抢到
   *   并发槽位而没有 run（那是合法状态），此时要往回**再找一条**，否则聊天会
   *   莫名其妙丢掉上文。`seq DESC, rowid DESC` 与文件适配器"从后往前走，
   *   返回第一条 runId 非空的"逐项等价。
   *
   * `run_id <> ''` 不是多余的：文件适配器写的是 `if (t.runId)`，那是**真假值**
   * 判断，空字符串在那边是假值。`RunId` 的 schema 是 `z.string()`（没有 `.min(1)`），
   * 所以 `''` 在类型上是个合法值——不写这一条，两种存储对同一条记录会给出
   * 不同的答案。真实 ULID 永远非空，这条是给"类型允许"兜底。
   */
  chatTurnLastWithRun: `SELECT json FROM chat_turn
     WHERE conversation_id = ? AND run_id IS NOT NULL AND run_id <> ''
     ORDER BY seq DESC, rowid DESC
     LIMIT 1`,

  /**
   * 删对话时**连带删掉它的轮次**。
   *
   * ★ 顺序不能反（先轮次、后对话）。中途失败时，留下的若是"指向不存在对话的
   *   轮次"，那些记录**没有任何入口能看见**（轮次列表按对话走），却会在下次
   *   "我到底说了什么"的时候对不上——看不见的脏数据比看得见的报错难查得多。
   *
   * ⚠️ 带上 `workspace_id`，而不是只按 `conversationId` 删：文件适配器是在
   *   **找到那个对话的 workspace** 里遍历轮次再删的，所以一条 `workspace_id`
   *   与对话不一致的轮次（写入路径不会产生这种数据）两边都会留下。
   *   "顺手删得更干净"在这里是错的——两个适配器对同一串操作必须给出同样的结果。
   *
   * 那条 run **留着**：它是审计记录（成本、日志、工作目录的归属都挂在它身上），
   * 而且它的产出与聊天记录是同一份东西——删掉 run 等于把"这次对话真的发生过"
   * 一起删了。端口文档里也是这么写的。
   */
  chatTurnsDeleteByConversation: `DELETE FROM chat_turn
     WHERE workspace_id = ? AND conversation_id = ?`,

  // ── deleteRun 的连带删除（与文件适配器同一串操作，见 `Store.deleteRun`）──

  /** 哪些对话的轮次引用了这条 run：删轮次后要重算它们的 `turnCount`。 */
  chatTurnsByRun: `SELECT json FROM chat_turn WHERE run_id = ? ORDER BY seq, rowid`,
  /** 删掉引用这条 run 的轮次（那一轮的内容就是 run 的 messages，run 没了轮次只剩半句话）。 */
  chatTurnsDeleteByRun: `DELETE FROM chat_turn WHERE run_id = ?`,
  /** 重算对话轮数用的计数。 */
  chatTurnsCountByConversation: `SELECT COUNT(*) AS n FROM chat_turn WHERE conversation_id = ?`,
  /** action 挂在 verdict 上：先删 action（按这些 verdict 的 id）再删 verdict。 */
  actionsDeleteByRunVerdicts: `DELETE FROM action
     WHERE verdict_id IN (SELECT id FROM verdict WHERE run_id = ?)`,
  verdictsDeleteByRun: `DELETE FROM verdict WHERE run_id = ?`,
  artifactsDeleteByRun: `DELETE FROM artifact WHERE run_id = ?`,
  runMessagesDeleteByRun: `DELETE FROM run_message WHERE run_id = ?`,

  skillsByIds: `SELECT json FROM skill
     WHERE id IN (SELECT value FROM json_each(?))
     ORDER BY rowid`,

  /**
   * 按 slug 取包。**必须带上 workspace_id**：slug 只在一个 workspace 内唯一，
   * 两个空间各有一个 `deploy` 是合法的；不带这一条会把别的空间的包交给调用方，
   * 而判决里写的 `<slug>.<动作名>` 就指向了一个根本不是它声明过的包。
   *
   * `ORDER BY rowid LIMIT 1`：万一同一个 workspace 里真装了两个同 slug 的包
   * （端口没有约束它），取最早装的那个——与文件适配器"找第一条匹配"的确定性
   * 保持一致，而不是让 SQLite 的扫描顺序决定结果。
   */
  toolBySlug: `SELECT json FROM tool
     WHERE workspace_id = ? AND slug = ?
     ORDER BY rowid LIMIT 1`,

  toolsByIds: `SELECT json FROM tool
     WHERE id IN (SELECT value FROM json_each(?))
     ORDER BY rowid`,

  // ── 消息流 ──
  messageInsert: `INSERT INTO run_message(run_id, seq, json) VALUES(?, ?, ?)`,
  messagesSince: `SELECT json FROM run_message WHERE run_id = ? AND seq > ? ORDER BY seq, rowid`,
  messageLastSeq: `SELECT MAX(seq) AS last FROM run_message WHERE run_id = ?`,

  // ── 内容寻址 ──
  blobPut: `INSERT INTO blob(ref, bytes) VALUES(?, ?) ON CONFLICT(ref) DO NOTHING`,
  blobGet: `SELECT bytes FROM blob WHERE ref = ?`,
  blobHas: `SELECT 1 AS present FROM blob WHERE ref = ?`,

  // ── 通知中心 ──
  inboxGet: `SELECT json FROM inbox WHERE id = ?`,
  inboxMarkRead: `UPDATE inbox SET json = ? WHERE id = ?`,
  /** 默认只列未读，且按时间倒序、条数封顶（INV-8：通知必须稀缺）。 */
  inboxUnread: `SELECT json FROM inbox
     WHERE workspace_id = ? AND is_read = 0
     ORDER BY created_at DESC, rowid LIMIT ?`,
  inboxAll: `SELECT json FROM inbox
     WHERE workspace_id = ?
     ORDER BY created_at DESC, rowid LIMIT ?`,
} as const

type NamedStmt = keyof typeof NAMED_SQL

/** 通用语句：按表名拼键。表名来自编译期常量，不可能是注入点。 */
function derivedSql(): Record<string, string> {
  const out: Record<string, string> = {}
  // `group` 是 SQL 保留字：拼语句时必须加引号（CREATE TABLE 那侧已经引了）。
  // 键名仍用裸名（`get:group`），只有 SQL 里的表名带引号。
  const q = (t: string): string => (t === 'group' ? '"group"' : t)
  for (const t of ALL_TABLES) out[`count:${t}`] = `SELECT count(*) AS n FROM ${q(t)}`
  for (const t of [...ENTITY_TABLES, 'report'] as const) {
    out[`get:${t}`] = `SELECT json FROM ${q(t)} WHERE id = ?`
  }
  for (const t of GENERAL_PUT_TABLES) {
    /**
     * 用 upsert 而不是 INSERT：文件适配器是追加式日志，"同一个 id 再写一次"
     * 是覆盖（最后一条赢），不是报错。端口里没有"仅插入一次"的语义——
     * 唯一的例外是 report 的去重键，那条单独处理。
     */
    out[`put:${t}`] = `INSERT INTO ${q(t)}(id, workspace_id, json) VALUES(?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, json = excluded.json`
  }
  for (const t of GENERAL_PUT_TABLES) {
    // 与 put 对称的一条：删掉就真的删掉（sqlite 是就地更新的，不像文件适配器
    // 那样要追加一条 del 记录再等 compact）——D38 加，用于卸载 skill。
    out[`del:${t}`] = `DELETE FROM ${q(t)} WHERE id = ?`
  }
  for (const t of WORKSPACE_LIST_TABLES) {
    out[`listByWorkspace:${t}`] = `SELECT json FROM ${q(t)} WHERE workspace_id = ? ORDER BY rowid`
  }
  return out
}

const ALL_SQL: Record<string, string> = { ...NAMED_SQL, ...derivedSql() }

// ─────────────────────────────────────────────────────────────
// 适配器
// ─────────────────────────────────────────────────────────────

export class SqliteStore implements Store {
  readonly #dataDir: string
  readonly #path: string
  readonly #db: DatabaseSync
  readonly #version: number
  /** 键 → 预热好的语句。open() 时全部装好，运行期只取不建。 */
  readonly #stmts = new Map<string, StatementSync>()
  #closed = false

  private constructor(dataDir: string, path: string, db: DatabaseSync, version: number) {
    this.#dataDir = dataDir
    this.#path = path
    this.#db = db
    this.#version = version
  }

  static async open(options: SqliteStoreOptions): Promise<SqliteStore> {
    const dataDir = options.dataDir
    const fileName = options.fileName ?? SQLITE_FILE_NAME
    const fsync = options.fsync ?? true

    mkdirSync(dataDir, { recursive: true })
    const path = join(dataDir, fileName)
    const db = new DatabaseSync(path)

    try {
      /**
       * WAL：读不阻塞写、写不阻塞读，崩溃后靠 WAL 恢复。相比"每次追加都
       * fsync 一个日志文件"，这是数据库这边最主要的收益。
       */
      db.exec('PRAGMA journal_mode = WAL')
      db.exec(`PRAGMA synchronous = ${fsync ? 'FULL' : 'NORMAL'}`)
      /**
       * 另一个进程正在写时等一会儿再重试，而不是立刻抛 SQLITE_BUSY。
       * 本项目仍然只建议跑一个 daemon（NFR-D-05），但"两个进程撞上"
       * 不应该表现为一个随机失败。
       */
      db.exec('PRAGMA busy_timeout = 5000')

      /**
       * ★ 别把别人的数据库当成自己的空库。
       *
       * `CREATE TABLE IF NOT EXISTS meta` 是无害的，但如果文件里已经有别的表、
       * 却没有 meta，那它就不是本程序的库——此时**必须拒绝打开**。默默建一张
       * meta 表然后往里写，等于把使用者的另一个 SQLite 库当成"新库"接管了。
       * 空文件（刚建的新库）没有任何表，会被正常放行。
       */
      if (hasForeignTables(db)) {
        throw new Error(
          `打不开 ${path}：它不像是本程序写出的存储文件（已有别的表，但没有 meta 表）`,
        )
      }
      for (const sql of META_SCHEMA) db.exec(sql)
      const stored = readStoredFormatVersion(db, path)
      if (stored !== null && stored > SQLITE_STORE_FORMAT_VERSION) {
        throw new Error(
          `数据库的存储格式版本为 ${stored}，高于本程序支持的 ${SQLITE_STORE_FORMAT_VERSION}。` +
            `请升级程序，不要用旧版本打开新数据。`,
        )
      }

      const store = new SqliteStore(dataDir, path, db, stored ?? SQLITE_STORE_FORMAT_VERSION)
      store.#createSchema()
      store.#prepare()
      store.#warmUp()
      if (stored === null) {
        store.#named('metaPut').run(FORMAT_VERSION_KEY, String(SQLITE_STORE_FORMAT_VERSION))
      }
      return store
    } catch (err) {
      /**
       * ★ 打开失败必须把句柄关掉。
       *
       * "版本过高 ⇒ 拒绝打开"这条路径上不关句柄的话，使用者在同一个进程里
       * 修好数据再打开会撞上文件锁，报出来的错会指向一个完全无关的地方——
       * 排查方向被错误信息带偏是最贵的一种 bug。
       */
      try {
        db.close()
      } catch {
        // 已经关掉了：忽略
      }
      throw err
    }
  }

  /** 数据库文件路径（运维/测试用：备份、直接检查都从它开始；也是测试里开第二个连接的位置）。 */
  get path(): string {
    return this.#path
  }

  /** 数据目录（运维用：与 `path` 一起定位 WAL 的两个附属文件）。 */
  get dataDir(): string {
    return this.#dataDir
  }

  /** 建表与建索引。**急切**执行，不留到首次写入。 */
  #createSchema(): void {
    for (const sql of SCHEMA) this.#db.exec(sql)
  }

  /** 预热全部语句：schema 与 SQL 对不上时在 open 就炸。 */
  #prepare(): void {
    for (const [key, sql] of Object.entries(ALL_SQL)) {
      this.#stmts.set(key, this.#db.prepare(sql))
    }
  }

  /**
   * ★ 把每张表真读一次。
   *
   * 文件适配器那次"数据看起来丢了"的教训（懒建 per-workspace 存储，导致
   * 重开后跨 workspace 查询全空）在本适配器里结构上已经不可能发生——没有
   * 需要重建的内存索引。但读一遍仍然值得：文件损坏、表缺失、schema 对不上
   * 这类问题会在 **open 时当场报错**，而不是等使用者点了某个按钮才发现。
   *
   * 没有做 `PRAGMA integrity_check`：那是 O(库大小) 的全库校验，本机单用户
   * 的库虽然不大，但每次启动都全扫一遍不划算，拿来换上面这次逐表探测更值。
   */
  #warmUp(): void {
    for (const table of ALL_TABLES) this.#stmt(`count:${table}`).get()
  }

  #named(name: NamedStmt): StatementSync {
    return this.#stmt(name)
  }

  #stmt(key: string): StatementSync {
    if (this.#closed) throw new Error('存储已关闭')
    const stmt = this.#stmts.get(key)
    if (!stmt) {
      // 走到这里说明有人绕过了 open() 的预热，属于本适配器的内部错误
      throw new Error(`存储内部错误：语句 ${key} 未在 open() 时预热`)
    }
    return stmt
  }

  #parse<T>(row: { json: string } | undefined): T | null {
    return row ? (JSON.parse(row.json) as T) : null
  }

  #getEntity<T>(table: EntityTable | 'report', id: string): T | null {
    return this.#parse<T>(this.#stmt(`get:${table}`).get(id) as { json: string } | undefined)
  }

  #putEntity(table: EntityTable, id: string, workspaceId: WorkspaceId, entity: unknown): void {
    this.#stmt(`put:${table}`).run(id, workspaceId as string, JSON.stringify(entity))
  }

  #listByWorkspace<T>(table: (typeof WORKSPACE_LIST_TABLES)[number], workspaceId: WorkspaceId): T[] {
    return (this.#stmt(`listByWorkspace:${table}`).all(workspaceId as string) as { json: string }[]).map(
      (r) => JSON.parse(r.json) as T,
    )
  }

  /**
   * 游标分页。与文件适配器的 `paginate` 同一套判定：
   *
   * - 排序由 SQL 的 `ORDER BY id` 完成（两者都是 id 升序）；
   * - 起点是"**id 大于游标**"的第一条，与游标那条还在不在无关；
   * - `nextCursor` 是**本页最后一条**的 id，且仅当后面还有内容时非 null。
   *
   * 游标那条不见了（被过滤掉、来自别的 workspace、或者干脆是垃圾值）时，
   * 判定必须依然成立：大于全部 ⇒ 空页 + `nextCursor = null`（终止翻页），
   * 小于全部 ⇒ 从头返回。**两边现在都是这么做的**——文件适配器曾经用
   * `findIndex(id === cursor) + 1`，游标不存在时起点会退回 0，客户端于是
   * 在第一页上永远打转；那条已经按"id 大于游标"改掉了，所以差分测试
   * 在**所有**游标情形下逐项对比，不再给这条分歧让路。
   */
  #page<T extends { id: string }>(rows: T[], limit: number): Page<T> {
    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    const last = items[items.length - 1]
    return { items, nextCursor: hasMore && last ? last.id : null }
  }

  /**
   * 四个 `transition*` 共用的 CAS 骨架。
   *
   * 顺序是**刻意的**，不能调换：
   *
   *   1. 找不到 / 前态不匹配 ⇒ 直接返回 false（静默，不抛）；
   *   2. 前态匹配但目标是非法状态 ⇒ 跑领域层的状态机校验并**当场抛**。
   *
   * 反过来的话，"前态不匹配"也会顺带跑状态机，于是一个本来应该安静返回
   * false 的调用会因为"expect → next 不合法"而抛错——把并发下的正常失败
   * 变成异常。文件适配器也是这个顺序。
   */
  #cas(
    getStmt: NamedStmt,
    casStmt: NamedStmt,
    id: string,
    expect: string,
    // 用 object 而不是 Record<string, unknown>：RunPatch / ActionPatch 是 interface，
    // 没有隐式索引签名，收窄成 Record 会让调用方编译不过
    patch: object,
    extra: object,
    guard?: () => void,
  ): boolean {
    // ⚠️ 从这里到 .run() 之间不能出现 await：整个"读前态 → 校验 → 写"必须
    //    在同一个事件循环片段里跑完，进程内才不可能被别的调用插进来。
    const row = this.#named(getStmt).get(id) as { json: string; status: string } | undefined
    if (!row) return false
    if (row.status !== expect) return false
    guard?.()
    const merged = {
      ...(JSON.parse(row.json) as Record<string, unknown>),
      ...pruneUndefined(patch),
      ...pruneUndefined(extra),
    }
    const result = this.#named(casStmt).run(JSON.stringify(merged), id, expect)
    return Number(result.changes) > 0
  }

  // ── 生命周期 ──

  async formatVersion(): Promise<number> {
    return this.#version
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#stmts.clear()
    this.#db.close()
  }

  // ── Workspace 与 Device ──

  async getWorkspace(id: WorkspaceId): Promise<Workspace | null> {
    return this.#parse<Workspace>(
      this.#named('workspaceGet').get(id as string) as { json: string } | undefined,
    )
  }

  async insertWorkspace(ws: Workspace): Promise<void> {
    this.#named('workspacePut').run(ws.id as string, JSON.stringify(ws))
  }

  async listWorkspaceIds(): Promise<WorkspaceId[]> {
    const rows = this.#named('workspaceIds').all() as { id: string }[]
    return rows.map((r) => r.id as WorkspaceId)
  }

  async getDevice(): Promise<Device | null> {
    return this.#parse<Device>(this.#named('deviceGet').get() as { json: string } | undefined)
  }

  async upsertDevice(device: Device): Promise<void> {
    this.#named('devicePut').run(JSON.stringify(device))
  }

  // ── Agent ──

  // ⚠️ 与文件存储同一个判据：agent 读取的唯一总闸，撤掉的字段（老记录里还留着）
  //    在**读**这一层就摘掉，见 `stripLegacyAgentFields`。
  async getAgent(id: AgentId): Promise<Agent | null> {
    const found = this.#getEntity<Agent>('agent', id as string)
    return found ? cleanAgent(found) : null
  }

  async listAgents(workspaceId: WorkspaceId): Promise<Agent[]> {
    return this.#listByWorkspace<Agent>('agent', workspaceId).map(cleanAgent)
  }

  // 未经清理的那一份（`json` 列里存的是什么就是什么）：只给启动时的老记录清理用
  // ——它要删的正是读时兜底藏起来的那几个键，用 `listAgents` 就永远判不出"需要清"。
  async listAgentsRaw(workspaceId: WorkspaceId): Promise<Agent[]> {
    return this.#listByWorkspace<Agent>('agent', workspaceId)
  }

  async insertAgent(agent: Agent): Promise<void> {
    this.#putEntity('agent', agent.id as string, agent.workspaceId, agent)
  }

  async deleteAgent(id: AgentId): Promise<boolean> {
    const res = this.#stmt('del:agent').run(id as string)
    return Number(res.changes) > 0
  }

  // ── AgentGroup（智能体组，D70 增量添加）──

  async getGroup(id: AgentGroupId): Promise<AgentGroup | null> {
    return this.#getEntity<AgentGroup>('group', id as string)
  }

  async listGroups(workspaceId: WorkspaceId): Promise<AgentGroup[]> {
    return this.#listByWorkspace<AgentGroup>('group', workspaceId)
  }

  async listGroupsByAgent(agentId: AgentId): Promise<AgentGroup[]> {
    const rows = this.#stmt('groupListByAgent').all(agentId as string) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as AgentGroup)
  }

  async insertGroup(group: AgentGroup): Promise<void> {
    this.#putEntity('group', group.id as string, group.workspaceId, group)
  }

  async updateGroup(group: AgentGroup): Promise<boolean> {
    // sqlite 的 upsert 无法可靠区分"更新"与"插入"（`changes` 对两路径取值
    // 不一致），所以先查存在性。同一进程内 `DatabaseSync` 是同步的，`get` 与
    // `put` 之间没有 await，不存在并发窗口。
    if (this.#getEntity<AgentGroup>('group', group.id as string) === null) return false
    this.#putEntity('group', group.id as string, group.workspaceId, group)
    return true
  }

  async deleteGroup(id: AgentGroupId): Promise<boolean> {
    const res = this.#stmt('del:group').run(id as string)
    return res.changes > 0
  }

  // ── Skill ──

  async getSkill(id: SkillId): Promise<Skill | null> {
    return this.#getEntity<Skill>('skill', id as string)
  }

  async listSkills(workspaceId: WorkspaceId): Promise<Skill[]> {
    return this.#listByWorkspace<Skill>('skill', workspaceId)
  }

  async listSkillsByIds(ids: readonly SkillId[]): Promise<Skill[]> {
    // IN () 是语法错误：空集合必须提前返回，不能指望 SQLite 容忍
    if (ids.length === 0) return []
    const rows = this.#named('skillsByIds').all(JSON.stringify(ids)) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as Skill)
  }

  async insertSkill(skill: Skill): Promise<void> {
    this.#putEntity('skill', skill.id as string, skill.workspaceId, skill)
  }

  async deleteSkill(id: SkillId): Promise<boolean> {
    const res = this.#stmt('del:skill').run(id as string)
    // `changes` 是 sqlite 给的"真的删到了几行"——它比"先查再删"少一次竞态
    return Number(res.changes) > 0
  }

  // ── Tool（工具包 / 组，D40）──

  async getTool(id: ToolId): Promise<Tool | null> {
    return this.#getEntity<Tool>('tool', id as string)
  }

  async listTools(workspaceId: WorkspaceId): Promise<Tool[]> {
    return this.#listByWorkspace<Tool>('tool', workspaceId)
  }

  async listToolsByIds(ids: readonly ToolId[]): Promise<Tool[]> {
    // IN () 是语法错误：空集合必须提前返回，不能指望 SQLite 容忍
    if (ids.length === 0) return []
    const rows = this.#named('toolsByIds').all(JSON.stringify(ids)) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as Tool)
  }

  async getToolBySlug(workspaceId: WorkspaceId, slug: string): Promise<Tool | null> {
    return this.#parse<Tool>(
      this.#named('toolBySlug').get(workspaceId as string, slug) as { json: string } | undefined,
    )
  }

  async insertTool(tool: Tool): Promise<void> {
    this.#putEntity('tool', tool.id as string, tool.workspaceId, tool)
  }

  async deleteTool(id: ToolId): Promise<boolean> {
    // 与 deleteSkill 一样看 `changes`：文件适配器的 `del` 对不存在的 id 返回
    // false，这里用"真的删到了几行"对齐那个语义（删两次第二次是 false，不是错）
    const res = this.#stmt('del:tool').run(id as string)
    return Number(res.changes) > 0
  }

  // ── Issue 与 Comment ──

  async getIssue(id: IssueId): Promise<Issue | null> {
    return this.#getEntity<Issue>('issue', id as string)
  }

  async listIssues(q: IssueQuery): Promise<Page<Issue>> {
    const rows = this.#named('issueList').all(
      q.workspaceId as string,
      q.status?.length ? JSON.stringify(q.status) : null,
      q.assigneeId || null,
      q.cursor || '',
    ) as { json: string }[]
    let items = rows.map((r) => JSON.parse(r.json) as Issue)

    /**
     * 检索放在 JS 里做，**不推给 SQL**。
     *
     * SQLite 的 `LIKE` 与 `lower()` 只对 ASCII 做大小写折叠，而这里用的是
     * JS 的 `toLowerCase()`（Unicode 感知）。推到 SQL 会让非 ASCII 标题的
     * 匹配结果**静默改变**——换个存储就换了一套检索语义，这正是端口要防的事。
     * 规模上也无所谓：与文件适配器同样是扫一个 workspace 的 issue。
     */
    if (q.search) {
      const needle = q.search.toLowerCase()
      items = items.filter(
        (i) => i.title.toLowerCase().includes(needle) || i.description.toLowerCase().includes(needle),
      )
    }
    return this.#page(items, q.limit ?? 50)
  }

  async insertIssue(issue: Issue): Promise<void> {
    this.#putEntity('issue', issue.id as string, issue.workspaceId, issue)
  }

  async transitionIssue(
    id: IssueId,
    expect: Issue['status'],
    next: Issue['status'],
    patch: Partial<Pick<Issue, 'assignee' | 'labels' | 'priority' | 'title' | 'description'>> = {},
  ): Promise<boolean> {
    /**
     * 这里**没有**状态机校验：issue 的状态机在领域层还没有对应的 `assert*`
     * （run / verdict / action 都有），文件适配器同样不校验。不在这里自造
     * 一套规则——两份状态机比没有状态机更糟。
     */
    return this.#cas('issueGet', 'issueCas', id as string, expect, patch, {
      status: next,
      updatedAt: Date.now(),
    })
  }

  async listComments(issueId: IssueId): Promise<Comment[]> {
    const rows = this.#named('commentsByIssue').all(issueId as string) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as Comment)
  }

  async insertComment(comment: Comment): Promise<void> {
    this.#putEntity('comment', comment.id as string, comment.workspaceId, comment)
  }

  // ── Conversation 与 ChatTurn（聊天）──

  async getConversation(id: ConversationId): Promise<Conversation | null> {
    /**
     * 按 id 直接取，**不带 workspace_id**：文件适配器的 `getConversation` 是
     * 遍历所有 workspace 的内存索引找个遍（它不知道调用方想问哪个空间）。
     * id 是 ULID、全局唯一，所以"全局按 id 取一条"与那个遍历逐项等价。
     */
    return this.#getEntity<Conversation>('conversation', id as string)
  }

  async listConversations(workspaceId: WorkspaceId): Promise<Conversation[]> {
    const rows = this.#named('conversationList').all(workspaceId as string) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as Conversation)
  }

  async insertConversation(conversation: Conversation): Promise<void> {
    this.#putEntity(
      'conversation',
      conversation.id as string,
      conversation.workspaceId,
      conversation,
    )
  }

  /**
   * ★ 找不到时返回 `null`——不是抛错，也不是静默成功。
   *
   * 这一条是端口明确要求的，也是最容易写歪的地方：`UPDATE ... WHERE id = ?`
   * 在零行匹配时**什么都不说**，把它当成功返回会让调用方以为改名生效了。
   * 所以这里是"先读、没有就 null、有才写"，与文件适配器同构。
   *
   * ⚠️ 读与写之间**不能出现 `await`**（本文件所有方法体都守着这条，见文件头
   *    第 2 条取舍）：`DatabaseSync` 是同步的，一个方法体里不 await，进程内就
   *    不可能有另一个调用插进来改掉这条记录。
   *
   * patch 的合并是**原样的** `{ ...cur, ...patch }`，**不做 `pruneUndefined`**：
   * 这一点与 `transition*` 那四个方法刻意不同，因为文件适配器的
   * `updateConversation` 就是这么写的（那边只有 `transition*` 才 prune）。
   * 两边都保留"patch 里显式传 `undefined` ⇒ 该字段从落盘的 JSON 里消失"这个
   * 行为，免得同一个调用在两个适配器上得到不同的记录。
   */
  async updateConversation(
    id: ConversationId,
    patch: Partial<
      Pick<Conversation, 'title' | 'workDir' | 'updatedAt' | 'lastTurnAt' | 'turnCount'>
    >,
  ): Promise<Conversation | null> {
    const cur = this.#getEntity<Conversation>('conversation', id as string)
    if (!cur) return null
    const next = { ...cur, ...patch } as Conversation
    /**
     * 写回的 `workspace_id` 取 **`cur`** 的那个，不是 `next` 的。
     *
     * patch 的类型里没有 `workspaceId`，所以正常路径上两者相同。但万一运行时
     * 真塞进来一个（类型管不住 `as` 出来的对象），文件适配器是把记录留在**原来
     * 那个 workspace 的日志**里的——`listConversations` 仍然按原 workspace 列得
     * 到它。用 `cur.workspaceId` 才是同一个结果；用 `next` 的会让它从原
     * workspace 的列表里凭空消失，而新 workspace 里也查不到（`get` 是按 id 的）。
     */
    this.#putEntity('conversation', id as string, cur.workspaceId, next)
    return next
  }

  /**
   * 这个对话的回合，按 `seq` 升序。
   *
   * 签名里**没有 workspaceId**（端口就是这么定的）：`conversationId` 唯一确定
   * 一个对话，再要一个 workspace 只会多出一个可以对不上的参数。
   */
  async listChatTurns(conversationId: ConversationId): Promise<ChatTurn[]> {
    const rows = this.#named('chatTurnsByConversation').all(conversationId as string) as {
      json: string
    }[]
    return rows.map((r) => JSON.parse(r.json) as ChatTurn)
  }

  async insertChatTurn(turn: ChatTurn): Promise<void> {
    this.#putEntity('chat_turn', turn.id as string, turn.workspaceId, turn)
  }

  async lastChatTurnWithRun(conversationId: ConversationId): Promise<ChatTurn | null> {
    return this.#parse<ChatTurn>(
      this.#named('chatTurnLastWithRun').get(conversationId as string) as
        | { json: string }
        | undefined,
    )
  }

  /**
   * ★ 返回"真的删到了没有"，**不抛**。
   *
   * 本来就不在 ⇒ `false`（不是错误）：调用方按 id 删两次是合法的，第二次的
   * 正确答案是"没有可删的东西"，而不是一条异常。与 `deleteSkill` /
   * `deleteTool` 的语义一致。
   *
   * 先读一次再删，是为了对齐文件适配器里一条不显眼但真实的规则：**对话不存在
   * 时，它的轮次也不动**。文件适配器的实现是"找到对话才进那段删除逻辑"，
   * 所以一条没有对话的孤儿轮次不会被这里顺手删掉。若图省事写成"无条件按
   * conversation_id 删轮次 + 删对话"，返回值就对不上了（`false` 却删了东西）。
   *
   * 轮次与对话**都在同一个方法体内同步删完**，中间没有 `await`（见文件头第 2
   * 条取舍），所以不存在"删了一半"这种能被另一个调用观察到的中间态。
   */
  async deleteConversation(id: ConversationId): Promise<boolean> {
    const cur = this.#getEntity<Conversation>('conversation', id as string)
    if (!cur) return false
    this.#named('chatTurnsDeleteByConversation').run(cur.workspaceId as string, id as string)
    this.#stmt('del:conversation').run(id as string)
    return true
  }

  /**
   * 删掉一条 run 连同它派生的一切。连带范围与理由见端口文档
   * （`Store.deleteRun`）。与 `deleteConversation` 同一条约定：**方法体内同步
   * 删完、没有 `await`**，不存在可被观察到的中间态。
   */
  async deleteRun(id: RunId): Promise<boolean> {
    const run = this.#getEntity<Run>('run', id as string)
    if (!run) return false
    // ① 先找出引用这条 run 的轮次属于哪些对话（重算 turnCount 要用），再删轮次。
    const affected = this.#named('chatTurnsByRun').all(id as string) as { json: string }[]
    const convIds = [
      ...new Set(affected.map((r) => (JSON.parse(r.json) as ChatTurn).conversationId)),
    ]
    this.#named('chatTurnsDeleteByRun').run(id as string)
    for (const convId of convIds) {
      const conv = this.#getEntity<Conversation>('conversation', convId as string)
      if (!conv) continue
      const { n } = this.#named('chatTurnsCountByConversation').get(convId as string) as {
        n: number
      }
      this.#putEntity('conversation', convId as string, conv.workspaceId, {
        ...conv,
        turnCount: n,
        updatedAt: Date.now(),
      })
    }
    // ② verdict 与由它触发的 action（先 action 后 verdict）
    this.#named('actionsDeleteByRunVerdicts').run(id as string)
    this.#named('verdictsDeleteByRun').run(id as string)
    // ③ artifacts、④ 消息流、⑤ run 本体
    this.#named('artifactsDeleteByRun').run(id as string)
    this.#named('runMessagesDeleteByRun').run(id as string)
    this.#stmt('del:run').run(id as string)
    return true
  }

  /**
   * 删掉一条任务（issue）连同挂它名下的一切。连带范围见端口文档
   * （`Store.deleteIssue`）；与 `deleteRun` 同一条约定：方法体内同步删完。
   * 该 issue 上的 run（含审核链）逐个走 `deleteRun`（嵌套调用，SQLite 是同步
   * 执行的，不存在中间态）。
   */
  async deleteIssue(id: IssueId): Promise<boolean> {
    const cur = this.#getEntity<Issue>('issue', id as string)
    if (!cur) return false
    // ★ 先**收集**再删：判定"属于这条 issue"要靠 subject 链（审核 run 的 subject
    //   指向执行 run），若边删边判，执行 run 先消失会让后面审核 run 的链断掉、
    //   被当成"不属于"而漏删。
    const runs = this.#named('runsAll').all() as { json: string }[]
    const toDelete = runs
      .map((r) => JSON.parse(r.json) as Run)
      .filter((run) => this.#runBelongsToIssue(run, id))
    for (const run of toDelete) {
      await this.deleteRun(run.id)
    }
    this.#named('commentsDeleteByIssue').run(id as string)
    this.#stmt('del:issue').run(id as string)
    return true
  }

  /** 与文件适配器 / server 侧同一个判据：顺着 subject 链往上找，最多 3 层。 */
  #runBelongsToIssue(run: Run, issueId: IssueId): boolean {
    let cursor: Run | null = run
    for (let depth = 0; depth < 3 && cursor; depth++) {
      const subject: Run['subject'] = cursor.subject
      if (subject.type === 'issue') return subject.id === issueId
      if (subject.type !== 'run') return false
      cursor = this.#getEntity<Run>('run', subject.id as string)
    }
    return false
  }

  // ── Report ──

  /**
   * 列出报告（FR-STOR-05 的导出需要它）。
   *
   * 用与 agent / skill 同一套 `listByWorkspace` 机制，而不是另写一条 SQL：
   * 三个表的列举语义应当一致（按 rowid = 写入顺序，不做额外排序），
   * 各写各的最容易在分页边界上悄悄分叉。
   */
  async listReports(q: ReportQuery): Promise<Page<Report>> {
    /**
     * 这里**显式**按 id 排序并按游标的**位置**切片，而不是复用 `#page`。
     *
     * 理由是对齐：文件适配器的 `paginate()` 就是这么做的（按 id 排序 +
     * `findIndex(r => r.id > cursor)`），而 `#listByWorkspace` 是按 rowid
     * 排的。同一份数据在两个适配器上给出不同的翻页顺序，正是"差分对拍"
     * 要抓的那类分叉——尽管现在只有导出在用这个方法，分叉照样不该留。
     *
     * 游标按位置而不是按身份比较，理由与文件适配器那份相同：
     * 游标那条不在结果集里时，按身份查找会**静默重放第一页**。
     */
    const sorted = [...this.#listByWorkspace<Report>('report', q.workspaceId)].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )
    let start = 0
    if (q.cursor) {
      const cursor = q.cursor
      const idx = sorted.findIndex((r) => r.id > cursor)
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

  async findReportByDedupKey(dedupKey: string): Promise<Report | null> {
    /**
     * 去重键是"每个 workspace 内"唯一的（见 report_dedup 索引），所以跨
     * workspace 出现同一个键时，这里必须挑一条。文件适配器按"workspace 被
     * 打开的先后"挑，那个顺序本身取决于进程启动时的枚举，不确定；这里改成
     * 最早写入的那一条（`ORDER BY rowid`），至少是确定的。
     */
    return this.#parse<Report>(
      this.#named('reportDedup').get(dedupKey) as { json: string } | undefined,
    )
  }

  async getReport(id: Report['id']): Promise<Report | null> {
    return this.#getEntity<Report>('report', id as string)
  }

  /**
   * ★ 返回 false 表示去重键已存在——**由唯一索引判定，不是应用层判断**。
   *
   * 调用方（摄取流程）必须把 false 当作"已经处理过"，而不是"写入失败"。
   * 并发下两个进程同时插同一条 report，只有一个的 `changes` 是 1。
   */
  async insertReport(report: Report): Promise<boolean> {
    const result = this.#named('reportInsert').run(
      report.id as string,
      report.workspaceId as string,
      JSON.stringify(report),
    )
    return Number(result.changes) > 0
  }

  // ── Run ──

  async getRun(id: RunId): Promise<Run | null> {
    return this.#getEntity<Run>('run', id as string)
  }

  async listRuns(q: RunQuery): Promise<Page<Run>> {
    const rows = this.#named('runList').all(
      q.workspaceId as string,
      q.status?.length ? JSON.stringify(q.status) : null,
      q.agentId ? (q.agentId as string) : null,
      q.cursor || '',
    ) as { json: string }[]
    const items = rows.map((r) => JSON.parse(r.json) as Run)
    return this.#page(items, q.limit ?? 50)
  }

  async insertRun(run: Run): Promise<void> {
    this.#putEntity('run', run.id as string, run.workspaceId, run)
  }

  /**
   * ★ CAS 转移。
   *
   * 状态机校验用的是领域层的 `assertRunTransition`，不在这里抄一份转移表：
   * 抄一份就意味着将来领域层改了状态机，存储层会悄悄继续放行旧规则。
   */
  async transitionRun(
    id: RunId,
    expect: RunStatus,
    next: RunStatus,
    patch: RunPatch = {},
  ): Promise<boolean> {
    return this.#cas('runGet', 'runCas', id as string, expect, patch, { status: next }, () => {
      assertRunTransition(expect, next)
    })
  }

  async findRunHoldingWorkDir(workDir: string, excludeRunId?: RunId): Promise<Run | null> {
    // 活动状态集合直接来自领域层常量（见 ACTIVE_STATUS_PLACEHOLDERS）
    const active: string[] = [...ACTIVE_RUN_STATUSES]
    const stmt = excludeRunId ? this.#named('runHoldingDirExcept') : this.#named('runHoldingDir')
    const params = excludeRunId
      ? [workDir, ...active, excludeRunId as string]
      : [workDir, ...active]
    return this.#parse<Run>(stmt.get(...params) as { json: string } | undefined)
  }

  async findActiveRunForSubjectAgent(subject: SubjectRef, agentId: AgentId): Promise<Run | null> {
    const active: string[] = [...ACTIVE_RUN_STATUSES]
    return this.#parse<Run>(
      this.#named('runActiveForSubject').get(
        agentId as string,
        subject.type,
        subject.id,
        ...active,
      ) as { json: string } | undefined,
    )
  }

  // ── Run 的消息流 ──

  async appendRunMessage(runId: RunId, message: RunMessage): Promise<void> {
    this.#requireRun(runId)
    this.#named('messageInsert').run(runId as string, message.seq, JSON.stringify(message))
  }

  async listRunMessages(runId: RunId, since = -1): Promise<RunMessage[]> {
    this.#requireRun(runId)
    const rows = this.#named('messagesSince').all(runId as string, since) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as RunMessage)
  }

  async lastRunMessageSeq(runId: RunId): Promise<number> {
    this.#requireRun(runId)
    const row = this.#named('messageLastSeq').get(runId as string) as { last: number | null }
    // 没有消息时 -1：与文件适配器一致（它是从 -1 起算的），不是 0
    return row.last ?? -1
  }

  /**
   * 消息必须挂在一个已知 run 上。
   *
   * 文件适配器在这里**抛错而不是静默丢弃**——静默丢弃会让消息流的空洞
   * 出现在很久以后（页面补齐时才发现少了消息），那时已经无从追查。
   * 报错至少把问题钉在写入的这一刻。
   */
  #requireRun(runId: RunId): void {
    if (!this.#named('runExists').get(runId as string)) {
      throw new Error(`找不到 run ${runId}（消息流必须挂在一个已知 run 上）`)
    }
  }

  // ── Verdict ──

  async getVerdict(id: VerdictId): Promise<VerdictRecord | null> {
    return this.#getEntity<VerdictRecord>('verdict', id as string)
  }

  async listVerdictsByRun(runId: RunId): Promise<VerdictRecord[]> {
    const rows = this.#named('verdictsByRun').all(runId as string) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as VerdictRecord)
  }

  async insertVerdict(verdict: VerdictRecord): Promise<void> {
    this.#putEntity('verdict', verdict.id as string, verdict.workspaceId, verdict)
  }

  async transitionVerdict(
    id: VerdictId,
    expect: VerdictStatus,
    next: VerdictStatus,
    patch: Partial<Pick<VerdictRecord, 'invalidResolution'>> = {},
  ): Promise<boolean> {
    return this.#cas('verdictGet', 'verdictCas', id as string, expect, patch, { status: next }, () => {
      assertVerdictTransition(expect, next)
    })
  }

  // ── Action ──

  async getAction(id: ActionId): Promise<Action | null> {
    return this.#getEntity<Action>('action', id as string)
  }

  async listActionsByVerdict(verdictId: VerdictId): Promise<Action[]> {
    const rows = this.#named('actionsByVerdict').all(verdictId as string) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as Action)
  }

  async findActionByIdempotencyKey(key: string): Promise<Action | null> {
    return this.#parse<Action>(
      this.#named('actionIdempotency').get(key) as { json: string } | undefined,
    )
  }

  async insertAction(action: Action): Promise<void> {
    this.#putEntity('action', action.id as string, action.workspaceId, action)
  }

  async transitionAction(
    id: ActionId,
    expect: ActionStatus,
    next: ActionStatus,
    patch: ActionPatch = {},
  ): Promise<boolean> {
    return this.#cas('actionGet', 'actionCas', id as string, expect, patch, { status: next }, () => {
      assertActionTransition(expect, next)
    })
  }

  // ── Artifact ──

  async listArtifactsByRun(runId: RunId): Promise<Artifact[]> {
    const rows = this.#named('artifactsByRun').all(runId as string) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as Artifact)
  }

  async insertArtifact(artifact: Artifact): Promise<void> {
    this.#putEntity('artifact', artifact.id as string, artifact.workspaceId, artifact)
  }

  // ── 内容寻址 ──

  /**
   * 写入并返回引用。
   *
   * ref 由内容算出，所以同一份字节**必然**得到同一个 ref，`ON CONFLICT DO
   * NOTHING` 让它天然幂等——重复写不会产生第二份，也不会报错。哈希算法与
   * 文件适配器相同（sha256 十六进制），因此同一份内容在两种存储下引用一致，
   * 迁移时不会因为"引用变了"而全部失效。
   */
  async putBlob(bytes: Uint8Array): Promise<BlobRef> {
    const ref = `sha256:${sha256Hex(bytes)}` as BlobRef
    this.#named('blobPut').run(ref, bytes)
    return ref
  }

  async getBlob(ref: BlobRef): Promise<Uint8Array | null> {
    const row = this.#named('blobGet').get(ref) as { bytes: Uint8Array } | undefined
    return row ? row.bytes : null
  }

  async hasBlob(ref: BlobRef): Promise<boolean> {
    return this.#named('blobHas').get(ref) !== undefined
  }

  // ── 审计 ──

  async appendAudit(record: AuditRecord): Promise<void> {
    this.#putEntity('audit', record.id as string, record.workspaceId, record)
  }

  async listAuditsByRun(runId: RunId): Promise<AuditRecord[]> {
    const rows = this.#named('auditsByRun').all(runId as string) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as AuditRecord)
  }

  // ── 通知中心 ──

  async appendInboxItem(item: InboxItem): Promise<void> {
    this.#putEntity('inbox', item.id, item.workspaceId, item)
  }

  async listInboxItems(q: {
    workspaceId: WorkspaceId
    unreadOnly?: boolean
    limit?: number
  }): Promise<InboxItem[]> {
    // 默认只列未读：通知中心不是日志，列出一堆已读的只会让人不再看它（INV-8）
    const stmt = (q.unreadOnly ?? true) ? this.#named('inboxUnread') : this.#named('inboxAll')
    const rows = stmt.all(q.workspaceId as string, q.limit ?? 100) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json) as InboxItem)
  }

  async markInboxItemRead(id: string): Promise<boolean> {
    const row = this.#named('inboxGet').get(id) as { json: string } | undefined
    if (!row) return false
    const merged = { ...(JSON.parse(row.json) as Record<string, unknown>), read: true }
    const result = this.#named('inboxMarkRead').run(JSON.stringify(merged), id)
    return Number(result.changes) > 0
  }
}

/** 便捷打开函数，符合 `StoreOpener` 签名。 */
export async function openSqliteStore(options: SqliteStoreOptions): Promise<SqliteStore> {
  return SqliteStore.open(options)
}

/** 某个 dataDir 下数据库文件的路径（运维用：备份、检查都从它开始）。 */
export function sqliteStorePath(dataDir: string, fileName = SQLITE_FILE_NAME): string {
  return join(dataDir, fileName)
}

/**
 * 文件里是否已有"不属于本程序"的表。
 *
 * 判据是"有表但没有 meta"：本程序写出的库永远有 meta（它是第一个建的），
 * 而一个刚 open 出来的空库一张表都没有。
 */
function hasForeignTables(db: DatabaseSync): boolean {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[]
  return rows.length > 0 && !rows.some((r) => r.name === 'meta')
}

/**
 * 读存下来的格式版本。
 *
 * 区分两件事：**没有版本行**（新库，或本程序自己刚建的库）与**版本字段不可读**
 * （文件坏了 / 根本不是本程序的库）。前者返回 null 由调用方写入当前版本，
 * 后者直接抛——把"这不是我们的文件"含糊地当成"新库"会把别人的数据覆盖掉。
 */
function readStoredFormatVersion(db: DatabaseSync, path: string): number | null {
  let row: { value: string } | undefined
  try {
    row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(FORMAT_VERSION_KEY) as
      | { value: string }
      | undefined
  } catch (err) {
    throw new Error(
      `打不开 ${path}：它不像是本程序写出的存储文件（${(err as Error).message}）`,
    )
  }
  if (!row) return null
  const parsed = Number(row.value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `打不开 ${path}：格式版本字段不可读（值为 ${JSON.stringify(row.value)}），文件可能已损坏`,
    )
  }
  return parsed
}
