import type { MemoryEntry, MemoryKind } from '@agentdeck/protocol'
import { MemoryKind as MemoryKindSchema } from '@agentdeck/protocol'
import type { MemoryEntryId } from '@agentdeck/protocol'
import { ulid } from '@agentdeck/protocol'
import type { Store } from '@agentdeck/domain'
import { rankMemory, sortMemoryForInjection } from '@agentdeck/agent-core'

/**
 * 智能体记忆（分批第 240 批）：读写这一层，以及所有**限与默认**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一层只做三件事（别的都在别处）
 * ══════════════════════════════════════════════════════════════════
 *
 *   ① **校验与上限**：正文非空、≤ 400 字、每个 agent 最多 40 条（满了**明确拒绝**，
 *      绝不自动驱逐——系统偷偷删掉它自己的记忆是绝对不能做的那种事）；
 *   ② **"改 = 新增 + 删掉旧的"**：这里没有"更新正文"这条路径，只有 `add` / `remove` /
 *      `pin`（置顶是标记，不是内容）；
 *   ③ **有效触发词**：`workspace.memoryPrefixes` 缺省时用平台默认，
 *      空数组 = 关掉这个功能（不是"每句都算"）。
 *
 * 排序（谁进第一句话、按什么顺序）**不在这里**——那是 `packages/agent-core/src/memory.ts`
 * 的 `rankMemory()`，因为它要跟第一句话的预算一起算，而且必须是纯函数（好测）。
 */

/** 平台默认的触发词。⚠️ 只认**开头**，不做语义猜测。 */
export const DEFAULT_MEMORY_PREFIXES: readonly string[] = ['记住：', '以后', '下次别']

/** 每个 agent 最多多少条**活着**的记忆。满了就拒（不驱逐）。 */
export const MEMORY_LIMIT = 40

/** 单条正文上限（它每轮都会被带进上下文，长度就是成本）。 */
export const MEMORY_TEXT_MAX = 400

/**
 * 最多几条可以置顶。
 *
 * 为什么要有这个数：★ 是"预算紧张时最后才裁它"的加权，人人都置顶等于没有加权——
 * 那时裁剪规则就退化成按类型优先级，而人还以为自己钉住了那几条。
 * 3 是"真要紧的那几条"的量级（再多就该删掉别的，而不是全钉上）。
 */
export const MEMORY_PIN_LIMIT = 3

export const MEMORY_KINDS: readonly MemoryKind[] = ['preference', 'fact', 'lesson', 'commitment']

/**
 * 这个 workspace 的**有效**触发词。缺省（老数据里没有这个键）= 平台默认；空数组 = 关。
 *
 * ⚠️ 参数是**结构化的最小形状**（只要 `memoryPrefixes`），不是整个 `Workspace`：
 *    调用方手里常常只有 `readWorkspaceSettings()` 那份投影，而它没有全部字段——
 *    逼着调用方拼一个假 Workspace 只为调这个函数是纯粹的负担。
 */
export function effectiveMemoryPrefixes(
  workspace: { memoryPrefixes?: string[] | undefined } | null,
): string[] {
  const configured = workspace?.memoryPrefixes
  if (configured === undefined) return [...DEFAULT_MEMORY_PREFIXES]
  return [...configured]
}

/**
 * 这个 agent 现在**活着**的记忆（已删除的不返回），**按注入顺序排好**。
 *
 * ⚠️ 顺序在这里定、而不是留给界面：详情页从上到下的那一列就是"预算不够时先丢下面的"，
 *    而第一句话用的是同一个函数（`sortMemoryForInjection`）。两处各排一遍必漂。
 */
export async function listActiveMemory(
  store: Store,
  workspaceId: MemoryEntry['workspaceId'],
  agentId: MemoryEntry['agentId'],
): Promise<MemoryEntry[]> {
  const all = await store.listMemoryEntries(workspaceId, agentId)
  return sortMemoryForInjection(all.filter((entry) => entry.removedAt === null))
}

export type MemoryWriteError =
  | 'text_empty'
  | 'text_too_long'
  | 'kind_invalid'
  | 'limit_reached'
  | 'pin_limit'
  | 'looks_like_secret'
  | 'entry_not_found'

export type MemoryWriteResult =
  | { ok: true; entry: MemoryEntry }
  | { ok: false; code: MemoryWriteError; error: string }

