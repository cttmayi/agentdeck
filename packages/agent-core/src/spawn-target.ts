/**
 * 「到底该 exec 什么」——Windows 上不能直接 exec 探测到的那个文件。
 *
 * ══════════════════════════════════════════════════════════════════
 * 要解决的那个故障（2026-10 Windows 兼容性审计的 A1）
 * ══════════════════════════════════════════════════════════════════
 *
 * `probeCommand` 在 Windows 上探测到的是 npm 装的 **`.cmd` 垫片**
 * （`%APPDATA%\npm\claude.cmd`）。而 Node 从 2024-04 的安全版本起
 * （CVE-2024-27980）**拒绝 `shell: false` 地 spawn `.cmd`/`.bat`**：
 * 参数校验阶段就抛 `EINVAL`。表现是——**所有 runtime、所有任务一起挂**，
 * 报的还是裸的 `spawn EINVAL`（当时 `describeSpawnError` 只认 ENOENT/EACCES——
 * 现在它也认 EINVAL 了，见本文件末尾）。
 *
 * ⚠️ 不是"Windows 全都不行"：新版 Claude Code 的**原生安装器**给的是
 *    `claude.exe`（`%USERPROFILE%\.local\bin`），`.exe` 在候选表里排在
 *    `.cmd` 前面 ⇒ 那种装法是好的。**npm 装的才撞这条。**
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么选"解开垫片"而不是 cmd.exe / shell: true
 * ══════════════════════════════════════════════════════════════════
 *
 * 三条路，实测与推演都写在 `docs/reference/windows-compat.md`：
 *
 *   ① **解开垫片**（本文件的主路径）：垫片里真正调的是
 *      `"<node>" "<…\cli.js>" %*`——把那个 `.js` 抠出来，用**正在跑 daemon 的这个
 *      node** 起它。参数**原样**交给 CLI（不经 shell），进程树干净
 *      （`taskkill /T` 照样管用），也不用跟 cmd 的引号规则缠斗。
 *   ② `cmd.exe /d /s /c`（本文件的**兜底**）：垫片形状不认识时用。
 *      代价是 cmd 的引号/`%` 展开规则，所以引号类的参数我们**宁可拒绝也不静默改写**
 *      （见 `quoteForCmd` 与 `buildCmdLine`）。
 *   ③ `shell: true`：一行就能改完，但有注入面（Node 会警告 DEP0190），
 *      而且 `.cmd` 里的 `%*` 展开又是另一套引号规则——**不采用**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这段逻辑必须抽成纯函数（而不是写在 spawn 那里）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这台开发机是 macOS，**没有 Windows 可跑**。把"平台判断 + 垫片解析 + 引号规则"
 * 抽成"输入全是参数"的纯函数，就能在 macOS 上拿**真的 npm 垫片文本**当夹具
 * 把每一条判据钉住（`platform: 'win32'` 是注入的，不是读 `process.platform`）。
 * 剩下没被钉住的只有"真 Windows 上 exec 得起来吗"这一层——
 * 而那正是 `docs/reference/windows-compat.md` 里写明"要在真机上量"的那一节。
 */

import { readFileSync } from 'node:fs'
import { win32 } from 'node:path'

export interface SpawnTarget {
  /** 真的交给 `spawn` 的可执行文件。 */
  command: string
  /** 真的交给 `spawn` 的参数（已经带上垫片那层需要的、垫片自己会补的东西）。 */
  args: string[]
  /** 走的是哪条路——诊断与测试要看它。 */
  via: 'direct' | 'shim' | 'cmd'
  /**
   * ★ 传给 `spawn` 的 `windowsVerbatimArguments`（分批第 43 批，**真机量出来的**）。
   *
   * 使用者「我在 windows 查到了问题，问题是 .cmd/.bat 启动失败」——根因就在这里：
   *
   *   · `via: 'cmd'` 时，`args` 里的**最后一项**是我们自己拼好的整条命令
   *     （`"C:\…\codex.cmd" app-server --stdio`，带引号、带空格）。
   *   * 而 Node 默认会**再**替每个参数加一遍引号/转义（`"\"C:\…\""`）——
   *     cmd.exe 收到的是被转义过一遍的字符串，引号规则当场错位 ⇒ **起不来**。
   *   ⇒ 只有这一档必须 `windowsVerbatimArguments: true`：**我们拼的，就别再动它**。
   *
   *   · `via: 'direct'` / `'shim'` 时参数是一个个独立的 argv（垫片已解开成
   *     `<node> <script> <真实参数>`），**必须让 Node 照常加引号**——路径里有空格
   *     （`C:\Program Files\nodejs\node.exe`、`C:\Users\张三\…`）全靠它。
   *     ⚠️ 所以这个旗标**绝对不能**对所有情况都打开：那样 `shim` 那条路的脚本路径
   *     不会被加引号，含空格的路径会当场被拆成两个参数。
   */
  verbatimArguments: boolean
}

