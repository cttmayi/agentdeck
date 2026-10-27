import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@agentdeck/agent-core'
import type { RunId } from '@agentdeck/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * ★ 分批第 41 批：Settings 里的「运行时配置隔离」开关。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有这个开关（使用者原话）
 * ══════════════════════════════════════════════════════════════════
 *
 * 「我想在 Settings 里面增加一个开关，不 copy 配置，直接用原路径配置」——他在 Windows 上
 * 撞到的正是 D78 那套**复制**本身（把 `auth.json` + `config.toml` 搬进受管目录；
 * Windows 上有文件锁、有 BOM/UTF-16 存法的 config.toml、还有 codex 自己占着文件）。
 * 他要的不是"我们把复制修好"，而是"别复制，按我原本的环境跑"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这份测试钉的是什么（以及为什么必须用真 daemon + 假后端）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这条开关的要害不是"界面上有个勾"，而是**三件事必须同时跟着变**：
 *   ① 不复制配置文件（受管目录里不许出现新文件）；
 *   ② 不注入重定向（`CLAUDE_CONFIG_DIR` / `CODEX_HOME` 不许传给后端）；
 *   ③ 运行日志里写清这一次是哪种（关掉会失去隔离，不许静默）。
 *
 * 只验其中一条的话，最容易出现的坏结果是"开关关了、复制还在"或"复制停了、
 * 环境变量还在"——两种都表现为"设置没生效"，而那正是这个仓库最常见的缺陷形状。
 *
 * NFR-T-01：注入假后端，绝不启动真 CLI（这里连 claude/codex 的可执行文件都不需要）。
 */

/** 只记录"后端收到了什么"的假后端：这份测试不关心 agent 说了什么。 */
class EnvRecordingBackend implements AgentBackend {
  readonly key = 'codex-recorded'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  /** 最近一次执行收到的自定义环境变量（executor → backend 的那一条通道）。 */
  seenEnv: Record<string, string> = {}
  /** 执行过几次（用来判断"这条 run 真的跑到后端了"，而不是在更早的地方就失败了）。 */
  calls = 0

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'fake-runtime', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    this.calls += 1
    this.seenEnv = opts.env ?? {}
    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: '干完了。' })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: '干完了。',
        durationMs: 1,
        sessionId: 'isolation-session',
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

interface Harness {
  daemon: DaemonHandle
  backend: EnvRecordingBackend
  dataDir: string
  configDir: string
}

