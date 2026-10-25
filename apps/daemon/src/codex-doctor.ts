/**
 * `--doctor codex`：一条命令回答"这台机器上 codex 到底通不通"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它为什么存在（以及为什么不能放进 `pnpm run test`）
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者在 Windows 上报了两件事：**codex 执行失败**、**codex 的输出乱码**。
 * 这两件事在我这台 macOS 上都复现不了，而自动化测试**禁止调用真实 CLI**
 * （NFR-T-01：会花真实额度、还可能让 agent 改文件）。两条约束叠起来的结论是：
 * 这件事只能有一个**人工入口**，而且要**免费、只读、可复制粘贴**。
 *
 * 所以这条命令做四件事，全部不起 agent、不花额度：
 *
 *   1. **环境**：平台 / 架构 / Node / 终端代码页（Windows 上 `chcp` 的输出就是
 *      "这个窗口按哪个代码页显示"的答案，与乱码直接相关）。
 *   2. **可执行文件**：用**生产同一条**探测路径找到 codex（含 `PATHEXT` 候选），
 *      并报出 `resolveSpawnTarget` 会怎么起它（`direct` / `shim` / `cmd`）。
 *   3. **字节**：真的跑一次 `codex --version`，把**原始字节**同时按 UTF-8 与 GBK
 *      解出来给人看。乱码属于"字节是什么"的问题，只看解码后的字符串永远判不出来
 *      （`锟斤拷` 与 `�` 需要的是 hex）。
 *   4. **配置 + 复制 + 握手**：看 `~/.codex` 的两个文件（含 **BOM / UTF-16 判定**）、
 *      真跑一遍复制逻辑（到临时目录，不碰受管目录）、再起一次 `codex app-server`
 *      做 `initialize` 握手。这三步正好覆盖"执行失败"最常见的三个地方。
 *
 * ⚠️ 它**不清洗**任何东西、不改任何配置：复制演练落在一个临时目录里，跑完就删。
 * ⚠️ 它也不跑 turn：那要花额度，得由人决定（结尾会说怎么做）。
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_DESCRIPTOR, CODEX_SERVER_FACTS, JsonRpcTransport } from '@agentdeck/agent-codex'
import { probeCommand, resolveSpawnTarget, spawnPlanFor, spawnProcessTree } from '@agentdeck/agent-core'
import { knownRuntimeAdapters } from './runtime-registry.ts'
import { syncCodexConfigDir } from './run-hooks/codex-config.ts'

/** 一份字节的"三种读法"——乱码问题只能这样判。 */
export interface BytesDigest {
  byteLength: number
  /** 前 48 字节的 hex（足够看出 BOM 与代码页错位）。 */
  hex: string
  /** 按 UTF-8 解码（我们生产代码就是这么解的）。 */
  utf8: string
  /** 按 GBK/936 解码（Windows 中文版 ANSI 代码页）；解不了就是 null。 */
  gbk: string | null
  /** UTF-8 解码里出现替换字符 ⇒ 字节不是 UTF-8。 */
  utf8HasReplacement: boolean
  /** 开头的 BOM 判定。 */
  bom: 'none' | 'utf8' | 'utf16le' | 'utf16be'
}

export function digestBytes(buf: Buffer): BytesDigest {
  const head = buf.subarray(0, 48)
  const utf8 = buf.toString('utf8')
  let gbk: string | null = null
  try {
    // Node 官方构建带完整 ICU ⇒ 'gbk' 可用；不带的构建这里会抛，如实记 null
    gbk = new TextDecoder('gbk').decode(buf)
  } catch {
    gbk = null
  }
  let bom: BytesDigest['bom'] = 'none'
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bom = 'utf8'
  else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) bom = 'utf16le'
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) bom = 'utf16be'
  else if (buf.length >= 2 && buf[0] !== 0x00 && buf[1] === 0x00) bom = 'utf16le' // 无 BOM 的 UTF-16LE
  return {
    byteLength: buf.length,
    hex: head.toString('hex'),
    utf8,
    gbk,
    utf8HasReplacement: utf8.includes('\uFFFD'),
    bom,
  }
}

export interface DoctorCheck {
  id: string
  ok: boolean
  /** 这条通过/不通过意味着什么（人话）。 */
  detail: string
}

export interface ConfigFileView {
  name: string
  path: string
  exists: boolean
  bytes: BytesDigest | null
  /** 发现的具体问题（BOM、UTF-16、空文件…）。 */
  problems: string[]
}

