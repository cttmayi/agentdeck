# 界面风格规则（写界面之前先读这一份）

> 👤 **给写/改界面的人**：这里只有**规则**——控件长什么样、去哪拿类名、什么不许自己画。
> "为什么是这么定的""现状体检的数字"在 [`style-audit.md`](./style-audit.md)，那是一个 snapshot，
> 不要当规则读。令牌与类定义**只有一处**：`packages/ui/src/styles/app.css`。
>
> 一句话总纲：**同一个东西在哪个页面都得长得一样**；页面只决定"放什么、放在哪"，不决定"长什么样"。

---

## 0. 三条硬规则（其余都是这三条的展开）

1. **能决定"长什么样"的属性都显式写**：`color` / `font-size` / `background` 不许靠从容器继承。
   同一个类挂在不同页面里，祖先链不同就会长出两种样子——而样式表里搜不出任何差异
   （314/315 批就是这样踩的：`.detail-head h2` 与 `.detail-sub` 都没写 `color`，
   聊天栏的标题比任务栏淡一档、副标题又另一种灰）。
2. **不写裸值**：字号、圆角、间距、颜色一律走令牌（`var(--fs-*)` / `var(--radius*)` / `var(--sp-*)` /
   主题色令牌）。裸 `px`/`rem`/`#hex` 只在 `app.css` 里、且下面有明确例外的地方出现。
3. **不在组件里重定义全局控件**：按钮/输入/徽标/卡片这几种形状，`app.css` 里已经有一份。
   组件里 `:global(.btn) { ... }` 或再造一个 `.my-button { padding/border-radius/background }`
   都是同一类缺陷——改配色时必然漏掉它。
4. **加新控件 = 先抽象再加**：界面里出现第二种"看起来一样、写得不一样"的东西时，
   先把它收进 `app.css` 的某一族，再在页面里用；不给自己开小灶。

`pnpm run check` 里有一条**静态护栏**（`tests/ui-style.test.ts`）专门抓违反这三条的改动。
它报错时不要绕过——绕过一次，下一个页面就又有理由抄一遍。

---

## 0.1 排版七条（看这一张表就够了）

"东西多大、留多少、多密、一行多宽"全在这七条里，每一条**只有一个数**（或一个"三连"），
都落在 `app.css` 的 `:root` 令牌上。改了数就改令牌，页面里不许另写一个。

| 主题 | 令牌 | 值（px） | 谁用它 | 细则 |
|---|---|---|---|---|
| 控件高度 | `--ctl-h` | 30 | 按钮、`input`、`select`（一处三件同一套） | §2.1.1 / §2.1.2 |
| 工具条轨道 | `--rail-h` | 34 | 顶栏那排 / 栏头那排 / 对话头 / 来源切换（= 控件高 + 4px 内距） | §2.1.1 |
| 表格单元格内距 | `--pad-cell` | 12/12 | 表格数据行 `td` 上下 | §2.2.2 |
| 表格表头内距 | `--pad-cell-head` | 8/12 | 表格 `th` 上下 / 左右 | §2.2.2 |
| 列表行高 | `--list-row-min-h` | 64 | 任务 / 智能体 / 聊天三页的列表行 | §2.2.2 |
| 页面内距 | `--pad-page` | 24/32 | `.main`（窄屏收到 16） | §2.2.1 |
| 面板 / 浮层的头 | `--pad-frame-head` | 16/24/12 | 栏头、面板头、详情栏头、抽屉头、模态头 | §2.2.1 |
| 面板 / 浮层的体 | `--pad-frame-body` | 16/24 | 同上那一族的 body | §2.2.1 |
| 面板 / 浮层的脚 | `--pad-frame-foot` | 12/24 | 同上那一族的 foot | §2.2.1 |
| 正文档字号 | `--fs-base` | 14 | `body`、`.markdown`、`.bubble`（agent 产出也算正文） | §2.9.1 |
| 说明 / 控件字号 | `--fs-sm` | 13 | `label`、`.btn`、`input`、`.table`、`code` | §2.9.1 |
| 元信息字号 | `--fs-xs` | 12 | `.list-row-sub`、`.badge`、`.nav-hint` | §2.9.1 |
| 标签字号 | `--fs-2xs` | 11 | `.badge--sm`、轨道里的极小格子 | §2.9.1 |
| 标题字号 | `--fs-lg` / `--fs-md` / `--fs-sm` | 17 / 15 / 13 | `h2` / `h3` / `h4`（字重都 600；两两差 2px，见 §2.9.5） | §2.9.5 |
| 行宽上限 | `--measure` | 640 | 连续成段的文字（`.markdown` / 页头说明 / agent 气泡） | §2.9.2 |

两条**不是数字**的规则：

- **并排两列**只有两个类：`.pair-field`（字段对，gap 12）/ `.pair-card`（卡片对，gap 16），窄屏一律塌一列（§2.3.1）；
- **主操作**只有一种长相：实心 accent + 白字 + 600（§2.1.1），它出现在栏头 / 顶栏 / 底栏都一样。

⚠️ 这张表与 `app.css` 的令牌是**机器比对**的（`tests/ui-style.test.ts` 里那条"排版总表的数字必须与令牌一致"）：
表里的 px 值是从令牌算出来的（`1rem = 16px`，`--rail-h` 由 `--ctl-h` 加 4px），对不上就会红。
所以改令牌时表要一起改——这不是"多一道手续"，而是防"文档写着 38px、界面早就是 30px"。

**这七条在哪看得见**：[`list-page-demo.html`](./list-page-demo.html) 里有一节「排版七条速查」
（在主屏之外——主屏是固定高度的一屏截图，塞不进 640px 宽的正文档）。那一节六块各演示一条，
并且自己带一条结论：`排版七条自检通过 6/6`。改样式之后刷新那一页，它自己会量。

---

## 1. 令牌（`app.css` 的 `:root`）

| 组 | 令牌 | 说明 |
|---|---|---|
| 间距 | `--sp-1` 4px · `--sp-2` 8px · `--sp-3` 12px · `--sp-4` 16px · `--sp-5` 24px · `--sp-6` 32px · `--sp-8` 48px | 4 的倍数。**只用这几档**，6px/10px 这种中间值说明设计没想清楚 |
| 字号 | `--fs-3xs` 10px · `--fs-2xs` 11px · `--fs-xs` 12px · `--fs-sm` 13px · `--fs-base` 14px · `--fs-md` 15px · `--fs-lg` 17px · `--fs-xl` 22px · `--fs-2xl` 28px | 层级**从密到疏**；`--fs-base` 是正文默认 |
| 行高 | `--lh-tight` 1.3 · `--lh-base` 1.6 | 标题紧、正文松 |
| 圆角 | `--radius-none` 0 · `--radius-sm` 4px · `--radius-xs` 6px · `--radius` 8px · `--radius-lg` 12px · `--radius-pill` 999px | 控件用 `--radius`；小徽标/小方块用 `--radius-sm`/`--radius-xs`；胶囊用 `--radius-pill`；**圆形头像/圆点用 `50%`**（那是形状不是圆角档） |
| 控件高 | `--ctl-h` 30px · `--rail-h` 34px | **只有一个档**：按钮 / `input` / `select` 都是 `--ctl-h`；工具条轨道与顶栏常驻控件是 `--rail-h`（= 控件高 + 4px）。原来的 `--ctl-h-sm`（24px）随 D181 撤销 |
| 内距 | `--pad-page` · `--pad-frame-head/body/foot` · `--pad-cell` · `--pad-cell-head` | 四级内距与行级密度（见 §0.1 总表；别处不许凑内距） |
| 行宽 | `--measure` 640px | 连续成段文字的上限（§2.9.2） |
| 字族 | `--font` · `--font-mono` | 代码/日志/路径一律 `--font-mono` |
| 颜色 | `--bg` `--surface` `--surface-2` `--surface-hover` `--panel` `--line` `--line-strong` `--text` `--text-dim` `--text-faint` `--accent` `--accent-dim` `--good` `--bad` `--warn` `--status-*` | 亮/暗两套**同名**；组件里不写 `#hex`，否则暗色下必错 |

**加新令牌的门槛**：现存的档位表达不了、且**至少两处**要用。只有一处用的值就写在那一处，
不要为了"整齐"造一个只用一次的令牌（那只是把裸值换了个名字）。

**另一头也管**：**声明的令牌必须有人用**（D190）。`--fs-2xl`（28px）就是这样被发现的——
它躺在 `:root` 里，产品代码一处都没用（`--fs-xl` 还有两处，再往上一档是空的）。死令牌比裸值更坏：
它看起来像"有这一档可以选"，下一个人照着它写，界面里就多出一个只有它自己在用的字号。
判据在 `tests/ui-style.test.ts`（"令牌不许空手摆在那里"）。

---

## 2. 控件族：只从这里挑

### 2.1 按钮 —— `.btn` + 一个重量（+ 可选一个尺寸）

```svelte
<button class="btn btn--primary">保存</button>
<button class="btn btn--ghost btn--sm">返回</button>
<button class="btn btn--danger">删除</button>
```

| 重量（互斥，必选一个） | 用在哪 |
|---|---|
| `btn--primary` | 这一屏的主线动作：新建 / 发送 / 保存 / 安装 |
| `btn--secondary` | 配套动作：刷新 / 浏览… / 下载 |
| `btn--ghost` | 无底无框，hover 才浮出底：返回 / 关闭 / 图标 / 行内小动作 |
| `btn--danger` | 破坏性动作：删除 / 清空 / 停止 |
| `btn--link` | 行内文字链（`撤销` / `重命名`）：去掉一切按钮形状，只剩可点的字 |

| 尺寸（可叠） | 效果 |
|---|---|
| `btn--sm` | 只降字号到 `--fs-xs`，形状不变（表格行里、栏头里用） |
| `btn--mini` | 行尾那排"悬停才出现"的极小动作（记忆行的 改/删） |
| `btn--tight` | 小内距 + 描边，用在紧贴输入框的次要按钮（表单里"记下"） |
| `btn--icon` | 只有图标；SVG 的尺寸/线宽由这一族定，组件里不要再写 `svg { width: 1rem }` |

补充：`btn--link.btn--quiet` 是**更淡**的文字链（虚线下划线，用在"已记进它的记忆 · 撤销"这种句子里）。

#### 2.1.1 一个高度，一个字号（D181）

> 使用者："**按钮的类型差别大，一般按钮和顶栏的按钮差异太大，风格不一致**。"

改之前界面上其实有**两档按钮**，而且两档各自还有内部不一致：

| | 普通按钮（表单 / 面板底栏 / 模态框底栏） | 工具条格子（顶栏那排 / 栏头那排 / 对话头 / 来源切换） |
|---|---|---|
| 高度 | 38px（`padding: 8px 12px` + 14px 字） | 24px（`--ctl-h-sm`） |
| 字号 | 14px（`font: inherit`，所以栏脚里又是 13px） | 顶栏 13px、栏头 14px（同一个轨道两种字号） |
| 圆角 | `--radius` 8px | `--radius-sm` 4px |
| 主操作 | 实心 accent + 白字 | **顶栏**：加粗 accent 字（无底色）；**栏头**：400 字重 + 淡灰字 + 透明底（**与 ghost 一模一样，主操作看不见**） |

现在只有一套数：

| 数 | 值 | 谁在用 |
|---|---|---|
| `--ctl-h` | 30px | **所有** `.btn`（含工具条里的格子）。做法是"行高 = `--btn-h` − 上下内距"，写死 `height` 会把窄栏里折成两行的按钮切掉（实测有 53/64px 两行的） |
| 字号 | `--fs-sm` 13px | `.btn` 基座统一钉住（不再靠 `font: inherit` 被容器带偏）；`btn--sm` / `btn--mini` / `btn--link` 各自压到 12px |
| 圆角 | `--radius` 8px（格子 `--radius-xs` 6px） | 格子要略小于轨道（轨道 8px），否则圆角会顶破 |
| `--rail-h` | 34px = `--ctl-h` + 4px | 四条工具条轨道；与顶栏常驻控件（通知 / 设置 / 语言下拉）**同高**（"一条带子上的节奏"） |

