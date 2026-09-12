import { join } from 'node:path'
import type { BlobRef } from '@alpha-helper/protocol'
import { atomicWrite, ensureDir, exists, readBytesOrNull, sha256Hex } from './fs-utils.ts'

/**
 * 内容寻址的 blob 存储。
 *
 * 路径：`<base>/<前两位>/<完整 sha256>`
 *
 * 用内容寻址换来两件事：
 *
 * 1. **`putBlob` 天然幂等**——同一份内容重复写入不会产生第二份。
 *    这让 `FR-REPORT-03` 的去重键免费获得了一半的正确性；
 * 2. 写入是**不可变**的——路径即内容摘要，改了内容就是改了路径，
 *    所以不存在"读到一个正在被改写的文件"这种问题。
 *
 * 分两级目录是为了避免单目录下堆积过多条目。
 */
export class BlobStore {
  readonly #base: string

  constructor(base: string) {
    this.#base = base
  }

  #pathFor(ref: BlobRef): string {
    const hex = ref.slice('sha256:'.length)
    return join(this.#base, hex.slice(0, 2), hex)
  }

  /** 写入并返回引用。同一内容重复写入是幂等的。 */
  async put(bytes: Uint8Array): Promise<BlobRef> {
    const ref = `sha256:${sha256Hex(bytes)}` as BlobRef
    const path = this.#pathFor(ref)
    if (await exists(path)) return ref
    await ensureDir(join(this.#base, ref.slice(7, 9)))
    await atomicWrite(path, bytes)
    return ref
  }

  async get(ref: BlobRef): Promise<Uint8Array | null> {
    return readBytesOrNull(this.#pathFor(ref))
  }

  async has(ref: BlobRef): Promise<boolean> {
    return exists(this.#pathFor(ref))
  }
}
