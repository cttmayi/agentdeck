import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/**
 * 可选沙箱（M4）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 先说清楚它**不是**什么
 * ══════════════════════════════════════════════════════════════════
 *
 * `NG7` 明确写了首版不做沙箱隔离，run 以 daemon 进程的 OS 用户权限执行，
 * 可读写该用户可及的所有文件。这个东西**没有改变那个事实**：
 *
 *   - 它不是容器，也不是 microVM。同一个用户下的其他进程照样能碰到
 *     同一个工作目录；
 *   - 它挡的是**这条进程树自己**越界去读写别处，即"agent 自作主张动了
 *     工作目录之外的东西"这一类**意外与误操作**；
 *   - 它挡不住一个铁了心要逃逸的对手（`sandbox-exec` 的 profile 语言
 *     本就不是安全边界，Apple 自己也把它标注为 deprecated）。
 *
 * 所以它默认**关闭**。把它当成"开了就安全了"是最危险的误读，
 * README 与安全文档必须连这段一起说。
 *
 * ══════════════════════════════════════════════════════════════════
 * 唯一一条不能让步的规则：**宁可失败，不可静默降级**
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者打开了沙箱开关，就产生了一个明确的预期。如果这时候
 * `sandbox-exec` 不存在、或者 profile 语法不被接受，而实现选择
 * "那就直接跑吧"——那么**使用者会在以为自己被保护着的情况下裸奔**。
 *
 * 这种失败比"功能没做"严重得多，因为它把安全感本身变成了假的。
 * 所以 `planSandbox()` 在拿不到沙箱时**抛异常**，而不是返回一个
 * 不带包装的命令行。
 */

/** 沙箱模式。`none` 是默认——见文件头，这是有意的。 */
export type SandboxMode =
  /** 不包装。run 以 daemon 用户的完整权限执行（NG7 的现状）。 */
  | 'none'
  /**
   * 只允许写工作目录（外加系统临时目录）。
   *
   * 读权限**不限制**：agent 本来就需要读 CLI 自己的安装位置、node_modules、
   * 语言工具链。把读也锁死会让绝大多数任务直接跑不起来，而收益很小
   * （真正的秘密不在可读文件里，而在"能不能往回传"）。
   */
  | 'workdir-write'

export interface SandboxProbeResult {
  mode: SandboxMode
  /** 这个平台上有没有可用的沙箱工具。 */
  available: boolean
  /** 实际会用到的工具名（`sandbox-exec` / `bwrap`）或 null。 */
  tool: string | null
  /** 不可用时给出**可读**的原因。 */
  reason: string | null
}

export interface SandboxOptions {
  mode: SandboxMode
  /** 除工作目录外还允许写入的目录（工具链常要写缓存）。 */
  extraWritableDirs?: readonly string[]
}

export interface SandboxPlan {
  mode: SandboxMode
  /** 最终要执行的命令（含沙箱包装）。`none` 时原样返回。 */
  command: string
  args: string[]
  /** 审计用：实际生效的沙箱描述，会被写进审计记录。 */
  appliedDescription: string
}

export interface PlanSandboxInput {
  mode: SandboxMode
  command: string
  args: readonly string[]
  /** 允许写入的目录（通常是 run 的工作目录）。 */
  workDir: string
  /** 允许写入的额外目录（如系统临时目录）。 */
  extraWritableDirs?: readonly string[]
  platform?: NodeJS.Platform
  /** 探测工具是否存在。测试可注入，免得依赖跑测试的机器上装了什么。 */
  hasTool?: (name: string) => Promise<boolean>
}

/** 在 PATH 里找一个可执行文件。 */
async function defaultHasTool(name: string): Promise<boolean> {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter((d) => d !== '')
  for (const dir of dirs) {
    try {
      await access(join(dir, name), constants.X_OK)
      return true
    } catch {
      // 继续找下一个目录
    }
  }
  return false
}

