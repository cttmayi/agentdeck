import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { BOOL_FLAGS, HELP, isDirectInvocation, OPTIONAL_VALUE_FLAGS, VALUE_FLAGS } from './cli.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 同步工具 CLI 的**参数层**：`--` 必须被大声拒绝、正确写法必须真的能跑。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这几条要起真进程
 * ══════════════════════════════════════════════════════════════════
 *
 * 要钉的那个缺陷**只存在于 argv 这一层**：pnpm **不会**吃掉 `--`
 * （`pnpm run X -- --dry-run` 传进来的 argv[0] 就是 `--`）。它在别处吃过真实的
 * 亏——`sync-skills` 曾经是远端 CLI 的子命令，带 `--` 时 `argv[0]` 不是
 * `sync-skills`，子命令匹配不上，于是那条命令**若无其事地把服务起起来**了
 * （2026-10 复核文档时真跑出来：输出"正在监听 http://127.0.0.1:4518"）。
 * 抓取现已独立成本工具，但"参数怎么进来"这件事仍然只有起真进程才看得见。
 *
 * 退出码与 stderr 的形状见 `cli.ts` 结尾的 `main().catch`：message + `exit(1)`。
 */

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url))

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

/** 起一个真进程跑工具。非零退出**不算**异常——那条路正是要观察的对象。 */
function runCli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--experimental-strip-types', CLI, ...args],
      { timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          // 非零退出时 `err.code` 就是退出码；**不是**数字（被 signal 杀掉、
          // 或根本没起来）时不能当成"退出码 0"糊过去——那会把"进程被杀了"
          // 读成"成功"，正是这个仓库最忌讳的那种静默。
          const code = (err as { code?: unknown }).code
          if (typeof code !== 'number') {
            reject(err)
            return
          }
          resolve({ code, stdout, stderr })
          return
        }
        resolve({ code: 0, stdout, stderr })
      },
    )
  })
}

