<script lang="ts">
  import { afterUpdate, onMount } from 'svelte'
  import { templateKit, loadTemplateKit, previewFirstSentence } from '../lib/stores.ts'
  import type { FirstSentenceKind, TemplateBlock } from '../lib/api.ts'
  import { t } from '../lib/i18n.ts'

  /**
   * 「第一句话模版」这一栏（D32；2026-10 起是某条链路**某一块**的模版框）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 三个决定，都是为了让人**看得见自己写了什么**
   * ══════════════════════════════════════════════════════════════════
   *
   * **⓪ 输入框要够大，而且**跟着内容长**。**
   *    这是使用者点名要的："第一句话的填写框太小了，不利用看内容"。默认模版
   *    本身就有 30 行上下（审核那份还要长），一个 8 行的框等于逼人用滚动条读
   *    自己写的字。现在：最小 20rem、随内容自动长、上限 70vh（再长就在框内滚，
   *    不会把底部的按钮顶出视口）。
   *
   * **① 变量对照表从接口来，不在这里抄一份。**
   *    变量表、必需与否、说明文字都在 `packages/agent-core` 里（服务端那份
   *    就是校验用的同一份）。前端再写一遍，两边迟早分叉，而"照着界面的说明
   *    写了却被拒"是最难受的一种错。**变量按 `kind × block` 过滤**——在 ② 身份
   *    框里不会列出框架框的变量。
   *
   * **② 预览走服务端的真渲染器（只渲染这一块）。**
   *    前端自己拼一段"看起来差不多"的预览，它迟早与真实投递的东西走偏——
   *    而那种偏差正是这个功能最该防的（"预览里好好的"）。预览用的是示例值，
   *    所以它会**明说**这一点，免得好好的示例任务正文被误认成自己的任务。
   *
   * **③ 保存时才拦的错误，这里当场就能看到。**
   *    预览接口与写入口过的是同一道关、给的是同一句错——写错了立刻能看见，
   *    而不是点了保存才知道。
   */

  /** 这是哪一条链路（执行 / 审核 / 聊天）。 */
  export let kind: FirstSentenceKind
  /** 这是哪一块（① 框架 / ② 身份 / ③ 任务）。 */
  export let block: TemplateBlock = 'frame'
  /** 模版原文。空串 = 用平台默认模版。 */
  export let value: string
  /** 值变了（父组件自己保存；这里不做双向绑定，免得两种写法混着用）。 */
  export let onchange: (next: string) => void = () => {}
  /**
   * 要不要自己画那行标签。
   *
   * ★ 智能体详情页用的是"label 一列 + 值一列"的字段行（它的排版承诺之一是
   *   所有行的竖线对齐），所以那边把标签交给父组件，这里只留状态徽章——
   *   同一个标签出现两次比没对齐更糟。
   */
  export let showLabel = true

  let preview = ''
  let previewError = ''
  let busy = false
  let showVariables = false
  let showText = false

  // 变量表只在第一次需要时取一次（所有用到它的地方共用同一个 store）
  $: if ($templateKit === null) void loadTemplateKit()

  $: variables = ($templateKit?.variables ?? []).filter(
    (v) => v.kinds.includes(kind) && v.block === block,
  )
  $: custom = value.trim() !== ''
  /** 这一块"平台默认"是什么——「填入默认」与「留空 = 平台默认」都用它。 */
  $: defaultText = $templateKit?.defaults[kind]?.[block] ?? ''

  /**
   * `{{name}}` 这几个字在模板里**不能裸写**：Svelte 会把 `{{name}}` 当成
   * 一个表达式（对象字面量 `{name}`），渲染出来是 `[object Object]`。
   * 所以拼好再插值——顺便保证界面上显示的写法与校验用的写法一定是同一个。
   */
  const varToken = (name: string): string => `{{${name}}}`

  /**
   * 输入框跟着内容长高（最小 20rem / 最大 70vh）。
   *
   * ⚠️ 两个细节：
   *   - 先 `height = 'auto'` 再读 `scrollHeight`：不这么做的话，删掉几行之后
   *     它只会**长**不会**缩**（滚动高度的下限是当前高度）；
   *   - 上限按**视口**算（70vh）而不是写死像素：这个抽屉在笔记本上和小屏上
   *     都要能用，而"框比视口还高"会让底部的按钮永远够不着；
   *   - `afterUpdate` 里跑（而不是只在 input 上）：切页签会重建这个组件、
   *     「填入默认模版」是父组件改的值、预览/变量清单的展开会改变可用宽度——
   *     这三种情况都要重算。
   */
  const MIN_HEIGHT_PX = 320
  const MAX_HEIGHT_RATIO = 0.7

  let textareaEl: HTMLTextAreaElement | null = null

  function autosize(): void {
    const el = textareaEl
    if (!el) return
    const max = Math.round(window.innerHeight * MAX_HEIGHT_RATIO)
    el.style.height = 'auto'
    // `+2` 是上下边框：高度用 border-box 算，而 scrollHeight 不含边框
    const next = Math.min(Math.max(el.scrollHeight + 2, MIN_HEIGHT_PX), max)
    el.style.height = `${next}px`
  }

  onMount(autosize)
  afterUpdate(autosize)

  async function runPreview(): Promise<void> {
    busy = true
    previewError = ''
    try {
      preview = await previewFirstSentence(kind, block, value)
      showText = true
    } catch (err) {
      // 服务端说的就是原因（同一个校验），原文带回来，不要在这里改写它
      previewError = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }
</script>

<div class="tpl">
  <!--
    ★ 2026-10（紧凑性）：`showLabel=false`（WorkspaceSettings 里）时不再渲染
      这一行——原来它里面只剩状态徽章一个元素、独占一整行，右侧全是空白；
      徽章改并进下方 hint 段落的行首。
  -->
  {#if showLabel}
    <div class="tpl-head">
      <span class="tpl-label">{$t('tpl.label')}</span>
      <span class="tpl-state">
        {#if custom}
          <span class="badge custom">{$t('tpl.custom')}</span>
        {:else}
          <span class="badge">{$t('tpl.platformDefault')}</span>
        {/if}
      </span>
    </div>
  {/if}

  <p class="tpl-hint">
    {#if !showLabel}
      <span class="tpl-state tpl-state-inline">
        {#if custom}
          <span class="badge custom">{$t('tpl.custom')}</span>
        {:else}
          <span class="badge">{$t('tpl.platformDefault')}</span>
        {/if}
      </span>
    {/if}
    {$t(`tpl.settings.hint.${block}.before`)}<strong>{$t(`tpl.settings.hint.${block}.strong`)}</strong>{$t(`tpl.settings.hint.${block}.after`)}
    {#if block === 'task'}
      <span class="req">{$t('tpl.settings.hint.requiredTask.before')}<strong>{$t('tpl.settings.hint.requiredTask.strong')}</strong>{$t('tpl.settings.hint.requiredTask.after')}</span>
    {/if}
    <strong>{$t('tpl.hintVarsOnly')}</strong>{$t('tpl.hintVarsOnlyAfter')}
    {$t('tpl.settings.hint.emptyMeans')}<strong>{$t('tpl.settings.hint.platformDefault')}</strong>
    {#if block === 'frame'}{$t('tpl.hintDefaultGuardsLead')}{$t('tpl.hintDefaultGuards')}{/if}
  </p>

  <!-- `rows` 只是没有脚本时的兜底；实际高度由 `autosize()` 按内容算 -->
  <textarea
    class="tpl-text"
    rows="16"
    bind:this={textareaEl}
    spellcheck="false"
    placeholder={$t('tpl.placeholder')}
    value={value}
    oninput={(e) => onchange((e.currentTarget as HTMLTextAreaElement).value)}
  ></textarea>

  <div class="tpl-tools">
    <button
      type="button"
      class="ghost small"
      onclick={() => onchange(defaultText)}
      disabled={!defaultText}
    >
      {$t('tpl.fillDefault')}
    </button>
    <button
      type="button"
      class="ghost small"
      onclick={() => {
        onchange('')
        preview = ''
        previewError = ''
      }}
      disabled={!custom}
    >
      {$t('tpl.clearToDefault')}
    </button>
    <button type="button" class="ghost small" onclick={runPreview} disabled={busy}>
      {busy ? $t('common.previewing') : $t('common.preview')}
    </button>
    <button type="button" class="ghost small" onclick={() => (showVariables = !showVariables)}>
      {showVariables ? $t('tpl.hideVars') : $t('tpl.showVars')}
    </button>
  </div>

  {#if previewError}
    <div class="notice bad tpl-error">{previewError}</div>
  {/if}

  {#if showVariables}
    <div class="var-table">
      {#if variables.length === 0}
        <p class="row-hint">
          {$t('tpl.varsUnavailable')}<code>{varToken('name')}</code>。
        </p>
      {:else}
        <p class="row-hint">
          {$t('tpl.varsSyntax')}<code>{varToken('name')}</code>{$t('tpl.varsSyntaxAfter')}
          {$t('tpl.varsSyntaxAfter2')}
        </p>
        <p class="row-hint">
          <strong>{$t('tpl.condHintTitle')}</strong>：<code>{'{{#instructions}}…{{/instructions}}'}</code>
          {$t('tpl.condHintBody')}<strong>{$t('tpl.condHintStrong')}</strong>{$t('tpl.condHintQuote1')}
          {$t('tpl.condHintQuote2')}<code>{'{{^instructions}}…{{/instructions}}'}</code>。
          ⚠️ {$t('tpl.requiredVarsBefore')}<strong>{$t('tpl.requiredVarsOutside')}</strong>{$t('tpl.requiredVarsAfter')}
        </p>
        <!--
          ⚠️ 这里原来是一张两列表格（变量 | 说明）。这一栏住在 416px 宽的主从
             栏里，两列在那种宽度下会把说明挤成一条窄缝。改成一变量一段：
             变量名一行、说明一行——宽度再窄也读得下去。
        -->
        <ul class="var-list">
          {#each variables as v (v.name)}
            <li>
              <span class="var-line">
                <code>{varToken(v.name)}</code>
                {#if v.requiredFor.includes(kind)}<span class="req">{$t('common.required')}</span>{/if}
                <span class="faint small">{v.multiline ? $t('tpl.multiline') : $t('tpl.singleValue')}</span>
              </span>
              <span class="var-label faint small">{v.label}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if showText && preview}
    <div class="preview">
      <div class="preview-head">
        <strong>{$t('tpl.previewHeading')}</strong>
        <span class="faint small">
          {$t('tpl.previewNote1')}<strong>{$t('tpl.sampleValues')}</strong>{$t('tpl.previewNote2')}
          {$t('tpl.previewNote3')}
        </span>
        <button type="button" class="ghost small" onclick={() => (showText = false)}>{$t('common.collapse')}</button>
      </div>
      <pre>{preview}</pre>
    </div>
  {/if}
</div>

<style>
  .tpl { grid-column: 1 / -1; }

  .tpl-head { display: flex; align-items: center; gap: var(--sp-2); }

  /* 徽章并进 hint 行内时（showLabel=false）：与文字同排、留一点右间距 */
  .tpl-state-inline { margin-right: var(--sp-2); }

  .tpl-label {
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }

  .tpl-state .badge {
    font-size: var(--fs-xs);
    padding: 1px 6px;
    border-radius: var(--radius);
    border: 1px solid var(--line-strong);
    color: var(--text-faint);
  }

  .tpl-state .badge.custom {
    border-color: var(--accent);
    color: var(--accent);
  }

  .tpl-hint {
    font-size: var(--fs-xs);
    color: var(--text-faint);
    margin: var(--sp-1) 0;
    line-height: 1.6;
  }

  /**
   * ⚠️ 不要给这个 textarea 写 `rows` 之外的高度限制：高度由 `autosize()` 按内容
   *    设置。`resize: vertical` 也关掉——手动拖过之后，下一次输入就会被自动高度
   *    覆盖回去，那种"拖了没用"比不能拖更让人困惑。
   */
  .tpl-text {
    width: 100%;
    min-height: 20rem;
    box-sizing: border-box;
    resize: none;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.6;
  }

  .tpl-tools {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }

  .tpl-error { white-space: pre-line; margin-top: var(--sp-2); }

  .var-list {
    list-style: none;
    margin: var(--sp-2) 0 0;
    padding: 0;
    border-top: 1px solid var(--line);
  }

  .var-list li {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: var(--sp-2) 0;
    border-bottom: 1px solid var(--line);
  }

  .var-line { display: flex; align-items: center; gap: var(--sp-2); }

  .var-label { line-height: 1.5; }

  .req {
    font-size: var(--fs-xs);
    color: var(--warn);
  }

  .preview {
    margin-top: var(--sp-3);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
  }

  .preview-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
    padding: var(--sp-2) var(--sp-3);
    border-bottom: 1px solid var(--line);
  }

  .preview pre {
    margin: 0;
    padding: var(--sp-3);
    /* 预览同样是"看内容"的地方：给足高度，再长就在里面滚 */
    max-height: 38rem;
    overflow: auto;
    font-size: var(--fs-xs);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
