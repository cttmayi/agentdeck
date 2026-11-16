import { spawn, type ChildProcess } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import { resolveSpawnTarget, spawnPlanFor } from './spawn-target.ts'

/**
 * 进程树管理（NFR-P-05）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不能直接 `child.kill()`
 * ══════════════════════════════════════════════════════════════════
 *
 * Agent CLI 会自己派生子进程（跑测试、起构建、调工具）。只杀直接子进程
 * 会留下一堆孤儿——它们继续占着端口、改着文件，而使用者以为任务已经停了。
 *
 *   Unix    → 把子进程放进**新进程组**（`detached: true`），整组发信号
 *   Windows → `kill(pid)` 杀不掉进程树，必须用 `taskkill /T /F`
 *             （Job Object 是更彻底的方案，见下）
 *
 * 平台差异用一个接口盖住，上层不需要知道自己在哪个系统上。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️ Windows 上"要 exec 的东西"和"探测到的东西"**不是同一个文件**
 * ══════════════════════════════════════════════════════════════════
 *
 * npm 装在 Windows 上的 CLI 是 `.cmd` 垫片，而 Node 从 2024-04 的安全版本起
 * （CVE-2024-27980）**拒绝 `shell: false` 地 spawn `.cmd`/`.bat`**（参数校验阶段
 * 抛 `EINVAL`）。所以这里**先问 `resolveSpawnTarget`**：它会把垫片解开成
 * `<node> <cli.js> <真实参数>`（`via: 'shim'`），认不出来才退回 `cmd.exe`
 * （`via: 'cmd'`）。诊据与取舍全在 `spawn-target.ts` 的模块头与
 * `docs/reference/windows-compat.md`。
 *
 * ⚠️ 正因为有这条：`spawnProcessTree` **可能同步抛** `UnspawnableCommandError`
 *    （比如探测到的是 `.ps1`，或者参数里有 cmd 无法如实传递的字符）。
 *    那是**故意的**——静默改写参数会让"prompt 少了半句"，比失败难查得多。
 */

export interface SpawnInput {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** stdout 按行回调。 */
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  /** 任何输出都调用——用于活性判定（FR-RUN-08 的判据）。 */
  onActivity?: () => void
  /**
   * 测试缝：换成别的 `spawn`（默认 `node:child_process` 的）。
   * 用来在 macOS 上断言"我们真的把 `windowsVerbatimArguments` 传下去了"。
   */
  spawnImpl?: typeof spawn
  /**
   * 测试缝：换成别的"决定 exec 什么"（默认 `resolveSpawnTarget`）。
   * 同样是为了在 macOS 上把 Windows 的 `via: 'cmd'` 那一档跑出来。
   */
  resolveTarget?: typeof resolveSpawnTarget
}

export interface ExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
}

/**
 * 子进程上"只给监听器和 pid"的最小视图——见 `ProcessHandle.process` 的说明。
 *
 * 之所以不用 `ChildProcess` 本身：那个类型带着 `kill()`，而直接 `kill()`
 * 会绕过"杀整棵进程树"（NFR-P-05）——那正是本模块存在的理由。
 * 最小接口还有个附带好处：适配器不必 import Node 的子进程类型，
 * 它的测试替身也只需要提供这两样东西。
 */
export interface ChildProcessSignals extends EventEmitter {
  /** 可选——与 Node 的 `ChildProcess.pid` 一致（进程还没起来时是 undefined）。 */
  readonly pid?: number | undefined
}

export interface ProcessHandle {
  readonly pid: number | undefined
  /**
   * 底层子进程的信号面。
   *
   * 暴露它是为了**诊断**：`spawn` 的失败有两种出口——同步抛出，以及异步
   * `'error'` 事件。而 `exited` 把它们都压成了 `{ code: null }`，
   * 于是 ENOENT / EACCES 的真实原因会丢失，调用方只能报一句
   * "没拿到输出"（这正是"错误文本指向错地方"的典型）。
   *
   * 想拿到原因的调用方自己 `handle.process.once('error', ...)` 即可。
   */
  readonly process: ChildProcessSignals
  readonly exited: Promise<ExitInfo>
  writeStdin(data: string): void
  endStdin(): void
  /** 终止整棵进程树。先温和后强杀。 */
  terminate(graceMs?: number): Promise<void>
  /** 最近一次输出的时间戳。活性判定用它，而不是总运行时长。 */
  lastActivityAt(): number
}

