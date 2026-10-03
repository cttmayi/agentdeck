<script lang="ts">
  /* ════════════════════════════════════════════════════════════════════
     ListRow —— 三页列表的**行壳**（D66 标准控件）

     聊天 / 任务 / 智能体的列表行是同一副骨架：
       li（行盒：hover / 选中框 / min-height）＋ 整行可点的主按钮 ＋ 右侧动作钮。
     D61~D65 先把三页的行壳样式统一到逐字节一致，D66 才把它收成一个组件——
     三页 scoped 里各 ~35 行的复制（行盒 + 主按钮 + 删除钮）删掉，样式只写一次。

     边界：**壳归这里，内容归页面的 snippet**。标题 / 元信息 / 徽标 / 注释
     是每页的真差异（D61 的教训：差异塞进 props 只会变成一团开关），它们以
     `children`（主按钮内容）和 `action`（右侧动作区）两个 snippet 传进来。
     行盒的类名由页面给（`rowClass="conv-row"` 等）——那是身份的标记，探针
     按它们量行；样式统一吃 `.list-row`（本组件 scoped）。
     ════════════════════════════════════════════════════════════════════ */
  import type { Snippet } from 'svelte'

  let {
    rowClass,
    active = false,
    onclick,
    children,
    action,
  }: {
    /** 行盒的标记类名（如 `conv-row` / `task-row`；任务页带分组时传
        `task-row attention`——注意那条左边警告条是页面自己的样式）。 */
    rowClass: string
    active?: boolean
    onclick: () => void
    children: Snippet
    action?: Snippet
  } = $props()
</script>

<li class="list-row {rowClass}" class:active>
  <!--
    整行可点 + 右侧独立的动作按钮（`li` 里一条整行可点的 `<button>` + 兄弟按钮）：
    按钮里套按钮是非法结构，浏览器会把里层那个拆出去。`active` 挂在**整个 li**
    上（不是里面的按钮）：选中框包住整项、连右边的动作钮一起。
  -->
  <button type="button" class="list-row-main" onclick={onclick}>
    {@render children()}
  </button>
  {#if action}{@render action()}{/if}
</li>

<style>
  /* 行盒：三页同一个形状（D61 定、D65 钉死）。hover 用 `--surface-hover`
     （全 App 的 hover 标准），选中态用 `--surface-2` + accent 边框。 */
  .list-row {
    display: flex;
    align-items: center;
    gap: 2px;
    border: 1px solid transparent;
    border-radius: var(--radius);
    /* 列表行**至少**多高（三栏同款）。内容（徽标 / 阶段标签）更高时跟随内容——
       统一的是这条底线与内距，不是把内容压扁（D61）。 */
    min-height: var(--list-row-min-h);
  }

  .list-row:hover {
    background: var(--surface-hover);
  }

  .list-row.active {
    background: var(--surface-2);
    border-color: var(--accent);
  }

  /* 主按钮：`flex: 1` + `min-width: 0` 让动作钮能缩到内容宽度以下，
     不把右侧按钮顶出栏外（三页的 scoped 里原来各写一份同样的）。 */
  .list-row-main {
    flex: 1;
    min-width: 0;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--text);
    padding: var(--sp-2) var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: 2px;
    cursor: pointer;
  }
</style>
