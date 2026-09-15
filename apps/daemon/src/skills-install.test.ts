import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * skill 安装与同名冲突（FR-AGENT-09/10/11）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里防的是"下载顺手覆盖了你自己的东西"
 * ══════════════════════════════════════════════════════════════════
 *
 * FR-AGENT-10 说"远端下载来的 skill 与使用者自有 skill 并存可用；**本地内容
 * 不因远端变化而改变**"，FR-AGENT-11 说"同名冲突必须有**确定的优先级与明确
 * 提示**，不得静默覆盖使用者的本地内容"。
 *
 * 而原来的实现有两个真问题：
 *
 * **① `source` 被写死成 `'local'`。** 下载来的 skill 被记成"使用者自有的"，
 *    于是"本地内容不因远端变化而改变"这条保证**在数据上无从判断**——
 *    根本分不清谁是谁。
 *
 * **② 没有任何同名处理。** `insertSkill` 按 **id** 写入，所以两个 slug 相同、
 *    id 不同的 skill 会**同时存在**——同名冲突不是"被覆盖"，而是
 *    "悄悄多出一条"，而加载时只会取到其中一条。两种结果都不对，且都没有提示。
 */

async function withDaemon<T>(
  fn: (url: string) => Promise<T>,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const dir = await makeTempDir('skills-install')
  const d = await startDaemon({
    dataDir: dir,
    port: 0,
    fsync: false,
    // 工作目录也要显式给：兜底虽然不会碰家目录，但显式给更清楚
    workRoot: join(dir, 'work'),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    backend: {
      key: 'claude',
      protocol: 'stream-json',
      rejectDetectable: true,
      async probe() {
        return { available: false, command: 'claude', cliVersion: null }
      },
      async execute() {
        throw new Error('这个测试不该执行任何 run')
      },
    } as never,
    onWarn: () => {},
    onInfo: () => {},
  })
  try {
    return await fn(d.url)
  } finally {
    await d.close()
    await cleanup(dir)
  }
}

