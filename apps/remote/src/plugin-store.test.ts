import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginStore } from './plugin-store.ts'

/**
 * FR-PLUGIN-09（独立启停）与 FR-PLUGIN-11（密钥分开存放、权限更严）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 两件最要紧的事
 * ══════════════════════════════════════════════════════════════════
 *
 * **① 密钥不能出现在普通设定文件里。**
 *    混在一起的话，它有太多"顺手带出去"的路径：备份设定、把设定贴进
 *    issue、将来做"导出我的设定"。分成两个文件之后，
 *    **"普通设定"这个对象在结构上就不可能含有密钥**——这比"记得脱敏"可靠。
 *
 * **② 密钥的读取接口**只回"设没设"，不回值。
 *    值一旦进了 API 响应，就会出现在浏览器内存、日志、截图里，
 *    而调用方通常只想知道"配好了没有"。
 */

let dir: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'alpha-pluginstore-'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('插件启停状态（FR-PLUGIN-09）', () => {
  test('缺省是启用 —— 装进来就是"想用它"', async () => {
    const store = new PluginStore(dir)
    await store.load()
    assert.equal(store.isEnabled('never-mentioned'), true)
  })

  test('停用之后读回来是停用，且能重新启用', async () => {
    const store = new PluginStore(dir)
    await store.setEnabled('acme', false)
    assert.equal(store.isEnabled('acme'), false)
    await store.setEnabled('acme', true)
    assert.equal(store.isEnabled('acme'), true)
  })

  test('★ 停用状态会持久化 —— 重启后不该自己变回启用', async () => {
    const store = new PluginStore(dir)
    await store.setEnabled('persisted', false)

    const reopened = new PluginStore(dir)
    await reopened.load()
    assert.equal(
      reopened.isEnabled('persisted'),
      false,
      '重启后变回启用，等于使用者的关停动作被静默撤销',
    )
  })

  test('停用一个插件不影响别的插件', async () => {
    const store = new PluginStore(dir)
    await store.setEnabled('a', false)
    assert.equal(store.isEnabled('a'), false)
    assert.equal(store.isEnabled('b'), true, 'FR-PLUGIN-09 要求独立')
  })

  test('普通配置可读可合并写', async () => {
    const store = new PluginStore(dir)
    await store.setConfig('cfg', { region: 'cn' })
    const merged = await store.setConfig('cfg', { tier: 'pro' })
    assert.deepEqual(merged, { region: 'cn', tier: 'pro' })
  })
})

describe('★ 插件密钥（FR-PLUGIN-11）', () => {
  test('★ 密钥**不**写进普通状态文件', async () => {
    const store = new PluginStore(dir)
    await store.setConfig('sec', { region: 'cn' })
    await store.setSecret('sec', 'apiKey', 'super-secret-value')

    const stateRaw = await readFile(join(dir, 'plugins.state.json'), 'utf8')
    assert.ok(
      !stateRaw.includes('super-secret-value'),
      '密钥出现在普通状态文件里，就意味着它会跟着设定被备份、被导出、被贴进 issue',
    )

    const secretRaw = await readFile(join(dir, 'plugins.secrets.json'), 'utf8')
    assert.match(secretRaw, /super-secret-value/, '它应当在专门的密钥文件里')
  })

  test('★ 密钥文件权限是 0600 —— 同机其他用户读不到', async () => {
    const store = new PluginStore(dir)
    await store.setSecret('mode-test', 'k', 'v')
    const info = await stat(join(dir, 'plugins.secrets.json'))
    assert.equal(
      info.mode & 0o777,
      0o600,
      'umask 可能是 0022 甚至更松，装密钥的文件不该由 shell 配置间接决定谁能读',
    )
  })

  test('★ 第二次写入之后权限**仍然**是 0600', async () => {
    // `writeFile` 的 mode 只在**创建**时生效。少了那次显式 chmod，
    // 第二次写入之后权限就回到默认值了——而第一次的测试是绿的。
    const store = new PluginStore(dir)
    await store.setSecret('mode-twice', 'k1', 'v1')
    await store.setSecret('mode-twice', 'k2', 'v2')
    const info = await stat(join(dir, 'plugins.secrets.json'))
    assert.equal(info.mode & 0o777, 0o600)
  })

  test('★ 只回"哪些键已设置"，不回值', async () => {
    const store = new PluginStore(dir)
    await store.setSecret('acme', 'apiKey', 'should-not-leak')
    assert.deepEqual(store.secretKeysOf('acme'), ['apiKey'])
    assert.equal(store.hasSecret('acme', 'apiKey'), true)
    // secretOf 是给**进程内的插件代码**用的，不走 API
    assert.equal(store.secretOf('acme', 'apiKey'), 'should-not-leak')
  })

  test('没设置的键不会假装已设置', async () => {
    const store = new PluginStore(dir)
    assert.equal(store.hasSecret('nobody', 'apiKey'), false)
    assert.deepEqual(store.secretKeysOf('nobody'), [])
    assert.equal(store.secretOf('nobody', 'apiKey'), null)
  })

  test('★ 空字符串不算已设置 —— 空值会让插件以为配好了', async () => {
    const store = new PluginStore(dir)
    await store.setSecret('empty', 'apiKey', '')
    assert.equal(store.hasSecret('empty', 'apiKey'), false)
  })

  test('删除密钥返回是否真的删掉了', async () => {
    const store = new PluginStore(dir)
    await store.setSecret('del', 'k', 'v')
    assert.equal(await store.clearSecret('del', 'k'), true)
    assert.equal(await store.clearSecret('del', 'k'), false, '第二次删是同一种结果，但不该说"删了"')
    assert.equal(store.hasSecret('del', 'k'), false)
  })

  test('★ 密钥会持久化，重启后仍在', async () => {
    const store = new PluginStore(dir)
    await store.setSecret('persist', 'apiKey', 'v')
    const reopened = new PluginStore(dir)
    await reopened.load()
    assert.equal(reopened.secretOf('persist', 'apiKey'), 'v')
  })

  test('插件被移除时状态与密钥一起清掉', async () => {
    const store = new PluginStore(dir)
    await store.setEnabled('gone', false)
    await store.setSecret('gone', 'apiKey', 'v')
    await store.forget('gone')
    assert.equal(store.isEnabled('gone'), true, '回到缺省（启用）')
    assert.equal(store.hasSecret('gone', 'apiKey'), false)
  })

  test('dataDir 为 null（纯内存）时不报错，只是不持久化', async () => {
    const store = new PluginStore(null)
    await store.setSecret('mem', 'k', 'v')
    assert.equal(store.secretOf('mem', 'k'), 'v')
    assert.equal(store.secretsPath(), null)
  })
})
