/**
 * 任务列表分组纯函数的单测（2026-11，使用者拍板 demo v3）。
 *
 * 探针量界面交互；**分组/排序规则在这里钉死**：
 * · 同一 scheduleId 一组、手动（无 source）一组；
 * · 组间按组内最新任务时间倒排，**手动组参与排序**（不固定压底）；
 * · 组内保持传入顺序（不重排）；
 * · `source` 缺失（老数据 = undefined）与 `null` 一样归「手动创建」。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { groupTasks, MANUAL_GROUP_KEY } from './task-groups.ts'
import type { Issue } from '../lib/api.ts'

function item(
  id: string,
  createdAt: number,
  source: Issue['source'],
): { issue: Pick<Issue, 'id' | 'source' | 'createdAt'> } {
  return { issue: { id, source, createdAt } }
}

describe('task-groups', () => {
  it('同一定时任务的任务归一组，手动（无来源）归「手动创建」', () => {
    const groups = groupTasks(
      [
        item('a', 3, { kind: 'schedule', scheduleId: 's1', scheduleName: '每日巡检' }),
        item('b', 2, null),
        item('c', 1, { kind: 'schedule', scheduleId: 's1', scheduleName: '每日巡检' }),
        item('d', 0, undefined as unknown as Issue['source']), // 老数据缺键
      ],
      '手动创建',
    )
    assert.equal(groups.length, 2)
    const s1 = groups.find((g) => g.key === 's1')
    assert.ok(s1)
    assert.equal(s1.name, '每日巡检')
    assert.deepEqual(s1.items.map((x) => x.issue.id), ['a', 'c']) // 组内保持传入顺序
    const manual = groups.find((g) => g.key === MANUAL_GROUP_KEY)
    assert.ok(manual)
    assert.equal(manual.name, '手动创建')
    assert.deepEqual(manual.items.map((x) => x.issue.id), ['b', 'd']) // undefined 也归手动
  })

  it('组间按组内最新任务时间倒排，手动组参与排序（不固定压底）', () => {
    // 手动组有最新任务（13:42）→ 排第一；每日巡检最新（09:00）→ 第二
    const groups = groupTasks(
      [
        item('sched-new', 900, { kind: 'schedule', scheduleId: 's1', scheduleName: '每日巡检' }),
        item('sched-old', 100, { kind: 'schedule', scheduleId: 's1', scheduleName: '每日巡检' }),
        item('manual-new', 1300, null),
        item('manual-old', 800, null),
        item('other', 500, { kind: 'schedule', scheduleId: 's2', scheduleName: '周报' }),
      ],
      '手动创建',
    )
    assert.deepEqual(
      groups.map((g) => g.key),
      [MANUAL_GROUP_KEY, 's1', 's2'], // 手动组最新（1300）→ 每日巡检（900）→ 周报（500）
    )
    assert.equal(groups[0]?.latest, 1300)
    assert.equal(groups[1]?.latest, 900)
  })

  it('编排任务按编排分组（组头 = 编排名）', () => {
    const groups = groupTasks(
      [
        item('w1', 7, { kind: 'workflow', workflowId: 'wf1', workflowName: '日报流水线' }),
        item('m', 5, null),
        item('w2', 3, { kind: 'workflow', workflowId: 'wf1', workflowName: '日报流水线' }),
      ],
      '手动创建',
    )
    assert.equal(groups.length, 2)
    const wf = groups.find((g) => g.key === 'wf1')
    assert.ok(wf)
    assert.equal(wf.name, '日报流水线')
    assert.deepEqual(wf.items.map((x) => x.issue.id), ['w1', 'w2'])
    const manual = groups.find((g) => g.key === MANUAL_GROUP_KEY)
    assert.ok(manual)
    assert.deepEqual(manual.items.map((x) => x.issue.id), ['m'])
  })

  it('空列表 → 空组', () => {
    assert.deepEqual(groupTasks([], '手动创建'), [])
  })
})
