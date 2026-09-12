import { createReadStream } from 'node:fs'
import { rename, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { AppendHandle, atomicWrite, ensureDir, readJsonOrNull, removeQuietly } from './fs-utils.ts'
import { dirname } from 'node:path'

/**
 * append-only 记录日志 + 内存索引。
 *
 * 为什么用追加写而不是"读整份文件改完写回"：
 *
 * - 追加写**不需要原子替换整个文件**，崩溃最多丢掉最后一条，
 *   而不是把文件写坏；
 * - 每条记录就是一个版本，天然满足 DR-3「历史不得被覆盖」；
 * - 将来导入数据库时，回放这套日志即可完成初始装载（FR-STOR-05）。
 *
 * ⚠️ **所有 patch 必须是绝对赋值，不能是自增**。
 *    因为崩溃后可能重放已经应用过的记录，自增会被应用两次。
 */

export interface LogEntry {
  /** 日志内单调递增的序号。 */
  seq: number
  at: number
  op: 'put' | 'patch'
  id: string
  /** op = put 时的完整实体。 */
  value?: unknown
  /** op = patch 时的绝对赋值。 */
  patch?: Record<string, unknown>
}

interface Snapshot<T> {
  seq: number
  items: T[]
}

export class JsonlLog<T extends { id: string }> {
  readonly #path: string
  readonly #snapshotPath: string
  readonly #handle: AppendHandle
  readonly #index = new Map<string, T>()
  #seq = 0

  constructor(path: string, options: { fsync?: boolean } = {}) {
    this.#path = path
    this.#snapshotPath = `${path}.snapshot`
    this.#handle = new AppendHandle(path, options)
  }

  get size(): number {
    return this.#index.size
  }

  get lastSeq(): number {
    return this.#seq
  }

  /** 打开并重建内存索引：先读快照，再回放增量日志。 */
  async open(): Promise<void> {
    const snap = await readJsonOrNull<Snapshot<T>>(this.#snapshotPath)
    if (snap) {
      this.#seq = snap.seq
      for (const item of snap.items) this.#index.set(item.id, item)
    }
    await this.#replay()
  }

  async #replay(): Promise<void> {
    let fileSize = 0
    try {
      fileSize = (await stat(this.#path)).size
    } catch {
      return // 日志还不存在
    }
    if (fileSize === 0) return

    const rl = createInterface({
      input: createReadStream(this.#path, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })

    for await (const line of rl) {
      if (line.trim() === '') continue
      let entry: LogEntry
      try {
        entry = JSON.parse(line) as LogEntry
      } catch {
        // 尾部半行（崩溃时写了一半）：跳过。这正是追加写的好处——
        // 只丢最后一条，前面的都完好。
        continue
      }
      this.#apply(entry)
    }
  }

  #apply(entry: LogEntry): void {
    this.#seq = Math.max(this.#seq, entry.seq)
    if (entry.op === 'put') {
      this.#index.set(entry.id, entry.value as T)
      return
    }
    const current = this.#index.get(entry.id)
    if (!current) return // patch 先于 put 出现：忽略
    this.#index.set(entry.id, { ...current, ...(entry.patch ?? {}) })
  }

  get(id: string): T | undefined {
    return this.#index.get(id)
  }

  has(id: string): boolean {
    return this.#index.has(id)
  }

  all(): T[] {
    return [...this.#index.values()]
  }

  async #append(entry: Omit<LogEntry, 'seq' | 'at'>): Promise<void> {
    this.#seq += 1
    const full: LogEntry = { seq: this.#seq, at: Date.now(), ...entry }
    await this.#handle.appendLine(JSON.stringify(full))
    this.#apply(full)
  }

  async put(value: T): Promise<void> {
    await this.#append({ op: 'put', id: value.id, value })
  }

  /**
   * 局部更新。**patch 里只能是绝对赋值**——见文件头部的说明。
   * @returns 实体不存在时返回 false
   */
  async patch(id: string, patch: Record<string, unknown>): Promise<boolean> {
    if (!this.#index.has(id)) return false
    await this.#append({ op: 'patch', id, patch })
    return true
  }

  /**
   * 压缩：把当前状态物化成快照，然后丢弃日志。
   *
   * 顺序不可颠倒——**先把快照 fsync 落地，再删日志**。反过来的话，
   * 崩溃会同时丢掉快照和日志，等于把整个 workspace 清空。
   */
  async compact(): Promise<void> {
    await ensureDir(dirname(this.#snapshotPath))
    await atomicWrite(
      this.#snapshotPath,
      JSON.stringify({ seq: this.#seq, items: this.all() } satisfies Snapshot<T>),
    )

    await this.#handle.close()
    const rotated = `${this.#path}.discard-${process.pid}-${Date.now()}`
    try {
      await rename(this.#path, rotated)
      await removeQuietly(rotated)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  async close(): Promise<void> {
    await this.#handle.close()
  }
}