export interface AddMemoryInput {
  workspaceId: MemoryEntry['workspaceId']
  agentId: MemoryEntry['agentId']
  kind: unknown
  text: unknown
  /** 出处（哪条 run）——聊天里记下的带，手写的不带。 */
  evidence?: string | undefined
  pinned?: boolean | undefined
  /** 测试缝：id 与时间。 */
  newId?: () => string
  now?: () => number
}

function parseKind(kind: unknown): MemoryKind | null {
  const parsed = MemoryKindSchema.safeParse(kind)
  return parsed.success ? parsed.data : null
}

function normalizeText(text: unknown): { ok: true; text: string } | { ok: false; code: MemoryWriteError; error: string } {
  if (typeof text !== 'string') {
    return { ok: false, code: 'text_empty', error: '记忆正文必须是字符串' }
  }
  const trimmed = text.trim()
  if (trimmed === '') {
    return { ok: false, code: 'text_empty', error: '记忆正文不能为空' }
  }
  if (trimmed.length > MEMORY_TEXT_MAX) {
    return {
      ok: false,
      code: 'text_too_long',
      error: `记忆正文最多 ${MEMORY_TEXT_MAX} 字（现在是 ${trimmed.length} 字）——它每一轮都会被带进上下文`,
    }
  }
  return { ok: true, text: trimmed }
}

/**
 * 加一条。
 *
 * ⚠️ 上限按**活着**的条数算（删掉的不占名额）。满了返回 `limit_reached` 而不是
 *    驱逐最旧的那条：让机器悄悄遗忘，人不会知道它什么时候忘的。
 */
export async function addMemoryEntry(store: Store, input: AddMemoryInput): Promise<MemoryWriteResult> {
  const kind = parseKind(input.kind)
  if (kind === null) {
    return { ok: false, code: 'kind_invalid', error: `记忆类型必须是 ${MEMORY_KINDS.join(' / ')}` }
  }
  const text = normalizeText(input.text)
  if (!text.ok) return { ok: false, code: text.code, error: text.error }
  /**
   * ★ 分批第 241 批：**看起来像密钥的正文直接拒**（记忆每轮都会被发到 CLI）。
   *   要记"用哪个 token"就写**变量名**（`$GITHUB_TOKEN`），别写值。
   */
  const secret = looksLikeSecret(text.text)
  if (secret !== null) {
    return {
      ok: false,
      code: 'looks_like_secret',
      error:
        `这段像是${secret}，没有存进来——记忆每一轮都会被带进上下文发给 CLI。` +
        `要记住"用哪个凭据"就写变量名（比如 $GITHUB_TOKEN），不要写它的值。`,
    }
  }

  const active = await listActiveMemory(store, input.workspaceId, input.agentId)
  if (active.length >= MEMORY_LIMIT) {
    return {
      ok: false,
      code: 'limit_reached',
      error:
        `这个智能体的记忆满了（${MEMORY_LIMIT} 条）。记忆不会自动淘汰——` +
        `先在它的「记忆」里删掉几条不要的，再加新的。`,
    }
  }

  const now = (input.now ?? Date.now)()
  const entry: MemoryEntry = {
    id: ((input.newId ?? ulid)() as MemoryEntryId),
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    kind,
    text: text.text,
    ...(input.evidence === undefined || input.evidence === '' ? {} : { evidence: input.evidence }),
    pinned: input.pinned === true,
    useCount: 0,
    lastUsedAt: null,
    createdAt: now,
    removedAt: null,
  }
  await store.insertMemoryEntry(entry)
  return { ok: true, entry }
}

/**
 * 删一条 = **打时间戳**（不真删）。
 *
 * 幂等：已经删过的再删一次返回 `ok: true` + `alreadyRemoved: true`——"它已经不在了"
 * 与"删失败"是两件事，调用方（尤其是界面上的「撤销」）要分得清。
 */
