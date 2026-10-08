import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  nodeSupportsTypeStripping,
  parseNodeVersion,
  versionGuardMessage,
} from './node-entry.mjs'

/**
 * Node 版本守卫的判据（2026-10 Windows 兼容性审计的 B1）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这些判据在 macOS/Node 24 上也测得动
 * ══════════════════════════════════════════════════════════════════
 *
 * 版本判断是纯函数（版本号是参数），所以"22.17 不合格、22.18 合格、23.0 不合格、
 * 23.6 合格"这些**全都是真的判据**，不依赖本机装的是哪个 node。
 * 唯一真起进程的那条（argv 转交）用的是**当前**这个 node——它守的是
 * "前置壳不会把入口的参数挪位"这件事，与版本无关。
 *
 * 临时目录沿用工作区内 `.cache/test-tmp` 的约定（不用系统 `/tmp`）。
 */
const TEST_TMP_ROOT = join(process.cwd(), '.cache', 'test-tmp')
const run = promisify(execFile)

describe('★ nodeSupportsTypeStripping：三条线各自的门槛', () => {
  test('★ 22 线：22.18 起（22.17 不合格——这是实测到的那个报错版本）', () => {
    assert.equal(nodeSupportsTypeStripping('22.17.0'), false)
    assert.equal(nodeSupportsTypeStripping('22.18.0'), true)
    assert.equal(nodeSupportsTypeStripping('22.20.1'), true)
    assert.equal(nodeSupportsTypeStripping('22.6.0'), false, '22.6 只是"有这个 flag"，不是默认可用')
  })

  test('★ 23 线：23.6 起（**23.0–23.5 不合格**，一句话版本会漏掉这一段）', () => {
    assert.equal(nodeSupportsTypeStripping('23.0.0'), false)
    assert.equal(nodeSupportsTypeStripping('23.5.9'), false)
    assert.equal(nodeSupportsTypeStripping('23.6.0'), true)
  })

  test('24 起一律合格；更老的都不合格', () => {
    assert.equal(nodeSupportsTypeStripping('24.0.0'), true)
    assert.equal(nodeSupportsTypeStripping('24.19.0'), true)
    assert.equal(nodeSupportsTypeStripping('21.7.3'), false)
    assert.equal(nodeSupportsTypeStripping('20.12.2'), false)
  })

  test('`v` 前缀、缺段、垃圾串都处理得了（垃圾当作不合格，不抛）', () => {
    assert.deepEqual(parseNodeVersion('v24.19.0'), [24, 19, 0])
    assert.deepEqual(parseNodeVersion('22.18'), [22, 18, 0])
    assert.deepEqual(parseNodeVersion('24'), [24, 0, 0])
    assert.equal(nodeSupportsTypeStripping(''), false)
    assert.equal(nodeSupportsTypeStripping(undefined), false)
    assert.equal(nodeSupportsTypeStripping('不是版本号'), false)
  })
})

describe('★ 守卫说的话要能照做', () => {
  test('点名使用者的版本，并给两条出路（装 24 / 用 flag 直接跑）', () => {
    const text = versionGuardMessage('22.17.0')
    assert.match(text, /v22\.17\.0/, '要说出他现在是哪个版本')
    assert.match(text, /22\.18/)
    assert.match(text, /nodejs\.org/, '要给下载地址')
    assert.match(text, /--experimental-strip-types/, '要给不升级也能跑的那条路')
    assert.match(text, /pnpm run .*传不了 flag/, '要说清为什么不能靠 pnpm 加 flag')
    // ⚠️ 这段话会进终端，也会被人贴进 issue：不能有 markdown 记号（`**` 到人眼里就是两个星号）
    assert.ok(!text.includes('**'), '别留 markdown 粗体记号')
  })
})

describe('★ 前置壳真起进程：argv 不能让入口看见自己这一层', () => {
  test('★ 入口按 slice(2) 读参数 ⇒ 拿到的正是"入口直接跑"的那份', async () => {
    await mkdir(TEST_TMP_ROOT, { recursive: true })
    const dir = await mkdtemp(join(TEST_TMP_ROOT, 'node-entry-'))
    try {
      const entry = join(dir, 'fake-entry.mjs')
      const out = join(dir, 'argv.json')
      await writeFile(
        entry,
        [
          `import { writeFileSync } from 'node:fs'`,
          // 入口按仓库里所有入口的约定读参数
          `writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))`,
          '',
        ].join('\n'),
        'utf8',
      )
      await run(process.execPath, ['scripts/node-entry.mjs', entry, '--port', '4599', '--no-open'])
      assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), ['--port', '4599', '--no-open'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('没给入口 ⇒ 用法提示 + 退出码 2（不是把控制权交给一个空路径）', async () => {
    await assert.rejects(
      run(process.execPath, ['scripts/node-entry.mjs']),
      (err) => {
        assert.equal(err.code, 2)
        assert.match(err.stderr, /用法/)
        return true
      },
    )
  })
})