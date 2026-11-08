# 界面风格审计（批 297 只读盘点 → 批 298 起逐批落地）

> **怎么读这份文档**：§0–§8 是 297 批量到的现状（数字是当时的），§9–§10 是目标与进度；
> 表格里标了「已落地 / ✅」的就是 298 批做完的。**规则本身**（新代码该怎么写）之后会
> 单独整理到 `docs/design/ui-style.md`（300 批），这份文档留作"为什么是这么改的"证据。

> **这份文档是"体检报告 + 迁移计划"**，不含任何改动。
> 规则本体在 [`./ui-style.md`](./ui-style.md)（批 300 落地）；本文件只记录**现状**与**要改什么**。
> 目标（使用者定）：**同一类控件在所有页面上长得一样**；先把风格抽象成**类体系**（按钮只有几类，
> 每类一个类名，共性用一个 base），再逐页收敛，并**把规则写进文档**防止下一批人重新发明。

---

## 0. 三条硬口径（使用者定的，别改）

1. **不允许"顺手改像素"**：字面值换成等值令牌不算变化；**跨页不一致必须收敛**的那几处，
   逐条列在本文件 §6，等你点头才动。
2. **彻底改类名**（不保留旧写法打补丁）：按钮一律 `btn btn--*`；`.small` 一律 `.fs-xs`。
3. 远端管理页（`apps/remote/web`）**不在范围**。

---

## 1. 检查方法

| 层 | 手段 | 判据 |
|---|---|---|
| 静态 | 扫 `apps/web/src/**` + `packages/ui/src/**` 的 `.svelte` / `.css` | 字号/圆角/控件内距必须来自令牌；同一控件族只允许 base + 变体 |
| 运行时 | `tools/layout-probe`（真 Chrome，量 computed style） | 同一类控件在不同页面的 `fontSize/height/padding/borderRadius/color` 集合一致 |
| 文案 | 扫 `packages/i18n/src/web/*.ts` | 同一动作同一词；省略号统一 `…`；按钮文案不带句号 |

扫描脚本：`.cache/style-audit/scan.mjs`（临时的，批 300 收成 `scripts/style-audit.mjs` 并可 `pnpm run style:audit`）。

---

## 2. 现状：裸值（不走令牌）

### 2.1 字号：**30 处 / 15 种取值** —— ✅ 299 已收（剩 17 处 `em`，按使用者口径保持不动）

| 处数 | 现值 | 应换成 | 是否改像素 |
|---|---|---|---|
| 8 | `0.9em` | 视父级而定（见 §6） | ⚠️ 需逐条看 |
| 3 | `12px` | `--fs-xs`（0.75rem = 12px） | 否（等值） |
| 3 | `0.8125rem` | `--fs-sm` | 否（等值） |
| 2 | `11px` | 新增 `--fs-2xs: 11px` | 否（等值） |
| 2 | `0.6875rem` | `--fs-2xs`（11px） | 否（等值） |
| 2 | `0.85em` | 视父级 | ⚠️ |
| 2 | `0.92em` | 视父级 | ⚠️ |
| 1 | `0.8em` / `0.95em` / `1.05em` / `1.2em` / `1.4em` | 视父级 | ⚠️ |
| 1 | `10px` | 新增 `--fs-3xs: 10px` | 否 |
| 1 | `0.625rem` | `--fs-3xs`（10px） | 否 |
| 1 | `0.75rem` | `--fs-xs` | 否 |

**299 批落地**：13 处非 `em` 的全部换成令牌（`10px`/`0.625rem` → `--fs-3xs`（新增，0.625rem=10px）、
`11px`/`0.6875rem` → `--fs-2xs`（新增）、`12px`/`0.75rem` → `--fs-xs`、`0.8125rem` → `--fs-sm`），
**像素一个没动**。剩下的 17 处 `em` 是使用者点头"保持 `em` 原样"的那批（§6 A）——
`em` 跟着父级走，换 `rem` 必然变，所以留着，并在 301 的护栏里给它开一个显式例外。

