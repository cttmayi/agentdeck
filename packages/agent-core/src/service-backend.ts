/**
 * ★ 分批第 66/68 批：**service 形状适配器的公共基类**（`AgentBackendBase` 的一个族）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 类层次（按**交互方式**分族，公共部分在根上）
 * ══════════════════════════════════════════════════════════════════
 *
 * ```
 * AgentBackendBase            描述符、probe、解析可执行文件、"能不能跑"、证据等级说明
 *   ├── CliStreamBackendBase  一次 stdin + 逐行 stdout（claude、generic）
 *   └── ServiceBackendBase    常驻进程 + 帧协议（codex 的 app-server）
 * ```
 *
 * ══════════════════════════════════════════════════════════════════
 * 本族自己剩下的活儿
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
 *   · `prepareLaunch()`：起进程前的准备（根类给的"能跑吗" + 本族的沙箱规划）；
 *   · `extraWritableDirs()`：沙箱里除 CLI 状态目录外还要放行什么（codex 要放行 CODEX_HOME）。
 *
 * 剩下的（握手、turn、取消语义、终态判定）留在子类——**差异在子类里是显式的**，
 * 而不是散在一堆 `if (key === 'codex')` 里。
 */
import { AgentBackendBase, type LineStreamBackendOptions } from './backend-base.ts'
import type { ExecOptions } from './backend.ts'
import type { RuntimeDescriptor } from './runtime-table.ts'
import { cliStateDir, planSandbox, type SandboxPlan } from './sandbox.ts'

/**
 * service 族的构造选项——**与 cli 族完全一样**（描述符 + 可执行路径 + onWarn + 探测缓存），
 * 所以直接复用根类那份类型（`LineStreamBackendOptions` 名字留作兼容，见下）。
 */
export type ServiceBackendOptions = LineStreamBackendOptions

/** `prepareLaunch()` 的产物：起进程要用的两样东西。 */
export interface ServiceLaunch {
  executablePath: string
  plan: SandboxPlan
}

/**
 * ⚠️ 这里**不** `implements AgentBackend`：`execute()` 仍由子类实现（它的协议时序是子类的事）。
 *    写成 `implements` 会逼着一个抽象类去声明它并不提供的方法，读起来像"它负责执行"。
 */
export abstract class ServiceBackendBase extends AgentBackendBase {
  constructor(options: ServiceBackendOptions) {
    super(options)
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
    // 与 cli 那一族同一份实现（根类的 assertRunnable）
    await this.assertRunnable(executablePath)
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
