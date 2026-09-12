#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { startDaemon, type DaemonHandle } from './server.ts'
import type { SandboxMode } from '@alpha-helper/agent-core'

/**
 * CLI 入口。
 *
 * 命令面刻意保持最小（FR-RUNTIME-05）：首版只要
 * `alpha-helper daemon start` 能起来、能打印地址、能打开浏览器。
 * 参数面越窄，出错空间越小。
 */

/** 固定端口（FR-BRIDGE-14）——随机端口会让"页面怎么找到 daemon"变成一道猜谜。 */
export const DEFAULT_PORT = 4517

export const DEFAULT_DATA_DIR = join(homedir(), '.alpha-helper', 'data')

interface CliOptions {
  port: number
  dataDir: string
  open: boolean
  serveOnly: boolean
  /** 可选沙箱模式（M4）。 */
  sandboxMode: SandboxMode
  /**
   * `--verify-runtime <key>`：只做探测并报告，**不起服务**。
   *
   * 用 `'all'` 表示列出全部 runtime 的验证状态。
   */
  verifyRuntime: string | null
  /**
   * 覆盖 CLI 可执行文件路径。
   *
   * 探测失败时（CLI 装在 PATH 之外）用它，命令与探测**共用同一个值**——
   * 否则会出现"探测的是 A、跑的是 B"这种最难查的不一致。
   */
  executablePath: string | null
  /** 用哪个 runtime 起服务（缺省 claude）。 */
  runtimeKey: string | null
  /**
   * 工作区根目录的显式覆盖（D27）。
   *
   * 缺省是**数据目录之内的 `work/`**——数据目录是这个应用唯一的根，
   * 所以 `--data-dir` 一给出，所有产物的位置都确定了。
   * 想把它单独放到一块盘上时用这个。
   */
  workRoot: string | null
}

const SANDBOX_MODES: readonly SandboxMode[] = ['none', 'workdir-write']

/**
 * 命令行旗标的**唯一真相**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要把它单独抽出来
 * ══════════════════════════════════════════════════════════════════
 *
 * 抽出来之前，`HELP` 文本与这里的 `options` 是**两处各写一遍**，于是
 * "帮助里承诺了某个旗标、但程序根本不认"完全可能发生，而且**没有任何
 * 东西会发现**——`parseArgs` 配了 `strict: false`，不认识的旗标会被
 * 静默忽略（这本身是对的，为了容忍 `daemon start` 这类位置参数）。
 *
 * 凑巧的是我在写 `--verify-runtime` 的提示时**当场就犯了这个错**：
 * 让使用者"用 `--executable` 指定完整路径"，而那个旗标那时并不存在。
 *
 * 所以现在让两者可被**机器比对**：测试会断言 `HELP` 里出现的每一个
 * `--flag` 都在本表里。承诺与实现之间不再隔着人眼。
 */
export const CLI_OPTIONS = {
  port: { type: 'string', short: 'p' },
  'data-dir': { type: 'string' },
  'no-open': { type: 'boolean' },
  'serve-only': { type: 'boolean' },
  sandbox: { type: 'string' },
  'verify-runtime': { type: 'string' },
  executable: { type: 'string' },
  'runtime-key': { type: 'string' },
  'work-root': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: CLI_OPTIONS,
    allowPositionals: true,
    strict: false,
  })

  // ══════════════════════════════════════════════════════════════════
  // `--` 必须**明确拒绝**，不能静默当成位置参数
  // ══════════════════════════════════════════════════════════════════
  //
  // `parseArgs` 遇到 `--` 就把它之后的一切都当位置参数。而
  // `pnpm run daemon -- --port 4517` 这种写法**极其常见**，于是所有选项
  // 都被悄悄忽略、回落到默认值。
  //
  // 为什么这不能忍——两个真实的后果：
  //
  //   1. `--data-dir` 被忽略 ⇒ daemon 写到**别的目录**去，使用者却以为
  //      数据在那里（实测撞到的就是这个：它去建 `~/.alpha-helper` 了）；
  //   2. `--sandbox workdir-write` 被忽略 ⇒ 沙箱**根本没开**，而使用者
  //      以为自己被保护着。这正是本项目反复在防的那种失败：**把安全感
  //      本身变成假的**。
  //
  // 端口那个例子还会更隐蔽：`--port 4517` 恰好等于默认值，所以看不出任何异常。
  const ddIdx = argv.indexOf('--')
  if (ddIdx !== -1) {
    throw new Error(
      `检测到 \`--\`：它之后的选项会被当成位置参数而**全部被忽略**。` +
        `pnpm 会把 \`pnpm run daemon -- --port 4517\` 里的 \`--\` 一并传给本程序，` +
        `所以请直接写 \`pnpm run daemon --port 4517\`（去掉那个 \`--\`）。` +
        `这里选择报错而不是静默回落到默认值——那会让你以为选项生效了。`,
    )
  }

  const portRaw = values['port']
  const port = portRaw === undefined ? DEFAULT_PORT : Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口不合法：${String(portRaw)}`)
  }

  const dataDirRaw = values['data-dir']

  // 沙箱模式**严格校验**：写错了就报错退出，而不是悄悄退回 none。
  // 一个拼错的 --sandbox 参数不该让使用者以为沙箱开着。
  const sandboxRaw = values['sandbox']
  const sandboxMode = (sandboxRaw ?? 'none') as SandboxMode
  if (!SANDBOX_MODES.includes(sandboxMode)) {
    throw new Error(
      `--sandbox 取值不合法：${String(sandboxRaw)}（可选：${SANDBOX_MODES.join(' | ')}）`,
    )
  }

  const verifyRaw = values['verify-runtime']

  return {
    port,
    dataDir: typeof dataDirRaw === 'string' ? dataDirRaw : DEFAULT_DATA_DIR,
    open: values['no-open'] !== true,
    serveOnly: values['serve-only'] === true,
    sandboxMode,
    verifyRuntime: typeof verifyRaw === 'string' ? verifyRaw : null,
    executablePath: typeof values['executable'] === 'string' ? values['executable'] : null,
    runtimeKey: typeof values['runtime-key'] === 'string' ? values['runtime-key'] : null,
    workRoot: typeof values['work-root'] === 'string' ? values['work-root'] : null,
  }
}

export const HELP = `alpha-helper —— 本机 AI 工作台