describe('同步工具 CLI：`--` 那道闸', () => {
  test('★ 传了 `--` ⇒ 大声报错并给出能照抄的写法', async () => {
    const r = await runCli(['--', '--dry-run'])

    assert.equal(r.code, 1, '要被拒绝（非零退出），而不是"那就自己猜参数吧"')
    assert.match(r.stderr, /检测到 `--`/, '要指名道姓说清是哪个东西错了')
    assert.match(
      r.stderr,
      /pnpm run sync-skills --dry-run/,
      '要给出去掉 `--` 之后能照抄的那一行——只说"参数错误"会让人继续猜',
    )
    // 被拒的调用什么都不该做：连清单都不该读（读清单会联网）
    assert.ok(!r.stdout.includes('清单：'), '拒绝要发生在读清单之前')
  })

  test('★ 被拒绝的调用**什么都不碰**（闸排在所有落盘动作之前）', async () => {
    const dir = await makeTempDir('cli')
    try {
      const r = await runCli(['--', '--out', dir])

      assert.equal(r.code, 1)
      assert.deepEqual(await readdir(dir), [], '被拒绝的调用不许建目录、不许写盘')
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 手滑的参数（`--dryrun`）⇒ 报错，**绝不许当成"那就真同步吧"**', async () => {
    // 这条是这套参数检查存在的理由：`--dryrun`（少一个连字符）如果被静默忽略，
    // 结果不是"什么都没做"，而是**真的一次同步**——目录被替换了，而使用者以为
    // 只是在干跑。所以未知参数必须当场说出来。
    const dir = await makeTempDir('cli')
    try {
      const r = await runCli(['--dryrun', '--out', dir])

      assert.equal(r.code, 1)
      assert.match(r.stderr, /不认识的参数/, '要说出是哪个参数不认识')
      assert.match(r.stderr, /--dry-run/, '认得出这类手滑就直接点出来')
      assert.deepEqual(await readdir(dir), [], '★ 认不出参数就不许动盘——"真同步"比报错严重得多')
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 裸写 `--github-proxy` ⇒ 用默认加速器；`off` ⇒ 直连（能盖掉环境变量）', async () => {
    const dir = await makeTempDir('cli-proxy-default')
    try {
      // 裸写：不带地址，就用 https://gh-proxy.com（使用者 2026-10 定的省事写法）
      const bare = await runCli(['--github-proxy', '--manifest', join(dir, 'nope.json'), '--out', dir])
      assert.equal(bare.code, 1)
      assert.match(bare.stdout, /走 GitHub 加速器：gh-proxy\.com/, '裸写要用默认那一个')

      // ★ 后面那个 `--manifest` 不许被当成地址吃掉：吃掉就会去读**默认清单**，
      //   于是错误里出现的是别的路径（这条断言就是在钉这件事）
      assert.match(bare.stderr, /nope\.json/)

      // `off` 覆盖环境变量：这次就想直连
      const off = await runCli(['--github-proxy', 'off', '--manifest', join(dir, 'nope.json'), '--out', dir])
      assert.equal(off.code, 1)
      assert.ok(!/加速器/.test(off.stdout), '`off` 时不该出现任何加速器提示')
    } finally {
      await cleanup(dir)
    }
  })

  test('★ `--github-proxy` 被认识；但明文 http 与"GitHub 自己"当场拒绝', async () => {
    const dir = await makeTempDir('cli')
    try {
      // http 的加速器一律拒绝：链路上谁都能看和改，而加速器本来就已经能改
      const bad = await runCli(['--github-proxy', 'http://gh-proxy.com', '--out', dir])
      assert.equal(bad.code, 1)
      assert.match(bad.stderr, /https/)

      const self = await runCli(['--github-proxy', 'https://api.github.com', '--out', dir])
      assert.equal(self.code, 1)
      assert.match(self.stderr, /GitHub 自己/)

      // 合法地址会被接受（这里不真跑同步：用一个不存在的清单，走到读清单就停）
      const ok = await runCli([
        '--github-proxy',
        'https://gh-proxy.com',
        '--manifest',
        join(dir, 'nope.json'),
        '--out',
        dir,
      ])
      assert.equal(ok.code, 1)
      assert.match(ok.stderr, /nope\.json/, '参数被认下来了，才会走到读清单这一步')
      assert.ok(!/不认识的参数/.test(ok.stderr), '`--github-proxy` 必须是认识的参数')
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 去掉 `--` ⇒ 参数真的被认出来（闸没有把正确写法也挡掉）', async () => {
    const dir = await makeTempDir('cli')
    try {
      // 清单不存在 ⇒ 在读清单这一步就失败退出。这条钉的是"参数被读到了"：
      // 有闸之前 `--manifest` 会被 `--` 挤成位置参数，这里会变成"用默认清单"。
      const r = await runCli(['--manifest', join(dir, 'nope.json'), '--out', dir])

      assert.equal(r.code, 1, '清单不存在 ⇒ 失败退出（不是"用默认清单继续跑"）')
      assert.match(r.stderr, /nope\.json/, '要说清是哪个清单读不到，而不是笼统一句失败')
      assert.deepEqual(await readdir(dir), [], '读清单就失败了 ⇒ 一个字节都不该写')
    } finally {
      await cleanup(dir)
    }
  })
})

describe('★ HELP：命令记不住时的那条退路（而且它不许撒谎）', () => {
  test('★ `--help` / `-h` ⇒ 打出用法、退出码 0、**一个字都不碰**', async () => {
    const dir = await makeTempDir('cli-help')
    try {
      for (const flag of ['--help', '-h']) {
        const r = await runCli([flag, '--out', dir])

        assert.equal(r.code, 0, `${flag} 该以 0 退出（"我只是想看怎么用"不是错误）`)
        assert.match(r.stdout, /用法：/, '要给出用法')
        assert.match(r.stdout, /--github-proxy/, '每个旗标都要在帮助里')
        // ★ 帮助是**只读**的：不读清单（读清单会联网）、不建目录、不写盘。
        //   ⚠️ 判据不能写成"输出里没有『清单』"——帮助文本自己就写着"读清单"这几个字
        //   （第一次就是这么写错的）。钉的是**同步有没有真的跑起来**：跑起来会打出
        //   `清单：N 条（核对于 …）`，而帮助只有用法。
        assert.ok(!/清单：\d+ 条/.test(r.stdout), '帮助不该真的去跑一次同步')
        assert.ok(!/ENOENT/.test(r.stdout), '帮助不该因为找不到清单而报错')
        assert.deepEqual(await readdir(dir), [], '帮助不许有任何副作用')
      }
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 帮助里承诺的每个 `--flag` 都真的存在（不许撒谎）', () => {
    // 抄的是 daemon 那条检查（`apps/daemon/src/cli.test.ts`）——那边的由来是一次真事：
    // 提示里让人用一个当时并不存在的旗标。而**没人发现**是因为不认识的旗标会被静默
    // 忽略；所以这里让"承诺"与"实现"能机器比对。
    const promised = [...new Set([...HELP.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]!))]
    assert.ok(promised.length > 0, 'HELP 里该至少提到一个旗标')

    const implemented = new Set(
      [...VALUE_FLAGS, ...OPTIONAL_VALUE_FLAGS, ...BOOL_FLAGS].map((f) => f.replace(/^--/, '')),
    )
    const missing = promised.filter((flag) => !implemented.has(flag))
    assert.deepEqual(missing, [], `HELP 承诺了但没有实现的旗标：${missing.join(', ')}`)
  })

  test('★ 反过来：实现的每个旗标都要在帮助里说明（不许有隐藏开关）', () => {
    const documented = [...VALUE_FLAGS, ...OPTIONAL_VALUE_FLAGS, ...BOOL_FLAGS].filter(
      (f) => f !== '--help',
    )
    const missing = documented.filter((flag) => !HELP.includes(flag))
    assert.deepEqual(missing, [], `实现了但帮助里没写的旗标（隐藏开关）：${missing.join(', ')}`)
  })
})

describe('入口判据 isDirectInvocation', () => {
  /**
   * 与 `apps/daemon/src/cli.ts` 同一套判据，同一个 Windows 缺陷：曾经比 basename，
   * 而 Windows 的 `argv[1]` 是反斜杠 ⇒ 判据永远 false ⇒ 命令静默什么都不做。
   * 用**当前平台**的绝对路径：在 Windows 上 `self` 天然带反斜杠，正好复现那个 bug。
   */
  test('★ 比整条路径，不比 basename（Windows 反斜杠曾让它永远 false）', () => {
    const self = resolve('/', 'tmp', 'sync', 'cli.ts')
    const url = pathToFileURL(self).href

    assert.equal(isDirectInvocation(self, url), true)
    assert.equal(isDirectInvocation(resolve('/', 'tmp', 'other', 'cli.ts'), url), false)
    assert.equal(isDirectInvocation(undefined, url), false)
  })
})
