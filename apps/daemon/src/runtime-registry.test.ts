import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { knownRuntimeKeys } from '@agentdeck/agent-core'
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

  test('★ 拿到的描述符是补齐过的（按 kind 校验：cli 的 managedFlags 一定在位，service 一定没有）', () => {
    for (const key of knownRuntimeKeys()) {
      const { descriptor } = createRuntimeBackend(key)
      if (descriptor.kind === 'cli') {
        assert.ok(descriptor.managedFlags, `${key} 的 managedFlags 没补齐，拼参数会读到 undefined`)
        assert.equal(descriptor.managedFlags.resume, descriptor.resume?.flag, '恢复旗标两个视图必须一致')
      } else {
        // service 形状：cli-only 字段不填（填占位值就是撒谎），baseArgs 是启动参数
        assert.equal(descriptor.managedFlags, undefined, `${key} 是 service，不得有受管旗标`)
        assert.equal(descriptor.resume, undefined, `${key} 是 service，恢复走协议`)
        assert.ok(descriptor.baseArgs.length > 0, `${key} 的 baseArgs（启动参数）必须非空`)
      }
    }
  })

  test('★ codex（service）装配出来是一个真后端，且没有 cli 字段', () => {
    const codex = createRuntimeBackend('codex')
    assert.equal(codex.backend.key, 'codex')
    assert.equal(codex.descriptor.kind, 'service')
    assert.equal(codex.descriptor.protocol, 'jsonrpc')
    assert.equal(codex.backend.protocol, 'jsonrpc')
    // ★ 已实测（0.144.0-alpha.4）：thread/resume 失败一律回 -32600 JSON-RPC
    //   error ⇒ "恢复被拒"可检测，rejectDetectable=true（由适配器声明）
    assert.equal(codex.backend.rejectDetectable, true)
    assert.equal(typeof codex.backend.probe, 'function')
    assert.equal(typeof codex.backend.execute, 'function')
  })

  test('★ 两个 runtime 造出来的后端都属于同一份契约', () => {
    const claude = createRuntimeBackend('claude')
    const generic = createRuntimeBackend('generic')

    assert.equal(claude.backend.key, 'claude')
    assert.equal(generic.backend.key, 'generic')
    assert.notEqual(claude.backend.constructor, generic.backend.constructor, '确实是两个实现')

    for (const { backend, descriptor } of [claude, generic]) {
      assert.equal(backend.protocol, descriptor.protocol)
      // claude/generic 都是 cli 形状，resume 必然在位（上面那条按 kind 校验守着）
      assert.equal(backend.rejectDetectable, descriptor.resume?.rejectDetectable)
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
    assert.deepEqual(createRuntimeBackend('claude').descriptor.skills, {
      kind: 'directory',
      dir: '.claude/skills',
    })
  })

  test('第二个 runtime 不假装自己有技能机制（未验证 ⇒ 声明没有）', () => {
    const generic = createRuntimeBackend('generic').descriptor
    // ⚠️ 这条**改过**：原来是 `assert.notEqual(generic.skillDir, '.claude/skills')`
    //    ——那等于"只要目录名跟 claude 不一样就算填好了"。可 `.agent/skills`
    //    只是**猜的**：谁也没验证过那个 CLI 会不会扫它。按新规矩（见
    //    `RuntimeDescriptor.skills`），猜它支持与确认它不支持在效果上一样糟，
    //    都会把技能写进一个可能没人读的目录然后静默地不生效。
    assert.equal(generic.skills.kind, 'none', '未验证就该如实声明"没有"')
    assert.ok(generic.skills.kind === 'none' && generic.skills.reason.length > 20, '要说清缺什么证据')
  })
})
