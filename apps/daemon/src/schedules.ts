/**
 * **定时任务**（2026-11，使用者立项："做一个定时器，定时触发智能体完成任务"）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 本模块只做四件事：类型、存储、模板变量渲染、cron 工具
 * ══════════════════════════════════════════════════════════════════
 *
 * 触发链（到点 → 建 issue → 提交 run → 记录）在 `server.ts` 里实现——
 * 它要调 `submitRunRequest`（server 内部函数，组展开/校验/起进程都在那里），
 * 本模块保持纯逻辑、可单测。
 *
 * 存储是**自己的目录**（`<dataDir>/schedules/<id>/`：`schedule.json` 配置 +
 * `task.md` 任务正文 + `records.jsonl` 触发记录），不进 domain 的 store：
 * 定时任务是 daemon 的"外挂功能"——触发的 run 全部走既有链路（issue/run），
 * 它自己只是"到点的任务生成器"，不值得为此动 protocol/domain/store 协议层
 * （那是另一级回归面）。判据与 D34 同一句：能不动的层就不动。
 * ⚠️ 2026-11（D225）：原来是一个 `schedules.json` 大数组（真机 3 条 / 64 KB），
 * 现在一实体一目录——形状见 `schedules-dirs.ts` 头注释。
 *
 * 触发记录是"这个定时任务干过什么"的索引（保留最近 `MAX_RECORDS` 条），每次触发一条，
 * 点开跳任务页那次 run。它落成 `records.jsonl`（配置与历史分开）。
 */

import { Cron } from 'croner'
import type { RunId, WorkspaceId } from '@agentdeck/protocol'
import {
  legacySchedulesPath,
  listScheduleDirs,
  migrateLegacySchedules,
  removeScheduleDir,
  schedulesRoot,
  scheduleDirPath,
  writeScheduleDir,
} from './schedules-dirs.ts'

/** 一次触发的记录（"这个定时任务干过什么"的索引，对应任务页里那次 run）。 */
export interface ScheduleRecord {
  /** 触发时刻。 */
  triggeredAt: number
  /** 那次触发的 run（失败/跳过后为 null）。 */
  runId: RunId | null
  /** 那次触发的 issue（点「查看」跳任务页就靠它）。 */
  issueId: string | null
  /** 触发结果：`triggered` 正常发起 / `skipped` 上次还在跑 / `failed` 发起失败。 */
  status: 'triggered' | 'skipped' | 'failed'
  /** 失败/跳过原因（正常触发为 null）。 */
  note: string | null
}

/** 定时任务（到点的任务生成器）。 */
export interface Schedule {
  id: string
  workspaceId: WorkspaceId
  name: string
  enabled: boolean
  /** cron 表达式（croner 语法，5 段）。界面用表单生成，高级模式直接填。 */
  cron: string
  /**
   * 执行者类型。
   *
   * ⚠️ 2026-11（S3）：这里原来是 `'agent' | 'group'`（定时任务可以挂一个智能体组）。
   *   **组退场** ⇒ 新记录只会是 `'agent'`；但**老记录里还写着 `'group'`**，所以类型
   *   保留那个值——读到它时在触发分支里报"组已退场，请改选具体智能体"，而不是
   *   把一条跑不起来的定时任务静默跳过。
   */
  executorType: 'agent' | 'group'
  executorId: string
  /**
   * 「要做什么」模板（第一行当标题，与「新建任务」同一个框同一套规则）。
   * 支持触发上下文变量：{{date}} {{time}} {{weekday}} {{count}} {{runId}} {{lastRunId}}。
   */
  taskText: string
  /** 触发时的工作目录（2026-11 与「新建任务」同款：可选，null = daemon 自动分配）。 */
  workDir: string | null
  /** 触发方式：每次新起一个 agent 会话（fresh），还是续上上一次触发的会话（resume）。 */
  /**
   * 启动方式（2026-11 使用者三档定稿，顺序 = 按钮顺序）：
   *   'fresh'            = 新启动（新会话 + 新目录）
   *   'fresh-same-dir'   = 新启动 · 原目录（新会话 + 保持上次目录）
   *   'resume'           = 接续 · 原目录（续上次会话 + 保持上次目录）
   */
  resumeMode: 'fresh' | 'fresh-same-dir' | 'resume'
  createdAt: number
  updatedAt: number
  /** 累计触发次数（{{count}} 用它 +1）。 */
  triggerCount: number
  /** 上次触发的 runId（{{lastRunId}} 用它；首次为 null ⇒ 渲染成空）。 */
  lastRunId: RunId | null
  lastTriggerAt: number | null
  /** 触发记录（最近 MAX_RECORDS 条，新的在前）。 */
  records: ScheduleRecord[]
}

/** 触发记录保留条数（无限增长会拖垮启动读盘）。 */
export const MAX_RECORDS = 50

/*
 * 读写的**门面**：server 只认这三个名字，形状全在 `schedules-dirs.ts`。
 *
 * 为什么读要返回 `{ schedules, errors }`：旧实现是 `catch { return [] }`——
 * 文件坏了就表现为"一条定时任务都没有"，而**定时任务没了 = 到点什么都不再发生**，
 * 这是最坏的一种静默（不是"少显示一行"，是"该做的事不再做"）。
 */

/** 读全部定时任务（顺带把老的 `schedules.json` 迁成目录，幂等）。 */
export async function loadSchedules(dataDir: string): Promise<{
  schedules: Schedule[]
  errors: string[]
  migrated: { migrated: number; skipped: number; errors: string[] } | null
}> {
  const migrated = await migrateLegacySchedules(dataDir)
  const { schedules, errors } = await listScheduleDirs(dataDir)
  return { schedules, errors, migrated }
}

