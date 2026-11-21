/**
 * **定时任务的磁盘形状**（2026-11，D225——使用者："`schedules.json` 要不要下一轮照同一
 * 套形状一起改？" → "要，改吧"）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 与编排、智能体同一副形状
 * ══════════════════════════════════════════════════════════════════
 *
 *   <dataDir>/schedules/<scheduleId>/
 *   ├── schedule.json     结构化配置（cron / 执行者 / 启动方式 / 计数 / 上次触发）——**不含任务正文**
 *   ├── task.md           任务模板正文（`{{date}}` 那些变量的宿主）——与 `instructions.md` 同一个角色
 *   └── records.jsonl     触发记录（一行一条，**最老的在前**），最多 `MAX_RECORDS` 行
 *
 * 三条照抄过来的道理（`docs/design/storage-layout.md` §0）：
 *
 *   · **结构化进 json、成篇的正文进独立文本文件**：任务模板是一段人写的 prompt
 *     （真机上一条就上千字），塞进 json 里既读不了也没法 diff；
 *   · **一个实体一个目录**：真机上 `schedules.json` 已经是 64 KB 一个文件，
 *     一条坏掉就是全部定时任务一起没了（旧实现是"解析失败 ⇒ 空数组 ⇒ 什么都不触发"，
 *     而且日志里一个字都没有）；
 *   · **配置与历史分开**：`schedule.json` 是你在界面上改的东西，`records.jsonl` 是
 *     "它干过什么"。分开之后，历史坏掉不会带走配置，配置改坏也不会带走历史。
 *
 * ⚠️ `records.jsonl` 由 `writeScheduleDir` **整写**（不是追加）：它要截断到
 *   `MAX_RECORDS` 行，而截断本来就要求重写。写入是原子的（tmp → fsync → rename），
 *   所以任何时刻读到的都是完整的旧文件或新文件；行序**最老在前**，读回时反转成
 *   "新的在前"（与内存里的 `Schedule.records` 同一顺序）。
 */

import { readdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite, ensureDir, readJsonOrNull } from '@agentdeck/store-file'
import type { Schedule, ScheduleRecord } from './schedules.ts'

/* ══════════════════════════════════════════════════════════════════
 * 路径
 * ══════════════════════════════════════════════════════════════════ */

/** 定时任务目录的根（`<dataDir>/schedules`）。 */
export function schedulesRoot(dir: string): string {
  return join(dir, 'schedules')
}

/** 一个定时任务的目录（`<dataDir>/schedules/<id>`）。 */
export function scheduleDirPath(dir: string, id: string): string {
  return join(schedulesRoot(dir), id)
}

/** 配置落点（**不含任务正文**）。 */
function scheduleJsonPath(dir: string, id: string): string {
  return join(scheduleDirPath(dir, id), 'schedule.json')
}

/** 任务模板正文落点。 */
function scheduleTaskPath(dir: string, id: string): string {
  return join(scheduleDirPath(dir, id), 'task.md')
}

/** 触发记录落点（一行一条）。 */
function scheduleRecordsPath(dir: string, id: string): string {
  return join(scheduleDirPath(dir, id), 'records.jsonl')
}

/**
 * id 要能安全地当目录名用（路由把 URL 里的 id 直接递进来）。
 * 与编排、技能同一道防线：`..` / `/` / 绝对路径都不许。
 */
function assertSafeId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`定时任务 id 不能当目录名：${JSON.stringify(id)}`)
  return id
}

/* ══════════════════════════════════════════════════════════════════
 * 写
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 把一个定时任务落成目录：`schedule.json` + `task.md` + `records.jsonl`，三份都原子写。
 *
 * ⚠️ 顺序：先写正文与记录，**最后**写 `schedule.json`。`schedule.json` 是这个目录的
 * "存在证明"（`listScheduleDirs` 只认它），所以它落盘时另外两份一定已经在了。
 */
export async function writeScheduleDir(dir: string, schedule: Schedule): Promise<void> {
  const id = assertSafeId(schedule.id)
  await ensureDir(scheduleDirPath(dir, id))
  const { taskText, records, ...structured } = schedule
  await atomicWrite(scheduleTaskPath(dir, id), taskText)
  // 记录：最老的在最前（与"追加"同一个心智模型），读回时反转
  const lines = [...(records ?? [])].reverse().map((r) => JSON.stringify(r))
  await atomicWrite(
    scheduleRecordsPath(dir, id),
    lines.length === 0 ? '' : `${lines.join('\n')}\n`,
  )
  await atomicWrite(scheduleJsonPath(dir, id), `${JSON.stringify(structured, null, 2)}\n`)
}

/** 删掉一个定时任务的整个目录（配置 + 正文 + 记录）。 */
export async function removeScheduleDir(dir: string, id: string): Promise<void> {
  await rm(scheduleDirPath(dir, assertSafeId(id)), { recursive: true, force: true })
}

/* ══════════════════════════════════════════════════════════════════
 * 读
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 读回一个定时任务。配置读不到 ⇒ `null`（"没有这一条"）。
 *
 * 两种残缺分开处置：
 *   · `schedule.json` **读不出来** ⇒ 跳过这条，错误报出去（没有配置就没法调度）；
 *   · `task.md` **缺了** ⇒ 照样列出（正文空串）+ 报错误——与编排缺 `main.js` 同一条
 *     口径：列出来使用者才知道该把字贴回去，而不是这条定时任务从页面上消失。
 *   · `records.jsonl` 里**某一行坏了** ⇒ 跳过那一行、其余照读（坏一行不该让整个
 *     历史消失）——这是"一行一条"换来的好处。
 */
