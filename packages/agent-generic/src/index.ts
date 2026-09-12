/**
 * `@alpha-helper/agent-generic` —— 第二个 agent CLI 适配器。
 *
 * 存在的意义不在于"多支持一个厂商"，而在于给出**可插拔的第二个实证**：
 * 描述表里加一行、本包实现 `AgentBackend`，其余调用点（argv 组装、
 * 禁改参数过滤、失败分级、daemon 的注入与审计）一行都不用改（FR-CLI-47）。
 *
 * ⚠️ **该 runtime 的证据等级是 `provisional`**：本仓库里没有任何真实 CLI
 *    可对照，字段名按公开形状推导。整条链路由假可执行文件覆盖（NFR-T-01），
 *    首次接入真实 CLI 时必须逐个字段核对——清单见 `unverifiedFields()`。
 *
 * 反向引用一句设计里的话：留扩展位一定要写清楚**为什么没启用**，
 * 否则它会消失在"以后再说"里。`unverifiedFields()` 就是这个"写清楚"的
 * 机器可读版本。
 */

export {
  GENERIC_CLI_FACTS,
  GENERIC_DESCRIPTOR,
  GENERIC_BLOCKED_ARGS,
  genericDescriptor,
  genericEvidence,
  genericPromptDelivery,
  unverifiedFields,
  type GenericCliFacts,
} from './generic-descriptor.ts'

export {
  GenericStreamParser,
  GENERIC_EVENT_TYPES,
  MAX_LINE_BYTES,
  buildGenericInput,
  detectResumeRejection,
  type GenericEventType,
  type GenericStreamEvents,
} from './stream-parser.ts'

export {
  GenericBackend,
  classifyGenericFailure,
  describeMissingCommand,
  type GenericBackendOptions,
  type GenericFailure,
} from './generic-backend.ts'
