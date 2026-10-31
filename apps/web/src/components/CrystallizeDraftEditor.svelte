<script lang="ts">
  /**
   * 沉淀审阅页的**草稿编辑器**（分批第 153 批：从 `CrystallizeView` 里抽出来）。
   *
   * 为什么单独一个组件：设计 §12.12 定的是"右栏是唯一结构化的面"，而"改草稿"原来长在
   * **中间那条产物消息**里——同一份文件在两处出现（右栏只读预览、中间可改）。抽出来之后
   * 它就能被右栏装上（`CrystallizeArtifactPane`），中间那条消息只留结论与出口。
   *
   * ⚠️ 状态**不在这个组件里**：见 `lib/crystallize-editor.svelte.ts` 的文件头——两个组件要共享
   *    "选中的文件 / 编辑中的正文 / 有没有未保存改动"，而 legacy 父组件与 runes 子组件之间
   *    prop 更新不传播（§12.50 坑 4），所以状态放在一个 runes 模块里，两边直接读。
   *
   * ⚠️ 类名不能改：探针钉在 `.review-pane` / `.pane-tabs` / `.review-side` / `.review-cell` /
   *    `[data-cell]` / `textarea.editor` / `.diff-box .diff-line` 上（§12.37 并排那几条）。
   */
  // `$t` 是 i18n 那个 store 的自动订阅写法 ⇒ 必须把 `t` 导入进来（新组件里漏了它，
  //  `$t` 会被当成"未定义全局"，svelte 直接报 `$t is an illegal variable name`）
  import { t } from '../lib/i18n.ts'
  import { editor } from '../lib/crystallize-editor.svelte.ts'
  import { showToast } from '../lib/view.ts'

  /** 变更徽标的文案（A/M/D → 中文；空串 = 未改动）。 */
  function changeLabel(change: '' | 'A' | 'M' | 'D'): string {
    if (change === 'A') return $t('crystallize.changeAdded')
    if (change === 'M') return $t('crystallize.changeModified')
    if (change === 'D') return $t('crystallize.changeDeleted')
    return ''
  }

  async function saveEdits(): Promise<void> {
    try {
      if (await editor.saveEdits()) showToast($t('crystallize.saveDraftDone'))
    } catch (err) {
      showToast(String(err instanceof Error ? err.message : err))
    }
  }
</script>