async function install(url: string, body: unknown) {
  const res = await fetch(`${url}/api/skills`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function listSkills(url: string) {
  const res = await fetch(`${url}/api/skills`)
  return ((await res.json()) as {
    skills: Array<{ slug: string; source: string; id: string; body: string }>
  }).skills
}

describe('★ skill 安装：来源要如实（FR-AGENT-10）', () => {
  test('★ 默认记成 remote —— 下载来的不能冒充"使用者自有的"', async () => {
    await withDaemon(async (url) => {
      const res = await install(url, {
        skills: [{ slug: 'from-catalog', name: '目录里的', body: '标准', allowedActions: ['comment.create'] }],
        batchId: 'b1',
      })
      assert.equal(res.status, 201)
      const skills = await listSkills(url)
      const found = skills.find((s) => s.slug === 'from-catalog')
      assert.ok(found)
      assert.equal(
        found.source,
        'remote',
        '★ 写死成 local 的话，"本地内容不因远端变化而改变"就无从判断了',
      )
    })
  })

  test('显式声明为 local 时如实记 local', async () => {
    await withDaemon(async (url) => {
      await install(url, {
        skills: [{ slug: 'mine', name: '我自己写的', body: 'x', source: 'local' }],
        batchId: 'b1',
      })
      assert.equal((await listSkills(url)).find((s) => s.slug === 'mine')?.source, 'local')
    })
  })
})

describe('★ 同名冲突：确定的优先级 + 明确提示，绝不静默（FR-AGENT-11）', () => {
  test('★ 同名一律拒绝写入，并在 skipped 里说清与谁冲突', async () => {
    await withDaemon(async (url) => {
      await install(url, {
        skills: [{ slug: 'dup', name: '第一次', body: 'A', source: 'local' }],
        batchId: 'b1',
      })
      const second = await install(url, {
        skills: [{ slug: 'dup', name: '第二次', body: 'B' }],
        batchId: 'b2',
      })

      const skipped = second.body['skipped'] as Array<{ slug: string; reason: string; existingSource: string }>
      assert.equal(skipped.length, 1)
      assert.equal(skipped[0]?.slug, 'dup')
      assert.equal(skipped[0]?.existingSource, 'local', '要告诉调用方冲突对方**是哪来的**')
      assert.match(skipped[0]?.reason ?? '', /同名|冲突/)
      assert.match(skipped[0]?.reason ?? '', /overwrite/, '要给出可行动的做法')

      // ★ 原有内容**一字未动**
      const skills = await listSkills(url)
      const dup = skills.filter((s) => s.slug === 'dup')
      assert.equal(dup.length, 1, '★ 不能"悄悄多出一条同名"——那正是旧实现的行为')
      assert.equal(dup[0]?.source, 'local', '★ 使用者自己的东西没被远端覆盖')
    })
  })

  test('显式 overwrite 才替换，且**复用原 id**（不留孤儿记录）', async () => {
    await withDaemon(async (url) => {
      await install(url, { skills: [{ slug: 'r', name: '旧', body: 'A' }], batchId: 'b1' })
      const before = (await listSkills(url)).find((s) => s.slug === 'r')
      const second = await install(url, {
        skills: [{ slug: 'r', name: '新', body: 'B' }],
        batchId: 'b2',
        overwrite: true,
      })
      assert.deepEqual(second.body['skipped'], [])
      const after = await listSkills(url)
      const items = after.filter((s) => s.slug === 'r')
      assert.equal(items.length, 1)
      assert.equal(items[0]?.id, before?.id, '复用原 id：否则会留下一条永远没人引用的孤儿')
    })
  })

  test('★ 批次内的同名也只落一条（同一批里重复更隐蔽）', async () => {
    await withDaemon(async (url) => {
      const res = await install(url, {
        skills: [
          { slug: 'same', name: 'A', body: 'x' },
          { slug: 'same', name: 'B', body: 'y' },
        ],
        batchId: 'b1',
      })
      assert.equal((res.body['installed'] as unknown[]).length, 1)
      assert.equal((res.body['skipped'] as unknown[]).length, 1)
      assert.equal((await listSkills(url)).filter((s) => s.slug === 'same').length, 1)
    })
  })

  test('slug 为空时拒绝并说明原因（它是 skill 的权威标识）', async () => {
    await withDaemon(async (url) => {
      const res = await install(url, { skills: [{ name: '没有 slug' }], batchId: 'b1' })
      const skipped = res.body['skipped'] as Array<{ reason: string }>
      assert.match(skipped[0]?.reason ?? '', /slug/)
    })
  })

  test('skills 不是数组时是 400，不是静默成功', async () => {
    await withDaemon(async (url) => {
      assert.equal((await install(url, { batchId: 'b1' })).status, 400)
      assert.equal((await install(url, { skills: 'nope', batchId: 'b1' })).status, 400)
    })
  })

  test('部分成功也要分别报告，不能整批算成功', async () => {
    await withDaemon(async (url) => {
      await install(url, { skills: [{ slug: 'exists', name: 'x', body: 'x' }], batchId: 'b0' })
      const res = await install(url, {
        skills: [
          { slug: 'brand-new', name: '新的', body: 'x' },
          { slug: 'exists', name: '撞了', body: 'x' },
        ],
        batchId: 'b1',
      })
      assert.equal((res.body['installed'] as unknown[]).length, 1)
      assert.equal((res.body['skipped'] as unknown[]).length, 1)
    })
  })
})

describe('★ 执行 run 的 skill 解析（一次真实的静默失效）', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 这次静默失效的由来
   * ══════════════════════════════════════════════════════════════════
   *
   * 页面提交执行 run 时硬编码了 `skills: []`，于是**一个 skill 也没注入**，
   * Claude 用的是它自己的默认行为——而"审核标准由 skill 决定"是这个产品的
   * 核心，那条路径等于把它关掉了。
   *
   * 它**没有任何报错**：run 正常跑完、状态 completed，只是做的事不是你要的。
   *
   * 根因不在那一行 `[]`，而在"谁来解析 skill"有两个答案：服务端的
   * `createRunForReviewer` 会调 `loadAgentSkills`，而页面自己拼请求时
   * 没有任何东西提醒它也要这么做。
   *
   * 现在把解析权收归 daemon：**省略 skills 就按 agent 解析**。
   */

  /**
   * 造一个**挂着 skill 的执行者**当夹具。
   *
   * ⚠️ 原来这里挑的是"首启播种的、挂了内置审核模板的那个 agent"——而 D37 之后
   *    审核标准内联在审核者身上，播种的审核者**不再挂 skill**，于是"播种里
   *    找一个挂 skill 的"这条路没了。夹具要自己造，不能依赖播种的行为细节。
   */
  async function bootstrap(url: string): Promise<{ id: string; name: string; skillIds: string[] }> {
    const installed = (await (
      await fetch(`${url}/api/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          skills: [{ slug: 'probe-skill', name: '夹具技能', body: '# 夹具\n\n正文。' }],
        }),
      })
    ).json()) as { installed: Array<{ id: string }> }
    const skillId = installed.installed[0]!.id

    const agent = (await (
      await fetch(`${url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '挂了 skill 的执行者', role: 'executor', skillIds: [skillId] }),
      })
    ).json()) as { id: string; name: string; skillIds: string[] }
    assert.deepEqual(agent.skillIds, [skillId], '夹具 agent 得真的挂着那个 skill')
    return agent
  }

  let lastSubmittedRunId = ''

  async function submitRun(url: string, agentId: string, extra: Record<string, unknown>) {
    const runId = `01M2SKILL${Math.random().toString(36).slice(2, 14).toUpperCase().padEnd(16, '0')}`
    const res = await fetch(`${url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId,
        kind: 'execute',
        agentRef: { id: agentId, name: 'x', instructions: '' },
        subject: { type: 'issue', id: 'i-1' },
        prompt: 'x',
        limits: { maxTurns: null, timeoutMs: null },
        ...extra,
      }),
    })
    lastSubmittedRunId = runId
    return { status: res.status, runId }
  }

  test('★ 省略 skills ⇒ daemon 按 agent 配置解析，而不是一个都不注入', async () => {
    await withDaemon(async (url) => {
      const agent = await bootstrap(url)
      const { status } = await submitRun(url, agent.id, {})
      assert.equal(status, 202)

      // 看 run 记录自己的 skillRefs。
      //
      // ⚠️ 不能看审计：审计是**审核收口**时才写的（判决、动作、审计一起落库），
      //    execute run 根本不产生审计记录。我第一版就写错了地方，测试报的是
      //    "审计里没有 skillRefs"，而真相是"这条 run 没有审计"。
      const run = (await (
        await fetch(`${url}/api/runs/${lastSubmittedRunId}`)
      ).json()) as { skillRefs: unknown[] }
      assert.ok(
        run.skillRefs.length > 0,
        '★ 省略 skills 时必须解析出 agent 配的那些 —— 否则等于用裸模型跑审核',
      )
    })
  })

  test('★ 显式传空数组仍然合法（"这次就是不要 skill"）', async () => {
    await withDaemon(async (url) => {
      const agent = await bootstrap(url)
      const { status } = await submitRun(url, agent.id, { skills: [] })
      assert.equal(status, 202, '显式空数组是一个合法意图，不该被拒')
    })
  })

  test('显式给 skill 时用给的（覆盖 agent 配置）', async () => {
    await withDaemon(async (url) => {
      const agent = await bootstrap(url)
      const { status } = await submitRun(url, agent.id, {
        skills: [
          {
            ref: { id: 'x', slug: 'only-this', source: 'local' },
            slug: 'only-this',
            name: 'only-this',
            body: '标准',
            allowedActions: ['comment.create'],
            files: {},
          },
        ],
      })
      assert.equal(status, 202)
    })
  })
})

// ─────────────────────────────────────────────────────────────
// 从「路径 / GitHub 链接」安装
// ─────────────────────────────────────────────────────────────

async function installFromSource(url: string, body: unknown) {
  const res = await fetch(`${url}/api/skills/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** 建一个技能目录。 */
async function makeSkillDir(files: Record<string, string>): Promise<string> {
  const dir = await makeTempDir('install-src')
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true })
    await writeFile(join(dir, rel), content, 'utf8')
  }
  return dir
}

