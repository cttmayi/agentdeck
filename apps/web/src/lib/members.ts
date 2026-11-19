import type { Agent } from './api.ts'

/**
 * ★ 2026-11（D147）：这个 agent 是不是**平台成员**（只读 / 不可删）。
 *
 * 判据与 daemon 的 `ownerOf()` **同一份口径**（`apps/daemon/src/platform-member.ts`）：
 *   · 服务端给了 `owner` ⇒ 就是它（迁移后的数据走这条）；
 *   · 老响应没有 `owner` ⇒ 按老字段推：`builtin === true` **且**岗位认得出 ⇒ 平台；
 *     岗位缺或写了个认不出的值（**半内置**）⇒ 不是平台成员（否则会把人自己的智能体
 *     锁成改不了删不掉的僵尸——这正是 D145 要消灭的那种事故）。
 *
 * ⚠️ 界面上任何"只读 / 不可删"的判断都读它，**不要**再写 `agent.builtin === true`：
 *   半内置与已下线的 `skill-reviewer` 都会判错（前者被误锁、后者被误锁成平台成员）。
 */
export function isPlatformMember(agent: Agent): boolean {
  if (agent.owner === 'platform' || agent.owner === 'user') return agent.owner === 'platform'
  if (agent.builtin !== true) return false
  if (agent.builtinKind === undefined) return false
  if (agent.builtinKind === 'skill-reviewer') return false
  return true
}

/**
 * 使用者能在新建 / 编辑智能体里勾的那三个入口（2026-11，D146）。
 *
 * ⚠️ 三项**顺序**是服务端规范化的顺序（`parseUserEntries` 也按这个次序落库），
 *   所以勾选结果显示的次序、请求发出去的次序、数据里存的次序是同一个。
 *
 * ⚠️ 平台动作入口（`action:…`）**不在这里**：那是平台自己发起的流程节点，勾上也没有
 *   任何东西会叫它。服务端见到就拒（不是静默忽略）。
 */
export const USER_ENTRY_CHOICES = ['chat', 'task', 'workflow'] as const
export type UserEntry = (typeof USER_ENTRY_CHOICES)[number]

/**
 * 每个入口的**文案键**（字面量写全，`$t()` 的入参是封闭联合类型——拼字符串拼不出来）。
 *
 * 与 `USER_ENTRY_CHOICES` 同序，两处改动要一起改：新增一个入口时，这里少写一行就是
 * 类型错误（不会静默降级成一个空标签）。
 */
export const USER_ENTRY_LABEL_KEYS: Record<
  UserEntry,
  'agents.entryChat' | 'agents.entryTask' | 'agents.entryWorkflow'
> = {
  chat: 'agents.entryChat',
  task: 'agents.entryTask',
  workflow: 'agents.entryWorkflow',
}

/**
 * 平台动作接入点的**展示名**（2026-11，D153）。
 *
 * 为什么要显示它们：`action:<id>` 这一半的接入点以前**只在服务端判据里**，界面上
 * 一个字都看不到——于是"这条平台成员到底被什么叫着"这件事只能靠猜。使用者原话：
 * 「把 entries：Action 显示出来」。
 *
 * ⚠️ 与 `USER_ENTRY_CHOICES` 不同，这几项**不可勾**（平台自己发起），所以界面把它们
 *    渲染成徽标而不是勾选框；`title` 里挂上原始值（`action:skill-draft`），机器名
 *    仍然查得到。
 * ⚠️ 键是**封闭**的：新增一个动作必须在 `apps/daemon/src/platform-actions.ts` 加一行，
 *    同时在这里加一行文案——少加一处就是类型错误（不会静默显示成空徽标）。
 */
export const ACTION_ENTRY_LABEL_KEYS: Record<
  'skill-draft' | 'memory-tidy' | 'agent-commit' | 'workflow-commit',
  | 'agents.actionSkillDraft'
  | 'agents.actionMemoryTidy'
  | 'agents.actionAgentCommit'
  | 'agents.actionWorkflowCommit'