export class UnspawnableCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnspawnableCommandError'
  }
}

/**
 * 解开垫片之后拿到的东西。
 *
 * ⚠️ 只有**脚本**，**没有解释器**——垫片自己那个 `node.exe` 我们**故意不用**：
 *    它要么不存在（现代 npm 写的是 `SET "_prog=node"`，意思是"从 PATH 找"），
 *    要么是某个来路不明的 node 副本；而"正在跑 daemon 的这个 node"一定存在、
 *    版本一定够，也和平台自己用的是同一个（与 `script-executor.resolveCommand`
 *    对 `node` 的处理同一条理由）。**猜错解释器**的表现是"CLI 起来了但报语法错"，
 *    那是比失败更难查的一类。
 */
export interface NpmShim {
  /** 垫片真正要跑的那个脚本（已经把它里面的 `%dp0%` 换成垫片所在目录）。 */
  script: string
}

/**
 * 造一段**形状与 npm 垫片一致**的 `.cmd`。
 *
 * 为什么要这个生成器：Windows 上不能拿 `#!/bin/sh` 包装去当假 CLI（见
 * `docs/reference/windows-compat.md` 的 A3）。测试脚手架需要一个"Node 能起得来
 * 的包装"，而**我们自己的解析器 + Windows 的 exec 规则**共同要求它长得像 npm 垫片：
 * `resolveSpawnTarget` 会把它解开成 `<node> <script> <真实参数>`，
 * 于是"被测的 argv 仍然是真实 argv"这条（假 CLI 存在的全部意义）在 Windows 上照样成立。
 *
 * 单元测试里有一条"生成 ⇒ 解析"的往返判据守着这两半不漂。
 */
export function npmShimText(input: { nodePath: string; scriptPath: string }): string {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    `endLocal & "%dp0%\node.exe" "%dp0%\placeholder.js" %*`,
    '',
  ]
    .join('\r\n')
    // ⚠️ 上面那行只是"形状"，真正要写进去的是调用方给的两个绝对路径：
    //    解析器会先按 `%dp0%` 展开，所以直接写绝对路径也可以。
    .replace(`"%dp0%\node.exe"`, `"${input.nodePath}"`)
    .replace(`"%dp0%\placeholder.js"`, `"${input.scriptPath}"`)
}

/**
 * 造一个"任何平台都起得起来"的可执行包装（**测试脚手架用**）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它，以及为什么是这两种形状
 * ══════════════════════════════════════════════════════════════════
 *
 * 假 CLI 要害在于：**被测的 argv 必须还是真实 argv**（假货不能改写适配器拼出来的
 * 参数）。所以包装要做的事只有一件——在真实参数前面插一个"脚本路径"。
 *
 *   · **Unix**：`#!/bin/sh` + `exec "<node>" "<script>" "$@"`（要 +x 位 ⇒ `needsChmod`）。
 *     这是仓库一直在用的形状，一个字没改。
 *   · **Windows**：没有 `/bin/sh`，`chmod` 也是空操作。所以改用一段**形状与 npm
 *     垫片一致**的 `.cmd`——`resolveSpawnTarget` 会把它解开成
 *     `<node> <script> <真实参数>`（`via: 'shim'`），于是这条性质在 Windows 上照样成立。
 *
 * ⚠️ 这两条路**必须由一个函数产出**：分头写就会出现"Unix 上对、Windows 上形状不对，
 *    而 Windows 上的表现是假 CLI 起不来"——那会把 61 条测试一起弄红，
 *    且红的原因指向适配器（见 `docs/reference/windows-compat.md` 的 A3）。
 */
