# Skill 参考手册：是什么、住在哪、怎么装

> **这份回答"东西在哪、怎么用"**：一个 skill 由什么构成、能从哪儿来、装进来之后
> 落在磁盘的哪里、跑任务时又被放到哪里、限额是多少、有哪些坑。
>
> **回答"为什么这么设计"的是** [`../design/design.md`](./../design/design.md)（§15.10 三种来源、
> §15.12 去留规则、§12.1 远端目录）与 [`../srs/requirements.md`](./../srs/requirements.md) 的
> **D37 / D38**。
>
> ⚠️ 判定"这是不是一个 skill""这个 skill 合不合规"的**唯一判据是代码**，不是这份
> 文档：`packages/protocol/src/entities.ts` 的 `Skill` 与
> `apps/daemon/src/skill-source.ts`。文档与代码不一致时以代码为准，然后回来改这份文档。

---

## 0. 一句话

**一个含 `SKILL.md` 的目录就是一个 skill。** 没有 `SKILL.md` 的目录**不是**——三种
来源都要过这一关，而且失败时要说清是"目录里没有 SKILL.md"，而不是"里面没有技能"
（那两句话指向的下一步完全不同）。

skill 是**给执行者干活时参考的资料/方法包**。它**不是**判断依据，也**不是**行动权限：

| 你可能以为它在这 | 其实在 | 为什么 |
|---|---|---|
| 判断依据（"按什么判"） | **审核者的「指令」**（`Agent.instructions`；老数据那份 `Agent.reviewStandard` 仍然会被一起投递，详情页里能一键并进「指令」） | 判断依据是审核者的能力，不是一份可以顺手挂上来的资料（D37）；2026-09 起它和身份写在同一栏里 |
| 行动权限（"判完允许动什么"） | `Agent.allowedActions`——也在审核者身上 | 同上；挂在 skill 上等于让一个资料包决定谁能改状态（D40 收口） |

所以：**skill 挂给执行者**（`Agent.skillIds`），**判断依据与权限配给审核者**。skill 对审核者
只是可选的参考/支持文件。

---

## 1. 一个 skill 由什么构成

```
my-skill/
  SKILL.md          ← 必须有。正文（可带 frontmatter），上限 256 KB
  references/…      ← 可选：支持文件（只收文本）
  scripts/…         ← 可选：支持文件（**不会被执行**，只是随包带的资料）
```

| 字段（`Skill` 实体） | 是什么 |
|---|---|
| `slug` | kebab-case，`^[a-z0-9][a-z0-9-]{0,62}$`。**同时是注入时的目录名**，所以它必须是文件系统安全的 |
| `name` | 给人看的名字（≤200） |
| `description` | 一句话用途（可空）。会被补进注入文件的 frontmatter `description`——CLI 的清单里它**是唯一的用途信号**，缺了技能基本不会被主动选用 |
| `body` | `SKILL.md` 正文 |
| `files` | 支持文件：相对路径 → 文本内容（可选） |
| `source` / `sourceRef` | 从哪儿来的（见 §4 的形状表） |
| `version` | 远端目录给的那个版本，没有就是 `null` |
| `verdictSchemaVersion` | **引用**平台内置的判决 schema 版本（`VERDICT_SCHEMA_VERSION`），不是自定义 schema——skill 不定义判决长什么样 |

**只收文本**：二进制（图片、字体、压缩包）在**安装时就被拒绝并列出**，而不是装进来再在
某个环节悄悄写坏。缺了支持文件的技能是坏的技能，所以宁可当场说清楚。

---

## 2. 它住在哪：四层，别混

这是最容易搞混的一节。同一个 skill 在四个不同的地方有四种不同的形态：