const json = async (
  h: Harness,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${h.daemon.url}${path}`, init)
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

const putJson = (h: Harness, path: string, payload: unknown) =>
  json(h, path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

/** 起一条 execute run 并等它到终态（只看终态，不看内容）。 */
async function runOnce(h: Harness, workDir: string): Promise<{ runId: string; notes: string[] }> {
  const runId = `run-iso-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`
  const created = await json(h, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId,
      kind: 'execute',
      // runtimeKey 留空 ⇒ 新 agent 的默认值 'default' ⇒ 三级解析落到 daemon 侦测的那个
      agentRef: { id: `a-iso-${runId}`, name: '助手', instructions: '' },
      skills: [],
      subject: { type: 'issue', id: `i-iso-${runId}` },
      prompt: '干活',
      workDir,
      limits: { maxTurns: null, timeoutMs: null },
    }),
  })
  assert.equal(created.status, 202, `建 run 失败：${JSON.stringify(created.body)}`)

  for (let i = 0; i < 200; i += 1) {
    const { body } = await json(h, `/api/runs/${runId}`)
    const status = (body as { status?: string }).status
    if (status !== undefined && ['completed', 'failed', 'cancelled'].includes(status)) break
    await new Promise((r) => setTimeout(r, 25))
  }
  const msgs = await json(h, `/api/runs/${runId}/messages`)
  const notes = ((msgs.body as { messages: Array<{ content: string }> }).messages ?? []).map(
    (m) => m.content,
  )
  return { runId, notes }
}

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  )

async function makeHarness(runtimeKey: string): Promise<Harness> {
  const dataDir = await makeTempDir(`iso-${runtimeKey}-data`)
  const configDir = join(dataDir, 'managed-config')
  const backend = new EnvRecordingBackend()
  const daemon = await startDaemon({
    dataDir,
    workRoot: join(dataDir, 'work'),
    port: 0,
    fsync: false,
    backend,
    // ★ daemon 级 runtime 就是被测的那个：注入的假后端因此对它生效（真 CLI 一次都不起）
    runtimeKey,
    // 受管目录与"用户的原始配置目录"都钉在临时目录里——测试绝不读使用者真实配置
    ...(runtimeKey === 'codex'
      ? { codexConfigDir: configDir, codexConfigSource: join(dataDir, 'user-codex') }
      : { claudeConfigDir: configDir, claudeSettingsSource: join(dataDir, 'user-claude/settings.json') }),
    onWarn: () => {},
    onInfo: () => {},
  })
  // 源配置（模拟使用者的 ~/.codex / ~/.claude）——内容是什么不重要，存在即可
  if (runtimeKey === 'codex') {
    await mkdir(join(dataDir, 'user-codex'), { recursive: true })
    await writeFile(join(dataDir, 'user-codex/auth.json'), '{"OPENAI_API_KEY":"sk-fake"}\n', 'utf8')
    await writeFile(join(dataDir, 'user-codex/config.toml'), 'model = "fake"\n', 'utf8')
  } else {
    await mkdir(join(dataDir, 'user-claude'), { recursive: true })
    await writeFile(
      join(dataDir, 'user-claude/settings.json'),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-fake' } }),
      'utf8',
    )
  }
  return { daemon, backend, dataDir, configDir }
}

describe('★ 分批第 41 批：Settings 的「运行时配置隔离」开关（codex 与 claude 同一个开关）', () => {
  test('★★ 接口与身份：写进去的值必须原样读回来（含"老数据缺省 = 开"）', async () => {
    const h = await makeHarness('claude')
    try {
      // 缺省：老 workspace 里没有这个键 ⇒ 开（升级不许悄悄改变既有行为）
      const before = await json(h, '/api/identity')
      assert.equal(
        (before.body as { runtimeConfigIsolation?: boolean }).runtimeConfigIsolation,
        true,
        '没设过的时候必须是"开"——否则升级会把所有人的隔离悄悄关掉',
      )

      const off = await putJson(h, '/api/workspace/runtime-config-isolation', { enabled: false })
      assert.equal(off.status, 200, JSON.stringify(off.body))
      const afterOff = await json(h, '/api/identity')
      assert.equal(
        (afterOff.body as { runtimeConfigIsolation?: boolean }).runtimeConfigIsolation,
        false,
        '★ 开关的值必须从服务端读回来（界面上那个勾读的就是它）',
      )

      const bad = await putJson(h, '/api/workspace/runtime-config-isolation', { enabled: 'no' })
      assert.equal(bad.status, 400, 'enabled 必须是布尔值')
      assert.equal((bad.body as { code?: string }).code, 'invalid_enabled')
    } finally {
      await h.daemon.close()
      await cleanup(h.dataDir)
    }
  })

  test('★★★ 开（默认）：claude 侧复制配置 + 注入 CLAUDE_CONFIG_DIR', async () => {
    const h = await makeHarness('claude')
    try {
      const work = await makeTempDir('iso-claude-on-work')
      const { notes } = await runOnce(h, work)
      assert.equal(
        h.backend.seenEnv['CLAUDE_CONFIG_DIR'],
        h.configDir,
        '★ 隔离开着时必须把 CLAUDE_CONFIG_DIR 指向受管目录',
      )
      assert.equal(
        await exists(join(h.configDir, 'settings.json')),
        true,
        '★ 隔离开着时必须真的写出一份受管 settings.json',
      )
      assert.ok(
        notes.some((n) => n.includes('claude 个人配置隔离') && n.includes('已启用')),
        `运行日志要写明这次启用了隔离：${notes.join(' | ')}`,
      )
      await cleanup(work)
    } finally {
      await h.daemon.close()
      await cleanup(h.dataDir)
    }
  })

  test('★★★ 关：claude 侧**不复制、不重定向**，并在日志里说清楚（使用者要的就是这个）', async () => {
    const h = await makeHarness('claude')
    try {
      const off = await putJson(h, '/api/workspace/runtime-config-isolation', { enabled: false })
      assert.equal(off.status, 200, JSON.stringify(off.body))
      const work = await makeTempDir('iso-claude-off-work')
      // 受管目录里预先放一个"上一轮留下的"文件：用来证明"关掉"不是"清空"
      await mkdir(h.configDir, { recursive: true })
      await writeFile(join(h.configDir, 'stale.txt'), 'old\n', 'utf8')

      const { notes } = await runOnce(h, work)
      assert.equal(
        h.backend.seenEnv['CLAUDE_CONFIG_DIR'],
        undefined,
        '★★ 关掉之后**不许**再注入 CLAUDE_CONFIG_DIR —— 否则复制停了、重定向还在，' +
          'CLI 会拿着一个没人维护的目录跑（这是最坏的那种"半生效"）',
      )
      assert.equal(
        await exists(join(h.configDir, 'settings.json')),
        false,
        '★ 关掉之后不许再往受管目录里写 settings.json',
      )
      assert.ok(
        notes.some((n) => n.includes('运行时配置隔离：已关闭')),
        `关掉必须在运行日志里说清楚（不许静默丢掉隔离）：${notes.join(' | ')}`,
      )
      await cleanup(work)
    } finally {
      await h.daemon.close()
      await cleanup(h.dataDir)
    }
  })

  test('★★★ codex：开 → 复制 auth.json/config.toml 且注入 CODEX_HOME；关 → 两个都不做', async () => {
    const h = await makeHarness('codex')
    try {
      const workOn = await makeTempDir('iso-codex-on-work')
      const on = await runOnce(h, workOn)
      /**
       * ★ 分批第 60 批：`CODEX_HOME` 从"全局一份"改成"**按工作目录分**一份"——
       * 原因见 `codex-config.ts` 的 `codexHomeFor`：全局一份时两条不同工作目录的 run
       * 会同时重建同一份 config.toml，后写赢 ⇒ 先写那条的 trust 段被抹掉。
       * 所以判据是"**在受管根下面、且与本轮工作目录绑定**"，不是"等于受管根"。
       */
      const codexHome = h.backend.seenEnv['CODEX_HOME'] ?? ''
      assert.ok(
        codexHome.startsWith(`${h.configDir}/`),
        `★ 隔离开着时 CODEX_HOME 必须在受管根下面：${codexHome}`,
      )
      assert.match(codexHome, /\/[0-9a-f]{16}$/u, '目录名是工作目录路径的哈希（保证同一目录复用同一份）')
      const copiedAuth = await readFile(join(h.backend.seenEnv['CODEX_HOME'] ?? '', 'auth.json'), 'utf8')
      assert.match(copiedAuth, /OPENAI_API_KEY/, '★ auth.json 必须真的被复制过去（否则 codex 认证不了）')
      assert.equal(
        await exists(join(h.backend.seenEnv['CODEX_HOME'] ?? '', 'config.toml')),
        true,
        'config.toml 同样要复制',
      )
      assert.ok(
        on.notes.some((n) => n.includes('codex 个人配置隔离') && n.includes('已启用')),
        `运行日志要写明这次启用了隔离：${on.notes.join(' | ')}`,
      )

      const offRes = await putJson(h, '/api/workspace/runtime-config-isolation', { enabled: false })
      assert.equal(offRes.status, 200, JSON.stringify(offRes.body))
      // 把这份 per-workdir 目录整个删掉：只有真的不再复制，它们才不会回来
      const codexHomeOn = h.backend.seenEnv['CODEX_HOME'] ?? ''
      assert.notEqual(codexHomeOn, '', '前提：开的时候真的注入了 CODEX_HOME')
      await cleanup(codexHomeOn)
      const workOff = await makeTempDir('iso-codex-off-work')
      const off = await runOnce(h, workOff)
      assert.equal(
        h.backend.seenEnv['CODEX_HOME'],
        undefined,
        '★ 关掉之后不许再注入 CODEX_HOME —— codex 就用它自己的 ~/.codex',
      )
      assert.equal(
        await exists(join(codexHomeOn, 'auth.json')),
        false,
        '★ 关掉之后不许再复制 auth.json（这正是 Windows 上出问题的那一步）',
      )
      assert.ok(
        off.notes.some((n) => n.includes('运行时配置隔离：已关闭')),
        `关掉必须在运行日志里说清楚：${off.notes.join(' | ')}`,
      )

      await cleanup(workOn)
      await cleanup(workOff)
    } finally {
      await h.daemon.close()
      await cleanup(h.dataDir)
    }
  })
})

/**
 * ★ 分批第 61 批：**删对话/任务时把它那份 CODEX_HOME 一起清掉**（真 daemon 验证）。
 *
 * 为什么必须（使用者提的）：那份目录里有 `auth.json` 的真实 key 副本——实体删了还留着，
 * 就是"看不见、但一直在"的残留。
 *
 * 这一条走真 HTTP：建对话（会真跑一轮 ⇒ 真的写出那份 CODEX_HOME）→ 删对话 → 那份目录要没了，
 * 而且**别的目录那份不许被牵连**。
 */
describe('★ 分批第 61 批：删除实体时清掉它那份 CODEX_HOME', () => {
  test('★★★ 删对话 ⇒ 它那份 CODEX_HOME 没了，别的那份还在', async () => {
    const h = await makeHarness('codex')
    try {
      // ① 建两个对话（各自一个工作目录 ⇒ 各自一份 CODEX_HOME）
      //    ⚠️ agentId 要用**播种出来的那条**（假 id 会 404 `agent_not_found`——第一次就这么红的）
      const agentsRes = await json(h, '/api/agents')
      const seeded = (agentsRes.body as { agents: Array<{ id: string; role: string }> }).agents
      const execId = seeded.find((a) => a.role === 'executor')?.id ?? ''
      assert.notEqual(execId, '', '要先拿到播种出来的执行者')
      /**
       * ⚠️ 必须把这条执行者改成 `default`（= 跟随全局 ⇒ 落到 daemon 侦测到的 codex）：
       *    播种出来的 agent 记的是 `claude`，那样这条对话会跑 **claude**，
       *    根本不会写出 CODEX_HOME（我第一版就这么写的，红了才发现）。
       */
      const patched = await putJson(h, `/api/agents/${execId}`, { runtimeKey: 'default' })
      assert.equal(patched.status, 200, JSON.stringify(patched.body))
      const makeConv = async (): Promise<{ id: string; dir: string }> => {
        const created = await json(h, '/api/conversations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: execId, text: '看看目录', workDir: null }),
        })
        assert.equal(created.status, 201, JSON.stringify(created.body))
        const body = created.body as { conversation: { id: string }; turn: { runId: string } }
        for (let i = 0; i < 200; i += 1) {
          const r = await json(h, `/api/runs/${body.turn.runId}`)
          const status = (r.body as { status?: string }).status
          if (status !== undefined && ['completed', 'failed', 'cancelled'].includes(status)) break
          await new Promise((res) => setTimeout(res, 25))
        }
        const run = await json(h, `/api/runs/${body.turn.runId}`)
        return { id: body.conversation.id, dir: (run.body as { workDir: string }).workDir }
      }
      const one = await makeConv()
      const two = await makeConv()
      assert.notEqual(one.dir, two.dir, '两个对话各自一个目录')

      const root = h.configDir
      const { codexHomeFor } = await import('./run-hooks/codex-config.ts')
      const homeOne = codexHomeFor(root, one.dir)
      const homeTwo = codexHomeFor(root, two.dir)
      assert.equal(await exists(homeOne), true, '前提：跑过一轮之后那份 CODEX_HOME 真的写出来了')
      assert.equal(await exists(join(homeOne, 'auth.json')), true, '里面有 auth.json（key 副本）')
      assert.equal(await exists(homeTwo), true)

      // ② 删掉其中一个对话
      const del = await json(h, `/api/conversations/${one.id}`, { method: 'DELETE' })
      assert.equal(del.status, 200, JSON.stringify(del.body))

      // ③ 它那份没了、另一份还在
      assert.equal(await exists(homeOne), false, '★ 对话删了，它那份 CODEX_HOME（含 key 副本）必须一起没了')
      assert.equal(await exists(homeTwo), true, '★ 别的对话那份不许被牵连')
      await cleanup(two.dir)
      await cleanup(one.dir)
    } finally {
      await h.daemon.close()
      await cleanup(h.dataDir)
    }
  })
})
