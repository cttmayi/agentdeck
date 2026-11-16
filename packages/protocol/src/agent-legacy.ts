/**
 * ⚠️ **已经从 `Agent` 上撤掉的字段**（2026-10），以及把老记录摘干净的纯函数。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要这个文件
 * ══════════════════════════════════════════════════════════════════
 *
 * 这两个能力被整个移除，字段也随之从 `Agent` 的 schema 里删掉了：
 *
 *   · `reviewerAgentId` —— "由谁来审这个执行 agent 的产出"。界面上 2026-10 就
 *     拿掉了那个设置，留下的是一个**隐式**效果（某个执行者跑完会自动被某个人
 *     审，而这件事在界面上完全看不见）。现在"谁审"的唯一出处是**智能体组**的
 *     审核者，建任务时展开进 `Run.reviewerAgentId`。
 *
 *   · `allowedActions` / `debugActions` / `actionParams` —— 审核者的"行动权限"。
 *     "判完允许动什么"属于**这条链**（这队人的活判过之后允许做什么），不属于
 *     某个审核者个人：它一度搬到 `AgentGroup` 上的同名字段，2026-11（D123）又随
 *     **整个动作能力退场**——现在平台不再有动作，也没有地方配它。
 *
 * 但**老记录里还留着那几个键**：store 把 agent 整条当 JSON 存（文件存储是
 * JSONL、sqlite 是一个 `json` 列），读取路径上没有 zod 校验，所以删字段**不会**
 * 让老数据消失——它只会让"读的人"看不见。于是那些键会出现在 API 响应里、会在
 * `{...agent, ...patch}` 这类合并里被原样带回去、会在导出与排查时误导人。
 *
 * 所以清理分三层，**判据都在这个文件里**（一处定义，三处使用）：
 *
 *   ① **读时兜底** —— 两个 store 的 `getAgent` / `listAgents` 都过一遍
 *      `stripLegacyAgentFields`。这是唯一的总闸：所有读取都走 store 端口。
 *   ② **启动时一次性从记录里删掉** —— daemon 起来时扫一遍并写回
 *      （`apps/daemon/src/agent-legacy-cleanup.ts`），老数据从此在磁盘上就干净了。
 *   ③ **保存时也进不来** —— 写入口（创建 / PATCH）不再认识这几个键，写了就是
 *      `不认识的字段` 400。加上 ①，"合并老记录再写回"也带不回它们。
 *
 * ⚠️ **别把 `Run.reviewerAgentId` 一起摘掉**：run 上那个同名字段**保留**，它是
 *    组把审核者交给链路的载体（语义是"这一次任务由谁审"）。这里只处理 `Agent`
 *    与它内嵌的 `reviewStandard`。
 */

/**
 * 老记录里要摘掉的键（`Agent` 顶层）。
 *
 * 与 `Agent` 的 schema **必须一致**——这里多一个键就会把还在用的字段删掉。所以
 * 清单只有这一份，且由 `agent-legacy.test.ts` 钉住"这几个键确实不在 schema 里"。
 */
export const LEGACY_AGENT_KEYS = [
  'reviewerAgentId',
  'allowedActions',
  'debugActions',
  'actionParams',
  /*
   * ⚠️ 2026-11（S4，D127）：`role` 也进了这张表——**但不是简单删掉**，见下面
   *   `BUILTIN_KIND_BY_LEGACY_ROLE` 那段：内置岗位要从 `role` **搬进**
   *   `Agent.builtinKind`，用户建的 agent 则是直接失去那个键。
   */
  'role',
] as const

