# 生成类功能：产物写存储格式，人点一下入库（编排 / 智能体 / 技能）

> 2026-11。使用者定调（逐条）：
>
> 1. 「在聊天过程中可以**自动生成** workflow（**直接生成存储的样子**）」——产物从"草稿 md"换成"存储同构目录"；
> 2. 「**不需要看已经有的智能体**，直接在内部生成智能体来使用」——编排自带人；
> 3. 「由于 workflow 的代码形式会**经常变化**，最好以**资料**的形式动态输入到工作目录，类似于技能起草的方式」；
> 4. 「点「收进编排库」→ **直接保存，进入编辑编排页面**（如果有同名，要提示是否覆盖）」；
> 5. 「资料包：可能需要更多，比如 **Skill 和 Agent 的写法**（后面技能起草者和智能体生成者都要给成类似形式）」；
> 6. 「在聊天的工作目录生成存储的格式，等人点确认后再入库」。
>
> 拍板：按钮"目录存在就出现"；内建智能体**不挂外围技能、但可以自生成技能**；名字**允许中文**；一条编排**软上限 8 人**；
> 资料目录 `material/orchestration`（外加 agent / skill 两包）。
>
> **状态：已实施（D255，2026-11）**。实现落在：`docs/material/**`（唯一手写源）→ `tools/material/sync.mjs`
> → `apps/daemon/catalog/material/**`（随包）→ `material-seed.ts`（每次对话前覆盖写进工作目录）；
> 预检 `workflow-candidate.ts`、入库 `workflow-adopt.ts`、界面 `ChatWorkflowCandidates.svelte`；
> 旧面板 `WorkflowMakerConfirm` 与 `workflow-draft` / `workflow-commit` 两条接口已删除，
> D143 那份平台技能已幂等退役（`workflow-maker-skill-retire.ts`）。
> 本文保留作设计依据；逐条判据见 `docs/srs/requirements.md` §16 的 **D255**。

---

## 1. 定稿的三条主线

| | 定稿 |
|---|---|
| **产物** | 在聊天工作目录里**直接写成存储形状**：`workflow-draft/<编排名>/{workflow.json, main.js, agents/<名字>/…}` |
| **入库** | 人点一次「收进编排库」⇒ **直接保存**（没有中间确认面板）⇒ **跳到编排编辑页并选中它**；同名 ⇒ 先问「覆盖那条吗」 |
| **知识** | API 与写法**不进提示词**，以资料包写进 `material/`（orchestration / agent / skill 三包，见 §6） |

这三条对**智能体生成者**（岗位卡）与**技能起草者**（沉淀）**同构**：同一种产物（目录）、同一种入口（点一下入库）、
同一份资料目录（`material/`）。本轮先落编排，另两条按同一张图纸后续接（§9）。

---

## 2. 产物：工作目录里就是存储的样子

```
<工作目录>/
  workflow-draft/                  ← 沿用 D135 这个"一个生成产物一个目录"的约定
    周报流水线/                     ← 一个候选编排 = 一个子目录（**还没有 id**）
      workflow.json                { "name": "周报流水线", "summary": "取数→成稿→你过目" }
      main.js                      编排代码（= Workflow.code，一个字不差）
      agents/
        写作员/
          agent.json               { "name": "写作员", "runtimeKey": "default" }
          instructions.md          她的指令（组装前正文）
          skills/                  ← **自生成技能**（与 D234 的独有技能同构）
            weekly-shape/SKILL.md
        审稿员/
          agent.json
          instructions.md
```

要点：

- **`workflow.json` 只写生成者该知道的**：`name` / `summary`。`id` / `source: 'ai'` / `createdAt` / `apiVersion` / `origin` 由 daemon 入库时补。
- **`main.js`** 就是存储里那段代码——**存储怎么放，生成者怎么写**。
- **`agents/<名字>/`** 与 `workflows/<id>/agents/<名字>/` 同构（D234）；`skills/<名字>/SKILL.md` 与独有技能同构（D111）。
  内建智能体**不挂外围技能**（`skillIds` 恒空）——但**可以自生成技能**（写在自己的 `skills/` 下）。
- **中文名允许**：`写作员`、`周报流水线` 都合法（目录名 = 名字的 slug，D231 同一套）。

---

## 3. 入库：人点一下 → 直接保存 → 进编辑页

### 3.1 聊天里的卡片（自动出现，不需要点）

```
┌ 已生成编排「周报流水线」                          [打开目录]  [收进编排库] ┐
│ 3 步：取数 → 成稿 → 你过目 · 2 个内建智能体（写作员 / 审稿员）            │
│ 按 v5 写的 · workflow-draft/周报流水线/ · ✅ 校验通过                      │
└───────────────────────────────────────────────────────────────────────────┘
```

有毛病的版本（**按钮在、但置灰**，原因写在卡片上）：

