<script lang="ts">
  import { loadTemplateKit, saveFirstSentenceTemplates, templateKit } from '../lib/stores.ts'
  import { showToast } from '../lib/view.ts'
  import Drawer from './Drawer.svelte'
  import FirstSentenceTemplate from './FirstSentenceTemplate.svelte'
  import type { FirstSentenceKind } from '../lib/api.ts'

  /**
   * 设置（右侧抽屉）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它是一个**装设置的容器**，不只有第一句话
   * ══════════════════════════════════════════════════════════════════
   *
   * 结构按"以后还要往里加"来搭：抽屉里是一串 `.drawer-section`，
   * 每一段是一件独立的事，各写各的说明；底部常驻一个共用的「保存」。
   * 现在只有一段——**第一句话模版**。
   *
   * ══════════════════════════════════════════════════════════════════
   * 第一句话模版是**全局配置**
   * ══════════════════════════════════════════════════════════════════
   *
   * 那段文字是"平台怎么把一次 run 交代给模型"的骨架，跟"这个 agent 是谁"
   * 是两件事——后者由 agent 的「指令」承担，而它会作为 `{{instructions}}` 插进模版。
   * 所以这里设一次，**所有 agent 都按它来**（包括已经建好的）；换一个 agent
   * 只是换掉 `{{instructions}}` 那段。
   *
   * 最初的版本做成了每个 agent 一份，被使用者当场纠正；界面上显示的这份与
   * 执行器投递的那份也因此收在同一个接口上（`current`）。
   *
   * 执行与审核各一份：在**同一段**里用两个页签分开——它们是同一件事的两个
   * 面（"交代什么"与"按什么标准审"），但材料与判决契约只有审核那份有，
   * 混在一起会让两条链路互相牵制。
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

  async function save(): Promise<void> {
    busy = true
    error = ''
    try {
      await saveFirstSentenceTemplates({ executeTemplate, reviewTemplate })
      showToast('设置已保存（对所有智能体生效）')
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
  <Drawer
    {open}
    wide
    title="设置"
    subtitle="这里的设置都是平台行为：改一次，对所有智能体生效。"
    ariaLabel="设置"
    {onclose}
  >
    <form
      id="settings-form"
      class="settings-form"
      onsubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <!-- ══════════════ 第一句话模版 ══════════════ -->
      <section class="drawer-section">
        <h3>第一句话模版</h3>
        <p class="hint">
          一次 run 交代给模型的<strong>全部内容</strong>就是这一段文字（只有这一条通道）。
          它是<strong>通用配置</strong>：设一次，<strong>所有智能体</strong>都按它来——换一个
          智能体只换 <code>{'{{instructions}}'}</code> 那段（来自那个智能体的「指令」）。留空 = 用平台默认那段。
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
          <p class="empty-value">拿不到变量表（daemon 可能没起来）——先重启 daemon 再改模版。</p>
        {:else}
          <!--
            只显示当前页签那一个编辑器。`{#key tab}` 是有用的：切页签时把组件
            整个重建，于是它内部的"预览打开了""变量清单展开了"跟着复位——
            预览属于**这一份**模版，不该跟着串到另一份上。
          -->
          {#key tab}
            <FirstSentenceTemplate
              kind={tab}
              value={current}
              onchange={setCurrent}
              showLabel={false}
            />
          {/key}
        {/if}
      </section>

      <!-- 以后的设置往这里加：一段一件独立的事，底部那个「保存」是共用的 -->
    </form>

    <svelte:fragment slot="foot">
      <button type="submit" form="settings-form" disabled={busy || $templateKit === null}>
        {busy ? '保存中…' : '保存'}
      </button>
      <button type="button" class="secondary" onclick={onclose} disabled={busy}>取消</button>
      {#if error}
        <span class="bad small settings-error">{error}</span>
      {:else}
        <span class="faint small">保存后<strong>对所有智能体生效</strong>，包括已经建好的那些。</span>
      {/if}
    </svelte:fragment>
  </Drawer>
{/if}

<style>
  .settings-form { width: 100%; min-width: 0; }

  .settings-form .tabs {
    display: flex;
    gap: var(--sp-1);
    border-bottom: 1px solid var(--line);
    margin: var(--sp-3) 0;
  }

  .settings-form .tab {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    color: var(--text-faint);
    padding: var(--sp-2) var(--sp-4);
    cursor: pointer;
  }

  .settings-form .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .settings-form .tab .dot { font-size: var(--fs-xs); margin-left: 4px; }

  /* 校验错误可能是好几条，一句一行读得清 */
  .settings-error { white-space: pre-line; }
</style>
