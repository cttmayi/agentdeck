import { access, constants, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/**
 * 从 `PATH` 里找一个可执行文件；找不到返回 `null`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它为什么单独留下来了（2026-11，D123）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这个函数原来住在 `script-executor.ts`（"把工具包里的脚本跑起来"），而工具包与
 * 动作能力一起退场了——**整个文件都删了**。只有它是别人的依赖：`reveal.ts`
 * 要判断"这台机器上到底有没有 `open` / `explorer.exe` / `xdg-open`"，判据就是
 * "PATH 里找不找得到"（找不到时要给一句能照做的话，而不是"打开失败"）。
 *
 * 所以它不是"为工具包写的工具函数"，而是**平台兼容的一条规则**：按 `PATH` 找命令，
 * Windows 上还要按 `PATHEXT` 补扩展名。这条规则在哪儿都该一样的写法，抽出来放在
 * 这里（`reveal.ts` 是唯一使用者），比埋在一个会消失的模块里可靠。
 *
 * ★ 为什么 `platform` 是参数、不直接读 `process.platform`：注入是为了能在 macOS 上
 *   把"Windows 按 PATHEXT 逐扩展名找"那条分支真的跑一遍。之前它直接读
 *   `process.platform`，于是那条分支**在 macOS 上永远测不到**，而测试里能替它传的
 *   只有 env——等于让一条 Windows 专属的查找规则无人验证（真机上第一次跑就是它
 *   出错的时候）。`executable.test.ts` 钉着两条分支。
 */
export async function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const dirs = (env['PATH'] ?? '').split(delimiter).filter((d) => d !== '')
  const suffixes =
    platform === 'win32'
      ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter((s) => s !== '')
      : ['']

  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, command + suffix)
      try {
        const info = await stat(candidate)
        if (!info.isFile()) continue
        // ⚠️ 权限检查也要看**注入的平台**：Windows 没有"可执行位"这回事（`X_OK` 在那里
        //    等价于存在性），而注入 `platform: 'win32'` 在 macOS 上跑时若仍用 `X_OK`，
        //    一个 `.cmd` 会因为"没有 +x"被判成找不到 —— 那正是我们在真机之外**造**出来的假缺陷。
        await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK)
        return candidate
      } catch {
        // 不是可执行文件 / 不存在 ⇒ 继续找
      }
    }
  }
  return null
}
