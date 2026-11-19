/**
 * **平台槽位表**（2026-11，D154）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它替掉了什么
 * ══════════════════════════════════════════════════════════════════
 *
 * 原来"平台那四条记录是哪四条"记在**记录自己身上**（`Agent.builtin` + `builtinKind`），
 * 于是有两份职责混在一个字段里：
 *
 *   · "这条是不是平台的" —— 已经归 `owner`（D145）；
 *   · "它是哪一条" —— 就是这里这张表。
 *
 * 把后者挪到工作区上的好处是**"半内置"在数据形态上不可能出现**：记录上只剩
 * `owner` + `entries`，没有一个"写坏一半还能被认出来"的标记。缺一个槽位就是
 * "那一条还没被认领"，对账建一条新的并把 id 写回这里。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条纪律
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **表是"引用"，不是"授权"**：它只说"平台那条起草者是这个 id"。
 *    能不能改/删看 `owner`，能不能被谁叫看 `entries`——这张表一个能力判断都不做。
 *    把判据塞进来就又变回"岗位兼职能力开关"（D145/D152 才刚拆完）。
 * ② **表里可以指向一条已经不存在的记录**（被手删了）。所有读法都要能处理
 *    "认领了但记录没了"这一档：`resolveSlot()` 返回 null，由调用方决定补建。
 * ③ **认表失败就回退老字段**：老工作区没有这张表，`resolveSlot()` 会按
 *    `builtin` + `builtinKind` 找（那是升级当天的唯一线索），找到之后对账会把 id
 *    写进表——下一轮就走表了。
 */

import type { Agent, WorkspaceId } from '@agentdeck/protocol'
import type { Store } from '@agentdeck/domain'
import type { BuiltinKind } from './builtin-drafter.ts'
import { ownerOf } from './platform-member.ts'

/**
 * 四个"活的"槽位。
 *
 * ⚠️ 退役的 `skill-reviewer` **不在**这里：那条流程整条退场（D125），老记录归用户
 *    （可删），没有槽位可认领——也就不该有"平台还认它"的错觉。
 */
export const PLATFORM_SLOTS = ['assistant', 'drafter', 'memory-tidy', 'agent-maker', 'workflow-maker'] as const
export type PlatformSlot = (typeof PLATFORM_SLOTS)[number]

/** 槽位 → agentId。缺 = 那条还没被认领（或工作区是老的、还没跑过对账）。 */
export type SlotTable = Partial<Record<PlatformSlot, string>>

/** 运行时的值域校验（表是 `z.record(z.string())`，键在协议层是开放的）。 */
export function isPlatformSlot(value: string): value is PlatformSlot {
  return (PLATFORM_SLOTS as readonly string[]).includes(value)
}

/** 从协议里的原始 record 收窄成 `SlotTable`（丢掉不认识的键——它们不会生效）。 */
export function toSlotTable(raw: Record<string, string> | undefined): SlotTable {
  const table: SlotTable = {}
  if (raw === undefined) return table
  for (const [key, value] of Object.entries(raw)) {
    if (isPlatformSlot(key) && typeof value === 'string' && value !== '') table[key] = value
  }
  return table
}

/** 读表（工作区上没有这个键 ⇒ 空表，不抛）。 */
export async function loadSlotTable(store: Store, workspaceId: WorkspaceId): Promise<SlotTable> {
  const workspace = await store.getWorkspace(workspaceId)
  return toSlotTable(workspace?.platformSlots as Record<string, string> | undefined)
}

/**
 * 写表（**只覆盖 `platformSlots` 这一个键**，其余设置原样保留）。
 *
 * ⚠️ 工作区不存在时**抛**，不静默跳过：槽位表挂在工作区上，写不进去就等于"平台那四条
 *    记录下一轮又认不出来" ⇒ 每次启动多建一条（这条故障本仓库踩过，症状是"列表里
 *    又多了个起草者"，很难联想到工作区没建）。
 *    工作区由 daemon 的引导流程保证存在（`startDaemon`）；测试要自己造一个
 *    （`testing/test-workspace.ts`）。
 */
export async function saveSlotTable(
  store: Store,
  workspaceId: WorkspaceId,
  table: SlotTable,
): Promise<void> {
  const workspace = await store.getWorkspace(workspaceId)
  if (workspace === null) {
    throw new Error(
      `槽位表无处可存：工作区 ${String(workspaceId)} 不存在。` +
        '（槽位表挂在工作区上；老工作区请先跑一次引导，测试请用 testing/test-workspace.ts）',
    )
  }
  await store.insertWorkspace({ ...workspace, platformSlots: { ...table }, updatedAt: Date.now() })
}

/** 反查：这条 agent 占了哪个槽位（不是平台成员 ⇒ null）。 */
export function slotOfAgent(table: SlotTable, agentId: string): PlatformSlot | null {
  for (const slot of PLATFORM_SLOTS) {
    if (table[slot] === agentId) return slot
  }
  return null
}

/**
 * 解析一个槽位现在是哪条记录（**读表**；表里没有就回退老字段）。
 *
 * 返回 `null` 有三种情况，调用方的处理是一样的（补建一条并写回表）：
 *   · 表里没这个槽位（新工作区 / 还没跑过对账 / 那条被 detach 掉了）；
 *   · 表里有 id，但记录已经不在了（被手删）；
 *   · 表里有 id，但那条记录已经不是平台成员了（被改过归属）。
 *
 * ⚠️ 回退分支只在"表里没有这个槽位"时走：表里明确指向某条记录、而它不合格时**不**
 *    再去扫老字段，否则会出现"表说 A、老字段说 B"两条记录同时被认领的混乱。
 */
