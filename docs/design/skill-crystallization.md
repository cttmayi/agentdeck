# 聊天沉淀 skill（chat-to-skill）设计

> 状态：**设计已定，未实现**（2026-10-18，使用者确认先落文档）。
> 配套决策记录：`docs/srs/requirements.md` §16 的 **D80**。
> 本文档回答"聊天里怎么沉淀出（并可进化）可复用 skill"的完整设计；实现范围见 §8。

## 1. 背景与目标

使用者在 AgentDeck 的聊天（conversation run）里和 agent 协作，经常完成**可复用**的事——
修了一个流程、跑通了一段部署、整理出一套检查步骤。这些"做法"当前只活在对话历史里，
下次要再用就得重讲一遍，或者翻聊天记录。

**目标**：把"这段聊天做了什么、怎么做的"提炼成标准的 `SKILL.md`，进 `~/.agentdeck/skills/`
（磁盘为准的技能库），以后挂到 agent 上复用；用多了发现不够 → 在旧版基础上**进化**（覆盖 + git 版本管理）。

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

### 4.1 用户主动（主触发）——消息级按钮

聊天消息旁一个「沉淀成 skill」按钮。点击后平台把**从这条消息往后的所有消息**
（含 agent 的工具调用与结果，从 run events 里取）打包成「沉淀素材」。

- 为什么以"某条消息为起点"而不是整段会话：整段太大、提炼不出单一做法；用户自然会说
  "从这条开始，这段做法值得沉淀"。
- 素材来源：`/api/runs/:id/events`（现成）。素材里**必须保留工具调用及其结果**
  ——提炼"怎么做"依赖真实的命令/脚本，只给对话文本会写出幻觉步骤。

### 4.2 信号建议（辅触发）——只问不做

run 结束时检测三类信号（借 dsh-skill-evolution 的信号模型）：

| 信号 | 条件 | 含义 |
|---|---|---|
| `complex` | 成功 turn 且 ≥5 次工具调用 | 完成了一件复杂事 |
| `recovered` | 有失败步骤但 turn 仍成功 | 绕过了死路、找到了可行路径 |
| `repeated` | 相同工具序列重复 ≥N 次且成功率高 | 反复验证过的流程 |

命中时，agent 在回复里**只问一句**"这段值得沉淀成 skill 吗？"——**不自动做**。
为什么：AgentDeck 的 NG 原则是"平台不替使用者决定"；自动结晶（dsh-skill-evolution 的
默认形态）会把使用者没有主动要的东西写进他的技能库，噪音大于收益。信号只用来**降低
使用者发现"这段可沉淀"的成本**，决定权始终在使用者。

（`complex` 单独命中太弱——任何长 turn 都符合，dsh-skill-evolution 默认要求 complex
必须被 recovered/repeated 佐证。本设计首版只做**建议文案**，佐证门槛并入 §9 开放问题。）

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

## 6. 审阅 → 入库

- 界面预览草稿（SKILL.md 渲染，Markdown 渲染器是现成的 `apps/web/src/lib/markdown.ts`），
  可编辑，**用户确认后才入库**。
- 校验：frontmatter 合法（name/description 存在、description 含触发条件）、slug 唯一
  （撞车提示"已有同名 skill，是否进化它？"——从这里自然衔接进化流程）。
- 入库走现有 `POST /api/skills/install`（`installSkillPayloads`，落 `~/.agentdeck/skills/<slug>/`）。

## 7. 进化（覆盖 + git 版本管理）

### 7.1 触发

- 用户对聊天片段点「进化此 skill」（选择目标 skill；或入库校验撞车时直接切进化）。
- skill 挂载的 run 中 agent 发现问题（"这个 skill 缺了 X/过时了"）→ 建议使用者进化。

### 7.2 起草与覆盖

素材 = **现有 SKILL.md 全文 + 新经验** → 起草修订版 → 用户确认 → **覆盖旧文件**。

### 7.3 git 版本管理（使用者定的语义：覆盖 + git 类似版本管理）

- `~/.agentdeck/skills/` **整体 git 化**：首次开做时 `git init`（实测当前不是 git 仓库，
  全局 git 身份已配置 `cttmayi@hotmail.com` / `Ling Yuan`，平台自动 commit 有身份可用）。
- 每次入库/进化后平台**自动 `git add` + `commit`**，commit message 带版本说明，如
  `skill <slug> v2：新增 X 边界`。
- 收益：`git log`/`git diff`/`git checkout` 回退/远程同步（推到私有仓库备份、换机器拉取）全免费，
  不用平台自己造版本表。
- 兜底（沿用"失败不失败 run"惯例）：git 不存在 / 非仓库 / commit 失败 → note 降级，
  run 照常；另在 skills 仓库配 **per-repo 兜底身份**（`agentdeck <agentdeck@localhost>`），
  防"换机器没有全局身份"时 commit 挂掉。

## 8. 实现范围（要开做时的六项）

1. **消息级按钮 + 起点选中**（RunLog/chat 视图）——「沉淀成 skill」按钮 + 选中起点消息。
2. **素材打包**（daemon 端）——取起点后的 events（消息 + 工具调用），组「沉淀素材」。
3. **起草 run**（新 run kind `skill-draft`）——prompt 组装（素材 + 模板 + skill 列表 +
   不结晶清单），产出候选文件。
4. **草稿审阅界面**——预览/编辑/确认入库/撞车时切进化。
5. **git 化 + 自动 commit**——daemon 启动确保 skills 根 `git init`（幂等）+ 入库/进化后
   `git add`+`commit`，失败 note 降级。
6. **信号建议**——run 结束检测 complex/recovered/repeated → 回复里加一句"这段值得沉淀吗？"。

最小闭环 = 1–5（触发→提炼→审阅→入库→git）；6（信号建议）与 FOLD_INTO 合并提示可二期。

## 9. 开放问题（本次未定）

- **佐证门槛**：`complex` 单独命中要不要 dsh-skill-evolution 那样被佐证？首版建议文案从简。
- **FOLD_INTO 的 UI 形态**：起草 run 返回"建议合并进 <已有 skill>"时，界面怎么呈现（确认即覆盖
  已有 skill？还是先看 diff？）——与 §7.3 的 git diff 天然衔接。
- **离线挖掘**（skill-miner 式批处理分析历史会话找重复模式）——二期备选。
- **多文件 skill 的审阅形态**：草稿含脚本/模板时，审阅界面怎么预览非 markdown 文件。
- **skill 带示例评测**：Anthropic 建议"从评估开始"——首版不做评测 run（成本高），
  使用者在真实任务里用几次自会知道好不好用。

## 10. 与现有机制的关系（零冲突）

| 现有机制 | 本设计的接法 |
|---|---|
| run 执行管道（executor、第一句话、审核收口） | 起草 run 完全复用（kind 加一个 `skill-draft`） |
| `/api/runs/:id/events` | 素材打包的数据源 |
| `POST /api/skills/install` + `~/.agentdeck/skills/` | 入库落点（git 化该目录） |
| Markdown 渲染器 `apps/web/src/lib/markdown.ts` | 草稿预览复用 |
| NG 原则（不替使用者决定） | 用户主动为主触发；信号只建议不自动做；审阅后才入库 |
