import { ulid, type AuditRecord, type TokenUsage } from '@agentdeck/protocol'

/**
 * 审计记录（FR-AUDIT-01）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它能证明什么，不能证明什么
 * ══════════════════════════════════════════════════════════════════
 *
 * 给定 `inputBlobRefs` + `skillRefs` + `promptHash` + `cliVersion` + `modelId`
 * + `argvRedacted`，可以重建当时给模型的**全部输入**。
 *
 * ⚠️ 但它**不能**证明 skill 当时的具体内容——因为不记内容指纹（D9）。
 *    所以对外表述必须是"**可追溯**"，不是"完全可复现"。
 *    这一条在实现时最容易被悄悄掏空，因为它只是个措辞问题，
 *    不影响任何测试通过。
 */

/** 需要脱敏的参数名——它们的值不能进审计日志。 */
const SECRET_FLAGS = new Set([
  '--token',
  '--api-key',
  '--apikey',
  '--password',
  '--secret',
  '--authorization',
  '-t',
])

/** 形如令牌的字符串。宁可多脱敏几个，也不要漏一个真令牌。 */
const SECRET_VALUE_PATTERNS = [
  /^mul_[A-Za-z0-9_-]{8,}$/,
  /^mat_[A-Za-z0-9_-]{8,}$/,
  /^mcn_[A-Za-z0-9_-]{8,}$/,
  /^sk-[A-Za-z0-9_-]{8,}$/,
  /^gh[pousr]_[A-Za-z0-9]{8,}$/,
  /^Bearer\s+\S+$/i,
]

export const REDACTED = '***'

/**
 * 脱敏命令行。
 *
 * 为什么审计日志里要有 argv，又必须脱敏：
 * 没有 argv 就无法解释"当时到底怎么起的进程"（参数是行为的一部分）；
 * 但参数里可能带令牌——两者都要满足，所以只能脱敏后再存。
 */
export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = []
  let redactNext = false

  for (const token of argv) {
    if (redactNext) {
      out.push(REDACTED)
      redactNext = false
      continue
    }

    const eq = token.indexOf('=')
    const name = eq === -1 ? token : token.slice(0, eq)

    if (SECRET_FLAGS.has(name)) {
      if (eq === -1) {
        out.push(token)
        redactNext = true
      } else {
        out.push(`${name}=${REDACTED}`)
      }
      continue
    }

    if (SECRET_VALUE_PATTERNS.some((re) => re.test(token))) {
      out.push(REDACTED)
      continue
    }

    out.push(token)
  }

  return out
}

export interface BuildAuditInput {
  workspaceId: AuditRecord['workspaceId']
  runId: AuditRecord['runId']
  subject: AuditRecord['subject']
  inputBlobRefs: readonly AuditRecord['inputBlobRefs'][number][]
  skillRefs: readonly AuditRecord['skillRefs'][number][]
  runtimeDescriptorKey: string
  cliVersion: string | null
  modelId: string | null
  promptHash: string | null
  /** 实际启动的命令行——**本函数负责脱敏**。 */
  argv: readonly string[]
  verdictId: AuditRecord['verdictId']
  actionIds: readonly AuditRecord['actionIds'][number][]
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
  usage: TokenUsage | null | undefined
  now?: () => number
}

export function buildAuditRecord(input: BuildAuditInput): AuditRecord {
  return {
    id: ulid(input.now ? input.now() : Date.now()) as AuditRecord['id'],
    workspaceId: input.workspaceId,
    runId: input.runId,
    subject: input.subject,
    inputBlobRefs: [...input.inputBlobRefs],
    skillRefs: [...input.skillRefs],
    runtimeDescriptorKey: input.runtimeDescriptorKey,
    cliVersion: input.cliVersion,
    modelId: input.modelId,
    promptHash: input.promptHash,
    argvRedacted: redactArgv(input.argv),
    verdictId: input.verdictId,
    actionIds: [...input.actionIds],
    queuedAt: input.queuedAt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    usage: input.usage ?? null,
  }
}
