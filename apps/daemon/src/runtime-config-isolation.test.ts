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
 * 运行时个人配置隔离的**失败语义**与**技能落点**（分批第 75 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一批改了什么，为什么
 * ══════════════════════════════════════════════════════════════════
 *
 * 原来有一个 Settings 开关「运行时配置」（`Workspace.runtimeConfigIsolation`）。
 * 它当初是为 Windows 上撞到的两个真问题准备的退路：`config.toml` 是 PowerShell `>`
 * 写出的 **UTF-16**、`auth.json` 被 codex 占着复制不了。
 *
 * 但开关并不解决那两个问题——它只是让使用者**手动**退回"用我自己的配置"。更糟的是
 * 复制失败时代码**照样**把 `CODEX_HOME` 指向受管目录 ⇒ codex 拿到一个缺 auth.json 的
 * 空目录 ⇒ 认证失败。也就是说：开关替那段坏逻辑背了锅。
 *
 * 这一批把机器修好、把开关删掉：
 *   · **编码**：`readConfigText()` 按 BOM 判 UTF-16 / UTF-8+ BOM 再解码，受管副本
 *     一律以 UTF-8 写回（**使用者的原文件一个字节都不动**）；
 *   · **占用**：`copyWithRetry()` 对 `EPERM/EACCES/EBUSY` 在 win32 上退避重试；
 *   · **失败语义**：同步失败 ⇒ **不注入重定向**（`CLAUDE_CONFIG_DIR` / `CODEX_HOME`
 *     都不传给后端）+ 一条明确 note ⇒ 直接用使用者自己的配置。等价于原来那个开关，
 *     但不需要人操心；
 *   · **技能落点**：隔离生效时技能写 `<CODEX_HOME>/skills`（实测 codex 会把它当技能根），
 *     工作目录里不再出现 `.codex/skills`；隔离失败时退回工作目录（**绝不写使用者真实的
 *     `~/.codex`**）。
 *
 * NFR-T-01：注入假后端，绝不启动真 CLI。
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
async function runOnce(
  h: Harness,
  workDir: string,
  skills: Array<Record<string, unknown>> = [],
): Promise<{ runId: string; notes: string[] }> {
  const runId = `run-iso-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`
  const created = await json(h, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId,
      kind: 'execute',
      // runtimeKey 留空 ⇒ 新 agent 的默认值 'default' ⇒ 三级解析落到 daemon 侦测的那个
      agentRef: { id: `a-iso-${runId}`, name: '助手', instructions: '' },
      skills,
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

describe('★ 分批第 75 批：隔离生效时照旧复制 + 重定向（默认行为不变）', () => {
  test('★★★ claude：复制 settings.json 并注入 CLAUDE_CONFIG_DIR', async () => {
    const h = await makeHarness('claude')
    try {
      const work = await makeTempDir('iso-claude-on-work')
      const { notes } = await runOnce(h, work)
      assert.equal(
        h.backend.seenEnv['CLAUDE_CONFIG_DIR'],
        h.configDir,
        '★ 隔离生效时必须把 CLAUDE_CONFIG_DIR 指向受管目录',
      )
      assert.equal(
        await exists(join(h.configDir, 'settings.json')),
        true,
        '★ 隔离生效时必须真的写出一份受管 settings.json',
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

  test('★★★ codex：复制 auth.json/config.toml，CODEX_HOME 按工作目录分', async () => {
    const h = await makeHarness('codex')
    try {
      const work = await makeTempDir('iso-codex-on-work')
      const on = await runOnce(h, work)
      const codexHome = h.backend.seenEnv['CODEX_HOME'] ?? ''
      assert.ok(codexHome.startsWith(`${h.configDir}/`), `★ CODEX_HOME 必须在受管根下面：${codexHome}`)
      assert.match(codexHome, /\/[0-9a-f]{16}$/u, '目录名是工作目录路径的哈希（同一目录复用同一份）')
      assert.match(
        await readFile(join(codexHome, 'auth.json'), 'utf8'),
        /OPENAI_API_KEY/u,
        '★ auth.json 必须真的被复制过去（否则 codex 认证不了）',
      )
      assert.equal(await exists(join(codexHome, 'config.toml')), true, 'config.toml 同样要复制')
      assert.ok(
        on.notes.some((n) => n.includes('codex 个人配置隔离') && n.includes('已启用')),
        `运行日志要写明这次启用了隔离：${on.notes.join(' | ')}`,
      )
      await cleanup(work)
    } finally {
      await h.daemon.close()
      await cleanup(h.dataDir)
    }
  })
})

describe('★ 分批第 75 批：复制不成 ⇒ **自动退回**（开关删了，退路变成自动的）', () => {
  /**
   * 判据是"**不重定向**"，不是"报了个错"。
   *
   * 原来失败时仍然返回 `env = { CODEX_HOME: 受管目录 }`：codex 拿着一个可能缺
   * `auth.json` 的目录起来 ⇒ 认证失败。那不是隔离，是把能跑的 run 变成跑不起来的 run。
   */
  test('★★★ codex：源缺 auth.json ⇒ 不注入 CODEX_HOME，日志说明"直接用你自己的"', async () => {
    const h = await makeHarness('codex')
    try {
      // 让源配置"缺一个文件"：复制这一步失败
      await cleanup(join(h.dataDir, 'user-codex/auth.json'))
      const work = await makeTempDir('iso-codex-fallback-work')
      const { notes } = await runOnce(h, work)
      assert.equal(
        h.backend.seenEnv['CODEX_HOME'],
        undefined,
        '★ 复制失败时**不许**再把 CODEX_HOME 指向受管目录（那是最坏的半生效）',
      )
      assert.ok(
        notes.some((n) => n.includes('codex 个人配置隔离未生效') && n.includes('直接用你自己的')),
        `要在日志里说清"这次没有隔离、用的是你自己的配置"：${notes.join(' | ')}`,
      )
      await cleanup(work)
    } finally {
      await h.daemon.close()
      await cleanup(h.dataDir)
    }
  })

  test('★★★ claude：源 settings.json 缺失 ⇒ 不注入 CLAUDE_CONFIG_DIR（但自带 skills 照样关）', async () => {
    const h = await makeHarness('claude')
    try {
      await cleanup(join(h.dataDir, 'user-claude/settings.json'))
      const work = await makeTempDir('iso-claude-fallback-work')
      const { notes } = await runOnce(h, work)
      assert.equal(
        h.backend.seenEnv['CLAUDE_CONFIG_DIR'],
        undefined,
        '★ 复制失败时不许再注入 CLAUDE_CONFIG_DIR',
      )
      assert.equal(
        h.backend.seenEnv['CLAUDE_CODE_DISABLE_BUNDLED_SKILLS'],
        '1',
        '★ 但"关掉 claude 自带 skills"与复制成败无关（它只是一个 env）⇒ 仍然要注入',
      )
      assert.ok(
        notes.some((n) => n.includes('claude 个人配置隔离未生效') && n.includes('直接用你自己的')),
        `日志要说清这次的退路：${notes.join(' | ')}`,
      )
      await cleanup(work)
    } finally {
      await h.daemon.close()
      await cleanup(h.dataDir)
    }
  })

  test('★★★ UTF-16 的 config.toml ⇒ 受管副本规范化成 UTF-8（原文件不动），日志说明', async () => {
    const h = await makeHarness('codex')
    try {
      // PowerShell 5.1 的 `>` 产物：UTF-16LE + BOM
      const utf16 = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('model = "fake"\n[model_providers.local]\nbase_url = "http://127.0.0.1:8080"\n', 'utf16le'),
      ])
      await writeFile(join(h.dataDir, 'user-codex/config.toml'), utf16)

      const work = await makeTempDir('iso-codex-utf16-work')
      const { notes } = await runOnce(h, work)
      const codexHome = h.backend.seenEnv['CODEX_HOME'] ?? ''
      assert.notEqual(codexHome, '', '前提：这次隔离是生效的')
      const managed = await readFile(join(codexHome, 'config.toml'))
      assert.equal(
        managed[0] === 0xff && managed[1] === 0xfe,
        false,
        '★ 受管副本不许再是 UTF-16（否则我们后续按 UTF-8 读它又是乱码）',
      )
      const text = managed.toString('utf8')
      assert.match(text, /model = "fake"/u, '★ 内容必须是**解码后**的真文本，不是乱码夹 NUL')
      assert.equal(text.includes('\u0000'), false, '不许有 NUL')
      assert.ok(
        notes.some((n) => n.includes('UTF-16') || n.includes('utf16le')),
        `日志要说明"你的 config.toml 是 UTF-16，已解码写进受管副本"：${notes.join(' | ')}`,
      )
      // 使用者的原文件一个字节都不能动
      const source = await readFile(join(h.dataDir, 'user-codex/config.toml'))
      assert.equal(source[0], 0xff, '★ 源文件必须还是原来的 UTF-16（D29：不碰使用者的文件）')
      await cleanup(work)
    } finally {
      await h.daemon.close()
      await cleanup(h.dataDir)
    }
  })
})

describe('★ 分批第 75 批：技能落点（隔离生效 ⇒ 受管 home；失败 ⇒ 退回工作目录）', () => {
  const oneSkill = (slug: string): Array<Record<string, unknown>> => [
    {
      ref: { id: `sk-${slug}`, slug, source: 'builtin' },
      slug,
      name: `技能 ${slug}`,
      body: `# ${slug}\n\n正文。\n`,
      description: `探针技能 ${slug}`,
    },
  ]

  test('★★★ codex：隔离生效 ⇒ 技能写进 <CODEX_HOME>/skills，工作目录里没有 .codex/skills', async () => {
    const h = await makeHarness('codex')
    try {
      const work = await makeTempDir('iso-codex-skill-work')
      await runOnce(h, work, oneSkill('probe-alpha'))
      const codexHome = h.backend.seenEnv['CODEX_HOME'] ?? ''
      assert.notEqual(codexHome, '', '前提：隔离生效')
      /**
       * 实测（0.157.1）：`<CODEX_HOME>/skills/<slug>/SKILL.md` 会被 codex 当成一条技能，
       * `codex debug prompt-input` 里技能根是 `r0 = <CODEX_HOME>/skills`，
       * app-server 模式下模型能抄出它的 description。
       *
       * ⚠️ 这里只能验"写到了哪"（真 CLI 的可见性由真机跑过一次确认）；跑完之后
       *    平台会把自己的注入物收走（工作目录/受管目录都回到"只有 agent 的产出"），
       *    所以断言用**注入那一刻的 note**：它既证明了落点，也证明了我们没写工作目录。
       */
      const { notes } = await runOnce(h, work, oneSkill('probe-beta'))
      assert.ok(
        notes.some((n) => n.includes('写入受管运行时目录的 skills/') && n.includes('probe-beta')),
        `日志要说清技能写进了受管 home：${notes.join(' | ')}`,
      )
      assert.equal(
        await exists(join(work, '.codex', 'skills')),
        false,
        '★ 工作目录里不该出现平台写的 .codex/skills（这正是使用者要的效果）',
      )
      await cleanup(work)
    } finally {
      await h.daemon.close()
      await cleanup(h.dataDir)
    }
  })

  test('★★ 隔离失败 ⇒ 技能退回工作目录的 .codex/skills（绝不写使用者真实的 ~/.codex）', async () => {
    const h = await makeHarness('codex')
    try {
      await cleanup(join(h.dataDir, 'user-codex/auth.json'))
      const work = await makeTempDir('iso-codex-skill-fallback')
      const { notes } = await runOnce(h, work, oneSkill('probe-gamma'))
      assert.equal(h.backend.seenEnv['CODEX_HOME'], undefined, '前提：这次隔离没生效')
      assert.ok(
        notes.some((n) => n.includes('写入工作目录的 .codex/skills/') && n.includes('probe-gamma')),
        `没有受管 home 时技能必须退回工作目录：${notes.join(' | ')}`,
      )
      await cleanup(work)
    } finally {
      await h.daemon.close()
      await cleanup(h.dataDir)
    }
  })
})

describe('★ 分批第 75 批：copyWithRetry（Windows 占用重试）', () => {
  test('★★★ win32 上 EPERM 会退避重试；非 win32 一次就放弃；非瞬时错误立刻抛', async () => {
    const { copyWithRetry } = await import('./run-hooks/config-file.ts')
    const sleep = async (): Promise<void> => {}
    const eperm = (): NodeJS.ErrnoException => Object.assign(new Error('locked'), { code: 'EPERM' })

    // ① win32：前两次 EPERM，第三次成功
    let calls = 0
    await copyWithRetry('a', 'b', {
      platform: 'win32',
      sleep,
      copy: async () => {
        calls += 1
        if (calls < 3) throw eperm()
      },
    })
    assert.equal(calls, 3, '★ win32 上"文件被占用"要重试（codex 常开着 auth.json）')

    // ② 非 win32：一次就抛（POSIX 上重试只会让真错误晚 300ms 报出来）
    let calls2 = 0
    await assert.rejects(
      copyWithRetry('a', 'b', {
        platform: 'darwin',
        sleep,
        copy: async () => {
          calls2 += 1
          throw eperm()
        },
      }),
    )
    assert.equal(calls2, 1, 'POSIX 上不许重试')

    // ③ 非瞬时错误（比如 ENOENT）立刻抛，不浪费四次退避
    let calls3 = 0
    await assert.rejects(
      copyWithRetry('a', 'b', {
        platform: 'win32',
        sleep,
        copy: async () => {
          calls3 += 1
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        },
      }),
    )
    assert.equal(calls3, 1, 'ENOENT 不是"被占用"，重试没有意义')
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

/**
 * ★ 分批第 62 批：claude 侧也要关掉**自带**的 skills（与 codex 那个 `[skills.bundled]` 同一个目标）。
 *
 * 实测依据（假 Anthropic 端点抓请求体，不花 token；claude 2.1.302）：
 *   · 不关：模型能看到 **14 条**技能（1 条我们注入的 + 13 条自带：dataviz / code-review /
 *     security-review / init / run / loop / claude-api / update-config / keybindings-help /
 *     simplify / fewer-permission-prompts / workflow-authoring / plugin-authoring）；
 *   · `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` ⇒ 只剩 **2 条**（注入的 + plugin-authoring）；
 *   · `--disable-slash-commands` ⇒ **整个技能段消失**（连注入的一起）⇒ 不能用；
 *   · `~/.agents/skills` 那三个宿主级技能 **claude 根本不读**（与 codex 不同），
 *     `~/.claude/skills` 的个人技能被 CLAUDE_CONFIG_DIR 挡住了。
 */
describe('★ 分批第 62 批：claude 也关掉自带 skills', () => {
  test('★★★ 隔离生效 ⇒ 注入 CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1；退回时也注入（与复制无关）', async () => {
    const h = await makeHarness('claude')
    try {
      const work = await makeTempDir('claude-bundled-on-work')
      const on = await runOnce(h, work)
      assert.equal(
        h.backend.seenEnv['CLAUDE_CODE_DISABLE_BUNDLED_SKILLS'],
        '1',
        '★ 隔离生效时必须关掉 claude 自带的 13 条 skills（否则它们混进模型清单）',
      )
      assert.ok(
        on.notes.some((n) => n.includes('claude 自带的 skills：已关闭')),
        `日志要说清这件事（含"还剩 plugin-authoring"）：${on.notes.join(' | ')}`,
      )

      // ★ 分批第 75 批：开关删了。等价情形是"复制失败 ⇒ 自动退回"——
      //   那时**仍然**要关 claude 自带 skills：它只是一个 env，与复制成败无关。
      await cleanup(join(h.dataDir, 'user-claude/settings.json'))
      const work2 = await makeTempDir('claude-bundled-fallback-work')
      await runOnce(h, work2)
      assert.equal(
        h.backend.seenEnv['CLAUDE_CONFIG_DIR'],
        undefined,
        '前提：复制失败时不再重定向',
      )
      assert.equal(
        h.backend.seenEnv['CLAUDE_CODE_DISABLE_BUNDLED_SKILLS'],
        '1',
        '★ 退回用你自己的配置时，claude 自带 skills 照样该关（那条 env 不依赖复制）',
      )
      await cleanup(work)
      await cleanup(work2)
    } finally {
      await h.daemon.close()
      await cleanup(h.dataDir)
    }
  })

  test('★★ agent 自定义同名 env 被平台覆盖（不能由 agent 把自带的 skills 开回来）', async () => {
    const h = await makeHarness('claude')
    try {
      const agentsRes = await json(h, '/api/agents')
      const seeded = (agentsRes.body as { agents: Array<{ id: string; role: string }> }).agents
      const execId = seeded.find((a) => a.role === 'executor')?.id ?? ''
      const patched = await putJson(h, `/api/agents/${execId}`, {
        env: { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '0' },
      })
      assert.equal(patched.status, 200, JSON.stringify(patched.body))
      const runId = `run-claude-env-${String(Date.now())}`
      const createRes = await json(h, '/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: execId, name: '助手', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: 'i-claude-env' },
          prompt: '干活',
          workDir: await makeTempDir('claude-env-work'),
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      assert.equal(createRes.status, 202, JSON.stringify(createRes.body))
      for (let i = 0; i < 200; i += 1) {
        const r = await json(h, `/api/runs/${runId}`)
        const status = (r.body as { status?: string }).status
        if (status !== undefined && ['completed', 'failed', 'cancelled'].includes(status)) break
        await new Promise((res) => setTimeout(res, 25))
      }
      assert.equal(
        h.backend.seenEnv['CLAUDE_CODE_DISABLE_BUNDLED_SKILLS'],
        '1',
        '★ 平台最后写 ⇒ agent 想设成 0 也不生效（隔离不能由 agent 关掉）',
      )
    } finally {
      await h.daemon.close()
      await cleanup(h.dataDir)
    }
  })
})
