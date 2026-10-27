import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 全局 runtime 默认值（2026-10，定稿第 ⑦ 条）：三级解析
 * `agent 的值 ⇒ workspace.defaultRuntimeKey ⇒ 启动时侦测到的那个`。
 *
 * 为什么三级都要有：使用者想"默认都用 claude"时不必逐个 agent 改；某个 agent 要例外
 * 必须能就地覆盖；而没设过的人不该被迫先做一次选择（缺省跟随侦测）。
 *
 * ⚠️ 这两条判据在**接口层**，因为最容易错的地方是**入口的缺省值**：新建 agent 时若把
 *    当时的默认"烙"进记录（老行为写死 `'claude'`），使用者后来改了全局默认，这些 agent
 *    不会跟着变——而"默认"这个词就成了谎话，且没人会去怀疑一条已经存好的记录。
 */

async function withDaemon<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir('agent-runtime-default')
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

describe('全局 runtime 默认值：入口缺省是 default、设定可改、空串 = 跟随侦测', () => {
  test('★ 新建 agent 不带 runtimeKey ⇒ 记 `default`（**不烙**当时的默认值）', async () => {
    await withDaemon(async (url) => {
      const res = await fetch(`${url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '新执行者', instructions: '干活', role: 'executor' }),
      })
      // ⚠️ 响应体只能读一次：先 `text()` 断言状态（失败时要看得到 body），再 `JSON.parse`。
      //    写成 `assert.equal(res.status, 201, await res.text())` + `await res.json()`
      //    会抛 `Body is unusable: Body has already been read`——那个错看起来像接口坏了。
      const text = await res.text()
      assert.equal(res.status, 201, text)
      // ⚠️ POST /api/agents 返回的是**agent 本体**（不是 `{agent}` 包一层）——
      //    我按别的接口的样子猜了 `{agent}`，于是拿到 `undefined` 再读属性就崩了。
      const agent = JSON.parse(text) as { runtimeKey: string }
      assert.equal(agent.runtimeKey, 'default')
    })
  })

  test('★ 内置起草者也记 `default`（它应当最跟随平台设置）', async () => {
    await withDaemon(async (url) => {
      const body = (await (await fetch(`${url}/api/agents`)).json()) as {
        agents: { runtimeKey: string; role: string; builtin?: boolean }[]
      }
      // ⚠️ 判据是**角色**：内置有两条（起草者 + skill 审核者），按 `builtin` 挑会挑到
      //    先出现的那条（第 70 批量的），于是这条用例可能在测审核者的 runtimeKey。
      const drafter = body.agents.find((a) => a.role === 'drafter')
      assert.ok(drafter)
      assert.equal(drafter.runtimeKey, 'default')
    })
  })

  test('★ 设定可改：存得下、读得出、并回报"侦测到的那个"', async () => {
    await withDaemon(async (url) => {
      const res = await fetch(`${url}/api/workspace/default-runtime`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtimeKey: 'codex' }),
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      const out = JSON.parse(text) as { runtimeKey: string; detected: string }
      assert.equal(out.runtimeKey, 'codex')
      assert.equal(out.detected, 'claude', '侦测到的那个要回报出去（界面要显示它）')
    })
  })

  test('★ 空串 = 跟随侦测（能表达"回到自动"，否则使用者只能猜一个值填进去）', async () => {
    await withDaemon(async (url) => {
      const res = await fetch(`${url}/api/workspace/default-runtime`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtimeKey: '' }),
      })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      const out = JSON.parse(text) as { runtimeKey: string }
      assert.equal(out.runtimeKey, '')
    })
  })

  test('★★ 拼错的 runtime 明确拒绝（静默存下会把故障推迟到某个 run 启动时）', async () => {
    await withDaemon(async (url) => {
      const res = await fetch(`${url}/api/workspace/default-runtime`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtimeKey: 'claud' }),
      })
      assert.equal(res.status, 400)
      const body = (await res.json()) as { error: string }
      assert.match(body.error, /未知的 runtime/)
    })
  })
})
