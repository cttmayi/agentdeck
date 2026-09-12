import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPluginDirectory, resolveInPluginDir } from './loader.ts'

/**
 * 插件代码加载（P1）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里真正要证明的是一件事
 * ══════════════════════════════════════════════════════════════════
 *
 * 在 P1 落地之前，插件系统只做了"声明"那一半——`entry` 里的代码从来没被
 * 求值过。所以这些测试的核心不是"函数返回了正确的对象"，而是：
 *
 *     **第三方往目录里放一个 plugin.json + index.js，它真的会跑起来。**
 *
 * 另一半是安全：`entry` 是陌生人写的字符串，它能指向目录外面。
 */

let root: string

/** 写一个插件目录。 */
async function makePlugin(
  name: string,
  manifest: unknown,
  code?: string,
): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
  if (code !== undefined) await writeFile(join(dir, 'index.js'), code, 'utf8')
  return dir
}

const baseManifest = {
  apiVersion: 1,
  name: 'demo',
  capability: 'third-party',
  version: '1.0.0',
  scopes: ['thirdparty:query'],
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'alpha-plugin-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('★ 插件的代码真的会被加载执行（P1）', () => {
  test('★ 放一个 index.js 进去，它的 query 就真的能被调用', async () => {
    await makePlugin(
      'real',
      { ...baseManifest, name: 'real', entry: 'index.js' },
      `export function query(params) { return { echo: params.city, from: 'real-plugin' } }\n`,
    )
    // 这条是关键：早先 entry 里的代码从不被求值，插件只能靠宿主注入 impl
    const report = await loadPluginDirectory({ pluginDir: root })
    const plugin = report.plugins.find((p) => p.manifest.name === 'real')
    assert.ok(plugin, '插件应被加载')
    assert.equal(plugin.enabled, true, plugin.error ?? '')
    const impl = plugin.impl as { query: (p: Record<string, unknown>) => unknown }
    assert.deepEqual(impl.query({ city: '上海' }), { echo: '上海', from: 'real-plugin' })
  })

  test('支持 default 导出', async () => {
    await makePlugin(
      'defaulted',
      { ...baseManifest, name: 'defaulted', entry: 'index.js' },
      `export default { query: async () => ({ ok: true }) }\n`,
    )
    const report = await loadPluginDirectory({ pluginDir: root })
    const plugin = report.plugins.find((p) => p.manifest.name === 'defaulted')
    assert.equal(plugin?.enabled, true, plugin?.error ?? '')
    assert.ok((plugin?.impl as { query?: unknown })?.query)
  })

  test('没有 entry 的纯声明式插件照常加载，impl 为 null —— 这不是错误', async () => {
    await makePlugin('declarative', { ...baseManifest, name: 'declarative' })
    const report = await loadPluginDirectory({ pluginDir: root })
    const plugin = report.plugins.find((p) => p.manifest.name === 'declarative')
    assert.equal(plugin?.enabled, true)
    assert.equal(plugin?.impl, null)
    assert.equal(plugin?.error, null)
  })

  test('只读模式（allowCode: false）不执行代码，但 manifest 仍然被校验', async () => {
    await makePlugin(
      'nocode',
      { ...baseManifest, name: 'nocode', entry: 'index.js' },
      `export function query() { throw new Error('不该被执行') }\n`,
    )
    const report = await loadPluginDirectory({ pluginDir: root, allowCode: false })
    const plugin = report.plugins.find((p) => p.manifest.name === 'nocode')
    assert.equal(plugin?.enabled, true)
    assert.equal(plugin?.impl, null)
  })
})

