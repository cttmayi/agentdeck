/**
 * **智能体生成者的约定**（2026-11；D109 起，D256 改形状）。
 *
 * 生成者不再写"一张岗位卡 md"，而是把候选智能体**写成存储的形状**（一个候选 = 一个目录）：
 *
 *   <工作目录>/agent-draft/<岗位名>/
 *     agent.json      { name?, runtimeKey? }
 *     instructions.md 那段唯一正文
 *     skills/<技能名>/SKILL.md   可选：它自己带的配套技能（可以 0 条）
 *
 * 于是这里只剩下**一个常量**：候选包目录名（与「编排生成者」的 `workflow-draft/` 对称）。
 * 读与校验在 `agent-candidate.ts`，入库在 `agent-adopt.ts`。
 *
 * ⚠️ D256 删掉的东西（别再写回来）：
 *   · `parseAgentDraft` / `readAgentDraftArtifacts`：旧的"岗位卡 md + `skill/` 目录"格式废止——
 *     产物就是存储形状，不需要从一种格式翻译成另一种；
 *   · `GET …/agent-draft` 与 `POST …/agent-commit` 两条路由：换成候选预检与入库；
 *   · `agent-draft.md` 这个文件名：老文件留在磁盘上不动，但不再被读（只认目录）。
 */

/** 生成产物的候选包目录（工作目录下的 `agent-draft/`；一个候选 = 一个子目录）。 */
export const AGENT_DRAFT_DIR = 'agent-draft'
