/**
 * **迁移账本**（D230，2026-11）——`<dataDir>/migrations.json`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有它
 * ══════════════════════════════════════════════════════════════════
 *
 * 到 2026-11 为止，开库时的迁移各用各的判据：标记文件（`agents/.migrated`）、
 * "老文件还在吗"（memory / skills / workflows / schedules）、"老目录还在吗"
 * （D229 的 `SKILL/`）。三种约定都对，但有一个共同的毛病：
 *
 *   **每次启动都要重新判断一遍。** 单个判据很便宜（一两次 stat），可迁移会越加越多——
 *   加到二十个，就是每次启动二十来次目录扫查，而且**未来每加一个迁移都要问一遍
 *   "这个判据贵不贵"**。
 *
 * 账本就是把这个"判断"本身记下来：**跑过的迁移记一条，之后启动只读一个文件。**
 * 启动成本从此与"历史上做过多少迁移"**脱钩**——这是这一层唯一的目的。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条纪律
 * ══════════════════════════════════════════════════════════════════
 *
 *   ① **迁移本身仍然必须幂等**。账本是加速层，不是正确性来源：有人手工删掉
 *      `migrations.json`（或从备份恢复），迁移就该能再跑一遍而不做错事。
 *   ② **版本化**：键 + `v`。同一个 key 的 `v` 升了 ⇒ 再跑一次（"这条迁移改过规则"），
 *      这样"重跑"不必靠删文件。
 *   ③ **坏了当空、但要说话**：账本读不出来 ⇒ 当作一条都没记（迁移重跑，只是慢一次），
 *      并把原因打出去。静默返空会让"迁移每次都跑"变成一个没人查得清的谜。
 */

import { join } from 'node:path'
import { atomicWrite, readJsonOrNull } from './fs-utils.ts'

/** 一条迁移的记录。 */
export interface MigrationRecord {
  /** 迁移规则的版本。升版本 = 要再跑一次。 */
  v: number
  /** 什么时候跑完的（epoch ms）。 */
  at: number
}

/** 账本文件里存的东西：`{ [key]: record }`。 */
type LedgerFile = Record<string, MigrationRecord>

/**
 * 一次迁移的声明（调用方按它判断"跑过没有"）。
 *
 * `key` 一经发布**不许改**（改了就等于新迁移，会再跑一遍）；`version` 在"迁移规则
 * 变了、老数据还得再处理一次"时 +1。
 */
export interface MigrationSpec {
  key: string
  version: number
}

/** 账本文件的落点。 */
export function migrationsPath(dataDir: string): string {
  return join(dataDir, 'migrations.json')
}

/**
 * 迁移账本（内存里一份 + 落盘一份）。
 *
 * ⚠️ 只在 `FileStore.open()` 里用。**不要在别处自己读写这个文件**：漏一条、写一条
 * 半截，都会让"迁移跑没跑过"变成两个出处。
 */
export class MigrationLedger {
  readonly #path: string
  readonly #records: LedgerFile
  readonly #onInfo: (message: string) => void

  private constructor(path: string, records: LedgerFile, onInfo: (m: string) => void) {
    this.#path = path
    this.#records = records
    this.#onInfo = onInfo
  }

