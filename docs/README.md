# AgentDeck 开发者文档

> 👤 **这份文件是给开发者的**：代码怎么组织、从哪读起、怎么开发和验证、每份文档回答什么。
> **使用者**请读仓库根的 [`../README.md`](../README.md)（怎么跑起来、怎么用、安全边界）——
> 其中「安全边界」那一节是必读的，开发者也不能跳过。

> 📁 **目录组织（2026-09）**：文档按用途分四组——
> [`srs/`](./srs/)（需求与决策）、[`design/`](./design/)（设计与架构）、
> [`runtime/`](./runtime/)（运行时框架与流程）、[`reference/`](./reference/)（参考手册）。
> 本文件是入口索引；改文档时保持"每组一份职责"的边界，不要往根目录堆新文件。

---

## 从哪读起

| 想知道 | 读 |
|---|---|
| 这东西是干什么的、给谁用 | [`../README.md`](../README.md)（使用者的那一份） |
| **要做什么**、验收标准、不变量、决策记录 | [`./srs/requirements.md`](./srs/requirements.md) |
| **现在的代码长什么样**（模块、依赖、接口、数据落点、不变量强制点、代码索引） | [`./design/architecture.md`](./design/architecture.md) |
| **runtime 是怎么抽象出来的**（AgentBackend 公共契约、RuntimeDescriptor 数据表、公共机器、差异点、加 runtime 清单） | [`./runtime/runtime-framework.md`](./runtime/runtime-framework.md) |
| **为什么这么做**（架构、数据模型、接口、状态机、安全边界） | [`./design/design.md`](./design/design.md) |
| **一条 run 实际是怎么跑起来的**（命令行、注入、判决链路） | [`./runtime/pipeline.md`](./runtime/pipeline.md) |
| **skill 是什么、住在哪、怎么装**（来源、磁盘落点、注入、限额） | [`./reference/skills.md`](./reference/skills.md) |
| **工具包怎么开发、住在哪**（清单逐字段、脚本约定、远端目录、执行链路） | [`./reference/tools.md`](./reference/tools.md) |
| 端到端走查与边界情况 | [`./reference/scenarios.md`](./reference/scenarios.md) |
| **智能体组是怎么工作的**（工作流：执行 → 审核 → 行动、展开、返工闭环、四道闸） | [`./reference/agent-group-workflow.md`](./reference/agent-group-workflow.md) |
| **要装到 Windows 上跑 / 有人报"Windows 上跑不起来"** | [`./reference/windows-compat.md`](./reference/windows-compat.md)（先看「现在的状态」，再看「下一步」与「最小验收清单」） |

**读代码的路线**：`./runtime/pipeline.md` 是按"一次 run 的生命周期"写的，每一节都标了对应文件——
从它进比从目录树进快得多。改哪一段去哪找，见那份文档最后的「代码索引」，
以及 `./design/architecture.md` §13 的「代码索引」与 §13.1 的「谁钉住了什么」。

---

## 文档地图