用法：
  alpha-helper [daemon start] [选项]

选项：
  -p, --port <端口>     本地端口（默认 ${DEFAULT_PORT}）
      --data-dir <路径> 数据目录（默认 ${DEFAULT_DATA_DIR}）
      --no-open         启动后不自动打开浏览器
      --serve-only      只起服务，不打开浏览器（等价于 --no-open）
      --sandbox <模式>  none（默认）| workdir-write
                        只允许写工作目录。**只在 macOS/Linux 上可用**，
                        且**不是安全边界**——它挡误操作，不挡对手。
                        开启后若缺工具（sandbox-exec / bwrap），起 run 时会
                        明确报错，不会静默退回无沙箱。
      --executable <路径>  覆盖 CLI 可执行文件路径（探测与执行共用同一个值）
      --runtime-key <key>  用哪个 runtime 起服务（默认 claude）
      --work-root <路径>   工作区根目录（默认 <数据目录>/work）
      --verify-runtime <key|all>
                        只探测并报告 CLI 的版本验证状态（FR-CLI-07），不起服务。
                        它**不会**替你宣称"已验证"——真实端到端验证要你自己跑。
  -h, --help            显示本帮助

说明：
  界面与接口都由本进程在回环地址上托管，因此页面与接口同源。
  另有 daemon 停止方式：Ctrl-C。
`

/** 打开系统默认浏览器。失败不影响服务（使用者可以手点 URL）。 */
export function openBrowser(url: string): void {
  const platform = process.platform
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => {
      /* 打不开就让使用者自己点 */
    })
    child.unref()
  } catch {
    /* 同上 */
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP)
    return 0
  }

  let options: CliOptions
  try {
    options = parseCliArgs(argv)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${HELP}`)
    return 2
  }

  // --verify-runtime 是**只读探测**，不起服务、不碰数据目录。
  // 放在这里而不是起完服务再问，是因为它的用途恰恰是"服务起不来/行为可疑时
  // 先看看 CLI 到底是什么版本"。
  if (options.verifyRuntime !== null) {
    const { renderVerifyReport, verifyAllRuntimes, verifyRuntime } = await import('./verify-runtime.ts')
    try {
      const reports =
        options.verifyRuntime === 'all'
          ? await verifyAllRuntimes(options.executablePath ?? undefined)
          : [await verifyRuntime(options.verifyRuntime, options.executablePath ?? undefined)]
      process.stdout.write(renderVerifyReport(reports))
      // ★ 退出码反映的是"**探测**是否成功"，不是"是否已验证"。
      //   用退出码宣称"验证通过"会让 CI 里一条命令就假装完成了人工验证。
      const probed = reports.every((r) => r.found)
      return probed ? 0 : 1
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      return 2
    }
  }

  let daemon: DaemonHandle
  try {
    daemon = await startDaemon({
      dataDir: options.dataDir,
      port: options.port,
      sandboxMode: options.sandboxMode,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      ...(options.runtimeKey ? { runtimeKey: options.runtimeKey } : {}),
      ...(options.workRoot ? { workRoot: options.workRoot } : {}),
      onInfo: (m) => process.stdout.write(`${m}\n`),
      onWarn: (m) => process.stderr.write(`[警告] ${m}\n`),
    })
  } catch (err) {
    // 端口被占用之类的启动失败必须说清楚——静默换端口会让页面连不上
    process.stderr.write(
      `daemon 启动失败：${err instanceof Error ? err.message : String(err)}\n` +
        `提示：若端口 ${options.port} 被占用，可用 --port 指定别的端口。\n`,
    )
    return 1
  }

  process.stdout.write(`\nalpha-helper 已就绪\n  地址：${daemon.url}\n  数据：${options.dataDir}\n`)
  // ★ 沙箱状态必须**每次启动都报**，而不是只在开启时报。
  //   "这次跑的东西有没有被沙箱"是个要紧的事实，不该要人去翻命令历史。
  process.stdout.write(
    options.sandboxMode === 'none'
      ? '  沙箱：未启用 —— run 以当前用户的完整权限执行（NG7）\n\n'
      : `  沙箱：${options.sandboxMode} —— 只允许写工作目录；⚠️ 不是安全边界\n\n`,
  )
  process.stdout.write('按 Ctrl-C 停止。\n')

  if (options.open && !options.serveOnly) openBrowser(daemon.url)

  const shutdown = async (): Promise<void> => {
    process.stdout.write('\n正在停止…\n')
    await daemon.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  // 保持进程存活
  return new Promise<number>(() => {
    /* 直到收到信号 */
  })
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')

if (invokedDirectly) {
  void main().then((code) => {
    if (code !== 0) process.exit(code)
  })
}
