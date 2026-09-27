import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  MCP_PROTOCOL_VERSION,
  TOOLS,
  findTool,
  handleRequest,
  toolsList,
} from './server.ts'

/**
 * 对外 MCP server。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里最要紧的一组测试是"**哪些没被暴露**"
 * ══════════════════════════════════════════════════════════════════
 *
 * MCP 一接出去，别的 agent 就能驱动本系统，而**这道边界一旦放开就很难收回**
 * ——外面会有人开始依赖它。所以"不暴露什么"和"暴露什么"一样是契约，
 * 必须被测试钉住，而不是只写在注释里。
 *
 * 具体到 `POST /api/runs`：它会接受一个任意 `workDir`，然后在那个目录里
 * 启动一个会读写文件的子进程。把它接进 MCP，等于把"在你机器上按我给的
 * 路径执行 agent"变成一次普通的工具调用。
 */

/** 造一个假的 daemon：记录被请求的路径，返回固定响应。 */
function fakeDaemon(handler?: (path: string, init?: RequestInit) => unknown) {
  const calls: { path: string; init?: RequestInit }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const path = url.replace('http://127.0.0.1:4517', '')
    calls.push({ path, ...(init ? { init } : {}) })
    const body = handler ? handler(path, init) : { ok: true, path }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { calls, ctx: { daemonUrl: 'http://127.0.0.1:4517', fetchImpl } }
}

describe('MCP 协议握手', () => {
  test('initialize 报出协议版本与工具能力', async () => {
    const { ctx } = fakeDaemon()
    const res = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, ctx)
    const result = res?.result as {
      protocolVersion: string
      capabilities: { tools?: unknown }
      serverInfo: { name: string }
    }
    assert.equal(result.protocolVersion, MCP_PROTOCOL_VERSION)
    assert.ok(result.capabilities.tools, '必须声明 tools 能力，否则客户端根本不会来调')
    assert.equal(result.serverInfo.name, 'agentdeck')
  })

  test('notifications 不产生响应（回了就是协议违规）', async () => {
    const { ctx } = fakeDaemon()
    assert.equal(
      await handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx),
      null,
    )
  })

  test('未知方法返回 -32601，并保留请求 id', async () => {
    const { ctx } = fakeDaemon()
    const res = await handleRequest({ jsonrpc: '2.0', id: 7, method: 'nope' }, ctx)
    assert.equal(res?.id, 7)
    assert.equal(res?.error?.code, -32601)
  })

  test('tools/list 列出全部工具，且不泄漏内部实现', () => {
    const list = toolsList()
    assert.ok(list.tools.length > 0)
    for (const tool of list.tools) {
      assert.ok(!('run' in tool), 'tools/list 不该把实现体发给客户端')
      assert.equal(typeof tool.description, 'string')
    }
  })
})

describe('★ 暴露范围：不执行、不写代码、不改配置', () => {
  test('★ 没有任何工具能直接提交 run（那等于任意目录代码执行）', () => {
    const names = TOOLS.map((t) => t.name)
    assert.ok(
      !names.includes('submit_run') && !names.includes('run_agent'),
      '提交 run 接受任意 workDir 并会启动子进程——不能作为 MCP 工具暴露',
    )
  })

  test('★ 没有任何工具能写 skill 或改 agent 配置', () => {
    const names = TOOLS.map((t) => t.name)
    for (const forbidden of ['install_skill', 'write_skill', 'create_agent', 'update_agent']) {
      assert.ok(!names.includes(forbidden), `${forbidden} 不该被暴露`)
    }
  })

  test('submit_report 只是投递材料，描述里明确说了它不执行任何命令', () => {
    const tool = findTool('submit_report')
    assert.ok(tool)
    assert.match(tool.description, /不执行任何命令/)
  })

  test('每个工具都声明了闭合的参数 schema（不允许塞入未声明字段）', () => {
    for (const tool of TOOLS) {
      assert.equal(
        tool.inputSchema['additionalProperties'],
        false,
        `${tool.name} 的参数必须是闭合的——否则未声明的字段会被静默吞掉`,
      )
    }
  })

  test('未知工具名把可用清单一并返回，便于调用方纠错', async () => {
    const { ctx } = fakeDaemon()
    const res = await handleRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } },
      ctx,
    )
    assert.match(res?.error?.message ?? '', /list_issues/)
  })
})

