import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeAgent, wsId } from '@agentdeck/domain/testing'
import type { Agent, Workspace } from '@agentdeck/protocol'
import { FileStore } from './file-store.ts'
import { agentsRoot } from './agent-dirs.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * ★ 2026-11（D111）：**一个智能体 = 一个目录**——`<dataDir>/agents/<id>/`。
 *
 * 钉的是这几件事（设计定稿 `docs/design/agent-directory.md`）：
 *   · 目录形态：agent.json（结构化，**不含指令正文**）+ instructions.md（组装前）；
 *   · 独有技能 = 目录里的文件（SKILL/<slug>/SKILL.md），不进技能库；
 *   · 老 JSONL 的一次性迁移：幂等、内置带 `instructionsAssembled: true`（老记录存的是
 *     组装后全文）、`.migrated` 标记防"删了又复活"；老 jsonl **保留不删**。
 */

let dir: string
let store: FileStore
const WS = wsId('ws-agent-dirs')

before(async () => {
  dir = await makeTempDir('agent-dirs')
  store = await FileStore.open({ dataDir: dir, fsync: false })
})

after(async () => {
  await store.close()
  await cleanup(dir)
})

function mk(
  id: string,
  over: Partial<Agent> = {},
): Agent {
  return makeAgent({ id: id as Agent['id'], workspaceId: WS, name: '测试智能体', ...over })
}

/** 老工作区的落盘形状：workspaces.jsonl（wsIndex）+ workspaces/<WS>/log/agents.jsonl。 */
async function seedLegacyWorkspace(d2: string, records: Array<Agent & { id: string }>): Promise<void> {
  const now = Date.now()
  const ws: Workspace = {
    id: WS,
    name: '老工作区',
    executeTemplate: '',
    reviewTemplate: '',
    chatTemplate: '',
    defaultAgentId: null,
    locale: 'zh',
    createdAt: now,
    updatedAt: now,
  }
  await appendFile(
    join(d2, 'workspaces.jsonl'),
    JSON.stringify({ seq: 1, at: now, op: 'put', id: String(WS), value: ws }) + '\n',
  )
  const logDir = join(d2, 'workspaces', String(WS), 'log')
  await mkdir(logDir, { recursive: true })
  for (let i = 0; i < records.length; i++) {
    await appendFile(
      join(logDir, 'agent.jsonl'),
      JSON.stringify({ seq: i + 1, at: now, op: 'put', id: records[i]!.id, value: records[i] }) + '\n',
    )
  }
}

describe('一个智能体 = 一个目录（D111）', () => {
  test('★ 目录形态：agent.json 不含指令正文，instructions.md 存**组装前**正文', async () => {
    await store.insertAgent(mk('a-shape', { builtin: true, instructions: '身份块（组装前）' }))
    const json = JSON.parse(
      await readFile(join(agentsRoot(dir), 'a-shape', 'agent.json'), 'utf8'),
    ) as Record<string, unknown>
    assert.equal(json['name'], '测试智能体')
    assert.equal(json['id'], 'a-shape')
    assert.equal(json['instructions'], undefined, '结构化资讯里不许有指令正文（它在 md 里）')
    const md = await readFile(join(agentsRoot(dir), 'a-shape', 'instructions.md'), 'utf8')
    assert.equal(md, '身份块（组装前）')
  })

  test('★ 读回：instructions 恒为 md 的**组装前**正文；缺 md ⇒ 空串；缺 agent.json ⇒ null', async () => {
    await store.insertAgent(mk('a-read', { instructions: '原始正文' }))
    const got = await store.getAgent('a-read' as Agent['id'])
    assert.equal(got?.instructions, '原始正文')
    // 手工删掉 instructions.md ⇒ 空正文（不抛）
    const { rm } = await import('node:fs/promises')
    await rm(join(agentsRoot(dir), 'a-read', 'instructions.md'))
    const empty = await store.getAgent('a-read' as Agent['id'])
    assert.equal(empty?.instructions, '')
    // 目录整个不在 ⇒ null
    assert.equal(await store.getAgent('nope' as Agent['id']), null)
  })

  test('★ 独有技能：写 / 列 / 读 / 删（SKILL/<slug>/SKILL.md，不进技能库）', async () => {
    const id = 'a-exclusive' as Agent['id']
    await store.insertAgent(mk(id))
    const body = '---\nname: 私有笔记格式\ndescription: 三段式\n---\n## When to Use\n私有笔记\n## Procedure\n写三段。'
    await store.writeExclusiveSkill(id, 'private-notes', body)
    await store.writeExclusiveSkill(id, 'second-one', '# 第二条\n\n正文。')

    const listed = await store.listExclusiveSkills(id)
    assert.deepEqual(listed.map((s) => s.slug).sort(), ['private-notes', 'second-one'])
    assert.equal(listed.find((s) => s.slug === 'private-notes')?.body, body)
    assert.equal(await store.getExclusiveSkill(id, 'private-notes'), body)
    assert.equal(await store.getExclusiveSkill(id, 'missing'), null)

    // 删：记录在 ⇒ true；再删 ⇒ false（幂等）
    assert.equal(await store.removeExclusiveSkill(id, 'second-one'), true)
    assert.equal(await store.removeExclusiveSkill(id, 'second-one'), false)
    const rest = await store.listExclusiveSkills(id)
    assert.deepEqual(rest.map((s) => s.slug), ['private-notes'])

    // ★ 与技能库**完全无关**：库里一条都没有
    assert.deepEqual(await store.listSkills(WS), [])
  })

  test('★ 删智能体 = 删整个目录（连独有技能文件一起）', async () => {
    const id = 'a-remove' as Agent['id']
    await store.insertAgent(mk(id))
    await store.writeExclusiveSkill(id, 'gone-with-me', '# 陪葬技能')
    assert.equal(await store.deleteAgent(id), true)
    assert.equal(await store.getAgent(id), null)
    // 目录真的没了（连 SKILL/ 一起）
    assert.equal(
      await readFile(join(agentsRoot(dir), id, 'SKILL', 'gone-with-me', 'SKILL.md'), 'utf8').then(
        () => true,
        () => false,
      ),
      false,
    )
  })
})

