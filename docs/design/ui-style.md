# 界面风格规则（写界面之前先读这一份）

> 👤 **给写/改界面的人**：这里只有**规则**——控件长什么样、去哪拿类名、什么不许自己画。
> "为什么是这么定的""现状体检的数字"在 [`style-audit.md`](./style-audit.md)，那是一个 snapshot，
> 不要当规则读。令牌与类定义**只有一处**：`packages/ui/src/styles/app.css`。
>
> 一句话总纲：**同一个东西在哪个页面都得长得一样**；页面只决定"放什么、放在哪"，不决定"长什么样"。

---

## 0. 三条硬规则（其余都是这三条的展开）

1. **不写裸值**：字号、圆角、间距、颜色一律走令牌（`var(--fs-*)` / `var(--radius*)` / `var(--sp-*)` /
   主题色令牌）。裸 `px`/`rem`/`#hex` 只在 `app.css` 里、且下面有明确例外的地方出现。
2. **不在组件里重定义全局控件**：按钮/输入/徽标/卡片这几种形状，`app.css` 里已经有一份。
   组件里 `:global(.btn) { ... }` 或再造一个 `.my-button { padding/border-radius/background }`
   都是同一类缺陷——改配色时必然漏掉它。
3. **加新控件 = 先抽象再加**：界面里出现第二种"看起来一样、写得不一样"的东西时，
   先把它收进 `app.css` 的某一族，再在页面里用；不给自己开小灶。

`pnpm run check` 里有一条**静态护栏**（`tests/ui-style.test.ts`）专门抓违反这三条的改动。
它报错时不要绕过——绕过一次，下一个页面就又有理由抄一遍。

---

## 1. 令牌（`app.css` 的 `:root`）

| 组 | 令牌 | 说明 |
|---|---|---|
| 间距 | `--sp-1` 4px · `--sp-2` 8px · `--sp-3` 12px · `--sp-4` 16px · `--sp-5` 24px · `--sp-6` 32px · `--sp-8` 48px | 4 的倍数。**只用这几档**，6px/10px 这种中间值说明设计没想清楚 |
| 字号 | `--fs-3xs` 10px · `--fs-2xs` 11px · `--fs-xs` 12px · `--fs-sm` 13px · `--fs-base` 14px · `--fs-md` 15px · `--fs-lg` 17px · `--fs-xl` 22px · `--fs-2xl` 28px | 层级**从密到疏**；`--fs-base` 是正文默认 |
| 行高 | `--lh-tight` 1.3 · `--lh-base` 1.6 | 标题紧、正文松 |
| 圆角 | `--radius-none` 0 · `--radius-sm` 4px · `--radius-xs` 6px · `--radius` 8px · `--radius-lg` 12px · `--radius-pill` 999px | 控件用 `--radius`；小徽标/小方块用 `--radius-sm`/`--radius-xs`；胶囊用 `--radius-pill`；**圆形头像/圆点用 `50%`**（那是形状不是圆角档） |
| 控件高 | `--ctl-h` 1.9rem · `--ctl-h-sm` 1.5rem | 同一条带子上的控件必须等高；这两档是**已有的**两种 |
| 字族 | `--font` · `--font-mono` | 代码/日志/路径一律 `--font-mono` |
| 颜色 | `--bg` `--surface` `--surface-2` `--surface-hover` `--panel` `--line` `--line-strong` `--text` `--text-dim` `--text-faint` `--accent` `--accent-dim` `--good` `--bad` `--warn` `--status-*` | 亮/暗两套**同名**；组件里不写 `#hex`，否则暗色下必错 |

**加新令牌的门槛**：现存的档位表达不了、且**至少两处**要用。只有一处用的值就写在那一处，
不要为了"整齐"造一个只用一次的令牌（那只是把裸值换了个名字）。

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

### 2.2 输入 / 表单

- 单个控件：`input, textarea, select` 已经有全局样式（底色、描边、圆角、focus），**不要重写**。
- 标签 + 控件 + 说明：用 `.field`（内含 `> label`、`> input`），一行一个。
- 只读/不可用：`disabled` 属性（浏览器默认样式已配好），**不要**自己画一个灰框冒充。
- 输入框旁的动作（浏览…/发送）：动作本身是 `btn btn--ghost` 或 `btn btn--primary`，
  容器负责对齐，**不要在按钮上写 `height`**。

### 2.3 徽标 / 状态色

- 只读的状态小标签：`.badge`（胶囊），语义色由类后缀给：`.badge.todo/.in_progress/.in_review/.done/.blocked/.cancelled`。
- 文字状态色：`.good` / `.bad` / `.warn` / `.muted` / `.faint`（**颜色**，不是字号）。
- 字号工具：`.fs-xs`（12px，最常用）；更小的用令牌写在组件样式里，但**不许写裸 px**。

> `.small` 这个类 **298 批已删除**。旧代码里看到它就是没迁移完——换成 `.fs-xs`（文字）
> 或按钮上的 `btn--sm`（尺寸）。

### 2.4 页面骨架

| 位置 | 类 | 备注 |
|---|---|---|
| 三栏壳 | `.shell` + `.topbar` / `.sidebar` / `.main` | 顶栏高度 `--topbar-h`、侧栏宽 `--sidebar-w` |
| 列表 + 详情 | `.split-layout`（`.board` 看板 / `.with-detail` / `.with-artifact`） | 窄屏自动退成"列表 → 详情"两层 |
| 列表栏 | `.pane`, `.pane-head`, `.pane-body`, `.pane-foot`, `.pane-actions` | 栏头不放标题（D64） |
| 主区面板（设置这类） | `.main-panel` + `.main-panel-head`（`h2` + `.panel-back`）+ `.main-panel-body` + `.main-panel-foot` | **所有"整块换掉右栏"的面板都长这样** |
| 详情头 | `.detail-head` + `.detail-sub` + `.detail-actions` | 动作按钮 ≥2 个时自动画分组轨道 |
| 空态 | `.empty`（可带 `strong` + `p`） | 别自己拼居中的灰字 |
| 提示条 | `.notice` + `.bad` / `.warn` / `.good` | 一句话；更长的进 body |
| 浮层 | `.drawer*` / `.modal*` / `.page-menu` / `.toast` | 遮罩 + 描边 + `--shadow-2` 三层一起给 |
| 表格 | `.table-wrap`（壳）+ `<table class="table">` | 307 批：表头/单元格内距等规则挂**元素选择器与 `.table` 两条**，所以"长得像表格但不是 `<table>` 元素"的东西加 `class="table"` 就同款 |
| 折叠 | `.fold-section` / `.fold-head` / `.fold-body` | |

### 2.5 已经归位、**不要**再新画的

`SettingsPanel.svelte` 是"主区面板"的共享外壳（`section.main-panel` + 头部返回 + body + foot），
新加一个设置页 = **用它 + 写内容**，不要自己再拼一遍头部和返回按钮。

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

⚠️ 只比**字号**，不比高度：同一类按钮的高度跟着内容走（只有图标的、带两行标签的、
被父容器拉伸的），拿高度当判据立刻一片假红（第一版就这么写的）。

---

## 8. 相关文档

- 现状体检、逐条迁移记录、像素变更清单：[`style-audit.md`](./style-audit.md)
- 页面骨架为什么不这么排就会坏（两栏并排、栏头高度这些**类型检查看不见**的）：
  [`../../tools/layout-probe/README.md`](../../tools/layout-probe/README.md)
- 主题与令牌的来龙去脉：`packages/ui/src/styles/app.css` 顶部那段注释