### 2.2 圆角：**23 处 / 7 种取值** —— ✅ 299 已收（剩 1 处 `5px` 保持不动，2 处 `var(--r-sm)` 待 300）

| 处数 | 现值 | 结论 |
|---|---|---|
| 8 | `0` | 语义是"直角"（表格/卡片边合并）⇒ 保留，但写成 `--radius-none: 0` |
| 5 | `4px` | `--radius-sm`（等值） |
| 3 | `100px` | `--radius-pill: 999px`（**会变像素**：100→999 在圆角上视觉等价，但声明值变了；属等值替换） |
| 2 | `var(--r-sm)` | ⚠️ **这个令牌不存在** ⇒ 声明静默失效 |
| 2 | `var(--r-2, 6px)` | ⚠️ 令牌不存在，实际吃 fallback 6px |
| 1 | `var(--r-1, 4px)` | ⚠️ 同上，吃 4px |
| 1 | `6px` / `5px` | 收敛到 `--radius`(8) 还是新增一档？见 §6 |

**299 批落地**：`0` → `--radius-none`、`4px` → `--radius-sm`、`999px`/`100px` → `--radius-pill`、
`6px` → `--radius-xs`（新增档，等值）、`var(--r-2, 6px)` → `--radius-xs`、`var(--r-1, 4px)` → `--radius-sm`。
**`100px` → `999px` 是唯一"声明值变了、视觉没变"的一类**（胶囊形状在 100px 与 999px 上完全一致），
探针那条"徽标同一形状"因此改成认"两边一致 + 都是胶囊"，不再认历史字面量。
`5px`（`app.css:238` 一处）使用者点名**保持原样**；`DirPicker` 的两处 `var(--r-sm)` 是**死声明**
（根本没有 `--r-sm` 这个令牌、也没有 fallback ⇒ 浏览器当作 `0`），它要改就会变像素，
归到 300/302 的"未定义变量"里一并决定。`50%` 是圆形/头像，不是圆角档，不在收敛范围。

### 2.3 控件内距/高度：**66 处**裸 `px`/`rem` —— ⚠️ 只做了"等值"的那几处

合法例外（**不改**）：`min-height` / `max-height`（长文本框的下限/上限，本来就是内容相关）、
`width: 1.2em` 这类图标尺寸。其余归入 §3 的组件重定义。

300 批把**值正好等于某一档 `--sp-*`** 的换掉了（`0 4px` → `0 var(--sp-1)`、
`0 0.5rem` → `0 var(--sp-2)` 等，像素不变）。剩下 **约 40 处是"不在 4 的倍数上"的
内距**（`6px 10px`、`3px 10px`、`1px 9px`、`0.15rem 0.5rem`…），它们各自属于某一个小控件的
历史尺寸：**换成 `--sp-*` 就会改像素**（6px→8px、3px→4px）。这类值本轮**不动**，
理由与 §6 一致——"统一"不等于"顺手挪 1px"。

真要收它们，是一轮**有意的视觉调整**：逐条列出"这个控件该多松"再改，
并且要重跑探针里所有按像素断言的行高/对齐判据。

### 2.3.1 剩下的**裸内距**逐条（303 批量的，共 25 处；`em` 的不列——那是刻意跟着字号缩的）