| 层 | 在哪 | 形态 |
|---|---|---|
| ① 作者那里（源头） | 你机器上的某个目录 / GitHub 仓库 | 一个含 `SKILL.md` 的**目录** |
| ② 装进来之后（库） | `~/.agentdeck/data/workspaces/<wsId>/log/skill.jsonl` | **一条记录**（正文与支持文件都在记录里，**不是文件**） |
| ③ 跑任务时（注入） | `<工作目录>/.claude/skills/<slug>/` | **真文件**：`SKILL.md` + 支持文件 |
| ④ 界面上 | `#/skills` | 列表里的一行 |

### ② 装进来之后：是记录，不是文件

**这一条最反直觉，也最容易找错地方。** 装一个 skill **不会**在磁盘上留下那个目录的副本。
它变成 `log/skill.jsonl` 里的一条记录——正文、支持文件、来源、版本全在记录里。

```
~/.agentdeck/data/                     ← 数据目录（--data-dir 可覆盖）
├── workspaces.jsonl
└── workspaces/<wsId>/
    ├── log/skill.jsonl                   ← ★ skill 的权威记录在这里（append-only）
    ├── log/skill.jsonl.snapshot          ← 压缩后的物化快照
    ├── log/tool.jsonl                    ← 工具包（见 tools.md）
    └── runs/<runId>/messages.jsonl       ← 执行消息流
```

- 想确认"到底装了什么"，看的是这份 JSONL，**不是**任何 `skills/` 目录；
- ⚠️ 它是 **append-only** 的：改一条 = 追加一条新记录，读的时候取最后一条。
  所以**别手动编辑**它——要改就通过界面或接口重装（同名要显式 `overwrite`）；
- 卸载 = 删掉这条记录。**还挂着它的智能体会让卸载被拒**，并把它们列出来：静默删掉一条
  还被引用的东西，症状会在很久以后才出现（而且看起来像技能坏了）。若挂它的是**没有内联
  标准的审核者**，提示会直接给出下一步：先把标准固化到审核者身上，再回来卸载。

### ③ 跑任务时：注入到工作目录

执行 run 开始时，平台把 `Agent.skillIds` 指向的那几条 skill 写成真文件，放到 **CLI 原生
会扫的目录**里，让 CLI 自己去发现：

```
<工作目录>/.claude/skills/                ← 由 runtime 描述表决定（claude ⇒ 这个目录）
├── .agentdeck-managed.json            ← 归属清单：我们放过哪些 slug
├── my-skill/
│   ├── SKILL.md                          ← 已重建过 frontmatter（见 §6）
│   └── references/…                      ← 支持文件原样落盘
└── another-skill/…
```

- **工作目录**默认在 `~/agentdeck-workspace/<issue|report|run>-<id>/`（`--work-root` 可
  覆盖）。目录按**任务**（subject）分，不按 run 分——所以同一个任务的重试能看到上次留下的
  文件（D27）；
- **`.agentdeck-managed.json` 是归属清单**，不是配置：它记着我们放过哪些 slug。作用是
  两件——
  - **不再挂载的会被清掉**（只清清单里我们自己放的那些）；
  - **同名冲突会被拒绝而不是覆盖**：目标目录存在、但不在清单里 ⇒ 那是使用者的东西，
    抛 `SkillCollisionError`，不碰它；
- ⚠️ **只有支持"技能发现"的 runtime 才会收到文件。** `claude` 描述表声明
  `{ kind: 'directory', dir: '.claude/skills' }`；`generic` 声明
  `{ kind: 'none', reason: '未对照真实 CLI 验证过任何技能发现机制' }`——它**一个文件都不写**。
  往一个没人读的目录里写文件等于假装支持（FR-CLI-40）；
- **run 结束会按归属清单把本次注入的收掉**（工作目录只留产出——使用者的要求，D30）；下一次
  run 开始前按新的挂载集合重新注入并对账。

---

## 3. 能从哪儿来

