# Windows 兼容性：现状、缺口与修法（2026-10 审计）

> 👤 **给开发者看的一份平台审计**。使用者的安装说明在仓库根 [`../../README.md`](../../README.md)。
> 这份文件回答一件事：**在 Windows 上这个项目能不能跑、跑起来会缺什么、要改哪里。**
>
> ⚠️ **先说口径**：这份报告是**读代码 + 在这台 macOS 上做的可移植性实测**得出的，
> **没有在真 Windows 上跑过**（这台机器没有 Windows，也没有可用的 Windows 容器/虚拟机）。
> 每条都标了 `[量到]`（我实际跑出来/打印出来的）或 `[判断]`（读代码推出来的，需要真机确认）。
> 最后一节「没量到的」把边界说清楚了——不要把它当成"已经在 Windows 上验过"。

---

## 一句话结论

| 部分 | 在 Windows 上 |
|---|---|
| 装依赖、构建界面、起 daemon、开界面、看数据 | **可以**（无原生编译依赖，锁文件里 win32 产物齐全） |
| **真跑一条任务**（拉起 agent CLI） | **会挂在第一条 A 级缺口上**：npm 装的 CLI 是 `.cmd` 垫片，现代 Node **拒绝 spawn `.cmd`** |
| 跑测试 | **61 条会红**（3 个文件：泛型后端 28 + codex 后端 13 + 流解析 20）——假 CLI 是 `#!/bin/sh` 包装 + `chmod`。其余测试**不受影响**（daemon 的 e2e 用进程内 `FakeBackend`，不起进程） |
| 布局探针 | 不支持（Chrome 路径与 `pkill` 都是 macOS/Linux 的） |

也就是说：**这台项目的主体是跨平台的，缺的是"起 CLI 的那一步"和"测试脚手架"这两处。**

---

## 已经修掉的（2026-10，随这份审计一起提交）

