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
import { commitMine, ensureMineRepo, probeGit } from './skill-mine.ts'
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
    const probe = await probeGit(fakeGit)
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
