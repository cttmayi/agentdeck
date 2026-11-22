import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * **编排生成者的整条链**（2026-11，D255）——端到端钉四件事：
 *
 *   ① **资料落盘**：给编排生成者起一轮对话之后，工作目录里有 `material/orchestration/`
 *      （使用者：写法要"以资料的形式动态输入到工作目录"）；
 *   ② **预检**：工作目录里出现候选（`workflow-draft/<名字>/`）时，对话详情带上
 *      `workflowCandidates`（界面据此画卡片）；
 *   ③ **入库**：`POST …/workflow-adopt` 把目录搬成一条编排（`source: 'ai'`、`apiVersion`、
 *      `origin`），同名先 409，带覆盖意图才替换；
 *   ④ **只有生成者的对话能入库**：别的 agent 的对话一律 400——不替任何人背书。
 *
 * 为什么走真 HTTP：这条链的价值全在"三个环节接得上"（落盘 → 预检 → 入库），
 * 单测每一段都绿而中间接不上，正是本仓库最常见的那类缺陷。
 */

/** 在对话的工作目录里铺一个候选（工作目录名 = `chat-<对话id>`，见 `resolveWorkDir`）。 */
async function writeCandidate(workDir: string, name: string): Promise<void> {
  const dir = join(workDir, 'workflow-draft', name)
  await mkdir(join(dir, 'agents', '写作员'), { recursive: true })
  await writeFile(
    join(dir, 'workflow.json'),
    JSON.stringify({ name, summary: '取数→成稿→你过目' }),
    'utf8',
  )
  await writeFile(
    join(dir, 'main.js'),
    "const 写作 = agent('写作员')\nconst r = await flow([写作], '{{task}}')\nreturn r.message\n",
    'utf8',
  )
  await writeFile(join(dir, 'agents', '写作员', 'agent.json'), JSON.stringify({ name: '写作员' }), 'utf8')
  await writeFile(join(dir, 'agents', '写作员', 'instructions.md'), '你是写作员：按要点写周报。', 'utf8')
}

interface Json {
  [k: string]: unknown
}

describe('★ D255：资料落盘 → 候选预检 → 收进编排库（端到端）', () => {
  test('★★ 一条链走通：资料在、候选在、入库成、同名 409、覆盖同 id、非生成者 400', async () => {
    const dataDir = await makeTempDir('wf-autogen')
    const workRoot = await makeTempDir('wf-autogen-work')
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
      const maker = agents.agents.find((a) => a.name === '编排生成者')
      assert.ok(maker, '启动对账应当建出「编排生成者」')
      /*
       * ① 身份里不再有 API 清单，只有"先读资料"的指针
       *   （使用者：「由于 workflow 的代码形式会经常变化，最好以资料的形式动态输入」）。
       */
      assert.ok(
        (maker.instructions ?? '').includes('material/orchestration/README.md'),
        '身份里要指向资料包',
      )
      assert.ok(
        !(maker.instructions ?? '').includes('reuseOutput'),
        '身份里不该再罗列 API 细节（那些在资料里）',
      )

      // 建一条空对话（不带第一句话 ⇒ 不跑 run），再补一轮，让 run 真的起来
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
        body: JSON.stringify({ text: '帮我做一条周报流程' }),
      })
      assert.equal(turn.status, 202, '这一轮要真的跑起来（假后端）')

      // ① 资料落盘到工作目录
      const workDir = join(workRoot, `chat-${convId}`)
      const seeded = join(workDir, 'material', 'orchestration')
      assert.ok(existsSync(join(seeded, 'api.md')), 'material/orchestration/api.md 要落盘')
      assert.ok(existsSync(join(seeded, 'api-version.json')), 'api-version.json 要落盘')
      const index = await readFile(join(workDir, 'material', 'README.md'), 'utf8')
      assert.ok(index.includes('orchestration'), '索引里写明这次是哪一包')

      // ② 铺一个候选 ⇒ 对话详情带 workflowCandidates
      await writeCandidate(workDir, '周报流水线')
      const detail = (await (await fetch(`${daemon.url}/api/conversations/${convId}`)).json()) as Json
      const candidates = detail['workflowCandidates'] as Array<Json>
      assert.equal(candidates.length, 1)
      assert.equal(candidates[0]?.['name'], '周报流水线')
      assert.equal((candidates[0]?.['problems'] as unknown[]).length, 0, '这条候选应当是干净的')
      assert.equal((candidates[0]?.['agents'] as unknown[]).length, 1)

      // ③ 入库
      const adopt = await fetch(`${daemon.url}/api/conversations/${convId}/workflow-adopt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: '周报流水线' }),
      })
      const adoptBody = await adopt.text()
      assert.equal(adopt.status, 201, adoptBody)
      const adopted = JSON.parse(adoptBody) as { workflow: { id: string; name: string } }
      const wfDir = join(dataDir, 'workflows', adopted.workflow.id)
      const wfJson = JSON.parse(await readFile(join(wfDir, 'workflow.json'), 'utf8')) as Json
      assert.equal(wfJson['source'], 'ai')
      assert.equal(wfJson['name'], '周报流水线')
      assert.equal(wfJson['origin'], `conversation:${convId}`)
      assert.equal(typeof wfJson['apiVersion'], 'string', '要记下按哪一版写法写的')
      assert.ok(existsSync(join(wfDir, 'main.js')), '代码在 main.js')
      assert.ok(existsSync(join(wfDir, 'agents', '写作员', 'instructions.md')), '内建人跟着搬')

      // 同名再收一次 ⇒ 409（先问人）
      const again = await fetch(`${daemon.url}/api/conversations/${convId}/workflow-adopt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: '周报流水线' }),
      })
      assert.equal(again.status, 409)
      const conflict = (await again.json()) as { code?: string; existing?: { id?: string } }
      assert.equal(conflict.code, 'workflow_name_taken')
      assert.equal(conflict.existing?.id, adopted.workflow.id)

      // 带上覆盖意图 ⇒ 201，id 不变
      const overwrite = await fetch(`${daemon.url}/api/conversations/${convId}/workflow-adopt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dir: '周报流水线',
          overwrite: true,
          existingId: adopted.workflow.id,
        }),
      })
      const overwriteBody = await overwrite.text()
      assert.equal(overwrite.status, 201, overwriteBody)
      const after = JSON.parse(overwriteBody) as { workflow: { id: string } }
      assert.equal(after.workflow.id, adopted.workflow.id, '覆盖是原地替换（id 不变）')

      // 编排列表里只有一条（覆盖没有多出一条）
      const list = (await (await fetch(`${daemon.url}/api/workflows`)).json()) as { items: Array<Json> }
      assert.equal(list.items.filter((w) => w['name'] === '周报流水线').length, 1)

      // ④ 非生成者的对话：400（不替别的 agent 背书）
      const other = agents.agents.find((a) => a.name !== '编排生成者')
      assert.ok(other)
      const otherConv = (await (
        await fetch(`${daemon.url}/api/conversations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: other.id, text: '' }),
        })
      ).json()) as { conversation: { id: string } }
      const denied = await fetch(
        `${daemon.url}/api/conversations/${otherConv.conversation.id}/workflow-adopt`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dir: '周报流水线' }),
        },
      )
      assert.equal(denied.status, 400)
      const deniedBody = (await denied.json()) as { code?: string }
      assert.equal(deniedBody.code, 'workflow_adopt_not_maker')
    } finally {
      await daemon.close()
      await cleanup(dataDir)
      await cleanup(workRoot)
    }
  })
})
