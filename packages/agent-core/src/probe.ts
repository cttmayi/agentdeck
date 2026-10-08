import { access, constants } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { spawnProcessTree } from './process-tree.ts'
import { WINDOWS_SPAWNABLE_EXT, isWindowsSpawnableExt } from './spawn-target.ts'

/**
 * 可执行文件探测（FR-RUNTIME-03）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要自己实现 `which`
 * ══════════════════════════════════════════════════════════════════
 *
 * 关键场景：**从 GUI 启动的进程拿不到用户 shell 的 PATH**。
 * 使用者在终端里 `claude` 明明能用，但从桌面图标启动的 daemon 里
 * `LookPath` 找不到——于是"这个 CLI 没装"这个结论是错的，而用户
 * 完全不知道为什么。
 *
 * 所以探测分两步：
 *   1. 先在当前 PATH 里找（快，覆盖绝大多数情况）
 *   2. 找不到时 **fork 用户的登录 shell** 问一次 `command -v`
 *      （这会加载 rc 文件，因此慢——所以只在第一步失败时才做）
 *
 * `ref/multica-claude-code-customization.md` 里对这一步有句很准的批注：
 * 没有这个兜底，"几乎总有一个没装上的 provider 会让 LookPath 失败"。
 */

/**
 * Windows 上要找哪些扩展名。
 *
 * ══════════════════════════════════════════════════════════════════
 * 旧版这里写死了一张表，里面还带 `.ps1`——那是错的
 * ══════════════════════════════════════════════════════════════════
 *
 * `.ps1` 是 PowerShell 脚本，**Node 起不了它**（要 `powershell.exe -NoProfile -File`）。
 * 于是探测会"成功"、真跑的时候才炸——正是"预检说可用、运行时报错"那类最难归因的
 * 故障（2026-10 Windows 兼容性审计的 A2）。
 *
 * 现在两件事一起改：
 *   1. 以机器的 **`PATHEXT`** 为准（`script-executor.findExecutable` 一直是这么做的，
 *      两处不一致本身就是坑）；
 *   2. 用 `WINDOWS_SPAWNABLE_EXT` **把 Node 起不来的那些滤掉**——`.ps1`、`.VBS`、
 *      `.JS`、`.WSF` 都在 PATHEXT 里、也都起不了。
 *
 * 末尾那个空串是"命令本身已经带扩展名"的情形（`claude.exe`）：不试它就永远找不到。
 */
export function windowsCandidateExtensions(pathext: string | undefined): string[] {
  const declared = (pathext ?? '')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext !== '')
  const spawnable = declared.filter((ext) => isWindowsSpawnableExt(ext))
  // PATHEXT 可能被改窄过（有人把它设成只有 `.EXE`），但 PATH 里真有 `.cmd` 垫片
  // 时我们仍然该找到它——所以三类可 spawn 的扩展名一个都不能少。
  for (const ext of WINDOWS_SPAWNABLE_EXT) {
    if (!spawnable.includes(ext)) spawnable.push(ext)
  }
  return [...new Set([...spawnable, ''])]
}

export function candidatesIn(dir: string, command: string): string[] {
  if (process.platform !== 'win32') return [join(dir, command)]
  return windowsCandidateExtensions(process.env['PATHEXT']).map((ext) => join(dir, `${command}${ext}`))
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 在当前 PATH 里查找。 */
export async function findOnPath(command: string): Promise<string | null> {
  if (isAbsolute(command)) return (await isExecutable(command)) ? command : null

  const pathValue = process.env['PATH'] ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const candidate of candidatesIn(dir, command)) {
      if (await isExecutable(candidate)) return candidate
    }
  }
  return null
}

/**
 * fork 用户的登录 shell 问一次。
 *
 * 会执行用户的 rc 文件——这是**性能与副作用的取舍**：正因为它慢且有副作用，
 * 只在第一步失败时调用，并且结果要缓存（调用方负责缓存）。
 */
