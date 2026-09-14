<script lang="ts">
  import { loadTemplateKit, saveFirstSentenceTemplates, templateKit } from '../lib/stores.ts'
  import { showToast } from '../lib/view.ts'
  import FirstSentenceTemplate from './FirstSentenceTemplate.svelte'
  import type { FirstSentenceKind } from '../lib/api.ts'

  /**
   * 第一句话模版的**全局设置**（D32）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它是通用配置，不是每个 agent 一份
   * ══════════════════════════════════════════════════════════════════
   *
   * 那段文字是"平台怎么把一次 run 交代给模型"的骨架，跟"这个 agent 是谁"
   * 是两件事——后者由 agent 的「指令」承担，而它会被插进模版里的
   * `{{role}}`。所以这里设一次，**所有 agent 都按它来**；换一个 agent 只是
   * 换掉「你的角色」那一段。
   *
   * 最初做成了每个 agent 一份，被使用者当场纠正。这次连**读**都收在一处：
   * 界面上显示的这份与执行器投递的那份走同一个接口（`current`）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 两个页签，一次保存
   * ══════════════════════════════════════════════════════════════════
   *
   * 执行与审核各一份模版，但**保存是一次的事**（同一个接口、同一个校验）。
   * 页签只是把它们分开显示——左边栏只有 416px，两个编辑器竖着堆起来没人看得
   * 下去；而"我在改哪一份"必须是明确的一件事。
   */
  export let open = false
  export let onclose: () => void = () => {}

  let tab: FirstSentenceKind = 'execute'
  let executeTemplate = ''
  let reviewTemplate = ''
  /** 初始值只取一次——否则每次 store 刷新都会把正在编辑的内容冲掉。 */
  let seeded = false
  let busy = false
  let error = ''

  $: if (open && $templateKit === null) void loadTemplateKit()
  $: if (open && !seeded && $templateKit !== null) {
    executeTemplate = $templateKit.current.executeTemplate
    reviewTemplate = $templateKit.current.reviewTemplate
    seeded = true
    error = ''
  }

  $: current = tab === 'review' ? reviewTemplate : executeTemplate
  function setCurrent(next: string): void {
    if (tab === 'review') reviewTemplate = next
    else executeTemplate = next
  }

  /** 「填入默认模版」要有东西可填：变量表还没到就先别给这个按钮。 */
  $: defaults = $templateKit?.defaults ?? null

  async function save(): Promise<void> {
    busy = true
    error = ''
    try {
      await saveFirstSentenceTemplates({ executeTemplate, reviewTemplate })
      showToast('第一句话模版已保存（对所有智能体生效）')
      onclose()
    } catch (err) {
      // 服务端的原文带回来：校验在那边（它是权威），这里不改写它
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }
</script>

{#if open}
  <form
    class="tpl-panel"
    onsubmit={(e) => {
      e.preventDefault()
      void save()
    }}
  >
    <h3>第一句话模版</h3>
    <p class="hint">
      这是<strong>通用配置</strong>：设一次，<strong>所有智能体</strong>都按它来（换 agent 只换
      「你的角色」那一段，它来自那个 agent 的「指令」）。留空 = 用平台默认那段。
    </p>

    <div class="tabs">
      <button
        type="button"
        class="tab"
        class:active={tab === 'execute'}
        onclick={() => (tab = 'execute')}
      >
        执行
        {#if executeTemplate.trim() !== ''}<span class="dot">●</span>{/if}
      </button>
      <button
        type="button"
        class="tab"
        class:active={tab === 'review'}
        onclick={() => (tab = 'review')}
      >
        审核
        {#if reviewTemplate.trim() !== ''}<span class="dot">●</span>{/if}
      </button>
    </div>

    {#if $templateKit === null}
      <p class="row-hint">拿不到变量表（daemon 可能没起来）——先重启 daemon 再改模版。</p>
    {:else}
      <!--
        只显示当前页签那一个编辑器。`{#key tab}` 是有用的：切页签时把组件
        整个重建，于是它内部的"预览打开了""变量清单展开了"跟着复位——
        预览属于**这一份**模版，不该跟着串到另一份上。
      -->
      {#key tab}
        <FirstSentenceTemplate kind={tab} value={current} onchange={setCurrent} showLabel={false} />
      {/key}
    {/if}

    {#if error}
      <div class="notice bad tpl-error">{error}</div>
    {/if}

    <div class="panel-foot">
      <button type="submit" disabled={busy || $templateKit === null}>
        {busy ? '保存中…' : '保存'}
      </button>
      <button type="button" class="secondary" onclick={onclose} disabled={busy}>取消</button>
      <span class="faint small">
        保存后<strong>对所有智能体生效</strong>，包括已经建好的那些。
      </span>
    </div>
  </form>
{/if}

<style>
  .tpl-panel {
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    padding: var(--sp-4);
    margin-bottom: var(--sp-3);
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }

  .tpl-panel h3 { margin-bottom: var(--sp-2); }

  .tabs {
    display: flex;
    gap: var(--sp-1);
    border-bottom: 1px solid var(--line);
    margin-bottom: var(--sp-3);
  }

  .tab {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    color: var(--text-faint);
    padding: var(--sp-2) var(--sp-3);
    cursor: pointer;
  }

  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .tab .dot { font-size: var(--fs-xs); margin-left: 4px; }

  .tpl-error { white-space: pre-line; margin-top: var(--sp-2); }

  .panel-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
    margin-top: var(--sp-3);
    padding-top: var(--sp-3);
    border-top: 1px solid var(--line);
  }
</style>