| 文档 | 说明 | 版本 |
|---|---|---|
| [`./srs/requirements.md`](./srs/requirements.md) | **需求说明书（SRS）** —— 定位、目标、非目标、场景、功能需求、不变量、状态机、验收标准、里程碑、决策记录 | v2.25 |
| [`./design/architecture.md`](./design/architecture.md) | **架构文档（当前实现）** —— 运行时拓扑、依赖方向、八个包与五个 app 的结构、完整路由表、存储布局、扩展点、不变量→强制点、代码索引与测试对照。**结论都指到具体文件** | — |
| [`./design/design.md`](./design/design.md) | **设计文档** —— 总体架构、包结构、存储端口、数据模型、接口、状态机、Verdict schema、本地 Daemon、Claude 适配层、审核流水线、动作与审计、远端能力与插件系统、安全边界。**2026-09 的第一句话三块组装见 §15.33** | v2.8 |
| [`./runtime/pipeline.md`](./runtime/pipeline.md) | **执行与审核：完整流程** —— 参考手册，描述**当前实现**：受理 → 准备 → 命令行 → 输入 → 收尾；执行与审核的差别、失败原因码、去哪儿看全过程、已知的坑 | — |
| [`./reference/skills.md`](./reference/skills.md) | **Skill 参考手册** —— 一个 skill 由什么构成、来源（本机目录 / GitHub / 推荐清单；界面另有「本地清单」「从本地安装」两个**入口**）、**装进来正文与支持文件落成真文件（`~/.agentdeck/skills/<slug>/`，磁盘为准）而 `log/skill.jsonl` 只留索引**（**没有例外**）、注入到工作目录的哪、frontmatter 会被怎么改写、限额与常见坑 | — |
| [`../tools/skill-catalog-sync/README.md`](../tools/skill-catalog-sync/README.md) | **推荐技能目录的同步工具**（独立工具，不属于远端服务）—— 清单怎么改、**一次同步要花多少次 GitHub API 调用**（以及撞限额时是什么表现）、失败语义（单条失败一个字都不换）、目录布局（工具与服务之间的唯一约定） | — |
| [`./reference/tools.md`](./reference/tools.md) | **工具包参考手册** —— 一个包 = 一个组、`tool.json` 清单逐字段（含 bound/open 参数）、**怎么照着范例开发一个工具**、脚本与平台的三条约定（stdin/stdout/dry-run）、执行时的环境与临时目录、远端目录的放置位置、判决→动作的完整链路 | — |
| [`./reference/first-sentence-template.md`](./reference/first-sentence-template.md) | **第一句话模版参考（当前实现）** —— 三块组装（① 框架 / ② 身份 / ③ 任务）× 三条链路（执行 / 审核 / 聊天）的逐项细节、变量表（11 条）、默认模版与渲染实例（逐字）、A/B 投递档、校验规则、老模版迁移、**调整时必须守住的不变量**与代码索引 | — |
| [`./reference/windows-compat.md`](./reference/windows-compat.md) | **Windows 兼容性审计（2026-10）** —— **现在的状态**（A/B/D 已修完、B8 是设计决定）、**下一步**（只剩"在真 Windows 上量一次"，附定位办法）、A/B/C/D 四级缺口逐条（都指到文件行并标 `[量到]`/`[判断]`）、真机最小验收清单、以及**没量到的**那一节 | — |
| [`./reference/scenarios.md`](./reference/scenarios.md) | **使用场景说明** —— 端到端走查、多 agent 分工、插件机制、异常边界、数据归属、待确认点 | v2.5 |
| [`./reference/agent-group-workflow.md`](./reference/agent-group-workflow.md) | **工作流智能体组：它是怎么工作的**（当前实现）—— 组里装了什么、三步（执行 → 审核 → 行动）、建任务时怎么摊开成普通配置、判决怎么分流、**返工闭环**（交回同一执行者原地改）、行动与固定参数、几道边界、界面看到什么 | — |
| [`./runtime/runtime-framework.md`](./runtime/runtime-framework.md) | **Runtime 抽象框架（当前实现）** —— AgentBackend 公共契约与 RuntimeDescriptor 数据表（都贴真代码）、claude 与 codex 两行对照、daemon 公共机器路径表、差异在哪、加第三个 runtime 的清单 | — |
| [`runtime/codex-runtime-design.md`](runtime/codex-runtime-design.md) | **Codex 支持设计（app-server 形式）** —— 为什么用 app-server 而不是 `codex exec`、事实核查、`kind` 契约扩展、per-run 进程模型、包结构、描述表取值、未验证项清单（✅ 已接入真实 codex 0.144.0-alpha.4 与 0.157.1，证据等级 verified；实测与文档差异清单） | v2 |
| [`./design/skill-crystallization.md`](./design/skill-crystallization.md) | **聊天沉淀 skill 设计（chat-to-skill，已设计未实现）** —— 在 conversation 里把"这段做法"提炼成 SKILL.md 入库、可进化（覆盖 + git 版本管理）；触发双层（用户主动按钮 + 信号建议）、起草 run + 不结晶清单、审阅后入库、git 化自动 commit；调研依据（skilldistill / dsh-skill-evolution / skill-miner / Anthropic 官方）与实现范围六项 | 设计稿（D80） |

> 决策记录见 `./srs/requirements.md` §16（**D1–D75**；D1–D50 是需求期、D51 起是逐轮的实施决定）。**决定改了就把编号写进去**——同步文档时
> 发现 `D28` 被代码注释引用了十几处、决策表里却一直没有：**决策只活在代码里就会漂。**

---

## 代码结构

### 可执行入口（`apps/`）

| 入口 | 说明 |
|---|---|
| `apps/daemon` | 本机 daemon：托管界面与本地接口。**全部权威数据在本机** |
| `apps/web` | Web UI（Vite + Svelte 5）。产物是纯静态文件，由 daemon 托管；它**不能单独跑**（`dev:web` 只是把 `/api` 代理到 daemon） |
| `apps/cli` | **命令行**：daemon 的客户端。默认 JSON 输出、退出码有含义，供人与 agent 驱动 |
| `apps/mcp` | **对外 MCP server**：stdio JSON-RPC，供其他 agent 驱动 |
| `apps/remote` | **远端服务**：账号 / 设定 / 公共目录 / 第三方查询 / 记录统计 |

> ⚠️ 三者（CLI、MCP、页面）走**同一套** HTTP 接口，因此权限边界也一致：
> 都不提供"提交任意 run"——那接受任意 `workDir` 并在其中启动子进程，
> 等于一条现成的代码执行入口。

### 库（`packages/`）

