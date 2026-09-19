import { spawn as spawnChildProcess, type ChildProcess } from 'node:child_process'
import { access, constants, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { ToolRuntime } from '@alpha-helper/protocol'

/**
 * 工具脚本执行器（D40）：把第三方工具包里的脚本**跑起来**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它只做四件事，第五件以上的都不做
 * ══════════════════════════════════════════════════════════════════
 *
 *   ① 把包里的文件**物化**到本次执行专用的临时目录；
 *   ② 用白名单（runtime）决定用什么解释器跑哪个入口；
 *   ③ 走约定的 stdin/stdout 协议：stdin 一份 JSON 进去，stdout 一份 JSON 出来；
 *   ④ 把结果变成 `{ ok, detail, exitCode?, timedOut?, durationMs }`。
 *
 * **不做**的事（平台保留的四件：参数绑定与校验、幂等、审计、状态）：
 *
 *   · **不重试**。脚本失败就是失败——重试是平台在别处按策略决定的事，
 *     而"执行器自己偷偷重跑一遍"会让审计里出现两次副作用、一次记录；
 *   · **不写任何 store**。状态由 `ActionRunner` 按结果写（`executed` / `failed`），
 *     执行器连 store 都不认识；
 *   · **不判定成败的语义**。脚本说 `ok: false` 就是失败，退出码非 0 就是失败，
 *     平台不替它解释"这其实算成功"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不许用 `tmpdir()`
 * ══════════════════════════════════════════════════════════════════
 *
 * 临时目录的**父目录**由调用方给（daemon 数据目录下的一个子目录）。
 * 理由有两条，都不只是洁癖：
 *
 *   1. 系统临时目录在受限环境（容器、沙箱、专用用户）里可能根本写不了——
 *      而"把 daemon 跑在受限环境里"是推荐做法；
 *   2. 它是**共享**的：同一台机器上别的进程能读到我们物化出去的包内容，
 *      也能在我们的目录里塞东西（符号链接是最经典的一种）。
 *
 * 仓库里还有一条机器检查（`tests/test-safety.test.ts`）专门守这件事。
 */

// ══════════════════════════════════════════════════════════════════
// 输入 / 输出
// ══════════════════════════════════════════════════════════════════

/** 执行一个动作所需要知道的最小事实（定义里与执行有关的那部分）。 */
export interface ScriptActionSpec {
  /** 完整动作名（`<包 slug>.<动作名>`）——进脚本 stdin 的 `action` 字段。 */
  type: string
  /** 包 slug。 */
  slug: string
  runtime: ToolRuntime
  /** 相对包根的入口。 */
  entry: string
  timeoutMs: number
  /** 清单里声明的 dry-run 能力。`unsupported` 时平台**不许**在演练模式下跑它。 */
  dryRun: 'supported' | 'unsupported'
}

/** 这次执行的处境。它会原样作为 `context` 进脚本的 stdin。 */
export interface ScriptContext {
  /** 这次 run 的工作目录（绝对路径）。**同时**也是子进程的 cwd。 */
  workdir: string | null
  runId: string | null
  workspaceId: string
}

export interface ScriptExecutionRequest {
  action: ScriptActionSpec
  /**
   * ★ **已经合并好的最终参数**（bound + open）。
   *
   * 执行器不做 bound/open 的区分——边界是平台的事，不该漏给脚本：脚本拿到
   * 的就是"照着用就行"的一份参数。它也不该去猜"哪个值是模型给的"。
   */
  params: Readonly<Record<string, unknown>>
  dryRun: boolean
  context: ScriptContext
  /** 该工具包的文件集合（`Tool.files`：相对路径 → 文本内容）。 */
  files: Readonly<Record<string, string>>
}

/**
 * 结果。**状态由平台写**，这里只回答"发生了什么"。
 *
 * `exitCode` / `timedOut` 只在真的起了进程时才有意义；`detail` 是**给人看的
 * 一句话**——它会进动作记录、审计与失败通知，所以要写清"为什么"，
 * 而不是"失败了"。
 */
export interface ScriptExecutionResult {
  ok: boolean
  detail: string
  exitCode?: number | null
  timedOut?: boolean
  durationMs: number
}

// ══════════════════════════════════════════════════════════════════
// 起进程：可注入
// ══════════════════════════════════════════════════════════════════

export interface SpawnScriptInput {
  command: string
  args: readonly string[]
  cwd: string
  /** 白名单算出来的环境（**不是** daemon 的 `process.env`）。 */
  env: Record<string, string>
  onStdout: (chunk: string) => void
  onStderr: (chunk: string) => void
  /** 启动失败（ENOENT/EACCES）。有的平台上是**异步**事件，不是同步抛错。 */
  onError: (err: Error) => void
}

/** 执行器需要子进程提供的那**最小**几样东西。 */
export interface ScriptProcess {
  readonly pid: number | undefined
  writeStdin(data: string): void
  endStdin(): void
  /** 终止**整个进程组**（不只是直接子进程），理由见 `killProcessTree`。 */
  terminate(): void
  /** 子进程退出（或启动失败）。 */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

/**
 * `spawn` 的替身接口。
 *
 * ★ 为什么要可注入：这个文件里**最容易出错的分支全都在"异常路径"上**——
 *   超时、非 0 退出、stdout 不是 JSON、进程根本没起来。这些分支用真进程
 *   测起来要么慢（等真的超时）、要么不稳（靠脚本故意崩）。做成可注入之后，
 *   每条异常路径都能在一次同步的单测里钉住；真起进程那条留给**一条**集成
 *   测试（真跑 `examples/tools/example-note`）。
 */
export type SpawnScript = (input: SpawnScriptInput) => ScriptProcess

/** 默认实现：`node:child_process.spawn`。 */
export function nodeSpawn(): SpawnScript {
  return (input) => {
    const child = spawnChildProcess(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // ★ 新进程组（Unix）：超时时要能**整组**杀掉。脚本很可能会自己派生子
      //   进程（跑个命令、起个构建），只杀直接子进程会在使用者机器上留下
      //   孤儿——它们继续占着端口、改着文件，而使用者以为动作已经停了。
      detached: process.platform !== 'win32',
      windowsHide: true,
    })

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => input.onStdout(chunk))
    child.stderr?.on('data', (chunk: string) => input.onStderr(chunk))
    // 脚本可能压根不读 stdin（读完就退），那时写进去会得到 EPIPE。
    // 那是脚本的行为，不该让平台炸掉；真正的失败由退出码/输出体现。
    child.stdin?.on('error', () => {})

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => {
        child.once('error', (err: Error) => {
          input.onError(err)
          resolveExit({ code: null, signal: null })
        })
        child.once('close', (code, signal) => resolveExit({ code, signal }))
      },
    )

    return {
      pid: child.pid,
      writeStdin: (data) => {
        try {
          child.stdin?.write(data)
        } catch {
          // 同上：EPIPE 不是平台的问题
        }
      },
      endStdin: () => {
        try {
          child.stdin?.end()
        } catch {
          /* 同上 */
        }
      },
      terminate: () => killProcessTree(child),
      exited,
    }
  }
}

