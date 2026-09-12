import { z } from 'zod'
import { ActionType, ReasonCode, Severity, VerdictConclusion } from './enums.ts'
import { BlobRef } from './ids.ts'

/**
 * Verdict 的全局统一 schema（requirements §7、D2）。
 *
 * 设计要点是**「一开一合」**（FR-REVIEW-10）：
 *
 *   闭合：conclusion / reasonCode / severity / evidence / action.type
 *   开放：**只有** finding.detail 一处
 *
 * 判定标准是「是否有第二个消费方需要理解它」：
 * 需要 → 闭合（否则无法统计、分组、写升级策略）；
 * 只有产出者与人类读者关心 → 开放。
 *
 * 为什么必须这样：全局统一 schema 最大的风险是**越写越松**，最后变成一个
 * 什么都能塞的 JSON blob，等于没有校验。所以开放位置必须被**限制在一处**。
 */

/**
 * 证据引用。必须能指回输入快照，否则判决不可追溯。
 *
 * 用 `strictObject`：**闭合位置必须真的拒绝未知字段**。若只靠类型标注，
 * zod 默认会静默剥离多余字段——那等于"看似闭合、实则放任"。
 */
export const EvidenceRef = z.strictObject({
  /** 指向输入快照（report 或上游 run 的产出）。 */
  blobRef: BlobRef.nullable(),
  /** 在快照内的定位（行号、章节、条目 id 等）。 */
  locator: z.string().max(200).nullable(),
  /** 摘录。限长，防止把整份文档塞进 verdict。 */
  excerpt: z.string().max(1000).nullable(),
})
export type EvidenceRef = z.infer<typeof EvidenceRef>

/**
 * 动作引用。
 *
 * ★ 注意：**没有 `plane` 字段**。执行端（local / remote）由动作注册表决定，
 *   不由 verdict 决定（INV-13）。这样本地动作将来迁移到远端时，
 *   已经产生的历史判决不需要做数据迁移。
 */
export const ActionRef = z.strictObject({
  type: ActionType,
  /** 载荷按 action type 二次校验（那属于注册表的职责，不在这里）。 */
  params: z.record(z.string(), z.unknown()),
})
export type ActionRef = z.infer<typeof ActionRef>

/**
 * 发现项。
 *
 * `detail` 是**唯一**开放处——所以本对象是 strict 的：
 * 想在判决里塞新结构，只有 `detail` 一条路，别的写法一律被拒。
 */
export const Finding = z.strictObject({
  severity: Severity,
  summary: z.string().min(1).max(500),
  evidence: z.array(EvidenceRef).max(20),
  /** ★ 唯一开放字段：领域多样性由此承载，其余位置一律闭合。 */
  detail: z.record(z.string(), z.unknown()).optional(),
})
export type Finding = z.infer<typeof Finding>

export const VERDICT_SCHEMA_VERSION = 1 as const

/**
 * 判决本体。**全局统一**——所有 skill 的产出顶层形状完全相同，
 * skill 只改变「审核标准」，不改变「输出形状」。
 *
 * 同样是 `strictObject`：顶层多一个字段就判不合规。理由与 Finding 相同——
 * 否则"一开一合"里的"合"会被从顶层绕过。
 */
export const Verdict = z
  .strictObject({
    schemaVersion: z.literal(VERDICT_SCHEMA_VERSION),
    conclusion: VerdictConclusion,
    reasonCode: ReasonCode,
    confidence: z.number().min(0).max(1),
    findings: z.array(Finding).max(100),
    action: ActionRef.nullable(),
    escalateReason: z.string().max(500).nullable(),
  })
  .superRefine((v, ctx) => {
    // 升级必须带结构化原因（INV-5）——不允许只给一段自然语言。
    if (v.conclusion === 'needs_human') {
      if (v.escalateReason === null || v.escalateReason.trim() === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['escalateReason'],
          message: '结论为 needs_human 时必须给出 escalateReason，不得留空',
        })
      }
    } else if (v.escalateReason !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['escalateReason'],
        message: 'escalateReason 只在结论为 needs_human 时允许非空',
      })
    }

    // fail 必须可执行——否则判决没有出口，只能靠人来补，等于把
    // "人" 又变回了默认关卡（INV-4）。
    if (v.conclusion === 'fail' && v.action === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['action'],
        message: '结论为 fail 时必须给出 action，否则判决无法执行',
      })
    }
  })

