import type {
  Agent,
  AgentId,
  Artifact,
  AuditRecord,
  BlobRef,
  ChatTurn,
  ChatTurnId,
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

/**
 * 存储端口。
 *
 * ══════════════════════════════════════════════════════════════
 * 设计约束（FR-STOR-02/03）——这是本文件最重要的部分
 * ══════════════════════════════════════════════════════════════
 *
 * **接口按领域需要定义，不按存储实现的能力定义。**
 *
 * 禁止出现在本文件里的东西：
 *
 *   ✗ readJsonFile / writeJsonFile —— 把存储实现泄进领域逻辑
 *   ✗ readAll()                    —— 迫使领域逻辑做全量扫描，数据库上不可行
 *   ✗ 任何带 file / json / line / path 字样的方法名 —— 命名即泄漏
 *
 * 为什么这条重要：如果首版把"读全量 → 改 → 写回"这类文件存储的用法
 * 泄进领域逻辑，将来接入数据库时不是"换个适配器"，而是重写业务代码。
 *
 * ══════════════════════════════════════════════════════════════
 * 支点：CAS 语义
 * ══════════════════════════════════════════════════════════════
 *
 * `transitionRun(id, expect, next, patch)` 的语义是
 * "**仅当**当前状态等于 expect 时才转移"。
 *
 *   文件存储上：加锁读 → 校验 → 追加
 *   数据库上：  UPDATE ... SET status = next WHERE id = ? AND status = expect
 *
 * **两者语义相同**，所以领域逻辑不需要知道底下是什么。所有状态变更都必须
 * 走这条路——不允许出现"先 get 再 set"的写法，那样在并发下必然出错。
 */

// ─────────────────────────────────────────────────────────────
// 查询与分页
// ─────────────────────────────────────────────────────────────

/** 游标分页。游标是上一页最后一条的 id（ULID，天然可排序）。 */
export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface PageQuery {
  limit?: number
  /**
   * 从该 id **之后**开始取。
   *
   * ══════════════════════════════════════════════════════════════════
   * 两条写在这里的约定，因为适配器之间真的会踩到
   * ══════════════════════════════════════════════════════════════════
   *
   * **① 游标不在候选集里时必须"继续"，不能"回头"。**
   *    最容易写错的实现是 `findIndex(i => i.id === cursor) + 1`——
   *    找不到时得到 `-1 + 1 = 0`，于是**静默重放第一页**。调用方拿到的是
   *    合法的一页、`nextCursor` 也照常给出，但翻页会永远在第一页打转且
   *    毫无报错。正确做法是按**位置**比较（`id > cursor`）。
   *    游标不在结果里并不罕见：上一页最后一条恰好在两次翻页之间改了状态、
   *    被过滤掉，就会发生。
   *
   * **② 排序口径是"id 的**字节序**"，不是"本地化顺序"。**
   *    所有真实 id 都是 ULID（Crockford base32，纯 ASCII），ASCII 上
   *    JS 的 `<` 与 SQLite 的 `BINARY` 完全一致，所以这条现在不构成差异。
   *    但它**不是普遍成立**的：JS 按 UTF-16 代码单元比较，SQLite 按 UTF-8
   *    字节比较，含星平面字符（如 emoji）时两者**顺序相反**。
   *    换言之：**不要把非 ASCII 字符串当作 id 塞进这里**——
   *    那会让 SQL 适配器与文件适配器给出不同的排序。
   */
  cursor?: string | null
}

export interface RunQuery extends PageQuery {
  workspaceId: WorkspaceId
  status?: readonly RunStatus[]
  agentId?: AgentId
  /**
   * 排序方向（2026-10，分批第 72 批）。
   *
   * - `'asc'`（默认）= **老 → 新**，游标翻页（`PageQuery.cursor`，现状不变）；
   * - `'desc'` = **新 → 旧的一页**：按 `queuedAt` 排（同一个毫秒再按 id），
   *   `nextCursor` **恒为 null**——这个方向不做游标翻页。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么必须加这个（一个真 bug，量出来的）
   * ══════════════════════════════════════════════════════════════════
   *
   * 翻页实现是"按 id 升序 + 取前 limit 条"，而 run 的 id 是 ULID（字典序 = 时间序）。
   * 于是 `GET /api/runs`（`limit: 100`）拿到的是**最老的 100 条**。本机实测：某个
   * 工作区有 **445 条 run**，接口返回的最"新"一条是 45 天前的——**最近 45 天的 run
   * 一条都返回不到**。
   *
   * 任务看板正是靠这个列表把 run 归到任务上（`apps/web/src/lib/pipeline.ts` 的
   * `deriveStage`）。看不到 run ⇒ 落到"一条执行 run 都还没有"那一档 ⇒ 于是最近建的
   * 任务**一直显示「执行中」**，哪怕它早就 failed/completed 了。刷新一次就复现，
   * 而接口一个错都不报。
   *
   * 所以"最近的一页"必须是**明确要来的**，不能靠调用方猜 limit 够不够大。
   *
   * ⚠️ 为什么 desc **不支持游标**：游标的位置是用 id 比较出来的（`id > cursor`），
   *    而 desc 的序是 `queuedAt`——两套键混用会得到"翻页翻到最老"的那种假象
   *    （而 `PageQuery.cursor` 的注释里写着：游标失效时**不许回头**）。
   *    与其发明一个"复合游标"再让两个存储实现比着写对，不如把这条方向的语义
   *    收成一句话：**只看最近 N 条，不翻页**。要翻旧数据就用 asc。
   */
  order?: 'asc' | 'desc'
}

/*
 * ⚠️ 2026-11（D125）：`ReportQuery` 随报告摄取链退场删掉（四个 report 方法一起）。
 */

export interface IssueQuery extends PageQuery {
  workspaceId: WorkspaceId
  status?: readonly Issue['status'][]
  assigneeId?: string
  /** 标题/描述的子串检索（目录管理能力，FR-ISSUE-09/10）。 */
  search?: string
}

/**
 * 认定为"正在占用工作目录"的状态集合。
 *
 * 只有已经被 daemon 受理的 run 才持有目录；`queued` 还没被受理，
 * 因此不算占用（它会等到受理时再检查，届时进入 waiting_local_directory）。
 */
export const ACTIVE_RUN_STATUSES = [
  'dispatched',
  'running',
  'waiting_local_directory',
] as const satisfies readonly RunStatus[]

// ─────────────────────────────────────────────────────────────
// 端口
// ─────────────────────────────────────────────────────────────

/**
 * **独有技能的来源**（D228）——"这份文件资产是谁的"。
 *
 * 说清"是谁"，**不说"在哪个目录"**：目录是存储实现的事（路径词汇不许进端口，
 * 见 `tests/port-purity` 那条判据）。文件适配器按这个描述符解析出目录；
 * 其它实现（SQLite）可以如实拒绝（独有技能本来就是文件资产）。
 *
 * 两种来源今天都真实存在：
 *   · `agent` —— 智能体页里那条记录（`agents/<id>/skills/`）；
 *   · `workflow-agent` —— 编排内建智能体（`workflows/<wid>/agents/<aid>/skills/`），
 *     它**不在智能体库里**，所以没有 `AgentId` 可用——这正是这一层存在的理由。
 */
export type ExclusiveSkillOwner =
  | { kind: 'agent'; agentId: AgentId }
  | { kind: 'workflow-agent'; workflowId: string; agentId: string }

/**
 * 常见那一种来源的构造器——**别在调用点手写 `{ kind: 'agent', agentId }`**：
 * 一百处手写就有一百处能写错 kind，而写错的表现是"技能读不到"，不会报错。
 */
export function agentSkillOwner(agentId: AgentId): ExclusiveSkillOwner {
  return { kind: 'agent', agentId }
}

export interface Store {
  // ── 生命周期 ──

  /** 存储格式版本，用于迁移判定（FR-STOR-04）。 */
  formatVersion(): Promise<number>
  close(): Promise<void>

  // ── Workspace 与 Device ──

  getWorkspace(id: WorkspaceId): Promise<Workspace | null>
  insertWorkspace(ws: Workspace): Promise<void>
  /** 枚举已知 workspace——daemon 启动时据此预加载，并选出默认工作区。 */
  listWorkspaceIds(): Promise<WorkspaceId[]>
  getDevice(): Promise<Device | null>
  upsertDevice(device: Device): Promise<void>

  // ── Agent ──

  /**
   * 按 **id** 取（D231：以前叫 `getAgent`）。`id` 是**身份**——历史、快照、平台槽位、
   * 定时任务的执行者里存的都是它；它永不变（改名字也不变）。
   */
  getAgentById(id: AgentId): Promise<Agent | null>
  /**
   * 按 **名字** 取（D231）。名字是**人给的句柄**（编排代码 `agent('写作员')`、CLI、
   * 界面跳转），可改、理论上可能撞（老数据里真有重名）。
   *
   * ⚠️ 撞了**不猜**：返回 `ambiguous` 让调用方自己说话——静默取第一个正是 D163
   *    修掉的那个坑（"我明明选了新的，怎么跑的是旧的"）。
   */
  getAgentByName(name: string): Promise<
    | { kind: 'found'; agent: Agent }
    | { kind: 'ambiguous'; agents: Agent[] }
    | { kind: 'none' }
  >
  listAgents(workspaceId: WorkspaceId): Promise<Agent[]>
  /**
   * 读**未经清理**的 agent 记录：磁盘上是什么样就是什么样。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它只为一件事存在：把老记录里撤掉的键**从磁盘上**摘掉
   * ══════════════════════════════════════════════════════════════════
   *
   * `getAgentById` / `listAgents` 会摘掉那几个键（读时兜底，见
   * `packages/protocol/src/agent-legacy.ts`），于是**磁盘清理没法用它们**：读回来
   * 的记录已经"看起来干净"，判据永远是"没有老字段"⇒ 一个字都不用改 ⇒ 磁盘上那些
   * 键会永久留着（而使用者的要求是"不要遗留旧数据"）。
   *
   * ⚠️ 这是**唯一**一个"绕过总闸"的读口，所以调用方必须是清理那一处
   *    （`apps/daemon/src/agent-legacy-cleanup.ts`）——别在业务代码里用它：那样会把
   *    撤掉的字段重新带回链路里，而它们的语义已经不存在了（读到也不知道该怎么办）。
   */
  listAgentsRaw(workspaceId: WorkspaceId): Promise<Agent[]>
  insertAgent(agent: Agent): Promise<void>
  /**
   * 删除一个 agent（第二轮，2026 续：智能体组删除时**级联删私有成员**）。
   *
   * @returns 真的删到了返回 true；本来就没有返回 false（**不是错误**）。
   *
   * ⚠️ Agent 原来是 append-only（只有 insert，没有 delete）——所以这个方法是
   *    **新增**的，不是补齐缺口。调用方负责引用检查：私有 agent 随组删（这轮
   *    唯一的生产调用点）；全局 agent 有没有被组引用由调用方在删之前反查
   *    （`listGroupsByAgent`）。
   */
  deleteAgent(id: AgentId): Promise<boolean>

  // ── 独有技能（D111：`agents/<id>/skills/<slug>/SKILL.md` 这类文件资产）──

  // 两类技能的分界（设计定稿 `docs/design/agent-directory.md` §4）：
  //   · **独有** = 跟着某个实体目录走的文件——不进技能库、不进技能页、不可卸载，
  //     删掉那个实体就连文件一起删。下面四个方法管的就是它们。
  //   · **共享** = 技能库里的资产，用 `skillIds` 引用（见 `Skill` 一节）。
  //
  // ⚠️ 独有技能**没有库 id**：run 的 `skillRefs` 里它们长这样——
  //    `{ id: null, slug, source: 'agent' }`（`SkillRef.id` 可空，D111）。
  //
  // ★ 2026-11（D228）：**"谁的技能"从 `AgentId` 换成一个来源描述符**。
  //
  //   改之前这四个方法的第一个参数是 `agentId`——于是"独有技能放在哪"这件事
  //   被硬绑在"智能体在库里有一条记录"上。后果是：**编排内建智能体**（只属于
  //   一条编排、不在库里）没法带独有技能，而它恰恰最需要（"这条编排自带的参考资料"）。
  //
  //   现在参数是 `ExclusiveSkillOwner`：说清"这是谁的文件"，不说"它在哪个目录"。
  //   目录从哪来由**存储实现**决定（文件适配器按 owner 解析；路径词汇不许进端口，
  //   `FR-STOR-03` 那条机器判据盯着）。
  /** 列出这个来源的独有技能（slug + 正文）。正文 = `SKILL.md` 原文。 */
  listExclusiveSkills(
    owner: ExclusiveSkillOwner,
  ): Promise<Array<{ slug: string; body: string }>>
  /** 读一条独有技能的正文；没有返回 null（**不是错误**）。 */
  getExclusiveSkill(owner: ExclusiveSkillOwner, slug: string): Promise<string | null>
  /** 写一条独有技能（覆盖同 slug）。校验（slug/正文规则）由调用方做。 */
  writeExclusiveSkill(owner: ExclusiveSkillOwner, slug: string, body: string): Promise<void>
  /** 删一条独有技能。真的删到了返回 true；本来就没有返回 false（**不是错误**）。 */
  removeExclusiveSkill(owner: ExclusiveSkillOwner, slug: string): Promise<boolean>

  /*
   * ⚠️ 2026-11（S3）：这里原来是**智能体组**那一组端口（`getGroup` / `listGroups` /
   *   `listGroupsByAgent` / `insertGroup` / `updateGroup` / `deleteGroup`）。
   *
   *   **组退场**（它存在的全部理由是回答"谁审、判完允许动什么"，而审核 run 与动作
   *   能力都退场了）⇒ 端口上不再有组。磁盘 / SQLite 里那一节老数据原样留着，
   *   没有代码读它。
   *
   *   ⚠️ `updateGroup` 那条注释里有一句话值得留：**组是"当前配置"（可编辑），不是
   *   append-only 的历史实体**——所以它有 update，而 Agent 只有 insert。判断一个
   *   实体该不该可改，看的是"它是配置还是发生过的事"。
   */

  // ── Agent memory（分批第 240 批）──

  /**
   * 列这个 workspace 的记忆条目。
   *
   * @param agentId 给了就只要这个 agent 的（详情页）；不给就是全部（第一句话注入要
   *        按 agent 取，别的地方一般用不到）。
   *
   * ⚠️ 返回的是**所有记录**，包括 `removedAt !== null` 的（删除只是打时间戳，历史留在
   *    日志里）。"哪些还算数"由调用方按 `removedAt === null` 过滤——存储层不替上层
   *    决定可见性。
   */
  listMemoryEntries(workspaceId: WorkspaceId, agentId?: AgentId): Promise<MemoryEntry[]>
  /** 新增一条（"改"也走这条：新增 + 把旧的打上 `removedAt`）。 */
  insertMemoryEntry(entry: MemoryEntry): Promise<void>
  /**
   * 覆盖一条（置顶开关、使用统计、打删除时间戳）。
   *
   * @returns 这条记录本来就在返回 true；不在返回 false（**不是错误**，调用方要分清
   *          "它已经没了"与"写失败"）。
   */
  updateMemoryEntry(entry: MemoryEntry): Promise<boolean>

  // ── Skill ──

  getSkill(id: SkillId): Promise<Skill | null>
  listSkills(workspaceId: WorkspaceId): Promise<Skill[]>
  /** 按 id 批量取（一个 run 的技能集合按 agent 求解，D22）。 */
  listSkillsByIds(ids: readonly SkillId[]): Promise<Skill[]>
  insertSkill(skill: Skill): Promise<void>
  /**
   * 卸载一条 skill（D38）。
   *
   * @returns 真的删到了返回 true；本来就没有返回 false（**不是错误**——
   *          "它已经不在了"与"删失败"是两件事，调用方要分得清）。
   *
   * ⚠️ 调用方负责**引用检查**（还有哪些 agent 挂着它）。存储层不该替上层
   *    猜"能不能删"——那条规则属于业务，而且它的报错要说清是谁还挂着。
   */
  deleteSkill(id: SkillId): Promise<boolean>

  /*
   * ⚠️ 2026-11（D123）：这里原来是**工具包**那一组端口（getTool / listTools /
   *   listToolsByIds / getToolBySlug / insertTool / deleteTool）。工具包与动作能力
   *   一起退场——daemon 不再装包、导出不再带包、没有任何调用方，整组删掉。
   */

  // ── Issue 与 Comment ──

  getIssue(id: IssueId): Promise<Issue | null>
  listIssues(q: IssueQuery): Promise<Page<Issue>>
  insertIssue(issue: Issue): Promise<void>
  transitionIssue(
    id: IssueId,
    expect: Issue['status'],
    next: Issue['status'],
    patch?: Partial<Pick<Issue, 'assignee' | 'labels' | 'priority' | 'title' | 'description'>>,
  ): Promise<boolean>
  listComments(issueId: IssueId): Promise<Comment[]>
  insertComment(comment: Comment): Promise<void>

  /**
   * 删掉一条任务（issue）**连同挂它名下的一切**。
   *
   * 连带范围（使用者确认过："删任务 = 连带删除全部执行记录"）：
   *   ① 该 issue 上所有 run —— 逐个走 `deleteRun` 的连带（消息流 / artifacts /
   *      引用那些 run 的对话轮次；审计与 blob 不删；⚠️ 老数据里的 verdicts 也
   *      一并清掉，见 `deleteRun`）；
   *   ② 该 issue 的全部评论；
   *   ③ issue 本体。
   *
   * ⚠️ 只按 `subject.type === 'issue' && subject.id === issueId` 找 run：
   *    聊天轮次的 run subject 是 `conversation`，不在其列（删任务不碰聊天）。
   * ⚠️ 通知（inbox）不删——"发生了什么"的痕迹留着，与审计同一条理由。
   * ⚠️ 返回 false = 本来就没有这条 issue（不是错误），与 `deleteConversation` 一致。
   */
  deleteIssue(id: IssueId): Promise<boolean>

  // ── Conversation 与 ChatTurn（聊天）──

  getConversation(id: ConversationId): Promise<Conversation | null>
  /** 按 `lastTurnAt` 倒序（从没说过话的按 `createdAt`）。 */
  listConversations(workspaceId: WorkspaceId): Promise<Conversation[]>
  insertConversation(conversation: Conversation): Promise<void>
  updateConversation(
    id: ConversationId,
    patch: Partial<
      Pick<Conversation, 'title' | 'workDir' | 'updatedAt' | 'lastTurnAt' | 'turnCount'>
    >,
  ): Promise<Conversation | null>

  listChatTurns(conversationId: ConversationId): Promise<ChatTurn[]>
  insertChatTurn(turn: ChatTurn): Promise<void>
  /**
   * 这个对话里最后一条**带着 run 的**轮次。
   *
   * ★ 它是"上一轮是谁"的唯一答案：下一轮要靠它拿 `resumeFromRunId` 去接上文。
   *   按 `seq` 取而不是按时间——同一毫秒内连着两轮时，时间戳分不出先后。
   */
  lastChatTurnWithRun(conversationId: ConversationId): Promise<ChatTurn | null>

  /**
   * 删掉一个对话**连同它的全部轮次**。返回是否真的删到了。
   *
   * ⚠️ 只删对话与轮次，**那条 run 留着**。run 是审计记录（成本、日志、工作目录
   *    的归属都挂在它身上），而且它的产出与聊天记录是**同一份东西**——删掉
   *    run 等于把"这次对话真的发生过"这件事一起删了。
   */
  deleteConversation(id: ConversationId): Promise<boolean>

  /**
   * 删掉一条 run **连同它派生的一切**：消息流、artifacts，以及**引用它的对话
   * 轮次**（那一轮的内容就是这条 run 的 messages——run 没了，轮次只剩"我说了句
   * 什么"的半句话，留着是断的）。
   *
   * ⚠️ 2026-11（D125）：判决退场之后没有"由判决触发的动作"可连带；但**老数据**
   *    里还躺着那条 run 的 verdict 记录，删除时一并清掉（见两个适配器的实现）——
   *    留着它等于留一条指向已删 run 的判决。
   *
   * ⚠️ **审计记录与内容寻址 blob 不删**：审计是"发生过什么"的不可变历史
   *    （FR-AUDIT-01），blob 被审计/报告引用——删掉它们等于把可追溯性挖掉一块。
   *    它们留着、`runId` 指向一条已删的 run，是允许的（读取端按 runId 查，没有
   *    外键）。
   * ⚠️ 受影响对话的 `turnCount` 会重算（它是冗余字段，删轮次后必须同步）。
   * ⚠️ 返回 false = 本来就没有这条 run（不是错误），与 `deleteConversation` 一致。
   * ⚠️ 运行中的 run 不该走到这里（`DELETE /api/runs/:id` 路由按非终态状态挡下）；
   *    存储层不替调用方做这个判断，与 `cancel` 同一口径。
   */
  deleteRun(id: RunId): Promise<boolean>

  /*
   * ⚠️ 2026-11（D125）：这里原来是 report 的四个方法——`listReports` /
   *   `findReportByDedupKey` / `getReport` / `insertReport`（`insertReport` 返回
   *   false 表示"去重键已存在"，那是并发下的幂等语义）。
   *
   *   **报告摄取整条链退场**（见 `entities.ts` 那段说明）⇒ 端口上不再有 report。
   *   磁盘/SQLite 里那一段老数据原样留着，没有代码读它。
   */

  // ── Run ──

  getRun(id: RunId): Promise<Run | null>
  listRuns(q: RunQuery): Promise<Page<Run>>
  insertRun(run: Run): Promise<void>

  /**
   * ★ CAS 转移。仅当当前状态等于 `expect` 时才写入 `next`。
   * @returns 是否发生了转移（false 表示前态不匹配或实体不存在）
   */
  transitionRun(
    id: RunId,
    expect: RunStatus,
    next: RunStatus,
    patch?: RunPatch,
  ): Promise<boolean>

  /** 查找占用某工作目录的 run（同目录串行化，D20）。 */
  findRunHoldingWorkDir(workDir: string, excludeRunId?: RunId): Promise<Run | null>

  /** 查找同一 (subject, agent) 上仍在进行的 run（防止自竞争，INV-17）。 */
  findActiveRunForSubjectAgent(subject: SubjectRef, agentId: AgentId): Promise<Run | null>

  // ── Run 的消息流 ──

  /**
   * 追加一条执行消息。
   *
   * 消息是**高写入量**数据，与实体记录分开存放。`seq` 由调用方按本地
   * 单调递增给出，**不依赖时间戳**——本地时钟可能漂移，而页面要靠它
   * 做「按序号补齐」（FR-BRIDGE-18）。
   */
  appendRunMessage(runId: RunId, message: RunMessage): Promise<void>
  /** 按 `since` 取消息（不含该序号本身）。 */
  listRunMessages(runId: RunId, since?: number): Promise<RunMessage[]>
  /** 该 run 已产生到第几号消息——页面据此决定补齐起点。 */
  lastRunMessageSeq(runId: RunId): Promise<number>

  /*
   * ⚠️ 2026-11（D125）：这里原来是判决的四个方法——`getVerdict` /
   *   `listVerdictsByRun` / `insertVerdict` / `transitionVerdict`（后者是带前态
   *   期望的 CAS，前态不匹配就返回 false 而不是抛）。
   *
   *   审核 run 与判决一起退场 ⇒ 端口上不再有判决。**磁盘/SQLite 里那一段老数据
   *   原样留着**，没有代码读它。
   *
   *   ⚠️ CAS 那条纪律留着：**状态迁移必须带前态期望**，"先读出来再判断"在并发下
   *   会漏（两个请求同时读到旧态、同时写）。`transitionRun` 还在用它。
   */

  /*
   * ⚠️ 2026-11（D123）：这里原来是**动作记录**那一组端口（getAction /
   *   listActionsByVerdict / findActionByIdempotencyKey / insertAction /
   *   transitionAction）。动作能力退场后判决不再触发动作，这些记录**没有任何
   *   生产者**——`listActionsByVerdict` 永远返回空。端口与两个 store 的实现、
   *   以及调用它们的地方（导出的 `actions` 段、任务页的动作时间线）一起删。
   */

  // ── Artifact ──

  listArtifactsByRun(runId: RunId): Promise<Artifact[]>
  insertArtifact(artifact: Artifact): Promise<void>

  // ── 内容寻址 ──

  /** 写入并返回 `sha256:<hex>` 引用。同一内容重复写入是幂等的。 */
  putBlob(bytes: Uint8Array): Promise<BlobRef>
  getBlob(ref: BlobRef): Promise<Uint8Array | null>
  hasBlob(ref: BlobRef): Promise<boolean>

  // ── 审计 ──

  appendAudit(record: AuditRecord): Promise<void>
  listAuditsByRun(runId: RunId): Promise<AuditRecord[]>

  // ── 通知中心 ──

  /** 追加一条通知（FR-ISSUE-07）。 */
  appendInboxItem(item: InboxItem): Promise<void>
  /** 列出通知，默认只列未读。 */
  listInboxItems(q: { workspaceId: WorkspaceId; unreadOnly?: boolean; limit?: number }): Promise<InboxItem[]>
  /** 标记已读。 */
  markInboxItemRead(id: string): Promise<boolean>
}

// ─────────────────────────────────────────────────────────────
// 可变字段（只允许这些被 patch）
// ─────────────────────────────────────────────────────────────

export interface RunPatch {
  workDir?: string | null
  waitReason?: string | null
  sessionId?: string | null
  failureReason?: Run['failureReason']
  /** 失败原因的具体文字——与 `failureReason` 一起落库（只留码不留字，原因就永远找不回来）。 */
  failureMessage?: Run['failureMessage']
  usage?: Run['usage']
  dispatchedAt?: number | null
  startedAt?: number | null
  finishedAt?: number | null
  attempt?: number
}

/*
 * ⚠️ 2026-11（D123）：这里原来是 `ActionPatch`（`transitionAction` 的部分更新形状）。
 *   随动作记录端口一起删。
 */

/** 打开存储的工厂签名。具体实现由适配器包提供。 */
export type StoreOpener = (options: { dataDir: string }) => Promise<Store>
