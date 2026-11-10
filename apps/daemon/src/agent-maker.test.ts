import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@agentdeck/agent-core'
import { FileStore } from '@agentdeck/store-file'
import { wsId } from '@agentdeck/domain/testing'
import { startDaemon, type DaemonHandle } from './server.ts'
import { parseAgentDraft, readAgentDraftArtifacts, type AgentDraftParsed } from './agent-maker.ts'
import {
  AGENT_MAKER_SKILL_SLUGS,
  ensureAgentMakerSkillsInstalled,
  syncAgentMakerSkillMount,
} from './agent-maker-skills.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 智能体生成者（2026-11 设计定稿）：岗位卡解析 + 生成产物读取 + 确认生成整链。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有这一份
 * ══════════════════════════════════════════════════════════════════
 *
 * 岗位卡（agent-draft.md）是**生成者在聊天里写的产物**——解析规则错了，确认时
 * 拿到的就是另一个岗位；确认接口（先沉淀配套技能、再建智能体、skillIds 指向
 * 已存在的技能）是"生成智能体"唯一的生产入口，两条都值得钉住。
 *
 * ⚠️ 假后端（NFR-T-01）：不碰任何真实 CLI——假后端的 execute 直接把岗位卡与
 *    配套技能**写进工作目录**（真后端里这一步是生成者干的，这里由夹具代办）。
 */

const WS = wsId('ws-agent-maker')

// ────────────────────────────────────────────────────────────────
// 岗位卡解析（纯函数）
// ────────────────────────────────────────────────────────────────

describe('岗位卡（agent-draft.md）的解析', () => {
  const good = `---
name: 会议纪要助理
role: executor
---
你是会议纪要助理。

## 目标
把妙记变成一页纪要。

## 边界（不能碰）
不替参会人做决定。
`

  test('★ 标准岗位卡：frontmatter 的 name/role + 正文即指令', () => {
    const out = parseAgentDraft(good)
    assert.ok(out.ok)
    if (!out.ok) return
    assert.equal(out.name, '会议纪要助理')
    assert.equal(out.role, 'executor')
    assert.ok(out.instructions.startsWith('你是会议纪要助理。'))
    assert.ok(out.instructions.includes('## 边界（不能碰）'))
  })

  test('★ frontmatter 必须在第一行（与 SKILL.md 同一纪律）：前面多一行 = 没被认出', () => {
    const out = parseAgentDraft('应并入：会议纪要\n\n' + good)
    assert.ok(!out.ok)
  })

  test('★ 引号要去掉（与 parseSkillMd 的 stripQuotes 同款）；缺 name / role / 正文各报其错', () => {
    const quoted = good.replace('会议纪要助理', '"会议纪要助理"')
    const out = parseAgentDraft(quoted)
    assert.ok(out.ok)
    if (out.ok) assert.equal(out.name, '会议纪要助理')

    const noName = parseAgentDraft(good.replace('name: 会议纪要助理', ''))
    assert.ok(!noName.ok)
    const noRole = parseAgentDraft(good.replace('role: executor', ''))
    assert.ok(!noRole.ok)
    const empty = parseAgentDraft('---\nname: 岗位\nrole: executor\n---\n  \n')
    assert.ok(!empty.ok)
  })

  test('★ reviewer 也算合法岗位（判据由确认路由钉住 executor/reviewer 两个值）', () => {
    const out = parseAgentDraft(good.replace('role: executor', 'role: reviewer'))
    assert.ok(out.ok)
    if (out.ok) assert.equal(out.role, 'reviewer')
  })
})

