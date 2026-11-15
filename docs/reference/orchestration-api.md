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
- **失败不产 Reply**：执行失败是 run 级状态（`run.status = failed`）。

### 2.3 EngineHooks（执行侧注入——与 daemon 解耦）

```ts
interface EngineHooks {
  submit: (step, prompt, opts?) => Promise<{ ok, runId, error?, output?, reviewPass? }>
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
| `loop` | `loop(executor: Handle, guard: Handle, prompt?: string, opts?: { maxRounds? }) => Handle` | 把关循环：每轮执行者 run → 把关者 Reply（pass 出 / fail 重写/意见附加）→ 超轮兜底（返回 fail，run 不挂） |
| `route` | `route(map: Record<string, Handle>, prompt?: string) => Handle` | 关键字路由（无命中 = 第一个） |

**prompt 全部可选**（默认 `{{task}}`）。

### 3.1 loop 的输出语义（使用者拍板）

```
成功（pass 出循环）   → { result: 'done', message: 执行者的返回, guard: 最后审核者 }
超轮仍 fail（兜底）   → { result: 'fail', message: 执行者的最后返回（仍可用）, guard: 最后审核者（打回理由） }
```

**message 永远是执行者的返回**（fail 时也能用——"不好但可用"的半成品）；
审核意见看 `结果.guard?.message`。超轮不弄挂 run——编排代码自己兜底。

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
| loop | ↻ 轮次（写作员→审查员意见） | 循环、把关意见、确认面板 |
| gate | ✋ 等确认 | 人机回环 |
| route | 🔀 判定 → 选中 | 决策可见 |

**保留 5 个原语**（flow/parallel/loop/route/gate）——结构即界面；聚合是
组合（parallel + JS 拼 + flow 单 agent）。

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
- **把关者位**：agent 把关者提交**审核 run**（kind=review + subject=执行 run）——
  与 autoChainReview 同一套反查规则（界面「审查员意见」反查成立）；审核 run
  不进 step.runIds。
- **daemon 接线**：`apps/daemon/src/workflows.ts` 只留类型/模板/存储并
  re-export 引擎；`server.ts` 的 `launchWorkflowRun` 用 `EngineHooks` 注入
  submitStep/等人/持久化。

## 6. 变更（v2 → v5）

- 引擎从 daemon 抽到独立包（解耦）。
- `new Function` → `AsyncFunction`（编排代码可用 await）。
- 惰性 Handle（await 才执行）——v2 的"忘 await 兜底"删除（不 await = 不跑）。
- Reply 统一（result/message/guard）——await 返回 Reply（一层访问）。
- 把关者位提交审核 run（review）——界面兼容。
- 步骤模型保守复用 v2（flow/loop 一步 + runIds）。
- **旧编排数据（v2 写法）不兼容**——需按 v5 写法重写（模板已更新）。
