/**
 * **平台成员的属性**（2026-11，D145）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不再让 `builtinKind` 单独决定一切
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者原话：「我不想用岗位这个属性来做很多不同分支，想脱离出一些单独的属性来配置。」
 * 查下来今天的痛点是：`builtin`（是不是平台的）与 `builtinKind`（是哪一条岗位）是**两个
 * 能各自变的字段**，而判据各摸一个——
 *
 *   · 只读 / 不可删 / 恢复默认 → 看 `builtin`
 *   · 派任务下拉 → 看 `builtinKind === undefined`（前端）
 *   · 当默认执行者 → 看 `builtinKindOf() !== null`
 *   · 聊天放行 → 看 `builtinKindOf()`（外加白名单）
 *
 * 于是手改一次数据（或一次写库写到一半）就能造出**半内置**：`builtin: true` 但没有
 * `builtinKind` ⇒ 改不了、删不掉，而岗位逻辑又认不出它是谁，**却被派活那侧当成普通
 * 智能体**（能被派任务、当默认、开新对话）。反过来（kind 在、标记丢）则是"可改可删的
 * 起草者"——身份能被悄悄改坏。
 *
 * ══════════════════════════════════════════════════════════════════
 * 所以拆成两个正交属性
 * ══════════════════════════════════════════════════════════════════
 *
 *   `owner`    : 'platform' | 'user'    —— 只读 / 不可删 / 启动自愈
 *   `entries`  : MemberEntry[]          —— 谁能叫它（多选）
 *
 * `builtinKind` **保留**，但它只剩一个职责：**是哪一条**（平台自己发起的流程要按它找人：
 * 起草流程找起草者、整理流程找整理者）。它不再回答"谁能叫它"，也不再被任何 UI/守卫当成
 * "能不能派活/能不能聊天"的依据。
 *
 * `owner` 与 `entries` 可以**从老字段推出来**（`ownerOf` / `entriesOf` 会回退），所以
 * 迁移只是把结果**写进数据**，不改行为、可回滚（发旧版代码即可）。
 */

import type { Agent, WorkspaceId } from '@agentdeck/protocol'
import type { Store } from '@agentdeck/domain'
import type { BuiltinKind } from './builtin-drafter.ts'
import { PLATFORM_ACTION_IDS, actionEntriesFor } from './platform-actions.ts'

/* ══════════════════════════════════════════════════════════════════
 * 值域
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 接入点（谁可以叫它）。**封闭值域**——写错就是 400，不做自由输入。
 *
 * `action:<id>` 的 `id` 与「动作注册表」一一对应。有 run 的动作直接用 **subject.type**
 * （`skill-draft` / `memory-tidy` / `agent-draft`）；纯"采纳"动作没有自己的 run，
 * 用路由名（`agent-commit` / `workflow-commit`）。
 */
export type MemberEntry = 'chat' | 'task' | 'workflow' | `action:${string}`

/**
 * 与动作注册表一一对应的 action id（封闭值域）。
 *
 * ★ 2026-11（D148）：**派生自 `PLATFORM_ACTIONS`**，不再手写一份。原来是两处各写
 *   一份（这里一份、`PLATFORM_MEMBER_ENTRIES` 里的 `action:` 一份），加一个动作时
 *   漏改一处不会报错——症状是"成员有这条动作，却谁也不许调它"。
 */
export const MEMBER_ACTION_IDS: readonly string[] = PLATFORM_ACTION_IDS
export type MemberActionId = (typeof PLATFORM_ACTION_IDS)[number]

/** 三个"非动作"接入点。 */
export const MEMBER_PLAIN_ENTRIES = ['chat', 'task', 'workflow'] as const

/** 普通智能体（`owner = 'user'`）的默认接入点：三项全开。 */
export const USER_ENTRIES: readonly MemberEntry[] = ['chat', 'task', 'workflow']

/** 一条 `entries` 值是否合法（`owner` 那边的值域由类型管，这里只管运行时收进来的东西）。 */
export function isMemberEntry(value: unknown): value is MemberEntry {
  if (typeof value !== 'string') return false
  if ((MEMBER_PLAIN_ENTRIES as readonly string[]).includes(value)) return true
  if (!value.startsWith('action:')) return false
  return (MEMBER_ACTION_IDS as readonly string[]).includes(value.slice('action:'.length))
}