```
┌ 还没能收：「周报流水线」                                        [打开目录] ┐
│ ✗ agent('数据员') 在 agents/ 下没有这个人——要么改名，要么给他写一份指令  │
│ ✓ main.js 语法通过 · ✓ workflow.json ok · 2 个人都有指令                  │
└──────────────────────────────────────────────────────────────────────────┘
```

- **打开目录**：D245 的文件树（原文面可编辑）——要改就在这儿改，或让模型改。
- **收进编排库**：校验通过时可点；**点下去不弹面板**，直接保存（3.3），成功后**跳 `#/workflows` 并选中这条编排**。

### 3.2 同名怎么办

服务端入库前查「同一工作区里已有同名编排」：

- 有 ⇒ `409 { code: 'workflow_name_taken', existing: { id, name } }`；
- 界面弹**确认框**（`askConfirm`，与删除同一个组件）：
  「库里已有一条同名编排「周报流水线」。要用这次的生成覆盖它吗？」
  ⚠️ 文案里说清**覆盖什么**：「它的代码与 2 个内建智能体会被整份替换（原来有、这次没有的人会被删掉）」；
- 确认 ⇒ 再发一次 `{ dir, overwrite: true, existingId }`，服务端**原地替换**那条（保留 id，`updatedAt` 变）；
- 取消 ⇒ 什么都不发生（目录还在工作目录里）。

### 3.3 入库动作（服务端，一次事务）

1. 校验（§4，界面那份是预检，这里才是权威）；
2. `id`：新建 = `ulid()`；覆盖 = 沿用 existingId；
3. **整目录搬**：`workflow-draft/<名字>/` → `workflows/<id>/`
   （`workflow.json` 补 `id` / `workspaceId` / `source` / `apiVersion` / `origin` / `createdAt` / `updatedAt` 后写回；
   `main.js`、`agents/**`（含其中的 `skills/**`）原样搬）；
4. 先写临时目录再 rename，失败不落半条；
5. 返回 `{ workflow }`。

---

## 4. 校验（两个时机，同一份判据）

- **每轮预检**（turn 的 run 结束）：扫 `workflow-draft/*/`，结果进对话详情（`conversation.workflowCandidates`）
  ⇒ 卡片据此显示"能不能收"；
- **入库时再校验一次**（服务端权威，不信任界面）。

| # | 判据 | 失败怎么说 |
|---|---|---|
| 1 | `workflow.json` 能解析、`name` 非空 ≤100、`summary` 可空 | 「workflow.json 第 3 行不是合法 JSON」这种原文 |
| 2 | `main.js` 语法通过（`AsyncFunction` 只构造不调用，与引擎同一条路） | 语法错误原文 + 行号 |
| 3 | `agent('X')` **只认 `agents/X/`**；`gate/flow/parallel/loop/route` 之外**不许出现别的标识符调用** | 「`agent('数据员')` 在 `agents/` 下没有这个人」／「`inline(…)` 不是编排原语」 |
| 4 | 每个 `agents/<名字>/instructions.md` 非空；`agent.json.name` 与目录名一致；自生成技能的 `SKILL.md` frontmatter 有 `name`/`description` | 点名是哪个人 / 哪个技能 |
| 5 | 软上限 **8 人**（超了**不拒**，卡片上说一句"人有点多，考虑拆成两条编排"） | — |

---

## 5. 生成者的身份怎么改

现在的身份里有一大段 API 清单（六个原语、Reply 形状、`{{task}}`…）。这套设计里**删掉**，只留：

1. **怎么问**（几步 / 每步谁干 / 哪一步要人拍板）——不变；
2. **人可以没有就用内建**：「用户说不出名字就**自己起一个人**（写进 `agents/`），不要让他先去建」；
3. **先读资料**：「动笔前读 `material/orchestration/README.md`；不确定的地方回去读，别凭印象」；
4. **写到哪**：`workflow-draft/<名字>/` 三件套 + `agents/`；
   写完在聊天里说清"几步 / 每步谁干 / 哪一步要人确认 / 请点「收进编排库」"；
5. **它不自己入库**——入库只有人那一按。

---

## 6. 资料包：`material/` 下三包（编排 / 智能体 / 技能）

### 6.1 目录

```
<工作目录>/material/
  README.md                    ← 索引：这次我在做哪一类、先读哪一包、各包当前版本
  orchestration/               ← 编排生成者用（本轮做实）
    README.md                  apiVersion + 文件清单 + "怎么用"
    api.md                     六个原语的签名与语义、Reply 形状、{{task}}
    examples/                  接力.js 门禁.js 并行.js 返工.js
    changelog.md               哪一版改了什么、旧写法怎么改
    api-version.json           { "version": "v5" }
  agent/                       ← 智能体生成者用（下一步接）
    README.md
    shape.md                   agents/<名字>/ 的存储形状（agent.json 字段、instructions.md、skills/）
    norms.md                   岗位卡写法：目标 / 边界段（必填）/ 交付物 / 判定口径
    examples/
  skill/                       ← 技能起草者用（下一步接）
    README.md
    format.md                  SKILL.md 的 frontmatter（name/description）+ 正文结构 + 支持文件
    examples/
    checklist.md               入库前的机械体检项（与 validateArtifactFiles 同一套）
```

