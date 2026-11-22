import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * **按 scope 读/写一个文件：发的是文件本身的字节**（2026-11，D254）。
 *
 * 使用者报的原话：「智能体存储的 `instructions.md` 不是真 md，而是 json」——
 * 他在智能体编辑页的「目录」里点开 `instructions.md`，看到的是：
 *
 *     {"text":"你是一个严格的审核者。逐条核查……","bytes":204}
 *
 * 磁盘上的文件其实是好 markdown。出问题的是 D245 那条路由：
 *
 *     const buf = await readScopeFile(dir, rel)
 *     sendJson(res, 200, { text: buf.toString('utf8'), bytes: buf.byteLength })   // ← 信封
 *
 * 而查看器（`FileViewer`）是 `res.arrayBuffer()` 之后按 UTF-8 解码——**信封被当成了
 * 正文**。工作目录那条路（`sendWorkFile`）一直是"`content-type` + 原始字节 + 那组
 * 防 XSS 的响应头"，这条新路由当时另起了一套。
 *
 * 所以这条用例钉三件事：
 *   ① `content-type` 按后缀给（`text/plain` 之类），**不是** `application/json`；
 *   ② 响应体**就是文件本身**（不含 `"bytes"` 那种信封字段）；
 *   ③ 那组安全响应头（`X-Content-Type-Options: nosniff` 与带 sandbox 的 CSP）还在
 *      ——这些目录里的文件同样是 agent 写的，不能因为换了个 scope 就少一层。
 *
 * 另外顺带钉住写：`PUT` 之后 `GET` 能读到刚写进去的正文（保存写回磁盘那条路）。
 */
describe('★ D254：scope 的文件接口发原始字节', () => {
  test('★★ GET 发文件本身（不是 {text,bytes} 信封）＋带 nosniff/CSP；PUT 后读得回', async () => {
    const dataDir = await makeTempDir('fs-scope-file')
    const workRoot = await makeTempDir('fs-scope-file-work')
    const wsId = '01WSSCOPEFILE000000000000001'
    await mkdir(join(dataDir, 'workspaces', wsId, 'log'), { recursive: true })
    const agentDir = join(dataDir, 'agents', '审核员')
    await mkdir(agentDir, { recursive: true })
    const agentId = '01AGENTSCOPEFILE00000000001'
    await writeFile(
      join(agentDir, 'agent.json'),
      JSON.stringify({ id: agentId, workspaceId: wsId, name: '审核员', skillIds: [] }, null, 2),
      'utf8',
    )
    const md = '# 审核员\n\n逐条核查，每条结论都要有依据。\n'
    await writeFile(join(agentDir, 'instructions.md'), md, 'utf8')

    const daemon = await startDaemon({
      dataDir,
      port: 0,
      fsync: false,
      runtimeKey: 'generic',
      workRoot,
      backend: {
        key: 'generic',
        protocol: 'stream-json',
        rejectDetectable: false,
        async probe() {
          return { available: true, command: 'fake', cliVersion: '0.0.0-fake' }
        },
        async execute() {
          return { async *[Symbol.asyncIterator]() {}, sessionId: null, exitCode: 0 }
        },
      } as never,
      onWarn: () => {},
      onInfo: () => {},
    })
    try {
      const base = `${daemon.url}/api/fs/agent:${agentId}`

      // ① 目录列表：这个文件在
      const listed = (await (await fetch(`${base}/files`)).json()) as {
        entries: Array<{ path: string }>
      }
      assert.ok(
        listed.entries.some((e) => e.path === 'instructions.md'),
        '目录列表里要有 instructions.md',
      )

      // ② 读：正文就是 markdown，头也是文本类型
      const res = await fetch(`${base}/file?path=${encodeURIComponent('instructions.md')}`)
      assert.equal(res.status, 200)
      const ctype = res.headers.get('content-type') ?? ''
      assert.ok(
        !ctype.includes('json'),
        `content-type 不能是 json（查看器按 UTF-8 解码原始字节）：${ctype}`,
      )
      assert.ok(ctype.startsWith('text/'), `content-type 要是文本类：${ctype}`)
      const body = await res.text()
      assert.equal(body, md, '响应体就是磁盘上的那份正文')
      assert.ok(!body.includes('"bytes"'), '不许把 {text,bytes} 信封当正文发出去')

      // ③ 安全头：这些文件是 agent 写的，与工作目录那条路由同一套
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
      assert.match(
        res.headers.get('content-security-policy') ?? '',
        /sandbox/,
        'CSP 要带 sandbox（不许 allow-same-origin）',
      )
      assert.ok(
        !(res.headers.get('content-security-policy') ?? '').includes('allow-same-origin'),
        '绝不要 allow-same-origin',
      )

      // ④ 写：改过的正文能落盘、能读回（目录里就是给人改的）
      const next = '# 审核员（改过）\n\n新的一句。\n'
      const put = await fetch(`${base}/file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'instructions.md', text: next }),
      })
      assert.equal(put.status, 200)
      const after = await (
        await fetch(`${base}/file?path=${encodeURIComponent('instructions.md')}`)
      ).text()
      assert.equal(after, next, 'PUT 之后读回来的是新正文')

      // ⑤ 认不出来的 scope / 不存在的实体：如实报错，不是 200 空文
      const badScope = await fetch(`${daemon.url}/api/fs/nope:whatever/file?path=x`)
      assert.equal(badScope.status, 400)
      const missing = await fetch(
        `${daemon.url}/api/fs/agent:01NOSUCHAGENT0000000000000/file?path=instructions.md`,
      )
      assert.equal(missing.status, 404)
    } finally {
      await daemon.close()
      await cleanup(dataDir)
      await cleanup(workRoot)
    }
  })
})