describe('老 JSONL → 目录的迁移（D111）', () => {
  test('★ 老记录迁进目录：内置带 instructionsAssembled: true，自建 false；老 jsonl 保留', async () => {
    const d2 = await makeTempDir('agent-dirs-migrate')
    try {
      await seedLegacyWorkspace(d2, [
        mk('old-builtin', { builtin: true, instructions: '老内置全文（已组装）' }),
        mk('old-self', { builtin: false, instructions: '老自建全文' }),
      ])

      const s2 = await FileStore.open({ dataDir: d2, fsync: false })
      try {
        const builtin = await s2.getAgent('old-builtin' as Agent['id'])
        assert.equal(builtin?.instructions, '老内置全文（已组装）', '正文原样落 md')
        assert.equal(builtin?.instructionsAssembled, true, '老内置 = 组装后，读取端不再拼一遍')
        const self = await s2.getAgent('old-self' as Agent['id'])
        assert.equal(self?.instructionsAssembled, false, '老自建 = 组装前')
        // 目录真的在（迁移产物）
        assert.ok(
          await readFile(join(agentsRoot(d2), 'old-builtin', 'agent.json'), 'utf8').then(
            () => true,
            () => false,
          ),
        )
        // 老 jsonl 保留不删（等使用者确认后再删）
        const kept = await readFile(join(d2, 'workspaces', String(WS), 'log', 'agent.jsonl'), 'utf8')
        assert.ok(kept.includes('old-builtin'), '老 jsonl 保留')
        // 标记写出来了
        const marker = await readFile(join(agentsRoot(d2), '.migrated'), 'utf8')
        assert.ok(marker.includes('v'), '.migrated 标记要写出来')
      } finally {
        await s2.close()
      }

      // 幂等：再 open 一字不动（有标记 ⇒ 不重迁）
      const s3 = await FileStore.open({ dataDir: d2, fsync: false })
      try {
        assert.equal((await s3.getAgent('old-builtin' as Agent['id']))?.instructions, '老内置全文（已组装）')
      } finally {
        await s3.close()
      }
    } finally {
      await cleanup(d2)
    }
  })

  test('★★ 删掉的智能体**不复活**（.migrated 标记防"老 jsonl 还在 ⇒ 重迁"）', async () => {
    const d2 = await makeTempDir('agent-dirs-zombie')
    try {
      await seedLegacyWorkspace(d2, [mk('old-zombie', { instructions: '老正文' })])

      // 第一轮：open ⇒ 迁移 → 删掉它 → 关
      const s1 = await FileStore.open({ dataDir: d2, fsync: false })
      try {
        assert.ok(await s1.getAgent('old-zombie' as Agent['id']), '迁移后存在')
        await s1.deleteAgent('old-zombie' as Agent['id'])
      } finally {
        await s1.close()
      }

      // 第二轮：open ⇒ 老 jsonl 里那行还在，但标记在 ⇒ 不许复活
      const s2 = await FileStore.open({ dataDir: d2, fsync: false })
      try {
        assert.equal(await s2.getAgent('old-zombie' as Agent['id']), null, '删掉的不许被老记录复活')
      } finally {
        await s2.close()
      }
    } finally {
      await cleanup(d2)
    }
  })
})
