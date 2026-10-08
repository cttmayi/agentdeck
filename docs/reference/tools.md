# 工具包参考手册：是什么、怎么开发、住在哪

> **这份回答"怎么做一个工具、东西在哪、它怎么被跑起来"**：包的结构、清单逐字段、
> 脚本与平台的约定、远端目录的放置位置、装进来与执行时的落点、动作被触发的链路。
>
> **回答"为什么这么设计"的是** [`../design/design.md`](./../design/design.md)（§9 动作与审计、
> §12.1 远端目录、§15.26 清单 schema 的解说）与 [`../srs/requirements.md`](./../srs/requirements.md)
> 的 **D40 / D41 / D43**。
>
> ⚠️ 判定"这是不是一个适配本平台的工具"的**唯一判据是代码**，不是这份文档：
> `packages/protocol/src/tools.ts` 的 `ToolManifest`。装进来的包要么整份通过它，
> 要么带着一条具体的错被拒——文档只是解说。

---

## 0. 一句话

**一个工具包 = 一个目录 = 一个组**：一份 `tool.json` 清单 + 一个或多个入口脚本，
组内声明**多个动作**。判决通过后要做的动作**全部**由它执行。

**平台自己不带任何动作**（D41）。动作在判决里写成 `<包 slug>.<动作名>`，
没装那个包、或没在审核者的「行动权限」里勾上，判决引用它就会**整条判为不合规**。

```
一个包 = 一组动作，装一次一起进来，授权也是按动作给
判决 → 动作 → 脚本 → 结果
```

---

## 1. 一个包长什么样

```
my-tool/
  tool.json              ← ★ 机器读的清单（平台按它判断"这是不是一个工具"）
  TOOL.md                ← 人读的说明（可选；装进来会在界面上显示）
  scripts/main.mjs       ← 入口（清单里的 entry）
  scripts/other.mjs      ← 某个动作自己的入口（动作级 entry，可选）
  lib/…                  ← 其他支持文件（只收文本）
```

**两个文件各干一件事**：`tool.json` 是机器读的清单，`TOOL.md` 是人读的正文。

> 为什么不用 `TOOL.md` 的 frontmatter 装清单（skill 是那么干的）：
> skill 的 frontmatter **从来没有被结构化解析过**，而工具清单里有 `actions[]` 这种嵌套
> 数组——手写一个 YAML 子集解析器正是"格式没被完整定义、半年后在某个缩进上炸掉"的经典
> 来源。JSON + zod 直接可校验，且全仓库都是 zod，不引入第二个契约来源。

**照抄起步**：仓库里有两处可以整目录复制——

| 范例 | 位置 | 演示什么 |
|---|---|---|
| `example-note` | `examples/tools/example-note/` | **最小可用形**：一个组、两个动作、两个入口文件、`reversible: false` 的动作长什么样、`from: literal` 的绑定参数 |
| `hello-tool` | `apps/remote/catalog/tools/hello-tool/` | 远端目录里最简的一条（一个动作） |
| `example-notify` / `example-llm` / `example-issue` | `apps/remote/catalog/tools/` | **参数演示**：覆盖 string / integer / boolean / enum 全部四种开放参数，以及 `workdir` / `workspace.id` / `subject.runId` 三种绑定来源 |

> 五种绑定来源里，范例覆盖了四种（`literal` 在 `example-note` 里），**`subject.issueId` 没有范例**
> ——它只在"受审对象是 issue"时有值，其余的 run 用它会直接失败（并说清缺什么）。

---

## 2. 清单（`tool.json`）逐字段