| # | 位置 | 现值 | 若收敛到 `--sp-*` | 会差 |
|---|---|---|---|---|
| 1 | `ActionPicker` `.ap-chip` | `1px 9px` | `0 var(--sp-2)` | −1 / −1 |
| 2 | `ActionPicker` `.ap-expand` | `1px 8px` | `0 var(--sp-2)` | −1 / 0 |
| 3 | `ActionPicker` `.ap-search` | `2px 8px` | `var(--sp-1) var(--sp-2)` | +2 / 0 |
| 4 | `ActionPicker` `.ap-badge.fixed` | `0 7px` | `0 var(--sp-2)` | 0 / +1 |
| 5 | `ActionPicker` `.ap-bound-row` | `1px 0` | `0`（竖直不要） | −2 |
| 6 | `ChatMemoryTidy` `.tidy-text` | `1px 4px` | `0 var(--sp-1)` | −2 / 0 |
| 7 | `ChatSettings` `.prefix-x` | `0 2px` | `0` | 0 / −4 |
| 8 | `CrystallizeDraftEditor` `.file-row` | `6px 10px` | `var(--sp-2) var(--sp-3)` | +4 / +2 |
| 9 | `CrystallizeView` `.file-row` | `6px 10px` | 同上（**与 #8 完全同值：同一个形状写了两遍**） | +4 / +2 |
| 10 | `CrystallizeDraftEditor` `.change-tag` | `0 5px` | `0 var(--sp-1)` | 0 / −1 |
| 11 | `CrystallizeView` `.change-tag` | `0 5px` | 同上（**与 #10 同值**） | 0 / −1 |
| 12 | `CrystallizeView` `.tab-count` | `0 5px` | `0 var(--sp-1)` | 0 / −1 |
| 13 | 两处 `.hunk-head` | `0.15rem 0.5rem` | `2px var(--sp-2)` | 约 0 / 0 |
| 14 | `CrystallizeDraftEditor` `.pane-tabs > button` | `3px 10px` | `var(--sp-1) var(--sp-3)` | +2 / +4 |
| 15 | `CrystallizeView` `.new-version-bar` | `6px 10px` | `var(--sp-2) var(--sp-3)` | +4 / +2 |
| 16 | `DirPicker` `.row` | `0.15rem 0.35rem` | `2px var(--sp-1)` | +0.4 / +2.6 |
| 17 | `FirstSentenceTemplate` `.tpl-state .badge` | `1px 6px` | **不该改**：它是 `.badge` 的重画（见 §9 的收口规则），理想是并进 `.badge--sm` | — |
| 18 | `WorkDirTree` `.wd li` | `2px 0` | `0`（竖直不要） | −4 |
| 19 | `app.css` `.theme-picker` | `2px` | `0` | −4 |
| 20 | `app.css` `code` / `.markdown code` / `.badge--sm` / `.unread` | `em` | **不动**（跟着字号缩才对齐） | — |

**能"等值"先做的**：只有 #13（`0.15rem` 就是 2px 的另一种写法）。其余每一条都要动 1–4px，
**所以本轮一条都没动**。如果要做，建议**一次只做一屏**（比如先把沉淀页的差异视图 #8–#15
统一到 `--sp-*`，再跑探针），否则出问题时分不清是哪一屏。

**顺手能做的（不下 1px 的）**：#8/#9、#10/#11 是**同一个形状在两个组件里各写一遍**，
把它们抽成 `app.css` 的一个 `.diff-*` 家族是**等值**的——这才是"统一"该先做的事。

### 2.3.2 下一批（304）的施工单（使用者已点头"按建议做"）

**A. 抽取差异视图的三个形状（像素不变）**

`CrystallizeDraftEditor.svelte` 与 `CrystallizeView.svelte` 里 `.file-row` / `.change-tag` /
`.hunk-head` 三条规则**逐字相同**（已比对）：

| 类 | 两份的声明 |
|---|---|
| `.file-row` | `display:flex; align-items:center; gap:8px; width:100%; padding:6px 10px; background:transparent; border:0; border-bottom:1px solid var(--line); font:inherit; color:inherit; text-align:left; cursor:pointer` |
| `.change-tag` | `flex:0 0 auto; padding:0 5px; border-radius:var(--radius-sm); font-size:var(--fs-2xs); line-height:1.5; border:1px solid var(--line)` |
| `.hunk-head` | `padding:0.15rem 0.5rem; color:var(--text-faint); background:var(--surface-2); border-top:1px solid var(--line); user-select:none` |