依赖方向是**单向**的：`protocol` ← `domain` ←（适配器 / 存储 / apps）。
`protocol` 不依赖任何内部包，`domain` 只依赖 `protocol`。

| 包 | 职责 |
|---|---|
| `protocol` | 全项目契约的**单一来源**：实体、枚举、接口形状、判决 schema。daemon、页面、远端都从这里取类型 |
| `domain` | 领域模型层：状态机、不变量、路由、环路边界、审计脱敏。**不认识任何存储实现** |
| `store-file` / `store-sqlite` | `Store` 端口的两套实现（v1 文件 / v2 SQLite）。领域层只认识端口。⚠️ **`store-sqlite` 已实现但没有接线**：daemon 用的是 `store-file`，而且 `apps/daemon/package.json` 里**没有** `@agentdeck/store-sqlite` 这个依赖——现在连 import 都解析不到 |
| `agent-core` | 与具体 CLI 无关的适配层：runtime 描述表、禁改参数表、argv 组装、**第一句话模版**（D32）、技能注入、沙箱、进程树。⚠️ **受管上下文块已删**（D29）——不再有 `context-block.ts` |
| `agent-claude` | Claude Code 适配器（首版参考实现） |
| `agent-generic` | 第二个 CLI 适配器——价值在于给出**可插拔的第二个实证**，而不是"多支持一个厂商" |
| `agent-codex` | 第三个适配器（**service 形状**：`codex app-server` + JSON-RPC，无 run 级 argv）。证据等级 **verified**（0.144.0-alpha.4 与 0.157.1 实测）；残余未验证项（dynamicToolCall/webSearch 等）见 `unverifiedFields()` 清单 |
| `i18n` | 界面词表（中 / 英）+ **取值标签**（D39）。机器值一个字都不翻，翻译只加在为它配的标签上 |

---

## 开发环境与命令

需要 **Node ≥ 22.6**（推荐 24——后端直接跑 `.ts`，没有构建步骤）。
⚠️ 不是"≥ 22"就够：类型擦除（把 `.ts` 直接交给 node）是 **22.6** 加进来的、
**22.18** 起才默认开（23.x 那条线要 **23.6**），低于 22.6 会报
`ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"`。
所以所有 `pnpm run` 入口（含 `test`）前面套了一层**普通 JavaScript** 的版本守卫
（[`../scripts/node-entry.mjs`](../scripts/node-entry.mjs)，写成 `.mjs` 是必须的——
守卫写在 `.ts` 里跑不到，node 连那个文件都加载不了），它分三档：
**默认可用** ⇒ 把 `process.argv` 掰回"入口直接跑"的样子再 `import()` 真入口；
**22.6–22.17 / 23.0–23.5** ⇒ 自动补 `--experimental-strip-types` **重跑一层**
（`pnpm run <命令>` 自己传不了 flag，所以只能在守卫里补）；**低于 22.6** ⇒ 给一句能照做的话。
真机验证过：Node 22.17.0 上 `pnpm run daemon` 与 `pnpm run test` 都跑得通（D75）。

```bash
pnpm install
pnpm run build:web          # 界面是构建产物，不进版本库；clone 后必做一次

pnpm run daemon             # 起本机 daemon（界面 + 接口）
pnpm run dev:web            # 界面开发模式：Vite(5173) 把 /api 代理到 daemon，改代码即时热更新
```

| 命令 | 说明 |
|---|---|
| `pnpm run check` | **typecheck + 全量测试**（提交前跑这个） |
| `pnpm run test` | 只跑测试；`pnpm run test:watch` 监听模式 |
| `pnpm run build:web` | 构建**两个**前端：daemon 界面 → `apps/web/dist/`、远端管理页 → `apps/remote/web/dist/`（都已 gitignore） |
| `pnpm run build:remote-web` | 只构建远端管理页（`apps/remote/web/dist/`） |
| `pnpm run dev:web` | 界面开发模式（5173 → 代理到 4517） |
| `pnpm run probe:layout` | **daemon 界面的布局检查**（约 470 项）：用真浏览器量布局并断言。改过界面布局时跑；需要先 `build:web`，**不在 `check` 里**（它要真 Chrome + 真 daemon）——见 `../tools/layout-probe/README.md` |
| `pnpm run probe:remote` | **远端管理页的界面检查**（21 项）：起一次性远端服务（夹具数据、假同步工具、不联网）用真 Chrome 量。改过远端页时跑，**不在 `check` 里**——见 `../tools/remote-ui-probe/README.md` |
| `node apps/daemon/src/cli.ts --verify-runtime all` | 查看 CLI 版本验证状态（FR-CLI-07），不起服务。⚠️ 所有 `pnpm run <入口>` 命令都先过 `scripts/node-entry.mjs` 那层版本守卫（上面"开发环境"一节），直接敲 `node apps/…/cli.ts` 则**绕过**它 |
| `pnpm run sync-skills` | **推荐技能目录的同步工具**：抓清单里的 GitHub 技能写进公共目录（跑一次就退出，**不是**服务；参数 `--dry-run` / `--out` / `--manifest`）。⚠️ 要联网、会撞 GitHub 匿名限额（60 次/小时；**实测一条大技能就 11 次**——`pptx` 52 个文件、9 个目录 ⇒ 列目录 10 次 + 取版本 1 次，所以 12 条在匿名下装不下一整轮）。**第一条失败就停**、**1 小时内抓过的不再下载**、已抓到的进**断点目录**。**记不住选项就敲 `pnpm run sync-skills --help`**（只读、无副作用）——见 `../tools/skill-catalog-sync/README.md` |
| `pnpm run remote` / `mcp` / `cli <命令>` | 另外三个入口。推荐清单的**配置文件**在数据目录下（`recommended-skills.json`）：第一次跑同步时由工具把内置默认转存过去，`--manifest <文件>` 可另指一份（D54）。⚠️ `remote` 起来之后 **http://127.0.0.1:4518/** 就是**管理页**（技能 / 工具目录，D51/D52）：能看、能**重新同步**、能**手动装一条技能**（填 GitHub 链接）、能**卸载本地装的那条**（同步来的要改清单再同步）；`--web-dir` / `--sync-tool` 可换产物目录与同步工具 |