**主操作只有一个长相：实心 accent 底 + 白字 + 字重 600。** 于是它出现在哪一档都认得出：

> ★ **D189**：这三个特征现在**全写在 `.btn--primary` 基类里**。D181 当时只把"实心底 + 白字"
> 写进了基类，600 却写在两条轨道规则里（`.topbar .page-actions button.btn--primary` 与
> `.detail-head .detail-actions > button.btn--primary`）⇒ 顶栏/栏头的主操作是 600，而
> **面板底栏 / 模态框底栏 / 表单底栏 / 抽屉脚的主操作是 400**。同一颗 `btn--primary` 还是
> 两个长相，差在字重。是谁发现的：`list-page-demo.html` 的「排版七条速查」自检⑥量到
> `fontWeight: 400` 当场红（产品页面里没暴雷，只是那几处 primary 恰好都长在轨道上）。
>
> ⚠️ 但**底色与字色不能也一并"收进基类"就删掉轨道那两条**：`.topbar .page-actions button`
> 与 `.detail-head .detail-actions > button` 把每一格的底色压成 `transparent`、字色压成
> `--text-dim`，它们特异性比基类高——那两条规则的作用是**把主操作从"格子默认长相"里捞出来**。
> D189 第一版删得只剩说明，顶栏那颗「新建任务」当场变成透明底淡字（探针 `btn.uniform` 报
> `顶栏格子 底 rgba(0,0,0,0)`）。**能"收进基类"的是基类本来能定的值，不是需要更高特异性
> 的覆盖。**

- 面板底栏 / 模态框底栏 / 表单底栏：`.btn--primary`
- 顶栏那排 / 栏头那排（轨道里的格子）：同样是 `.btn--primary`（**这条推翻了 298 批"顶栏只靠文字分重量"的旧意图**——那个意图的代价是栏头的主操作根本看不见）
- "这是当前哪一档"用 `.active`（同一种实心底，但它表达的是位置而不是"要你做的事"）

⚠️ 一屏里**只该有一处**实心色块（`btn--primary`）。顶栏里 `primary` 与 `active` 会同时是实心：任务页的「新建任务」（要你做的事）+「列表」（你在这里）—— 它们是两件事，颜色相同是已知的取舍，别再往顶栏加第二颗 primary。

配套判据（都在 `tests/ui-style.test.ts` 与 `tools/layout-probe/`）：

1. **重量词必须带 `btn--` 前缀**（D180），且用到的变体必须在 `app.css` 里有定义；
2. **动作按钮必须归进按钮族**：裸 `<button>` 只许出现在结构性控件里（白名单在测试里，`.fold-head` / `.nav-item` / `.row` / 轨道里的互斥切换 …）。反例是这次清掉的 10 颗：新建任务表单的「保存并运行」、设置页的「登录」、平台设定的「保存」、技能的「安装」、任务页的「接着干」/「恢复」、聊天的「保存」、智能体详情的「设为默认/复制/取消」、远端管理页的「安装」——它们没有类名，吃裸 `button` 的 base：**实心 accent + 38px**，于是"主按钮"有两种尺寸，而且一屏会出现好几个"主操作"长相；
3. 探针 `btn.uniform`：顶栏格子 / 表单底栏 / 模态框底栏 / 模态框关闭 四处**同高 30px、同字号 13px**，主操作三处**同色、同字重 600**（字重是 D189 补上的——原来只量底色与字色，"顶栏 600 / 底栏 400"就这么漏了一年）；
4. 探针 `btn.headPrimary`：栏头那颗「保存」必须是**主操作长相**（实心 + 白字 + 600 + 30px）。

**重量词必须带 `btn--` 前缀，`btn` 也必须写。** 这不是强迫症：

> ★ D180（使用者："在'选择一个目录'的界面中，可以看到'关闭'等的蓝色按钮，这个风格需要调整一下，
> 觉得不太好看"）。查下来是**改名漏了一层**：`.` 批把按钮族从 `button.ghost` / `button.secondary`
> 改名成 `.btn--ghost` / `.btn--secondary`，那次迁移覆盖了 `apps/web` 的 167 个按钮，
> 却漏了**共享包 `packages/ui/src/components`**——那里五颗按钮还写着裸的 `ghost` /
> `primary` / `secondary` / `danger`。这些裸名字**没有任何全局规则**，而裸 `button`
> 的 base 是 `background: var(--accent-dim)`：
>
> | 位置 | 旧写法 | 实际渲染 |
> |---|---|---|
> | `Modal` 的「关闭」（**每个模态框**，含目录选择框） | `class="ghost"` | 蓝底白字 `rgb(47, 111, 208)` |
> | `FootFiles` 的「工作目录的文件」标题 + 「在文件管理器里显示」 | `class="ghost"` | 同上（栏脚标题变成一颗主按钮） |
> | `ConfirmDialog` 的「取消」 | `class="secondary"` | 同上（"取消"失去了"轻"这一层） |
> | `ConfirmDialog` 的「确认」（危险动作） | `class="danger"` | 同上 —— **删东西的按钮和保存按钮长得一模一样** |
> | `ChatComposer` 的「发送」 | `class="primary"` | 碰巧是 accent（看着对），但没有 `.btn`，尺寸/禁用态与按钮族脱钩 |
>
> 这类缺陷的特征：**不报错、不警告、类型检查看不见**，只是安静地变成另一个按钮。
> 所以判据是机器化的：`tests/ui-style.test.ts` 判「重量词必须带 `btn--` 前缀」+
> 「用到的变体必须在 app.css 里有定义」，探针再在真 Chrome 里量一眼「关闭」的底色是**透明**
> （`dirs.modalCloseIsGhost`）。

#### 2.3.1 "两个东西并排"只有一条规则（D187）

| 类 | 用在哪 | 数 |
|---|---|---|
| `.pair-field` | **字段对**（同一件事的两个参数：名字/CLI、指令/技能…） | 两**等宽**列 + gap **12**（`--sp-3`） |
| `.pair-card` | **卡片对**（两个平行的事物：设置页的卡片、关于页的卡片） | 两**等宽**列 + gap **16**（`--sp-4`） |

区别只在间距：字段对是同一件事的两半（紧一点才像一个整体），卡片对是两个独立的东西（松一点才分得开）。窄屏（≤60rem）**一律塌成一列**——两列在窄栏里只剩一半宽度，字段会挤成两行。

`.card-grid` 保留名字（多处 markup 用它），排法就是 `pair-card`。

改之前这条栅格在**四处**各写一份：

| 出处 | 写法 |
|---|---|
| `.card-grid` | `repeat(2, minmax(0,1fr))` + gap 16 |
| `NewAgentForm` 的 `.card.agent-card` | 同一条栅格 + gap 12 |
| `AgentDetail` 的 `.card.agent-card` | **与上一条逐字相同**（代码注释自己写着"两处一致"） |
| `CrystallizeDraftEditor` | `minmax(0, 1fr) minmax(0, 1fr)` —— 等价写法的第三种 |

"两处一致"的东西就是迟早会不一致的东西：现在两处 `.card.agent-card` 只剩"卡片这张皮"（内距/描边/圆角），栅格交给全局 `.pair-field`。

判据：探针 `grid.pairField` —— 新建智能体表单的卡片必须**两等宽列 + gap 12 + 元素上真的带 `.pair-field`**（不是自己又写了一条栅格）。

##### 2.1.2.1 键盘焦点全站只有一道环（D202）

**2px accent + 1px offset，所有能被 Tab 停到的东西都一样。**

量出来的现状（真按 Tab 走 22 个停靠点 × 3 页，`Input.dispatchKeyEvent` 发真的键盘事件）：
按钮都有环，**`input` / `textarea` 一个都没有**——它们的规则写的是
`outline: none; border-color: var(--accent)`，只把 1px 边框换了个色。于是同一个页面里键盘用户
看到两种焦点提示：按钮一道环、输入框一条细边。

现在：输入框也上环（边框色照旧变 accent，作为第二重提示）。**`outline: none` 只在"焦点提示由外层承担"的地方允许**：

| 地方 | 为什么 |
|---|---|
| `CodeEditor` 里层 textarea | 那是**透明文字**叠在彩色代码上的（`color: transparent` + `caret-color`），给它画 2px 环会横跨在代码上 ⇒ 环画在外层 `.editor:focus-within`（`outline-offset: -1px` 贴内缘） |
| `PromptEditor` 的 `.pe-textarea` | 同一个做法：环画在 `.pe-code:focus-within` |

判据两条：
1. **源码**（`tests/ui-style.test.ts`）：全局 `:focus-visible { outline: 2px solid var(--accent) }` 必须在；
   任何 `<style>` 里的 `outline: none` 必须进登记表并写明理由。变异验证：随便加一条 `outline: none` 当场红。
2. **探针**（`focus.rings`）：三页扫所有可聚焦元素，**按"命中的 :focus 规则里特异最高的那条"**判定
   它最后把 outline 设成了什么（只说"有某条规则给环就算有"会被蒙——见下面那条坑）。
   实测 `可聚焦 84 个 · 焦点规则 10 条`，零处被吃。变异验证：尾部挂一条 `input:focus { outline: none }`
   ⇒ 当场红并点出 4 个 `INPUT`。

> ⚠️ **三个踩过的坑**，都记在代码注释里：
> 1. **程序聚焦量不出 `:focus-visible`**：第一版用 `el.focus()` 量，结论是"按钮全都没有焦点环"——
>    假红。Chrome 的 `:focus-visible` 要真实的键盘事件才匹配（`focus({focusVisible:true})` 也不行）。
>    真按 Tab 之后：66 个停靠点全部有环。
> 2. **全局规则去掉伪类后是空选择器**：`:focus-visible` 剥掉伪类就什么都不剩，第一版把它 filter 掉了，
>    于是"输入框只命中 `input:focus`"被判成没环——又一个假红。空 ⇒ 命中一切。
> 3. **"没写 outline" ≠ "把环吃掉了"**：`input:focus { border-color: … }` 压根没提 outline，
>    不该参与比较。只有**明确**写了 `outline: none/0` 的规则才算覆盖。分不清这三件事就测不准。

#### 2.1.1.4 圆角只有五个值 + 圆（D201）

| 令牌 | 值 | 用在哪 |
|---|---|---|
| `--radius-none` | 0 | 贴边的东西（`.btn--link`、tab、editor） |
| `--radius-sm` | 4 | 徽标、行内 code、小标签、分组头 |
| `--radius-md` | 6 | **轨道里的格子**（`.topbar .page-actions button` / `.pane-actions button` / `.detail-actions > button` / `.source-toggle button`） |
| `--radius` | 8 | 控件（`.btn` / `input` / `select`）、列表行、面板 |
| `--radius-lg` | 12 | 浮层（`.modal`） |
| `--radius-pill` | 999 | 胶囊（徽标、chips） |
| （`50%`） | 圆 | 圆点、开关、头像 |

⚠️ **名字原来和值是反的**：6px 那个叫 `--radius-xs`、4px 那个叫 `--radius-sm`——`xs` 比 `sm` 还大。
这种错不会让界面坏掉，但它让"该挑哪个令牌"变成猜：下一个人在 4 与 6 之间选时，看名字只会选错。

D201 只改了名字（`--radius-xs` → `--radius-md`），**像素一个没动 ⇒ 视觉零变化**（实测：轨道按钮仍是 6px、
普通按钮 8px、徽标 999px、面板 8px）。现在序是干净的：`none(0) < sm(4) < md(6) < 默认(8) < lg(12) < pill(999)`。

