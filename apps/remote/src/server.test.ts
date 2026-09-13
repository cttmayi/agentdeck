import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { test } from 'node:test'
import { join } from 'node:path'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { RemoteService, isLoopbackOrigin } from './server.ts'
import { loadPlugins } from './plugins.ts'

/**
 * 这些测试打的是**协议与语义**，不是实现细节：
 * 401 与 400 的区别、第三方查询不落盘、插件失败隔离。
 */

let service: RemoteService
let base: string
let dir: string

async function call(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const { token, ...rest } = init
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((rest.headers as Record<string, string> | undefined) ?? {}),
  }
  if (token) headers['authorization'] = `Bearer ${token}`
  const res = await fetch(`${base}${path}`, { ...rest, headers })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

describe('远端服务（M3）', () => {
  before(async () => {
    dir = await makeTempDir('alpha-remote')
    service = new RemoteService({ port: 0, dataDir: dir })
    service.loadPluginManifests([
      {
        manifest: {
          apiVersion: 1,
          name: 'acme-sso',
          capability: 'login',
          version: '1.0.0',
          scopes: ['account:identify'],
        },
        impl: {},
      },
      {
        manifest: {
          apiVersion: 1,
          name: 'weather',
          capability: 'third-party',
          version: '1.0.0',
          scopes: ['thirdparty:query'],
        },
        impl: {
          query: async (params: Record<string, unknown>) => ({
            city: params['city'],
            tempC: 21,
          }),
        },
      },
      {
        manifest: {
          apiVersion: 1,
          name: 'broken-login',
          capability: 'login',
          version: '1.0.0',
          scopes: ['fs:write'],
        },
        impl: {},
      },
    ])
    const port = await service.start()
    base = `http://127.0.0.1:${port}`
  })

  after(async () => {
    await service.close()
    await cleanup(dir)
  })

  it('健康检查不需要登录', async () => {
    const { status, body } = await call('/api/health')
    assert.equal(status, 200)
    assert.deepEqual(body, { ok: true, apiVersion: 1 })
  })

  it('未登录访问受保护端点返回 401 且带 unauthenticated 码', async () => {
    const { status, body } = await call('/api/me')
    assert.equal(status, 401)
    assert.equal((body as { code: string }).code, 'unauthenticated')
  })

  it('注册 → 登录 → 取自身信息', async () => {
    const reg = await call('/api/accounts/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@example.com', password: 'hunter2hunter2' }),
    })
    assert.equal(reg.status, 201)
    assert.equal((reg.body as { email: string }).email, 'a@example.com')

    const login = await call('/api/accounts/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@example.com', password: 'hunter2hunter2' }),
    })
    assert.equal(login.status, 200)
    const token = (login.body as { token: string }).token
    assert.ok(token.length > 20)

    const me = await call('/api/me', { token })
    assert.equal(me.status, 200)
    assert.equal((me.body as { account: { email: string } }).account.email, 'a@example.com')
  })

  it('口令错误返回 401，且提示不区分"邮箱不存在"与"口令错误"', async () => {
    const wrongPass = await call('/api/accounts/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@example.com', password: 'wrongwrongwrong' }),
    })
    const noSuchUser = await call('/api/accounts/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrongwrongwrong' }),
    })
    assert.equal(wrongPass.status, 401)
    assert.equal(noSuchUser.status, 401)
    assert.equal(
      (wrongPass.body as { error: string }).error,
      (noSuchUser.body as { error: string }).error,
    )
  })

  it('口令过短被拒绝', async () => {
    const { status } = await call('/api/accounts/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'b@example.com', password: 'short' }),
    })
    assert.equal(status, 400)
  })

  it('非法 token 返回 401 而不是 500', async () => {
    const { status } = await call('/api/me', { token: 'deadbeef' })
    assert.equal(status, 401)
  })

  it('目录公开可用，且内置口令登录与插件登录方式同时列出', async () => {
    const { status, body } = await call('/api/catalog')
    assert.equal(status, 200)
    const b = body as {
      skills: { slug: string }[]
      tools: { name: string }[]
      loginMethods: { name: string }[]
    }
    assert.deepEqual(
      b.skills.map((s) => s.slug),
      ['general-review'],
    )
    assert.ok(b.tools.some((t) => t.name === 'report.get'))

    const names = b.loginMethods.map((m) => m.name)
    assert.ok(names.includes('password'), '内置口令登录必须始终可用')
    assert.ok(names.includes('acme-sso'), '启用的 login 插件应出现在登录方式里')
    assert.ok(!names.includes('broken-login'), '被拒绝的插件不能出现在登录方式里')
  })

  it('插件加载失败隔离：坏插件不影响口令登录', async () => {
    const login = await call('/api/accounts/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@example.com', password: 'hunter2hunter2' }),
    })
    assert.equal(login.status, 200)
    const broken = service.plugins.find((p) => p.manifest.name === 'broken-login')
    assert.equal(broken?.enabled, false)
    assert.match(broken?.error ?? '', /fs:write/)
  })

  it('用户设定可读可合并写', async () => {
    const login = await call('/api/accounts/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@example.com', password: 'hunter2hunter2' }),
    })
    const token = (login.body as { token: string }).token

    assert.deepEqual((await call('/api/settings', { token })).body, {})

    await call('/api/settings', {
      method: 'PUT',
      token,
      body: JSON.stringify({ theme: 'dark' }),
    })
    const merged = await call('/api/settings', {
      method: 'PUT',
      token,
      body: JSON.stringify({ locale: 'zh-CN' }),
    })
    // 合并而非覆盖——页面可能只提交改动的字段。
    assert.deepEqual(merged.body, { theme: 'dark', locale: 'zh-CN' })
  })

  it('第三方查询经插件转发', async () => {
    const login = await call('/api/accounts/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@example.com', password: 'hunter2hunter2' }),
    })
    const token = (login.body as { token: string }).token
    const { status, body } = await call('/api/third-party/query', {
      method: 'POST',
      token,
      body: JSON.stringify({ plugin: 'weather', params: { city: '上海' } }),
    })
    assert.equal(status, 200)
    assert.deepEqual(body, { city: '上海', tempC: 21 })
  })

  it('查询未启用的插件是明确错误，不是空结果', async () => {
    const login = await call('/api/accounts/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@example.com', password: 'hunter2hunter2' }),
    })
    const token = (login.body as { token: string }).token
    const { status, body } = await call('/api/third-party/query', {
      method: 'POST',
      token,
      body: JSON.stringify({ plugin: 'nope', params: {} }),
    })
    assert.equal(status, 400)
    assert.match((body as { error: string }).error, /nope/)
  })

  it('记录接收只存摘要，统计按账号隔离', async () => {
    const login = await call('/api/accounts/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@example.com', password: 'hunter2hunter2' }),
    })
    const token = (login.body as { token: string }).token

    const accepted = await call('/api/records', {
      method: 'POST',
      token,
      body: JSON.stringify({
        records: [
          { kind: 'verdict', digest: 'd1', conclusion: 'pass', occurredAt: '2024-01-01T00:00:00.000Z' },
          { kind: 'verdict', digest: 'd2', conclusion: 'fail', occurredAt: '2024-01-02T00:00:00.000Z' },
          { kind: 'action', digest: 'd3', actionType: 'issue.update_status', occurredAt: '2024-01-03T00:00:00.000Z' },
        ],
      }),
    })
    assert.equal(accepted.status, 202)
    assert.deepEqual(accepted.body, { accepted: 3 })

    const stats = await call('/api/stats', { token })
    const s = stats.body as {
      total: number
      byKind: Record<string, number>
      byConclusion: Record<string, number>
      byActionType: Record<string, number>
    }
    assert.equal(s.total, 3)
    assert.deepEqual(s.byKind, { verdict: 2, action: 1 })
    assert.deepEqual(s.byConclusion, { pass: 1, fail: 1 })
    assert.deepEqual(s.byActionType, { 'issue.update_status': 1 })
  })

  it('重启后账号、token 与设定都还在（持久化不丢）', async () => {
    const reopened = new RemoteService({ port: 0, dataDir: dir })
    const port = await reopened.start()
    try {
      const login = await fetch(`http://127.0.0.1:${port}/api/accounts/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@example.com', password: 'hunter2hunter2' }),
      })
      assert.equal(login.status, 200)
      const { token } = (await login.json()) as { token: string }

      const settings = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        headers: { authorization: `Bearer ${token}` },
      })
      assert.deepEqual(await settings.json(), { theme: 'dark', locale: 'zh-CN' })
    } finally {
      await reopened.close()
    }
  })

  it('未知端点是 404 而不是静默成功', async () => {
    const login = await call('/api/accounts/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@example.com', password: 'hunter2hunter2' }),
    })
    const token = (login.body as { token: string }).token
    const { status, body } = await call('/api/nope', { token })
    assert.equal(status, 404)
    assert.match((body as { error: string }).error, /nope/)
  })

  it('未登录访问未知端点返回 401 —— 认证门在前，不泄露端点是否存在', async () => {
    const { status } = await call('/api/nope')
    assert.equal(status, 401)
  })
})

describe('远端服务：第三方查询不留存（D-远端无状态）', () => {
  it('同一个查询调用两次都会真的打到插件，不做缓存', async () => {
    let calls = 0
    const svc = new RemoteService({
      port: 0,
      plugins: loadPlugins([
        {
          manifest: {
            apiVersion: 1,
            name: 'counter',
            capability: 'third-party',
            version: '1.0.0',
            scopes: ['thirdparty:query'],
          },
          impl: {
            query: async () => {
              calls += 1
              return { calls }
            },
          },
        },
      ]),
    })
    const port = await svc.start()
    try {
      const first = await svc.queryThirdParty('counter', {})
      const second = await svc.queryThirdParty('counter', {})
      assert.deepEqual(first, { calls: 1 })
      assert.deepEqual(second, { calls: 2 })
      assert.equal(calls, 2)
      assert.ok(port > 0)
    } finally {
      await svc.close()
    }
  })
})

describe('回环来源判定（M3：远端是全链路里唯一需要 CORS 的一环）', () => {
  it('放行回环来源——发起方是跑在本机浏览器里的页面', () => {
    for (const origin of [
      'http://127.0.0.1:4517',
      'http://localhost:4517',
      'http://127.0.0.1:8080',
      'https://localhost:443',
      'http://[::1]:4517',
    ]) {
      assert.equal(isLoopbackOrigin(origin), true, origin)
    }
  })

  it('★ 拒绝公网来源——否则任何网页都能拿着用户的 token 打远端', () => {
    for (const origin of [
      'https://evil.example.com',
      'http://127.0.0.1.evil.com', // 前缀伪装：hostname 不是 127.0.0.1
      'http://localhost.evil.com',
      'https://example.com/?x=http://127.0.0.1',
      'file://',
      'null',
      '',
    ]) {
      assert.equal(isLoopbackOrigin(origin), false, origin)
    }
  })

  it('缺失或畸形的 Origin 一律不放行，且不抛异常', () => {
    assert.equal(isLoopbackOrigin(undefined), false)
    assert.equal(isLoopbackOrigin('not a url'), false)
    assert.equal(isLoopbackOrigin('ftp://127.0.0.1'), false)
  })
})

describe('远端服务：预检与 CORS 头（带 Authorization 的跨源请求必经此路）', () => {
  let svc: RemoteService
  let origin: string

  before(async () => {
    svc = new RemoteService({ port: 0 })
    const port = await svc.start()
    origin = `http://127.0.0.1:${port}`
  })

  after(async () => {
    await svc.close()
  })

  it('★ 回环来源的预检被正确应答，否则带 token 的请求在浏览器里根本发不出去', async () => {
    const res = await fetch(`${origin}/api/me`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://127.0.0.1:4517',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4517')
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /authorization/)
  })

  it('★ 公网来源拿不到 CORS 头——浏览器会据此拦下真正的请求', async () => {
    const res = await fetch(`${origin}/api/health`, {
      headers: { origin: 'https://evil.example.com' },
    })
    assert.equal(res.headers.get('access-control-allow-origin'), null)
  })

  it('无 Origin 的同机调用（curl、测试）照常工作', async () => {
    const res = await fetch(`${origin}/api/health`)
    assert.equal(res.status, 200)
  })
})

