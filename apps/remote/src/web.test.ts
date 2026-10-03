import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { cleanup, makeTempDir } from './testing/tmp.ts'
import { RemoteService } from './server.ts'

/**
 * 远端管理页（技能 / 工具目录，2026-10）：**静态托管 + 同步端点**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一组测试守什么
 * ══════════════════════════════════════════════════════════════════
 *
 * 新加的这块有两条**安全性质**，两条都容易写漏、也都不报错：
 *
 *   1. **静态文件不许穿出目录**：`resolve` 之后必须仍在页面目录里。裸拼路径
 *      或只做字符串前缀比较（`/a/bc` 会被判成在 `/a/b` 内）都会漏，而漏了的
 *      后果是"读本机任意文件"。
 *   2. **跨源页面不许触发同步**：浏览器对 `text/plain` 那种"简单请求"**不做
 *      预检**，所以光靠 CORS 拦不住"恶意页面发一个 POST"。这里必须显式看 Origin。
 *
 * 另有一条**诚实性质**：同步的失败原因要如实出现在状态里（`tail` + 退出码），
 * 而不是一句"同步失败"——那正是这个仓库反复在防的那种"看起来像成功/像坏了但
 * 说不出为什么"的界面。
 *
 * ⚠️ 全部不联网、不真抓（NFR-T-01）：同步工具用一个**临时假脚本**顶替
 *   （它只打印几行、按参数决定退出码）。
 */

let webDir: string
let toolPath: string
let dataDir: string

/** 假同步工具：把 argv 打出来、按第一参决定退出码；`sleep:<ms>` 用来制造"正在跑"。 */
const FAKE_TOOL = `
const args = process.argv.slice(2)
console.log('同步开始 argv=' + JSON.stringify(args))
if (process.env['FAKE_TOOL_SLEEP']) {
  await new Promise((r) => setTimeout(r, Number(process.env['FAKE_TOOL_SLEEP'])))
}
if (args.includes('--fail')) {
  console.error('✗ 第 1 条：故意失败')
  process.exit(1)
}
console.log('✓ done')
`

before(async () => {
  webDir = await makeTempDir('remote-web')
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>remote</title><div id="app">REMOTE-WEB</div>')
  await mkdir(join(webDir, 'assets'), { recursive: true })
  await writeFile(join(webDir, 'assets', 'app.js'), 'console.log(1)\n')

  toolPath = join(await makeTempDir('remote-tool'), 'fake-tool.mjs')
  await writeFile(toolPath, FAKE_TOOL, 'utf8')

  dataDir = await makeTempDir('remote-web-data')
})

after(async () => {
  await cleanup(webDir)
  await cleanup(dataDir)
})

