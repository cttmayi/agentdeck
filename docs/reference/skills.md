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
> `packages/skill-source/src/skill-source.ts`（2026-10 起独立成包：daemon 装技能与
> 推荐清单的同步工具 `pnpm run sync-skills` 抓取时**共用同一份规则**）。文档与代码不一致时以代码为准，
> 然后回来改这份文档。

---

## 0. 一句话

**一个含 `SKILL.md` 的目录就是一个 skill。** 没有 `SKILL.md` 的目录**不是**——三种
来源都要过这一关，而且失败时要说清是"目录里没有 SKILL.md"，而不是"里面没有技能"
（那两句话指向的下一步完全不同）。

skill 是**给执行者干活时参考的资料/方法包**。它**不是**判断依据，也**不是**行动权限：

| 你可能以为它在这 | 其实在 | 为什么 |
|---|---|---|
| 判断依据（"按什么判"） | **审核者的「指令」**（`Agent.instructions`；老数据那份 `Agent.reviewStandard` 仍然会被一起投递，详情页里能一键并进「指令」） | 判断依据是审核者的能力，不是一份可以顺手挂上来的资料（D37）；2026-09 起它和身份写在同一栏里 |
| 行动权限（"判完允许动什么"） | `AgentGroup.allowedActions`——**在智能体组上**（2026-10；D40 收口时一度在审核者身上） | 同上；挂在 skill 上等于让一个资料包决定谁能改状态（D40 收口） |

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
| ② 装进来之后（库） | `~/.agentdeck/skills/<slug>/`（默认；`--skills-root` 可覆盖） | **真文件**：`SKILL.md` + 支持文件；索引在 `log/skill.jsonl`（只留元数据） |
| ③ 跑任务时（注入） | `<工作目录>/.claude/skills/<slug>/` | **真文件**：`SKILL.md` + 支持文件 |
| ④ 界面上 | `#/skills` | 列表里的一行 |

### ② 装进来之后：是文件（磁盘为准）

**2026-10 起，装一个 skill 会把内容写成真文件**，落在 `<skillsRoot>/<slug>/` 下，
默认在**家目录下一个可见的** `~/.agentdeck/skills`。**磁盘是权威**：改那里的
`SKILL.md` 就生效——下一次注入用的就是改后的内容，不用重装。

```
~/.agentdeck/skills/                    ← 技能内容的落点（--skills-root 可覆盖）
├── my-skill/
│   ├── SKILL.md                          ← 正文（权威）
│   └── references/…                      ← 支持文件
└── another-skill/…

~/.agentdeck/data/                      ← 数据目录（--data-dir 可覆盖）
├── workspaces.jsonl
└── workspaces/<wsId>/
    ├── log/skill.jsonl                   ← ★ 索引：只留 id/slug/来源/版本/时间（append-only）
    ├── log/skill.jsonl.snapshot          ← 压缩后的物化快照
    ├── log/tool.jsonl                    ← 工具包（见 tools.md）
    └── runs/<runId>/messages.jsonl       ← 执行消息流
```

- **正文与支持文件以磁盘为准**（`~/.agentdeck/skills/<slug>/`）。代价如实写在这里：
  **改文件不进 append-only 日志**（改文件不留历史）——这是刻意的取舍；
- 想确认"到底装了什么"，看的是 `~/.agentdeck/skills/`；索引（来源、版本）在 `log/skill.jsonl`；
- ⚠️ 索引是 **append-only** 的：改一条 = 追加一条新记录，读的时候取最后一条。
  所以**别手动编辑**它——要改内容直接改 `SKILL.md`，要改来源/版本通过界面或接口重装
  （同名要显式 `overwrite`）；
- 卸载 = 删索引记录 + 删 `<skillsRoot>/<slug>/` 目录。**还挂着它的智能体会让卸载被拒**，
  并把它们列出来：静默删掉一条还被引用的东西，症状会在很久以后才出现（而且看起来像技能
  坏了）。若挂它的是**没有内联标准的审核者**，提示会直接给出下一步：先把标准固化到审核者
  身上，再回来卸载；
