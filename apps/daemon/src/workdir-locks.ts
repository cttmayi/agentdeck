import type { RunId } from '@agentdeck/protocol'

/**
 * 工作目录锁（D20 —— 同一目录串行化）。
 *
 * 为什么需要它：平台只给一个工作目录，**不做仓库检出**。所以两个 run 落在
 * 同一个目录上时，它们会同时改同一批文件——结果不是"冲突报错"，而是
 * **互相踩坏且没人知道**。
 *
 * 处理方式不是失败，而是**停放**：后来的 run 进入 `waiting_local_directory`，
 * 等前一个释放后自动继续。占用是**可恢复的**，失败只会让使用者白跑一次。
 *
 * 这是一个**进程内**的 FIFO 队列。跨进程由数据目录锁（NFR-D-05）挡住——
 * 同一数据目录只允许一个 daemon，所以进程内队列就够了。
 */

export interface WorkDirWaiter {
  runId: RunId
  resolve: () => void
}

export class WorkDirLocks {
  readonly #holder = new Map<string, RunId>()
  readonly #waiters = new Map<string, WorkDirWaiter[]>()

  /** 当前持有者。 */
  holderOf(workDir: string): RunId | undefined {
    return this.#holder.get(workDir)
  }

  isLocked(workDir: string): boolean {
    return this.#holder.has(workDir)
  }

  /**
   * 尝试获取。
   *
   * @returns `acquired: true` 表示立刻拿到；`false` 表示已排队，
   *           `waiting` 会在轮到时 resolve。
   */
  acquire(
    workDir: string,
    runId: RunId,
  ): { acquired: boolean; waiting?: Promise<void> } {
    const holder = this.#holder.get(workDir)
    if (holder === undefined) {
      this.#holder.set(workDir, runId)
      return { acquired: true }
    }
    if (holder === runId) {
      // 重复获取：幂等，不排队
      return { acquired: true }
    }

    let resolveFn: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      resolveFn = resolve
    })
    const queue = this.#waiters.get(workDir) ?? []
    queue.push({ runId, resolve: resolveFn! })
    this.#waiters.set(workDir, queue)

    return { acquired: false, waiting }
  }

  /** 释放。若有人排队，直接移交给队首（不留空窗）。 */
  release(workDir: string, runId: RunId): void {
    if (this.#holder.get(workDir) !== runId) return

    const queue = this.#waiters.get(workDir)
    const next = queue?.shift()
    if (queue && queue.length === 0) this.#waiters.delete(workDir)

    if (next) {
      // 直接移交，避免"释放 → 空窗 → 别人抢走"
      this.#holder.set(workDir, next.runId)
      next.resolve()
    } else {
      this.#holder.delete(workDir)
    }
  }

  /** 排队中的人数——诊断与测试用。 */
  waitingCount(workDir: string): number {
    return this.#waiters.get(workDir)?.length ?? 0
  }

  /** 取消一个排队中的 run。 */
  cancelWaiting(workDir: string, runId: RunId): boolean {
    const queue = this.#waiters.get(workDir)
    if (!queue) return false
    const index = queue.findIndex((w) => w.runId === runId)
    if (index === -1) return false
    queue.splice(index, 1)
    return true
  }
}
