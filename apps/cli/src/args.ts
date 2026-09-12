import { DEFAULT_DAEMON_URL } from './commands.ts'

/**
 * `alpha-helper` 命令行（FR-INTEG-02）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它是 daemon 的**客户端**，不是 daemon 的一部分
 * ══════════════════════════════════════════════════════════════════
 *
 * 需求里那半句"**且 agent 可通过同一 CLI 驱动本系统**"决定了它的形状：
 * 它必须是一个**能被脚本和 agent 调用**的东西，而不是 daemon 的一个启动参数。
 *
 * 所以它：
 *   - 只通过本机 HTTP 接口说话，不 import daemon 的任何模块；
 *   - **默认输出 JSON**（机器可读优先）。人要看好读的输出时加 `--human`。
 *     反过来（默认给人看、加 `--json`）会让 agent 每次都得记得加参数，
 *     而"忘加参数导致解析失败"是个纯粹的浪费。
 *   - 退出码有含义：0 成功、1 业务失败、2 用法错误、3 连不上 daemon。
 *     脚本靠它分支，不需要去解析文本。
 *
 * ⚠️ 与 MCP server（`apps/mcp`）的分工：MCP 面向**模型**（工具调用协议），
 *    本 CLI 面向**人和脚本**（进程 + 退出码 + 标准输出）。
 *    两者共用同一套 HTTP 接口，所以**权限边界必须一致**——
 *    本 CLI 同样**不提供**"提交任意 run"（那是任意目录代码执行）。
 */

const USAGE = `alpha-helper —— 命令行（需要本机 daemon 正在运行）

用法：
  alpha-helper <命令> [参数] [--daemon <url>]

命令：
  status                       daemon 与 runtime 的状态（含版本验证、会话状态）
  issues [--status s] [--search q] [--limit n]
                              列出任务
  issue-create <标题> [--desc 描述]
                              建一个任务
  runs [--limit n]            列出执行记录
  run <runId>                 看一条执行的详情
  run-verdicts <runId>        看某条执行的判决
  run-audits <runId>          看某条执行的审计链
  run-cancel <runId>          取消一条执行
  reports --source s --file f 投递报告（f 为 JSON 数组；- 表示标准输入）
  inbox [--all]               看通知
  inbox-read <id>             把通知标为已读
  costs                       成本汇总
  audits-export [--run <id>]  导出审计（写到标准输出）
  skills                      列出技能
  agents                      列出 agent

选项：
      --daemon <url>          本机 daemon 地址（默认 ${DEFAULT_DAEMON_URL}）
      --human                 输出人类可读的格式（默认 JSON）
  -h, --help                  显示本帮助

退出码：
  0 成功   1 业务失败   2 用法错误   3 连不上 daemon
`

export interface ParsedArgs {
  command: string | null
  positionals: string[]
  flags: Map<string, string | boolean>
}

/**
 * 极简参数解析。
 *
 * 刻意不用 `node:util` 的 `parseArgs`——那个 API 遇到 `--` 会把之后的一切
 * 当成位置参数，而 `pnpm run cli -- ...` 这种写法极其常见（daemon 的 CLI
 * 就为此专门加了一道拒绝）。这里**显式**把 `--` 当成用法错误，
 * 而不是让它悄悄吞掉后面所有选项。
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const ddIndex = argv.indexOf('--')
  if (ddIndex !== -1) {
    throw new UsageError(
      '检测到 `--`：它之后的选项会被当成位置参数而全部失效。' +
        '请直接写 `pnpm run cli <命令>`，去掉那个 `--`。',
    )
  }

  const flags = new Map<string, string | boolean>()
  const positionals: string[] = []
  let command: string | null = null

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(name, next)
        i += 1
      } else {
        flags.set(name, true)
      }
      continue
    }
    if (command === null) command = token
    else positionals.push(token)
  }

  return { command, positionals, flags }
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export { USAGE }