---

## 当前进行中的工作（新对话从这里接）

| 线索 | 状态 | 去哪看 |
|---|---|---|
| **Windows 兼容性**（2026-10） | A / B / D 三级**已修完**（`pnpm run test` 1855/0、`typecheck` 0 错）；**剩"在真 Windows 上量一次"**——那几条 `[判断]` 还没变成 `[量到]` | [`./reference/windows-compat.md`](./reference/windows-compat.md) 的「现在的状态」+「下一步（新对话从这里接）」 |
| 展示页面支持音视频 | 已做完（daemon 认 `video/*`/`audio/*` + 支持 `Range`；查看器就地播放） | `./design/design.md` §15.58 |
| 远端管理页（技能 / 工具目录） | 已做完（含常驻探针 `pnpm run probe:remote`，21 项） | `./srs/requirements.md` §16 的 D51–D55 |
| **文档对账**（2026-10） | 已做完（只改文档、没动代码）：把「链路深度上限与环检测」被说成硬不变量的两处 README 改回实情；给 `architecture.md` 的「完整路由表」补上**整段漏掉的 `/api/agent-groups` 5 条**并修掉 `POST /api/agents` 的过时字段；术语表的「行动权限」落点从 agent 改到**智能体组**；§14 补上本轮新查到的几处开口 | `./design/architecture.md` §4.3 / §7.2 / §13 / §14；本文件下面那节「架构与不变量」 |
| **布局探针重对齐** | ⚠️ **没做，且是当前最大的空缺**：探针 542 条里 74 红 / 105 没量到，红在「新建任务的三步链 / 审核标准 / 智能体」这些**已经被改掉的形状**上 ⇒ **界面暂时没有可信的自动回归网**。另有一层环境障碍：它要真无头 Chrome，受限环境下 Chrome 可能连 Crashpad 目录都写不了（`exit 133`） | `tools/layout-probe/README.md` 的「⚠️ 现状：有 7 段已经过期」；`./design/design.md` §15.57 |
| **从「本地清单」安装技能**（2026-10） | 已做完：安装面板第三个页签，读仓库自带的一份 JSON（`apps/daemon/catalog/skills.json`），点一下由 daemon 现去取——**不用远端服务 / 同步工具 / 登录**（`--skills-catalog` 可换一份） | `./srs/requirements.md` §16 的 **D71**；`./reference/skills.md` §3；`./design/architecture.md` §7.2 / §13 |
| **技能内容落盘**（2026-10） | 已做完：技能正文与支持文件存成**真文件**放在 `~/.agentdeck/skills/<slug>/`（`--skills-root` 可覆盖），**磁盘为准**（改文件就生效）；`log/skill.jsonl` 退化成索引（**所有来源都是这样，没有例外**——`localdir:` 那条例外随 D73 撤掉了） | `./srs/requirements.md` §16 的 **D72**；`./reference/skills.md` §2；`./design/architecture.md` §5.1 / §13 |
| **本地技能目录改成显式安装**（2026-10） | 已做完：原来勾选目录 ⇒ 每次读列表自动对账读入；现在改成安装面板的第四个页签「从本地安装」——扫内置的那几个目录（claude / codex / cursor / agents），**逐条装**，装完落 `~/.agentdeck/skills/<slug>/`、带 `localdir:<根目录>` 标记。`Workspace.localSkillDirs` 与 `PUT /api/skills/local-dirs` 删掉，`FileStore` 的 `localdir:` 例外也撤了 | `./srs/requirements.md` §16 的 **D73**；`./reference/skills.md` §6；`./design/architecture.md` §5.1 / §7.2 |
| **本地清单按类别分组**（2026-10） | 已做完：安装面板「本地清单」页签改成**按类别分组、默认折叠**（点类别标题展开）；清单内容从 12 条扩到 **28 条**——使用者给的一批里逐条**联网核实**，能装的才写进 `apps/daemon/catalog/skills.json`（6 个合集仓库指到具体子目录；失效/非 GitHub/无 SKILL.md 的不写，另附说明） | `./srs/requirements.md` §16 的 **D74**；`./reference/skills.md` §3 |
| **Node 22 兼容**（2026-10） | 已做完：入口守卫 `scripts/node-entry.mjs` 从"两档"改成**三档**——22.6–22.17 / 23.0–23.5 **自动补 `--experimental-strip-types` 重跑一层**（不再报 `ERR_UNKNOWN_FILE_EXTENSION`），`< 22.6` 才劝升级；`engines` 放到 `>=22.6`，`pnpm run test` 也走这层（测试的 `.ts` 夹具靠 `NODE_OPTIONS` 继承 flag）。顺带修两处真机上撞到的：`node:sqlite` 的 `?N` 语句在 22.x **只认按名字绑**、超时等待的 grace 计时器**不能 `unref`**（22 的 test runner 会把"循环空了的挂起测试"取消掉）。真机在 **Node 22.17.0** 上跑通 `pnpm run daemon` 与全量测试 | `./srs/requirements.md` §16 的 **D75**；`./reference/windows-compat.md` 的 B1「补记」 |
| **聊天沉淀 skill（chat-to-skill）**（2026-10） | 🔄 **四轮重设计：P0 已实作（2026-10-19）**——使用者提五点（素材落盘让 agent 读 / 用一套优秀 skill 去生成 / 多文件产物与呈现 / 审阅免填 frontmatter / 新建-更新对比 + git 历史）。P0 = 素材落盘成 `material/` 目录（agent 按需读，不再内联进第一句话）+ 平台内置技能 `writing-skills`（随 run 注入，正文与 references 承载“怎么写 skill”）+ 产出写 `skill/` 目录（多文件、树形呈现、文本兜底给不会写文件的 runtime）+ 审阅只从 SKILL.md 的 frontmatter 取 name/description（不再手填）、slug 可确认、校验问题定位到文件；入库入参改成 `{files}`，服务端复算。**P1 也已实作（2026-10-19）**：变更集 diff（后端 `text-diff.ts` 算 LCS，逐文件 hunks，
界面画 +n −m 与逐行差异，可切"对比当前版本 / 对比上一版草稿"）、素材分节（清单 + 预览 + 目录）、
「按意见改一版」（同源素材 + 上一版产出进 `previous-draft/` + 意见进 `feedback.md`，新 run 记
`revisedFrom`）。P2 待做：git 历史 list + 选中两版对比。设计见 `./design/skill-crystallization.md` §5.0，P0 实作与三个坑见 §5.0.10；此前 1–10 已实作**（1–6 见下一条；7–10 界面，2026-10-19）：沉淀面板从**设置式抽屉**改成**任务详情式全页**——右主区切换成沉淀流程页（MainArea 壳：返回+标题+来源副题+**随流程变的栏头操作**：开始沉淀/停止/确认入库），页面 = **步骤条（①目标 → ②起草 run → ③审阅入库）+ 分节渐进展开**（素材摘要/目标/起草日志常驻/草稿审阅/完成态，失败态红徽标+失败原因+重新起草）；**沉淀是独立一页**（三轮，2026-10-19 使用者定：导航列「工具」之下的 TAB）：左栏 = 沉淀任务列表（未入库的起草 run，可切换；已入库的不显示），右栏 = 流程页；列表上方「新建沉淀」→ 选来源（对话 / 达标的任务）再进目标步骤。地址 `#/crystallize/<runId>`（`#/chat|crystallize/<runId>` 保留并重定向），切页/刷新/浏览器后退都找得回；**状态语义**（三轮修：左栏原来把起草 run 的「已完成」当任务状态，实际 run 跑完≠沉淀完成——5 条里 3 条标「已完成」而 skills-mine 一条都没有；现在按任务状态显示 起草中/待审阅/起草失败/已停止，「已沉淀」只在 commit 成功后）：**放弃**由 `POST /api/crystallize/discard` 真落地（`discarded: true`，还在跑先停；左栏「×」与流程页「放弃」两处入口），没入库的草稿终于能收尾；**控件与任务页同一套**（三轮返工：`ListRow` 行壳 / `Modal` 浮层 / 顶栏 `setPageActions` 主操作 / 全局 `.badge` + `lib/run-status.ts` 状态映射 / `FoldSection` 折叠 / 分节就是任务详情那种朴素 `drawer-section`——不再自造行样式、`.status-tag`、遮罩层或卡片分节）；`GET /api/crystallize/targets` 加 `materialStats`（素材起草前可见、空素材早失败）+ **沉淀不是任务**（起草 run 不挂 issue、不进任务列表）且**可恢复进行中的起草**（起草 run 记 `subject.sourceRunId` + 沉淀目标 `crystallizeTarget`，重开流程页「继续」挂回——起草中看日志、已完成直接进审阅，对话按全部轮次匹配）。设计语义不变：**提炼的落独立根 `~/.agentdeck/skills-mine/`（git 化 + 自动 commit），与安装根 `~/.agentdeck/skills/` 物理分离**；触发只有用户主动；git 可用性保护；新建必填「作用描述」；任务场景需有用户反馈或审核过才可用 | `./design/skill-crystallization.md` §4.1.1 / §4.1.2 / **§5.0（四轮重设计）** / §6.1 / §7.4 / §8.1；`./srs/requirements.md` §16 的 **D80** |
| **沉淀 skill（D80 实作）**（2026-10） | ✅ **已实作**（后端 951417a + 前端 16e8dcd + e2e）：双根 `skills-mine`（git 化 + per-repo 兜底身份 + 自动 commit）；`POST /api/crystallize/{targets,draft,commit}`；起草 run（`skill-draft` subject，复用执行管道，绝不自动审）；Chat 标题栏「沉淀成 skill」+ Tasks「优化 skill」（有反馈或审核过才可用）+ 三态面板（目标→起草→审阅→入库，撞 slug 409 切更新）+ 技能列表分组/遮蔽标注。**真机验证**：codex runtime 走 two-api 的 `/responses` 流式仍 502（另一条线的已知问题），起草 run 会因此失败——**非本功能缺陷**；happy path 由 `crystallize-e2e.test.ts`（假后端 + 真 git）全链钉住 | `./design/skill-crystallization.md`；`./srs/requirements.md` §16 的 **D80** |

