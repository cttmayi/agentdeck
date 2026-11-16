import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findExecutable } from './executable.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * `findExecutable` 的两条平台分支（分批第 228 批）。
 *
 * ⚠️ 这两条原来住在 `script-executor.test.ts` 里（那个执行器随工具包能力退场删了）。
 *    留下来的理由与函数本身一样：**平台兼容的规则必须有可跑的判据**，否则"Windows
 *    上找不到 .cmd"这类缺陷只会在真机上第一次出现。
 *
 * ★ 两条都**钉住 platform**，理由见函数头部那段注释。
 */

test('findExecutable：POSIX 上按 PATH 找、且**看可执行位**', async () => {
  const dir = await makeTempDir('executable-path')
  const empty = await makeTempDir('executable-path-empty')
  try {
    await writeFile(join(dir, 'my-tool'), '#!/bin/sh\necho hi\n', 'utf8')
    await chmod(join(dir, 'my-tool'), 0o755)

    assert.equal(await findExecutable('my-tool', { PATH: dir }, 'linux'), join(dir, 'my-tool'))
    assert.equal(await findExecutable('my-tool', { PATH: empty }, 'linux'), null)
    // 存在但不可执行 ⇒ 不算找到（这正是"可执行位也算判据"那条规则）
    await chmod(join(dir, 'my-tool'), 0o644)
    assert.equal(await findExecutable('my-tool', { PATH: dir }, 'linux'), null)
  } finally {
    await cleanup(dir)
    await cleanup(empty)
  }
})

test('★★ findExecutable：Windows 上按 PATHEXT 逐扩展名找（裸名找不到 `.cmd`）', async () => {
  const dir = await makeTempDir('executable-path-win')
  try {
    await writeFile(join(dir, 'codex.cmd'), '@echo off\n', 'utf8')
    /**
     * 裸名 `codex` 在 Windows 上要能靠 PATHEXT 找到 codex.cmd。
     *
     * ⚠️ 断言**大小写不敏感**：候选扩展名来自 PATHEXT（真实机器上是 `.CMD` 大写），
     *    Windows 的文件系统不区分大小写，所以两种写法都能打开；而跑这条判据的
     *    macOS 可能是大小写敏感卷。比较大小写无关的字符串，测的才是"找不找得到"。
     */
    const same = (got: string | null, want: string): boolean =>
      got !== null && got.toLowerCase() === want.toLowerCase()

    assert.ok(same(await findExecutable('codex', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32'), join(dir, 'codex.cmd')))
    // 不带 PATHEXT 时用默认那三档，同样找得到
    assert.ok(same(await findExecutable('codex', { PATH: dir }, 'win32'), join(dir, 'codex.cmd')))
    // 而 POSIX 语义下这个名字不存在（没有任何扩展名可补）
    assert.equal(await findExecutable('codex', { PATH: dir }, 'linux'), null)
  } finally {
    await cleanup(dir)
  }
})