describe('生成产物读取（readAgentDraftArtifacts）', () => {
  test('★ 岗位卡 + 配套技能草稿都读出来；skill/ 不存在 = 0 条（不是错误）', async () => {
    const dir = await makeTempDir('agent-maker-artifacts')
    try {
      await writeFile(join(dir, 'agent-draft.md'), '---\nname: 会议纪要助理\nrole: executor\n---\n你是会议纪要助理。')
      await mkdir(join(dir, 'skill', 'meeting-notes-format'), { recursive: true })
      await writeFile(
        join(dir, 'skill', 'meeting-notes-format', 'SKILL.md'),
        '---\nname: 会议纪要格式\ndescription: decisions/owners/deadlines 三段\n---\n## When to Use\n会议纪要\n## Procedure\n分三段。',
      )
      const out = await readAgentDraftArtifacts(dir)
      assert.ok(out.agentDraft !== null && out.agentDraft.includes('会议纪要助理'))
      assert.equal(out.skills.length, 1)
      assert.equal(out.skills[0]!.slug, 'meeting-notes-format')
      assert.equal(out.skills[0]!.name, '会议纪要格式')
      assert.ok(out.skills[0]!.body.includes('## When to Use'))
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 什么都没有 = agentDraft null + skills 空数组（按钮出现条件就是前者）', async () => {
    const dir = await makeTempDir('agent-maker-empty')
    try {
      const out = await readAgentDraftArtifacts(dir)
      assert.equal(out.agentDraft, null)
      assert.deepEqual(out.skills, [])
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 子目录里没有 SKILL.md = 不是配套技能（跳过，不抛）', async () => {
    const dir = await makeTempDir('agent-maker-skip')
    try {
      await writeFile(join(dir, 'agent-draft.md'), '---\nname: x\nrole: executor\n---\n你是x。')
      await mkdir(join(dir, 'skill', 'not-a-skill'), { recursive: true })
      await writeFile(join(dir, 'skill', 'not-a-skill', 'notes.txt'), '没有 SKILL.md')
      const out = await readAgentDraftArtifacts(dir)
      assert.deepEqual(out.skills, [])
    } finally {
      await cleanup(dir)
    }
  })
})

describe('平台技能动态安装 + 挂载（agent-maker-skills）', () => {
  test('★ 三份平台技能从仓库装进技能库（幂等：再跑一遍不动）；挂载对齐到生成者身上', async () => {
    const dir = await makeTempDir('agent-maker-skills')
    const store = await FileStore.open({ dataDir: dir, fsync: false })
    try {
      const first = await ensureAgentMakerSkillsInstalled(store, WS)
      assert.deepEqual([...first.installed].sort(), [...AGENT_MAKER_SKILL_SLUGS].sort())
      const skills = await store.listSkills(WS)
      for (const slug of AGENT_MAKER_SKILL_SLUGS) {
        const skill = skills.find((s) => s.slug === slug)
        assert.ok(skill, `平台技能 ${slug} 要装进来`)
        assert.ok(skill!.body.includes('## When to Use'), `${slug} 的正文要完整（含 When to Use）`)
        assert.equal(skill!.source, 'local')
      }
      // 幂等：再跑一遍 = 什么都不装（同名已存在）
      const again = await ensureAgentMakerSkillsInstalled(store, WS)
      assert.deepEqual(again.installed, [])
      assert.equal((await store.listSkills(WS)).length, AGENT_MAKER_SKILL_SLUGS.length)

      // 挂载：生成者身上挂着那三条（对账先建出生成者）
      const mount = await syncAgentMakerSkillMount(store, WS)
      assert.equal(mount.skillSlugs.length, AGENT_MAKER_SKILL_SLUGS.length)
      const maker = (await store.listAgents(WS)).find((a) => a.role === 'agent-maker')!
      assert.equal(maker.skillIds.length, AGENT_MAKER_SKILL_SLUGS.length)
      // 再跑一遍 = 不写（改了才写）
      const mountAgain = await syncAgentMakerSkillMount(store, WS)
      assert.deepEqual(mountAgain.skillIds, mount.skillIds)
    } finally {
      await store.close()
      await cleanup(dir)
    }
  })
})

// ────────────────────────────────────────────────────────────────
// 整链（真 daemon + 假后端）：生成 → 读 → 确认
// ────────────────────────────────────────────────────────────────

/** 假后端：execute 时把岗位卡与配套技能**写进工作目录**（生成者真机的产出由夹具代办）。 */
class WritingBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true
  agentDraft = ''
  skillBody = ''

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    const workDir = opts.workDir ?? ''
    if (this.agentDraft !== '') {
      await writeFile(join(workDir, 'agent-draft.md'), this.agentDraft)
    }
    if (this.skillBody !== '') {
      await mkdir(join(workDir, 'skill', 'meeting-notes-format'), { recursive: true })
      await writeFile(join(workDir, 'skill', 'meeting-notes-format', 'SKILL.md'), this.skillBody)
    }
    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: '岗位卡已写入 agent-draft.md。' })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: '岗位卡已写入 agent-draft.md。',
        durationMs: 2,
        sessionId: 'maker-session',
        usage: { inputTokens: 10, outputTokens: 5, costUsdMicros: 100, costSource: 'provider' },
        exitCode: 0,
      }),
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

