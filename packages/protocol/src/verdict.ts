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
  // ══════════════════════════════════════════════════════════════════
  // ★ 这三个字段：**缺省 ≡ null**
  // ══════════════════════════════════════════════════════════════════
  //
  // 它们原来是 `.nullable()`——"可以空，但**必须出现**"。那是 JSON 里的反直觉
  // 要求：模型的自然习惯是"没有就不写这个键"。实测被咬过不止一次，而且每次
  // 代价都是一整条判决作废 + 一次重试 + 可能还要人介入。
  //
  // 而"缺省"与"null"在这三个字段上**语义完全相同**，没有任何安全价值：
  // 真正承载判断的是 conclusion / reasonCode / 证据能不能指回原文（那是
  // 内容要求，不是 JSON 键的在场要求）。所以按"必填只留给真正承载判断的字段"
  // 这条原则，改成缺省即 null。
  /** 指向输入快照（report 或上游 run 的产出）。 */
  blobRef: BlobRef.nullish().transform((v) => v ?? null),
  /** 在快照内的定位（行号、章节、条目 id 等）。 */
  locator: z.string().max(200).nullish().transform((v) => v ?? null),
  /** 摘录。限长，防止把整份文档塞进 verdict。 */
  excerpt: z.string().max(1000).nullish().transform((v) => v ?? null),
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
  /**
   * 载荷按 action type 二次校验（那属于注册表的职责，不在这里）。
   *
   * 缺省即空对象：有的动作没有参数，"不写"与"写 {}"是同一件事。
   */
  params: z.record(z.string(), z.unknown()).default({}),
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
    // ══════════════════════════════════════════════════════════════════
    // ★ 这三个同样"缺省即 null / 空数组"
    // ══════════════════════════════════════════════════════════════════
    //
    // 真实踩过：一份 `pass` 判决把整个 `action` 键省掉了（因为指令只说
    // "fail 必须给出 action"，模型合理地认为 pass 不需要它），于是
    // 「action：这个字段是必填的，但判决里没有」——整条判决作废。
    //
    // **安全性一点没丢**：下面 `superRefine` 里那两条出口规则看的是
    // "action 是不是 null"，不是"这个键在不在"。省略与 null 等价。
    findings: z.array(Finding).max(100).default([]),
    action: ActionRef.nullish().transform((v) => v ?? null),
    escalateReason: z.string().max(500).nullish().transform((v) => v ?? null),
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
  /**
   * zod 的 issue code（`invalid_type` / `invalid_value` / `unrecognized_keys`…）。
   *
   * ★ 留着它是为了把失败原因翻成**人话**：`message` 是 zod 生成的英文
   *   （"Invalid option: expected one of …"），而这段文字会一路进到使用者
   *   看到的地方——判决的 `escalateReason` 与通知标题。真实出现过的一次：
   *   使用者看到的"需要人工的原因"是一屏 zod 英文，完全不知道该怎么办。
   */
  code?: string
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
      code: i.code,
    })),
  }
}

/**
 * 把校验错误整理成**人话**，用于判决的 `escalateReason` 与通知标题。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不能直接用 zod 的 `message`
 * ══════════════════════════════════════════════════════════════════
 *
 * 这段文字会出现在使用者眼前（"为什么需要人工"），而 zod 的原文是英文、
 * 而且一次能刷出十几条。真实发生过：一次审核的失败原因是一屏
 * `Invalid option: expected one of "meets_criteria"|…；findings.0.evidence:
 * Too big: expected string to have <=20 characters…`——使用者只能看到
 * "出错了"，看不出**该改什么**。
 *
 * 所以按 zod 的 issue code 翻成中文，并**限量**（超出的只说还有多少处）。
 * 原文并没有丢：它仍在日志与判决详情里（那条链路是给排查用的）。
 */
