/**
 * skill-mine（D80）git 版本管理的单元测试。
 *
 * NFR-T-01 的同类理由：**不依赖跑测机器上真的装着 git**——用一把假的 `git`
 * 可执行文件（临时目录里的 shell 脚本）注入。真 git 的行为差异（init 报错、
 * commit 报错、nothing to commit）用假的脚本各态模拟。
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  commitMine,
  compareMineRevisions,
  ensureMineRepo,
  listMineHistory,
  probeGit,
  readMineRevision,
} from './skill-mine.ts'
import { cleanup, makeTempDir } from '../testing/tmp.ts'

let dir: string
let fakeGit: string
let mineRoot: string

/** 造一把"好 git"：所有操作成功，第一次 commit 成功、之后 nothing to commit。 */
async function writeFakeGit(opts: {
  /** `add` 失败（模拟 .git 损坏/权限不足）。 */
  addFails?: boolean
  /** `commit` 永远失败。 */
  commitAlwaysFails?: boolean
} = {}): Promise<string> {
  const git = join(dir, 'fake-git.sh')
  const lines = [
    '#!/bin/sh',
    'case "$1" in',
    '  --version) echo "git version 2.99.0-fake"; exit 0 ;;',
    '  init) mkdir -p .git; echo "Initialized empty"; exit 0 ;;',
    '  config) exit 0 ;;',
    opts.addFails ? '  add) echo "fatal: bad config"; exit 128 ;;' : '  add) exit 0 ;;',
    opts.commitAlwaysFails
      ? '  commit) echo "fatal: bad object"; exit 128 ;;'
      : '  commit) if [ -f .committed ]; then echo "nothing to commit, working tree clean"; exit 1; else touch .committed; echo "f123abc"; exit 0; fi ;;',
    '  *) echo "unknown git subcommand"; exit 1 ;;',
    'esac',
  ]
  await writeFile(git, lines.join('\n'), 'utf8')
  await chmod(git, 0o755)
  return git
}

before(async () => {
  dir = await makeTempDir('skill-mine')
  mineRoot = join(dir, 'skills-mine')
  fakeGit = await writeFakeGit()
})

after(async () => {
  await cleanup(dir)
})

describe('probeGit：可用性开关', () => {
  test('系统没有 git（路径不存在）⇒ 不可用——这是正常状态，不是错误', async () => {
    const probe = await probeGit(join(dir, 'definitely-not-git'))
    assert.equal(probe.available, false)
    assert.equal(probe.version, null)
  })

  test('有 git ⇒ 可用并带版本', async () => {
    // ⚠️ 第二条参数是**超时**（默认 3 秒）。这条用的是假 git，理论上瞬间返回，
    //    但整包测试并行满载时"起一个 shell 脚本"本身就能超过 3 秒 ⇒ 曾经偶发红
    //    （单独跑必过）。断言一个字没松——只是不给它一个不公平的截止时间。
    const probe = await probeGit(fakeGit, 20_000)
    assert.equal(probe.available, true)
    assert.match(probe.version ?? '', /2\.99\.0-fake/)
  })
})

describe('ensureMineRepo：幂等 init + per-repo 兜底身份', () => {
  test('首次 ⇒ git init + 建 .git；再次 ⇒ 幂等原样返回', async () => {
    const first = await ensureMineRepo(mineRoot, fakeGit)
    assert.ok(first.ok, JSON.stringify(first))
    // .git 真的建出来了（假 git 的 init 会 mkdir .git）
    const hasGit = await import('node:fs/promises').then((fs) =>
      fs.stat(join(mineRoot, '.git')).then(() => true, () => false),
    )
    assert.equal(hasGit, true, 'init 后 .git 存在')

    const second = await ensureMineRepo(mineRoot, fakeGit)
    assert.ok(second.ok, '第二次幂等返回 ok（不再 init）')
  })

  test('git 不可用 ⇒ {ok:false, reason 含"不可用"}——不是错误，调用方按关闭版本管理处理', async () => {
    const result = await ensureMineRepo(join(dir, 'another-mine'), join(dir, 'no-git'))
    assert.equal(result.ok, false)
    assert.match(result.reason, /不可用/)
  })
})

describe('commitMine：自动提交', () => {
  test('正常路径：add + commit 成功', async () => {
    const root = join(dir, 'commit-ok')
    await ensureMineRepo(root, fakeGit)
    const result = await commitMine(root, 'skill abc 沉淀（新建）', fakeGit)
    assert.ok(result.ok, JSON.stringify(result))
    assert.equal(result.commit, 'f123abc')
  })

  test('nothing to commit ⇒ 视为成功（幂等：同一内容反复确认不该报错）', async () => {
    const root = join(dir, 'commit-idempotent')
    await ensureMineRepo(root, fakeGit)
    await commitMine(root, '第一次', fakeGit)
    const second = await commitMine(root, '第二次（无改动）', fakeGit)
    assert.ok(second.ok, 'nothing to commit 是幂等成功')
  })

  test('git add 失败 ⇒ {ok:false}（降级兜底：调用方 note 降级，沉淀照常）', async () => {
    const brokenGit = await writeFakeGit({ addFails: true })
    const root = join(dir, 'commit-add-fail')
    await ensureMineRepo(root, brokenGit)
    const result = await commitMine(root, 'x', brokenGit)
    assert.equal(result.ok, false)
    assert.match(result.reason, /git add 失败/)
  })

  test('git commit 失败 ⇒ {ok:false}', async () => {
    const brokenGit = await writeFakeGit({ commitAlwaysFails: true })
    const root = join(dir, 'commit-fail')
    await ensureMineRepo(root, brokenGit)
    const result = await commitMine(root, 'x', brokenGit)
    assert.equal(result.ok, false)
    assert.match(result.reason, /git commit 失败/)
  })
})

