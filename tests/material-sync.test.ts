import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * **「生成资料」只有一份手写的东西**（2026-11）。
 *
 * 使用者定调：「material 也在代码中单独目录维护，不要分散在各个地方，最好和 docs
 * 链接起来，直接作为文档的一部分，**人和 LLM 看到的是一份资料**。」
 *
 * 落地形状：
 *
 *   docs/material/**                  ← 唯一手写源（人读；docs/README.md 有链接）
 *   apps/daemon/catalog/material/**   ← 同步产物（daemon 落盘时复制进工作目录，随包发布）
 *   tools/material/sync.mjs           ← 同步器（整目录替换）
 *
 * 这条判据钉三件事：
 *   ① 两边**逐字节相同**（改了 docs 忘了同步 ⇒ 红，跑 `node tools/material/sync.mjs`）；
 *   ② 产物目录里**没有源里不存在的文件**（否则 agent 会读到过期资料）；
 *   ③ 必要的包与索引都在（orchestration 的 README/api/examples/changelog/api-version，
 *      以及 agent / skill 两个包与顶层索引）——"目录搭好了但内容没落地"也要红。
 */
const REPO_ROOT = join(import.meta.dirname, '..')
const SOURCE = 'docs/material'
const TARGET = 'apps/daemon/catalog/material'

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  for (const name of await readdir(dir)) {
    const full = join(dir, name)
    if ((await stat(full)).isDirectory()) out.push(...(await walk(full, base)))
    else out.push(relative(base, full).split('\\').join('/'))
  }
  return out.sort()
}

describe('生成资料（docs/material ⇄ catalog/material）', () => {
  test('★★ 两边逐字节相同，且产物里没有源里没有的文件', async () => {
    const src = await walk(join(REPO_ROOT, SOURCE))
    const dst = await walk(join(REPO_ROOT, TARGET))
    assert.deepEqual(
      dst,
      src,
      `两边文件清单不一致（改完 docs/material 要跑 \`node tools/material/sync.mjs\`）：\n` +
        `只在源里：${src.filter((f) => !dst.includes(f)).join(', ') || '（无）'}\n` +
        `只在产物里：${dst.filter((f) => !src.includes(f)).join(', ') || '（无）'}`,
    )
    const diff: string[] = []
    for (const rel of src) {
      const a = await readFile(join(REPO_ROOT, SOURCE, rel), 'utf8')
      const b = await readFile(join(REPO_ROOT, TARGET, rel), 'utf8')
      if (a !== b) diff.push(rel)
    }
    assert.deepEqual(diff, [], `这些文件两边内容不同（跑 \`node tools/material/sync.mjs\`）：${diff.join(', ')}`)
  })

  test('★ 三包与索引都在：orchestration 齐、agent/skill 有骨架', async () => {
    const src = await walk(join(REPO_ROOT, SOURCE))
    for (const required of [
      'README.md',
      'orchestration/README.md',
      'orchestration/api.md',
      'orchestration/changelog.md',
      'orchestration/api-version.json',
      'agent/README.md',
      'skill/README.md',
    ]) {
      assert.ok(src.includes(required), `docs/material 缺 ${required}`)
    }
    // orchestration 的例子至少四份（接力 / 机器把关 / 人把关 / 并行）——写代码前要照抄的那几份
    const examples = src.filter((f) => f.startsWith('orchestration/examples/'))
    assert.ok(examples.length >= 4, `orchestration/examples 至少 4 份，现在 ${examples.length}`)
    // api-version.json 要能被解析、有 version（daemon 落盘时把它写成 material 的版本标记）
    const version = JSON.parse(
      await readFile(join(REPO_ROOT, SOURCE, 'orchestration/api-version.json'), 'utf8'),
    ) as { version?: unknown }
    assert.equal(typeof version.version, 'string', 'api-version.json 要有 version 字符串')
  })
})
