/**
 * **编排生成者的约定**（2026-11；D135 起，D255 改形状）。
 *
 * 生成者不再写"一张草稿 md"，而是把候选编排**写成存储的形状**（一个候选 = 一个目录）：
 *
 *   <工作目录>/workflow-draft/<编排名>/
 *     workflow.json      { name, summary }           ← 结构化（不含代码）
 *     main.js            编排代码（= Workflow.code）
 *     agents/<名字>/     内建智能体：agent.json + instructions.md（+ 自己的 skills/…）
 *
 * 于是这里只剩下**两个常量**：暂存目录名、作用域里合法的原语名。
 * 解析/校验在 `workflow-candidate.ts`（读目录 + 四条校验），入库在 `workflow-adopt.ts`
 * （校验 + 整目录搬 + 补字段）。
 *
 * ⚠️ D255 删掉的东西（别再写回来）：
 *   · `parseWorkflowDraft` / `readWorkflowDraft`：旧的"frontmatter + 代码"草稿格式废止——
 *     产物就是存储形状，不需要从一种格式翻译成另一种（翻译就有两处形状要同步）；
 *   · `validateWorkflowCode`：名字校验从"库里有没有这个智能体"变成"本编排 `agents/` 下
 *     有没有这个人"，判据换了（`workflow-candidate.ts` 的 `checkCandidateCode`）；
 *   · 独有技能 `orchestration-authoring`：写法改成资料包（`docs/material/orchestration/`），
 *     技能是"播种一次就不再覆盖"的，而编排写法会变——留着它就是第二个真相。
 */

/** 生成产物的暂存根（工作目录下的 `workflow-draft/`；一个候选 = 一个子目录）。 */
export const WORKFLOW_DRAFT_DIR = 'workflow-draft'

/** 编排代码里允许出现的原语（与引擎 `AsyncFunction` 的参数表一字不差）。 */
export const WORKFLOW_PRIMITIVES = ['agent', 'gate', 'flow', 'parallel', 'loop', 'route'] as const