export async function resolveSlot(
  store: Store,
  workspaceId: WorkspaceId,
  table: SlotTable,
  slot: PlatformSlot,
): Promise<Agent | null> {
  const claimed = table[slot]
  if (claimed !== undefined) {
    const agent = await store.getAgent(claimed as Agent['id'])
    if (agent === null) return null
    return ownerOf(agent) === 'platform' ? agent : null
  }
  // 老工作区：按 `builtin` + `builtinKind` 找（升级当天的唯一线索）
  const all = await store.listAgents(workspaceId)
  return all.find((a) => legacySlotOf(a) === slot && ownerOf(a) === 'platform') ?? null
}

/**
 * 老字段里的岗位值（**只给升级路径用**）。
 *
 * ⚠️ 新记录没有 `builtinKind`，所以这个函数只会对老数据有返回值。写业务判据时**不要**
 *    用它——要问"谁是我的起草者"就问 `resolveSlot()`（表），不要问记录。
 */
export function legacySlotOf(agent: Pick<Agent, 'builtin' | 'builtinKind'>): PlatformSlot | null {
  if (agent.builtin !== true) return null
  const kind = agent.builtinKind
  if (kind === undefined) return null
  return isPlatformSlot(kind) ? kind : null
}

/**
 * 把一个槽位指向某条记录（表会被**原地改**，调用方负责 `saveSlotTable`）。
 */
export function claimSlot(table: SlotTable, slot: PlatformSlot, agentId: string): void {
  table[slot] = agentId
}

/**
 * 让出一个槽位（detach 用：把这条记录从平台的引用里摘掉）。
 *
 * ⚠️ 只摘 id，**不动记录**——"它变成你的"那三件事（`owner` / `entries` / 老字段）
 *    由 `member-detach.ts` 一次写完。
 */
export function releaseSlot(table: SlotTable, agentId: string): PlatformSlot | null {
  const slot = slotOfAgent(table, agentId)
  if (slot !== null) delete table[slot]
  return slot
}

/**
 * ★ 2026-11（D155）：把**平台成员的接入点对齐到注册表**（平台声明，不是使用者配置）。
 *
 * 为什么需要：`entries` 在数据里存了一份，而它其实是**注册表派生的**（哪条动作归谁）。
 * 注册表一变（比如删掉死接口 `agent-draft`），老记录里那一份就过期了——界面会继续显示
 * 一条"没人认的动作"徽标，而新记录没有，同一页两种样子。
 *
 * ⚠️ 只动**平台成员**（槽位表里那些）；用户智能体的 `entries` 是使用者勾的，一个字都不碰。
 *
 * 返回被对齐的名字（给启动日志用；没变就是空数组）。
 */
export async function alignMemberEntries(
  store: Store,
  workspaceId: WorkspaceId,
  table: SlotTable,
  expected: (slot: PlatformSlot) => readonly string[],
): Promise<string[]> {
  const changed: string[] = []
  for (const slot of PLATFORM_SLOTS) {
    const agentId = table[slot]
    if (agentId === undefined) continue
    const agent = await store.getAgent(agentId as Agent['id'])
    if (agent === null || ownerOf(agent) !== 'platform') continue
    const want = [...expected(slot)]
    const have = Array.isArray(agent.entries) ? agent.entries : []
    if (want.length === have.length && want.every((e, i) => e === have[i])) continue
    await store.insertAgent({ ...agent, entries: want, updatedAt: Date.now() })
    changed.push(agent.name as string)
  }
  return changed
}

/**
 * 取一个槽位现在的记录（表 + 老字段兜底，见 `resolveSlot`）。
 *
 * ⚠️ 这是**异步**的（要读工作区与 agent），与老的那个同步 `findBuiltinAgent(agents, kind)`
 *    不同：槽位表不在 agent 列表里，所以"认人"这件事必须经过一次读。
 *    调用点都是本来就要读库的地方（启动对账 / 起 run 前 / 播种技能前），不会多一次往返。
 */
export async function platformMemberOf(
  store: Store,
  workspaceId: WorkspaceId,
  slot: PlatformSlot,
): Promise<Agent | null> {
  const table = await loadSlotTable(store, workspaceId)
  return await resolveSlot(store, workspaceId, table, slot)
}

/**
 * `builtinKindOf()` 的替代：先从表里反查，老数据才看记录上的老字段。
 *
 * 存在的理由：有些地方拿到一条记录**只想知道"它是不是某一条平台成员"**（展示、
 * 描述文案、几个只读错误信息），并不需要那条记录本身。
 */
export async function slotOf(
  store: Store,
  workspaceId: WorkspaceId,
  agent: Pick<Agent, 'id' | 'builtin' | 'builtinKind'>,
): Promise<PlatformSlot | null> {
  const table = await loadSlotTable(store, workspaceId)
  const fromTable = slotOfAgent(table, agent.id as string)
  if (fromTable !== null) return fromTable
  return legacySlotOf(agent)
}

/** 给界面/日志的一句中文件名（"沉淀起草者" 这种），未知槽位给通用说法。 */
export const SLOT_LABELS: Record<PlatformSlot, string> = {
  assistant: '助手',
  drafter: '沉淀起草者',
  'memory-tidy': '记忆整理者',
  'agent-maker': '智能体生成者',
  'workflow-maker': '编排生成者',
}

/** `BuiltinKind` → `PlatformSlot` 收窄（退役的 `skill-reviewer` 没有槽位）。 */
export function asPlatformSlot(kind: BuiltinKind): PlatformSlot | null {
  return isPlatformSlot(kind) ? kind : null
}
