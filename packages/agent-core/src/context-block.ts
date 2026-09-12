/**
 * 上下文块注入（FR-CLI-26~30）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这个算法值得写得这么小心
 * ══════════════════════════════════════════════════════════════════
 *
 * 参考材料记录了一个真实事故：早期版本**无条件覆盖写**，在"绑定本地目录"
 * 这种项目形态下，第一次运行就**截断了使用者自己仓库里的 CLAUDE.md**。
 *
 * 所以结论只有一条：
 *
 *   **往使用者的文件里写东西，只有"可回滚"和"数据损坏"两种结果，
 *     中间状态不存在。**
 *
 * 三种文件状态 → 三种行为，且**分隔符的字节算作受管区域的一部分**——
 * 后者看着吹毛求疵，但它买来的是：清理可以逐字节还原，不需要对尾部换行
 * 做任何规范化猜测。使用者那个以三个换行结尾的文件，回来还是三个换行。
 */

/**
 * 块标记。
 *
 * 用注释形式是为了让**不认识这套格式的人**读源文件时也能看懂它是自动管理的。
 * `do not edit` 不是客套——外面一改，下次注入就会被覆盖。
 */
export const CONTEXT_BLOCK_BEGIN = '<!-- BEGIN ALPHA-HELPER (auto-managed; do not edit) -->'
export const CONTEXT_BLOCK_END = '<!-- END ALPHA-HELPER -->'

/**
 * 追加时使用的前置分隔符。
 *
 * ★ 它的字节**属于受管区域**：清理时连它一起去掉，才能还原成
 *   "文件里本来没有这一段"。
 */
export const CONTEXT_BLOCK_SEPARATOR = '\n\n'

export type ContextBlockOrigin =
  /** 文件原本不存在，只写了一个块（不写前置分隔符）。 */
  | 'created'
  /** 文件存在但没有标记块，追加了分隔符 + 块。 */
  | 'appended'
  /** 已有标记块，原地替换块体，块外逐字节保留。 */
  | 'replaced'
  /** 上次写入崩溃留下"有开始无结束"的半个块，按延伸到末尾处理并重写。 */
  | 'repaired'

export interface InjectResult {
  content: string
  origin: ContextBlockOrigin
}

/** 用一对标记把内容包起来。 */
export function renderContextBlock(body: string): string {
  return `${CONTEXT_BLOCK_BEGIN}\n${body.trimEnd()}\n${CONTEXT_BLOCK_END}`
}

/**
 * 注入。
 *
 * @param original 文件当前内容；**文件不存在时传 `null`**（不是空字符串——
 *                 两者语义不同：空文件是"存在但为空"，清理时要保留它）。
 */
export function injectContextBlock(original: string | null, block: string): InjectResult {
  // ① 文件不存在：只写块，不写前置分隔符
  if (original === null) {
    return { content: block, origin: 'created' }
  }

  const begin = original.indexOf(CONTEXT_BLOCK_BEGIN)

  // ② 没有标记块：追加「固定分隔符 + 块」
  if (begin === -1) {
    return {
      content: original + CONTEXT_BLOCK_SEPARATOR + block,
      origin: 'appended',
    }
  }

  const afterBegin = begin + CONTEXT_BLOCK_BEGIN.length

  // ★ 只在 BEGIN **之后**查找 END。
  //
  //   朴素实现会全文找 END，于是使用者文档里一句"我们的格式长这样"引用的
  //   孤立 END 标记会让它判定"块无效"→ 追加新块 → 孤立标记还在 →
  //   **每次运行都追加一个，文件无限增长**。
  const end = original.indexOf(CONTEXT_BLOCK_END, afterBegin)

  // ③ 有 BEGIN 无 END：上次写入崩在中间留下的半个块。
  //    视作块一直延伸到文件末尾，下次原地替换——而不是在它后面再堆一个。
  if (end === -1) {
    return { content: original.slice(0, begin) + block, origin: 'repaired' }
  }

  // ④ 完整块：原地替换块体，块外逐字节保留
  return {
    content:
      original.slice(0, begin) + block + original.slice(end + CONTEXT_BLOCK_END.length),
    origin: 'replaced',
  }
}

export interface RemoveResult {
  content: string
  /** true 表示这个文件是**我们创建的**（原本不存在），应当删除而不是留空。 */
  deleteFile: boolean
}

/**
 * 清理：逐字节还原使用者原文件。
 *
 * 「文件是不是我们创建的」用**结构证据**判断，不依赖外部记忆——这样即使
 * 进程中途崩过、记录丢了，清理依然正确。判据是**两个条件同时成立**：
 *
 *   ① 块位于文件最开头（前面**没有**我们的分隔符）
 *   ② 移除后什么都不剩
 *
 * 缺一不可：
 *   - 只看①会误删"使用者自己就以标记开头的文件"；
 *   - 只看②会把使用者**原本就存在的空文件**当成我们造的删掉
 *     （空文件 + 追加会得到「分隔符 + 块」，移除后也确实什么都不剩）。
 */
export function removeContextBlock(content: string): RemoveResult {
  const begin = content.indexOf(CONTEXT_BLOCK_BEGIN)
  if (begin === -1) return { content, deleteFile: false }

  const afterBegin = begin + CONTEXT_BLOCK_BEGIN.length
  const end = content.indexOf(CONTEXT_BLOCK_END, afterBegin)
  const removeTo = end === -1 ? content.length : end + CONTEXT_BLOCK_END.length

  // 块首紧邻我们的分隔符 ⇒ 这分隔符也是我们加的，属于受管区域，一起去掉
  const sepStart = begin - CONTEXT_BLOCK_SEPARATOR.length
  const hasOurSeparator =
    sepStart >= 0 && content.slice(sepStart, begin) === CONTEXT_BLOCK_SEPARATOR

  const from = hasOurSeparator ? sepStart : begin
  const remaining = content.slice(0, from) + content.slice(removeTo)

  const deleteFile = !hasOurSeparator && begin === 0 && remaining === ''

  return { content: deleteFile ? '' : remaining, deleteFile }
}

/** 判断一段内容里是否已有我们管理的块。 */
export function hasContextBlock(content: string): boolean {
  return content.includes(CONTEXT_BLOCK_BEGIN)
}
