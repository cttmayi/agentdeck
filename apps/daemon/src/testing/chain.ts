import type { AgentGroup } from '@agentdeck/protocol'
import type { FixtureDaemon } from './tool-fixture.ts'

/**
 * 建一个「执行者 + 审核者」的智能体组（2026-10 的测试共用助手）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么测试里到处都要它了
 * ══════════════════════════════════════════════════════════════════
 *
 * 在此之前，测试把"这条链怎么跑"直接写在两个 agent 上：
 *
 *   · `PATCH /api/agents/<执行者>` 带 `reviewerAgentId` ⇒ 执行完自动审；
 *   · `POST /api/agents` 带 `allowedActions` ⇒ 判决允许触发哪些动作。
 *
 * 2026-10 起这两个字段都**从 `Agent` 上撤掉了**：
 *
 *   · "谁审谁"与"判完允许动什么"的唯一出处是**组**（`AgentGroup`）；
 *   · 建任务时带 `groupId`，组把审核者与动作白名单**展开进这条 run**；
 *   · run 上那几个同名字段仍然存在（它们是载体），所以链路本身一字未变。
 *
 * 于是每个"我要一条能自动审、并且判完能动手的链"的用例，都得先建组。这件事
 * 三步（建执行者、建审核者、建组）在十几个文件里重复，**各写一遍必然有地方漏**
 * ——而漏掉的表现是"不派生审核 run"，症状是**超时**（看起来像 daemon 卡住，
 * 其实一切正常）。所以收在这里。
 *
 * ⚠️ 组必须**形态合法**：恰好 1 执行 + 1 审核（`checkGroupShape`）。写错成员
 *    会 400，而错误信息会说清是几个执行者、缺谁。
 */
export interface ChainGroupSpec {
  /** 组名（默认够用就行；同一用例里建多个组时给不同的名字便于排查）。 */
  name?: string | undefined
  /** `[执行者 id, 审核者 id]`——顺序无关（形态校验按角色认人）。 */
  members: [string, string]
  /**
   * 允许触发的动作（`<包 slug>.<动作名>`）。
   *
   * 缺省 `[]` = 一个都不许（与播种默认值一致）：判决只能给结论。
   */
  allowedActions?: readonly string[] | undefined
  /** 动作的固定参数（`动作 → 参数 → 值`）。 */
  actionParams?: Record<string, Record<string, unknown>> | undefined
  /** 「调试」标记（不真跑、只记录）；必须是 `allowedActions` 的子集。 */
  debugActions?: readonly string[] | undefined
  /** 允许返工几次。 */
  maxReworks?: number | undefined
  /** 停用（用于测"停用的组不能被选"）。 */
  enabled?: boolean | undefined
}

/** 建组并返回**整条组记录**（要只拿 id 的话用 `createChainGroup`）。 */
export async function createChainGroupFull(
  d: FixtureDaemon,
  spec: ChainGroupSpec,
): Promise<AgentGroup> {
  const res = await fetch(`${d.url}/api/agent-groups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: spec.name ?? '测试组',
      members: spec.members,
      allowedActions: [...(spec.allowedActions ?? [])],
      ...(spec.actionParams === undefined ? {} : { actionParams: spec.actionParams }),
      debugActions: [...(spec.debugActions ?? [])],
      ...(spec.maxReworks === undefined ? {} : { maxReworks: spec.maxReworks }),
      ...(spec.enabled === undefined ? {} : { enabled: spec.enabled }),
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`建组应当成功，实际 ${res.status}：${text.slice(0, 400)}`)
  }
  return ((JSON.parse(text) as { group: AgentGroup }).group)
}

/** 建组并只返回 id（提交 run 时带 `groupId` 用的就是它）。 */
export async function createChainGroup(
  d: FixtureDaemon,
  spec: ChainGroupSpec,
): Promise<AgentGroup['id']> {
  return (await createChainGroupFull(d, spec)).id
}