#!/usr/bin/env node
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { resolveGithubProxy } from '@agentdeck/skill-source'

import { resolveManifest } from './manifest-config.ts'

import { syncRecommendedSkills } from './skills-sync.ts'

/**
 * 推荐技能目录的**同步工具**（独立命令，不属于远端服务、也不属于 daemon）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是一个独立工具，而不是远端的子命令
 * ══════════════════════════════════════════════════════════════════
 *
 * 2026-10 定案（A 案，接 D50）：抓取这件事与"远端服务在跑"没有关系——远端只做
 * 三件与技能目录有关的事：**读盘、校验、返回**（`GET /api/catalog`）。它不联网、
 * 不知道 GitHub、也没有抓取代码。抓取是**维护时刻的动作**：要联网、要过 GitHub
 * 的限额、还可能因为上游改了目录名而失败，这些都不该混进"服务在跑"这条路径里。
 *
 * 两边**只靠一个目录**相连：本工具把内容写进一个目录，远端服务从那个目录读。
 * 没有共享代码、没有共享数据目录常量（`--out` 说了算）、没有互相 import。
 * 所以这个工具可以脱离远端单独跑，远端也可以完全没有它。
 *
 * ══════════════════════════════════════════════════════════════════
 * 配额：一次同步要花多少次 GitHub API 调用
 * ══════════════════════════════════════════════════════════════════
 *
 * 每条技能要（都打在 `api.github.com` 上，GitHub 对**匿名**请求限 60 次/小时）：
 *
 *   1. 列目录（`/contents/<dir>`）——技能是个目录，里面有 `SKILL.md` 与可能的
 *      支持文件（`scripts/`、`templates/`…），**文件名猜不出来**：猜漏一个，
 *      技能就是坏的，而且坏得很安静（界面显示"已安装"，跑起来才发现少东西）。
 *      ⚠️ **每个子目录还要再来一次**，所以调用数取决于目录树有多深。
 *   2. 取版本（`/commits?path=<dir>&per_page=1`）——目录要说得出"有新版本了"，
 *      就得有个版本号可比。**这一条是目录独有的**，共用取包规则里没有它
 *      （daemon 装一条 GitHub 链接时版本落 `null`）。
 *
 * 文件内容本身走 `raw.githubusercontent.com`，**不计入**这 60 次。
 *
 * ⚠️ **实测一条 11 次**（`pptx`：52 个文件、9 个目录 ⇒ 列目录 10 次 + 取版本 1 次），
 * 不是"两条"。所以 12 条的清单在匿名限额下**装不下一整轮**——那时本工具会把实测
 * 花掉的次数打出来、**一个字都不写**（P7），并且**第一条失败就停**（见 skills-sync.ts）。
 * 于是重跑是有意义的：**1 小时内抓过的条目不再下载**，配额只花在还缺的那几条上。
 * 想彻底不受限：给一个不勾任何 scope 的 token（限额 5000/小时）。
 *
 * 用法：
 *   pnpm run sync-skills                      # 抓取并替换目录
 *   pnpm run sync-skills --dry-run            # 逐条真抓一遍，但不写盘
 *   pnpm run sync-skills --refresh            # 忽略复用窗口，全部重新下载
 *   pnpm run sync-skills --out <目录>          # 写到别处（远端用 --data-dir 时必须给）
 *   pnpm run sync-skills --manifest <文件>     # 换一份清单（显式指定，不转存）
 *   pnpm run sync-skills --github-proxy <地址>  # 走 GitHub 加速器（默认不用，见下）
 *
 * ★ 两条行为（2026-10 使用者要求，见 skills-sync.ts）：
 *   · **第一条失败就停**——撞限额时后面每条都是同一句话，继续试只会刷一屏；
 *   · **1 小时内抓过的不再下载**——沿用已发布那份；只有 `--dry-run` 与 `--refresh`
 *     会无视这个窗口。⚠️ 光有这一条**并不能**让撞限额后的重跑收敛（那个索引文件只在
 *     整轮成功时才写）。所以还有下面这个：
 *   · **已抓到的落进断点目录**（`<out>.partial`）——失败时已发布目录一个字都不改，
 *     但抓到的那些留着，下一轮只补缺的。断点那份**跨小时也留着**（花过配额的不丢）。
 *
 * ⚠️ **加速器是第三方**：`--github-proxy`（**裸写即可**，不带地址就用
 *   `DEFAULT_GITHUB_PROXY` = `https://gh-proxy.com`；也可以给别的地址，或
 *   `--github-proxy off` 这次直连）或环境变量 `AGENTDECK_GITHUB_PROXY`
 *   会把每个 GitHub 请求转给它——它能看、也能改内容。
 *   换来的是"国内下载稳"与"配额不再是本机那 60 次"（实测它自己带 5000/h 的凭证）。
 *   我们**不会**把自己的 token 交给它（有测试钉着），也**只有你显式指定**时才启用。
 *
 * ⚠️ **不要**写 `pnpm run sync-skills -- --dry-run`：pnpm 会把那个 `--` 原样传进来
 *    （见下面那道闸）。正确写法就是上面这样，参数跟在命令后面。
 *
 * 退出码：0 = 全部抓成（目录已替换，或 dry-run 通过）；非 0 = 有一条没抓成，
 * **目录一个字都没改**（半份目录比旧目录更糟：使用者会点到一个"看起来能装、
 * 其实是半截"的条目，而维护者以为同步成功了）。
 */

