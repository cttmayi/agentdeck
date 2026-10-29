/**
 * 读/复制「使用者的 CLI 个人配置」这两个动作的底座（分批第 75 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么单独一层：Windows 上这两个动作都**不是**普通的读写
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **编码**：PowerShell 5.1 的 `>` 重定向会把 `config.toml` 写成 **UTF-16LE**
 *    （带 BOM）。我们原来一律 `readFile(path, 'utf8')` ⇒ 读出来是**乱码夹着 NUL**，
 *    再把这段乱码当 TOML 改一改写回受管副本，codex 就解析不了。这件事
 *    `codex-doctor` 早就能**识别**（判 BOM 为 utf16le 并给出转换办法），但**复制这条
 *    路上没做**——于是"能诊断、却在跑的时候照样坏"。
 * ② **文件锁**：codex 经常正开着 `auth.json`，Windows 的 `CopyFile` 在目标被占用时
 *    会失败（`EPERM`/`EACCES`/`EBUSY`）。与 `store-file` 的 `renameWithRetry` 同一个
 *    现象、同一套处置（只在这几个码上退避重试，且**只在 win32 上**）。
 *
 * ⚠️ 读进来的文本会**以 UTF-8 写回受管副本**（那份文件是我们自己的，见 D78）。
 *    使用者的原文件一个字节都不动——这条边界在整个仓库里是一致的（D29）。
 */

import { copyFile, readFile, writeFile } from 'node:fs/promises'

/** 读到的编码形态。`utf8` = 原样就是 UTF-8（无 BOM）。 */
export type ConfigEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be'

export interface ConfigText {
  /** 已经按真实编码解出来的文本（可直接当 TOML / JSON 用）。 */
  text: string
  encoding: ConfigEncoding
  /**
   * 需要「规范化成 UTF-8」吗（`encoding !== 'utf8'`）。
   *
   * 调用方在**要写回受管副本**时必须写 UTF-8——即使内容没改也要写，否则受管副本
   * 里留着一份 UTF-16 的文件，而我们后续的读取（都已按 UTF-8 走）就又会读错。
   */
  needsNormalize: boolean
}

/** UTF-16BE 在 Node 里没有现成解码器：交换字节序之后按 LE 解。 */
function decodeUtf16be(bytes: Uint8Array): string {
  const swapped = Buffer.from(bytes)
  swapped.swap16()
  return swapped.toString('utf16le')
}

/**
 * 读一个配置文件，按 BOM 判真实编码。
 *
 * ⚠️ 判据只有 BOM（前几个字节），**不做启发式猜测**：没有 BOM 就是 UTF-8——
 *    这也是 Node 的默认行为。凭"看起来像 UTF-16"去猜会在正常 UTF-8 文件上误判
 *    （而误判的后果是把好文件写坏）。
 */
export async function readConfigText(path: string): Promise<ConfigText> {
  const bytes = await readFile(path)
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      text: bytes.subarray(2).toString('utf16le'),
      encoding: 'utf16le',
      needsNormalize: true,
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeUtf16be(bytes.subarray(2)), encoding: 'utf16be', needsNormalize: true }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: bytes.subarray(3).toString('utf8'), encoding: 'utf8-bom', needsNormalize: true }
  }
  return { text: bytes.toString('utf8'), encoding: 'utf8', needsNormalize: false }
}

/** 把文本以 UTF-8（无 BOM）写回。受管副本的规范化只走这一个出口。 */
export async function writeConfigTextUtf8(path: string, text: string): Promise<void> {
  await writeFile(path, text, 'utf8')
}

export interface CopyRetryDeps {
  /** 注入平台（默认 `process.platform`）——注入是为了能在 macOS 上测 Windows 那条。 */
  platform?: NodeJS.Platform
  /** 注入 copyFile（默认 `node:fs/promises` 的）。 */
  copy?: (from: string, to: string) => Promise<void>
  /** 注入等待（默认真等）。测试里换成"立刻返回"，免得判据真的睡 300ms。 */
  sleep?: (ms: number) => Promise<void>
}

/** 「别人正开着这个文件」这类可以重试的错误码。 */
const TRANSIENT_COPY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * 复制一个文件；Windows 上遇到占用时退避重试（20/40/80/160ms，总上限约 300ms）。
 *
 * 与 `store-file` 的 `renameWithRetry` 同一套判据与同一个理由：
 * 「占用」在 Windows 上是**常态**（杀软在扫、另一个句柄没释放），试一次就放弃
 * 等于把一次"毫秒级的偶然"当成"真的不能用"；而无限重试会把卡住的现场变成挂死。
 */
export async function copyWithRetry(
  source: string,
  target: string,
  deps: CopyRetryDeps = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform
  const doCopy = deps.copy ?? copyFile
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  const delays = platform === 'win32' ? [20, 40, 80, 160] : []
  for (let attempt = 0; ; attempt += 1) {
    try {
      await doCopy(source, target)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const delay = delays[attempt]
      if (delay === undefined || code === undefined || !TRANSIENT_COPY_CODES.has(code)) throw err
      await sleep(delay)
    }
  }
}