- ⚠️ **没有例外**（2026-10）：从**本地技能目录**装进来的（`localdir:`，见 §6）也要落盘——
  它们装完之后就是一条普通技能，正文在 `~/.agentdeck/skills/<slug>/`，与其它来源完全一致。
  （改动前 `localdir:` 是唯一的例外、正文留在索引记录里；那条例外随"本地技能目录改成**显式
  安装**"撤掉了，见 D73。）
- ✅ **唯一的例外是"聊天沉淀"（`mine:`，设计未实现，见 D80）**：自己提炼的 skill 落
  **另一个根** `~/.agentdeck/skills-mine/<slug>/`（git 化 + 平台自动 commit），与安装根
  **物理分离**——安装的重装覆盖语义不能碰自己的沉淀资产；同 slug 冲突时提炼的优先
  （详见 `docs/design/skill-crystallization.md` §1.1）。

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
| **远端目录** | `source.kind = 'payload'`（页面取好交过来） | **原始 GitHub 来源**（`github:…`，见下） | 页面 → daemon 再校验 |
| **本地技能目录**（§6） | 装的时候走的也是**本机目录**那条路（`source.kind = 'path'` + 一个来源标记），只是由「从本地安装」页签**扫到后逐条装** | `localdir:<绝对路径>` | daemon 直接读盘 |

界面上「安装」面板（主区就地面板，2026-10 起不再是抽屉）里有**四个页签**：

1. **路径 / GitHub** = 前两条（输入框**自动判断**是路径还是链接：`/` 或 `~` 开头是路径，
   含 `://` 是链接）；
2. **从本地安装**（2026-10）= 第四条（扫别的 AI 工具的技能目录，逐条装，见 §6）；
3. **远端目录** = 第三条（推荐清单，见下）；
4. **本地清单**（2026-10）= 一份**仓库自带**的 JSON（`apps/daemon/catalog/skills.json`），
   每条写一个**安装方法**（GitHub 链接或本地路径）。界面把它**按类别分组、默认折叠**
   列出来（点类别标题展开那一组，再点某条右侧的按钮装），点一下就装。
   - 每条可带一个 `category`——它是**机器值**（英文 id，如 `software` / `docs`），
     界面按它分组；**显示名在词表里**（`skills.cat*`，D39：机器值一个字都不翻）。
     界面认得的 id 按固定顺序排；**认不出的**（清单比界面新、加了新类别）垫到最后并
     **原样显示那个 id**（不静默丢）。没写 `category` 的条目归入 `other`。
   - ⚠️ **合集类仓库（redis / vercel-labs / MiniMax / getsentry 之类）要指到具体子目录**：
     这类仓库根目录没有 `SKILL.md`（每个子目录才是一个技能），指到仓库根会装不上。

> ★ **「本地清单」不是新的来源**：它点的每一条都落进第 1 条那条路（daemon 现去取），
> `sourceRef` 也是 `github:…` / `path:…`。它的价值在于**不用远端服务、不用同步工具、
> 不用登录**——把一批安装方法固化成一份可点列表（`GET /api/skills/install-list`）。
> 清单可用 `--skills-catalog <路径>` 换一份（清单**本身**坏掉时接口明确报错，不给空表；
> 单条坏掉只进 `skipped` 并列出原因）。
> ⚠️ 它**不声明 slug**——slug 由取包规则算出（与真正装的时候逐字相同），清单声明的 slug
> 一旦与重算的不一致，界面会拿错 slug 去比"装没装过"，把已装的显示成「安装」。
> ⚠️ 经 url 安装会把那个仓库的**整棵树**拉下来（清单不带 `exclude` 修剪语义——那是推荐
> 清单才有的），只在限额内。它与推荐清单（`tools/skill-catalog-sync/recommended-skills.json`）
> 是**两份各自独立的文件**，不承诺同步。

