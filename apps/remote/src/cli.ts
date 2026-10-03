#!/usr/bin/env node
import { mkdir, readdir, rename, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadPluginDirectory } from './loader.ts'
import { RemoteService } from './server.ts'

/**
 * 改名（2026-09：alpha-helper → agentdeck）后 remote 数据目录的一次性迁移。
 *
 * 与 daemon 里 `migrateLegacyDataDir` 同一套"只在完全安全的情况下搬"的规矩：
 * 新目录不存在或是空目录（**绝不覆盖**）、旧目录存在且非空、`rename` 原子。
 * 只在**用默认路径**（没给 `--data-dir`）时调用——显式指定的人用的是他自己的地盘。
 */
async function migrateLegacyRemoteDir(dataDir: string): Promise<void> {
  const legacy = join(homedir(), '.alpha-helper', 'remote')
  if (legacy === dataDir) return
  const legacyEntries = await readdir(legacy).catch(() => null)
  if (!legacyEntries || legacyEntries.length === 0) return // 旧目录不存在/空：没什么可搬
  const targetEntries = await readdir(dataDir).catch(() => null)
  if (targetEntries !== null && targetEntries.length > 0) {
    // 新目录已经有东西了：那是使用者的地盘，什么都不碰，只提醒一声
    process.stderr.write(
      `[警告] 远端数据目录已经是 ${dataDir}，旧目录 ${legacy} 里的内容没有搬（新目录非空）。没有丢，需要的话自行合并。\n`,
    )
    return
  }
  try {
    await mkdir(dirname(dataDir), { recursive: true })
    if (targetEntries !== null) await rmdir(dataDir).catch(() => undefined)
    await rename(legacy, dataDir)
    process.stdout.write(`远端数据目录已迁移：${legacy} → ${dataDir}（${legacyEntries.length} 项）\n`)
  } catch (err) {
    // ⚠️ 只警告、**不删源**：搬不动就维持原样
    process.stderr.write(
      `[警告] 远端数据目录迁移失败（${legacy} → ${dataDir}）：${(err as Error).message}。旧内容原样保留。\n`,
    )
  }
}

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

/**
 * 认识的选项只有两个（`--port` / `--data-dir`）；其余一律拒绝。
 *
 * ⚠️ 为什么值得单独一个函数、还带注释：**默认路径是会吃人的**。本 CLI 不做子命令
 * 分派，任何它没看懂的 token 都会让它继续往下走，最后"服务起来了"——那看起来像
 * 成功，而使用者要的可能是另一件事（历史上就是这么出过一次）。
 *
 * 值也算被消费（`--port 4599` 里的 `4599` 不是"多余的位置参数"），否则合法的
 * 调用会被这条闸误伤——闸误伤正常用法，下一个人就会把它删掉。
 */
