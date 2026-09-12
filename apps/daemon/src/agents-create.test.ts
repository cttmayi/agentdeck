import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

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
  test('★ skill id 不存在 ⇒ 400 并列出可用项', async () => {
    // 不校验的话，错误会在运行时才发作：报的是"没有 skill"，
    // 而不是"你填错了 id"——排查方向完全跑偏。
    await withDaemon(async (url) => {
      const res = await create(url, { name: 'x', skillIds: ['not-a-real-skill'] })
      assert.equal(res.status, 400)
      assert.match(String(res.body['error']), /skill 不存在/)
      // 要给出可用的，否则使用者只能去翻接口
      assert.match(String(res.body['error']), /general-review/)
    })
  })

  test('用真实存在的 skill id 可以创建', async () => {
    await withDaemon(async (url) => {
      const skills = ((await (await fetch(`${url}/api/skills`)).json()) as {
        skills: Array<{ id: string; slug: string }>
      }).skills
      const real = skills[0]
      assert.ok(real, 'daemon 首启会播种一个内置审核模板')
      const res = await create(url, { name: '审核者', skillIds: [real!.id] })
      assert.equal(res.status, 201)
      assert.deepEqual(res.body['skillIds'], [real!.id])
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

  test('kindPatterns 里混了数字 ⇒ 400', async () => {
    await withDaemon(async (url) => {
      assert.equal((await create(url, { name: 'x', kindPatterns: [123] })).status, 400)
    })
  })

  test('kindPatterns 会被 trim', async () => {
    await withDaemon(async (url) => {
      const res = await create(url, { name: 'x', kindPatterns: [' ci-failure ', 'sec-*'] })
      assert.deepEqual(res.body['kindPatterns'], ['ci-failure', 'sec-*'])
    })
  })

  test('maxConcurrentRuns 必须是正整数', async () => {
    await withDaemon(async (url) => {
      assert.equal((await create(url, { name: 'x', maxConcurrentRuns: 0 })).status, 400)
      assert.equal((await create(url, { name: 'x', maxConcurrentRuns: 1.5 })).status, 400)
    })
  })
})

describe('默认值与 runtime', () => {
  test('★ runtimeKey 用**当前 daemon 的**，不由客户端指定', async () => {
    // 指定一个没装的 runtime 只会让 run 起不来，而错误发生在很远的地方
    await withDaemon(async (url) => {
      const res = await create(url, { name: 'x', runtimeKey: '不存在的runtime' })
      assert.equal(res.status, 201)
      assert.equal(res.body['runtimeKey'], 'claude', '应当忽略客户端指定的 runtime')
    })
  })

  test('没给 kindPatterns 时是空数组（谁也接不到）—— 这是如实记录，不是错误', async () => {
    await withDaemon(async (url) => {
      const res = await create(url, { name: 'x' })
      assert.deepEqual(res.body['kindPatterns'], [])
    })
  })

  test('空字符串的 workDir 被当作"没指定"（D27 的默认路径）', async () => {
    await withDaemon(async (url) => {
      const res = await create(url, { name: 'x', workDir: '   ' })
      assert.equal(res.body['workDir'], null)
    })
  })

  test('布尔字段只有显式 true 才算真', async () => {
    await withDaemon(async (url) => {
      const res = await create(url, { name: 'x', isFallbackReviewer: 'yes', autoReview: 1 })
      assert.equal(res.body['isFallbackReviewer'], false)
      assert.equal(res.body['autoReview'], false)
    })
  })
})
