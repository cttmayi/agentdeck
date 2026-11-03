import { spawn } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { findExecutable } from './script-executor.ts'

/**
 * 在**系统文件管理器**里打开一个目录（Finder / 资源管理器 / xdg 那边）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这件事得 daemon 来做
 * ══════════════════════════════════════════════════════════════════
 *
 * 浏览器没有"打开本机某个目录"的能力（`file://` 链接在现代浏览器里被拦，而且它也不该
 * 由页面来开）。所以「工作目录的文件」栏头上那颗「打开」只能是：页面发一个路径给 daemon，
 * daemon 调系统自带的那条命令。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三个平台各自的坑
 * ══════════════════════════════════════════════════════════════════
 *
 *   macOS    `open <dir>`：最规矩的一条。
 *   Windows  `explorer.exe <dir>`：
 *            ⚠️ **成功也回退出码 1**（它把"窗口已经交出去了"当成非零）。所以这里
 *            绝不能用退出码判断成败——判断依据只能是"进程起没起来"。
 *   Linux    `xdg-open <dir>`：桌面环境才有；纯命令行/容器里它多半不存在（这时给一句
 *            能照做的话，而不是"打开失败"）。
 *
 * ⚠️ **argv 直传，不经过 shell**（`spawn(command, [path])`）：路径里带空格、`&`、引号都
 *    是常态（`/Users/me/My Projects`），拼 shell 命令行等于给自己开一个注入面。
 *    `cli.ts` 里 `openBrowser` 是同一个口径。
 */
export type RevealResult =
  | { ok: true; path: string }
  | {
      ok: false
      code: 'not_absolute' | 'not_a_dir' | 'not_found' | 'no_opener'
      error: string
    }

/** 平台 → "打开这个目录"的命令与参数。**纯函数**：三个平台都能在任意机器上钉住。 */
export function revealCommandFor(
  platform: NodeJS.Platform,
  dir: string,
): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [dir] }
  if (platform === 'win32') return { command: 'explorer.exe', args: [dir] }
  return { command: 'xdg-open', args: [dir] }
}

export interface RevealInput {
  /** 要打开的目录（必须绝对；`~` 不在这里展开——调用方给的一律是 daemon 算出来的绝对路径）。 */
  path: string
  /** 注入平台（默认 `process.platform`）——测试在 macOS 上验 Windows/Linux 那两档。 */
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** 测试缝：换掉真正的 `spawn`。 */
  spawnImpl?: typeof spawn
  /** 测试缝：换掉"这条命令在不在"。 */
  find?: (command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => Promise<string | null>
}

/**
 * 打开目录。**成功只代表"已经把它交出去了"**，不代表窗口真的弹出来了（那要靠 GUI 会话）。
 */
export async function revealInFileManager(input: RevealInput): Promise<RevealResult> {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const asked = input.path.trim()
  if (!isAbsolute(asked)) {
    return { ok: false, code: 'not_absolute', error: `需要一个绝对路径（收到的是「${asked}」）` }
  }

  // 先解析再开：路径里可能有符号链接，而"打开一个链接"在三个平台上的表现各不相同
  // （Finder 会跳到链接本身所在的位置）。解析之后打开的是真实目录，与界面上显示的一致。
  let real: string
  try {
    real = await realpath(asked)
  } catch {
    return { ok: false, code: 'not_found', error: `这个目录不存在：${asked}` }
  }
  const info = await stat(real).catch(() => null)
  if (info === null || !info.isDirectory()) {
    return { ok: false, code: 'not_a_dir', error: `这不是一个目录：${real}` }
  }

  const { command, args } = revealCommandFor(platform, real)
  const find = input.find ?? findExecutable
  if ((await find(command, env, platform)) === null) {
    return {
      ok: false,
      code: 'no_opener',
      error:
        platform === 'linux'
          ? `这台机器上没有 ${command}（多半是没有桌面环境）。可以直接在终端里 cd 进去：${real}`
          : `找不到用来打开目录的命令（${command}）`,
    }
  }

  const doSpawn = input.spawnImpl ?? spawn
  try {
    // detached + ignore + unref：文件管理器是**独立进程**，daemon 不该等它、也不该跟着它退。
    const child = doSpawn(command, args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    })
    child.on('error', () => {
      /* 起不来就算了：调用方已经收到"交出去了"，人能自己开；错误进不了界面也不必说谎 */
    })
    child.unref()
  } catch {
    return { ok: false, code: 'no_opener', error: `没能启动 ${command}` }
  }
  return { ok: true, path: real }
}
