# 聊天沉淀 skill（chat-to-skill）设计

> 状态：**设计已定，未实现**（2026-10-18，使用者确认先落文档；同日补充"提炼的与安装的分根"）。
> 配套决策记录：`docs/srs/requirements.md` §16 的 **D80**。
> 本文档回答"聊天里怎么沉淀出（并可进化）可复用 skill"的完整设计；实现范围见 §8。

## 1. 背景与目标

使用者在 AgentDeck 的聊天（conversation run）里和 agent 协作，经常完成**可复用**的事——
修了一个流程、跑通了一段部署、整理出一套检查步骤。这些"做法"当前只活在对话历史里，
下次要再用就得重讲一遍，或者翻聊天记录。

**目标**：把"这段聊天做了什么、怎么做的"提炼成标准的 `SKILL.md`，进**提炼专用根
`~/.agentdeck/skills-mine/`**（与安装根 `~/.agentdeck/skills/` **物理分离**，理由见 §1.1），
以后挂到 agent 上复用；用多了发现不够 → 在旧版基础上**进化**（覆盖 + git 版本管理）。

### 1.1 为什么提炼的与安装的必须分根（2026-10-18 使用者提出）

使用者："**不应该把安装的 skill 和我自己提炼的 skill 混在一起（混在 `~/.agentdeck/skills/`）**"。
两者语义完全不同，混在一个根里有真实的损害：

| | 安装的（外部） | 提炼的（自己的） |
|---|---|---|
| 来源 | 远端服务 / GitHub / 本地清单 / localdir | 自己的聊天沉淀 |
| 更新语义 | **重新安装覆盖**是正常行为 | 自己的进化被"重装"覆盖 = **资产丢失** |
| 版本管理 | 外部内容，重新装就行 | 自己的资产，要 git 历史 / 回退 / 备份 |
| 信任 | 别人写的（可能有许可证 / 更新） | 自己的做法（可能含工作上下文） |

**落地方案（两个根）**：

```
~/.agentdeck/skills/          ← 安装的（现状不变：install API 落这）
                                   不 git 化，重装覆盖语义不变
~/.agentdeck/skills-mine/     ← 提炼的（新根，git 化 + 平台自动 commit）
                                   平台永不自动覆盖——进化 = 起草→确认→覆盖+commit
```

- **store 索引**：`Skill.source` 标记 `mine`，界面按「安装 / 我提炼的」分组。
- **注入**：零改动——注入走 store 的 `skill.body`（`syncInjectedSkills(workDir, skillDir, skills)`
  的 payload 来自 store 记录，不从磁盘根读）。
- **slug 冲突**（同 slug 两个根都有）：**提炼的优先**——运行期用提炼的 body，自己的版本
  遮蔽安装的；列表里被遮蔽的安装项标注「被你的版本遮蔽」。
- **git 化范围**：只 `skills-mine` 一个根——平台自动 commit 的语义正好是"你沉淀的东西"，
  安装的外部内容平台不碰（要备份安装的，使用者自己 git 整个 `~/.agentdeck` 即可）。

**为什么值得做（调研共识）**：skilldistill 说得最直接——"Agents repeatedly discover useful
procedures, but most of that knowledge stays trapped in the conversation"（知识困在对话里）。
业界对"从对话提炼 skill"的共识是：**审阅是必要环节**（不自动入库），且 SKILL.md 遵循统一结构
（Anthropic 官方博客的「渐进式披露」：frontmatter 的 `name`/`description` 只够判断"何时用"，
正文是第二层细节，认为相关才全文读入）。

## 2. 调研依据（网络资料）

