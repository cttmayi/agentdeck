import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import {
  MAX_FILES,
  MAX_SKILL_BYTES,
  SkillSourceError,
  isProbablyText,
  parseGithubUrl,
  resolveGithubUrl,
  resolveLocalPath,
  resolvePayloadEntry,
  resolveSkillSource,
  toSlug,
} from './skill-source.ts'

/**
 * skill 来源解析（FR-AGENT-09/11）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这组测试要钉住三件事
 * ══════════════════════════════════════════════════════════════════
 *
 * **① 没有 SKILL.md 就不是技能。** 三种来源都要过这一关。装进来一个永远
 *    不会生效的技能，比拒绝安装糟得多——使用者会以为它在起作用。
 *
 * **② 边界不许松。** 这是 daemon 第一次对外发请求，主机白名单、跳转校验、
 *    限额都在这里，而且都必须是"不满足就拒绝"，不是"不满足就降级"。
 *
 * **③ 测试绝不联网。** 所有 GitHub 路径都注入假 fetch（NFR-T-01）。
 */

// ─────────────────────────────────────────────────────────────
// 假 GitHub
// ─────────────────────────────────────────────────────────────

/**
 * 用一张 `路径 → 内容` 的表假装成 GitHub。
 *
 * 故意按**协议**来假装（contents API 返回目录列表、raw 返回内容），而不是
 * 按"我们的代码怎么调"来假装：前者能发现调用方式错了，后者只会为错误放行。
 */
