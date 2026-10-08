/**
 * `@agentdeck/protocol` —— 全项目契约的**单一来源**。
 *
 * 这个包不依赖任何内部包（design §3.1 的依赖方向）。daemon、页面、远端
 * 三方都从这里取枚举、实体与接口契约，因此不存在"两边各写一套然后漂移"
 * 的可能（INV-18、FR-REVIEW-12）。
 */

export * from './enums.ts'
export * from './ids.ts'
export * from './tools.ts'
export * from './verdict.ts'
export * from './entities.ts'
export * from './agent-legacy.ts'
export * from './local-api.ts'
