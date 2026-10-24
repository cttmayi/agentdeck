/**
 * 沉淀任务的**链条**：一版一代，沿 `revisedFrom` 上溯到根。
 *
 * ## 为什么单独一个文件
 *
 * "哪几版算同一个沉淀任务"这件事，原来有**四份**各自实现的口径，全都写成
 * "同一来源 run + 同一目标"：
 *
 * | 落点 | 后果 |
 * | --- | --- |
 * | `listCrystallizeDrafts`（列表一行一个任务） | 两条不相干的链显示成一行 |
 * | `listChain`（任务目录解析） | 目录会按邻链的最新版自愈 ⇒ 可能把别条链的内容搬进来 |
 * | `#reworkBudgetFor`（自动返工的额度） | 邻链的版本数把额度撑爆 ⇒ 自动返工永远不触发 |
 * | `/api/crystallize/review` 的 `versions` | 轮次显示成两条链之和 |
 *
 * 真机实测（2026-10-23）：来源 run `Q2SQ16` 下有**两个根**——`H5YM0E`（10-20，4 版，
 * 讲的是 HTML 报告）与 `9D67DN`（10-22，10 版，讲的是追溯原始文献）。两者的
 * `sourceRunId` 相同、`crystallizeTarget` 都是 `{"kind":"new"}` ⇒ 四份口径一致地把它们
 * 当成一条链：
 *
 * - 列表上是**一行 18 个版本**；
 * - `9D67DN` 的任务目录里 `.versions.json` 记了 **14 条**（两条链混在一起）；
 * - 自动返工按"同来源已起草几版"算额度 ⇒ 已用 17 > 上限 2 ⇒ **每一轮都判额度用尽**
 *   ⇒ `createReworkRun` 一次都没被调用（使用者只能手动点 10 次「反馈」）。
 *
 * `revisedFrom` 是唯一的、写进 run 记录里的父子关系（返工时由平台写），它不会因为
 * "目标恰好相同"而把两件事混起来。所以链条只认它。
 *
 * ## 口径
 *
 * - **根**：`revisedFrom` 为空的那一版（新建沉淀时平台没给父）。
 * - **同一条链**：沿 `revisedFrom` 上溯能到达同一个根的所有版。
 * - `revisedFrom` 指向一条**已不存在**的 run（数据被删过）⇒ 那一版自成一根，
 *   而不是被并进别人家。
 * - 上溯有步数上限（50）：链再长也够，同时挡住脏数据成环把进程转死。
 */

/** 判链条只需要这三样。 */
export interface ChainRun {
  id: string
  revisedFrom: string | null
  queuedAt: number
}

const MAX_CHAIN_HOPS = 50

/**
 * 沿 `revisedFrom` 上溯到根。
 *
 * ⚠️ 父不存在（`byId` 里没有）时**停在当前这一版**：把"父被删了"当成"这就是根"，
 *    否则会把一条断了链的数据挂到 `undefined` 上，而所有断链的版本会因此被并成一组。
 * ⚠️ 成环（A→B→A）时返回走到的最后一版，不抛：列表页不该因为一条脏数据整页打不开。
 */
export function rootOf(runId: string, byId: ReadonlyMap<string, ChainRun>): string {
  let current = runId
  const path: string[] = [current]
  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop += 1) {
    const parent = byId.get(current)?.revisedFrom ?? null
    if (parent === null || parent === '') return current
    if (!byId.has(parent)) return current
    const at = path.indexOf(parent)
    if (at >= 0) {
      // 成环（A→B→A）：根取环上**时间最早那一版**（同时刻按 id 定序）。
      //
      // ⚠️ 第一版我写的是"上溯到重复出现就停在当时那一版"——从 A 进得到 B、从 B 进得到 A，
      //    同一条脏数据在两次调用里被算成**两条链**（列表会一行变两行，额度也数两遍）。
      //    取环上最早的那一版与入口无关，所以确定。
      const cycle = path.slice(at)
      let best = cycle[0] ?? current
      for (const id of cycle) {
        const a = byId.get(id)
        const b = byId.get(best)
        if (a === undefined || b === undefined) continue
        if (a.queuedAt < b.queuedAt || (a.queuedAt === b.queuedAt && a.id < b.id)) best = id
      }
      return best
    }
    path.push(parent)
    current = parent
  }
  return current
}

/** 把同一批 run 按**链根**分组；每组内部按 `queuedAt` 升序（第一版在前）。 */
export function groupByChain(runs: readonly ChainRun[]): Map<string, ChainRun[]> {
  const byId = new Map(runs.map((r) => [r.id, r]))
  const groups = new Map<string, ChainRun[]>()
  for (const run of runs) {
    const root = rootOf(run.id, byId)
    const list = groups.get(root) ?? []
    list.push(run)
    groups.set(root, list)
  }
  for (const list of groups.values()) list.sort((a, b) => a.queuedAt - b.queuedAt)
  return groups
}

/** 某个根下的整条链（按 `queuedAt` 升序）；根不在 `runs` 里 ⇒ 空数组。 */
export function chainOf(runs: readonly ChainRun[], rootId: string): ChainRun[] {
  return groupByChain(runs).get(rootId) ?? []
}

/**
 * **任意一版**所在的整条链（按 `queuedAt` 升序，包含它自己）。
 *
 * 调用方通常手里只有"当前这一版"的 id（列表页、审查接口、返工额度），先自己上溯再查
 * 等于把"根怎么算"又写一遍 ⇒ 给一个入口，别让调用方各自拼。
 */
export function chainOfRun(runs: readonly ChainRun[], runId: string): ChainRun[] {
  const byId = new Map(runs.map((r) => [r.id, r]))
  if (!byId.has(runId)) return []
  return chainOf(runs, rootOf(runId, byId))
}
