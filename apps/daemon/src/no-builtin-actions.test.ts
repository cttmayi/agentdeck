import assert from 'node:assert/strict'
import { deliveredText } from './testing/delivered.ts'
import { describe, test } from 'node:test'
import { join } from 'node:path'
import {
  VERDICT_FENCE_BEGIN,
  VERDICT_FENCE_END,
  ulid,
  type Agent,
  type InboxItem,
  type RunId,
  type VerdictRecord,
} from '@agentdeck/protocol'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { AsyncQueue, type AgentBackend, type AgentMessage, type ExecOptions, type AgentSession } from '@agentdeck/agent-core'

/**
 * ★ D41：平台**没有内置动作**了——这条语义本身要有人守。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件守的是"删除生效了"，而不是"某个函数返回对"
 * ══════════════════════════════════════════════════════════════════
 *
 * 内置动作（`comment.create` / `issue.update_status` / `issue.add_label` /
 * `issue.create` / `issue.assign_agent` / `notify.emit`）被整个移除，动作从此
 * **只能**来自装进来的工具包。这次删除有几个**语义后果**，它们没有任何单个
 * 单元的测试能覆盖，只能开着真 daemon 才看得出来：
 *
 *   ① **首启播种的审核者没有任何动作权限**（`allowedActions: []`）——
 *      所以"开箱即用地评论 / 改状态"**不再成立**。这是刻意的结果，不是回归；
 *   ② 判决契约在"一个动作都不允许"时必须**明说"这次不要写 action"**——
 *      否则模型会照旧去编一个动作名，而那个名字会让**整条判决**（连结论一起）
 *      被判不合规。契约里没有的取值，模型写不出来；
 *   ③ 白名单里写一个裸名（`comment.create` 形状合法，但没有任何包提供它）⇒
 *      保存时就 400。⚠️ 它现在与"一个叫 `comment` 的包没装"**在数据上不可区分**——
 *      不是缺陷，而是删除的直接后果：那个名字已经没有任何特殊身份了；
 *   ④ 判决里写一个裸名 ⇒ 走**结构性 invalid**（重试无意义）并升级给人，
 *      **绝不放行**——"未声明即拒绝"这条规矩一个字都没放松。
 *
 * ⚠️ NFR-T-01：这里用假后端（不调用任何真实 CLI）。本文件**不需要**工具包夹具：
 *    它测的正是"没有任何工具包时会发生什么"。
 */

class VerdictBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json'
  readonly rejectDetectable = false
  /** 审核 run 一律用这份判决回答（可以被读到多次）。 */
  verdict: Record<string, unknown> | null = null
  prompts: string[] = []

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    this.prompts.push(deliveredText(opts))
    // ★ 判据是"这段 prompt 是不是审核"（审核那份里带着判决契约），不是调用序号——
    //   按序号判在并行跑整个套件时会偶发地把判决喂给错误的 run。
    const isReview = deliveredText(opts).includes(VERDICT_FENCE_BEGIN)
    const verdict = isReview ? this.verdict : null
    const text =
      verdict === null
        ? '我做完了这件事。'
        : `结论：\n${VERDICT_FENCE_BEGIN}\n${JSON.stringify(verdict)}\n${VERDICT_FENCE_END}\n`
    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: text })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: text,
        durationMs: 2,
        sessionId: 'd41-session',
        usage: { inputTokens: 10, outputTokens: 5, costUsdMicros: 100, costSource: 'provider' },
        exitCode: 0,
      }),
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