判据两条：
1. **源码**（`tests/ui-style.test.ts`）：令牌名里的序必须等于数值的序、不许两个令牌同值、组件里不许写裸 px 圆角
   （允许 `50%`、`var(--radius*)`、`calc()`、分角写法）。变异验证：把 sm/md 的值对调，判据当场红并点名 `sm=6 < md=4`。
2. **探针**（`radius.values`）：三页扫 computed `border-radius`，令牌外出现新值即红。
   实测 `任务页(43) 技能页(37) 设置页(42) · 4px / 6px / 8px / 999px`。变异验证：造一个 `border-radius: 10px`，判据红并点出四处。

#### 2.1.1.3 间距只有四类来源（D200）

扫三页（任务 / 设置 / 技能）所有容器的 `gap`，实际出现的值只有六个：**2 / 4 / 6 / 8 / 12 / 16**。
它们不是"六个档位"，而是四类东西：

| 来源 | 值 | 是什么 |
|---|---|---|
| **令牌刻度** | `--sp-1..8` = 4 / 8 / 12 / 16 / 24 / 32 / 48 | 块与块之间（唯一可扩的刻度） |
| **紧贴档** | **2** | 两块**本该连着**的地方：分段控件格子之间的缝、标题与副标题、紧凑字段的标签与输入框 |
| **控件内部常量** | **6** | `.btn` 里"图标 ↔ 文字"的缝——它不是间距档，是按钮内部的排版常量 |
| **内容决定** | 8 等 | 行内相邻元素（徽标 / 元信息 / 动作）跟着内容走 |

⚠️ **2 与 6 都不进 `--sp-*` 刻度**：刻度是"距离"，这两个是"贴着"和"内部排版"，性质不同。但它们**必须各只有一个出处**——
原来 `.btn` 里那个 6px 在**五条规则**里各写一遍（`.topbar .page-actions button` / `.page-menu button` /
`.pane-actions button` / `.detail-actions > button` / `.source-toggle button`），2px 在四条轨道 +
两个分段控件里各写一遍（六处）。同一个值写五六遍，等于没有定义。

现在：
- **6px**：只在 `.btn`（D181 那个块）里定义一次；
- **2px**：一条共享规则 `:is(.topbar .page-actions, .pane-actions, .detail-actions:has(>button+button), .source-toggle, .theme-picker, .view-switch)` 定义一次。

判据：探针 `gap.values`——三页扫所有容器的 `gap`，出现刻度外的新值就红。
实测 `任务页(33) 技能页(25) 设置页(30) · 见到的 gap：2 / 4 / 6 / 8 / 12 / 16`。
变异验证：用尾部覆盖规则造一个 `gap: 20px`，判据当场红并点出 `设置页:main-panel-head=20px` 四处。

#### 2.1.1.2 可点元素的高度只有三种来源（D199）

把全站可点元素的高度摊开，会看到这样一列：`13 / 20 / 22 / 24 / 28 / 30 / 34 / 42 / 53 / 60 / 62 / 64 / 65 / 89 / 848`。
看着像**十五个档位**，其实只有三样东西：

| 来源 | 是什么 | 值 |
|---|---|---|
| **档位** | 写死的控件高度 | 控件 **30**（`.btn` / `input` / `select` / 裸 `<button>`）、轨道常驻 **34**、行内动作 **28**、标签胶囊 **24 / 22**、内联小件 **13 / 20** |
| **内容** | 文字折行的按钮会比 30 高 | 实测 42 / 53 / 64（写死 `height` 会把这些切掉，所以 `.btn` 用行高 + 内距算高度） |
| **容器** | 高度跟着内容/容器走，不是控件 | 列表行 60–89、拖动条 848、导航行 60、分组头 30–53 |
| **（文字）** | 不是控件：`<label for>`、行内 `<a>` | 高度就是行盒（21 / 17）——算进控件里只会是噪声 |

判据：探针 `ctl.heights`——在**任务页 / 设置页 / 技能页**各扫一次、合并成一个事实，把每个可点元素归到这四类之一；
**归不到任何一类的类名 ⇒ 报红**（那正是"又冒出第四个档位"的样子）。同时把"折行"与"没归类"分开报：
折行是内容决定的（允许，但要报出来，不能静默放宽）。

变异验证过：把 `.theme-picker button` 的 `min-height` 从 `var(--ctl-h)` 改成 `26px`，判据当场红并点出
`设置页:BUTTON=26`、`设置页:active=26` 六个元素；还原后 593 项全绿。
（第一次变异没生效，因为我加的是 `height: 26px`，被同一规则里的 `min-height` 压住了——这也顺带证明了
"用 `min-height` 而不是写死 `height`"这个写法是对的。）

#### 2.1.1.1 「控件」按用途认，不按类名认（D198）

同一张设置卡里，`select` 是 **30px**，主题三档是 **28.8px**——差 1.2px，谁也说不清为什么。

原因：D181/D182 把"按钮 / `input` / `select` 同一套 30px"钉住了，但那条判据是**按类名（`.btn`）找的**；
而设置页主题三档是**裸 `<button>`**（`.theme-picker button`），不在 `.btn` 族里 ⇒ 从来没被扫到，
它靠自己 `padding: 4px 12px` + 行高 20.8 凑出 28.8。

现在：**只要它在设置卡里能点、且独占一行高度，它就是控件，必须 `--ctl-h`（30）**，不管有没有 `.btn`。
`.theme-picker button` 改成 `min-height: var(--ctl-h)` + `inline-flex` 居中（用 `min-height` 而不是写死 `height`：
文字折行时不会被切掉，这条与 `.btn` 同一个道理）。

**形状同族但角色不同的，是两档**（不要因为长得像就并成一档）：

| 东西 | 档 | 实测 |
|---|---|---|
| `.theme-picker button`（设置项里的分段选择） | 控件档 | **30**（13px 字） |
| `.stage-chips button` / `.view-switch button`（列表工具条里的筛选） | 标签胶囊档 | **24 / 22**（11px 字；差 2px 只是"有边框 / 无边框"） |
| `.list-row-action`（列表行里的 ×） | 行内动作 | **28**（方形，跟着行高走） |

判据：探针 `ctl.sweep`——设置页里**扫描**（不是抽样）所有 `.theme-picker button` / `input` / `select` / 非轨道 `.btn`，
高度必须是唯一值 30；标签胶囊只许 24 与 22；行内动作只许 28（再冒出第三种值就红）。
变异验证过：把 `.theme-picker button` 改回旧的 `padding` 写法，判据当场红（`22 个控件高 [29,30]`）。

#### 2.9.5 标题层级只有一套定义（D193）

**定义在 `app.css`，页面不许改字号 / 字重 / 字色**。量到六页（任务 / 智能体 / 技能 / 聊天 / 设置 / 关于）的实际值：

| 档 | 实测 | 用在哪 |
|---|---|---|
| `h1.page-name` | 15 / 500 / dim | 顶栏页名（**六页逐页量到一致**） |
| `h2` | 17 / 600 / 正文色 | 面板 / 详情 / 设置分区的大标题 |
| `h3` | **15 / 600 / 正文色** | 一节的标题 |
| `h4` | 13 / 600 / dim | 段内小节（也是标签档的 13，但它是**标题**：600 + 独占一行，标签是 500 + 贴在控件上） |

**h3 原来是 17（与 h2 同值，D179 的决定），D197 压到 15。** 理由就是量出来的：设置页里 h3 就挂在 h2 底下（「通用」→「界面主题」），两档同值时在视觉上分不开，分开它们的只有卡片与间距——而标题层级本来就该由**字号**表达。现在三档两两差 2px（17 / 15 / 13），字重都还是 600。

这次改动的代价也是量过的：**整张设置卡片矮约 2px，没有一处文字被挤换行**（换行会把"矮 2px"变成"高 8px"，那就是另一回事了）。决定是怎么下的：先按 D195 在演示页里摆了同一张卡片的两案（h3 = 17 / 15）让使用者看，拍板取 15 之后才动 `app.css` 那一个 token。

**文档层是另一套**（`.markdown` 里的 `h1`–`h4`）：22 / 17 / 15 / 15+正文色。这不是不一致——agent 产出的是一篇文章，它需要比界面多一级"文章标题"（22px，`--fs-xl` 的唯一用途）。两套的界面/文档边界就是 `.markdown` 这个类：类里是文档，类外是界面。

页面里原来唯一一处改标题的是 `PromptEditor` 的 `.pe-head h3`（把 `<h3>` 画成 14/600）——它把标题当"工具条上的一行说明"用，既不是标题档（17/600）也不是标签档（13/500）。**D194 从根上解决了**：markup 换成非标题元素 `<span class="pe-head-name">`，声明一字不改（14/600 + `margin: 0`，并把原来从 `h1–h4` 继承来的 `line-height: var(--lh-tight)` 显式写上），**视觉一致**——量过：同一个 flex 行里 `<h3>` 与 `<span>` 的标题盒子都是 238×22、x 都是 37（flex 子项会被块级化，inline/block 的差别在 flex 容器里不存在）。

所以现在例外表是**空的**。

**演示页里现在量的是终态**：`docs/design/list-page-demo.html` 的「排版七条速查」第 ⑦ 块，一张设置卡片里
h2 / h3 / h4 同屏，旁边实时打印实测值（h2 17、h3 15、h4 13，三档两两差 2px、字重都 600、三行都不换行）。
它原来（D195）是"两案对比"——同一个卡片渲染两遍、h3 一边 17 一边 15，用来看要不要压；
拍板并且把 15 写进 `app.css` 之后，那条演示专用的 `.demo-h3-15` 覆盖就删了，现在这块量的是真样式。

> ⚠️ **演示里"摆着看"的组件必须拔掉它的定位身份**。第 ② 块把一块 `.modal` 摆在页面上跟面板比内距，
> 但全局 `.modal` 是 `position: fixed; top/left 50%; translate(-50%,-50%); z-index: 50`——
> 它就一直钉在屏幕中央压住整页（使用者原话：「那个"浮层"一直在上面，挡住我了」）。
> 原来那里只删了 `box-shadow`，以为"它只是有头体脚的一块东西"，位置没拔。教训：
> **把一个组件搬出它该在的上下文时，要拔的是它的定位/层级，不只是它的装饰**。
> 现在 `.demo-rule .modal` 回到文档流（`position: static` + 清 `top/left/transform/z-index/width/max-height`），
> 并且第 ② 条判据里加了两句：`position` 必须是 `static`，且这块浮层的矩形必须落在它所在小节内
> （钉在视口上就会越界 ⇒ 当场红）。

判据：`tests/ui-style.test.ts` 的「标题层级只有一处定义」——页面 `<style>` 里不许给 `h1`–`h4` 写字号 / 字重 / 字色，例外必须在 `HEADING_OVERRIDES` 里带理由登记（变异验证过：删掉登记表那条，判据当场红）。

#### 2.2.3 断点只有四级（D192）

| 断点 | 名字 | 这一档发生什么 |
|---|---|---|
| `width >= 74rem`（1184px） | 宽 | 沉淀页的**产物第三列**成为真列（窄了退回右侧抽屉） |
| `width < 74rem` | — | 同上，另一侧（页面里那两处）：把手隐藏 / 产物栏变抽屉 |
| `width < 72rem`（1152px） | 中 | 列表与详情**不再并排**：切成单栏，详情里出现「返回列表」 |
| `width < 60rem`（960px） | 窄 | 页面内距 24/32 → 16；两列排法塌一列；顶栏动作收进「更多」菜单 |
| `width < 48rem`（768px） | 更窄 | 收账户名；页名宽度降到 8rem |

三条硬规则：

1. **写法只有一种：range 语法**（`width >= 74rem` / `width < 60rem`），不许再用 `max-width` / `min-width` 写屏幕宽度。
   理由不是审美：`max-width: 74rem` **含边界**（≤1184），`min-width: 74rem` 也含边界（≥1184）——
   一对边界要在 1184px 上不重叠，只能写成 `max-width: 73.99rem`。本文件里真的躺着**两个**
   `73.99rem`（`Crystallize.svelte` 与 `CrystallizeArtifactPane.svelte`，注释还专门写了"必须与
   app.css 的 74rem 对齐"）。`width < 74rem` 与 `width >= 74rem` 是**严格互补**，不用凑数。