做法：在 `app.css` 里加**带作用域**的一组（`.diff-view .file-row` 这样），
两个组件的外层容器加 `class="diff-view"`，再把三份本地规则删掉。
⚠️ **不要**直接写成全局 `.file-row`：`FileViewer` / `WorkDirTree` / `ActionPicker` 里也有
同名类（各自 scoped），全局化会把这几条属性漏过去。

**B. 再动内距（会改像素，一屏一批）**

顺序建议：① 沉淀页差异视图（#8–#15）→ ② `ActionPicker`（#1–#5）→ ③ 其余零散（#6/#7/#16/#18/#19）。
每屏做完跑一次 `pnpm run probe:layout`（618 项），红了就当场看清是哪一屏的哪个断言。
#17（`.tpl-state .badge`）**不按内距改**，它是 `.badge` 的重画，该并进 `.badge--sm`。

---

## 3. 组件在重定义控件外观（**7 处**）

| 位置 | 类 | 问题 |
|---|---|---|
| `AgentDetail.svelte:1991` | `.btn-mini` | 自造"迷你按钮"（记忆行内） |
| `AgentDetail.svelte:2021` | `.btn-small` | 自造"小按钮"（与全局 `.small` 语义重叠） |
| `AgentDetail.svelte:2036` | `.btn-link` | 自造"文字按钮" |
| `Chat.svelte:1461` | `.btn-link` | 又一份 `.btn-link`（与上面重复定义） |
| `Topbar.svelte:240/253` | `.icon-btn` | 自造图标按钮（顶栏） |

⇒ 全部收进 `app.css` 的按钮族（§4），组件里删掉。

---

## 4. 按钮族现状：**组合已经碎片化**

`<button>` 上的 class 组合（出现次数）：

```
 19 × [ghost]              11 × [ghost small]        10 × [secondary]
  4 × [primary]             3 × [btn-link]            3 × [danger]
  3 × [intake-choice]      + 一次性组合：
    artifact-close ghost / ghost tiny / ghost stop / ghost small stop /
    back-to-list ghost small / ghost panel-back small / ap-chip / list-row-main
```

**迁移目标（全部机械替换）——2026-11 批 298 已落地**

| 旧 | 新 | 落地情况 |
|---|---|---|
| （无 class，裸 `<button>`） | `btn btn--primary`（默认主操作） | ✅ 唯一一处（`Tools` 的「更新」） |
| `ghost` | `btn btn--ghost` | ✅ |
| `secondary` | `btn btn--secondary` | ✅ |
| `primary` | `btn btn--primary` | ✅ |
| `danger` | `btn btn--danger` | ✅（`ghost danger` 两处合并成 `btn--danger`：旧 CSS 里 `button.danger` 写在 `button.ghost` 之后，只有它生效） |
| `btn-link` | `btn btn--link` | ✅；`Chat` 那条更淡的撤销链再加 `btn--quiet`（虚线下划线） |
| `ghost small` / `secondary small` / `primary small` / `danger small` | 上面各变体 + `btn--sm` | ✅ |
| `ghost tiny`（跑日志展开） | `btn btn--ghost btn--sm` + 组件内只留横向内距 | ✅ |
| `.icon-btn`（顶栏） | `btn btn--icon` | ✅ 组件里那三条规则删掉，SVG 尺寸归 app.css |
| `.btn-mini`（记忆行） | `btn btn--mini` | ✅ |
| `.btn-small`（表单「记下」） | `btn btn--secondary btn--tight`（小内距 + 描边，字号仍是 `--fs-sm`） | ✅ |
| `ghost small primary-ghost`（误留的死类） | `btn btn--ghost btn--sm` | ✅ 去掉 `primary-ghost`（从来没有对应规则） |