| 派别 | 代表 | 触发哲学 | 对本设计的影响 |
|---|---|---|---|
| 用户主动蒸馏 | [skilldistill](https://pypi.org/project/skilldistill/)、[dsh-skill-evolve](https://github.com/dmsobtl/dsh-skill-evolve) | 用户选定轨迹 → 提炼成 **reviewable** 候选 | 「用户主动」触发（§3.1）+「审阅」环节（§5） |
| 信号触发自动结晶 | [dsh-skill-evolution](https://github.com/VanadisGithub/dsh-skill-evolution) | turn 结束时信号检测（complex/recovered/repeated）→ LLM 审查门 → `SAVE / FOLD_INTO / NOTHING_TO_SAVE`；硬性**不结晶清单** | 「信号建议」触发（§3.2）+ 不结晶清单（§4.2）+ `FOLD_INTO` 合并（§4.3） |
| 离线批量挖掘 | [skill-miner](https://pypi.org/project/skill-miner/) | 分析 session 历史找重复模式 | 二期备选（§9 开放问题） |
| SKILL.md 标准 | [Anthropic 官方博客](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)、[Claude Code 文档](https://code.claude.com/docs/en/skills) | frontmatter（name/description）+ 正文；从评估开始补缺口 | 草稿结构模板（§4.4） |

## 3. 流水线总览

```
聊天消息 → ①触发（用户主动按钮 / 信号建议）
        → ②提炼（skill 起草 run：素材 + 模板 + 不结晶清单 + 现有 skill 列表）
        → ③审阅（界面预览/编辑 → 用户确认，平台不自动入库）
        → ④入库（走现有 POST /api/skills/install → ~/.agentdeck/skills/<slug>/）
        → ⑤进化（起草修订版 → 确认 → 覆盖 + git 自动 commit，可回退）
```

## 4. 触发（双层，调研后定稿）

### 4.1 用户主动（主触发）——轮次级按钮（UI 行为细节）

Chat 视图的 UI 单位是**一轮（turn）**：每条 agent 回复是一个气泡（`bubble agent`），
一轮跑完才有完整素材（该轮 run 的 events）。所以起点按**轮**选，不按消息行。

**按钮形态与位置**
- 每条 **agent 回复气泡（一轮 turn）**的右上角一个「沉淀成 skill」图标按钮
  （ghost 小图标，带悬浮提示"从这轮开始沉淀成 skill"）。
- **只在该轮已结束**（非"正在跑"）时可用——跑的时候素材不完整；按钮在该轮运行时置灰。
- **常驻显示**（不做 hover 才出——发现性优先；视觉弱化用 ghost 图标压住存在感）。

**点击后：选起点 + 确认范围**
1. 点按钮 → 该轮进入"候选起点"态：气泡加高亮边框，顶部出现提示条
   "**将从此轮沉淀到对话结尾**"。
2. 可点**更早**的轮调整起点（起点只能往前选）——高亮跟着移动，起点之前的轮恢复正常显示。
3. 提示条实时显示范围摘要："**将沉淀 N 轮（M 次工具调用），从 <本轮摘要> 到 <当前轮>**"；
   按钮变为「开始沉淀」。
4. 素材范围 = **起点轮 → 当前轮**之间所有 turn 的 run events（消息 + 工具调用 + 输入输出）。
   素材里**必须保留工具调用及其结果**——提炼"怎么做"依赖真实的命令/脚本，只给对话文本
   会写出幻觉步骤。

**触发起草（起草 run 的过程可见、可停）**
5. 点「开始沉淀」→ 平台打包素材（各 turn 的 `/api/runs/:id/events`，现成）→ 起
   「skill 起草 run」（kind `skill-draft`，§5）。
6. 界面进入"**起草中**"状态：**复用 RunLog 显示起草 run 的实时日志**（现成能力——
   RunLog 本来就是唯一消息渲染器），可「停止」（现成的 stop 按钮），起草失败可看日志。
7. 起草完成 → 进入审阅。

**草稿审阅界面（草稿回来）**
8. 弹出/切换「**草稿审阅**」面板：
   - **预览**：SKILL.md 渲染预览（现成 markdown 渲染器 `apps/web/src/lib/markdown.ts`）。
   - **编辑**：`name`（kebab-case）、`description`（校验必须含触发条件）、正文
     （When to Use / Procedure / Pitfalls / Verification）都可改。
   - **支持文件**：草稿带脚本/模板（`scripts/`、`templates/`）时，文件列表 + 逐个预览。
9. **撞 slug 校验**（§6）：确认时检查同名——
   - 提炼根已有同 slug → 提示"已有你提炼的同名 skill（vN）"，选「**覆盖（进化）**」走 §7
     （素材 = 旧 SKILL.md + 新经验）或「**改名**」。
   - 安装根已有同 slug → 提示"已有安装的同名 skill，你的版本将**遮蔽**它"（§1.1），确认即入
     或改名。
10. 「**确认入库**」→ 写 `~/.agentdeck/skills-mine/<slug>/` + store `source: 'mine'`
    + git commit → 完成提示"已沉淀 skill <name>，可在技能库查看/挂到 agent"。
11. 「**取消**」→ 丢弃草稿，回到聊天，聊天内容不受影响。

**边界情况**
- 起点轮之后没有更多轮（只有起点自己）→ 按钮仍可用（单轮也可沉淀），提示条注明"只有这一轮"。
- 起草 run 失败 → 提示失败原因 + 「查看日志」「重试」（素材原样重发，不重复打包）。
- 素材过大（轮数多）→ 提示"素材较大（N 轮），起草 run 上下文有限，可能截断"——**不阻断**。
- 对话还在进行（run 未终态）→ 素材只取已落库的部分，提示说明。

**为什么按轮选起点而不是"整段会话"**：整段太大、提炼不出单一做法；用户自然会说
"从这一轮开始，这段做法值得沉淀"。起点必须"往前选"而不能往后——沉淀的永远是**历史**，
未来还没发生。

### 4.2 信号建议（辅触发）——⏸️ 暂缓，首版不做（2026-10-18 使用者定）

使用者："**4.2 信号建议（辅触发）先不做，这部分还没考虑清楚**"。设计方向（借
dsh-skill-evolution 的信号模型）记录在案，等考虑清楚再捡起：

| 信号 | 条件 | 含义 |
|---|---|---|
| `complex` | 成功 turn 且 ≥5 次工具调用 | 完成了一件复杂事 |
| `recovered` | 有失败步骤但 turn 仍成功 | 绕过了死路、找到了可行路径 |
| `repeated` | 相同工具序列重复 ≥N 次且成功率高 | 反复验证过的流程 |

思路：命中时 agent 在回复里**只问一句**"这段值得沉淀成 skill 吗？"——**不自动做**。
（AgentDeck 的 NG 原则是"平台不替使用者决定"；自动结晶会把使用者没有主动要的东西写进
他的技能库，噪音大于收益。信号只用来**降低使用者发现"这段可沉淀"的成本**。）

**为什么暂缓**（没考虑清楚的点，捡起时先回答这些）：
- 信号定义本身：`complex` 单独命中太弱（任何长 turn 都符合），要不要佐证门槛
  （dsh-skill-evolution 要求 complex 被 recovered/repeated 佐证）？
- 噪音控制：run 结束时多一句"要沉淀吗？"——频繁出现就是打扰，什么频率可接受？
- 触发时机与渠道：信号在 run 结束（而不是聊天中）检测，与用户主动按钮怎么衔接？

首版**只有用户主动**（§4.1）一条触发。相关开放问题见 §9。

## 5. 提炼——「skill 起草 run」

平台起一个**专门的 run（kind 建议 `skill-draft`）**，runtime 用当前 workspace 默认的
claude/codex，复用现有执行管道（第一句话投递、日志、审核收口——全部现成，零新机制）。

prompt = 三块拼装：
1. **沉淀素材**（§4.1 打包的消息 + 工具调用 + 结果）
2. **SKILL.md 模板指引**（§4.4 的结构约束）
3. **现有 skill 列表**（name + description）——让起草者判断是否该 `FOLD_INTO`（合并进已有
   skill）而不是新建重复项

产出 = SKILL.md 草稿（文本，落成一个临时候选文件，不进任何工作目录）。

### 5.1 不结晶清单（质量门）

以下情况**不许沉淀**（来自 dsh-skill-evolution 的硬性门，防垃圾技能冻结成长期错误行为）：

- 环境依赖失败（缺二进制、未配凭证、没装的包）——换个环境就废
- 对工具的负面评价（"工具 X 坏了"——会冻结成长期拒绝用某工具）
- 瞬时错误靠重试治好的（教训是"重试"这个模式，不是原始错误本身）
- 一次性任务叙事、没解决的失败

### 5.2 SKILL.md 草稿结构

```
---
name: <kebab-case 技能名>
description: <一句话，必须含触发条件——"当用户想……时用"——这是渐进式披露的第一层>
---

# <Title>

## When to Use   ← 触发条件展开
## Procedure     ← 可操作步骤（步骤里引用的命令/脚本要原样可复制）
## Pitfalls      ← 注意事项与边界（含"别在什么情况下用"）
## Verification  ← 怎么验证这步做对了
```

支持多文件（脚本/模板放同目录，如 `scripts/`、`templates/`），与现库 skill 结构一致
（如 `browser-use/` 是 `SKILL.md + LICENSE.txt + templates/`）。

## 6. 审阅 → 入库（提炼根 `~/.agentdeck/skills-mine/`）

- 界面预览草稿（SKILL.md 渲染，Markdown 渲染器是现成的 `apps/web/src/lib/markdown.ts`），
  可编辑，**用户确认后才入库**——完整交互见 §4.1 第 8–11 步。
- 校验：frontmatter 合法（name/description 存在、description 含触发条件）、slug 唯一
  （撞车提示"已有同名 skill，是否进化它？"——从这里自然衔接进化流程）。
- 入库**不走** `POST /api/skills/install`（那是"装外部来源"的路，落安装根）——提炼走新的
  「沉淀入库」写入，落 `~/.agentdeck/skills-mine/<slug>/`，store 记录 `source: 'mine'`，
  写完 `git add` + `commit`（§7.3）。**平台永不自动覆盖安装根**。

## 7. 进化（覆盖 + git 版本管理）

### 7.1 触发

- 用户对聊天片段点「进化此 skill」（选择目标 skill；或入库校验撞车时直接切进化）。
- skill 挂载的 run 中 agent 发现问题（"这个 skill 缺了 X/过时了"）→ 建议使用者进化。

### 7.2 起草与覆盖

素材 = **现有 SKILL.md 全文 + 新经验** → 起草修订版 → 用户确认 → **覆盖旧文件**。

### 7.3 git 版本管理（使用者定的语义：覆盖 + git 类似版本管理）

- `~/.agentdeck/skills-mine/` **做成 git 仓库**：首次开做时 `git init`（实测安装根
  `~/.agentdeck/skills/` 当前不是 git 仓库；全局 git 身份已配置，平台自动 commit
  有身份可用）。**只 git 化提炼根**——安装根是外部内容，
  平台不自动 commit（§1.1）。
- 每次入库/进化后平台**自动 `git add` + `commit`**，commit message 带版本说明，如
  `skill <slug> v2：新增 X 边界`。
- 收益：`git log`/`git diff`/`git checkout` 回退/远程同步（推到私有仓库备份、换机器拉取）全免费，
  不用平台自己造版本表。

#### 7.3.1 git 可用性保护（2026-10-18 使用者要求：依赖的是**用户环境的 git**，不捆绑平台）

版本管理依赖系统 `git`——**用户环境可能没有 git，这是正常状态，不是错误**。
设计分两层（对比：早期兜底只有"失败不失败 run"，把 git 缺失当**异常**报——每次沉淀都
尝试 `git init`+`commit`、撞失败、产出一条"commit 失败"note，看着像出错；使用者要求
把它升级为**功能开关**：没有 git 就不需要版本管理）：

| 层 | 触发 | 行为 |
|---|---|---|
| **可用性开关** | 探测：daemon 启动时 + 每次沉淀/进化前 `git --version`（spawn 探测，超时/非零/找不到 → 不可用） | **git 不可用 → 版本管理关闭**：跳过 init 与 commit，沉淀/进化**照常写盘 + store 索引**（功能完全不受影响，只少历史回退）；note 一条说明"版本管理未启用（系统无 git），沉淀照常、无历史回退"——**不是错误** |
| **降级兜底** | git 可用但操作失败（`git init`/`add`/`commit` 非零、`.git` 损坏、权限不足） | note 降级，run 照常（保留早期兜底的语义——这层针对"有 git 但坏了"） |

- **自动恢复**：git 可用性每次沉淀前都探测 → 用户中途装了 git，下次沉淀自动恢复版本管理
  （幂等 `git init` + 首次 commit 把已有沉淀收进历史）。
- **半途状态**：git 不可用期间沉淀的进化没有历史——装 git 后**不补造历史**（没有基线，
  造出来是假的），从恢复那一刻起记录；note 里说明这一点。
- 另在 skills-mine 仓库配 **per-repo 兜底身份**（`agentdeck <agentdeck@localhost>`），
  防"有 git 但没全局身份"时 commit 挂掉（这是降级兜底层的一部分）。

## 8. 实现范围（要开做时的六项）

1. **消息级按钮 + 起点选中**（RunLog/chat 视图）——「沉淀成 skill」按钮 + 选中起点消息。
2. **素材打包**（daemon 端）——取起点后的 events（消息 + 工具调用），组「沉淀素材」。
3. **起草 run**（新 run kind `skill-draft`）——prompt 组装（素材 + 模板 + skill 列表 +
   不结晶清单），产出候选文件。
4. **草稿审阅界面**——预览/编辑/确认入库/撞车时切进化。
5. **提炼根 `skills-mine` + git 化 + 自动 commit**——新根落盘（`source: 'mine'`，store 索引）、
   **git 可用性开关**（启动时 + 每次沉淀前探测 `git --version`；不可用 → 版本管理关闭、
   沉淀照常 + note，可用 → 幂等 init + 自动 commit；操作失败 → note 降级，见 §7.3.1）。
6. **列表分组 + 冲突遮蔽**——技能库按「安装 / 我提炼的」分组；同 slug 冲突时提炼的优先
   （注入用提炼的 body），被遮蔽的安装项标注。

最小闭环 = 1–6（触发→提炼→审阅→入库→git→列表/遮蔽，全部做完才是完整闭环）；
**信号建议（§4.2）不在首版**——使用者定"还没考虑清楚，先不做"；FOLD_INTO 合并提示可二期。

## 9. 开放问题（本次未定）

- **信号建议的完整设计**（§4.2 暂缓的原因）：佐证门槛、噪音控制、触发时机与渠道——考虑清楚才捡起。
- **FOLD_INTO 的 UI 形态**：起草 run 返回"建议合并进 <已有 skill>"时，界面怎么呈现（确认即覆盖
  已有 skill？还是先看 diff？）——与 §7.3 的 git diff 天然衔接。跨根合并（提炼的并入安装的？
  反之？）首版**禁止**——FOLD_INTO 只在提炼根内合并。
- **离线挖掘**（skill-miner 式批处理分析历史会话找重复模式）——二期备选。
- **多文件 skill 的审阅形态**：草稿含脚本/模板时，审阅界面怎么预览非 markdown 文件。
- **skill 带示例评测**：Anthropic 建议"从评估开始"——首版不做评测 run（成本高），
  使用者在真实任务里用几次自会知道好不好用。

## 10. 与现有机制的关系（零冲突）

| 现有机制 | 本设计的接法 |
|---|---|
| run 执行管道（executor、第一句话、审核收口） | 起草 run 完全复用（kind 加一个 `skill-draft`） |
| `/api/runs/:id/events` | 素材打包的数据源 |
| `POST /api/skills/install` + `~/.agentdeck/skills/` | **不动**——那是"装外部来源"的路；提炼走新根 `~/.agentdeck/skills-mine/` + 新写入入口（§1.1、§6） |
| store 的 `Skill.source` | 加 `'mine'` 值；注入零改动（走 `skill.body`），冲突时提炼优先（§1.1） |
| Markdown 渲染器 `apps/web/src/lib/markdown.ts` | 草稿预览复用 |
| NG 原则（不替使用者决定） | 用户主动为唯一触发（信号建议暂缓）；审阅后才入库 |
