/**
 * 命令行命令实现（FR-INTEG-02）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 与 MCP server 共用同一套 HTTP 接口，因此**权限边界也必须一致**
 * ══════════════════════════════════════════════════════════════════
 *
 * MCP 那边刻意不暴露 `POST /api/runs`（它接受任意 `workDir`，然后在那个
 * 目录里启动一个会读写文件的子进程——那等于把"在你机器上按我给的路径执行
 * agent"变成一次普通调用）。
 *
 * 这个 CLI 同样不提供。理由一模一样，而且这里更危险：CLI 是给**脚本**用的，
 * 一个能提交任意 run 的 CLI 就是一条现成的代码执行入口。
 * 要跑东西请走 `reports` → 审核 → 判决 → 有界动作这条路，
 * 或者由人在页面上动手。
 */

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:4517'

export class CommandError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'CommandError'
    this.status = status
  }
}

/** 连不上 daemon —— 单独一类，因为它的处置与业务失败完全不同。 */
export class DaemonUnreachableError extends Error {
  constructor(url: string, cause: unknown) {
    super(
      `连不上本机 daemon（${url}）。请确认它已经启动：pnpm run daemon\n` +
        `（原因：${cause instanceof Error ? cause.message : String(cause)}）`,
    )
    this.name = 'DaemonUnreachableError'
  }
}

export interface CommandContext {
  daemonUrl: string
  fetchImpl: typeof fetch
}

