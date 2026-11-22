# 编排 API（v5）——设计、契约与实现

> 2026-11 定稿（使用者逐条拍板）。编排引擎在独立包
> **`@agentdeck/orchestration`**（`packages/orchestration/`）——与界面/daemon
> 完全解耦（执行侧以 `EngineHooks` 注入）。本文是正式规格：设计原则、契约、
> 原语、行为、界面、主流对比与实现说明。

## 1. 设计原则

1. **万物皆 Agent（万物皆 Execute）**：执行者、审核者、判定者、人、控制流
   都是"可执行单元"（`Handle`）——一个类型，`run` 闭包一切执行逻辑。
2. **三层分离**：`Handle`（可执行单元——惰性）/ `await`（执行）/ `Reply`（结果）。
3. **惰性**：构造器不执行；`await handle`（thenable）才执行——**不 await = 不跑**
   （没有"忘 await"魔法，语义明确）。
4. **全 JS 显式传参**：`报告.message` 写在哪、传在哪——不做隐式管道、不做
   `{{prev}}` 占位符；唯一占位符是 `{{task}}`（任务动态注入）。
5. **flow 内部自动接力**：一条链内 agent 之间零传参（链的语义）。
6. **把关循环是一等公民**：`loop(执行者, 把关者)`——评估者-优化者模式
   （Anthropic 经典模式之一）做进原语——把关者两态：AI 判定（代码）或人（gate）。
7. **kind 就两项**（pass/fail）+ 超轮兜底——loop 简单；其他值报错。

## 2. 契约

### 2.1 Handle（可执行单元）

```ts
interface Handle {
  run: (input: string, opts?: { review?: boolean; subjectRunId?: string }) => Reply | Promise<Reply>
  label?: string          // 展示（界面/运行画面）
  reset?: () => void      // 运行时重置（复合 Handle 递归重置内部所有 agent）
  then?: (resolve, reject?) => void  // thenable：await handle 触发执行
}
```

- **惰性**：构造器返回 Handle 不执行；`await` 才跑。
- **编排代码的返回值没有去处**（D261）：引擎 `await fn(...)` 之后把返回值丢掉——产出只认
  **每一步 run 的产出**（`WorkflowRun.steps`）。所以在 `main.js` 里 `return '…'` 拼一段话
  什么也不会发生（写法合法、语义为空），这类"看起来在交付"的代码由候选校验提示出来
  （`checkCandidateCode().topLevelReturns`，warn 级）。
- **不展示/不调用的全闭包**：lastRunId（resume 锚点）、resume 开关、判定/
  解析函数、智能体名、gate 文案、循环逻辑——都在 `run` 闭包里。
- **复合 Handle**（flow/parallel/loop/route 的返回值）：`run` 是复合执行
  （可重跑——嵌套用），`reset` 递归。

### 2.2 Reply（执行结果）

```ts
interface Reply {
  result: 'done' | 'pass' | 'fail'   // 执行者 done；把关者 pass/fail
  message?: string | string[]        // 产出文本（可数组——代码执行转出的数据源）
  guard?: Reply                      // loop 专用：最后审核者的返回
  [k: string]: unknown               // 信息载荷（score 等）——不挂 Handle
}
```

- **所有原语 `await` 后都是 Reply**（一层访问：`结果.message`）。
- **失败不产 Reply**：执行失败**抛错**（步骤 `failed`、整条编排 run `failed`）——见 §3.5。

### 2.3 EngineHooks（执行侧注入——与 daemon 解耦）

```ts
interface EngineHooks {
  submit: (step, prompt, opts?) => Promise<{ ok, runId, error?, output? }>
  waitForGateConfirm: (step) => Promise<{ kind: 'passed' } | { kind: 'rejected', feedback: string }>
  persist: (run) => Promise<void>
  waitIfPaused: () => Promise<void>
}
```

## 3. 原语

