/**
 * `@agentdeck/protocol` —— 全项目契约的**单一来源**。
 *
 * 这个包不依赖任何内部包（design §3.1 的依赖方向）。daemon、页面、远端
 * 三方都从这里取枚举、实体与接口契约，因此不存在"两边各写一套然后漂移"
 * 的可能（INV-18、FR-REVIEW-12）。
 */

export * from './enums.ts'
export * from './ids.ts'
/*
 * ⚠️ 2026-11（D123）：这里原来有一行 `export * from './tools.ts'`（工具包清单与
 *   `Tool` 实体）。工具包与动作能力一起退场，那份文件删了。
 */
/*
 * ⚠️ 2026-11（D125）：这里原来有一行 `export * from './verdict.ts'`（判决 schema、
 *   `parseVerdict`、围栏标记、`foldVerdict`、`stripVerdictBlocks`、`ActionRef`）。
 *   审核 run 与判决一起退场，那份文件删了。
 */
export * from './entities.ts'
export * from './agent-legacy.ts'
export * from './local-api.ts'