/** 假 GitHub：只有一条技能，`d/SKILL.md` 与 `d/extra.md`。 */
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
      return content === undefined
        ? new Response('no', { status: 404 })
        : new Response(content, { status: 200 })
    }
    return new Response('unexpected', { status: 500 })
  }) as typeof fetch
}

describe('★ 从路径安装 skill（FR-AGENT-09）', () => {
  test('★ 有 SKILL.md ⇒ 装上，支持文件也落库；来源记成 local', async () => {
    const src = await makeSkillDir({
      'SKILL.md': '# 我的标准',
      'extra.md': '补充材料',
    })
    try {
      await withDaemon(async (url) => {
        const res = await installFromSource(url, { source: { kind: 'path', path: src } })
        assert.equal(res.status, 201)
        const installed = res.body['installed'] as Array<Record<string, unknown>>
        assert.equal(installed.length, 1)
        assert.equal(installed[0]?.['body'], '# 我的标准')
        assert.deepEqual(installed[0]?.['files'], { 'extra.md': '补充材料' })
        assert.equal(
          installed[0]?.['source'],
          'local',
          '★ 从本机目录装的是本地内容，不能记成 remote',
        )
        // 界面要能看到"从哪儿装的、装了什么、什么没装"
        assert.equal(typeof res.body['resolvedFrom'], 'string')
        assert.equal((res.body['included'] as unknown[]).length, 2)

        // 真的进了库
        const listed = await listSkills(url)
        assert.equal(listed.some((s) => s.slug === installed[0]?.['slug']), true)
      })
    } finally {
      await cleanup(src)
    }
  })

  test('★ 没有 SKILL.md ⇒ 400，并且告诉使用者"这个目录里其实有什么"', async () => {
    const src = await makeSkillDir({ 'readme.md': '我不是技能' })
    try {
      await withDaemon(async (url) => {
        const res = await installFromSource(url, { source: { kind: 'path', path: src } })
        assert.equal(res.status, 400, '来源不对是使用者输入问题，不该是 500')
        assert.equal(res.body['code'], 'missing_skill_md')
        assert.match(String(res.body['detail']), /readme\.md/)
      })
    } finally {
      await cleanup(src)
    }
  })

  test('★ 非 GitHub 的链接被拒绝，并引导去用本地路径', async () => {
    await withDaemon(async (url) => {
      const res = await installFromSource(url, {
        source: { kind: 'url', url: 'https://example.com/skill' },
      })
      assert.equal(res.status, 400)
      assert.equal(res.body['code'], 'blocked_host')
    })
  })

  test('★ 与已有同名 skill 冲突 ⇒ 拒绝写入，并说清冲突对方是哪来的', async () => {
    const src = await makeSkillDir({ 'SKILL.md': '# 想顶掉已有的' })
    try {
      await withDaemon(async (url) => {
        // ⚠️ 这里原来用的是"首启播种的那条内置 skill"，而 D38 之后**首启不再播种
        //    skill**（技能库是空的）。冲突这件事本身与"那条是不是内置的"无关，
        //    所以夹具自己造一条——夹具不该依赖播种的行为细节。
        // ⚠️ 显式 `source: 'local'`：批量接口在没给 source 时按 `remote` 记
        //    （它分不清你这是从哪儿来的），而这条用例要断言的正是
        //    "冲突对方是**本地**的那一条"。
        await install(url, {
          skills: [{ slug: 'existing', name: '已有的', body: '# 原始', source: 'local' }],
          batchId: 'b0',
        })

        const res = await installFromSource(url, {
          source: { kind: 'path', path: src },
          slug: 'existing',
        })
        // 201 只在装上时返回；这里应当是"没装上 + 明确原因"
        assert.equal(res.body['installed'] ? (res.body['installed'] as unknown[]).length : 0, 0)
        const skipped = res.body['skipped'] as Array<{ slug: string; existingSource: string; reason: string }>
        assert.equal(skipped[0]?.slug, 'existing')
        assert.equal(skipped[0]?.existingSource, 'local')
        assert.match(skipped[0]?.reason ?? '', /overwrite/)

        // 已有那条**一字未动**
        const listed = await listSkills(url)
        assert.equal(listed.filter((s) => s.slug === 'existing').length, 1)
        assert.equal(listed.find((s) => s.slug === 'existing')?.body, '# 原始')
      })
    } finally {
      await cleanup(src)
    }
  })

  test('★ 显式 overwrite 才替换', async () => {
    const src = await makeSkillDir({ 'SKILL.md': '# 换掉已有的' })
    try {
      await withDaemon(async (url) => {
        await install(url, {
          skills: [{ slug: 'existing', name: '已有的', body: '# 原始' }],
          batchId: 'b0',
        })
        const before = (await listSkills(url)).find((s) => s.slug === 'existing')
        const res = await installFromSource(url, {
          source: { kind: 'path', path: src },
          slug: 'existing',
          overwrite: true,
        })
        assert.equal((res.body['installed'] as unknown[]).length, 1)
        const after = (await listSkills(url)).find((s) => s.slug === 'existing')
        assert.equal(after?.id, before?.id, '复用原 id，不留孤儿')
        assert.equal(after?.body, '# 换掉已有的')
      })
    } finally {
      await cleanup(src)
    }
  })

  test('★ 不认识的动作被拒绝（动作表是闭合的，放过去会让每次都判不合规）', async () => {
    const src = await makeSkillDir({ 'SKILL.md': '# 标准' })
    try {
      await withDaemon(async (url) => {
        const res = await installFromSource(url, {
          source: { kind: 'path', path: src },
          allowedActions: ['comment.create', 'rm -rf everything'],
        })
        assert.equal(res.status, 400)
        assert.match(String(res.body['error']), /不认识的动作/)
      })
    } finally {
      await cleanup(src)
    }
  })

  test('★ 只允许白名单里的动作被写进库', async () => {
    const src = await makeSkillDir({ 'SKILL.md': '# 标准' })
    try {
      await withDaemon(async (url) => {
        const res = await installFromSource(url, {
          source: { kind: 'path', path: src },
          allowedActions: ['issue.add_label'],
        })
        const installed = res.body['installed'] as Array<{ allowedActions: string[] }>
        assert.deepEqual(installed[0]?.allowedActions, ['issue.add_label'])
      })
    } finally {
      await cleanup(src)
    }
  })

  test('source 形状不对 ⇒ 400 且指出是哪个字段', async () => {
    await withDaemon(async (url) => {
      assert.equal((await installFromSource(url, {})).status, 400)
      assert.equal((await installFromSource(url, { source: { kind: 'path' } })).status, 400)
      assert.equal((await installFromSource(url, { source: { kind: '???' } })).status, 400)
      assert.match(
        String((await installFromSource(url, { source: { kind: 'path' } })).body['error']),
        /path/,
      )
    })
  })

  test('★ 从 GitHub 链接安装（注入假 fetch，不联网）', async () => {
    const gh = fakeGithub({
      'skills/foo/SKILL.md': '# 远端技能',
      'skills/foo/extra.md': '远端的补充',
    })
    await withDaemon(
      async (url) => {
        const res = await installFromSource(url, {
          source: { kind: 'url', url: 'https://github.com/o/r/tree/main/skills/foo' },
        })
        assert.equal(res.status, 201)
        const installed = res.body['installed'] as Array<Record<string, unknown>>
        assert.equal(installed[0]?.['slug'], 'foo')
        assert.equal(installed[0]?.['body'], '# 远端技能')
        assert.deepEqual(installed[0]?.['files'], { 'extra.md': '远端的补充' })
        assert.equal(
          installed[0]?.['source'],
          'local',
          '从 GitHub 装进来的是**本地内容**（下载到本地了），不是远端目录那条路',
        )
        assert.match(String(installed[0]?.['sourceRef']), /github:o\/r@main/)
      },
      { fetchImpl: gh },
    )
  })

  test('★ 从远端目录装进来的会记下版本（界面据此判断"已安装/可更新"）', async () => {
    await withDaemon(async (url) => {
      const res = await installFromSource(url, {
        source: {
          kind: 'payload',
          slug: 'remote-thing',
          body: '# 远端的标准',
          version: '2.3.4',
          sourceRef: 'remote:remote-thing@2.3.4',
        },
      })
      assert.equal(res.status, 201)
      const installed = res.body['installed'] as Array<Record<string, unknown>>
      assert.equal(installed[0]?.['version'], '2.3.4', '★ 版本必须落库，否则界面无从比较')
      assert.equal(installed[0]?.['source'], 'remote')

      // 再查一次，确认不是只在响应里带了一下
      const listed = ((await (await fetch(`${url}/api/skills`)).json()) as {
        skills: Array<{ slug: string; version?: string | null }>
      }).skills
      assert.equal(listed.find((s) => s.slug === 'remote-thing')?.version, '2.3.4')
    })
  })

  test('★ 更新：同名新版本 + 显式 overwrite ⇒ 版本真的被换掉', async () => {
    // 界面把「更新」实现成"带 overwrite 的同名安装"。所以这条路径必须真的
    // 换掉版本号——否则按钮点了、界面说"已安装"，而库里还是旧的。
    await withDaemon(async (url) => {
      const first = await installFromSource(url, {
        source: {
          kind: 'payload',
          slug: 'updatable',
          body: '# 第一版',
          version: '1.0.0',
          sourceRef: 'remote:updatable@1.0.0',
        },
      })
      assert.equal(first.status, 201)

      // 不显式确认 ⇒ 拒绝（这条规则不能被"更新"这个说法绕过）
      const refused = await installFromSource(url, {
        source: {
          kind: 'payload',
          slug: 'updatable',
          body: '# 第二版',
          version: '1.1.0',
          sourceRef: 'remote:updatable@1.1.0',
        },
      })
      assert.equal((refused.body['installed'] as unknown[]).length, 0)
      assert.match(
        String((refused.body['skipped'] as Array<{ reason: string }>)[0]?.reason),
        /overwrite/,
      )

      const updated = await installFromSource(url, {
        source: {
          kind: 'payload',
          slug: 'updatable',
          body: '# 第二版',
          version: '1.1.0',
          sourceRef: 'remote:updatable@1.1.0',
        },
        overwrite: true,
      })
      assert.equal((updated.body['installed'] as unknown[]).length, 1)

      const listed = ((await (await fetch(`${url}/api/skills`)).json()) as {
        skills: Array<{ slug: string; version?: string | null; body: string }>
      }).skills.find((x) => x.slug === 'updatable')
      assert.equal(listed?.version, '1.1.0', '★ 版本必须真的被换掉')
      assert.equal(listed?.body, '# 第二版')
      // 只剩一条，不能"悄悄多出一条同名"
      const all = ((await (await fetch(`${url}/api/skills`)).json()) as {
        skills: Array<{ slug: string }>
      }).skills.filter((x) => x.slug === 'updatable')
      assert.equal(all.length, 1)
    })
  })

  test('★ 不带版本时记成 null，而不是空字符串', async () => {
    // 空字符串会参与比较（"" !== "1.0.0"），于是界面永远显示"可以更新"。
    // null 才是"没有版本"这个事实。
    const src = await makeSkillDir({ 'SKILL.md': '# 本地标准' })
    try {
      await withDaemon(async (url) => {
        const res = await installFromSource(url, { source: { kind: 'path', path: src } })
        const installed = res.body['installed'] as Array<Record<string, unknown>>
        assert.equal(installed[0]?.['version'], null)
      })
    } finally {
      await cleanup(src)
    }
  })

  test('★ 路径不存在 ⇒ 400 而不是 500', async () => {
    await withDaemon(async (url) => {
      const res = await installFromSource(url, {
        source: { kind: 'path', path: '/definitely/not/here/xyz' },
      })
      assert.equal(res.status, 400)
      assert.equal(res.body['code'], 'not_found')
    })
  })
})

