/**
 * 任务隔离的 PreToolUse hook 注入（2026-10）。
 *
 * 背景：claude 会把 Bash/Read 跑到工作目录之外——实测它会 `ls ..` 去看兄弟
 * 任务的目录、读其他 issue 的产出当参考（那份"聪明"越过了任务边界）。工作目录
 * 是"分配给你干活的地方"，不是"你只能看这里"（NG7：不做沙箱隔离），所以这里
 * 用 claude 自己的 hooks 机制做**硬拦截**：工具执行前 claude 调
 * `pre-tool-use.py`（本目录），目标路径在工作目录外就 deny，工具不执行。
 *
 * ⚠️ 2026-10-17 实测确认：claude 2.1.143 的 `-p` 非交互模式**会**执行工作目录
 *    `.claude/settings.json` 里配置的 PreToolUse hook（这是本方案成立的前提）。
 *
 * 与第一句话里那句「任务边界」的关系：那句是**引导层**（模型先看到规则），
 * 这里是**拦截层**（规则没拦住就 deny）。两层都无条件由平台注入/组装，
 * 不依赖使用者记得写。
 *
 * 只对 claude runtime 生效：codex 是 service 形状（app-server），没有这套
 * hooks 机制，也不读 `.claude/settings.json`。
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** PreToolUse 拦截哪些工具：结构化路径工具 + Bash（Bash 只拦明显越界，见脚本注释）。 */
export const RUN_HOOK_MATCHER = 'Bash|Read|Edit|Write|Glob|Grep'

/** hook 脚本在工作目录里的落点。 */
export const RUN_HOOK_SCRIPT_REL = join('.agentdeck', 'hooks', 'pre-tool-use.py')
/** claude 读的 project settings 落点（hook 配置）。 */
export const RUN_HOOK_SETTINGS_REL = join('.claude', 'settings.json')

const hookScriptUrl = new URL('./pre-tool-use.py', import.meta.url)

/**
 * 把任务隔离 hook 写进工作目录：`.claude/settings.json`（claude 读它）+ 脚本本体。
 * 幂等（每次 run 覆盖重写）。注入失败**不**让 run 失败——隔离是增强不是核心，
 * 但会记一条 note 让使用者知道这次没有隔离。
 */
export async function injectRunHooks(workDir: string): Promise<void> {
  const hookPy = join(workDir, RUN_HOOK_SCRIPT_REL)
  const settings = join(workDir, RUN_HOOK_SETTINGS_REL)
  await mkdir(join(workDir, '.claude'), { recursive: true })
  await mkdir(join(workDir, '.agentdeck', 'hooks'), { recursive: true })
  const script = await readFile(hookScriptUrl, 'utf8')
  await writeFile(hookPy, script, 'utf8')
  const settingsJson = JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: RUN_HOOK_MATCHER,
            hooks: [{ type: 'command', command: `python3 ${JSON.stringify(hookPy)}`, timeout: 10 }],
          },
        ],
      },
    },
    null,
    2,
  )
  await writeFile(settings, settingsJson, 'utf8')
}

/** 收尾：摘掉平台注入的 hook 配置与脚本（工作目录只留 agent 的产出）。幂等。 */
export async function removeRunHooks(workDir: string): Promise<void> {
  await rm(join(workDir, '.agentdeck', 'hooks'), { recursive: true, force: true })
  await rm(join(workDir, RUN_HOOK_SETTINGS_REL), { force: true })
}