| 编号 | 改了什么 | 在哪 |
|---|---|---|
| **A1** | spawn 之前先问 `resolveSpawnTarget`：`.cmd`/`.bat` 会被**解开成 `<node> <cli.js> <真实参数>`**（`via: 'shim'`；用完 daemon 的这个 node，理由同 `resolveCommand('node')`），认不出来才退回 `cmd.exe /d /s /c`（`via: 'cmd'`，且参数里有 cmd 无法如实传递的字符就**拒绝**而不是静默改写） | 新 `packages/agent-core/src/spawn-target.ts`；接进 `process-tree.ts`、`apps/daemon/src/script-executor.ts` |
| **A2** | 候选扩展名改读机器的 **`PATHEXT`**，并按"Node 起得起来"过滤——**`.ps1` 从此不在候选里**（`.VBS`/`.JS`/`.WSF` 同理）；`.ps1` 真的被指到时**明确拒绝**并说清"npm 同时给了 `.cmd`" | `packages/agent-core/src/probe.ts`、`spawn-target.ts` |
| **A3** | 假 CLI 的包装按平台产出：Unix 仍是 `#!/bin/sh` + exec（形状逐字未变），Windows 改成一段**形状与 npm 垫片一致**的 `.cmd`——于是"被测的 argv 仍是真实 argv"两个平台都成立 | `spawn-target.ts` 的 `executableWrapper`；`packages/agent-generic`、`packages/agent-codex` 的两个 helper |
| B1（另一半） | 入口前置壳 `scripts/node-entry.mjs`：跑 `.ts` 之前先查 Node 版本，不合格就把 `ERR_UNKNOWN_FILE_EXTENSION` 那段堆栈换成一句能照做的话（**实测**：真的 Node 22.17.0 上现在是这段话 + 退出码 1）。⚠️ 守卫**必须**是 `.mjs`——写在 `.ts` 里是跑不到的 | `scripts/node-entry.mjs` + 四条 `pnpm run` 命令 |
| B1（一半） | `engines` 从 `>=22` 收紧到 **`>=22.18`**，README 的安装节把"为什么不是 ≥22 就够"写清了（含 23.x 那条线要 23.6） | `package.json`、`README.md` |
| B4 | `splitPath` 认反斜杠（Windows 绝对路径不再被整条当成"文件名"显示） | `apps/web/src/lib/file-view.ts` + 测试 |
| B5 | 两处"必须是相对路径"的判据从 `startsWith('/')` 换成 `isAbsolute()`（Windows 的三种绝对形态现在报的是对的原因） | `apps/daemon/src/workdir-files.ts`、`apps/daemon/src/tool-source.ts` |
| B7 | 新增 `.gitattributes`（`* text=auto eol=lf` + 二进制白名单）——Git for Windows 默认把检出变成 CRLF | `.gitattributes` |
| B9 | `~\` 也当家目录展开（Windows 使用者敲的是这个） | `apps/daemon/src/tool-source.ts`、`apps/daemon/src/local-skill-dirs.ts` + 测试 |
| **B2** | 工具包解释器的失败文案按平台给能照做的指令（Windows 上给 `winget install Git.Git` / `Python.Python.3.12` 并点明 `python.exe`），Windows 上把 **`python` 也当候选**（官方安装器给的就是它） | `apps/daemon/src/script-executor.ts` 的 `missingInterpreterMessage` / `resolveCommand` + 3 条判据 |
| **B3** | 预检在 Windows 上**真写一个临时文件再删掉**（`access(W_OK)` 在那里不查 ACL ⇒ 会在最需要它的机器上漏报）；顺带：状态目录位置上有个**同名文件**时也报错（不然是运行中的 `ENOTDIR`） | `apps/daemon/src/environment.ts` + 新 `environment.test.ts`（8 条） |
| **B6** | `rename` 对 `EPERM`/`EACCES`/`EBUSY` 做 4 次退避重试（20/40/80/160ms，约 300ms 上限），**只在 win32 上**——POSIX 上重试只会让"真没权限"晚 300ms 才报出来 | `packages/store-file/src/fs-utils.ts` 的 `renameWithRetry` + 新 `fs-utils.test.ts`（9 条） |
| **D** | 探针在 Windows 上也找得到浏览器（Chrome 三个常见位置 + **Edge** 兜底），收尾用 `taskkill /T /F` 而不是 `pkill`（Chrome 的子进程杀掉父进程后还活着、还占着 profile） | `tools/layout-probe/run.mjs` |

⚠️ **这些改动没有在真 Windows 上跑过**（本机是 macOS）。哪些是量到的、哪些还只是判断：

- **量到**：垫片解析与平台判断（21 条判据，夹具是**逐字抄的真 npm 垫片**）、假 CLI 包装的两种形状
  （含"我们的解析器认得出我们造的包装"这条往返）、候选扩展名（拿 Windows 默认 PATHEXT 当输入）、
  版本守卫（真的 Node 22.17.0 跑出来的那段话）、argv 转交（真起进程）、
  以及 **Unix 上行为一个字没变**（`via: 'direct'`，原来的测试全绿）。
- **还只是判断**：真 Windows 上 `.cmd` 垫片 exec 得起来吗、cmd 的引号规则在真机上是不是如我所想、
  `taskkill /T` 在"我们成了 node 的父进程"之后是否照样收掉整棵树。**这三条要在真机上量**（见下面清单）。

---

## A 级：会拦住"真跑任务"

> ✅ **这三条已经修完了**（2026-10，改动见上面那张"已经修掉的"表）。下面保留的是
> **当时的现场与判断依据**——为什么它必须这么修、以及哪些方案被否掉了。
> 想直接看结论就看那张表；想知道"为什么不能用 `shell: true` 一行改完"就看这一节。

### A1. `spawn` 一个 `.cmd` 垫片 —— Node 会直接抛 `EINVAL` `[判断，但机制是确定的]`

`packages/agent-core/src/process-tree.ts:79`

```ts
const child: ChildProcess = spawn(input.command, [...input.args], { …, detached: !isWindows })
```

`input.command` 是探测到的**可执行文件路径**（`packages/agent-core/src/probe.ts:43` 的
`findOnPath`）。在 Windows 上：

- npm 全局装的 CLI（`claude` / `codex`）落成的是 **`.cmd` 垫片**（npm 对 `bin` 的固定做法）；
- 而 Node 从 **2024-04 的安全版本**（CVE-2024-27980）起，**`spawn` 一个 `.cmd`/`.bat` 必须
  `shell: true`**，否则抛 `EINVAL`
  （[Node 安全公告](https://nodejs.org/ro/blog/vulnerability/april-2024-security-releases-2)、
  同类现场：[electron-builder #9488](https://github.com/electron-userland/electron-builder/issues/9488)、
  [biome #5668](https://github.com/apache/maka/issues/5668)、
  以及一份"Windows 上解析 `claude.cmd`"的修法：[everything-claude-code](https://github.com/mike-batrakov/everything-claude-code/commit/e09af121e42f69f8de52d98c9e3254a534e0ac5c)）。

我们的 `probe.ts:26` 候选表是 `.exe` → `.cmd` → `.bat` → `.ps1` → 空。所以：

- **`.exe` 排在前面**：新版 Claude Code 的**原生安装器**给的是 `.exe`（`%USERPROFILE%\.local\bin`）
  ⇒ 那种装法**不会**撞上这条；
- **npm 装的 ⇒ 命中的是 `.cmd`** ⇒ `spawnProcessTree` 抛异常。

⚠️ 三个放大伤害的细节：

1. `spawnProcessTree` **没有把这种失败翻成人话**：Node 在**参数校验阶段**就拒绝它
   （同步抛 `EINVAL`），而 `exited` 那条路会把异步失败一律压成 `{ code: null }`；
   `[判断]`——它到底是同步抛出还是 `'error'` 事件，我在这台 macOS 上量不到，但**两种都会让
   这条 run 失败、且都不是人话**，写文案前要在真机上确认一次；
2. `describeSpawnError` **不认 `EINVAL`**（它熟悉的是 ENOENT/EACCES），所以使用者会看到
   裸的 `spawn EINVAL`。**已经补上**：这个码现在会翻成"这个文件不能被直接执行 + `.cmd`
   是主因 + 改用原生安装器"——⚠️ 而且顺手把**重复的两份**（`agent-generic` 与
   `agent-codex` 各一份，注释写着"改的时候要一起改"）收进了 `agent-core` 的
   `spawn-target.ts`：判断"能 exec 什么"和"exec 失败怎么解释"本来就该在一起；
3. 这条一坏，**所有 runtime、所有任务**都跑不起来——不是边角功能。

**修法（推荐 ①）**：

| 方案 | 做法 | 取舍 |
|---|---|---|
| ① 解垫片（推荐） | 读 `.cmd` 内容，取出它真正调的那条 `node <cli.js>`，改用 `process.execPath` 起 | 绕开 cmd 的引号地狱；进程树干净（`taskkill /T` 照样管用）；参数**原样**传给 CLI，不经 shell。代价：要解析垫片文本（垫片格式是 npm 生成的，稳定） |
| ② `cmd.exe /d /s /c` | 自己拼命令行 | 要自己实现 cmd 的引号规则（`cross-spawn` 这个包存在的唯一理由就是这个），中文/空格/引号参数有踩坑面 |
| ③ `shell: true` | 一行改完 | Node 会警告 DEP0190（`shell:true` + args 有注入面）；且 `.cmd` 里的 `%*` 展开又是另一套引号规则 |

### A2. `.ps1` 根本不该出现在候选表里 `[判断]`

`packages/agent-core/src/probe.ts:26`

```ts
const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat', '.ps1', '']
```

Node **起不了 `.ps1`**（那要 `powershell.exe -NoProfile -File …`）。所以只要 PATH 里有一个
`.ps1` 而前面没有 `.exe`/`.cmd`，探测会"成功"、spawn 必失败——这正是"错误指向错地方"：
预检说这个 runtime 可用，真跑的时候才炸。

顺带一处不一致：`probe.ts` 的候选表是**写死**的，而 `apps/daemon/src/script-executor.ts:309`
的 `findExecutable` **读了 `PATHEXT`**（更对）。两处应该统一到"读 PATHEXT + 只留 spawn 得了的扩展名"。

### A3. 测试脚手架用的是 `sh` 包装 `[判断]`

- `packages/agent-generic/src/testing/fake-cli-helpers.ts:71-79`
- `packages/agent-codex/src/testing/fake-app-server-helpers.ts:50-57`

```ts
'#!/bin/sh',
`exec "${process.execPath}" "${scriptPath}" "$@"`,
…
await chmod(wrapperPath, 0o755)
```

注释里其实**已经预见了**这件事（"可执行位是文件系统属性……Windows 上更没有"），但方案本身
在 Windows 上不成立：**没有 `/bin/sh`，`chmod` 又是个空操作** ⇒ 假 CLI 起不来。

影响面是**量过的** `[量到]`：依赖这两个 helper 的测试文件是
`packages/agent-generic/src/generic-backend.test.ts`（28 条）、
`packages/agent-codex/src/codex-backend.test.ts`（13 条）、
`packages/agent-codex/src/stream-parser.test.ts`（20 条），**共 61 条**。
仓库里其余测试不经过这里（daemon 的 e2e 用进程内 `FakeBackend`，压根不起进程）。
但这 61 条恰好是"真起进程、断言进程**实际收到**的 argv"的那一层——价值最高的一层，
不该只留给 macOS/Linux。

**修法与 A1 配套**：把包装改成一个 `.cmd`（内容 `@"%~dp0\node.exe" "%~dp0fake-cli.ts" %*`，
或直接用 `process.execPath` 的绝对路径）。**A1 修好之后 `.cmd` 是能被 spawn 的**，所以一处
修法同时解决产品与测试。

---

## B 级：能跑，但会误导人或掉功能

### B1. `engines: >=22` 与"直接跑 `.ts`"矛盾 —— 我在 Node 22.17 上量到了 `[量到]`

`package.json:8` 写 `"node": ">=22"`，`README.md:69` 写"需要 Node ≥ 22（推荐 24）"。
但仓库的启动方式是把 **`.ts` 直接交给 node**（`package.json:16`：`node apps/daemon/src/cli.ts`），
这依赖 Node 的**类型擦除**。实测（本机下载 Node 22.17.0 跑仓库代码）：

```
$ node-v22.17.0/bin/node apps/daemon/src/cli.ts --help
TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts" for …/apps/daemon/src/cli.ts

