import type {
  Agent,
  AgentId,
  Issue,
  ChatTurn,
  ChatTurnId,
  Conversation,
  ConversationId,
  IssueId,
  Run,
  RunId,
  Skill,
  SkillId,
  WorkspaceId,
} from '@agentdeck/protocol'

/**
 * 测试夹具。
 *
 * 用极薄的 cast 生成 branded id——brand 是编译期约束，测试里构造数据时
 * 没必要为它写一堆 zod 解析。这样测试保持可读，同时**类型仍然被检查**。
 */

export const wsId = (s = 'ws_1') => s as WorkspaceId
export const agentId = (s: string) => s as AgentId
export const skillId = (s: string) => s as SkillId
export const issueId = (s: string) => s as IssueId
export const conversationId = (s: string) => s as ConversationId
export const chatTurnId = (s: string) => s as ChatTurnId
export const runId = (s: string) => s as RunId

const T0 = 1_700_000_000_000

export function makeAgent(over: Omit<Partial<Agent>, 'id'> & { id: string }): Agent {
  return {
    workspaceId: wsId(),
    name: over.id,
    instructions: '',
    model: null,
    runtimeKey: 'claude',
    workDir: null,
    skillIds: [],
    env: {},
    createdAt: T0,
    // D37：审核标准内联在审核者上；要测就 over 里给
    reviewStandard: null,
    updatedAt: T0,
    ...over,
    id: agentId(over.id),
  }
}

export function makeSkill(over: Omit<Partial<Skill>, 'id'> & { id: string }): Skill {
  return {
    workspaceId: wsId(),
    /*
     * ★ D236：技能只有一个名字（= 目录名）。夹具缺省用 id 当名字（好认、不撞），
     *   要改就显式给 `name`——以前这里还有 `slug` 与 `name` 两个，缺省分别是
     *   id 与 id，那个形状只在"两个字段"的时代成立。
     */
    name: over.name ?? over.id,
    description: null,
    body: '',
    verdictSchemaVersion: 1,
    // ⚠️ 这里原来有 `allowedActions: []`。D40 收口之后 `Skill` **没有**这个字段
    //    ——动作权限属于**智能体组**（2026-10 起 `AgentGroup.allowedActions`，
    //    在那之前短暂地是 `Agent.allowedActions`），skill 只剩"正文 + 支持文件"。
    //    夹具里留着它会掩盖"skill 又能声明动作了"这件事。
    source: 'local',
    sourceRef: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
    id: skillId(over.id),
  }
}

/*
 * ⚠️ 2026-11（D123）：这里原来是 `makeTool()`（一个已安装的工具包的夹具）。
 *   工具包与动作能力一起退场，`Tool` 实体与清单 schema 都没了，夹具跟着删。
 */


export function makeRun(
  over: Omit<Partial<Run>, 'id' | 'agentId'> & { id: string; agentId: string },
): Run {
  return {
    workspaceId: wsId(),
    kind: 'execute',
    status: 'queued',
    subject: { type: 'issue', id: 'i_1' },
    trigger: 'assignment',
    derivedFrom: null,
    chainDepth: 0,
    skillRefs: [],
    workDir: null,
    waitReason: null,
    sessionId: null,
    attempt: 1,
    maxAttempts: 2,
    failureReason: null,
    usage: null,
    queuedAt: T0,
    dispatchedAt: null,
    startedAt: null,
    finishedAt: null,
    ...over,
    id: runId(over.id),
    agentId: agentId(over.agentId),
  }
}

/*
 * ⚠️ 2026-11（D125）：`makeReport` / `reportId` 随 `Report` 实体与报告摄取链一起删。
 */

export function makeConversation(
  over: Omit<Partial<Conversation>, 'id'> & { id: string },
): Conversation {
  return {
    workspaceId: wsId(),
    agentId: agentId('a1'),
    skillIds: [],
    title: '对话',
    workDir: null,
    createdAt: T0,
    updatedAt: T0,
    lastTurnAt: null,
    turnCount: 0,
    ...over,
    id: conversationId(over.id),
  }
}

export function makeChatTurn(
  // ⚠️ `conversationId` 要从 `Partial<ChatTurn>` 里**摘掉**再交叉：不摘的话
  //    交集会变成 `ConversationId & string`，调用方传普通字符串就编译不过——
  //    而夹具的整个意义就是"测试里不必为品牌类型写一堆解析"。
  over: Omit<Partial<ChatTurn>, 'id' | 'conversationId'> & {
    id: string
    conversationId: string
  },
): ChatTurn {
  return {
    workspaceId: wsId(),
    seq: 1,
    userText: '你好',
    runId: null,
    createdAt: T0,
    error: null,
    ...over,
    id: chatTurnId(over.id),
    conversationId: conversationId(over.conversationId),
  }
}

export function makeIssue(over: Omit<Partial<Issue>, 'id'> & { id: string }): Issue {
  return {
    workspaceId: wsId(),
    title: 'issue',
    description: '',
    status: 'todo',
    priority: 'none',
    assignee: null,
    labels: [],
    createdAt: T0,
    updatedAt: T0,
    source: null,
    ...over,
    id: issueId(over.id),
  }
}
