import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 远端 CLI 的**参数闸**：任何它没看懂的参数都不许被"按默认往下走"消化掉。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这几条要起真进程
 * ══════════════════════════════════════════════════════════════════
 *
 * 这个 CLI **不做子命令分派**：它没看懂的 token 不会报错，而是继续往下走，最后
 * "服务起来了"。那看起来像成功——2026-10 真踩了两次，两次都是同一个形状：
 *
 *   1. `pnpm run remote -- sync-skills`（当时抓取还是子命令）：`--` 被 pnpm 原样
 *      传进来占掉 `argv[0]`，子命令匹配不上 ⇒ 输出"正在监听 http://127.0.0.1:4518"。
 *      要的是同步技能，发生的是跑服务。
 *   2. 抓取改成独立工具之后，`pnpm run remote sync-skills` 这条**原来有意义**的
 *      写法：不再匹配任何东西 ⇒ 又是"正在监听…"。写这条测试时实测它挂了 **300 秒**
 *      才被外部杀掉，整个过程没有一行说自己理解错了。
 *
 * 所以判据必须是"真进程的退出码 + 真 stderr"，而且**成功那侧不能靠等超时**：
 * 超时要卡得比服务启动还短，否则一次回归会变成挂半分钟才报红。
 */

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url))

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 起一个真进程跑 CLI。
 *
 * ⚠️ `timeoutMs` 故意很短（3 秒）：被拒的调用应当**立刻**退出。一次"没被拒 ⇒
 * 变成起服务"的回归会挂住，3 秒就红——而不是让人等半分钟还以为在跑。
 */
function runCli(args: readonly string[], timeoutMs = 3_000): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--experimental-strip-types', CLI, ...args],
      { timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as { code?: unknown }).code
          // 被信号杀掉（= 超时）也当成一种**可断言的**结果：那时的现象正是
          // "它去起服务了，没人拦"，用一个不可能等于 1 的 -1 表示。
          resolve({ code: typeof code === 'number' ? code : -1, stdout, stderr })
          return
        }
        resolve({ code: 0, stdout, stderr })
      },
    )
  })
}

describe('远端 CLI：参数闸（不许把不懂的参数当成"那就起服务吧"）', () => {
  test('★ `pnpm run remote sync-skills`（旧写法）⇒ 报错并指名**新命令**，不许起服务', async () => {
    // 这条就是那次挂了 300 秒的命令。它现在必须**立刻**失败。
    const r = await runCli(['sync-skills'])

    assert.equal(r.code, 1, '要被拒绝（非零退出），而不是"那就跑服务吧"')
    assert.match(r.stderr, /pnpm run sync-skills/, '要说清现在该用哪个命令')
    assert.match(r.stderr, /独立工具/, '以及为什么（抓取已经不在这个命令里了）')
    assert.ok(
      !r.stdout.includes('正在监听'),
      '不许把服务起起来——那正是改版前的坏行为：意图被静默替换，且没人说',
    )
  })

  test('★ 传了 `--` ⇒ 大声报错并给出能照抄的写法，也不许起服务', async () => {
    // 这就是 `pnpm run remote -- --port 4519` 传给 CLI 的那个 argv。
    const r = await runCli(['--', '--port', '4519'])

    assert.equal(r.code, 1)
    assert.match(r.stderr, /检测到 `--`/)
    assert.match(r.stderr, /pnpm run remote --port 4519/, '要给出正确写法')
    assert.ok(!r.stdout.includes('正在监听'), '不许把服务起起来')
  })

  test('★ 合法选项**不能**被这道闸误伤（认得出 `--port` 与 `--data-dir`）', async () => {
    // `--port 0` 是个巧妙的探针：它被**认出来**了，所以不会走"不认识的位置参数"
    // 那条路，而是走进 parsePort 的取值校验（0 不在 1-65535 里）⇒ 报那个错。
    // 于是"闸有没有误伤正常用法"这件事，不用真把服务起起来就能断言。
    const r = await runCli(['--port', '0'])

    assert.equal(r.code, 1)
    assert.match(r.stderr, /1-65535/, '`--port` 的值要真的被消费掉、送进校验')
    assert.ok(!/不认识的位置参数/.test(r.stderr), '合法选项不许被当成多余位置参数')
  })

  test('★ 被拒绝的调用**什么都不碰**（闸排在所有落盘动作之前）', async () => {
    // 闸如果排到数据目录那段之后，一个被拒的调用会顺带建目录 / 搬数据目录
    // （`migrateLegacyRemoteDir`），而使用者以为"什么都没发生"。
    const dir = await makeTempDir('remote-cli')
    try {
      const r = await runCli(['sync-skills', '--data-dir', dir])

      assert.equal(r.code, 1)
      assert.deepEqual(await readdir(dir), [], '被拒绝的调用不许建目录、不许写盘')
    } finally {
      await cleanup(dir)
    }
  })
})
