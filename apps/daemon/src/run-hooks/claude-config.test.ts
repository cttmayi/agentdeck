/**
 * claude 个人配置隔离（2026-10，D78）：`syncClaudeConfigDir` 的行为。
 *
 * 重点断言的是「写下去的受管 settings.json 长什么样」：只 copy env、键值
 * 是字符串、文件 600（里面有真实 key，只给属主读）、幂等覆盖、以及源文件
 * 缺失/损坏时**返回 ok:false 带原因**而不是抛异常（调用方据此记 note）。
 *
 * ⚠️ 临时目录一律走 `makeTempDir`（`.cache/test-tmp`）。这里不 spawn 任何
 * CLI（NFR-T-01：测试里绝不调用真实 agent CLI）。
 */

import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanup, makeTempDir } from '../testing/tmp.ts'
import { MANAGED_SETTINGS_REL, syncClaudeConfigDir } from './claude-config.ts'

test('syncClaudeConfigDir：把源 settings.json 的 env 写进受管目录', async () => {
  const root = await makeTempDir('ccd-sync')
  try {
    const source = join(root, 'src-settings.json')
    const configDir = join(root, 'claude-config')
    await writeFile(
      source,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080',
          ANTHROPIC_AUTH_TOKEN: 'sk-test-123',
          MAX_THINKING_TOKENS: '16000',
        },
        // 非 env 的键是用户级行为配置，隔离掉——不写进受管目录
        enabledPlugins: {},
        alwaysThinkingEnabled: false,
      }),
      'utf8',
    )

    const result = await syncClaudeConfigDir(configDir, source)
    assert.equal(result.ok, true, '正常同步应成功')
    assert.equal(result.envCount, 3)

    const written = JSON.parse(
      await readFile(join(configDir, MANAGED_SETTINGS_REL), 'utf8'),
    ) as { env: Record<string, string> }
    assert.deepEqual(written.env, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080',
      ANTHROPIC_AUTH_TOKEN: 'sk-test-123',
      MAX_THINKING_TOKENS: '16000',
    })
    // ★ 受管 settings.json 里有真实 key——只能属主读，别让同机其他用户看见
    const mode = (await stat(join(configDir, MANAGED_SETTINGS_REL))).mode & 0o777
    assert.equal(mode, 0o600, '含 key 的 settings.json 必须是 600')
  } finally {
    await cleanup(root)
  }
})

test('syncClaudeConfigDir：幂等——第二次同步覆盖旧 env（改 key 即时生效）', async () => {
  const root = await makeTempDir('ccd-idem')
  try {
    const source = join(root, 'src-settings.json')
    const configDir = join(root, 'claude-config')
    await writeFile(
      source,
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-old' } }),
      'utf8',
    )
    await syncClaudeConfigDir(configDir, source)
    // 使用者换了 key
    await writeFile(
      source,
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-new' } }),
      'utf8',
    )
    const result = await syncClaudeConfigDir(configDir, source)
    assert.equal(result.ok, true)
    const written = JSON.parse(
      await readFile(join(configDir, MANAGED_SETTINGS_REL), 'utf8'),
    ) as { env: Record<string, string> }
    assert.equal(written.env['ANTHROPIC_AUTH_TOKEN'], 'sk-new', '第二次同步必须覆盖第一次')
  } finally {
    await cleanup(root)
  }
})

test('syncClaudeConfigDir：只挑字符串 env 值，别的类型不进受管文件', async () => {
  const root = await makeTempDir('ccd-types')
  try {
    const source = join(root, 'src-settings.json')
    const configDir = join(root, 'claude-config')
    await writeFile(
      source,
      JSON.stringify({ env: { STRING_OK: 'v', NUMBER_BAD: 42, BOOL_BAD: true } }),
      'utf8',
    )
    const result = await syncClaudeConfigDir(configDir, source)
    assert.equal(result.ok, true)
    assert.equal(result.envCount, 1)
    const written = JSON.parse(
      await readFile(join(configDir, MANAGED_SETTINGS_REL), 'utf8'),
    ) as { env: Record<string, string> }
    assert.deepEqual(written.env, { STRING_OK: 'v' })
  } finally {
    await cleanup(root)
  }
})

test('syncClaudeConfigDir：源缺失/JSON 坏/无 env → ok:false 带原因（不抛异常）', async () => {
  const root = await makeTempDir('ccd-fail')
  try {
    const configDir = join(root, 'claude-config')

    const missing = await syncClaudeConfigDir(configDir, join(root, 'no-such.json'))
    assert.equal(missing.ok, false)
    assert.ok(missing.reason?.includes('读不到源配置'), `原因要可读：${missing.reason}`)

    const bad = join(root, 'bad.json')
    await writeFile(bad, '{not json', 'utf8')
    const corrupt = await syncClaudeConfigDir(configDir, bad)
    assert.equal(corrupt.ok, false)
    assert.ok(corrupt.reason?.includes('不是合法 JSON'), `原因要可读：${corrupt.reason}`)

    const noEnv = join(root, 'noenv.json')
    await writeFile(noEnv, JSON.stringify({ permissions: {} }), 'utf8')
    const withoutEnv = await syncClaudeConfigDir(configDir, noEnv)
    assert.equal(withoutEnv.ok, false)
    assert.ok(withoutEnv.reason?.includes('没有 env'), `原因要可读：${withoutEnv.reason}`)
  } finally {
    await cleanup(root)
  }
})

