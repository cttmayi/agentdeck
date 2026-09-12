import { renderVerdictInstruction } from '@alpha-helper/protocol'

/**
 * 受管上下文块的内容生成（FR-CLI-31/32/43）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 两个反直觉的决定
 * ══════════════════════════════════════════════════════════════════
 *
 * **① 技能清单只列名字，不列描述**（FR-CLI-31）
 *    Claude Code 自己会扫技能目录、生成一份**带描述**的清单。我们在上下文里
 *    再列一遍描述，等于把模型已经有的东西买两遍——参考材料实测这部分约占
 *    3100 token、占全文 40%，而且**不提供额外的路由信号**。
 *
 *    但清单本身要留：它是**唯一一份平台能控制的**技能清单。各家 CLI 自己的
 *    清单是它们的东西，格式甚至是否存在都可能随版本变。
 *
 * **② 判决格式用围栏约定，不用"请输出 JSON"**（FR-CLI-44/45）
 *    自由文本里"捞 JSON"既不可靠也不可测。所以给一对明确标记，
 *    让提取变成一次确定性切片；不合规就走 invalid 路径，**不做任何修复**。
 */

export interface SkillBrief {
  slug: string
  name: string
  /** 审核标准正文。 */
  body: string
}

export interface ExecuteTaskContextInput {
  kind: 'execute'
  runId: string
  subject: { type: string; id: string }
  prompt: string
  skills: readonly SkillBrief[]
}

export interface ReviewTaskContextInput {
  kind: 'review'
  runId: string
  subject: { type: string; id: string }
  /** 审核对象的内容。 */
  report: { kind: string; title: string; body: string }
  /** 这个 agent 挂载的审核标准。 */
  skills: readonly SkillBrief[]
  /** 关联的 issue —— 动作参数需要它（见协议里的说明）。 */
  relatedIssueId?: string | null
}

export type TaskContextInput = ExecuteTaskContextInput | ReviewTaskContextInput

/**
 * 渲染受管块的内容。
 *
 * 刻意保持精简：这块内容**每一轮都会被读**，塞进去的每一行都按轮计费。
 */
export function renderTaskContext(input: TaskContextInput): string {
  return input.kind === 'review' ? renderReview(input) : renderExecute(input)
}

function renderSkillIndex(skills: readonly SkillBrief[]): string[] {
  if (skills.length === 0) return []
  return [
    '## 可用技能',
    '',
    // ★ 只列名字：描述由 CLI 自己的清单提供，重复一遍没有额外信号
    skills.map((s) => `- \`${s.slug}\``).join('\n'),
    '',
  ]
}

function renderExecute(input: ExecuteTaskContextInput): string {
  const lines = [
    '# 任务（由 alpha-helper 自动管理）',
    '',
    `- run：\`${input.runId}\``,
    `- 对象：${input.subject.type} \`${input.subject.id}\``,
    '',
    '## 要做的事',
    '',
    input.prompt,
    '',
    ...renderSkillIndex(input.skills),
    '## 护栏',
    '',
    '- 只做上面描述的事，不要扩大范围。',
    '- 完成后给出一份**报告**：做了什么、结论是什么、还有哪些不确定的地方。',
  ]
  return lines.join('\n')
}

function renderReview(input: ReviewTaskContextInput): string {
  const lines = [
    '# 审核任务（由 alpha-helper 自动管理）',
    '',
    `- run：\`${input.runId}\``,
    `- 对象：${input.subject.type} \`${input.subject.id}\``,
    `- 类型：\`${input.report.kind}\``,
    ...(input.relatedIssueId ? [`- 关联 issue：\`${input.relatedIssueId}\``] : []),
    '',
    '## 待审核的内容',
    '',
    input.report.title ? `### ${input.report.title}` : '',
    '',
    input.report.body,
    '',
  ]

  if (input.skills.length > 0) {
    lines.push('## 审核标准', '')
    for (const skill of input.skills) {
      lines.push(`### ${skill.slug}${skill.name && skill.name !== skill.slug ? `（${skill.name}）` : ''}`, '')
      lines.push(skill.body.trim(), '')
    }
  }

  lines.push(
    '## 输出要求',
    '',
    // ★ schema 随 skill 一同下发——不能指望模型自己猜格式（FR-CLI-43）
    renderVerdictInstruction(),
    '',
    '## 护栏',
    '',
    '- 严格按上面的审核标准判断，不要引入标准之外的要求。',
    '- 证据必须能指回待审核内容里的具体位置。',
    '- **拿不准就选 `needs_human` 并说明原因**，不要硬猜一个结论。',
    '- 不要修改任何文件，这是一次只读审核。',
  )

  return lines.filter((line) => line !== undefined).join('\n')
}
