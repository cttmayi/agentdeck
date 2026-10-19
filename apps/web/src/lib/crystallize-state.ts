/**
 * 沉淀**任务**的状态（不是起草 run 的状态）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有这一层（使用者："很多沉淀任务标注'已完成'，实际没有完成"）
 * ══════════════════════════════════════════════════════════════════
 *
 * 左栏初版直接把**起草 run 的 status** 当任务状态显示。于是 run 一跑完，
 * 列表上就是「已完成」——可那条 run 完成只意味着**草稿写出来了**，沉淀本身
 * 还停在"等你看、等你入库"。真实数据里 3 条「已完成」的草稿，`skills-mine`
 * 里一条都没有：**字面撒谎，会让人以为活干完了**。
 *
 * 沉淀这件事的完成线是**入库**（`crystallized: true`，写入 skills-mine 并 git
 * 提交），不是起草 run 的终态。所以在两者之间加这一层：
 *
 *   起草 run queued/dispatched/deferred/waiting_local_directory/running → 起草中
 *   起草 run completed（还没入库）                                  → **待审阅**
 *   起草 run failed                                                 → 起草失败
 *   起草 run cancelled                                              → 已停止
 *
 * 已入库（`crystallized: true`）与已放弃（`discarded: true`）的**不进列表**，
 * 所以这里不定义那两档——留着就是走不到的分支。
 *
 * 徽标颜色复用全局 `.badge` 的那批语义色：进行中 / 待审阅 / 失败 / 取消。
 */
import type { WebTextId } from '@agentdeck/i18n'

export type CrystallizeState = 'drafting' | 'review' | 'failed' | 'stopped'

/** 起草 run 处于"还在跑"的那几个状态（协议里 RunStatus 的非终态部分）。 */
const RUNNING_STATUSES = new Set([
  'queued',
  'dispatched',
  'deferred',
  'waiting_local_directory',
  'running',
])

/**
 * 起草 run 的 status → 沉淀任务的状态。
 *
 * 未知的 run 状态按"起草中"算——宁可显示进行中，也不要凭空宣布完成。
 */
export function crystallizeState(status: string): CrystallizeState {
  if (status === 'completed') return 'review'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'stopped'
  if (RUNNING_STATUSES.has(status)) return 'drafting'
  return 'drafting'
}

/** 状态徽标的颜色类（全局 `.badge` 的语义档）。 */
export function crystallizeStateClass(state: CrystallizeState): string {
  if (state === 'review') return 'in_review'
  if (state === 'failed') return 'failed'
  if (state === 'stopped') return 'cancelled'
  return 'in_progress'
}

/** 状态徽标的字（`crystallize.state.*`）。 */
export function crystallizeStateKey(state: CrystallizeState): WebTextId {
  return `crystallize.state.${state}` as WebTextId
}
