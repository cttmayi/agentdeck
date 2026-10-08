import { access, constants, mkdir, rm, stat, writeFile } from 'node:fs/promises'
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

export interface WritableProbeDeps {
  /** 注入平台（默认 `process.platform`）——注入是为了能在 macOS 上测 Windows 那条分支。 */
  platform?: NodeJS.Platform
  /** 真的写一次并删掉。默认实现见 `probeWrite`。 */
  writeProbe?: (path: string) => Promise<void>
}

/**
 * ★ Windows 上**必须真写一次**，不能只看 `access(W_OK)`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么（2026-10 Windows 兼容性审计的 B3）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这个函数存在的全部理由，是把"CLI 状态目录写不进去"从**一句指向错方向的
 * EPERM**（见文件头）提前成启动时的**一句人话**。而 `access(W_OK)` 在 Windows 上
 * 给出的答案不反映 ACL——它看的是只读属性那一套。也就是说：**在那台真正会出问题的
 * 机器上，这个预检会报"一切正常"**，问题照样推到运行时、照样以 EPERM 出现、
 * 照样被读成"工作目录没建成功"。
 *
 * 所以 Windows 上改成"真写一个临时文件再删掉"：那是唯一权威的判据。
 * 非 Windows 上保留 `access` 那条快路（POSIX 上它是准的，而且不往使用者的
 * 家目录里落任何东西——那也是"别碰别人东西"这条规矩的一部分）。
 *
 * 代价说清楚：Windows 上会在 CLI 的状态目录里**短暂出现**一个
 * `.agentdeck-write-probe-<pid>` 文件（写完立刻删）。一个只读目录里它建不出来，
 * 而"建不出来"正是我们要知道的答案。
 */
async function probeWrite(path: string): Promise<void> {
  // ⚠️ 不覆盖任何已有文件（万一这个 pid 的死文件还在，换一个名字）
  const probe = join(path, `.agentdeck-write-probe-${process.pid}-${Date.now()}`)
  try {
    await writeFile(probe, '', 'utf8')
  } finally {
    await rm(probe, { force: true }).catch(() => {
      /* 删不掉不影响结论：能不能写已经量到了 */
    })
  }
}

export async function isWritableDir(
  path: string,
  deps: WritableProbeDeps = {},
): Promise<{ ok: boolean; reason?: string }> {
  const platform = deps.platform ?? process.platform
  try {
    // 先看存不存在
    await access(path, constants.F_OK)
  } catch {
    // 不存在 ⇒ 试着建。这才是真实场景：CLI 首次运行时要建它。
    try {
      await mkdir(path, { recursive: true })
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  // ⚠️ 存在还不够，它得是个**目录**：那个位置上有个同名文件时，CLI 会在运行中报
  //    `ENOTDIR`（一句话里看不出"是你的状态路径被文件占了"），而这个预检的价值
  //    正是把这类环境问题提前成启动时的一句话。这条与平台无关。
  try {
    const info = await stat(path)
    if (!info.isDirectory()) {
      return { ok: false, reason: '那个位置上有个同名的文件，不是目录' }
    }
  } catch (err) {
    // 坏掉的符号链接之类：stat 本身就会失败，如实说出来
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }

  if (platform === 'win32') {
    try {
      await (deps.writeProbe ?? probeWrite)(path)
      return { ok: true }
    } catch (err) {
      // 带上真实 errno（Windows 上 EPERM/EACCES 的含义与 POSIX 不完全一样，
      // 使用者要拿它去搜、去问 IT）
      const code = (err as NodeJS.ErrnoException).code
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, reason: code === undefined ? detail : `${detail}（${code}）` }
    }
  }

  try {
    await access(path, constants.W_OK)
    return { ok: true }
  } catch {
    return { ok: false, reason: '目录存在但不可写' }
  }
}

/**
 * 检查所有 runtime 的状态目录。
 *
 * 只检查**可用**的那些——没装的 CLI 谈不上"它的家目录写不进去"。
 */
export async function checkEnvironment(
  runtimes: ReadonlyArray<{ descriptor: RuntimeDescriptor; available: boolean }>,
  options: { homeDir?: string; deps?: WritableProbeDeps } = {},
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
    const result = await isWritableDir(path, options.deps)

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
