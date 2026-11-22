import type { Agent } from './api.ts'

/**
 * 表单用的**空白智能体**（2026-11，D249）。
 *
 * 为什么需要它：新建与编辑合成同一个组件（`AgentForm.svelte`，`mode='create' | 'edit'`）
 * 之后，新建态也得交出一个 `agent`——组件里到处是 `agent.name` / `agent.skillIds`
 * 这种读法（它们是"库里那一份"，用来算 patch、算只读态），把 `agent` 做成可空会让
 * 几百行都要加 `?.`。
 *
 * 所以新建态交一份**空白**的：`id` 是空串 ⇒ 所有"要打接口"的地方（读记忆、读独有技能、
 * 目录一节）都被 `isNew` 挡住，不会拿空 id 去请求 `/api/agents/`。
 *
 * ⚠️ 只在 `mode='create'` 下用。它**不是**一个真实智能体：`owner` / `builtin` / `slot`
 * 全部缺省 ⇒ 各处的"平台成员 / 只读 / 出厂槽位"判断都是 false，正是新建态该有的样子。
 */
export function blankAgent(): Agent {
  return {
    id: '',
    name: '',
    instructions: '',
    workDir: null,
    skillIds: [],
    model: null,
    runtimeKey: 'default',
    reviewStandard: null,
    entries: [],
    memoryEnabled: false,
  }
}