export interface CodexDoctorReport {
  env: {
    platform: string
    arch: string
    node: string
    /** Windows 上 `chcp` 的输出（其它平台为 null）。 */
    codePage: string | null
    /** 是否由我们自己注入 `CODEX_HOME`（设置里那个开关）。 */
    isolationNote: string
  }
  executable: {
    path: string
    found: boolean
    /** `resolveSpawnTarget` 会怎么起它：`direct` / `shim` / `cmd`。 */
    via: string
    args: string[]
  }
  version: {
    bytes: BytesDigest | null
    /** CLI 自己报的版本（从字节里取第一行）。 */
    reported: string | null
    exitCode: number | null
  }
  config: {
    sourceDir: string
    files: ConfigFileView[]
  }
  copy: {
    targetDir: string
    ok: boolean
    reason: string | null
    copied: string[]
    /** 复制过去的字节与源**逐字节相同**（我们只做字节搬运，不改编码）。 */
    bytesIdentical: boolean
  }
  handshake: {
    ok: boolean
    ms: number | null
    firstFrame: string | null
    error: string | null
  }
  checks: DoctorCheck[]
  /** 下一步该做什么（按不通过的那些逐条给）。 */
  nextSteps: string[]
}

/** 跑一条命令并**按字节**收回输出（不走 UTF-8 解码）。 */
async function runCapture(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null }> {
  /**
   * ⚠️ 必须过 `resolveSpawnTarget`：Windows 上 `spawn('codex.cmd')` 会抛 EINVAL
   *    （CVE-2024-27980 之后 Node 不再隐式经 cmd.exe）。自检如果自己另起一条路，
   *    "自检起不来"就会变成假警报——而它恰恰是用来判断"到底能不能起"的。
   */
  let plan: ReturnType<typeof spawnPlanFor>
  try {
    plan = spawnPlanFor(resolveSpawnTarget({ command, args }))
  } catch (err) {
    return { stdout: Buffer.alloc(0), stderr: Buffer.from(String(err), 'utf8'), exitCode: null }
  }
  return await new Promise((resolve) => {
    const child = spawn(plan.command, plan.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...plan.options,
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    const done = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), exitCode })
    }
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    child.once('error', () => done(null))
    child.once('close', (code) => done(code))
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
      done(null)
    }, timeoutMs).unref()
  })
}

/** Windows 的终端代码页——乱码的第一现场。 */
async function readCodePage(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const out = await runCapture(process.env['COMSPEC'] ?? 'cmd.exe', ['/c', 'chcp'], 5_000)
  const text = out.stdout.toString('utf8').trim()
  return text === '' ? null : text
}

async function inspectConfigFile(dir: string, name: string): Promise<ConfigFileView> {
  const path = join(dir, name)
  let raw: Buffer
  try {
    raw = await readFile(path)
  } catch {
    return { name, path, exists: false, bytes: null, problems: ['文件不存在'] }
  }
  const bytes = digestBytes(raw)
  const problems: string[] = []
  if (raw.length === 0) problems.push('文件是空的（0 字节）')
  if (bytes.bom === 'utf8') problems.push('开头有 UTF-8 BOM（EF BB BF）：TOML/JSON 解析器常常不认它')
  if (bytes.bom === 'utf16le' || bytes.bom === 'utf16be') {
    problems.push(`文件是 UTF-16（${bytes.bom}）——codex 读不了，必须先转成 UTF-8`)
  }
  if (bytes.utf8HasReplacement && bytes.bom === 'none') {
    problems.push('不是合法 UTF-8（解码出现替换字符）——可能是 GBK/ANSI 存的')
  }
  return { name, path, exists: true, bytes, problems }
}

/**
 * 起一次 `codex app-server` 并做 `initialize` 握手。
 *
 * 走的是**生产同一条** `spawnProcessTree`（含 npm 垫片解包）与**同一个** JSON-RPC
 * 传输层：自检如果另走一条起进程的路，"自检通过"就证明不了生产能跑。
 */
