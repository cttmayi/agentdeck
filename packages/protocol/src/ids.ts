import { z } from 'zod'

/**
 * 实体标识。用 zod 的 brand 做**编译期区分**——
 * 把 `RunId` 传进要 `IssueId` 的地方是编译错误，而不是运行时的诡异 bug。
 */

export const WorkspaceId = z.string().brand<'WorkspaceId'>()
export type WorkspaceId = z.infer<typeof WorkspaceId>

export const DeviceId = z.string().brand<'DeviceId'>()
export type DeviceId = z.infer<typeof DeviceId>

export const AgentId = z.string().brand<'AgentId'>()
export type AgentId = z.infer<typeof AgentId>

export const SkillId = z.string().brand<'SkillId'>()
export type SkillId = z.infer<typeof SkillId>

export const IssueId = z.string().brand<'IssueId'>()
export type IssueId = z.infer<typeof IssueId>

export const CommentId = z.string().brand<'CommentId'>()
export type CommentId = z.infer<typeof CommentId>

export const RunId = z.string().brand<'RunId'>()
export type RunId = z.infer<typeof RunId>

export const ReportId = z.string().brand<'ReportId'>()
export type ReportId = z.infer<typeof ReportId>

export const VerdictId = z.string().brand<'VerdictId'>()
export type VerdictId = z.infer<typeof VerdictId>

export const ActionId = z.string().brand<'ActionId'>()
export type ActionId = z.infer<typeof ActionId>

export const ArtifactId = z.string().brand<'ArtifactId'>()
export type ArtifactId = z.infer<typeof ArtifactId>

export const AuditId = z.string().brand<'AuditId'>()
export type AuditId = z.infer<typeof AuditId>

export const RuntimeId = z.string().brand<'RuntimeId'>()
export type RuntimeId = z.infer<typeof RuntimeId>

export const AccountId = z.string().brand<'AccountId'>()
export type AccountId = z.infer<typeof AccountId>

/**
 * 内容寻址引用：`sha256:<hex>`。
 * 用于 report 快照与 artifact——同一份内容天然去重。
 */
export const BlobRef = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be sha256:<64 hex>')
export type BlobRef = z.infer<typeof BlobRef>

// ─────────────────────────────────────────────────────────────
// ULID
// ─────────────────────────────────────────────────────────────

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32
const ENCODING_LEN = 32
const TIME_LEN = 10
const RANDOM_LEN = 16

/**
 * 生成 ULID：前 10 字符是 48 位毫秒时间戳，后 16 字符是 80 位随机。
 *
 * 为什么用 ULID 而不是 UUID：**单调可排序**，而本项目的存储是 append-only
 * 日志，排序友好的键能省掉很多索引工作。
 */
export function encodeTime(now: number, len = TIME_LEN): string {
  if (!Number.isFinite(now) || now < 0) throw new RangeError(`invalid time: ${now}`)
  let out = ''
  let t = Math.floor(now)
  for (let i = len - 1; i >= 0; i--) {
    out = ENCODING[t % ENCODING_LEN]! + out
    t = Math.floor(t / ENCODING_LEN)
  }
  return out
}

/** 80 位随机 → 16 个 base32 字符（按位正确编码，不做取模偏置）。 */
export function encodeRandom(): string {
  const bytes = new Uint8Array(10)
  globalThis.crypto.getRandomValues(bytes)
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let out = ''
  for (let i = 0; i < RANDOM_LEN; i++) {
    out = ENCODING[Number(n & 31n)]! + out
    n >>= 5n
  }
  return out
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

export const Ulid = z.string().regex(ULID_RE, 'must be a ULID')
export type Ulid = z.infer<typeof Ulid>

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom()
}

/**
 * 单调 ULID 生成器：同一毫秒内连续生成时，随机部分递增而不是重新抽取。
 *
 * 这让**同一进程内**的 ID 严格递增，append-only 日志按 ID 排序即等价于
 * 按写入顺序排序——省掉一个容易出错的隐式约定。
 */
export function createUlidFactory(): (now?: number) => string {
  let lastTime = -1
  let lastRandom = ''

  return (now: number = Date.now()): string => {
    const t = Math.floor(now)
    if (t === lastTime) {
      // 在当前随机部分上做 +1（base32 进位）
      let carry = true
      const chars = lastRandom.split('')
      for (let i = chars.length - 1; i >= 0 && carry; i--) {
        const idx = ENCODING.indexOf(chars[i]!)
        if (idx === ENCODING_LEN - 1) {
          chars[i] = ENCODING[0]!
        } else {
          chars[i] = ENCODING[idx + 1]!
          carry = false
        }
      }
      if (carry) {
        // 随机部分溢出（概率可忽略）：退化为重新抽取，并推进时间戳
        lastTime = t + 1
        lastRandom = encodeRandom()
        return encodeTime(lastTime) + lastRandom
      }
      lastRandom = chars.join('')
    } else {
      lastTime = t
      lastRandom = encodeRandom()
    }
    return encodeTime(lastTime) + lastRandom
  }
}
