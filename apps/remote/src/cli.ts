#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadPluginDirectory } from './loader.ts'
import { RemoteService } from './server.ts'

/**
 * 远端服务的独立进程入口。
 *
 * 端口是**固定**的（与 daemon 同一约定）：随机端口意味着"重启后地址变了"，
 * 而地址会写进用户的浏览器书签与 daemon 配置里，漂移比端口冲突更难排查。
 * 端口被占用时**大声失败**，不静默换端口。
 */

const DEFAULT_REMOTE_PORT = 4518

function parsePort(argv: readonly string[]): number {
  const idx = argv.indexOf('--port')
  if (idx === -1) return DEFAULT_REMOTE_PORT
  const raw = argv[idx + 1]
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`--port 需要一个 1-65535 的整数，收到：${String(raw)}`)
  }
  return n
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const port = parsePort(argv)
  const dataDirIdx = argv.indexOf('--data-dir')
  const dataDir =
    dataDirIdx === -1
      ? join(homedir(), '.alpha-helper', 'remote')
      : (argv[dataDirIdx + 1] ?? join(homedir(), '.alpha-helper', 'remote'))

  const service = new RemoteService({ port, dataDir })

  // 插件目录：没有就空着——插件是扩展，不是运行前提。
  //
  // 用 loadPluginDirectory 而不是自己 readdir + JSON.parse：只有前者会
  // **真的把 entry 里的代码跑起来**，也才有 entry 越界的防护。
  const pluginDir = join(dataDir, 'plugins')
  const report = await loadPluginDirectory({
    pluginDir,
    onWarn: (m) => process.stderr.write(`[warn] ${m}\n`),
  })
  if (report.plugins.length > 0) {
    // ★ 用 setPlugins 而不是 loadPluginManifests：后者会重新校验 manifest，
    //   而加载器那边的失败（代码求值、entry 越界、语法错误）它看不到，
    //   结果会把一个坏掉的插件在清单里显示成"已启用"。
    service.setPlugins(report.plugins)
    const ok = report.plugins.filter((p) => p.enabled).length
    process.stdout.write(`已加载插件 ${ok}/${report.plugins.length}（目录：${pluginDir}）\n`)
    for (const p of report.plugins.filter((x) => !x.enabled)) {
      process.stderr.write(`[warn] 插件 ${p.manifest.name} 不可用：${p.error ?? '未知原因'}\n`)
    }
  }

  let actual: number
  try {
    actual = await service.start()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') {
      throw new Error(
        `端口 ${port} 已被占用。alpha-helper 不自动换端口——` +
          `请先停止占用该端口的进程，或用 --port 显式指定另一个端口。`,
      )
    }
    throw err
  }

  process.stdout.write(`alpha-helper remote 正在监听 http://127.0.0.1:${actual}\n`)
  process.stdout.write(`数据目录：${dataDir}\n`)

  const shutdown = (): void => {
    void service.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
