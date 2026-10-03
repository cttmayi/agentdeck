import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { resolveLocalPath } from '@agentdeck/skill-source'

import { cleanup, makeTempDir } from './testing/tmp.ts'
import { readRecommendedManifest, syncRecommendedSkills } from './skills-sync.ts'

/**
 * `sync-skills` 的测试。
 *
 * ★ **不联网**（NFR-T-01）：`resolveGithubUrl` 与取版本号都走注入的 `fetchImpl`。
 *   所以这里的假 GitHub 就是唯一的"上游"，上游长什么样由这几条用例说了算。
 */

/** 假 GitHub：contents 列目录 + raw 取文件 + commits 取版本。 */
function fakeGithub(
  files: Record<string, string>,
  options: { rawBase?: string; commitsStatus?: number } = {},
): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const rawBase = options.rawBase ?? 'https://raw.githubusercontent.com/o/r/main'

  const impl = (async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)

    const commits = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/commits/.exec(url)
    if (commits) {
      if (options.commitsStatus !== undefined && options.commitsStatus !== 200) {
        return new Response('{}', { status: options.commitsStatus })
      }
      return new Response(JSON.stringify([{ sha: 'abc1234def5678' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const contents = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/(.*?)(?:\?|$)/.exec(
      url,
    )
    if (contents) {
      const dir = contents[1] ?? ''
      const names = new Map<string, { type: 'file' | 'dir'; path: string; size: number }>()
      for (const path of Object.keys(files)) {
        if (dir !== '' && !path.startsWith(`${dir}/`)) continue
        const rest = dir === '' ? path : path.slice(dir.length + 1)
        const [head, ...tail] = rest.split('/')
        if (!head) continue
        const full = dir === '' ? head : `${dir}/${head}`
        if (tail.length > 0) names.set(head, { type: 'dir', path: full, size: 0 })
        else
          names.set(head, {
            type: 'file',
            path: full,
            size: Buffer.byteLength(files[path]!, 'utf8'),
          })
      }
      const entries = [...names.entries()].map(([name, e]) => ({
        name,
        path: e.path,
        type: e.type,
        ...(e.type === 'file' ? { size: e.size, download_url: `${rawBase}/${e.path}` } : {}),
      }))
      return new Response(JSON.stringify(entries), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const raw = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.*)$/.exec(url)
    if (raw) {
      const content = files[raw[1]!]
      if (content === undefined) return new Response('not found', { status: 404 })
      return new Response(content, {
        status: 200,
        headers: { 'content-length': String(Buffer.byteLength(content, 'utf8')) },
      })
    }

    return new Response('unexpected url', { status: 500 })
  }) as typeof fetch

  return { impl, calls }
}

async function writeManifest(items: unknown[]): Promise<string> {
  const dir = await makeTempDir('sync-manifest')
  const path = join(dir, 'recommended-skills.json')
  await writeFile(
    path,
    JSON.stringify({ schema: 'agentdeck/recommended-skills@1', verifiedAt: '2026-10-05', items }),
    'utf8',
  )
  return path
}

const item = (url: string, name = '示例技能') => ({
  url,
  name,
  category: 'research',
  origin: 'official',
  summary: '一句话说明',
  fills: null,
  needs: null,
})

describe('推荐清单：形状校验（坏清单要当场说清是哪一条坏）', () => {
  test('非 GitHub 链接 ⇒ 报错并指出第几条', async () => {
    const path = await writeManifest([item('https://gitlab.com/o/r')])
    await assert.rejects(readRecommendedManifest(path), /第 1 条的 url/)
  })

  test('缺 name ⇒ 报错（它是列表里给人看的那一格）', async () => {
    const path = await writeManifest([{ url: 'https://github.com/o/r', category: 'x', summary: 'y' }])
    await assert.rejects(readRecommendedManifest(path), /缺 name/)
  })

  test('重复条目 ⇒ 报错', async () => {
    const url = 'https://github.com/o/r'
    const path = await writeManifest([item(url), item(url)])
    await assert.rejects(readRecommendedManifest(path), /重复/)
  })
})

describe('★ sync-skills：抓取 → 校验 → 原子替换', () => {
  test('抓下来写进目录，索引里的 sourceRef 指回 GitHub（不是 remote:）', async () => {
    const skillsDir = join(await makeTempDir('sync-out'), 'catalog-skills')
    const gh = fakeGithub({
      'skills/foo/SKILL.md': '---\nname: foo\n---\n\n正文',
      'skills/foo/reference.md': '参考资料',
    })
    try {
      const report = await syncRecommendedSkills({
        manifestPath: await writeManifest([item('https://github.com/o/r/tree/main/skills/foo')]),
        skillsDir,
        fetchImpl: gh.impl,
      })
      assert.equal(report.failures.length, 0, JSON.stringify(report.failures))
      assert.equal(report.swapped, true)
      assert.equal(report.items[0]!.slug, 'foo')
      assert.equal(report.items[0]!.sourceRef, 'github:o/r@main:skills/foo')
      assert.equal(report.items[0]!.version, 'abc1234')
      assert.deepEqual(report.items[0]!.files, ['SKILL.md', 'reference.md'])

      // 内容真的落盘了（含支持文件——缺了它装进来只有 SKILL.md，那种技能是坏的）
      assert.equal(await readFile(join(skillsDir, 'foo', 'SKILL.md'), 'utf8'), '---\nname: foo\n---\n\n正文')
      assert.equal(await readFile(join(skillsDir, 'foo', 'reference.md'), 'utf8'), '参考资料')

      // ★ 目录里只有技能目录 + 一个索引：元数据**不能**放进技能目录里，
      //   否则会被当成支持文件装进使用者的技能里
      assert.deepEqual((await readdir(skillsDir)).sort(), ['.sync.json', 'foo'])
      const index = JSON.parse(await readFile(join(skillsDir, '.sync.json'), 'utf8')) as {
        items: Array<Record<string, unknown>>
      }
      assert.equal(index.items[0]!['sourceRef'], 'github:o/r@main:skills/foo')
      // ★ 这一份**键表就是两个进程之间的契约**：工具写、远端服务读，彼此不 import
      //   （2026-10 拆开，见 README 的"目录布局"）。所以键表在两边各钉一条：
      //   这里钉"我写出来的就是这些键"，`apps/remote/src/server.test.ts` 那边钉
      //   "按这些键读得出来"。任何一边改了字段，都会有一条测试说出另一边。
      assert.deepEqual(
        Object.keys(index.items[0]!).sort(),
        [
          'category',
          'excluded',
          'fetchedAt',
          'files',
          'fills',
          'name',
          'needs',
          'origin',
          'slug',
          'sourceRef',
          'summary',
          'url',
          'version',
        ],
        '改了索引字段就要同时改远端那一侧的手写夹具（见注释）',
      )

      // ★ 读回来用的是**与 daemon 同一个本地取包规则**（`@agentdeck/skill-source`）：
      //   本工具的契约就是"写出一个那份规则读得出来的目录"，而不是"写出远端某个
      //   函数喜欢的形状"。远端自己那一侧（`loadCatalogSkills` + `/api/catalog`）
      //   由 `apps/remote/src/server.test.ts` 钉住——两边各测各的那一段，
      //   跨进程的那条缝就是"一个目录"，也正是这里在测的东西。
      const resolved = await resolveLocalPath(join(skillsDir, 'foo'))
      assert.equal(resolved.slug, 'foo')
      assert.equal(resolved.body, '---\nname: foo\n---\n\n正文')
      assert.equal(resolved.files['reference.md'], '参考资料', '支持文件必须一起装得进去')
    } finally {
      await cleanup(join(skillsDir, '..'))
    }
  })

  test('★★ 有一条抓不到 ⇒ 目录**一个字都没改**（P7：宁可失败，不可静默降级）', async () => {
    const root = await makeTempDir('sync-keep')
    const skillsDir = join(root, 'catalog-skills')
    try {
      // 先放一份"上一次同步的结果"
      await writeFile(join(root, 'placeholder'), '', 'utf8')
      const first = fakeGithub({ 'skills/foo/SKILL.md': '# 旧内容' })
      await syncRecommendedSkills({
        manifestPath: await writeManifest([item('https://github.com/o/r/tree/main/skills/foo')]),
        skillsDir,
        fetchImpl: first.impl,
      })
      assert.match(await readFile(join(skillsDir, 'foo', 'SKILL.md'), 'utf8'), /旧内容/)

      // 这一次清单里多了一条**抓不到**的（上游把目录删了）
      const gh = fakeGithub({ 'skills/foo/SKILL.md': '# 新内容' })
      const report = await syncRecommendedSkills({
        manifestPath: await writeManifest([
          item('https://github.com/o/r/tree/main/skills/foo'),
          { ...item('https://github.com/o/r/tree/main/skills/gone'), name: '消失的技能' },
        ]),
        skillsDir,
        fetchImpl: gh.impl,
        // ⚠️ 关掉复用窗口（0 = 不复用）：这条测的是"抓到了新内容、但因为有失败所以
        //    一个字都不替换"。如果让它复用，磁盘上那份"旧内容"是因为**没下载**而
        //    留在那儿的——断言照样绿，但守的东西已经换了。
        reuseWindowMs: 0,
      })
      assert.equal(report.failures.length, 1)
      assert.match(report.failures[0]!.reason, /没有 SKILL\.md|不存在|not_found|missing_skill_md/)
      assert.equal(report.swapped, false)

      // ★ 旧内容原样还在（半份目录比旧目录更糟）
      assert.match(await readFile(join(skillsDir, 'foo', 'SKILL.md'), 'utf8'), /旧内容/)

      // ★★ 2026-10：失败时**已抓到的没白花**——它落在**断点目录**里，而
      //    已发布目录一个字都没改。两条断言一起才说明"两个目录是分开的"：
      //    发布那份仍是旧内容，断点那份是新抓的。
      assert.equal(report.checkpointed, 1, '抓成的那条要替下一轮攒着')
      assert.match(
        await readFile(join(`${skillsDir}.partial`, 'foo', 'SKILL.md'), 'utf8'),
        /新内容/,
        '断点目录里应当是这一轮真抓到的东西',
      )
      // 也没有留下临时目录
      const leftovers = (await readdir(root)).filter((n) => n.includes('staging') || n.includes('.old-'))
      assert.deepEqual(leftovers, [])
    } finally {
      await cleanup(root)
    }
  })

  test('--dry-run：逐条真抓一遍（能查出坏链接），但不写盘', async () => {
    const root = await makeTempDir('sync-dry')
    const skillsDir = join(root, 'catalog-skills')
    try {
      const gh = fakeGithub({ 'skills/foo/SKILL.md': '# 内容' })
      const report = await syncRecommendedSkills({
        manifestPath: await writeManifest([item('https://github.com/o/r/tree/main/skills/foo')]),
        skillsDir,
        fetchImpl: gh.impl,
        dryRun: true,
      })
      assert.equal(report.dryRun, true)
      assert.equal(report.swapped, false)
      assert.equal(report.items.length, 1)
      await assert.rejects(readdir(skillsDir), /ENOENT/)
      assert.deepEqual(
        (await readdir(root)).filter((n) => n.includes('staging')),
        [],
      )
    } finally {
      await cleanup(root)
    }
  })

  test('两条 slug 撞车 ⇒ 失败（技能库按 slug 唯一，装第二条会顶掉第一条）', async () => {
    const root = await makeTempDir('sync-clash')
    try {
      const gh = fakeGithub({
        'a/foo/SKILL.md': '# A',
        'b/foo/SKILL.md': '# B',
      })
      const report = await syncRecommendedSkills({
        manifestPath: await writeManifest([
          item('https://github.com/o/r/tree/main/a/foo'),
          item('https://github.com/o/r/tree/main/b/foo'),
        ]),
        skillsDir: join(root, 'catalog-skills'),
        fetchImpl: gh.impl,
      })
      assert.equal(report.failures.length, 1)
      assert.match(report.failures[0]!.reason, /slug/)
      assert.equal(report.swapped, false)
    } finally {
      await cleanup(root)
    }
  })

  test('★★ 第一条失败就停：剩下的**不再挨个试**（撞限额时它们只会是同一句话）', async () => {
    const root = await makeTempDir('sync-stop')
    const skillsDir = join(root, 'catalog-skills')
    try {
      // 清单 4 条：第 1 条抓不到，后面 3 条**本来都抓得到**
      const gh = fakeGithub({
        'skills/b/SKILL.md': '# b',
        'skills/c/SKILL.md': '# c',
        'skills/d/SKILL.md': '# d',
      })
      const report = await syncRecommendedSkills({
        manifestPath: await writeManifest([
          item('https://github.com/o/r/tree/main/skills/gone', '删掉了的'),
          item('https://github.com/o/r/tree/main/skills/b'),
          item('https://github.com/o/r/tree/main/skills/c'),
          item('https://github.com/o/r/tree/main/skills/d'),
        ]),
        skillsDir,
        fetchImpl: gh.impl,
      })

      assert.equal(report.failures.length, 1, '只报第一条（不再刷一屏同样的话）')
      assert.equal(report.stoppedEarly, true)
      assert.equal(report.remaining, 3, '要如实说清"还有 3 条没试"')
      // ★ 真正的判据：后面三条**一次都没被请求过**。只断言"失败只有一条"是不够的
      //   ——把失败都吞掉也能满足它，而这里要的是"根本没去试"。
      assert.equal(gh.calls.length, 1, `只该发一次请求，实际：${gh.calls.join(' | ')}`)
      assert.ok(
        !gh.calls.some((u) => u.includes('skills/b') || u.includes('skills/c') || u.includes('skills/d')),
        '后面的条目不许被请求',
      )
      assert.equal(report.swapped, false)
    } finally {
      await cleanup(root)
    }
  })

  test('★★ 1 小时内抓过 ⇒ 跳过下载：**一次 API 调用都不花**', async () => {
    const root = await makeTempDir('sync-reuse')
    const skillsDir = join(root, 'catalog-skills')
    const manifestPath = await writeManifest([item('https://github.com/o/r/tree/main/skills/foo')])
    try {
      const first = fakeGithub({
        'skills/foo/SKILL.md': '---\nname: foo\n---\n\n正文',
        'skills/foo/reference.md': '参考资料',
      })
      await syncRecommendedSkills({
        manifestPath,
        skillsDir,
        fetchImpl: first.impl,
        now: () => new Date('2026-10-05T10:00:00Z'),
      })
      assert.ok(first.calls.length > 0, '第一次当然要真抓')

      // 第二次：30 分钟后。fetch 换成一个"被调用就炸"的——被调用本身就说明没复用。
      const boom = (async (input: unknown): Promise<Response> => {
        throw new Error(`不该发请求：${String(input)}`)
      }) as typeof fetch
      const report = await syncRecommendedSkills({
        manifestPath,
        skillsDir,
        fetchImpl: boom,
        now: () => new Date('2026-10-05T10:30:00Z'),
      })

      assert.deepEqual(report.reused, ['foo'])
      assert.equal(report.failures.length, 0)
      assert.equal(report.swapped, true)
      // 内容（含支持文件）照旧——复用不是"只留 SKILL.md"
      assert.match(await readFile(join(skillsDir, 'foo', 'SKILL.md'), 'utf8'), /正文/)
      assert.equal(await readFile(join(skillsDir, 'foo', 'reference.md'), 'utf8'), '参考资料')
      // 没有重新抓 ⇒ 版本与抓取时间必须**原样沿用**：改掉它们就等于谎称"这是新抓的"
      const index = JSON.parse(await readFile(join(skillsDir, '.sync.json'), 'utf8')) as {
        items: Array<{ version: string; fetchedAt: string }>
      }
      assert.equal(index.items[0]!.version, 'abc1234')
      assert.equal(index.items[0]!.fetchedAt, '2026-10-05T10:00:00.000Z')
    } finally {
      await cleanup(root)
    }
  })

  test('★ 超过 1 小时 ⇒ 重新下载（窗口是"1 小时"，不是"永远复用"）', async () => {
    const root = await makeTempDir('sync-stale')
    const skillsDir = join(root, 'catalog-skills')
    const manifestPath = await writeManifest([item('https://github.com/o/r/tree/main/skills/foo')])
    try {
      await syncRecommendedSkills({
        manifestPath,
        skillsDir,
        fetchImpl: fakeGithub({ 'skills/foo/SKILL.md': '# 旧' }).impl,
        now: () => new Date('2026-10-05T10:00:00Z'),
      })
      const second = fakeGithub({ 'skills/foo/SKILL.md': '# 新' })
      const report = await syncRecommendedSkills({
        manifestPath,
        skillsDir,
        fetchImpl: second.impl,
        now: () => new Date('2026-10-05T11:30:00Z'),
      })

      assert.deepEqual(report.reused, [], '过了窗口就该重新抓')
      assert.ok(second.calls.length > 0)
      assert.match(await readFile(join(skillsDir, 'foo', 'SKILL.md'), 'utf8'), /新/)
    } finally {
      await cleanup(root)
    }
  })

  test('★ 本地那份读不出来（目录被手删）⇒ 回退重抓，并**说出来**', async () => {
    const root = await makeTempDir('sync-broken')
    const skillsDir = join(root, 'catalog-skills')
    const manifestPath = await writeManifest([item('https://github.com/o/r/tree/main/skills/foo')])
    try {
      await syncRecommendedSkills({
        manifestPath,
        skillsDir,
        fetchImpl: fakeGithub({ 'skills/foo/SKILL.md': '# 一' }).impl,
        now: () => new Date('2026-10-05T10:00:00Z'),
      })
      await rm(join(skillsDir, 'foo'), { recursive: true, force: true })

      const second = fakeGithub({ 'skills/foo/SKILL.md': '# 二' })
      const report = await syncRecommendedSkills({
        manifestPath,
        skillsDir,
        fetchImpl: second.impl,
        now: () => new Date('2026-10-05T10:30:00Z'),
      })

      // ★ 不许把"索引里写着有"当成"内容还在"：读不出来就重抓，而且要说一句
      assert.deepEqual(report.reused, [])
      assert.ok(second.calls.length > 0, '内容没了就得去抓')
      assert.ok(
        report.warnings.some((w) => /读不出来/.test(w)),
        `要说清为什么不复用：${report.warnings.join(' | ')}`,
      )
      assert.match(await readFile(join(skillsDir, 'foo', 'SKILL.md'), 'utf8'), /二/)
    } finally {
      await cleanup(root)
    }
  })

  test('★ `--dry-run` 与 `--refresh` 都无视复用窗口（dry-run 的用途就是逐条真抓一遍）', async () => {
    const root = await makeTempDir('sync-window-off')
    const skillsDir = join(root, 'catalog-skills')
    const manifestPath = await writeManifest([item('https://github.com/o/r/tree/main/skills/foo')])
    try {
      await syncRecommendedSkills({
        manifestPath,
        skillsDir,
        fetchImpl: fakeGithub({ 'skills/foo/SKILL.md': '# 一' }).impl,
        now: () => new Date('2026-10-05T10:00:00Z'),
      })

      // dry-run：窗口内也照样真抓（跳过任何一条都会让这次检查说假话）
      const dry = fakeGithub({ 'skills/foo/SKILL.md': '# 一' })
      const dryReport = await syncRecommendedSkills({
        manifestPath,
        skillsDir,
        fetchImpl: dry.impl,
        dryRun: true,
        now: () => new Date('2026-10-05T10:10:00Z'),
      })
      assert.ok(dry.calls.length > 0, '--dry-run 不许因为"本地还新"就跳过')
      assert.deepEqual(dryReport.reused, [])

      // --refresh：强制重新下载
      const fresh = fakeGithub({ 'skills/foo/SKILL.md': '# 二' })
      const refreshReport = await syncRecommendedSkills({
        manifestPath,
        skillsDir,
        fetchImpl: fresh.impl,
        refresh: true,
        now: () => new Date('2026-10-05T10:20:00Z'),
      })
      assert.ok(fresh.calls.length > 0, '--refresh 必须真的重新下载')
      assert.deepEqual(refreshReport.reused, [])
      assert.match(await readFile(join(skillsDir, 'foo', 'SKILL.md'), 'utf8'), /二/)
    } finally {
      await cleanup(root)
    }
  })

  test('★ `--out` 给**相对路径**时也能复用（`resolveLocalPath` 只收绝对路径）', async () => {
    // ⚠️ 这条是一次真踩：复用那条路要拿共用取包规则去校验本地那份，而它**只收绝对
    //   路径**（刻意的规定）。给相对的 `--out` 时它会抛，于是复用**悄悄走不到**、
    //    白花一轮配额（当时只留了一条 warning）。所以这里用相对路径再验一遍。
    const root = await makeTempDir('sync-rel')
    const absDir = join(root, 'catalog-skills')
    const relDir = relative(process.cwd(), absDir)
    const manifestPath = await writeManifest([item('https://github.com/o/r/tree/main/skills/foo')])
    try {
      await syncRecommendedSkills({
        manifestPath,
        skillsDir: relDir,
        fetchImpl: fakeGithub({ 'skills/foo/SKILL.md': '# 一' }).impl,
        now: () => new Date('2026-10-05T10:00:00Z'),
      })

      const boom = (async (input: unknown): Promise<Response> => {
        throw new Error(`不该发请求：${String(input)}`)
      }) as typeof fetch
      const report = await syncRecommendedSkills({
        manifestPath,
        skillsDir: relDir,
        fetchImpl: boom,
        now: () => new Date('2026-10-05T10:30:00Z'),
      })

      assert.deepEqual(report.reused, ['foo'], '相对路径下也要走得到复用')
      assert.equal(report.skillsDir, absDir, '报告里给的是绝对路径（"写到了哪儿"要能核对）')
    } finally {
      await cleanup(root)
    }
  })

  test('★★ 撞墙之后下一轮**只补缺的**（这才是"收敛"；我先前说过的那句当时是错的）', async () => {
    const root = await makeTempDir('sync-resume')
    const skillsDir = join(root, 'catalog-skills')
    const manifestPath = await writeManifest([
      item('https://github.com/o/r/tree/main/skills/foo'),
      item('https://github.com/o/r/tree/main/skills/bar'),
    ])
    try {
      // 第一轮：foo 抓成、bar 上游还没有 ⇒ 失败、什么都不发布
      const first = fakeGithub({ 'skills/foo/SKILL.md': '# foo' })
      const firstReport = await syncRecommendedSkills({ manifestPath, skillsDir, fetchImpl: first.impl })
      assert.equal(firstReport.swapped, false)
      assert.equal(firstReport.checkpointed, 1, 'foo 应当已经攒在断点目录里')

      // 第二轮：上游把 bar 补上了。**foo 一次都不许再被请求**——那是已经花过配额的东西。
      const second = fakeGithub({
        'skills/foo/SKILL.md': '# foo',
        'skills/bar/SKILL.md': '# bar',
      })
      const secondReport = await syncRecommendedSkills({ manifestPath, skillsDir, fetchImpl: second.impl })

      assert.deepEqual(secondReport.fromCheckpoint, ['foo'], 'foo 要从断点目录沿用')
      assert.ok(
        !second.calls.some((u) => u.includes('skills/foo')),
        `已经抓过的条目不许再请求，实际：${second.calls.join(' | ')}`,
      )
      assert.equal(secondReport.swapped, true)
      // 两条都在已发布目录里
      assert.equal(await readFile(join(skillsDir, 'foo', 'SKILL.md'), 'utf8'), '# foo')
      assert.equal(await readFile(join(skillsDir, 'bar', 'SKILL.md'), 'utf8'), '# bar')
      // ★ 内容已发布 ⇒ 断点目录收掉（留着会变成"下次会不会用旧的"这种说不清的状态）
      await assert.rejects(
        () => readdir(`${skillsDir}.partial`),
        '整轮成功之后断点目录要清掉',
      )
    } finally {
      await cleanup(root)
    }
  })

  test('★ 断点那份**跨小时也沿用**（花过配额的东西不因"过了 1 小时"丢掉）', async () => {
    // ⚠️ 这是刻意与"已发布目录 1 小时窗口"不同的口径：已发布那份过期就重抓（使用者
    //   定的规格），而断点那份是**已经花过配额、只是还没装上**的内容——它要是也
    //   过期，"撞墙后重跑"就又退化成从头再抓，配额白花（那正是这个目录存在的理由）。
    const root = await makeTempDir('sync-resume-old')
    const skillsDir = join(root, 'catalog-skills')
    const manifestPath = await writeManifest([
      item('https://github.com/o/r/tree/main/skills/foo'),
      item('https://github.com/o/r/tree/main/skills/bar'),
    ])
    try {
      const first = fakeGithub({ 'skills/foo/SKILL.md': '# foo' })
      await syncRecommendedSkills({
        manifestPath,
        skillsDir,
        fetchImpl: first.impl,
        now: () => new Date('2026-10-05T10:00:00Z'),
      })

      // 三个小时后再跑（远超 1 小时窗口）
      const later = fakeGithub({
        'skills/foo/SKILL.md': '# 变了',
        'skills/bar/SKILL.md': '# bar',
      })
      const report = await syncRecommendedSkills({
        manifestPath,
        skillsDir,
        fetchImpl: later.impl,
        now: () => new Date('2026-10-05T13:00:00Z'),
      })

      assert.deepEqual(report.fromCheckpoint, ['foo'], '断点那份不受 1 小时窗口管')
      assert.ok(!later.calls.some((u) => u.includes('skills/foo')), '不许重抓断点里的条目')
      assert.equal(await readFile(join(skillsDir, 'foo', 'SKILL.md'), 'utf8'), '# foo')
    } finally {
      await cleanup(root)
    }
  })

  test('★ `--refresh` 无视断点（全部重新下载）', async () => {
    const root = await makeTempDir('sync-refresh-cp')
    const skillsDir = join(root, 'catalog-skills')
    const manifestPath = await writeManifest([
      item('https://github.com/o/r/tree/main/skills/foo'),
      item('https://github.com/o/r/tree/main/skills/bar'),
    ])
    try {
      await syncRecommendedSkills({
        manifestPath,
        skillsDir,
        fetchImpl: fakeGithub({ 'skills/foo/SKILL.md': '# foo' }).impl,
        now: () => new Date('2026-10-05T10:00:00Z'),
      })

      const fresh = fakeGithub({
        'skills/foo/SKILL.md': '# 新的',
        'skills/bar/SKILL.md': '# bar',
      })
      const report = await syncRecommendedSkills({
        manifestPath,
        skillsDir,
        fetchImpl: fresh.impl,
        refresh: true,
        now: () => new Date('2026-10-05T10:10:00Z'),
      })

      assert.deepEqual(report.fromCheckpoint, [], '--refresh 时断点也要无视')
      assert.ok(fresh.calls.some((u) => u.includes('skills/foo')), '--refresh 必须真的重下')
      assert.equal(await readFile(join(skillsDir, 'foo', 'SKILL.md'), 'utf8'), '# 新的')
    } finally {
      await cleanup(root)
    }
  })

  test('★ `--dry-run` 一个字都不写：连断点目录都不建', async () => {
    const root = await makeTempDir('sync-dry-cp')
    const skillsDir = join(root, 'catalog-skills')
    try {
      const report = await syncRecommendedSkills({
        manifestPath: await writeManifest([
          item('https://github.com/o/r/tree/main/skills/foo'),
        ]),
        skillsDir,
        fetchImpl: fakeGithub({ 'skills/foo/SKILL.md': '# foo' }).impl,
        dryRun: true,
      })
      assert.equal(report.dryRun, true)
      assert.equal(report.checkpointed, 0)
      const names = await readdir(root)
      assert.ok(
        !names.some((n) => n.includes('.partial')),
        `--dry-run 是检查，不许写盘，实际留下：${names.join(', ')}`,
      )
    } finally {
      await cleanup(root)
    }
  })

  test('★★ 走加速器同步：请求（含取版本）都发给代理，且**不带 token**', async () => {
    // 与共用取包规则里那条是同一个判据的两个入口；工具这边**接线**要能被发现断掉
    // （同步里除了取包规则，还有一次自己拼的"取版本"请求——它最容易漏掉改写）。
    const seen: Array<{ url: string; authorization: string | null }> = []
    const inner = fakeGithub({
      'skills/foo/SKILL.md': '# 正文',
      'skills/foo/extra.md': '补充',
    })
    const direct = inner.impl
    const proxyImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      seen.push({
        url,
        authorization: new Headers((init?.headers ?? {}) as Record<string, string>).get('authorization'),
      })
      if (!url.startsWith('https://gh-proxy.com/https://')) {
        return new Response(`没走代理：${url}`, { status: 502 })
      }
      return direct(url.slice('https://gh-proxy.com/'.length), init)
    }) as typeof fetch

    const root = await makeTempDir('sync-proxy')
    const skillsDir = join(root, 'catalog-skills')
    try {
      const report = await syncRecommendedSkills({
        manifestPath: await writeManifest([item('https://github.com/o/r/tree/main/skills/foo')]),
        skillsDir,
        fetchImpl: proxyImpl,
        githubToken: 'secret-token-must-not-leak',
        githubProxy: 'https://gh-proxy.com',
      })

      assert.equal(report.failures.length, 0, JSON.stringify(report.failures))
      assert.equal(report.swapped, true)
      assert.ok(seen.length > 0)
      // ★ 取版本那次请求也必须走代理（它原来是自己拼地址的）
      assert.ok(
        seen.some((r) => r.url.includes('/commits')),
        `取版本也要走代理，实际：${seen.map((r) => r.url).join(' | ')}`,
      )
      for (const req of seen) {
        assert.ok(req.url.startsWith('https://gh-proxy.com/https://'), `该走代理：${req.url}`)
        assert.equal(req.authorization, null, '★ 凭证不许交给第三方加速器')
      }
    } finally {
      await cleanup(root)
    }
  })

  test('★★ 清单里的 include/exclude：剪掉营销素材与测试产物，并**如实列出来**', async () => {
    // 这次是真仓的形状：仓库里混着 README 图（docs/readme/**）与测试产物
    // （scripts/verify-output/**），而技能内容在 references/ + assets/ 里。
    const gh = fakeGithub({
      'SKILL.md': '# 正文',
      'references/a.md': '参考',
      'assets/theme.css': 'body{}',
      'docs/readme/hero.md': 'README 图说明',
      'scripts/verify-output/out.png': 'y'.repeat(300_000),
    })
    const root = await makeTempDir('sync-filter')
    const skillsDir = join(root, 'catalog-skills')
    try {
      const report = await syncRecommendedSkills({
        manifestPath: await writeManifest([
          {
            ...item('https://github.com/o/r'),
            exclude: ['docs/**', 'scripts/verify-output/**'],
          },
        ]),
        skillsDir,
        fetchImpl: gh.impl,
      })

      assert.equal(report.failures.length, 0, JSON.stringify(report.failures))
      // 装进来的只有该留的
      assert.deepEqual(report.items[0]!.files, ['SKILL.md', 'assets/theme.css', 'references/a.md'])
      // ★ 索引里记下"被排除的"——界面靠它说"内容不完整"
      assert.deepEqual(report.items[0]!.excluded.sort(), ['docs/', 'scripts/verify-output/'])
      // ★ 那 300 KB 的测试产物**一次都没被请求**（不然限额与流量都白花）
      assert.ok(
        !gh.calls.some((u) => u.includes('verify-output')),
        `被排除的文件不该下载：${gh.calls.join(' | ')}`,
      )
    } finally {
      await cleanup(root)
    }
  })

  test('★ 改过排除图案之后**不复用**旧内容（否则"我明明加了 exclude，怎么还是旧的"）', async () => {
    const root = await makeTempDir('sync-filter-reuse')
    const skillsDir = join(root, 'catalog-skills')
    const withExclude = await writeManifest([
      { ...item('https://github.com/o/r'), exclude: ['docs/**'] },
    ])
    try {
      const first = fakeGithub({ 'SKILL.md': '# 正文', 'docs/x.md': '文档' })
      await syncRecommendedSkills({
        manifestPath: withExclude,
        skillsDir,
        fetchImpl: first.impl,
        now: () => new Date('2026-10-05T10:00:00Z'),
      })

      // 同一个 URL、同一份清单，但把 exclude 去掉（图案变了）
      const withoutExclude = await writeManifest([item('https://github.com/o/r')])
      const second = fakeGithub({ 'SKILL.md': '# 正文', 'docs/x.md': '文档' })
      const report = await syncRecommendedSkills({
        manifestPath: withoutExclude,
        skillsDir,
        fetchImpl: second.impl,
        now: () => new Date('2026-10-05T10:05:00Z'),
      })

      assert.deepEqual(report.reused, [], '图案变了就不该沿用旧内容')
      assert.ok(second.calls.length > 0, '要重新抓一遍')
      assert.deepEqual(report.items[0]!.excluded, [], '新图案下没有排除')
      // ⚠️ `SyncIndexItem.files` 是**字符串数组**（`ResolvedSkillSource.files` 才是
      //    相对路径→内容的对象）——这里踩过一次，写成了 `Object.keys(...)`
      assert.ok(report.items[0]!.files.includes('docs/x.md'), '这次该把 docs 带上')
    } finally {
      await cleanup(root)
    }
  })

  test('★ 清单里的图案写错（绝对路径 / `..` / 排除 SKILL.md）⇒ 读清单时就报错', async () => {
    for (const [exclude, pattern] of [
      [['/etc/**'], /相对路径/],
      [['../secret'], /相对路径/],
      [['**'], /SKILL\.md/],
    ] as Array<[string[], RegExp]>) {
      const path = await writeManifest([{ ...item('https://github.com/o/r'), exclude }])
      await assert.rejects(readRecommendedManifest(path), pattern, `exclude=${exclude.join()}`)
    }
    // include 也走同一套校验
    const bad = await writeManifest([{ ...item('https://github.com/o/r'), include: ['..'] }])
    await assert.rejects(readRecommendedManifest(bad), /相对路径/)
  })

  test('取版本号失败**不算失败**：目录照旧同步，只记一条 warning', async () => {
    const root = await makeTempDir('sync-ver')
    try {
      const gh = fakeGithub({ 'skills/foo/SKILL.md': '# 内容' }, { commitsStatus: 403 })
      const report = await syncRecommendedSkills({
        manifestPath: await writeManifest([item('https://github.com/o/r/tree/main/skills/foo')]),
        skillsDir: join(root, 'catalog-skills'),
        fetchImpl: gh.impl,
      })
      assert.equal(report.failures.length, 0)
      assert.equal(report.swapped, true)
      assert.equal(report.items[0]!.version, null)
      assert.match(report.warnings.join('\n'), /取版本号失败/)
    } finally {
      await cleanup(root)
    }
  })
})