{#if editor.artifacts !== null && editor.artifacts.mode !== 'refused'}
  <div class="review-pane">
    <ul class="file-tree">
      {#each editor.fileRows as row (row.rel)}
        <li>
          <button
            type="button"
            class="file-row"
            class:active={row.rel === editor.selectedFile}
            title={row.rel}
            onclick={() => editor.selectFile(row.rel)}
          >
            {#if row.change !== ''}
              <span
                class="change-tag"
                class:add={row.change === 'A'}
                class:mod={row.change === 'M'}
                class:del={row.change === 'D'}
              >{changeLabel(row.change)}</span>
            {/if}
            <span class="file-name mono">{row.rel}</span>
            {#if row.change !== 'D'}
              {@const d = editor.diffByRel.get(row.rel)}
              {#if d && (d.added > 0 || d.removed > 0)}
                <span class="num-tag add">+{d.added}</span>
                <span class="num-tag del">−{d.removed}</span>
              {/if}
            {/if}
          </button>
        </li>
      {/each}
    </ul>

    <div class="file-body">
      <div class="pane-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={editor.reviewTab === 'content'}
          class:tabs-active={editor.reviewTab === 'content'}
          onclick={() => (editor.reviewTab = 'content')}
        >{$t('crystallize.tabContent')}</button>
        <button
          type="button"
          role="tab"
          aria-selected={editor.reviewTab === 'diff'}
          class:tabs-active={editor.reviewTab === 'diff'}
          onclick={() => (editor.reviewTab = 'diff')}
        >{$t('crystallize.tabDiff')}</button>
        <!-- ★ 分批第 153 批：「保存改动」跟着编辑器走（它改的就是这份正文）。
             只在**有未保存改动**时出现（`dirty`）：没有改动时它是个不该被点的按钮，
             而"点不动的按钮"比"没有按钮"更让人困惑。 -->
        {#if editor.dirty}
          <button
            class="ghost small primary-ghost"
            disabled={editor.savingDraft}
            title={$t('crystallize.saveDraftHint')}
            onclick={() => void saveEdits()}
          >{$t('crystallize.saveDraft')}</button>
        {/if}
        {#if editor.reviewTab === 'diff'}
          <span class="tabs-right">
            {#if editor.selectedDiff && (editor.selectedDiff.added > 0 || editor.selectedDiff.removed > 0)}
              <span class="num-tag add">+{editor.selectedDiff.added}</span>
              <span class="num-tag del">−{editor.selectedDiff.removed}</span>
            {/if}
            <!--
              「对比原 skill」什么时候给：
                · 改版草稿（`revisedFrom !== null`）⇒ 原 skill = **第一版的快照**，比得出东西；
                · 更新场景（`baseline !== null`）⇒ 原 skill = 任务开始时库里那一份。
              ⚠️ 我第一版让它**常驻**，探针那条"新建目标的草稿不给一个永远空的切换"当场红：
                新建目标的**首版**没有"原来那一份"（服务端会退回当前版本 = 空）⇒ 这个按钮
                点了什么都不会变，正是这条判据要挡的死接口。判据在探针里，别在这里放宽。
            -->
            {#if editor.artifacts.revisedFrom !== null || editor.artifacts.baseline !== null}
              <button
                type="button"
                class="ghost small"
                class:active={editor.diffAgainst === 'original'}
                onclick={() => void editor.loadDiff('original')}
              >{$t('crystallize.diffVsOriginal')}</button>
            {/if}
            {#if editor.artifacts.revisedFrom !== null}
              <button
                type="button"
                class="ghost small"
                class:active={editor.diffAgainst === 'current'}
                onclick={() => void editor.loadDiff('current')}
              >{$t('crystallize.diffVsCurrent')}</button>
              <button
                type="button"
                class="ghost small"
                class:active={editor.diffAgainst === 'previous'}
                onclick={() => void editor.loadDiff('previous')}
              >{$t('crystallize.diffVsPrevious')}</button>
            {/if}
          </span>
        {/if}
      </div>

      <!-- ★ 分批第 120 批（U3c-2 审阅态并排）：内容与差异并排；窄屏只显示激活那一格 -->
      <div class="review-side" data-review-tab={editor.reviewTab}>
        <div class="review-cell" data-cell="content">
          {#if editor.selectedFile === ''}
            <p class="faint small">{$t('crystallize.noFiles')}</p>
          {:else if editor.fileRows.find((r) => r.rel === editor.selectedFile)?.change === 'D'}
            <p class="faint small pad">{$t('crystallize.deletedHint')}</p>
          {:else}
            <textarea
              value={editor.editText}
              oninput={(e) => editor.applyEdit((e.currentTarget as HTMLTextAreaElement).value)}
              class="mono editor"
              spellcheck="false"
            ></textarea>
          {/if}
        </div>
        <div class="review-cell" data-cell="diff">
          {#if editor.diffLoading}
            <p class="faint small pad">{$t('crystallize.diffLoading')}</p>
          {:else if editor.selectedDiff && editor.selectedDiff.hunks.length > 0}
            <div class="diff-box mono">
              {#each editor.selectedDiff.hunks as hunk (hunk.oldStart + ':' + hunk.newStart)}
                <div class="hunk-head">@@ −{hunk.oldStart} +{hunk.newStart} @@</div>
                {#each hunk.lines as line (line.oldNo + '/' + line.newNo + '/' + line.kind)}
                  <div class="diff-line {line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : ''}">
                    <span class="gutter">{line.oldNo ?? ''}</span>
                    <span class="gutter">{line.newNo ?? ''}</span>
                    <span class="sign">{line.kind === ' ' ? ' ' : line.kind}</span>
                    <span class="text">{line.text}</span>
                  </div>
                {/each}
              {/each}
            </div>
          {:else if editor.diff === null}
            <p class="faint small pad">{$t('crystallize.diffLoading')}</p>
          {:else}
            <p class="faint small pad">{$t('crystallize.diffUnchanged')}</p>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ══════════════ 编辑器的样式（分批第 153 批从 `CrystallizeView` 搬过来） ══════════════
     ⚠️ 为什么要搬：Svelte 的 `<style>` 是**按组件作用域**的——样式写在 `CrystallizeView` 里，
     而元素由这个组件渲染 ⇒ 那些规则一条都不生效。真 Chrome 里量到的现象是：树变成整行铺开
     （565px）、内容与差异没有并排、点「差异」后两格同时可见（两条布局判据当场红）。
     另一条路是给每个选择器加 `:global(...)`，但那等于放弃作用域；把样式跟着组件走更难出错。
  */
  /* ══════════ 审阅：文件树 + 编辑区（四轮）══════════
     ★ 只用全局变量与既有观感（--panel/--line/--radius/--font-mono），不自造卡片：
     这一块是"多文件产物的呈现"，不是另一套设计语言。 */
  /* ── 变更集 diff（P1）：行号 gutter + 符号 + 文本，三色只区分增删 ── */
  .num-tag {
    font-size: 11px;
    padding: 0 4px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .num-tag.add {
    color: #1a7f37;
    background: rgba(26, 127, 55, 0.1);
  }
  .num-tag.del {
    color: #b42318;
    background: rgba(180, 35, 24, 0.1);
  }
  .diff-box {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    font-size: 12px;
    line-height: 1.5;
  }
  .hunk-head {
    padding: 0.15rem 0.5rem;
    color: var(--fg-faint);
    background: var(--bg-sunken, #f6f6f6);
    border-top: 1px solid var(--border);
    user-select: none;
  }
  .hunk-head:first-child {
    border-top: 0;
  }
  .diff-line {
    display: grid;
    grid-template-columns: 3rem 3rem 1rem minmax(0, 1fr);
    gap: 0.25rem;
    padding: 0 0.5rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .diff-line.add {
    background: rgba(26, 127, 55, 0.08);
  }
  .diff-line.del {
    background: rgba(180, 35, 24, 0.08);
  }
  .diff-line .gutter {
    color: var(--fg-faint);
    text-align: right;
    user-select: none;
  }
  .diff-line .sign {
    color: var(--fg-faint);
    user-select: none;
  }
  .diff-line.add .sign {
    color: #1a7f37;
  }
  .diff-line.del .sign {
    color: #b42318;
  }

  /* ══════════ 审阅重排（2026-10-19）：结论条 + 主区 + 折叠 ══════════

     三条规矩写在 markup 的注释里（结论常驻 / 主区自己滚 / 编辑与差异同位置切换）。
     这里只落尺寸：树 240px 固定、窗格吃满剩下的、主区高度跟窗口走但**不整页滚**。 */

  /*
   * ── 一条结论条（2026-10-21）──
   * 原来是三条横条竖着摞（审核块 + 校验条 + frontmatter 摘要），加起来 ~240px；
   * 现在一块两行 ~76px。宽度按内容排（结论那一行**不许换行**——原来「开始审核」按钮在
   * 69px 宽里折成 3 行，高 54px，就是这里没管住 `flex` 的结果）。

  /* ── 主区：树 240px + 窗格 ──
     高度跟窗口走（min 420 保证编辑器不至于只有几行；max 与窗口高对齐），
     两个子块各自 overflow: auto——页面**不因为文件多而整页变长**。 */
  .review-pane {
    display: grid;
    /* 右栏是 24–30rem 的一列：树固定 180px（文件名能读），剩下全给正文 */
    grid-template-columns: 180px minmax(0, 1fr);
    gap: var(--sp-2);
    /* 吃剩余高度（basis 0：高度由剩余空间定，内容在格子里自己滚），22rem 保底 */
    flex: 1 1 0;
    min-height: 22rem;
    margin-top: var(--sp-1);
  }

  .file-tree {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow-y: auto;
    background: var(--panel);
  }

  /* 文件行是真按钮（tab 能到、读屏器能读）——与列表行同一纪律，只是密度更高 */
  .file-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--line);
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .file-tree li:last-child .file-row {
    border-bottom: 0;
  }

  .file-row:hover {
    background: var(--hover);
  }

  .file-row.active {
    background: var(--active, var(--hover));
    font-weight: 600;
  }

  .file-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8125rem;
  }

  /* 变更标记：A/M/D 用 git 的说法，颜色靠全局 badge 的语义色 */
  .change-tag {
    flex: 0 0 auto;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 0.6875rem;
    line-height: 1.5;
    border: 1px solid var(--line);
  }

  .change-tag.add {
    color: var(--good);
    border-color: var(--good);
  }

  .change-tag.mod {
    color: var(--warn);
    border-color: var(--warn);
  }

  .change-tag.del {
    color: var(--bad);
    border-color: var(--bad);
  }

  /* 窗格：分段控件常驻，下面那一块自己滚 */
  .file-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--panel);
  }

  .pane-tabs {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    padding: 2px var(--sp-1);
    border-bottom: 1px solid var(--line);
    flex: 0 0 auto;
  }

  .pane-tabs > button {
    padding: 3px 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-soft);
    font-size: var(--fs-sm);
    cursor: pointer;
  }

  .pane-tabs > button.tabs-active {
    background: var(--panel-sunken, rgba(0, 0, 0, 0.05));
    color: var(--fg);
    font-weight: 600;
  }

  .tabs-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--sp-1);
  }

  /*
   * 「结论已过期」这个标记：**要显眼**，因为它是"别照这个结论做决定"的提示。
   * 用告警色（与失败结论同一个色系），不用灰色——灰色在这里等于"可以不看"。
   */
  /* 「保存改动」比同排的其他 ghost 按钮重要一点：它是"你刚做的事还没算数"的出口。 */

  .file-body textarea.editor {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    box-sizing: border-box;
    border: 0;
    border-radius: 0;
    resize: none;
    padding: var(--sp-2) var(--sp-3);
    font-size: 0.8125rem;
    line-height: 1.55;
  }


  .file-body .pad {
    padding: var(--sp-3);
    margin: 0;
  }



  /* ══════════ 完成态 ══════════
     ★ 底色/描边/内距吃全局 `.notice`（`.good` 那档），这里只管"竖着排"——
     再自造一张卡片就又多一套边距，是使用者说的"和任务不一样"的来源之一。 */

  /* U3c-2·审阅态：内容与差异并排（宽屏）；窄屏只显示激活那一格 */
  .review-side {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--sp-2);
    flex: 1;
    min-height: 0;
  }

  .review-cell {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  /* ⚠️ 断点统一 96rem（1536px）：探针视口 1280 属于窄屏，那里应当"只剩激活那一格" */
  /* ★ 分批第 155 批（编辑搬进右栏）：**不再并排**，永远只显示激活那一格。
     右栏是 24–30rem 的一列（探针视口 1280 下 384px），两格并排各 ~180px 连一行 SKILL.md 都读不下。
     于是"内容 / 差异"回到**同一个窗格里切换**（这正是 2026-10-21 那三条排版规矩的第 ③ 条：
     编辑与差异同位置切换、切换不滚动）。原来的 `@media (max-width: 96rem)` 是按视口判的，
     而现在这个容器比视口窄得多 ⇒ 条件永远不成立，必须无条件收成一列。 */
  .review-side {
    grid-template-columns: minmax(0, 1fr);
  }

  .review-side[data-review-tab='content'] .review-cell[data-cell='diff'],
  .review-side[data-review-tab='diff'] .review-cell[data-cell='content'] {
    display: none;
  }

</style>