/** 远端服务默认读的那个目录——**约定，不是 import**（见文件头）。 */
function defaultOutDir(): string {
  return join(homedir(), '.agentdeck', 'remote', 'catalog-skills')
}

/**
 * 数一数这次真花了几次 GitHub API 调用。
 *
 * ★ 为什么要数：这条命令的失败几乎都是配额（2026-10 实测被咬过一次——撞墙时
 *   使用者只能猜"是不是我哪配错了"）。打印**实测值**而不是文档里那句"大概
 *   大概多少次"，配额的事就只剩一个可核对的数字：撞墙时它告诉你这次花掉多少、
 *   还剩多少要等。
 */
function countingFetch(
  stats: { directApi: number; proxiedApi: number },
  proxyHost: string | null,
): typeof fetch {
  return (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    try {
      const parsed = new URL(url)
      if (parsed.hostname === 'api.github.com') stats.directApi += 1
      // ★ 走加速器时，请求是发给代理的（`<proxy>/https://api.github.com/...`），
      //   主机名不再是 api.github.com。**只按主机名数就会数成 0**——那行"0 次"会让人
      //   以为"什么都没请求"，而其实几十次调用都经过代理了（只是不占本机配额）。
      else if (proxyHost !== null && parsed.hostname === proxyHost && url.includes('api.github.com')) {
        stats.proxiedApi += 1
      }
    } catch {
      // 相对 URL 之类：不算，也不该让计数把同步搞坏
    }
    return fetch(input, init)
  }
}

