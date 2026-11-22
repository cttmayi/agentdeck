<script lang="ts">
  /**
   * **「目录」一节**（2026-11，D248 起；D253 扩到编排 / 定时任务 / 技能）——每个
   * "住在一个目录里"的实体共用的一份：智能体（`agent:<id>` / `wf-agent:<wid>/<aid>`）、
   * 编排（`workflow:<id>`）、定时任务（`schedule:<id>`）、技能（`skill:<名字>`）。
   *
   * 来历：D245 先给编排内建智能体的编辑页做了"默认收起的一节目录树"
   * （使用者："可以作为某种高级默认隐藏目录显示，而不是有一个打开目录的按钮"）。
   * 接着使用者要求把**新建与编辑统一化**：「主要差异是智能体的名字和打开目录，
   * 原则还是一样，不可用的部分置灰」——于是这一节在两页都在：
   *   · 编辑页：`base` 是真实目录（`/api/fs/agent:<id>` 或 `/api/fs/wf-agent:<wid>/<aid>`），
   *     展开即可看文件、点文件名进 `FileViewer` 的原文面改、保存写回磁盘；
   *   · 新建页：实体还不存在 ⇒ `base=null` + `disabled`，整节**置灰不展开**
   *     （不删——删了会让两页结构不一样，见 `ui-style.md` §2.4「不可用置灰不删」）。
   *
   * ⚠️ 位置照 §2.4：整行宽的辅助块只能放在主内容**之后**。
   *   ★ D252（使用者："那个『目录』独独的在框外面，总觉得不好看，是否可以放框里面，
   *     框的最下面，用一个横线隔开上面的内容。另外，也注意字体"）：**它就是卡片里的
   *     最后一格**（`.cell.dir-cell`：整行宽 + `border-top` 横线），不再是卡片外面的
   *     `.fold-section`。理由两点：
   *       · 它和「记忆」是同类——"这个智能体的附属信息"，而记忆本来就在卡片里；
   *       · 原来那套 `.fold-head` 是**列表分组头**的长相（600 字重 + hover 底色 + 整条
   *         可点的块），放在表单里像另一个控件族。现在标签走 `.cell-label`
   *         （`--fs-sm` / `--text-faint`），与「名字」「CLI」那些一格一致。
   */
  import WorkDirTree from './WorkDirTree.svelte'
  import { t } from '../lib/i18n.ts'

  /** 目录的接口前缀（`/api/fs/<scope>`）。`null` = 还没有目录（新建页）。 */
  export let base: string | null = null
  /** 置灰：标题还在、点不开（新建页用）。 */
  export let disabled = false
  /** 标题文案（缺省「目录」）。 */
  export let title = ''
  /** 说明文案（缺省那句通用的）。 */
  export let hint = ''

  let open = false
  let count = 0

  $: shownTitle = title === '' ? $t('agents.dirTitle') : title
  $: shownHint = disabled ? $t('agents.dirAfterCreate') : hint === '' ? $t('agents.dirHint') : hint
</script>

<div class="cell dir-cell" data-dir data-dir-disabled={disabled}>
  <button
    type="button"
    class="dir-head"
    aria-expanded={open && !disabled}
    aria-disabled={disabled}
    disabled={disabled}
    title={disabled ? $t('agents.dirAfterCreate') : ''}
    onclick={() => {
      if (disabled) return
      open = !open
    }}
  >
    <span class="dir-chevron" aria-hidden="true">{open && !disabled ? '▾' : '▸'}</span>
    <span class="cell-label">{shownTitle}</span>
    <!-- ★ D190：截断走全局 `.ellipsis`（样式里不再写那三条） -->
    <span class="dir-summary ellipsis" data-dir-summary>{shownHint}</span>
  </button>
  {#if open && !disabled && base}
    <div class="dir-body">
      <WorkDirTree {base} reloadKey={`${base}/${open}`} bind:count />
    </div>
  {/if}
</div>

<style>
  /**
   * 「目录」= 卡片里的最后一格（D252）。整行宽 + 一条横线隔开上面的内容——
   * 与「记忆」那一格同一套长相（`.memory-cell` 也是 `border-top` + `padding-top`），
   * 因为它们都是"这个智能体的附属信息"，不是表格里的一个字段。
   */
  .dir-cell {
    grid-column: 1 / -1;
    border-top: 1px solid var(--line);
    padding-top: var(--sp-3);
  }

  /**
   * 标题行：**不是按钮的长相**（无底色、无内距、无 600 字重）——它只是"点一下展开"的
   * 一行标签，与「名字」「CLI」那些格子的标签同一档字体（`.cell-label` = `--fs-sm` /
   * `--text-faint`）。原来借用列表分组头的 `.fold-head`（600 字重 + hover 整条底色），
   * 放在表单里像另一个控件族（使用者："注意字体"）。
   */
  .dir-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 100%;
    min-width: 0;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .dir-head:disabled {
    cursor: not-allowed;
  }

  .dir-chevron {
    flex: 0 0 auto;
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }

  /* 说明：一格辅助文字（与 `.cell-label` 同一档字号/颜色）；放不下就省略——截断三条
     由全局 `.ellipsis` 提供（D190：页面里不许再抄那三条）。 */
  .dir-summary {
    min-width: 0;
    font-size: var(--fs-sm);
    color: var(--text-faint);
  }

  .dir-body {
    margin-top: var(--sp-2);
  }
</style>