### 6.2 资料**在仓库里只有一份手写的**（2026-11 使用者补充）

> 「material 也在代码中**单独目录维护**，不要分散在各个地方，最好和 docs 链接起来，
> 直接作为文档的一部分，**人和 LLM 看到的是一份资料**。」

落地三条：

| 层 | 位置 | 是什么 |
|---|---|---|
| **唯一手写源** | `docs/material/**` | 人在这里读（`docs/README.md` 有链接）；`docs/material/README.md` 是这份资料的入口 |
| **同步产物** | `apps/daemon/catalog/material/**` | 随包发布的那份；`node tools/material/sync.mjs` 生成，`tests/material-sync.test.ts` 逐字节比对（与 `tools/ui-demo/sync-demo.mjs` 同一条规矩：**仓库里没有第二份手写资料**） |
| **运行时副本** | `<工作目录>/material/**` | daemon 起生成类对话时把产物目录**原样复制**过去（覆盖写），agent 读的是它 |

- **不许再散落**：这些内容不写进 `builtin-drafter.ts` 的身份文本、不在别处手抄——身份只负责"问什么"和"先读 `material/…/README.md`"；
- 覆盖写 ⇒ API/规范升级后**下一轮就是新版**，不需要人做什么，也不需要升"内置身份版本"（D143 的坑）；
- `orchestration/api.md` 是**给 agent 的 playbook**，`docs/reference/orchestration-api.md` 是**设计规格**；playbook 的每条规则都要能在规格里找到出处，冲突以规格为准。

### 6.3 版本落到磁盘

`workflow.json` / `agent.json` / `SKILL.md` 旁边记 `version`（入库时由 daemon 补，不进生成者的手写内容）。
将来不兼容改版时：列表/详情能显示"按 v5 写的"，运行/校验能先说"这条是老版本的"。

---

## 7. 与"确认面板"的关系

**删掉** `WorkflowMakerConfirm.svelte`（连同 `GET …/workflow-draft`、`POST …/workflow-commit` 两条接口）。
理由：产物是文件，**改就该改文件**；面板里再放一份可改的文本会和磁盘分叉。
界面上只留：卡片（状态 + 打开目录 + 收进编排库）与一个同名的 `askConfirm` 覆盖确认。

---

## 8. 重复生成、改名、删除

- **同一对话再生成一次**：同 `name` ⇒ 入库时问「覆盖」；不同 `name` ⇒ 新建一条候选（两个子目录并存，卡片两张）。
- **换个人来改**（另一个对话生成同名编排）：不合并，同样走"同名 ⇒ 问覆盖"。
- **删除**：编排页删（已有入口）；删掉后聊天里那张卡片变灰「已删除」。**聊天里不再有第二个删除入口**。

---

## 9. 智能体 / 技能：同一张图纸（后续接）

| | 产物（工作目录） | 入库后 | 跳转到 |
|---|---|---|---|
| 编排（本轮） | `workflow-draft/<名字>/` | `workflows/<id>/` | 编排编辑页 |
| 智能体 | `agent-draft/<名字>/`（`agent.json` + `instructions.md` + `skills/`） | `agents/<目录名>/` | 智能体编辑页 |
| 技能 | `skill-draft/<名字>/`（`SKILL.md` + 支持文件） | 技能库（`skills/` 或 `skills-mine/`） | 技能页（展开那一行） |

三者共用：同一种卡片、同一种"点一下入库并跳编辑页"、同一个 `material/` 资料目录、同一套校验入口。
⚠️ 现有的 `agent-draft/agent-draft.md`（岗位卡）与沉淀的 `skill/` 产物届时按同一规则改——**这一轮不动它们**。

---

## 10. 数据与协议要改的地方（预告）

- `Workflow` 增 `summary?: string`、`apiVersion?: string`、`origin?: string`；
- 路由：新增 `GET …/workflow-candidates`、`POST …/workflow-adopt`；删掉 `workflow-draft` / `workflow-commit`；
- 对话详情增 `workflowCandidates: [{ dir, name, summary, steps?, agents, problems }]`；
- 入库 = 搬目录：`workflows-dirs.ts` 的 `writeWorkflowAgent` / 独有技能目录工具直接复用；
- 资料：`docs/material/**`（源）→ `apps/daemon/catalog/material/**`（`pnpm run sync:material`）→ 工作目录 `material/**`（daemon 复制）。

---

## 11. 开放项（要你点头）

1. **覆盖的边界**：同名覆盖时把**旧的内建智能体整份替换**（原来有、这次没有的人会被删掉），并在确认框里写明。可以吗？
2. **资料包这一轮做到哪**：建议先把 `orchestration/` 做实（本轮就要用），`agent/` 与 `skill/` 先落**目录 + README 指针**，
   真正的内容等接那两条时补——避免写两份没人读的资料。
3. **`material/README.md` 的索引**要不要写"这次我在做哪一类"（写了它每轮都在变）。