```json
{
  "schema": "agentdeck/tool@1",
  "slug": "example-note",
  "name": "示例工具（往工作目录写一条记录）",
  "version": "1.0.0",
  "description": "示范包：一个组、两个动作、一个支持文件。",
  "runtime": "node",
  "entry": "scripts/note.mjs",
  "actions": [ /* 见下 */ ]
}
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `schema` | ✅ | **必须**是 `agentdeck/tool@1`。不认识这个值 ⇒ **明确拒绝**，不做"尽力而为" |
| `slug` | ✅ | kebab-case `^[a-z0-9][a-z0-9-]{0,62}$`。它**同时是组的名字与动作的命名空间** |
| `name` | ✅ | 给人看的名字（1–200） |
| `version` | — | `x.y.z` 或 `null`（缺省 `null`）。远端目录靠它判断「已安装 / 有新版」 |
| `description` | — | 一句话（≤2000） |
| `runtime` | ✅ | **闭合枚举**：`node` / `shell` / `python3`。不在其中一律拒——**不给"你自己填个命令"的自由** |
| `entry` | ✅ | 包级默认入口，相对包根。**不许**绝对路径、不许含 `..` |
| `actions` | ✅ | 1–50 条，见下 |

### 一个动作

```json
{
  "name": "append-note",
  "summary": "把一句话追加到工作目录的 NOTES.md",
  "entry": "scripts/note.mjs",
  "reversible": true,
  "dryRun": "supported",
  "timeoutMs": 10000,
  "params": {
    "bound": { "dir": { "from": "workdir" } },
    "open": { "text": { "type": "string", "max": 2000 } }
  }
}
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `name` | ✅ | kebab-case，**组内唯一**。完整动作名是 `<包 slug>.<name>` |
| `summary` | ✅ | 一行说明（1–200），会写进判决契约与界面 |
| `entry` | — | 该动作自己的入口；不给就用包级 `entry` |
| `reversible` | ✅ | **必须显式写**。不可回滚的动作在界面上会被标出来 |
| `dryRun` | ✅ | `supported` / `unsupported`。**`unsupported` 的动作默认没有自动执行资格**（见 §6） |
| `timeoutMs` | — | 1000–600000，缺省 **60000**。超时会**整组杀掉**那个进程 |
| `params` | — | `bound` / `open` 二分，见下 |

### 参数：`bound` 与 `open`（这是整个清单里最重要的一个设计）

**`bound`（绑定）= 平台按事实填，模型看不见也填不了：**

| `from` | 值是什么 |
|---|---|
| `literal` | 清单里写死的 `value`（必填） |
| `subject.issueId` | 当前受审对象的 issue id |
| `subject.runId` | 当前这条 run 的 id |
| `workspace.id` | 工作区 id |
| `workdir` | 这次 run 的工作目录（绝对路径） |

**`open`（开放）= 模型在判决时填的那部分，每一项都必须有界：**

| `type` | 必填字段 | 说明 |
|---|---|---|
| `string` | `max`（缺省 1000，≤20000） | **没有无界字符串**——不限长的字符串就是一个入口 |
| `integer` | `min`、`max` | |
| `boolean` | — | |
| `enum` | `values`（1–50 项，每项 ≤200） | 值域由作者钉死，拼错一个字母不会变成"另一个动作" |

每个开放参数还可以写 `required`（缺省 `true`）。

⚠️ 两条不能违反的：

- **同一个参数名不能既在 `bound` 又在 `open` 里**——否则"模型碰不到它"这条就被悄悄绕过了；
- **绑定的值不进模型可见的契约**。为什么不是"允许模型填、平台再覆盖"：覆盖式语义下模型仍
  以为自己在控制这个字段（下次它会尝试控制别的），而且它填错时你永远看不到这个信号，
  审计里还会出现两套值。把它从契约里删掉，"误操作到别的 issue"就**从结构上不可能**。

---

## 3. 怎么开发一个工具（照着抄）

```bash
# ① 复制范例
cp -r examples/tools/example-note ~/dev/my-tool
cd ~/dev/my-tool

# ② 改 tool.json：slug / name / description / runtime / entry / actions
#    ⚠️ slug 改了，动作名跟着变（<slug>.<动作名>），判决里也要跟着改

# ③ 写脚本：读 stdin 的 JSON，写 stdout 的 JSON（约定见 §4）

# ④ 装进来（本机目录这条路）
curl -s -X POST http://127.0.0.1:4517/api/tools \
  -H 'content-type: application/json' \
  -d '{"source":"path","path":"'"$HOME"'/dev/my-tool"}'
# 界面上：工具页 →「安装」→「本机目录」页签，填同一个路径

# ⑤ 让它能被触发：智能体页 → 点开那个**审核者** →「行动权限」里勾上它的动作
#    （审核者只判断不动手；动作权限配在审核者身上）

# ⑥ 试：新建任务时第三步可以只勾这一次要用的动作，还能钉固定参数
```

