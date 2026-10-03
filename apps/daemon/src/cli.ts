#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readdir, rename, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { startDaemon, type DaemonHandle } from './server.ts'
import { defaultWorkRoot, fallbackWorkRoot, migrateLegacyWorkRoot } from './workdir.ts'
import type { SandboxMode } from '@agentdeck/agent-core'
import { DEFAULT_GITHUB_PROXY, resolveGithubProxy } from '@agentdeck/skill-source'

/**
 * CLI 入口。
 *
 * 命令面刻意保持最小（FR-RUNTIME-05）：首版只要
 * `agentdeck daemon start` 能起来、能打印地址、能打开浏览器。
 * 参数面越窄，出错空间越小。
 */

/** 固定端口（FR-BRIDGE-14）——随机端口会让"页面怎么找到 daemon"变成一道猜谜。 */
export const DEFAULT_PORT = 4517

export const DEFAULT_DATA_DIR = join(homedir(), '.agentdeck', 'data')

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
  /** GitHub 加速器（第三方，默认 null = 直连；见 server.ts 的 `DaemonOptions.githubProxy`）。 */
  githubProxy: string | null
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
  'github-proxy': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const

/**
 * `--github-proxy` 的值是**可选**的（裸写 = 用默认加速器），而 `node:util` 的
 * `parseArgs` 会把**紧跟其后的旗标**当成它的值（`--github-proxy --port 9` ⇒ 值变成
 * `'--port'`，端口那项就丢了）。所以先把它补成明确的值，再交给 parseArgs。
 *
 * ★ 这条不是防御性编程：daemon 的帮助里就写着"裸写就用默认值"，而 `--github-proxy --port`
 *   这种组合是**最自然**的打法（先想起加速器，再想起端口）。
 */
