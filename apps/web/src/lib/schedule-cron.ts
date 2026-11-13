/**
 * 定时任务：表单式调度 ↔ cron 表达式的双向转换（2026-11，使用者立项）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 使用者不写 cron——界面是「预设五档 + 时间点」，保存时转成 cron 存库
 * （croner 调度）；编辑时把 cron 解析回表单。cron 永远**可见**（底部
 * 结果区常驻），表单与 cron 是同一状态的两侧，改哪边都实时同步——
 * 这是 2026-11 使用者两轮反馈后的定型（「选中哪些调整 cron 就自动改、
 * 根本不知道当前设定的是哪一个」⇒ 结果区三行：cron / 人话 / 下次）。
 * ══════════════════════════════════════════════════════════════════
 *
 * 表单能表达的五类（与 daemon 的 `describeCron` 识别的是同一组）：
 *   每天        → `M H * * *`
 *   每周（多选）→ `M H * * 1,3`（周一至周五恰全选 ⇒ 区间 `1-5`，
 *                   那是「工作日」快捷的唯一形态，描述端认区间）
 *   每月（几号）→ `M H D * *`（D 可为 `L` = 每月最后一天，croner 原生支持，
 *                   11 月→30 日 / 12 月→31 日 / 2 月→28 日，实测）
 *   每 N 分钟   → 「斜杠 N」+ 分 时 日 月 周（cron 里星号斜杠 N 开头）
 *   自定义      → cron 原文（由使用者直接写，人话翻译交给 cronstrue）
 *
 * ⚠️ 自定义的 cron **不保证**能解析回表单——解析不了就落回"自定义"模式
 *   显示原文（"看不懂的就不假装看懂"，与 daemon `describeCron` 同一句判据）。
 */

export type ScheduleFreq = 'daily' | 'weekly' | 'monthly' | 'interval' | 'custom'

export interface ScheduleForm {
  freq: ScheduleFreq
  /** HH:MM（daily/weekly/monthly 用）。 */
  time: string
  /** 1=周一 … 7=周日（weekly 用，空 = 未选）。 */
  weekdays: number[]
  /** 1–31 或 'L'（每月最后一天，monthly 用）。 */
  monthDay: number | 'L'
  /** 间隔分钟数（interval 用）。 */
  minutes: number
  /** 自定义模式：非空则优先（手填 cron 原文）。 */
  customCron: string
}

export function defaultScheduleForm(): ScheduleForm {
  return {
    freq: 'daily',
    time: '09:00',
    weekdays: [1],
    monthDay: 1,
    minutes: 30,
    customCron: '',
  }
}

/** 「工作日」= 恰选周一至周五（快捷按钮的 on 状态与 cron 的 `1-5` 同源）。 */
export function isWorkdays(form: ScheduleForm): boolean {
  return (
    form.weekdays.length === 5 &&
    form.weekdays.every((d) => d >= 1 && d <= 5)
  )
}

function hhmmToCronParts(time: string): { min: string; hour: string } {
  const [hour = '0', min = '0'] = time.split(':')
  return { min, hour }
}

/** 表单 → cron（自定义模式时直接用自定义 cron 原文）。 */
export function scheduleFormToCron(form: ScheduleForm): string {
  if (form.freq === 'custom') {
    const e = form.customCron.trim()
    if (e !== '') return e
    // 切进自定义但还没写：退回 daily 的默认形态，避免存出空串
    const { min, hour } = hhmmToCronParts(form.time)
    return `${min} ${hour} * * *`
  }
  const { min, hour } = hhmmToCronParts(form.time)
  switch (form.freq) {
    case 'daily':
      return `${min} ${hour} * * *`
    case 'weekly': {
      const days = [...form.weekdays].sort((a, b) => a - b)
      if (isWorkdays(form)) return `${min} ${hour} * * 1-5`
      return `${min} ${hour} * * ${days.join(',')}`
    }
    case 'monthly':
      return `${min} ${hour} ${form.monthDay} * *`
    case 'interval':
      return `*/${form.minutes} * * * *`
  }
}

/**
 * cron → 表单。能解析回表单的五类就回填表单；**解析不了**（自定义手写的复杂
 * 表达式）返回 freq = 'custom'、customCron = 原文。
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
  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* (1-5|[0-7](?:,[0-7])*)$/.exec(e)
  if (weekly) {
    form.freq = 'weekly'
    form.time = `${pad2(weekly[2]!)}:${pad2(weekly[1]!)}`
    form.weekdays =
      weekly[3]! === '1-5'
        ? [1, 2, 3, 4, 5] // 「工作日」区间展开成五个勾（快捷钮随 isWorkdays 亮起）
        : weekly[3]!.split(',').map((n) => Number(n)).sort()
    return form
  }
  const monthly = /^(\d{1,2}) (\d{1,2}) (L|\d{1,2}) \* \*$/.exec(e)
  if (monthly) {
    form.freq = 'monthly'
    form.time = `${pad2(monthly[2]!)}:${pad2(monthly[1]!)}`
    form.monthDay = monthly[3]! === 'L' ? 'L' : Number(monthly[3]!)
    return form
  }
  const everyMin = /^\*\/(\d{1,3}) \* \* \* \*$/.exec(e)
  if (everyMin) {
    form.freq = 'interval'
    form.minutes = Number(everyMin[1]!)
    return form
  }
  // 解析不了：落回自定义模式，原文照显（cronstrue 负责翻译它）
  form.freq = 'custom'
  form.customCron = e
  return form
}

function pad2(n: string): string {
  return n.padStart(2, '0')
}
