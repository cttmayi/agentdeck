import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@agentdeck/agent-core'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 对话级的工作目录（`GET /api/conversations/:id/files` 与 `/file`）——端到端。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要单独有这一份（函数级测试已经有了）
 * ══════════════════════════════════════════════════════════════════
 *
 * `workdir-files.test.ts` 钉住的是"守卫写对了"（`..`、软链、上限、排序、注入物
 * 判定），那些是**函数**的性质。这一份钉的是**这条路由**的性质，而路由上特有的
 * 风险恰好是最容易漏的两条：
 *
 *   1. **目录从哪来**：按 run 问的那条用 `run.workDir`，按对话问的这条要用
 *      `resolveWorkDir`——**与出 run 时同一个函数**。两处各算一次，界面上显示的
 *      路径就会与它真正干活的路径分叉，而分叉的表现是"这一栏列的是别的目录"。
 *   2. **"目录还不存在"要说出来**：聊天第一轮之前正是这一档，而它与"存在但是空的"
 *      都是空列表（`exists` 就是为这件事加的）。
 *
 * 所以这里的用例都尽量走**真 HTTP + 真服务端**，只把 CLI 换成一个假后端。
 */

/** 立刻成功的假后端：这里量的是文件那一栏，不是 agent 说了什么。 */
class QuietBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(_opts: ExecOptions): Promise<AgentSession> {
    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: '好。' })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: '好。',
        durationMs: 1,
        sessionId: 'files-session',
        usage: { inputTokens: 1, outputTokens: 1, costUsdMicros: 0, costSource: 'provider' },
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
let workRoot: string
let daemon: DaemonHandle
let agentId = ''