/**
 * 一段"带历史的"假 git：log / ls-tree / show 都按脚本里写死的答案回答。
 *
 * ⚠️ 为什么连 `show` 也要假：真跑 git 就要在测试里建仓库、写文件、提交——那是
 *    "测试依赖跑测机器上的 git"，与 NFR-T-01 的同类理由（真 CLI 会烧额度/改文件，
 *    这里则是**结果不可控**：不同 git 版本的 log 格式、locale、hash 长度都可能不同）。
 *    假脚本把"我们喂给 git 的参数"与"我们怎么解析输出"这两件事分开测。
 */
async function writeFakeGitWithHistory(opts: {
  /** `log` 的退出码与输出（默认一条提交）。 */
  logFails?: 'no-commits' | 'not-a-repo'
  /** 空历史（`log` 成功但没有任何行）。 */
  logEmpty?: boolean
} = {}): Promise<string> {
  const git = join(dir, 'fake-git-history.sh')
  const logCase = opts.logFails
    ? opts.logFails === 'no-commits'
      ? '  log) echo "fatal: your current branch does not have any commits yet" >&2; exit 128 ;;'
      : '  log) echo "fatal: not a git repository" >&2; exit 128 ;;'
    : opts.logEmpty
      ? '  log) exit 0 ;;'
      : // \x1f 用 printf 造：字段分隔符是设计的核心，测试里也要**真的**是那个字节
        '  log) printf "aaa111\\037aaa111\\0372026-10-19T10:00:00+08:00\\037skill foo 沉淀（新建）\\naaa222\\037aaa222\\0372026-10-20T11:30:00+08:00\\037skill foo 进化 | 更新\\n"; exit 0 ;;'
  const lines = [
    '#!/bin/sh',
    'case "$1" in',
    '  --version) echo "git version 2.99.0-fake"; exit 0 ;;',
    logCase,
    // ⚠️ 只认这两个 rev：否则"取不到那一版"根本测不到（第一版对任何 rev 都答成功，
    //    于是那条测试量到的是"比较成功了"——测试的前提没立住，不是实现错了）
    // ⚠️ 参数是 `ls-tree -r --name-only <rev> -- <slug>/` ⇒ **rev 在 $4**，
    //    第一版按 `$2` 匹配（那是 `-r`）⇒ 假 git 对任何 rev 都报"不是有效对象"，
    //    量到的失败是假的（测试脚本自己写错了参数位，与实现无关）
    '  ls-tree) case "$4" in aaa111|aaa222) printf "foo/SKILL.md\\nfoo/reference/notes.md\\n"; exit 0 ;; *) echo "fatal: Not a valid object name" >&2; exit 128 ;; esac ;;',
    '  show)',
    // ⚠️ `printf` 的第一个参数**以 `-` 开头会被当成选项**：`printf "---\n…"` 什么都不输出
    //    （而 SKILL.md 的正文正好以 `---`（frontmatter）开头 ⇒ 只有它被吃掉，
    //     表现为"某个文件正文是空的"）。所以那两条用 `printf -- "…"`。
    //    踩过一次：这条测试当场红在"正文里找不到 新的正文"，而实现是对的。
    '    case "$2" in',
    '      aaa222:foo/SKILL.md) printf -- "---\\nname: foo\\n---\\n\\n新的正文\\n"; exit 0 ;;',
    '      aaa222:foo/reference/notes.md) printf "第二版笔记\\n"; exit 0 ;;',
    '      aaa111:foo/SKILL.md) printf -- "---\\nname: foo\\n---\\n\\n旧的正文\\n"; exit 0 ;;',
    '      aaa111:foo/reference/notes.md) printf "第一版笔记\\n"; exit 0 ;;',
    '      aaa222:foo/gone.md) printf "这一版有、上一版没有\\n"; exit 0 ;;',
    '      *) echo "fatal: path not in rev" >&2; exit 128 ;;',
    '    esac ;;',
    '  *) echo "unknown git subcommand" >&2; exit 1 ;;',
    'esac',
  ]
  await writeFile(git, lines.join('\n'), 'utf8')
  await chmod(git, 0o755)
  return git
}

