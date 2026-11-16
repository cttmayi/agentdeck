/**
 * `@agentdeck/domain` —— 领域模型层。
 *
 * 依赖方向（design §3.1）：只依赖 `protocol`，不依赖任何存储适配器。
 * 存储能力以**端口**（`ports/store.ts`）的形式声明，由外层适配器实现。
 */

export * from './errors.ts'
export * from './ports/store.ts'
export * from './state/run.ts'
/*
 * ⚠️ 2026-11（D125）：`./state/verdict.ts`（判决状态机与合法迁移表）随判决一起删。
 */
/*
 * ⚠️ 2026-11（D123）：这里原来是 `export * from './state/action.ts'`（动作状态机：
 *   `canTransitionAction` / `assertActionTransition`）。动作记录退场之后状态机没有
 *   使用对象，文件一并删。
 */
/*
 * ⚠️ 2026-11（D125）：这里原来是 `export * from './review/distinct.ts'`（INV-1：
 *   审核者必须不同于执行者）。审核 run 退场 ⇒ 没有"审核者"这个角色可判，文件删。
 *   ⚠️ 它守的那个洞值得记住：不变量实现好了、注释也写了"要在写入前拦"，
 *   **但那个调用点从来没被接上**——全仓只有它自己的测试在引用。
 */
/*
 * ⚠️ 2026-11（D125）：`./review/pipeline.ts`（`decideReview`：把一份判决分成
 *   记录 / 交给人 / 重试 / 降级 / 升级几档）随审核 run 与判决一起删。
 */
/*
 * ⚠️ 2026-11（S3）：这里原来是 `export * from './groups/shape.ts'`（`checkGroupShape`：
 *   组形态必须恰好 1 执行 + 1 审核）。智能体组退场 ⇒ 文件删。
 *   ⚠️ 那条判据的好做法留着：**在写入前把"最终形态"算出来校验**，而不是建完再回滚。
 */
/*
 * ⚠️ 2026-11（D125）：这里原来是 `export * from './loop/bounds.ts'`（回路边界
 *   INV-14~16：`detectChainLoop` / `DEFAULT_MAX_CHAIN_DEPTH` 那一组纯函数）。
 *   它唯一的输入是"判决 → 动作 → 新 run"这条链的深度与去重键——动作与判决都退场
 *   之后**没有生产者**，`DEFAULT_MAX_CHAIN_DEPTH` 也从 `autoChainReview` 里消失了。
 *   留着它就是一处"看起来还有回路保护"的死接口。
 *
 *   ⚠️ 那条判断仍然成立：**会自我维持的环**在没有边界时迟早烧掉大量 token 并把看板
 *   刷满，而且往往要几轮之后才看得出来。将来任何"run 能派生 run"的能力都该先把
 *   边界接上再上线。
 */
/*
 * ⚠️ 2026-11（D123）：这里原来是 `export * from './loop/chain.ts'`（链路重建：
 *   `loadChainSteps` / `withCurrentVerdict` / `depthFromChain`）。它唯一的边走的是
 *   `run.derivedFrom → action → verdict → 上一个 run`，而动作记录退场之后
 *   `derivedFrom` 再也没有写入者——那条走法一步都走不通，模块整个删掉。
 *   ⚠️ 它本来就**没有生产调用点**（`review.ts` 里 `chainSteps` 早已删）。
 *   环检测那几条纯函数仍在 `./loop/bounds.ts`：它们是**能力的规定**（INV-14~16），
 *   不依赖动作，等 S2 处理返工/链深时再一并收。
 */
export * from './routing/kind.ts'
export * from './audit/record.ts'
export * from './audit/export.ts'
export * from './audit/snapshot.ts'
