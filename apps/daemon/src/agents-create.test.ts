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

describe('★ 角色（原来还管"由谁审我"，2026-10 起那件事只有组能回答）', () => {
  test('缺省角色是 executor', async () => {
    // 新建一个 agent 时"它能干活"是最合理的默认；默认成审核者会让它
    // 悄悄进入审核小组。
    await withDaemon(async (url) => {
      const res = await create(url, { name: 'x' })
      assert.equal(res.body['role'], 'executor')
      // ⚠️ 这里原来还断言 `reviewerAgentId === null`——那个字段已经从 `Agent` 上
      //    整个撤掉，所以现在的判据是"读回来的记录里**没有这个键**"（而不是"它是
      //    null"）。这一条同时钉住"老字段不会从任何角落里漏出来"。
      assert.ok(
        !Object.hasOwn(res.body as Record<string, unknown>, 'reviewerAgentId'),
        '撤掉的字段不该出现在新建记录里（连 null 都不该有）',
      )
    })
  })

  test('role 只认两个取值', async () => {
    await withDaemon(async (url) => {
      assert.equal((await create(url, { name: 'x', role: 'admin' })).status, 400)
      assert.equal((await create(url, { name: 'r', role: 'reviewer' })).status, 201)
    })
  })

  /**
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ 这一节原来有六条用例，全是"由谁审我"的校验（D28）
   * ══════════════════════════════════════════════════════════════════
   *
   * 它们钉的是：执行者能指定一个审核者、指定的必须是**审核角色**、不能指向自己、
   * 审核者自己不许配、指向不存在的 id 要 400。**这六条现在都没有对象了**——
   * `Agent.reviewerAgentId` 已从协议里撤掉（"谁审我"这件事现在只有**智能体组**
   * 能回答，见 `AgentGroup`），所以那些请求现在一律走"不认识的字段"这条 400。
   *
   * ★ 而它们防的那几件事**一件都没丢**，只是换了承载体和发生时机：
   *
   *   · "指定的必须是审核角色" / "不能是自己" / "不能一个执行者都没有" ⇒
   *     组的**形态校验器**（`checkGroupShape`：恰好 1 执行 + 1 审核，报出实际是
   *     谁、缺谁），而且它**每次派活时都会再校验一遍**（成员会被删、角色会被改）
   *     ——比"在写入口校验一次"更强；
   *   · "指向不存在的 id" ⇒ 同样由形态校验器报（成员不存在时会点名那个 id）；
   *   · INV-1（审核者 ≠ 执行者）另有一道：`POST /api/runs` 上的
   *     `assertReviewerDistinct`（写入前强制）。
   *
   * 所以这里不再重写那六条，而是钉住**新的事实**：那几个键现在进不来。
   */
  test('★★ 撤掉的字段写进接口 ⇒ 400「不认识的字段」（而不是被静默忽略）', async () => {
    // 静默忽略是最坏的一种处理：使用者以为"我给它配了审核者/动作权限"，界面也
    // 一路 200，而库里一个字节都没写——下次打开发现配置不见了，谁也说不清是哪
    // 一步丢的。所以写入口**明确拒绝**，并在错误里点出可改的字段。
    await withDaemon(async (url) => {
      for (const key of ['reviewerAgentId', 'allowedActions', 'actionParams', 'debugActions']) {
        const res = await create(url, { name: `想写 ${key} 的执行者`, [key]: [] })
        assert.equal(res.status, 400, `${key}：必须拒绝，实际 ${res.status}`)
        assert.match(String(res.body['error']), /不认识的字段/, `${key}：要说清是字段不认识`)
        assert.match(String(res.body['error']), new RegExp(key), `${key}：要点名是哪一个`)
      }
    })
  })

  test('★★ 撤掉的字段连 PATCH 也进不来（保存一次不该把它带回来）', async () => {
    await withDaemon(async (url) => {
      const made = (await create(url, { name: '普通执行者' })).body as { id: string }
      const res = await fetch(`${url}/api/agents/${made.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewerAgentId: null }),
      })
      assert.equal(res.status, 400, '旧字段写一次也是 400（不然"保存时顺手清掉"就无从谈起）')
      // 而普通字段照旧能改——这条反向对照防的是"整个 PATCH 被改坏了"
      const ok = await fetch(`${url}/api/agents/${made.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '改个名字' }),
      })
      assert.equal(ok.status, 200)
      assert.equal(((await ok.json()) as { name: string }).name, '改个名字')
    })
  })
})

describe('★ runtime 可以选，但必须是装了的那个', () => {
  test('不指定时缺省 `default`（跟随全局默认，而不是把当时的默认值烙进记录）', async () => {
    // ★ 2026-10（定稿第 ⑦ 条）改了这条断言：从前缺省写死 `'claude'`，于是使用者后来
    //   改了全局 runtime 默认值，这些 agent **不会跟着变**——而"默认"这个词就成了谎话，
    //   且没人会去怀疑一条已经存好的记录。现在记的是 `'default'`，由 executor 三级解析。
    await withDaemon(async (url) => {
      assert.equal((await create(url, { name: 'x' })).body['runtimeKey'], 'default')
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
      // ⚠️ 2026-10：这里原来还顺带造一个工具包、把它的动作写进审核者的
      //    `allowedActions`（D41：动作只能来自装进来的包）。那一步现在**没有落点了**
      //    ——agent 上不再有动作字段（动作只属于组），所以这条用例回到它真正的
      //    被测对象：`runtimeKey` 是否如实落库、并且真的决定用哪个 CLI。

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
          }),
        })
      ).json()) as { id: string; runtimeKey: string })

      assert.equal(reviewer.runtimeKey, 'generic', '字段如实存下来')

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
