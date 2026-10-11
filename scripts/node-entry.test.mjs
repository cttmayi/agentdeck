import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseNodeVersion, typeStrippingMode, versionGuardMessage } from './node-entry.mjs'

/**
 * Node 版本守卫的判据（2026-10 Windows 兼容性审计的 B1；同日使用者要求"兼容 22"后扩成三档）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这些判据在 macOS/Node 24 上也测得动
 * ══════════════════════════════════════════════════════════════════
 *
 * 版本判断是纯函数（版本号是参数），所以"22.5 不合格、22.6 要补 flag、22.18 免开关、
 * 23.5 要补 flag、23.6 免开关"这些**全都是真的判据**，不依赖本机装的是哪个 node。
 * 真起进程的那几条（argv 转交、`--test` 透传）用的是**当前**这个 node——它们守的是
 * "前置壳不会把入口的参数挪位 / 不会把测试运行器吃掉"，与版本无关。
 *
 * ⚠️ "22.6–22.17 补上 flag 真能跑通"这条**不在这里测**：本机是 Node 24，凑不出一个
 * 22.17。它由 `scripts/node-entry.mjs` 的 `flag` 档 + 一次真机验证（真的 Node 22.17.0
 * 跑 `pnpm run cli` 与 `pnpm run test`）保证，见 D75。
 *
 * 临时目录沿用工作区内 `.cache/test-tmp` 的约定（不用系统 `/tmp`）。
 */
const TEST_TMP_ROOT = join(process.cwd(), '.cache', 'test-tmp')
const run = promisify(execFile)

/**
 * 起子进程时把 `NODE_TEST_CONTEXT` 摘掉。
 *
 * ⚠️ 不摘就会**假绿**：外层测试运行器会给它起的每个子进程塞
 * `NODE_TEST_CONTEXT=child-v8`，里层再 `node --test` 时那个 node 就以为自己是
 * "被跑的测试文件"，把结果走内部通道回报给外层，并且**一律退出 0**——
 * 于是"失败的测试要传成退出码 1"这条判据永远不可能失败（实测：同一个夹具，
 * 带这个变量 exit=0，摘掉 exit=1）。测"退出码会如实回传"时，这个变量必须清掉。
 */
function envWithoutTestRunner() {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return env
}

describe('★ typeStrippingMode：三条线各自的门槛，分三档', () => {
  test('★ 22 线：<22.6 只能升级、22.6–22.17 补 flag、22.18 起免开关', () => {
    assert.equal(typeStrippingMode('22.5.9'), 'unsupported', '连 --experimental-strip-types 都没有')
    assert.equal(typeStrippingMode('22.6.0'), 'flag', '22.6 只是"有这个 flag"，不是默认可用')
    assert.equal(typeStrippingMode('22.17.0'), 'flag', '这是实测到 ERR_UNKNOWN_FILE_EXTENSION 的那个版本')
    assert.equal(typeStrippingMode('22.18.0'), 'native')
    assert.equal(typeStrippingMode('22.20.1'), 'native')
  })

  test('★ 23 线：23.0–23.5 补 flag、23.6 起免开关（一句话版本会漏掉这一段）', () => {
    assert.equal(typeStrippingMode('23.0.0'), 'flag')
    assert.equal(typeStrippingMode('23.5.9'), 'flag')
    assert.equal(typeStrippingMode('23.6.0'), 'native')
  })

  test('24 起一律免开关；更老的一律只能升级', () => {
    assert.equal(typeStrippingMode('24.0.0'), 'native')
    assert.equal(typeStrippingMode('24.19.0'), 'native')
    assert.equal(typeStrippingMode('21.7.3'), 'unsupported')
    assert.equal(typeStrippingMode('20.12.2'), 'unsupported')
  })

  test('`v` 前缀、缺段、垃圾串都处理得了（垃圾当作最老的一档，不抛）', () => {
    assert.deepEqual(parseNodeVersion('v24.19.0'), [24, 19, 0])
    assert.deepEqual(parseNodeVersion('22.18'), [22, 18, 0])
    assert.deepEqual(parseNodeVersion('24'), [24, 0, 0])
    assert.equal(typeStrippingMode(''), 'unsupported')
    assert.equal(typeStrippingMode(undefined), 'unsupported')
    assert.equal(typeStrippingMode('不是版本号'), 'unsupported')
  })
})

describe('★ 守卫说的话要能照做（只在"连开关都没有"时才说）', () => {
  test('点名使用者的版本，说清 22.6 是门槛，并给下载地址', () => {
    const text = versionGuardMessage('22.5.0')
    assert.match(text, /v22\.5\.0/, '要说出他现在是哪个版本')
    assert.match(text, /22\.6/, '门槛是 22.6，不是 22.18')
    assert.match(text, /nodejs\.org/, '要给下载地址')
    // ⚠️ 这段话会进终端，也会被人贴进 issue：不能有 markdown 记号（`**` 到人眼里就是两个星号）
    assert.ok(!text.includes('**'), '别留 markdown 粗体记号')
  })

  test('⚠️ 不再让使用者自己加 flag —— 那一档现在是守卫自动补的', () => {
    const text = versionGuardMessage('22.5.0')
    assert.ok(
      !/临时用带 flag 的方式/.test(text),
      '22.6–22.17 已经由守卫自动补 flag；这段话只对"连 flag 都没有"的版本说，不该再教人手动加',
    )
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
      // ⚠️ 这条在 22.6–22.17 上会走 spawn 那条路（子进程多带一个 flag），在 24 上走 import
      // 那条路——两条路都要让入口拿到同样的 argv，所以这条判据在两种 node 上都成立。
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

describe('★ `--test` 透传：pnpm run test 也走这一层', () => {
  test('★ 起的就是 node 的测试运行器，退出码如实回传（过 0、败 1）', async () => {
    await mkdir(TEST_TMP_ROOT, { recursive: true })
    const dir = await mkdtemp(join(TEST_TMP_ROOT, 'node-entry-test-'))
    try {
      const pass = join(dir, 'pass.test.ts')
      const fail = join(dir, 'fail.test.ts')
      const body = (left, right) =>
        [
          `import { test } from 'node:test'`,
          `import assert from 'node:assert/strict'`,
          `test('fixture', () => { assert.equal(${left}, ${right}) })`,
          '',
        ].join('\n')
      await writeFile(pass, body(1, 1), 'utf8')
      await writeFile(fail, body(1, 2), 'utf8')

      // 过：execFile resolve
      await run(process.execPath, ['scripts/node-entry.mjs', '--test', pass], {
        env: envWithoutTestRunner(),
      })

      // 败：node --test 退出码 1，得原样传出来（否则 CI 会把红的当绿的）
      await assert.rejects(
        run(process.execPath, ['scripts/node-entry.mjs', '--test', fail], {
          env: envWithoutTestRunner(),
        }),
        (err) => {
          assert.equal(err.code, 1)
          return true
        },
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
