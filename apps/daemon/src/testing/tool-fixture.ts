import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  TOOL_MANIFEST_SCHEMA,
  ulid,
  type Agent,
  type Tool,
  type ToolManifest,
  type WorkspaceId,
} from '@agentdeck/protocol'
import type { Store } from '@agentdeck/domain'
import { makeTempDir } from './tmp.ts'

/**
 * HTTP 夹具只要能拿到 URL 就够——**不要**要求完整的 `DaemonHandle`。
 *
 * 有些测试的 `withDaemon` 只把 `url` 传进来（它们的夹具不关心 store），
 * 收窄成 `DaemonHandle` 会逼着调用方为一个类型去改自己的夹具形状，
 * 而这里真正用到的只有 `d.url`。
 */
export interface FixtureDaemon {
  url: string
}

/**
 * 工具包动作夹具（D41 之后**唯一**的动作来源）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要这个共享助手
 * ══════════════════════════════════════════════════════════════════
 *
 * 平台的内置动作（`comment.create` / `issue.update_status` / …）全部移除之后，
 * "判决带一个动作"这件事在测试里不再能靠写一个裸名做到：那个动作必须来自一个
 * **真的装了**的工具包。而"造包 + 装 + 挂 + 给审核者白名单"是四步纯装配噪音，
 * 每处各写一遍的话，夹具自身的 bug 会伪装成产品缺陷。
 *
 * 所以这里把四步收成一行（`setupToolFixture`），并给出拆开用的零件：
 *
 *   · `writeToolPackage()`  —— 磁盘上造一个最小工具包（真 `node` 脚本）；
 *   · `seedToolFixture()`   —— store 级：造包 + 落库（给直接用 FileStore 的测试）；
 *   · `installToolPackage()` —— HTTP 级：走真实的安装接口；
 *   · `setupToolFixture()`  —— HTTP 级一行版（最常见的用法）。
 *
 * ══════════════════════════════════════════════════════════════════
 * NFR-T-01：绝不调用真实 CLI —— 但我们**自己的**脚本是真跑的
 * ══════════════════════════════════════════════════════════════════
 *
 * 假后端只负责"agent 说了什么"；动作那条路走的是工具包脚本，而它由我们自己写、
 * 只往**工作目录**里写一个文件（`fixture-out.txt`）。真跑它的意义是让"动作到底
 * 有没有落地"有硬证据，而不是靠断言某个函数被调用过。这与
 * `examples/tools/example-note` 是同一种做法。
 */

// ══════════════════════════════════════════════════════════════════
// ① 造包
// ══════════════════════════════════════════════════════════════════

/**
 * 默认入口脚本的正文。
 *
 * 三条约定（与 `examples/tools/example-note` 完全一致）：
 *   · stdin 收一份 JSON（`{ action, params, dryRun, context }`）；
 *   · stdout 出一份 JSON（`{ ok, detail }`）；
 *   · `dryRun: true` 时**只描述、不许改**——夹具如实遵守，所以它声明 supported。
 *
 * ⚠️ 产物写在 `params.dir`（绑定参数 `workdir`）里，而**不是**当前目录：
 *    写到当前目录的脚本会让"产物落地"这条断言在 daemon 自己的 cwd 里通过，
 *    而那正是绑定参数要防的事。
 */
const DEFAULT_SCRIPT = [
  "import { appendFile } from 'node:fs/promises'",
  "import { join } from 'node:path'",
  'const chunks = []',
  'for await (const chunk of process.stdin) chunks.push(chunk)',
  'const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")',
  'const params = input.params ?? {}',
  'const dir = params.dir',
  'if (typeof dir !== "string" || dir === "") {',
  '  process.stdout.write(JSON.stringify({ ok: false, detail: "没有拿到工作目录（bound 参数 dir 缺失）" }))',
  '} else {',
  '  const target = join(dir, "fixture-out.txt")',
  '  const text = typeof params.text === "string" ? params.text : String(input.action)',
  '  if (input.dryRun === true) {',
  '    process.stdout.write(JSON.stringify({ ok: true, detail: "会往 " + target + " 追加一行（dry-run，没有真的写）" }))',
  '  } else {',
  '    await appendFile(target, "- " + text + "\\n", "utf8")',
  '    process.stdout.write(JSON.stringify({ ok: true, detail: "已往 " + target + " 追加一行" }))',
  '  }',
  '}',
].join('\n')

export interface ToolPackageSpec {
  /** 包 slug，同时是动作的命名空间。默认 `fixture-tool`。 */
  slug?: string
  /** 组内动作名。默认 `act`。 */
  actionName?: string
  /** 动作摘要（会进日志与判决契约）。 */
  summary?: string
  /** `supported`（默认）会让动作能被自动执行；`unsupported` 用于测准入。 */
  dryRun?: 'supported' | 'unsupported'
  /** 自定义入口脚本正文；不给我就用默认那个（往工作目录写 `fixture-out.txt`）。 */
  script?: string
  /** 覆盖清单里的字段（`actions` 会被整体替换，慎用——见下面的注释）。 */
  manifest?: Partial<Omit<ToolManifest, 'actions'>> & { actions?: ToolManifest['actions'] }
  /** 额外的支持文件（相对包根 → 正文）。 */
  files?: Record<string, string>
  /** 包目录的父目录；不给我就自建一个临时目录。 */
  root?: string
}

