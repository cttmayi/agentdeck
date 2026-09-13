/**
 * daemon 接口客户端（同源）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么单独一个模块，而不是在每个组件里 fetch
 * ══════════════════════════════════════════════════════════════════
 *
 * 因为这里有三件**必须到处一致**的事，散落开就一定会漂：
 *
 *   - 出错时怎么判断"是网络问题还是业务问题"（前者要提示去启动 daemon，
 *     后者要展示服务端给的原文）；
 *   - 429（并发已满）要**单独**处理，它不是错误，是"稍后再试"；
 *   - 路径拼接与手写 URL 的地方越少越好。
 */

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

/** 并发已满不是失败，是"稍后再试"——单独一个类型，调用方才好分支。 */
export class BusyError extends ApiError {
  constructor(body: unknown) {
    super('本机并发已满，请稍后重试。', 429, body)
    this.name = 'BusyError'
  }
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      ...init,
    })
  } catch (err) {
    // 连不上本机 daemon 是**最可能**的失败，而且处置与业务错误完全不同：
    // 一个是"去把服务起起来"，一个是"你的输入有问题"。
    throw new ApiError(
      `连不上本机 daemon。请确认它已经启动（pnpm run daemon）。` +
        `（原因：${err instanceof Error ? err.message : String(err)}）`,
      0,
      null,
    )
  }

  const text = await res.text()
  let body: unknown = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      // 服务端返回了非 JSON —— 说明它自己出问题了，把原文带上比吞掉有用
      body = { raw: text.slice(0, 500) }
    }
  }

  if (res.status === 429) throw new BusyError(body)

  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`
    throw new ApiError(message, res.status, body)
  }
  return body as T
}

// ─────────────────────────────────────────────────────────────
// 接口形状（只声明我们真的用到的字段）
// ─────────────────────────────────────────────────────────────

export interface RuntimeView {
  key: string
  command: string
  available: boolean
  cliVersion: string | null
  /** `verified` = 对照过真实程序；`provisional` = 按公开形状推导。 */
  evidence: string
  sessionState: string
  versionSupport?: {
    status: string
    range: string | null
    verifiedWith: string[]
    message: string
  }
}

export interface EnvironmentIssue {
  subject: string
  severity: 'error' | 'warning'
  summary: string
  action: string
}

export interface Identity {
  deviceName: string
  currentRuntime?: string
  runtimes: RuntimeView[]
  /** 运行环境预检结果（例如 CLI 自己的状态目录写不进去）。 */
  environment?: { ok: boolean; issues: EnvironmentIssue[] }
}

export interface Issue {
  id: string
  title: string
  description: string
  status: string
  assignee: { type: string; id: string } | null
  labels: string[]
  updatedAt: number
  createdAt: number
}

export type AgentRole = 'executor' | 'reviewer'

export interface Agent {
  id: string
  name: string
  instructions: string
  workDir: string | null
  skillIds: string[]
  model: string | null
  runtimeKey: string
  /** 干活的还是审的（D28）。 */
  role: AgentRole
  /** 由谁来审**这个执行 agent** 的产出（仅 executor 有意义）。 */
  reviewerAgentId: string | null
}

export interface Skill {
  id: string
  slug: string
  name: string
  description: string | null
  /** SKILL.md 的正文。 */
  body: string
  /** 支持文件：相对路径 → 内容。缺失表示只有 SKILL.md。 */
  files?: Record<string, string>
  allowedActions: string[]
  source: 'local' | 'remote'
  sourceRef: string | null
  /** 这份内容的版本（远端目录给的）。没有版本时缺失/null。 */
  version?: string | null
  updatedAt: number
}

export interface RunSummary {
  runId: string
  kind: string
  status: string
  agentId: string
  /** run 处理的对象。页面靠它把 run 归到具体任务上。 */
  subject: { type: string; id: string }
  workDir: string | null
  queuedAt: number
  finishedAt: number | null
  failureReason: string | null
  chainDepth: number
}

export type RunDetail = RunSummary

export interface RunMessage {
  seq: number
  type: string
  tool: string | null
  content: string
  /**
   * 工具的**结构化入参**（原文保留）。
   *
   * 类型写具体而不是 `unknown`：界面要把它当对象渲染成 JSON。
   * 写 `unknown` 的话每个使用点都得自己收窄一遍——那是把类型信息
   * 丢在源头，然后让所有下游去猜。
   */
  input: Record<string, unknown> | null
  output: string | null
  outputTruncated: boolean
  at: number
}

export interface VerdictView {
  id: string
  status: string
  conclusion: string
  reasonCode: string
  confidence: number
  findings: Array<{ severity: string; summary: string; evidence?: string | null }>
  action: { type: string; params: Record<string, unknown> } | null
  escalateReason: string | null
  invalidResolution: string | null
  createdAt: number
}

export interface InboxItem {
  id: string
  type: string
  severity: 'action_required' | 'attention' | 'info'
  title: string
  body: string
  issueId: string | null
  runId: string | null
  createdAt: number
}

export interface CostBucket {
  key: string
  runs: number
  inputTokens: number
  outputTokens: number
  costUsdMicros: number
  estimatedRuns: number
}

export interface CostReport {
  total: CostBucket
  byAgent: CostBucket[]
  byKind: CostBucket[]
  runsWithoutUsage: number
}

/** 与 daemon 保持一致的 ULID 生成。 */
export function newRunId(): string {
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let time = Date.now()
  let timePart = ''
  for (let i = 0; i < 10; i++) {
    timePart = ENCODING[time % 32] + timePart
    time = Math.floor(time / 32)
  }
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let randPart = ''
  for (let i = 0; i < 16; i++) {
    randPart = ENCODING[Number(n & 31n)] + randPart
    n >>= 5n
  }
  return timePart + randPart
}

/** `GET /api/runs/:id/files` —— 工作目录里的文件列表。 */
export interface WorkDirFile {
  path: string
  kind: 'file' | 'dir'
  sizeBytes: number
  modifiedAt: number
  /** 平台注入的东西（`.claude/**`、`CLAUDE.md`），不是 agent 的产出。 */
  managed: boolean
}

export interface WorkDirListing {
  workDir: string | null
  entries: WorkDirFile[]
  truncated: boolean
}