> ⚠️ **提交与分发**：本文件早前写着"这台开发机连不上 github.com"——**2026-10 复核时它通了**
> （`git ls-remote origin HEAD` 成功返回 `2954eff`）。所以推送**可能**做得了（本地 `main`
> 当时领先 `origin/main` **6 个提交**，未推）。网络会变，推送失败时就走自包含 bundle：
> `git bundle create .cache/agentdeck-all.bundle --all`（`.cache/` 已 gitignore），
> 另一边 `git clone <bundle> agentdeck`。改完记得**重新生成**。

---

## 约定与硬约束（改代码前值得先知道）

1. **测试里绝不调用真实 CLI**（NFR-T-01）。会消耗真实额度、还可能让 agent 改文件。
   注入一个假的 `AgentBackend`（`DaemonOptions.backend`），GitHub 相关的注入 `fetchImpl`。
2. **测试的临时目录建在仓库内**（`.cache/test-tmp`），不用系统 tmp——受限沙箱里后者可能不可写。
   还有一条自动检查：测试文件里**不许出现 `tmpdir()`**，也不许对危险目录做递归删除
   （这条规矩来自一次真实事故）。
3. **注释与测试名写"为什么"**，用中文，包括踩过的坑：哪一版错了、错在哪、怎么发现的。
   这是这个仓库最主要的防复发手段——**只写结论的注释留不住教训**。
