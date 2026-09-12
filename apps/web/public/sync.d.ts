/**
 * `sync.js` 的类型声明。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么给一个"零构建"的原生模块配 .d.ts
 * ══════════════════════════════════════════════════════════════════
 *
 * `public/` 下的东西是**直接交给浏览器**的 ES 模块，故意不走构建。
 * 但它们的**纯逻辑部分**（设定怎么夹、队列怎么涨、上报包里有没有正文）
 * 是值得测的，而测试跑在 Node + TypeScript 下。
 *
 * 所以这里只声明测试要用的那些导出，而不是把 `public/` 整个拉进类型检查——
 * 那会要求给浏览器代码写全套类型，与"零构建"的取舍相冲突。
 *
 * ⚠️ 这个文件**不会被托管**：静态资源走白名单（`src/index.ts` 的 `ALLOWED`），
 *    只有列在里面的文件名才发得出去。
 */
export declare const DEFAULT_POLL_INTERVAL_MS: number
export declare const MIN_POLL_INTERVAL_MS: number
export declare const MAX_POLL_INTERVAL_MS: number
export declare const DEFAULT_SETTINGS: Record<string, unknown>

export interface SyncSettings {
  pollIntervalMs: number
  reportingEnabled: boolean
  aggregateOnly: boolean
}

export declare function readSyncSettings(settings: unknown): SyncSettings
export declare function readQueue(): Array<Record<string, unknown>>
export declare function enqueue(records: unknown[]): number
export declare function clearQueue(): void
export declare function collectRecords(
  issues: unknown[],
  runs: unknown[],
): Array<Record<string, unknown>>
export declare function runSyncCycle(options?: unknown): Promise<Record<string, unknown>>
export declare function startSyncLoop(options: unknown): { stop: () => void }