export async function findViaLoginShell(command: string): Promise<string | null> {
  if (process.platform === 'win32') return null

  const shell = process.env['SHELL'] || '/bin/sh'
  return new Promise((resolve) => {
    let out = ''
    const handle = spawnProcessTree({
      command: shell,
      // -l 让 shell 成为登录 shell，加载用户的 rc
      args: ['-l', '-c', `command -v ${JSON.stringify(command)}`],
      cwd: process.cwd(),
      env: process.env,
      onStdoutLine: (line) => {
        out += `${line}\n`
      },
    })

    const timer = setTimeout(() => {
      void handle.terminate(1000)
      resolve(null)
    }, 5000)
    timer.unref?.()

    void handle.exited.then(() => {
      clearTimeout(timer)
      const first = out.trim().split('\n')[0]?.trim()
      resolve(first && first.length > 0 ? first : null)
    })
  })
}

export interface ProbeResult {
  available: boolean
  /** 解析到的可执行文件路径（不可用时为 null）。 */
  path: string | null
  /** 是通过登录 shell 兜底找到的。 */
  viaLoginShell: boolean
}

/**
 * 探测一个命令。带**进程内缓存**——因为登录 shell 兜底有副作用，
 * 重复调用它会让每次探测都去跑一遍用户的 rc 文件。
 */
const probeCache = new Map<string, ProbeResult>()

export async function probeCommand(
  command: string,
  options: { useCache?: boolean } = {},
): Promise<ProbeResult> {
  const useCache = options.useCache ?? true
  if (useCache) {
    const cached = probeCache.get(command)
    if (cached) return cached
  }

  let result: ProbeResult = { available: false, path: null, viaLoginShell: false }

  const direct = await findOnPath(command)
  if (direct) {
    result = { available: true, path: direct, viaLoginShell: false }
  } else {
    const viaShell = await findViaLoginShell(command)
    if (viaShell) {
      result = { available: true, path: viaShell, viaLoginShell: true }
    }
  }

  if (useCache) probeCache.set(command, result)
  return result
}

/** 清空探测缓存——CLI 刚装好或刚登录后调用（`daemon restart` 路径）。 */
export function clearProbeCache(): void {
  probeCache.clear()
}

/**
 * 取 CLI 版本。
 *
 * 版本只作**观察**用途：绝不拿它来选择行为。按版本分支是脆弱设计的典型，
 * 因为版本号的语义在不同 CLI 之间并不一致（FR-RUNTIME-07 要求声明并测试
 * 支持的版本范围，那是**测试**的职责，不是运行时的分支）。
 */
export async function detectVersion(executablePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const stdoutLines: string[] = []
    const stderrLines: string[] = []
    const handle = spawnProcessTree({
      command: executablePath,
      args: ['--version'],
      cwd: process.cwd(),
      env: process.env,
      onStdoutLine: (line) => {
        stdoutLines.push(line)
      },
      onStderrLine: (line) => {
        stderrLines.push(line)
      },
    })

    const timer = setTimeout(() => {
      void handle.terminate(1000)
      resolve(null)
    }, 5000)
    timer.unref?.()

    void handle.exited.then(() => {
      clearTimeout(timer)
      // ★ 版本号以 **stdout** 为准：stderr 可能是警告/日志（codex 的 --version
      //   会先在 stderr 打一行 WARNING，抢到"第一行"会把版本探测变成垃圾串）。
      //   从 stdout 里找第一个长得像版本的；stdout 为空才退回 stderr。
      const pick = (lines: string[]): string | null => {
        if (lines.length === 0) return null
        const withVersion = lines.map((l) => l.trim()).find((l) => /\d+\.\d+\.\d+(?:[-.\w]*)?/.test(l))
        const first = withVersion ?? lines[0]?.trim() ?? ''
        if (!first) return null
        const match = first.match(/\d+\.\d+\.\d+(?:[-.\w]*)?/)
        return match ? match[0] : first.slice(0, 64)
      }
      resolve(pick(stdoutLines) ?? pick(stderrLines))
    })
  })
}