| 原语 | 签名 | 语义 |
|---|---|---|
| `agent` | `agent(name, run?, opts?: { resume? }) => Handle` | 引用现有智能体（LLM 执行）；`run` = 代码执行（把关判定/产出解析，语义由使用位置决定） |
| `gate` | `gate(text) => Handle` | 人把关者（界面确认/否决）；thenable（`await gate()` 独立等待） |
| `flow` | `flow(agents: Handle[], prompt?: string, opts?: { returnIndex? }) => Handle` | 一条流水线：内部接力（第一个吃 prompt，后续收上一步产出）；`returnIndex` 支持负数（-1 最后、默认 -1） |
| `parallel` | `parallel(agents: Handle \| Handle[], prompts?: string \| string[], opts?: { concurrency? }) => Handle[]` | 并行：prompts×agents（1×N 广播 / N×N 派发 / N×1 多任务 / 不匹配报错）；**thenable 数组**（`await` → Reply[]） |
| `loop` | `loop(executor: Handle, guard: Handle, promptOrOpts?: string \| { maxRounds?, reuseOutput? }, opts?) => Handle` | 把关循环：每轮执行者 run → 把关者 Reply（pass 出 / fail 重写/意见附加）→ 超轮兜底（返回 fail，run 不挂）。**`reuseOutput: true`：第一轮不重跑执行者**，直接拿上一版产出送审（人把关用它，见 §3.5） |
| `route` | `route(map: Record<string, Handle>, prompt?: string) => Handle` | 关键字路由（无命中 = 第一个） |

**prompt 全部可选**（默认 `{{task}}`）。

### 3.1 loop 的输出语义（使用者拍板）

```
成功（pass 出循环）   → { result: 'done', message: 执行者的返回, guard: 最后审核者 }
超轮仍 fail（兜底）   → { result: 'fail', message: 执行者的最后返回（仍可用）, guard: 最后审核者（打回理由） }
```

**message 永远是执行者的返回**（fail 时也能用——"不好但可用"的半成品）；
审核意见看 `结果.guard?.message`。超轮不弄挂 run——编排代码自己兜底。

### 3.5 人把关：`reuseOutput`（D134）

**问题**（使用者真机编排）：① 机器把关跑完，② 让人把关时——

```js
const 写作 = agent('文章写作员')
await loop(写作, agent('审查员', 判定), '{{task}}')                  // ① 机器把关
await loop(写作, gate('请过目…'), '{{task}}', { maxRounds: 3 })      // ② 人把关
```

② 一进来就**先把「写作」跑一遍**（loop 的骨架是"先执行再把关"）⇒ 使用者刚在 ① 里审过的
那一版**被悄悄换成新写的一版**，人确认的不是他看过的东西；而且白花一次额度。
使用者原话："用户确认的 loop 由于'写作'先执行，导致有重新写的嫌疑"。

**修法**：给 loop 一个开关

```js
// ③ 个参数直接给 opts 也行（prompt 用默认的 {{task}}）——新增的写法，最常用
await loop(写作, gate('文章已完成，请过目…'), { maxRounds: 3, reuseOutput: true })

// 想自己写重写轮的任务书，就还是位置参数
await loop(写作, gate('文章已完成，请过目…'), '{{task}}', { maxRounds: 3, reuseOutput: true })
```

`'{{task}}'` 在**重写轮**才用得上（执行者收到的 = 原任务 + `[打回意见] 人的意见`）；
第一次送审完全不经过它——所以用默认就行。

语义：
- **第一轮不提交执行 run**：拿执行者最近一次产出（`Handle.lastOutput`）送进把关。
  通过 ⇒ 这一步 `done`；否决 ⇒ 带着意见真跑一轮重写，再问一次，最多 `maxRounds` 次；
- 执行者还没有任何产出（比如 ① 没跑）⇒ **自动退化成"照旧先执行"**，不会拿空材料去问人；
- ⚠️ 只作用于第一轮（否决之后当然要真写）。

配套：步骤上新增 `rounds: [{ runIds, gate }]`（只有 loop 写）。因为第一轮没有执行 run，
界面靠 `runIds` 两两配对会把"第 2 轮的执行"当成"第 1 轮的把关"；有了 `rounds`，
运行画面直接照它画（老数据没有这个字段 ⇒ 退回配对）。

### 3.2 嵌套（惰性句柄）

