/**
 * schedule-cron 双向转换单测（2026-11，定时任务 D115 的 v8 定型形态）。
 *
 * 重点覆盖两处"容易在改版里翻车"的：
 * ① 「工作日」快捷 ⇔ cron 区间 `1-5`（恰选周一至周五时输出区间，回填成五个勾）；
 * ② 「每月最后一天」⇔ `L`（monthDay 可以是 'L'，回填成特殊选项）。
 * 以及自定义模式（写什么存什么、回填不进五类时落回自定义原文）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  defaultScheduleForm,
  isWorkdays,
  scheduleCronToForm,
  scheduleFormToCron,
} from './schedule-cron.ts'

test('五档表单 → cron', () => {
  const base = defaultScheduleForm()

  assert.equal(scheduleFormToCron({ ...base, freq: 'daily', time: '09:05' }), '05 09 * * *')

  // 每周：普通多选 = 列表；恰选周一至周五 = 区间 `1-5`（工作日快捷）
  assert.equal(
    scheduleFormToCron({ ...base, freq: 'weekly', time: '08:30', weekdays: [1, 3] }),
    '30 08 * * 1,3',
  )
  assert.equal(
    scheduleFormToCron({ ...base, freq: 'weekly', time: '08:30', weekdays: [1, 2, 3, 4, 5] }),
    '30 08 * * 1-5',
  )
  // 顺序无关：勾选顺序乱也不影响输出排序
  assert.equal(
    scheduleFormToCron({ ...base, freq: 'weekly', time: '08:30', weekdays: [5, 1, 3] }),
    '30 08 * * 1,3,5',
  )

  // 每月：普通几号 vs 最后一天 L
  assert.equal(scheduleFormToCron({ ...base, freq: 'monthly', time: '09:00', monthDay: 15 }), '00 09 15 * *')
  assert.equal(scheduleFormToCron({ ...base, freq: 'monthly', time: '09:00', monthDay: 'L' }), '00 09 L * *')

  // 间隔
  assert.equal(scheduleFormToCron({ ...base, freq: 'interval', minutes: 15 }), '*/15 * * * *')

  // 自定义：写什么存什么（空自定义退回 daily 默认形，避免存出空串）
  assert.equal(
    scheduleFormToCron({ ...base, freq: 'custom', customCron: '0 9 * * 1' }),
    '0 9 * * 1',
  )
  assert.equal(scheduleFormToCron({ ...base, freq: 'custom', customCron: '  */5 * * * * ' }), '*/5 * * * *')
  assert.equal(scheduleFormToCron({ ...base, freq: 'custom', customCron: '' }), '00 09 * * *')
})

test('cron → 表单（五类回填 + 自定义落回原文）', () => {
  const daily = scheduleCronToForm('5 9 * * *')
  assert.equal(daily.freq, 'daily')
  assert.equal(daily.time, '09:05')

  const weekly = scheduleCronToForm('30 08 * * 1,3')
  assert.equal(weekly.freq, 'weekly')
  assert.deepEqual(weekly.weekdays, [1, 3])
  assert.equal(weekly.time, '08:30')

  // 区间 `1-5` → 五个勾（工作日快捷亮）
  const workdays = scheduleCronToForm('30 08 * * 1-5')
  assert.equal(workdays.freq, 'weekly')
  assert.deepEqual(workdays.weekdays, [1, 2, 3, 4, 5])
  assert.ok(isWorkdays(workdays))

  const monthly = scheduleCronToForm('00 09 15 * *')
  assert.equal(monthly.freq, 'monthly')
  assert.equal(monthly.monthDay, 15)

  const lastDay = scheduleCronToForm('00 09 L * *')
  assert.equal(lastDay.freq, 'monthly')
  assert.equal(lastDay.monthDay, 'L')

  const interval = scheduleCronToForm('*/45 * * * *')
  assert.equal(interval.freq, 'interval')
  assert.equal(interval.minutes, 45)

  // 自定义：认不出 → 原文照显、freq=custom
  const weird = scheduleCronToForm('0 9 15 * 1,2')
  assert.equal(weird.freq, 'custom')
  assert.equal(weird.customCron, '0 9 15 * 1,2')
})

test('isWorkdays：恰为周一至周五才算，缺一天/多一天都不算', () => {
  const base = defaultScheduleForm()
  assert.ok(isWorkdays({ ...base, weekdays: [1, 2, 3, 4, 5] }))
  assert.ok(!isWorkdays({ ...base, weekdays: [1, 2, 3, 4] }))
  assert.ok(!isWorkdays({ ...base, weekdays: [1, 2, 3, 4, 5, 6] }))
  assert.ok(!isWorkdays({ ...base, weekdays: [1] }))
})

test('往返一致性：表单 → cron → 表单 回到同一形态', () => {
  const cases: Array<ReturnType<typeof defaultScheduleForm>> = [
    { ...defaultScheduleForm(), freq: 'daily', time: '07:15' },
    { ...defaultScheduleForm(), freq: 'weekly', time: '07:15', weekdays: [2, 4] },
    { ...defaultScheduleForm(), freq: 'weekly', time: '07:15', weekdays: [1, 2, 3, 4, 5] },
    { ...defaultScheduleForm(), freq: 'monthly', time: '07:15', monthDay: 28 },
    { ...defaultScheduleForm(), freq: 'monthly', time: '07:15', monthDay: 'L' },
    { ...defaultScheduleForm(), freq: 'interval', minutes: 10 },
  ]
  for (const form of cases) {
    const back = scheduleCronToForm(scheduleFormToCron(form))
    assert.equal(back.freq, form.freq, `${form.freq} 往返后 freq 变了`)
    assert.equal(back.time, form.time)
    if (form.freq === 'weekly') assert.deepEqual(back.weekdays, form.weekdays)
    if (form.freq === 'monthly') assert.equal(back.monthDay, form.monthDay)
    if (form.freq === 'interval') assert.equal(back.minutes, form.minutes)
  }
})