> **远端目录里放的是「推荐清单」（D50，2026-10）**：来源由维护者核过（清单
> `tools/skill-catalog-sync/recommended-skills.json`），内容由**独立工具**
> `pnpm run sync-skills`（`tools/skill-catalog-sync/`）从上游抓下来、写进一个目录
> （默认远端数据目录下的 `catalog-skills/`）。⚠️ 抓取与远端服务**互不相干**：
> 工具只写目录、服务只读目录，中间没有代码依赖。**`sourceRef` 保留原始 GitHub 来源**（不是
> `remote:…`）——远端是中转，不是出处：库里这条记录仍然指回上游，装的时候
> **支持文件一起带走**（少了它们技能是坏的，而且坏得很安静）。
> 目录还可以是空的（还没同步过），界面有对应空态。
> **维护者视角**：远端的**管理页**（`http://127.0.0.1:4518/`，D51/D52）把这份目录列出来——
> 每条带来源、版本、文件数、**被清单排除的记录**与 SKILL.md 正文，还有"重新同步"按钮、
> **手动装一条**（填 GitHub 链接）与**卸载**（只对本地装的；同步来的要改清单）。
> 手动装的白在另一个目录（`<dataDir>/catalog-skills-local`），同步工具不碰它。

### ⚠️ 远端目录里**没有** skill

**这一条要说清楚，否则会一直找。** 远端服务的公共目录里 `skills` 是**恒空的**
（`apps/remote/src/server.ts` 的 `catalog.skills = []`，D38）：

- 那里曾经放过一份 `general-review`，那是**审核标准**——而标准属于 daemon 侧（内联在审核者
  身上）。放在远端目录里会重新制造一个已经去掉的混淆：让使用者以为"要审东西先得装一份
  skill"；
- 所以公共目录里**不放审核标准**——这是仍然成立的那一半；
- 但「远端目录」那个页签**不再是恒空**：它列的是**推荐清单**（D50）——维护者
  核过来源、由独立工具 `pnpm run sync-skills` 把内容抓下来放进那个目录。它也可能**是空的**（还没同步过），
  那时界面有一句空态（与"远端不可用""未登录"分开说）。

于是 skill 的来源**种类**还是三个：**本机目录 / GitHub 链接 / 推荐清单（远端目录）**。
界面上另外两个页签——「本地清单」与「从本地安装」——是**入口**而不是新的种类：它们点/装的
每一条都落进第一条路（本机目录）；「从本地安装」额外给装进来的记录带上一个
`localdir:<根目录>` 的来源标记（装完仍是普通技能，见 §6）。

### GitHub 那条路的规矩

不是通用 URL 下载器，**只放开三个主机**（`github.com`、`raw.githubusercontent.com`、
`api.github.com`）：

- 通用抓取 = 一个本地服务替别人访问任意地址（SSRF：内网、云元数据、本机其它端口）。做对它
  需要 IP 段判断、DNS 重绑定防护一整套东西，那是另一件事；
- 只允许 **https**；**每一跳跳转都重新校验主机**；限单文件/总量/文件数/超时；
- 私有仓库要 token 时读环境变量 `AGENTDECK_GITHUB_TOKEN`；
- **可选：GitHub 加速器**（2026-10，第三方，**默认不用**）。国内直连 GitHub 常失败，
  社区做法是走一个"加速器"：`pnpm run sync-skills --github-proxy`（**裸写即可，值可省略
  ⇒ `https://gh-proxy.com`**；也可以给别的地址，或 `--github-proxy off` 直连），
  daemon 那边是 `pnpm run daemon --github-proxy`（环境变量 `AGENTDECK_GITHUB_PROXY`
  只对同步工具有效）。三条硬规矩：
  ①**只代理 GitHub 自己那三个主机**（使用者填的其它地址照样被白名单挡在外面——加速器不会
  变成一个访问任意地址的跳板）；
  ②**走代理时不带我们的 token**（`githubRequestTarget` 一个判据管两处；代理自己带凭证，
  实测它给的额度是 5000 次/小时，本机那 60 次也就不适用了）；
  ③**默认关，只有你显式指定才启用**，开了会在启动/运行时**大声说**"内容正经过第三方 X"。
  ⚠️ 代价如实写在这里：**加速器能看、也能改**转发给我们的内容（它就是链路上的中间人）。
- **可选：清单可以声明 `include` / `exclude`**（相对技能目录的 glob，2026-10）。技能格式
  **没有"必须文件清单"**，而有些仓库（"整仓即技能"）把营销素材、README 图、测试产物和技能
  内容混在一棵树里——那就由维护者在清单里声明排除什么。三条规矩：**`SKILL.md` 不许被排除**、
  图案不许是绝对路径或含 `..`、被排除的东西**逐个列出来**（同步日志 + 装进来的记录 + 目录
  条目的 `excluded`，界面在装之前就显示"内容不完整：跳过了 N 项"）。排除**在下载之前**生效；
  改过图案就不复用旧内容。见 `tools/skill-catalog-sync/README.md` 里两个真仓的实测对照。
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
| 单个支持文件上限 | 256 KB | `packages/skill-source/src/skill-source.ts` |
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

