import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { revealCommandFor, revealInFileManager } from './reveal.ts'

/**
 * 「打开」按钮的后端：在系统文件管理器里打开一个目录。
 *
 * 这组测试钉三件事：
 *   · **三个平台各自起什么命令**（Windows 那条特别容易写错，见 `explorer.exe` 的注释）；
 *   · **argv 直传**：路径里的空格 / `&` 不会被 shell 解释（拼命令行就等于开一个注入面）；
 *   · 失败要**分得清**（路径不存在 / 不是目录 / 没桌面环境分别怎么说）。
 *
 * ⚠️ 测试绝不真的弹窗：`spawnImpl` 与 `find` 都是注入的。
 */

const noFind = async (): Promise<string> => '/usr/bin/fake-opener'

/** 假 spawn：记下 argv，返回一个带 `on`/`unref` 的空壳。 */
function fakeSpawn(): { calls: Array<{ command: string; args: string[] }>; spawn: typeof import('node:child_process').spawn } {
  const calls: Array<{ command: string; args: string[] }> = []
  const spawn = ((command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] })
    const listeners: Array<(err: unknown) => void> = []
    return {
      on: (event: string, cb: (err: unknown) => void) => {
        if (event === 'error') listeners.push(cb)
        return undefined
      },
      unref: () => undefined,
    }
  }) as unknown as typeof import('node:child_process').spawn
  return { calls, spawn }
}

describe('「打开」：三个平台起什么命令', () => {
  test('★ macOS ⇒ `open <dir>`', () => {
    assert.deepEqual(revealCommandFor('darwin', '/Users/me/repo'), {
      command: 'open',
      args: ['/Users/me/repo'],
    })
  })

  test('★★ Windows ⇒ `explorer.exe <dir>`（⚠️ 成功也回 1，所以判据只能是"起没起来"）', () => {
    assert.deepEqual(revealCommandFor('win32', 'C:\\work\\repo'), {
      command: 'explorer.exe',
      args: ['C:\\work\\repo'],
    })
  })

  test('★ Linux ⇒ `xdg-open <dir>`', () => {
    assert.deepEqual(revealCommandFor('linux', '/home/me/repo'), {
      command: 'xdg-open',
      args: ['/home/me/repo'],
    })
  })
})

describe('「打开」：真的去起进程', () => {
  test('★★ 路径**原样进 argv**（带空格的目录不会被拆成两个参数，也不会被 shell 解释）', async () => {
    const dir = await makeTempDir('reveal-space')
    const odd = join(dir, 'My Projects & Stuff')
    await mkdir(odd)
    const fake = fakeSpawn()
    const r = await revealInFileManager({ path: odd, platform: 'darwin', spawnImpl: fake.spawn, find: noFind })
    assert.equal(r.ok, true)
    assert.deepEqual(fake.calls, [{ command: 'open', args: [odd] }])
    await cleanup(dir)
  })

  test('★ 打开前先解析链接：起的是**真实**目录（界面显示哪个就打开哪个）', async () => {
    const dir = await makeTempDir('reveal-link')
    const real = join(dir, 'real')
    await mkdir(real)
    const { symlink } = await import('node:fs/promises')
    const link = join(dir, 'link')
    await symlink(real, link)
    const fake = fakeSpawn()
    const r = await revealInFileManager({ path: link, platform: 'linux', spawnImpl: fake.spawn, find: noFind })
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.path, real)
    assert.deepEqual(fake.calls, [{ command: 'xdg-open', args: [real] }])
    await cleanup(dir)
  })
})

describe('「打开」：失败要说清是哪一种', () => {
  test('相对路径 ⇒ `not_absolute`（工作目录一律绝对路径）', async () => {
    const r = await revealInFileManager({ path: 'repo', spawnImpl: fakeSpawn().spawn, find: noFind })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, 'not_absolute')
  })

  test('不存在 ⇒ `not_found`', async () => {
    const dir = await makeTempDir('reveal-missing')
    const r = await revealInFileManager({
      path: join(dir, 'nope'),
      spawnImpl: fakeSpawn().spawn,
      find: noFind,
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, 'not_found')
    await cleanup(dir)
  })

  test('★ 是个文件 ⇒ `not_a_dir`（这颗按钮开的是目录，不是文件）', async () => {
    const dir = await makeTempDir('reveal-file')
    const file = join(dir, 'a.txt')
    await writeFile(file, 'x')
    const r = await revealInFileManager({ path: file, spawnImpl: fakeSpawn().spawn, find: noFind })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, 'not_a_dir')
    await cleanup(dir)
  })

  test('★★ 没有桌面环境（`xdg-open` 不存在）⇒ `no_opener`，而且**一句话能照做**（给出路径让人自己 cd）', async () => {
    const dir = await makeTempDir('reveal-noopener')
    const r = await revealInFileManager({
      path: dir,
      platform: 'linux',
      spawnImpl: fakeSpawn().spawn,
      find: async () => null,
    })
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.code, 'no_opener')
      assert.match(r.error, /cd/, 'Linux 上找不到 xdg-open 时，要给出"自己 cd 进去"这条退路')
      assert.ok(r.error.includes(dir), '错误里要有那条路径，否则人还得自己找它')
    }
    await cleanup(dir)
  })

  test('★ 找不到命令时**根本不 spawn**（不把一个注定的失败丢给系统）', async () => {
    const dir = await makeTempDir('reveal-nospawn')
    const fake = fakeSpawn()
    await revealInFileManager({
      path: dir,
      platform: 'linux',
      spawnImpl: fake.spawn,
      find: async () => null,
    })
    assert.deepEqual(fake.calls, [])
    await cleanup(dir)
  })
})
