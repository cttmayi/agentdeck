/**
 * 上传文件到工作目录（分批第 203 批）。
 *
 * 这一批的判据只钉**平台这一侧的硬事实**：路径守卫、重名不覆盖、尺寸上限、二进制判定、
 * 落点必须在工作目录之内。两条路由（沉淀 / 聊天）各自只差一个子目录名，所以这里直接
 * 对着 `writeWorkDirUpload` 测——它才是两份实现合一的那一处。
 *
 * ⚠️ 真文件系统（仓库内 `.cache/test-tmp`），不碰任何 CLI（NFR-T-01）。
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import {
  looksBinary,
  safeUploadName,
  UPLOAD_MAX_FILES,
  writeWorkDirUpload,
} from './workdir-upload.ts'

let workDir = ''

before(async () => {
  workDir = await makeTempDir('upload')
})
after(async () => {
  await cleanup(workDir)
})

const b64 = (text: string | Buffer): string =>
  (typeof text === 'string' ? Buffer.from(text, 'utf8') : text).toString('base64')

describe('上传到工作目录：落点与命名', () => {
  test('★★★ 写进指定子目录，且**逐字节等于**上传内容（二进制也要，含 NUL）', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0xff, 0x00, 0x02])
    const res = await writeWorkDirUpload(workDir, 'material/appended', [
      { name: 'notes.md', base64: b64('# 笔记\n') },
      { name: 'shot.png', base64: b64(png) },
    ])
    assert.equal(res.ok, true, JSON.stringify(res))
    if (!res.ok) return
    assert.deepEqual(
      res.files.map((f) => f.relPath).sort(),
      ['material/appended/notes.md', 'material/appended/shot.png'],
    )
    const onDisk = await readFile(join(workDir, 'material/appended/notes.md'), 'utf8')
    assert.equal(onDisk, '# 笔记\n')
    const bin = await readFile(join(workDir, 'material/appended/shot.png'))
    assert.deepEqual([...bin], [...png], '二进制必须原样落盘（不能当文本转码）')
    assert.equal(res.files.find((f) => f.name === 'shot.png')?.binary, true)
    assert.equal(res.files.find((f) => f.name === 'notes.md')?.binary, false)
  })

  test('★★★ 重名**不覆盖**：自动 -2，两份都在（覆盖会静默丢掉前一份）', async () => {
    const dir = 'dup'
    const first = await writeWorkDirUpload(workDir, dir, [{ name: 'a.md', base64: b64('第一份') }])
    const second = await writeWorkDirUpload(workDir, dir, [{ name: 'a.md', base64: b64('第二份') }])
    assert.equal(first.ok && second.ok, true)
    if (!first.ok || !second.ok) return
    assert.equal(second.files[0]?.name, 'a-2.md')
    assert.equal(await readFile(join(workDir, dir, 'a.md'), 'utf8'), '第一份')
    assert.equal(await readFile(join(workDir, dir, 'a-2.md'), 'utf8'), '第二份')
  })

  test('★★ 文件名只取最后一段：路径与控制字符都被剥掉（不许借文件名逃出目录）', async () => {
    assert.equal(safeUploadName('../../etc/passwd'), 'passwd')
    assert.equal(safeUploadName('a/b/c.txt'), 'c.txt')
    assert.equal(safeUploadName('x\u0000y.txt'), 'x-y.txt')
    assert.equal(safeUploadName('...hidden'), 'hidden')
    const res = await writeWorkDirUpload(workDir, 'escape', [
      { name: '../../../evil.md', base64: b64('x') },
    ])
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.equal(res.files[0]?.relPath, 'escape/evil.md', '落点必须还在子目录里')
  })

  test('★★ 落点不合法（`..` / 绝对路径 / 反斜杠）⇒ 整单拒，一个字节都不写', async () => {
    for (const dir of ['../outside', '/abs', 'a/../b', 'a\\b']) {
      const res = await writeWorkDirUpload(workDir, dir, [{ name: 'x.md', base64: b64('x') }])
      assert.equal(res.ok, false, dir)
      if (res.ok) return
      assert.equal(res.code, 'unsafe_target')
    }
  })
})

describe('上传到工作目录：上限', () => {
  test('★★ 超过份数上限 ⇒ 拒（并说清数字）', async () => {
    const files = Array.from({ length: UPLOAD_MAX_FILES + 1 }, (_, i) => ({
      name: `f${i}.md`,
      base64: b64('x'),
    }))
    const res = await writeWorkDirUpload(workDir, 'many', files)
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.equal(res.code, 'upload_too_many')
    assert.match(res.error, new RegExp(String(UPLOAD_MAX_FILES)))
  })

  test('★★ 单份超限 / 空文件 ⇒ 拒（整单，不写半个）', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41)
    const tooBig = await writeWorkDirUpload(workDir, 'big', [{ name: 'big.bin', base64: b64(big) }])
    assert.equal(tooBig.ok, false)
    if (!tooBig.ok) assert.equal(tooBig.code, 'upload_too_large')

    const empty = await writeWorkDirUpload(workDir, 'empty', [{ name: 'z.md', base64: b64('') }])
    assert.equal(empty.ok, false)
    if (!empty.ok) assert.equal(empty.code, 'upload_empty')

    // 整单拒：同一次里的好文件也不该落盘
    const mixed = await writeWorkDirUpload(workDir, 'mixed', [
      { name: 'good.md', base64: b64('ok') },
      { name: 'huge.bin', base64: b64(big) },
    ])
    assert.equal(mixed.ok, false)
    await assert.rejects(readFile(join(workDir, 'mixed', 'good.md'), 'utf8'))
  })

  test('★ 二进制判定：纯文本不算，含 NUL 算', async () => {
    assert.equal(looksBinary(Buffer.from('普通文本\nwith ascii\n', 'utf8')), false)
    assert.equal(looksBinary(Buffer.from([0x41, 0x00, 0x42])), true)
    assert.equal(looksBinary(Buffer.alloc(0)), false)
  })
})
