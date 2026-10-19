/**
 * run 消息 → 文本（2026-10-19 四轮抽出来的）。
 *
 * 为什么单独一个模块：素材落盘（`crystallize-material.ts`）与沉淀的其他地方都要把
 * run 的消息渲染成给人看/给 agent 读的文本。这段渲染原来住在 `crystallize.ts` 里，
 * 而素材模块又要被起草流程复用——两边互相 import 就成环。渲染逻辑与"沉淀"没有关系，
 * 放这里，谁都能用，且"消息怎么变成文本"只有这一处。
 *
 * 口径不变（与任务详情页一致）：产出 = **最后一条**非空 text 消息，不拼接。
 */

export interface RunMessageView {
  seq: number
  type: string
  tool: string | null
  content: string
  input: Record<string, unknown> | null
  output: string | null
}

/**
 * 把一条 run 的消息渲染成文本。
 *
 * ⚠️ 工具调用与结果**不能省**：提炼"怎么做"依赖真实的命令与输出，只给对话文本
 * 会让起草者写出幻觉步骤（设计 §4.1 的硬要求）。
 */
export function formatRunMessages(runId: string, messages: RunMessageView[]): string {
  const lines: string[] = []
  void runId
  for (const m of messages) {
    switch (m.type) {
      case 'text':
        lines.push(`[消息] ${m.content}`)
        break
      case 'tool_use':
        lines.push(`[工具调用] ${m.tool ?? '(未知)'}`)
        if (m.input && Object.keys(m.input).length > 0) {
          lines.push(`  入参：${JSON.stringify(m.input)}`)
        }
        break
      case 'tool_result':
        lines.push(`[工具结果] ${m.content}`)
        if (m.output && m.output !== m.content) lines.push(`  输出：${m.output}`)
        break
      case 'thinking':
        // 思考过程对"怎么做"有价值，但噪音大——压缩成一行说明存在。
        lines.push(`[思考] ${m.content.slice(0, 200)}${m.content.length > 200 ? '…' : ''}`)
        break
      default:
        // status/error/log：过程信息，保留简短内容（错误可能是重要线索）。
        if (m.type === 'error') lines.push(`[错误] ${m.content}`)
        break
    }
  }
  return lines.join('\n')
}

/** 一条 run 的产出 = **最后一条**非空 text 消息（与任务详情页同一口径）。 */
export function lastTextOf(
  messages: Array<{ type: string; content: string }>,
): string | null {
  let last: string | null = null
  for (const m of messages) {
    if (m.type === 'text' && m.content.trim() !== '') last = m.content
  }
  return last
}