export function executableWrapper(input: {
  /** 注入平台（默认 `process.platform`）——注入是为了能在 macOS 上测 Windows 那条。 */
  platform?: NodeJS.Platform
  /** 包装本身叫什么（Unix 上就是这个名字，Windows 上会加 `.cmd`）。 */
  name: string
  /** 用哪个 node 跑脚本（一般就是 `process.execPath`）。 */
  nodePath: string
  /** 被包装的脚本。 */
  scriptPath: string
}): { name: string; content: string; needsChmod: boolean } {
  const platform = input.platform ?? process.platform
  if (platform === 'win32') {
    return {
      name: `${input.name}.cmd`,
      content: npmShimText({ nodePath: input.nodePath, scriptPath: input.scriptPath }),
      needsChmod: false,
    }
  }
  return {
    name: input.name,
    content: [
      '#!/bin/sh',
      '# 包装脚本：把后端拼出的真实 argv 原样转发给 node。',
      '# 用 exec 而不是调用：让 node 取代 sh，进程树与信号语义和真 CLI 一致。',
      `exec "${input.nodePath}" "${input.scriptPath}" "$@"`,
      '',
    ].join('\n'),
    needsChmod: true,
  }
}

/**
 * 各类 spawn 失败的可读翻译。
 *
 * ⚠️ 这份东西原先在 `agent-generic` 与 `agent-codex` 里**各有一份**，注释写着
 *    "与 generic 同一份约定，改的时候要一起改"——那正是最会漂的一种安排。
 *    两处判断（"能 exec 什么"与"exec 失败了怎么解释"）本来就该在一起，所以收在这里。
 *
 * 为什么补 `EINVAL`（2026-10 审计里"放大伤害的细节"之一）：它是 Windows 上
 * "`shell: false` 地 spawn `.cmd`/`.bat`"的报错码（CVE-2024-27980 之后的行为）。
 * 不认它的后果是使用者看到裸的 `spawn EINVAL`——一个不指向任何东西的码。
 * 现在 A1 已经把这条路绕开了，但**绕过它不等于它不会再出现**（比如 `.cmd` 形状
 * 认不出来、`COMSPEC` 又指错了地方），所以给这个码一句能照做的话。
 */
export function describeSpawnError(err: unknown, command: string, path: string): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  switch (code) {
    case 'ENOENT':
      return (
        `找不到 ${command} 可执行文件（${path}）。` +
        `请先安装它；若已安装，试着重启 daemon 以重新探测 PATH。`
      )
    case 'EACCES':
      return `${command} 不可执行（${path}）：权限不足。检查文件权限或挂载选项。`
    case 'EINVAL':
      return (
        `启动 ${command} 失败（${path}）：这个文件不能被直接执行。` +
        `在 Windows 上最常见的原因是它是一个 .cmd/.bat 包装脚本——` +
        `那种文件必须经 cmd.exe 跑（平台已经会自己解开 npm 的垫片，走到这里说明` +
        `这次没解开）。如果是 npm 装的 CLI，改用它的原生安装器（给出的是 .exe），` +
        `或把 npm 全局目录里的 .cmd 换成 .exe 版本。`
      )
    default:
      return `启动 ${command} 失败：${String(err)}`
  }
}

/** 可 spawn 的 Windows 可执行扩展名。**不含 `.ps1`**——Node 起不了它。 */
export const WINDOWS_SPAWNABLE_EXT = ['.exe', '.com', '.cmd', '.bat'] as const

/**
 * 这个扩展名 Node 起得起来吗。
 *
 * 给**探测**用（`probe.ts` 读 `PATHEXT` 时要按它过滤）：`.ps1`/`.VBS`/`.JS`/`.WSF`
 * 都在 Windows 的 PATHEXT 里，但 Node **一个都起不了**——找出来只会把
 * "预检说可用"变成"运行时报错"。
 */