async function runSyncSkills(argv: readonly string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run')

  const manifestIdx = argv.indexOf('--manifest')
  const explicitManifest = manifestIdx === -1 ? undefined : (argv[manifestIdx + 1] ?? '')

  const outIdx = argv.indexOf('--out')
  const skillsDir = outIdx === -1 ? defaultOutDir() : (argv[outIdx + 1] ?? '')

  // ── GitHub 加速器（可选，2026-10）──
  //
  // 命令行 `--github-proxy` 优先，其次环境变量。**默认不用**：它是第三方，能看也能
  // 改转发给我们的内容（见 `parseGithubProxy` 上的说明）。
  // 裸写 `--github-proxy`（后面没值，或紧跟另一个旗标）⇒ 用 DEFAULT_GITHUB_PROXY；
  // `off` / `none` ⇒ 直连（也能覆盖环境变量）。判据在 `resolveGithubProxy` 里，一处。
  const proxyIdx = argv.indexOf('--github-proxy')
  const proxyFlagValue: string | boolean | undefined =
    proxyIdx === -1
      ? undefined
      : argv[proxyIdx + 1] !== undefined && !argv[proxyIdx + 1]!.startsWith('-')
        ? argv[proxyIdx + 1]
        : true
  const githubProxy = resolveGithubProxy({
    ...(proxyFlagValue === undefined ? {} : { flagValue: proxyFlagValue }),
    envValue: process.env['AGENTDECK_GITHUB_PROXY'],
  })
  if (githubProxy !== null) {
    // ★ 必须**大声说**：使用者的内容正在经过第三方，而且我们不再把 token 交给它。
    process.stdout.write(
      `⚠️ 走 GitHub 加速器：${new URL(githubProxy).hostname}\n` +
        '   它能看、也能改转发过来的内容（第三方进了信任链）；' +
        '凭证不会交给它（它自己有），本机那 60 次/小时的匿名限额也不再适用。\n',
    )
  }

  // ★ 清单：显式 `--manifest` > 配置位置（`<out 的父目录>/recommended-skills.json`）
  //   > 内置默认（**转存**过去再用）。见 `manifest-config.ts` 顶部那段。
  const { path: manifestPath } = await resolveManifest({
    ...(explicitManifest === undefined ? {} : { explicitPath: explicitManifest }),
    catalogDir: skillsDir,
    log: (line) => process.stdout.write(`${line}\n`),
  })

  const stats = { directApi: 0, proxiedApi: 0 }
  const report = await syncRecommendedSkills({
    manifestPath,
    skillsDir,
    fetchImpl: countingFetch(stats, githubProxy === null ? null : new URL(githubProxy).hostname),
    githubToken: process.env['AGENTDECK_GITHUB_TOKEN'] ?? null,
    dryRun,
    refresh: argv.includes('--refresh'),
    ...(githubProxy !== null ? { githubProxy } : {}),
    log: (line) => process.stdout.write(`${line}\n`),
  })

  for (const w of report.warnings) process.stderr.write(`[warn] ${w}\n`)

  // ★ 配额这一行**无论成败都打**：失败时它是"为什么撞墙"的唯一硬证据，
  //   成功时它是"这个小时还剩多少"的账。
  //   ⚠️ 走加速器时要**分开说**：那些调用不占本机那 60 次（代理自己带凭证），
  //      只报"0 次"会让人以为什么都没请求。
  process.stdout.write(
    githubProxy === null
      ? `\nGitHub API 调用：${stats.directApi} 次` +
          `（匿名限额 60 次/小时；文件内容走 raw.githubusercontent.com，不计入）\n`
      : `\n经加速器转发的 API 调用：${stats.proxiedApi} 次` +
          `（走代理时**不占**本机那 60 次/小时的匿名限额——额度是代理的）` +
          `${stats.directApi > 0 ? `；直连还发了 ${stats.directApi} 次` : ''}\n`,
  )

  // ★ "复用了几条 / 新抓了几条"必须打出来：不然"这次只花了 0 次调用"看起来
  //   像没干活，而"1 小时内抓过"这件事只有它说得清。
  if (report.reused.length > 0) {
    process.stdout.write(
      `沿用已发布那份：${report.reused.length} 条（未过 1 小时窗口，没有重新下载）：` +
        `${report.reused.join('、')}\n`,
    )
  }
  if (report.fromCheckpoint.length > 0) {
    process.stdout.write(
      `沿用断点目录那份：${report.fromCheckpoint.length} 条（上一轮抓过、还没发布，不重抓）：` +
        `${report.fromCheckpoint.join('、')}\n`,
    )
  }

  if (report.failures.length > 0) {
    process.stderr.write(`\n失败 ${report.failures.length} 条：\n`)
    for (const f of report.failures) process.stderr.write(`  ${f.url}\n    ${f.reason}\n`)
    if (report.stoppedEarly) {
      process.stderr.write(
        `已在第 ${report.items.length + report.failures.length} 条停下：一次失败就退出，` +
          `后面 ${report.remaining} 条没有再试（撞限额时它们只会是同一句话）。\n`,
      )
    }
    // ★ 这次失败唯一有用的信息：**已抓到的那些没白花**。断点目录替下一轮攒着，
    //   下一轮只补缺的——所以"等配额恢复再跑一次"是一句**真的**话。
    if (report.checkpointed > 0) {
      process.stderr.write(
        `已抓到的 ${report.checkpointed} 条留在断点目录：${report.checkpointDir}\n` +
          `（已发布目录一个字都没改；下一次跑只补缺的那几条）\n`,
      )
    }
    throw new Error('同步未完成：已发布目录没有改动（修掉这一条或等配额恢复，再跑一次即可）')
  }

  process.stdout.write(
    dryRun
      ? `\n--dry-run 通过：${report.items.length} 条都能抓下来（没有写盘）\n`
      : `\n同步完成：${report.items.length} 条已写入 ${report.skillsDir}` +
        // ⚠️ "新抓"要把**两种沿用**都减掉（已发布那份 + 断点那份）。只减前者时，
        //    真机上会出现"12 条已写入（新抓 12 条）"外加一行"沿用断点 6 条"这种
        //    自相矛盾的话（2026-10 实测撞到）。
        `（新抓 ${report.items.length - report.reused.length - report.fromCheckpoint.length} 条）\n`,
  )
  // ★ 白纸黑字写出写到了哪儿：远端服务用 `--data-dir` 改了数据目录时，它读的
  //   就不是这里——那会表现为"界面里目录是空的"，而两个进程都不觉得自己错了。
  if (!dryRun) {
    process.stdout.write(
      `远端服务默认读的就是这个目录；它若用 --data-dir，你这里也要用 --out 指到那儿。\n`,
    )
  }
}