export function formatVerdictIssues(issues: readonly VerdictIssue[]): string {
  if (issues.length === 0) return '判决不符合 schema'
  const MAX = 6
  const parts = issues.slice(0, MAX).map((issue) => {
    const where = issue.path.length ? issue.path.join('.') : '顶层'
    return `${where}：${humanizeIssue(issue)}`
  })
  const rest = issues.length > MAX ? `（另有 ${issues.length - MAX} 处同类问题）` : ''
  return parts.join('；') + rest
}

/** 一条 zod issue → 一句中文（认不出来时保留原文，不要编）。 */
function humanizeIssue(issue: VerdictIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      // zod 把"缺字段"也报成 invalid_type（received undefined）
      return issue.message.includes('undefined')
        ? '这个字段是必填的，但判决里没有'
        : '类型不对'
    case 'invalid_value':
    case 'invalid_enum_value':
      return '取值不在允许范围内（可用的取值见任务说明里的字段规则）'
    case 'unrecognized_keys':
      return '多出了不允许的字段（判决是闭合的，只能有规则里列出的那些）'
    case 'too_big':
      return '太长了'
    case 'too_small':
      return '为空或太短'
    case 'invalid_format':
      return '格式不对'
    default:
      return issue.message
  }
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

    // ══════════════════════════════════════════════════════════════════
    // ★ 把"结尾又写成了开头"当作结尾
    // ══════════════════════════════════════════════════════════════════
    //
    // 真实发生过**两次**（同一批任务的两条审核）：模型给出的判决内容完全合法，
    // 但结尾写的是 `<<<ALPHA_VERDICT>>>` 而不是 `<<<END_ALPHA_VERDICT>>>`
    // ——于是这里判"有 BEGIN 无 END"，整条判决作废，人还得去处理。
    //
    // 这个围栏是**我们自己的约定**（不是模型世界的格式），因为抄错一个结尾标记
    // 就丢掉一份做得很好的审核，代价明显不对等。所以：块的结束取**下面两者中
    // 更早出现的那个**——
    //   - 正确的结尾标记；或
    //   - 又一个开头标记（模型显然是想收尾，只是抄错了）。
    //
    // 这仍然是**确定性切片**（不是"在自由文本里捞 JSON"）：只认这两个标记，
    // 顺序与位置都是确定的。
    const endCorrect = text.indexOf(VERDICT_FENCE_END, bodyStart)
    const endRepeated = text.indexOf(VERDICT_FENCE_BEGIN, bodyStart)
    const end =
      endCorrect === -1
        ? endRepeated
        : endRepeated === -1
          ? endCorrect
          : Math.min(endCorrect, endRepeated)
    if (end === -1) break // 两个都没有：半个块，不作为有效判决

    found = text.slice(bodyStart, end).trim()
    searchFrom = end + (end === endCorrect ? VERDICT_FENCE_END.length : VERDICT_FENCE_BEGIN.length)
  }

  return found
}