```js
// 嵌套 = 未 await 的 Handle 作参数（外层执行时调内层 run——内层第一次执行在外层需要时）
await loop(loop(写作, 审查), gate('请过目'))
// 外层 fail → 内层整体重跑（内层 run 再调用）——内层把关结论自己消化，
// 跨层只传完成产物
```

**边界**：把关者位不能放复合 Handle（loop/flow 输出 done 不是 pass/fail——报错）；
已 await 的 Handle 再嵌套会重跑（浪费——展示可见）。

### 3.3 resume（agent 的 run 闭包行为，不是句柄字段）

| 写法 | 行为 |
|---|---|
| `agent('X')`（默认） | 每轮 resume（续上一版） |
| `agent('X', { resume: false })` | 每轮 new 会话 |
| `X.reset()` | 运行时重置（复合 Handle 递归） |

### 3.4 界面展示（每个原语在运行画面）

| 原语 | 画面 | 展示价值 |
|---|---|---|
| flow | 链（①→②→③） | 链式流程，每步可展开 |
| parallel | 扇出（分支独立） | 并行等待、分支产出 |
| loop | ↻ 轮次（执行者 → 把关者意见） | 循环、把关意见、确认面板 |
| gate | ✋ 等确认 | 人机回环 |
| route | 🔀 判定 → 选中 | 决策可见 |

**保留 5 个原语**（flow/parallel/loop/route/gate）——结构即界面；聚合是
组合（parallel + JS 拼 + flow 单 agent）。

### 3.5 失败语义（2026-11 硬闸，D119）

**执行 run 没跑成 ⇒ 抛错，不产 Reply**（不是"done + 一句错误文本"）：

| 情形 | 结果 |
|---|---|
| 子 run 以 `failed` / `cancelled` 收口 | `throws Error('执行失败：<原始失败原因>')`；步骤 `failed`；**整条编排 run `failed`**，`run.error` 带原因 |
| 被审 run 没跑成，或产出为空 | 平台**不提交审核**（`checkReviewable`）：`throws` 同上，行进方向与上一行一致 |
| 编排代码自己接住 | `try { await flow([…]) } catch (e) { … }` —— 抛错可被使用者代码接住，写完 `catch` 流程就能继续 |

为什么不是"返回 done 让编排自己看 message"：以前正是那样，于是 loop 把一句失败原因
当成了执行者产出，接着把那条 **failed、产出为空** 的 run 交给把关者去审——真机上
一次被判「不通过」（写作员被拖去重写），另一次对同样的空材料判「通过」，
编排把没跑成的一步当通过往下跑。**静默吞掉失败比制造一个新错误更糟**。

### 3.6 把关者必须能判（2026-11，D121）

| 把关者 | 能判吗 | 说明 |
|---|---|---|
| `agent('审查员', (意见) => …)` | ✅（`parser`） | 解析函数把审核意见变成 `{ result: 'pass' \| 'fail' }`；`'done'`/其他值 ⇒ 报错 |
| `gate('请你过目')` | ✅（`human`） | 人确认 |
| `agent('审查员')`（没有解析函数） | ❌（`none`） | **在提交任何 run 之前**就报错，并说明两条改法——不再先跑一轮执行 + 一轮审核才抛「未知结果」 |
| 复合 Handle（flow/parallel/loop/route） | 缺省 | 不猜；仍由运行时的「把关者输出了不认识的结果」兜底 |

**为什么在这里就拒**：把关者不带解析函数时回复永远是 `result: 'done'`（执行者语义）。
以前 loop 会先把执行 run 跑出来、再提交审核 run（真金白银的额度），最后才抛一句
「把关者输出了不认识的结果 result=done」——使用者看到的是一句看不懂的错误，
而真正的问题是"没给判定方式"。现在错误发生在**第一次提交之前**，且直接说怎么改。

**`reviewPass` 已删**：`StepSubmitResult.reviewPass` 曾经被生产、从未被消费。编排审核 run
走的是"没有判决契约"的路（`first-sentence.ts` 的 workflow 分支不渲染 `{{verdict}}`，
判定在编排代码里），那条通路永远拿不到判决 ⇒ 字段恒为 `false`。留着它只会让人以为
"不带 parser 也能过"。契约里标成 `?: never`，误用当场编译失败。

