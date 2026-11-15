import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  WORKFLOW_TEMPLATES,
  loadWorkflowRuns,
  loadWorkflows,
  saveWorkflowRuns,
  saveWorkflows,
} from './workflows.ts'
import type { WorkflowRun } from './workflows.ts'

/**
 * 编排存储/模板测试（引擎测试在 @agentdeck/orchestration 包内——
 * 那里的 15 个用例覆盖惰性/嵌套/Reply/超轮/位置检查/幂等）。
 *
 * ★ 测试临时目录必须建在仓库内 `.cache/test-tmp`（硬约束：测试不许用系统 tmpdir）。
 */
const TMP = join(process.cwd(), '.cache', 'test-tmp', `workflows-${process.pid}`)

function freshRun(): WorkflowRun {
  return {
    id: 'run-1',
    issueId: 'iss-1',
    workflowId: 'wf-1',
    workDir: null,
    status: 'queued',
    steps: [],
    gateFeedback: null,
    taskAppend: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

test('★ 模板清单：七个固定模板都在（UI「从模板」入口的数据源）', () => {
  const keys = WORKFLOW_TEMPLATES.map((t) => t.key)
  for (const k of ['single-flow', 'sequential', 'parallel', 'loop', 'route', 'supervise', 'gate']) {
    assert.ok(keys.includes(k), `模板 ${k} 必须存在`)
  }
  // 模板代码用 v5 原语（agent 句柄 + flow/parallel/loop/route）
  const loopTpl = WORKFLOW_TEMPLATES.find((t) => t.key === 'loop')!
  assert.match(loopTpl.code, /agent\(/)
  assert.match(loopTpl.code, /loop\(/)
})

test('★ 编排存储往返（save → load）', async () => {
  await rm(TMP, { recursive: true, force: true })
  await saveWorkflows(TMP, [
    {
      id: 'wf-1',
      workspaceId: 'ws-1' as never,
      name: '测试编排',
      code: 'await flow([agent("A")], "{{task}}")',
      source: 'manual',
      templateKey: null,
      inlineAgents: [],
      createdAt: 1,
      updatedAt: 2,
    },
  ])
  const loaded = await loadWorkflows(TMP)
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0]!.name, '测试编排')
})

test('★ 运行实例存储往返（save → load）', async () => {
  await rm(TMP, { recursive: true, force: true })
  await saveWorkflowRuns(TMP, [freshRun()])
  const loaded = await loadWorkflowRuns(TMP)
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0]!.id, 'run-1')
})

test('★ 坏 JSON 不炸（读成空数组）', async () => {
  await rm(TMP, { recursive: true, force: true })
  const { mkdir } = await import('node:fs/promises')
  await mkdir(TMP, { recursive: true })
  await writeFile(join(TMP, 'workflows.json'), '{坏', 'utf8')
  const loaded = await loadWorkflows(TMP)
  assert.deepEqual(loaded, [])
})
