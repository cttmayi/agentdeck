<script lang="ts">
  /**
   * 栏脚的**输入条**（"说一句话 + 发送"）。
   *
   * ★ 分批第 197 批：聊天页与沉淀页共用这一份。使用者："关于「发送」一起，用相同的控件，
   * 不然不一致"——两页原来一个是 `textarea + 发送`（聊天）、一个是 `input + 发送`（沉淀），
   * 连宽度与高度都不一样。
   *
   * 几条从聊天页搬来的行为（它们都是踩过的坑）：
   *   · **Enter 发送、Shift+Enter 换行**：`textarea` 里 Enter 默认换行，不拦一下它永远发不出去；
   *   · 发送按钮**按内容启用**（空串禁用），并在悬停时说明为什么不能发；
   *   · 左下角那行提示**由调用方给**（聊天页说"Enter 发送"，沉淀页说"这句话会被当成什么"），
   *     组件本身不认识任何业务文案。
   */
  import type { Snippet } from 'svelte'

  let {
    value = $bindable(''),
    placeholder = '',
    /** 输入框禁用（聊天在跑、沉底在等回答时都可能要禁）。 */
    disabled = false,
    /** 左下角那行小字（空串 = 不画）。 */
    hint = '',
    /** 发送按钮的字（两页各自的词条）。 */
    sendLabel = '',
    /** 发送按钮不可用时给的悬停说明。 */
    sendDisabledTitle = '',
    /** 额外的按钮/内容（沉淀页目前没有，留着与聊天页同构）。 */
    extra,
    onsend,
  }: {
    value?: string
    placeholder?: string
    disabled?: boolean
    hint?: string
    sendLabel?: string
    sendDisabledTitle?: string
    extra?: Snippet
    onsend: (text: string) => void
  } = $props()

  const canSend = $derived(!disabled && value.trim() !== '')

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    if (canSend) onsend(value.trim())
  }
</script>

<div class="pane-foot chat-composer" data-composer>
  <textarea
    class="composer-input"
    bind:value
    rows="2"
    {placeholder}
    {disabled}
    onkeydown={onKeydown}
  ></textarea>
  <div class="composer-row">
    <span class="faint small">{hint}</span>
    {#if extra}{@render extra()}{/if}
    <button
      type="button"
      class="primary"
      data-composer-send
      disabled={!canSend}
      title={canSend ? undefined : sendDisabledTitle}
      onclick={() => onsend(value.trim())}
    >{sendLabel}</button>
  </div>
</div>

<style>
  .chat-composer {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .composer-input {
    width: 100%;
    font: inherit;
    font-size: var(--fs-base);
    resize: vertical;
    max-height: calc(15lh + 1.6rem);
  }

  .composer-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
  }
</style>
