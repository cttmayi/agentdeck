import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  KNOWN_CAPABILITIES,
  KNOWN_SCOPES,
  PluginRejected,
  enabledPluginsFor,
  loadPlugins,
  validateManifest,
} from './plugins.ts'

const valid = {
  apiVersion: 1,
  name: 'acme-sso',
  capability: 'login',
  version: '1.2.0',
  scopes: ['account:identify'],
}

describe('插件 manifest 校验（FR-PLUGIN）', () => {
  it('接受合法的 login 插件', () => {
    const m = validateManifest(valid)
    assert.equal(m.name, 'acme-sso')
    assert.equal(m.capability, 'login')
    assert.deepEqual(m.scopes, ['account:identify'])
  })

  it('未声明的 capability 被拒绝，且理由里列出宿主支持的能力', () => {
    assert.throws(
      () => validateManifest({ ...valid, capability: 'billing' }),
      (err: unknown) => {
        assert.ok(err instanceof PluginRejected)
        assert.match(err.message, /billing/)
        for (const c of KNOWN_CAPABILITIES) assert.match(err.message, new RegExp(c))
        return true
      },
    )
  })

  it('未声明的 scope 被拒绝 —— 白名单而非黑名单', () => {
    assert.throws(
      () => validateManifest({ ...valid, scopes: ['account:identify', 'fs:write'] }),
      (err: unknown) => {
        assert.ok(err instanceof PluginRejected)
        assert.match(err.message, /fs:write/)
        return true
      },
    )
  })

  it('已知 scope 全部放行（白名单与实现同步）', () => {
    for (const scope of KNOWN_SCOPES) {
      const m = validateManifest({ ...valid, scopes: [scope] })
      assert.deepEqual(m.scopes, [scope])
    }
  })

  it('apiVersion 不符时拒绝，并指出宿主认识的版本', () => {
    assert.throws(
      () => validateManifest({ ...valid, apiVersion: 2 }),
      /apiVersion 2/,
    )
  })

  it('缺少 version 时拒绝', () => {
    assert.throws(() => validateManifest({ ...valid, version: undefined }), /version/)
  })

  it('manifest 不是对象时拒绝，而不是抛类型错误', () => {
    assert.throws(() => validateManifest(null), PluginRejected)
    assert.throws(() => validateManifest('acme'), PluginRejected)
  })
})

describe('插件加载失败隔离（FR-PLUGIN-3）', () => {
  it('一个插件坏掉不影响其他插件加载', () => {
    const loaded = loadPlugins([
      { manifest: valid, impl: { query: () => ({}) } },
      { manifest: { ...valid, name: 'bad', scopes: ['nope:all'] }, impl: {} },
      { manifest: { ...valid, name: 'good2', capability: 'third-party' }, impl: {} },
    ])

    assert.equal(loaded.length, 3)
    assert.equal(loaded[0]?.enabled, true)
    assert.equal(loaded[1]?.enabled, false)
    assert.match(loaded[1]?.error ?? '', /nope:all/)
    assert.equal(loaded[2]?.enabled, true)
  })

  it('被拒绝的插件仍保留名字，便于在设置页面上报错', () => {
    const [bad] = loadPlugins([{ manifest: { ...valid, name: 'acme-sso', scopes: ['x'] }, impl: {} }])
    assert.equal(bad?.manifest.name, 'acme-sso')
    assert.equal(bad?.enabled, false)
    assert.ok(bad?.error)
  })

  it('manifest 完全无法解析时也有可展示的占位名', () => {
    const [bad] = loadPlugins([{ manifest: 42, impl: {} }])
    assert.equal(bad?.enabled, false)
    assert.equal(bad?.manifest.name, '(未命名)')
  })

  it('enabledPluginsFor 只返回已启用且能力匹配的插件', () => {
    const loaded = loadPlugins([
      { manifest: valid, impl: {} },
      { manifest: { ...valid, name: 'qq', capability: 'login' }, impl: {} },
      { manifest: { ...valid, name: 'tp', capability: 'third-party' }, impl: {} },
      { manifest: { ...valid, name: 'broken', scopes: ['z'] }, impl: {} },
    ])
    const logins = enabledPluginsFor(loaded, 'login').map((p) => p.manifest.name)
    assert.deepEqual(logins, ['acme-sso', 'qq'])

    const tp = enabledPluginsFor(loaded, 'third-party').map((p) => p.manifest.name)
    assert.deepEqual(tp, ['tp'])
  })
})