export function isWindowsSpawnableExt(ext: string): boolean {
  return (WINDOWS_SPAWNABLE_EXT as readonly string[]).includes(ext.toLowerCase())
}

/**
 * 解析 npm 的 `.cmd` 垫片。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是"找那一行、再抠两个东西"，而不是"按语法解析 cmd"
 * ══════════════════════════════════════════════════════════════════
 *
 * 垫片是 **npm 生成的固定形状**（`cmd-shim` 那个包），不是使用者手写的脚本。
 * 所以不去实现 cmd 的 IF/SETLOCAL/GOTO 语义，只做两件事：
 *
 *   1. 找到**真正转发参数**的那一行（带 `%*` 的）；
 *   2. 从那一行里抠出**脚本**（`.js`/`.mjs`/`.cjs` 结尾的那一项）与
 *      **解释器**（`node.exe`；`SET "_prog=node"` 那种就认不出来 ⇒ 交给调用方定）。
 *
 * 认不出来就返回 `null`（调用方走 ② `cmd.exe` 兜底）——**绝不猜**：
 * 猜错的表现是"参数被吃掉一半"，那比明确失败难查得多。
 *
 * ⚠️ `%dp0%` / `%~dp0` 都要换：新老 npm 两种写法都出现过，还见过 `%dp0`
 *    （漏一个百分号的老版本）。都换成垫片所在目录（带结尾分隔符，因为垫片里
 *    写的是 `"%dp0%\node_modules\…"`）。
 */
export function parseNpmShim(text: string, shimPath: string): NpmShim | null {
  const dir = win32.dirname(shimPath)
  const dp0 = `${dir}\\`

  const lines = text.split(/\r?\n/)
  // ① 找转发参数的那一行；找不到就退而求其次：任何带脚本扩展名的一行
  const forward = [...lines].reverse().find((l) => l.includes('%*'))
  const candidates = forward === undefined ? [...lines].reverse() : [forward]

  for (const line of candidates) {
    const tokens = tokenizeCmdLine(line)
    // ⚠️ `.ts`/`.mts`/`.cts` 也认：本仓库的假 CLI 就是 `.ts`（Node 的类型擦除直接跑它），
    //    而真实 CLI 里也有用 `.ts`/`.mts` 装的。反正最后都是用 node 跑它。
    const script = tokens.find((t) =>
      /\.(?:js|mjs|cjs|ts|mts|cts)$/i.test(t.replace(/%dp0%?|%~dp0/gi, '')),
    )
    if (script === undefined) continue
    return { script: substituteDp0(script, dp0) }
  }
  return null
}

/**
 * 把 `%dp0%` / `%~dp0` / `%dp0` 换成垫片所在目录。
 *
 * ⚠️ 三种写法都换成**带结尾分隔符**的目录，因为 npm 的垫片里
 *    `SET dp0=%~dp0` —— 那个变量本身就带结尾反斜杠，垫片接着写
 *    `"%dp0%\node_modules\…"`，于是真实文本里是**两个**反斜杠
 *    （`C:\…\npm\\node_modules\…`）。Windows 容忍重复的分隔符，
 *    所以没人注意过；我们照它本来的语义展开，不做"顺手美化"——
 *    美化会顺手改掉 UNC 路径（`\\server\share`）那种真正有意义的前导双斜杠。
 */
function substituteDp0(token: string, dp0: string): string {
  return token.replace(/%~dp0|%dp0%?/gi, dp0)
}

/**
 * 把一行 cmd 文本切成"参数"。
 *
 * 只做**双引号**分组（cmd 的垫片里只有这一种引号）：
 * `"%~dp0\node.exe" "%~dp0\cli.js" %*` ⇒ 三项，`%*` 原样留着（它是个记号，
 * 不是文件名，抠脚本时会被忽略）。
 */
export function tokenizeCmdLine(line: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && (ch === ' ' || ch === '\t')) {
      if (current !== '') out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current !== '') out.push(current)
  return out
}

