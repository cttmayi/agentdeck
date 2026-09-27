import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { installToolPackage, writeToolPackage } from './testing/tool-fixture.ts'

/**
 * 新建智能体（FR-AGENT-01/12/15/20）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里的核心是"**不要静默兜底**"
 * ══════════════════════════════════════════════════════════════════
 *
 * 原来的实现每个字段都 `?? 默认值`。对 `instructions` 这类"空着也行"的
 * 字段没问题，但对 `name` 不行：字段名写错时会造出一个叫"新 agent"的家伙，
 * **看起来像成功了**——一个拼写错误变成了一条脏数据。
 *
 * 另外两处必须校验，因为它们的错误会在**很远的地方**才发作：
 *   - 挂载不存在的 skill ⇒ 运行时报"没有 skill"，而不是"你填错了 id"；
 *   - `kindPatterns` 留空 ⇒ 这个 agent 谁也接不到，且没有任何报错。
 */

async function withDaemon<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir('agents-create')
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

async function create(url: string, body: unknown) {
  const res = await fetch(`${url}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('★ 新建 agent：缺 name 要报错，不能造出"新 agent"', () => {
  test('★ 没有 name ⇒ 400（而不是静默取一个默认名）', async () => {
    await withDaemon(async (url) => {
      const res = await create(url, { instructions: '干活' })
      assert.equal(res.status, 400)
      assert.match(String(res.body['error']), /name/)
    })
  })

  test('空白 name 也算缺 —— 表单里打了几个空格不该通过', async () => {
    await withDaemon(async (url) => {
      assert.equal((await create(url, { name: '   ' })).status, 400)
    })
  })

  test('name 过长被拒（它有 100 字符的 schema 上限）', async () => {
    await withDaemon(async (url) => {
      assert.equal((await create(url, { name: 'x'.repeat(200) })).status, 400)
    })
  })

  test('正常创建：名称与指令如实存下', async () => {
    await withDaemon(async (url) => {
      const res = await create(url, { name: '安全审核员', instructions: '只看安全问题' })
      assert.equal(res.status, 201)
      const agents = ((await (await fetch(`${url}/api/agents`)).json()) as {
        agents: Array<{ name: string; instructions: string }>
      }).agents
      const made = agents.find((a) => a.name === '安全审核员')
      assert.ok(made)
      assert.equal(made?.instructions, '只看安全问题')
    })
  })
})

describe('★ 挂载不存在的 skill 要在**创建时**就报错', () => {
  /** 造一条 skill 当夹具（D38 之后首启**不再播种** skill，技能库是空的）。 */
  async function installOne(url: string): Promise<{ id: string; slug: string }> {
    const res = await fetch(`${url}/api/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skills: [{ slug: 'fixture-skill', name: '夹具技能', body: '# 夹具', source: 'local' }],
      }),
    })
    const body = (await res.json()) as { installed: Array<{ id: string; slug: string }> }
    return body.installed[0]!
  }

  test('★ skill id 不存在 ⇒ 400 并列出可用项', async () => {
    // 不校验的话，错误会在运行时才发作：报的是"没有 skill"，
    // 而不是"你填错了 id"——排查方向完全跑偏。
    await withDaemon(async (url) => {
      const one = await installOne(url)
      const res = await create(url, { name: 'x', skillIds: ['not-a-real-skill'] })
      assert.equal(res.status, 400)
      assert.match(String(res.body['error']), /skill 不存在/)
      // 要给出可用的，否则使用者只能去翻接口
      assert.match(String(res.body['error']), new RegExp(one.slug))
    })
  })

  test('技能库为空时也说清"还没有 skill"，而不是给一句空列表', async () => {
    await withDaemon(async (url) => {
      const res = await create(url, { name: 'x', skillIds: ['not-a-real-skill'] })
      assert.equal(res.status, 400)
      assert.match(String(res.body['error']), /还没有 skill/)
    })
  })

  test('用真实存在的 skill id 可以创建', async () => {
    await withDaemon(async (url) => {
      const real = await installOne(url)
      const res = await create(url, { name: '执行者', skillIds: [real.id] })
      assert.equal(res.status, 201)
      assert.deepEqual(res.body['skillIds'], [real.id])
    })
  })
})

describe('★ 数组字段要校验元素类型，不是"给了数组就行"', () => {
  test('skillIds 不是数组 ⇒ 400', async () => {
    await withDaemon(async (url) => {
      assert.equal((await create(url, { name: 'x', skillIds: 'nope' })).status, 400)
    })
  })

  test('★ skillIds 里混了空字符串 ⇒ 400（它会一路走到技能求解才炸）', async () => {
    await withDaemon(async (url) => {
      const res = await create(url, { name: 'x', skillIds: [''] })
      assert.equal(res.status, 400)
      assert.match(String(res.body['error']), /非空字符串/)
    })
  })
})