/**
 * 认识的参数只有三个；其余一律拒绝。
 *
 * ★ 这条不是洁癖：`--dryrun`（少一个连字符）这种手滑如果被**静默忽略**，结果不是
 *   "什么都没做"，而是**真的一次同步**——目录被替换了，而使用者以为只是在干跑。
 *   参数层的意外必须当场说出来，这是"宁可失败，不可静默降级"在这一层的说法。
 */
/**
 * 认识的参数——**唯一真相**。
 *
 * ★ 导出是刻意的：`HELP` 文本与这张表会被**机器比对**（见 `cli.test.ts`），
 *   免得"帮助里承诺了、程序不认"或"有个没人知道的隐藏开关"这两类事长期潜伏。
 *   这个做法抄的是 daemon 那边（`apps/daemon/src/cli.ts` 的 `CLI_OPTIONS`）——
 *   那边的由来是一次真事：写 `--verify-runtime` 的提示时**当场撒了个谎**，
 *   让使用者去用一个当时并不存在的旗标。
 */
export const VALUE_FLAGS = ['--manifest', '--out'] as const
/**
 * **值可选**的旗标：`--github-proxy` 不带地址时用默认加速器（使用者 2026-10 定）。
 * ⚠️ 它不能塞进 `VALUE_FLAGS`：那样 `--github-proxy --dry-run` 会把 `--dry-run`
 *    **当成地址吃掉**（`node:util` 的 parseArgs 就是这样，本仓库因此不用它）。
 */
export const OPTIONAL_VALUE_FLAGS = ['--github-proxy'] as const
export const BOOL_FLAGS = ['--dry-run', '--refresh', '--help'] as const

/**
 * 帮助文本。
 *
 * ⚠️ 里面**不许出现本工具不认识的旗标**（连举例都不行）：`cli.test.ts` 会把
 *    这里出现的每个 `--flag` 拿去找参数表对账。所以"远端服务那个数据目录开关"
 *    这类别家的旗标只能写成白话（"远端服务若改了数据目录"），不能写 `--data-dir`。
 */
export const HELP = `推荐技能目录的同步工具（独立命令，不是服务）

用法：
  pnpm run sync-skills [选项]

做什么：
  读清单 → 逐条从 GitHub 抓取并校验 → 原子替换目录。
  失败时**已发布目录一个字都不改**；已抓到的留在断点目录里，下次只补缺的。

选项：
  --dry-run              逐条真抓一遍，但**一个字都不写**（检查清单里的链接还有没有效）
  --refresh              忽略"1 小时内抓过"与断点目录，全部重新下载
  --out <路径>           内容落到哪（默认远端服务默认读的那个目录；
                         远端服务若改了数据目录，这里要用本选项指到那儿）
  --manifest <文件>      换一份清单（默认是本工具自带的那份 recommended-skills.json）
                         清单里每条可写 include/exclude（相对技能目录的 glob）——
                         仓库混着营销素材/测试产物时用；被排除的会逐个列出来
  --github-proxy [地址]  走 GitHub 加速器（**第三方**，默认不用）
                         **不带地址就用 https://gh-proxy.com**（裸写这个旗标即可）
                         例：--github-proxy            （= gh-proxy.com）
                             --github-proxy https://别的加速器
                             --github-proxy off        （这次直连，覆盖环境变量）
                         它只代理 GitHub 自己的主机，而且**拿不到你的凭证**
  -h, --help             显示本帮助

几条要记得的：
  · **第一条失败就停**（撞限额时后面每条都是同一句话），已抓到的进**断点目录**；
  · **1 小时内抓过的不再下载**；断点那份跨小时也留着（花过配额的不丢）；
  · 内容只落一个目录，**不进代码仓库**；远端服务只读那个目录，它自己不抓取；
  · 开销 ≈ 每条技能的目录数 + 2 次 API 调用（实测：pptx 一条 11 次、research 4 次），
    匿名限额是 60 次/小时——清单大时用加速器或令牌。

环境变量：
  AGENTDECK_GITHUB_PROXY  同 --github-proxy（命令行优先）
  AGENTDECK_GITHUB_TOKEN  提高 GitHub 限额；走加速器时**不会**交给加速器

退出码：
  0 = 全部抓成（目录已替换，或 --dry-run 通过）；非 0 = 有一条没抓成，目录没改动。
`