async function readScheduleDir(
  dir: string,
  id: string,
): Promise<{ schedule: Schedule; errors: string[] } | { error: string } | null> {
  let structured: Record<string, unknown>
  try {
    const parsed = await readJsonOrNull<Record<string, unknown>>(scheduleJsonPath(dir, id))
    if (parsed === null) return null
    structured = parsed
  } catch (err) {
    return { error: `${id}/schedule.json 读不出来：${String(err)}` }
  }
  const errors: string[] = []
  let taskText = ''
  try {
    taskText = await readFile(scheduleTaskPath(dir, id), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { error: `${id}/task.md 读不出来：${String(err)}` }
    }
    errors.push(`${String(structured['name'] ?? id)}：缺 task.md（任务正文丢了，这条现在跑起来是空的）`)
  }
  const records: ScheduleRecord[] = []
  try {
    const raw = await readFile(scheduleRecordsPath(dir, id), 'utf8')
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (text === '') continue
      try {
        records.push(JSON.parse(text) as ScheduleRecord)
      } catch {
        errors.push(`${String(structured['name'] ?? id)}：records.jsonl 里有一行读不出来（已跳过）`)
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      errors.push(`${String(structured['name'] ?? id)}：records.jsonl 读不出来：${String(err)}`)
    }
  }
  // 盘上最老在前 ⇒ 内存里新的在前（`Schedule.records` 的既有顺序，界面照它画）
  records.reverse()
  return { schedule: { ...(structured as unknown as Schedule), id, taskText, records }, errors }
}

/**
 * 列出全部定时任务。
 *
 * 返回 `{ schedules, errors }`：**逐条读、逐条报**。旧实现是
 * `try { … } catch { return [] }`——文件坏了就是"一条定时任务都没有"，
 * 而**定时任务没了 = 到点什么都不再发生**，这是最坏的一种静默。
 */
export async function listScheduleDirs(
  dir: string,
): Promise<{ schedules: Schedule[]; errors: string[] }> {
  let ids: string[]
  try {
    ids = await readdir(schedulesRoot(dir))
  } catch {
    return { schedules: [], errors: [] } // 从没建过定时任务 ≠ 出错
  }
  const schedules: Schedule[] = []
  const errors: string[] = []
  for (const id of ids) {
    if (id.startsWith('.')) continue
    try {
      const entry = await readScheduleDir(dir, id)
      if (entry === null) continue
      if ('error' in entry) {
        errors.push(entry.error)
        continue
      }
      schedules.push(entry.schedule)
      errors.push(...entry.errors)
    } catch (err) {
      errors.push(`${id}：${String(err)}`)
    }
  }
  // 稳定顺序：按创建时间（readdir 的顺序不保证，界面不该跟着抖）
  schedules.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return { schedules, errors }
}

/* ══════════════════════════════════════════════════════════════════
 * 迁移（老的 schedules.json → 目录；幂等、可回滚）
 * ══════════════════════════════════════════════════════════════════ */

/** 老文件的落点（它曾经是唯一的存储）。 */
export function legacySchedulesPath(dir: string): string {
  return join(dir, 'schedules.json')
}

/**
 * 把老的 `schedules.json`（一个数组）迁进目录形状。
 *
 * 口径与编排那次逐条相同（`workflows-dirs.ts`）：
 *   · 老文件**不存在** ⇒ 什么都不做（返回 `null`，与"迁了 0 条"是两件事）；
 *   · 老文件**读不出来** ⇒ **不改名、不删**，把错误报出去（迁移不许掩盖坏数据）；
 *   · 目标目录**已经存在** ⇒ 跳过那一条（目录是新的真相）；
 *   · 迁完把老文件改名 `schedules.json.migrated` **留档不删**（回滚 = 发旧版代码 + 改回原名）。
 */
export async function migrateLegacySchedules(
  dir: string,
): Promise<{ migrated: number; skipped: number; errors: string[] } | null> {
  const path = legacySchedulesPath(dir)
  let list: Schedule[]
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return { migrated: 0, skipped: 0, errors: [`${path} 里不是数组，原样留着没动`] }
    }
    list = parsed as Schedule[]
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { migrated: 0, skipped: 0, errors: [`${path} 读不出来（原样留着没动）：${String(err)}`] }
  }
  const errors: string[] = []
  let migrated = 0
  let skipped = 0
  for (const s of list) {
    /*
     * 形状检查照旧（旧实现就有一条"只留形状对的条目"）：缺 id / cron / taskText 的
     * 条目在目录形状下无法调度，跳过并点名——不静默吞掉。
     */
    if (
      typeof s !== 'object' ||
      s === null ||
      typeof s.id !== 'string' ||
      s.id === '' ||
      typeof s.cron !== 'string' ||
      typeof s.taskText !== 'string'
    ) {
      errors.push('schedules.json 里有一条形状不对（缺 id/cron/taskText），跳过')
      continue
    }
    const existing = await readJsonOrNull<unknown>(scheduleJsonPath(dir, s.id))
    if (existing !== null) {
      skipped += 1
      continue
    }
    try {
      await writeScheduleDir(dir, { ...s, records: s.records ?? [] })
      migrated += 1
    } catch (err) {
      errors.push(`定时任务 ${s.id} 落盘失败：${String(err)}`)
    }
  }
  // 一条都没迁成（全失败）就别改名——留着老文件，下次启动还能再试。
  if (errors.length === 0 || migrated > 0) {
    let target = `${path}.migrated`
    try {
      await readFile(target)
      target = `${path}.migrated-${Date.now()}`
    } catch {
      // 没有旧档案 ⇒ 用默认名
    }
    try {
      await rename(path, target)
    } catch (err) {
      errors.push(`老文件改名留档失败（不影响已迁数据）：${String(err)}`)
    }
  }
  return { migrated, skipped, errors }
}
