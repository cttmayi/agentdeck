import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { getRuntimeDescriptor } from '@agentdeck/agent-core'
import {
  MAX_FILE_BYTES,
  MAX_MEDIA_BYTES,
  UnsafePathError,
  contentTypeFor,
  isStreamableType,
  listWorkDir,
  managedPathsFor,
  openWorkFile,
  parseByteRange,
  readWorkFile,
  resolveWorkFilePath,
} from './workdir-files.ts'

/** claude 的注入物规则——大多数用例只关心"是不是被标出来"。 */
const CLAUDE_MANAGED = managedPathsFor(getRuntimeDescriptor('claude'))

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

      // ★ 规则要**传进去**（按这个 run 的 runtime 算）——这正是这次改动：
      //   原来 `listWorkDir` 内部写死 `.claude/**`，换 CLI 就会把注入物
      //   当成 agent 的产出显示。
      const listing = await listWorkDir(dir, '', CLAUDE_MANAGED)
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

  test('★ "哪些是平台注入的"由 runtime 描述表决定，不是写死 .claude', async () => {
    const dir = await makeWorkDir()
    try {
      // 两个 runtime 的注入物同时躺在目录里（现实里不会，但这样最能说明问题）
      await mkdir(join(dir, '.claude', 'skills'), { recursive: true })
      await mkdir(join(dir, '.agentdeck', 'context'), { recursive: true })

      const claude = await listWorkDir(dir, '', managedPathsFor(getRuntimeDescriptor('claude')))
      const claudeManaged = claude.entries.filter((e) => e.managed).map((e) => e.path).sort()
      // claude 的技能目录 + 我们自己的上下文副本，两样都算平台注入
      assert.deepEqual(claudeManaged, ['.agentdeck', '.claude'])

      const generic = await listWorkDir(dir, '', managedPathsFor(getRuntimeDescriptor('generic')))
      const genericManaged = generic.entries.filter((e) => e.managed).map((e) => e.path).sort()
      // generic 声明"没有技能发现机制" ⇒ 它没有技能目录算注入物；
      // 而 `.claude/**` 对它只是**别人的东西**（那是 claude 的约定）
      assert.deepEqual(genericManaged, ['.agentdeck'])
      assert.ok(
        !genericManaged.includes('.claude'),
        '★ 写死 .claude 的版本会在这里把 claude 的技能目录标成 generic 的',
      )
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

  /**
   * ★ 「还不存在」与「存在但是空的」都是空列表，而界面那两句话给出的下一步
   *   完全不同（"再等等/先说句话" vs "它确实没产出"）。所以这件事必须由服务端
   *   给出来，不能让界面看着空数组猜——聊天那边第一轮之前正是前者。
   */
  test('★★ 「还不存在」与「存在但是空的」分开报（exists）', async () => {
    const root = await makeTempDir('workdir-files-exists')

    const missing = await listWorkDir(join(root, 'never-created'))
    assert.equal(missing.exists, false, '目录还没建出来 ⇒ exists: false')

    const existing = join(root, 'exists-but-empty')
    await mkdir(existing, { recursive: true })
    const empty = await listWorkDir(existing)
    assert.deepEqual(empty.entries, [])
    assert.equal(empty.exists, true, '目录在、里面什么都没有 ⇒ exists: true（不是"还不存在"）')

    await cleanup(root)
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

  test('★ 音视频认得出（2026-10：它们以前一律是 octet-stream）', () => {
    // 认不出的后果就是"视频显示成十六进制"——界面按 content-type 分类
    assert.equal(contentTypeFor('a.mp4'), 'video/mp4')
    assert.equal(contentTypeFor('dir/CLIP.MP4'), 'video/mp4')
    assert.equal(contentTypeFor('a.webm'), 'video/webm')
    assert.equal(contentTypeFor('a.mov'), 'video/quicktime')
    assert.equal(contentTypeFor('a.mkv'), 'video/x-matroska')
    assert.equal(contentTypeFor('a.mp3'), 'audio/mpeg')
    assert.equal(contentTypeFor('a.wav'), 'audio/wav')
    assert.equal(contentTypeFor('a.opus'), 'audio/ogg')
  })

  test('★ `.ts` 仍然是文本，不是 MPEG-TS 视频', () => {
    // 把 .ts 当视频会让一堆 TypeScript 源码文件变成播放器——这个后缀在本项目里
    // 最常见的就是源码
    assert.match(contentTypeFor('a.ts'), /^text\/plain/)
    assert.equal(isStreamableType(contentTypeFor('a.ts')), false)
  })

  test('只有音视频是"流着发"的（文本/图片仍然整份读出来）', () => {
    assert.equal(isStreamableType(contentTypeFor('a.mp4')), true)
    assert.equal(isStreamableType(contentTypeFor('a.mp3')), true)
    assert.equal(isStreamableType('video/mp4; charset=binary'), true)
    assert.equal(isStreamableType(contentTypeFor('a.png')), false)
    assert.equal(isStreamableType(contentTypeFor('a.md')), false)
    assert.equal(isStreamableType(contentTypeFor('blob.bin')), false)
  })
})

describe('★ Range（音视频的 seek 全靠它）', () => {
  test('没有 Range 头 ⇒ null（回 200 整份）', () => {
    assert.equal(parseByteRange(undefined, 100), null)
    assert.equal(parseByteRange(null, 100), null)
    assert.equal(parseByteRange('', 100), null)
    // 认不出来的写法当成"没有 Range"（HTTP 允许服务器忽略它），不当错误
    assert.equal(parseByteRange('items=0-9', 100), null)
    assert.equal(parseByteRange('bytes=0-9,20-29', 100), null, '多区间不支持：当没给')
  })

  test('三档区间写法都对', () => {
    // bytes=0-99 ⇒ 前 100 字节
    assert.deepEqual(parseByteRange('bytes=0-99', 1000), { start: 0, end: 99 })
    // bytes=500- ⇒ 到结尾
    assert.deepEqual(parseByteRange('bytes=500-', 1000), { start: 500, end: 999 })
    // bytes=-100 ⇒ **最后** 100 字节
    assert.deepEqual(parseByteRange('bytes=-100', 1000), { start: 900, end: 999 })
    // 结尾越界 ⇒ 收到 size-1（HTTP 的语义就是这样，不是错误）
    assert.deepEqual(parseByteRange('bytes=900-999999', 1000), { start: 900, end: 999 })
    // 前后空格也要认
    assert.deepEqual(parseByteRange(' bytes=0-9 ', 100), { start: 0, end: 9 })
  })

  test('★ 起点越界 ⇒ unsatisfiable（要回 416，不是"忽略 Range 回 200"）', () => {
    // 回 200 整份是不合规的：客户端会以为自己拿到了要的那一段
    assert.equal(parseByteRange('bytes=1000-', 1000), 'unsatisfiable')
    assert.equal(parseByteRange('bytes=2000-3000', 1000), 'unsatisfiable')
    // 空文件：任何区间都越界
    assert.equal(parseByteRange('bytes=0-', 0), 'unsatisfiable')
  })

  test('倒过来的区间与坏数字都当越界', () => {
    assert.equal(parseByteRange('bytes=50-10', 1000), 'unsatisfiable')
    assert.equal(parseByteRange('bytes=-0', 1000), 'unsatisfiable')
  })
})

describe('★ 上限分两档：音视频不读进内存，所以上限高得多', () => {
  test('媒体上限远高于 8MB 那一档（一段 1080p 一分钟就几十 MB）', () => {
    assert.ok(MAX_MEDIA_BYTES > MAX_FILE_BYTES * 10)
  })

  test('openWorkFile 认得类型、给出"该不该流着发"', async () => {
    const root = await makeWorkDir()
    try {
      await writeFile(join(root, 'clip.mp4'), Buffer.alloc(64, 1))
      await writeFile(join(root, 'note.txt'), 'hi\n')

      const media = await openWorkFile(root, 'clip.mp4')
      assert.equal(media.streamable, true)
      assert.equal(media.contentType, 'video/mp4')
      assert.equal(media.size, 64)

      const text = await openWorkFile(root, 'note.txt')
      assert.equal(text.streamable, false)
      assert.equal(text.size, 3)
    } finally {
      await cleanup(root)
    }
  })

  test('★ 守卫在 openWorkFile 里也生效（流式那条路不许绕过它）', async () => {
    const root = await makeWorkDir()
    try {
      await assert.rejects(() => openWorkFile(root, '../outside.mp4'), UnsafePathError)
      await assert.rejects(() => openWorkFile(root, '/etc/passwd'), UnsafePathError)
      await assert.rejects(() => openWorkFile(root, 'nope.mp4'), UnsafePathError)
      // 非媒体那一档仍然卡在 8MB
      await writeFile(join(root, 'huge.md'), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61))
      await assert.rejects(() => openWorkFile(root, 'huge.md'), UnsafePathError)
    } finally {
      await cleanup(root)
    }
  })
})