迭代时：改完脚本**重新装一遍**（同名要带 `overwrite`）。⚠️ 库里存的是**快照**——
改磁盘上的文件不会自动生效。界面上「工具」页在远端有更新版本时会给出「更新到 x.y.z」，
它走的就是"带 `overwrite` 再装一遍"这一条路。

**几条开发期就该知道的：**

- **先实现 `dry-run`。** 声明 `dryRun: "unsupported"` 的动作默认**不会被自动执行**
  （见 §6），而那通常不是你要的；
- **脚本只能改工作目录里的东西。** 平台**没有**给工具脚本任何 API——它不会替你写评论、
  改 issue 状态、发通知。想让这类能力回来，要么设计一条**受控的**本地接口，要么把这类动作
  做成随平台发布的标准工具包，而不是把内置动作加回 daemon（D41）；
- **失败必须说话**：`{ ok: false, detail: "为什么没做成" }`。平台会把 `detail` 放进动作记录、
  审计与失败通知里——写"为什么"，不要写"失败了"。

---

## 4. 脚本与平台的约定（就三条）

**① stdin 收一份 JSON：**

```json
{
  "action": "my-tool.append-note",
  "params": { "dir": "/Users/me/agentdeck-workspace/issue-01J…", "text": "你好" },
  "dryRun": false,
  "context": { "workdir": "/Users/…/issue-01J…", "runId": "01J…", "workspaceId": "01J…" }
}
```

`params` 里**已经合并好**了 bound 与 open——脚本**不需要**（也拿不到）区分它们，
边界是平台的事。它不该去猜"哪个值是模型给的"：绑定值的存在意义正是让模型碰不到它。

**② stdout 出一份 JSON：**

```json
{ "ok": true,  "detail": "已往 /…/NOTES.md 追加一行" }
{ "ok": false, "detail": "text 是空的，没什么可写" }
```

- **退出码非 0 也算失败**（脚本崩了、或者你没写 stdout）——两种情况都记成 `failed` 并通知。
  **静默失败是不允许的**；
- stdout 必须是**一个 JSON 对象**（是数组、是别的东西都会带着原文报错）。

**③ `dryRun: true` 时只许描述、不许改。** 输出里说清"我打算改什么"。做不到就老实写
`"dryRun": "unsupported"`，平台不会让它自动执行。

### 执行时的环境（这些不是细节，是安全边界）

| 项 | 是什么 |
|---|---|
| 解释器 | `node` ⇒ **正在跑 daemon 的那个 node**（`process.execPath`，不查 PATH）；`shell` ⇒ PATH 里的 `bash`；`python3` ⇒ PATH 里的 `python3`。找不到就明确失败并说清怎么装 |
| 命令行 | 入口作为**单个参数**交给解释器：不拼命令行、不经过 shell ⇒ 清单里的字符串永远不会被当成命令解释 |
| cwd | 那条 run 的**工作目录**（没有工作目录时退到本次执行的临时 `work/`，并在结果里说明） |
| 环境变量 | **白名单**：`PATH`、`LANG`、`LC_ALL`、`LC_CTYPE`、`TZ`、`TERM`（Windows 另加 `SYSTEMROOT`/`WINDIR`/`PATHEXT`/`COMSPEC`）。**不是** daemon 的 `process.env` |
| `HOME` | 指向本次执行的临时目录。不给它一个自己的家，第三方脚本就能在你的家目录里落下任何东西 |
| `TMPDIR` / `TEMP` / `TMP` | 同上，收进本次执行的目录，跑完一起清掉 |
| `PYTHONIOENCODING` | `python3` 时设成 `utf-8`（否则非 ASCII 的 JSON 会被写坏，表现为"stdout 不是合法 JSON"） |
| 超时 | 到 `timeoutMs` 就**终止整个进程组**（Unix 上新进程组 + 负 pid；Windows 上 `taskkill /T`）。只杀直接子进程会在你机器上留下孤儿 |
| 不重试 | 脚本失败就是失败。执行器不会偷偷重跑一遍——那会让审计里出现两次副作用、一次记录 |