describe('★ 插件清单必须如实（FR-PLUGIN-10）', () => {
  test('★ 加载失败的插件不能显示成"已启用"——清单是排查问题的唯一入口', async () => {
    const svc = new RemoteService({ port: 0 })
    // 这是**加载器**给出的结果：manifest 合法，但代码求值失败了。
    // 早先这里会把 report.plugins 折成 {manifest, impl} 再喂给 loadPluginManifests，
    // 而后者重新校验 manifest、看不到加载器的失败 ⇒ 显示成 enabled: true。
    // 实测就是这样：一个 entry 越界的插件在清单里是"已启用"。
    svc.setPlugins([
      {
        manifest: {
          apiVersion: 1,
          name: 'broken',
          capability: 'third-party',
          version: '1.0.0',
          scopes: ['thirdparty:query'],
        },
        enabled: false,
        error: 'entry 越出了插件目录：../../etc/hosts',
        impl: null,
      },
      {
        manifest: {
          apiVersion: 1,
          name: 'fine',
          capability: 'third-party',
          version: '1.0.0',
          scopes: ['thirdparty:query'],
        },
        enabled: true,
        error: null,
        impl: { query: async () => ({ ok: true }) },
      },
    ])

    const port = await svc.start()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/me`, {
        headers: { authorization: 'Bearer nope' },
      })
      // 未登录也拿不到清单——这里换成直接检查服务内部状态，
      // 因为清单端点在认证门之后，不适合为了断言而放宽认证。
      assert.equal(res.status, 401)

      const plugins = svc.plugins
      const broken = plugins.find((p) => p.manifest.name === 'broken')
      assert.equal(broken?.enabled, false, '坏插件不能显示成已启用')
      assert.match(broken?.error ?? '', /越出/)

      const fine = plugins.find((p) => p.manifest.name === 'fine')
      assert.equal(fine?.enabled, true)
    } finally {
      await svc.close()
    }
  })

  test('被拒绝的第三方插件查询是明确错误，不是空结果', async () => {
    const svc = new RemoteService({ port: 0 })
    svc.setPlugins([
      {
        manifest: {
          apiVersion: 1,
          name: 'broken',
          capability: 'third-party',
          version: '1.0.0',
          scopes: ['thirdparty:query'],
        },
        enabled: false,
        error: '坏了',
        impl: { query: async () => ({ should: 'not run' }) },
      },
    ])
    // 错误措辞改进了：从这里只报"没有可用的第三方插件"，改成**点名 + 带原因**。
    // 笼统的一句会让人以为插件没装，而实际是它坏了——下一步动作完全不同。
    await assert.rejects(
      () => svc.queryThirdParty('broken', {}),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        assert.match(message, /broken/, '要点名是哪个插件')
        assert.match(message, /坏了/, '要带出**失败原因**，否则不知道该去查什么')
        return true
      },
    )
  })
})

describe('★ 插件停用必须真的生效（FR-PLUGIN-09）', () => {
  /** 造一个"真能查"的第三方插件。 */
  async function serviceWithEcho(dir: string | null) {
    const svc = new RemoteService({ port: 0, dataDir: dir })
    svc.setPlugins([
      {
        manifest: {
          apiVersion: 1,
          name: 'echo',
          capability: 'third-party',
          version: '1.0.0',
          scopes: ['thirdparty:query'],
        },
        enabled: true,
        error: null,
        impl: { query: async () => ({ from: 'echo-plugin' }) },
      },
    ] as never)
    return svc
  }

  test('★ 停用之后查询必须被挡住 —— 只改显示字段是最容易犯的错', async () => {
    const svc = await serviceWithEcho(null)

    // 停用之前能用
    assert.deepEqual(await svc.queryThirdParty('echo', {}), { from: 'echo-plugin' })

    await svc.pluginStore.setEnabled('echo', false)

    // ★ 界面显示"已停用"而查询照旧走那个插件，是这类需求最典型的失败形态：
    //   使用者以为自己关掉了它，实际上没有。
    await assert.rejects(
      () => svc.queryThirdParty('echo', {}),
      /已被停用/,
      '停用必须在**调用路径**上生效，不能只是一个显示字段',
    )

    // 重新启用后恢复
    await svc.pluginStore.setEnabled('echo', true)
    assert.deepEqual(await svc.queryThirdParty('echo', {}), { from: 'echo-plugin' })
  })

  test('★ 清单里"加载成功"与"使用者启用"是两个字段，不能混成一个布尔', async () => {
    const svc = await serviceWithEcho(null)
    await svc.pluginStore.setEnabled('echo', false)

    const [entry] = await svc.pluginInventory()
    assert.equal(entry?.loaded, true, '代码加载是成功的')
    assert.equal(entry?.enabled, false, '但使用者把它停用了')
    // 混成一个布尔就分不清"加载失败"和"加载成功但被关掉"——
    // 而这两件事的下一步动作完全不同。
  })

  test('★ 清单只列出密钥的**键名**，绝不回值', async () => {
    const svc = await serviceWithEcho(null)
    await svc.pluginStore.setSecret('echo', 'apiKey', 'super-secret')

    const [entry] = await svc.pluginInventory()
    assert.deepEqual(entry?.secretKeys, ['apiKey'])
    assert.ok(
      !JSON.stringify(entry).includes('super-secret'),
      '清单是页面要渲染的东西，密钥绝不能出现在里面',
    )
  })

  test('停用一个插件不影响其他插件', async () => {
    const svc = new RemoteService({ port: 0 })
    svc.setPlugins([
      {
        manifest: { apiVersion: 1, name: 'a', capability: 'third-party', version: '1.0.0', scopes: [] },
        enabled: true,
        error: null,
        impl: { query: async () => ({ which: 'a' }) },
      },
      {
        manifest: { apiVersion: 1, name: 'b', capability: 'third-party', version: '1.0.0', scopes: [] },
        enabled: true,
        error: null,
        impl: { query: async () => ({ which: 'b' }) },
      },
    ] as never)

    await svc.pluginStore.setEnabled('a', false)
    await assert.rejects(() => svc.queryThirdParty('a', {}), /已被停用/)
    assert.deepEqual(await svc.queryThirdParty('b', {}), { which: 'b' })
  })

  test('查询一个加载失败的插件，错误里要带出**失败原因**，不是笼统的"没有可用插件"', async () => {
    const svc = new RemoteService({ port: 0 })
    svc.setPlugins([
      {
        manifest: { apiVersion: 1, name: 'broken', capability: 'third-party', version: '1.0.0', scopes: [] },
        enabled: false,
        error: 'entry 越出了插件目录',
        impl: null,
      },
    ] as never)
    await assert.rejects(() => svc.queryThirdParty('broken', {}), /entry 越出了插件目录/)
  })
})