/**
 * 终止整棵进程树。
 *
 * Unix 上 `spawn` 时建了新进程组（`detached: true`），所以父进程可以给
 * **负 pid** 发信号 = 整组一起收。
 * Windows 上 `kill(pid)` 杀不掉进程树，必须 `taskkill /T`。
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid

  if (process.platform === 'win32') {
    if (pid !== undefined) {
      try {
        spawnChildProcess('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        }).unref()
      } catch {
        /* 下面还有一次直接 kill 兜底 */
      }
    }
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经退出了 */
    }
    return
  }

  if (pid === undefined) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经退出了 */
    }
    return
  }

  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // 进程组不在了（已经退出）或没有权限——退回杀直接子进程
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经退出了 */
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// 环境
// ══════════════════════════════════════════════════════════════════

/**
 * 传给脚本的环境**白名单**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不把 daemon 的环境原样传下去
 * ══════════════════════════════════════════════════════════════════
 *
 * daemon 的环境里有密钥（`ALPHA_HELPER_GITHUB_TOKEN` 之类），还有
 * `NODE_OPTIONS`（它是 `--require` 任意模块的入口）。第三方脚本是**你不完全
 * 了解的代码**，把整份环境递过去等于把密钥递给它，而且是无声的。
 *
 * 所以这里是"要什么给什么"：够解释器正常跑（PATH / 语言 / 时区），
 * 其余一律不给。缺了什么就明确失败，而不是"先都给它、以后再说"。
 */