const json = async (path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${daemon.url}${path}`, init)
  const text = await res.text()
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

const postJson = (path: string, body: unknown) =>
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

interface Listing {
  workDir: string
  dir: string
  entries: Array<{
    path: string
    name: string
    kind: 'file' | 'dir'
    sizeBytes: number
    hasChildren: boolean
    managed: boolean
  }>
  truncated: boolean
  exists: boolean
}

/**
 * 建一个对话，并把它的工作目录**拿回来**（用的是接口自己报出来的路径）。
 *
 * ⚠️ 不自己拼 `<workRoot>/chat-<id>`：那样这一份测试就成了"我算的路径等于我算的
 *    路径"，而"界面显示的路径与它真正干活的路径是不是同一个"恰恰是要钉住的事。
 *    这里从**响应**里读路径，再往那个目录里放文件——放进去的东西真的被列出来，
 *    才说明两边算的是同一个目录。
 */
async function makeConversation(): Promise<{ id: string; dir: string }> {
  const created = await postJson('/api/conversations', {
    agentId,
    text: '给我一个目录',
    workDir: await makeTempDir('conv-files-wd'),
  })
  assert.equal(created.status, 201, `建对话失败：${JSON.stringify(created.body)}`)
  const conversation = (created.body as { conversation: { id: string } }).conversation
  const turn = (created.body as { turn: { runId: string } }).turn
  await waitForTerminal(turn.runId)
  const listing = await json(`/api/conversations/${conversation.id}/files`)
  assert.equal(listing.status, 200, `列目录失败：${JSON.stringify(listing.body)}`)
  return { id: conversation.id, dir: (listing.body as Listing).workDir }
}

before(async () => {
  dataDir = await makeTempDir('conv-files-data')
  workRoot = await makeTempDir('conv-files-root')
  daemon = await startDaemon({
    dataDir,
    workRoot,
    port: 0,
    fsync: false,
    backend: new QuietBackend(),
    onWarn: () => {},
    onInfo: () => {},
  })
  const agents = await json('/api/agents')
  const list = (agents.body as { agents: Array<{ id: string; role: string }> }).agents
  agentId = list.find((a) => a.role === 'executor')!.id
})

after(async () => {
  await daemon.close()
  await cleanup(dataDir)
  await cleanup(workRoot)
})

describe('D49 ⑩：对话的工作目录（聊天右栏底部那一栏）', () => {
  test('★ 身份里认领了这条接口（界面据此决定画不画那一栏）', async () => {
    const { body } = await json('/api/identity')
    const caps = (body as { capabilities?: string[] }).capabilities ?? []
    assert.ok(caps.includes('conversation-files'), `capabilities 里要有它：${caps.join(', ')}`)
  })

  test('★ 列的是**接口报出来的那个目录**（与出 run 时同一个算法，不分叉）', async () => {
    const conv = await makeConversation()
    await writeFile(join(conv.dir, '结论.md'), '# 好\n')
    const { status, body } = await json(`/api/conversations/${conv.id}/files`)
    assert.equal(status, 200)
    const listing = body as Listing
    assert.equal(listing.workDir, conv.dir, '报出来的目录必须就是我往里写文件的目录')
    assert.ok(
      listing.entries.some((e) => e.name === '结论.md'),
      `写进去的文件要被列出来：${listing.entries.map((e) => e.name).join(', ')}`,
    )
    assert.equal(listing.exists, true)
  })

  test('★ 平台注入的（`.claude/**`、`.agentdeck/**`）被标出来', async () => {
    const conv = await makeConversation()
    await mkdir(join(conv.dir, '.claude/skills/x'), { recursive: true })
    await writeFile(join(conv.dir, '.claude/skills/x/SKILL.md'), '# skill\n')
    await mkdir(join(conv.dir, 'out'), { recursive: true })
    await writeFile(join(conv.dir, 'out/a.txt'), 'a\n')

    const { body } = await json(`/api/conversations/${conv.id}/files`)
    const listing = body as Listing
    // ⚠️ 断言的是**性质**、不是一份写死的清单：跑过一轮之后目录里必然还有平台
    //    自己写的东西（`.claude/` 的注入物、`.agentdeck/` 的上下文文件），
    //    写死清单的测试会在平台多写一个目录时红——而那不是这一条要钉的事。
    assert.ok(
      listing.entries.some((e) => e.name === 'out'),
      `产出 out/ 要在列表里：${listing.entries.map((e) => e.name).join(', ')}`,
    )
    assert.ok(
      listing.entries.some((e) => e.name === '.claude'),
      '平台注入的 .claude/ 也要在列表里（它只是应该被弱化，不是被藏起来）',
    )
    assert.equal(listing.entries.find((e) => e.name === 'out')!.managed, false, 'out 是产出')
    assert.equal(listing.entries.find((e) => e.name === '.claude')!.managed, true, '.claude 是注入物')
    // ⚠️ **顺序不在这一层断言**：服务端返回的是目录自己的顺序（这里量到的就是
    //    `.agentdeck, .claude, out`），"产出在前、注入物在后"由界面那边的
    //    `sortWorkDirEntries` 保证（`apps/web/src/lib/workdir-view.test.ts` 里
    //    「产出在前、平台注入在后」那一条）。把顺序也写在这里，等于让两处各自
    //    声称自己负责它——而真正决定使用者看到什么的是界面那一处。
  })

  test('★ 一次只列一层：点开目录才取下一层', async () => {
    const conv = await makeConversation()
    await mkdir(join(conv.dir, 'out/deep'), { recursive: true })
    await writeFile(join(conv.dir, 'out/deep/b.txt'), 'b\n')

    const root = (await json(`/api/conversations/${conv.id}/files`)).body as Listing
    assert.ok(
      !root.entries.some((e) => e.path === 'out/deep/b.txt'),
      `深层的文件不该被一次拉回来：${root.entries.map((e) => e.path).join(', ')}`,
    )
    const out = root.entries.find((e) => e.name === 'out')
    assert.ok(out !== undefined, 'out/ 要在顶层')
    assert.equal(out.hasChildren, true, 'out 里有东西 ⇒ 界面要画展开箭头')

    const child = (
      await json(`/api/conversations/${conv.id}/files?dir=${encodeURIComponent('out/deep')}`)
    ).body as Listing
    assert.deepEqual(
      child.entries.map((e) => e.path),
      ['out/deep/b.txt'],
    )
  })

  test('★★ 目录还不存在 ⇒ exists:false（与"存在但是空的"分开）', async () => {
    const conv = await makeConversation()
    await rm(conv.dir, { recursive: true, force: true })
    const { status, body } = await json(`/api/conversations/${conv.id}/files`)
    assert.equal(status, 200, '目录不在不是错误：界面要说的是"还不存在"，不是一个报错')
    const listing = body as Listing
    assert.deepEqual(listing.entries, [])
    assert.equal(listing.exists, false)
    assert.equal(listing.workDir, conv.dir)
  })

  test('★★ `dir=../..` 被拒（400）——这条路由读的是使用者目录里的文件', async () => {
    const conv = await makeConversation()
    for (const bad of ['../../..', '..', '/etc', '../' + conv.id]) {
      const { status } = await json(
        `/api/conversations/${conv.id}/files?dir=${encodeURIComponent(bad)}`,
      )
      assert.equal(status, 400, `「${bad}」该被拒`)
    }
  })

  test('★★ 软链指向外面 ⇒ 拒绝（路径检查看不出来，要比真实路径）', async () => {
    const conv = await makeConversation()
    await symlink('/etc/passwd', join(conv.dir, 'peek'))
    const { status } = await json(
      `/api/conversations/${conv.id}/file?path=${encodeURIComponent('peek')}`,
    )
    assert.equal(status, 400, '软链不能被跟随到工作目录外面')
  })

  test('★ 读文件：内容对，而且带着 sandbox 的 CSP（agent 写的 html 不能在这个源里跑脚本）', async () => {
    const conv = await makeConversation()
    await writeFile(join(conv.dir, 'note.txt'), 'hello\n')
    const res = await fetch(
      `${daemon.url}/api/conversations/${conv.id}/file?path=${encodeURIComponent('note.txt')}`,
    )
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'hello\n')
    const csp = res.headers.get('content-security-policy') ?? ''
    assert.match(csp, /sandbox/, `CSP 要带 sandbox，实际：${csp}`)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  })

  test('★ 未知对话 ⇒ 404（别的 workspace 的也当不存在，同一口径）', async () => {
    const { status } = await json('/api/conversations/01NOTACONVERSATION00000000/files')
    assert.equal(status, 404)
  })
})
