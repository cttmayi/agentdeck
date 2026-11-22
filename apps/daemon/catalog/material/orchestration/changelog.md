# 变更记录（编排写法）

## v5（当前）

- 五个原语（`flow/parallel/loop/route/gate`）+ `agent`；**`aggregate` 已删除**（聚合 = parallel + JS 拼 + flow 单 agent）。
- **惰性**：构造器不执行，`await` 才跑；不 await = 不跑。
- **Reply 一层**：`结果.message` 直接拿产出（`guard` 是 loop 最后审核者）。
- **执行失败抛错**（不再"done + 一句错误文本"）——可以自己 `try/catch` 接住。
- **把关者必须能判**：`agent(名字, 判定函数)` 或 `gate(...)`；不带判定函数的 `agent` 放进 loop 会当场报错。
- **人把关用 `reuseOutput: true`**：第一轮不重跑执行者，直接送审上一版。
- `loop` 超轮不挂 run：返回 `fail`，执行者最后产出仍在 `message`。

> ⚠️ v2 的写法（`aggregate`、已 await 的句柄当参数、`{{prev}}` 占位符）**不再支持**。