### 3.7 步骤的生命周期（运行画面说真话，D121）

每个跑过的步骤都要**收口**，否则画面会撒谎：

| 阶段 | 谁写 | 写什么 |
|---|---|---|
| 开始 | 步骤的**拥有者**（独立 `agent`/`gate`/`flow`/`parallel` 分支/`loop`/`route`） | `status: 'pending' → 'running'`、`startedAt`；**只在第一次**过一次步骤边界（`atBoundary` ⇒ `waitIfPaused`） |
| 收口 | 同上 | `status: 'done'`、`finishedAt` |
| 失败 | 执行 run 没跑成 | `status: 'failed'` + 抛错（§3.5） |

**以前只有 `loop`/`gate` 写状态**：`flow`/`parallel`/`route`/独立 `agent` 的步骤从头停在
`pending`——run 都 `done` 了，运行画面上那几步还写着"未开始"。顺带发现 `env.atBoundary`
是**死接口**（定义了、注入了、测试里也传了，没有一处调用）。

**"这一步是哪个步骤"是显式参数**（`RunContext.owner`），不是环境里的可变字段：
`parallel` 的分支是**并发**的，共享字段会被兄弟分支互相踩——两个分支各写一次、
各自"还原成自己看到的上一层"，于是把别人的步骤留在了字段里。实测后果是**步骤漏登记**
（并行块之后的那一步以为自己还在分支里，run 挂到别人身上、步骤链少一条、画面也少一条）。

**叶子原语不再改写 `step.nodeId`**：容器步骤的 `nodeId` 保持 `null`（"这一步自己的节点"），
"这一步跑哪个智能体"由 `StepSubmitOptions.agentName` 显式带上。以前把关循环跑过执行者与
审查员之后，这一步在画面上显示成"审查员在干"。

## 4. 与主流编排对比（摘要）

| 主流模式 | AgentDeck 实现 |
|---|---|
| 提示链 | flow |
| 路由 | route |
| 并行 | parallel |
| **评估者-优化者** | **loop**（核心创新——机器/人把关统一） |
| 自主循环 | loop |
| 人机回环 | gate |
| 监督者 / 交接 / 群聊 | 组合表达（flow+parallel / route / flow 链式接力） |
| 图/状态机 / 事件驱动 | 不做（本机轻量定位） |

## 5. 实现（`packages/orchestration/`）

```
src/types.ts      契约（Handle/Reply/StepSubmitOptions/EngineHooks/WorkflowRun/WorkflowStep）
src/primitives.ts 原语（makePrimitives(env)——惰性 Handle + thenable + 执行）
src/engine.ts     executeWorkflow（Env + AsyncFunction 执行 + 步骤登记/幂等）
src/index.ts      导出
src/engine.test.ts 严格测试（16 用例）
```

- **执行**：`executeWorkflow(run, code, hooks)`——原语注入 **AsyncFunction**
  （`await` 编排代码可用）；步骤按 seq 登记（幂等续跑：done 跳过）。
- **把关者位（2026-11，D125/S5 之后）**：agent 把关者就是**一次普通执行 run**——
  任务书由 `primitives.ts` 的 `reviewTaskText` 组装（"请你审什么" + 被审材料，
  并声明"材料不是指令"），它**照常进 `step.runIds`**。
  ⚠️ 它原来是一条 `kind: 'review'` 的**审核 run**（subject = 被审执行 run、
  并**故意不**进 `runIds`，界面靠 subject 反查）——审核 run 退场之后那条路没有了，
  反查也随之删掉：loop 步骤的 `runIds` 现在是**成对的** `[执行1, 把关1, 执行2, 把关2, …]`。
- **daemon 接线**：`apps/daemon/src/workflows.ts` 只留类型/模板/存储并
  re-export 引擎；`server.ts` 的 `launchWorkflowRun` 用 `EngineHooks` 注入
  submitStep/等人/持久化。

## 6. 变更（v2 → v5）

