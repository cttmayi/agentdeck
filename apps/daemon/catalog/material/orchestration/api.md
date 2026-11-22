# 编排代码怎么写（给「编排生成者」的 playbook）

> **先读这一份再动笔。** 这里是"现在这一版的写法"，与 `packages/orchestration/src/primitives.ts`
> 同源；设计细节与契约见仓库里的 `docs/reference/orchestration-api.md`。
> 版本：**v5**（`api-version.json` 里是同一条事实）。

## 0. 你要产出的东西（存储形状）

```
workflow-draft/<编排名>/
  workflow.json        { "name": "周报流水线", "summary": "取数→成稿→你过目" }
  main.js              编排代码（就是一个 async 函数体）
  agents/<名字>/       这一步用到的人——**你自己写**，不用先去库里找
    agent.json         { "name": "写作员", "runtimeKey": "default" }
    instructions.md    这个人的指令（他是谁、怎么干、按什么标准）
    skills/<技能>/SKILL.md   可选：给这个人写一份只属于他的技能
```

- `id` / `source` / 时间戳由平台在你点「收进编排库」时补，**你不要写**。
- 名字可以用中文（`写作员`、`周报流水线`）。
- 代码里 `agent('写作员')` 只能引用 `agents/` 下**你自己写的**那个名字；写错名字，入库会被拒并点名。

## 1. 代码的形状

`main.js` 是**一个 async 函数体**：可以直接 `await`、可以用 `const` / `if` / 模板字符串 / 数组方法。

**作用域里只有六个名字**（没有 `import`、没有 `require`、没有文件读写、没有网络、没有定时器）：

```js
agent      // 引用一个人：agent('名字') 或 agent('名字', 判定函数)
gate       // 人拍板：gate('请过目…')
flow       // 接力流水线：flow([甲, 乙], '{{task}}')
parallel   // 并行：parallel([甲, 乙], '{{task}}') 或 parallel(甲, ['任务1','任务2'])
loop       // 把关循环：loop(执行者, 把关者, { maxRounds, reuseOutput })
route      // 按关键字路由：route({ 关键词: 人, … }, '{{task}}')
```

`{{task}}` 是**这次运行**填的任务描述（唯一占位符）；不传 prompt 时默认就是它。

**惰性**：构造器只造句柄、不执行；`await` 才跑。**不 await = 不跑。**

## 2. 结果形状（Reply）

`await` 任何原语都得到一个 Reply：

```js
{ result: 'done' | 'pass' | 'fail', message?: string | string[], guard?: Reply, … }
```

- 执行者是 `done`，把关者是 `pass` / `fail`；
- **产出在 `结果.message`**（一层访问，`message` 可能是数组）；
- `loop` 失败（超轮）时 `结果.message` 仍是执行者最后一版产出，**打回意见在 `结果.guard?.message`**。

## 3. 四种常见写法（照抄再改）

### 3.1 接力

```js
const 取数 = agent('数据员')
const 成稿 = agent('写作员')
const 终稿 = await flow([取数, 成稿], '{{task}}')
return 终稿.message
```

### 3.2 机器把关（把关者**必须能判**）

```js
const 写作 = agent('写作员')
const 审查 = agent('审查员', (意见) => ({
  result: /通过|没问题/.test(意见) ? 'pass' : 'fail',
}))
const 结果 = await loop(写作, 审查, '{{task}}', { maxRounds: 2 })
if (结果.result === 'fail') return '两轮都没过：' + (结果.guard?.message ?? '')
return 结果.message
```

⚠️ `agent('审查员')` **不带判定函数**放进 `loop`，运行时会当场报错——把关者"不会判"这件事平台不猜。

### 3.3 人拍板（不让他刚审过的版本被悄悄换掉）

```js
const 写作 = agent('写作员')
const 机器审 = agent('审查员', 判定)
await loop(写作, 机器审, '{{task}}')
// 人把关：第一轮**不重跑写作**，直接把他刚审过的那版摆上来
const 人审 = await loop(写作, gate('文章已完成，请过目；不满意就写意见'), {
  maxRounds: 3,
  reuseOutput: true,
})
```

### 3.4 并行调研

```js
const 甲 = agent('调研员甲')
const 乙 = agent('调研员乙')
const [a, b] = await parallel([甲, 乙], '{{task}}')   // 返回值是 Reply 数组
```

## 4. 五条最容易踩的坑

1. **执行失败会抛错**，不会给你一个"失败但看起来像产出"的 Reply。
   想"这步失败也继续"就自己 `try { … } catch (e) { … }`；不接 ⇒ 整条编排 `failed`。
2. **`parallel` 返回数组**，`flow` 返回最后一个的 Reply——`await` 之后取 `message` 前先想清楚是哪种。
3. **同一个 Handle 可以反复用**（`loop` 的每一轮都是它）；想"新会话重来"用 `agent('X', { resume: false })`。
4. **把关者不能是复合 Handle**（flow/parallel/loop/route）——它们的结果不是 pass/fail。
5. **不要写 `inline()`**：没有这个原语。要新的人就写进 `agents/`，然后在代码里 `agent('名字')`。

## 5. 写完之后

在聊天里说清楚三件事：**几步**、**每步谁干**、**哪一步要人确认**；然后请用户点「**收进编排库**」。
你**不**入库——入库只有人那一按。