## 6. 从本地安装（把别的 AI 工具那儿的 skill 装进来）

这一节解决的是：**你已经在 Claude Code / Codex / Cursor 里攒了一堆 skill，
不想再复制一份。** 答案不是"让 AgentDeck 一直盯着那几个目录"，而是**扫出来、逐条装**。

界面：技能页 →「安装」→ 页签「从本地安装」。它现扫那几个目录（**不持久化**"我关注哪几个
目录"这件事），把里面的技能列成一行行，每条一个「安装」按钮。装一条走的就是**本机目录**那条路
（§3），只是额外带一个 `localdir:<根目录>` 的来源标记。

★ 它和「本地清单」（§3）**是同一张表**：同样的列（技能 / 来源 / 说明 / 本地 / 操作）、
按来源分组（这边按**目录**、那边按**类别**）、点组标题折叠——两个页签是同一件事的两个来源
（2026-10 使用者要求统一，见 D74 的后续）。

**装完就是一条普通技能**：正文落到 `~/.agentdeck/skills/<slug>/`，与其它来源完全一致
（§2）。列表里它显示「来自本地技能目录：`<根目录>`」——那只是一条**来源标记**，不是
"跟着源目录走"。所以：

| 你可能以为 | 实际 |
|---|---|
| "在 `~/.claude/skills` 里改一句就生效" | ❌ 装完那份是**我们自己的副本**（`~/.agentdeck/skills/<slug>/`）。要改就改我们这份（磁盘为准），或回来**再装一次** |
| "在那边删了技能，这边也没了" | ❌ 库里那条照旧可用（它已经是一条独立技能） |
| "卸载后会被扫描带回来" | ❌ 卸载就是卸载。它现在是一条普通技能，不会被自动重扫回来 |

⚠️ **2026-10 之前这里是自动对账**（勾选目录 ⇒ 每次读列表把内容读进库）。那套撤掉了（D73）：
它带来一串特例（`localdir:` 的记录不落盘、`ReconcileReport`、"来源目录还勾着且文件还在"
才算可选……），而使用者要的只是"像装别的 skill 那样装一下"。

### 内置候选与规则

| 候选 | 路径 | 形状 |
|---|---|---|
| Claude Code | `~/.claude/skills` | 扁平：`<slug>/SKILL.md` |
| Codex | `~/.codex/skills` | **多一层**：实测是 `.system/<slug>/SKILL.md` |
| Cursor | `~/.cursor/skills` | 扁平 |
| AGENTS 约定目录 | `~/.agents/skills` | 扁平 |

候选表是内置的（`localSkillDirCandidates()`）；**不再持久化自定义目录**——要装任意路径的技能，
用「路径 / GitHub」页签（那条路本来就在）。

- 扫描深度 **2 层**（所以 Codex 的 `.system/` 那一层能认出来）、最多 **200 个** skill；
- 跳过 `.git`、`node_modules`、`.github`、`__pycache__`、`.venv`、`venv`；
- **符号链接不跟随**（与 `skill-source.ts` 同一条规矩：既可能指到技能目录外面，也可能成环）
  ——但**会如实报出来**（"跳过：`<名字>`（符号链接，未跟随）"）。静默跳过会让界面上的
  "里面 1 个" 与 Finder 里的 2 个对不上，而使用者只能去猜；
- 扫到却没有 `SKILL.md` 的目录、读不进来的技能，都进该目录的「跳过」列表并**带上原因**；
- 目录不存在 / 读不了：`error` 字段如实说（**不是**"里面没有技能"）；
- ⚠️ 列表里的「已安装」标记 = 库里有没有同 slug 的技能（现算，不缓存）。

---

## 7. 常见坑

