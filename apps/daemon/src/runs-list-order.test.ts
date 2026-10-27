/**
 * ★ 分批第 72 批：`GET /api/runs` 必须是**最近的一页**（这条测试来自一个真 bug）。
 *
 * 使用者报的原话：「发现用 URL 启动的任务，在任务列表中，一直显示『执行中』」。
 *
 * 查下来不是新接口的问题：`GET /api/runs` 原先请求 `limit: 100`，而翻页实现是
 * 「按 id 升序取前 100 条」——run 的 id 是 ULID（字典序 = 时间序），于是返回的是
 * **最老的 100 条**。本机实测那个工作区有 **445 条 run**，接口给的"最新"一条是
 * **45 天前**的：最近 45 天的 run 一条都返回不到。
 *
 * 任务看板的阶段推导（`apps/web/src/lib/pipeline.ts` 的 `deriveStage`）只看这个
 * 列表：看不到 run ⇒ 落到"一条执行 run 都还没有"那一档 ⇒ 标签是「执行中」。
 * 于是**最近建的任务一律显示执行中**，哪怕它早就 failed——不报错、不告警，
 * 刷新一次就复现。
 *
 * ⚠️ 这条不是"只有 API 任务会中"：任何新任务的 run 都在那 345 条尾巴里。
 *    API 任务只是让人第一次注意到它（它是全新的、一定落在尾巴里）。
 *
 * 判据：往临时数据目录里**先塞 150 条 run**（直接写 store，不执行任何东西），
 * 再起 daemon，然后看接口给的是不是**最新的那 100 条**。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { FileStore } from '@agentdeck/store-file'
import { makeRun } from '@agentdeck/domain/testing'
import { wsId } from '@agentdeck/domain/testing'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

const WS = wsId('ws-list-order')
/** 180 条：跨过 `GET /api/runs` 的 limit(100)，让"最老的会被截掉"这件事一定发生。 */
const TOTAL = 180

async function withSeededDaemon<T>(
  fn: (url: string, ids: string[]) => Promise<T>,
): Promise<T> {
  const dataDir = await makeTempDir('runs-list-order')
  const now = Date.now()
  const seed = await FileStore.open({ dataDir, fsync: false })
  await seed.insertWorkspace({
    executeTemplate: '',
    reviewTemplate: '',
    chatTemplate: '',
    defaultAgentId: null,
    locale: 'zh',
    id: WS,
    name: '默认工作区',
    createdAt: now,
    updatedAt: now,
  })
  const ids: string[] = []
  for (let i = 0; i < TOTAL; i += 1) {
    // id 递增 = 时间递增（与 ULID 一样），最老的是 run-000
    const id = `run-${String(i).padStart(3, '0')}`
    ids.push(id)
    await seed.insertRun(
      makeRun({
        id,
        workspaceId: WS,
        agentId: 'agent-1',
        // 每条挂一个任务，顺便让"按 subject 归到任务上"那条路也走得通
        subject: { type: 'issue', id: `issue-${String(i).padStart(3, '0')}` },
        status: 'completed',
        queuedAt: now - (TOTAL - i) * 1000,
      }),
    )
  }
  await seed.close()

  const d = await startDaemon({
    dataDir,
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
        throw new Error('这条测试不该执行任何 run')
      },
    } as never,
    onWarn: () => {},
    onInfo: () => {},
  })
  try {
    return await fn(d.url, ids)
  } finally {
    await d.close()
    await cleanup(dataDir)
  }
}