**尺寸**：`btn`（默认，高 `--ctl-h` = 1.9rem）/ `btn--sm`（只降字号，形状不变）/
`--mini`（行尾极小动作）/ `--tight`（小内距 + 描边）/ `--icon`（方形，SVG 1rem）。

**结构性控件不在按钮族里**（它们自带形状，套 `.btn` 会把底色变成 accent）：
`.intake-choice`、`.role-card`、`.tab`、`.list-row-main` / `.list-row-action`、`.prefix-x`、
`.agent-group-head`、`.cat-toggle`、`.draft-turn-toggle`、`.file-row`、`.ap-*`、`.artifact-tab`、
`.card`、`.env`、`.history-row`、`.mem-pin`、`.nav-item`、`.pane-resizer`、`.row.dir`、
`.run-tab`、`.terms-label`、`.wd-dir`、`.wd-file`。清单同步在 `app.css` 的按钮族注释里。

**远端管理页（`apps/remote/web`）只做机械跟随**：它 import 同一份 `app.css`，
所以 `.small` 一改名它就跟着坏——本轮把它的 `small` 换成 `fs-xs`、
`secondary small` 一类换成 `btn btn--*`，但**不重新设计它**（使用者口径：那页不在本轮范围）。

---

## 5. `.small` 的迁移（**273 处**，其中 42 处与 `ghost` 同用）

`.small` 现在**兼两职**：字号（`--fs-xs`）×200 处与 `faint` 同用；按钮尺寸 ×42 处与 `ghost` 同用。

⇒ 拆分：

- 文本上的 `.small` → **`.fs-xs`**（纯字号工具，语义清楚）——✅ 298 已做完（`app.css` 里
  `.small` 这个类**已删除**，不是留了别名：留别名就还是两套名字）
- 按钮上的 `.small` → 由 `btn--sm` 接管（尺寸是按钮族的属性，不是字号）——✅
- 与 `.faint` 同用的 `.faint small` → `.faint .fs-xs`——✅（探针判据跟着改成
  `.hint.faint.fs-xs, .hint.fs-xs` 计数为 0）

---

## 6. ⚠️ 会改到像素的地方（需要你逐条点头）

**A. `em` 单位字号（17 处）** —— `em` 相对父级字号，换成 `rem`/令牌必然改变实际大小。逐条给：

| 位置 | 现值 | 父级字号 | 换算 | 选项 |
|---|---|---|---|---|
| `RunLog.svelte:565` | `0.9em` | 待量 | — | ① 保持 `em`（不进令牌）② 换成 `--fs-sm`（13px，可能变小） |
| `RunLog.svelte:585` | `0.95em` | 待量 | — | 同上 |
| `RunLog.svelte:634` / `CrystallizeView.svelte:2219` | `0.85em` | 待量 | — | 同上 |
| `NewAgentForm.svelte:347/442`、`MemberSlotForm.svelte:324/344`、`AgentDetail.svelte:1565/1716`、`Groups.svelte:721` 等 | `0.9em` | 待量 | — | 同上 |
| `MemberSlotForm.svelte:398` | `0.8em` | 待量 | — | 同上 |

**B. 圆角 `6px` / `5px`（各 1 处）** —— 收敛到 `--radius`(8) 会变；或新增 `--radius-xs: 6px` 保持等值。
**建议：新增 `--radius-xs: 6px`，`5px` 归到它**（差 1px，属本清单要你决定的一项）。

**C. 顶栏按钮高度** —— `.topbar .page-actions button { height: 1.5rem }`，
而 `btn` 默认 `1.9rem`，`btn--sm` `1.5rem` ⇒ 顶栏按钮改成 `btn--sm` 后**等值**。
（298 批的做法更省事：`.topbar .page-actions button` 这条上下文规则**原样保留**，
只把 `1.5rem` 换成 `--ctl-h-sm`——所以顶栏根本不参与"重量/尺寸"那套类名。）

