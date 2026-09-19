# 示例工具：单据操作（example-issue）

**远端目录里的范例包，专门用来测试动作参数**——这一包演示**绑定参数**与**同一包里两个动作、两套参数形状**。

## 它演示什么

两个动作都模拟对单据的操作，但**不真的改任何单据**：它们把收到的参数（开放 + 绑定）
追加写到工作目录的 `issue-ops.log`（一行一个操作）。

- `example-issue.tag` —— 打标签：`label`（enum）+ `addSummary`（boolean），**两个开放参数**。
- `example-issue.close` —— 关闭单据：只有 `reason`（string ≤500），**一个开放参数**。

同一个包里的两个动作参数形状不同，是刻意的：**动作自己的清单决定它要哪些参数**——脚本
不猜、契约不补，模型只填清单里列出来的那几个。

## 参数一览

### `tag`

| 参数 | 类型 | 怎么填 |
|---|---|---|
| `label` | **enum** | `bug` / `feature` / `tech-debt` / `blocked` / `needs-info` 五选一 |
| `add-summary` | boolean | 是否顺带在摘要里写一句 |
| `dir` | bound（`workdir`） | 平台注入 |
| `workspace-id` | **bound（`workspace.id`）** | 平台注入：**当前工作区 id**，演示"单据归属哪个工作区"这类事实不由模型填 |

### `close`

| 参数 | 类型 | 怎么填 |
|---|---|---|
| `reason` | string（≤500） | 关闭理由 |
| `dir` | bound（`workdir`） | 平台注入 |
| `workspace-id` | bound（`workspace.id`） | 平台注入 |

## 为什么这样设计

- **绑定参数演示"单据不能由模型指定"**：`workspaceId` 来自 `workspace.id`——平台按这次
  run 所在的工作区填。如果让模型填，它就可能"把这条产出操作到别的单据上去"；绑定从
  **结构上**把这个可能拿掉（模型写了反而判不合规）。
- **`reversible: false`**：`close` 声明不可回滚（打标签可以撤，关单据不行）——演示动作
  清单对"能不能撤销"的诚实声明。

## 怎么用（端到端测一遍）

1. 「工具」页 → 从**远端目录**安装 `example-issue`。
2. 挂到一个**执行者**身上。
3. 在**审核者**的「行动权限」里允许 `example-issue.tag` 与/或 `example-issue.close`。
4. 新建任务跑一次；判决里写 `action: { "type": "example-issue.tag", "params": { "label": "bug", "add-summary": true } }`。
5. 脚本执行后，打开那条任务的工作目录，看 `issue-ops.log`。

⚠️ 它刻意**只往工作目录写一个文件**：范例不该在你的机器上动别的东西。