2. **每一档只有一块**。`60rem` 那一档原来拆成两块（一块管"两列塌一列"、一块管内距与顶栏动作），
   中间隔着别的东西 ⇒ 想知道"这一档改了什么"要把文件翻两遍。
3. **页面里不许出现没登记的断点**。判据里有一张登记表（`BOARD_STEPS`），现在**是空的**——
   详见下面这条账。

> **顺带清掉的债**：`Tasks.svelte` 里原来有一族"看板固定列数"的规则（`.board-6` 的 `repeat(6)`
> 加 110rem / 64rem / 60rem 三步阶梯）。量下来它们**从来没生效过**：`.board` 的
> `repeat(auto-fit, minmax(10rem,1fr))` 写在后面、特异性相同，把整族压住了——界面上一直是
> "有几个状态就几列、宽度不够自动折行"，而样式表里写的却是另一回事（实测 1920 宽窗口下
> 列宽 810/810，那是 auto-fit 的两列，不是 `repeat(6)` 的六分之一）。状态从三列并成两列之后
> "固定六列"只是历史残留，所以**删的是规则，不是行为**。app.css 里那条 `.board-4`
> （管着一个全站都不存在的类、靠 `!important` 生效）一起删了。

#### 2.9.3 要截断的长文字只有一个写法（D190）