### 6.1 这一轮**真的会看到差别**的地方（302 批要逐条过的就是这份）

| # | 位置 | 差别 | 性质 |
|---|---|---|---|
| 1 | 沉淀草稿页的**差异视图**（`.hunk-head`、文件树 hover/选中） | hunk 头多了上边框、辅助字颜色变淡；文件树 hover/选中**多出底色**（原来没有） | 修 bug（§8） |
| 2 | `DirPicker` 的目录行 | hover 多出底色；圆角 0 → 4px | 修 bug（§8） |
| 3 | `SkillHistory` 的差异统计 | `+n` / `-n` 的绿换成主题绿 `--good`（暗色下可读性明显变好） | 修 bug（§8） |
| 4 | `ChatMemoryTidy` 的告警字 | 亮色下 `#b9770e` → `#b7791f`（几乎看不出），暗色下才正确 | 修 bug（§8） |
| 5 | 「私有成员」徽标（`MemberSlotForm`） | 底色 alpha 12% → 10%（跟系统徽标同一配方），字号/内距不变 | 统一配方 |
| 6 | `ChatComposer` 的「附件」按钮、`FootFiles` 的计数、`ChatBubble` 的 who 行、`SourceRef` | **字号回到设计值**：298 批把 `.small` 删掉时漏改了 `packages/ui/src/components/`（4 个共享组件），它们一度失去 12px；300 批修好 | 把我自己的疏漏修回来 |
| 7 | 远端管理页的 4 处圆角 | 0 → 4px | 修 bug（§8） |
| 8 | 所有确认框 | 「确认删除」→「删除对话」（与组 / 任务同名） | 文案 |

**没有变**的：按钮的重量/尺寸（298 用的是等值映射）、字号层级（299 全是等值替换）、
圆角档位（`100px`→`999px` 形状相同）、间距（没动 `--sp-*` 的用法）。

---

## 7. 文案不一致（第 2 条：纳入本轮）

| 动作 | 现状 | 建议 |
|---|---|---|
| 删除 / 移除 | 18 处「删除」，5 处「移除」 | 统一为**删除**（"移除"只留给"从列表移出去但不销毁"的语义，若有则保留并在文档写明） |
| 取消 / 关闭 | 11 处「取消」，2 处「关闭」 | **按钮**统一「取消」；**浮层/面板的离开**用「关闭」；主区面板的返回用「← 返回」（已在用） |
| 返回 | 5 处 | 主区面板统一「← 返回」；窄屏列表返回用「← 返回列表」 |
| 省略号 | 用户文案里**没有** `...`（21 处 `...` 全在注释/展开语法里） | 无需改；把它写进规则（用户文案一律 `…`） |

---

## 8. 真正的 bug：**未定义的 CSS 变量**（20 个）—— ✅ 300 批全部修完

其中 **7 个没有 fallback ⇒ 声明整条失效**（写了等于没写）：

| 变量 | 应为 | 位置 |
|---|---|---|
| `--fg-faint` ×5 | `--text-faint` | `CrystallizeDraftEditor.svelte:270/293/298`、`SkillHistory.svelte:302`、`CrystallizeView.svelte:2339` |
| `--fg` ×1 | `--text` | `CrystallizeDraftEditor.svelte:458` |
| `--fg-soft` ×1 | `--text-dim` | `CrystallizeDraftEditor.svelte:451` |
| `--bg-hover` ×1 | `--surface-hover` | `DirPicker.svelte:301` |
| `--text-muted` ×1 | `--text-dim` | `CrystallizeView.svelte:2277` |
| `--border` ×2 | `--line` | `CrystallizeDraftEditor.svelte:272`、`CrystallizeView.svelte:2341` |
| `--fs-small` ×1 | `--fs-xs` | `SkillHistory.svelte:296` |

另有带 fallback 的：`--r-1`(4px)、`--r-2`(6px)、`--r-sm`；以及**运行期由 inline style 注入**的合法项
（`--level`、`--artifact-w`、`--create-pad-x`），不算错。

