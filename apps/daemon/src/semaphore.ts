/**
 * 极简并发槽位信号量。
 *
 * 语义是**先占槽再执行**（FR-RUNTIME-04）：取不到槽位就不接受请求，
 * 让页面稍后重试——而不是"先收下再排队"。因为"已接受却排不上"会让
 * 使用者看到一堆 dispatched 却什么都没跑，比直接说"忙"更难理解。
 */
export class Semaphore {
  readonly #limit: number
  #inUse = 0

  constructor(limit: number) {
    if (limit < 1) throw new RangeError('并发上限必须 >= 1')
    this.#limit = limit
  }

  get limit(): number {
    return this.#limit
  }

  get inUse(): number {
    return this.#inUse
  }

  get available(): number {
    return Math.max(0, this.#limit - this.#inUse)
  }

  /** 取一个槽位。取不到返回 false。 */
  tryAcquire(): boolean {
    if (this.#inUse >= this.#limit) return false
    this.#inUse++
    return true
  }

  release(): void {
    if (this.#inUse > 0) this.#inUse--
  }
}