async function handshake(executablePath: string, codexHome: string | null, timeoutMs = 20_000): Promise<{ ok: boolean; ms: number | null; firstFrame: string | null; error: string | null }> {
  const startedAt = Date.now()
  let firstFrame: string | null = null
  let stderrTail = ''
  let handle: ReturnType<typeof spawnProcessTree> | null = null
  let transport: JsonRpcTransport | null = null
  try {
    const spawned = spawnProcessTree({
      command: executablePath,
      args: [...CODEX_DESCRIPTOR.baseArgs],
      cwd: process.cwd(),
      /**
       * ★ 用**生产的形状**握手：CODEX_HOME 指向一个可写目录（这里就是复制演练那个
       *   临时目录，生产里是平台受管目录）。
       *
       * 为什么不能就用 `~/.codex`：codex 会在 CODEX_HOME 下建 sqlite 状态库
       *   （本机实测报过 `failed to initialize sqlite state runtime under ~/.codex`）。
       *   拿使用者的家目录去试"能不能起"，量到的常常是**权限**而不是 codex 本身；
       *   而生产从来不是这么跑的——这条自检要量的是"生产那条路通不通"。
       *   复制失败时退化为"不注入 CODEX_HOME"（那也正是设置里关掉隔离的样子）。
       */
      env: { ...process.env, ...(codexHome === null ? {} : { CODEX_HOME: codexHome }) },
      onStdoutLine: (line) => {
        if (firstFrame === null) firstFrame = line.slice(0, 400)
        transport?.push(line)
      },
      onStderrLine: (line) => {
        stderrTail = `${stderrTail}\n${line}`.slice(-2000)
      },
      onActivity: () => {},
    })
    handle = spawned
    transport = new JsonRpcTransport(
      {
        onNotification: () => {},
        onUnparsableLine: () => {},
        onServerRequest: (_id, _method, _params, respond) => respond({ decision: 'decline' }),
        // 自检里不做背压重试：失败就是失败，早报比晚报有用
        maxRetries: 0,
      },
      (frame) => spawned.writeStdin(`${JSON.stringify(frame)}\n`),
    )
    await transport.request(
      CODEX_SERVER_FACTS.methods.initialize,
      {
        clientInfo: {
          name: CODEX_SERVER_FACTS.clientName,
          title: 'agentdeck doctor',
          version: '0.0.0',
        },
      },
      { timeoutMs },
    )
    return { ok: true, ms: Date.now() - startedAt, firstFrame, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const tail = stderrTail.trim() === '' ? '' : `（stderr: ${stderrTail.trim()}）`
    return { ok: false, ms: null, firstFrame, error: `${message}${tail}` }
  } finally {
    if (handle) await handle.terminate(1_000).catch(() => {})
  }
}

export interface CodexDoctorOptions {
  /** 指定 CLI 路径（缺省走探测）。 */
  executablePath?: string
  /** 覆盖"用户的 codex 配置目录"（缺省 `~/.codex`）。测试注入用。 */
  configSource?: string
  /** 覆盖复制演练的目标目录（缺省临时目录）。测试注入用。 */
  copyTarget?: string
  /** 跳过握手（测试里不想起进程时用）。 */
  skipHandshake?: boolean
  /** 握手超时。 */
  handshakeTimeoutMs?: number
}

/**
 * 跑一遍自检。**只读、免费**：不跑 turn、不改使用者的配置。
 */
export async function runCodexDoctor(options: CodexDoctorOptions = {}): Promise<CodexDoctorReport> {
  const checks: DoctorCheck[] = []
  const nextSteps: string[] = []

  const codePage = await readCodePage()

  // ── ① 可执行文件：用**生产同一条**探测路径（适配器的 probe，含 Windows 的 PATHEXT 候选）──
  const adapter = knownRuntimeAdapters()['codex']
  if (!adapter) throw new Error('没有装配 codex 适配器：本 daemon 不支持 codex runtime')
  const probe = await adapter
    .create({ ...(options.executablePath ? { executablePath: options.executablePath } : {}), onWarn: () => {} })
    .probe()
  /**
   * ★ 起进程用的路径**必须**是"生产真的会起的那一个"。
   *
   * 踩过的坑（这一批当场踩的）：适配器的 `probe()` 返回的 `command` 是**描述表里的
   * 命令名**（`'codex'`），不是解析后的绝对路径。第一版拿它去 spawn，`--version`
   * 量到的就是 PATH 上那个**真实** codex（0.157.1），而不是夹具里那个假货——
   * 既让这份测试失去意义，也等于在测试里调了真实 CLI（NFR-T-01 明令禁止）。
   * 所以：调用方给了路径就用它；没给才走 `probeCommand`（含 PATH / PATHEXT 解析）。
   */
  // 显式分两步写：`??` 里夹一个 `await` 的表达式在这套 tsconfig 下推不出窄类型
  // （实测 TS2322：`string | undefined`），而这里一旦放宽，下面所有 spawn 都可能收到 undefined。
  const injectedPath: string | undefined = options.executablePath
  const probed = injectedPath === undefined ? await probeCommand(CODEX_DESCRIPTOR.command) : null
  const resolvedPath: string = injectedPath ?? probed?.path ?? CODEX_DESCRIPTOR.command
  let found = probe.available
  let via = 'direct'
  let args: string[] = []
  try {
    const target = resolveSpawnTarget({ command: resolvedPath, args: [...CODEX_DESCRIPTOR.baseArgs] })
    via = target.via
    args = target.args
  } catch (err) {
    found = false
    checks.push({
      id: 'cli-resolvable',
      ok: false,
      detail: `起不来：${err instanceof Error ? err.message : String(err)}`,
    })
  }
  if (found) {
    checks.push({
      id: 'cli-resolvable',
      ok: true,
      detail: `codex 可起（${via}）：${resolvedPath} ${args.join(' ')}`,
    })
  } else {
    nextSteps.push(
      '先让 codex 能被找到：`npm i -g @openai/codex`，或给 `--executable <绝对路径>` 指过去。',
    )
  }

  // ── ② `codex --version` 的**原始字节**（乱码的唯一证据）──
  let versionBytes: BytesDigest | null = null
  let reported: string | null = null
  let versionExit: number | null = null
  if (found) {
    const out = await runCapture(resolvedPath, ['--version'], 20_000)
    versionExit = out.exitCode
    const buf = out.stdout.length > 0 ? out.stdout : out.stderr
    versionBytes = digestBytes(buf)
    reported = buf.toString('utf8').split(/\r?\n/u)[0]?.trim() ?? null
    const textOk = !versionBytes.utf8HasReplacement
    checks.push({
      id: 'version-bytes',
      ok: out.exitCode === 0 && textOk,
      detail: textOk
        ? `版本可读：${reported ?? '（空）'}`
        : `★ 输出**不是合法 UTF-8**（hex 开头 ${versionBytes.hex}，GBK 读法：` +
          `${versionBytes.gbk?.slice(0, 40) ?? '解不了'}）——这就是乱码的来源：` +
          'CLI 按 Windows ANSI 代码页吐字节，我们按 UTF-8 读。',
    })
    if (!textOk) {
      nextSteps.push(
        '在跑 daemon 的那个窗口里先执行 `chcp 65001`（或换成 Windows Terminal 的 UTF-8 配置），' +
          '再重启 daemon —— 先排除"控制台代码页"这一层；界面里仍乱则是 CLIP 自己吐的字节问题，' +
          '把这份自检输出发我。',
      )
    }
  }

  // ── ③ 用户的 codex 配置：存在性 + 编码 ──
  const sourceDir = options.configSource ?? join(homedir(), '.codex')
  const files = [
    await inspectConfigFile(sourceDir, 'auth.json'),
    await inspectConfigFile(sourceDir, 'config.toml'),
  ]
  const missing = files.filter((f) => !f.exists).map((f) => f.name)
  const encodingProblems = files.flatMap((f) => f.problems.filter((p) => !p.includes('不存在')))
  checks.push({
    id: 'config-present',
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `两个文件都在：${sourceDir}`
        : `缺 ${missing.join('、')}（在 ${sourceDir}）——codex 会认证不了/没有端点配置`,
  })
  if (missing.length > 0) {
    nextSteps.push(
      `先把 ${missing.join('、')} 准备出来（跑一次 \`codex login\`，或从另一台机器复制到 ${sourceDir}）。`,
    )
  }
  if (encodingProblems.length > 0) {
    checks.push({
      id: 'config-encoding',
      ok: false,
      detail: encodingProblems.join('；'),
    })
    nextSteps.push(
      '把配置文件转成**无 BOM 的 UTF-8**（PowerShell 里用 ' +
        '`[IO.File]::WriteAllText($p, $text, [Text.UTF8Encoding]::new($false))`，' +
        '别用 `>` 重定向——PS 5.1 的 `>` 会写 UTF-16）。',
    )
  } else {
    checks.push({
      id: 'config-encoding',
      ok: true,
      detail: '两个配置文件的编码都正常（无 BOM、合法 UTF-8 或 UTF-16 之外的空文件问题都没有）',
    })
  }

  // ── ④ 复制演练：真跑一遍生产那段复制，落到临时目录 ──
  const targetDir = options.copyTarget ?? (await mkdtemp(join(tmpdir(), 'agentdeck-doctor-')))
  const copy = {
    targetDir,
    ok: false,
    reason: null as string | null,
    copied: [] as string[],
    bytesIdentical: false,
  }
  try {
    await mkdir(targetDir, { recursive: true })
    const result = await syncCodexConfigDir(targetDir, sourceDir)
    copy.ok = result.ok
    copy.reason = result.reason ?? null
    copy.copied = [...result.copied]
    let identical = result.copied.length > 0
    for (const name of result.copied) {
      try {
        const [a, b] = await Promise.all([
          readFile(join(sourceDir, name)),
          readFile(join(targetDir, name)),
        ])
        if (!a.equals(b)) identical = false
      } catch {
        identical = false
      }
    }
    copy.bytesIdentical = identical
  } catch (err) {
    copy.reason = err instanceof Error ? err.message : String(err)
  }
  checks.push({
    id: 'copy-works',
    ok: copy.ok,
    detail: copy.ok
      ? `复制成功（${copy.copied.join('、')}），且与源**逐字节相同**` +
        (copy.bytesIdentical ? '' : ' ⚠️ 字节不一致')
      : `复制失败：${copy.reason ?? '未知原因'}（这就是"执行失败"的一个常见来源：` +
        '受管目录里没有 auth.json ⇒ codex 起得来但认证不了）',
  })
  if (!copy.ok) {
    nextSteps.push(
      '复制这一步失败了。临时办法：设置里把「运行时配置」那个勾**取消**（= 不复制、直接用原路径），' +
        '再跑一次任务；如果这样能跑通，就确认是复制这条路的问题，把这行输出发我。',
    )
  }

  // ── ⑤ app-server 握手（起真进程，只做 initialize，不花额度）──
  let handshakeResult: CodexDoctorReport['handshake'] = {
    ok: false,
    ms: null,
    firstFrame: null,
    error: '跳过（--skip-handshake）',
  }
  if (!options.skipHandshake) {
    if (!found) {
      handshakeResult = { ok: false, ms: null, firstFrame: null, error: 'codex 起不来，无法握手' }
    } else {
      // 复制成功 ⇒ 用演练目录当 CODEX_HOME（生产形状）；复制失败 ⇒ 不注入（关隔离的形状）
      handshakeResult = await handshake(
        resolvedPath,
        copy.ok ? copy.targetDir : null,
        options.handshakeTimeoutMs ?? 20_000,
      )
    }
  }
  checks.push({
    id: 'app-server-handshake',
    ok: handshakeResult.ok,
    detail: handshakeResult.ok
      ? `initialize 成功（${String(handshakeResult.ms)}ms）——JSON-RPC 通道通`
      : `握手失败：${handshakeResult.error ?? '未知'}`,
  })
  if (!handshakeResult.ok && !options.skipHandshake) {
    const stderrish = handshakeResult.error ?? ''
    if (/state runtime|sqlite|Operation not permitted|EPERM|EACCES/iu.test(stderrish)) {
      nextSteps.push(
        '★ 这一条看着像**权限**：codex 要在 CODEX_HOME 下建会话状态库，那个目录写不进去。' +
          '如果你是在受限环境/沙箱里跑 daemon，把数据目录指到可写的地方再试' +
          '（`--data-dir <可写目录>`）；Windows 上还可能是杀软/受控文件夹盯着那个目录。',
      )
    }
    nextSteps.push(
      '握手过不去，说明故障在"起进程/协议"这一层，与配置**内容**无关：' +
        '把这一步的 error 与 firstFrame 发我（firstFrame 是它吐的第一行原文）。',
    )
  }

  const env = {
    platform: `${process.platform} ${process.arch}`,
    arch: process.arch,
    node: process.version,
    codePage,
    isolationNote:
      '平台是否注入 CODEX_HOME 由设置里的「运行时配置」开关决定；本命令**不读**那个设定，' +
      '只做只读演练（落临时目录）。',
  }

  return {
    env,
    executable: { path: resolvedPath, found, via, args },
    version: { bytes: versionBytes, reported, exitCode: versionExit },
    config: { sourceDir, files },
    copy,
    handshake: handshakeResult,
    checks,
    nextSteps,
  }
}

/** 清理自检用的临时目录（只在缺省目标时清；调用方给了目录就不动）。 */
export async function cleanupDoctorReport(report: CodexDoctorReport): Promise<void> {
  if (!report.copy.targetDir.includes('agentdeck-doctor-')) return
  await rm(report.copy.targetDir, { recursive: true, force: true }).catch(() => {})
}

/** 渲染成人能读、能整段复制粘贴的报告。 */
export function renderCodexDoctorReport(report: CodexDoctorReport): string {
  const lines: string[] = []
  const mark = (ok: boolean): string => (ok ? '✓' : '✗')
  lines.push('── codex 自检（只读、免费：不跑 turn、不改你的配置）──')
  lines.push('')
  lines.push('【环境】')
  lines.push(`  平台   ${report.env.platform}    Node ${report.env.node}`)
  lines.push(
    `  代码页 ${report.env.codePage ?? '（非 Windows，无此概念）'}` +
      (report.env.codePage !== null && !/65001/u.test(report.env.codePage)
        ? '  ⚠️ 不是 65001（UTF-8）：这个窗口里中文很可能显示成乱码，先 chcp 65001'
        : ''),
  )
  lines.push('')
  lines.push('【可执行文件】')
  lines.push(`  ${mark(report.executable.found)} 路径 ${report.executable.path}`)
  lines.push(`    起法 ${report.executable.via}（args: ${report.executable.args.join(' ') || '（无）'}）`)
  if (report.version.bytes) {
    lines.push('')
    lines.push('【codex --version 的原始字节】')
    lines.push(`  hex  ${report.version.bytes.hex}`)
    lines.push(`  UTF-8 ${JSON.stringify(report.version.bytes.utf8.slice(0, 120))}`)
    lines.push(`  GBK   ${JSON.stringify(report.version.bytes.gbk?.slice(0, 120) ?? null)}`)
    lines.push(`  版本  ${report.version.reported ?? '（没读出）'}（退出码 ${String(report.version.exitCode)}）`)
  }
  lines.push('')
  lines.push(`【配置】${report.config.sourceDir}`)
  for (const f of report.config.files) {
    const icon = f.exists ? mark(f.problems.length === 0) : '✗'
    const size = f.exists ? `${String(f.bytes?.byteLength ?? 0)} 字节` : '不存在'
    lines.push(`  ${icon} ${f.name}  ${size}`)
    if (f.exists && f.bytes) {
      lines.push(`     hex  ${f.bytes.hex}`)
      lines.push(`     BOM  ${f.bytes.bom}`)
      if (f.bytes.utf8HasReplacement) {
        lines.push(`     GBK  ${JSON.stringify(f.bytes.gbk?.slice(0, 120) ?? null)}  ← 按 UTF-8 读是坏的`)
      }
    }
    for (const p of f.problems) lines.push(`     ⚠️ ${p}`)
  }
  lines.push('')
  lines.push('【复制演练（临时目录，不碰受管目录）】')
  lines.push(`  ${mark(report.copy.ok)} ${report.copy.targetDir}`)
  lines.push(
    `    copied=${report.copy.copied.join('、') || '（无）'}  逐字节相同=${String(report.copy.bytesIdentical)}` +
      (report.copy.reason ? `  reason=${report.copy.reason}` : ''),
  )
  lines.push('')
  lines.push('【app-server 握手（真起进程，只 initialize）】')
  lines.push(`  ${mark(report.handshake.ok)} ${report.handshake.ms === null ? '（没跑到）' : `${String(report.handshake.ms)}ms`}`)
  if (report.handshake.firstFrame) lines.push(`    第一行 ${JSON.stringify(report.handshake.firstFrame)}`)
  if (report.handshake.error) lines.push(`    error  ${report.handshake.error}`)
  lines.push('')
  lines.push('【逐条结论】')
  for (const c of report.checks) lines.push(`  ${mark(c.ok)} ${c.id}：${c.detail}`)
  if (report.nextSteps.length > 0) {
    lines.push('')
    lines.push('【下一步】')
    for (const s of report.nextSteps) lines.push(`  · ${s}`)
  }
  lines.push('')
  lines.push(`结论：${report.checks.every((c) => c.ok) ? '全部通过 —— codex 这条路是通的' : '有不通的地方（见上）'}`)
  return `${lines.join('\n')}\n`
}