/** 探测当前平台能不能提供所选模式的沙箱。 */
export async function probeSandbox(
  mode: SandboxMode,
  options: { platform?: NodeJS.Platform; hasTool?: (name: string) => Promise<boolean> } = {},
): Promise<SandboxProbeResult> {
  if (mode === 'none') {
    return { mode, available: true, tool: null, reason: null }
  }

  const platform = options.platform ?? process.platform
  const hasTool = options.hasTool ?? defaultHasTool

  if (platform === 'darwin') {
    return (await hasTool('sandbox-exec'))
      ? { mode, available: true, tool: 'sandbox-exec', reason: null }
      : {
          mode,
          available: false,
          tool: null,
          reason: 'macOS 上找不到 sandbox-exec（它随系统提供，通常不该缺失）',
        }
  }

  if (platform === 'linux') {
    return (await hasTool('bwrap'))
      ? { mode, available: true, tool: 'bwrap', reason: null }
      : {
          mode,
          available: false,
          tool: null,
          reason:
            'Linux 上找不到 bwrap（bubblewrap）。请先安装：' +
            'apt install bubblewrap / dnf install bubblewrap',
        }
  }

  return {
    mode,
    available: false,
    tool: null,
    reason:
      `当前平台（${platform}）没有实现可选沙箱。` +
      `Windows 上可考虑改用容器或独立 VM——本项目不在首版范围内。`,
  }
}

/**
 * 生成最终命令行。
 *
 * ★ 沙箱不可用时**抛异常**。见文件头：静默降级会让使用者
 *   在以为自己被保护着的情况下裸奔。
 */
export async function planSandbox(input: PlanSandboxInput): Promise<SandboxPlan> {
  if (input.mode === 'none') {
    return {
      mode: 'none',
      command: input.command,
      args: [...input.args],
      // 审计里也要留痕：将来看到一条 run 时，要知道它当时**没有**被沙箱
      appliedDescription: '未启用沙箱：run 以 daemon 用户的完整权限执行（NG7）',
    }
  }

  const probe = await probeSandbox(input.mode, {
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.hasTool ? { hasTool: input.hasTool } : {}),
  })

  if (!probe.available) {
    throw new SandboxUnavailableError(probe.reason ?? '沙箱不可用')
  }

  const writable = [input.workDir, ...(input.extraWritableDirs ?? [])]

  if (probe.tool === 'sandbox-exec') {
    return {
      mode: input.mode,
      command: 'sandbox-exec',
      args: ['-p', macosProfile(writable), input.command, ...input.args],
      appliedDescription:
        `sandbox-exec：允许写入 ${writable.join(', ')}；读取不受限；` +
        `⚠️ 这不是安全边界（NG7），只挡误操作`,
    }
  }

  // bwrap
  const args = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
  ]
  for (const dir of writable) {
    args.push('--bind', dir, dir)
  }
  args.push('--unshare-pid', '--die-with-parent', input.command, ...input.args)

  return {
    mode: input.mode,
    command: 'bwrap',
    args,
    appliedDescription:
      `bwrap：根文件系统只读，仅允许写入 ${writable.join(', ')}；` +
      `⚠️ 这不是安全边界（NG7），只挡误操作`,
  }
}

export class SandboxUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `沙箱模式已开启但不可用：${reason}\n` +
        `**不会静默降级为无沙箱执行**——那会让你在以为自己被保护着的情况下裸奔。` +
        `请安装对应工具，或显式把沙箱模式改回 none 并接受 NG7 的风险。`,
    )
    this.name = 'SandboxUnavailableError'
  }
}

/**
 * macOS 的 SBPL profile。
 *
 * 写成 `(allow default)` 再关掉写，而不是"默认拒绝再逐条放行"：
 * 后者需要枚举 agent 会用到的每一条系统调用与路径，漏一条就是任务直接跑不起来，
 * 而且在没有真实 CLI 的 CI 上根本无法验证。**默认允许 + 限制写**是这里
 * 唯一能被诚实验证的口径，也与"这不是安全边界"的定位一致。
 */
function macosProfile(writable: readonly string[]): string {
  const writes = writable.map((d) => `(subpath ${JSON.stringify(d)})`).join(' ')
  return [
    '(version 1)',
    '(allow default)',
    // 关掉"写到别处"。注意这是**最后一条匹配生效**的语义之外的口径：
    // SBPL 里 allow 优先，所以这里同时要显式拒绝，不能只靠 allow 的缺席。
    '(deny file-write*)',
    `(allow file-write* ${writes})`,
    // /dev 下的东西是终端、随机数等运行必需品，锁掉会让进程直接起不来
    '(allow file-write* (subpath "/dev"))',
    // 系统临时目录：很多工具链默认往这里写
    '(allow file-write* (subpath "/private/tmp") (subpath "/var/folders"))',
  ].join('\n')
}