### 跑的时候落在哪

包文件会被**物化**到本次执行专用的临时目录，跑完删掉：

```
<数据目录>/tool-tmp/tool-XXXXXX/          ← mkdtemp，每次执行一个（并发不撞车）
├── package/                              ← 包里的文件，保持相对结构（入口在这里）
├── home/                                 ← 脚本眼里的 $HOME
└── work/                                 ← 没有工作目录时的退路（脚本的 scratch）
```

⚠️ **不用系统临时目录**（`tmpdir()`）：它在受限环境（容器、沙箱、专用用户）里可能根本写不了，
而且它是**共享**的——同机别的进程能读到我们物化出去的包内容，也能在我们的目录里塞东西。
仓库里有一条机器检查（`tests/test-safety.test.ts`）专门守这件事。

---

## 5. 它住在哪：四层，别混

| 层 | 在哪 | 形态 |
|---|---|---|
| ① 作者那里 | 你机器上的某个目录 | 一个含 `tool.json` 的**目录** |
| ② 远端公共目录 | `apps/remote/catalog/tools/`（见 §5.2） | 一个含 `tool.json` 的**目录** |
| ③ 装进来之后 | `~/.agentdeck/data/workspaces/<wsId>/log/tool.jsonl` | **一条记录**（清单 + 文件正文 + `TOOL.md` 都在记录里，**不是文件**） |
| ④ 跑的时候 | `<数据目录>/tool-tmp/tool-XXXXXX/package/` | **真文件**（临时，跑完删） |

### 5.1 装进来之后：是记录，不是文件

和 skill 同一条规矩：装一个包**不会**在磁盘上留下那个目录的副本。

```
~/.agentdeck/data/                     ← 数据目录（--data-dir 可覆盖）
└── workspaces/<wsId>/
    ├── log/tool.jsonl                    ← ★ 工具包的权威记录在这里（append-only）
    └── log/skill.jsonl                   ← skill（见 skills.md）
```

记录里存的是：解析通过的 `manifest`（zod 校验过的原件）、`files`（相对路径 → 文本内容）、
`docs`（`TOOL.md` 正文）、`source`（`local` / `remote`）与 `sourceRef`。

| `sourceRef` 形状 | 从哪来 | 界面上的说法 |
|---|---|---|
| `path:<绝对路径>` | 本机目录 | 本机目录：… |
| `remote:<slug>@<版本>` | 远端公共目录（页面取好交过来） | 远端目录：… |

装的两条来源（`POST /api/tools`）：

| `source` | 字段 | 谁去取内容 |
|---|---|---|
| `path` | `path`（绝对路径，`~` 会展开）、可选 `slug` | daemon 直接读盘 |
| `payload` | `slug`、`manifest`、`files`、`docs`、`sourceRef`、`version` | **页面**从远端目录取好送过来；daemon **再校验一遍** |

- 两条路都会**再校验一遍清单**：远端说 A、daemon 按 B 解析，症状是"装进来的包少了一个动作"
  ——没有报错、没有堆栈，只有一处功能静静地不工作；
- 给了 `slug` 就必须与清单里的 `slug` 一致（否则判决里该写哪个名字没有答案）；
- **同名一律拒绝写入**，除非显式带 `overwrite: true`（界面上那个勾选框；它也是「更新」唯一
  走的那条路）。

### 5.2 远端公共目录的放置位置

**放一个包 = 在 `apps/remote/catalog/tools/` 下面放一个含 `tool.json` 的目录。**

```
apps/remote/catalog/tools/
├── hello-tool/tool.json + TOOL.md + scripts/
├── example-notify/…
├── example-llm/…
└── example-issue/…
```

- **以 `tool.json` 为准，不要求固定深度**（`<root>/<任意层级>/<包目录>/tool.json`，最多 4 层，
  点开头的目录跳过）。所以可以按用途分文件夹：`tools/notify/example-notify/…` 照样能列出来；