$ node-v22.17.0/bin/node --experimental-strip-types apps/daemon/src/cli.ts --help
agentdeck —— 本机 AI 工作台          ← 加 flag 就能跑
```

类型擦除**默认可用**是 Node 23.6 起、并回移到 **22.18**
（[Node 22.18.0 发布说明](https://nodejs.org/tr/blog/release/v22.18.0)）。
所以 `>=22` 这个范围里 **22.0–22.17 这一段是假的**；而 Windows 使用者最容易踩——
他们按官网装 LTS，拿到的是哪一个小版本不由我们决定。

**改法**：`engines` 收紧到 `>=22.18`（或干脆 `>=24`，开发机上就是 24），
并在三个 CLI 入口（`apps/daemon/src/cli.ts`、`apps/remote/src/cli.ts`、`apps/cli/src/cli.ts`、
`apps/mcp/src/cli.ts`）加一道**一句话守卫**：版本不够就把 `ERR_UNKNOWN_FILE_EXTENSION`
那段堆栈换成"这个命令要用 Node ≥ 22.18 跑：你的是 v22.17.0；装 Node 24 或加 `--experimental-strip-types`"。
（`node:sqlite` 反而没问题：22.17 上免 flag 可用，实测过。）

### B2. 工具包的 `shell` / `python3` 在 Windows 上默认不存在，且文案没提 Windows `[量到 + 判断]`

`apps/daemon/src/script-executor.ts:358-380`：

- `runtime: 'shell'` → 找 **`bash`**。Windows 自带的是 `cmd.exe`/PowerShell，`bash` 只在你装了
  Git for Windows（Git Bash）或 WSL 之后才有；
- `runtime: 'python3'` → 找 **`python3`**。官方 Windows 安装器给的是 `python.exe`（和 `py` 启动器），
  `python3.exe` 只有 Microsoft Store 的别名才有。

而两条失败文案只写了"macOS 自带 / Debian 上 apt / brew"——**Windows 使用者拿不到能照做的指令**。

**已经这么改了**：① 文案抽成纯函数 `missingInterpreterMessage(runtime, platform)` 按平台分支
（Windows 上给 `winget install Git.Git` / `Python.Python.3.12`，并点明那个可执行文件叫 `python.exe`）；
② Windows 上把 `python` 也当候选——少了这一步的表现是"使用者明明装了 Python 3、`python --version`
也能跑，工具包却报'没装 python3'"。三条判据钉住（含"别给 Windows 使用者一条 Debian 的命令"这种硬要求）。
⚠️ Windows 上 `runtime: 'shell'`（要 `bash`）**仍然**需要 Git for Windows 或 WSL——这不是缺陷，
是那个 runtime 的定义；文案现在会说清怎么装。

### B3. 环境预检"能不能写"的判据在 Windows 上不可靠 `[判断]`

`apps/daemon/src/environment.ts:54-63` 用 `fs.access(path, W_OK)` 判可写。
Windows 上 `access` 的 `W_OK` 主要反映**只读属性**，**不查 ACL**。后果是：
状态目录其实写不进去时，预检**报 ok**，问题推到运行时以 EPERM 出现——
而本文件存在的全部理由就是"EPERM 看起来像'工作目录没建成功'，其实是状态目录写不了"。
**已经这么改了**：Windows 上真写一个 `.agentdeck-write-probe-<pid>-<时间戳>` 再立刻删掉
（写完就删，不留垃圾；失败消息带上真实 errno）；非 Windows 保留 `access` 那条快路——
POSIX 上它是准的，而且不往使用者的家目录里落任何东西。
顺手补了一条**与平台无关**的判定：那个位置上有个**同名文件**时也报不可用
（两种平台的旧实现都会说"ok"，而 CLI 会在运行中报 `ENOTDIR`——那句话里看不出
"是你的状态路径被文件占了"）。新增 8 条判据（Windows 那条用注入的 `writeProbe` 在 macOS 上钉住）。

### B4. 界面里按 `/` 切路径：Windows 绝对路径会显示成一整条 `[判断]`

`apps/web/src/lib/file-view.ts:353` 的 `splitPath` 只认 `/`。工作目录**树**不受影响
（daemon 给的是 `/` 分隔的相对路径，见 `apps/daemon/src/workdir-files.ts:206`），
但**查看器标题栏**会把 `C:\Users\ling\agentdeck-workspace\task-1\clip.webm` 整个当成"文件名"，
前面那一截目录名显示不出来。**改法**：切之前先 `replace(/\\/g, '/')`（一行 + 一条测试）。

### B5. "必须是相对路径"的那句判定漏了 Windows 的绝对形态 `[判断]`

- `apps/daemon/src/workdir-files.ts:256`：`if (relPath.startsWith('/'))`
- `apps/daemon/src/tool-source.ts:164`：`if (relPath.startsWith('/') || relPath.includes('..'))`

Windows 上绝对路径还有 `C:\…`、`\\server\share\…`、`\x` 三种形态，都不以 `/` 开头。
⚠️ **安全上不漏**：真正拦住它们的是后面那道 `resolve` + `startsWith(root + sep)`
（`workdir-files.ts:263/269`、`script-executor.ts:434-438` 的 `resolveInside`），
我逐条看过，三道都在、且都用 `sep` 比前缀（不会把 `C:\work-other` 当成 `C:\work` 的子路径）。
只是**措辞不对**：使用者会收到"跑出了工作目录"而不是"path 必须是相对路径"。
**改法**：把 `startsWith('/')` 换成 `node:path` 的 `isAbsolute()`。

### B6. 原子写的 `rename` 在 Windows 上有偶发失败面 `[判断]`

`packages/store-file/src/fs-utils.ts:28-39`（临时文件 → `fsync` → `rename`）。
`rename` 覆盖已存在的文件在 Windows 上是可行的（libuv 传了 `MOVEFILE_REPLACE_EXISTING`），
但**目标被别的进程持着句柄**时（杀毒、索引器、编辑器）会以 `EPERM`/`EBUSY` 失败——
这是 Windows 上"偶发、难复现"那一类。**已经这么改了**：`renameWithRetry` 对 `EPERM`/`EACCES`/`EBUSY` 退避重试
（20/40/80/160ms，1 次首发 + 4 次重试），重试完把**原始错误**抛出去；别的错误码
（`ENOSPC` 之类）**一次都不重试**——那类重试没有意义，只会让错误晚 300ms 才报出来。
重试**只在 win32 上做**：POSIX 的 `rename` 覆盖已打开的文件是允许的，这是两个平台的根本差别。
新增 9 条判据（注入 `rename`/`sleep`，不真的睡）。`fsync` 本身没问题（我们对**文件** fsync，没有对目录 fsync——
后者在 Windows 上本来就不成立，现在这样是对的）。

### B7. 没有 `.gitattributes`：Git for Windows 默认 `core.autocrlf=true` `[量到：文件不存在]`

检出到 Windows 的文本全是 CRLF。我核过它**不会**弄红测试：
仓库里没有"把仓库文件哈希钉死"的测试（`apps/daemon/src/review-e2e.test.ts:545` 那个哈希算的是
**运行时投递出去的字节**），仓库文件比较用的是 `includes`（如 `tool-source.test.ts:65`）。
但 **CRLF 会让任何被 `bash` 执行的仓库内脚本失败**（`runtime: 'shell'` 的工具包、
示例脚本、探针脚本），失败信息还特别难归因（`$'\r': command not found`）。
**改法**：加一个 `.gitattributes`：`* text=auto eol=lf`，再给二进制加白名单
（`*.png -text`、`*.tar.gz -text` 之类）。便宜且是跨平台仓库的标准做法。

### B8. 可选沙箱在 Windows 上**没有实现**（但它是诚实的）`[量到：代码里明说]`


`packages/agent-core/src/sandbox.ts:145-175`：macOS 用 `sandbox-exec`、Linux 用 `bwrap`，
其余平台返回
`当前平台（win32）没有实现可选沙箱。`，且 `planSandbox` 在 `mode: 'required'` 时**抛异常**
（不静默降级——这是对的）。默认 `mode: 'none'`，所以 Windows 上照常用。
**要在文档里写明**：Windows 上"沙箱"这一档不存在，别让人以为开了。

### B9. `~` 只认 `~/`，不认 `~\` `[判断]`

`apps/daemon/src/tool-source.ts:285-286`、`apps/daemon/src/local-skill-dirs.ts:90`。
Windows 使用者在输入框里敲 `~\my-tools\note` 不会展开成家目录。**改法**：`~/` 与 `~\` 都认。

---

## C 级：已经做对了的（别白改，这些是资产）

- **进程树**：`process-tree.ts:116-136` Unix 才 `detached`、Windows 走 `taskkill /pid /T /F`；
  `script-executor.ts:197-217` 同样处理。`windowsHide: true` 到处都给了。
- **环境变量**：`script-executor.ts:258-288` 在 Windows 上补 `SYSTEMROOT`/`WINDIR`/`PATHEXT`/`COMSPEC`，
  并把 `HOME`/`USERPROFILE`/`TEMP`/`TMP` 都指到本次执行的临时目录（"别往使用者家目录里落东西"）。
- **PATH 查找**：`script-executor.ts:309-323` 读 `PATHEXT`、用 `node:path.delimiter` 切 PATH
  （全仓没有一处 `split(':')` 切 PATH——我 grep 过）。
- **探测**：`probe.ts:35` Windows 上用 `F_OK`（没有可执行位这回事）、`probe.ts:63` 跳过登录 shell 兜底。
- **锁**：`store-file/src/lock.ts:36-45` 把 `EPERM` 当"进程还活着"——这正是 Windows 上正确的读法；
  `open(path, 'wx')` 的"不存在才创建"也是跨平台原子的。
- **开浏览器**：`apps/daemon/src/cli.ts:231-235` 用 `cmd /c start "" <url>`。
- **信号**：`daemon/cli.ts:432`、`remote/cli.ts:212` 都接了 `SIGINT`/`SIGTERM`（Windows Ctrl-C 会成 SIGINT）。
- **文件名**：工作目录名做了白名单替换（`workdir.ts:65` 的 `[^A-Za-z0-9_-] → _`），
  日志轮转名是 `pid-Date.now()`（`store-file/src/log.ts:176`）——**没有一处把 ISO 时间戳当文件名**
  （那会带上 Windows 非法的 `:`，我 grep 过全仓 `toISOString`，只出现在 JSON 字段里）。
- **运行时依赖**：没有原生编译依赖（没有 `better-sqlite3`/`node-pty`/`keytar`/`sharp`/`node-gyp`），
  esbuild/rollup 都是预编译产物，**锁文件里 win32 产物齐全**（我核过：`win32-x64` 12 处、
  `@esbuild/win32-x64@0.25.12/0.28.2`、`@rollup/rollup-win32-*`）⇒ Windows 上**不需要 VS Build Tools**。
- **取远端**：技能/工具抓 GitHub 走 **HTTP，不起 `git`**（全仓没有一处 spawn `git`）⇒ 不需要装 git。
- **存储**：`node:sqlite` 在 22.17 上免 flag 可用（`[量到]`），WAL 在 Windows 上正常。
- **界面**：`apps/web` 纯前端构建，无平台分支。

---

## D 级：只有开发工具（探针）不支持

`tools/layout-probe/run.mjs:3895-3903` 只找 macOS/Linux 的 Chrome 路径（有 `CHROME=` 逃生口），
`:4042` 用 `pkill -f` 收尾；视频夹具还要求 PATH 里有 `ffmpeg`。
这是**开发工具**，不影响使用者；要么在 README 里标明"探针目前只在 macOS/Linux 上跑"，
要么补两条：Windows 的 Chrome 路径 + 用 `taskkill /F /PID` 收尾。

---

## 建议的修复顺序

1. **A1 + A3**（`.cmd`/`.bat` 的 spawn 路径 + 假 CLI 包装改 `.cmd`）——决定"Windows 上能不能真跑任务、
   测试能不能跑"。一起改，因为 A3 的修法依赖 A1 的能力。
2. **A2**（`.ps1` 从候选表里拿掉 / 统一到 `PATHEXT`）。
3. **B1**（`engines` 收紧 + CLI 版本守卫 + README 的 Windows 段落：Node ≥ 22.18、pnpm、
   `runtime: shell` 的工具包需要 Git Bash 或 WSL、首次绑端口会有防火墙提示）。
4. **B3**（预检在 Windows 上真写一次文件）——它挡的是"最难归因的那个故障"。
5. 一组小修：**B4**（`splitPath`）、**B5**（`isAbsolute`）、**B7**（`.gitattributes`）、
   **B2**（文案 + `python` 兜底）、**B9**（`~\`）。
6. **B6**（`rename` 重试）、**D**（探针）——看优先级排。

---

## Windows 真机上的最小验收清单

**先把代码搬过去。** 这台开发机连不上 github.com（直连、SSH:443、本地常见代理端口都试过，
都不通），所以仓库打成了一份**自包含**的 git bundle：

```bash
# 在能拿到这份 bundle 的机器上（bundle 在 .cache/ 里，3.7 MB）
git clone /path/to/agentdeck-all.bundle agentdeck
```

已经有一份仓库、只想把新提交并进来的话：

```bash
git fetch /path/to/agentdeck-all.bundle 'refs/heads/*:refs/heads/bundle-*'
git merge bundle-main          # 或者直接 git checkout bundle-main
```

（bundle 是"整份历史"，`git bundle verify` 通过；`.cache/` 在 .gitignore 里、
不进版本库，所以每次改完要**重新生成**：`git bundle create .cache/agentdeck-all.bundle --all`。）

```powershell
node --version                       # 必须 ≥ 22.18（推荐 24）
# ★ 顺手验版本守卫：故意用一个老的 node（比如 22.17）跑下面这行，
#   期望它是"这个命令要用 Node ≥ 22.18 跑…" + 退出码 1，而不是 ERR_UNKNOWN_FILE_EXTENSION
node scripts/node-entry.mjs apps/daemon/src/cli.ts --help

