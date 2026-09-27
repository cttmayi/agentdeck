import type { ExecOptions } from '@agentdeck/agent-core'

/**
 * 假后端眼里的"它被交代了什么"——**两块合起来**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 2026-09 三块组装之后，这一行成了每个假后端都必须做的事
 * ══════════════════════════════════════════════════════════════════
 *
 * 投递分两块（见 `first-sentence.ts`）：
 *
 *   · **A 档**（runtime 支持系统提示）：① 框架 + ② 身份 → `systemPrompt`，③ 任务 → `prompt`；
 *   · **B 档**：三块合成一段，全在 `prompt` 里。
 *
 * 于是"这段是不是一次审核？"（假后端靠 `# 审核任务` / 判决契约来判）在 A 档下
 * **不在 `prompt` 里**——只读 `opts.prompt` 的假后端会认不出审核，进而永远不产出
 * 判决，测试表现成**十几秒超时**（实测踩过：四条动作相关的 e2e 一起红）。
 *
 * 所以假后端一律用这个函数取"全部内容"，不要自己拼。
 */
export function deliveredText(opts: Pick<ExecOptions, 'prompt' | 'systemPrompt'>): string {
  return [opts.systemPrompt ?? '', opts.prompt].filter((p) => p !== '').join('\n\n')
}
