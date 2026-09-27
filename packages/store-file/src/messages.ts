import { join } from 'node:path'
import type { RunId, RunMessage } from '@agentdeck/protocol'
import { AppendHandle, ensureDir, readBytesOrNull } from './fs-utils.ts'

/**
 * 一个 run 的消息流。
 *
 * 为什么与实体日志分开存放：消息是**高写入量**数据（一次 run 可能产生
 * 上千条），而实体记录是低频的状态变更。混在一起会让实体日志的压缩
 * 变得又大又频繁。
 *
 * 消息**只追加、不修改**，所以不需要 JsonlLog 那套索引机制——
 * 只需要维护一个内存里的 `lastSeq` 用于快速回答"已产生到第几号"。
 */
export class MessageLog {
  readonly #path: string
  readonly #handle: AppendHandle
  #lastSeq = -1

  constructor(path: string, options: { fsync?: boolean } = {}) {
    this.#path = path
    this.#handle = new AppendHandle(path, options)
  }

  get lastSeq(): number {
    return this.#lastSeq
  }

  /** 打开时扫一遍已有消息，恢复 lastSeq。 */
  async open(): Promise<void> {
    const bytes = await readBytesOrNull(this.#path)
    if (!bytes || bytes.length === 0) return
    const text = new TextDecoder().decode(bytes)
    let max = -1
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const msg = JSON.parse(line) as RunMessage
        if (typeof msg.seq === 'number' && msg.seq > max) max = msg.seq
      } catch {
        continue // 尾部半行：忽略
      }
    }
    this.#lastSeq = max
  }

  async append(message: RunMessage): Promise<void> {
    await this.#handle.appendLine(JSON.stringify(message))
    if (message.seq > this.#lastSeq) this.#lastSeq = message.seq
  }

  /** 读取 `seq > since` 的消息，按 seq 升序。 */
  async read(since = -1): Promise<RunMessage[]> {
    const bytes = await readBytesOrNull(this.#path)
    if (!bytes || bytes.length === 0) return []
    const text = new TextDecoder().decode(bytes)
    const out: RunMessage[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const msg = JSON.parse(line) as RunMessage
        if (msg.seq > since) out.push(msg)
      } catch {
        continue
      }
    }
    return out.sort((a, b) => a.seq - b.seq)
  }

  async close(): Promise<void> {
    await this.#handle.close()
  }
}

export function messageLogPath(runsDir: string, runId: RunId): string {
  return join(runsDir, runId, 'messages.jsonl')
}

export async function ensureRunDir(runsDir: string, runId: RunId): Promise<void> {
  await ensureDir(join(runsDir, runId))
}