function assertKnownArgs(argv: readonly string[]): void {
  const consumed = new Set<number>()
  argv.forEach((token, i) => {
    const known =
      (VALUE_FLAGS as readonly string[]).includes(token) ||
      (OPTIONAL_VALUE_FLAGS as readonly string[]).includes(token) ||
      (BOOL_FLAGS as readonly string[]).includes(token)
    if (!known) return
    consumed.add(i)
    const next = argv[i + 1]
    if (next === undefined) return
    const takesValue =
      (VALUE_FLAGS as readonly string[]).includes(token) ||
      // 值可选的旗标**只吃"不像旗标"的下一项**：`--github-proxy --dry-run` 里
      // `--dry-run` 是旗标，不是地址
      ((OPTIONAL_VALUE_FLAGS as readonly string[]).includes(token) && !next.startsWith('-'))
    if (takesValue) consumed.add(i + 1)
  })
  const stray = argv.filter((_, i) => !consumed.has(i))
  if (stray.length === 0) return

  const first = stray[0] ?? ''
  const guess =
    first === '--dryrun' || first === '--dryRun' || first === '-dry-run'
      ? '（是不是想写 `--dry-run`？）'
      : ''
  throw new Error(
    `不认识的参数：${stray.join(' ')}${guess}。` +
      `可用：--dry-run、--refresh、--manifest <文件>、--out <目录>、--github-proxy <地址>。`,
  )
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  // ★ `--` 直接拒绝，与 `apps/cli/src/args.ts`、`apps/remote/src/cli.ts` 同一道闸。
  //   在这里它其实**不会坏事**（参数是按名字找的，不是按位置：`--  --dry-run`
  //   照样会被认出来）——那也要拒：仓库里只有一条口径，一处拒一处忍才是最坑的
  //   那种不一致（使用者得记住"哪个命令能吃 --"）。
  const ddIndex = argv.indexOf('--')
  if (ddIndex !== -1) {
    throw new Error(
      '检测到 `--`：请直接写 `pnpm run sync-skills --dry-run`，去掉那个 `--`。',
    )
  }

  // ★ 帮助**短路**在这里：不读清单、不联网、不写盘（"我只是想看怎么用"不该有副作用）。
  //   放在参数校验之前也是刻意的：`--help` 本身是认识的参数，但它之后可以跟任何东西
  //   （比如有人把旗标拼错又在末尾加了个 --help），那时先把用法给他看更有用。
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP)
    return
  }

  assertKnownArgs(argv)

  await runSyncSkills(argv)
}

/**
 * ⚠️ **只有被直接执行时才跑 `main()`**。
 *
 * 这条守卫是必需的，不是洁癖：`cli.test.ts` 要 import 本文件里的 `HELP` 与参数表
 * （好让"帮助承诺的旗标"与"实现的旗标"能机器对账），而 import 会**执行整个模块**。
 * 没有守卫时，测试进程会带着测试运行器自己的 argv 跑一遍 CLI——参数不认识 ⇒
 * `main().catch` 里的 `process.exit(1)` 把**测试进程本身**干掉，表现是"每条用例都
 * 过了、这个文件却失败"（2026-10 实测：9 条全绿、文件红）。
 *
 * 判据与 `apps/daemon/src/cli.ts` 同一套（比文件名，不比整条路径——`pnpm run` 传进来的
 * 路径形态与 `import.meta.url` 未必逐字相同）。
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
