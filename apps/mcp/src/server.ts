import { ulid } from '@alpha-helper/protocol'

/**
 * 对外 MCP server（M4、FR-INTEG-01）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它是 daemon 的**客户端**，不是 daemon 的一部分
 * ══════════════════════════════════════════════════════════════════
 *
 * 这一点决定了整个设计：
 *
 *   - 它**不导入** daemon 的任何模块，只通过本机 HTTP 接口说话。
 *     所以它可以被任意进程按需拉起（通常是被别的 agent 当子进程起），
 *     不需要和 daemon 共享生命周期；
 *   - 它**不向远端发任何请求**——D20 说 daemon 不主动外联，这个进程也
 *     遵守同一条线。它只连 `127.0.0.1`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 工具集刻意是**窄**的（这是最重要的一个决定）
 * ══════════════════════════════════════════════════════════════════
 *
 * MCP 一接出去，别的 agent 就能驱动本系统。所以"暴露哪些操作"本身就是
 * 一道安全边界，而且这道边界一旦放开就很难收回——外面会有人开始依赖它。
 *
 * **刻意不暴露的**：
 *
 *   - `POST /api/runs`（直接提交 run）。它会接受一个任意 `workDir`，
 *     然后在那里启动一个会读写文件的子进程。那等于把"在你的机器上按我给的
 *     路径执行 agent"变成一次 MCP 调用。要跑东西，请走
 *     `submit_report` → 审核 → 判决 → 有界动作这条路，
 *     或者由人在本机页面上动手。
 *   - `POST /api/skills`（写 skill 文件）。skill 会被拼进 agent 的上下文，
 *     是提示注入的现成入口。
 *   - 任何会改 agent 配置的操作（`POST /api/agents`）。
 *
 * **暴露的**都是"读 + 受控写入"：看板、审计、判决、成本，
 * 以及"投递一条报告"——后者不执行任何东西，只是把材料放进来走既有流程。
 */

export const MCP_PROTOCOL_VERSION = '2024-11-05'

/** daemon 的本机地址。固定回环——MCP 不该成为访问别处的跳板。 */
export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:4517'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** 实际执行。抛出的错误会被转成工具级的错误结果。 */
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>
}

export interface ToolContext {
  daemonUrl: string
  fetchImpl?: typeof fetch
}

/** 调 daemon 的本机接口。 */
async function daemonApi(
  ctx: ToolContext,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const doFetch = ctx.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(`${ctx.daemonUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
  } catch (err) {
    // 把"daemon 没起来"与"请求出错"分开报——这两件事的处置完全不同
    throw new Error(
      `连不上本机 daemon（${ctx.daemonUrl}）。请确认它已经启动：pnpm run daemon` +
        `（原因：${err instanceof Error ? err.message : String(err)}）`,
    )
  }
  const text = await res.text()
  const body = text ? JSON.parse(text) : null
  if (!res.ok) {
    throw new Error((body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`)
  }
  return body
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || v === '') throw new Error(`${field} 必须是非空字符串`)
  return v
}