where.exe claude                     # 看是 .exe 还是 .cmd —— 这条决定 A1 会不会被撞上
pnpm install
pnpm run build:web
node apps/daemon/src/cli.ts --verify-runtime all   # 探到没探到、探到的是哪个文件
pnpm run daemon                      # 界面 200（首次绑 127.0.0.1 会有防火墙提示，允许即可）
# ★ 关键一步：界面上建一条任务、让它真跑一次 —— 这一步才会走到 A1
pnpm run test                        # 期望 1855/0（A3 没修好时适配器那一片会红）
```

⭐ **最省事的一次性验法**：在 Windows 上跑 `pnpm run test`。
其中 `packages/agent-generic/src/generic-backend.test.ts` 与
`packages/agent-codex/src/codex-backend.test.ts` 会**真的 spawn 一个假 CLI**
（A3 造的 `.cmd` 包装）并把**进程实际收到的 argv** 落盘比对——
一次同时验到 A1（解开垫片、exec 得起来）与 A3（包装形状对）。

补几条诊断用的：

```powershell
node -e "console.log(process.env.PATHEXT)"
node -e "console.log(process.env.COMSPEC)"     # A1 的兜底路径用的就是它
node -e "require('node:fs').access(process.env.USERPROFILE, 2, (e)=>console.log(e))"   # B3 那条（在 Windows 上不可信）
node -e "require('node:fs').writeFileSync(require('node:path').join(process.env.USERPROFILE,'.agentdeck-write-probe'),''); require('node:fs').unlinkSync(require('node:path').join(process.env.USERPROFILE,'.agentdeck-write-probe'))"   # 权威判据
# 探针能不能找到浏览器（D）：应打出一个存在的路径
pnpm run probe:layout -- --dry-run 2>$null | Select-String -Pattern 'chrome'
```

---

## 没量到的（诚实清单）

1. **真 Windows 上的一次完整跑通**——这份报告里所有 `[判断]` 都没有真机证据。
2. **`.cmd` 垫片能否原样转发参数**（中文、空格）：A1 已经选了"解开垫片"这条路（参数不经 shell），
   所以这条已经**在我们这侧**绕开了；真机上要量的是"解开之后 exec 得起来吗"。
   仓库里现成的手段：`FAKE_ARGV_ECHO_FILE` 会把进程**实际收到**的 argv 落盘 ⇒
   在 Windows 上跑 `packages/agent-generic/src/generic-backend.test.ts` 就能同时验到 A1 与 A3。
3. **`fs.access(W_OK)` 在 Windows 上对 ACL 拒绝目录的返回值**（B3 的判断依据）。
4. **Defender / 索引器对 `rename` 的干扰面**（B6 的频率，是"偶发"还是"经常"）。
5. **长路径（MAX_PATH 260）**：工作目录默认在 `%USERPROFILE%\agentdeck-workspace\…`，够短；
   但技能与工具物化会再往下几层（`.claude/skills/<slug>/templates/…`）。没量过临界点。
6. **探针在 Windows 上的可行性**（Chrome 路径、`taskkill`、`ffmpeg` 的 PATH）。