- 一个包目录里**不再往下找**：嵌套的 `tool.json` 只会是包自己的东西；
- 远端**只列内容、不经手安装**：装会在使用者机器上落盘并让那些脚本真的被执行，所以判据
  （清单 schema、限额、入口文件必须在包里）全部在 daemon 侧再走一遍；
- 远端自己的限额（比 daemon 侧更小，因为要经网络传下去）：单文件 **128 KB**、一个包所有文件
  加起来 **512 KB**、文件数 **32**、**只收文本**（二进制在这里就被拒并记下来）；
- 坏清单 / 二进制 / 超限的东西**不会静默消失**：它们进 `skipped` 并带原因
  （`GET /api/catalog` 的响应里有）。

远端目录由**页面**去取（`GET /api/catalog`），再把选中的包以 `source: payload` 交给本机
daemon——daemon 不主动访问 agentdeck 的远端服务。

### 5.3 卸载

`DELETE /api/tools/:id` **一律放行**。这里原来有一段"还挂着它的 agent 会让删除被拒"，随
挂载能力一起删掉了——那把锁**没有钥匙**：拒绝时给的话是"先把它从那些智能体上摘掉"，而"摘掉"
那个入口已经不存在了。**一条指向死路的拒绝，比不拒绝更糟。**

---

## 6. 动作怎么被触发

```
执行者跑完 → 审核者按内联标准判 → 判决里的 actions[]
   → ① 动作名在不在**已安装的包**里          不在 ⇒ 整条判决判为不合规
   → ② 在不在这个审核者的**行动权限**里      不在 ⇒ 整条判决判为不合规
   → ③ 开放参数合不合规（类型、上限、必填）  不合 ⇒ 整条判决判为不合规
   → ④ 幂等（键含 verdictId）                重复 ⇒ 落 skipped
   → ⑤ 绑定/合并参数（平台注入 bound）       ← 模型填了 bound ⇒ 不合规
   → ⑥ 执行脚本（dry-run 原样透传）
   → ⑦ 记状态：executed / failed（失败必须可见）
```

**三条不能退让的规则：**

1. **默认自动执行**（INV-4）。没有"先等人批准"这一步——状态枚举里虽然还留着
   `awaiting_approval`，但**现在没有任何分支会产生它**。若默认要人点一下，人又变回了默认关卡；
2. **幂等键必须含 `verdictId`**：同一判决重放要被去重，但**不同判决产生的相同动作不能被
   去重**——否则多视角审核里第二个 agent 同样的真实发现会被静默吞掉；
3. **失败必须可见**（FR-ACTION-08）：动作失败不得静默，进 `failed` 状态并发通知。

### 「调试」：不跑脚本、只记录动作与参数（2026-09 取代"预演准入"）

原来这里是一道"预演准入"刹车（`dryRun: "unsupported"` 的动作默认不得自动执行，
「工具」页有个全局开关放行）——**2026-09 整体撤掉**：动作**直接执行**，是否执行只看
它是否在审核者的行动权限里 + 参数是否合规；清单里的 `dryRun` 声明保留但不再参与任何判断。

想看"这条动作会带着什么参数发出去"改用**审核者行动权限里的「调试」勾选**
（`AgentGroup.debugActions`，`allowedActions` 的子集、配在**组**上、没有任务级覆盖——2026-10 起；在那之前短暂地在审核者身上）：
勾上之后判决引用该动作时**不跑脚本**，只把动作连同解析后的完整参数（平台绑定 + 模型
填的 + 固定参数）记进时间线（`Action.dryRun: true` ⇒ 显示「调试 · 未执行」）。守卫在
`apps/daemon/src/actions.ts`——不是界面一句提示。

### 固定参数（D43）

审核者上（以及新建任务第三步）可以给某个动作**钉死**几个 open 参数：值由平台在执行时注入，
**模型不许写**——写了的判决会被判不合规。用途是"这个 id 要事前定义、别让模型误操作到别的 id"。

---

## 7. 限额与硬规则（速查）