async function withService<T>(
  fn: (svc: RemoteService, base: string, dataDir: string) => Promise<T>,
  options: {
    syncTool?: string | null
    webDir?: string | null
    fetchImpl?: typeof fetch
  } = {},
): Promise<T> {
  const dir = await makeTempDir('remote-web-svc')
  const svc = new RemoteService({
    port: 0,
    dataDir: dir,
    webDir: options.webDir === undefined ? webDir : options.webDir,
    syncTool: options.syncTool === undefined ? toolPath : options.syncTool,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  const port = await svc.start()
  try {
    return await fn(svc, `http://127.0.0.1:${port}`, dir)
  } finally {
    await svc.close()
    await cleanup(dir)
  }
}

describe('远端管理页：静态托管', () => {
  test('★ 根路径回管理页（同一份 index.html），带对 content-type', async () => {
    await withService(async (_svc, base) => {
      const res = await fetch(`${base}/`)
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /text\/html/)
      assert.match(await res.text(), /REMOTE-WEB/)
    })
  })

  test('★ 静态资源按扩展名给类型（js/css 长缓存、入口不缓存）', async () => {
    await withService(async (_svc, base) => {
      const js = await fetch(`${base}/assets/app.js`)
      assert.equal(js.status, 200)
      assert.match(js.headers.get('content-type') ?? '', /javascript/)
      assert.match(js.headers.get('cache-control') ?? '', /immutable/, '带哈希的资源该长缓存')

      const index = await fetch(`${base}/`)
      assert.match(index.headers.get('cache-control') ?? '', /no-cache/, '入口不许缓存')
    })
  })

  test('★★ 穿越不出去：`..` 与编码过的 `%2e%2e` 都读不到目录外的文件', async () => {
    await withService(async (_svc, base) => {
      for (const path of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/assets/../../etc/passwd']) {
        const body = await (await fetch(`${base}${path}`)).text()
        assert.doesNotMatch(body, /root:/, `${path} 读到了目录外的文件`)
        assert.match(body, /REMOTE-WEB/, `${path} 应当走 SPA 兜底（回 index.html）`)
      }
    })
  })

  test('★ 未知路径回 index.html（hash 路由的兜底），但 /api/ 下的未知端点仍是 JSON', async () => {
    await withService(async (_svc, base) => {
      const page = await fetch(`${base}/some/deep/route`)
      assert.equal(page.status, 200)
      assert.match(await page.text(), /REMOTE-WEB/)

      // ⚠️ 未知的 `/api/` 端点，**未登录**时回的是 401（既有行为，不是它不存在）——
      //    对未认证的调用者不透露"这个端点存不存在"。所以这条要**先注册拿 token**
      //    再验，否则断言的是另一条分支（第一版就是这么写错的）。
      const creds = JSON.stringify({ email: 'admin@example.com', password: 'password123' })
      const reg = await fetch(`${base}/api/accounts/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: creds,
      })
      assert.equal(reg.status, 201)
      // ⚠️ 注册只回**账号**，token 要从**登录**拿（第一版在这里也写错过）
      const login = await fetch(`${base}/api/accounts/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: creds,
      })
      assert.equal(login.status, 200)
      const { token } = (await login.json()) as { token: string }
      assert.ok(token.length > 0)

      const api = await fetch(`${base}/api/nope`, { headers: { authorization: `Bearer ${token}` } })
      assert.equal(api.status, 404)
      assert.match(api.headers.get('content-type') ?? '', /application\/json/)
    })
  })

  test('★ 产物没构建时说清怎么办，而不是一句 404', async () => {
    const empty = await makeTempDir('remote-web-empty')
    try {
      await withService(
        async (_svc, base) => {
          const res = await fetch(`${base}/`)
          assert.equal(res.status, 500)
          const text = await res.text()
          assert.match(text, /build:remote-web/, '要告诉维护者该跑哪条命令')
          assert.match(text, /api\/catalog/, '以及"急用可以直接打接口"')
        },
        { webDir: empty },
      )
    } finally {
      await cleanup(empty)
    }
  })

  test('★ 明确不托管页面时（webDir=null）回一句人话，不回 HTML', async () => {
    await withService(
      async (_svc, base) => {
        const res = await fetch(`${base}/`)
        assert.equal(res.status, 404)
        assert.match(await res.text(), /没有托管管理页/)
      },
      { webDir: null },
    )
  })
})

