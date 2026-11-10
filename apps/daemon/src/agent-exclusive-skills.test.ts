import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 智能体的**独有技能** API（2026-11，D111）——`agents/<id>/SKILL/<slug>/SKILL.md`
 * 文件资产。与技能库两码事：不进技能页、不可卸载、删智能体连目录一起删。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么单独一份测试
 * ══════════════════════════════════════════════════════════════════
 *
 * 独有技能是智能体上**唯一的写入口在目录文件**上的部分（其它字段走 PATCH agent）。
 * 要钉的是：
 *   · 校验与安装接口**同一关**（`resolvePayloadEntry`）——两条规则不许分叉；
 *   · 内置智能体只读（界面第一道闸、接口第二道，这里钉接口这道）；
 *   · 独有技能不进技能库（技能页看不到它）。
 */

async function withDaemon<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir('agent-exclusive')
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

async function createAgent(url: string): Promise<string> {
  const res = await fetch(`${url}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '独有技能持有者', role: 'executor', instructions: '你是助手。' }),
  })
  assert.equal(res.status, 201)
  const body = (await res.json()) as { id: string }
  return body.id
}

function goodBody(slug: string): string {
  return `---\nname: ${slug} 的名字\ndescription: 一段说明\n---\n## When to Use\n什么时候用\n## Procedure\n怎么做。`
}

describe('★ 独有技能 API（D111）', () => {
  test('★ PUT 新增 ⇒ 列表带名字/说明/正文；同名 PUT 覆盖；DELETE 删除', async () => {
    await withDaemon(async (url) => {
      const agentId = await createAgent(url)

      // 新增
      const put = await fetch(`${url}/api/agents/${agentId}/skills/private-notes`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: goodBody('private-notes') }),
      })
      assert.equal(put.status, 200)

      // 列表
      const list = await fetch(`${url}/api/agents/${agentId}/skills`)
      const { skills } = (await list.json()) as {
        skills: Array<{ slug: string; name: string; description?: string; body: string }>
      }
      assert.equal(skills.length, 1)
      assert.equal(skills[0]!.slug, 'private-notes')
      assert.equal(skills[0]!.name, 'private-notes 的名字')
      assert.equal(skills[0]!.description, '一段说明')
      assert.ok(skills[0]!.body.includes('## When to Use'))

      // 同名覆盖（改正文）
      const put2 = await fetch(`${url}/api/agents/${agentId}/skills/private-notes`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: '# 新版\n\n新正文。' }),
      })
      assert.equal(put2.status, 200)
      const list2 = (await (await fetch(`${url}/api/agents/${agentId}/skills`)).json()) as {
        skills: Array<{ slug: string; body: string }>
      }
      assert.equal(list2.skills[0]!.body, '# 新版\n\n新正文。')

      // 删除；再删 ⇒ 404
      const del = await fetch(`${url}/api/agents/${agentId}/skills/private-notes`, { method: 'DELETE' })
      assert.equal(del.status, 200)
      const del2 = await fetch(`${url}/api/agents/${agentId}/skills/private-notes`, { method: 'DELETE' })
      assert.equal(del2.status, 404)
      const list3 = (await (await fetch(`${url}/api/agents/${agentId}/skills`)).json()) as {
        skills: unknown[]
      }
      assert.deepEqual(list3.skills, [])
    })
  })

  test('★★ 校验与安装接口同一关：坏 slug / 空正文 / 没有 frontmatter 全部 400', async () => {
    await withDaemon(async (url) => {
      const agentId = await createAgent(url)
      const put = async (body: unknown) =>
        fetch(`${url}/api/agents/${agentId}/skills/bad`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })

      // 空正文
      assert.equal((await put({ body: '' })).status, 400)
      assert.equal((await put({ body: '   ' })).status, 400)
      // 没有 frontmatter 也**收**（那关只要求"有 SKILL.md 的内容"；名字回退到 slug）
      const noFrontmatter = await put({ body: '# 没有头\n\n只有正文。' })
      assert.equal(noFrontmatter.status, 200)
      // 超过 SKILL.md 上限（256 KB）⇒ 400（同一份限额）
      const oversized = await put({ body: 'x'.repeat(300 * 1024) })
      assert.equal(oversized.status, 400)
      // 坏 slug：路由会匹配（[^/]+），但 resolvePayloadEntry 那关按 slug 规则拒绝
      const badSlug = await fetch(`${url}/api/agents/${agentId}/skills/UPPER_CASE`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: goodBody('x') }),
      })
      assert.equal(badSlug.status, 400)
      assert.match(
        String(((await badSlug.json()) as { error: string }).error),
        /slug/,
        '要说出是 slug 不对',
      )
      // 不存在的 agent ⇒ 404
      const noAgent = await fetch(`${url}/api/agents/not-there/skills/x`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: goodBody('x') }),
      })
      assert.equal(noAgent.status, 404)
    })
  })

  test('★ 内置智能体只读：PUT / DELETE 都 403（平台播种，不许手改）', async () => {
    await withDaemon(async (url) => {
      const agents = (await (await fetch(`${url}/api/agents`)).json()) as {
        agents: Array<{ id: string; role: string }>
      }
      const drafter = agents.agents.find((a) => a.role === 'drafter')!
      const put = await fetch(`${url}/api/agents/${drafter.id}/skills/x`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: goodBody('x') }),
      })
      assert.equal(put.status, 400)
      assert.equal(((await put.json()) as { code?: string }).code, 'builtin_agent_readonly')
      const del = await fetch(`${url}/api/agents/${drafter.id}/skills/agent-design-norms`, {
        method: 'DELETE',
      })
      assert.equal(del.status, 400)
      assert.equal(((await del.json()) as { code?: string }).code, 'builtin_agent_readonly')
      // 生成者播种的 3 条独有技能在列表里（GET 只读，仍可见）
      const maker = agents.agents.find((a) => a.role === 'agent-maker')!
      const list = (await (await fetch(`${url}/api/agents/${maker.id}/skills`)).json()) as {
        skills: Array<{ slug: string }>
      }
      const slugs = list.skills.map((s) => s.slug).sort()
      assert.deepEqual(slugs, ['agent-design-norms', 'boundary-checklist', 'skill-eligibility'])
    })
  })

  test('★★ 独有技能不进技能库：装了独有技能后技能页一条都没有', async () => {
    await withDaemon(async (url) => {
      const agentId = await createAgent(url)
      await fetch(`${url}/api/agents/${agentId}/skills/private-notes`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: goodBody('private-notes') }),
      })
      const all = (await (await fetch(`${url}/api/skills`)).json()) as {
        skills: Array<{ slug: string }>
      }
      assert.deepEqual(all.skills, [], '独有技能不该出现在技能页（技能页 = 技能库）')
    })
  })
})
