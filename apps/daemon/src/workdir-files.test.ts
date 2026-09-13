import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import {
  MAX_FILE_BYTES,
  UnsafePathError,
  contentTypeFor,
  listWorkDir,
  readWorkFile,
  resolveWorkFilePath,
} from './workdir-files.ts'

/**
 * 工作目录的文件浏览。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这组测试里最要紧的是**不许跑出工作目录**
 * ══════════════════════════════════════════════════════════════════
 *
 * 被读的是使用者工作目录里的文件，而路径来自 HTTP 查询参数。所以这里要钉住的
 * 是两道检查，而不是"列文件"这个功能本身：
 *
 *   1. `..` / 绝对路径 —— 且必须**按分隔符**比前缀（`/work-other` 不是 `/work`
 *      的子路径，用 `startsWith(root)` 就会放行）；
 *   2. **符号链接** —— 路径本身完全正常，但真实路径在外面。
 */

async function makeWorkDir(): Promise<string> {
  return makeTempDir('workdir-files')
}

describe('★ 路径不许跑出工作目录', () => {
  test('★ `..` 逃逸被拒', async () => {
    const dir = await makeWorkDir()
    try {
      await writeFile(join(dir, 'ok.txt'), 'x', 'utf8')
      for (const bad of [
        '../secret.txt',
        '../../etc/passwd',
        'a/../../outside.txt',
        './../../x',
      ]) {
        await assert.rejects(
          () => resolveWorkFilePath(dir, bad),
          (err: unknown) => err instanceof UnsafePathError,
          `应当拒绝：${bad}`,
        )
      }
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 绝对路径被拒（不静默当成相对的）', async () => {
    const dir = await makeWorkDir()
    try {
      await assert.rejects(
        () => resolveWorkFilePath(dir, '/etc/passwd'),
        (err: unknown) => err instanceof UnsafePathError,
      )
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 前缀相近的兄弟目录不能被误判为"在之内"', async () => {
    // `/tmp/x/work` 与 `/tmp/x/work-other`：用 `startsWith(root)` 会放行后者，
    // 这是这类检查最经典的一个错法。
    //
    // ⚠️ 这条用例第一版写错了：它只断言"被拒"。而实现里有**两道**检查，
    //    第二道（比 realpath）恰好也能挡住这个例子 —— 于是把第一道改成错的
    //    写法，用例照样通过（变异验证发现的）。所以这里改成断言**理由**：
    //    跑出去了就该说"跑出了工作目录"，而不是"文件不存在"。
    const base = await makeWorkDir()
    const work = join(base, 'work')
    const other = join(base, 'work-other')
    try {
      await mkdir(work, { recursive: true })
      await mkdir(other, { recursive: true })
      await writeFile(join(other, 'secret.txt'), '不该读到', 'utf8')

      await assert.rejects(
        () => resolveWorkFilePath(work, '../work-other/secret.txt'),
        (err: unknown) => err instanceof UnsafePathError && /跑出了工作目录/.test(err.message),
        '★ 兄弟目录必须被判成"跑出去了"',
      )

      // 目标**不存在**时也要说清是"跑出去了"：否则错误信息会把人带到
      // "文件是不是被删了"上去，而真正的问题是路径本身不合法。
      // （这一条才真正钉住第一道检查 —— 存在的情况下第二道也会拦。）
      await assert.rejects(
        () => resolveWorkFilePath(work, '../work-other/不存在.txt'),
        (err: unknown) => err instanceof UnsafePathError && /跑出了工作目录/.test(err.message),
      )
    } finally {
      await cleanup(base)
    }
  })

  test('★ 符号链接指向外面 ⇒ 拒绝（路径检查看不出来）', async () => {
    const base = await makeWorkDir()
    const work = join(base, 'work')
    try {
      await mkdir(work, { recursive: true })
      const outside = join(base, 'secret.txt')
      await writeFile(outside, '外面的东西', 'utf8')
      // 工作目录里放一个软链指向它
      await symlink(outside, join(work, 'link.txt'))

      await assert.rejects(
        () => resolveWorkFilePath(work, 'link.txt'),
        (err: unknown) => err instanceof UnsafePathError,
        '★ 只看拼出来的路径挡不住软链，必须比 realpath',
      )
    } finally {
      await cleanup(base)
    }
  })

  test('正常路径可读，且拒绝空 path', async () => {
    const dir = await makeWorkDir()
    try {
      await writeFile(join(dir, 'a.txt'), '内容', 'utf8')
      assert.equal((await readWorkFile(dir, 'a.txt')).toString('utf8'), '内容')
      await assert.rejects(
        () => resolveWorkFilePath(dir, ''),
        (err: unknown) => err instanceof UnsafePathError,
      )
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 超过读取上限的文件被拒（并说清该怎么办）', async () => {
    const dir = await makeWorkDir()
    try {
      // 只写个"声明大小"是做不到的，所以造一个略超上限的文件
      await writeFile(join(dir, 'big.bin'), Buffer.alloc(MAX_FILE_BYTES + 1))
      await assert.rejects(
        () => readWorkFile(dir, 'big.bin'),
        (err: unknown) => err instanceof UnsafePathError && /超过/.test((err as Error).message),
      )
    } finally {
      await cleanup(dir)
    }
  })
})

describe('列目录：**一次一层**', () => {
  test('★ 只列直接子项，不递归（递归会把真正的产出淹掉）', async () => {
    const dir = await makeWorkDir()
    try {
      await writeFile(join(dir, 'report.md'), '# 报告', 'utf8')
      await mkdir(join(dir, '.claude', 'skills', 'x'), { recursive: true })
      await writeFile(join(dir, '.claude', 'skills', 'x', 'SKILL.md'), '# 技能', 'utf8')

      const listing = await listWorkDir(dir)
      assert.deepEqual(
        listing.entries.map((e) => e.path).sort(),
        ['.claude', 'report.md'],
        '★ 第一层只该有这两项',
      )
      const claude = listing.entries.find((e) => e.path === '.claude')
      assert.equal(claude?.kind, 'dir')
      assert.equal(claude?.managed, true, '平台注入的要标出来')
      assert.equal(claude?.hasChildren, true, '里面有东西 ⇒ 界面才画展开箭头')
      assert.equal(listing.dir, '', '顶层时 dir 是空串')
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 给 dir 就列那一层（界面点开目录时用）', async () => {
    const dir = await makeWorkDir()
    try {
      await mkdir(join(dir, '.claude', 'skills', 'algorithmic-art', 'templates'), { recursive: true })
      await writeFile(join(dir, '.claude', 'skills', 'algorithmic-art', 'SKILL.md'), '# 技能', 'utf8')
      await writeFile(join(dir, '.claude', 'skills', 'algorithmic-art', 'templates', 'v.html'), 'x', 'utf8')

      const l1 = await listWorkDir(dir, '.claude/skills')
      assert.equal(l1.dir, '.claude/skills')
      assert.deepEqual(l1.entries.map((e) => e.path), ['.claude/skills/algorithmic-art'])
      assert.equal(l1.entries[0]?.name, 'algorithmic-art', '条目带 name，界面显示它、层级靠缩进')
      assert.equal(l1.entries[0]?.hasChildren, true)

      const l2 = await listWorkDir(dir, '.claude/skills/algorithmic-art')
      assert.deepEqual(
        l2.entries.map((e) => e.name),
        ['templates', 'SKILL.md'],
        '目录在前、再按名字',
      )
    } finally {
      await cleanup(dir)
    }
  })

  test('空目录 ⇒ hasChildren 为 false（不画一个点了没反应的箭头）', async () => {
    const dir = await makeWorkDir()
    try {
      await mkdir(join(dir, 'empty'), { recursive: true })
      const listing = await listWorkDir(dir)
      assert.equal(listing.entries[0]?.hasChildren, false)
    } finally {
      await cleanup(dir)
    }
  })

  test('目录排在文件前面（先看结构）', async () => {
    const dir = await makeWorkDir()
    try {
      await writeFile(join(dir, 'a.txt'), 'x', 'utf8')
      await mkdir(join(dir, 'assets'), { recursive: true })
      const { entries } = await listWorkDir(dir)
      assert.equal(entries[0]?.kind, 'dir')
    } finally {
      await cleanup(dir)
    }
  })

  test('★ `.git` 与 `.DS_Store` 不列（一个是我们自己的状态，一个是 macOS 的元数据）', async () => {
    const dir = await makeWorkDir()
    try {
      await mkdir(join(dir, '.git'), { recursive: true })
      await writeFile(join(dir, '.git', 'HEAD'), 'ref: x', 'utf8')
      await writeFile(join(dir, '.DS_Store'), 'junk', 'utf8')
      await writeFile(join(dir, 'real.txt'), 'x', 'utf8')
      const { entries } = await listWorkDir(dir)
      assert.deepEqual(entries.map((e) => e.name), ['real.txt'])
    } finally {
      await cleanup(dir)
    }
  })

  test('★ dir 参数同样不许跑出工作目录', async () => {
    const dir = await makeWorkDir()
    try {
      await assert.rejects(
        () => listWorkDir(dir, '../..'),
        (err: unknown) => err instanceof UnsafePathError,
      )
    } finally {
      await cleanup(dir)
    }
  })

  test('空的（或还不存在的）工作目录不报错，返回空列表', async () => {
    const dir = join(await makeWorkDir(), 'not-created-yet')
    const listing = await listWorkDir(dir)
    assert.deepEqual(listing.entries, [])
    assert.equal(listing.truncated, false)
    await cleanup(dir)
  })
})

describe('Content-Type', () => {
  test('常见类型认得出来', () => {
    assert.match(contentTypeFor('a.png'), /^image\/png/)
    assert.match(contentTypeFor('a.svg'), /^image\/svg/)
    assert.match(contentTypeFor('a.md'), /^text\/plain/)
    assert.match(contentTypeFor('a.json'), /^application\/json/)
  })

  test('★ 认不出来的一律 octet-stream，不猜 text/plain', () => {
    // 猜错类型会让浏览器去渲染一个本来不该渲染的东西
    assert.equal(contentTypeFor('a.bin'), 'application/octet-stream')
    assert.equal(contentTypeFor('noext'), 'application/octet-stream')
  })

  test('★ 大小写不影响判定', () => {
    assert.match(contentTypeFor('A.PNG'), /^image\/png/)
  })
})