- 引擎从 daemon 抽到独立包（解耦）。
- `new Function` → `AsyncFunction`（编排代码可用 await）。
- 惰性 Handle（await 才执行）——v2 的"忘 await 兜底"删除（不 await = 不跑）。
- Reply 统一（result/message/guard）——await 返回 Reply（一层访问）。
- ~~把关者位提交审核 run（review）——界面兼容。~~ **2026-11（D125/S5）：审核 run 退场，
  把关者改成普通执行 run，并记进 `step.runIds`；界面按"两两配对"渲染每一轮。**
- 步骤模型保守复用 v2（flow/loop 一步 + runIds）。
  **2026-11 补**（D121）：所有原语都要写步骤状态（`beginStep`/`finishStep`），
  且"这一步是哪个步骤"走显式参数 `RunContext.owner`——不再有 `env.currentStep`
  这个共享可变字段（并发分支会互相踩 ⇒ 漏登记步骤）。
- **旧编排数据（v2 写法）不兼容**——需按 v5 写法重写（模板已更新）。

## 7. AI 生成编排（编排生成者，D135）

> ★ 生成者**实际照着写的那份**是「资料包」（2026-11，D255 起；D143 那份独有技能已退役）：
> [`docs/material/orchestration/api.md`](../material/orchestration/api.md)
> ——签名、Reply 形状、`{{task}}`、两种把关者、四种可抄写法、五个坑。
> 平台在**每次对话前**把它覆盖写进工作目录的 `material/orchestration/`（源在 `docs/material/`，
> 与 `catalog/material/` 逐字节同步，`tests/material-sync.test.ts` 钉着）。
> 一致性由 `apps/daemon/src/material-orchestration.test.ts` 盯着——**api.md 与 examples/ 里
> 每段代码都能被编译通过**、六个原语一个不少。
> 本节讲"为什么这样设计"，那份讲"怎么写"。

编排代码是**人写的字符串**（§1），所以"让 AI 帮我写"一直是个自然的入口，但
2026-11 之前它只有一句"二期再说"，代码里只留了一个**没人产出的枚举值**
（`Workflow.source: 'ai'`：字段、类型、界面徽标都在，没有任何路径写得进去）。
D135 把它接活了，办法是**照抄「智能体生成者」那条已经踩过坑的链**：

```
编排页「AI 生成…」
  → 聊天页（预选内置「编排生成者（内置）」）
  → 生成者问清「几步、每步谁干、哪一步要人拍板」
  → 写 workflow-draft/workflow-draft.md
      frontmatter: name（必填）/ summary（可选）
      正文 = 编排代码（允许包在 ```js 围栏里）
  → 聊天页栏头出现「确认采纳编排」（= 对话详情 hasWorkflowDraft 为真）
  → 对话框里改名字/改代码 → 采纳
  → 一条真编排（source: 'ai'）→ 运行仍然由人点
```

**为什么采纳前才校验、而不是边写边校验**：草稿是给**人改**的初稿，边写边校验会把
"写到一半的代码"当成错误刷屏。采纳是唯一会产生后果的那一下，校验就放在那里。

三道校验（`apps/daemon/src/workflow-maker.ts` 的 `validateWorkflowCode`）：

| 判据 | 怎么判 | 失败时 |
|---|---|---|
| **语法** | `new AsyncFunction(...WORKFLOW_PRIMITIVES, code)` —— 与 `engine.ts` 执行用户代码**同一条构造路径**，但**只构造不调用**（不提交任何 run） | 400 `workflow_code_syntax` |
| **节点名** | 正则抓 `agent('字面量')`，名字必须在**现有智能体**里（引擎提交那一步就是按名字找人） | 400 `workflow_code_unknown_agent` + `unknownAgents` |
| **名字** | frontmatter `name` 非空、≤100 | 400 `workflow_draft_invalid` |

⚠️ **拼出来的引用不拒绝**：`agent(变量)`（比如按模块名循环）数不清，落进响应的
`unverifiable` 如实说。宁可少校验，也不要把好好的代码拒掉——这条与本仓库
"过滤器写等值"的纪律同一个来由：**放不过去的东西比放过去了更伤人**。

⚠️ **`reuseOutput` 是给人把关用的**（§3.5）：生成者写出来的代码里，`loop(某人, gate('…'))`
建议带 `{ reuseOutput: true }`，否则"人刚看过的那一版"会在进 loop 时被重写一遍。
生成者的指令里写着这一条。