describe('listMineHistory：历史列表（P2）', () => {
  test('两条提交 ⇒ 逐字段解析出来（rev / 短 hash / 时间 / 消息）', async () => {
    const git = await writeFakeGitWithHistory()
    const got = await listMineHistory(mineRoot, 'foo', git)
    assert.equal(got.available, true)
    if (!got.available) return
    assert.equal(got.entries.length, 2)
    assert.deepEqual(got.entries[0], {
      rev: 'aaa111',
      short: 'aaa111',
      when: '2026-10-19T10:00:00+08:00',
      message: 'skill foo 沉淀（新建）',
    })
    // ⚠️ 消息里带 `|` 也要原样出来：字段分隔符必须是那个不可打印字节，
    //    用 `|` 切的话这一条会变成"消息只剩前半句"——而那种错看起来像 git 坏了
    assert.equal(got.entries[1]?.message, 'skill foo 进化 | 更新')
  })

  test('空仓库（还没有任何提交）⇒ available:true + 空列表', async () => {
    // ⚠️ 这条钉的是"空仓库 ≠ git 坏了"：报成 available:false 会让界面说
    //    "版本管理未启用"，而其实只是还没沉淀过——两种状态要说得出区别
    const git = await writeFakeGitWithHistory({ logFails: 'no-commits' })
    const got = await listMineHistory(mineRoot, 'foo', git)
    assert.deepEqual(got, { available: true, entries: [] })
  })

  test('真的不是 git 仓库 ⇒ available:false + 理由（界面照降级叙事显示）', async () => {
    const git = await writeFakeGitWithHistory({ logFails: 'not-a-repo' })
    const got = await listMineHistory(mineRoot, 'foo', git)
    assert.equal(got.available, false)
    if (got.available) return
    assert.match(got.reason, /not a git repository/)
  })

  test('系统没有 git ⇒ available:false（正常状态，不抛异常）', async () => {
    const got = await listMineHistory(mineRoot, 'foo', join(dir, 'no-such-git'))
    assert.equal(got.available, false)
  })
})

describe('readMineRevision / compareMineRevisions：某一版与两版差异（P2）', () => {
  test('某一版的文件树：键是**相对技能目录**的路径（与 store 的 files 同一口径）', async () => {
    const git = await writeFakeGitWithHistory()
    const got = await readMineRevision(mineRoot, 'foo', 'aaa222', git)
    assert.equal(got.available, true)
    if (!got.available) return
    assert.deepEqual(Object.keys(got.files).sort(), ['SKILL.md', 'reference/notes.md'])
    // 正文里不该再带 `foo/` 前缀：界面按这个键去比 store 里的 files，带前缀就找不着
    assert.match(got.files['SKILL.md'] ?? '', /新的正文/)
    assert.equal(got.files['reference/notes.md'], '第二版笔记\n')
  })

  test('两版相比：逐文件 A/M/D 与行数由**后端**算出来（前端只渲染）', async () => {
    const git = await writeFakeGitWithHistory()
    const got = await compareMineRevisions(
      mineRoot,
      'foo',
      { rev: 'aaa111' },
      { rev: 'aaa222' },
      git,
    )
    assert.equal(got.available, true)
    if (!got.available) return
    const byRel = Object.fromEntries(got.files.map((f) => [f.rel, f]))
    // 正文改了 ⇒ M，而且行数是真算出来的（旧的正文 → 新的正文）
    assert.equal(byRel['SKILL.md']?.change, 'M')
    assert.ok((byRel['SKILL.md']?.added ?? 0) > 0)
    assert.ok((byRel['SKILL.md']?.removed ?? 0) > 0)
    // 两版都有的同一个文件：内容不同 ⇒ M
    assert.equal(byRel['reference/notes.md']?.change, 'M')
  })

  test('`current` 那一侧 = 库里现在这份（工作区与最新提交不同时看得出差别）', async () => {
    const git = await writeFakeGitWithHistory()
    const got = await compareMineRevisions(
      mineRoot,
      'foo',
      { rev: 'aaa111' },
      { current: { 'SKILL.md': '---\nname: foo\n---\n\n旧的正文\n' } },
      git,
    )
    assert.equal(got.available, true)
    if (!got.available) return
    const byRel = Object.fromEntries(got.files.map((f) => [f.rel, f]))
    // `SKILL.md` 两边一字不差 ⇒ `same`（这一条要的就是"能拿**库里的内容**当一侧"）
    assert.equal(byRel['SKILL.md']?.change, 'same')
    // ⚠️ 而 `reference/notes.md` 在这一版里有、库里这份没有 ⇒ `D`。第一版写的是
    //    "every === same"：那要求两侧**文件集合也相同**，而这条测试只给了 SKILL.md
    //    ——期望本身就错了（量到 false，看起来像实现坏了）
    assert.equal(byRel['reference/notes.md']?.change, 'D')
    assert.equal(got.to, 'current')
  })

  test('取不到那一版 ⇒ 整条如实失败（不假装没差异）', async () => {
    const git = await writeFakeGitWithHistory()
    const got = await compareMineRevisions(
      mineRoot,
      'foo',
      { rev: 'aaa111' },
      { rev: 'nope' },
      git,
    )
    assert.equal(got.available, false)
    if (got.available) return
    // 理由里要看得见是哪一侧出的问题（界面照降级叙事显示，别只说"失败了"）
    assert.match(got.reason, /Not a valid object name/)
  })
})