```css
.ellipsis { max-width: 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

这五行**一行都不能省**，而且理由各不相同：

| 行 | 少了会怎样 |
|---|---|
| `white-space: nowrap` | 没有"被裁"这回事——会折行 |
| `overflow: hidden` | 画到盒子外面去，省略号不出现 |
| `text-overflow: ellipsis` | 画省略号 |
| `max-width: 100%` | 父容器是 flex 行且 `align-items: center` 时，块级子项宽度是 `max-content`（**不会**被父宽度限制）⇒ 长标题把父容器撑宽，永远不到"裁"的条件 |
| `min-width: 0` | 作为 flex 子项时，`min-width: auto` 同样拒绝缩小 |

后两行看起来冗余的时候，正是它们最必要的时候——**这也是这五行被抄了 35 次的原因**：每个人都在一个不同的父容器里各踩了一次。

用法：markup 上加 `class="… ellipsis"`；页面 `<style>` 里只留自己的东西（`display: block`、`font-weight`、`flex`）。

判据（`tests/ui-style.test.ts`）：页面 `<style>` 里**一处都不许**再写那三条（带不带 `max-width: 100%` 都算），一律用全局 `.ellipsis`。

> ★ **D191 把剩下的 25 处也收了**：D190 当时用棘轮（"只许少不许增，现在 27"）是为了不假装做完了；
> 现在棘轮已经**降到 0**。收法一律是两步——页面规则里删掉那三条（`flex` / `min-width` /
> `font-weight` / `display` 留下，那是这个元素自己的事），markup 上 `class="… ellipsis"`。
> 收的过程中遇到两类"看起来一样、其实不一样"的：
> · `.fv-table th/td` 用的是 `white-space: pre`（要保留空格）而不是 `nowrap` ⇒ 它不是这一族，
>   `text-overflow` 在那儿配合 `max-width: 24rem` 单独成立，**没动**；
> · `WorkDirTree` 的 `.wd-dir` / `.wd-file` 靠 `min-width: 0` + `flex-shrink: 1` 让名字肯缩，
>   这两行留在原处（`.ellipsis` 里的 `min-width: 0` 管"能缩到 0"，是另一件事）。
>
> 验证：五个页面（任务 / 智能体 / 聊天 / 技能 / 编排）逐元素量 `text-overflow` / `white-space` /
> `overflow`，没有一处从 `ellipsis` 掉回 `clip`；探针「长名字裁切」仍是 `裁住 true`。

#### 2.9.4 元素自己的宽度（D190）

`--measure`（640px）**只管连续成段的文字**。其余 `max-width`（标题 14rem、对方只手 16rem、提示条 `min(32rem,92vw)`、占位 55% …）是"这个元素自己的宽度上限"，就地写，**不进令牌**：每多一个令牌，"这一档"就多一个名字，而它们各自只用一次（造令牌的门槛见 §1）。

新增一档之前先问：这是不是**同一类东西的同一个宽度**？是就进令牌，不是就留在原地并写一行注释说明为什么是这个数。

### 2.9.2 一段话的行宽上限（D186）

连续成段的文字有**行宽上限** `--measure: 40rem`（640px，14px 字下约 **45 个汉字**一行）。

| 管 | 不管 |
|---|---|
| `.markdown`（agent 产出的正文、文件查看器的渲染结果） | 表格、列表（要跟栏走） |
| `.view-intro p`（页头说明段） | 卡片 / 表单（一排排东西，不是"一段话"） |
| `.bubble.agent`（agent 的答复气泡；用户气泡本来就有 85% 上限） | 代码块（`pre` 自己横向滚） |

改之前量到的：**2200px 窗口下任务详情栏 1658px、正文一行约 115 个汉字**——眼睛换来换去会串行。

⚠️ 上限**不居中**：正文列靠左，右侧留白由栏自己承担。居中会让"这段文字"看起来像一个独立的东西，而它只是面板里的内容。

⚠️ 气泡上限放在 `.bubble.agent` 而不是只用 `.markdown`：气泡的底色跟着文字走（宽度 = 内容宽度），否则会出现"一条横贯整栏的色带 + 左边一截字"。

判据：探针 `type.measure` —— 往真实 `.pane-body` 里插一个与渲染器同构的 `.markdown` 宿主，量到**宽度 ≤ 640 且 `max-width` 就是那个令牌值，并且真正窄于栏宽**（后面这半句才是"上限生效了"的证据）。

#### 2.9.1 正文档只有一个字号（D185）

字号的四档里，"正文"这一档只管一件事：**人读的句子**。它不分"界面的"和"agent 产出的"：

| 档 | 字号 | 谁 |
|---|---|---|
| 正文 | **14**（`--fs-base`） | `body`、`.markdown`（agent 产出的正文）、`.bubble`（聊天气泡）、`.list-group-head` |
| 说明 / 控件 | **13**（`--fs-sm`） | `label`、`.btn`、`input/select/textarea`、`.table`、`code`、`.view-intro p`、`.fold-summary`、顶栏语言下拉 |
| 元信息 | **12**（`--fs-xs`） | `.list-row-sub`、`.list-group-count`、`.badge`、`.nav-hint`、`btn--sm/--mini/--link` |
| 标签 / 极小 | **11**（`--fs-2xs`） | `.badge--sm`、`.stage-chips` / `.view-switch` 的格子 |

改之前：界面正文 14，而**agent 产出的正文是 13**（`.markdown` 与 `ChatBubble` 的 `.bubble` 各写一份 13）——"结 果""聊天气泡""文件查看器"恰恰是读得最多的那块，却比按钮旁的说明还小一档。现在三处都是 14。

⚠️ 两处必须同档的陷阱：同一个气泡里"纯文本"与"渲染出来的 markdown"分属两个文件（`ChatBubble.svelte` 的 `.bubble` 与 `app.css` 的 `.markdown`），只改一处会让同一个气泡里出现两种字号——这也是为什么这条要有判据。

`.markdown` 的行高是 **1.7**（要读的长段落），标题仍走全局 `--lh-tight`。

判据：探针 `type.bodySame` —— `.markdown` 的字号**等于 `body`**（量的是"同一档"，不是写死 14），聊天气泡若在也必须同档。

#### 2.2.2 密度只有两档（D184）

"这块该多密"也只有两档答案，量过的三页都已经是这个数——写下来是为了让**新写的表格 / 新写的列表有数可抄**，而不是各自发明：

| 档 | 谁用它 | 数 |
|---|---|---|
| **紧凑** | 表格（一屏要看很多行） | 数据行 `td` 上下各 **12**（`--pad-cell`）、表头 `th` 上下各 **8**（`--pad-cell-head`） |
| **标准** | 列表行（一行装一句话 + 元信息） | 行高 **64**（`--list-row-min-h`）、行内上下各 **8** |

表头比数据行紧一档是**有意**的：它是一行标签，不是内容。

**不在两档里的一类**：分组标题行（`.group-head td` / `.cat-row td`）是 12/4——它把"贴着它管的那段"接上去，不是一行数据。

判据：探针 `density.listRow`（列表行高**等于那个令牌的数** 64px，量的不是"看起来差不多"）+ `density.cell`（数据行 12/12、表头 8/8；取样时**跳过分组标题行**，否则量到的是标题行）。

#### 2.2.1 内距只有四级（D183）

一块内容该留多少，只有四档答案。**同级的东西用同一套数**，不是"每个组件自己看着舒服"：

| 级 | 谁属于它 | 头 | 体 | 脚 |
|---|---|---|---|---|
| ① 页面级 | `.main`（页面外边距） | — | **24 / 32**（窄屏 16） | — |
| ② 面板级 | 栏（`.pane-*`）、面板（`.main-panel-*`）、详情栏（`.detail-head`） | **16 / 24 / 12** | **16 / 24** | **12 / 24** |
| ③ 浮层级 | 抽屉（`.drawer-*`）、模态（`.modal-*`） | **同 ②** | **同 ②** | **同 ②** |
| ④ 行级 | 表格单元格、表单字段、列表行 | 见 §2.4 | | |

令牌就是这三条：`--pad-page`、`--pad-frame-head` / `--pad-frame-body` / `--pad-frame-foot`（`app.css` 的 `:root`）。

**为什么浮层要跟面板同一套**：它们是同一级东西——一块"有头、有体、有脚"的方块，区别只是浮在别的东西上面。改之前浮层的头少一个"下 12"（16/24 对 16/24/12）、浮层的体是 **24/24** 而面板的体是 16/24 —— 同一级两套数，于是"同一块带头的面板，浮起来之后行距就变了"。

窄屏统一收法（`max-width: 60rem`）：页面级 24/32 → 16；面板级只收**左右**（24 → 16），竖向不动——竖向再收会让栏头跟内容贴在一起，而被挤的其实是横向那条边。

两处**已知的例外**（都在组件自己的场景里，不在"级"里）：

- 列表栏的 `.pane-body` 横向只有 8px（`list-stack` 的行要贴边，行内自带 padding）；
- 新建任务那一栏是 `.pane-body.create-body` + `.detail-head.create-head`（`padding: 0` 起手，左右留白统一由 `--create-pad-x` 一个变量给，理由写在 `Tasks.svelte` 里：那一栏要"提交栏横贯可滚区"）。

判据：探针 `frame.paddingSame` —— 模态框的头/体/脚内距**与同页面板级逐条相等**（头与栏头相同、体竖 16、脚 12）。量的不是"各自等于某个数"，而是"同级真的同一套"。

#### 2.1.2 输入控件与按钮是同一套尺寸（D182）

> 来源是 D181 之后接着量到的：按钮 30px 了，**输入框还是 40px、下拉 37px**。

| | 改之前 | 现在 |
|---|---|---|
| `input` | 40px 高 / 14px 字 / `padding: 8px 12px` | **30px / 13px / `padding: 0 12px`**（`--ctl-h`） |
| `select` | 37px 高 / 14px 字 | **30px / 13px** |
| `textarea` | 竖内距 8px / 14px 字 | 竖内距 4px / 13px（高度仍由 `rows` 定，**不许写死**） |

所以 `--btn-h` 改名 **`--ctl-h`**（它已经是"控件高度"，按钮和输入框一个数）；`--rail-h` = `--ctl-h` + 4px 仍是工具条轨道。顶栏的常驻图标控件与语言下拉显式取 `--rail-h`（要跟轨道齐，不是跟输入框齐）。

为什么输入框用 `height` 而按钮用"行高凑"：输入框是**单行固定盒子**（多行的那个叫 `textarea`，按 `rows` 长高），写死高度不会切字；按钮里会折行，必须能长高。

判据：探针 `controls.rowSameHeight` —— 新建任务表单「高级 → 工作目录」那一行里，输入框 / 「浏览…」/ 提交按钮**同高 30px、同字号 13px**（量的不是"各自等于某个数"，而是"同一行里真的同高"）。

### 2.2 输入 / 表单

- 单个控件：`input, textarea, select` 已经有全局样式（底色、描边、圆角、focus），**不要重写**。
- 标签 + 控件 + 说明：用 `.field`（内含 `> label`，`> input` / `> select` / `> textarea`
  都拉到满宽），一行一个。**不要再写包裹式 `<label>文字 + <select></label>`**（标签与控件
  是两个元素，用 `for` / `id` 关联；D174 把设置页那 5 处、ChatSettings 那 4 处都收了过来）。
  - 紧凑档 `.field--compact`：设置面板里一行挨一行地堆（标签 `--fs-xs`、间距 2px）。
  - 一行并排 `.field-row`：控件 + 按钮（「浏览…」「保存地址」）、两个字段并排、短控件与
    长控件混排，都走这一条（**`align-items: flex-end` 底对齐**，理由见 §2.4「混排行」）。
    D174 之前这是三处各写一遍（`.voice-row` / `.proxy-row` / `.workdir-row`）+ 两处内联
    `style="display:flex;gap:…"`。
- 只读/不可用：`disabled` 属性（浏览器默认样式已配好），**不要**自己画一个灰框冒充。
- 输入框旁的动作（浏览…/发送）：动作本身是 `btn btn--ghost` 或 `btn btn--primary`，
  容器负责对齐，**不要在按钮上写 `height`**。

### 2.3 徽标 / 状态色

- 只读的状态小标签：`.badge`（胶囊），语义色由类后缀给：`.badge.todo/.in_progress/.in_review/.done/.blocked/.cancelled`。
- 文字状态色：`.good` / `.bad` / `.warn` / `.muted` / `.faint`（**颜色**，不是字号）。
- 字号工具：`.fs-xs`（12px，最常用）；更小的用令牌写在组件样式里，但**不许写裸 px**。

> `.small` 这个类 **298 批已删除**。旧代码里看到它就是没迁移完——换成 `.fs-xs`（文字）
> 或按钮上的 `btn--sm`（尺寸）。

**徽标的两个纪律**（2026-11，D142）：

- `.badge` 是 **`inline-block`**（不是 `inline-flex`）：圆点用内联块 + `vertical-align: middle`。
  用 flex 时容器的基线取"第一个 flex 子项"的基线，而圆点没有文字 ⇒ 浏览器退回用圆点的
  **下边缘**当基线 ⇒ 徽标比旁边的文字**低 1.9px**（混排时一眼看得出）。
- **变体只写差异**：阶段标签 `.stage-tag` 现在同时带 `.badge`（`class="badge stage-tag …"`），
  Tasks 的 scoped 样式里只剩"竖内距 0"（D61：`.badge` 的 `0.1rem` 会把任务行撑高 2-3px）。
  自己再画一遍胶囊 + 圆点，就会在改 `.badge` 时被漏掉——这正是 D142 里 `stage-tag` 的教训。

### 2.4 页面骨架

| 位置 | 类 | 备注 |
|---|---|---|
| 三栏壳 | `.shell` + `.topbar` / `.sidebar` / `.main` | 顶栏高度 `--topbar-h`、侧栏宽 `--sidebar-w` |
| 列表 + 详情 | `.split-layout`（`.board` 看板 / `.with-detail` / `.with-artifact`） | 窄屏自动退成"列表 → 详情"两层 |
| 列表栏 | `.pane`, `.pane-head`, `.pane-body`, `.pane-foot`, `.pane-actions` | 栏头不放标题（D64） |
| 主区面板（设置这类） | `.main-panel` + `.main-panel-head`（`h2` + `.panel-back`）+ `.main-panel-body` + `.main-panel-foot`（分段用 `.drawer-section`） | **所有"整块换掉右栏"的面板都长这样**；设置**页**（`views/Settings.svelte`）的三张卡也是同一个壳（D174：原来是页面私有的 `.set-card` / `.set-block`，边框还误用填充档 `--surface-2`）。**主操作在这一族的底栏**（`.main-panel-foot`），栏头只放 ghost——见 §2.6.1.1「主操作放哪」 |
| 目录选择 | 组件 `DirPicker`（「浏览…」打开它，`bind:open` + `bind:value` 与表单输入框同一个值） | 路径行 + 导航行 + 列表（目录可进、文件只作佐证）+ 底部「选这个目录」；输入框始终留着，手打永远可用。**不要**自己再搭一个目录弹层 |
| 详情头 | `.detail-head` + `.detail-sub` + `.detail-actions`（**主操作在栏头**，见 §2.6.1.1） | 动作按钮 ≥2 个时自动画分组轨道。所有「标题 + 元信息 + 动作」的头都用它（聊天栏头 313 批已并入，不要再自己写 flex 补丁） |
| 加载 | `.skeleton`（单行 1.1rem）/ `.skeleton.skeleton--block`（一块 4rem） | 只有两档形状、宽度 100%、**不许内联尺寸**；叠两行自动留距（见 §2.8.2） |
| 空态 | `.empty`（可带 `strong` + `p`）/ 内容里一小格用 `.empty.empty--flush` / 字段无值用 `.empty-value` | 别自己拼居中的灰字；**两档语境与措辞分档见 §2.8.1** |
| 详情/栏头两行 | 栏头这类"标题 + 一串元信息"的地方同样两行：第一行 **标题 + 动作按钮**，第二行 **元信息**（执行者 / 轮数 / 技能 / 时间）。元信息元素写 `flex: 0 0 100%` 强制独占一行 | 312 批：聊天的栏头原来是"标题 + 改名 + 文章写作员 · 2 轮"三样挤一行，长标题与元信息互相抢宽度。与"列表行两行"同一条注意力顺序 |
| 列表行两行 | 列表行（聊天/任务/智能体/沉淀/定时任务/编排）一律 **两行结构**：第一行 = 标题（`<span class="…-title">`），第二行 = 辅助信息（执行者 / 轮数 / 时间 / 阶段，`<span class="…-sub">`）。两行都由 `.list-row-main`（`display:flex; flex-direction:column`）自然堆叠，**不许把辅助信息挤进标题那一行**；标题单行省略、辅助信息也单行省略 | 311 批：使用者原话——"类似任务的类似，一行主 Title，一行辅助信息的格式"。注意力顺序是"先认这是哪一条，再看它什么状态"；挤在一行时两者互相抢宽度，长标题会把辅助信息挤没。**照抄的地方见 §2.6**（连 CSS 一起） |
| 列表分组 | 组头 = 组件 `ListGroupHead`：**一条分段带**（整行铺 `color-mix(in srgb, var(--text) 14%, var(--surface))` 的浅灰底 + 圆角 + **下方一条 `--line` 的线**，chevron + 组名 + 右侧说明与计数），字号与行标题**同级**（`--fs-base`）、字重 600、字色淡一档（`--text-dim` vs 行的 `--text`）；组头与行**平级**（`<li>` 里不许再套 `<li>`）；组间分隔线由 `app.css` 的 `.list-stack > .list-group-head-wrap:not(:first-child)` 自动画 | D137：这一档原来**两页各一套**（任务页是带边框的卡片按钮、智能体页是淡字行，连 DOM 结构都不同）。D140 按使用者两轮反馈定形：**靠底色分段、不靠缩小**——（a）组名原来用正文色（`--text`）+ 12px，"头比内容还小、颜色又跟行一样"，读起来就是一行缩小的内容；（b）所以字号提到与行标题同级、改用 `--bg` 底色带分段，底色**故意不是 `--bg`**（与白底对比只有 1.07，肉眼分不出——第二轮反馈）也不是 `--surface-2`（那是选中行底色，同色会让"选中的那一行"被读成分组头）。折叠状态由页面给（任务默认展开、智能体「内置」默认收拢），控件不管 |
| 行分界 | 行与行之间**一条 1px 的 `--line` 发丝线**（`app.css` 的 `.list-row + .list-row`），`ul` 不再靠空隙分段（`gap: 0`）；第一行不画（列表顶部不凭空多一条线） | D141：使用者"列表的内容只有选中才有框，没选择的时候，看不清楚分界"——原来靠 `gap: 4px` 分段，而空隙在静止状态（不 hover、不选中）什么都读不出来。⚠️ 这条规则**只能写在 `app.css`**：放进 `ListRow.svelte` 的 scoped 样式会被 Svelte 剪掉（`.list-row + .list-row` 实测没进构建产物） |
| 副行基线 | 行的第二行（辅助信息）统一 `class="list-row-sub …"`（`app.css`：`display:flex` + **`align-items: baseline`** + 字号/字色显式写 + `> * { min-width: 0 }`） | D142：六个列表页原来各写一份、其中五处是 `align-items: center`——而这一行常把文字与徽标混着放，徽标的盒子比文字高，`center` 对齐的是**盒子**：于是"最近 15 小时前"比前面几段**低 3px**（实测 center 3px / baseline 0px）。页面只写"这一页多出来的形状"（任务要 `flex-wrap: wrap`、智能体要 `width: 100%`） |
| 单行省略 | 列表标题一类要"一行 + 省略号"的元素必须 **`display: block` + `max-width: 100%` + `overflow: hidden` + `text-overflow: ellipsis` + `white-space: nowrap`** 五件套 | 310 批：行内元素上 `overflow`/`text-overflow` 不生效，`nowrap` 只挡换行*算法*，中文长标题在窄栏里仍会被顶成两行、末尾却还挂着省略号（使用者报的） |
| 可拖的栏宽 | `use:paneResize`（`lib/pane-resize.ts`）：插入或接管 `.split-grip` / `.pane-resizer`，宽度写进 CSS 变量，存档 `agentdeck.pane.<name>`（老键照读并搬迁） | D175：列表栏与产物栏原来是两套实现（各自 clamp、各自 window 监听、各自键名），收成一份。**改宽度范围就改调用处的 `min/max`**，不要在下游再造一套。设置页「布局」那张表（D176）列的就是 `LIST_PANES` + 产物栏，`恢复默认` = 删存档（默认宽度归 CSS） |
| 混排行 | `.field-row`（`display:flex` + **`align-items: flex-end`** + `flex-wrap`；`> input/select` 收缩、`> button` 不许被挤窄） | 308 批：`center` 会让勾选浮在中间、`flex-start` 贴着顶边——两者高度差大时都不像同一行。**D174 起这条有了类名**：新写这类行直接用 `.field-row`，不要再造一个 `.xxx-row` |
| 提示条 | `.notice` + `.bad` / `.warn` / `.good` | 一句话；更长的进 body。**它同时是「这一块数据没拿到」的唯一去处**（不许只弹 toast，见 §2.8.3） |
| 浮层 | `.drawer*` / `.modal*` / `.page-menu` / `.toast` | 遮罩 + 描边 + `--shadow-2` 三层一起给 |
| 表格 | `.table-wrap`（壳）+ `<table class="table">` | 307 批：表头/单元格内距等规则挂**元素选择器与 `.table` 两条**，所以"长得像表格但不是 `<table>` 元素"的东西加 `class="table"` 就同款 |
| 折叠 | `.fold-section` / `.fold-head` / `.fold-body` | |

### 2.5 已经归位、**不要**再新画的

`SettingsPanel.svelte` 是"主区面板"的共享外壳（`section.main-panel` + 头部返回 + body + foot），
新加一个设置页 = **用它 + 写内容**，不要自己再拼一遍头部和返回按钮。

D174 归位的三件（代码里还看到就是没迁移完）：
- 设置项的**分段**一律 `.drawer-section`（不要再写 `.set-block`）；
- 设置卡 / 面板的**外壳**一律 `.main-panel`（不要再写 `.set-card`；关于页的 `.ab-card` 也已并进来，
  两页卡片网格用全局 `.card-grid`——见 §2.9.1）；
- 一行并排的**控件行**一律 `.field-row`（不要再写 `.voice-row` / `.proxy-row` / `.workdir-row`，
  也不要内联 `display:flex;gap`）。

D179 归位的两件：
- 标题：四级 + 一档标签，字号只在 `app.css`（**组件不许写 `h2`/`h3`/`h4` 的 `font-size`**），
  段内小节一律 `<h4>`——见 §2.9；
- 卡片：网格 `.card-grid`、外壳 `.main-panel`（`.ab-grid` / `.ab-card` / `.set-grid` / `.set-card`
  这些页面私有的名字一律不许再出现）——见 §2.9.1。

### 2.6 列表页范例：照抄这一份，不要自己发明

> 用途：新写一个「左边一列、右边看详情」的页面时，**从这份骨架开始**，把行内容换掉即可。
> 它只拼装**现有的标准控件**（`ListPane` / `ListRow` / `MainArea` / `Modal` / `confirm`），
> 类和令牌全部来自 `app.css`——这里没有任何"看起来像"的自定义形状。
>
> 给使用者：下次看到某一页风格不统一，直接说「按 ui-style.md §2.6 的列表页范例改」即可。
>
> ★ **看得见的那一份：[`list-page-demo.html`](./list-page-demo.html)**（浏览器直接打开，不用起服务）。
> 它是一屏完整页面（顶栏 + 侧栏 + 两栏），页面上的蓝色数字对应"这一块来自哪个控件"，
> 最底下是**三种错的样子**（行容器没重置 / 标题没有单行省略 / 辅助信息挤进第一行）。
> ⚠️ 它第一段 `<style>` 是**从真文件逐字嵌入**的（`app.css` + `ListRow` / `ListPane` 的
> scoped 样式），不是手抄一份——`tests/ui-style.test.ts` 有一条判据盯着它：
> 真文件改了而范例没同步 ⇒ `pnpm run check` 变红。

#### 2.6.0 外层网格：三列，中间那个把手不手写

```svelte
<div class="split-layout" data-list-key="xxx" data-list-label={$t('shell.resizeList')} use:paneResize>
  <!-- 列表栏（ListPane） -->
  <!-- ★ 这里的位置是**把手**：由 `use:paneResize` 动作自己插进来，模板里不要手写 -->
  <!-- 详情栏（MainArea） -->
