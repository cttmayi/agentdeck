# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

AgentDeck：跑在本机的 AI 工作台。把外部报告收进来，让本机 agent 按你写的标准审核，产出**结构化判决**（结论 / 理由码 / 严重度 / 证据 / 动作），判过才触发**有界的动作**，判不过交回执行者返工。

**开发者文档入口是 [`docs/README.md`](docs/README.md)**（代码结构、命令、技术选型、不变量、当前进行中的工作）。使用者文档是根 [`README.md`](README.md)。本文件只放高频操作与必须记住的硬约束——**深度细节一律去 docs，不要在这里堆。**

## 常用命令

后端**没有构建步骤**——`.ts` 由 Node 的类型擦除直接执行。前端是构建产物，不进版本库。

```bash
pnpm install
pnpm run build:web        # clone 后必做一次：界面是构建产物，daemon 起时会明确提示而不是发空白页

pnpm run daemon           # 本机 daemon（核心，必起）→ http://127.0.0.1:4517
pnpm run remote           # 远端服务（可选）→ http://127.0.0.1:4518（根路径即管理页）
pnpm run mcp              # 对外 MCP server（可选，stdio）
pnpm run cli status       # CLI（可选，daemon 的客户端，daemon 要在跑）
pnpm run sync-skills      # 推荐技能目录同步工具（可选，跑一次就退出）

pnpm run check            # typecheck + 全量测试（提交前跑这个）
pnpm run typecheck        # 只类型检查（含 svelte-check）
pnpm run test             # 只跑测试
pnpm run test:watch       # 监听模式
pnpm run dev:web          # 界面开发模式：Vite(5173) 把 /api 代理到 daemon(4517)，改代码热更新

pnpm run probe:layout     # daemon 界面布局检查（真 Chrome + 真 daemon，改布局后跑，不在 check 里）
pnpm run probe:remote     # 远端管理页布局检查（不在 check 里）
```

**跑单个测试**：`node scripts/node-entry.mjs --test packages/domain/src/state/state.test.ts`（测试用 `node:test`，文件 glob 见 `package.json` 的 `test` 脚本；也可传多个路径/glob）。直接 `node --test …` 只在默认开类型擦除的 node（≥22.18 / ≥23.6 / 24）上等价。

**Node 版本要求 ≥ 22.6**（推荐 24）。类型擦除（把 `.ts` 直接交给 node 跑）是 22.6 加进来的、22.18 起默认开（23.x 那条线要 23.6）。所有 `pnpm run <入口>` 命令与 `pnpm run test` 前面套了一层普通 JS 版本守卫 `scripts/node-entry.mjs`（写成 `.mjs` 是必须的——写在 `.ts` 里 node 连文件都加载不了）：**22.6–22.17（含 23.0–23.5）它自动补 `--experimental-strip-types` 重跑一层**，低于 22.6 才把堆栈换成一句能照做的话。直接 `node apps/…/cli.ts` 会**绕过**这层守卫。

**`--` 是个坑**：不要写 `pnpm run daemon -- --port 4599`——pnpm 会把 `--` 一并传进来，后面所有选项都被当位置参数而**静默失效**。daemon 与 CLI 遇到 `--` 会**直接报错**，而不是静默回落。同理，`remote` 会**点名拒绝**它不认识的参数（从前会"若无其事地把服务起起来"，看起来像成功）。

## 架构大图

**三个进程 + 一个静态产物。浏览器是唯一的远端通道，daemon 不向 agentdeck 远端服务发请求**（唯一例外：从本地路径 / GitHub 装 skill 时 daemon 自己下载，边界写死在 `packages/skill-source/src/skill-source.ts`）。

```
浏览器（页面由 daemon 托管 ⇒ 同源）
  ├─ 同源 →  http://127.0.0.1:4517/api/*   全部权威数据与操作（daemon）
  └─ 跨源 →  http://127.0.0.1:4518/api/*   账号/设定/目录/统计（remote）
daemon ──spawn──▶ agent CLI（claude / codex / generic），工作目录 ~/agentdeck-workspace/
apps/cli、apps/mcp 是 daemon 的 HTTP 客户端，不共享生命周期
```

- **`apps/daemon`** 是唯一的装配点：认识所有包，其他 app 都不认识 daemon 内部模块。它持有全部权威数据（默认 `store-file`）、执行 run、审核收口、跑工具包动作、SSE 实时流。
- **`apps/web`**（Svelte 5 + Vite 6）产物是纯静态文件，**不能单独跑**。**`apps/remote`** 只存账号/设定/公共目录/统计，不存使用者 payload（prompt/报告/日志只上报摘要）。
- **CLI / MCP / 页面走同一套 HTTP 接口**，因此权限边界一致：都**不提供"提交任意 run"**——那接受任意 `workDir` 并 spawn 子进程，等于开放代码执行入口。

