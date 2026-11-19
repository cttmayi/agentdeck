/**
 * **编排里按名字找人**（2026-11，D163）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要单独一个模块
 * ══════════════════════════════════════════════════════════════════
 *
 * 编排代码里写的是 `agent('撰稿员')`——**按名字**引用。而智能体的名字**不是唯一的**
 * （从来没有过唯一约束，改名也是使用者的自由）。于是"重名"这件事有两条路：
 *
 *   · **静默取第一个**（改之前的行为）：`agents.find(a => a.name === name)`。
 *     存储顺序 ≈ 创建先后 ⇒ 重名时永远命中"更早那条"，而**界面、采纳校验、运行日志
 *     都不会说这件事**。使用者看到的是"我明明选了新那条，怎么跑的是旧的"。
 *     这正是本仓库最忌讳的"看起来生效了"。
 *   · **拒绝歧义**（现在）：重名时**启动之前就报错**，并点名是哪几条（带 id 与归属），
 *     让人去改名。宁可跑不起来，也不要跑错人。
 *
 * ⚠️ 两处必须**同一句话**（否则就是"校验说行、跑起来必炸"）：
 *   · 采纳校验（`POST /api/conversations/:id/workflow-commit`）——写库之前；
 *   · 引擎解析（每个节点起 run 之前）——真跑的时候。
 *   两处都调这里的 `resolveWorkflowAgent()`。
 */

import type { Agent } from '@agentdeck/protocol'
import { canBeReferencedByWorkflow, ownerOf } from './platform-member.ts'

export type WorkflowAgentResolution =
  | { ok: true; agent: Agent }
  | { ok: false; error: string; code: 'agent_not_found' | 'agent_ambiguous' | 'agent_not_referenceable' }

/**
 * 把编排代码里的一个名字解析成**唯一**那条智能体。
 *
 * 三种失败各有各的处置（不要合成一句"找不到"）：
 *   · `agent_not_found`——没有这个名字；
 *   · `agent_ambiguous`——**有两条以上同名**（这就是本条模块存在的理由）；
 *   · `agent_not_referenceable`——名字唯一，但那条的接入点里没有 `workflow`
 *     （平台成员默认没有；D145 的"两处都约束"）。
 */
export function resolveWorkflowAgent(
  agents: ReadonlyArray<Agent>,
  name: string,
): WorkflowAgentResolution {
  const matches = agents.filter((a) => (a.name as string) === name)
  if (matches.length === 0) {
    return { ok: false, code: 'agent_not_found', error: `内嵌智能体不存在：${name}` }
  }
  if (matches.length > 1) {
    /*
     * 点名是**哪几条**：只给 id 太抽象，只给名字又分不清（名字本来就是一样的），
     * 所以"名字 + 归属"（平台的还是你的）——那就足以让人知道该改哪一条。
     */
    const which = matches
      .map((a) => `${ownerOf(a) === 'platform' ? '平台成员' : '你自己的'}（${a.id as string}）`)
      .join('、')
    return {
      ok: false,
      code: 'agent_ambiguous',
      error:
        `「${name}」有 ${matches.length} 条同名智能体：${which}——编排代码按名字引用，` +
        '重名时**不知道找的是哪一条**。请先给其中一条改名（智能体页 → 改名），再来跑。',
    }
  }
  const only = matches[0]!
  if (!canBeReferencedByWorkflow(only)) {
    return {
      ok: false,
      code: 'agent_not_referenceable',
      error:
        `「${name}」不能被编排引用——它的接入点里没有「被编排调用」（平台成员默认不给）。` +
        '换一个自己建的智能体。',
    }
  }
  return { ok: true, agent: only }
}

/**
 * 一段编排代码里**按字面量引用**的智能体名字（`agent('x')` / `agent("x")`）。
 *
 * ⚠️ 拼出来的（`agent(变量)`）数不清，这里**不猜**——与 D145 那条"宁可选校验不足"同一口径。
 */
export function literalAgentNamesInWorkflowCode(code: string): string[] {
  const out = new Set<string>()
  for (const m of code.matchAll(/agent\s*\(\s*(['"])([^'"]*)\1/g)) {
    const name = (m[2] ?? '').trim()
    if (name !== '') out.add(name)
  }
  return [...out]
}

/**
 * 采纳之前的**歧义体检**：代码里每个字面量名字都必须解析成唯一一条（且可被编排引用）。
 *
 * 返回第一处问题（一次只说一件，改完再来看下一件——与其它校验同一口径）。
 */
export function checkWorkflowAgentRefs(
  agents: ReadonlyArray<Agent>,
  code: string,
):
  | { ok: true }
  | { ok: false; error: string; code: 'agent_not_found' | 'agent_ambiguous' | 'agent_not_referenceable'; name: string } {
  for (const name of literalAgentNamesInWorkflowCode(code)) {
    const resolved = resolveWorkflowAgent(agents, name)
    if (!resolved.ok) return { ok: false, error: resolved.error, code: resolved.code, name }
  }
  return { ok: true }
}
