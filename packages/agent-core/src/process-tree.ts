import { spawn, type ChildProcess } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { resolveSpawnTarget } from './spawn-target.ts'

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

const DEFAULT_GRACE_MS = 5_000

export function spawnProcessTree(input: SpawnInput): ProcessHandle {
  const isWindows = process.platform === 'win32'

  const target = resolveSpawnTarget({ command: input.command, args: input.args })

  const child: ChildProcess = spawn(target.command, target.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Unix：新进程组，便于整组终止
    detached: !isWindows,
    windowsHide: true,
  })

  let lastActivity = Date.now()
  const touch = (): void => {
    lastActivity = Date.now()
    input.onActivity?.()
  }

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      touch()
      input.onStdoutLine?.(line)
    })
  }
  if (child.stderr) {
    const rl = createInterface({ input: child.stderr, crlfDelay: Infinity })
    rl.on('line', (line) => {
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
