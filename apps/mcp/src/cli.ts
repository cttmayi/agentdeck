#!/usr/bin/env node
import { createInterface } from 'node:readline'
import {
  DEFAULT_DAEMON_URL,
  handleRequest,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './server.ts'

/**
 * MCP server 的 stdio 入口（FR-INTEG-01）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么用 stdio 而不是 HTTP
 * ══════════════════════════════════════════════════════════════════
 *
 * MCP 客户端（各种 agent CLI）通常把 MCP server 当**子进程**拉起。
 * stdio 传输下：
 *
 *   - 不需要端口，不会和 daemon 的固定端口打架；
 *   - 生命周期天然绑定在父进程上——父进程退出，本进程的 stdin 就关了，
 *     我们据此退出，不会留下孤儿进程；
 *   - **没有网络面**。这个进程能做的事完全由它启动时的身份决定，
 *     不存在"局域网里谁能连上它"这个问题。
 *
 * ══════════════════════════════════════════════════════════════════
 * stdout 是协议通道，日志只能走 stderr
 * ══════════════════════════════════════════════════════════════════
 *
 * 往 stdout 写一行非 JSON 的东西就会让客户端解析失败、整个连接作废。
 * 这是个很容易犯的错（`console.log` 调试一下就中招），所以这里**不用
 * console**，全部显式写 stderr。
 */

function logStderr(message: string): void {
  process.stderr.write(`[alpha-helper-mcp] ${message}\n`)
}

function write(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const urlIdx = argv.indexOf('--daemon-url')
  const daemonUrl = (urlIdx === -1 ? DEFAULT_DAEMON_URL : argv[urlIdx + 1]) ?? DEFAULT_DAEMON_URL

  // ★ 只允许连回环：MCP 不该成为"借本机之手访问别处"的跳板。
  let parsed: URL
  try {
    parsed = new URL(daemonUrl)
  } catch {
    logStderr(`--daemon-url 不是合法 URL：${daemonUrl}`)
    process.exit(1)
  }
  const loopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '::1' ||
    parsed.hostname === '[::1]'
  if (!loopback) {
    logStderr(`拒绝：只允许连接回环地址的本机 daemon，收到 ${parsed.hostname}`)
    process.exit(1)
  }

  logStderr(`已启动，daemon = ${daemonUrl}`)

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

  // 逐行处理，但**串行化**：并行处理会让同一批请求的响应乱序，
  // 而 JSON-RPC 客户端并不保证能接受乱序响应。
  let tail: Promise<void> = Promise.resolve()

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed === '') return

    tail = tail.then(async () => {
      let req: JsonRpcRequest
      try {
        req = JSON.parse(trimmed) as JsonRpcRequest
      } catch {
        write({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: '收到的不是合法 JSON' },
        })
        return
      }
      try {
        const response = await handleRequest(req, { daemonUrl })
        if (response) write(response)
      } catch (err) {
        // 兜底：任何漏网的异常都必须变成一条响应，不能让客户端一直等
        write({
          jsonrpc: '2.0',
          id: req.id ?? null,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        })
      }
    })
  })

  rl.on('close', () => {
    // 父进程关闭了 stdin ⇒ 我们也该退出。等手上的请求处理完再退，
    // 否则最后一条请求会静默丢失。
    void tail.then(() => {
      logStderr('stdin 已关闭，退出')
      process.exit(0)
    })
  })
}

main().catch((err: unknown) => {
  logStderr(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
