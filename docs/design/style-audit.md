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

### 2.3 控件内距/高度：**66 处**裸 `px`/`rem`

合法例外（**不改**）：`min-height` / `max-height`（长文本框的下限/上限，本来就是内容相关）、
`width: 1.2em` 这类图标尺寸。其余归入 §3 的组件重定义。

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

---

## 7. 文案不一致（第 2 条：纳入本轮）

| 动作 | 现状 | 建议 |
|---|---|---|
| 删除 / 移除 | 18 处「删除」，5 处「移除」 | 统一为**删除**（"移除"只留给"从列表移出去但不销毁"的语义，若有则保留并在文档写明） |
| 取消 / 关闭 | 11 处「取消」，2 处「关闭」 | **按钮**统一「取消」；**浮层/面板的离开**用「关闭」；主区面板的返回用「← 返回」（已在用） |
| 返回 | 5 处 | 主区面板统一「← 返回」；窄屏列表返回用「← 返回列表」 |
| 省略号 | 用户文案里**没有** `...`（21 处 `...` 全在注释/展开语法里） | 无需改；把它写进规则（用户文案一律 `…`） |

---

## 8. 真正的 bug：**未定义的 CSS 变量**（20 个）

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
| 字号工具 | `.fs-2xs / .fs-xs / .fs-sm / .fs-base` | — | — |

新增令牌（298 批已加进 `app.css`）：`--radius-none: 0`、`--radius-xs: 6px`、
`--radius-pill: 999px`、`--ctl-h: 1.9rem`、`--ctl-h-sm: 1.5rem`。

- `--ctl-h` / `--ctl-h-sm` 当批就用掉了（`.topbar button` / `.topbar .page-actions button`），
  不再是"登记待用"。
- `--radius-*` 三个是给 299/302 的裸圆角迁移用的：**保留等值**（`6px` 就是 `6px`），
  换名不改像素。
- `--fs-2xs` / `--fs-3xs` 这一批**没有**加：本轮没有一处字号需要它们（`11px`/`10px`
  那几处属于 299 的裸值迁移，等真要用再加，免得留一个没人用的令牌）。

---

## 10. 分批计划

| 批 | 内容 | 验证 |
|---|---|---|
| 297 | 本报告 + 扫描脚本 | 无代码改动 |
| **298**（本批，合并了原 298+299） | 令牌补齐 + `app.css` 按钮族（`btn` / `--primary/--secondary/--ghost/--danger/--link` / `--sm/--mini/--tight/--icon`）+ **全量组件迁移** + `.small` → `.fs-xs` + 删组件里那四个自造按钮类 | `check`（2464）+ `probe:layout`（615）+ `probe:remote`（27） |
| **299**（本批） | 裸字号 / 裸圆角 → 令牌（等值，像素不动）；新增 `--fs-2xs` / `--fs-3xs`（当批就用上） | `check`（2464）+ `probe:layout`（615） |
| 300 | 输入 / 勾选 / chip / 徽标 / 卡片 / 列表行 / 标题 六族收口（§9 其余行）+ 修 20 个未定义变量 + 文案统一 + 写 `docs/design/ui-style.md` | `check` |
| 301 | 护栏：静态测试（禁裸字号/圆角/控件内距）+ 探针 `style.*` 判据 | `check` + `probe` |
| 302 | §6 的像素变更逐条落地（**等你逐条确认**） | 你抽查页面 |