describe('★ 两条安装路径必须过同一关', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 这条测试对应一处真实的不一致
   * ══════════════════════════════════════════════════════════════════
   *
   * "从路径 / GitHub 安装"这条路过 `resolvePayloadEntry`，于是：
   *   - 没有 SKILL.md 的内容 ⇒ 拒绝；
   *   - 超过限额 ⇒ 拒绝；
   *   - 版本号落库（界面据此显示「已安装 / 更新」）。
   *
   * 而**批量接口**（设置抽屉里那个「安装」）直接收下条目：
   *   - `body: ''` 会被原样写进库 —— 装进去的技能永远不会生效，
   *     而界面显示"已安装"；
   *   - `version` 不传，于是本地这条的 version 是 null，
   *     同一个远端技能从这条路装完，界面**永远**显示「替换本地同名」。
   *
   * 两条路都是"从远端目录装同一个技能"，行为不该不同。
   */
  test('★ 批量接口也要拒绝没有 SKILL.md 内容的条目', async () => {
    await withDaemon(async (url) => {
      const res = await install(url, {
        batchId: 'b-empty',
        skills: [{ slug: 'empty-body', name: '空的', body: '' }],
      })
      assert.equal((res.body['installed'] as unknown[]).length, 0, '★ 空正文不能入库')
      const skipped = res.body['skipped'] as Array<{ reason: string }>
      assert.match(skipped[0]?.reason ?? '', /SKILL\.md/, '要说清缺的是 SKILL.md 的内容')

      const listed = await listSkills(url)
      assert.equal(listed.some((s) => s.slug === 'empty-body'), false)
    })
  })

  test('★ 批量接口也要把版本号落库（否则界面永远显示"替换本地同名"）', async () => {
    await withDaemon(async (url) => {
      await install(url, {
        batchId: 'b-version',
        skills: [
          {
            slug: 'from-drawer',
            name: 'from-drawer',
            body: '# 正文',
            source: 'remote',
            version: '3.1.4',
            sourceRef: 'remote:from-drawer@3.1.4',
          },
        ],
      })
      const listed = ((await (await fetch(`${url}/api/skills`)).json()) as {
        skills: Array<{ slug: string; version?: string | null }>
      }).skills.find((s) => s.slug === 'from-drawer')
      assert.equal(
        listed?.version,
        '3.1.4',
        '★ 两条下载路径落库的版本必须一样，否则同一次下载在界面上有两种说法',
      )
    })
  })

  test('★ 超限的条目在批量接口上同样被拒（限额只有一份）', async () => {
    await withDaemon(async (url) => {
      const res = await install(url, {
        batchId: 'b-big',
        skills: [{ slug: 'too-big', name: 'big', body: 'x'.repeat(300 * 1024) }],
      })
      assert.equal((res.body['installed'] as unknown[]).length, 0)
      assert.match(
        String((res.body['skipped'] as Array<{ reason: string }>)[0]?.reason),
        /超过上限/,
      )
    })
  })
})

