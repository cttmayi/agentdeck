import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TOOL_MANIFEST_SCHEMA, type Tool } from '@agentdeck/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { installToolPackage, writeToolPackage } from './testing/tool-fixture.ts'

/**
 * 工具包的安装 / 卸载 / 挂载（D40）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件证明的是"判据真的接在路由上了"
 * ══════════════════════════════════════════════════════════════════
 *
 * 判据本身（"这是不是一个适配本平台的工具包"）在
 * `packages/protocol/src/tools.ts` 的 schema 与 `tool-source.ts` 的解析里，
 * 那两条路有自己的测试（`tool-source.test.ts`）。这里测的是**另一件事**：
 * 路由有没有把那份解析当成唯一入口（而不是自己再判一遍），以及装完之后的
 * 三件事——列表里能不能看到它、库里的记录齐不齐、**挂载与卸载的边界**对不对。
 *
 * ⚠️ 全程不碰真实 CLI、不联网：daemon 用的后端是假后端（它一旦被执行就抛）。
 */

async function withDaemon<T>(fn: (d: DaemonHandle) => Promise<T>): Promise<T> {
  const dir = await makeTempDir('tools-api')
  const d = await startDaemon({
    dataDir: dir,
    port: 0,
    fsync: false,
    // 工作目录也要显式给：兜底虽然不会碰家目录，但显式给更清楚
    workRoot: join(dir, 'work'),
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
    return await fn(d)
  } finally {
    await d.close()
    await cleanup(dir)
  }
}

interface CallResult {
  status: number
  body: Record<string, unknown>
}

async function call(
  d: DaemonHandle,
  method: string,
  path: string,
  body?: unknown,
): Promise<CallResult> {
  const res = await fetch(`${d.url}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** 装一个包（两条来源走同一个接口）。 */
const installTool = (d: DaemonHandle, body: unknown) => call(d, 'POST', '/api/tools', body)

// ⚠️ 这里原来叫 `ListedTool`，比 `Tool` 多一个 `mountedBy`（"被哪些执行者挂载"）。
//    挂载能力撤掉之后接口不再算它，类型也就退回了 `Tool` 本身。
async function listTools(d: DaemonHandle): Promise<Tool[]> {
  const res = await call(d, 'GET', '/api/tools')
  assert.equal(res.status, 200)
  return res.body['tools'] as Tool[]
}

/**
 * 造一个**合规**的工具包目录。
 *
 * 合规是刻意的：这些测试要测的是路由与挂载语义，不是 schema——清单本身如果不
 * 合规，失败的会是解析那一关，而这些测试会以一个看不懂的理由红掉。
 */
async function makeToolDir(
  slug = 'demo-tool',
  over: { manifest?: Record<string, unknown>; files?: Record<string, string>; docs?: string | null } = {},
): Promise<string> {
  const dir = await makeTempDir('tool-pkg')
  const manifest = {
    schema: TOOL_MANIFEST_SCHEMA,
    slug,
    name: `${slug} 的显示名`,
    version: '1.0.0',
    description: '夹具工具包',
    runtime: 'node',
    entry: 'index.mjs',
    actions: [
      {
        name: 'run',
        summary: '跑一下',
        reversible: true,
        dryRun: 'supported',
        timeoutMs: 30_000,
        params: { bound: {}, open: {} },
      },
    ],
    ...over.manifest,
  }
  await writeFile(join(dir, 'tool.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await writeFile(join(dir, 'index.mjs'), '// 夹具：什么都不做\n', 'utf8')
  if (over.docs !== null) {
    await writeFile(join(dir, 'TOOL.md'), over.docs ?? '# 夹具工具包\n\n说明正文。\n', 'utf8')
  }
  for (const [rel, content] of Object.entries(over.files ?? {})) {
    await mkdir(join(dir, rel, '..'), { recursive: true })
    await writeFile(join(dir, rel), content, 'utf8')
  }
  return dir
}

/** 造一个执行者（默认角色），返回它的 id。 */
async function makeExecutor(d: DaemonHandle, name = '执行者'): Promise<string> {
  const res = await call(d, 'POST', '/api/agents', { name, role: 'executor' })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return res.body['id'] as string
}

// ══════════════════════════════════════════════════════════════════
// 装成功的往返
// ══════════════════════════════════════════════════════════════════

describe('★ 安装工具包：装 → 列表 → 库里的字段', () => {
  test('★ 从本机目录装：列表里有它，且 store 里的字段齐全', async () => {
    await withDaemon(async (d) => {
      const dir = await makeToolDir('demo-tool')
      const res = await installTool(d, { source: 'path', path: dir })
      assert.equal(res.status, 201, JSON.stringify(res.body))
      const tool = res.body['tool'] as Tool
      assert.equal(tool.slug, 'demo-tool')
      assert.equal(tool.source, 'local', '从本机路径装的是"使用者自有的"，不是 remote')
      assert.equal(tool.sourceRef, `path:${dir}`)

      // ① 列表里有它
      const listed = (await listTools(d)).find((t) => t.id === tool.id)
      assert.ok(listed, '装完必须能在列表里看到')

      // ② ★ 直接读 store：接口回的那份与真正落库的那份必须是同一份
      const stored = await d.store.getTool(tool.id)
      assert.ok(stored, '接口说装成功了，库里就必须有')
      assert.equal(stored.workspaceId, tool.workspaceId)
      assert.equal(stored.slug, 'demo-tool')
      assert.equal(stored.name, 'demo-tool 的显示名')
      assert.equal(stored.description, '夹具工具包')
      assert.equal(stored.version, '1.0.0')
      assert.equal(stored.manifest.schema, TOOL_MANIFEST_SCHEMA)
      assert.equal(stored.manifest.slug, stored.slug, '清单里的 slug 与提上来的那个必须是同一个值')
      assert.equal(stored.manifest.actions.length, 1)
      assert.equal(stored.manifest.actions[0]!.name, 'run')
      assert.ok(
        stored.files['index.mjs']?.includes('夹具'),
        '入口脚本要真的落库——否则"装进来了"与"跑得起来"是两件事',
      )
      assert.ok(stored.docs.includes('说明正文'), 'TOOL.md 要落库（界面要显示它）')
      assert.equal(typeof stored.createdAt, 'number')
      assert.equal(stored.createdAt, stored.updatedAt, '刚装进来时两个时间戳是同一个（同一次写入）')
      assert.ok(stored.createdAt > 0)
    })
  })

  test('★ 装页面送来的包（payload）：来源如实记成 remote', async () => {
    await withDaemon(async (d) => {
      const manifest = {
        schema: TOOL_MANIFEST_SCHEMA,
        slug: 'remote-tool',
        name: '远端来的',
        version: '2.0.0',
        description: '',
        runtime: 'node',
        entry: 'index.mjs',
        actions: [
          {
            name: 'deploy',
            summary: '部署',
            reversible: false,
            dryRun: 'unsupported',
            timeoutMs: 60_000,
            params: { bound: {}, open: {} },
          },
        ],
      }
      const res = await installTool(d, {
        source: 'payload',
        slug: 'remote-tool',
        manifest,
        files: { 'index.mjs': '// 远端夹具\n' },
        docs: '# 远端\n',
        sourceRef: 'remote:acme/remote-tool',
        version: '2.0.0',
      })
      assert.equal(res.status, 201, JSON.stringify(res.body))
      const tool = res.body['tool'] as Tool
      assert.equal(
        tool.source,
        'remote',
        '★ 从远端目录来的不能冒充"使用者自有的"——否则"本地内容不因远端变化而改变"无从判断',
      )
      assert.equal(tool.sourceRef, 'remote:acme/remote-tool')
      assert.equal(tool.version, '2.0.0')
      assert.ok(tool.docs.includes('远端'))
      assert.equal(tool.manifest.actions[0]!.name, 'deploy')
    })
  })

  test('★ 路径安装可以显式给 slug，但必须与清单一致（两处不一致没有权威）', async () => {
    await withDaemon(async (d) => {
      const dir = await makeToolDir('override-tool')
      const agree = await installTool(d, { source: 'path', path: dir, slug: 'override-tool' })
      assert.equal(agree.status, 201, JSON.stringify(agree.body))

      const dir2 = await makeToolDir('override-tool-2')
      const disagree = await installTool(d, { source: 'path', path: dir2, slug: 'something-else' })
      assert.equal(disagree.status, 400)
      assert.equal(disagree.body['code'], 'bad_input')
      assert.match(String(disagree.body['error']), /something-else.*override-tool-2/s)
      assert.equal((await listTools(d)).length, 1, '被拒的那次不能留下半条记录')
    })
  })

  test('payload 不给 sourceRef 时缺省记成 remote:<slug>', async () => {
    await withDaemon(async (d) => {
      const res = await installTool(d, {
        source: 'payload',
        slug: 'no-ref',
        manifest: {
          schema: TOOL_MANIFEST_SCHEMA,
          slug: 'no-ref',
          name: 'x',
          runtime: 'node',
          entry: 'index.mjs',
          actions: [
            {
              name: 'go',
              summary: '走',
              reversible: true,
              dryRun: 'supported',
              timeoutMs: 1_000,
              params: { bound: {}, open: {} },
            },
          ],
        },
        files: { 'index.mjs': '// x\n' },
      })
      assert.equal(res.status, 201, JSON.stringify(res.body))
      assert.equal((res.body['tool'] as Tool).sourceRef, 'remote:no-ref')
    })
  })
})

// ══════════════════════════════════════════════════════════════════
// 装失败：code 让界面决定怎么提示，detail 原样显示
// ══════════════════════════════════════════════════════════════════

describe('★ 装失败：400 + code + detail', () => {
  test('★ 路径不存在 ⇒ code=not_found', async () => {
    await withDaemon(async (d) => {
      const dir = await makeTempDir('tool-pkg')
      const res = await installTool(d, { source: 'path', path: join(dir, '不存在') })
      assert.equal(res.status, 400)
      assert.equal(res.body['code'], 'not_found')
      assert.match(String(res.body['error']), /不存在/)
    })
  })

  test('★ 目录里没有 tool.json ⇒ code=missing_tool_json，detail 说清里面有什么', async () => {
    await withDaemon(async (d) => {
      const dir = await makeTempDir('tool-pkg')
      await writeFile(join(dir, 'README.md'), '# 这不是工具包\n', 'utf8')
      const res = await installTool(d, { source: 'path', path: dir })
      assert.equal(res.status, 400)
      assert.equal(res.body['code'], 'missing_tool_json')
      assert.match(String(res.body['detail']), /README\.md/, '要告诉使用者目录里到底有什么')
    })
  })

  test('★ 清单不合规 ⇒ code=manifest_invalid，detail 逐条列出（带换行）', async () => {
    await withDaemon(async (d) => {
      const dir = await makeTempDir('tool-pkg')
      await writeFile(
        join(dir, 'tool.json'),
        JSON.stringify({
          schema: TOOL_MANIFEST_SCHEMA,
          slug: 'Bad Slug', // 不是 kebab-case
          name: 'x',
          runtime: 'node',
          entry: 'index.mjs',
          actions: [], // 空组没有意义
        }),
        'utf8',
      )
      const res = await installTool(d, { source: 'path', path: dir })
      assert.equal(res.status, 400)
      assert.equal(res.body['code'], 'manifest_invalid')
      const detail = String(res.body['detail'])
      assert.ok(
        detail.includes('\n'),
        '★ detail 里逐条列出的问题要能原样显示（换行不能被压掉），否则"哪一条不合规"就丢了',
      )
      assert.match(detail, /slug/)
    })
  })

  test('★ 清单声明的入口不在包里 ⇒ code=missing_entry（不能等第一次触发才失败）', async () => {
    await withDaemon(async (d) => {
      const dir = await makeToolDir('missing-entry', { manifest: { entry: 'nope.mjs' } })
      const res = await installTool(d, { source: 'path', path: dir })
      assert.equal(res.status, 400)
      assert.equal(res.body['code'], 'missing_entry')
      assert.match(String(res.body['error']), /nope\.mjs/)
    })
  })

  test('JSON 坏掉、source 不认识、source=payload 缺字段——一律 400 且带 code', async () => {
    await withDaemon(async (d) => {
      const badJson = await makeTempDir('tool-pkg')
      await writeFile(join(badJson, 'tool.json'), '{ 这不是 JSON }', 'utf8')
      const r1 = await installTool(d, { source: 'path', path: badJson })
      assert.equal(r1.status, 400)
      assert.equal(r1.body['code'], 'bad_json')

      const r2 = await installTool(d, { source: 'url', url: 'https://example.com/x' })
      assert.equal(r2.status, 400)
      assert.equal(r2.body['code'], 'bad_input', '工具包没有 url 这条路（脚本会在本机真的执行）')

      const r3 = await installTool(d, { source: 'payload', slug: 'x' })
      assert.equal(r3.status, 400)
      assert.equal(r3.body['code'], 'bad_input')
      assert.match(String(r3.body['error']), /manifest/)

      const r4 = await installTool(d, 'nope')
      assert.equal(r4.status, 400)
      assert.equal(r4.body['code'], 'bad_input')
    })
  })

  test('payload 的 slug / version 与清单不一致 ⇒ 保存时就拒（两处不一致没有权威）', async () => {
    await withDaemon(async (d) => {
      const manifest = {
        schema: TOOL_MANIFEST_SCHEMA,
        slug: 'in-manifest',
        name: 'x',
        version: '1.0.0',
        runtime: 'node',
        entry: 'index.mjs',
        actions: [
          {
            name: 'go',
            summary: '走',
            reversible: true,
            dryRun: 'supported',
            timeoutMs: 1_000,
            params: { bound: {}, open: {} },
          },
        ],
      }
      const files = { 'index.mjs': '// x\n' }

      const slugRes = await installTool(d, {
        source: 'payload',
        slug: 'another-name',
        manifest,
        files,
      })
      assert.equal(slugRes.status, 400)
      assert.match(String(slugRes.body['error']), /another-name.*in-manifest/s)

      const versionRes = await installTool(d, {
        source: 'payload',
        slug: 'in-manifest',
        manifest,
        files,
        version: '9.9.9',
      })
      assert.equal(versionRes.status, 400)
      assert.match(String(versionRes.body['error']), /9\.9\.9/)

      const reservedRes = await installTool(d, {
        source: 'payload',
        slug: 'in-manifest',
        manifest,
        files: { ...files, 'tool.json': '{}' },
      })
      assert.equal(reservedRes.status, 400)
      assert.match(String(reservedRes.body['error']), /tool\.json/)

      assert.deepEqual(await listTools(d), [], '三次都该是**一条都没写进去**')
    })
  })
})

// ══════════════════════════════════════════════════════════════════
// 同名冲突
// ══════════════════════════════════════════════════════════════════

describe('★ 同名冲突：一律拒绝写入，绝不静默覆盖（与 skill 同一条规则）', () => {
  test('★ 同 slug 第二次安装被拒，原内容一字未动', async () => {
    await withDaemon(async (d) => {
      const dirA = await makeToolDir('dup-tool', { manifest: { name: '第一份' } })
      const dirB = await makeToolDir('dup-tool', { manifest: { name: '第二份' } })
      const first = await installTool(d, { source: 'path', path: dirA })
      assert.equal(first.status, 201, JSON.stringify(first.body))

      const second = await installTool(d, { source: 'path', path: dirB })
      assert.equal(second.status, 400)
      assert.match(String(second.body['error']), /同名/)
      assert.match(
        String(second.body['error']),
        /overwrite/,
        '★ 拒绝必须给出可行动的做法：确实要替换就显式说',
      )
      assert.equal(second.body['code'], 'bad_input', '界面按 code 决定提示方式，不能给一个不在表里的')

      const tools = await listTools(d)
      assert.equal(tools.length, 1, '★ 不能"悄悄多出一条同名"——`getToolBySlug` 只会取到其中一条')
      assert.equal(tools[0]!.name, '第一份', '★ 使用者自己装的那份没被覆盖')
    })
  })

  test('★ 显式 overwrite 才替换，且**复用原 id**（追溯不断）', async () => {
    await withDaemon(async (d) => {
      const dirA = await makeToolDir('dup-tool', { manifest: { name: '第一份' } })
      const dirB = await makeToolDir('dup-tool', { manifest: { name: '第二份' } })
      const first = await installTool(d, { source: 'path', path: dirA })
      const firstId = (first.body['tool'] as Tool).id
      const firstCreatedAt = (first.body['tool'] as Tool).createdAt

      const second = await installTool(d, {
        source: 'path',
        path: dirB,
        overwrite: true,
      })
      assert.equal(second.status, 201, JSON.stringify(second.body))
      const replaced = second.body['tool'] as Tool
      assert.equal(
        replaced.id,
        firstId,
        '★ 复用原 id：审计记录、判决与已在跑的 run 里都留着这个包的 id 与 slug，换 id 会让追溯对不上',
      )
      assert.equal(replaced.name, '第二份')
      assert.equal(replaced.createdAt, firstCreatedAt, '这不是新装的一个包，是同一条记录的更新')

      const tools = await listTools(d)
      assert.equal(tools.length, 1)
      assert.equal(tools[0]!.id, firstId, '列表里也只有一条——是同一条记录被替换，不是新装了一个')
    })
  })
})

// ══════════════════════════════════════════════════════════════════
// 卸载
// ══════════════════════════════════════════════════════════════════

describe('★ 卸载：一律放行（"还挂着就拒"那把锁已经删掉）', () => {
  test('没人挂着 ⇒ 删得掉；再删一次是 404（"本来就没有"不是错误）', async () => {
    await withDaemon(async (d) => {
      const dir = await makeToolDir('gone-tool')
      const installed = await installTool(d, { source: 'path', path: dir })
      const id = (installed.body['tool'] as Tool).id

      const deleted = await call(d, 'DELETE', `/api/tools/${id}`)
      assert.equal(deleted.status, 200)
      assert.equal(deleted.body['deleted'], true)
      assert.equal(await d.store.getTool(id as Tool['id']), null, '库里必须真的没了')
      assert.deepEqual(await listTools(d), [])

      const again = await call(d, 'DELETE', `/api/tools/${id}`)
      assert.equal(again.status, 404, '本来就没了是 404，不是 500、也不是"成功"')
    })
  })

  /**
   * ⚠️ 这里原来是「**还有 agent 挂着 ⇒ 400**，并把名字列出来」。
   *
   * 那条拒绝已经删掉，理由是它**把使用者锁死**：它给的下一步是"先在那些智能体
   * 上把它摘掉"，而"摘掉"这个动作已经不存在了（挂载能力撤掉、那个勾选栏也没了）。
   * 一条指向死路的拒绝比不拒绝更糟——它把"我做不到"说成"你先去做那件事"。
   *
   * 所以现在**卸载一律成功**。这条测试留着，是为了盯住"以后别再把它加回来"：
   * 老数据里那个 `toolIds` 键在解析时就被丢掉了，删包不会留下悬空引用。
   */
  test('★ 卸载一个**老数据里被引用过**的包也照样成功（不再有"还挂着就拒"）', async () => {
    await withDaemon(async (d) => {
      const dir = await makeToolDir('busy-tool')
      const installed = await installTool(d, { source: 'path', path: dir })
      const id = (installed.body['tool'] as Tool).id

      // 一个执行者（老数据里它可能"挂着"这个包——那个键现在会被解析丢掉）
      await makeExecutor(d, '小李的执行者')

      const res = await call(d, 'DELETE', `/api/tools/${id}`)
      assert.equal(res.status, 200, '★ 卸载必须放行：拒绝会把使用者锁死')
      assert.equal(res.body['deleted'], true)
      assert.equal(await d.store.getTool(id as Tool['id']), null, '库里必须真的没了')
      assert.deepEqual(await listTools(d), [])
    })
  })
})

// ══════════════════════════════════════════════════════════════════
// ⚠️ 这里原来有两整块测试，共 8 个用例，全部删掉了：
//
//   · 「挂载与摘挂：授权单位是**组**」——测 `PUT /api/agents/:id/tools`
//     （整体替换 / 挂不存在的 id / 参数校验 / 去重）；
//   · 「审核者不许挂工具：它只判断、不动手」——测同一个接口的两条角色规矩。
//
// 那个接口**已经删除**（见 `server.ts` 里那段说明：挂载能力撤掉之后它没有任何
// 调用方）。接口没了，测它的用例就是测一条不存在的路——留着只会让下一个读代码的
// 人以为挂载还能用。
//
// ⚠️ 其中有一条测试防的是"老数据（挂着工具的审核者）被规则锁死"——那条**顾虑
//    本身仍然成立**，只是它现在由"卸载一律放行"来满足（见上面卸载那一块），
//    因为字段已经从协议里删掉，老数据里那个键解析时就被丢掉了。
// ══════════════════════════════════════════════════════════════════

describe('★ 动作权限写在**组**上：接受已装工具的第三方动作，未安装的在保存时拒', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ 这一整块原来测的是"动作权限写在 **agent** 上"（D40 收口）
   * ══════════════════════════════════════════════════════════════════
   *
   * 2026-10 起动作权限**只属于智能体组**（`AgentGroup.allowedActions`）：同一个
   * 审核者出现在不同的组里，本来就该配不同的处置权限——而"判完允许动什么"是**这条
   * 链**的事，不是某个人长期的能力。所以写入口从 `POST/PATCH /api/agents` 搬到了
   * `POST/PATCH /api/agent-groups`，而校验逻辑（对着**已安装的工具包**核）一个字
   * 没变：它本来就在 `parseAllowedActions` 里，两边共用。
   *
   * 于是这一块的每个用例都**跟着写入口走**：它守的是"哪些动作名被接受/被拒"这件事，
   * 不是某一个 URL。这样搬家之后，校验矩阵仍然是满的。
   *
   * ── 三条用例**删掉**了（它们的对象不再存在，理由写在这里）──
   *
   *   · 「执行者带非空动作 ⇒ 400」（`rejectActionsForExecutor`）；
   *   · 「角色从执行者改成审核者时可以一并带上动作」；
   *   · 「有动作的审核者不能一步变成执行者（先清空，再改角色）」。
   *
   * 它们守的是"只有**审核者**能有动作权限"这条角色规矩。现在动作挂在**组**上，
   * 而组按形态**必然**是 1 执行 + 1 审核——角色与动作之间不再有可判的关系，
   * 那条规矩**没有可判的东西了**。`rejectActionsForExecutor` 也随字段一起删掉了。
   *
   * ⚠️ 但它防过的那件事仍然成立、只是换了位置：动作**不会**被某个执行者顺手拿到，
   *    因为执行者身上根本没有动作字段（写进 `POST /api/agents` 就是 400
   *    「不认识的字段」——这条在上面的 agents 用例里钉着）。
   */

  /** 建一对"执行者 + 审核者"（组必须恰好 1+1），返回它们的 id。 */
  async function makePair(d: DaemonHandle): Promise<[string, string]> {
    const executor = await makeExecutor(d, '组里的执行者')
    const reviewer = (await call(d, 'POST', '/api/agents', {
      name: '组里的审核者',
      role: 'reviewer',
      reviewStandard: { body: '正文' },
    })).body['id'] as string
    return [executor, reviewer]
  }

  /** 建一个带指定动作的组（本块所有用例的写入口）。 */
  async function makeGroup(
    d: DaemonHandle,
    allowedActions: string[],
    members?: [string, string],
  ): Promise<CallResult> {
    const pair = members ?? (await makePair(d))
    return call(d, 'POST', '/api/agent-groups', {
      name: '动作测试组',
      members: pair,
      allowedActions,
    })
  }

  test('★ 已安装工具的动作可以写在组上（`<包 slug>.<动作名>`）', async () => {
    await withDaemon(async (d) => {
      const pkg = await writeToolPackage({ slug: 'demo-tool' })
      await installToolPackage(d, pkg)

      const res = await makeGroup(d, [pkg.action])
      assert.equal(res.status, 201, JSON.stringify(res.body))
      const group = res.body['group'] as { allowedActions: string[] }
      assert.deepEqual(
        group.allowedActions,
        [pkg.action],
        '★ 已装包声明的动作要如实存下来 —— 判决引用它时才有依据',
      )
    })
  })

  test('★ 未安装的第三方动作 ⇒ 保存时就 400，并说清是哪个包没装', async () => {
    await withDaemon(async (d) => {
      // ★ D41：这份请求里"合法的那一半"必须是**已装**工具包声明的动作——否则它自己
      //   就会先被"包没装"拦下，这条用例再也测不到"整份请求都不生效"。
      const pkg = await writeToolPackage({ slug: 'demo-tool', actionName: 'run' })
      await installToolPackage(d, pkg)
      const pair = await makePair(d)
      const created = await makeGroup(d, [pkg.action], pair)
      assert.equal(created.status, 201, JSON.stringify(created.body))
      const id = (created.body['group'] as { id: string }).id

      // "没装的那个包"用一个**明确不存在**的名字：老的内置名（`comment.create`）
      // 现在也落在同一条规则里，但拿它当夹具会让"哪个包没装"这句读起来像在说一个
      // 内置动作（那条语义变化单独记在下面那条用例里）。
      const res = await call(d, 'PATCH', `/api/agent-groups/${id}`, {
        allowedActions: [pkg.action, 'ghost-tool.run'],
      })
      assert.equal(res.status, 400, '★ 早拒：跑到一半才发现"策略要的动作找不到包"就是每次都失败')
      const error = String(res.body['error'])
      assert.match(error, /ghost-tool\.run/, '要说清**哪个动作**')
      assert.match(error, /ghost-tool/, '要说清**因为哪个包没装**')
      assert.match(error, /安装/)

      const group = await call(d, 'GET', `/api/agent-groups/${id}`)
      assert.deepEqual(
        (group.body['group'] as { allowedActions: string[] }).allowedActions,
        [pkg.action],
        '拒了就不能写进去（原来那份要原样留着）',
      )
    })
  })

  test('★ 包装着、但没声明这个动作 ⇒ 也拒（拼错动作名不能拖到运行时）', async () => {
    await withDaemon(async (d) => {
      await installTool(d, { source: 'path', path: await makeToolDir('demo-tool') })
      const res = await makeGroup(d, ['demo-tool.runn'])
      assert.equal(res.status, 400)
      assert.match(String(res.body['error']), /没有声明/)
      assert.match(String(res.body['error']), /run/, '要顺带说清这个包声明的是哪些动作')
    })
  })

  test('形状不对的动作名照旧拒（不认识就是不认识，不猜）', async () => {
    await withDaemon(async (d) => {
      const res = await makeGroup(d, ['Demo_Tool.run'])
      assert.equal(res.status, 400)
      assert.match(String(res.body['error']), /不认识的动作/)
    })
  })

  test('★ D41：老的内置动作名不再有任何特殊路径——要么"包没装"，要么连形状都不对', async () => {
    await withDaemon(async (d) => {
      // 内置动作被移除之前，`comment.create` 这类名字在白名单里是**原样放行**的
      // （那时有一个"内置动作集合"专门给它们开一条路）。D41 把那个集合删了，
      // 于是这些老名字和任何一个动作名走**同一条**校验——再没有"内置"与"第三方"
      // 的区别了。这条用例把新的现实钉住，免得以后有人以为它们还在。
      const shaped = await makeGroup(d, ['comment.create'])
      assert.equal(shaped.status, 400)
      assert.match(
        String(shaped.body['error']),
        /还没安装/,
        '★ `comment.create` 的形状恰好合法（看起来就是 `<包>.<动作名>`），所以它落在"工具包 comment 没装"上',
      )
      assert.match(String(shaped.body['error']), /comment/)

      // 这一批连形状都不合法（下划线不在允许字符里），所以更容易认：不是动作名。
      const unshaped = await makeGroup(d, ['issue.update_status', 'issue.add_label'])
      assert.equal(unshaped.status, 400)
      assert.match(String(unshaped.body['error']), /不认识的动作/)
      assert.match(String(unshaped.body['error']), /issue\.update_status/)
    })
  })

  test('★ 包被卸载之后，组上那份动作仍然在（它是保存时的快照，不是活引用）', async () => {
    await withDaemon(async (d) => {
      const installed = await installTool(d, { source: 'path', path: await makeToolDir('demo-tool') })
      const toolId = (installed.body['tool'] as Tool).id
      const created = await makeGroup(d, ['demo-tool.run'])
      assert.equal(created.status, 201, JSON.stringify(created.body))
      const id = (created.body['group'] as { id: string }).id
      assert.equal((await call(d, 'DELETE', `/api/tools/${toolId}`)).status, 200)

      const group = await call(d, 'GET', `/api/agent-groups/${id}`)
      assert.deepEqual(
        (group.body['group'] as { allowedActions: string[] }).allowedActions,
        ['demo-tool.run'],
        '库里的那份不该因为卸载而被改掉——该拦的是"再保存一次"（那一次会被"包没装"拒）',
      )
    })
  })

  test('★ 老客户端把动作写在标准里的那次请求：不报错，但**不写库**（只读兼容字段）', async () => {
    await withDaemon(async (d) => {
      // ★ D41：老字段里放的也得是一个**真动作**了（平台已经没有内置动作）——
      //   用一个已装工具包真的声明了的动作，"它照样不被采纳"这句话才立得住。
      const pkg = await writeToolPackage({ slug: 'legacy-standard-tool', actionName: 'run' })
      await installToolPackage(d, pkg)

      // 搬走之前，动作是写在 `reviewStandard` 里的。老客户端会照旧这么发。
      const created = await call(d, 'POST', '/api/agents', {
        name: '老客户端建的审核者',
        role: 'reviewer',
        reviewStandard: { body: '正文', allowedActions: [pkg.action] },
      })
      assert.equal(created.status, 201, '不是"装错了"，只是那一项不再属于标准——不该整条拒掉')
      const body = created.body as Record<string, unknown>
      assert.equal(
        body['allowedActions'],
        undefined,
        '★ 老字段里的值不会被搬到任何地方去（动作只属于组，agent 上连这个键都不该有）',
      )
      assert.equal(
        (body['reviewStandard'] as Record<string, unknown>)['allowedActions'],
        undefined,
        '★ 标准里也不留那个键：两处都写就会出现两个出处',
      )
    })
  })
})