export async function removeMemoryEntry(
  store: Store,
  input: {
    workspaceId: MemoryEntry['workspaceId']
    agentId: MemoryEntry['agentId']
    entryId: string
    now?: () => number
  },
): Promise<{ ok: true; alreadyRemoved: boolean } | { ok: false; code: 'entry_not_found'; error: string }> {
  const all = await store.listMemoryEntries(input.workspaceId, input.agentId)
  const found = all.find((entry) => (entry.id as string) === input.entryId)
  if (found === undefined) {
    return { ok: false, code: 'entry_not_found', error: `没有这条记忆：${input.entryId}` }
  }
  if (found.removedAt !== null) return { ok: true, alreadyRemoved: true }
  await store.updateMemoryEntry({ ...found, removedAt: (input.now ?? Date.now)() })
  return { ok: true, alreadyRemoved: false }
}

/**
 * 置顶开关（★ = 预算紧张时最后才裁它）。
 *
 * ⚠️ 最多 `MEMORY_PIN_LIMIT` 条：全都能置顶等于没有加权。超出时**明确拒绝**
 *    并说清"已经钉了几条"，而不是悄悄把最旧的那条取消置顶。
 */
export async function setMemoryPinned(
  store: Store,
  input: {
    workspaceId: MemoryEntry['workspaceId']
    agentId: MemoryEntry['agentId']
    entryId: string
    pinned: boolean
  },
): Promise<
  | { ok: true; entry: MemoryEntry }
  | { ok: false; code: 'entry_not_found' | 'pin_limit'; error: string }
> {
  const all = await store.listMemoryEntries(input.workspaceId, input.agentId)
  const found = all.find((entry) => (entry.id as string) === input.entryId)
  if (found === undefined || found.removedAt !== null) {
    return { ok: false, code: 'entry_not_found', error: `没有这条记忆：${input.entryId}` }
  }
  if (input.pinned && found.pinned !== true) {
    const pinnedNow = all.filter((e) => e.removedAt === null && e.pinned === true).length
    if (pinnedNow >= MEMORY_PIN_LIMIT) {
      return {
        ok: false,
        code: 'pin_limit',
        error:
          `最多置顶 ${MEMORY_PIN_LIMIT} 条（现在已经有 ${pinnedNow} 条）——` +
          `★ 的意思是"预算紧张时最后才裁它"，全都钉上等于没钉。先取消一条再钉。`,
      }
    }
  }
  const next = { ...found, pinned: input.pinned }
  await store.updateMemoryEntry(next)
  return { ok: true, entry: next }
}

/** 详情页保存时提交的差量。**只有加 / 删 / 置顶三种动作**——没有"改正文"。 */
export interface MemoryDelta {
  add?: Array<{ kind: unknown; text: unknown; pinned?: unknown }>
  remove?: string[]
  pin?: Array<{ id: string; pinned: unknown }>
}

export type MemoryDeltaResult =
  | { ok: true; added: MemoryEntry[]; removed: string[]; pinned: string[] }
  | { ok: false; code: MemoryWriteError; error: string }

/**
 * 应用一次差量（详情页的「保存」）。
 *
 * 顺序是**先加、再置顶、后删**：这样"改"（= 新增一条 + 删掉旧的）在**同一个 id 空间**
 * 里不会互相踩。上限检查只看加那一步。
 */
export async function applyMemoryDelta(
  store: Store,
  input: {
    workspaceId: MemoryEntry['workspaceId']
    agentId: MemoryEntry['agentId']
    delta: MemoryDelta
    newId?: () => string
    now?: () => number
  },
): Promise<MemoryDeltaResult> {
  const added: MemoryEntry[] = []
  for (const item of input.delta.add ?? []) {
    const result = await addMemoryEntry(store, {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      kind: item.kind,
      text: item.text,
      ...(item.pinned === true ? { pinned: true } : {}),
      ...(input.newId ? { newId: input.newId } : {}),
      ...(input.now ? { now: input.now } : {}),
    })
    if (!result.ok) {
      // 已经加进去的那几条**不回滚**：这是流式的"逐条如实"，
      // 报错里说清停在第几条，界面上那一份草稿还在（人改一改再存）。
      return {
        ok: false,
        code: result.code,
        error:
          added.length === 0
            ? result.error
            : `第 ${added.length + 1} 条${result.error}（前面 ${added.length} 条已经存下了）`,
      }
    }
    added.push(result.entry)
  }

  const pinned: string[] = []
  for (const item of input.delta.pin ?? []) {
    const result = await setMemoryPinned(store, {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      entryId: item.id,
      pinned: item.pinned === true,
    })
    if (!result.ok) {
      /**
       * ⚠️ 两种失败要分开：
       *   · `entry_not_found`（另一端刚删了）——**跳过**，别让整次保存失败；
       *   · `pin_limit`（钉太多了）——是使用者刚做的那个动作被拒，必须**说出来**，
       *     否则界面上那个 ★ 会亮着而库里没钉上（"看起来生效了"）。
       */
      if (result.code === 'pin_limit') {
        return { ok: false, code: 'pin_limit', error: result.error }
      }
      continue
    }
    pinned.push(item.id)
  }

  const removed: string[] = []
  for (const id of input.delta.remove ?? []) {
    const result = await removeMemoryEntry(store, {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      entryId: id,
      ...(input.now ? { now: input.now } : {}),
    })
    if (result.ok) removed.push(id)
  }

  return { ok: true, added, removed, pinned }
}

