import {
  getRuntimeDescriptor,
  knownRuntimeKeys,
  loadRuntimeDescriptor,
  type AgentBackend,
  type RuntimeDescriptor,
} from '@agentdeck/agent-core'
import { ClaudeBackend } from '@agentdeck/agent-claude'
import { CodexBackend } from '@agentdeck/agent-codex'
import { GenericBackend } from '@agentdeck/agent-generic'

/**
 * runtime → 适配器的装配表（FR-CLI-47 的第 2 段）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这一小段代码必须放在 daemon，而不能放进 agent-core
 * ══════════════════════════════════════════════════════════════════
 *
 * 描述表（数据）在 agent-core，适配器（行为）在各 `agent-*` 包里。
 * 把它们**接起来**的那一行只能在最上层——因为单向依赖：
 *
 *   agent-core ← agent-claude / agent-generic ← daemon
 *
 * 若把"new ClaudeBackend(descriptor)"写进 agent-core，agent-core 就得反过来
 * 依赖 agent-claude，形成环。所以拼装点天然属于**组合根**，也就是这里。
 *
 * ⚠️ 但这不等于"加一个 runtime 要去改调用点"。分工要看清：
 *   - 想加 runtime：`runtime-table.ts` 加一行（数据）+ 新包的适配器（行为）；
 *   - 本文件只在**首次接入那个适配器包**时加一行映射（一次性的）。
 * 也就是说"支持 N 个 runtime"的成本是 O(N) 的一次性装配，而不是
 * 在"每个用到 backend 的地方"各加一个 if——后者才是 FR-CLI-47 要防的。
 *
 * 本文件是 agent-claude 与 agent-generic **唯一的**共同调用点，
 * 所以"第二个适配器有没有真的插上"在这一个文件里看得清清楚楚。
 */

/** 一个 runtime 的装配项：构造适配器所需的全部信息。 */
export interface RuntimeAdapter {
  descriptor: RuntimeDescriptor
  create(options: {
    /** 覆盖可执行文件路径（测试与诊断用）。 */
    executablePath?: string
    onWarn?: (message: string) => void
  }): AgentBackend
}

/**
 * 已装配的 runtime 表。
 *
 * `backend` 的类型写成 `AgentBackend` 而不是各自的类：两个适配器实现的是
 * **同一份契约**，装配点不该知道谁是谁。这也让"少实现一个方法"在类型层面
 * 就过不了——可插拔的前提是接口真的被遵守。
 */
function buildAdapters(): Record<string, RuntimeAdapter> {
  return {
    claude: {
      descriptor: getRuntimeDescriptor('claude'),
      create: (options) =>
        new ClaudeBackend({
          descriptor: getRuntimeDescriptor('claude'),
          ...(options.executablePath ? { executablePath: options.executablePath } : {}),
          ...(options.onWarn ? { onWarn: options.onWarn } : {}),
        }),
    },
    generic: {
      descriptor: getRuntimeDescriptor('generic'),
      create: (options) =>
        new GenericBackend({
          descriptor: getRuntimeDescriptor('generic'),
          ...(options.executablePath ? { executablePath: options.executablePath } : {}),
          ...(options.onWarn ? { onWarn: options.onWarn } : {}),
        }),
    },
    // ★ codex：service 形状（`codex app-server` + JSON-RPC）。
    //   装配行与 claude/generic 完全同构——差异全部在描述表数据里（kind:'service'、
    //   baseArgs、family），这里没有多一个 if。证据等级 provisional：
    //   首次接入真实 codex 前先核对 `@agentdeck/agent-codex` 的 unverifiedFields()。
    codex: {
      descriptor: getRuntimeDescriptor('codex'),
      create: (options) =>
        new CodexBackend({
          descriptor: getRuntimeDescriptor('codex'),
          ...(options.executablePath ? { executablePath: options.executablePath } : {}),
          ...(options.onWarn ? { onWarn: options.onWarn } : {}),
        }),
    },
  }
}

/**
 * 装配表 + 每张表行一个适配器，**两边的键必须一一对应**。
 *
 * 这条不变式由测试守着，但它在这里也值得写一句：描述表里出现一个没有适配器的
 * runtime，表现是"这个 runtime 可选，选了就崩"——比不支持更糟，因为使用者
 * 会以为是自己配置错了。反之适配器多一个也没有意义（枚举不到）。
 */
export function knownRuntimeAdapters(): Record<string, RuntimeAdapter> {
  const adapters = buildAdapters()
  const missing = knownRuntimeKeys().filter((key) => !(key in adapters))
  if (missing.length > 0) {
    throw new Error(
      `runtime 描述表里有未装配适配器的项：${missing.join(', ')}。` +
        `请在 apps/daemon/src/runtime-registry.ts 里补上——有表行没有适配器时，` +
        `使用者会看到这个 runtime 可选，选了却起不来。`,
    )
  }
  return adapters
}

export interface SelectedRuntime {
  descriptor: RuntimeDescriptor
  backend: AgentBackend
}

/**
 * 按 key 装配一个 runtime。
 *
 * 未知 key **必须报错并列出可用的**，不能静默回退到 claude：静默回退会让
 * 一次写错 runtimeKey 的配置看起来"能跑"，但跑的是**另一个 CLI**，
 * 而产出与上下文文件目录全都对不上——这种错最难查。
 */
export function createRuntimeBackend(
  runtimeKey: string,
  options: { executablePath?: string; onWarn?: (message: string) => void } = {},
): SelectedRuntime {
  const adapters = knownRuntimeAdapters()
  const adapter = adapters[runtimeKey]
  if (!adapter) {
    throw new Error(
      `未知的 runtime：${runtimeKey}。可用：${Object.keys(adapters).join(', ')}`,
    )
  }
  return {
    descriptor: loadRuntimeDescriptor(adapter.descriptor),
    backend: adapter.create(options),
  }
}