**300 批怎么修的**（逐条落到真令牌，括号里是"修完会不会看出来"）：

| 原来 | 改成 | 看出来吗 |
|---|---|---|
| `--fg-faint` ×5 | `--text-faint` | 会：那几行辅助字以前跟着父级颜色（常常是正文色，比应有的深一档） |
| `--fg` | `--text` | 同上 |
| `--fg-soft` | `--text-dim` | 同上 |
| `--bg-hover` | `--surface-hover` | **会**：`DirPicker` 的行原来 hover 没有底色（声明整条失效），现在真的有 |
| `--text-muted` | `--text-dim` | 会 |
| `--border` ×2 | `--line` | **会**：差异视图的 hunk 头原来没有上边框 |
| `--fs-small` | `--fs-xs` | 会：跑日志差异区字号从继承值变成 12px |
| `--hover` / `--active`（差异视图文件树） | `--surface-hover` | **会**：原来 hover/选中都没底色 |
| `--bg-sunken`、`--panel-sunken` | `--surface-2` | **会**：亮色下几乎一样；暗色下原来吃的是写死的浅灰（白底黑字），现在才是主题色 |
| `--r-sm`（`DirPicker` 两处） | `--radius-sm` | **会**：那两处原来圆角是 0（死声明），现在是 4px |
| `--ok`（`SkillHistory` 两处） | `--good` | **会**：色相从 `#2a7` 挪到主题绿，暗色下也读得清 |
| `--text-warn`（`ChatMemoryTidy`） | `--warn` | 会：亮色下 `#b9770e` → `#b7791f`（肉眼几乎看不出），暗色下才正确 |
| `--radius-1`（远端管理页 4 处） | `--radius-sm` | **会**：那几处原来圆角是 0 |

这些**不是"风格统一"的副作用，是修 bug**——它们本来就该是那个样子，只是一直没生效。
`probe:layout` / `probe:remote` 全绿说明没有把布局弄坏；观感差异集中在**沉淀草稿/差异视图**
与 **`DirPicker` 的 hover**，值得你点开看一眼（302 批会逐条过）。

---

## 9. 类体系目标（批 298 落地到 `app.css`）

| 族 | base | 变体 | 尺寸 |
|---|---|---|---|
| 按钮 | `.btn` | `--primary / --secondary / --ghost / --danger / --link` | `--sm` / `--icon` |
| 输入 | `.field`（label+控件+提示） | `--invalid` / `--locked` | `--sm` |
| 勾选行 | `.check` | `--inline` | — |
| 页签 | `.tabs` + `.tab` | `.active` | `--sm` |
| chip / 徽标 | `.chip`（可点） / `.badge`（只读） | badge 语义色 | `--sm` |
| 卡片 / 面板 | `.card` / `.panel`（head/body/foot） | `--flush` | — |
| 列表行 | `.list-row` | `--active` / `--danger` | — |
| 标题 | `.section-title`(h3) / `.sub-title`(h4) | — | — |
| 辅助文字 | `.hint` / `.hint--bad/--warn` | — | — |
| 字号工具 | `.fs-xs`（在用；其余档在需要时再加，不预先造） | — | — |
| 强调色字 | `--on-accent`（压在 accent 实心块上的白字） | — | — |

新增令牌（298 批已加进 `app.css`）：`--radius-none: 0`、`--radius-xs: 6px`、
`--radius-pill: 999px`、`--ctl-h: 1.9rem`、`--ctl-h-sm: 1.5rem`。

- `--ctl-h` / `--ctl-h-sm` 当批就用掉了（`.topbar button` / `.topbar .page-actions button`），
  不再是"登记待用"。
- `--radius-*` 三个是给 299/302 的裸圆角迁移用的：**保留等值**（`6px` 就是 `6px`），
  换名不改像素。