const ENV_WHITELIST = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM'] as const

/** Windows 上解释器自己要读的几个键（不给的话 node/python 会出各种怪毛病）。 */
const WINDOWS_ENV = ['SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC'] as const

export function buildScriptEnv(input: {
  /** 白名单的来源（默认 `process.env`）。**只为取值**，不是传递。 */
  source: NodeJS.ProcessEnv
  /** 脚本的 HOME 与 TMPDIR 都指到这里（本次执行的临时目录）。 */
  tempDir: string
  runtime: ToolRuntime
}): Record<string, string> {
  const env: Record<string, string> = {}

  const keys =
    process.platform === 'win32' ? [...ENV_WHITELIST, ...WINDOWS_ENV] : [...ENV_WHITELIST]
  for (const key of keys) {
    const value = input.source[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }

  // ★ HOME 指向临时目录：脚本会照惯例往 `~/.config`、`~/.cache` 里写东西，
  //   而那是**使用者的家目录**。不给它一个自己的家，第三方脚本就能在你的
  //   家目录里落下任何东西——包括以后会被别的程序读到的配置。
  env['HOME'] = input.tempDir
  if (process.platform === 'win32') env['USERPROFILE'] = input.tempDir

  // 同理：`os.tmpdir()` 之类的落点也收进本次执行的目录，跑完一起清掉
  if (process.platform === 'win32') {
    env['TEMP'] = input.tempDir
    env['TMP'] = input.tempDir
  } else {
    env['TMPDIR'] = input.tempDir
  }

  // python3 的 stdout 编码默认跟 locale 走，在某些环境下会把 JSON 里非
  // ASCII 的部分写坏（表现为"stdout 不是合法 JSON"）。这一条只影响 stdio 编码。
  if (input.runtime === 'python3') env['PYTHONIOENCODING'] = 'utf-8'

  return env
}

// ══════════════════════════════════════════════════════════════════
// 解释器解析
// ══════════════════════════════════════════════════════════════════

export type ResolvedCommand =
  | { ok: true; command: string }
  | { ok: false; detail: string }

/** 从 PATH 找可执行文件；找不到返回 null。 */
export async function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const dirs = (env['PATH'] ?? '').split(delimiter).filter((d) => d !== '')
  const suffixes =
    process.platform === 'win32'
      ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter((s) => s !== '')
      : ['']

  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, command + suffix)
      try {
        const info = await stat(candidate)
        if (!info.isFile()) continue
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // 不是可执行文件 / 不存在 ⇒ 继续找
      }
    }
  }
  return null
}

/**
 * runtime → 真的去跑什么命令。
 *
 * ⚠️ 这里**没有**"使用者自己填一个命令"的自由：runtime 是协议里的闭合枚举
 *    （`node` / `shell` / `python3`），而这个函数是唯一把它翻译成命令的地方。
 *    要把"命令"从清单里读出来（哪怕只是拼进 argv 的一段）就等于开放了任意
 *    执行——那正是 D40 明确不要的东西。
 */