/**
 * 这一轮**真的会带进第一句话**的那几条（用来记账：`useCount` / `lastUsedAt`）。
 *
 * ⚠️ 它与 `buildBlocks` 里算的是**同一个纯函数、同一份默认预算**——所以"钉的两边
 *    一致"不是靠约定，而是靠同一次调用形状。将来若允许自定义预算，两处必须一起传
 *    （那时这个函数要多一个参数，注释在这里提醒）。
 */
export function pickedMemoryFor<T extends MemoryEntry>(entries: readonly T[]): T[] {
  return rankMemory(entries).picked
}

/**
 * 记一次"被用上了"：`useCount + 1`、`lastUsedAt = now`。
 *
 * 这是"这条记忆到底有没有用"的唯一证据，也是"久不用的自然沉底"的依据
 * ——所以它必须在**投递之后**写（投递失败就不该记成用过）。
 * 记账失败不打断 run（它只是统计，不是这次 run 的一部分）。
 */
export async function recordMemoryUse(
  store: Store,
  entries: readonly MemoryEntry[],
  now: () => number = Date.now,
): Promise<void> {
  const at = now()
  for (const entry of entries) {
    try {
      await store.updateMemoryEntry({
        ...entry,
        useCount: entry.useCount + 1,
        lastUsedAt: at,
      })
    } catch {
      // 统计写不进去不影响这一轮：它是给人看"有没有用"的，不是 run 的一部分
    }
  }
}

/**
 * 看起来像密钥的东西 ⇒ **拒绝写入**（分批第 241 批补：设计里那句"宁可拒绝，也不要把
 * 密钥摘进记忆"）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这条检查必须在**写入口**，而不是在界面上
 * ══════════════════════════════════════════════════════════════════
 *
 * 记忆会被原样带进第一句话、发到 CLI（也就是模型提供方）。而人在聊天里说一句
 * "记住：部署时用 `ghp_xxx…` 这个 token" 是**很自然**的事——那一刻没有人会想起
 * "这句话会被存下来、以后每轮都发出去"。
 *
 * 所以拦在 `addMemoryEntry()`（详情页与聊天两条路都过它）：**一条写入口**。
 *
 * ⚠️ 判据**宁可粗一点**：误报的代价是"这句话存不进记忆，请改写成 `$GITHUB_TOKEN`"，
 *    而漏报的代价是一个长期有效的凭据被反复发到模型那边。两边的代价不对称，
 *    所以这里用"看起来像"就拒，不做精确解析。
 * ⚠️ 但**不拒 `$GITHUB_TOKEN` 这种变量名**：把凭据**写成变量名**正是我们要的行为，
 *    判定只看"像不像一串真的密钥"。
 */
const SECRET_PATTERNS: Array<{ what: string; re: RegExp }> = [
  { what: '私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // OpenAI / Anthropic 风格的 key、GitHub token、Slack token、AWS key id
  { what: 'API key', re: /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/ },
  { what: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { what: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { what: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  // `token=…` / `password: …` 这类赋值，且右侧是够长的一串非空白
  {
    what: '口令赋值',
    re: /\b(pass(word)?|secret|token|api[_-]?key)\b\s*[=:]\s*["']?[A-Za-z0-9_\-+/=]{12,}/i,
  },
  { what: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
]

/** 这段正文看起来像不像"把凭据抄进来了"。 */
export function looksLikeSecret(text: string): string | null {
  for (const { what, re } of SECRET_PATTERNS) {
    if (re.test(text)) return what
  }
  return null
}