function fillOptionalValueFlag(
  argv: readonly string[],
  flag: string,
  fallback: string,
): string[] {
  const out = [...argv]
  const idx = out.indexOf(flag)
  if (idx === -1) return out
  const next = out[idx + 1]
  if (next === undefined || next.startsWith('-')) out.splice(idx + 1, 0, fallback)
  return out
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const { values } = parseArgs({
    args: fillOptionalValueFlag(argv, '--github-proxy', DEFAULT_GITHUB_PROXY),
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
  //      数据在那里（实测撞到的就是这个：它去建 `~/.agentdeck` 了）；
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
    // ⚠️ 校验**严格**（与 --sandbox 同一个口径）：写错了就报错退出，而不是
    //    悄悄直连——"我以为走了加速器"与"我以为沙箱开着"是同一类假安全感。
    //    裸写旗标 ⇒ `DEFAULT_GITHUB_PROXY`（`fillOptionalValueFlag` 已经补好值）；
    //    `--github-proxy off` ⇒ 直连。判据在共用包里的 `resolveGithubProxy`。
    //    ⚠️ **只认旗标**：环境变量只对同步工具有效（守护进程的配置应当写在命令行上，
    //    而不是靠 shell 里恰好 export 了什么）。
    githubProxy: resolveGithubProxy(
      typeof values['github-proxy'] === 'string'
        ? { flagValue: values['github-proxy'] }
        : {},
    ),
  }
}

export const HELP = `agentdeck —— 本机 AI 工作台

用法：
  agentdeck [daemon start] [选项]

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
      --work-root <路径>   工作区根目录（默认 ~/agentdeck-workspace）
      --github-proxy [地址] 从 GitHub 装 skill 时走**加速器**（默认直连）。
                        ⚠️ 它是**第三方**：能看也能改转发过来的内容，所以默认不用、
                        只在显式指定时启用；凭证**不会**交给它。
                        **不带地址就用 https://gh-proxy.com**（裸写这个旗标即可）。
                        例：--github-proxy            （= gh-proxy.com）
                            --github-proxy https://别的加速器
                            --github-proxy off        （这次直连）
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

/**
 * 改名（2026-09：alpha-helper → agentdeck）之后的数据目录迁移。
 *
 * 与 `migrateLegacyWorkRoot`（`workdir.ts`）同一套"只在完全安全的情况下搬"的
 * 规矩：
 *
 *   - 新目录（`~/.agentdeck/data`）不存在，或只是个空目录（**绝不覆盖**——
 *     那可能正是使用者手动指定的数据目录）；
 *   - 旧目录（`~/.alpha-helper/data`）存在且非空（没东西可搬就不搬）；
 *   - `rename` 成功（同盘是原子的；跨盘会 EXDEV，此时只警告、不删源）。
 *
 * 只在**用默认数据目录**（没给 `--data-dir`）时调用——显式指定 `--data-dir`
 * 的人是在指一块他自己的地盘，不该被悄悄搬走。
 */
export async function migrateLegacyDataDir(input: {
  dataDir: string
  /** 旧数据目录。缺省是改名前的默认位置（可注入以便测试）。 */
  legacyDataDir?: string
  onInfo?: (message: string) => void
  onWarn?: (message: string) => void
}): Promise<'moved' | 'skipped' | 'failed'> {
  const info = input.onInfo ?? ((): void => {})
  const warn = input.onWarn ?? ((): void => {})
  const legacyDataDir = input.legacyDataDir ?? join(homedir(), '.alpha-helper', 'data')
  const { dataDir } = input

  if (legacyDataDir === dataDir) return 'skipped'

  let legacyEntries: string[]
  try {
    legacyEntries = await readdir(legacyDataDir)
  } catch {
    return 'skipped' // 旧目录不存在：全新安装，没什么可搬
  }
  if (legacyEntries.length === 0) return 'skipped'

  const targetEntries = await readdir(dataDir).catch(() => null)
  if (targetEntries !== null && targetEntries.length > 0) {
    // 新目录已经有东西了：那是使用者的地盘，什么都不碰
    warn(
      `数据目录已经是 ${dataDir}，但旧目录 ${legacyDataDir} 里还有 ${legacyEntries.length} 项，` +
        `因为新目录非空所以没有搬。旧目录里的内容没有丢，需要的话自行合并。`,
    )
    return 'skipped'
  }

  try {
    await mkdir(dirname(dataDir), { recursive: true })
    // 新目录刚才可能是"存在但是空的"，rename 到一个已存在的空目录在 POSIX 下
    // 会失败（ENOTEMPTY/EEXIST 视实现），所以先把它去掉
    if (targetEntries !== null) await rmdir(dataDir).catch(() => undefined)
    await rename(legacyDataDir, dataDir)
  } catch (err) {
    // ⚠️ 这里只警告、**不删源**：搬不动就维持原样，旧目录仍然可用
    warn(
      `数据目录迁移失败（${legacyDataDir} → ${dataDir}）：${(err as Error).message}。` +
        `旧内容原样保留，新任务会使用新位置。`,
    )
    return 'failed'
  }

  info(`数据目录已迁移：${legacyDataDir} → ${dataDir}（${legacyEntries.length} 项）`)
  return 'moved'
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
    // ══════════════════════════════════════════════════════════════════
    // 工作目录放哪 —— 到这里才决定，因为这是**面向使用者的产品决定**
    // ══════════════════════════════════════════════════════════════════
    //
    // `startDaemon` 的兜底是数据目录之内的 `work/`（自洽、不碰家目录）。
    // 但只要是人自己在跑 agentdeck，缺省就该是一块**看得见**的地方：
    // 工作目录装的是 agent 真正的产出，使用者要用 Finder 打开、要在终端里
    // `cd` 进去。藏在 `~/.agentdeck/data/work/` 里等于找不到。
    const workRoot = options.workRoot ?? defaultWorkRoot()

    // ★ 只有用默认位置时才迁移旧目录。
    //
    //   显式给了 `--work-root` 的人是在指定一块**他自己的**地盘（某个项目、
    //   某块盘）。往那里搬历史目录是没人要求过的副作用——他指定什么就该是
    //   什么。
    if (!options.workRoot) {
      await migrateLegacyWorkRoot({
        legacyRoot: fallbackWorkRoot(options.dataDir),
        workRoot,
        onInfo: (m) => process.stdout.write(`${m}\n`),
        onWarn: (m) => process.stderr.write(`[警告] ${m}\n`),
      })
    }

    // ★ 只有用默认数据目录时才迁移旧目录。显式给 `--data-dir` 的人指定的是
    //   他自己的地盘，不该被悄悄搬走。
    if (options.dataDir === DEFAULT_DATA_DIR) {
      await migrateLegacyDataDir({
        dataDir: options.dataDir,
        onInfo: (m) => process.stdout.write(`${m}\n`),
        onWarn: (m) => process.stderr.write(`[警告] ${m}\n`),
      })
    }

    daemon = await startDaemon({
      dataDir: options.dataDir,
      port: options.port,
      sandboxMode: options.sandboxMode,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      ...(options.runtimeKey ? { runtimeKey: options.runtimeKey } : {}),
      workRoot,
      ...(options.githubProxy ? { githubProxy: options.githubProxy } : {}),
      onInfo: (m) => process.stdout.write(`${m}\n`),
      onWarn: (m) => process.stderr.write(`[警告] ${m}\n`),
    })
    if (options.githubProxy) {
      // ★ 必须**大声说**：从这里开始，每一次"从 GitHub 装 skill"都会经过第三方主机，
      //   而它能看、也能改内容。这种事实不该只写在帮助文本里等人去读。
      process.stdout.write(
        `⚠️ GitHub 加速器已启用：${new URL(options.githubProxy).hostname}\n` +
          '   从 GitHub 装 skill 的请求都会经过它（第三方，能看也能改内容）；' +
          '凭证不会交给它。\n',
      )
    }
  } catch (err) {
    // 端口被占用之类的启动失败必须说清楚——静默换端口会让页面连不上
    process.stderr.write(
      `daemon 启动失败：${err instanceof Error ? err.message : String(err)}\n` +
        `提示：若端口 ${options.port} 被占用，可用 --port 指定别的端口。\n`,
    )
    return 1
  }

  // 工作目录要印出来：它是使用者会真的进去翻的地方，而"它在哪"不是一个
  // 能靠猜的东西（旧版本藏在 data/work 下面两层）。
  process.stdout.write(
    `\nAgentDeck 已就绪\n  地址：${daemon.url}\n  数据：${options.dataDir}\n` +
      `  工作目录：${daemon.workRoot}\n`,
  )
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