describe('★ GET /api/runs：看板能算出每个任务的阶段（bug 的修复点）', () => {
  test('★★★ 一页里既有最新的、也有最老的（截断本身就是病）', async () => {
    await withSeededDaemon(async (url, ids) => {
      const body = (await (await fetch(`${url}/api/runs`)).json()) as {
        runs: Array<{ runId: string; queuedAt: number }>
      }
      const got = body.runs.map((r) => r.runId)
      assert.equal(body.runs[0]!.runId, ids[TOTAL - 1], '★ 第一条必须是最新的那条 run')
      assert.ok(got.includes(ids[0]!), '★ 最老的也得在——只给"最近 100 条"会反过来坑老任务')
      assert.equal(body.runs.length, TOTAL, '一页里所有 run 都要在（上限 10_000，见 RUNS_LIST_LIMIT）')
      // 顺序：queuedAt 新→旧
      for (let i = 1; i < body.runs.length; i += 1) {
        assert.ok(body.runs[i]!.queuedAt <= body.runs[i - 1]!.queuedAt, '列表必须按时间新→旧')
      }
    })
  })

  test('★★★ 每条任务的**最新那条 run** 都在这一页里（阶段推导的前提）', async () => {
    /*
     * 这条是那个 bug 的真正判据，而且它**不依赖界面代码**：
     * `deriveStage`（`apps/web/src/lib/pipeline.ts`）以"该任务最新的执行 run"为锚点。
     * 只要这条 run 不在列表里，它就落到"还没有执行"那一档 ⇒ 标签「执行中」。
     *
     * ⚠️ 我最初把它写成"import stageOf 然后断言 stage"，跑起来是对的，但**类型检查
     *    立刻红了**：从 daemon 的类型检查程序里 import 界面代码，会把一批需要 DOM 类型
     *    的文件拖进来（`packages/ui/src/theme.ts` 里的 `window`）。跨 app import 在
     *    `node --test` 下能跑，但会破坏 `pnpm run typecheck`——所以判据改成表达
     *    **界面所依赖的那个事实**，而不是 import 界面本身。
     */
    await withSeededDaemon(async (url) => {
      const seed = await FileStore.open({ dataDir: await makeTempDir('runs-order-truth'), fsync: false })
      await seed.close()

      const body = (await (await fetch(`${url}/api/runs`)).json()) as {
        runs: Array<{ runId: string; subject: { type: string; id: string } }>
      }
      const byIssue = new Map<string, string[]>()
      for (const run of body.runs) {
        if (run.subject.type !== 'issue') continue
        const list = byIssue.get(run.subject.id) ?? []
        list.push(run.runId)
        byIssue.set(run.subject.id, list)
      }
      // 每条任务都该有 run；而且它那几条里**最新的那条**必须在列表里（就是它自己）
      assert.equal(byIssue.size, TOTAL, '每条任务都该在列表里看到自己的 run')
      for (let i = 0; i < TOTAL; i += 1) {
        const issueId = `issue-${String(i).padStart(3, '0')}`
        const ids = byIssue.get(issueId)
        assert.deepEqual(ids, [`run-${String(i).padStart(3, '0')}`], `${issueId} 的 run 必须能查到`)
      }
    })
  })
})

/**
 * ★ 顺带修掉的**死接口**：CLI 的 `runs --limit N` 一直发 `?limit=N`，而这条路由
 * 从来没读过它（参数被静默忽略，永远返回写死的数）。既然这一行这次要改，就接上，
 * 并且越界**明确 400**——静默夹到边界会让"我要 5 条"变成"给你 10 条"。
 */
describe('★ ?limit= 真的生效（原来是个死参数）', () => {
  test('limit=7 ⇒ 7 条；越界/非整数 ⇒ 400', async () => {
    await withSeededDaemon(async (url) => {
      const five = (await (await fetch(`${url}/api/runs?limit=7`)).json()) as { runs: unknown[] }
      assert.equal(five.runs.length, 7)

      for (const bad of ['0', '-3', '10001', 'abc', '2.5']) {
        const res = await fetch(`${url}/api/runs?limit=${bad}`)
        assert.equal(res.status, 400, `limit=${bad} 该被拒`)
        assert.equal(((await res.json()) as { code?: string }).code, 'runs_limit_invalid')
      }
    })
  })
})