- `--fs-2xs` / `--fs-3xs` 在 299 批加上了（那批真用到了 13 处）。
- 300 批新加的：`--on-accent`（原 11 处写死 `#fff`）、`.badge--sm` / `.badge--accent`、
  `.field` 收下"竖排 + 间距"（两个组件里各抄了一遍）、`.field--flush`、
  `.btn--link:disabled` 的禁用色（原来在 `AgentDetail` 里另有一份）。
- `badge`/`field` 的**形状**现在只有 `app.css` 一份；组件里只允许写位置类属性
  （`align-self` 这类）——这条由 301 批的静态护栏钉住。

---

## 10. 分批计划

| 批 | 内容 | 验证 |
|---|---|---|
| 297 | 本报告 + 扫描脚本 | 无代码改动 |
| **298**（本批，合并了原 298+299） | 令牌补齐 + `app.css` 按钮族（`btn` / `--primary/--secondary/--ghost/--danger/--link` / `--sm/--mini/--tight/--icon`）+ **全量组件迁移** + `.small` → `.fs-xs` + 删组件里那四个自造按钮类 | `check`（2464）+ `probe:layout`（615）+ `probe:remote`（27） |
| **299**（本批） | 裸字号 / 裸圆角 → 令牌（等值，像素不动）；新增 `--fs-2xs` / `--fs-3xs`（当批就用上） | `check`（2464）+ `probe:layout`（615） |
| **300**（本批） | 修 20 个未定义变量（§8）+ `--on-accent` + `.field`/`.badge` 变体收进 `app.css` + 清掉 `packages/ui` 组件里漏改的 `.small`（**298 批扫描范围漏了这个目录，护栏抓出来的**）+ 文案：确认框按钮与动作同名 + 写 `docs/design/ui-style.md` + 三处指路 | `check`（2469）+ `probe:layout`（615）+ `probe:remote`（27） |
| **301**（本批） | 静态护栏 `tests/ui-style.test.ts`（5 条） | `check`（含护栏） |
| 302 | 还剩 **§6 的像素变更逐条过一遍**（多数已在 298–300 顺带落地，清单见上）+ 你抽查页面 | 你抽查页面 |
| **303**（本批） | 把"各页是不是同一套"**量出来**：探针新增 3 条跨页判据（同一类按钮的字号、徽标形状、行标题字号），六个页面各取一份样本 | `probe:layout`（615 → **618**） |

**303 量到的**（六个页面：聊天 / 任务 / 智能体 / 技能 / 工具 / 组）：

- **按钮字号按"变体+尺寸"跨页完全一致**：顶栏那一排 13px、页面里默认 14px、`btn--sm` 12px；
  连顶栏里 `btn--icon` 也与普通顶栏按钮同为 13px。
- **徽标形状一致**：任务页与智能体页的 `.badge` 都是 `999px / 12px / 1.6px 8px`。
- **列表行标题一致**：三页都是 14px。
- 高度**不**参与这条判据（同一类按钮的高度跟着内容走：只有图标的、带标签的、行内被拉伸的），
  第一版拿高度当判据时在 `btn--ghost` 上量到 22/24/53/64 四种——那是正常差异，不是缺陷。
  这条教训写进了 `run.mjs` 的 `uniformViolations` 注释。

> **§9 里那几族（输入 / 勾选 / chip / 卡片 / 列表行 / 标题）没有全部抽象完**：
> 体检发现真正在**重复定义**的只有按钮、`.field`、`.badge` 三处（已收）；
> 其余几样（`.tab`、`.card`、`.list-row`、标题）各页只有**一份**定义，
> 没有"同一形状写两遍"的证据。**当前的价值不在把它们再包装一层，而在守住
> "不许再出现第二份"**——这件事 301 的护栏已经在做了。真要统一外观时再动，
> 那时是一次**有意的视觉调整**，不属于"统一成同一份"的范围。