describe('远端管理页：重新同步（把独立工具当子进程跑）', () => {
  test('★ 工具不在 ⇒ 状态 unavailable，触发返回 409（按钮据此置灰并说明原因）', async () => {
    await withService(
      async (svc, base) => {
        const status = await (await fetch(`${base}/api/catalog/skills/sync`)).json()
        assert.equal((status as { state: string }).state, 'unavailable')
        assert.equal((await svc.syncStatus()).state, 'unavailable')

        const res = await fetch(`${base}/api/catalog/skills/sync`, { method: 'POST' })
        assert.equal(res.status, 409, '不可用时不该假装开始')
      },
      { syncTool: join(webDir, 'nope.mjs') },
    )
  })

  test('★★ 跑一次成功：状态 idle→ok，输出留在 tail 里，参数带上 --out', async () => {
    await withService(async (svc, base) => {
      const res = await fetch(`${base}/api/catalog/skills/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(res.status, 202)
      assert.equal(((await res.json()) as { state: string }).state, 'running', 'POST 当即返回 running')

      // 等它跑完（假工具是毫秒级）
      let status = await svc.syncStatus()
      for (let i = 0; i < 50 && status.state === 'running'; i += 1) {
        await new Promise((r) => setTimeout(r, 50))
        status = await svc.syncStatus()
      }
      assert.equal(status.state, 'ok', `tail=${status.tail.join(' | ')}`)
      assert.equal(status.exitCode, 0)
      assert.ok(status.finishedAt !== null)
      // ★ 参数真的传下去了（`--out` 指向这个服务读的那个目录）
      assert.ok(
        status.tail.some((l) => l.includes('--out')),
        `tail 里要看得见参数：${status.tail.join(' | ')}`,
      )
      assert.ok(status.tail.some((l) => l.includes('✓ done')))
      // ★ 清单路径**显式传给工具**（D54）：这样"页面上说的那份"与"真正被抓的那份"
      //   永远是同一个文件，不存在两边各自解析出不同结果的可能
      assert.ok(
        status.tail.some((l) => l.includes('--manifest')),
        `要把清单路径传下去：${status.tail.join(' | ')}`,
      )
    })
  })

  test('★★ 失败**如实**报出来：非零退出 + 输出留着（不许只说一句"同步失败"）', async () => {
    // 用一个"总是失败"的假工具（同一份脚本，加 `--fail` 那种行为由环境变量控制
    // 不便；这里直接写一个只报错的脚本）
    const failing = join(await makeTempDir('remote-tool-fail'), 'fail.mjs')
    await writeFile(failing, "console.error('✗ 第 3 条：匿名次数用完了')\nprocess.exit(2)\n", 'utf8')

    await withService(
      async (svc, base) => {
        await fetch(`${base}/api/catalog/skills/sync`, { method: 'POST' })
        let status = await svc.syncStatus()
        for (let i = 0; i < 50 && status.state === 'running'; i += 1) {
          await new Promise((r) => setTimeout(r, 50))
          status = await svc.syncStatus()
        }
        assert.equal(status.state, 'failed')
        assert.equal(status.exitCode, 2)
        assert.ok(
          status.tail.some((l) => l.includes('匿名次数用完了')),
          `失败原因要在 tail 里：${status.tail.join(' | ')}`,
        )
      },
      { syncTool: failing },
    )
  })

  test('★★ 单飞：正在跑的时候再点一次返回 409，而不是排队跑第二个', async () => {
    const slow = join(await makeTempDir('remote-tool-slow'), 'slow.mjs')
    await writeFile(
      slow,
      "console.log('start')\nawait new Promise((r) => setTimeout(r, 1500))\nconsole.log('done')\n",
      'utf8',
    )

    await withService(
      async (svc, base) => {
        const first = await fetch(`${base}/api/catalog/skills/sync`, { method: 'POST' })
        assert.equal(first.status, 202)

        // 等它真的进入 running
        let status = await svc.syncStatus()
        for (let i = 0; i < 20 && status.state !== 'running'; i += 1) {
          await new Promise((r) => setTimeout(r, 25))
          status = await svc.syncStatus()
        }
        assert.equal(status.state, 'running')

        const second = await fetch(`${base}/api/catalog/skills/sync`, { method: 'POST' })
        assert.equal(second.status, 409, '第二次点击不该再起一个进程')
        assert.equal(((await second.json()) as { state: string }).state, 'running')
      },
      { syncTool: slow },
    )
  })

  test('★★ 跨源页面不许触发同步（Origin 不是回环 ⇒ 403）', async () => {
    await withService(async (_svc, base) => {
      const evil = await fetch(`${base}/api/catalog/skills/sync`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', origin: 'https://evil.example.com' },
        body: '{}',
      })
      assert.equal(evil.status, 403)

      // 回环来源照常（daemon 界面想加个"同步一下"按钮也能用）
      const ok = await fetch(`${base}/api/catalog/skills/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4517' },
        body: '{}',
      })
      assert.equal(ok.status, 202)
    })
  })

  test('★ 环境变量里的加速器会传给工具（服务自己不抓取，只转述配置）', async () => {
    await withService(async (svc, base) => {
      process.env['AGENTDECK_GITHUB_PROXY'] = 'https://gh-proxy.example'
      try {
        await fetch(`${base}/api/catalog/skills/sync`, { method: 'POST' })
        let status = await svc.syncStatus()
        for (let i = 0; i < 50 && status.state === 'running'; i += 1) {
          await new Promise((r) => setTimeout(r, 50))
          status = await svc.syncStatus()
        }
        assert.ok(
          status.tail.some((l) => l.includes('gh-proxy.example')),
          `加速器要传下去：${status.tail.join(' | ')}`,
        )
      } finally {
        delete process.env['AGENTDECK_GITHUB_PROXY']
      }
    })
  })
})

