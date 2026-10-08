import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicWrite, renameWithRetry } from './fs-utils.ts'

/**
 * 原子写与"Windows 上 rename 会偶发失败"的判据（2026-10 兼容性审计的 B6）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这些判据在 macOS 上怎么成立
 * ══════════════════════════════════════════════════════════════════
 *
 * 平台、`rename`、`sleep` 三者都是**注入**的，所以"Windows 上 EPERM 会重试到第 4 次"
 * 这件事可以在 macOS 上逐次钉住——而且不真的睡 300ms（注入的 sleep 立刻返回）。
 *
 * ⚠️ 判断"该不该重试"用的是错误码（`EPERM`/`EACCES`/`EBUSY`）；别的错误码
 *    **一次都不重试**——那条判据同样在下面钉着（不然"磁盘满了"会变成 300ms 的等待）。
 *
 * 临时目录沿用工作区内 `.cache/test-tmp` 的约定（不用系统 `/tmp`）。
 */
const TEST_TMP_ROOT = join(process.cwd(), '.cache', 'test-tmp')

async function makeTempDir(prefix: string): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return mkdtemp(join(TEST_TMP_ROOT, prefix))
}

describe('★ renameWithRetry：Windows 上的偶发 EPERM 要退避重试', () => {
  test('★ Windows：前两次 EPERM、第三次成功 ⇒ 最终成功，且等了 20+40ms', async () => {
    const slept: number[] = []
    let calls = 0
    await renameWithRetry('a', 'b', {
      platform: 'win32',
      rename: async () => {
        calls += 1
        if (calls <= 2) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      },
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    assert.equal(calls, 3)
    assert.deepEqual(slept, [20, 40])
  })

  test('★ Windows：一直 EPERM ⇒ 试满 4 次退避后把**原始错误**抛出去', async () => {
    const slept: number[] = []
    let calls = 0
    await assert.rejects(
      renameWithRetry('a', 'b', {
        platform: 'win32',
        rename: async () => {
          calls += 1
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
        },
        sleep: async (ms) => {
          slept.push(ms)
        },
      }),
      /EPERM/,
    )
    assert.equal(calls, 5, '1 次首发 + 4 次重试')
    assert.deepEqual(slept, [20, 40, 80, 160], '退避要递增，不是死循环')
  })

  test('★ 非 Windows：一次都不重试（不然"真的没权限"要晚 300ms 才报出来）', async () => {
    let calls = 0
    await assert.rejects(
      renameWithRetry('a', 'b', {
        platform: 'linux',
        rename: async () => {
          calls += 1
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        },
        sleep: async () => {},
      }),
      /EACCES/,
    )
    assert.equal(calls, 1)
  })

  test('★ 不会因为"重试"而把别的错误也拖慢：ENOSPC 一次就抛', async () => {
    let calls = 0
    let slept = 0
    await assert.rejects(
      renameWithRetry('a', 'b', {
        platform: 'win32',
        rename: async () => {
          calls += 1
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
        },
        sleep: async () => {
          slept += 1
        },
      }),
      /ENOSPC/,
    )
    assert.equal(calls, 1, '磁盘满不是"别人正开着"，重试没有意义')
    assert.equal(slept, 0)
  })

  test('没有错误码的异常也一次就抛（不猜）', async () => {
    let calls = 0
    await assert.rejects(
      renameWithRetry('a', 'b', {
        platform: 'win32',
        rename: async () => {
          calls += 1
          throw new Error('说不清哪里错了')
        },
        sleep: async () => {},
      }),
      /说不清/,
    )
    assert.equal(calls, 1)
  })
})

describe('★ atomicWrite：正常路径没被这次改动碰坏', () => {
  test('写进去的内容是对的，且不留下临时文件', async () => {
    const dir = await makeTempDir('atomic-')
    try {
      const target = join(dir, 'meta.json')
      await atomicWrite(target, JSON.stringify({ hello: '世界' }))
      assert.equal(await readFile(target, 'utf8'), '{"hello":"世界"}')
      const { readdir } = await import('node:fs/promises')
      assert.deepEqual(await readdir(dir), ['meta.json'], '临时文件必须已经被 rename 掉')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('覆盖已有文件（`meta.json` 每次启动都重写，走的就是这条）', async () => {
    const dir = await makeTempDir('atomic2-')
    try {
      const target = join(dir, 'meta.json')
      await writeFile(target, '旧的', 'utf8')
      await atomicWrite(target, '新的')
      assert.equal(await readFile(target, 'utf8'), '新的')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('★ 注入的 rename 被真的用上了（说明接线没断）', async () => {
    const dir = await makeTempDir('atomic3-')
    try {
      const target = join(dir, 'x.json')
      let renamed = 0
      await atomicWrite(target, 'x', {
        platform: 'win32',
        rename: async (from, to) => {
          renamed += 1
          const { rename: real } = await import('node:fs/promises')
          await real(from, to)
        },
      })
      assert.equal(renamed, 1)
      assert.equal(await readFile(target, 'utf8'), 'x')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('目标目录不存在 ⇒ 自动建（调用方从不先 mkdir）', async () => {
    const dir = await makeTempDir('atomic4-')
    try {
      const target = join(dir, 'nested', 'deep', 'x.json')
      await atomicWrite(target, 'y')
      assert.equal(await readFile(target, 'utf8'), 'y')
      assert.equal(dirname(target), join(dir, 'nested', 'deep'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})