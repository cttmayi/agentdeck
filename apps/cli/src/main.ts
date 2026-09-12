#!/usr/bin/env node
import {
  COMMANDS,
  CommandError,
  DaemonUnreachableError,
  DEFAULT_DAEMON_URL,
  findCommand,
  renderHuman,
} from './commands.ts'
import { USAGE, UsageError, parseArgs } from './args.ts'

/**
 * 退出码（FR-INTEG-02）。
 *
 * 脚本与 agent 靠它分支，**不需要去解析文本**。这是"agent 可驱动"
 * 这个要求里最实际的一条：解析人类可读输出的正则极其脆弱，
 * 换一个措辞就坏，而退出码不会。
 */
const EXIT = {
  ok: 0,
  /** 业务失败（daemon 拒绝了这次操作）。 */
  failed: 1,
  /** 用法错误（参数不对、命令不存在）。 */
  usage: 2,
  /** 连不上 daemon —— 与"操作失败"分开，因为处置完全不同。 */
  unreachable: 3,
} as const

async function main(argv: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs(argv)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
    return EXIT.usage
  }

  if (parsed.flags.has('help') || parsed.command === null || parsed.command === 'help') {
    process.stdout.write(USAGE)
    return EXIT.ok
  }

  const spec = findCommand(parsed.command)
  if (!spec) {
    // 未知命令要把可用命令列出来——不然调用方只能去读源码
    process.stderr.write(
      `未知命令：${parsed.command}\n可用命令：${COMMANDS.map((c) => c.name).join(', ')}\n`,
    )
    return EXIT.usage
  }

  if (spec.needsPositional && parsed.positionals.length === 0) {
    process.stderr.write(`${spec.name} 需要一个参数。\n\n${USAGE}`)
    return EXIT.usage
  }

  const daemonUrl = (parsed.flags.get('daemon') as string | undefined) ?? DEFAULT_DAEMON_URL

  try {
    const result = await spec.run(
      { daemonUrl, fetchImpl: fetch },
      { positionals: parsed.positionals, flags: parsed.flags },
    )
    const human = parsed.flags.has('human')
    process.stdout.write(
      human ? `${renderHuman(result)}\n` : `${JSON.stringify(result, null, 2)}\n`,
    )
    return EXIT.ok
  } catch (err) {
    if (err instanceof DaemonUnreachableError) {
      process.stderr.write(`${err.message}\n`)
      return EXIT.unreachable
    }
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${USAGE}`)
      return EXIT.usage
    }
    if (err instanceof CommandError) {
      process.stderr.write(`${err.message}\n`)
      return EXIT.failed
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT.failed
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = EXIT.failed
  })