/**
 * ══════════════════════════════════════════════════════════════════
 * 卸载（D38）——README 里挂着的那个缺口的收尾
 * ══════════════════════════════════════════════════════════════════
 *
 * 为什么现在补：D38 之后首启不再播种 skill，而**老数据里可能还留着**当年播种的
 * `general-review`。没有卸载入口的话，那条东西只能改库才能清掉。
 */
describe('★ 卸载 skill（D38）', () => {
  async function remove(url: string, id: string) {
    const res = await fetch(`${url}/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  test('★ 卸载之后列表里没有了；卸载不存在的是 404（不是静默成功）', async () => {
    await withDaemon(async (url) => {
      const installed = await install(url, {
        skills: [{ slug: 'to-remove', name: '待卸载', body: '# x', source: 'local' }],
        batchId: 'b1',
      })
      const id = (installed.body['installed'] as Array<{ id: string }>)[0]!.id
      assert.equal((await listSkills(url)).filter((s) => s.slug === 'to-remove').length, 1)

      const res = await remove(url, id)
      assert.equal(res.status, 200)
      assert.equal(res.body['slug'], 'to-remove')
      assert.equal((await listSkills(url)).filter((s) => s.slug === 'to-remove').length, 0)

      // 幂等性由"第二次是 404"表达：**它已经不在了**是事实，不该报成 500
      assert.equal((await remove(url, id)).status, 404)
    })
  })

  test('★ 还有 agent 挂着它 ⇒ 拒绝，并说清是谁（静默删掉会在很久以后才发作）', async () => {
    await withDaemon(async (url) => {
      const installed = await install(url, {
        skills: [{ slug: 'in-use', name: '在用', body: '# x', source: 'local' }],
        batchId: 'b1',
      })
      const id = (installed.body['installed'] as Array<{ id: string }>)[0]!.id
      await fetch(`${url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '挂着它的执行者', skillIds: [id] }),
      })

      const res = await remove(url, id)
      assert.equal(res.status, 400)
      const error = String(res.body['error'])
      assert.match(error, /挂着它的执行者/, '要把"还挂着的是谁"列出来')
      assert.match(error, /先在它们的配置里把它摘掉/, '要说清怎么改')
      assert.equal((await listSkills(url)).filter((s) => s.slug === 'in-use').length, 1)
    })
  })
})