describe('★ entry 必须留在插件目录内（陌生人写的字符串）', () => {
  test('★ `..` 逃逸被拒绝 —— 字符串前缀判断挡不住它', async () => {
    // 关键：这个路径**以插件目录开头**，但它落在插件目录之外。
    // 只做 startsWith 的实现会放它过去。
    const pluginDir = join(root, 'escape', 'plugins', 'evil')
    await mkdir(pluginDir, { recursive: true })
    assert.throws(
      () => resolveInPluginDir(pluginDir, '../../../../etc/passwd'),
      /越出/,
      '解析后的真实路径才是判据',
    )
  })

  test('绝对路径被拒绝', () => {
    assert.throws(() => resolveInPluginDir('/a/plugins/b', '/etc/passwd'), /绝对路径/)
  })

  test('目录内的正常相对路径通过', () => {
    const full = resolveInPluginDir('/a/plugins/b', 'sub/index.mjs')
    assert.equal(full, '/a/plugins/b/sub/index.mjs')
  })

  test('★ 逃逸的 entry 只让这个插件失败，不影响其他插件', async () => {
    await makePlugin('escaper', { ...baseManifest, name: 'escaper', entry: '../../../etc/hosts' })
    await makePlugin(
      'healthy',
      { ...baseManifest, name: 'healthy', entry: 'index.js' },
      `export function query() { return { ok: 1 } }\n`,
    )

    const report = await loadPluginDirectory({ pluginDir: root })
    const escaper = report.plugins.find((p) => p.manifest.name === 'escaper')
    const healthy = report.plugins.find((p) => p.manifest.name === 'healthy')

    assert.equal(escaper?.enabled, false)
    assert.match(escaper?.error ?? '', /越出/)
    assert.equal(healthy?.enabled, true, '一个坏插件不能连累别的插件')
  })
})

describe('插件加载的失败隔离与可读报错', () => {
  test('★ 语法错误的插件被隔离，其他插件照常工作', async () => {
    await makePlugin(
      'broken',
      { ...baseManifest, name: 'broken', entry: 'index.js' },
      `export function query( { 这根本不是合法的 JavaScript\n`,
    )
    await makePlugin(
      'fine',
      { ...baseManifest, name: 'fine', entry: 'index.js' },
      `export function query() { return { ok: true } }\n`,
    )

    const report = await loadPluginDirectory({ pluginDir: root, onWarn: () => {} })
    assert.equal(report.plugins.find((p) => p.manifest.name === 'broken')?.enabled, false)
    assert.equal(report.plugins.find((p) => p.manifest.name === 'fine')?.enabled, true)
  })

  test('entry 指向不存在的文件时给出可读错误，而不是难懂的 import 报错', async () => {
    await makePlugin('missing', { ...baseManifest, name: 'missing', entry: 'nope.js' })
    const report = await loadPluginDirectory({ pluginDir: root, onWarn: () => {} })
    const plugin = report.plugins.find((p) => p.manifest.name === 'missing')
    assert.equal(plugin?.enabled, false)
    assert.match(plugin?.error ?? '', /不存在/)
  })

  test('entry 指向目录时明确拒绝', async () => {
    const dir = await makePlugin('isdir', { ...baseManifest, name: 'isdir', entry: 'sub' })
    await mkdir(join(dir, 'sub'), { recursive: true })
    const report = await loadPluginDirectory({ pluginDir: root, onWarn: () => {} })
    const plugin = report.plugins.find((p) => p.manifest.name === 'isdir')
    assert.equal(plugin?.enabled, false)
    assert.match(plugin?.error ?? '', /目录/)
  })

  test('★ 不收 .ts —— 与其让第三方插件半死不活，不如加载时就拒绝', async () => {
    await makePlugin('typed', { ...baseManifest, name: 'typed', entry: 'index.ts' }, 'export const a: number = 1\n')
    const report = await loadPluginDirectory({ pluginDir: root, onWarn: () => {} })
    const plugin = report.plugins.find((p) => p.manifest.name === 'typed')
    assert.equal(plugin?.enabled, false)
    assert.match(plugin?.error ?? '', /\.js \/ \.mjs|不存在/)
  })

  test('plugin.json 不是合法 JSON 时给出可读错误', async () => {
    const dir = join(root, 'badjson')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'plugin.json'), '{ 这不是 json', 'utf8')
    const report = await loadPluginDirectory({ pluginDir: root, onWarn: () => {} })
    const plugin = report.plugins.find((p) => p.manifest.name === 'badjson')
    assert.equal(plugin?.enabled, false)
    assert.match(plugin?.error ?? '', /JSON/)
  })

  test('没有 plugin.json 的目录被跳过，不算插件也不报错', async () => {
    await mkdir(join(root, 'not-a-plugin'), { recursive: true })
    const report = await loadPluginDirectory({ pluginDir: root, onWarn: () => {} })
    assert.ok(!report.plugins.some((p) => p.manifest.name === 'not-a-plugin'))
  })

  test('插件目录不存在时返回空列表，而不是抛异常（首次启动的正常路径）', async () => {
    const report = await loadPluginDirectory({
      pluginDir: join(root, 'does-not-exist'),
      onWarn: () => {},
    })
    assert.deepEqual(report.plugins, [])
  })
})
