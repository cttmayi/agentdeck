import type {
  Agent,
  AgentId,
  Issue,
  ChatTurn,
  ChatTurnId,
  Conversation,
  ConversationId,
  IssueId,
  Report,
  ReportId,
  Run,
  RunId,
  Skill,
  SkillId,
  Tool,
  ToolId,
  WorkspaceId,
} from '@agentdeck/protocol'
import { TOOL_MANIFEST_SCHEMA } from '@agentdeck/protocol'

/**
 * 测试夹具。
 *
 * 用极薄的 cast 生成 branded id——brand 是编译期约束，测试里构造数据时
 * 没必要为它写一堆 zod 解析。这样测试保持可读，同时**类型仍然被检查**。
 */

export const wsId = (s = 'ws_1') => s as WorkspaceId
export const agentId = (s: string) => s as AgentId
export const skillId = (s: string) => s as SkillId
export const toolId = (s: string) => s as ToolId
export const issueId = (s: string) => s as IssueId
export const conversationId = (s: string) => s as ConversationId
export const chatTurnId = (s: string) => s as ChatTurnId
export const runId = (s: string) => s as RunId
export const reportId = (s: string) => s as ReportId

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
    role: 'executor',
    reviewerAgentId: null,
    // ★ D40 收口：动作权限在 **agent** 上（它一度住在 skill 里、也一度住在
    //   `reviewStandard` 里）。缺省为空——只有审核者才该有非空值。
    allowedActions: [],
    // D37：审核标准内联在审核者上；要测就 over 里给
    reviewStandard: null,
    updatedAt: T0,
    ...over,
    id: agentId(over.id),
  }
}

export function makeSkill(
  over: Omit<Partial<Skill>, 'id'> & { id: string; slug?: string },
): Skill {
  return {
    workspaceId: wsId(),
    slug: over.slug ?? over.id,
    name: over.id,
    description: null,
    body: '',
    verdictSchemaVersion: 1,
    // ⚠️ 这里原来有 `allowedActions: []`。D40 收口之后 `Skill` **没有**这个字段
    //    ——动作权限是审核者的能力（`Agent.allowedActions`），skill 只剩
    //    "正文 + 支持文件"。夹具里留着它会掩盖"skill 又能声明动作了"这件事。
    source: 'local',
    sourceRef: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
    id: skillId(over.id),
  }
}

/**
 * 一个已安装的工具包（D40）。
 *
 * 清单是**真的按 schema 造出来的**（而不是丢一个空对象）：存储层要存的就是
 * 这份清单，夹具里给个 `{}` 会让"清单没被完整写下来"这类问题在测试里看不见。
 */
export function makeTool(
  over: Omit<Partial<Tool>, 'id'> & { id: string; slug?: string },
): Tool {
  const slug = over.slug ?? over.id
  return {
    workspaceId: wsId(),
    slug,
    name: over.id,
    description: '',
    version: null,
    manifest: {
      schema: TOOL_MANIFEST_SCHEMA,
      slug,
      name: over.id,
      version: null,
      description: '',
      runtime: 'node',
      entry: 'index.mjs',
      actions: [
        {
          name: 'run',
          summary: '跑一下',
          reversible: true,
          dryRun: 'supported',
          timeoutMs: 60_000,
          params: { bound: {}, open: {} },
        },
      ],
    },
    files: { 'index.mjs': '// 空实现\n' },
    docs: '',
    source: 'local',
    sourceRef: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
    id: toolId(over.id),
  }
}

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

export function makeReport(
  over: Omit<Partial<Report>, 'id'> & { id: string; kind: string },
): Report {
  return {
    workspaceId: wsId(),
    source: 'test-source',
    externalId: 'ext-1',
    title: 't',
    body: 'b',
    meta: {},
    blobRef: `sha256:${'a'.repeat(64)}` as Report['blobRef'],
    dedupKey: 'dedup-1',
    ingestedAt: T0,
    ...over,
    id: reportId(over.id),
  }
}

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
    ...over,
    id: issueId(over.id),
  }
}
