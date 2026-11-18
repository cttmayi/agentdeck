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
| 目录选择 | 组件 `DirPicker`（「浏览…」打开它，`bind:open` + `bind:value` 与表单输入框同一个值） | 路径行 + 导航行 + 列表（目录可进、文件只作佐证）+ 底部「选这个目录」；输入框始终留着，手打永远可用。**不要**自己再搭一个目录弹层 |
| 详情头 | `.detail-head` + `.detail-sub` + `.detail-actions` | 动作按钮 ≥2 个时自动画分组轨道。所有「标题 + 元信息 + 动作」的头都用它（聊天栏头 313 批已并入，不要再自己写 flex 补丁） |
| 空态 | `.empty`（可带 `strong` + `p`） | 别自己拼居中的灰字 |
| 详情/栏头两行 | 栏头这类"标题 + 一串元信息"的地方同样两行：第一行 **标题 + 动作按钮**，第二行 **元信息**（执行者 / 轮数 / 技能 / 时间）。元信息元素写 `flex: 0 0 100%` 强制独占一行 | 312 批：聊天的栏头原来是"标题 + 改名 + 文章写作员 · 2 轮"三样挤一行，长标题与元信息互相抢宽度。与"列表行两行"同一条注意力顺序 |
| 列表行两行 | 列表行（聊天/任务/智能体/沉淀/定时任务/编排）一律 **两行结构**：第一行 = 标题（`<span class="…-title">`），第二行 = 辅助信息（执行者 / 轮数 / 时间 / 阶段，`<span class="…-sub">`）。两行都由 `.list-row-main`（`display:flex; flex-direction:column`）自然堆叠，**不许把辅助信息挤进标题那一行**；标题单行省略、辅助信息也单行省略 | 311 批：使用者原话——"类似任务的类似，一行主 Title，一行辅助信息的格式"。注意力顺序是"先认这是哪一条，再看它什么状态"；挤在一行时两者互相抢宽度，长标题会把辅助信息挤没。**照抄的地方见 §2.6**（连 CSS 一起） |
| 列表分组 | 组头 = 组件 `ListGroupHead`（淡字一行：chevron + 组名 + 右侧说明与计数）；组头与行**平级**（`<li>` 里不许再套 `<li>`）；组间分隔线由 `app.css` 的 `.list-stack > .list-group-head-wrap:not(:first-child)` 自动画 | D137：这一档原来**两页各一套**（任务页是带边框的卡片按钮、智能体页是淡字行，连 DOM 结构都不同）。组头是**分段标题**不是内容，所以不带边框、不与 `.list-row` 抢注意力；折叠状态由页面给（任务默认展开、智能体「内置」默认收拢），控件不管 |
| 单行省略 | 列表标题一类要"一行 + 省略号"的元素必须 **`display: block` + `max-width: 100%` + `overflow: hidden` + `text-overflow: ellipsis` + `white-space: nowrap`** 五件套 | 310 批：行内元素上 `overflow`/`text-overflow` 不生效，`nowrap` 只挡换行*算法*，中文长标题在窄栏里仍会被顶成两行、末尾却还挂着省略号（使用者报的） |
| 混排行 | 短控件（勾选）+ 长控件（标签+输入）同排时 **`align-items: flex-end`** | 308 批：`center` 会让勾选浮在中间、`flex-start` 贴着顶边——两者高度差大时都不像同一行。新写这类行照这条来 |
| 提示条 | `.notice` + `.bad` / `.warn` / `.good` | 一句话；更长的进 body |
| 浮层 | `.drawer*` / `.modal*` / `.page-menu` / `.toast` | 遮罩 + 描边 + `--shadow-2` 三层一起给 |
| 表格 | `.table-wrap`（壳）+ `<table class="table">` | 307 批：表头/单元格内距等规则挂**元素选择器与 `.table` 两条**，所以"长得像表格但不是 `<table>` 元素"的东西加 `class="table"` 就同款 |
| 折叠 | `.fold-section` / `.fold-head` / `.fold-body` | |

### 2.5 已经归位、**不要**再新画的

`SettingsPanel.svelte` 是"主区面板"的共享外壳（`section.main-panel` + 头部返回 + body + foot），
新加一个设置页 = **用它 + 写内容**，不要自己再拼一遍头部和返回按钮。

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
<div class="split-layout" data-list-key="xxx" data-list-label={$t('shell.resizeList')} use:listGrip>
  <!-- 列表栏（ListPane） -->
  <!-- ★ 这里的位置是**把手**：由 `use:listGrip` 动作自己插进来，模板里不要手写 -->
  <!-- 详情栏（MainArea） -->
</div>
```

`.split-layout` 是**三列**：`列表 | 把手 | 详情`（`var(--list-w) var(--grip-w) minmax(0,1fr)`）。
`.split-grip` **不要手写**——`lib/list-grip.ts` 会插一个，手写第二个会叠在同一格里。

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
  两栏并排**且详情栏够宽**、栏头 51px 无标题、`ul` 缩进 0/符号 none/行距 4、行高底线 64、
  长标题单行裁切、正文自滚、栏脚贴底、无横向溢出）。不通过就红着脸写在页面最上面，
  不用等人看出来。
- 两组判据量的都是**等式**（五页互相相等）：栏头高 / 行盒 / hover 底色 /
  行内标题字号字重 / 徽标形状，加上两条较新的等式：
  - `skeleton.listBox`：`ul` 的 `padding-left` = 0、`list-style` = none、行距 4px、
    行左沿贴着栏内容左缘；
  - `skeleton.groupHead`：两页的组头**同高（≤1px）、同字号（12px）、组名同字重（600）**、
    都有 chevron、计数贴右；组间分隔线只在第二组上方有（第一组上方不许有线）；
  - `skeleton.rowMetrics`：行高**底线**（`min-height`）= 64px、**页内**任意两行差 ≤1px
    （内容更高时行可以更高——那不算不一致，令牌才是不允许漂的东西）。


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