/**
 * ══════════════════════════════════════════════════════════════════
 * 过渡期迁移：把"来自挂载 skill 的标准"固化到 agent 上（D38）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这条路的由来：使用者**删不掉**那条内置的 `general-review`——因为他的审核者还挂着
 * 它，而且**它的审核标准正来自它**（老数据）。而"先摘掉 skill 再卸载"会先把审核者
 * 变成一个没标准的状态，平台于是不再把产出交给它审。
 *
 * 所以需要一步"原样固化"：把当前生效的标准（= 挂载 skill 的正文与动作并集）写成
 * agent 自己的 `reviewStandard`，并摘掉那些挂载。固化之后那条 skill 才能被卸载。
 */
describe('★ 把挂载的 skill 转成内联标准（D38 的迁移入口）', () => {
  async function adopt(url: string, agentId: string) {
    const res = await fetch(
      `${url}/api/agents/${encodeURIComponent(agentId)}/review-standard/adopt-from-skills`,
      { method: 'POST' },
    )
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  test('★ 固化之后：标准与"固化之前生效的那份"一致、挂载清空、skill 可以卸载了', async () => {
    await withDaemon(async (url) => {
      // 造一条技能 + 一个只挂它、没有内联标准的审核者（＝老数据的形态）
      const installed = await install(url, {
        skills: [
          { slug: 'legacy-a', name: '老标准甲', body: '# 甲\n\n只看甲。', source: 'local' },
          { slug: 'legacy-b', name: '老标准乙', body: '# 乙\n\n只看乙。', source: 'local' },
        ],
        batchId: 'b1',
      })
      const ids = (installed.body['installed'] as Array<{ id: string }>).map((s) => s.id)
      const reviewer = (await (
        await fetch(`${url}/api/agents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: '老形态审核者', role: 'reviewer', skillIds: ids }),
        })
      ).json()) as { id: string; reviewStandard: unknown; skillIds: string[] }
      assert.equal(reviewer.reviewStandard, null)
      assert.equal(reviewer.skillIds.length, 2)

      const res = await adopt(url, reviewer.id)
      assert.equal(res.status, 200)
      const adopted = res.body['adopted'] as { name: string; fromSkills: string[] }
      assert.deepEqual(adopted.fromSkills.sort(), ['legacy-a', 'legacy-b'])

      const after = ((await (await fetch(`${url}/api/agents`)).json()) as {
        agents: Array<{ id: string; skillIds: string[]; reviewStandard: { body: string; allowedActions: string[]; name: string } | null }>
      }).agents.find((a) => a.id === reviewer.id)!
      assert.deepEqual(after.skillIds, [], '挂载要摘掉——标准已经在它自己身上了')
      assert.ok(after.reviewStandard, '标准固化下来了')
      assert.match(after.reviewStandard!.body, /只看甲/)
      assert.match(after.reviewStandard!.body, /只看乙/, '两份 skill 的正文都要在')
      assert.match(after.reviewStandard!.name, /老标准甲/)

      // ★ 现在两条 skill 都不再被引用 ⇒ 可以卸载
      for (const id of ids) {
        const del = await fetch(`${url}/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' })
        assert.equal(del.status, 200, '固化之后卸载应当成功')
      }
      assert.equal((await listSkills(url)).length, 0)
    })
  })

  test('没有标准可固化 / 非审核角色 ⇒ 400，并说清怎么做', async () => {
    await withDaemon(async (url) => {
      const empty = await fetch(`${url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '没标准的审核者', role: 'reviewer' }),
      }).then((r) => r.json() as Promise<{ id: string }>)
      const res = await adopt(url, empty.id)
      assert.equal(res.status, 400)
      assert.match(String(res.body['error']), /没有可固化的标准/)

      const executor = await fetch(`${url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '执行者', role: 'executor' }),
      }).then((r) => r.json() as Promise<{ id: string }>)
      assert.equal((await adopt(url, executor.id)).status, 400)

      assert.equal((await adopt(url, 'not-an-agent')).status, 404)
    })
  })
})