/**
 * 一个参数能不能**如实**塞进 `cmd /c` 的命令行。
 *
 * 不能如实表达的就返回 `null`，调用方据此**明确拒绝**（不是改写）：
 *
 *   · `"` —— cmd 的解析器与目标程序的 CRT 解析器各有各的转义规则，
 *     "转义一次就能两边都对"的写法**不存在**（`cross-spawn` 整个包就是在绕这件事）。
 *     参数被吃掉一半的表现是"prompt 莫名其妙丢了半句"，比拒绝难查得多。
 *   · `%` —— `cmd /c` 的命令行**会**做变量展开；`%%` 只在批处理里有意义，
 *     命令行上不成立。所以含 `%` 的参数无法保证原样送达。
 *   · 换行（`\r`/`\n`）—— cmd 按行读命令，塞进去就是把命令切成两条。
 */
export function quoteForCmd(arg: string): string | null {
  if (arg === '') return '""'
  if (/["%\r\n]/.test(arg)) return null
  return /[\s&|<>^()]/.test(arg) ? `"${arg}"` : arg
}

/**
 * 拼一条 `cmd /c` 的命令行。
 *
 * ⚠️ 有一个参数没法如实表达就**抛**（理由见 `quoteForCmd`）。
 * 消息里点名是哪个参数、为什么、以及怎么办——这条路径本来就是兜底，
 * 兜底时更需要一句能照做的话。
 */
export function buildCmdLine(command: string, args: readonly string[]): string {
  // 先过一遍规则：路径里有 cmd 表达不了的字符就明确拒绝（不是改写）
  const checked = quoteForCmd(command)
  if (checked === null) {
    throw new UnspawnableCommandError(
      `这条命令的路径里有 cmd 解析不了、也无法如实转义的字符：${command}。` +
        `把它挪到一个路径里不含 " 或 % 的位置，或者改用原生安装器装的 CLI（那种给的是 .exe）。`,
    )
  }
  /**
   * ★ 命令路径**永远**加引号（分批第 43 批，使用者真机量的）：
   *
   * 原来只在"含空格"时才加。但 Windows 上的路径还可能是 `C:\Users\张三\…`
   * （中文用户名）、`C:\work\a&b\…`——这些**不含空格却照样会被 cmd 拆开或改写**。
   * 加引号是安全的：`cmd /d /s /c` 的 `/s` 会剥掉**最外层**那一对引号（下面整条再包一层），
   * 内层这对正好落在命令路径上。不加的代价是"有时能起、有时起不来"，最难查。
   */
  const parts = [`"${command}"`]
  for (const arg of args) {
    const quoted = quoteForCmd(arg)
    if (quoted === null) {
      throw new UnspawnableCommandError(
        `这条命令的参数里有 cmd 无法如实传递的字符（" 或 % 或换行），拒绝静默改写：` +
          `${JSON.stringify(arg.slice(0, 120))}。` +
          `这种参数经过 cmd.exe 一定会被吃掉一部分，而"prompt 少了半句"比失败难查得多。` +
          `改用原生安装器装的 CLI（.exe，不经 cmd）即可。`,
      )
    }
    parts.push(quoted)
  }
  // ⚠️ 整条再包一层引号：`/s` 之后 cmd 会把首尾那一对引号剥掉，
  //    所以"包一层"是**必须**的（不包的话，命令路径里有空格时 cmd 会把它拆开）。
  return `"${parts.join(' ')}"`
}

/**
 * `SpawnTarget` ⇒ 真正交给 `spawn` 的三样东西。
 *
 * 为什么要抽成一个函数：`windowsVerbatimArguments` 是**唯一**一个"漏掉就起不来、
 * 而且只在 Windows 上才起不来"的选项。让每个调用点自己写一份，等于每次新增一条
 * 起进程的路就埋一个 Windows 专属坑（分批第 43 批就是这么漏的：`process-tree` 与
 * `script-executor` 各写了一份 spawn 选项，两份都没这个旗标）。
 */
export interface SpawnPlan {
  command: string
  args: string[]
  /** 直接展开进 `spawn(..., options)`。 */
  options: { windowsVerbatimArguments: boolean }
}

export function spawnPlanFor(target: SpawnTarget): SpawnPlan {
  return {
    command: target.command,
    args: [...target.args],
    // ⚠️ 非 Windows 上 Node 忽略这个键；写上不会有害，只在 win32 + `via: 'cmd'` 时起作用。
    options: { windowsVerbatimArguments: target.verbatimArguments },
  }
}

export interface ResolveSpawnInput {
  command: string
  args: readonly string[]
  /** 注入平台（默认 `process.platform`）。**注入是为了能在 macOS 上测 Windows 分支。** */
  platform?: NodeJS.Platform
  /** 读垫片文本；读不到返回 `null`（默认用 `node:fs` 同步读）。 */
  readText?: (path: string) => string | null
  /** 解出来的脚本用哪个 node 跑。默认 `process.execPath`。 */
  nodePath?: string
  /** `cmd.exe` 从哪来（默认读 `COMSPEC`，兜底 `cmd.exe`）。 */
  env?: NodeJS.ProcessEnv
}

/**
 * 决定真的要 exec 什么。
 *
 * Unix 上一律原样返回（`via: 'direct'`）——**这条路一个字节都没变**。
 * Windows 上：
 *   · `.cmd`/`.bat` ⇒ 先试解开垫片（`via: 'shim'`），解不出来走 `cmd.exe`（`via: 'cmd'`）；
 *   · `.ps1` ⇒ 直接拒绝并说清为什么（Node 起不了它，而 `cmd /c x.ps1` 也不成立）；
 *   · 其余（`.exe`/`.com`/没扩展名）⇒ 原样返回。
 *
 * 为什么 `node` 用 `process.execPath` 而不是垫片里那个 `node`：与
 * `script-executor.resolveCommand('node')` 同一条理由——最合理的"跑这个脚本的
 * node"就是**正在跑 daemon 的这个**（它一定存在、版本一定够）。垫片里写的
 * `SET "_prog=node"` 意思是"从 PATH 找"，而 PATH 恰恰是 daemon 可能没有的东西。
 */
export function resolveSpawnTarget(input: ResolveSpawnInput): SpawnTarget {
  const platform = input.platform ?? process.platform
  // direct / shim：argv 是**真参数**，让 Node 照常加引号（含空格的路径全靠它）
  const direct: SpawnTarget = {
    command: input.command,
    args: [...input.args],
    via: 'direct',
    verbatimArguments: false,
  }
  if (platform !== 'win32') return direct

  const ext = win32.extname(input.command).toLowerCase()

  if (ext === '.ps1') {
    throw new UnspawnableCommandError(
      `Node 起不了 PowerShell 脚本（${input.command}）。` +
        `npm 装 CLI 时会**同时**给一个 .cmd 垫片，用那个即可；` +
        `或者改用原生安装器装的 CLI（给的是 .exe）。`,
    )
  }

  if (ext !== '.cmd' && ext !== '.bat') return direct

  const readText = input.readText ?? defaultReadText
  const text = readText(input.command)
  if (text !== null) {
    const shim = parseNpmShim(text, input.command)
    if (shim !== null) {
      return {
        command: input.nodePath ?? process.execPath,
        args: [shim.script, ...input.args],
        via: 'shim',
        // 同上：`<node> <script> …` 是独立 argv，路径含空格要靠 Node 加引号
        verbatimArguments: false,
      }
    }
  }

  const comspec = (input.env ?? process.env)['COMSPEC'] ?? 'cmd.exe'
  // `/d` 跳过 AutoRun、`/s` 让 cmd 按"最外层引号"处理整条命令行（见 buildCmdLine）
  return {
    command: comspec,
    args: ['/d', '/s', '/c', buildCmdLine(input.command, [...input.args])],
    via: 'cmd',
    // ★ 最后那一项已经是拼好的整条命令行 ⇒ 不许 Node 再转义一遍（否则引号错位、起不来）
    verbatimArguments: true,
  }
}

/**
 * 默认的读文件：**同步**读。
 *
 * 为什么可以同步：`spawnProcessTree` 是同步返回句柄的（见它的注释），而垫片只有
 * 几百字节、只在 Windows 上、只在命令以 `.cmd`/`.bat` 结尾时才读一次。
 * 读不到（文件没了/权限）返回 `null` ⇒ 走 `cmd.exe` 兜底，那时失败信息由 spawn 给。
 */
function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}