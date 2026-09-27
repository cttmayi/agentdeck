/**
 * `@agentdeck/agent-codex` —— Codex（app-server 形式）的适配器。
 *
 * 与前两个适配器（agent-claude / agent-generic）不同，这是**第一个 service 形状**
 * 的 runtime：不拼 run 级命令行，而是起一个 `codex app-server`，走 JSON-RPC 2.0
 * （stdio JSONL）——`thread/start`（或 `thread/resume`）→ `turn/start` → 流式
 * `item/*` 通知 → `turn/completed` 终止。设计见 `docs/runtime/codex-runtime-design.md`。
 *
 * ✅ 证据等级 `verified`：协议形状（握手、线程、turn、item 载荷、tokenUsage、
 *    中断、恢复拒绝 -32600）已在真实 app-server **0.144.0-alpha.4**（本机 local
 *    模型端点）上实测核对。残余未验证项（工具类 item、failed turn 的 TurnError
 *    形状、-32001 背压、`codex` 在 PATH 上的存在性）见 `unverifiedFields()`
 *    （数据，不是注释）。
 */

export {
  CODEX_DESCRIPTOR,
  CODEX_SERVER_FACTS,
  codexDescriptor,
  unverifiedFields,
  type CodexServerFacts,
} from './codex-descriptor.ts'

export {
  JsonRpcTransport,
  JsonRpcServerError,
  OVERLOAD_ERROR_CODE,
  type JsonRpcTransportOptions,
} from './jsonrpc-transport.ts'

export {
  CodexStreamParser,
  classifyCodexFailure,
  CODEX_NOTIFICATIONS,
  type CodexFailure,
  type CodexParserEvents,
  type CodexTurnEnd,
} from './stream-parser.ts'

export {
  CodexBackend,
  describeMissingCommand,
  type CodexBackendOptions,
} from './codex-backend.ts'