| 来源 | 怎么给 | `sourceRef` | 谁去取内容 |
|---|---|---|---|
| **本机目录** | `source.kind = 'path'`，绝对路径（`~` 会展开） | `path:<绝对路径>` | daemon 直接读盘 |
| **GitHub 链接** | `source.kind = 'url'` | `github:<owner>/<repo>@<ref>:<dir>` | daemon 自己下载 |
| **远端目录** | `source.kind = 'payload'`（页面取好交过来） | `remote:<slug>@<版本>` | 页面 → daemon 再校验 |
| **本地技能目录**（§8） | 在「设置」里勾一个目录，**不是逐条装** | `localdir:<绝对路径>` | daemon 扫描 + 对账 |

界面上「安装」抽屉里那两个页签 = 前两条（输入框**自动判断**是路径还是链接：`/` 或 `~` 开头
是路径，含 `://` 是链接）+ 远端目录。

### ⚠️ 远端目录里**没有** skill

**这一条要说清楚，否则会一直找。** 远端服务的公共目录里 `skills` 是**恒空的**
（`apps/remote/src/server.ts` 的 `catalog.skills = []`，D38）：

- 那里曾经放过一份 `general-review`，那是**审核标准**——而标准属于 daemon 侧（内联在审核者
  身上）。放在远端目录里会重新制造一个已经去掉的混淆：让使用者以为"要审东西先得装一份
  skill"；
- 所以「远端目录」那个页签**永远是空态**，而这是**一句真话**，不是没做完；
- 远端目录里**只有工具包**（见 [`tools.md`](tools.md) §4）。

于是 skill 的实际来源是：**本机目录 / GitHub 链接 / 本地技能目录**。

### GitHub 那条路的规矩

不是通用 URL 下载器，**只放开三个主机**（`github.com`、`raw.githubusercontent.com`、
`api.github.com`）：

- 通用抓取 = 一个本地服务替别人访问任意地址（SSRF：内网、云元数据、本机其它端口）。做对它
  需要 IP 段判断、DNS 重绑定防护一整套东西，那是另一件事；
- 只允许 **https**；**每一跳跳转都重新校验主机**；限单文件/总量/文件数/超时；
- 私有仓库要 token 时读环境变量 `AGENTDECK_GITHUB_TOKEN`；
- 支持的链接形状（都在 `skill-source.ts` 里解析）：

```
https://github.com/{o}/{r}                                    （仓库根）
https://github.com/{o}/{r}/tree/{ref}/{dir}                    （目录，最常用）
https://github.com/{o}/{r}/blob/{ref}/{dir}/SKILL.md           （文件）
https://raw.githubusercontent.com/{o}/{r}/{ref}/{dir}/SKILL.md （Raw 按钮）
```

⚠️ 这条路是"daemon 不发对外请求"（D19/D20）的**刻意例外**，理由有两条：本地目录路径只有
daemon 读得到（页面读不了磁盘），而"下载到本地"本来就发生在 daemon 这台机器上。例外被严格
限制在 `skill-source.ts` 一个文件里，**不涉及 agentdeck 的远端服务**。

---

## 4. 限额与硬规则

| 规则 | 值 | 出处 |
|---|---|---|
| `SKILL.md` 上限 | **256 KB** | `packages/agent-core/src/skill-injection.ts` 的 `MAX_SKILL_BYTES` |
| 单个支持文件上限 | 256 KB | `apps/daemon/src/skill-source.ts` |
| 所有文件加起来 | 8 MB（2026-10 从 1 MB 提上来） | 同上 |
| 文件数（含 SKILL.md） | 512（2026-10 从 64 提上来） | 同上 |
| 目录递归深度 | 4 | 同上 |
| 单次 HTTP 超时 | 15 s | 同上 |
| 递归时跳过的目录 | `.git`、`node_modules`、`.github` | 同上 |
| slug | `^[a-z0-9][a-z0-9-]{0,62}$` | `packages/protocol/src/entities.ts` |