/**
 * 老的 `role` → 新的 `builtinKind`。
 *
 * 只有**内置**的那四个岗位有对应关系；`executor` / `reviewer` 没有——它们不是岗位，
 * 是"角色"，而角色这个概念已经删了（D127）。所以老记录的处理分两种：
 *
 *   · `builtin === true` + `role` 是这四个之一 ⇒ 补上 `builtinKind`（老记录里没有），
 *     再摘掉 `role`；
 *   · 其余（用户建的 agent，或者 builtin 标记坏了）⇒ 只摘 `role`。
 *
 * ⚠️ 这是一次**升格**（把一个字段的值搬到另一个字段），不是"补默认值"。放在这里而
 *    不是放在启动清理里，是因为**读时兜底是唯一的总闸**：两个 store 的
 *    `getAgent` / `listAgents` 都过这个函数，所以任何读路径（包括还没跑过启动
 *    清理的老 data 目录）看到的内置岗位都是完整的。漏在这一层的后果很具体：
 *    内置起草者读出来 `builtinKind === undefined` ⇒ `builtinKindOf()` 返回 null ⇒
 *    沉淀那条链找不到它，会**再建一个**。
 */
const BUILTIN_KIND_BY_LEGACY_ROLE: Record<string, string> = {
  drafter: 'drafter',
  'skill-reviewer': 'skill-reviewer',
  'memory-tidy': 'memory-tidy',
  'agent-maker': 'agent-maker',
}

/** `ReviewStandard` 内嵌的那个老字段（动作白名单一度与判断依据合体存在标准里；能力已退场）。 */
const LEGACY_STANDARD_KEYS = ['allowedActions'] as const

export interface StrippedLegacyFields {
  /** 摘干净之后的记录（**新对象**，原对象不动）。 */
  next: Record<string, unknown>
  /** 这次摘掉了哪些键（供日志与测试断言；空的表示本来就没有）。 */
  removed: string[]
}

/**
 * 把一条 agent 记录里的老字段摘掉。
 *
 * 用法（读时兜底就是这一行）：
 *
 * ```ts
 * const { next } = stripLegacyAgentFields(raw)
 * ```
 *
 * ⚠️ 它**只删键**，不补默认值、不改别的字段——"清理"最怕顺手做别的事，那样
 *    下一次就得先读懂它才能信任它。
 *
 * ⚠️ `reviewStandard` 只摘 `allowedActions`，**没有正文时不删整个键**：正文是
 *    在用的字段（判断依据），而这个函数不该替任何人判断"这份标准空了没"。
 */
export function stripLegacyAgentFields(record: Record<string, unknown>): StrippedLegacyFields {
  const removed: string[] = []
  const next: Record<string, unknown> = { ...record }

  /*
   * ⚠️ 顺序要紧：**先把 `role` 升格成 `builtinKind`，再统一摘 `role`**。
   *   反过来写的话 `role` 已经没了，那条内置记录就永远不知道自己是谁。
   */
  const legacyRole = next['role']
  if (
    typeof legacyRole === 'string' &&
    next['builtin'] === true &&
    next['builtinKind'] === undefined
  ) {
    const kind = BUILTIN_KIND_BY_LEGACY_ROLE[legacyRole]
    if (kind !== undefined) next['builtinKind'] = kind
  }

  for (const key of LEGACY_AGENT_KEYS) {
    if (key in next) {
      delete next[key]
      removed.push(key)
    }
  }

  const standard = next['reviewStandard']
  if (standard !== null && typeof standard === 'object' && !Array.isArray(standard)) {
    const std = { ...(standard as Record<string, unknown>) }
    let touched = false
    for (const key of LEGACY_STANDARD_KEYS) {
      if (key in std) {
        delete std[key]
        touched = true
        removed.push(`reviewStandard.${key}`)
      }
    }
    if (touched) next['reviewStandard'] = std
  }

  return { next, removed }
}

/** 这条记录身上还有没有老字段（省掉调用方的比较：没有就别写库）。 */
export function hasLegacyAgentFields(record: Record<string, unknown>): boolean {
  return stripLegacyAgentFields(record).removed.length > 0
}
/**
 * 读路径用的便捷包装：**类型不变**，只把老键摘掉（两个 store 的 `getAgent` /
 * `listAgents` 用它，所以它是"读时兜底"的落点）。
 */
export function cleanAgent<T extends object>(record: T): T {
  return stripLegacyAgentFields(record as Record<string, unknown>).next as T
}