export interface ToolPackage {
  /** 包目录（本地来源：`POST /api/tools { source: 'path', path: dir }`）。 */
  dir: string
  slug: string
  /** 组内动作名（不含命名空间）。 */
  actionName: string
  /** 完整动作名 `<slug>.<动作名>`——判决与白名单里写的就是它。 */
  action: string
  manifest: ToolManifest
  /** 包里的文件（相对路径 → 正文），与 `Tool.files` 同一个形状。 */
  files: Record<string, string>
}

/**
 * 在磁盘上造一个**最小但合规**的工具包，返回它的目录与解析好的清单。
 *
 * 合规是刻意的：只要清单不合规，失败的会是解析那一关，而调用方想测的是别的事
 * （动作执行、流程、审计……），那会以看不懂的理由红掉。
 */
export async function writeToolPackage(spec: ToolPackageSpec = {}): Promise<ToolPackage> {
  const slug = spec.slug ?? 'fixture-tool'
  const actionName = spec.actionName ?? 'act'
  const entry = 'index.mjs'
  const script = spec.script ?? DEFAULT_SCRIPT
  const files: Record<string, string> = { [entry]: script, ...(spec.files ?? {}) }

  const manifest: ToolManifest = {
    schema: TOOL_MANIFEST_SCHEMA,
    slug,
    name: `${slug} 夹具`,
    version: '1.0.0',
    description: '夹具工具包：只往工作目录写一个文件。',
    runtime: 'node',
    entry,
    actions: [
      {
        name: actionName,
        summary: spec.summary ?? '夹具动作：往工作目录追加一行',
        reversible: true,
        dryRun: spec.dryRun ?? 'supported',
        timeoutMs: 30_000,
        params: {
          // ★ 绑定参数 `dir` 来自事实（run 的 workdir）——夹具因此天然证明
          //   "模型给的参数与平台绑的参数是分开的"。
          bound: { dir: { from: 'workdir' } },
          open: { text: { type: 'string', max: 2000 } },
        },
      },
    ],
    ...spec.manifest,
  } as ToolManifest

  const dir = join(spec.root ?? (await makeTempDir('tool-fixture')), `${slug}-pkg`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'tool.json'), JSON.stringify(manifest, null, 2), 'utf8')
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, body, 'utf8')
  }

  return { dir, slug, actionName, action: `${slug}.${actionName}`, manifest, files }
}

// ══════════════════════════════════════════════════════════════════
// ② store 级：直接用 FileStore 的测试（不做 HTTP）
// ══════════════════════════════════════════════════════════════════

/** 把包变成一个可以 `store.insertTool()` 的实体。 */
export function toolEntity(
  pkg: ToolPackage,
  over: { id?: string; workspaceId: WorkspaceId },
): Tool {
  const now = Date.now()
  return {
    id: (over.id ?? ulid()) as Tool['id'],
    workspaceId: over.workspaceId,
    slug: pkg.slug,
    name: pkg.manifest.name,
    description: pkg.manifest.description,
    version: pkg.manifest.version,
    manifest: pkg.manifest,
    files: pkg.files,
    docs: '',
    source: 'local',
    sourceRef: null,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * store 级一行版：造包 → 落库 → 返回包与实体。
 *
 * 用于"直接 `new ActionRunner({ store, ... })`"的那类测试——它们不走 HTTP，
 * 但同样需要一个**装了**的工具动作。
 */
export async function seedToolFixture(
  store: Store,
  workspaceId: WorkspaceId,
  spec: ToolPackageSpec = {},
): Promise<{ pkg: ToolPackage; tool: Tool }> {
  const pkg = await writeToolPackage(spec)
  const tool = toolEntity(pkg, { workspaceId })
  await store.insertTool(tool)
  return { pkg, tool }
}

// ══════════════════════════════════════════════════════════════════
// ③ HTTP 级：走真实的安装 / 挂载接口
// ══════════════════════════════════════════════════════════════════

async function sendJson<T>(
  url: string,
  body: unknown,
  method: 'POST' | 'PUT' = 'POST',
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url} 应当成功，实际 ${res.status}：${text.slice(0, 400)}`)
  return JSON.parse(text) as T
}

/** 装一个包（本地目录来源，走真实安装路径——含清单校验与落库）。 */
export async function installToolPackage(d: FixtureDaemon, pkg: ToolPackage): Promise<Tool> {
  const body = await sendJson<{ tool: Tool }>(`${d.url}/api/tools`, {
    source: 'path',
    path: pkg.dir,
  })
  return body.tool
}

// ⚠️ 这里原来有 `mountTool()` / `mountTools()`（`PUT /api/agents/:id/tools`：
//    把一个包按**组**挂到某个 agent 身上）。挂载能力撤掉、接口也删了，两个夹具
//    函数一并删掉——夹具是给测试用的**入口**，留着一个"还能挂"的入口等于给下一个人
//    递一把开不了门的钥匙。

/**
 * `POST /api/agents` 的最小封装。
 *
 * ⚠️ 这个接口返回的是 **agent 本身**（201），不是 `{ agent }`——与
 *    `PUT /api/agents/:id/tools` 的形状不同。把两者记混会让夹具在
 *    `executor.id` 上报 "Cannot read properties of undefined"，
 *    而症状看起来像"建 agent 失败了"。
 */
async function createAgent(d: FixtureDaemon, body: Record<string, unknown>): Promise<Agent> {
  const res = await fetch(`${d.url}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`建 agent 应当成功，实际 ${res.status}：${text.slice(0, 400)}`)
  return JSON.parse(text) as Agent
}