⚠️ **文件数与总字节 2026-10 各提了一档**：真实技能仓库是**完整仓库**（实测
fireworks-tech-graph：234 个文本文件、2.4 MB 文本），旧上限（64 个 / 1 MB）把它挡在
门外，而界面当时只说"读不进来"不说原因。两档仍是硬护栏，只是不再误伤完整仓库；
「读不进来」那行现在**带原因**（`路径（文件太多：…）`），不用猜。

⚠️ **`SKILL.md` 的上限只有一处定义**（agent-core 的 `MAX_SKILL_BYTES`），安装侧复用它而不是
另写一个数。安装时按一个数收下、注入时按另一个数拒绝，就会出现"装得上但跑任务时炸"的技能
——而那种失败发生在很久以后、离原因很远。

---

## 5. 装进来时，frontmatter 会被怎么处理

注入前 `normalizeSkillFrontmatter()` 会把 `SKILL.md` 过一遍，**重建 frontmatter 时保留其他
键**（FR-CLI-21）。规则：

| 情况 | 处理 | 记一条说明 |
|---|---|---|
| 完全没有 frontmatter | 注入最小的 `{ name: <slug>, description? }` | ✅ |
| frontmatter 解析不了（YAML 坏） | 重建（只保留正文） | ✅ |
| frontmatter 不是键值对象 | 重建 | ✅ |
| 缺 `description` 而平台登记了用途 | 补上平台那句 | ✅ |
| 两边都没有 `description` | 不动 | ❌ **刻意不记**——那是技能作者的问题，不是这次运行的异常。日志里的信号要稀缺 |
| 缺 `name` | 注入 slug | ✅ |
| 作者填的 `name` 与 slug 不一致 | **按 slug 改写** | ✅ |

两条值得记住的：

- **`name` 以 slug 为权威名**：同名不同源的技能必须可区分，而只有 slug 有唯一性保证；
- **作者写了 `description` 就不动**——那是他的表达。

---

## 6. 本地技能目录（「设置」里勾选的那几个）

这一节是 `localSkillDirs` 那套东西（界面：Skills 页 →「设置」）。它解决的是另一个问题：
**你已经在 Claude Code / Codex / Cursor 里攒了一堆 skill，不想再复制一份。**

### 勾选的含义

**勾选只表示"可以被选择的时候能看见"。** 取消勾选**不会**抽走已经被智能体用着的 skill。

| 磁盘上 | 勾选状态 | 有智能体挂着吗 | 库里 | 列表上 |
|---|---|---|---|---|
| 有 | 勾了 | — | 有记录 | 正常一行，带「来自 `<目录>`」徽标 |
| 有 | 没勾 | 没有 | 没有记录 | 不出现 |
| 有 | 没勾 | **有** | 记录**留着** | 出现，带一行警告「来源目录已取消勾选或文件已移走，但还有智能体在用：`<谁>`」，**不给卸载按钮** |
| 没了（你删了文件） | 勾了 | 没有 | 记录删掉 | 不出现 |
| 没了 | — | **有** | 记录**留着** | 同上那行警告（文件已移走那一半） |
| 没了 | 没勾 | 没有 | 记录删掉 | 不出现 |

⚠️ 为什么"还有人在用"就留着：那条记录正被 `Agent.skillIds` 指着，抽走它等于让某个智能体的
技能凭空消失。而"不给卸载按钮"是因为**删了会被下一次扫描带回来**——按下去只会闪一下又回来，
那比没有按钮更糟。要真的不要它，去源目录里删。

### 内置候选与规则

| 候选 | 路径 | 形状 |
|---|---|---|
| Claude Code | `~/.claude/skills` | 扁平：`<slug>/SKILL.md` |
| Codex | `~/.codex/skills` | **多一层**：实测是 `.system/<slug>/SKILL.md` |
| Cursor | `~/.cursor/skills` | 扁平 |
| AGENTS 约定目录 | `~/.agents/skills` | 扁平 |

也可以自己填任意绝对路径（不在候选表里的会单列出来，能取消）。

