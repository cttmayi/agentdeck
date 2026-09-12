import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
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

async function withDaemon<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir('skills-install')
  const d = await startDaemon({
    dataDir: dir,
    port: 0,
    fsync: false,
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
  return ((await res.json()) as { skills: Array<{ slug: string; source: string; id: string }> })
    .skills
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

  async function bootstrap(url: string) {
    const agents = ((await (await fetch(`${url}/api/agents`)).json()) as {
      agents: Array<{ id: string; name: string; skillIds: string[] }>
    }).agents
    const agent = agents.find((a) => a.skillIds.length > 0)
    assert.ok(agent, 'daemon 首启会播种一个挂着内置审核模板的 agent')
    return agent!
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
