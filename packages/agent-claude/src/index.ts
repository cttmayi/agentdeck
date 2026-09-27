/**
 * `@agentdeck/agent-claude` —— Claude Code 适配器。
 *
 * 首版唯一的 runtime 实现（D1）。新增第二个 CLI 时，照本包的形状再写一个：
 * 实现 `AgentBackend`，在 runtime 描述表里加一行，其余调用点不动
 * （FR-RUNTIME-06/08）。
 */

export { ClaudeBackend, type ClaudeBackendOptions } from './claude-backend.ts'
export {
  ClaudeStreamParser,
  MAX_LINE_BYTES,
  buildClaudeInput,
  detectResumeRejection,
  type ClaudeStreamEvents,
} from './stream-parser.ts'
