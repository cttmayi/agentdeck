/**
 * `@agentdeck/domain` —— 领域模型层。
 *
 * 依赖方向（design §3.1）：只依赖 `protocol`，不依赖任何存储适配器。
 * 存储能力以**端口**（`ports/store.ts`）的形式声明，由外层适配器实现。
 */

export * from './errors.ts'
export * from './ports/store.ts'
export * from './state/run.ts'
export * from './state/verdict.ts'
export * from './state/action.ts'
export * from './review/distinct.ts'
export * from './review/pipeline.ts'
export * from './groups/shape.ts'
export * from './loop/bounds.ts'
export * from './loop/chain.ts'
export * from './routing/kind.ts'
export * from './actions/definition.ts'
export * from './actions/tool-actions.ts'
export * from './audit/record.ts'
export * from './audit/export.ts'
export * from './audit/snapshot.ts'
