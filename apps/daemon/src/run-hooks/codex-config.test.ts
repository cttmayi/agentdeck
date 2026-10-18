/**
 * codex 个人配置隔离（2026-10，D78 的 codex 版）：`syncCodexConfigDir` 的行为。
 *
 * 重点断言的是「copy 进受管目录的文件长什么样」：auth.json 与 config.toml
 * 整份 copy、文件 600（里面都有真实 key，只给属主读）、幂等覆盖（改 key
 * 即时生效）、以及源文件缺失时**返回 ok:false 带原因**而不是抛异常
 * （调用方据此记 note——不悄悄"以为隔离了"）。
 *
 * ⚠️ 临时目录一律走 `makeTempDir`（`.cache/test-tmp`）。这里不 spawn 任何
 * CLI（NFR-T-01：测试里绝不调用真实 agent CLI）。
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanup, makeTempDir } from '../testing/tmp.ts'
import { syncCodexConfigDir } from './codex-config.ts'

test('syncCodexConfigDir：把源 ~/.codex 的 auth.json 与 config.toml copy 进受管目录', async () => {
  const root = await makeTempDir('ccd-codex')
  try {
    const source = join(root, 'codex-home')
    const configDir = join(root, 'codex-config')
    // 模拟 ~/.codex：auth.json（认证）与 config.toml（端点和 key 混在一起）
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test-456' }), 'utf8')
    await writeFile(
      join(source, 'config.toml'),
      'model = "codex"\n[model_providers.local]\nbase_url = "http://127.0.0.1:8080"\napi_key = "sk-xxxx"\n',
      'utf8',
    )

    const result = await syncCodexConfigDir(configDir, source)
    assert.equal(result.ok, true, '正常同步应成功')
    assert.deepEqual(result.copied, ['auth.json', 'config.toml'])

    const auth = JSON.parse(await readFile(join(configDir, 'auth.json'), 'utf8')) as { OPENAI_API_KEY: string }
    assert.equal(auth.OPENAI_API_KEY, 'sk-test-456')
    const toml = await readFile(join(configDir, 'config.toml'), 'utf8')
    assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:8080"/, 'config.toml 整份 copy（端点不能丢）')

    // ★ 两个文件都有真实 key：只给属主读
    for (const name of ['auth.json', 'config.toml']) {
      const mode = (await stat(join(configDir, name))).mode & 0o777
      assert.equal(mode, 0o600, `${name} 应为 600（有 key）`)
    }
  } finally {
    await cleanup(root)
  }
})

test('syncCodexConfigDir：幂等覆盖——改源 key 后重新同步即时生效', async () => {
  const root = await makeTempDir('ccd-codex-idem')
  try {
    const source = join(root, 'codex-home')
    const configDir = join(root, 'codex-config')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-old' }), 'utf8')
    await writeFile(join(source, 'config.toml'), 'model = "codex"\n', 'utf8')

    await syncCodexConfigDir(configDir, source)
    // 使用者换了 key（幂等语义：每次 run 现读现 copy，不用重启 daemon）
    await writeFile(join(source, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-new' }), 'utf8')
    const result = await syncCodexConfigDir(configDir, source)

    assert.equal(result.ok, true)
    const auth = JSON.parse(await readFile(join(configDir, 'auth.json'), 'utf8')) as { OPENAI_API_KEY: string }
    assert.equal(auth.OPENAI_API_KEY, 'sk-new', '重新同步应覆盖旧值')
  } finally {
    await cleanup(root)
  }
})

test('syncCodexConfigDir：源缺文件 → ok:false 带原因，不抛异常', async () => {
  const root = await makeTempDir('ccd-codex-missing')
  try {
    const source = join(root, 'codex-home')
    const configDir = join(root, 'codex-config')
    // 只有 auth.json，没有 config.toml——codex 在受管目录下起不到"和平时
    // 一样"的状态（端点定义丢了），必须明说没隔离，不能悄悄跑偏
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'auth.json'), '{}', 'utf8')

    const result = await syncCodexConfigDir(configDir, source)
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /config\.toml/, '原因要指明缺哪个文件')
    assert.deepEqual(result.copied, ['auth.json'])
  } finally {
    await cleanup(root)
  }
})

test('syncCodexConfigDir：源目录不存在 → ok:false 带原因', async () => {
  const root = await makeTempDir('ccd-codex-nosrc')
  try {
    const source = join(root, 'no-such-codex-home')
    const configDir = join(root, 'codex-config')
    const result = await syncCodexConfigDir(configDir, source)
    assert.equal(result.ok, false)
    assert.ok(result.reason, '要有原因')
  } finally {
    await cleanup(root)
  }
})
