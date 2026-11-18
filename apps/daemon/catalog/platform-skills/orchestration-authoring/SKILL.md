---
name: 编排代码写法
description: 编排原语的签名与语义（agent / gate / flow / parallel / loop / route）、Reply 的形状、{{task}} 的含义、几种常见流程的写法与踩坑。平台内置，挂给「编排生成者」，保证它写出来的代码真的能跑。
---

# 编排代码写法

给「编排生成者」用：把一段流程写成**平台能执行的编排代码**。

## When to Use

起草 `workflow-draft.md` 正文（编排代码）之前——凡是"这句话怎么写、这段能不能这么接"，都照这份来。

## Procedure

### 1. 代码是一个 async 函数体

- 里层就是 **JavaScript**，可以用 `const` / `if` / 模板字符串 / 数组方法，**顶层可以直接 `await`**。
- **只有六个原语在作用域里**：`agent` / `gate` / `flow` / `parallel` / `loop` / `route`。
  没有 `import`、没有 `require`、没有 Node 的文件读写、没有网络、没有定时器——
  要读文件或查东西，交给某个 `agent()` 去做。
- 代码里**不许**出现 `inline:` 这类内嵌智能体写法（引擎里没有这个原语）。

### 2. 六个原语的签名

```js
agent(名字)                      // 变成一个可执行的 Handle；名字必须真存在（见 §5）
agent(名字, 判定函数)             // 同上，但它能被放进 loop 的**把关者位**
gate('给用户看的文案')            // 等人拍板；人点通过 = pass，否决 = fail
flow([甲, 乙, 丙], '任务书')      // 接力：依次执行，产物由引擎接力给下一个人
parallel([甲, 乙], '任务书')      // 并行：**返回 Reply 数组**（不是 Handle）
loop(执行者, 把关者, '任务书', { maxRounds: 3 })   // 不通过 ⇒ 带意见重写，最多 maxRounds 轮
route({ 标签: handle }, '任务书') // 按人选的标签走一个分支
```

第三个参数可以**直接给选项对象**（此时任务书用默认的 `'{{task}}'`）：

```js
await loop(撰稿, gate('这版可以发了吗'), { maxRounds: 3, reuseOutput: true })
```

`parallel` 的选项：`{ concurrency: 2 }`（最多同时几条）。`flow` 的选项：`{ returnIndex: 1 }`。

### 3. 产物怎么在步骤之间流动

- 每次 `agent()` 执行 = **一条 run**，它的产出是**文本**；`await handle` 得到的是 Reply。
- `flow` 会自动把上一个人的产出交给下一个人（你不用拼）。
- 要**自己拼**的时候（并行结果汇总、条件拼接），从 Reply 里取文本：

```js
const 几路 = await parallel([甲, 乙], '{{task}}')
const 材料 = 几路
  .map((r) => (typeof r.message === 'string' ? r.message : ''))
  .filter((s) => s.trim() !== '')
  .join('\n\n')
await flow([汇总], '把下面几路材料整理成一份：\n\n' + 材料)
```

- Reply 的形状：`{ result: 'done' | 'pass' | 'fail', message?: string, guard?: Reply }`。
  执行者回 `done`，把关者回 `pass` / `fail`。

### 4. `'{{task}}'` 是什么

**运行时由人填的那句话**（他在「运行」对话框里写的任务描述）。写代码时原样写这个占位符，
不要自己编内容。需要加前缀就用字符串拼接：

```js
await flow([汇编码], '这是一次发布前检查。任务：\n\n{{task}}')
```

### 5. 两种把关者（这是最容易写错的一处）

| 谁来判 | 怎么写 | 什么时候用 |
|---|---|---|
| **机器判** | `agent('审查员', (意见) => 意见.includes('不通过') ? { result: 'fail', message: 意见 } : { result: 'pass' })` | 有明确标准（有没有跑测试、格式对不对） |
| **人判** | `gate('请过目：这版可以发了吗')` | 价值判断、要签字、要发给别人之前 |

⚠️ **不带判定函数的 `agent('审查员')` 不能当把关者**——它只会回 `done`，
平台在提交任何 run 之前就会拒（"把关者不会判"）。要么给判定函数，要么用 `gate`。

⚠️ **人判要配 `reuseOutput: true`**：否则进 `loop` 的第一步会**先把执行者重跑一遍**，
人看到的就不是他刚确认过的那一版。

### 6. 常见形状（照抄再改名字）

**① 两步接力 + 人放行**

```js
const 取数 = agent('数据员')
const 撰稿 = agent('撰稿员')
await flow([取数, 撰稿], '{{task}}')
await loop(撰稿, gate('这版可以发了吗？不满意请说明，我会打回重写'), {
  maxRounds: 3,
  reuseOutput: true,
})
```

**② 写完自动复查，过了再给人看**

```js
const 开发 = agent('开发')
const 复查 = agent('代码审查员', (意见) =>
  意见.includes('不通过') ? { result: 'fail', message: 意见 } : { result: 'pass' })
await loop(开发, 复查, '{{task}}', { maxRounds: 3 })
await loop(开发, gate('改完了，请过目'), { maxRounds: 2, reuseOutput: true })
```

**③ 并行查 → 汇总 → 人决定**

```js
const 甲 = agent('调研员甲')
const 乙 = agent('调研员乙')
const 汇总 = agent('报告撰写员')
const 两路 = await parallel([甲, 乙], '{{task}}')
const 材料 = 两路.map((r) => r.message ?? '').filter((s) => s).join('\n\n')
await flow([汇总], '把下面几路材料整理成一份报告：\n\n' + 材料)
await loop(汇总, gate('报告可以发了吗'), { maxRounds: 3, reuseOutput: true })
```

**④ 单独等人拍板**

```js
await flow([某人], '{{task}}')
await gate('结果在上面。确认后你自己继续；不满意就把意见写在这里')
```

### 7. 踩过的坑

- **名字必须真存在**：`agent('…')` 里的名字要是智能体页里真实的那个（采纳时会校验，
  对不上会被拒）。不确定就问用户，不要编。
- **每一步都是一条 run**：跑一次花一次额度，也占一个并发位。三步以内最常见；
  能并行的别串行，能用 `gate` 就别再拉一个人来"点点头"。
- **同一个工作目录**：整条编排在同一个目录里跑，步骤之间靠**产出文本**接力，
  不要假设上一步把文件写好了（要看文件就让 agent 自己去读）。
- **代码只有几十行**：它是"流程"，不是程序。复杂逻辑留给某个 agent 去做。
- 写法上跟平台的其它代码一致：**中文标识符可以**（`const 撰稿 = …`），
  但 `agent('…')` 里必须是**真实的智能体名字**。
