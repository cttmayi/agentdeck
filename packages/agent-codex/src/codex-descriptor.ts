import { CODEX_DESCRIPTOR, type RuntimeDescriptor } from '@agentdeck/agent-core'

// 表行本体在 agent-core 的 RUNTIMES 里；这里只是转发给本包的调用方
// （测试、后端、daemon 装配各取所需）。
export { CODEX_DESCRIPTOR }

/**
 * 本包对 codex app-server 的**额外假设**——它们不进 `RuntimeDescriptor`。
 *
 * 判断标准与 generic 那份相同：**core 需要知道吗？** 协议方法名、审批策略、
 * 沙箱取值只有本包的 JSON-RPC 代码需要，所以留在本包；进表的只有 core 的
 * 通用机器（执行器、投递、审计、界面）要读的那些（会话状态、技能目录、
 * 证据等级、启动参数）。
 *
 * ✅ 方法名/取值已在真实 app-server 上实测核对（**0.144.0-alpha.4 与 0.157.1**，
 *    本机 local 模型端点，见 docs/runtime/codex-runtime-design.md §7）——残留未验证项见
 *    `unverifiedFields()`。
 */
export interface CodexServerFacts {
  /** initialize 握手时的客户端标识（出现在 OpenAI 合规日志里）。 */
  clientName: string
  /** thread/start 与 turn/start 的无人值守审批策略（两者都要传——恢复的线程会退回 on-request）。 */
  approvalPolicy: 'never'
  /** thread/start 的工作区沙箱——codex 每线程原生"只写工作区"。 */
  sandbox: 'workspace-write'
  /** 本 run 用到的 JSON-RPC 方法名（协议级）。 */
  methods: {
    initialize: string
    initialized: string
    threadStart: string
    threadResume: string
    turnStart: string
    turnInterrupt: string
  }
  /** 关心的通知方法名——未列出的通知宽容忽略（上游加通知是常态）。 */
  notifications: {
    itemStarted: string
    agentMessageDelta: string
    reasoningSummaryTextDelta: string
    /** 实测（0.144.0-alpha.4）：新摘要段落的标记帧（无文本，文本随后由 summaryTextDelta 送达）。 */
    reasoningSummaryPartAdded: string
    commandExecutionOutputDelta: string
    itemCompleted: string
    turnCompleted: string
    tokenUsageUpdated: string
    error: string
  }
}

export const CODEX_SERVER_FACTS: CodexServerFacts = {
  clientName: 'agentdeck',
  approvalPolicy: 'never',
  sandbox: 'workspace-write',
  methods: {
    initialize: 'initialize',
    initialized: 'initialized',
    threadStart: 'thread/start',
    threadResume: 'thread/resume',
    turnStart: 'turn/start',
    turnInterrupt: 'turn/interrupt',
  },
  notifications: {
    itemStarted: 'item/started',
    agentMessageDelta: 'item/agentMessage/delta',
    reasoningSummaryTextDelta: 'item/reasoning/summaryTextDelta',
    reasoningSummaryPartAdded: 'item/reasoning/summaryPartAdded',
    commandExecutionOutputDelta: 'item/commandExecution/outputDelta',
    itemCompleted: 'item/completed',
    turnCompleted: 'turn/completed',
    tokenUsageUpdated: 'thread/tokenUsage/updated',
    error: 'error',
  },
}

/** codex 描述符的副本（表行本体在 agent-core 的 `RUNTIMES`）。 */
export function codexDescriptor(): RuntimeDescriptor {
  return { ...CODEX_DESCRIPTOR }
}

/**
 * 该描述符与协议形状的哪些部分**还没有对照真实 app-server 验证过**。
 *
 * 不是注释，是**数据**：本包的测试直接断言这张清单存在，于是"未验证"这件事
 * 不会随着代码改动悄悄消失。核对过一条就删一条，并在删除处把结论写进
 * `CODEX_DESCRIPTOR.evidenceNote`。设计稿 `docs/runtime/codex-runtime-design.md` §7
 * 就是这张清单的出处（怎么核对写在每一行的"怎么核对"里）。
 *
 * ✅ 已实测核对并删除的条目：
 *   - 0.144.0-alpha.4（本机 local 模型端点）：baseArgs / sessionState / skills /
 *     versions（已填 verifiedWith）/ jsonrpc:initialize / jsonrpc:thread/start /
 *     jsonrpc:thread/resume（-32600 错误形状，rejectDetectable=true 依据）/
 *     jsonrpc:turn/start（含 approvalPolicy 参数）/ jsonrpc:turn/interrupt
 *     （{} 响应 → interrupted）/ jsonrpc:item/* 的 agentMessage(item.text) /
 *     reasoning(item.summary[]) / fileChange(item.changes[]) / userMessage /
 *     jsonrpc:turn/completed（completed|interrupted，failed 分支的 TurnError
 *     形状仍未实测）/ jsonrpc:thread/tokenUsage/updated（tokenUsage.total）/
 *     approvalPolicy:never（新线程无审批请求；恢复线程退回 on-request ⇒
 *     turn/start 也显式传 never）。
 *   - 0.157.1（npm 通道 /opt/homebrew/bin/codex，local 模型端点）：工具类 item
 *     **扁平形状**——commandExecution 字段在 item 顶层（item.command /
 *     item.status / item.aggregatedOutput，**没有 outputDelta 通知**）；
 *     mcpToolCall 同样扁平（item.tool / item.arguments / item.result.content[] /
 *     item.error）；fileChange 形状与 0.144.0-alpha.4 一致（item.changes[]）；
 *     sandbox 合法枚举实测：read-only | workspace-write | danger-full-access。
 */
export function unverifiedFields(): string[] {
  return [
    // 本机 PATH 上曾无 codex（插件二进制 ~/.codex/plugins/.plugin-appserver/codex
    // 不在 PATH）；2026-09-27 起用户装了 npm 通道 /opt/homebrew/bin/codex 后才
    // 可探测。这条保留：探测只认 PATH，二进制位置仍随安装方式变化。
    'command',
    // dynamicToolCall / webSearch 的形状仍未实测（本机模型未触发这两类工具）。
    'jsonrpc:item/* 的 dynamicToolCall / webSearch 分支',
    // turn/completed 的 failed 分支：TurnError{message, codexErrorInfo} 的形状
    // 来自源码/文档；实测只观察到 completed / interrupted（error:null）。
    'jsonrpc:turn/completed 的 failed 分支（TurnError/codexErrorInfo）',
    // 背压错误码：源码注释承诺 -32001；未实测触发过（重试逻辑按它写的）。
    'jsonrpc:-32001',
  ]
}