describe('工具调用', () => {
  test('list_issues 把过滤条件传给 daemon', async () => {
    const { calls, ctx } = fakeDaemon()
    await handleRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_issues', arguments: { status: 'todo', limit: 5 } },
      },
      ctx,
    )
    assert.match(calls[0]?.path ?? '', /\/api\/issues\?/)
    assert.match(calls[0]?.path ?? '', /status=todo/)
    assert.match(calls[0]?.path ?? '', /limit=5/)
  })

  test('runId 会被 URL 编码（不能让它拼出别的路径）', async () => {
    const { calls, ctx } = fakeDaemon()
    await handleRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_run', arguments: { runId: '../identity' } },
      },
      ctx,
    )
    assert.ok(
      !calls[0]?.path.includes('../'),
      `路径穿越必须被编码掉，实得 ${calls[0]?.path}`,
    )
  })

  test('参数缺失走工具层错误（isError），让模型能看见原因并改参数', async () => {
    const { ctx } = fakeDaemon()
    const res = await handleRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_run' } },
      ctx,
    )
    // 有意的分层：**协议层**错误（未知方法/未知工具名）用 JSON-RPC error，
    // **工具层**错误（参数不对、daemon 报错）用 result + isError。
    // 后者模型看得见原因、可以自己纠正；前者是客户端的事。
    const result = res?.result as { isError?: boolean; content: { text: string }[] }
    assert.equal(result?.isError, true)
    assert.match(result?.content[0]?.text ?? '', /runId/)
  })

  test('★ daemon 没起来时给出可执行的提示，而不是一个 ENOENT', async () => {
    const ctx = {
      daemonUrl: 'http://127.0.0.1:4517',
      fetchImpl: (async () => {
        throw new Error('fetch failed')
      }) as unknown as typeof fetch,
    }
    const res = await handleRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_issues' } },
      ctx,
    )
    const result = res?.result as { isError?: boolean; content: { text: string }[] }
    assert.equal(result?.isError, true)
    assert.match(result?.content[0]?.text ?? '', /pnpm run daemon/)
  })

  test('daemon 返回错误时把原文带出来，而不是笼统的"调用失败"', async () => {
    const ctx = {
      daemonUrl: 'http://127.0.0.1:4517',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: 'issue 不存在：xyz' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    }
    const res = await handleRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_run', arguments: { runId: 'xyz' } },
      },
      ctx,
    )
    const result = res?.result as { content: { text: string }[] }
    assert.match(result.content[0]?.text ?? '', /issue 不存在：xyz/)
  })

  test('submit_report 把 source 与 items 原样递过去', async () => {
    const { calls, ctx } = fakeDaemon(() => ({ unmatched: 0, runIds: ['r1'] }))
    const res = await handleRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'submit_report',
          arguments: {
            source: 'ci',
            items: [{ externalId: 'e1', kind: 'ci-failure', title: '构建挂了' }],
          },
        },
      },
      ctx,
    )
    assert.equal(calls[0]?.path, '/api/reports')
    assert.equal(calls[0]?.init?.method, 'POST')
    const sent = JSON.parse(String(calls[0]?.init?.body)) as {
      source: string
      items: unknown[]
    }
    assert.equal(sent.source, 'ci')
    assert.equal(sent.items.length, 1)
    assert.ok(res?.result)
  })

  test('submit_report 拒绝空 items，而不是把空批次发出去', async () => {
    const { calls, ctx } = fakeDaemon()
    const res = await handleRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'submit_report', arguments: { source: 'ci', items: [] } },
      },
      ctx,
    )
    const result = res?.result as { isError?: boolean }
    assert.equal(result?.isError, true)
    assert.equal(calls.length, 0, '不该发出请求')
  })
})
