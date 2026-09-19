import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Tool } from '@alpha-helper/protocol'
import { RemoteService } from '../../remote/src/server.ts'
import { startDaemon } from './server.ts'
import { makeTempDir } from './testing/tmp.ts'

/**
 * 远端目录 ⇒ 本机安装（D40）的**跨边界**那一步。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么值得单独一条：这是唯一"两边都以为自己对了"的地方
 * ══════════════════════════════════════════════════════════════════
 *
 * 远端侧与 daemon 侧各有自己的测试，但它们各测各的**同一份** schema 的理解。
 * 真正会出事的是**两边不一致**：远端按 A 列出内容、daemon 按 B 解析，
 * 症状是"装进来的包少了一个动作"——没有报错、没有堆栈，只有一处功能静静地
 * 不工作（这类问题在本仓库出现过多次，所以要一条测试把两端焊在一起）。
 *
 * 这条测试做的事与真实链路**逐步相同**：
 *
 *   ① 起一个远端服务（目录里有一个可装的范例 `hello-tool`）；
 *   ② 页面那样 `GET /api/catalog` 取回条目（含清单与脚本原文）；
 *   ③ 页面那样 `POST /api/tools {source:'payload'}` 交给本机 daemon；
 *   ④ 断言装进来的那一条**动作名、参数、入口**与远端那份逐字一致。
 *
 * 用的是两个真实进程内的服务（都绑回环），没有桩。
 */

describe('D40：从远端目录装一个工具包', () => {
  test('★ 远端列出的内容 ⇒ 本机装上 ⇒ 动作名与参数逐字一致', async () => {
    const daemonDir = await makeTempDir('remote-tool-daemon')
    const remoteDir = await makeTempDir('remote-tool-remote')
    const remote = new RemoteService({ dataDir: remoteDir, port: 0 })
    const remotePort = await remote.start()
    const remoteUrl = `http://127.0.0.1:${remotePort}`
    const daemon = await startDaemon({
      dataDir: daemonDir,
      port: 0,
      fsync: false,
      workRoot: `${daemonDir}/work`,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      // ── ① 远端目录（公开接口，不需要登录） ──
      const catalogRes = await fetch(`${remoteUrl}/api/catalog`)
      assert.equal(catalogRes.status, 200)
      const catalog = (await catalogRes.json()) as {
        tools: Array<{
          slug: string
          version: string | null
          manifest: Record<string, unknown>
          files: Record<string, string>
          docs: string
        }>
      }
      const entry = catalog.tools.find((t) => t.slug === 'hello-tool')
      assert.ok(entry, '远端目录里应当有范例 hello-tool')

      // ── ② 页面把条目原样交给本机 daemon（`source: 'payload'`） ──
      const installRes = await fetch(`${daemon.url}/api/tools`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'payload',
          slug: entry.slug,
          manifest: entry.manifest,
          files: entry.files,
          docs: entry.docs,
          version: entry.version,
          sourceRef: `remote:${entry.slug}@${entry.version}`,
        }),
      })
      const installText = await installRes.text()
      assert.ok(installRes.ok, `从远端目录装应当成功，实际 ${installRes.status}：${installText.slice(0, 400)}`)
      const installed = (JSON.parse(installText) as { tool: Tool }).tool

      // ── ③ 逐字对照：名字、版本、动作、参数、入口、文件 ──
      assert.equal(installed.slug, entry.slug)
      assert.equal(installed.version, entry.version)
      assert.equal(installed.source, 'remote', '来源要记成 remote（否则"本地自有"与"远端来的"分不清）')
      assert.equal(installed.sourceRef, `remote:${entry.slug}@${entry.version}`)
      assert.equal(installed.manifest.schema, 'alpha-helper/tool@1')
      assert.deepEqual(
        installed.manifest.actions.map((a) => a.name),
        ['say'],
        '★ 动作名就是判决里要写的那个（远端说 A、daemon 按 B 会在这里露出来）',
      )
      const action = installed.manifest.actions[0]!
      assert.equal(action.dryRun, 'supported', '演练能力要如实传下来（它决定能不能自动执行）')
      assert.deepEqual(Object.keys(action.params.bound), ['dir'], '绑定参数：模型看不见的那个')
      assert.deepEqual(Object.keys(action.params.open), ['message'], '开放参数：模型要填的那个')
      assert.equal(installed.manifest.entry, 'scripts/say.mjs')
      assert.ok('scripts/say.mjs' in installed.files, '入口脚本必须装进来，否则动作跑不起来')
      assert.match(installed.docs, /hello-tool/, 'TOOL.md 的正文要留下（界面上要显示）')

      // ── ④ 装进来的这条**真的能被执行**：拿执行器直接跑一次（dry-run） ──
      //   这一步比"字段对了"更强：它证明脚本与清单的约定没有断。
      const { createScriptExecutor } = await import('./script-executor.ts')
      const { toolActionDefinitions } = await import('@alpha-helper/domain')
      const definitions = toolActionDefinitions([installed])
      const definition = definitions['hello-tool.say']
      assert.ok(definition, '装进来之后应当能解析出这个动作')

      const executor = createScriptExecutor({ tempRoot: `${daemonDir}/tool-tmp` })
      const result = await executor({
        action: {
          type: 'hello-tool.say',
          slug: installed.slug,
          runtime: 'node',
          entry: 'scripts/say.mjs',
          dryRun: 'supported',
          timeoutMs: 10_000,
          provider: { slug: installed.slug, version: installed.version },
        },
        params: { dir: daemonDir, message: '来自远端目录的问候' },
        dryRun: true,
        context: { workdir: daemonDir, runId: null, workspaceId: null },
        files: installed.files,
      } as never)
      assert.equal(result.ok, true, `远端装进来的脚本应当能跑：${result.detail}`)
      assert.match(result.detail, /dry-run/, 'dry-run 时脚本只说"会做什么"，不真的写')
    } finally {
      await daemon.close()
      await remote.close()
    }
  })
})