**依赖方向单向无环**：`protocol ← domain ←（store-* / agent-core ← agent-*）`，apps 在最上层。`protocol` 不依赖任何内部包；`domain` 只依赖 `protocol`，不认识任何存储实现（存储是端口 `packages/domain/src/ports/store.ts`）。`agent-core` 依赖 `protocol` 但**不依赖 `domain`**（脱敏只能有一份：适配器只如实上报命令行，脱敏由调用方用 domain 的 `redactArgv` 做）。

**run 的两次是同构的**：执行与审核都是"起一个 CLI、喂第一句话、收产出"，共用同一套 argv 组装、工作目录规则、收尾。差别只有三处：谁发起、用哪个目录、第一句话里装什么。按生命周期读代码的路线是 [`docs/runtime/pipeline.md`](docs/runtime/pipeline.md)（每节标了对应文件 + 末尾代码索引），比从目录树进快。

**多 runtime 是可插拔的**：claude / codex / generic 三个适配器。加一个 runtime 要做三件事（D31）：`packages/agent-core/src/runtime-table.ts` 描述表加一行（`cli` 形态必填 `managedFlags`/`resume`，`service` 形态必填 `baseArgs`，按 kind 校验，缺了当场报错）+ 写适配器包 + `apps/daemon/src/runtime-registry.ts` 装配表加一行。造完跑 `apps/daemon/src/runtime-agnostic.test.ts`（整条跑在非 claude runtime 上，专抓"还有东西写死了 claude"）。

## 改代码前必须知道的硬约束

1. **测试里绝不调用真实 CLI**（NFR-T-01）。会烧真实额度、可能让 agent 改文件。注入假的 `AgentBackend`（`DaemonOptions.backend`），GitHub 相关的注入 `fetchImpl`。
2. **测试临时目录建在仓库内 `.cache/test-tmp`**，不用系统 tmp。有一条自动检查（`tests/test-safety.test.ts`）：测试文件里**不许出现 `tmpdir()`**，也不许对危险目录做递归删除——来自一次真实事故。
3. **注释与测试名写"为什么"，用中文**，包括踩过的坑（哪一版错了、错在哪、怎么发现的）。这是本仓库最主要的防复发手段——只写结论的注释留不住教训。
4. **`erasableSyntaxOnly: true`**：不能用 TS 的 `enum` / `namespace` / 构造函数参数属性（`constructor(readonly x: string)` 这类需要 tsc 生成代码的写法被禁）。后端直接跑 `.ts`，没有编译步骤。
5. **不要留死接口**：本仓库最常见的缺陷是"字段/接口/界面都在，就是没有代码路径让它发生"。留一处死接口，早晚有人以为它生效了。
6. **交给 CLI 的只有「第一句话」**（D29）：由 `packages/agent-core/src/first-sentence.ts` 一处组装（三块：框架/身份/任务），整块进 run 日志。要往里面加东西就加在那一个函数里——**不要另开投递通道**，也不要写 CLI 认识的项目记忆文件名。
7. **界面改动要过 `svelte-check`**（`pnpm run check` 已含，`tsc` 看不见 `.svelte` 模板）；改布局再跑 `pnpm run probe:layout`。
8. **改界面之前的三件事**（详见 [`docs/README.md`](docs/README.md)）：
   - Markdown 渲染器是自己写的（`apps/web/src/lib/markdown.ts`），渲染的是 agent 产出的文本，顺序是硬规则：**先摘结构 → 再转义剩余文字 → 最后拼自己的标签**。原始 HTML 一律不认。
   - 工作目录文件响应**必须带 `Content-Security-Policy: sandbox allow-scripts`**，**绝不要加 `allow-same-origin`**（加上等于把"agent 写的 html 能读 run 日志"这条路接回去）。测试里钉着。
   - 布局类缺陷类型检查看不见（"两栏有没有真并排"之类），只有浏览器量得出来。

## 文档与现状

- **改哪段代码 → 去哪几个文件**：`docs/design/architecture.md` §13「代码索引」与 §13.1「谁钉住了什么」。
- **不变量清单**：`docs/srs/requirements.md` §8；落到实现的映射与「已知的边界与开口」见 `docs/design/architecture.md` §4.3 与 §14。
- **决策记录**：`docs/srs/requirements.md` §16（D1–D75）。决定改了就把编号写进去——决策只活在代码里就会漂。
- **当前进行中的工作 / 新对话从哪接**：`docs/README.md` 的「当前进行中的工作」一节。
- **安全边界是必读**（不做沙箱隔离 NG7 是明确的范围决定，不是待办）：根 `README.md` 的「安全边界」与 `docs/design/design.md` §14。
- **`ref/` 是上游行为分析材料，不是本项目文档，且已 gitignore**。实现必须 **clean-room**——**不得从 `ref/multica/`（上游源码 checkout）复制任何源码**。