4. **`erasableSyntaxOnly: true`**：不能用 TS 的 `enum` / `namespace` / 构造函数参数属性
   （`constructor(readonly x: string)` 这类需要 tsc 生成代码的写法被禁）。
5. **界面的验证方式**：`tsc` 看不见 `.svelte` 模板，所以界面改动要过 `svelte-check`
   （`pnpm run check` 里已包含），改布局再跑 `pnpm run probe:layout`。
6. **不要留死接口**：这个仓库最常见的缺陷是"字段 / 接口 / 界面都在，就是没有代码路径让它发生"。
   留下一处死接口，早晚会有人以为它生效了。
7. **交给 CLI 的只有「第一句话」**（D29；**2026-09 起它由三块组装**：① 框架（模版）/ ② 身份（「指令」）/ ③ 任务——投递分 A/B 两档，档位记在 `Run.deliveryMode` 上；**2026-10 起三块各有一个模版框**：② 用 `{{identity}}`、③ 用 `{{task}}` 摆放，默认框 = 平台默认逐字不变）：它由 `packages/agent-core/src/first-sentence.ts`
   组装（身份 → 角色 → 材料 → 技能清单 → 护栏 → 判决契约放最末），**整块进 run 日志**（A 档下两块分别记录）。
   ~~同一份文本另存一份副本 `<workdir>/.agentdeck/context/<runId>.md`~~ —— **已撤（2026-09）**：
   执行/审核都不再写副本文件（"回看它被交代了什么"看日志；它从来**不是**第二个投递通道）。再想往里面加东西，就加在那一个函数里——不要另开通道，
   也不要写 CLI 认识的项目记忆文件名。