export type Verdict = z.infer<typeof Verdict>

// ─────────────────────────────────────────────────────────────
// 校验结果：**不抛异常**
// ─────────────────────────────────────────────────────────────

export interface VerdictIssue {
  /** 出错字段路径，如 `['escalateReason']`。 */
  path: string[]
  message: string
}

export type VerdictParseResult =
  | { ok: true; verdict: Verdict }
  | { ok: false; issues: VerdictIssue[] }

/**
 * 校验一份判决。
 *
 * **刻意不抛异常**：schema 不合规在本项目里是一种**独立的失败类型**
 * （FR-REVIEW-05），调用方必须显式处理三条路径
 * （retry / downgrade_to_advisory / escalate），而不是被异常打断。
 */
export function parseVerdict(input: unknown): VerdictParseResult {
  const result = Verdict.safeParse(input)
  if (result.success) return { ok: true, verdict: result.data }
  return {
    ok: false,
    issues: result.error.issues.map((i) => ({
      path: i.path.map(String),
      message: i.message,
    })),
  }
}

/** 把校验错误整理成一段人能读懂的话，用于 UI 与通知。 */
export function formatVerdictIssues(issues: readonly VerdictIssue[]): string {
  if (issues.length === 0) return '判决不符合 schema'
  return issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('；')
}

// ─────────────────────────────────────────────────────────────
// 判决提取：约定围栏 + 确定性切片
// ─────────────────────────────────────────────────────────────

/**
 * 判决围栏标记。
 *
 * 为什么要有它（FR-CLI-44/45）：agent 的输出是自由文本，而我们**不能**用
 * 正则在自由文本里"捞" JSON——那既不可靠也不可测。所以约定一对围栏标记，
 * 让提取变成一次确定性切片。
 *
 * 这三者必须一致：skill 里的输出要求、上下文块里的指令、以及本文件的标记。
 * 因此它们属于**协议**，不属于任何单方实现。
 */
export const VERDICT_FENCE_BEGIN = '<<<ALPHA_VERDICT>>>'
export const VERDICT_FENCE_END = '<<<END_ALPHA_VERDICT>>>'

/**
 * 从 agent 输出中切出判决 JSON 文本。**不做任何"修复"**——
 * 切片结果直接交给 `parseVerdict`，不合规就走 invalid 路径。
 *
 * 取**最后一个**完整块：skill 文件与上下文里都带有判决示例，
 * agent 有可能把它们回显出来；最后出现的那个才是它自己的产出。
 *
 * 只认"先 BEGIN 再 END"的顺序——反过来查找会让孤立的 END 标记
 * 把切片范围搞乱（与上下文块注入算法同一考虑，FR-CLI-28）。
 */
export function extractVerdictJson(text: string): string | null {
  let searchFrom = 0
  let found: string | null = null

  for (;;) {
    const begin = text.indexOf(VERDICT_FENCE_BEGIN, searchFrom)
    if (begin === -1) break
    const bodyStart = begin + VERDICT_FENCE_BEGIN.length
    const end = text.indexOf(VERDICT_FENCE_END, bodyStart)
    if (end === -1) break // 有 BEGIN 无 END：半个块，不作为有效判决
    found = text.slice(bodyStart, end).trim()
    searchFrom = end + VERDICT_FENCE_END.length
  }

  return found
}

/** 让模型照此格式输出（供 skill 与上下文块生成使用）。 */
export function renderVerdictInstruction(): string {
  return [
    `把最终判决写成**一个** JSON 对象，放在下面这对标记之间，标记之外不要重复：`,
    '',
    VERDICT_FENCE_BEGIN,
    '{ "schemaVersion": 1, "conclusion": "...", "reasonCode": "...", "confidence": 0.0,',
    '  "findings": [], "action": null, "escalateReason": null }',
    VERDICT_FENCE_END,
    '',
    '约束：conclusion ∈ pass|fail|needs_human；reasonCode 必须是协议里的枚举值；',
    'needs_human 必须给出 escalateReason；fail 必须给出 action。',
  ].join('\n')
}