| 规则 | 值 |
|---|---|
| 清单 schema | `agentdeck/tool@1`（不认识就拒） |
| 包 slug / 动作名 | kebab-case，≤63 |
| 动作数 | 1–50，组内 `name` 唯一 |
| `timeoutMs` | 1000–600000（缺省 60000） |
| 入口路径 | 必须在包内：不许绝对路径、不许 `..` |
| `runtime` | `node` / `shell` / `python3` |
| **daemon 侧装包限额** | 单文件 256 KB、总计 8 MB、文件数 512、深度 4（与 skill 同一组常量，2026-10 随 skill 提档——完整仓库型技能实测 234 文件 / 2.4 MB） |
| **远端目录限额** | 单文件 128 KB、总计 512 KB、文件数 32 |
| 文件内容 | **只收文本**（二进制在安装时就被拒并列出） |

---

## 8. 常见坑

| 现象 | 真正的原因 |
|---|---|
| "装进来了，但判决引用它就判不合规" | 没在**审核者**的「行动权限」里勾上那个动作。审核者不挂工具——权限配在它身上 |
| "改完脚本没反应" | 库里是**快照**。要重新装一遍（同名带 `overwrite`） |
| "动作明明写了却从来没被执行" | 清单里写了 `dryRun: "unsupported"`。默认不放行；要么实现 dry-run，要么在工具页打开那个开关 |
| "装进来的包少了一个动作" | 清单没通过校验。远端和 daemon 用的是**同一份 schema**，`GET /api/catalog` 的 `skipped` 里有原因 |
| "脚本报 stdout 不是合法 JSON" | 多半是脚本还打了别的东西到 stdout（日志要走 stderr），或者 python 的编码问题（平台已经设了 `PYTHONIOENCODING=utf-8`） |
| "脚本找不到自己包里的文件" | 入口是相对**包根**写的，而 cwd 是那条 run 的工作目录。要么用包内相对路径拼 `import.meta.url`，要么把路径做成绑定参数 |
| "同一个包想装两个版本" | 不允许。同名就是冲突，要么 `overwrite`，要么换 slug |
| "远端目录里加了包，界面上看不到" | 目录**每次都重扫**（`GET /api/catalog` 里现扫，不需要重启）——所以看不到就是**没通过校验**：原因在响应的 `skipped` 里，远端进程的日志里也有一行 `[warn] 目录里的包没有列出去：… —— 原因`。另外别把它放进**点开头**的目录（会被跳过），也别超过 4 层 |

---

## 9. 代码索引

| 想知道 | 去哪 |
|---|---|
| 清单 schema（唯一判据） | `packages/protocol/src/tools.ts`（`ToolManifest`、`ToolActionSpec`、`BoundFrom`、`OpenParamSpec`、`ToolRuntime`） |
| 已安装工具包的实体 | 同上（`Tool`） |
| 从本机目录解析包、限额、`sourceRef` | `apps/daemon/src/tool-source.ts` |
| 远端目录扫描与限额 | `apps/remote/src/catalog.ts`（`loadCatalogTools`） |
| 远端目录的响应 | `apps/remote/src/server.ts`（`catalog`） |
| 脚本执行器（物化、白名单环境、超时、杀进程组） | `apps/daemon/src/script-executor.ts` |
| 动作的解析 / 校验 / 幂等 / 授权 / 调试短路 | `apps/daemon/src/actions.ts`、`packages/domain/src/actions/tool-actions.ts` |
| 接口 | `apps/daemon/src/server.ts`：`GET/POST/DELETE /api/tools`；动作授权与调试在**组的 CRUD** 上（`allowedActions` / `actionParams` / `debugActions`，2026-10 起；在那之前是 `PATCH/POST /api/agents`） |
| 落在磁盘上的布局 | `packages/store-file/src/file-store.ts`（文件头有完整目录树） |
| 可照抄的范例 | `examples/tools/example-note/`、`apps/remote/catalog/tools/*/` |
| 测试 | `apps/daemon/src/tool-source.test.ts`、`apps/daemon/src/tool-action-e2e.test.ts`、`apps/daemon/src/tools-api.test.ts`、`apps/daemon/src/remote-tool-install.test.ts`、`apps/remote/src/catalog.ts` 的测试 |
