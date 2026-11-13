/**
 * createTimeKit 单测（2026-11 补：v8 时发现「下次触发」的未来时间戳被旧实现
 * 算成「刚刚」——`diff = max(0, now - ts)` 对未来一律 0。现在正负分开，
 * 未来向走 inX 文案，>30 天给日期）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createTimeKit, type TimeText } from './time.ts'

const NOW = new Date('2026-11-11T10:00:00Z').getTime() // 2026-11-11 周三 10:00 UTC

const kit = createTimeKit({
  justNow: () => '刚刚',
  minutesAgo: (n) => `${n} 分钟前`,
  hoursAgo: (n) => `${n} 小时前`,
  daysAgo: (n) => `${n} 天前`,
  inMinutes: (n) => `${n} 分钟后`,
  inHours: (n) => `${n} 小时后`,
  inDays: (n) => `${n} 天后`,
} satisfies TimeText)

test('过去向：刚刚 / X 分钟前 / X 小时前 / X 天前 / 超 30 天给日期', () => {
  assert.equal(kit.relativeTime(NOW - 10_000, NOW), '刚刚')
  assert.equal(kit.relativeTime(NOW - 5 * 60_000, NOW), '5 分钟前')
  assert.equal(kit.relativeTime(NOW - 3 * 3_600_000, NOW), '3 小时前')
  assert.equal(kit.relativeTime(NOW - 2 * 86_400_000, NOW), '2 天前')
  assert.equal(kit.relativeTime(NOW - 45 * 86_400_000, NOW), '2026-09-27')
})

test('未来向：X 分钟后 / 小时后 / 天后 / 超 30 天给日期——不再算成「刚刚」', () => {
  assert.equal(kit.relativeTime(NOW + 10_000, NOW), '1 分钟后')
  assert.equal(kit.relativeTime(NOW + 5 * 60_000, NOW), '5 分钟后')
  assert.equal(kit.relativeTime(NOW + 3 * 3_600_000, NOW), '3 小时后')
  assert.equal(kit.relativeTime(NOW + 2 * 86_400_000, NOW), '2 天后')
  assert.equal(kit.relativeTime(NOW + 45 * 86_400_000, NOW), '2026-12-26')
})

test('null / 空串 / 非法 → —', () => {
  assert.equal(kit.relativeTime(null, NOW), '—')
  assert.equal(kit.relativeTime('', NOW), '—')
  assert.equal(kit.relativeTime('nope', NOW), '—')
})