export const TOOLS: McpTool[] = [
  {
    name: 'list_issues',
    description: '列出本机工作区里的任务（issue）。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '按状态过滤，如 todo / in_progress / done' },
        search: { type: 'string', description: '标题子串检索' },
        limit: { type: 'number', description: '最多返回多少条，默认 50' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const qs = new URLSearchParams()
      if (typeof args['status'] === 'string') qs.set('status', args['status'])
      if (typeof args['search'] === 'string') qs.set('search', args['search'])
      qs.set('limit', String(typeof args['limit'] === 'number' ? args['limit'] : 50))
      return daemonApi(ctx, `/api/issues?${qs}`)
    },
  },
  {
    name: 'get_run',
    description: '读取一次执行的记录与终态。只读。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return daemonApi(ctx, `/api/runs/${encodeURIComponent(str(args['runId'], 'runId'))}`)
    },
  },
  {
    name: 'list_run_verdicts',
    description: '读取某次 run 产生的判决。只读。判决里有结论、理由码、证据与建议动作。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = encodeURIComponent(str(args['runId'], 'runId'))
      return daemonApi(ctx, `/api/runs/${id}/verdicts`)
    },
  },
  {
    name: 'list_run_audits',
    description: '读取某次 run 的审计链。只读。argv 已脱敏。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = encodeURIComponent(str(args['runId'], 'runId'))
      return daemonApi(ctx, `/api/runs/${id}/audits`)
    },
  },
  {
    name: 'list_inbox',
    description: '读取通知中心。只读。只会有需要人介入或需要留意的事项。',
    inputSchema: {
      type: 'object',
      properties: {
        unreadOnly: { type: 'boolean', description: '只看未读，默认 true' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const qs = new URLSearchParams()
      if (args['unreadOnly'] !== false) qs.set('unreadOnly', 'true')
      if (typeof args['limit'] === 'number') qs.set('limit', String(args['limit']))
      return daemonApi(ctx, `/api/inbox?${qs}`)
    },
  },
  {
    name: 'cost_report',
    description:
      '成本汇总：总额、按 agent、按类型，以及有多少条 run 没有上报用量。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      return daemonApi(ctx, '/api/costs')
    },
  },
  {
    name: 'submit_report',
    description:
      '投递一批外部报告（issue 报告 / CI 结果等）。' +
      '这会走既有的审核流程：按 kind 路由给合适的审核 agent，产出结构化判决，' +
      '再由判决触发有界动作。**它本身不执行任何命令。**',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '报告来源标识，如 github / ci / 手工' },
        items: {
          type: 'array',
          description: '报告条目',
          items: {
            type: 'object',
            properties: {
              externalId: { type: 'string', description: '来源侧的稳定 id，用于去重' },
              kind: { type: 'string', description: '类型键，决定路由给哪个审核者' },
              title: { type: 'string' },
              body: { type: 'string' },
            },
            required: ['externalId', 'kind', 'title'],
            additionalProperties: false,
          },
        },
      },
      required: ['source', 'items'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const source = str(args['source'], 'source')
      const items = args['items']
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('items 必须是非空数组')
      }
      // 去重键由**来源 + 外部 id** 组成，在 daemon 侧计算并保证唯一。
      // 这里只负责把材料原样递过去。
      return daemonApi(ctx, '/api/reports', {
        method: 'POST',
        body: JSON.stringify({ source, items }),
      })
    },
  },
]

export function findTool(name: string): McpTool | undefined {
  return TOOLS.find((t) => t.name === name)
}

/** MCP 的 tools/list 载荷。 */
export function toolsList(): { tools: Array<Omit<McpTool, 'run'>> } {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }
}

/**
 * 处理一条 JSON-RPC 请求。
 *
 * 分成"协议层错误"与"工具层错误"两种，因为 MCP 客户端对它们的处理不同：
 *
 *   - **协议层**（未知方法、参数不对）→ JSON-RPC `error`，客户端应当报错；
 *   - **工具层**（daemon 没起来、issue 不存在）→ `result` 里带 `isError: true`，
 *     客户端会把它当作**工具的一次失败返回**交给模型，模型可以据此调整。
 *
 * 把所有失败都塞进 `error` 会让模型看不到失败原因，只能干瞪眼重试。
 */
export async function handleRequest(
  req: JsonRpcRequest,
  ctx: ToolContext,
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null
  const params = req.params ?? {}

  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'alpha-helper', version: '0.1.0' },
        },
      }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      // 通知没有响应——返回 null 让调用方什么都不回。
      return null

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: toolsList() }

    case 'tools/call': {
      const name = params['name']
      if (typeof name !== 'string') {
        return errorResponse(id, -32602, 'tools/call 需要 name')
      }
      const tool = findTool(name)
      if (!tool) {
        // 未知工具名要说清楚有哪些可用——别的 agent 只能靠这句话纠错
        return errorResponse(
          id,
          -32602,
          `未知工具 ${name}。可用：${TOOLS.map((t) => t.name).join(', ')}`,
        )
      }
      const args = (params['arguments'] ?? {}) as Record<string, unknown>
      try {
        const out = await tool.run(args, ctx)
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          },
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `工具 ${name} 失败：${message}` }],
            isError: true,
          },
        }
      }
    }

    default:
      return errorResponse(id, -32601, `不支持的方法：${req.method}`)
  }
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** 生成一个请求 id（测试与 CLI 用）。 */
export function newRequestId(): string {
  return ulid()
}