/* ══════════════════════════════════════════════════════════════════
 * 界面可配的那三个接入点（用户自己造的智能体只在这三项里挑）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 使用者能在「新建 / 编辑智能体」里勾的入口。
 *
 * ⚠️ `action:<id>` **不在这里**，而且是刻意不给：那些是**平台发起的动作**（沉淀起草、
 *    整理记忆、确认采纳…）——它们是平台代码里写死的流程节点，不是"这个智能体能被谁叫"。
 *    让使用者勾上它只会得到"勾了也永远没人叫"的配置（本仓库最常见的死接口）。
 *    服务端见到 `action:` 前缀直接拒（见 `parseUserEntries`），不是静默忽略。
 */
export const USER_ENTRY_CHOICES = MEMBER_PLAIN_ENTRIES

/**
 * 校验并规范化请求里的 `entries`（`POST /api/agents` 与 `PATCH` 共用这一处）。
 *
 * 三条口径：
 *   · **不给（`undefined` / `null`）= 三项全开**——与 `entriesOf()` 对用户记录的回退一致，
 *     所以"老客户端不带这个字段"和"新的默认值"是同一个结果，不会因为上线换行为；
 *   · **顺序与去重都规范化**（按 `chat, task, workflow` 的次序、去掉重复）——同一份配置
 *     不该因为勾选先后在数据里长得不一样；
 *   · **一个都不勾 = 400**：那样造出来的智能体在**每一个**入口里都叫不出来，等于一条
 *     谁也摸不着的记录。宁可在这里拒绝，也不要让人过几天发现"我建的智能体去哪了"。
 */
export function parseUserEntries(
  raw: unknown,
): { ok: true; value: MemberEntry[] } | { ok: false; error: string } {
  const valid = USER_ENTRY_CHOICES.join(', ')
  if (raw === undefined || raw === null) return { ok: true, value: [...USER_ENTRIES] }
  if (!Array.isArray(raw)) return { ok: false, error: `entries 必须是数组（可用的：${valid}）` }
  const picked = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') {
      return {
        ok: false,
        error: `entries 里每一项都必须是非空字符串（收到 ${JSON.stringify(item)}）`,
      }
    }
    const entry = item.trim()
    if (entry.startsWith('action:')) {
      return {
        ok: false,
        error:
          `「${entry}」是**平台动作**入口，只属于平台成员：自定义智能体只能在 ` +
          `${valid} 里选（那些动作由平台自己发起，勾上也没有任何东西会叫它）。`,
      }
    }
    if (!(USER_ENTRY_CHOICES as readonly string[]).includes(entry)) {
      return { ok: false, error: `不认识的入口：${entry}。可用的：${valid}` }
    }
    picked.add(entry)
  }
  if (picked.size === 0) {
    return {
      ok: false,
      error: `至少要有一个入口（${valid}）：一个都没有的智能体，哪个入口都叫不动它。`,
    }
  }
  return { ok: true, value: USER_ENTRY_CHOICES.filter((e) => picked.has(e)) }
}

/* ══════════════════════════════════════════════════════════════════
 * 出厂表：每条平台成员的接入点（**唯一声明处**）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 四条出厂成员各自"谁能叫它"。
 *
 * ⚠️ 这是**唯一**声明这些的地方：新增一条平台成员 = 这里加一行 + 它的指令/技能。
 *    别的地方（对账、迁移、判据、日志）都从这里读——上一轮的教训是"启动对账日志"
 *    这个清单漏过一次（D144）。
 *
 * ⚠️ 平台成员**默认不给 `task` / `workflow`**（2026-11 拍板）：起草者被派活会按
 *    "你是 skill 作者"的指令跑偏；被编排引用同理。
 */
/**
 * 每个平台成员的**非动作**接入点（`chat`；`task` / `workflow` 一个都不给）。
 *
 * `action:` 那几条**不在这里**——它们由 `actionEntriesFor()` 从动作注册表派生，
 * 见 `PLATFORM_MEMBER_ENTRIES` 下面那句。
 */
export const PLATFORM_MEMBER_PLAIN_ENTRIES: Record<BuiltinKind, readonly MemberEntry[]> = {
  drafter: [],
  'memory-tidy': [],
  // 两个生成者要能在聊天里起草，所以有 chat；起草者与整理者各走各的页面按钮。
  'agent-maker': ['chat'],
  'workflow-maker': ['chat'],
  /*
   * ★ 2026-11（D161）：**内置「助手」是唯一的例外**——它同时接 `chat` / `task` /
   *   `workflow`（使用者定："它默认是勾选『聊天』和『编排』和『任务』的，同时它也是
   *   默认智能体"）。它是"默认那个干活的人"，所以这三项都该有；其余平台成员仍然
   *   只有它们自己那一件事。
   */
  assistant: ['chat', 'task', 'workflow'],
  /*
   * 已下线（沉淀线的评审整条退场）：**没有任何接入点**——谁也进不去。
   * 它的归属见 `ownerOf()`：这一类按 `user` 处理（可删、可改），因为默认身份已经删了、
   * 没有任何链路在用它，把它当"用户的旧记录"最省事（删除路由今天也正好放行它）。
   */
  'skill-reviewer': [],
}