/** 写**一条**定时任务（配置 + 正文 + 记录，三份都原子写）。 */
export async function saveSchedule(dataDir: string, schedule: Schedule): Promise<void> {
  await writeScheduleDir(dataDir, schedule)
}

/** 删一条定时任务 = 删它自己的目录（配置 / 正文 / 记录一起走）。 */
export async function removeSchedule(dataDir: string, id: string): Promise<void> {
  await removeScheduleDir(dataDir, id)
}

/** 落盘路径（给启动日志与测试用；别在别处自己拼路径）。 */
export { legacySchedulesPath, schedulesRoot, scheduleDirPath }

// ══════════════════════════════════════════════════════════════════
// 模板变量（触发时快照）
// ══════════════════════════════════════════════════════════════════
//
// 与 D33 的第一句话变量（{{prompt}}/{{skills}} 等）互不干扰：那套是平台组装
// 身份/技能时的注入；这套是**任务文本里的触发上下文**，每次到点由 daemon 算好
// 填入。判据沿用 D33：**变量只给内容、不给标题**；**缺值替换成空、不报错**
// （首次触发没有"上次"很正常，报错会让模板没法跑）。

export interface ScheduleVars {
  /** 触发日期 YYYY-MM-DD（本地时区）。 */
  date: string
  /** 触发时刻 HH:MM。 */
  time: string
  /** 星期几（周一…周日）。 */
  weekday: string
  /** 第几次触发（含本次）。 */
  count: number
  /** 本次 run 的 id。 */
  runId: string
  /** 上次触发的 runId（首次为 null）。 */
  lastRunId: string | null
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** 触发时刻的变量快照。 */
export function scheduleVarsFor(
  now: number,
  count: number,
  runId: string,
  lastRunId: string | null,
): ScheduleVars {
  const d = new Date(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    weekday: WEEKDAYS[d.getDay()]!,
    count,
    runId,
    lastRunId,
  }
}

/**
 * 渲染任务文本模板。不认识的 `{{xxx}}` **保留原样**（不是报错也不是删掉——
 * 模板作者拼错了变量，静默删掉会把"引用"悄悄变成"没有"，留着他还能看见）。
 */
export function renderScheduleTask(template: string, vars: ScheduleVars): string {
  return template
    .replace(/\{\{date\}\}/g, vars.date)
    .replace(/\{\{time\}\}/g, vars.time)
    .replace(/\{\{weekday\}\}/g, vars.weekday)
    .replace(/\{\{count\}\}/g, String(vars.count))
    .replace(/\{\{runId\}\}/g, vars.runId)
    .replace(/\{\{lastRunId\}\}/g, vars.lastRunId ?? '')
}

// ══════════════════════════════════════════════════════════════════
// cron 工具（croner）
// ══════════════════════════════════════════════════════════════════

/** 校验 cron 表达式：合法返回 null，非法返回一句人话错误。 */
export function validateCron(expr: string): string | null {
  const trimmed = expr.trim()
  if (trimmed === '') return 'cron 不能为空'
  try {
    new Cron(trimmed)
    return null
  } catch (err) {
    return `cron 表达式不合法：${String(err instanceof Error ? err.message : err).split('\n')[0]}`
  }
}

/** 下一次触发时刻（epoch ms）；表达式非法返回 null。 */
export function nextRunAt(expr: string, from: Date = new Date()): number | null {
  try {
    return new Cron(expr).nextRun(from)?.getTime() ?? null
  } catch {
    return null
  }
}

/**
 * cron → 人类可读描述（列表/详情显示）。
 *
 * ⚠️ 只懂**表单生成的几种**（每天/每周/每月/每 N 分钟——见前端表单的生成规则），
 * 其它表达式（高级模式手填的）显示原文——"看不懂的就不假装看懂"。
 */
export function describeCron(expr: string): string {
  const e = expr.trim()
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(e)
  if (daily) return `每天 ${pad2(daily[2]!)}:${pad2(daily[1]!)}`
  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* (1-5|[0-7](?:,[0-7])*)$/.exec(e)
  if (weekly) {
    // 「工作日」= 区间 `1-5`（2026-11 v8 定型：表单里工作日快捷的唯一 cron 形态）
    if (weekly[3]! === '1-5') return `工作日（周一至周五）${pad2(weekly[2]!)}:${pad2(weekly[1]!)}`
    const names = weekly[3]!.split(',').map((n) => weekdayName(Number(n)))
    return `每周 ${names.join('、')} ${pad2(weekly[2]!)}:${pad2(weekly[1]!)}`
  }
  const monthly = /^(\d{1,2}) (\d{1,2}) (L|\d{1,2}) \* \*$/.exec(e)
  if (monthly) {
    // `L` = 每月最后一天（croner 原生支持：11 月→30 / 12 月→31 / 2 月→28，实测）
    if (monthly[3]! === 'L') return `每月最后一天 ${pad2(monthly[2]!)}:${pad2(monthly[1]!)}`
    return `每月 ${Number(monthly[3]!)} 日 ${pad2(monthly[2]!)}:${pad2(monthly[1]!)}`
  }
  const everyMin = /^\*\/(\d{1,3}) \* \* \* \*$/.exec(e)
  if (everyMin) return `每 ${everyMin[1]!} 分钟`
  const hourly = /^(\d{1,2}) \* \* \* \*$/.exec(e)
  if (hourly) return `每小时 ${pad2(hourly[1]!)} 分`
  return e
}

function pad2(n: string): string {
  return n.padStart(2, '0')
}

function weekdayName(n: number): string {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][((n % 7) + 7) % 7] ?? String(n)
}