async function api(
  ctx: CommandContext,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  let res: Response
  try {
    res = await ctx.fetchImpl(`${ctx.daemonUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
  } catch (err) {
    throw new DaemonUnreachableError(ctx.daemonUrl, err)
  }
  const text = await res.text()
  const body = text ? (JSON.parse(text) as unknown) : null
  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`
    throw new CommandError(message, res.status)
  }
  return body
}

export interface CommandSpec {
  name: string
  summary: string
  /** 需要位置参数吗（用于用法校验）。 */
  needsPositional?: boolean
  run: (ctx: CommandContext, args: { positionals: string[]; flags: Map<string, string | boolean> }) => Promise<unknown>
}

const str = (flags: Map<string, string | boolean>, name: string): string | null => {
  const v = flags.get(name)
  return typeof v === 'string' ? v : null
}

const num = (flags: Map<string, string | boolean>, name: string): number | null => {
  const v = str(flags, name)
  if (v === null) return null
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new CommandError(`--${name} 需要一个正整数`)
  return n
}

function qs(pairs: Array<[string, string | null]>): string {
  const usp = new URLSearchParams()
  for (const [k, v] of pairs) if (v !== null) usp.set(k, v)
  const s = usp.toString()
  return s === '' ? '' : `?${s}`
}

export const COMMANDS: CommandSpec[] = [
  {
    name: 'status',
    summary: 'daemon 与 runtime 的状态',
    async run(ctx) {
      return api(ctx, '/api/identity')
    },
  },
  {
    name: 'issues',
    summary: '列出任务',
    async run(ctx, { flags }) {
      return api(
        ctx,
        `/api/issues${qs([
          ['status', str(flags, 'status')],
          ['search', str(flags, 'search')],
          ['limit', num(flags, 'limit')?.toString() ?? null],
        ])}`,
      )
    },
  },
  {
    name: 'issue-create',
    summary: '建一个任务',
    needsPositional: true,
    async run(ctx, { positionals, flags }) {
      const title = positionals[0]
      if (!title) throw new CommandError('需要标题：agentdeck issue-create "标题"')
      return api(ctx, '/api/issues', {
        method: 'POST',
        body: JSON.stringify({ title, description: str(flags, 'desc') ?? '' }),
      })
    },
  },
  {
    name: 'runs',
    summary: '列出执行记录',
    async run(ctx, { flags }) {
      return api(ctx, `/api/runs${qs([['limit', num(flags, 'limit')?.toString() ?? null]])}`)
    },
  },
  {
    name: 'run',
    summary: '看一条执行的详情',
    needsPositional: true,
    async run(ctx, { positionals }) {
      return api(ctx, `/api/runs/${encodeURIComponent(positionals[0]!)}`)
    },
  },
  {
    name: 'run-verdicts',
    summary: '看某条执行的判决',
    needsPositional: true,
    async run(ctx, { positionals }) {
      return api(ctx, `/api/runs/${encodeURIComponent(positionals[0]!)}/verdicts`)
    },
  },
  {
    name: 'run-audits',
    summary: '看某条执行的审计链',
    needsPositional: true,
    async run(ctx, { positionals }) {
      return api(ctx, `/api/runs/${encodeURIComponent(positionals[0]!)}/audits`)
    },
  },
  {
    name: 'run-cancel',
    summary: '取消一条执行',
    needsPositional: true,
    async run(ctx, { positionals }) {
      return api(ctx, `/api/runs/${encodeURIComponent(positionals[0]!)}/cancel`, {
        method: 'POST',
      })
    },
  },
  {
    name: 'reports',
    summary: '投递报告（它本身不执行任何命令）',
    async run(ctx, { flags }) {
      const source = str(flags, 'source')
      if (!source) throw new CommandError('需要 --source <来源标识>')
      const file = str(flags, 'file')
      if (!file) throw new CommandError('需要 --file <路径>（- 表示标准输入）')

      let raw: string
      if (file === '-') {
        raw = await readStdin()
      } else {
        const { readFile } = await import('node:fs/promises')
        raw = await readFile(file, 'utf8')
      }
      let items: unknown
      try {
        items = JSON.parse(raw)
      } catch (err) {
        throw new CommandError(
          `--file 的内容不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (!Array.isArray(items) || items.length === 0) {
        throw new CommandError('报告条目必须是非空 JSON 数组')
      }
      return api(ctx, '/api/reports', {
        method: 'POST',
        body: JSON.stringify({ source, items }),
      })
    },
  },
  {
    name: 'inbox',
    summary: '看通知',
    async run(ctx, { flags }) {
      return api(
        ctx,
        `/api/inbox${qs([
          ['unreadOnly', flags.has('all') ? 'false' : 'true'],
          ['limit', num(flags, 'limit')?.toString() ?? null],
        ])}`,
      )
    },
  },
  {
    name: 'inbox-read',
    summary: '把通知标为已读',
    needsPositional: true,
    async run(ctx, { positionals }) {
      return api(ctx, `/api/inbox/${encodeURIComponent(positionals[0]!)}/read`, {
        method: 'POST',
      })
    },
  },
  {
    name: 'costs',
    summary: '成本汇总',
    async run(ctx) {
      return api(ctx, '/api/costs')
    },
  },
  {
    name: 'audits-export',
    summary: '导出审计（写到标准输出）',
    async run(ctx, { flags }) {
      return api(
        ctx,
        `/api/audits/export${qs([['runId', str(flags, 'run')]])}`,
      )
    },
  },
  {
    name: 'skills',
    summary: '列出技能',
    async run(ctx) {
      return api(ctx, '/api/skills')
    },
  },
  {
    name: 'agents',
    summary: '列出 agent',
    async run(ctx) {
      return api(ctx, '/api/agents')
    },
  },
]

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 人类可读渲染。
 *
 * 只做最朴素的缩进，刻意不引第三方格式库：这个 CLI 的**主要**输出形态是
 * JSON（给 agent 用），人类可读只是方便随手看一眼。为了"好看"引一个依赖，
 * 会让一个只为便利存在的功能带来供应链与体积成本。
 */
export function renderHuman(value: unknown): string {
  if (value === null || value === undefined) return '(空)'
  if (Array.isArray(value)) {
    if (value.length === 0) return '(空列表)'
    return value.map((v, i) => `[${i}] ${renderHuman(v)}`).join('\n')
  }
  if (typeof value !== 'object') return String(value)
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => {
      if (v !== null && typeof v === 'object') {
        const inner = renderHuman(v)
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n')
        return `  ${k}:\n${inner}`
      }
      return `  ${k}: ${String(v)}`
    })
    .join('\n')
}