export interface ToolFixtureSpec extends ToolPackageSpec {
  executorName?: string
  reviewerName?: string
  /** 审核标准正文；不给就用一句"什么都算通过"。 */
  standardBody?: string
  /**
   * 审核者的行动权限。
   *
   * 默认就是**这个包声明的那个动作**——夹具的常规用途是"判决能触发一个动作"。
   * 显式传空数组可以造出"审核者什么都不能做"那种局面（D41 的播种默认值）。
   */
  allowedActions?: readonly string[]
}

export interface ToolFixture {
  pkg: ToolPackage
  tool: Tool
  /** 执行者（`reviewerAgentId` 已指向下面那个审核者）。 */
  executor: Agent
  /** 审核者（带标准与行动权限）。 */
  reviewer: Agent
  /** 完整动作名 `<slug>.<动作名>`。 */
  action: string
  /** 审核者的行动权限（最终值）。 */
  allowedActions: string[]
}

/**
 * ★ HTTP 级一行版：造包 → 装 → 建执行者 + 审核者 → 执行者指向审核者 →
 *   把工具挂到执行者 → 给审核者那份行动权限。
 *
 * 这几步的正常顺序就这五步，任何一处装错（漏挂、漏白名单）都会让"判决带动作"
 * 以"动作不合规"的形式失败——而那个症状指向的是产品，不是夹具。所以收成一行。
 *
 * ⚠️ 审核者**不挂工具**（那是服务端硬规则：审核者只判断不动手）。动作的执行
 *    发生在**平台**这一侧，而"平台会执行哪些动作"由审核者的行动权限决定。
 */
export async function setupToolFixture(
  d: FixtureDaemon,
  spec: ToolFixtureSpec = {},
): Promise<ToolFixture> {
  const pkg = await writeToolPackage(spec)
  const tool = await installToolPackage(d, pkg)

  const executor = await createAgent(d, {
    name: spec.executorName ?? '夹具执行者',
    instructions: '',
    runtimeKey: 'claude',
    role: 'executor',
  })
  const allowedActions = [...(spec.allowedActions ?? [pkg.action])]
  const reviewer = await createAgent(d, {
    name: spec.reviewerName ?? '夹具审核者',
    instructions: '',
    runtimeKey: 'claude',
    role: 'reviewer',
    allowedActions,
    reviewStandard: {
      name: '夹具标准',
      body: spec.standardBody ?? '# 夹具标准\n\n只要产出不为空就算通过。',
    },
  })

  const patched = await fetch(`${d.url}/api/agents/${executor.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reviewerAgentId: reviewer.id }),
  })
  if (!patched.ok) {
    throw new Error(`设置审核者应当成功，实际 ${patched.status}：${(await patched.text()).slice(0, 300)}`)
  }

  return { pkg, tool, executor, reviewer, action: pkg.action, allowedActions }
}

// ══════════════════════════════════════════════════════════════════
// ④ 判决里那条动作
// ══════════════════════════════════════════════════════════════════

/**
 * 判决 `action` 字段的形状：**只给开放参数**。
 *
 * 绑定参数（`dir`）由平台按事实注入，模型写不出来、也不该写——把它写进来会被
 * 校验按"未知键"拒掉。所以这里只收 `open`，而且默认是空对象。
 *
 * ⚠️ **默认夹具包的 `text` 是必填的开放参数**（`OpenParamSpec.required` 缺省为
 *    `true`），所以 `verdictAction(fx.action)` 会以「动作参数 text：必填，但模型
 *    没有给这个参数」失败。那个错误前缀是 `动作参数 ` ⇒ `isStructuralInvalid`
 *    判它**不是结构性**问题 ⇒ 判决走 retry/downgrade 而**不是** escalated。
 *
 *    要测"白名单拦下 / 要人介入"那条路时，**务必**写 `verdictAction(a, { text: '…' })`：
 *    否则断言会红在一个看起来毫不相干的地方（"为什么没 escalated"），而真正的原因
 *    是夹具少给了一个参数。
 *
 *    想用别的参数形状，就在 `writeToolPackage({ manifest: { actions: [...] } })` 里
 *    自己声明——`open` 的各参数名与 `required` 都由清单说了算。
 */
export function verdictAction(
  action: string,
  open: Record<string, unknown> = {},
): { type: string; params: Record<string, unknown> } {
  return { type: action, params: { ...open } }
}
