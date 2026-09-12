import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { CLI_OPTIONS, DEFAULT_PORT, HELP, parseCliArgs } from './cli.ts'

/**
 * 命令行解析。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里钉住的核心是"**不要静默回落**"
 * ══════════════════════════════════════════════════════════════════
 *
 * 一个被忽略的选项比一个报错的选项危险得多：
 *
 *   - `--data-dir` 被忽略 ⇒ daemon 写到别的目录，使用者以为数据在那里；
 *   - `--sandbox workdir-write` 被忽略 ⇒ **沙箱根本没开**，而使用者以为
 *     自己被保护着。这正是本项目反复在防的那类失败：**把安全感变成假的**。
 *
 * `pnpm run daemon -- --port 4517` 这种写法会把 `--` 一并传给本程序，
 * 而 `parseArgs` 见到 `--` 就把之后的一切当位置参数——所有选项悄悄失效。
 * 更隐蔽的是 `--port 4517` 恰好等于默认端口，于是从输出上完全看不出异常。
 */

describe('daemon 命令行解析', () => {
  test('正常解析端口与数据目录', () => {
    const options = parseCliArgs(['--port', '4600', '--data-dir', '/tmp/x'])
    assert.equal(options.port, 4600)
    assert.equal(options.dataDir, '/tmp/x')
  })

  test('省略时用默认值', () => {
    const options = parseCliArgs([])
    assert.equal(options.port, DEFAULT_PORT)
    assert.equal(options.sandboxMode, 'none')
  })

  test('★ 出现 `--` 时**报错**，而不是静默忽略后面所有选项', () => {
    assert.throws(
      () => parseCliArgs(['--', '--port', '4600', '--data-dir', '/x']),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        assert.match(message, /--/, '要指出是什么东西有问题')
        assert.match(message, /pnpm run daemon --port/, '要给出正确的写法')
        assert.match(message, /静默回落|全部被忽略/, '要解释为什么报错而不是沉默')
        return true
      },
    )
  })

  test('★ 沙箱模式只能是已知取值，拼错必须报错', () => {
    assert.equal(parseCliArgs(['--sandbox', 'workdir-write']).sandboxMode, 'workdir-write')
    assert.equal(parseCliArgs(['--sandbox', 'none']).sandboxMode, 'none')
    // 一个拼错的 --sandbox 参数不该让使用者以为沙箱开着
    assert.throws(() => parseCliArgs(['--sandbox', 'workdir-writee']), /不合法/)
    assert.throws(() => parseCliArgs(['--sandbox', 'true']), /不合法/)
  })

  test('端口越界时报错', () => {
    assert.throws(() => parseCliArgs(['--port', '0']), /端口不合法/)
    assert.throws(() => parseCliArgs(['--port', '70000']), /端口不合法/)
    assert.throws(() => parseCliArgs(['--port', 'abc']), /端口不合法/)
  })

  test('文档里写的 `daemon start` 位置参数仍被接受（不是错误）', () => {
    const options = parseCliArgs(['daemon', 'start'])
    assert.equal(options.port, DEFAULT_PORT)
  })
})

describe('★ HELP 里承诺的旗标必须真的存在', () => {
  test('★ 帮助文本里的每一个 --flag 都在 CLI_OPTIONS 里', () => {
    // 这条测试的由来：我在写 --verify-runtime 的提示时**当场就撒了个谎**——
    // 让使用者"用 --executable 指定完整路径"，而那个旗标那时并不存在。
    //
    // 之所以没人发现，是因为 parseArgs 配了 strict: false（为了容忍
    // `daemon start` 这类位置参数），不认识的旗标会被**静默忽略**。
    // 于是"帮助里承诺了、程序不认"是一类可以长期潜伏的缺陷。
    //
    // 现在让两者可被机器比对：承诺与实现之间不再隔着人眼。
    const promised = [...new Set([...HELP.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]!))]
    assert.ok(promised.length > 0, 'HELP 里应该至少提到一个旗标')

    const implemented = new Set(Object.keys(CLI_OPTIONS))
    const missing = promised.filter((flag) => !implemented.has(flag))
    assert.deepEqual(
      missing,
      [],
      `HELP 承诺了但 CLI_OPTIONS 里没有的旗标：${missing.join(', ')}`,
    )
  })

  test('★ 反过来：CLI_OPTIONS 里的旗标也该在 HELP 里说明（不许有隐藏开关）', () => {
    const implemented = Object.keys(CLI_OPTIONS).filter((k) => k !== 'help')
    const missing = implemented.filter((flag) => !HELP.includes(`--${flag}`))
    assert.deepEqual(
      missing,
      [],
      `CLI_OPTIONS 里有但 HELP 没说明的旗标：${missing.join(', ')}——隐藏开关没人能发现`,
    )
  })
})