export async function resolveCommand(
  runtime: ToolRuntime,
  find: (command: string) => Promise<string | null> = (c) => findExecutable(c),
  /** `node` 用哪个可执行文件。默认 `process.execPath`（理由见下面那条注释）。 */
  nodePath: string = process.execPath,
): Promise<ResolvedCommand> {
  switch (runtime) {
    case 'node':
      // ★ 用 `process.execPath`（除非装配处钉了别的），**不查 PATH**。
      //
      //   daemon 可能是被一个 PATH 里没有 node 的环境拉起来的（Finder、
      //   某些服务管理器、容器里的绝对路径启动）。而"跑这个脚本用的 node"
      //   最合理的选择就是**正在跑 daemon 的这个 node**：它一定存在，
      //   一定是够新的版本，也一定和平台自己用的是同一个。
      return { ok: true, command: nodePath }
    case 'shell': {
      const found = await find('bash')
      if (found === null) {
        return {
          ok: false,
          detail:
            '没找到 bash：这个工具包声明 runtime 为 shell，平台用 bash 跑它，但 PATH 里没有 bash。' +
            '装一个 bash（macOS 自带；Debian/Ubuntu 上是 `apt install bash`）或把它所在的目录加进 PATH 后重试。',
        }
      }
      return { ok: true, command: found }
    }
    case 'python3': {
      const found = await find('python3')
      if (found === null) {
        return {
          ok: false,
          detail:
            '没找到 python3：这个工具包声明 runtime 为 python3，平台用 python3 跑它，但 PATH 里没有 python3。' +
            '装一个 Python 3（`brew install python3` / `apt install python3`）或把它所在的目录加进 PATH 后重试。',
        }
      }
      return { ok: true, command: found }
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// 物化
// ══════════════════════════════════════════════════════════════════

/** 物化失败——**不是**脚本的失败，而是平台侧的设置失败（文案要说清是哪种）。 */
export class ScriptSetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScriptSetupError'
  }
}

export interface MaterializedPackage {
  /** 本次执行专用的临时目录（跑完删掉）。 */
  execDir: string
  /** 包文件落在这里（保持包的相对结构）。 */
  packageDir: string
  /** 脚本的 HOME。 */
  homeDir: string
  /** 没有工作目录时脚本的 cwd。 */
  scratchDir: string
  /** 入口脚本的绝对路径。 */
  entryPath: string
}

/**
 * 把一个相对路径安全地拼到 root 里面。
 *
 * 清单在**安装时**已经校验过路径（`ToolManifest` 的 `superRefine` 拒绝对路径
 * 与 `..`），所以这里是**纵深防御**：同一份包内容可能来自远端目录，而"外部
 * 输入只校验一次"是经典事故。判据两条：
 *
 *   1. 按**路径分隔符**比前缀（不是字符串前缀）——否则 `/tmp/pkg-other` 会被
 *      当成 `/tmp/pkg` 的子路径；
 *   2. 逐个 segment 拒 `..`——`resolve` 之后比前缀其实已经够了，但显式拒掉能
 *      让报错说清"哪一段越界了"。
 */
function resolveInside(root: string, rel: string, what: string): string {
  if (rel === '' || rel.includes('\0')) {
    throw new ScriptSetupError(`${what} 的路径为空或不合法：${JSON.stringify(rel)}`)
  }
  if (isAbsolute(rel)) {
    throw new ScriptSetupError(`${what} 必须是**相对**包根的路径，实际是绝对路径：${rel}`)
  }
  const segments = rel.split(/[\\/]+/)
  if (segments.some((s) => s === '..')) {
    throw new ScriptSetupError(`${what} 不许跑出包目录（路径里有 ..）：${rel}`)
  }

  const target = resolve(root, rel)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new ScriptSetupError(`${what} 跑出了包目录：${rel}`)
  }
  return target
}

/** 把包里的文件写进本次执行专用的临时目录。 */
export async function materializePackage(input: {
  tempRoot: string
  files: Readonly<Record<string, string>>
  entry: string
}): Promise<MaterializedPackage> {
  if (!isAbsolute(input.tempRoot)) {
    // 相对路径的临时根取决于 daemon 是从哪个目录启动的——同一个配置在不同
    // 启动方式下会指向完全不同的地方，这类问题排查起来极其费劲。
    throw new ScriptSetupError(
      `临时目录的父目录必须是绝对路径，实际是：${input.tempRoot}（它应当来自 daemon 的数据目录）`,
    )
  }

  await mkdir(input.tempRoot, { recursive: true, mode: 0o700 })
  // 每次执行一个独立目录（`mkdtemp` 保证并发执行之间不会撞车）
  const execDir = await mkdtemp(join(input.tempRoot, 'tool-'))
  const packageDir = join(execDir, 'package')
  const homeDir = join(execDir, 'home')
  const scratchDir = join(execDir, 'work')

  await mkdir(packageDir, { recursive: true, mode: 0o700 })
  await mkdir(homeDir, { recursive: true, mode: 0o700 })
  await mkdir(scratchDir, { recursive: true, mode: 0o700 })

  for (const [rel, text] of Object.entries(input.files)) {
    const target = resolveInside(packageDir, rel, '包里的文件')
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, text, { encoding: 'utf8', mode: 0o600 })
  }

  const entryPath = resolveInside(packageDir, input.entry, '入口')
  if (!(input.entry in input.files)) {
    // 安装时查过一次，这里再查一次：这条错误说清是"包装坏了"，
    // 而不是让 spawn 去报一个 ENOENT（那会看起来像环境问题）。
    throw new ScriptSetupError(
      `包里没有清单声明的入口文件：${input.entry}（这个包是坏的，请重新安装它）`,
    )
  }

  return { execDir, packageDir, homeDir, scratchDir, entryPath }
}