function memberEntries(kind: BuiltinKind): readonly MemberEntry[] {
  return [...PLATFORM_MEMBER_PLAIN_ENTRIES[kind], ...actionEntriesFor(kind)]
}

/**
 * 四条出厂成员各自"谁能叫它"——**派生出的结果**（普通入口 + 注册表里的动作）。
 *
 * ⚠️ 新增一条平台成员 = 注册表里加一行动作（若它有动作）+ 上面那张普通入口表加一行；
 *    别的地方（对账、迁移、判据、日志）都从这里读——上一轮的教训是"启动对账日志"
 *    这个清单漏过一次（D144）。
 *
 * ⚠️ 平台成员**默认不给 `task` / `workflow`**（2026-11 拍板）：起草者被派活会按
 *    "你是 skill 作者"的指令跑偏；被编排引用同理。
 */
export const PLATFORM_MEMBER_ENTRIES: Record<BuiltinKind, readonly MemberEntry[]> = {
  assistant: memberEntries('assistant'),
  drafter: memberEntries('drafter'),
  'memory-tidy': memberEntries('memory-tidy'),
  'agent-maker': memberEntries('agent-maker'),
  'workflow-maker': memberEntries('workflow-maker'),
  'skill-reviewer': memberEntries('skill-reviewer'),
}

/* ══════════════════════════════════════════════════════════════════
 * 派生判据（**老字段回退**：迁移没跑也不会错）
 * ══════════════════════════════════════════════════════════════════ */

/** 归属：平台 / 用户。这是"能不能改 / 能不能删"的**唯一**判据。 */
export function ownerOf(agent: Pick<Agent, 'owner' | 'builtin' | 'builtinKind'>): 'platform' | 'user' {
  if (agent.owner === 'platform' || agent.owner === 'user') return agent.owner
  /*
   * 回退（老数据，或迁移还没跑）：`builtin === true` 且**岗位值也在** ⇒ 平台成员。
   * ⚠️ "岗位值缺"那一档（半内置）**不**当平台成员：它不是任何一条已声明的成员，
   *    按用户记录处理，界面会标"配置损坏"（见 `isHalfBuiltin`），绝不会被静默锁成
   *    一个改不了删不掉的僵尸。
   */
  if (agent.builtin !== true) return 'user'
  if (agent.builtinKind === undefined) return 'user'
  if (agent.builtinKind === 'skill-reviewer') return 'user'
  return 'platform'
}

/**
 * 一条记录是不是"半内置"（老字段残缺）：`builtin: true` 但岗位值缺或认不出。
 *
 * 只用于**报出来**（启动日志 + 界面提示），不参与任何放行/拒绝判据——这正是上半句
 * "按用户记录处理"的意思：它能被修、也能被删，但平台会明确告诉人"这条配置是坏的"。
 */
export function isHalfBuiltin(agent: Pick<Agent, 'owner' | 'builtin' | 'builtinKind'>): boolean {
  if (agent.owner !== undefined) return false
  if (agent.builtin !== true) return false
  const kind = agent.builtinKind
  if (kind === undefined) return true
  return !(kind in PLATFORM_MEMBER_ENTRIES)
}

/** 接入点。平台成员按出厂表；用户记录按"三项全开"。 */
export function entriesOf(
  agent: Pick<Agent, 'owner' | 'entries' | 'builtin' | 'builtinKind'>,
): MemberEntry[] {
  if (Array.isArray(agent.entries)) return agent.entries.filter(isMemberEntry)
  const owner = ownerOf(agent)
  if (owner === 'user') return [...USER_ENTRIES]
  const kind = agent.builtinKind
  if (kind !== undefined && kind in PLATFORM_MEMBER_ENTRIES) {
    return [...PLATFORM_MEMBER_ENTRIES[kind]]
  }
  return []
}

export function hasEntry(
  agent: Pick<Agent, 'owner' | 'entries' | 'builtin' | 'builtinKind'>,
  entry: MemberEntry,
): boolean {
  return entriesOf(agent).includes(entry)
}

/** 能不能当**对话执行者**。 */
export const canChat = (agent: Parameters<typeof hasEntry>[0]): boolean => hasEntry(agent, 'chat')

/**
 * 能不能**派业务任务 / 当默认执行者 / 出现在新建任务下拉**。
 *
 * ⚠️ 这是"能不能派活"的**唯一**判据：接口层（`POST /api/runs`、`POST /api/issues`、
 *    设默认）与界面下拉都读它——今天这三处各摸一个字段、判据还不一致，是"半内置"
 *    能钻过去的原因。
 */