  /**
   * 读账本。**读不出来当空**（并把原因报出去）：账本是加速层，坏掉最多让迁移重跑一次，
   * 不该让存储打不开。注意读坏的那份**先留档**再覆盖——那是唯一能看出"为什么它坏了"的东西。
   */
  static async load(dataDir: string, onInfo: (m: string) => void = () => {}): Promise<MigrationLedger> {
    const path = migrationsPath(dataDir)
    let records: LedgerFile = {}
    try {
      const raw = await readJsonOrNull<unknown>(path)
      if (raw !== null) {
        if (typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            const rec = value as MigrationRecord | null
            if (rec && typeof rec.v === 'number' && typeof rec.at === 'number') {
              records[key] = { v: rec.v, at: rec.at }
            }
          }
        } else {
          onInfo(`迁移账本 ${path} 形状不对（不是对象）⇒ 当作一条都没记；迁移会重跑一遍`)
        }
      }
    } catch (err) {
      onInfo(`迁移账本 ${path} 读不出来（当作一条都没记，迁移会重跑一遍）：${String(err)}`)
    }
    return new MigrationLedger(path, records, onInfo)
  }

  /** 这条迁移**跑过没有**（版本不够也算没跑过）。纯内存判断，不碰磁盘。 */
  has(spec: MigrationSpec): boolean {
    const rec = this.#records[spec.key]
    return rec !== undefined && rec.v >= spec.version
  }

  /**
   * 记下"这条迁移跑完了"。**立刻落盘**（原子写）——不要攒到最后再写：
   * 迁移中途崩掉时，已经跑完的那几条应该算数，否则下次启动要白跑一遍。
   */
  async mark(spec: MigrationSpec): Promise<void> {
    this.#records[spec.key] = { v: spec.version, at: Date.now() }
    await atomicWrite(this.#path, `${JSON.stringify(this.#records, null, 2)}\n`)
  }

  /** 当前记了哪些（测试与排查看；生产代码别拿它做判断，用 `has`）。 */
  keys(): string[] {
    return Object.keys(this.#records).sort()
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 已登记的迁移（**唯一清单**）
 * ══════════════════════════════════════════════════════════════════
 *
 * ⚠️ 加一个迁移 = 判断它属于下面哪一档，然后照那个档的规矩来：
 *
 *   **判据贵 ⇒ 用账本门住**（登记在这里；`FileStore.open()` 里 `if (!ledger.has(...))`）。
 *     贵 = 要扫目录、要读多个文件、成本随数据量涨。
 *
 *   **判据便宜 ⇒ 不门住**（不进这张表；每次启动照跑）。
 *     便宜 = 一次 `stat`、或一次内存遍历。**门住它们反而是错的**：账本一旦被删/丢，
 *     或者有人从备份恢复了一份老数据，迁移就再也不会为它跑一次。
 *     现在属于这一档的有（都写在各自的函数注释里）：
 *       · `agents-to-dirs`（D111）—— `agents/.migrated` 标记，一次 stat；
 *       · `memory-to-agent-dirs`（D112）—— 每个工作区一次 `stat`；
 *       · `skills-to-disk`（2026-10）—— 内存里遍历技能记录看有没有 `body`；
 *       · 编排 / 定时任务 / workspace 那三处（`apps/daemon`）—— 判断"老文件还在吗"，一次 `stat`。
 *
 * 所以今天真正被门住的是两条（`agent-dir-names` 与 `exclusive-skills-dir-case`）：它们都要 `readdir` 全部智能体目录。
 * 账本真正的价值在**以后**：新迁移若判据贵，登记一个 key 就再也不摊启动成本；
 * 而"已登记了哪些"本身也是一份可查的账（`keys()`）。
 */
export const MIGRATIONS = {
  /**
   * 智能体目录名从 **id** 改成 **名字的 slug**（D231，方案 D）。
   *
   * 判据是 `readdir(agents/)` + 读每个 `agent.json`（要算 slug 才知道该不该改）——
   * 随智能体数量线性涨，且只在改目录名的那一次有意义，所以门住。
   */
  agentDirNames: { key: 'agent-dir-names', version: 1 },
  /**
   * 独有技能目录 `SKILL/` → `skills/`（D229）。
   *
   * 判据是 `readdir(agents/)` + 每个智能体 1–2 次 `stat`——随智能体数量线性涨，
   * 而且这条迁移**只在改目录名的那一次**有意义，之后每次启动都白扫，所以门住。
   */
  exclusiveSkillsDirCase: { key: 'exclusive-skills-dir-case', version: 1 },
} as const satisfies Record<string, MigrationSpec>

export type MigrationKey = keyof typeof MIGRATIONS
