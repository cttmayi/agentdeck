# 平台兼容纪律（2026-11，Windows infra_error 事故后固化）

> 目的：把"Windows 与 macOS 行为不同"的教训收拢成一页，改代码前过一遍。
> 每一条都来自仓库里真实发生过的差异或已收口的平台分支，附来源。
> 机器检查在 `tests/platform-compat.test.ts`，判级回归测试在
> `packages/agent-codex/src/stream-parser.test.ts` ——规则要查，不是要记得。
> 平台兼容的**现状审计**（哪些已修完、哪些还没量）在
> [`../reference/windows-compat.md`](../reference/windows-compat.md)——这里是规则。

## 0. 事故：Windows 上沉淀总报 infra_error（2026-11，提交 f79ee99）

**症状**：codex 干完了活（`skill/SKILL.md` 都写好了、收尾话也说了），run 却报
`infra_error`；界面上多显示出来的"已创建 [skill/SKILL…"正是它**成功**的收尾话。

**根子**：codex 的 app-server 是**常驻进程**，`turn/completed` 先到之后，适配器主动
`terminate()` 收掉它——

- macOS/Linux：`terminate()` 发 SIGTERM，进程被信号杀死 ⇒ Node 报 `exitCode=null`；
- Windows：`terminate()` 走 `taskkill /T /F` **强杀** ⇒ 进程留下 `exitCode=1`。

旧判据把"退出码非 0"一律当 CLI 失败，于是**同一份成功产出**在 Windows 上被误判成
`agent_error` → executor 记 `infra_error`。macOS 上从未触发，因为信号死从不给非零码。

**结论**：进程退出码在**自己 terminate 之后**读到的值，是"我们怎么杀它"的产物，
不是 CLI 的成败。这条纪律就是为防它复发。

## 1. 进程退出码：只有进程**自己**退出时才可信

- ✅ turn 的结局以**协议终止帧**（`turn/completed` 的 status/error）为准；
  进程**先于**终止帧死掉时的退出码，才说明 CLI 真挂了。
- ❌ 适配器**自己 terminate 之后**不许读退出码参与判级/记终态（run 记录里
  记 `exitCode=null`，和 Unix 行为对齐）。
- 机器检查：`tests/platform-compat.test.ts` 扫 `.exited.catch(` 反模式
  （"terminate 之后捞退出码"的旧形状）；判级回归用例
  `classifyCodexFailure(exitCode:1 + completed + 有产出) → null` 钉着契约本身。

## 2. 收进程只有一处：`process-tree.ts`

- ✅ terminate 的平台分支（Unix 信号 / Windows `taskkill /T /F`）**只**在
  `packages/agent-core/src/process-tree.ts` 一处；所有适配器经它收进程。
- ❌ 适配器不许自己写平台分支、不许自己 `spawn('taskkill'`。
- 机器检查：`spawn('taskkill'` 只允许出现在 process-tree.ts。

## 3. 适配器不许读平台

- ✅ 平台知识（可执行文件探测、权限位、进程树、taskkill）收口在
  `agent-core`（`spawn-target.ts` / `probe.ts` / `process-tree.ts` /
  `executable-check.ts`）；适配器是平台无关的。
- ❌ 适配器（`packages/agent-{codex,claude,generic}/src`）里不许出现
  `process.platform` / `isWindows`。
- 机器检查：见 `tests/platform-compat.test.ts`。
- 反例参考（合法分支）：`store-file/fs-utils.ts`（win32 的 rename 重试——
  POSIX 不会因"目标被打开"失败）、`apps/daemon` 的 `/api/fs/reveal`
  （macOS `open` / Windows `explorer.exe` / Linux `xdg-open`）——
  它们**不在**适配器里，且各有注释说明为什么需要分支。

## 4. 路径：拼用 `join()`，对外统一 `/`

- ✅ 拼接路径用 `node:path` 的 `join()`；**对外契约**（素材 relPath、URL、日志里的路径）
  一律 `/` 分隔；测试断言路径时用 `[/\\]` 兼容 Windows 反斜杠。
- 示例：`crystallize-e2e.test.ts` 的
  `assert.match(res.dir, /skill-draft-[A-Z0-9]+[/\\]material$/)`。
- 事故关联：Windows 上 `join()` 出的是 `\`，直接拿去做正则/字符串匹配就翻车。

## 5. 文件系统大小写：NTFS 不敏感

- ✅ 凡是"名字判重/冲突"（技能 slug、文件去重、目录比较）按**大小写不敏感**处理，
  或在代码里明确"这里就是大小写敏感的、Windows 上会怎样"。
- 风险：`SKILL.md` 与 `skill.md` 在 macOS 是两个文件、在 Windows 是同一个——
  判重逻辑在 Windows 上会提前撞车。

## 6. 行尾 CRLF：Windows 文件可能带 `\r`

- ✅ 从 Windows 机器来的文本（素材、配置文件、agent 产出）比较/匹配前容忍 `\r`
  （正则用 `\r?\n`，或先 normalize）。
- 风险：素材或索引里混进 `\r`，起草者拿到的行尾与预期不符、diff 永远"有改动"。

## 7. 可执行文件与 spawn

- ✅ spawn 外部命令显式 `windowsHide: true`；可执行文件探测一律走
  `spawn-target.ts`（`win32` 平台是**注入的**参数，不是读 `process.platform`）。
- ✅ 测试里的假 CLI 用 **Node 脚本**（跨平台），不要用 shell 脚本
  或依赖 Unix 工具的假货（`fake-app-server.ts` 即 Node 脚本）。

## 8. 环境变量：Windows 名字大小写不敏感

- ✅ 读环境变量用**约定大小写**（全大写），比较时按大小写不敏感处理；
  测试注入 env 时注意 `PATH`/`Path` 是同一个。

## 9. 文件占用与删除：Windows 删不掉被打开的文件

- ✅ 涉及删除/重命名/原子替换的代码，想一下"文件正被别的进程打开"：
  `store-file/fs-utils.ts` 已有 win32 的 rename 重试（`[20, 40, 80, 160]`ms），
  新代码复用那套，不要另写一份。
- 关联：run 工作目录的锁等待要**超时并如实报**（executor 里 `infra_error` 的
  锁超时路径），Windows 上锁的语义更紧，别假设"马上就能拿到"。

## 怎么新增一个平台分支

1. **先问**：这个分支能不能靠注入参数表达（像 `spawn-target.ts` 的
   `platform: 'win32'`），而不是读 `process.platform`？
2. 分支点收口在 agent-core 或明确标注"这是合法的平台分支"的文件，
   **不要**散进适配器。
3. 注释写"为什么需要"（哪个平台、什么行为不同、不分支会怎样）。
4. 如果适配器里真的躲不掉平台判断，`tests/platform-compat.test.ts` 会拦——
   把分支挪到对的地方，而不是往扫描名单里塞例外。
