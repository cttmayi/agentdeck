import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CLI_OPTIONS, DEFAULT_PORT, HELP, isDirectInvocation, parseCliArgs } from './cli.ts'
import { DEFAULT_GITHUB_PROXY } from '@agentdeck/skill-source'

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

describe('★ `--github-proxy`（值可选：裸写 = 默认加速器）', () => {
  test('★ 裸写就用默认那一个，而且**不许把后面的旗标当成地址**', () => {
    // `--github-proxy --port 4599` 是最自然的打法（先想起加速器，再想起端口），
    // 而 `node:util` 的 parseArgs 会把 `--port` 当成前者的值 ⇒ 端口那项直接丢。
    const parsed = parseCliArgs(['--github-proxy', '--port', '4599'])
    assert.equal(parsed.githubProxy, DEFAULT_GITHUB_PROXY)
    assert.equal(parsed.port, 4599, '★ 后面的旗标不能被当成地址吃掉')
  })

  test('★ 给了地址用它；`off` 直连；不给就不开（默认仍然是直连）', () => {
    assert.equal(
      parseCliArgs(['--github-proxy', 'https://other.example']).githubProxy,
      'https://other.example',
    )
    assert.equal(parseCliArgs(['--github-proxy', 'off']).githubProxy, null)
    assert.equal(parseCliArgs([]).githubProxy, null, '不给旗标 ⇒ 直连')
  })

  test('★ 非法地址当场报错，而不是悄悄直连（同一类假安全感）', () => {
    assert.throws(() => parseCliArgs(['--github-proxy', 'http://gh-proxy.com']), /https/)
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

describe('入口判据 isDirectInvocation', () => {
  /**
   * ⚠️ 这条钉的是一个**只在 Windows 上现出来**的缺陷：入口判据曾经比 basename
   * （`import.meta.url.endsWith(argv1.split('/').pop())`），而 Windows 的 `argv[1]`
   * 是 `C:\…\cli.ts`（反斜杠）——`split('/')` 切不开，`endsWith` 永远 false ⇒
   * `main()` 不被调用、daemon 静默不启动。判据改成比**完整文件 URL** 之后才成立。
   *
   * 这条用例用**当前平台**的绝对路径（`resolve` 产出该平台的分隔符）：在 Windows 上
   * 跑时 `self` 天然带反斜杠，正好复现那个 bug（旧判据会返回 false、这条红）；在
   * macOS/Linux 上它至少钉住"比整条路径、不比 basename"这条不变式。
   */
  test('★ 认得出直接入口，且同名不同目录不算（比整条路径，不比 basename）', () => {
    const self = resolve('/', 'tmp', 'agentdeck', 'cli.ts')
    const url = pathToFileURL(self).href

    assert.equal(isDirectInvocation(self, url), true, '自己那条路径就是入口')
    // 另一个目录里的同名文件：basename 比较会把它误判成"是入口"
    assert.equal(
      isDirectInvocation(resolve('/', 'tmp', 'other', 'cli.ts'), url),
      false,
      '同名但不同目录的东西不是入口',
    )
    assert.equal(isDirectInvocation(undefined, url), false, '没有 argv[1]（被 import）不是入口')
    assert.equal(isDirectInvocation('', url), false, '空串不是入口')
  })
})
