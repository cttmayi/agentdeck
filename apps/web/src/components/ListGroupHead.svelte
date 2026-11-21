<script lang="ts">
  /* ════════════════════════════════════════════════════════════════════
     ListGroupHead —— 列表分组那一行组头（D137 标准控件）

     为什么要有它：这一档原来**两个页面各写一套**——任务页是带边框的卡片按钮
     （组名 600 / `--fs-sm`），智能体页是无边框的淡字行（`--fs-xs`、hover 才有底），
     连 DOM 结构都不一样（一个把行套在组里、一个把组头当行的兄弟）。同一个东西
     两种样子，第三个要分组的页面只能挑一个抄，抄完再漂一次。

     边界：
       · **只管组头这一行**。组里那些行仍然是 `ListRow`（页面自己渲染），组头与它们
         是**平级兄弟**（`<li>` 里不要再套 `<li>`——任务页原来就是
         `<li class="task-group">` 里套 `<li class="list-row">`，浏览器能忍，但结构是错的）。
       · **不管折叠状态**：`open` + `ontoggle` 由页面给（任务默认展开、智能体的
         「内置」默认收拢——那是产品决定，不该写死在控件里）。
       · 组与组之间那条分隔线由 `app.css` 的 `:not(:first-child)` 画，页面不用管。
       · `count` 收**已经排好版的字符串**（"3 个任务" / "12"）：数字怎么说是各页的
         文案，控件不碰 i18n。

     用法：
       <ul class="list-stack">
         <ListGroupHead label={…} count={$t('…', { n })} open={open} ontoggle={() => (open = !open)} />
         {#each rows as r (r.id)}<ListRow … />{/each}
       </ul>
     ════════════════════════════════════════════════════════════════════ */
  let {
    label,
    count = '',
    open,
    ontoggle,
    /** 组头右侧的补充说明（智能体页那句「内置岗位不可删」就住这里）。 */
    note = '',
    /** 给探针/测试认组的稳定标记（`data-list-group`）。 */
    groupKey = '',
  }: {
    label: string
    count?: string
    open: boolean
    ontoggle: () => void
    note?: string
    groupKey?: string
  } = $props()
</script>

<li class="list-group-head-wrap">
  <button
    type="button"
    class="list-group-head"
    aria-expanded={open}
    data-list-group={groupKey === '' ? undefined : groupKey}
    onclick={ontoggle}
  >
    <!-- 折叠态用字形切换（与 `.fold-head` 同一做法）：不用 transform，就没有"转半圈"的重绘 -->
    <span class="chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
    <span class="list-group-name">{label}</span>
    <span class="list-group-tail">
      {#if note !== ''}
        <span class="faint fs-xs list-group-note ellipsis">{note}</span>
      {/if}
      {#if count !== ''}
        <span class="list-group-count">{count}</span>
      {/if}
    </span>
  </button>
</li>

<style>
  /* 右侧那一簇（说明 + 计数）：整体贴右，内部不换行、长说明自己缩 */
  .list-group-tail {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }

  .list-group-note {

  /* D191：截断三条收进全局 `.ellipsis`（markup 已带） */
    min-width: 0;
  }
</style>