8. **加一个 runtime 要做三件事**（D31）：描述表加一行（`packages/agent-core/src/runtime-table.ts`）
   + 写一个适配器包 + 在 `apps/daemon/src/runtime-registry.ts` 的装配表加一行。
   描述表那行**必须自己写全**：先声明 `kind`——`cli`（claude、generic 那种命令行形态）必填
   `managedFlags`/`resume`，`service`（codex app-server 那种常驻服务 + JSON-RPC）必填 `baseArgs`，
   加载器按 kind 校验，缺了当场报错，**不会**替你猜 claude 的拼写；技能要么声明
   `{kind:'directory',dir}` 要么老实写 `{kind:'none',reason}`。
   造完请跑 `apps/daemon/src/runtime-agnostic.test.ts` 那条用例——它整条跑在非 claude 的 runtime 上，
   专门抓"还有东西写死了 claude"（审计、技能投递、界面选项、文件清单）。

---

## Web UI 技术栈

| 层 | 选型 | 为什么 |
|---|---|---|
| 框架 | **Svelte 5** | 编译成很小的原生 JS，**没有运行时框架要下载**——与"daemon 托管静态文件、断网可用"这条约束最合 |
| 构建 | **Vite 6** | 产物输出到 `apps/web/dist/`，daemon 只当它是普通静态文件，不知道 Svelte 的存在 |
| 依赖 | 5 个 devDependencies + **1 个运行时依赖**（`highlight.js`，按需动态 import） | 模版引擎在 agent-core 侧（`mustache`） |
| 样式 | 手写 CSS + **设计令牌层**（`apps/web/src/styles/app.css`）+ **亮/暗双主题** | 间距（4 的倍数）、字号层级、语义化颜色集中在一处；`:root` = 亮色板、`[data-theme='dark']` = 暗色板（`color-scheme` 跟随，原生控件不错位）；主题偏好存 `ah.theme-pref`（默认跟随系统，首帧前由 `index.html` 内联脚本定 `data-theme` 防闪）；扁平化：无阴影，描边/底色用 `color-mix` 随主题自适应 |
| 实时 | 原生 `EventSource`（SSE） | 按 seq 补齐，刷新 / 重连都不丢消息 |

**为什么不是 Next.js / React**：最初设计文档写的是 Next.js。但它需要 Node 运行时来渲染，
而这里的页面由 daemon 在 `127.0.0.1` 上托管、要能断网工作；一个纯静态产物更贴合。
UI 一直复杂到"需要组件化与路由"才换的——那次切换只动了 `apps/web/`，后端一行没改。

**开发模式**：`pnpm run dev:web` 起 Vite（5173）并把 `/api` 代理到 daemon 的 4517，
所以**浏览器看到的仍是同源**——开发与生产的同源假设一致，不会出现"开发能跑、上线 CORS 炸"。

> ⚠️ 构建产物**不进版本库**，而 `vite build` 会清空 `dist/`。所以两件事：
> clone 之后直接起 daemon 会没有界面（daemon 会明确提示你跑 `build:web`，而不是发一个空白页）；
> 往 `dist/` 里放临时文件的东西（比如布局探针）**每次构建都要重放一次**。

---

## 架构与不变量（要点 + 去哪看细节）

三句话概括这个系统的信任模型与硬约束；**细节不去这里找**，按最后一列读：

1. **浏览器是唯一的远端通道。** 页面由 daemon 托管 ⇒ **同源**，跨源那一整套（Origin 白名单、
   一次性令牌、私有网络预检）都不需要，只剩"只绑回环 + 校验 `Host`"两条。
   → `./design/design.md` §14.2。
2. **daemon 不向 agentdeck 的远端服务发起请求。** 远端只承担五件事（账号登录、用户设定、
   公共目录、第三方查询转发、统计接收）。**一处刻意例外**：从本地路径 / GitHub 安装 skill 时
   daemon 自己去下载（本地目录路径页面读不到）。这条路的边界**写死在
   `packages/skill-source/src/skill-source.ts`**：只允许 GitHub 的几个主机、只允许 https、**每一跳跳转都
   重新校验主机**，并限大小 / 文件数 / 超时。要扩到任意 URL 得单独做——让本地服务去抓任意
   地址，等于给它一个访问内网的跳板。 → `./design/design.md` §15.10。