> = {
  'skill-draft': 'agents.actionSkillDraft',
  'memory-tidy': 'agents.actionMemoryTidy',
  'agent-commit': 'agents.actionAgentCommit',
  'workflow-commit': 'agents.actionWorkflowCommit',
}

/** 一个平台成员身上的**动作接入点**（服务端给的 entries 里 `action:` 那些，保持原顺序）。 */
export function actionEntriesOf(agent: Agent): Array<{ raw: string; id: string; labelKey: string }> {
  return agentEntries(agent)
    .filter((e) => e.startsWith('action:'))
    .map((raw) => {
      const id = raw.slice('action:'.length)
      const labelKey = ACTION_ENTRY_LABEL_KEYS[id as keyof typeof ACTION_ENTRY_LABEL_KEYS]
      return {
        raw,
        id,
        // 认不出的 id（比如以后加的、这条界面还没跟上）**照样显示机器名**：
        // 少一行文案不该让"它被什么叫着"这件事在界面上消失。
        labelKey: labelKey ?? '',
      }
    })
}

/** 一个都没勾 = 哪个入口都叫不动它；界面据此禁掉「创建 / 保存」。 */
export function hasAnyEntry(picked: readonly string[]): boolean {
  return USER_ENTRY_CHOICES.some((e) => picked.includes(e))
}

/** 认得出的平台成员岗位（与 daemon 的 `PLATFORM_MEMBER_ENTRIES` 同一套键）。 */
const KNOWN_BUILTIN_KINDS = new Set([
  'drafter',
  'skill-reviewer',
  'memory-tidy',
  'agent-maker',
  'workflow-maker',
])

/**
 * ★ 2026-11（D147）：**半内置**——`builtin: true` 但岗位值缺或认不出。
 *
 * 服务端在列表接口里已经算好（`halfBuiltin`），这里只是**回退**（老 daemon / 详情接口）。
 * 它不是"平台成员"，而是一条**配置残缺的用户记录**：能改、能删，但要在界面上说出来
 * ——不然人看到一条带内置标记、又不属于任何岗位的智能体，只会以为界面坏了。
 */
export function isHalfBuiltinAgent(agent: Agent): boolean {
  if (typeof agent.halfBuiltin === 'boolean') return agent.halfBuiltin
  if (agent.owner !== undefined) return false
  if (agent.builtin !== true) return false
  if (agent.builtinKind === undefined) return true
  return !KNOWN_BUILTIN_KINDS.has(agent.builtinKind)
}

/**
 * 平台成员的**接入点**在界面侧的读法（2026-11，D145）。
 *
 * ⚠️ 为什么不在这里再存一份"哪条成员有哪些接入点"的表：那张表在 daemon
 *   （`apps/daemon/src/platform-member.ts` 的 `PLATFORM_MEMBER_ENTRIES`），界面
 *   **直接读服务端算好的 `entries`**（`GET /api/agents` 会带上）。在这里抄一份
 *   = 两处各说一半（这个仓库为这类复制栽过好几次）。
 *
 * 所以这里只做**兜底**（服务端没给 `entries` 时，比如老 daemon、或测试夹具）：
 *   · 不是平台成员 ⇒ 三项全开（用户建的智能体本来就能聊天/派活/被编排引用）；
 *   · 是平台成员但拿不到 entries ⇒ **空**（保守：宁可这一条选不到，也不要把
 *     平台成员误派成业务执行者）。
 */
export function agentEntries(agent: Agent): string[] {
  if (Array.isArray(agent.entries)) return agent.entries
  // ⚠️ 兜底口径与 `isPlatformMember` 同一份：半内置（builtin 但岗位残缺）**不是**
  //    平台成员 ⇒ 三项全开，而不是被当成平台成员变成一个谁也进不去的空配置。
  return isPlatformMember(agent) ? [] : [...USER_ENTRY_CHOICES]
}

export function hasEntry(agent: Agent, entry: 'chat' | 'task' | 'workflow'): boolean {
  return agentEntries(agent).includes(entry)
}
