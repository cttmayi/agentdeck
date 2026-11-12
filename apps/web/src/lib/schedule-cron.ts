/**
 * 定时任务：表单式调度 ↔ cron 表达式的双向转换（2026-11，使用者立项）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 使用者不写 cron——界面填「频率 + 时间点」，保存时转成 cron 存库
 * （croner 调度）；编辑时把 cron 解析回表单。
 * ══════════════════════════════════════════════════════════════════
 *
 * 表单能表达的四类（与 daemon 的 `describeCron` 识别的是同一组）：
 *   每天        → `M H * * *`
 *   每周（多选）→ `M H * * 1,3`
 *   每月（几号）→ `M H D * *`
 *   每 N 分钟   → 「斜杠 N」+ 分 时 日 月 周（cron 里星号斜杠 N 开头）
 *
 * ⚠️ 高级模式手填的 cron **不保证**能解析回表单——解析不了就落回"高级"模式
 *   显示原文（"看不懂的就不假装看懂"，与 daemon `describeCron` 同一句判据）。
 */

export type ScheduleFreq = 'daily' | 'weekly' | 'monthly' | 'interval'

export interface ScheduleForm {
  freq: ScheduleFreq
  /** HH:MM（daily/weekly/monthly 用）。 */
  time: string
  /** 1=周一 … 7=周日（weekly 用，空 = 未选）。 */
  weekdays: number[]
  /** 1–31（monthly 用）。 */
  monthDay: number
  /** 间隔分钟数（interval 用）。 */
  minutes: number
  /** 高级模式：非空则优先（手填 cron 原文）。 */
  advancedCron: string
}

export function defaultScheduleForm(): ScheduleForm {
  return {
    freq: 'daily',
    time: '09:00',
    weekdays: [1],
    monthDay: 1,
    minutes: 30,
    advancedCron: '',
  }
}

function hhmmToCronParts(time: string): { min: string; hour: string } {
  const [hour = '0', min = '0'] = time.split(':')
  return { min, hour }
}

/** 表单 → cron（高级模式非空时直接用高级 cron）。 */
export function scheduleFormToCron(form: ScheduleForm): string {
  if (form.advancedCron.trim() !== '') return form.advancedCron.trim()
  const { min, hour } = hhmmToCronParts(form.time)
  switch (form.freq) {
    case 'daily':
      return `${min} ${hour} * * *`
    case 'weekly':
      return `${min} ${hour} * * ${form.weekdays.join(',')}`
    case 'monthly':
      return `${min} ${hour} ${form.monthDay} * *`
    case 'interval':
      return `*/${form.minutes} * * * *`
  }
}

/**
 * cron → 表单。能解析回表单的四类就回填表单；**解析不了**（高级手填的复杂
 * 表达式）返回 advancedCron = 原文、freq 保持 daily（显示成高级模式）。
 */
export function scheduleCronToForm(cron: string): ScheduleForm {
  const form = defaultScheduleForm()
  const e = cron.trim()
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(e)
  if (daily) {
    form.freq = 'daily'
    form.time = `${pad2(daily[2]!)}:${pad2(daily[1]!)}`
    return form
  }
  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7](?:,[0-7])*)$/.exec(e)
  if (weekly) {
    form.freq = 'weekly'
    form.time = `${pad2(weekly[2]!)}:${pad2(weekly[1]!)}`
    form.weekdays = weekly[3]!.split(',').map((n) => Number(n)).sort()
    return form
  }
  const monthly = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/.exec(e)
  if (monthly) {
    form.freq = 'monthly'
    form.time = `${pad2(monthly[2]!)}:${pad2(monthly[1]!)}`
    form.monthDay = Number(monthly[3]!)
    return form
  }
  const everyMin = /^\*\/(\d{1,3}) \* \* \* \*$/.exec(e)
  if (everyMin) {
    form.freq = 'interval'
    form.minutes = Number(everyMin[1]!)
    return form
  }
  // 解析不了：落回高级模式，原文照显
  form.advancedCron = e
  return form
}

function pad2(n: string): string {
  return n.padStart(2, '0')
}