3. **审核者 ≠ 执行者、动作只能由判决触发。** 这两条是硬不变量，**在写库之前强制校验**，
   不会被静默降级。⚠️ **别把「链路深度上限与环检测」并列进来**：深度上限只在
   「执行完自动串接审核」这一条路上生效，且超限的动作是**发通知 + 停止派生**（不是拒绝写入）；
   返工回路改由 `maxReworks` 限额管着（可为 `null` = 无限）；**环检测这一版没有生产调用点**。
   → 清单见 `./srs/requirements.md` §8，落到实现的映射见 `./design/architecture.md` §4.3
   与 `./design/architecture.md` §14（后者的「已知的边界与开口」表是查证这件事的地方）。

> 往使用者磁盘上写任何东西之前，先读根 README 的「安全边界」与 `./design/design.md` §14：
> **不做沙箱隔离（NG7）是明确的范围决定**，不是待办。

---

## 改界面之前要知道的三件事

1. **Markdown 渲染器是自己写的**（`apps/web/src/lib/markdown.ts`）。前端只有一条运行时依赖（`highlight.js`，按需 + 动态 import），
   为一个视图引 `marked` 就把这条约束破了。而它渲染的内容是 **agent 产出的文本**，
   页面又与 daemon **同源**，所以顺序是硬规则：**先摘出结构、再转义剩下的文字、最后拼
   我们自己的标签**。原始 HTML 一律不认、链接只允许 `http(s)`/`mailto`、图片地址必须经
   调用方映射。（第一版写成"先整段转义、再拼标签"，于是每一处插回去的东西都被二次转义——
   三个 bug 都是测试抓出来的，根因是同一个。）
2. **工作目录里的文件响应必须带 `Content-Security-Policy: sandbox allow-scripts`**。
   因为文件是 **agent 写的**、页面又由 daemon 托管 ⇒ 一个 agent 写出来的 `html`/`svg` 被打开时
   **默认**就拿到了这个源（能读所有 run 日志、能装 skill、能提交任务）。所以：
   - 允许脚本 ⇒ 产出里的画布页（p5 之类）能真的画出来；
   - **没有 `allow-same-origin`** ⇒ 文档落在**不透明源**里，`fetch('/api/…')` 变成跨源请求，
     而 daemon 不发 CORS 头 ⇒ 响应读不到，cookie / localStorage 也拿不到。

   ⚠️ **绝不要加 `allow-same-origin`**——加上它等于把上面那条断掉的路接回去。测试里专门钉着。
3. **布局类的缺陷类型检查看不见**："两栏有没有真的并排"、"窄屏返回按钮有没有出现"、
   `.main:has(> .split-layout)` 有没有生效——这些只有浏览器量得出来。
   改布局用 `tools/layout-probe/`（`pnpm run probe:layout`）。

---

## 参考材料（`ref/`）

放在仓库 `ref/` 目录下的上游行为分析材料。**属于参考输入，不是本项目文档。**

> ⚠️ 这些材料是对 Multica 行为的描述。Multica 采用自定义许可（禁止对外托管与商业嵌入），
> 因此本项目实现必须 **clean-room**，**不得复制其源码**。

| 文档 | 说明 | 对应 |
|---|---|---|
| `ref/multica-claude-code-customization.md` | Claude Code 注入层：一条 argv 里的六个注入点、所有权约束、参数仲裁顺序、上下文块回滚、失败分级 | `./srs/requirements.md` §9.13 |
| `ref/multica-25-backends-flattening.md` | 多个后端如何摊平成一条接口：协议族、差异旋钮、活性与超时 | FR-RUNTIME-06~08 |
| `ref/multica-agent-invocation-deep-dive.md` | agent 间调用链路：触发拓扑、@mention 协议语法、鉴权链、去重、父任务唤醒 | FR-RUN-02、§8.5 |

> ℹ️ 早前有一批 `research/` 调研报告（架构参考 / daemon 适配参考 / 部署参考 / 竞品定位），
> 目录后来移出了仓库——对应内容由上面 `ref/` 的材料与 `requirements.md` §2 的结论摘要承担。
> 本文件不再列它。

> ⚠️ **`ref/` 下还有一份 `ref/multica/`——上游的整份源码 checkout（约 88 MB）**，
> 就是上面那三份分析所描述的对象。它**不在 git 里**（`ref/` 已 gitignore，`git ls-files ref/` = 0，
> 现有的 `.cache/agentdeck-all.bundle` 里也没有它的对象），所以**不会被提交、也不会进 bundle**。
> 留在这里只为对照阅读；**clean-room 这条线不因为它在磁盘上而松动——不得从它复制任何源码**。

---

## 待产出

| 文档 | 说明 |
|---|---|
| `security.md` | 安全边界与风险披露（不做沙箱隔离，需独立成篇）—— 内容基础见 `./design/design.md` §14 |
| `deployment.md` | 部署与运维手册 |
| `cli.md` | CLI 与 daemon 使用手册 |
