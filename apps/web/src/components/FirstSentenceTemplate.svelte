<script lang="ts">
  import { templateKit, loadTemplateKit, previewFirstSentence } from '../lib/stores.ts'
  import type { FirstSentenceKind } from '../lib/api.ts'

  /**
   * 「第一句话模版」这一栏（D32）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 三个决定，都是为了让人**看得见自己写了什么**
   * ══════════════════════════════════════════════════════════════════
   *
   * **① 变量对照表从接口来，不在这里抄一份。**
   *    变量表、必需与否、说明文字都在 `packages/agent-core` 里（服务端那份
   *    就是校验用的同一份）。前端再写一遍，两边迟早分叉，而"照着界面的说明
   *    写了却被拒"是最难受的一种错。
   *
   * **② 预览走服务端的真渲染器。**
   *    前端自己拼一段"看起来差不多"的预览，它迟早与真实投递的东西走偏——
   *    而那种偏差正是这个功能最该防的（"预览里好好的"）。预览用的是示例值，
   *    所以它会**明说**这一点，免得好好的示例任务正文被误认成自己的任务。
   *
   * **③ 保存时才拦的错误，这里当场就能看到。**
   *    预览接口与写入口过的是同一道关、给的是同一句错——写错了立刻能看见，
   *    而不是点了保存才知道。
   */

  /** 这是哪一个模版（执行 / 审核）。 */
  export let kind: FirstSentenceKind
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

  $: variables = ($templateKit?.variables ?? []).filter((v) => v.kinds.includes(kind))
  $: custom = value.trim() !== ''
  /** 这一栏里"另一条链路"的模版是不是也写了——写了两份要给个提示。 */
  $: defaultText = $templateKit?.defaults[kind] ?? ''

  /**
   * `{{name}}` 这几个字在模板里**不能裸写**：Svelte 会把 `{{name}}` 当成
   * 一个表达式（对象字面量 `{name}`），渲染出来是 `[object Object]`。
   * 所以拼好再插值——顺便保证界面上显示的写法与校验用的写法一定是同一个。
   */
  const varToken = (name: string): string => `{{${name}}}`

  async function runPreview(): Promise<void> {
    busy = true
    previewError = ''
    try {
      preview = await previewFirstSentence(kind, value)
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
  <div class="tpl-head">
    {#if showLabel}<span class="tpl-label">第一句话模版</span>{/if}
    <span class="tpl-state">
      {#if custom}
        <span class="badge custom">自定义</span>
      {:else}
        <span class="badge">平台默认</span>
      {/if}
    </span>
  </div>

  <p class="tpl-hint">
    一次 run 交代给模型的<strong>全部内容</strong>就是这一段文字（只有这一条通道）。
    留空 = 用平台默认那段；自己写 = <strong>整段取代默认</strong>，默认里的
    「完成后给出一份报告」那类护栏也一并没了，需要自己写进去。
  </p>

  <textarea
    class="tpl-text"
    rows="8"
    spellcheck="false"
    placeholder="留空 = 用平台默认模版。点下面的「填入默认模版」可以从默认那段改起。"
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
      填入默认模版
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
      清空（回到平台默认）
    </button>
    <button type="button" class="ghost small" onclick={runPreview} disabled={busy}>
      {busy ? '预览中…' : '预览'}
    </button>
    <button type="button" class="ghost small" onclick={() => (showVariables = !showVariables)}>
      {showVariables ? '收起变量' : '可用的变量'}
    </button>
  </div>

  {#if previewError}
    <div class="notice bad tpl-error">{previewError}</div>
  {/if}

  {#if showVariables}
    <div class="var-table">
      {#if variables.length === 0}
        <p class="row-hint">
          拿不到变量表（daemon 可能没起来）。变量写法是 <code>{varToken('name')}</code>。
        </p>
      {:else}
        <p class="row-hint">
          写法是 <code>{varToken('name')}</code>，插值发生在每次 run：同一个模版，
          模型拿到的是这一次的值。
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
                {#if v.requiredFor.includes(kind)}<span class="req">必需</span>{/if}
                <span class="faint small">{v.block ? '整段' : '单值'}</span>
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
        <strong>渲染出来是这样</strong>
        <span class="faint small">
          —— 用的是<strong>示例值</strong>（一个假任务 / 一份假报告），不是你的真实任务；
          但渲染器与真的那次是同一个。
        </span>
        <button type="button" class="ghost small" onclick={() => (showText = false)}>收起</button>
      </div>
      <pre>{preview}</pre>
    </div>
  {/if}
</div>

<style>
  .tpl { grid-column: 1 / -1; }

  .tpl-head { display: flex; align-items: center; gap: var(--sp-2); }

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

  .tpl-text {
    width: 100%;
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
    max-height: 26rem;
    overflow: auto;
    font-size: var(--fs-xs);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
