import type { MemoryKind } from '@agentdeck/protocol'

/**
 * 「经验」那一块怎么排、带哪几条（分批第 240 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这一段必须是一个纯函数，而且放在 agent-core
 * ══════════════════════════════════════════════════════════════════
 *
 * 它决定**这一轮它收到什么**——而"它为什么这么干"这件事只能靠这一段解释。
 * 所以：纯函数（同样的输入永远同样的输出）、不读磁盘、不读 store，测试直接喂数组。
 * 放在 `agent-core` 是因为它与第一句话的组装在同一层，而组装那一层的规矩是
 * 「交给 CLI 的只有第一句话」（D29）——记忆没有第二条投递通道。
 *
 * ══════════════════════════════════════════════════════════════════
 * 顺序（所见即所得：界面上也是这个顺序）
 * ══════════════════════════════════════════════════════════════════
 *
 *   ① **★ 置顶**的排最前，预算紧张时最后才裁（这就是"能不能调顺序"这个需求的落地：
 *      不做拖拽排序，只给一个"必须带上"的加权）；
 *   ② 其余按类型优先级：`commitment > preference > fact > lesson`
 *      —— 约定与偏好管"怎么做事"，事实管"环境长什么样"，教训是事后总结；
 *   ③ 同类按**最近用过**（久不用的自然沉底，所以不需要"停用/退役"状态）；
 *   ④ 还平的话按创建时间新的在前。
 *
 * ⚠️ 预算按**字数**算（不是 token）：跟第一句话里其它块的写法一致，而且它不需要
 *    引入一个分词器。超预算就**从后往前裁**，并且如实地说"另有 N 条没带"
 *    —— 静默截断会让人以为"我说的它都记得"。
 */
export const MEMORY_KIND_PRIORITY: Record<MemoryKind, number> = {
  // 数字小的先带：约定（答应过的事）> 偏好（怎么对待人）> 事实（环境）> 教训（复盘）。
  commitment: 0,
  preference: 1,
  fact: 2,
  lesson: 3,
}

/** 每个 kind 在正文前的短标记（第一句话里要能一眼分出是哪一类）。 */
export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
  commitment: '约定',
  preference: '偏好',
  fact: '事实',
  lesson: '教训',
}

/**
 * ★ 分批第 266 批（使用者："感觉没有必要有字数限制" → 选"去掉吧"）：**不再按字数裁**。
 *
 * 原先是 1200 字的每轮预算：超出就把尾巴裁掉，并写一句"另有 N 条这次没带"。
 * 去掉的理由（使用者定的）：字数闸在他看不见的地方悄悄裁，而它换来的只是每轮短一点。
 * 代价也说清、并接受：**每轮第一句话会随着记忆变多而变长**（上限仍是 40 条 × 400 字），
 * 多出来的记忆会稀释当前任务的注意力；"另有 N 条没带"这句诚实的提示也就不存在了
 * ——因为不再有"没带"这回事。
 *
 * ⚠️ 保留下来的两道：**40 条的库存上限**（人还能读完、改得动）与**单条 400 字**
 *    （写超了通常该拆成几条，或者它其实是一份文档）。
 */

/** 一条记忆在注入文本里的形状：`- [约定] 正文`。 */
export function memoryLineText(item: { kind: MemoryKind; text: string }): string {
  return `- [${MEMORY_KIND_LABEL[item.kind]}] ${item.text.trim()}`
}

/** 排序、截断要用到的字段（`MemoryEntry` 结构上就满足它）。 */
export interface RankableMemory {
  kind: MemoryKind
  text: string
  pinned?: boolean | undefined
  /** 最后一次被带进第一句话的时间；`null`/缺省 = 从没用上过。 */
  lastUsedAt?: number | null | undefined
  createdAt?: number | undefined
}

export interface RankedMemory<T extends RankableMemory> {
  /** 真正要带进第一句话的（已排序；第 266 批起 = **全部**）。 */
  picked: T[]
  /** 这一块占了多少字（含标记与换行）。界面用它显示"带入多少字"。 */
  chars: number
}

/**
 * 排序 + 按预算挑。
 *
 * `budgetChars` 给了就按它算（测试与将来的设定项都从这里进）。
 */
/**
 * 只排序、不裁剪：**注入顺序就是它**（界面也按这个顺序显示，所见即所得）。
 *
 * 抽出来是因为有两个调用方需要"同一个顺序、但不要预算"：`rankMemory`（要预算）
 * 与 daemon 的列表接口（详情页按注入顺序显示记忆——否则界面上从上到下的顺序
 * 与实际进第一句话的顺序不一致，人就没法判断"预算不够时先丢哪条"）。
 */
export function sortMemoryForInjection<T extends RankableMemory>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const pinnedA = a.pinned === true ? 0 : 1
    const pinnedB = b.pinned === true ? 0 : 1
    if (pinnedA !== pinnedB) return pinnedA - pinnedB
    const kindA = MEMORY_KIND_PRIORITY[a.kind]
    const kindB = MEMORY_KIND_PRIORITY[b.kind]
    if (kindA !== kindB) return kindA - kindB
    const usedA = a.lastUsedAt ?? -1
    const usedB = b.lastUsedAt ?? -1
    if (usedA !== usedB) return usedB - usedA
    return (b.createdAt ?? 0) - (a.createdAt ?? 0)
  })
}

export function rankMemory<T extends RankableMemory>(items: readonly T[]): RankedMemory<T> {
  const picked = sortMemoryForInjection(items)
  let chars = 0
  for (const item of picked) chars += memoryLineText(item).length + 1 // +1 = 换行
  return { picked, chars }
}

/**
 * 「经验」那一块的正文（不含模版包装）。
 *
 * 三条内容各自有理由：
 *   ① **从属声明**（"以下是过去记下的、可能过时；与身份/任务冲突时以它们为准"）——
 *      这是防"记忆悄悄改写人格"的那道闸，也是提示注入的兜底：记忆能影响它，
 *      但不能覆盖这次的人设与任务；
 *   ② 每行带 `[类型]` 标记——一眼能看出这条是"我答应过"还是"我复盘出来的"；
 *   ③ ★ 第 266 批起**不裁**（预算闸去掉）：全部带上，所以也没有"另有 N 条未带"那句话。
 */
export function memoryBlockText<T extends RankableMemory>(
  items: readonly T[],
): { text: string; picked: T[]; chars: number } {
  const ranked = rankMemory(items)
  if (ranked.picked.length === 0) return { text: '', picked: [], chars: 0 }
  const lines = [
    '以下是过去记下的经验，可能已经过时；与上面的身份、下面的任务冲突时，以它们为准。',
    '',
    ...ranked.picked.map((item) => memoryLineText(item)),
  ]
  return { text: lines.join('\n'), picked: ranked.picked, chars: ranked.chars }
}