/** 假的 GitHub（按协议假装：contents + raw）——端点测试也用注入的 fetch，绝不联网。 */
function fakeGithub(files: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const contents = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/(.*?)(?:\?|$)/.exec(url)
    if (contents) {
      const dir = contents[1] ?? ''
      const entries = Object.keys(files)
        .filter((p) => (dir === '' ? true : p.startsWith(`${dir}/`)))
        .filter((p) => !(dir === '' ? p : p.slice(dir.length + 1)).includes('/'))
        .map((p) => ({
          name: p.split('/').pop(),
          path: p,
          type: 'file',
          size: Buffer.byteLength(files[p]!, 'utf8'),
          download_url: `https://raw.githubusercontent.com/o/r/main/${p}`,
        }))
      return new Response(JSON.stringify(entries), { status: 200 })
    }
    const raw = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.*)$/.exec(url)
    if (raw) {
      const content = files[raw[1]!]
      return content === undefined ? new Response('no', { status: 404 }) : new Response(content, { status: 200 })
    }
    return new Response('unexpected', { status: 500 })
  }) as typeof fetch
}

const post = (base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/api/catalog/skills/local`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

describe('远端管理页：手动安装 / 卸载技能（本地层，D52）', () => {
  test('★ 相对 `--data-dir` 也要能列出本地装的（取包规则只收绝对路径）', async () => {
    // ⚠️ 这条是一次真踩：`--data-dir .cache/x`（相对）时，本地装的那条**列不出来**
    //   ——`loadCatalogSkills` 里的 `resolveLocalPath` 明确拒绝相对路径，而症状只是
    //   目录里少一条（服务日志里才有一句 warning）。第二次踩同一类坑，所以钉住。
    const fetchImpl = fakeGithub({ 'skills/foo/SKILL.md': '# 正文' })
    const abs = await makeTempDir('remote-rel')
    const rel = relative(process.cwd(), abs)
    const svc = new RemoteService({ port: 0, dataDir: rel, fetchImpl })
    const port = await svc.start()
    try {
      const base = `http://127.0.0.1:${port}`
      assert.equal(
        (await post(base, { url: 'https://github.com/o/r/tree/main/skills/foo' })).status,
        201,
      )
      const catalog = (await (await fetch(`${base}/api/catalog`)).json()) as {
        skills: Array<{ slug: string }>
      }
      assert.deepEqual(
        catalog.skills.map((s) => s.slug),
        ['foo'],
        '相对路径下也要列出来',
      )
    } finally {
      await svc.close()
      await cleanup(abs)
    }
  })

  test('★ 装一条 ⇒ 201，目录里立刻多一条且标着 `local`（与同步来的并列）', async () => {
    const fetchImpl = fakeGithub({
      'skills/foo/SKILL.md': '---\nname: foo\n---\n\n正文',
      'skills/foo/extra.md': '补充',
    })
    await withService(
      async (_svc, base) => {
        const res = await post(base, {
          url: 'https://github.com/o/r/tree/main/skills/foo',
          name: '手动装的',
        })
        assert.equal(res.status, 201, await res.clone().text())
        const body = (await res.json()) as { installed: { slug: string; files: string[] } }
        assert.equal(body.installed.slug, 'foo')
        assert.deepEqual(body.installed.files.sort(), ['SKILL.md', 'extra.md'])

        const catalog = (await (await fetch(`${base}/api/catalog`)).json()) as {
          skills: Array<{ slug: string; source?: string; files: Record<string, string> }>
        }
        const foo = catalog.skills.find((s) => s.slug === 'foo')
        assert.ok(foo, '装完要立刻出现在目录里')
        assert.equal(foo.source, 'local', '来源要标出来（界面据此显示徽标与卸载按钮）')
        assert.equal(foo.files['extra.md'], '补充', '支持文件要一起带上')
      },
      { fetchImpl },
    )
  })

  test('★★ 缺 url ⇒ 400；坏链接 ⇒ 400 且带上取包规则的原话；撞名 ⇒ 409', async () => {
    const fetchImpl = fakeGithub({ 'skills/foo/SKILL.md': '# 正文' })
    await withService(
      async (_svc, base) => {
        const noUrl = await post(base, {})
        assert.equal(noUrl.status, 400)
        assert.match(((await noUrl.json()) as { error: string }).error, /GitHub 链接/)

        const badUrl = await post(base, { url: 'https://gitlab.com/o/r' })
        assert.equal(badUrl.status, 400)
        assert.match(((await badUrl.json()) as { error: string }).error, /GitHub/)

        const url = 'https://github.com/o/r/tree/main/skills/foo'
        assert.equal((await post(base, { url })).status, 201)
        const again = await post(base, { url })
        assert.equal(again.status, 409, '同名要拒绝，不许覆盖')
        assert.match(((await again.json()) as { error: string }).error, /foo/)
      },
      { fetchImpl },
    )
  })

  test('★★ 卸载：本地装的能删；**同步来的会被 409 拒绝并说清该怎么做**', async () => {
    const fetchImpl = fakeGithub({ 'skills/foo/SKILL.md': '# 正文' })
    await withService(
      async (_svc, base, dataDir) => {
        // 先铺一条"同步来的"（模拟同步工具写下的目录）
        const syncedDir = join(dataDir, 'catalog-skills')
        await mkdir(join(syncedDir, 'from-manifest'), { recursive: true })
        await writeFile(join(syncedDir, 'from-manifest', 'SKILL.md'), '# 清单来的', 'utf8')
        await writeFile(
          join(syncedDir, '.sync.json'),
          JSON.stringify({
            schema: 'agentdeck/recommended-skills-sync@1',
            syncedAt: '2026-10-01T00:00:00.000Z',
            items: [{ url: 'https://github.com/o/r/tree/main/skills/x', slug: 'from-manifest', name: '清单来的', category: 'other', origin: 'official', summary: '', fills: null, needs: null, sourceRef: 'github:o/r@main:skills/x', version: null, fetchedAt: '2026-10-01T00:00:00.000Z', files: ['SKILL.md'], excluded: [] }],
          }),
          'utf8',
        )

        // ★ 同步来的**不给删**：要改清单再同步。回 409 并说清路径（不能一句 404 糊过去）
        const refused = await fetch(`${base}/api/catalog/skills/local/from-manifest`, {
          method: 'DELETE',
        })
        assert.equal(refused.status, 409)
        assert.match(((await refused.json()) as { error: string }).error, /推荐清单|重新同步/)
        assert.equal(
          (await fetch(`${base}/api/catalog`).then((r) => r.json()) as { skills: unknown[] }).skills
            .length,
          1,
          '被拒绝 ⇒ 目录里那条还在',
        )

        // 手动装的可以删
        await post(base, { url: 'https://github.com/o/r/tree/main/skills/foo' })
        const gone = await fetch(`${base}/api/catalog/skills/local/foo`, { method: 'DELETE' })
        assert.equal(gone.status, 200)
        const catalog = (await (await fetch(`${base}/api/catalog`)).json()) as { skills: unknown[] }
        assert.equal(catalog.skills.length, 1, '只剩同步来的那条')

        const missing = await fetch(`${base}/api/catalog/skills/local/nope`, { method: 'DELETE' })
        assert.equal(missing.status, 404)
      },
      { fetchImpl },
    )
  })

  test('★★ 跨源页面不许改动目录（非回环 Origin ⇒ 403），本机脚本照常', async () => {
    const fetchImpl = fakeGithub({ 'skills/foo/SKILL.md': '# 正文' })
    await withService(
      async (_svc, base) => {
        const evil = await post(base, { url: 'https://github.com/o/r/tree/main/skills/foo' }, {
          origin: 'https://evil.example.com',
        })
        assert.equal(evil.status, 403)
        const evilDelete = await fetch(`${base}/api/catalog/skills/local/foo`, {
          method: 'DELETE',
          headers: { origin: 'https://evil.example.com' },
        })
        assert.equal(evilDelete.status, 403)

        const local = await post(
          base,
          { url: 'https://github.com/o/r/tree/main/skills/foo' },
          { origin: 'http://127.0.0.1:4517' },
        )
        assert.equal(local.status, 201, '回环来源（daemon 页面）可以用')
      },
      { fetchImpl },
    )
  })
})