let dataDir: string
let daemon: DaemonHandle
let backend: WritingBackend
let makerId: string

const json = async (path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${daemon.url}${path}`, init)
  return { status: res.status, body: await res.json().catch(() => null) }
}

const postJson = (path: string, body: unknown): Promise<{ status: number; body: unknown }> =>
  json(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

async function waitForTerminal(runId: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { body } = await json(`/api/runs/${runId}`)
    const status = (body as { status?: string } | null)?.status
    if (status !== undefined && ['completed', 'failed', 'cancelled'].includes(status)) return
    if (Date.now() > deadline) throw new Error(`run ${runId} 一直没到终态`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

before(async () => {
  dataDir = await makeTempDir('agent-maker-e2e-data')
  backend = new WritingBackend()
  backend.agentDraft = `---
name: 会议纪要助理
role: executor
---
你是会议纪要助理。

## 目标
把妙记变成一页纪要。

## 职责
转写、提炼、分节。

## 边界（不能碰）
不替参会人做决定；只在工作目录写。

## 输出格式
decisions / owners / deadlines 三段。
`
  backend.skillBody = `---
name: 会议纪要格式
description: decisions/owners/deadlines 三段的会议纪要格式
---
## When to Use
把转写变成纪要时。

## Procedure
1. decisions 每行一条
2. owners 每行一条
3. deadlines 每行一条
`
  daemon = await startDaemon({
    dataDir,
    port: 0,
    fsync: false,
    backend,
    onWarn: () => {},
    onInfo: () => {},
  })
  const agents = await json('/api/agents')
  const list = (agents.body as { agents: Array<{ id: string; role: string }> }).agents
  makerId = list.find((a) => a.role === 'agent-maker')!.id
})

after(async () => {
  await daemon.close()
  await cleanup(dataDir)
})

describe('生成智能体整链（2026-11 设计定稿 §3.5–§3.6）', () => {
  test('★ 生成者对话跑完 ⇒ hasAgentDraft=true ⇒ 读岗位卡与配套技能 ⇒ 确认生成（先技能后智能体）', async () => {
    const created = await postJson('/api/conversations', {
      agentId: makerId,
      text: '帮我理清一个岗位：把会议纪要变成一页纪要。',
    })
    assert.equal(created.status, 201, `建对话失败：${JSON.stringify(created.body)}`)
    const conversationId = (created.body as { conversation: { id: string } }).conversation.id
    await waitForTerminal((created.body as { turn: { runId: string } }).turn.runId)

    // 详情带 hasAgentDraft（工作目录顶层有 agent-draft.md）
    const detail = await json(`/api/conversations/${conversationId}`)
    assert.equal((detail.body as { hasAgentDraft: boolean }).hasAgentDraft, true)

    // 读生成产物
    const artifacts = await json(`/api/conversations/${conversationId}/agent-draft`)
    const artifactBody = artifacts.body as {
      agentDraft: string | null
      skills: Array<{ slug: string; name: string; description: string; body: string }>
    }
    assert.ok(artifactBody.agentDraft !== null && artifactBody.agentDraft.includes('会议纪要助理'))
    assert.equal(artifactBody.skills.length, 1)
    assert.equal(artifactBody.skills[0]!.slug, 'meeting-notes-format')

    // 确认生成：岗位卡 + 配套技能一起提交
    const committed = await postJson(`/api/conversations/${conversationId}/agent-commit`, {
      agentDraft: artifactBody.agentDraft,
      skills: artifactBody.skills.map((s) => ({ slug: s.slug, body: s.body })),
    })
    assert.equal(committed.status, 201, `确认生成失败：${JSON.stringify(committed.body)}`)
    const out = committed.body as {
      agent: { id: string; name: string; role: string; skillIds: string[] }
      skillIds: string[]
    }
    assert.equal(out.agent.name, '会议纪要助理')
    assert.equal(out.agent.role, 'executor')

    // 配套技能先落库（mine + 可见），智能体 skillIds 指向它
    const skills = await json('/api/skills')
    const mine = (skills.body as { skills: Array<{ slug: string; source: string; id: string }> }).skills.find(
      (s) => s.slug === 'meeting-notes-format' && s.source === 'mine',
    )
    assert.ok(mine, '配套技能要落 skills-mine（source === mine）')
    assert.deepEqual(out.skillIds, [mine!.id], '智能体的 skillIds 要指向已沉淀的那条技能')
    assert.deepEqual(out.agent.skillIds, [mine!.id])
  })

  test('★ 非生成者对话不能确认生成（agent_commit_not_maker）', async () => {
    const agents = await json('/api/agents')
    const executorId = (agents.body as { agents: Array<{ id: string; role: string }> }).agents.find(
      (a) => a.role === 'executor',
    )!.id
    const created = await postJson('/api/conversations', { agentId: executorId, text: '你好' })
    assert.equal(created.status, 201)
    const conversationId = (created.body as { conversation: { id: string } }).conversation.id
    await waitForTerminal((created.body as { turn: { runId: string } }).turn.runId)

    const res = await postJson(`/api/conversations/${conversationId}/agent-commit`, {
      agentDraft: '---\nname: 岗位\nrole: executor\n---\n你是岗位。',
      skills: [],
    })
    assert.equal(res.status, 400)
    assert.equal((res.body as { code?: string }).code, 'agent_commit_not_maker')
  })

  test('★ 坏岗位卡 ⇒ 400（解析失败说得出哪里不对）；非 executor/reviewer ⇒ 400', async () => {
    const created = await postJson('/api/conversations', { agentId: makerId, text: '问个岗位' })
    assert.equal(created.status, 201)
    const conversationId = (created.body as { conversation: { id: string } }).conversation.id
    await waitForTerminal((created.body as { turn: { runId: string } }).turn.runId)

    const bad = await postJson(`/api/conversations/${conversationId}/agent-commit`, {
      agentDraft: '没有 frontmatter',
      skills: [],
    })
    assert.equal(bad.status, 400)
    assert.equal((bad.body as { code?: string }).code, 'agent_draft_invalid')

    const badRole = await postJson(`/api/conversations/${conversationId}/agent-commit`, {
      agentDraft: '---\nname: 岗位\nrole: drafter\n---\n你是岗位。',
      skills: [],
    })
    assert.equal(badRole.status, 400)
    assert.equal((badRole.body as { code?: string }).code, 'agent_role_invalid')
  })

  test('★ 同名 mine 技能冲突 ⇒ 409（与沉淀新建同一口径，不静默覆盖）', async () => {
    const created = await postJson('/api/conversations', { agentId: makerId, text: '再问一个' })
    assert.equal(created.status, 201)
    const conversationId = (created.body as { conversation: { id: string } }).conversation.id
    await waitForTerminal((created.body as { turn: { runId: string } }).turn.runId)

    const res = await postJson(`/api/conversations/${conversationId}/agent-commit`, {
      agentDraft: '---\nname: 岗位二\nrole: executor\n---\n你是岗位二。',
      skills: [{ slug: 'meeting-notes-format', body: '---\nname: x\n---\n## When to Use\na\n## Procedure\nb\n' }],
    })
    assert.equal(res.status, 409)
    assert.equal((res.body as { code?: string }).code, 'agent_skill_clash_mine')
  })

  test('★ 平台技能允许卸载：生成者（内置、只读）不挡路（下次启动对账会再装回来，自愈）', async () => {
    // 设计定稿 §3.3：平台技能"允许卸载，下次启动对账重装"——若把内置的挂载算成
    // "使用者的引用"，使用者就永远卸不掉（内置只读、没法自己摘挂）。
    const all = await json('/api/skills')
    const target = (all.body as { skills: Array<{ id: string; slug: string }> }).skills.find(
      (s) => s.slug === 'boundary-checklist',
    )!
    const del = await json(`/api/skills/${encodeURIComponent(target.id)}`, { method: 'DELETE' })
    assert.equal(del.status, 200, `卸平台技能应成功：${JSON.stringify(del.body)}`)

    const agents = await json('/api/agents')
    const maker = (agents.body as { agents: Array<{ id: string; role: string; skillIds: string[] }> }).agents.find(
      (a) => a.role === 'agent-maker',
    )!
    assert.ok(!maker.skillIds.includes(target.id), '生成者身上的挂载要被摘掉（它只读，但平台侧摘挂）')
    const after = await json('/api/skills')
    const skillsAfter = (after.body as { skills: Array<{ slug: string }> }).skills
    assert.ok(!skillsAfter.some((s) => s.slug === 'boundary-checklist'), '那条要从技能库消失')
    assert.ok(skillsAfter.some((s) => s.slug === 'agent-design-norms'), '另外两条不受影响')
  })
})
