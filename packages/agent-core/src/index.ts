/**
 * `@agentdeck/agent-core` —— Agent CLI 适配层的通用部分。
 *
 * 这里放**与具体 CLI 无关**的东西：runtime 描述表、禁改参数表、argv 组装、
 * 上下文块注入算法、以及适配器契约。具体 CLI 的实现放在各自的包里
 * （如 `@agentdeck/agent-claude`）。
 */

export * from './runtime-table.ts'
export * from './blocked-args.ts'
export * from './argv.ts'
export * from './first-sentence.ts'
export * from './backend.ts'
export * from './backend-base.ts'
export * from './service-backend.ts'
export * from './executable-check.ts'
export * from './process-tree.ts'
export * from './async-queue.ts'
export * from './probe.ts'
export * from './spawn-target.ts'
export * from './skill-injection.ts'

export * from './sandbox.ts'
export * from './version-support.ts'
export { cliStateDir } from './sandbox.ts'