- 扫描深度 **2 层**（所以 Codex 的 `.system/` 那一层能认出来）、最多 **200 个** skill；
- 跳过 `.git`、`node_modules`、`.github`、`__pycache__`、`.venv`、`venv`；
- **符号链接不跟随**（与 `skill-source.ts` 同一条规矩：既可能指到技能目录外面，也可能成环）
  ——但**会如实报出来**："跳过：`<名字>`（符号链接，未跟随）"。静默跳过会让界面上的
  "里面 1 个" 与 Finder 里的 2 个对不上，而使用者只能去猜；
- 勾选后**每次读列表都对账一遍**（磁盘为准，没有"导入"这一步）：你在源目录里改一句、加一个
  支持文件、删一个 skill，界面跟着变。对账**内容没变就不写库**——那是 append-only 的日志，
  不能每次刷新都追加一条；
- ⚠️ 对账只在**读列表/读设置**时发生（也就是页面开着的时候）。纯 CLI / MCP 用法不会自动同步。

---

## 7. 常见坑

| 现象 | 真正的原因 |
|---|---|
| "目录里明明有东西，界面说没有 skill" | 那个目录里没有 `SKILL.md`。**没有它就不是技能**（空目录、只有 README 的目录都算） |
| "它说找不到 SKILL.md，可我看着就是 `SKILL.md`" | 大小写。macOS 文件系统默认不分大小写，`skill.md` 能被碰巧读到——平台会明确点出"你那个是 `skill.md`，要求的是大写 `SKILL.md`" |
| "我删了源目录的文件，库里还在" | 看你走的是哪条路。**逐条装的**（path/GitHub/payload）是**快照**，源目录后来变了不影响库里；只有**本地技能目录**那条路是"磁盘为准" |
| "卸载按钮点不动 / 点了被拒" | 还有智能体挂着它。提示里会点名是谁；若挂着的是"判断依据还来自这条 skill"的审核者，先在它详情页按「把这份判断依据并进「指令」」 |
| "装 GitHub 的私有仓库失败" | 设 `AGENTDECK_GITHUB_TOKEN`；另外**只支持那三个 GitHub 主机**，别的域名会被拒 |
| "两个不同目录里有同名 skill" | 两个来源目录各留一条记录（slug 相同、`id` 不同、来源徽标不同）。智能体选择器里会标出「（来自 `<目录>`）」以便区分 |
| "刷新页面白屏" | 与 skill 无关：是静态资源缓存。`Cmd+Shift+R` |

---

## 8. 代码索引

| 想知道 | 去哪 |
|---|---|
| 实体与字段 | `packages/protocol/src/entities.ts`（`Skill`、`Agent.skillIds`、`Agent.reviewStandard`、`Agent.allowedActions`） |
| 从路径 / GitHub 解析与限额 | `apps/daemon/src/skill-source.ts` |
| 本地技能目录：候选、扫描、对账 | `apps/daemon/src/local-skill-dirs.ts` |
| 注入（写文件、归属清单、冲突、清理） | `packages/agent-core/src/skill-injection.ts` |
| frontmatter 归一化 | 同上（`normalizeSkillFrontmatter`） |
| 工作目录怎么算出来的 | `apps/daemon/src/workdir.ts`（`defaultWorkRoot`、`resolveWorkDir`） |
| 接口 | `apps/daemon/src/server.ts`：`GET/POST /api/skills`、`POST /api/skills/install`、`DELETE /api/skills/:id`、`GET/PUT /api/skills/local-dirs` |
| 落在磁盘上的布局 | `packages/store-file/src/file-store.ts`（文件头有完整目录树） |
| 运行时怎么投递技能 | `packages/agent-core/src/runtime-table.ts`（每个 runtime 的 `skills` 字段） |
| 测试 | `apps/daemon/src/skill-source.test.ts`、`apps/daemon/src/local-skill-dirs.test.ts`、`apps/daemon/src/skills-local-dirs-api.test.ts`、`packages/agent-core/src/skill-injection.test.ts` |