// ══════════════════════════════════════════════════════════════════
// 执行器
// ══════════════════════════════════════════════════════════════════

export interface ScriptExecutorDeps {
  /**
   * 临时目录的**父目录**。必须是绝对路径，且应当是 daemon 数据目录下的一个
   * 子目录——**绝不用 `tmpdir()`**（理由见文件头）。
   */
  tempRoot: string
  /** 起进程。默认 `node:child_process.spawn`（见 `nodeSpawn`）。 */
  spawn?: SpawnScript
  /** 查 PATH 找解释器。默认 `findExecutable`。 */
  findExecutable?: (command: string) => Promise<string | null>
  /** 环境的白名单来源。默认 `process.env`（**只为取值**）。 */
  env?: NodeJS.ProcessEnv
  /**
   * `node` runtime 用哪个可执行文件。默认 `process.execPath`。
   *
   * 暴露出来只为一件事：**部署/测试要把解释器钉死**时（例如容器里换一个
   * node 跑工具脚本）不必去改 PATH——PATH 是脚本可见的输入，改它会影响
   * 别的东西。
   */
  nodePath?: string
  now?: () => number
  /**
   * `terminate()` 之后最多再等多久（默认 3s）。
   *
   * 可注入是为了让"进程赖着不走"那条分支能被测到——真等 3 秒的测试没人
   * 愿意跑，而它恰恰是"超时之后会不会把判决卡死"的那个分支。
   */
  terminateGraceMs?: number
  /** 跑完保留临时目录（排查用）。默认删掉。 */
  keepTempDir?: boolean
}

/** 退出前的等待上限：`terminate()` 之后最多再等这么久。 */
const TERMINATE_GRACE_MS = 3_000

/** stdout/stderr 各留多少——够解析 JSON、够贴出"尾部若干字符"，但有界。 */
const MAX_CAPTURE = 256 * 1024
/** 失败原因里能贴多少尾部字符（约定：约 2000）。 */
const TAIL_CHARS = 2_000
/** 失败原因里能贴多少 stderr。 */
const STDERR_TAIL_CHARS = 600

function tail(text: string, chars: number): string {
  return text.length <= chars ? text : text.slice(text.length - chars)
}

/** 收集输出，但在上限处**停手**（不是丢头部：JSON 往往从头开始）。 */
class OutputCapture {
  #buffer = ''
  #truncated = false

  push(chunk: string): void {
    if (this.#truncated) return
    if (this.#buffer.length + chunk.length > MAX_CAPTURE) {
      this.#buffer += chunk.slice(0, Math.max(0, MAX_CAPTURE - this.#buffer.length))
      this.#truncated = true
      return
    }
    this.#buffer += chunk
  }

  get text(): string {
    return this.#buffer
  }

  get truncated(): boolean {
    return this.#truncated
  }
}

/** 脚本 stdout 的约定形状。 */
interface ScriptOutput {
  ok?: unknown
  detail?: unknown
}

export class ScriptExecutor {
  readonly #deps: ScriptExecutorDeps
  readonly #spawn: SpawnScript
  readonly #find: (command: string) => Promise<string | null>
  readonly #now: () => number

  constructor(deps: ScriptExecutorDeps) {
    this.#deps = deps
    this.#spawn = deps.spawn ?? nodeSpawn()
    this.#find = deps.findExecutable ?? ((c) => findExecutable(c))
    this.#now = deps.now ?? (() => Date.now())
  }