</div>
```

`.split-layout` 是**三列**：`列表 | 把手 | 详情`（`var(--list-w) var(--grip-w) minmax(0,1fr)`）。
`.split-grip` **不要手写**——`lib/pane-resize.ts` 会插一个，手写第二个会叠在同一格里。

**所有"拖出来的宽度"走同一个动作**（D175）：列表栏（无参数，宽度进 `--list-w`、存档
`agentdeck.pane.list.<视图>`）与沉淀页的产物栏（带参数：`cssVar: '--artifact-w'`、
`rightWidens: false`、`handle: '.pane-resizer'`——把手在标记里、贴在自己左缘所以方向相反）。
**不要再写第二份 clamp / window 监听 / localStorage 键**；要加一处可拖的栏，就给它一个
`name` 与 `min/max`。

⚠️ **漏掉把手 = 详情栏掉进第 2 列（6px 宽）**，整块主区看着像空的（2026-11 这份范例的
第一版就是这么错的，而且"两栏并排"还量得对——因为只比了左沿坐标，没比宽度）。
可用 Svelte 动作的页面不会踩这个坑；手写 HTML 的演示页必须自己补一个。

#### 2.6.1 骨架（结构层面：一行都不许自己写）

```svelte
<ListPane
  countLabel={$t('xxx.listCount', { count: items.length })}
  searchPlaceholder={$t('common.search')}
  {filter}
  onFilter={(v) => (filter = v)}
  loading={$loading['xxx']}
  loadError={$loadError['xxx'] ?? null}
  empty={items.length === 0}
  emptyTitle={$t('xxx.empty')}
  emptyHint={$t('xxx.emptyHint')}
  emptyFiltered={items.length > 0 && visible.length === 0}
  emptyFilteredTitle={$t('xxx.emptyFiltered')}
  emptyFilteredHint={$t('xxx.emptyFilteredHint')}