describe('远端管理页：清单摘要（D54：默认值转存成配置文件）', () => {
  test('★★ 目录接口带上清单摘要；还没转存时 `exists:false`（合法状态）', async () => {
    const fetchImpl = fakeGithub({ 'skills/foo/SKILL.md': '# 正文' })
    await withService(async (_svc, base, dataDir) => {
      const before = (await (await fetch(`${base}/api/catalog`)).json()) as {
        manifest: { path: string; exists: boolean; count: number; verifiedAt: string | null }
      }
      assert.equal(before.manifest.exists, false, '还没转存就是 false，不是错误')
      assert.equal(before.manifest.count, 0)
      assert.equal(before.manifest.path, join(dataDir, 'recommended-skills.json'), '路径要说清')

      // 写一份"转存后"的清单（工具在第一次跑同步时才会写，这里直接铺）
      await writeFile(
        before.manifest.path,
        JSON.stringify({
          schema: 'agentdeck/recommended-skills@1',
          verifiedAt: '2026-10-05',
          items: [{}, {}, {}],
        }),
        'utf8',
      )

      const after = (await (await fetch(`${base}/api/catalog`)).json()) as {
        manifest: { exists: boolean; count: number; verifiedAt: string | null; error: string | null }
      }
      assert.equal(after.manifest.exists, true)
      assert.equal(after.manifest.count, 3, '页面据此说"要抓的是 3 条"')
      assert.equal(after.manifest.verifiedAt, '2026-10-05')
      assert.equal(after.manifest.error, null)
    }, { fetchImpl })
  })

  test('★ 清单读不了 ⇒ 如实报（不假装 0 条就算了）', async () => {
    const fetchImpl = fakeGithub({ 'skills/foo/SKILL.md': '# 正文' })
    await withService(async (_svc, base, dataDir) => {
      await writeFile(join(dataDir, 'recommended-skills.json'), '{ 坏掉的 JSON', 'utf8')
      const body = (await (await fetch(`${base}/api/catalog`)).json()) as {
        manifest: { exists: boolean; error: string | null }
      }
      assert.equal(body.manifest.exists, true)
      assert.ok(body.manifest.error !== null, '要带上读不了的原因')
    }, { fetchImpl })
  })
})