/** 让模型照此格式输出（供 skill 与上下文块生成使用）。 */
export function renderVerdictInstruction(): string {
  // ══════════════════════════════════════════════════════════════════
  // ★ 枚举与示例都**从 schema 本体生成**，不手写
  // ══════════════════════════════════════════════════════════════════
  //
  // 这条指令以前只给一个**空骨架**：
  //
  //     { "schemaVersion": 1, "conclusion": "...", "reasonCode": "...",
  //       "findings": [], "action": null, "escalateReason": null }
  //     约束：reasonCode 必须是协议里的枚举值
  //
  // 于是模型**无从知道**枚举有哪些取值、`findings[]` 里该放什么。真实后果
  // （一次真实任务的两次审核，两个都失败）：
  //
  //   - 第一次：模型在工具调用里反复说 "The enum isn't defined anywhere
  //     accessible"，翻遍了工作目录与别处的文件去找 reasonCode 的取值，
  //     最后没能给出判决块（判 `invalid`）；
  //   - 第二次：它猜了 `reasonCode: "ok"`，并把 findings 写成自己发明的形状
  //     （`{kind, target, evidence: 长字符串}`）⇒ schema 拒绝 ⇒ 降级，
  //     而且失败原因是一大段 zod 英文。
  //
  // **那是我们的缺陷，不是模型不够聪明**：我们要一个严格闭合的对象，
  // 却只画了个轮廓。现在把枚举、字段规则、以及一个**能通过校验的完整示例**
  // 都写进去——示例由测试守着"必须 parseVerdict 通过"，所以它不会漂。
  const list = (values: readonly string[]): string => values.join(' | ')
  const example: Verdict = {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    conclusion: 'fail',
    reasonCode: 'missing_tests',
    confidence: 0.8,
    findings: [
      {
        severity: 'high',
        summary: '产出里没有测试文件',
        evidence: [{ blobRef: null, locator: '报告第 3 段', excerpt: '我忘了写测试' }],
        detail: { suggestion: '补一个最小的测试文件' },
      },
    ],
    action: {
      type: 'comment.create',
      params: { issueId: '<关联 issue 的 id>', body: '缺少测试，请补上' },
    },
    escalateReason: null,
  }

  return [
    '把最终判决写成**一个** JSON 对象，放在下面这对标记之间。',
    '围栏之外可以写解释，但**判决本体只能有一份**，且必须在这一对标记之间：',
    `- 开头标记：\`${VERDICT_FENCE_BEGIN}\``,
    `- 结尾标记：\`${VERDICT_FENCE_END}\` —— ⚠️ 注意结尾那个**带 \`END_\` 前缀**，`,
    '  不要把它也写成开头标记（这个错会让整条判决作废，你前面的工作就白做了）',
    '',
    VERDICT_FENCE_BEGIN,
    JSON.stringify(example, null, 2),
    VERDICT_FENCE_END,
    '',
    // ★ 回答语言可能不是中文（D39）——但**判决本身是机器值**，字段名与取值
    //   一律照抄。不加这句的话，模型会"顺手翻译"，那份判决整条作废。
    '⚠️ 下面这些字段名与取值**照原样写**，不要翻译成别的语言（它们是机器读的）。',
    '',
    '字段规则（判决是**闭合**的：**多**一个字段名会整条不合规）：',
    '',
    '⭐ 上面这份示例是 `fail`（所以有 `action`）。**`action` / `findings` / `escalateReason`',
    '   都可以省略**——省略与写 `null` 等价，不会因此被判不合规。最小的一份合法判决长这样：',
    '   `{ "schemaVersion": 1, "conclusion": "pass", "reasonCode": "meets_criteria", "confidence": 0.9 }`',
    '   （`pass` 不需要 action 或 escalateReason；`fail` 必须给 action；`needs_human` 必须给 escalateReason）',
    '',
    `- \`conclusion\`：${list(VerdictConclusion.options)}`,
    `- \`reasonCode\`：**必须**是其中之一 —— ${list(ReasonCode.options)}`,
    `- \`confidence\`：0 到 1 之间的小数`,
    `- \`findings[]\`：每项都要有 \`severity\`（${list(Severity.options)}）、`,
    '  \`summary\`（一句话，必填）；可选 \`evidence\` 与 \`detail\`',
    '- \`evidence\` 是**数组**，每项是一个对象 \`{ "blobRef": null, "locator": "…", "excerpt": "…" }\`',
    '  （最多 20 项；\`excerpt\` 不超过 1000 字）——**不要**把证据写成一整段字符串',
    '- \`detail\` 是**唯一**可以自由发挥的字段（一个对象）；其余字段名一个都不能多',
    `- \`action\`：\`fail\` **必须**给出（其余结论可以不写），形如 \`{ "type": "…", "params": { … } }\`，`,
    `  \`type\` 取：${list(ActionType.options)}`,
    '- \`escalateReason\`：\`needs_human\` 必须给出（一句话说清缺什么）',
    '- \`schemaVersion\` 固定为 1',
    '',
    '⭐ 拿不准取值时**宁可选 `needs_human`**，也不要去编一个字段名或枚举值：',
    '   编出来的东西会被判为"格式不合规"，整条判决作废——而你本来想说的结论也一起丢了。',
  ].join('\n')
}