/**
 * 按**真正的换行符**（`\n`）切行——**不认 Unicode 的行分隔符**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不能用 `readline.createInterface`
 * ══════════════════════════════════════════════════════════════════
 *
 * 2026-11 真机 P0（D120）：本机 9 条 run 全死在
 * `codex 对话阶段失败：JSON-RPC 请求 thread/resume（id=2）超时（60000ms）`，
 * 同时 run 日志里堆着 119 条「JSON-RPC 帧不可解析」。
 *
 * 量出来的根因就在这一行代码上：Node 的 `readline` 把 **U+2028（LINE SEPARATOR）
 * / U+2029（PARAGRAPH SEPARATOR）** 也当成行结束（那是 ECMAScript 的
 * LineTerminator 集合），而 JSON-RPC over stdio 是 **NDJSON**——只认 `\n`。
 * agent 读进来的那份 PDF / 网页 / `textutil` 转出的文本里正好有 U+2028，
 * 被塞进 `thread/resume` 的响应（1,649,749 字节、**118 个 U+2028**）里，
 * 于是那**一帧**被切成 119 段，每一段都不是合法 JSON ⇒ 对方的响应永远拼不回来
 * ⇒ 那条请求等到 60 秒超时 ⇒ 整条 run 记成 infra_error。
 *
 * 证据（本机实测，`.cache/codex-resume-wire/`）：
 *   · 同一份字节，裸 pipe 抓下来是 **1 行 / 13 个 LF**（`JSON.parse` 通过）；
 *   · 走 `spawnProcessTree` 同一个进程同样的帧：**readline 131 行**，其中 119 行
 *     不可解析，切点全在 `\xe2\x80\xa8` 上——与真机日志里 119 条一一对上。
 *
 * 所以自己切：`\n` 才是行边界，`\r`（Windows 的 CRLF）顺手去掉，其余一律照抄。
 * **不许多开一份切行逻辑**——平台侧进程 I/O 只在这里（见 platform-compat.md）。
 */
function pipeLines(stream: Readable, onLine: (line: string) => void): void {
  // 按字符串收（不是按 Buffer）：多字节字符正好卡在块边界时，`setEncoding` 的
  // StringDecoder 会把它补齐；自己 `toString()` 会把一个 UTF-8 字符劈成两半。
  stream.setEncoding('utf8')
  let pending = ''
  stream.on('data', (chunk: string) => {
    pending += chunk
    let index = pending.indexOf('\n')
    while (index >= 0) {
      let line = pending.slice(0, index)
      pending = pending.slice(index + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      onLine(line)
      index = pending.indexOf('\n')
    }
  })
  // 没有换行符收尾的最后一行也要吐出来——`readline` 也是这么做的，
  // 少了它，"CLI 只写了半行就退出"时那一行会静默消失（日志尾行丢失）。
  stream.on('end', () => {
    if (pending === '') return
    const line = pending.endsWith('\r') ? pending.slice(0, -1) : pending
    pending = ''
    onLine(line)
  })
}

const DEFAULT_GRACE_MS = 5_000

export function spawnProcessTree(input: SpawnInput): ProcessHandle {
  const isWindows = process.platform === 'win32'

  const target = (input.resolveTarget ?? resolveSpawnTarget)({
    command: input.command,
    args: input.args,
  })
  // ★ 分批第 43 批：`spawnPlanFor` 里带着 `windowsVerbatimArguments`——
  //   漏了它，`via: 'cmd'` 那条路在真 Windows 上**起不来**（我们拼好的命令行被
  //   Node 又转义了一遍，引号当场错位）。使用者就是这么量出来的。
  const plan = spawnPlanFor(target)
  const doSpawn = input.spawnImpl ?? spawn

  const child: ChildProcess = doSpawn(plan.command, plan.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Unix：新进程组，便于整组终止
    detached: !isWindows,
    windowsHide: true,
    ...plan.options,
  })

  let lastActivity = Date.now()
  const touch = (): void => {
    lastActivity = Date.now()
    input.onActivity?.()
  }

  if (child.stdout) {
    pipeLines(child.stdout, (line) => {
      touch()
      input.onStdoutLine?.(line)
    })
  }
  if (child.stderr) {
    pipeLines(child.stderr, (line) => {
      touch()
      input.onStderrLine?.(line)
    })
  }

  const exited = new Promise<ExitInfo>((resolve) => {
    child.once('error', () => resolve({ code: null, signal: null }))
    child.once('close', (code, signal) => resolve({ code, signal }))
  })

  let terminated = false

  const killTree = (signal: NodeJS.Signals): void => {
    const pid = child.pid
    if (pid === undefined) return

    if (isWindows) {
      // Windows 上 kill(pid) 不作用于子进程树
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
      return
    }

    try {
      // 负 pid = 整个进程组
      process.kill(-pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        /* 进程已退出 */
      }
    }
  }

  return {
    get pid() {
      return child.pid
    },
    process: child,
    exited,
    writeStdin(data: string) {
      child.stdin?.write(data)
    },
    endStdin() {
      child.stdin?.end()
    },
    lastActivityAt() {
      return lastActivity
    },
    async terminate(graceMs = DEFAULT_GRACE_MS) {
      if (terminated) return
      terminated = true

      if (child.exitCode !== null || child.signalCode !== null) return

      if (isWindows) {
        // taskkill 本身就带 /F，温和阶段没有意义
        killTree('SIGTERM')
        return
      }

      killTree('SIGTERM')

      const timer = setTimeout(() => killTree('SIGKILL'), graceMs)
      timer.unref?.()
      try {
        await Promise.race([exited, new Promise((r) => setTimeout(r, graceMs + 500))])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