export const canBeDispatched = (agent: Parameters<typeof hasEntry>[0]): boolean =>
  hasEntry(agent, 'task')

/** 能不能被**编排**引用（候选名单与引擎解析**两处**都读它）。 */
export const canBeReferencedByWorkflow = (agent: Parameters<typeof hasEntry>[0]): boolean =>
  hasEntry(agent, 'workflow')

/** 某个平台动作能不能叫它。 */
export const canBeCalledByAction = (
  agent: Parameters<typeof hasEntry>[0],
  action: MemberActionId,
): boolean => hasEntry(agent, `action:${action}`)

/* ══════════════════════════════════════════════════════════════════
 * 迁移（幂等：只补缺的；不删老字段）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 把老字段的推导结果**写进数据**（`owner` + `entries`）。
 *
 * 三条口径：
 *   · **只补缺的**：已经有 `owner` 的一律不动（那是迁移过的，或是用户后来改的）；
 *   · **不删老字段**：`builtin` / `builtinKind` 留着（回滚只需发旧版代码）；
 *   · **半内置不猜**：`builtin: true` 但岗位缺/未知 ⇒ 写成 `owner: 'user'` + 全开 entries
 *     （= 它可以被修、被删），并在返回值里**点名**让人知道有一条配置是坏的。
 */
export async function migratePlatformMemberFields(
  store: Store,
  workspaceId: WorkspaceId,
): Promise<{ migrated: string[]; halfBuiltin: string[] }> {
  const all = await store.listAgents(workspaceId)
  const migrated: string[] = []
  const halfBuiltin: string[] = []
  for (const agent of all) {
    if (agent.owner !== undefined) continue
    const half = isHalfBuiltin(agent)
    const owner = ownerOf(agent)
    const entries = entriesOf(agent)
    await store.insertAgent({ ...agent, owner, entries, updatedAt: Date.now() })
    migrated.push(agent.name as string)
    if (half) halfBuiltin.push(agent.name as string)
  }
  return { migrated, halfBuiltin }
}

/* ══════════════════════════════════════════════════════════════════
 * 上线前的体检：现有编排里有没有引用"不能被编排引用"的人
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 扫一遍现有编排代码，找出**引用了平台成员**的那些（返回 `编排名 → [名字]` 的可读串）。
 *
 * 为什么要它：`canBeReferencedByWorkflow` 是这一轮**新加**的守卫，而改之前引擎解析是
 * 全量名单——升级当天老编排里很可能已经引用了起草者/编排生成者，那样它会**在运行时
 * 被拒**。启动时报出来（只报不改），比让人跑到一半撞墙便宜得多。
 *
 * ⚠️ 只认 `agent('字面量')`；拼出来的（`agent(变量)`）数不清，这里**不猜**（那几个在
 *    采纳校验里也落 `unverifiable`，同一套口径）。
 */
export async function platformMemberRefsInWorkflows(
  store: Store,
  workspaceId: WorkspaceId,
  workflows: ReadonlyArray<{ name: string; code: string }>,
): Promise<string[]> {
  if (workflows.length === 0) return []
  const agents = await store.listAgents(workspaceId)
  const byName = new Map(agents.map((a) => [a.name as string, a]))
  const out: string[] = []
  for (const wf of workflows) {
    const hits = new Set<string>()
    for (const m of wf.code.matchAll(/agent\s*\(\s*(['"])([^'"]*)\1/g)) {
      const name = (m[2] ?? '').trim()
      if (name === '') continue
      const agent = byName.get(name)
      if (agent && !canBeReferencedByWorkflow(agent)) hits.add(name)
    }
    if (hits.size > 0) out.push(`${wf.name}（${[...hits].join('、')}）`)
  }
  return out
}

/* ══════════════════════════════════════════════════════════════════
 * 采纳前的校验名单（与引擎同一句判据，避免"校验说行、跑起来必炸"）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 编排代码里可以出现的**智能体名字**（交给 `validateWorkflowCode` 的那一份）。
 *
 * ⚠️ 与引擎解析用同一句判据（`canBeReferencedByWorkflow`）——两处不一致的后果是
 * "校验通过、运行时被拒"，而那时已经烧了一条 run。
 */
export function workflowReferenceableNames(
  agents: ReadonlyArray<Pick<Agent, 'owner' | 'entries' | 'builtin' | 'builtinKind' | 'name'>>,
): string[] {
  return agents.filter(canBeReferencedByWorkflow).map((a) => a.name as string)
}
