import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { absoluteTime, relativeTime } from './time.ts'

/**
 * 时间的统一显示（`lib/time.ts`）。
 *
 * ⚠️ 这组测试原来住在 `chat.test.ts` 里（那时 `relativeTime` 还在聊天领域文件
 *    里）。搬到这儿是因为**它要跨页面用**：任务清单、技能表、工具表、通知都
 *    显示同一种相对时间——四种粒度并存的局面就是这么来的。
 */
describe('相对时间（列表一律用它，准确时间放 title）', () => {
  test('只到"天"，再久直接给日期——"37 天前"没人算得出来是哪天', () => {
    const now = 1_700_000_000_000
    assert.equal(relativeTime(now, now), '刚刚')
    assert.equal(relativeTime(now - 5 * 60_000, now), '5 分钟前')
    assert.equal(relativeTime(now - 3 * 3_600_000, now), '3 小时前')
    assert.equal(relativeTime(now - 2 * 86_400_000, now), '2 天前')
    const old = relativeTime(now - 400 * 86_400_000, now)
    assert.match(old, /^\d{4}-\d{2}-\d{2}$/)
    // 未来时间不能出现"-3 分钟前"
    assert.equal(relativeTime(now + 60_000, now), '刚刚')
  })

  test('完整时间戳到秒（列表那一格的 title 用它）', () => {
    const at = new Date(2026, 9, 5, 13, 51, 18).getTime()
    const text = absoluteTime(at)
    // 不写死本地化格式（随环境变），但**必须包含时分秒**
    assert.match(text, /13:51:18/)
  })
})
