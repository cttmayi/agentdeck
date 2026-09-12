/**
 * 极简互斥锁：把并发的写操作排成队列。
 *
 * 本项目的存储是**单进程**的（NFR-D-05），所以进程内串行化就够了——
 * 不需要文件锁那样跨进程的机制。但**必须**有它：CAS 语义的前提是
 * "读到前态"与"写入新态"之间没有别人插进来。
 */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn)
    // 无论成败都让队列继续往下走，否则一次失败会把后续全部卡死
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

/**
 * 去掉值为 `undefined` 的键。
 *
 * 用途：patch 合并。`exactOptionalPropertyTypes` 下 `{...a, ...b}` 里
 * 若 b 的某个键是 undefined，会把 a 的值覆盖成 undefined——这不是我们
 * 想要的"没提到就不改"语义。
 */
export function pruneUndefined(obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out
}
