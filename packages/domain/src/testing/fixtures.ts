import type {
  Agent,
  AgentId,
  Issue,
  IssueId,
  Report,
  ReportId,
  Run,
  RunId,
  Skill,
  SkillId,
  WorkspaceId,
} from '@alpha-helper/protocol'

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
    toolIds: [],
    env: {},
    createdAt: T0,
    role: 'executor',
    reviewerAgentId: null,
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
    allowedActions: [],
    source: 'local',
    sourceRef: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
    id: skillId(over.id),
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