function assertNoStrayArgs(argv: readonly string[]): void {
  const consumed = new Set<number>()
  argv.forEach((token, i) => {
    if (
      token === '--port' ||
      token === '--data-dir' ||
      token === '--web-dir' ||
      token === '--sync-tool' ||
      token === '--manifest' ||
      token === '--github-proxy'
    ) {
      consumed.add(i)
      if (argv[i + 1] !== undefined) consumed.add(i + 1)
    }
  })
  const stray = argv.filter((_, i) => !consumed.has(i))
  if (stray.length === 0) return

  if (stray.includes('sync-skills')) {
    throw new Error(
      '抓取推荐技能**已经不是远端的子命令**了（2026-10 改成独立工具）：' +
        '请用 `pnpm run sync-skills`（加 `--dry-run` 先看会改什么）。' +
        '远端服务只管读那个目录并把目录返回给页面。',
    )
  }
  throw new Error(
    `不认识的位置参数：${stray.join(' ')}。本命令只启动远端服务，可用选项：` +
      `--port <端口>、--data-dir <目录>、--web-dir <目录>（管理页产物）、` +
      `--sync-tool <脚本>、--manifest <文件>（推荐清单的配置，默认数据目录下那份）`,
  )
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  // ★ 第一件事：拒绝那个 `--`。与 `apps/cli/src/args.ts` 同一道闸：pnpm 会把
  //   `pnpm run remote -- --port 4519` 里的 `--` **原样传进来**（它不吃掉它），
  //   于是它之后的选项会不会失效就看各人怎么写解析——仓库只有一条口径：
  //   **见到就拒，并告诉正确写法**，不留给使用者去记"哪个命令能吃 --"。
  //
  //   ⚠️ 必须挡在**任何落盘动作之前**：下面 `migrateLegacyRemoteDir()` 会搬数据
  //   目录，而被拒的调用不该顺带改动任何东西。
  //
  //   （2026-10 之前这里还有一条更阴的历史：`sync-skills` 曾经是本 CLI 的子命令，
  //   于是带 `--` 时 `argv[0]` 不是 `sync-skills`，子命令匹配不上——它就若无其事地
  //   把**服务**起起来，输出"正在监听 http://127.0.0.1:4518"。抓取现已独立成
  //   `tools/skill-catalog-sync/`（`pnpm run sync-skills`），这条路径不复存在，
  //   但闸留着。）
  const ddIndex = argv.indexOf('--')
  if (ddIndex !== -1) {
    throw new Error(
      '检测到 `--`：pnpm 会把它原样传进来，它之后的选项可能被当成位置参数而失效。' +
        '请直接写 `pnpm run remote --port 4519`，去掉那个 `--`。',
    )
  }

  // ★ 第二件事：**不认识的参数一律拒绝**，尤其是位置参数。
  //
  //   起因是一次真踩（2026-10）：抓取从本 CLI 的子命令改成独立工具之后，
  //   `pnpm run remote sync-skills` 这条**原来有意义**的写法不再有意义——而它
  //   不会报错，会掉进"那就起服务吧"这条默认路径：你以为在同步技能，屏幕上却是
  //   服务起来了（实测它真的在 4518 上挂着，直到被外部杀掉，300 秒里没有任何
  //   一行说自己理解错了）。
  //
  //   这条与上面那道 `--` 闸是**同一件事的两半**：参数层的任何意外都不许被
  //   "按默认往下走"消化掉。认得出旧写法时，直接把新命令报出来。
  assertNoStrayArgs(argv)

  const port = parsePort(argv)
  const dataDirIdx = argv.indexOf('--data-dir')
  const usingDefaultDataDir = dataDirIdx === -1
  const dataDir = usingDefaultDataDir
    ? join(homedir(), '.agentdeck', 'remote')
    : (argv[dataDirIdx + 1] ?? join(homedir(), '.agentdeck', 'remote'))

  // ★ 改名后第一次启动：把旧位置的 remote 数据（登录态等）搬过来。
  if (usingDefaultDataDir) {
    await migrateLegacyRemoteDir(dataDir)
  }

  // 管理页与同步工具：都不给就用默认（产物目录 / 仓库里的工具脚本）。
  // ⚠️ 默认值算的是"代码在哪儿"（`import.meta.url`），不是 `process.cwd()`——
  //    服务可能从任何目录启动。
  const webDirIdx = argv.indexOf('--web-dir')
  const syncToolIdx = argv.indexOf('--sync-tool')
  const manifestIdx = argv.indexOf('--manifest')
  const service = new RemoteService({
    port,
    dataDir,
    ...(webDirIdx !== -1 ? { webDir: argv[webDirIdx + 1] ?? null } : {}),
    ...(syncToolIdx !== -1 ? { syncTool: argv[syncToolIdx + 1] ?? null } : {}),
    ...(manifestIdx !== -1 ? { manifest: argv[manifestIdx + 1] ?? null } : {}),
  })

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
        `端口 ${port} 已被占用。agentdeck 不自动换端口——` +
          `请先停止占用该端口的进程，或用 --port 显式指定另一个端口。`,
      )
    }
    throw err
  }

  process.stdout.write(`agentdeck remote 正在监听 http://127.0.0.1:${actual}\n`)
  process.stdout.write(`管理页：http://127.0.0.1:${actual}/（技能 / 工具目录，只读）\n`)
  process.stdout.write(`数据目录：${dataDir}\n`)
  process.stdout.write(
    `推荐清单：${join(dataDir, 'recommended-skills.json')}` +
      '（第一次跑同步时由工具把内置默认转存到这里；服务只读它）\n',
  )

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
