/**
 * 把回调式的事件源转成 `AsyncIterable`。
 *
 * 用途：CLI 适配器在子进程输出时拿到消息，但对外要暴露一个可 `for await`
 * 的流。这样调用方（daemon）可以边收边推给页面，而不必等进程结束。
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  #buffer: T[] = []
  #waiters: Array<(result: IteratorResult<T>) => void> = []
  #closed = false

  get closed(): boolean {
    return this.#closed
  }

  push(item: T): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) {
      waiter({ value: item, done: false })
      return
    }
    this.#buffer.push(item)
  }

  /** 结束流。重复调用是幂等的。 */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const buffered = this.#buffer.shift()
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false })
        if (this.#closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
    }
  }
}
