/**
 * 任务隔离的 PreToolUse hook（2026-10；分批第 76 批**改落点**）。
 *
 * 背景：claude 会把 Bash/Read 跑到工作目录之外——实测它会 `ls ..` 去看兄弟任务的
 * 目录、读其他 issue 的产出当参考。工作目录是"分配给你干活的地方"，不是"你只能
 * 看这里"（NG7：不做沙箱隔离），所以用 claude 自己的 hooks 机制做**硬拦截**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 分批第 76 批：从"写进工作目录"改成"常驻受管配置目录"
 * ══════════════════════════════════════════════════════════════════
 *
 * 原来它落在任务工作目录里（`.claude/settings.json` + `.agentdeck/hooks/`），
 * 每次 run 注入、跑完摘掉。使用者问：「skill 和一些配置都放在 workdir 下，能不能
 * 挪出去，这样就不影响 workdir 里的东西」——hook 是工作目录里那两样平台痕迹之一。
 *
 * 现在它写在**受管 `CLAUDE_CONFIG_DIR`** 里（`claude-config.ts` 同步的那一份），
 * 与 `env` / `enabledPlugins` 一起进 `settings.json`：
 *   · 工作目录里不再出现 `.claude/settings.json` 与 `.agentdeck/hooks/`；
 *   · 不碰使用者真实的 `~/.claude`（那是 D78 的隔离要挡的东西）；
 *   · **常驻**而不是每轮注入 ⇒ 少一类"注入失败 ⇒ 这次没有拦截"的故障。
 *
 * 为什么常驻不会串到别的任务上（实测 2026-10-29，claude 2.1.302）：hook 被调用时
 * 环境里有 `CLAUDE_PROJECT_DIR=<本次工作目录>`，stdin 里也有 `cwd`——而脚本本来就是
 * 按 `cwd` 判越界的（见 `pre-tool-use.py` 头注释）。所以一份全局 hook 对每个
 * 工作目录各自正确。
 *
 * ⚠️ 只对 claude 生效：codex 是 service 形状（app-server），没有这套 hooks 机制。
 * ⚠️ 隔离没生效时（复制失败 ⇒ 自动退回用使用者自己的配置）**这套 hook 也就不存在**，
 *    那条 note 会明说"本次没有任务隔离拦截"。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** PreToolUse 拦截哪些工具：结构化路径工具 + Bash（Bash 只拦明显越界，见脚本注释）。 */
export const RUN_HOOK_MATCHER = 'Bash|Read|Edit|Write|Glob|Grep'

/** hook 脚本在**受管配置目录**里的相对落点（分批第 76 批）。 */
export const MANAGED_HOOK_SCRIPT_REL = join('agentdeck-hooks', 'pre-tool-use.py')

const hookScriptUrl = new URL('./pre-tool-use.py', import.meta.url)

/** settings.json 里那段 `hooks` 的形状（只声明我们认识的那一项）。 */
export interface RunHookSettings {
  PreToolUse: Array<{
    matcher: string
    hooks: Array<{ type: 'command'; command: string; timeout: number }>
  }>
}

/**
 * 把 hook 脚本写进受管配置目录，并返回要并进 `settings.json` 的 `hooks` 段。
 *
 * 幂等（每次 run 覆盖重写脚本与那段配置）；脚本从包内复制过去，**不引工作目录**。
 */
export async function installManagedRunHook(configDir: string): Promise<{
  scriptPath: string
  hooks: RunHookSettings
}> {
  const scriptPath = join(configDir, MANAGED_HOOK_SCRIPT_REL)
  await mkdir(dirname(scriptPath), { recursive: true })
  await writeFile(scriptPath, await readFile(hookScriptUrl, 'utf8'), 'utf8')
  return {
    scriptPath,
    hooks: {
      PreToolUse: [
        {
          matcher: RUN_HOOK_MATCHER,
          hooks: [
            { type: 'command', command: `python3 ${JSON.stringify(scriptPath)}`, timeout: 10 },
          ],
        },
      ],
    },
  }
}