async function until<T>(fn: () => Promise<T | null>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn().catch(() => null)
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function withDaemon<T>(
  fn: (ctx: {
    url: string
    backend: VerdictBackend
    store: Awaited<ReturnType<typeof startDaemon>>['store']
    executor: Agent
    reviewer: Agent
  }) => Promise<T>,
): Promise<T> {
  const dir = await makeTempDir('no-builtin-actions')
  const backend = new VerdictBackend()
  const daemon = await startDaemon({
    dataDir: dir,
    port: 0,
    fsync: false,
    workRoot: join(dir, 'workroot'),
    backend,
    onWarn: () => {},
    onInfo: () => {},
  })
  try {
    // 首启播种的那一对 agent（"助手" + "审核员"）——**不做任何额外配置**，
    // 因为这一组用例要测的正是"开箱是什么样"。
    const { agents } = (await (await fetch(`${daemon.url}/api/agents`)).json()) as {
      agents: Agent[]
    }
    const executor = agents.find((a) => a.role === 'executor')
    const reviewer = agents.find((a) => a.role === 'reviewer')
    assert.ok(executor && reviewer, '首启应当播种一对 agent')
    return await fn({
      url: daemon.url,
      backend,
      store: daemon.store,
      executor: executor!,
      reviewer: reviewer!,
    })
  } finally {
    await daemon.close()
    await cleanup(dir)
  }
}

/** 提一条执行 run，等它到终态（审核由 daemon 自己派，D28）。 */
async function runOnce(ctx: {
  url: string
  executor: Agent
}): Promise<void> {
  const runId = ulid() as RunId
  const res = await fetch(`${ctx.url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId,
      kind: 'execute',
      agentRef: { id: ctx.executor.id, name: ctx.executor.name, instructions: '' },
      skills: [],
      subject: { type: 'issue', id: 'issue-d41-1' },
      prompt: '干点活',
      limits: { maxTurns: null, timeoutMs: null },
    }),
  })
  const text = await res.text()
  assert.equal(res.status, 202, `提交 run 必须是 202，实际 ${res.status}：${text.slice(0, 300)}`)
  await until(async () => {
    const body = (await (await fetch(`${ctx.url}/api/runs/${runId}`)).json()) as { status: string }
    return TERMINAL.has(body.status) ? body.status : null
  }, `run ${runId} 到达终态`)
}

/**
 * 读到那条审核 run 的判决，并**等它落到指定的终态**。
 *
 * ⚠️ 不能只等"判决记录存在"：`insertVerdict` 先写一个中间状态
 *    （`act` ⇒ `validated`，`invalid` ⇒ `invalid`），随后
 *    `transitionVerdict` 才把它推到真正的终态
 *    （`dispatched_to_action` / `escalated` / `advisory`）。
 *    只等"存在"会读到中间态，而症状是"状态断言偶发失败"——
 *    这个仓库里已经踩过一次（`tool-action-e2e.test.ts` 的注释记着）。
 */
async function readVerdict(url: string, expected: string): Promise<VerdictRecord> {
  return until(async () => {
    const { runs } = (await (await fetch(`${url}/api/runs`)).json()) as {
      runs: Array<{ runId: string; kind: string }>
    }
    for (const run of runs.filter((r) => r.kind === 'review')) {
      const { verdicts } = (await (
        await fetch(`${url}/api/runs/${run.runId}/verdicts`)
      ).json()) as { verdicts: VerdictRecord[] }
      const hit = verdicts.find((v) => v.status === expected)
      if (hit) return hit
    }
    return null
  }, `审核判决落到 ${expected}`)
}

describe('★ D41：平台没有内置动作了', () => {
  test('① 首启播种的审核者**没有任何动作权限**（开箱不再"能评论/能改状态"）', async () => {
    await withDaemon(async ({ reviewer, executor, url, backend }) => {
      // ★ 这条是 D41 的刻意结果：这个常量原来是
      //   `['comment.create', 'issue.add_label']`，而那两个名字已经**没有实现**了。
      //   留着它们会让判决一旦引用就走结构性 invalid（不可重试），比空着糟得多。
      assert.deepEqual(
        reviewer.allowedActions,
        [],
        'D41：内置动作全部移除 ⇒ 播种的审核者不再带任何动作权限',
      )

      // 跑一条执行 run，让 daemon 自己派审核（D28）——这样才拿得到审核那份 prompt。
      await runOnce({ url, executor })

      // 契约侧的证据：**一个动作都不允许**时，判决契约必须明说"这次不要写 action"。
      // 不说的话模型会照旧去编一个动作名，而那个名字会让**整条判决**（连结论一起）
      // 被判不合规——"契约里没有的取值，模型写不出来"这条纪律的另一半就在这里。
      const reviewPrompt = await until(
        async () => backend.prompts.find((p) => p.includes(VERDICT_FENCE_BEGIN)) ?? null,
        '审核那份 prompt（自动审核真的被派了）',
      )
      assert.match(
        reviewPrompt,
        /这次不要写/,
        '★ 没有任何动作被允许时，契约必须说"不要写 action"',
      )
      assert.doesNotMatch(
        reviewPrompt,
        /comment\.create/,
        '★ 契约里不能出现任何内置动作名 —— 出现就等于在教模型写一个会被拒的名字',
      )
    })
  })

  test('③ 白名单里写裸名（`comment.create`）⇒ 保存时就 400（不再有特殊身份）', async () => {
    await withDaemon(async ({ url }) => {
      const res = await fetch(`${url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '想写内置动作的审核者',
          runtimeKey: 'claude',
          role: 'reviewer',
          allowedActions: ['comment.create'],
        }),
      })
      const body = (await res.json()) as { error?: string }
      assert.equal(res.status, 400, '裸名不再被接受（D41 之前它是被原样放行的内置动作）')
      assert.match(
        String(body.error),
        /comment\.create/,
        '要点名是哪一个动作（否则使用者不知道改哪一项）',
      )
      // ⚠️ 现在的文案是「动作来自**还没安装**的工具包：comment.create（来自工具包「comment」）」。
      //
      //    这**不是**在说"你得去装一个叫 comment 的包才能恢复内置行为"——它说的是
      //    D41 之后 `comment.create` 已经**没有特殊身份**了：它只是一个形状合法的
      //    `<包 slug>.<动作名>`，而工作区里没有那个包。两者在数据上不可区分，
      //    因为它们真的是同一件事（"这个动作没有实现"）。
      assert.match(
        String(body.error),
        /工具包/,
        '★ 要说清它被看成一个包的动作 —— 使用者唯一的出路是装一个提供它的包',
      )
      assert.match(String(body.error), /comment/, '并点名那个 slug')
    })
  })

  test('④ 判决引用内置动作名 ⇒ 结构性 invalid（重试无意义）+ 升级给人，绝不执行', async () => {
    await withDaemon(async ({ url, backend, store, executor }) => {
      // 一个形状合法（看起来像 `<slug>.<name>`）但**没有任何包提供**的名字。
      // `comment.create` 正是这种情况：D41 之前它是内置动作，现在只是一句空话。
      backend.verdict = {
        schemaVersion: 1,
        conclusion: 'pass',
        reasonCode: 'known_vulnerability',
        confidence: 0.9,
        // ⚠️ `Finding` 是 strictObject：多一个字段（例如 `location`）或把
        //    `evidence` 写成 null 都会让**整条判决**在 schema 那一步就作废——
        //    那样这条用例测到的就不是"动作名不合规"了（第一次跑就踩到了）。
        findings: [{ severity: 'high', summary: '发现了漏洞', evidence: [] }],
        action: { type: 'comment.create', params: { body: '发现了漏洞' } },
        escalateReason: null,
      }

      await runOnce({ url, executor })

      // ★ 等它落到 `escalated`：内置动作名解析不出来 ⇒ 结构性 invalid
      //   （"未声明即拒绝"），不可重试 ⇒ 升级给人。
      const verdict = await readVerdict(url, 'escalated')
      assert.notEqual(
        verdict.status,
        'dispatched_to_action',
        '★ 内置动作不可能被执行 —— 判决必须走 invalid 那条路',
      )
      assert.equal(verdict.invalidResolution, 'escalate')
      assert.match(String(verdict.escalateReason), /comment\.create/)

      // ★ 而且**一条动作记录都不该有**：判决被拒在前，平台绝不会"顺手试一下"
      const actions = await store.listActionsByVerdict(verdict.id)
      assert.equal(actions.length, 0, '不合规的判决不产生任何动作')

      // 失败必须可见：通知中心里要说清是动作的问题
      const inbox = await until(async () => {
        const { items } = (await (await fetch(`${url}/api/inbox?all=1`)).json()) as {
          items: InboxItem[]
        }
        const hit = items.filter((i) => i.type === 'verdict.invalid')
        return hit.length > 0 ? hit : null
      }, '通知中心里出现 verdict.invalid')
      assert.equal(inbox[0]?.severity, 'action_required')
      assert.match(
        JSON.stringify(inbox[0]),
        /comment\.create/,
        '通知里要出现那个动作名，否则人不知道该去改什么',
      )
    })
  })

  test('② 装了包、且审核者勾了它 ⇒ 那条动作**照旧**能执行（删除没有误伤工具动作）', async () => {
    // 这条是"删除生效"的反面证据：把内置动作删干净之后，工具动作那条路
    // **一点都没受影响**——否则上面三条会以一种"什么都不能做了"的方式假绿。
    const { setupToolFixture, verdictAction } = await import('./testing/tool-fixture.ts')
    const dir = await makeTempDir('no-builtin-actions-2')
    const backend = new VerdictBackend()
    const daemon = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      workRoot: join(dir, 'workroot'),
      backend,
      onWarn: () => {},
      onInfo: () => {},
      scriptRuntimePath: process.execPath,
    })
    try {
      const fx = await setupToolFixture(daemon)
      backend.verdict = {
        schemaVersion: 1,
        conclusion: 'pass',
        reasonCode: 'meets_criteria',
        confidence: 0.9,
        findings: [],
        escalateReason: null,
        action: verdictAction(fx.action, { text: '工具动作照旧' }),
      }
      await runOnce({ url: daemon.url, executor: fx.executor })

      const verdict = await readVerdict(daemon.url, 'dispatched_to_action')
      assert.equal(verdict.status, 'dispatched_to_action', '★ 工具动作必须照旧能被派发')
      const actions = await until(async () => {
        const list = await daemon.store.listActionsByVerdict(verdict.id)
        const settled = list.filter(
          (a) => a.status !== 'proposed' && a.status !== 'auto_approved' && a.status !== 'executing',
        )
        return settled.length > 0 ? settled : null
      }, '工具动作到达终态')
      assert.equal(actions[0]?.type, fx.action)
      assert.equal(actions[0]?.status, 'executed')
    } finally {
      await daemon.close()
      await cleanup(dir)
    }
  })
})

