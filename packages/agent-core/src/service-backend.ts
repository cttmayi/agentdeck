/**
 * ★ 分批第 66 批：**service 形状适配器的公共基类**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 与 cli 形状（`LineStreamBackendBase`）的分工
 * ══════════════════════════════════════════════════════════════════
 *
 * cli 形状（claude / generic）的骨架是"拼 argv → 喂一次 stdin → 逐行解析"，
 * 那条骨架整个共用（第 65 批）。
 *
 * service 形状（codex 的 `app-server`）的**协议时序**完全不同：起进程之后要先握手
 * （initialize → thread/start → turn/start），结果是 JSON-RPC 帧而不是 stdout 行，
 * 取消还要先发 `turn/interrupt`。把那段塞进模板方法只会得到一个"到处都是钩子"的基类，
 * 读起来比两份实现还糟。
 *
 * 所以这里只收**真正一样的那几段**：
 *
 *   ① 解析可执行文件（探测 or 注入路径）与 `probe()`；
 *   ② 找不到时的措辞钩子（各 runtime 的证据等级不同）；
 *   ③ "这个路径能不能当程序跑"（`isRunnableFile`，与 generic 共用同一份实现）；
 *   ④ `planSandbox` 那一步 + "CLI 状态目录必须放行"这条规则（外加子类自己的放行项）。
 *
 * 剩下的（握手、turn、取消语义、终态判定）留在子类——**差异在子类里是显式的**，
 * 而不是散在一堆 `if (key === 'codex')` 里。
 */
import type { ExecOptions } from './backend.ts'
import type { RuntimeDescriptor } from './runtime-table.ts'
import { detectVersion, probeCommand } from './probe.ts'
import { cliStateDir, planSandbox, type SandboxPlan } from './sandbox.ts'
import { describeMissingCommand, isRunnableFile } from './executable-check.ts'
import type { RuntimeProtocol } from '@agentdeck/protocol'

export interface ServiceBackendOptions {
  descriptor: RuntimeDescriptor
  /** 覆盖可执行文件路径；不给则自动探测。 */
  executablePath?: string
  /** 丢弃/忽略某项时的警告出口（不得静默）。 */
  onWarn?: (message: string) => void
  /** 缓存探测结果。测试里关掉。 */
  useProbeCache?: boolean
}

/** `prepareLaunch()` 的产物：起进程要用的两样东西。 */
export interface ServiceLaunch {
  executablePath: string
  plan: SandboxPlan
}

/**
 * ⚠️ 这里**不** `implements AgentBackend`：`execute()` 仍由子类实现（它的协议时序是子类的事）。
 *    写成 `implements` 会逼着一个抽象类去声明它并不提供的方法，读起来像"它负责执行"。
 */
export abstract class ServiceBackendBase {
  readonly key: string
  readonly protocol: RuntimeProtocol
  readonly rejectDetectable: boolean

  protected readonly descriptor: RuntimeDescriptor
  protected readonly options: ServiceBackendOptions

  constructor(options: ServiceBackendOptions) {
    this.options = options
    this.descriptor = options.descriptor
    this.key = this.descriptor.key
    this.protocol = this.descriptor.protocol
    // service 形状不靠"恢复被拒"的探测（没有 `resume` 段），固定 false。
    this.rejectDetectable = false
  }

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    const path = await this.resolveExecutable()
    if (!path) {
      return { available: false, command: this.descriptor.command, cliVersion: null }
    }
    return {
      available: true,
      command: this.descriptor.command,
      cliVersion: await detectVersion(path),
    }
  }

  /** 解析可执行文件（注入路径优先，否则探测 PATH）。 */
  protected async resolveExecutable(): Promise<string | null> {
    if (this.options.executablePath) return this.options.executablePath
    const probe = await probeCommand(this.descriptor.command, {
      useCache: this.options.useProbeCache ?? true,
    })
    return probe.available ? probe.path : null
  }

  /**
   * 起进程前的准备：解析 → "真能跑吗" → 沙箱规划。
   *
   * ⚠️ 顺序是刻意的：先确认文件能跑，再谈沙箱。反过来的话，"路径指到一个目录"
   *    会在沙箱那一步变成一个不相干的错误。
   */
  protected async prepareLaunch(opts: ExecOptions, args: readonly string[]): Promise<ServiceLaunch> {
    const executablePath = await this.resolveExecutable()
    if (!executablePath) throw new Error(await this.missingExecutableMessage())
    if (!(await isRunnableFile(executablePath))) {
      throw new Error(await describeMissingCommand(executablePath, this.evidenceNote()))
    }
    const plan = await planSandbox({
      mode: opts.sandbox?.mode ?? 'none',
      command: executablePath,
      args: [...args],
      workDir: opts.workDir,
      extraWritableDirs: [
        ...(opts.sandbox?.extraWritableDirs ?? []),
        ...this.extraWritableDirs(opts),
      ],
    })
    return { executablePath, plan }
  }

  // ── 子类的差异点 ──

  /** 找不到可执行文件时说什么。 */
  protected abstract missingExecutableMessage(): Promise<string> | string

  /** 证据等级说明（拼进"找不到/跑不了"的诊断里；空串 = 不说）。 */
  protected evidenceNote(): string {
    return ''
  }

  /**
   * 沙箱里额外要放行的目录。
   *
   * 默认 = CLI 自己的状态目录（`cliStateDir`）——**这条对所有 service runtime 都成立**：
   * 沙箱不让它写状态目录时，它会以各种奇怪的方式坏掉（codex 是建不了 rollout，
   * claude 是 Bash 工具全程 EPERM），而 daemon 在沙箱外、预检会说"一切正常"。
   */
  protected extraWritableDirs(_opts: ExecOptions): string[] {
    return [...cliStateDir(this.descriptor)]
  }
}