| 现象 | 真正的原因 |
|---|---|
| "目录里明明有东西，界面说没有 skill" | 那个目录里没有 `SKILL.md`。**没有它就不是技能**（空目录、只有 README 的目录都算） |
| "它说找不到 SKILL.md，可我看着就是 `SKILL.md`" | 大小写。macOS 文件系统默认不分大小写，`skill.md` 能被碰巧读到——平台会明确点出"你那个是 `skill.md`，要求的是大写 `SKILL.md`" |
| "我删了源目录的文件，库里还在" | 正常。**所有**来源装进来时都会**把内容复制到 `~/.agentdeck/skills/<slug>/`**，源目录后来变了不影响库里（要改就改库里那份，或重装）。**没有例外**（`localdir:` 也一样，见 §6） |
| "从本地安装后，在源目录里改了它，注入的还是旧的" | 装完那份是**我们自己的副本**。改 `~/.agentdeck/skills/<slug>/`（磁盘为准），或回「从本地安装」页签**再装一次**（见 §6） |
| "注入时报『技能「X」的正文是空的，拒绝注入』" | 你手删了 `~/.agentdeck/skills/<slug>/`（或里面的 `SKILL.md`）。索引记录还在、内容没了——平台**拒绝**用一个空技能，而不是静默注入一个空的。重新安装这个技能即可 |
| "卸载按钮点不动 / 点了被拒" | 还有智能体挂着它。提示里会点名是谁；若挂着的是"判断依据还来自这条 skill"的审核者，先在它详情页按「把这份判断依据并进「指令」」 |
| "装 GitHub 的私有仓库失败" | 设 `AGENTDECK_GITHUB_TOKEN`；另外**只支持那三个 GitHub 主机**，别的域名会被拒 |
| "两个不同目录里有同名 skill" | 两个来源目录各留一条记录（slug 相同、`id` 不同、来源徽标不同）。智能体选择器里会标出「（来自 `<目录>`）」以便区分 |
| "刷新页面白屏" | 与 skill 无关：是静态资源缓存。`Cmd+Shift+R` |

---

## 8. 代码索引

| 想知道 | 去哪 |
|---|---|
| 实体与字段 | `packages/protocol/src/entities.ts`（`Skill`、`Agent.skillIds`、`Agent.reviewStandard`、`AgentGroup.allowedActions`） |
| 从路径 / GitHub 解析与限额 | `packages/skill-source/src/skill-source.ts` |
| 本地安装清单：读、校验、算 slug | `apps/daemon/src/skill-list.ts`（自带清单在 `apps/daemon/catalog/skills.json`） |
| 从本地安装：候选、扫描（**只读**，无对账） | `apps/daemon/src/local-skill-dirs.ts` |
| 注入（写文件、归属清单、冲突、清理） | `packages/agent-core/src/skill-injection.ts` |
| frontmatter 归一化 | 同上（`normalizeSkillFrontmatter`） |
| 工作目录怎么算出来的 | `apps/daemon/src/workdir.ts`（`defaultWorkRoot`、`resolveWorkDir`） |
| 接口 | `apps/daemon/src/server.ts`：`GET/POST /api/skills`、`POST /api/skills/install`、`DELETE /api/skills/:id`、`GET /api/skills/local-dirs`（只读发现）、`GET /api/skills/install-list` |
| 落在磁盘上的布局 | `packages/store-file/src/file-store.ts`（文件头有完整目录树） |
| 技能内容落盘 / 回读 / 删目录 | `packages/store-file/src/skill-files.ts`（`<skillsRoot>/<slug>/`）；`FileStore.open` 里的 `#migrateSkillsToDisk` 负责老记录一次性迁移 |
| 运行时怎么投递技能 | `packages/agent-core/src/runtime-table.ts`（每个 runtime 的 `skills` 字段） |
| 测试 | `packages/skill-source/src/skill-source.test.ts`、`packages/store-file/src/file-store.test.ts`（落盘/回读/卸载/迁移，含老 `localdir:` 记录迁移落盘）、`apps/daemon/src/skills-install.test.ts`（装进来的文件真落在 skillsRoot 下、磁盘为准、`path` 来源带 `sourceRef`）、`apps/daemon/src/local-skill-dirs.test.ts`（扫描）、`apps/daemon/src/skills-local-dirs-api.test.ts`（扫描 → 安装 → 落盘 → 挂给智能体）、`apps/daemon/src/skill-list.test.ts`、`apps/daemon/src/skills-install-list-api.test.ts`、`packages/agent-core/src/skill-injection.test.ts`（空正文守卫） |
