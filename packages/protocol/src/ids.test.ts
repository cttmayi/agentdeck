import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createUlidFactory, encodeTime, ulid, Ulid } from './ids.ts'
import { agentMatchesKind } from './entities.ts'

describe('ULID', () => {
  test('格式正确：26 个 Crockford base32 字符', () => {
    const id = ulid()
    assert.equal(id.length, 26)
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/)
    assert.equal(Ulid.safeParse(id).success, true)
  })

  test('排除易混字符 I / L / O / U', () => {
    for (let i = 0; i < 200; i++) {
      assert.doesNotMatch(ulid(), /[ILOU]/)
    }
  })

  test('时间戳部分可解码回原毫秒', () => {
    const now = 1_700_000_000_000
    const id = ulid(now)
    const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    let decoded = 0
    for (const ch of id.slice(0, 10)) {
      decoded = decoded * 32 + ENCODING.indexOf(ch)
    }
    assert.equal(decoded, now)
  })

  test('encodeTime 对非法输入抛错', () => {
    assert.throws(() => encodeTime(-1))
    assert.throws(() => encodeTime(Number.NaN))
  })

  test('不同时刻的 ULID 按字典序递增', () => {
    const a = ulid(1000)
    const b = ulid(2000)
    assert.ok(a < b, `${a} 应小于 ${b}`)
  })
})

describe('单调 ULID 工厂', () => {
  test('同一毫秒内连续生成严格递增（append-only 日志可依赖它排序）', () => {
    const next = createUlidFactory()
    const ids = Array.from({ length: 200 }, () => next(1_700_000_000_000))
    const sorted = [...ids].sort()
    assert.deepEqual(ids, sorted, '同毫秒内的 ID 必须严格递增')
    assert.equal(new Set(ids).size, ids.length, '不能重复')
  })

  test('跨毫秒仍然递增', () => {
    const next = createUlidFactory()
    const a = next(1000)
    const b = next(1001)
    assert.ok(a < b)
  })
})

describe('agent 的 kind 匹配（D24 路由键）', () => {
  test('精确匹配', () => {
    assert.equal(agentMatchesKind(['ci-failure'], 'ci-failure'), true)
    assert.equal(agentMatchesKind(['ci-failure'], 'ci-success'), false)
  })

  test('尾部通配', () => {
    assert.equal(agentMatchesKind(['ci-*'], 'ci-failure'), true)
    assert.equal(agentMatchesKind(['ci-*'], 'pr-diff'), false)
  })

  test('星号匹配全部', () => {
    assert.equal(agentMatchesKind(['*'], '任意'), true)
  })

  test('空模式列表不匹配任何东西', () => {
    assert.equal(agentMatchesKind([], 'ci-failure'), false)
  })

  test('多个模式命中其一即可', () => {
    assert.equal(agentMatchesKind(['a', 'b', 'c-*'], 'c-x'), true)
  })
})