describe('★ 角色与"由谁审我"（D28）', () => {
  test('缺省角色是 executor', async () => {
    // 新建一个 agent 时"它能干活"是最合理的默认；默认成审核者会让它
    // 悄悄进入审核小组
    await withDaemon(async (url) => {
      const res = await create(url, { name: 'x' })
      assert.equal(res.body['role'], 'executor')
      assert.equal(res.body['reviewerAgentId'], null)
    })
  })

  test('role 只认两个取值', async () => {
    await withDaemon(async (url) => {
      assert.equal((await create(url, { name: 'x', role: 'admin' })).status, 400)
      assert.equal((await create(url, { name: 'r', role: 'reviewer' })).status, 201)
    })
  })

  test('★ executor 可以指定一个 reviewer 作为它的审核者', async () => {
    await withDaemon(async (url) => {
      // 首启会播种一对：审核员（reviewer）与助手（executor）
      const agents = ((await (await fetch(`${url}/api/agents`)).json()) as {
        agents: Array<{ id: string; name: string; role: string }>
      }).agents
      const reviewer = agents.find((a) => a.role === 'reviewer')
      assert.ok(reviewer, '首启会播种一个审核者 —— 否则报告全都无人可审')

      const res = await create(url, { name: '执行者', reviewerAgentId: reviewer!.id })
      assert.equal(res.status, 201)
      assert.equal(res.body['reviewerAgentId'], reviewer!.id)
    })
  })

  test('★ 指定的审核者必须真的是审核角色', async () => {
    // 指向一个 executor 是最容易犯的错：名字看起来对，但那个 agent 没有
    // 审核标准可用，run 起不来或审出没有依据的结论
    await withDaemon(async (url) => {
      const executor = (await create(url, { name: '另一个执行者' })).body as { id: string }
      const res = await create(url, { name: 'x', reviewerAgentId: executor.id })
      assert.equal(res.status, 400)
      assert.match(String(res.body['error']), /不是审核角色/)
    })
  })

  test('★ 审核者不能是自己', async () => {
    await withDaemon(async (url) => {
      const made = (await create(url, { name: 'r', role: 'reviewer' })).body as { id: string }
      const res = await fetch(`${url}/api/agents/${made.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'executor', reviewerAgentId: made.id }),
      })
      assert.equal(res.status, 400)
      const body = (await res.json()) as { error: string }
      assert.match(body.error, /审自己|自己/)
    })
  })

  test('★ reviewer 角色不该配 reviewerAgentId', async () => {
    // 它是审别人的那个，不是被审的那个
    await withDaemon(async (url) => {
      const agents = ((await (await fetch(`${url}/api/agents`)).json()) as {
        agents: Array<{ id: string; role: string }>
      }).agents
      const reviewer = agents.find((a) => a.role === 'reviewer')!
      const res = await create(url, {
        name: 'r2',
        role: 'reviewer',
        reviewerAgentId: reviewer.id,
      })
      assert.equal(res.status, 400)
      assert.match(String(res.body['error']), /审别人的那个/)
    })
  })

  test('指定的审核者不存在 ⇒ 400（而不是留一个悬空引用）', async () => {
    await withDaemon(async (url) => {
      const res = await create(url, { name: 'x', reviewerAgentId: 'no-such-agent' })
      assert.equal(res.status, 400)
      assert.match(String(res.body['error']), /不存在/)
    })
  })
})

describe('★ runtime 可以选，但必须是装了的那个', () => {
  test('不指定时缺省 claude', async () => {
    await withDaemon(async (url) => {
      assert.equal((await create(url, { name: 'x' })).body['runtimeKey'], 'claude')
    })
  })

  test('★ 指定一个不存在的 runtime ⇒ 400，并列出可用的', async () => {
    // 不校验的话 run 会在很远的地方起不来，而错误信息指向的是"进程启动失败"
    await withDaemon(async (url) => {
      const res = await create(url, { name: 'x', runtimeKey: 'gemini' })
      assert.equal(res.status, 400)
      assert.match(String(res.body['error']), /未知的 runtime/)
      assert.match(String(res.body['error']), /claude/)
    })
  })

  test('可以选 generic（适配表里另一个 runtime）', async () => {
    await withDaemon(async (url) => {
      const res = await create(url, { name: 'x', runtimeKey: 'generic' })
      assert.equal(res.status, 201)
      assert.equal(res.body['runtimeKey'], 'generic')
    })
  })
})

describe('★ 改 agent：只改传了的字段（PATCH 语义）', () => {
  test('★ 只改名字不会把指令清空', async () => {
    // 整体替换会让"只想改个名字"的请求顺手清掉没传的字段——
    // 那是个很容易踩、而且保存后才发现的坑。
    await withDaemon(async (url) => {
      const created = (await create(url, { name: '原名', instructions: '原来的指令' })).body as {
        id: string
      }
      const res = await fetch(`${url}/api/agents/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '新名' }),
      })
      assert.equal(res.status, 200)
      const updated = (await res.json()) as { name: string; instructions: string }
      assert.equal(updated.name, '新名')
      assert.equal(updated.instructions, '原来的指令', '★ 没传的字段必须原样保留')
    })
  })

  test('★ 拼错的字段名被**拒绝**，而不是静默忽略', async () => {
    // 静默忽略会让人以为保存成功了
    await withDaemon(async (url) => {
      const created = (await create(url, { name: 'x' })).body as { id: string }
      const res = await fetch(`${url}/api/agents/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: '少了 s' }),
      })
      assert.equal(res.status, 400)
      assert.match(String(((await res.json()) as { error: string }).error), /不认识的字段/)
    })
  })

  test('改 skillIds 时仍然校验存在性', async () => {
    await withDaemon(async (url) => {
      const created = (await create(url, { name: 'x' })).body as { id: string }
      const res = await fetch(`${url}/api/agents/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skillIds: ['nope'] }),
      })
      assert.equal(res.status, 400)
      assert.match(String(((await res.json()) as { error: string }).error), /skill 不存在/)
    })
  })

  test('GET 单个 agent 可取回细节', async () => {
    await withDaemon(async (url) => {
      const created = (await create(url, { name: '细节', instructions: '看这里' })).body as {
        id: string
      }
      const got = (await (await fetch(`${url}/api/agents/${created.id}`)).json()) as {
        name: string
        instructions: string
      }
      assert.equal(got.name, '细节')
      assert.equal(got.instructions, '看这里')
    })
  })

  test('改不存在的 agent ⇒ 404', async () => {
    await withDaemon(async (url) => {
      const res = await fetch(`${url}/api/agents/does-not-exist`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      })
      assert.equal(res.status, 404)
    })
  })

  test('name 不能改成空', async () => {
    await withDaemon(async (url) => {
      const created = (await create(url, { name: 'x' })).body as { id: string }
      const res = await fetch(`${url}/api/agents/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '  ' }),
      })
      assert.equal(res.status, 400)
    })
  })
})

describe('★ runtime 真的会被消费（不只是记在字段里）', () => {
  test('★ agent 的 runtimeKey 决定用哪个 CLI —— 不再是个没人读的字段', async () => {
    // ══════════════════════════════════════════════════════════════════
    // 这条测试的由来
    // ══════════════════════════════════════════════════════════════════
    //
    // 在这之前，执行器用的是 **daemon 级**的 backend 与描述符——所有 agent
    // 实际上都跑在同一个 CLI 上，而 `agent.runtimeKey` 是一个**没人读的
    // 字段**。界面上能选、审计里会记，行为上不存在。
    //
    // 那正是这个项目反复在防的那类东西：**接口接受了，行为上不存在**。
    // 让人以为配了就生效，比不支持更糟。
    //
    // 判据取的是**描述符**：不同 runtime 的 baseArgs 不同，而它会被写进
    // 审计的 argv（那是"当时到底怎么起的进程"的权威记录）。
    await withDaemon(async (url) => {
      // ★ D41：动作只能来自**装进来的工具包**（平台的内置动作全部移除了），
      //   所以先装一个包，再把它声明的动作写进 `allowedActions`。继续写
      //   `comment.create` 那种老名字的话，这次创建会以"工具的包没装"被 400 拒掉
      //   ——而这条用例要的是"字段如实存下来"，不是"包没装会被拒"。
      const pkg = await writeToolPackage({ slug: 'runtime-fixture-tool', actionName: 'run' })
      await installToolPackage({ url }, pkg)

      const reviewer = ((await (
        await fetch(`${url}/api/agents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'generic 审核者',
            role: 'reviewer',
            runtimeKey: 'generic',
            // D37/D38：审核者靠**自己带的标准**审，不再靠挂 skill
            reviewStandard: {
              body: '# 夹具\n\n只看一件事。',
            },
            // D40 收口：动作权限在 **agent** 上（不再是标准里那个字段）
            // D41：这里写的那个动作来自上面装的包 —— 它是这次唯一的合法来源
            allowedActions: [pkg.action],
          }),
        })
      ).json()) as { id: string; runtimeKey: string; allowedActions: string[] })

      assert.equal(reviewer.runtimeKey, 'generic', '字段如实存下来')
      assert.deepEqual(reviewer.allowedActions, [pkg.action], '动作也如实存下来')

      // 用这个 agent 起一条 review run，看审计里的 argv 用哪套基础参数
      const runId = '01M2RUNTIME00000000000001'
      await fetch(`${url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'review',
          agentRef: { id: reviewer.id, name: 'generic 审核者', instructions: '' },
          subject: { type: 'report', id: 'r-1' },
          prompt: '审一下',
          limits: { maxTurns: null, timeoutMs: null },
          review: { kind: 'k', title: 't', body: 'b', inputBlobRef: null, relatedIssueId: null },
        }),
      })

      // 等 run 结束（假后端会让它立刻完成或失败，两种都行——审计只在
      // "有判决"时写，所以这里只看 run 记录本身有没有被受理）
      const run = (await (await fetch(`${url}/api/runs/${runId}`)).json()) as { id?: string }
      assert.ok(run?.id, '★ run 被受理了 —— 说明 generic runtime 能被解析')
    })
  })

  test('未知 runtime 的 agent 不会被创建（在写库之前就拦掉）', async () => {
    await withDaemon(async (url) => {
      const res = await create(url, { name: 'x', runtimeKey: 'nope' })
      assert.equal(res.status, 400)
    })
  })
})

/**
 * ══════════════════════════════════════════════════════════════════
 * 「新建任务的默认智能体」（D36）
 * ══════════════════════════════════════════════════════════════════
 *
 * 它是 workspace 上的一个**全局单值**——"默认交给谁"本来就是一个选择。
 * 界面上的入口是每个 agent 卡片上的一个按钮，所以这个接口要能：
 * 设、取消、拒绝不存在 / 拒绝审核者；而列表接口要把它一起给出来（界面
 * 靠它标「默认」、新建任务页靠它预选）。
 */
describe('★ 默认智能体：设 / 取消 / 只认执行者', () => {
  test('★ 设上之后，列表接口把它带出来；取消之后回到 null', async () => {
    await withDaemon(async (url) => {
      const created = await create(url, { name: '默认候选', role: 'executor' })
      const id = created.body['id'] as string

      const before = (await (await fetch(`${url}/api/agents`)).json()) as {
        agents: Array<{ id: string }>
        defaultAgentId: string | null
      }
      assert.ok(before.agents.length >= 3, '播种的 + 新建的都在')
      assert.ok(before.defaultAgentId, '首启就该有一个默认（播种的执行者）')

      const set = await fetch(`${url}/api/agents/default`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: id }),
      })
      assert.equal(set.status, 200, JSON.stringify(await set.clone().json()))

      const after = (await (await fetch(`${url}/api/agents`)).json()) as {
        defaultAgentId: string | null
      }
      assert.equal(after.defaultAgentId, id, '列表接口要把它一起给出来')
    })
  })

  test('★ 审核者不能当默认（任务不会交给被动的那一方）', async () => {
    await withDaemon(async (url) => {
      const reviewer = await create(url, { name: '一个审核者', role: 'reviewer' })
      const res = await fetch(`${url}/api/agents/default`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: reviewer.body['id'] }),
      })
      assert.equal(res.status, 400)
      const body = (await res.json()) as { error: string }
      assert.match(body.error, /只有「执行」角色/)
      assert.match(body.error, /审核者/, '要说清为什么——否则人会以为是 bug')
    })
  })

  test('★ 没有「取消默认」：必须有一个默认（要换就设成另一个）', async () => {
    await withDaemon(async (url) => {
      const res = await fetch(`${url}/api/agents/default`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: null }),
      })
      assert.equal(res.status, 400)
      const body = (await res.json()) as { error: string }
      assert.match(body.error, /必须有一个/)
      assert.match(body.error, /设成另一个/, '要告诉人正确的做法是什么')

      // 设成另一个 ⇒ 原来那个自动让位（单值本身保证了这一点）
      const a = await create(url, { name: '甲执行者', role: 'executor' })
      const b = await create(url, { name: '乙执行者', role: 'executor' })
      for (const agent of [a, b]) {
        const r = await fetch(`${url}/api/agents/default`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: agent.body['id'] }),
        })
        assert.equal(r.status, 200)
      }
      const list = (await (await fetch(`${url}/api/agents`)).json()) as {
        defaultAgentId: string | null
      }
      assert.equal(list.defaultAgentId, b.body['id'], '最后一个设的赢（单选）')
    })
  })

  test('不存在的 agent / 类型不对 ⇒ 400（不静默记下一条悬空值）', async () => {
    await withDaemon(async (url) => {
      const missing = await fetch(`${url}/api/agents/default`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'not-an-agent' }),
      })
      assert.equal(missing.status, 400)
      assert.match(((await missing.json()) as { error: string }).error, /不存在/)

      const wrongType = await fetch(`${url}/api/agents/default`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 42 }),
      })
      assert.equal(wrongType.status, 400)
    })
  })
})
