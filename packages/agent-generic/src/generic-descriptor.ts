import {
  GENERIC_BLOCKED_ARGS,
  GENERIC_DESCRIPTOR,
  type PromptDelivery,
  type RuntimeDescriptor,
  type RuntimeEvidence,
} from '@alpha-helper/agent-core'

/**
 * 第二个 runtime 的描述符（FR-CLI-47 的填空作业）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么描述符本体在 agent-core，而**行为**在本包
 * ══════════════════════════════════════════════════════════════════
 *
 * 描述表是**编译进程序的**（design §9.1 的意图，docs 也明确说 CLI 适配层
 * 不是插件——插件只有登录与第三方查询）。`getRuntimeDescriptor('generic')`
 * 必须在 daemon 只依赖 agent-core 时也能返回东西，否则"表"就变成了
 * "运行时才发现装没装包"的注册表，那是插件模型。
 *
 * 所以分工是：
 *   - **数据**（表行）在 core —— 使 `RUNTIMES` 保持自洽、可静态枚举；
 *   - **行为**（拼参数、起进程、解 NDJSON、判失败）在本包。
 *
 * 本文件因此不再另造一份描述符，而是把 core 里那一行**取出来并补齐**，
 * 再附上本包自己的、只对第二个 CLI 成立的额外事实（`GenericCliFacts`）。
 * 两份描述符会漂移，这是刻意避免的。
 */

/**
 * 本包对第二个 CLI 的**额外假设**——它们不进 `RuntimeDescriptor`。
 *
 * 判断标准很简单：**core 需要知道吗？** `argv.ts` 需要旗标名、`executor.ts`
 * 需要技能目录与上下文文件名，所以那些进表；而"凭据放在哪个环境变量里"
 * 只有本包的进程启动代码需要，所以留在本包。往表里堆只有一家用得上的字段，
 * 会让第二个表行变成"字段名清单"，而表的价值恰恰在于它只有几列。
 */
export interface GenericCliFacts {
  /**
   * [未验证] 凭据环境变量名。
   *
   * 刻意**不支持**通过命令行或 `customArgs` 传 key：命令行参数会出现在
   * 进程列表与审计记录里。若真实 CLI 只认 `--api-key`，正确做法是写一个
   * 受管临时配置文件（FR-CLI-16 的权限收紧要求同样适用），
   * 而不是把密钥放进 argv。
   */
  apiKeyEnv: string
  /** [未验证] 兼容服务的 base URL 环境变量名。 */
  baseUrlEnv: string
  /** NDJSON 事件里表示会话 ID 的字段名。 */
  sessionIdField: string
}

export const GENERIC_CLI_FACTS: GenericCliFacts = {
  apiKeyEnv: 'AGENT_CLI_API_KEY',
  baseUrlEnv: 'AGENT_CLI_BASE_URL',
  sessionIdField: 'session_id',
}

/** 第二个 runtime 的描述符（`managedFlags` 现在是必填，不再需要补齐）。 */
export function genericDescriptor(): RuntimeDescriptor {
  return { ...GENERIC_DESCRIPTOR, managedFlags: { ...GENERIC_DESCRIPTOR.managedFlags } }
}

/**
 * 该描述符的哪些字段**没有对照真实 CLI 验证过**。
 *
 * 这不是注释，是**数据**：`agent-generic` 的测试直接断言这张清单，
 * 于是"未验证"这件事不会随着代码改动悄悄消失。首次接入真实 CLI 时，
 * 正确动作是逐条核对、从这张表里删掉一条，而 `evidenceNote` 里也写了这一点。
 *
 * 之所以要这么麻烦：一个"看起来能用"的未验证适配器最危险的地方，
 * 是它会把失败伪装成 agent 的行为问题——使用者会去查 prompt、查 skill，
 * 而真正的问题是旗标名拼错了。
 */
export function unverifiedFields(): string[] {
  return [
    'command', // 命令名 agent-cli：真实二进制名待定
    'baseArgs', // --non-interactive / --output ndjson / --no-color / --no-ask-user
    'blockedArgs', // --prompt / --yolo / --non-interactive 的实际拼写与别名
    'managedFlags.model', // -m
    'managedFlags.maxTurns', // --max-steps
    'resume.flag', // --resume-session
    'promptDelivery', // argv 还是 stdin，未验证
    'skills', // 该 CLI 到底有没有技能发现机制（现在如实声明为 'none'）
    'stream-parser:事件名', // text / thinking / tool_use / tool_result / usage / result / error
    'stream-parser:字段名', // session_id / message / result / usage.input_tokens
    'GENERIC_CLI_FACTS', // 凭据与 base URL 的环境变量名
  ]
}

/** 证据等级——UI 与审计据此提示"这个 runtime 还没验证过"。 */
export function genericEvidence(): RuntimeEvidence {
  return GENERIC_DESCRIPTOR.evidence
}

/** prompt 投递方式——`argv` 表示拼进命令行，`stdin-ndjson` 表示走标准输入。 */
export function genericPromptDelivery(): PromptDelivery {
  return GENERIC_DESCRIPTOR.promptDelivery
}

export { GENERIC_BLOCKED_ARGS, GENERIC_DESCRIPTOR }
