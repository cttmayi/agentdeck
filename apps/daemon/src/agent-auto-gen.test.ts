import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * **智能体生成者整条链**（2026-11，D256）——与 D255（编排）同一张图纸，端到端钉四件事：
 *
 *   ① **资料落盘**：给智能体生成者起一轮对话之后，工作目录里有 `material/agent/`；
 *   ② **预检**：出现候选（`agent-draft/<岗位名>/`）时，对话详情带上 `agentCandidates`；
 *   ③ **入库**：`POST …/agent-adopt` 建智能体 + 把配套技能落成它的**独有技能**；
 *   ④ **同名不覆盖 + 只有生成者的对话能入库**：409 / 400，两句原话都要说清楚。
 *
 * 为什么走真 HTTP：价值的全部在"落盘 → 预检 → 入库"能接上——单测每段都绿而中间断开，
 * 正是本仓库最常见的那类缺陷。
 */

async function writeCandidate(workDir: string, dirName: string): Promise<void> {
  const base = join(workDir, 'agent-draft', dirName)
  await mkdir(join(base, 'skills', 'meeting-notes-format'), { recursive: true })
  await writeFile(
    join(base, 'agent.json'),
    JSON.stringify({ name: dirName, runtimeKey: 'default' }),
    'utf8',
  )
  await writeFile(
    join(base, 'instructions.md'),
    '你是会议纪要助理。\n\n## 边界（不能碰）\n- 只在工作目录里读写文件。\n',
    'utf8',
  )
  await writeFile(
    join(base, 'skills', 'meeting-notes-format', 'SKILL.md'),
    [
      '---',
      'name: meeting-notes-format',
      'description: 会议纪要的固定形状（探针夹具）',
      '---',
      '',
      '# 纪要格式',
      '',
      '结论 → 待办 → 未决。',
    ].join('\n'),
    'utf8',
  )
}

describe('★ D256：智能体生成者（资料落盘 → 候选预检 → 生成智能体）', () => {
  test('★★ 一条链走通：资料在、候选在、入库成、同名 409、非生成者 400', async () => {
    const dataDir = await makeTempDir('agent-autogen')
    const workRoot = await makeTempDir('agent-autogen-work')
    const daemon = await startDaemon({
      dataDir,
      port: 0,
      fsync: false,
      runtimeKey: 'generic',
      workRoot,
      backend: {
        key: 'generic',
        protocol: 'stream-json',
        rejectDetectable: false,
        async probe() {
          return { available: true, command: 'fake', cliVersion: '0.0.0-fake' }
        },
        async execute() {
          return { async *[Symbol.asyncIterator]() {}, sessionId: null, exitCode: 0 }
        },
      } as never,
      onWarn: () => {},
      onInfo: () => {},
    })
    try {
      const agents = (await (await fetch(`${daemon.url}/api/agents`)).json()) as {
        agents: Array<{ id: string; name: string; instructions?: string }>
      }
      const maker = agents.agents.find((a) => a.name === '智能体生成者')
      assert.ok(maker, '启动对账应当建出「智能体生成者」')
      // ① 身份只留"先读资料"的指针（写法细节在资料里）
      assert.ok(
        (maker.instructions ?? '').includes('material/agent/README.md'),
        '身份里要指向资料包',
      )
      assert.ok(
        !(maker.instructions ?? '').includes('agent-draft.md'),
        '身份里不该再教旧的岗位卡 md 写法',
      )

      const created = (await (
        await fetch(`${daemon.url}/api/conversations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: maker.id, text: '' }),
        })
      ).json()) as { conversation: { id: string } }
      const convId = created.conversation.id
      const turn = await fetch(`${daemon.url}/api/conversations/${convId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '帮我把会议纪要写成一份岗位' }),
      })
      assert.equal(turn.status, 202)

      // ① 资料落盘
      const workDir = join(workRoot, `chat-${convId}`)
      assert.ok(existsSync(join(workDir, 'material', 'agent', 'shape.md')), 'material/agent/shape.md 要落盘')
      assert.ok(existsSync(join(workDir, 'material', 'agent', 'norms.md')), 'norms.md 要落盘')

      // ② 候选 → 对话详情
      await writeCandidate(workDir, '会议纪要助理')
      const detail = (await (await fetch(`${daemon.url}/api/conversations/${convId}`)).json()) as Record<string, unknown>
      const candidates = detail['agentCandidates'] as Array<Record<string, unknown>>
      assert.equal(candidates.length, 1)
      assert.equal(candidates[0]?.['name'], '会议纪要助理')
      assert.equal((candidates[0]?.['skills'] as unknown[]).length, 1)
      assert.equal((candidates[0]?.['problems'] as unknown[]).length, 0, '这条候选应当是干净的')

      // ③ 入库
      const adopt = await fetch(`${daemon.url}/api/conversations/${convId}/agent-adopt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: '会议纪要助理' }),
      })
      const adoptBody = await adopt.text()
      assert.equal(adopt.status, 201, adoptBody)
      const adopted = JSON.parse(adoptBody) as {
        agent: { id: string; name: string; runtimeKey: string }
        exclusiveNames: string[]
      }
      assert.equal(adopted.agent.name, '会议纪要助理')
      assert.equal(adopted.agent.runtimeKey, 'default')
      assert.deepEqual(adopted.exclusiveNames, ['meeting-notes-format'], '配套技能落成独有技能')
      // 库里那条的形状：agents/<名字>/…（与工作区智能体同形）
      const agentFiles = await (await fetch(`${daemon.url}/api/agents/${adopted.agent.id}`)).json() as {
        instructions?: string
        memoryEnabled?: boolean
      }
      assert.ok((agentFiles.instructions ?? '').includes('边界'), '指令原样存进库里')
      const exclusive = (await (
        await fetch(`${daemon.url}/api/agents/${adopted.agent.id}/skills`)
      ).json()) as { skills?: Array<{ name: string }> }
      assert.deepEqual(
        (exclusive.skills ?? []).map((s) => s.name),
        ['meeting-notes-format'],
        '独有技能读得回来',
      )

      // ④ 同名：409（不覆盖已有的智能体）
      const again = await fetch(`${daemon.url}/api/conversations/${convId}/agent-adopt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: '会议纪要助理' }),
      })
      assert.equal(again.status, 409)
      const conflict = (await again.json()) as { code?: string; error?: string }
      assert.equal(conflict.code, 'agent_name_taken')
      assert.ok((conflict.error ?? '').includes('改个名'), '要说清怎么办：改名或先删旧的')

      // ④ 非生成者的对话：400
      const other = agents.agents.find((a) => a.name !== '智能体生成者')
      assert.ok(other)
      const otherConv = (await (
        await fetch(`${daemon.url}/api/conversations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: other.id, text: '' }),
        })
      ).json()) as { conversation: { id: string } }
      const denied = await fetch(
        `${daemon.url}/api/conversations/${otherConv.conversation.id}/agent-adopt`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dir: '会议纪要助理' }),
        },
      )
      assert.equal(denied.status, 400)
      assert.equal(((await denied.json()) as { code?: string }).code, 'agent_adopt_not_maker')

      // 收尾：确认没有把"没有候选"的对话误判成有候选
      const otherDetail = (await (
        await fetch(`${daemon.url}/api/conversations/${otherConv.conversation.id}`)
      ).json()) as Record<string, unknown>
      assert.equal((otherDetail['agentCandidates'] as unknown[]).length, 0)
    } finally {
      await daemon.close()
      await cleanup(dataDir)
      await cleanup(workRoot)
    }
  })
})