>
  {#snippet rows()}
    <!-- ★ 行容器只有这一种写法：list-stack 在 app.css 里（重置 + 4px 行距） -->
    <ul class="list-stack">
      <!-- 要分组时：组头插在它那组第一行之前（与行平级），样式全在 app.css -->
      <ListGroupHead
        label={$t('xxx.groupA')}
        count={$t('xxx.groupCount', { n: groupA.length })}
        open={openA}
        ontoggle={() => (openA = !openA)}
        groupKey="a"
      />

      {#each visible as item (item.id)}
        <ListRow rowClass="xxx-row" active={item.id === selectedId} onclick={() => selectOne(item)}>
          {#snippet children()}
            <span class="xxx-title" title={item.name}>{item.name}</span>
            <span class="xxx-sub">
              <span class="badge">{$t(sourceKey(item))}</span>
              <span class="faint">{$t('xxx.updated', { time: relativeTime(item.updatedAt, Date.now()) })}</span>
            </span>
          {/snippet}
          {#snippet action()}
            <!-- 需要行内动作时只放这一颗（危险色由 .list-row-action 给） -->
            <button type="button" class="list-row-action" title={...} aria-label={...} onclick={...}>×</button>
          {/snippet}
        </ListRow>
      {/each}
    </ul>
  {/snippet}
</ListPane>

<MainArea
  empty={!detailOpen}
  emptyTitle={$t('xxx.pickHint')}
  emptyHint={$t('xxx.pickHintHint')}
  backLabel={detailOpen ? $t('xxx.backToList') : undefined}
  onBack={closeDetail}
  title={creating ? $t('xxx.createTitle') : selected?.name ?? ''}
  bodyClass="detail-scroll"
>
  {#snippet sub()}
    <!-- 元信息：徽标 + 时间 + 轮数。它在栏头里自动落到标题下面那一行 -->
    <span class="badge">{statusLabel}</span>
    <span class="faint fs-xs">{$t('xxx.meta', { by, time })}</span>
  {/snippet}

  {#snippet actions()}
    <!-- 栏头右侧动作（≥2 颗时自动画出分组轨道；主操作只有一颗 primary） -->
    <button type="button" class="btn btn--ghost btn--sm" onclick={remove}>{$t('common.delete')}</button>
  {/snippet}

  <!-- 正文：全部用现成控件，页面不发明形状 -->
  {#if error}<p class="notice bad">{error}</p>{/if}

  <div class="field">
    <label for="xxx-name">{$t('xxx.nameLabel')}</label>
    <input id="xxx-name" type="text" bind:value={formName} autocomplete="off" />
  </div>

  <div class="field">
    <label for="xxx-dir">{$t('newtask.workDirLabel')}</label>
    <div class="workdir-row">
      <input id="xxx-dir" type="text" bind:value={formWorkDir} />
      <button type="button" class="btn btn--secondary" onclick={browse}>{$t('dirs.browse')}</button>
    </div>
    <p class="hint">{$t('newtask.workDirHintAfter1')}</p>
  </div>

  <!-- 折叠块：标题一行 + 右侧一句摘要，展开才是内容 -->
  <div class="fold-section">
    <button type="button" class="fold-head" aria-expanded={open} onclick={() => (open = !open)}>
      <span class="chevron">{open ? '▾' : '▸'}</span>
      <span class="fold-title">{$t('xxx.filesTitle')}</span>
      <span class="fold-summary">{files.length} 个文件</span>
    </button>
    {#if open}
      <div class="fold-body">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>{$t('xxx.colFile')}</th><th>{$t('xxx.colSize')}</th><th>{$t('xxx.colWhen')}</th></tr></thead>
            <tbody>
              {#each files as f (f.path)}
                <tr><td><code>{f.path}</code></td><td>{f.size}</td><td class="faint fs-xs">{f.when}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  </div>

  {#snippet foot()}
    <!-- 这一屏的主动作（栏脚）。反馈紧贴在它上面，按下就能看见 -->
    <div class="main-panel-foot">
      <span class="faint fs-xs">{$t('xxx.footNote')}</span>
      <span style="flex: 1"></span>
      <button type="button" class="btn btn--secondary" onclick={closeDetail}>{$t('common.cancel')}</button>
      <button type="button" class="btn btn--primary" onclick={save}>{$t('xxx.save')}</button>
    </div>
  {/snippet}
</MainArea>
```

右栏（主区）永远是这四块，顺序固定：

| # | 块 | 由谁给 | 要点 |
|---|---|---|---|
| ① | 栏头 | `MainArea` 的 `title` / `sub` / `actions` | 标题左、**动作右**、元信息自动落第二行；窄屏「← 返回」也在它里面 |
| ② | 正文 | `.pane-body` + 现成控件 | 字段 `.field`、提示条 `.notice`、折叠 `.fold-section`、表格 `.table-wrap > table.table`、目录选择 `DirPicker`；**正文自己滚**，栏头不跟着滚 |
| ③ | 空态 | `empty` + `emptyTitle` / `emptyHint` | 没选中时"选一个"，不是一片空白 |

**这一屏的动作全在栏头**（`actions` 里那一排），**不要再在底下加一条"保存 / 取消"栏脚**：

- 顺序：主操作（`btn--primary`，只有一颗）→ 次操作（`btn--secondary`）→ 普通操作（`btn--ghost`）→
  **销毁放最后一个**（`btn--danger`，离主操作最远）。
- ≥2 颗时 `.detail-head .detail-actions:has(>button+button)` 自动画出分组轨道（1.9rem 高、`--line` 底），
  **别自己套一层容器**；单颗不画。
- `MainArea` 的 `foot` 只留给**常驻输入**那种东西（聊天的输入条）；表单式的主操作不放它。

#### 2.6.1.1 主操作放哪：**按族定**，不要跨族抄

> ★ D177（使用者问「'保存并运行' 按钮的位置是怎么定的？」之后选定的 B 案）。
> 同一个问题（"这个表单的主操作放哪"）在代码里曾经有**三条各自合法的答案**，
> 而文档只写了其中一条 ⇒ 另外两条既没被声明过、也没有判据钉着。现在按"这一屏是哪一族"
> 分开写死，每族一条可量的判据（探针里量，量的是**位置**，不是"按钮在不在"）。

| 族 | 主操作在哪 | 为什么 | 判据（`probe:layout`） |
|---|---|---|---|
| **① `MainArea`**：右栏 = 详情 / 表单页（任务详情、定时任务表单、编排、智能体详情） | **栏头**右侧那一条（`actions` → `.detail-head .detail-actions`） | 动作是"这一屏的主线"，标题就在它旁边；主操作在上部，视线不用往下找（2026-11 使用者原话："保存放栏头——主操作在表单上部，不在最底下"） | `动作在栏头、且排成一条轨道`(30px) / `只有一颗主操作` / `删除用危险色` / **`没有底部栏脚`**（四条都在范例页自检里） |
| **② `.main-panel`**：整块换掉右栏、带「← 返回」的面板（技能安装、工作区设置） | **底栏** `.main-panel-foot`（唯一那颗 primary；次操作在它旁边） | 面板里是**一长段内容**，主操作是"这一段填完了"的最后一步；反馈（notice / 错误）紧贴在它上面，按下就能看见。（它原来贴视口底、像弹框，改过来是为了"就地面板"的手感——这段理由写在 `Skills.svelte` 里） | `skills.panelActions` / `agents.settingsPanelActions`：**栏头只许 ghost**、**底栏恰有一颗 primary** |
| **②' 同一族、但没有"最后一步"的面板**（聊天设置、沉淀设置：控件改完即保存） | **两处都不放**：没有底栏，栏头也只有 ghost 的「← 返回」 | 它没有"提交"这件事——给它一颗保存按钮等于给一个假动作 | `chat.settingsActionPlace`：**没有底栏**、栏头只有 ghost |
| **③ 吸底条 `.form-foot`**：只有**边填边看结果**的长表单（新建任务） | 页内**吸底**（sticky bottom），错误与摘要在同一栏 | 无论滚到哪按钮都在、失败提示贴着按钮（D58 的原始规则："点一下、没反应，再点一下"的教训） | 属页面内部结构，暂**没有**跨页判据（只有这一处用它） |
| **④ 浮层**（`.modal*` / `.drawer*`：PromptEditor、确认框、目录选择） | 底栏（`.pe-actions` / `.modal-foot`） | 模态里没有"页面上下文"，动作在底部是这一类窗口的惯例 | 不参与本表判据（浮层有自己那一族规矩） |

**跨族的红线**（这几条都是踩过的）：`MainArea` 里**不许**加底栏；`.main-panel` 的栏头里
**不许**出现 primary / secondary / danger（只许 ghost 的返回与工具性动作，例如设置页「布局」卡的
「全部恢复默认」）；吸底条**不许**用在面板或 `MainArea` 里（它不是第三套"保存栏"，是一种
"结果要一直看得见"的表单结构）。

⚠️ 判据按**界面看到的重量**算 primary：`app.css` 里**一个变体都不写**的 `button` / `class="btn"`
也是 primary（accent 底色）。按写法算会漏掉技能安装底栏那颗 `<button type="submit">` ——
"主操作跑到栏头去了"就会被判成通过。


顶栏动作、删除确认、浮层一律走现成的：

```svelte
$: setPageActions('xxx', [
  { id: 'new', label: $t('common.create'), kind: 'primary', icon: 'plus', onActivate: startCreate },
  { id: 'refresh', label: $t('common.refresh'), kind: 'ghost', icon: 'refresh', onActivate: () => void refresh() },
])
onDestroy(() => clearPageActions('xxx'))

// 删除：平台居中对话框（不是 window.confirm）
if (!(await askConfirm({ ... }))) return
// 表单：Modal；写入成功后 loadXxx()（界面跟着数据走）
```

#### 2.6.2 页面自己的 `<style>` 里**只许**写这两块

行内容的两行结构（第一行标题、第二行辅助信息），逐条抄——**六页一字不差**：

```css
/* 第一行：标题必须“单行 + 省略号”五件套（行内元素上 overflow/text-overflow 不生效） */
.xxx-title {
  display: block;
  max-width: 100%;
  font-weight: 600;      /* 与 .conv-title / .task-title / .sched-title / .wf-title 同档 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 第二行：辅助信息——字色/字号**显式写**（不写就从行里继承，两页会长出两种灰） */
.xxx-sub {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-xs);
  color: var(--text-faint);
  overflow: hidden;
  white-space: nowrap;
}
/* flex 子项默认 min-width:auto 不收缩 ⇒ 长内容会把行顶出去、省略号失效 */
.xxx-sub > * { min-width: 0; }
```

**不许做的**（每一条都真的犯过）：

| 别写 | 为什么 | 该用什么 |
|---|---|---|
| `ul { list-style:none; margin:0; padding:0; display:flex; … }` / `.xxx-list { … }` | Svelte 的 scoped 样式**不跨文件**：下一个用同名类的页面照样吃浏览器默认的 `padding-left: 40px`（定时任务、编排各中招一次） | `<ul class="list-stack">`（app.css，一处定义）；`tests/ui-style.test.ts` 机器拦着 |
| 自己拼右栏的 `detail-head` / `detail-body` | 窄屏返回、空态、滚动容器都在 `MainArea` 里，少一样就是"窄屏进去一片空白、没有出口" | `MainArea` |
| `window.confirm` / 手搭 `.modal` 浮层 | 全站只有一种确认框、一种浮层（Esc / 遮罩 / 关闭只实现一次） | `askConfirm` / `Modal` |
| 栏头里放标题或按钮 | 栏头带只有「计数 + 搜索」，主操作在顶栏（D61~D66） | `ListPane` + `setPageActions` |
| 给标题加 `font-size` / 换 `font-weight` | 五页标题同一档（14/600），差一档就是"这一页看起来不一样" | 跟上面那段抄 |
| 行内塞第三种信息层（三层以上） | 列表是拿来扫的：**先认是哪一条，再看它什么状态** | 多的信息进 `title` 与右栏 |

#### 2.6.3 自证：怎么知道"和邻居一样"

- **静态**：`pnpm run check`（含 `tests/ui-style.test.ts` 那条"行容器只有一处定义"）。
- **渲染**：`pnpm run probe:layout` 的 `列表栏骨架（D61）` / `行内细节（D65）` 两组，
  采样页表是 `run.mjs` 顶部的 `LIST_PAGES`。**新增列表页必须往那张表里加一行**，
  否则它只有自己写给自己的判据（= 自证），那一整类缺陷就抓不到了。
- **范例页自己也会量**：`list-page-demo.html` 顶部有一条自检（17 项，加载时在浏览器里真的量一遍——
  两栏并排**且详情栏够宽**、栏头 51px 无标题、`ul` 缩进 0/符号 none/**行间一条发丝线**、行高底线 64、
  长标题单行裁切、正文自滚、栏脚贴底、无横向溢出）。不通过就红着脸写在页面最上面，
  不用等人看出来。
- 两组判据量的都是**等式**（五页互相相等）：栏头高 / 行盒 / hover 底色 /
  行内标题字号字重 / 徽标形状，加上两条较新的等式：
  - `skeleton.listBox`：`ul` 的 `padding-left` = 0、`list-style` = none、`gap` = 0、**行间一条 `--line` 上边线（第一行没有）**、
    行左沿贴着栏内容左缘；
  - `skeleton.groupHead`：两页的组头**同高（≤1px）、同字号且不小于行标题、组名同字重（600）**、
    都有 chevron、计数贴右；组间分隔线只在第二组上方有（第一组上方不许有线）；
  - `skeleton.rowMetrics`：行高**底线**（`min-height`）= 64px、**页内**任意两行差 ≤1px
    （内容更高时行可以更高——那不算不一致，令牌才是不允许漂的东西）。

### 2.7 候选 vs 动作：不可用的东西，一个是"置灰"，一个是"根本不出现"

两类东西容易混，判法只看一个问题：**这个位置本身就是"从一堆里挑一个"吗？**

- **是（下拉候选、列表候选、可选项）⇒ 显示但置灰**：整份候选**一个都不许少**，
  不可选的那个加 `disabled` 并在**同一行**末尾给原因（例：`编排生成者（内置） — 平台成员，不接业务任务`）。
  理由不是审美：候选**列表长度**本身是信息，滤掉之后"我的智能体是不是少了"这个问题
  在界面上无法回答，而且同一个人在不同页面看到的下拉会长短不一（2026-11 D145 之前正是这样）。
  置灰项**必须带原因**——只灰不说，读起来像坏了。
- **否（按钮、动作入口）⇒ 条件不满足就根本不出现**：按钮是"我现在能做的这件事"，
  不可做还占位会把真正能做的挤下去，也会让人反复点。例：只有起草者的对话里才出现「采纳」
  「改一版」，别的对话里这一排压根没有。

> 一句话：**候选格子里"缺人"要说出来（置灰 + 原因），动作按钮上"缺条件"直接不提（不渲染）。**

- 标题只有四级 + 一档标签，字号全在 `app.css`（**组件不许写 `h2`/`h3`/`h4` 的 `font-size`**）——见 §2.9。

### 2.8 三种状态：空 / 加载 / 错误

> ★ D178（使用者："比如'保存并运行'按钮的位置是怎么定的？"之后接着问的那一类：
> 界面上的**每一种东西**都该只有一种形状、长在一个地方）。
> 这三个状态的**词汇本来就在一处**（`app.css` 的 `.empty` / `.skeleton` / `.notice`），
> 缺的是"放哪 + 什么情况用哪个"。查下来：空态有 4 种写法（共享组件的 `empty` prop、
> 页内自写的 `.empty`、`.empty-value` 占位、以及一处用**内联 style 掰**全局样式的）；
> 加载态 24 处 `.skeleton` 里 **20 处**带随手写的内联 `height`/`width`/`margin`
> （4rem / 1.1rem / 40% / 55% / 60% / 70% / 80%…）；错误态有 **4 个去处**
> （正文 `.notice bad` 36 处 / toast 56 处 / 字段旁 `.hint bad` 4 处 / store 级 `loadError`
> 5 个键 9 个渲染点），而**没有一条规则说哪种情况用哪个**。

**一律长在正文里，不长在栏头。** 栏头是"我在哪 + 怎么回去"，状态是"这一块现在什么都没有"——
两者混在一起时，使用者分不清"界面坏了"还是"确实没有"（`MainArea` 的空态因此落在
`.pane-body` 里，窄屏没有标题、没有返回按钮）。

#### 2.8.1 空态：两档语境

| 语境 | 类 | 形状 | 例 |
|---|---|---|---|
| **整块**内容为空（列表 / 右栏 / 详情） | `.empty`（可带 `strong` + `p`） | 居中 + 虚线框 + 上下大内距 | 「还没有任务」/「选一个沉淀看详情」 |
| 内容区里的**一小格**为空（一次执行没有记录、一段没有产出） | `.empty.empty--flush` | 左对齐、**没有虚线框**、内距只留上下 | 定时任务详情的「执行记录」为空 |

- 措辞必须**分两类**：真没有（"还没有…"）与**筛掉之后没有**（"没有匹配…"）。
  只有前者是"这里本来是空的"，把后者说成"还没有"是**假话**（`ListPane` 的
  `empty` / `emptyFiltered` 两条分支就是为此；判据 `tasks.emptyStageWording` 钉着）。
- 字段"这一格没有值"是另一件事：用 `.empty-value`（不是 `.empty`）。
- **不许**用内联 `style` 掰（`Schedules.svelte` 曾用 `text-align:left;padding:.5rem 0`
  把整块空态硬掰成小格空态——那就是"同一个类在两个语境长得不一样，却没人说得出为什么"）。

#### 2.8.2 加载态：两档形状

| 形状 | 类 | 高度 | 用在哪 |
|---|---|---|---|
| **单行**（一行字的位置） | `.skeleton` | 1.1rem | 字段值、表里一行、一句说明还没读回来 |
| **一块**（一块内容的位置） | `.skeleton.skeleton--block` | 4rem | 列表、卡片、正文段落、材料格 |

- **宽度一律 100%**。原来那 20 处内联 `width:60%/70%/55%/40%/80%` 全删了：
  骨架的意义是"这里有东西、马上填上"，不是"假装内容有多长"。
- 要"两行骨架"就叠两个（`.skeleton + .skeleton` 自动留 `--sp-2`），
  不要再写内联 `margin-bottom`。
- 加载态**没有文字版**（全仓 0 处"加载中…"）：慢的地方一律给骨架，不给一句话。
  要自定义形状的（比如列表按行给骨架）走 `ListPane` 的 `loadingSkeleton` 插槽，
  但插槽里也只用上面两档。

#### 2.8.3 错误态：两个去处 + 一个不许

| 情况 | 去处 | 例子 |
|---|---|---|
| **这一块数据没拿到**（进页面 / 切页签时的读失败） | **正文里的 `.notice bad`**，可以带「重试」按钮 | 列表整拉失败（`loadError` 的 5 个键：agents / inbox / issues / skills / workflows）、技能页签读失败 |
| **一次操作的结果**（我按了某个按钮） | **toast**（成功也走这里） | 保存成功、删除失败、上传失败 |
| 字段级校验 | 就地 `.hint bad`（4 处） | 地址格式不对、密码太短 |

**不许**的：把"这一块数据没拿到"只交给 toast（一闪就没，而且下次进页面它还会再来一遍）；
把读失败渲染成一行灰字或一张空表（空表会被读成"这里本来就没有东西"——
`Skills.svelte` 里有好几处注释专门讲这个：**三者的下一步完全不同**）。

> 判据：`tests/ui-state.test.ts` 四条 + 探针 `states.emptyInBody` 一条。
> 说明为什么分两处：加载/错误两类是**瞬时**或**要制造故障**才出现的，探针一趟抓不到，
> 所以它们在源码层判（形状与去处都看得见）；探针只判"空态到底长在哪一层"。

### 2.9 标题层级：四级 + 一档标签（字号只有一处定义）

> ★ D179（沿用 D174–D178 的同一问法："这东西是不是只有一种形状、长在一个地方"）。
> 查下来的现状：层级**都在用**，但**没有一处写着"谁在哪一级"**——于是：
> `h2` 全局是 22px，`.detail-head` / `.pane-head` / `.main-panel-head` / `.mem-preview-head`
> **四处各写一遍"压回 17px"**；而"段内小节"有**四种写法**（`<h4>` / `<span class="cell-label">` /
> `<div class="proc-head">` / `<h3 class="artifact-sub">`），字号都是 13px，字色与权重各不相同，
> 其中 `.artifact-sub` 标签说"分段"、样式说"小节"；"看板列头"用 `<h4>` 却按 12px 大写标签写。
> 同一个值写四遍 = 层级没定义，谁再写第五遍也不会有人问为什么。

**四级 + 一档标签**（全部在 `app.css` 一处定义；组件里**不许**给 `h2/h3/h4` 写 `font-size`）：

| 级 | 标签 | 字号 / 权重 / 色 | 什么时候用 |
|---|---|---|---|
| **页名** | `h1.page-name`（只有顶栏有） | **15px / 500 / `--text-dim`** | 一页一个。**故意比卡片标题小**：顶栏那条是"我在哪"，要退后一层，别跟内容抢眼 |
| **这一块的名字** | `h2` | **17px / 600 / `--text`** | 栏头（`.detail-head` / `.pane-head`）、面板与卡片头（`.main-panel-head`）、正文里的块名（记忆预览、聊天空态标题） |
| **分段** | `h3` | **15px / 600** | `.drawer-section` 那种"一块内容里的第 N 段"。**比 h2 小 2px**——D179 当时定的是"与 h2 同字号、差的是位置不是大小"，**D197 改掉了**：设置页里 h3 就挂在 h2 底下（「通用」→「界面主题」），同值时两档在视觉上分不开。现在 17 / 15 / 13 三档两两差 2px，层级由字号表达（代价量过：整卡矮约 2px、无一处换行） |
| **段内小节** | `h4` | **13px / 600 / `--text-dim`** | 段里的小块名（`.proc-head`「步骤目标」、`.artifact-sub`「机械体检」、`.env-issues` 的「环境问题」、`.sub-block`「语音词表」） |
| **标签档**（不是标题） | `label` / `.cell-label` / `.column-label` | 13px / `--text-faint`；看板列头 12px 大写 | 字段名、单元格名、看板列头。**这一档不许用标题标签**（`<h1>`–`<h4>` 都不行） |

三条推论（都是从具体错误里抽出来的）：

- **浮层工具条那行不是标题**：`PromptEditor` 的头原来是 `<h3>`（画成 14/600），既不是标题档
  （17/600）也不是标签档（13/500）——它说的是"我在编辑什么"，属于工具条说明。**D194 换成了非标题元素**
  `<span class="pe-head-name">`（14/600 一字不改）。所以"允许组件自己写标题字号"的白名单现在是**空的**：
  组件里给 `h2`–`h4` 写 `font-size` 一律算违规（`tests/ui-headings.test.ts` + `tests/ui-style.test.ts` 各钉一遍）。
- **正文（Markdown）不跟界面层级走**：`.markdown h4` 显式保持 15px + 正文色。agent 写的
  "小标题"是内容，不是界面结构——把界面的 13px/dim 套上去，等于替 agent 决定它的小标题更弱。
- **标签档不许冒充标题**：看板列头原来是 `<h4>` 配 12px 大写 + faint，读屏与大纲里它会变成
  "第四级小标题"，而它其实只是"这一列叫什么"。现在它是 `.column-label`（一个 `div`）。

#### 2.9.1 卡片：网格与外壳也只有一套

- **网格** = `.card-grid`（`repeat(2, minmax(0, 1fr))` + `--sp-4` + `align-items: start`）。
  它原来在 `Settings.svelte`（`.set-grid`）与 `About.svelte`（`.ab-grid`）各写一遍，
  **五行逐字相同**——"关于页六卡与设置页同款"那句话当时只落在注释里。
- **外壳** = `.main-panel`（head + body [+ foot]）。关于页的六张卡原来用页面私有的 `.ab-card`：
  标题 15px（`.ab-card h2`）、边框 `border: 1px solid var(--surface-2)`——**拿填充档当线**
  （和 D174 修掉的 `.set-card` 一模一样，D174 只查了设置页）。现在两页同一套。
- 页面只决定**哪张卡跨行**（设置页的远端卡与布局卡 `grid-column: 1 / -1`）。

> 判据：`tests/ui-headings.test.ts` 五条（页名唯一 / 组件不许写标题字号 + app.css 里那把梯子不许被改 /
> 段内小节只许 h4 且标签档不许用标题标签 / 卡片只许 `.card-grid` + `.main-panel` 且旧壳名不许回来 /
> 填充档不许当边框线）+ 探针两条（`headings.levels` 在真 Chrome 里量四级字号与两条关系、
> `headings.aboutCards` 量关于页六卡与设置页同款）。
> 分工同 §2.8：**字号那条关系只有浏览器量得出来**（读 CSS 会让"四处覆盖同一个值"看着像没事），
> 源码只判"有没有第二处定义、有没有冒名顶替的标签"。


---

## 3. 结构性控件（不属于按钮族）

这些看起来"也是能点的"，但它们的形状是**内容的一部分**（整行、整格、标签页），
套 `.btn` 会把 accent 底色糊上去。它们各有自己的类，列在这里是为了让后来的人知道
"这不是漏网的按钮"，而是另一类东西：

`.list-row` / `.list-row-main` / `.list-row-action`（列表行）、`.tab`（页签）、
`.role-card`（角色卡）、`.nav-item`（侧栏项）、`.intake-choice`（带说明的选项块）、
`.file-row` / `.wd-dir` / `.wd-file`（文件树行）、`.prefix-x`（词条删除叉）、
`.cat-toggle` / `.agent-group-head` / `.ap-*`（折叠与分组头）、`.mem-pin`（记忆置顶星）、
`.expand-toggle`（▸）、`.pane-resizer`（拖动条）、`.env`（侧栏底部的环境块）。

**判据**：如果它需要**整行可点且要写背景/内距**，它多半属于这一类；
如果它是一句"要做一件事"的话，它属于按钮族。

---

## 4. 文案规则（界面上的字）

| 规则 | 说明 |
|---|---|
| 追加类动作用 `+` | 「往列表里加一条」的按钮写 `+`（配 `title`/`aria-label` 说清加什么），不写「加」/「新增」；中文动词留给真在做一件事的按钮（保存/删除/开始）。308 批定的：`+` 是符号，不随语言变长 |
| 一个动作一个词 | 销毁 = **删除**；从集合里移出、不销毁 = **移除**；卸载安装物 = **卸载**；取消这一次 = **取消**；离开浮层/面板 = **关闭**；主区面板回上一层 = **← 返回** |
| 确认框的确定按钮 = 那一行动作本身 | 「删除对话」「删除组」「删除任务」，不写「确认删除」这种第三种说法 |
| 一律 `…` 不写 `...` | 省略号用单个全角字符 |
| 一行说清，细节进 `title` | 界面上不摆第二行解释；放不下的进 `title`（悬停才看） |
| **不给失败原因留竖向空间** | 失败用 toast/状态色说，不在页面里插一行红字顶开布局 |
| 全部走 `$t()` | 界面上的中文字面量一律进 `packages/i18n/src/web/*.ts`；不用的键要删（有死键测试） |

---

## 5. 明说的例外（只剩两条，而且都不是风格问题）

| 例外 | 为什么留着 |
|---|---|
| `50%`（头像、圆点、进度环） | 那是"圆"这个**形状**，不是圆角档位 |
| `theme-picker` 的 `padding: 2px` | 选择器自己的内框，不是控件内距 |

> ★ 306 批（使用者口径："可以变像素，主要还是为了同一"）把原来这张表里的大半都**收掉了**：
> 17 处 `em` 字号与 `1.4em/1.2em/1.05em` 的 Markdown 标题分级全部换成 `--fs-*`，
> 唯一那处 `border-radius: 5px` 换成 `--radius-xs`。
> **静态护栏从此不放行 `em` 字号**——要相对父级就用令牌档位说话。

## 6. 加一个新控件 / 新页面的顺序

0. **新写一个列表页**（左列 + 右详情）⇒ 直接照抄 **§2.6 的列表页范例**，
   连 `<style>` 那两块一起抄。范例里的每一行都来自现有控件，不要"照着样子另写一份"。
1. 在 §2 里找**最接近的那一族**。找得到 ⇒ 直接用，别改它。
2. 找不到 ⇒ 问自己：它是"一句话能做的事"（→ 按钮族新变体）还是"一块有形状的内容"（→ 结构性控件）。
3. 需要新的**档位**（比如第三种控件高度）⇒ 先在 `app.css` 的令牌区加令牌，
   注释里写清"哪两处要用"；只有一处用就别加。
4. 组件样式里只写**这一处特有的东西**（宽度、栅格、滚动、对齐），不写底色/圆角/字号档。
5. 跑 `pnpm run check`（含静态护栏与 `svelte-check`）；改布局再跑 `pnpm run probe:layout`。

---

## 7. 怎么验证"各页真的是同一套"

静态护栏（`tests/ui-style.test.ts`）只证明**源码里**只有一份定义；"渲染出来一不一样"
它看不见（字号会被父容器的 `line-height`/`font-size` 带跑）。所以 `pnpm run probe:layout`
里另有三条**跨页**判据（`风格一致` 这一组，303 批加的）：

| 判据 | 量什么 |
|---|---|
| `style.pageStyles` + `style.btnUniform` | 六个页面里同一类按钮（**变体 + 尺寸**）的**字号**必须一致 |
| `style.badgeUniform` | 徽标在各页的圆角 / 字号 / 内距必须一致 |
| `style.rowTitleUniform` | 列表行标题在各页是同一档字号 |
| `skeleton.*` / `rowdetail.*` / `skeleton.listBox` | **五个列表页**（`LIST_PAGES`：聊天 / 任务 / 智能体 / 定时任务 / 编排）的栏头高、行高、行内标题、徽标、行盒、hover、**行容器 ul 的缩进与行距**——每一项都是**五页互相相等的等式**，不是单页的性质 |

⚠️ **新增一个列表页必须往 `tools/layout-probe/run.mjs` 顶部的 `LIST_PAGES` 加一行。**
漏了它，新页面就只剩"我为它同时写的自有判据"——那是自证：编排页整列缩进 40px、
行距 0 的那一版，探针 562 项全绿。

⚠️ 只比**字号**，不比高度：同一类按钮的高度跟着内容走（只有图标的、带两行标签的、
被父容器拉伸的），拿高度当判据立刻一片假红（第一版就这么写的）。

---

## 8. 相关文档

- 现状体检、逐条迁移记录、像素变更清单：[`style-audit.md`](./style-audit.md)
- 页面骨架为什么不这么排就会坏（两栏并排、栏头高度这些**类型检查看不见**的）：
  [`../../tools/layout-probe/README.md`](../../tools/layout-probe/README.md)
- 主题与令牌的来龙去脉：`packages/ui/src/styles/app.css` 顶部那段注释
