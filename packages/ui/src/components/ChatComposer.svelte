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
   *
   * ★ 分批第 232 批（使用者定）：**输入框与发送在同一行，下面不再有那行小字**。
   *
   *   原话："输入框和发送放同一行吧，太占高度了。也不需要下面的『正在跑』这样的信息"。
   *
   *   量过的高度：原来三块竖着排——两行文本框 + 一行提示（hint）+ 一行按钮，占掉栏脚
   *   四五行的位置；而右边那行按钮只有一个回形针和一个「发送」，左边空着。合并之后
   *   只剩"文本框那一块"，按钮贴在它的右下角。
   *
   *   那行提示（"Enter 发送 · Shift+Enter 换行" / "正在跑…"）一并去掉，理由分两半：
   *     · 键盘约定**已经写在输入框的 placeholder 里**（`chat.placeholder` 就带着它），
   *       再常驻一行等于同一句话说两遍；
   *     · "正在跑"属于**这一轮的状态**，它已经在消息流里那一行（带「停止」）说了。
   *   所以 `hint` 这个 prop 也删掉了——留一个没人传的参数只会让下一个人以为它还在生效。
   *
   * ★ 分批第 231 批（使用者定）：`disabled` **只挡住"发"，不挡"打字"**。
   *   原话："在执行过程中不能输入文字。我期待可以输入文字，只是不能发送即可。"
   *
   *   这条改动是有道理的：一轮在跑的时候，人往往正想到要补一句——那时输入框锁死，
   *   他只能先把话写在别处、等跑完再粘回来（或者干脆忘了）。而"不能发"本来就不需要
   *   靠锁输入框来实现：发送按钮与 Enter 都看 `canSend`。
   */
  import type { Snippet } from 'svelte'

  let {
    value = $bindable(''),
    placeholder = '',
    /**
     * **不能发**（不是"不能打字"）。
     *
     * ★ 分批第 231 批：它原来同时禁掉了输入框，于是"一轮正在跑"的时候连想补一句话都
     * 写不进去。现在它只管"发"：发送按钮禁用、Enter 不发（按下去当换行用），
     * 输入框照旧可以打字、那几行字会留着等这一轮结束。
     */
    disabled = false,
    /** 发送按钮的字（两页各自的词条）。 */
    sendLabel = '',
    /** 发送按钮不可用时给的悬停说明。 */
    sendDisabledTitle = '',
    /** 额外的按钮/内容（两页各自的小东西）。 */
    extra,
    /**
     * ★ 分批第 203 批：**上传文件**（两页共用同一颗回形针按钮）。
     *
     * 给了它就画一颗「📎」：点了选文件，选完把 `File[]` 交回去（**上传本身由调用方做**——
     * 落点、接口、回执各不相同，组件不该认识 `/api/crystallize/...` 这种东西）。
     * 不传就什么都不画（与以前的渲染一模一样）。
     */
    onupload,
    /**
     * 回形针的悬停说明 / 无障碍标签。
     *
     * ⚠️ 文案由调用方给：`@agentdeck/ui` 不认识任何业务词表（这个包只依赖 svelte），
     * 所以这里不 import `t`——那会让 ui 包拖着一份 i18n 依赖，而远端管理页也要用它。
     */
    attachLabel = '',
    onsend,
  }: {
    value?: string
    placeholder?: string
    disabled?: boolean
    sendLabel?: string
    sendDisabledTitle?: string
    extra?: Snippet
    onupload?: ((files: File[]) => void) | undefined
    attachLabel?: string
    onsend: (text: string) => void
  } = $props()

  const canSend = $derived(!disabled && value.trim() !== '')

  /** 隐藏的 `<input type=file>`：回形针那个按钮就是它的入口。 */
  let fileInput: HTMLInputElement | null = $state(null)

  function onPicked(event: Event): void {
    const input = event.currentTarget as HTMLInputElement | null
    const files = [...(input?.files ?? [])]
    // 清空 value：再选同一个文件时 `change` 才会再触发
    if (input) input.value = ''
    if (files.length > 0) onupload?.(files)
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    /**
     * ★ 分批第 231 批：`disabled` 时**不拦 Enter**——这一栏此刻还能打字，Enter 就该
     *   老老实实换行（拦掉它、又什么都不发，等于按一下没反应）。
     */
    if (disabled) return
    event.preventDefault()
    if (canSend) onsend(value.trim())
  }
</script>

<div class="pane-foot chat-composer" data-composer>
  <div class="composer-row">
    <!-- ⚠️ 这里**不传 `disabled`**（分批第 231 批）：跑着的时候也让人把想说的写下来，
         只是发不出去。见上面 `disabled` 那段。 -->
    <textarea
      class="composer-input"
      bind:value
      rows="2"
      {placeholder}
      onkeydown={onKeydown}
    ></textarea>
    <!-- 右侧那一组：额外内容 + 回形针 + 发送，贴在输入框的右下角 -->
    <span class="composer-actions">
      {#if extra}{@render extra()}{/if}
      {#if onupload}
        <button
          type="button"
          class="ghost small attach"
          data-composer-attach
          title={attachLabel}
          aria-label={attachLabel}
          onclick={() => fileInput?.click()}
        >📎</button>
        <input
          class="attach-input"
          type="file"
          multiple
          hidden
          bind:this={fileInput}
          onchange={onPicked}
        />
      {/if}
      <button
        type="button"
        class="primary"
        data-composer-send
        disabled={!canSend}
        title={canSend ? undefined : sendDisabledTitle}
        onclick={() => onsend(value.trim())}
      >{sendLabel}</button>
    </span>
  </div>
</div>

<style>
  /**
   * 一行：输入框吃掉剩下的宽度，动作组钉在右下角（`align-items: flex-end`——按钮跟着
   * 文字块的底边走，多行时不会被顶到中间去）。
   */
  .composer-row {
    display: flex;
    align-items: flex-end;
    gap: var(--sp-2);
  }

  .composer-input {
    flex: 1 1 auto;
    min-width: 0;
    font: inherit;
    font-size: var(--fs-base);
    /* 高度随内容长（Chrome 支持 `field-sizing`）；不支持的浏览器就是固定的两行 + 内部滚动，
       两条路都是"能看见自己写了什么"，而且都很矮。 */
    field-sizing: content;
    resize: none;
    max-height: calc(8lh);
    overflow-y: auto;
  }

  .composer-actions {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    /* 不让动作组被输入框挤扁（中文的 min-content 是一个字，见 app.css 里那条规矩） */
    flex: 0 0 auto;
  }

  /* 回形针：紧挨着「发送」（都在右边那组），提示文字仍占左边 */
  .attach {
    padding: 0 var(--sp-2);
    line-height: 1;
  }
</style>