  /**
   * 真跑一次脚本。
   *
   * 任何一条失败路径都**不留孤儿、不留临时目录**：`finally` 里清目录，
   * 超时路径先杀整组再返回。
   */
  async execute(req: ScriptExecutionRequest): Promise<ScriptExecutionResult> {
    const started = this.#now()
    const elapsed = (): number => this.#now() - started
    const fail = (detail: string, extra: Partial<ScriptExecutionResult> = {}): ScriptExecutionResult => ({
      ok: false,
      detail,
      durationMs: elapsed(),
      ...extra,
    })

    // ── ① 不支持 dry-run 的动作：平台**不许**在演练模式下跑它 ──
    //
    // 不是"硬跑一遍再说"：dryRun 的约定是**脚本自己保证不改**，而清单写
    // `unsupported` 就是作者在说"我保证不了"。那时平台唯一正确的做法是
    // 拒绝，并说清为什么——而不是拿使用者的工作目录去赌。
    if (req.dryRun && req.action.dryRun === 'unsupported') {
      return fail(
        `这个动作不支持 dry-run（工具包 ${req.action.slug} 的清单里写的是 dryRun: "unsupported"），` +
          `平台不会在演练模式下运行它——这类动作必须先有人明确开启才会真的执行。`,
      )
    }

    // ── ② 解释器 ──
    const resolved = await resolveCommand(req.action.runtime, this.#find, this.#deps.nodePath ?? process.execPath)
    if (!resolved.ok) return fail(resolved.detail)

    // ── ③ 物化 ──
    let materialized: MaterializedPackage
    try {
      materialized = await materializePackage({
        tempRoot: this.#deps.tempRoot,
        files: req.files,
        entry: req.action.entry,
      })
    } catch (err) {
      return fail(err instanceof ScriptSetupError ? err.message : `准备临时目录失败：${String(err)}`)
    }

    try {
      // ── ④ cwd：这次 run 的工作目录 ──
      //
      // 工作目录是"这个任务的产物在哪里"，脚本往相对路径写东西时会落到它里面
      // ——那正是使用者期望的。没有工作目录时退到临时目录（并在结果里说明），
      // 绝不退到 daemon 的 cwd（那是**安装目录**）或使用者的家目录。
      let cwd = materialized.scratchDir
      let cwdNote = ''
      if (req.context.workdir !== null && req.context.workdir !== '') {
        if (!(await isDirectory(req.context.workdir))) {
          return fail(
            `这次 run 的工作目录不可用：${req.context.workdir}（不存在或不是目录）。` +
              `平台不会替它换一个目录——那会让脚本把文件写到别的地方去。`,
          )
        }
        cwd = req.context.workdir
      } else {
        cwdNote = `（这条 run 还没有工作目录，脚本的工作目录退到了临时目录 ${materialized.scratchDir}）`
      }

      const env = buildScriptEnv({
        source: this.#deps.env ?? process.env,
        tempDir: materialized.homeDir,
        runtime: req.action.runtime,
      })

      // ── ⑤ 跑 ──
      const stdout = new OutputCapture()
      const stderr = new OutputCapture()
      const spawnErrors: Error[] = []
      let timedOut = false

      const proc = this.#spawn({
        // 入口作为**单个参数**给解释器：不拼命令行、不经过 shell，
        // 所以清单里的字符串永远不会被当成命令来解释（无 shell 注入面）。
        command: resolved.command,
        args: [materialized.entryPath],
        cwd,
        env,
        onStdout: (chunk) => stdout.push(chunk),
        onStderr: (chunk) => stderr.push(chunk),
        onError: (err) => {
          spawnErrors.push(err)
        },
      })

      proc.writeStdin(
        JSON.stringify({
          action: req.action.type,
          params: req.params,
          dryRun: req.dryRun,
          context: {
            workdir: req.context.workdir,
            runId: req.context.runId,
            workspaceId: req.context.workspaceId,
          },
        }),
      )
      proc.endStdin()

      const timeoutMs = req.action.timeoutMs
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<'timeout'>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout('timeout'), timeoutMs)
      })

      const outcome = await Promise.race([proc.exited.then(() => 'exited' as const), timeout])
      clearTimeout(timer)

      let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
      if (outcome === 'timeout') {
        timedOut = true
        proc.terminate()
        // 杀完要等它真的退。但**不能无限等**：一个赖着不走的进程不该把整个
        // 判决卡死。等不到就如实说"已经发了 SIGKILL、但没有确认它退出"。
        const grace = new Promise<'grace'>((resolveGrace) => {
          setTimeout(
            () => resolveGrace('grace'),
            this.#deps.terminateGraceMs ?? TERMINATE_GRACE_MS,
          ).unref()
        })
        const after = await Promise.race([proc.exited.then(() => 'exited' as const), grace])
        if (after === 'exited') exit = await proc.exited
      } else {
        exit = await proc.exited
      }

      const exitCode = exit?.code ?? null
      const base = { exitCode, ...(timedOut ? { timedOut: true } : {}) }

      if (timedOut) {
        return fail(
          `执行超时：${req.action.type} 在 ${timeoutMs}ms 内没有结束，已终止整个进程组` +
            (exit === null ? '（尚未确认它已退出）' : '') +
            `。${cwdNote}`,
          base,
        )
      }

      // 启动失败（ENOENT/EACCES）在 Node 上是**异步事件**，所以它可能与
      // "退出了"同时到达：这里先查它，报出来的是真正的病因（哪个文件没找到），
      // 而不是一句含糊的"非 0 退出码"。
      const spawnError: Error | undefined = spawnErrors[0]
      if (spawnError !== undefined) {
        return fail(`无法启动 ${resolved.command}：${spawnError.message}${cwdNote}`, base)
      }

      if (exitCode !== 0) {
        const detail = parseScriptOutput(stdout.text)?.detail
        return fail(
          `脚本以非 0 退出码结束（exitCode=${exitCode ?? 'null'}` +
            (exit?.signal ? `，signal=${exit.signal}` : '') +
            '）' +
            (typeof detail === 'string' && detail !== '' ? `：${detail}` : '') +
            (stderr.text.trim() !== '' ? `；stderr 尾部：${tail(stderr.text, STDERR_TAIL_CHARS)}` : '') +
            cwdNote,
          base,
        )
      }

      // ── ⑥ stdout 必须是**一个** JSON 对象 ──
      const raw = stdout.text
      const trimmed = raw.trim()
      if (trimmed === '') {
        return fail(
          `脚本没有往 stdout 写任何东西（约定：必须写一个 JSON 对象 { ok, detail }）${cwdNote}`,
          base,
        )
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch (err) {
        return fail(
          `脚本的 stdout 不是合法 JSON：${err instanceof Error ? err.message : String(err)}。` +
            `stdout 尾部（最多 ${TAIL_CHARS} 字符）：${tail(raw, TAIL_CHARS)}` +
            (stdout.truncated
              ? `（stdout 过长，只保留了前 ${MAX_CAPTURE / 1024}KB，这里是它的尾部）`
              : '') +
            cwdNote,
          base,
        )
      }

      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return fail(
          `脚本的 stdout 必须是一个 JSON 对象（约定是 { ok, detail }），实际是 ${Array.isArray(parsed) ? '数组' : JSON.stringify(parsed)}。` +
            `stdout 尾部（最多 ${TAIL_CHARS} 字符）：${tail(raw, TAIL_CHARS)}${cwdNote}`,
          base,
        )
      }

      const output = parsed as ScriptOutput
      const detail = typeof output.detail === 'string' ? output.detail : ''

      if (output.ok !== true) {
        if (output.ok === false) {
          return fail(
            `脚本报告失败：${detail === '' ? '（脚本没有说明原因）' : detail}` +
              (stderr.text.trim() !== '' ? `；stderr 尾部：${tail(stderr.text, STDERR_TAIL_CHARS)}` : '') +
              cwdNote,
            base,
          )
        }
        return fail(
          `脚本的 stdout 里没有 ok 字段（约定是 { ok: true|false, detail }），实际：${tail(raw, TAIL_CHARS)}${cwdNote}`,
          base,
        )
      }

      return {
        ok: true,
        detail:
          (detail === '' ? `已执行 ${req.action.type}` : detail) +
          (req.dryRun ? '（dry-run）' : '') +
          cwdNote,
        ...base,
        durationMs: elapsed(),
      }
    } finally {
      // ★ 不留痕迹：临时目录里既有包内容（可含第三方代码），也有脚本的
      //   HOME（它可能往里写了凭据）。跑完必删——连失败路径也走这里。
      if (this.#deps.keepTempDir !== true) {
        await rm(materialized.execDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}

/** 便捷工厂：大多数调用方只想要一个函数。 */
export function createScriptExecutor(
  deps: ScriptExecutorDeps,
): (req: ScriptExecutionRequest) => Promise<ScriptExecutionResult> {
  const executor = new ScriptExecutor(deps)
  return (req) => executor.execute(req)
}

/** 尽力解析 stdout（用在"非 0 退出"那条路径上，只为把脚本自己的话贴出来）。 */
function parseScriptOutput(text: string): ScriptOutput | null {
  try {
    const parsed: unknown = JSON.parse(text.trim())
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as ScriptOutput
  } catch {
    return null
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}