function fakeGithub(
  files: Record<string, string>,
  options: { status?: number; headers?: Record<string, string>; rawBase?: string } = {},
): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const rawBase = options.rawBase ?? 'https://raw.githubusercontent.com/o/r/main'

  const impl = (async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)

    if (options.status !== undefined) {
      return new Response('{}', { status: options.status, headers: options.headers ?? {} })
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
        ...(e.type === 'file'
          ? { size: e.size, download_url: `${rawBase}/${e.path}` }
          : {}),
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

/** 建一个技能目录。`files` 是相对路径 → 内容。 */
async function makeSkillDir(files: Record<string, string>): Promise<string> {
  const dir = await makeTempDir('skill-src')
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return dir
}

async function expectSourceError(
  fn: () => Promise<unknown>,
  code: string,
  messagePattern?: RegExp,
): Promise<SkillSourceError> {
  try {
    await fn()
  } catch (err) {
    assert.equal(err instanceof SkillSourceError, true, `应当是 SkillSourceError：${String(err)}`)
    const e = err as SkillSourceError
    assert.equal(e.code, code)
    if (messagePattern) assert.match(e.message, messagePattern)
    return e
  }
  assert.fail('本该报错，但没有报错')
}

// ─────────────────────────────────────────────────────────────
// slug
// ─────────────────────────────────────────────────────────────

describe('slug 收敛', () => {
  test('常见写法都能收敛成 kebab-case', () => {
    assert.equal(toSlug('My_Skill'), 'my-skill')
    assert.equal(toSlug('Foo.Bar'), 'foo-bar')
    assert.equal(toSlug('--a--b--'), 'a-b')
    assert.equal(toSlug('Bubble Sort'), 'bubble-sort')
  })

  test('★ 全非 ASCII 收敛成空串 —— 由调用方报错，而不是猜一个名字', () => {
    // 「技能」这种目录名收敛后是空串。此时**必须报错要求显式指定 slug**：
    // 猜一个拼音/序号当目录名，使用者会得到一个自己没起过名字的技能。
    assert.equal(toSlug('技能'), '')
  })

  test('★ 超过 63 字符会被截断（目录名有长度限制）', () => {
    assert.equal(toSlug('a'.repeat(200)).length, 63)
  })
})

// ─────────────────────────────────────────────────────────────
// 本地目录
// ─────────────────────────────────────────────────────────────

describe('来源：本地目录', () => {
  test('★ 有 SKILL.md 就装上，并把支持文件一起带上', async () => {
    const dir = await makeSkillDir({
      'SKILL.md': '# 我的技能\n\n标准正文',
      'reference.md': '参考资料',
      'scripts/check.sh': 'echo ok',
    })
    try {
      const r = await resolveLocalPath(dir)
      assert.equal(r.body, '# 我的技能\n\n标准正文')
      assert.equal(r.files['reference.md'], '参考资料')
      assert.equal(
        r.files['scripts/check.sh'],
        'echo ok',
        '★ 子目录里的支持文件也要带——少了它技能就是坏的',
      )
      assert.equal(r.slug.startsWith('skill-src-'), true, 'slug 由目录名派生')
      assert.equal(r.included.length, 3)
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 没有 SKILL.md ⇒ 拒绝，并且说清"这里到底有什么"', async () => {
    const dir = await makeSkillDir({ 'readme.md': '我不是技能', 'notes.txt': 'x' })
    try {
      const err = await expectSourceError(() => resolveLocalPath(dir), 'missing_skill_md')
      assert.match(err.detail ?? '', /readme\.md/, '★ 要列出目录内容，否则使用者不知道该怎么改')
      assert.match(err.message, /不是技能/)
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 只有小写 skill.md ⇒ 拒绝，并点明大小写问题', async () => {
    // macOS 文件系统不分大小写，`skill.md` 在 mac 上"碰巧能用"，Linux 上不行；
    // 而 CLI 找的是大写那个名字。这条测试保证我们**不跟着 mac 一起碰巧**。
    const dir = await makeSkillDir({ 'skill.md': '# 小写' })
    try {
      const err = await expectSourceError(() => resolveLocalPath(dir), 'missing_skill_md')
      assert.match(err.detail ?? '', /SKILL\.md/)
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 空 SKILL.md 也算"没有" —— 它同样不会生效', async () => {
    const dir = await makeSkillDir({ 'SKILL.md': '   \n\n  ' })
    try {
      await expectSourceError(() => resolveLocalPath(dir), 'missing_skill_md')
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 相对路径被拒绝（它取决于 daemon 从哪儿启动）', async () => {
    const err = await expectSourceError(() => resolveLocalPath('./somewhere'), 'bad_input')
    assert.match(err.message, /绝对路径/)
  })

  test('路径不存在 ⇒ not_found，而不是抛原始 ENOENT', async () => {
    const err = await expectSourceError(
      () => resolveLocalPath('/definitely/not/here/xyz'),
      'not_found',
    )
    assert.match(err.message, /不存在/)
  })

  test('★ 指向普通文件 ⇒ 明确说"技能是目录"', async () => {
    const dir = await makeSkillDir({ 'notes.txt': 'x' })
    try {
      await expectSourceError(() => resolveLocalPath(join(dir, 'notes.txt')), 'not_a_directory')
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 直接指向 SKILL.md 文件本身也可以（取它所在的目录）', async () => {
    const dir = await makeSkillDir({ 'SKILL.md': '# 正文', 'a.md': 'A' })
    try {
      const r = await resolveLocalPath(join(dir, 'SKILL.md'))
      assert.equal(r.body, '# 正文')
      assert.equal(r.files['a.md'], 'A', '支持文件照样要带上')
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 二进制支持文件**明确不装**并给出原因（不静默、也不写坏）', async () => {
    const dir = await makeSkillDir({ 'SKILL.md': '# 正文' })
    await writeFile(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    try {
      const r = await resolveLocalPath(dir)
      assert.equal(r.files['logo.png'], undefined)
      assert.equal(r.ignored.length, 1)
      assert.match(r.ignored[0]!.reason, /二进制/)
    } finally {
      await cleanup(dir)
    }
  })

  test('★ SKILL.md 本身是二进制 ⇒ 直接拒绝', async () => {
    const dir = await makeSkillDir({})
    await writeFile(join(dir, 'SKILL.md'), Buffer.from([0x00, 0x01, 0x02]))
    try {
      await expectSourceError(() => resolveLocalPath(dir), 'binary_file')
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 超过单个技能大小上限 ⇒ 拒绝（与注入层同一个上限）', async () => {
    const dir = await makeSkillDir({ 'SKILL.md': 'x'.repeat(MAX_SKILL_BYTES + 1) })
    try {
      await expectSourceError(() => resolveLocalPath(dir), 'too_large')
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 文件太多 ⇒ 拒绝（支持文件不是整个仓库）', async () => {
    const files: Record<string, string> = { 'SKILL.md': '# 正文' }
    for (let i = 0; i < MAX_FILES; i++) files[`f${i}.md`] = 'x'
    const dir = await makeSkillDir(files)
    try {
      await expectSourceError(() => resolveLocalPath(dir), 'too_many_files')
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 符号链接不跟随，并记下原因', async () => {
    const dir = await makeSkillDir({ 'SKILL.md': '# 正文', 'real.md': '真文件' })
    await symlink(join(dir, 'real.md'), join(dir, 'link.md'))
    try {
      const r = await resolveLocalPath(dir)
      assert.equal(r.files['link.md'], undefined, '跟随符号链接就可能跑出技能目录')
      assert.equal(
        r.ignored.some((i) => i.path === 'link.md' && /符号链接/.test(i.reason)),
        true,
      )
    } finally {
      await cleanup(dir)
    }
  })

  test('.git 目录不算技能内容', async () => {
    const dir = await makeSkillDir({ 'SKILL.md': '# 正文', '.git/config': '[core]' })
    try {
      const r = await resolveLocalPath(dir)
      assert.equal(r.files['.git/config'], undefined)
      assert.equal(r.ignored.some((i) => /版本库/.test(i.reason)), true)
    } finally {
      await cleanup(dir)
    }
  })

  test('★ `~` 会被展开（从界面上复制来的路径常常带它）', async () => {
    // 不展开的话 `~/x` 会被当成相对路径而拒绝，而使用者看着自己的路径
    // 完全想不通"为什么说我不是绝对路径"
    const err = await expectSourceError(() => resolveLocalPath('~/nonexistent-xyz-123'), 'not_found')
    assert.match(err.message, /不存在/)
  })

  test('显式 slug 覆盖派生结果', async () => {
    const dir = await makeSkillDir({ 'SKILL.md': '# 正文' })
    try {
      const r = await resolveLocalPath(dir, { slug: 'my-custom-slug' })
      assert.equal(r.slug, 'my-custom-slug')
    } finally {
      await cleanup(dir)
    }
  })
})

describe('文本判定', () => {
  test('含 NUL 字节 ⇒ 不是文本', () => {
    assert.equal(isProbablyText(Buffer.from([0x61, 0x00, 0x62])), false)
  })

  test('★ 非 UTF-8（比如 GBK）也判为非文本 —— 否则会静默变成乱码', () => {
    // "中文" 的 GBK 编码：解码成 utf8 再编码回来不会一致
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
    assert.equal(isProbablyText(gbk), false)
  })

  test('UTF-8 中文是文本', () => {
    assert.equal(isProbablyText(Buffer.from('中文内容', 'utf8')), true)
  })
})

// ─────────────────────────────────────────────────────────────
// GitHub 链接解析
// ─────────────────────────────────────────────────────────────

describe('GitHub 链接解析', () => {
  test('仓库根 / 目录 / 文件 / Raw 四种形态', () => {
    assert.deepEqual(parseGithubUrl('https://github.com/o/r'), {
      owner: 'o',
      repo: 'r',
      ref: null,
      dir: '',
      file: null,
      form: 'repo',
    })
    assert.deepEqual(parseGithubUrl('https://github.com/o/r/tree/main/skills/foo'), {
      owner: 'o',
      repo: 'r',
      ref: 'main',
      dir: 'skills/foo',
      file: null,
      form: 'tree',
    })
    // blob 指向文件：取它**所在的目录**，这样支持文件也能一起装
    assert.deepEqual(parseGithubUrl('https://github.com/o/r/blob/main/skills/foo/SKILL.md'), {
      owner: 'o',
      repo: 'r',
      ref: 'main',
      dir: 'skills/foo',
      file: 'skills/foo/SKILL.md',
      form: 'blob',
    })
    assert.deepEqual(
      parseGithubUrl('https://raw.githubusercontent.com/o/r/main/skills/foo/SKILL.md'),
      {
        owner: 'o',
        repo: 'r',
        ref: 'main',
        dir: 'skills/foo',
        file: 'skills/foo/SKILL.md',
        form: 'raw',
      },
    )
  })

  test('中文/空格目录名会被解码', () => {
    const t = parseGithubUrl('https://github.com/o/r/tree/main/%E6%8A%80%E8%83%BD')
    assert.equal(t.dir, '技能')
  })

  test('★ http 被拒绝', () => {
    assert.throws(
      () => parseGithubUrl('http://github.com/o/r'),
      (e: SkillSourceError) => e.code === 'unsupported_url',
    )
  })

  test('★ 非白名单主机被拒绝，并引导去用本地路径', () => {
    // 让本地服务去抓任意地址 = 一个对内网的访问跳板。这条守卫是刻意的边界，
    // 不是"还没来得及支持别的站点"。
    const err = (() => {
      try {
        parseGithubUrl('https://evil.example.com/o/r')
      } catch (e) {
        return e as SkillSourceError
      }
      assert.fail('本该拒绝')
    })()
    assert.equal(err.code, 'blocked_host')
    assert.match(err.detail ?? '', /本地目录/)
  })

  test('★ 内网地址同样被拒绝（SSRF 的典型目标）', () => {
    for (const url of [
      'https://127.0.0.1/o/r',
      'https://localhost:8080/o/r',
      'https://169.254.169.254/latest/meta-data',
      'https://api.github.com.evil.com/o/r',
    ]) {
      assert.throws(
        () => parseGithubUrl(url),
        (e: SkillSourceError) => e.code === 'blocked_host',
        url,
      )
    }
  })

  test('不认识的链接形态给出可操作的建议', () => {
    const err = (() => {
      try {
        parseGithubUrl('https://github.com/o/r/issues/1')
      } catch (e) {
        return e as SkillSourceError
      }
      assert.fail('本该拒绝')
    })()
    assert.equal(err.code, 'unsupported_url')
    assert.match(err.detail ?? '', /tree/)
  })

  test('tree 链接缺分支 ⇒ 拒绝', () => {
    assert.throws(
      () => parseGithubUrl('https://github.com/o/r/tree'),
      (e: SkillSourceError) => e.code === 'unsupported_url',
    )
  })
})

// ─────────────────────────────────────────────────────────────
// GitHub 解析（假 fetch）
// ─────────────────────────────────────────────────────────────

describe('来源：GitHub（注入假 fetch，不联网）', () => {
  test('★ tree 链接：SKILL.md 与子目录里的支持文件都装上', async () => {
    const gh = fakeGithub({
      'skills/foo/SKILL.md': '# foo 技能',
      'skills/foo/reference.md': '参考',
      'skills/foo/scripts/run.sh': 'echo hi',
      'skills/bar/SKILL.md': '# 另一个技能',
    })
    try {
      const r = await resolveGithubUrl(
        'https://github.com/o/r/tree/main/skills/foo',
        {},
        { fetchImpl: gh.impl },
      )
      assert.equal(r.body, '# foo 技能')
      assert.equal(r.slug, 'foo')
      assert.equal(r.files['reference.md'], '参考')
      assert.equal(r.files['scripts/run.sh'], 'echo hi')
      // ★ 别的技能不能被顺手装进来
      assert.equal(Object.keys(r.files).some((p) => p.includes('bar')), false)
      assert.equal(r.sourceRef, 'github:o/r@main:skills/foo')
    } finally {
      // 这条用例不需要磁盘（内容全在假 GitHub 里），所以什么都不用清。
      //
      // ⚠️ 这里曾经写过 `cleanup(tmpdir())`——它会递归删掉操作系统的临时目录。
      //    永远不要对 `tmpdir()` 本身做 recursive rm。
      assert.equal(gh.calls.length > 0, true)
    }
  })

  test('★ 目录里没有 SKILL.md ⇒ 拒绝，并列出目录内容', async () => {
    const gh = fakeGithub({ 'skills/foo/README.md': '不是技能' })
    const err = await expectSourceError(
      () => resolveGithubUrl('https://github.com/o/r/tree/main/skills/foo', {}, { fetchImpl: gh.impl }),
      'missing_skill_md',
    )
    assert.match(err.detail ?? '', /README\.md/)
  })

  test('★ 404 ⇒ not_found，并提示可能的原因（含分支名带斜杠）', async () => {
    const gh = fakeGithub({}, { status: 404 })
    const err = await expectSourceError(
      () => resolveGithubUrl('https://github.com/o/r/tree/main/nope', {}, { fetchImpl: gh.impl }),
      'not_found',
    )
    assert.match(err.detail ?? '', /斜杠/)
  })

  test('★ 匿名限额用完 ⇒ 专门的错误码与可操作建议', async () => {
    const gh = fakeGithub({}, {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0' },
    })
    const err = await expectSourceError(
      () => resolveGithubUrl('https://github.com/o/r/tree/main/x', {}, { fetchImpl: gh.impl }),
      'github_rate_limited',
    )
    assert.match(err.detail ?? '', /ALPHA_HELPER_GITHUB_TOKEN/)
  })

  test('★ 跳转到白名单之外 ⇒ 拒绝（白名单不能靠第一跳就完事）', async () => {
    // 这是这组里最要紧的一条：一个 302 就能把"只允许 GitHub"变成一句空话
    const impl = (async (): Promise<Response> =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/payload' },
      })) as typeof fetch
    const err = await expectSourceError(
      () => resolveGithubUrl('https://github.com/o/r/tree/main/x', {}, { fetchImpl: impl }),
      'blocked_host',
    )
    assert.match(err.message, /跳转/)
  })

  test('★ 响应体超过上限 ⇒ 拒绝（不把内存吃光）', async () => {
    const impl = (async (): Promise<Response> =>
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(64 * 1024 * 1024) },
      })) as typeof fetch
    await expectSourceError(
      () => resolveGithubUrl('https://github.com/o/r/tree/main/x', {}, { fetchImpl: impl }),
      'too_large',
    )
  })

  test('★ blob 链接指向的不是 SKILL.md ⇒ 说清它指向了什么', async () => {
    const gh = fakeGithub({ 'skills/foo/reference.md': 'x' })
    const err = await expectSourceError(
      () =>
        resolveGithubUrl(
          'https://github.com/o/r/blob/main/skills/foo/reference.md',
          {},
          { fetchImpl: gh.impl },
        ),
      'unsupported_url',
    )
    assert.match(err.message, /reference\.md/)
  })

  test('★ blob 链接指向 SKILL.md ⇒ 按所在目录解析，支持文件一起装', async () => {
    const gh = fakeGithub({
      'skills/foo/SKILL.md': '# 正文',
      'skills/foo/extra.md': '额外的',
    })
    const r = await resolveGithubUrl(
      'https://github.com/o/r/blob/main/skills/foo/SKILL.md',
      {},
      { fetchImpl: gh.impl },
    )
    assert.equal(r.body, '# 正文')
    assert.equal(r.files['extra.md'], '额外的', 'blob 链接也要能把支持文件带上')
  })

  test('★ Raw 链接同样按所在目录解析（Raw 按钮复制出来的就是它）', async () => {
    const gh = fakeGithub({
      'skills/foo/SKILL.md': '# 正文',
      'skills/foo/extra.md': '额外的',
    })
    const r = await resolveGithubUrl(
      'https://raw.githubusercontent.com/o/r/main/skills/foo/SKILL.md',
      {},
      { fetchImpl: gh.impl },
    )
    assert.equal(r.body, '# 正文')
    assert.equal(r.files['extra.md'], '额外的')
  })

  test('★ 仓库根没有 SKILL.md ⇒ 拒绝', async () => {
    const gh = fakeGithub({ 'README.md': 'x', 'src/a.ts': 'y' })
    const err = await expectSourceError(
      () => resolveGithubUrl('https://github.com/o/r', {}, { fetchImpl: gh.impl }),
      'missing_skill_md',
    )
    assert.match(err.message, /仓库根/)
  })

  test('支持文件里的二进制被明确跳过', async () => {
    // 假 fetch 只能给文本，所以用 NUL 字符模拟二进制内容
    const gh = fakeGithub({
      'skills/foo/SKILL.md': '# 正文',
      'skills/foo/blob.bin': '\u0000binary',
    })
    const r = await resolveGithubUrl(
      'https://github.com/o/r/tree/main/skills/foo',
      {},
      { fetchImpl: gh.impl },
    )
    assert.equal(r.files['blob.bin'], undefined)
    assert.equal(r.ignored.some((i) => /二进制/.test(i.reason)), true)
  })

  test('超过递归深度上限的目录被记下，而不是悄悄漏掉', async () => {
    const gh = fakeGithub({
      'd/SKILL.md': '# 正文',
      'd/a/b/c/d/e/deep.md': '太深了',
    })
    const r = await resolveGithubUrl('https://github.com/o/r/tree/main/d', {}, { fetchImpl: gh.impl })
    assert.equal(r.included.length >= 1, true)
    assert.equal(
      r.ignored.some((i) => /深度/.test(i.reason)),
      true,
      '超深的东西必须出现在"没装什么"里',
    )
  })
})

// ─────────────────────────────────────────────────────────────
// 远端目录条目
// ─────────────────────────────────────────────────────────────

describe('来源：远端目录条目', () => {
  test('★ body 就是 SKILL.md 的内容', () => {
    const r = resolvePayloadEntry({
      slug: 'remote-review',
      body: '# 远端标准',
      sourceRef: 'remote:remote-review@1.0.0',
    })
    assert.equal(r.body, '# 远端标准')
    assert.equal(r.slug, 'remote-review')
    assert.equal(r.sourceRef, 'remote:remote-review@1.0.0')
  })

  test('★ files 里有 SKILL.md 时以它为准（而不是和 body 打架）', () => {
    const r = resolvePayloadEntry({
      slug: 'x',
      body: '旧的正文',
      files: { 'SKILL.md': '# 文件里的正文', 'a.md': 'A' },
      sourceRef: 'remote:x@1',
    })
    assert.equal(r.body, '# 文件里的正文')
    assert.equal(r.files['a.md'], 'A')
    assert.equal(r.files['SKILL.md'], undefined, 'SKILL.md 不该同时出现在支持文件里')
  })

  test('★ body 与 files 都没有 SKILL.md ⇒ 拒绝', () => {
    assert.throws(
      () => resolvePayloadEntry({ slug: 'x', body: '   ', sourceRef: 'remote:x@1' }),
      (e: SkillSourceError) => e.code === 'missing_skill_md',
    )
  })

  test('★ 支持文件路径不许跑出技能目录', () => {
    assert.throws(
      () =>
        resolvePayloadEntry({
          slug: 'x',
          body: '# 正文',
          files: { '../../etc/passwd': '坏东西' },
          sourceRef: 'remote:x@1',
        }),
      (e: SkillSourceError) => e.code === 'bad_input',
    )
  })

  test('★ 远端给的 slug 不合法 ⇒ 拒绝（它是磁盘目录名）', () => {
    assert.throws(
      () => resolvePayloadEntry({ slug: '技能 名称', body: '# 正文', sourceRef: 'remote:x@1' }),
      (e: SkillSourceError) => e.code === 'bad_slug',
    )
  })
})

// ─────────────────────────────────────────────────────────────
// 统一入口
// ─────────────────────────────────────────────────────────────

describe('统一入口', () => {
  test('三种来源都能通过同一个入口解析', async () => {
    const dir = await makeSkillDir({ 'SKILL.md': '# 本地' })
    const gh = fakeGithub({ 'd/SKILL.md': '# 远端仓库' })
    try {
      const fromPath = await resolveSkillSource({ kind: 'path', path: dir })
      assert.equal(fromPath.body, '# 本地')

      const fromUrl = await resolveSkillSource(
        { kind: 'url', url: 'https://github.com/o/r/tree/main/d' },
        {},
        { fetchImpl: gh.impl },
      )
      assert.equal(fromUrl.body, '# 远端仓库')

      const fromPayload = await resolveSkillSource({
        kind: 'payload',
        slug: 'p',
        body: '# 远端目录',
        sourceRef: 'remote:p@1',
      })
      assert.equal(fromPayload.body, '# 远端目录')
    } finally {
      await cleanup(dir)
    }
  })
})
