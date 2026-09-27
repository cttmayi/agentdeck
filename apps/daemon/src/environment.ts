import { access, constants, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeDescriptor } from '@agentdeck/agent-core'

/**
 * 运行环境预检（实跑之后补上的一块）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这块是从一个"指向错误方向"的报错里长出来的
 * ══════════════════════════════════════════════════════════════════
 *
 * 实跑时 agent 的工具输出里出现：
 *
 *     EPERM: operation not permitted, mkdir '/Users/<user>/.claude/session-env/<uuid>'
 *
 * 那个路径**不是我们的工作目录**——它是 Claude Code 自己的状态目录。
 * 但因为报错发生在 run 里、又长得像"目录建不了"，很容易被读成
 * **"工作目录没设置成功"**。于是排查会从工作目录开始，而那里根本没有问题。
 *
 * ══════════════════════════════════════════════════════════════════
 * 什么时候会遇到
 * ══════════════════════════════════════════════════════════════════
 *
 * daemon 跑在受限环境里的时候：容器、专用用户、或者任何限制家目录写入的
 * 沙箱。而"把 daemon 跑在受限环境里"恰恰是**推荐做法**（README 里写着
 * 专用 Unix 用户 → 容器 → 独立 VM）。
 *
 * 也就是说：**越是按推荐做法部署，越容易撞上它**——而撞上时得到的是一句
 * 指向错误方向的 EPERM。所以这件事必须在起 run 之前就说清楚。
 *
 * ⚠️ 检查是**尽力而为**的：它只回答"这个目录能不能建/能写"，不保证 CLI
 *    在运行中不会因为别的原因失败。它的价值在于把最常见的那种环境问题
 *    从"agent 输出里的一句 EPERM"提前成"启动时的一句人话"。
 */

export interface EnvironmentIssue {
  /** 受影响的对象（runtime key）。 */
  subject: string
  severity: 'error' | 'warning'
  /** 一句话结论。 */
  summary: string
  /** 能照着做的下一步。 */
  action: string
}

export interface EnvironmentReport {
  ok: boolean
  issues: EnvironmentIssue[]
  /** 查过哪些路径（诊断用）。 */
  checkedPaths: string[]
}

async function isWritableDir(path: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    // 先看存不存在
    await access(path, constants.F_OK)
    try {
      await access(path, constants.W_OK)
      return { ok: true }
    } catch {
      return { ok: false, reason: '目录存在但不可写' }
    }
  } catch {
    // 不存在 ⇒ 试着建。这才是真实场景：CLI 首次运行时要建它。
    try {
      await mkdir(path, { recursive: true })
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

/**
 * 检查所有 runtime 的状态目录。
 *
 * 只检查**可用**的那些——没装的 CLI 谈不上"它的家目录写不进去"。
 */
export async function checkEnvironment(
  runtimes: ReadonlyArray<{ descriptor: RuntimeDescriptor; available: boolean }>,
  options: { homeDir?: string } = {},
): Promise<EnvironmentReport> {
  const home = options.homeDir ?? homedir()
  const issues: EnvironmentIssue[] = []
  const checkedPaths: string[] = []

  for (const { descriptor, available } of runtimes) {
    if (!available) continue
    const stateDir = descriptor.stateDir
    if (!stateDir) continue

    const path = join(home, stateDir)
    checkedPaths.push(path)
    const result = await isWritableDir(path)

    if (!result.ok) {
      issues.push({
        subject: descriptor.key,
        severity: 'error',
        summary:
          `${descriptor.command} 需要写自己的状态目录，但 ${path} 不可用` +
          `（${result.reason}）。它会在运行中报出 EPERM，而那看起来像"工作目录没建成功"——` +
          `其实工作目录是好的。`,
        action:
          `给这个目录写权限，或把 daemon 换成一个家目录可写的用户来跑。` +
          // ⚠️ 这句话会进**运行日志**（界面上按纯文本逐行显示），所以不留 markdown
          //    的粗体记号：`**推荐做法**` 到使用者眼里就是两个星号（2026-09 清理）。
          `注意：把 daemon 跑在受限环境（容器 / 专用用户 / 沙箱）里是推荐做法，` +
          `所以撞上它是正常的——只是要记得同时放开 CLI 自己的状态目录。`,
      })
    }
  }

  return { ok: issues.length === 0, issues, checkedPaths }
}

/** 供启动日志与界面使用的一段可读文本。 */
export function renderEnvironmentReport(report: EnvironmentReport): string {
  if (report.ok) return ''
  return report.issues
    .map((i) => `[${i.severity}] ${i.summary}\n  怎么办：${i.action}`)
    .join('\n')
}
