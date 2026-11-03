import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { listDir } from './fs-browse.ts'

/**
 * 目录浏览（「新建对话 / 新建任务」里点着选工作目录）。
 *
 * 这组测试要钉住的是**界面依赖的那几条事实**：
 *   · 空路径 ⇒ 家目录（第一次打开时页面什么都不用传）；
 *   · 目录在前、文件只是"预览"；
 *   · 隐藏项不列（`.git` 之类不淹清单），但**不拦**显式打进来的隐藏路径；
 *   · 符号链接的目录**要列、要能进去**（`readdir` 的 Dirent 对链接不跟随，
 *     照直写会把 `~/repo -> /Volumes/...` 整条丢掉）；
 *   · 各种失败给**不同的码**（"不存在"与"没权限"是两件事，界面上的说法也不同）。
 */

const WORK_ROOT = '/work'

describe('目录浏览：列什么、怎么排', () => {
  test('★ 目录在前、文件在后；隐藏项不列', async () => {
    const dir = await makeTempDir('browse-basic')
    await mkdir(join(dir, 'src'))
    await mkdir(join(dir, 'docs'))
    await mkdir(join(dir, '.git'))
    await writeFile(join(dir, 'README.md'), '# x')
    await writeFile(join(dir, '.env'), 'SECRET=1')
    const r = await listDir({ path: dir, home: dir, workRoot: WORK_ROOT })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.deepEqual(
      r.listing.entries.map((e) => `${e.kind}:${e.name}`),
      ['dir:docs', 'dir:src', 'file:README.md'],
    )
    // 路径是绝对且拼好的（界面拿它当下一跳，不自己拼）
    assert.equal(r.listing.entries[0]?.path, join(r.listing.path, 'docs'))
    assert.equal(r.listing.truncated, false)
    await cleanup(dir)
  })

  test('★★ 空路径 ⇒ 家目录（第一次打开时页面什么都不用传）', async () => {
    const dir = await makeTempDir('browse-home')
    await mkdir(join(dir, 'repo'))
    const r = await listDir({ path: '', home: dir, workRoot: WORK_ROOT })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.listing.path, dir)
    assert.equal(r.listing.home, dir)
    assert.equal(r.listing.workRoot, WORK_ROOT)
    await cleanup(dir)
  })

  test('★★ `~` 与 `~/x` 都能用（人会在输入框里这么打）', async () => {
    // 家目录是注入的（`home`），所以这里只能验证 `~` 展开走的是 `os.homedir()`：
    // 不注入时列家目录本身，至少不该是"路径不存在"。
    const r = await listDir({ path: '~', workRoot: WORK_ROOT })
    assert.equal(r.ok, true)
    const r2 = await listDir({ path: '~/.agentdeck-nonexistent-for-test', workRoot: WORK_ROOT })
    assert.equal(r2.ok, false)
    if (!r2.ok) assert.equal(r2.code, 'not_found')
  })

  test('★ 上一级：正常目录给父目录，根目录给 `null`（界面据此禁掉按钮）', async () => {
    const dir = await makeTempDir('browse-parent')
    await mkdir(join(dir, 'a', 'b'), { recursive: true })
    const r = await listDir({ path: join(dir, 'a', 'b'), home: dir, workRoot: WORK_ROOT })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.listing.parent, join(dir, 'a'))
    const root = await listDir({ path: '/', workRoot: WORK_ROOT })
    assert.equal(root.ok, true)
    if (root.ok) assert.equal(root.listing.parent, null)
    await cleanup(dir)
  })

  test('★ 大目录截断（`truncated` 说出来，界面不假装列全了）', async () => {
    const dir = await makeTempDir('browse-limit')
    for (let i = 0; i < 8; i += 1) await writeFile(join(dir, `f${String(i)}.txt`), 'x')
    const r = await listDir({ path: dir, home: dir, workRoot: WORK_ROOT, limit: 5 })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.listing.entries.length, 5)
    assert.equal(r.listing.truncated, true)
    await cleanup(dir)
  })

  test('★★ 指向目录的符号链接要列、且是 dir（`readdir` 对链接不跟随，照直写会丢）', async () => {
    const dir = await makeTempDir('browse-link')
    await mkdir(join(dir, 'real'))
    await writeFile(join(dir, 'plain.txt'), 'x')
    await symlink(join(dir, 'real'), join(dir, 'link-to-real'))
    await symlink(join(dir, 'nope'), join(dir, 'broken'))
    const r = await listDir({ path: dir, home: dir, workRoot: WORK_ROOT })
    assert.equal(r.ok, true)
    if (!r.ok) return
    const byName = new Map(r.listing.entries.map((e) => [e.name, e.kind]))
    assert.equal(byName.get('link-to-real'), 'dir')
    // 断链列出来也点不动，不如不列
    assert.equal(byName.has('broken'), false)
    await cleanup(dir)
  })

  test('★★ 路径被 realpath 解析：链接目录的「上一级」是真的上一级，不是字面父目录', async () => {
    const dir = await makeTempDir('browse-realdir')
    await mkdir(join(dir, 'vol', 'repo'), { recursive: true })
    const link = join(dir, 'repo-link')
    await symlink(join(dir, 'vol', 'repo'), link)
    const r = await listDir({ path: link, home: dir, workRoot: WORK_ROOT })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.listing.path, join(dir, 'vol', 'repo'))
    assert.equal(r.listing.parent, join(dir, 'vol'))
    await cleanup(dir)
  })
})

describe('目录浏览：失败要分得清', () => {
  test('不存在 ⇒ `not_found`', async () => {
    const dir = await makeTempDir('browse-missing')
    const r = await listDir({ path: join(dir, 'nope'), home: dir, workRoot: WORK_ROOT })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, 'not_found')
    await cleanup(dir)
  })

  test('★ 是个文件 ⇒ `not_a_dir`（不是"不存在"：路径打对了，但它不是目录）', async () => {
    const dir = await makeTempDir('browse-file')
    await writeFile(join(dir, 'a.txt'), 'x')
    const r = await listDir({ path: join(dir, 'a.txt'), home: dir, workRoot: WORK_ROOT })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, 'not_a_dir')
    await cleanup(dir)
  })

  test('相对路径 ⇒ `not_absolute`（工作目录必须是绝对路径，服务端先说清楚）', async () => {
    const r = await listDir({ path: 'repo', workRoot: WORK_ROOT })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, 'not_absolute')
  })

  test('没有权限 ⇒ `denied`（与"不存在"分开：一个要改权限，一个要改路径）', async () => {
    const dir = await makeTempDir('browse-denied')
    await mkdir(join(dir, 'locked'))
    const { chmod } = await import('node:fs/promises')
    await chmod(join(dir, 'locked'), 0o000)
    const r = await listDir({ path: join(dir, 'locked'), home: dir, workRoot: WORK_ROOT })
    // ⚠️ root 跑测试时 0o000 也读得到（Docker CI 常见）——那就跳过，不要假装这条验证过
    if (r.ok) {
      await chmod(join(dir, 'locked'), 0o755)
      await cleanup(dir)
      return
    }
    await chmod(join(dir, 'locked'), 0o755)
    assert.notEqual(r.code, 'not_found')
    await cleanup(dir)
  })
})
