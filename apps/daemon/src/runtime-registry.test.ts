import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { knownRuntimeKeys } from '@alpha-helper/agent-core'
import { createRuntimeBackend, knownRuntimeAdapters } from './runtime-registry.ts'

/**
 * 装配表的测试。
 *
 * 这一组守的是**"可插拔"这件事本身**，而不是某个适配器的行为：
 * 描述表里有几行，装配表里就必须有几个适配器；选谁是谁，不许静默回退。
 *
 * 注意这里**不构造真后端去跑**：`create()` 只是 new 一个对象，
 * 不发进程、不碰使用者的 CLI（NFR-T-01）。
 */

describe('runtime 装配表（FR-CLI-47 的第 2 段）', () => {
  test('★ 描述表的每一行都有适配器 —— 有表行没适配器比"不支持"更糟', () => {
    const adapters = knownRuntimeAdapters()
    assert.deepEqual(
      Object.keys(adapters).sort(),
      [...knownRuntimeKeys()].sort(),
      '两边的键必须一一对应：有表行没适配器时，使用者会看到该 runtime 可选、选了却起不来',
    )
    assert.ok(knownRuntimeKeys().includes('generic'), '第二个 runtime 必须在表里')
  })

  test('★ 拿到的描述符是补齐过的（managedFlags 一定在位）', () => {
    for (const key of knownRuntimeKeys()) {
      const { descriptor } = createRuntimeBackend(key)
      assert.ok(descriptor.managedFlags, `${key} 的 managedFlags 没补齐，拼参数会读到 undefined`)
      assert.equal(descriptor.managedFlags.resume, descriptor.resume.flag, '恢复旗标两个视图必须一致')
    }
  })

  test('★ 两个 runtime 造出来的后端都属于同一份契约', () => {
    const claude = createRuntimeBackend('claude')
    const generic = createRuntimeBackend('generic')

    assert.equal(claude.backend.key, 'claude')
    assert.equal(generic.backend.key, 'generic')
    assert.notEqual(claude.backend.constructor, generic.backend.constructor, '确实是两个实现')

    for (const { backend, descriptor } of [claude, generic]) {
      assert.equal(backend.protocol, descriptor.protocol)
      assert.equal(backend.rejectDetectable, descriptor.resume.rejectDetectable)
      assert.equal(typeof backend.probe, 'function')
      assert.equal(typeof backend.execute, 'function')
    }
  })

  test('★ 未知 runtime 报错并列出可用的 —— 绝不静默回退到 claude', () => {
    assert.throws(
      () => createRuntimeBackend('gemini'),
      (err: Error) => {
        assert.match(err.message, /未知的 runtime：gemini/)
        assert.match(err.message, /claude/)
        assert.match(err.message, /generic/)
        return true
      },
    )
  })

  test('缺省路径仍然是 claude（首版行为不变）', () => {
    assert.equal(createRuntimeBackend('claude').descriptor.key, 'claude')
    assert.equal(createRuntimeBackend('claude').descriptor.contextFile, 'CLAUDE.md')
    assert.deepEqual(createRuntimeBackend('claude').descriptor.skillDir, '.claude/skills')
  })

  test('第二个 runtime 的技能目录与上下文文件与 claude 不同（不是复制粘贴）', () => {
    const generic = createRuntimeBackend('generic').descriptor
    assert.notEqual(generic.contextFile, 'CLAUDE.md')
    assert.notEqual(generic.skillDir, '.claude/skills')
  })
})
