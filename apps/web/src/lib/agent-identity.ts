/**
 * 一个审核者**有没有判断依据** —— 界面侧的那份判据。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么它必须是一个函数，而不是写在标记里的一句条件
 * ══════════════════════════════════════════════════════════════════
 *
 * 这条判据决定"要不要在详情页顶上挂一条红警告"。它写错过一次，而且错得很典型：
 *
 *   条件是 `isReviewer && !agent.reviewStandard && agent.skillIds.length === 0`
 *   —— 两半都在看**老形态**（内联标准字段、挂载的 skill）。而 2026-09 之后判断
 *   依据并进了 ② 身份（= `Agent.instructions`），于是一个**完全正常**的审核者
 *   （写了指令、没标准字段、也没挂 skill）会被挂上
 *
 *     「它审不了任何东西：没有审核标准，平台不会把产出交给它审。点「编辑」写一条。」
 *
 *   而它其实审得好好的。**一个指向不存在的故障的警告比没有警告更糟**：使用者会去
 *   找一个不需要修的问题（这条链路上已经发生过一次——列表里那个「未挂 skill」
 *   徽标就是因为同一类过时判据被整段删掉的，见 `views/Agents.svelte`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它与另外两份判据的关系（必须同向，不许各自演化）
 * ══════════════════════════════════════════════════════════════════
 *
 *   · 域层 `packages/domain/src/routing/kind.ts` 的 `hasReviewIdentity` —— **粗筛**
 *     （报告路由用它决定"这份报告有没有人审"）；
 *   · daemon 的 `reviewerIdentity(...).text !== ''`（`review-standard.ts`）——
 *     **真判据**（派发审核前那一关，它还能看见 skill 的正文）。
 *
 * 三处收三种形态，缺一种就会把某一代数据打回"没人审"或"明明能审却报警"：
 *   ① `instructions` 非空 —— 新形态（依据并进「指令」）；
 *   ② `reviewStandard.body` 非空 —— D37 那一代（内联标准）；
 *   ③ 挂了 skill —— 更早的形态（正文住在 skill 里，界面看不到正文，所以只能认"挂了"）。
 *
 * ⚠️ 界面这份是**粗判**：它手里没有 skill 的正文，所以第 ③ 种一律算"有依据"。
 *    宁可漏报也不要误报——误报会让人去修一个不存在的问题。
 */
export interface IdentityBearingAgent {
  instructions?: string | null
  reviewStandard?: { body?: string | null } | null
  skillIds?: readonly string[]
}

export function hasReviewIdentity(agent: IdentityBearingAgent): boolean {
  if ((agent.instructions ?? '').trim() !== '') return true
  if ((agent.reviewStandard?.body ?? '').trim() !== '') return true
  return (agent.skillIds ?? []).length > 0
}
