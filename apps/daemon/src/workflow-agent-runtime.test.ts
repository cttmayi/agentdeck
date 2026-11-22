import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * **编排内建智能体的 `runtimeKey` 真的生效**（2026-11，D241）。
 *
 * 使用者："内建智能体当然要加 agent.json，它本质就是一个智能体，只是在外面看不到
 * 而已。" 在那之前执行器的取 CLI 逻辑是：
 *
 *     const agent = await store.getAgentById(run.agentId)   // 'inline:<编排id>/<id>'
 *     if (!agent) return fallback                            // ← 内建智能体永远走这里
 *
 * 也就是说内建智能体一律跑 daemon 默认 CLI——界面上那块「用哪个 CLI」只能是假的，
 * 所以当时只能把它藏掉（而藏掉之后两列网格就塌了，D240）。
 *
 * 这条用例钉的是**修复后的契约**：执行器会去问 daemon 注入的 `inlineAgentOf`，
 * 按内建智能体自己的 `runtimeKey` 解析。判据选的是"**解析失败时的告警里点名了
 * 那条内建智能体**"——只有真的查过它，才会走到解析与告警那一步。
 *
 * ⚠️ 为什么用"未知 runtime"而不是一个真 runtime：测试里注入的假后端只对 **daemon 级**
 *   runtime 生效（NFR-T-01：测试绝不调真实 CLI）。未知 key ⇒ `resolveRuntime` 抛错
 *   ⇒ 执行器告警并回落到 daemon 级（假后端）——run 照常跑完，而告警就是证据。
 *   这也顺带钉住了"告警要说出是谁"（原来那里只写得出 `agent.xxx`，对 null 会崩）。
 */
describe('★ D241：内建智能体的 runtimeKey 被真的读', () => {
  test('★★ 未知 runtime ⇒ 告警点名那条内建智能体，并回落到 daemon 级', async () => {
    const dataDir = await makeTempDir('wf-agent-runtime')
    const workRoot = await makeTempDir('wf-agent-runtime-work')
    const warns: string[] = []
    /*
     * 先铺盘再起 daemon：内建智能体的 `agent.json` 里有 `runtimeKey: 'no-such-cli'`。
     * 工作区 id 由 `#loadWorkspaces` 的"按目录自愈"给出——所以这里只要建那个目录
     * （`workspaces/<id>/` 存在就会被登记，D226）。
     */
    const wsId = '01WSRUNTIME0000000000000001'
    await mkdir(join(dataDir, 'workspaces', wsId, 'log'), { recursive: true })
    const wfId = 'wf-runtime-1'
    await mkdir(join(dataDir, 'workflows', wfId, 'agents', '甲'), { recursive: true })
    await writeFile(
      join(dataDir, 'workflows', wfId, 'workflow.json'),
      JSON.stringify(
        {
          id: wfId,
          workspaceId: wsId,
          name: '跑 CLI 的编排',
          source: 'manual',
          templateKey: null,
          createdAt: 1,
          updatedAt: 1,
        },
        null,
        2,
      ),
      'utf8',
    )
    await writeFile(
      join(dataDir, 'workflows', wfId, 'main.js'),
      "await agent('甲').run('做点事')\n",
      'utf8',
    )
    await writeFile(
      join(dataDir, 'workflows', wfId, 'agents', '甲', 'agent.json'),
      JSON.stringify(
        {
          id: 'inline-agent-1',
          name: '甲',
          skillIds: [],
          // ★ 关键：这条内建智能体自己的 CLI
          runtimeKey: 'no-such-cli',
          createdAt: 1,
          updatedAt: 1,
        },
        null,
        2,
      ),
      'utf8',
    )
    await writeFile(
      join(dataDir, 'workflows', wfId, 'agents', '甲', 'instructions.md'),
      '你只说一句话。',
      'utf8',
    )

    const daemon = await startDaemon({
      dataDir,
      port: 0,
      fsync: false,
      // daemon 级 = generic，注入的假后端因此对它生效
      runtimeKey: 'generic',
      workRoot,
      backend: {
        key: 'generic',
        protocol: 'stream-json',
        rejectDetectable: false,
        async probe() {
          return { available: true, command: 'fake', cliVersion: '0.0.0-fake' }
        },
        async execute(opts: never) {
          const o = opts as { onCommandLine?: (l: unknown) => void; onText?: (t: string) => void }
          o.onCommandLine?.({ argv: ['fake'], sandboxDescription: '未启用沙箱（测试）' })
          o.onText?.('做完了。')
          return {
            async *[Symbol.asyncIterator]() {},
            sessionId: null,
            exitCode: 0,
          }
        },
      } as never,
      onWarn: (m) => warns.push(m),
      onInfo: () => {},
    })
    try {
      /*
       * 界面那段先钉住：这条内建智能体的 `runtimeKey` 从接口读得出来
       * （它是 agent.json 里的真字段，不是前端自己编的默认值）。
       */
      const agents = (await (await fetch(`${daemon.url}/api/workflows/${wfId}/agents`)).json()) as {
        items: Array<{ name: string; runtimeKey?: string }>
      }
      assert.equal(agents.items[0]?.runtimeKey, 'no-such-cli', 'runtimeKey 要读得回来')

      const started = await fetch(`${daemon.url}/api/workflows/${wfId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: '跑一下', workDir: workRoot }),
      })
      assert.equal(started.status, 201, `起编排失败：${await started.text()}`)

      // 等那条告警出现（run 是异步的）
      for (let i = 0; i < 100 && !warns.some((w) => w.includes('no-such-cli')); i += 1) {
        await new Promise((r) => setTimeout(r, 50))
      }
      const hit = warns.find((w) => w.includes('no-such-cli')) ?? ''
      assert.ok(hit.includes('甲'), `告警要点名那条内建智能体（实际：${hit}）`)
      assert.ok(hit.includes('no-such-cli'), `告警要说出它要的 CLI（实际：${hit}）`)
    } finally {
      await daemon.close()
      await cleanup(dataDir)
      await cleanup(workRoot)
    }
  })
})
