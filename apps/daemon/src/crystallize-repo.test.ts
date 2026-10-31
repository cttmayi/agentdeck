/**
 * 从仓库拉材料的**纯解析测试**（分批第 157 批，§12.54）。
 *
 * 为什么单独一个文件、而且一条网络请求都不发：这一块的要点几乎全在"**边界**"上——
 * 收哪些地址、拒哪些地址、落下叫什么名字。把它钉在纯函数里，跑得快、也不会因为
 * GitHub 一天变一次接口就红一片（真拉取那条链在 `crystallize-e2e.test.ts` 里用注入的
 * `fetchImpl` 钉着）。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendRepoMaterial } from './crystallize-material.ts'
import {
  REPO_MAX_FILES,
  fetchRepoTextFiles,
  parseRepoUrl,
  repoDirName,
} from './crystallize-repo.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

describe('§10.14 从仓库拉材料：地址解析（分批第 157 批）', () => {
  const ok = (input: string) => {
    const r = parseRepoUrl(input)
    assert.equal(r.ok, true, `${input} 应当被接受${r.ok ? '' : `：${r.error}`}`)
    return r.ok ? r.ref : null
  }
  const bad = (input: string, why: RegExp) => {
    const r = parseRepoUrl(input)
    assert.equal(r.ok, false, `${input} 不应当被接受`)
    assert.match(r.ok ? '' : r.error, why)
  }

  test('★★ 认三种写法：仓库根 / tree+子目录 / owner-repo 简写', () => {
    const root = ok('https://github.com/acme/notes')
    assert.deepEqual(root, { owner: 'acme', repo: 'notes', ref: 'HEAD', subpath: '' })

    const tree = ok('https://github.com/acme/notes/tree/main/docs/runbooks')
    assert.deepEqual(tree, { owner: 'acme', repo: 'notes', ref: 'main', subpath: 'docs/runbooks' })

    const short = ok('acme/notes')
    assert.deepEqual(short, { owner: 'acme', repo: 'notes', ref: 'HEAD', subpath: '' })
  })

  test('★★ 不该收的地址一律当场拒，并说清为什么（白名单是硬边界）', () => {
    bad('https://gitlab.com/acme/notes', /只接受 GitHub/)
    bad('http://github.com/acme/notes', /只接受 https/)
    bad('https://user:pw@github.com/acme/notes', /不要带用户名/)
    bad('https://github.com/acme/notes?x=1', /查询串/)
    bad('https://raw.githubusercontent.com/acme/notes/main/a.md', /仓库主页地址/)
    bad('https://github.com/acme', /缺 owner\/repo/)
    bad('https://github.com/acme/notes/blob/main/a.md', /只认仓库根或/)
    bad('', /空的/)
  })

  test('★ 落盘目录名带 owner（两个仓库同名时素材清单里分得清）', () => {
    const r = ok('https://github.com/acme/notes')
    assert.ok(r)
    assert.deepEqual(repoDirName(r), 'acme-notes')
    // 不安全字符折成 `-`，不会留空
    const weird = ok('https://github.com/a/b.c_d-1')
    assert.ok(weird)
    assert.equal(repoDirName(weird), 'a-b.c_d-1')
  })
})

describe('§10.14 从仓库拉材料：拉取时的上限与过滤（注入 fetch，不打真网络）', () => {
  const tree = (paths: Array<{ path: string; size?: number }>) => ({
    ok: true,
    status: 200,
    json: async () => ({
      tree: paths.map((p) => ({ path: p.path, type: 'blob', size: p.size ?? 10 })),
    }),
    text: async () => '',
  })

  const rawOf = (map: Record<string, string>) => (path: string) => ({
    ok: true,
    status: 200,
    text: async () => map[path] ?? `# ${path}\n`,
    json: async () => ({}),
  })

  test('★★ 只收文本、跳过依赖目录与超大文件；上限之内全拉下来', async () => {
    const paths = [
      { path: 'README.md', size: 100 },
      { path: 'docs/guide.md', size: 200 },
      { path: 'logo.png', size: 300 },
      { path: 'node_modules/dep/index.js', size: 400 },
      { path: 'huge.log', size: 1024 * 1024 },
      { path: `many/ok.md`, size: 50 },
    ]
    const fetched: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url)
      fetched.push(u)
      if (u.includes('/git/trees/')) return tree(paths)
      const path = decodeURIComponent(u.split('/').slice(7).join('/'))
      return rawOf({})('docs/guide.md' === path ? 'docs/guide.md' : path)
    }) as unknown as typeof fetch

    const r = await fetchRepoTextFiles(
      { owner: 'acme', repo: 'notes', ref: 'HEAD', subpath: '' },
      { fetchImpl },
    )
    assert.deepEqual(
      r.files.map((f) => f.relPath).sort(),
      ['README.md', 'docs/guide.md', 'many/ok.md'],
    )
    assert.equal(r.skipped.some((s) => s.includes('logo.png')), true, '非文本要如实说跳过')
    assert.equal(r.skipped.some((s) => s.includes('node_modules')), true, '依赖目录要跳过')
    assert.equal(r.skipped.some((s) => s.includes('huge.log')), true, '超大文件要跳过')
    assert.equal(fetched.length, 1 + r.files.length, 'tree 一次 + 每个收下的文件一次，别多发请求')
  })

  test('★★ 子目录与 SKILL.md：只取那个子目录，并且如实报告"仓库里带了 SKILL.md"', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/git/trees/')) {
        return tree([
          { path: 'SKILL.md', size: 10 },
          { path: 'docs/a.md', size: 10 },
          { path: 'docs/b.md', size: 10 },
          { path: 'other/c.md', size: 10 },
        ])
      }
      return rawOf({})('x')
    }) as unknown as typeof fetch
    const r = await fetchRepoTextFiles(
      { owner: 'acme', repo: 'notes', ref: 'main', subpath: 'docs' },
      { fetchImpl },
    )
    assert.deepEqual(r.files.map((f) => f.relPath).sort(), ['a.md', 'b.md'])
    // SKILL.md 不在子目录里 ⇒ 不该报"带了 SKILL.md"（否则界面会给出一个错误的提示）
    assert.equal(r.hasSkillMd, false)
  })

  test('★ 文件数超过上限时如实跳过，不会把整个仓库吞进素材', async () => {
    const many = Array.from({ length: REPO_MAX_FILES + 5 }, (_, i) => ({
      path: `f${String(i).padStart(3, '0')}.md`,
      size: 10,
    }))
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/git/trees/')) return tree(many)
      return rawOf({})('x')
    }) as unknown as typeof fetch
    const r = await fetchRepoTextFiles(
      { owner: 'acme', repo: 'notes', ref: 'HEAD', subpath: '' },
      { fetchImpl },
    )
    assert.equal(r.files.length, REPO_MAX_FILES)
    assert.equal(r.skipped.filter((s) => s.includes('上限')).length, 5)
  })
})

describe('§10.14 从仓库拉材料：落盘与索引（分批第 157 批）', () => {
  test('★★ 几个文件落进 appended/<owner>-<repo>/，索引页只登记一行（不逐个列）', async () => {
    const dir = await makeTempDir('crystal-repo-material')
    try {
      const materialDir = join(dir, 'material')
      const saved = await appendRepoMaterial(materialDir, {
        dirName: 'acme-notes',
        files: [
          { relPath: 'README.md', text: '# 笔记\n\n先看日志再动手\n' },
          { relPath: 'docs/runbook.md', text: '# 手册\n' },
        ],
        now: new Date('2026-11-02T00:00:00Z'),
      })
      assert.equal(saved.relDir, 'appended/acme-notes')
      assert.equal(saved.files, 2)
      const readme = await readFile(join(materialDir, 'appended', 'acme-notes', 'README.md'), 'utf8')
      assert.match(readme, /先看日志再动手/, '正文要原样保留')
      assert.match(readme, /从仓库拉来的材料/, '头几行要说清它是从仓库拉来的')
      const nested = await readFile(
        join(materialDir, 'appended', 'acme-notes', 'docs', 'runbook.md'),
        'utf8',
      )
      assert.match(nested, /# 手册/, '仓库里的目录结构要保留')
      const index = await readFile(join(materialDir, '00-README.md'), 'utf8')
      assert.match(index, /使用者后来追加的材料/, '索引页要登记（起草者读的第一个文件）')
      assert.match(index, /appended\/acme-notes\//, '登记的是目录，不是逐个文件')
      assert.equal(index.includes('docs/runbook.md'), false, '一个仓库几十个文件，逐个列会把索引淹掉')
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 路径穿越的文件被丢掉（API 是公开的，不能靠上游已查过）', async () => {
    const dir = await makeTempDir('crystal-repo-evil')
    try {
      const materialDir = join(dir, 'material')
      const saved = await appendRepoMaterial(materialDir, {
        dirName: 'acme-notes',
        files: [
          { relPath: '../evil.md', text: '穿越' },
          { relPath: 'ok.md', text: '正常' },
        ],
      })
      assert.equal(saved.files, 1, '带 `..` 的那份直接不算（也不写盘）')
      assert.equal(
        await readFile(join(materialDir, 'evil.md'), 'utf8').catch(() => null),
        null,
        '不许写到 material/ 根上',
      )
    } finally {
      await cleanup(dir)
    }
  })
})
