import type { DroppedArg } from './blocked-args.ts'
import { filterBlockedArgs } from './blocked-args.ts'
import type { RuntimeDescriptor } from './runtime-table.ts'
import { loadRuntimeDescriptor } from './runtime-table.ts'

/**
 * argv 组装（FR-CLI-04）。
 *
 * 顺序是**固定的**，而且这个顺序本身就是一份声明——「谁说了算」：
 *
 *   1. 平台基础参数        使用者不可覆盖（协议本身）
 *   2. 平台受管参数        model / max-turns / resume
 *   3. 使用者自定义参数    ★ 已过禁改表过滤
 *   4. 平台受管追加参数    当前为空，为 MCP / settings 预留
 *
 * **最后写的赢。** 所以平台自己的值写在末尾——即使前面的过滤漏掉了什么，
 * 末尾的权威值仍然生效。这是"纵深防御"在参数层面的形态。
 *
 * ⚠️ 第 2 段的**旗标拼写来自描述表**（`managedFlags`），不写死在这里。
 *    首版写死过 `--model` / `--max-turns`：对 claude 正确，但等于把一个 CLI
 *    的拼写固化进"通用"代码——第二个 runtime 若用别的拼写，唯一的出路就是
 *    改本文件，而那正是 FR-CLI-47 禁止的"散落在调用点"。
 *    经 `loadRuntimeDescriptor` 补齐后缺省值仍是 claude 的拼写，故首版行为逐字节不变。
 */

export interface BuildArgvInput {
  runtime: RuntimeDescriptor
  model?: string | null
  maxTurns?: number | null
  resumeSessionId?: string | null
  /** 使用者的自定义参数——会被过滤。 */
  userArgs?: readonly string[]
  /**
   * 平台受管追加参数。
   *
   * 首版恒为空。它的存在就是**扩展位**（FR-CLI-45）：启用 MCP 或技能禁用时，
   * 这里追加 `--mcp-config <临时文件>` / `--settings <策略文件>`，
   * 而**不需要改动本函数的任何逻辑**。
   */
  managedAppend?: readonly string[]
}

export interface BuildArgvResult {
  /** 不含可执行文件本身的参数列表。 */
  argv: string[]
  dropped: DroppedArg[]
  /** 使用者传了禁改参数——调用方必须记警告日志（FR-CLI-12）。 */
  hadDropped: boolean
}

export function buildArgv(input: BuildArgvInput): BuildArgvResult {
  const runtime = loadRuntimeDescriptor(input.runtime)
  // `managedFlags` 是必填字段：类型上必填，`loadRuntimeDescriptor` 上一行
  // 还会在运行时再验一次（描述符可能是仓库之外传进来的对象）。
  const flags = runtime.managedFlags
  const argv: string[] = []

  // 1. 平台基础参数
  argv.push(...runtime.baseArgs)

  // 2. 平台受管参数
  if (input.model) argv.push(flags.model, input.model)
  if (input.maxTurns !== null && input.maxTurns !== undefined && input.maxTurns > 0) {
    argv.push(flags.maxTurns, String(input.maxTurns))
  }
  if (input.resumeSessionId) argv.push(flags.resume, input.resumeSessionId)

  // 3. 使用者参数（过滤后的），保持原有相对顺序
  const { kept, dropped } = filterBlockedArgs(input.userArgs ?? [], runtime.blockedArgs)
  argv.push(...kept)

  // 4. 平台受管追加参数——最后写，赢
  if (input.managedAppend?.length) argv.push(...input.managedAppend)

  return { argv, dropped, hadDropped: dropped.length > 0 }
}

/** 完整命令行（含可执行文件）——用于审计记录与日志。 */
export function buildCommandLine(executablePath: string, argv: readonly string[]): string[] {
  return [executablePath, ...argv]
}
