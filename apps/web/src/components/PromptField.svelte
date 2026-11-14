<script lang="ts">
  /**
   * PromptField：带「⛶ 展开」大编辑器的 prompt 输入控件（2026-11 控件化）。
   *
   * 把"小框 + 右下角展开按钮 + 弹层大编辑器"打包成一个控件——所有输入 prompt
   * 的位置（定时任务模板、智能体指令、任务要做什么、成员槽位指令）都用它，
   * 样式与行为只有一处定义：
   *
   *   · 小框 = textarea（行数/占位/只读可配，autosize 可选：随内容长高封顶）；
   *   · 右下角「⛶」浮按钮（全局 `.prompt-expand`，locked 时不显示）；
   *   · 点开 = PromptEditor 弹层（快照+确认语义，见 PromptEditor 头注释）；
   *   · vars 可选：定时任务传 6 个模板变量 chips（插到光标处）。
   *
   * 取值两种用法都支持：
   *   · 绑定式：`<PromptField bind:value={x} />`（写回 x）；
   *   · 受控式：只传 `value` + `oninput` 回调（值由父组件自己的状态驱动，
   *     例如 MemberSlotForm 的 `contentValue` 是 $derived，不能 bind）。
   *   弹层的保存写回 `value`：绑定式直接落父组件；受控式落在子组件本地，
   *    父组件靠 oninput 再同步——两种情形 onSave 都不丢字。
   */
  import { t } from '../lib/i18n.ts'
  import PromptEditor from './PromptEditor.svelte'

  let {
    value = $bindable(''),
    id,
    class: cls = '',
    label,
    vars = null,
    placeholder,
    rows = 6,
    locked = false,
    autosize = null,
    oninput = null,
    onkeydown = null,
    required = false,
    autocomplete,
  }: {
    value?: string
    id?: string
    /** 透传给小框 textarea 的 class（例如指令框的 `instructions`）。 */
    class?: string
    /** 字段名：小框的 label 由父组件自己摆；这里只当弹层标题。 */
    label?: string | undefined
    /** 可选：模板变量 chips（定时任务用）。 */
    vars?: Array<{ label: string; title: string }> | null | undefined
    placeholder?: string | undefined
    rows?: number | undefined
    /** 只读：小框 readonly，且不显示「⛶」展开按钮。 */
    locked?: boolean | undefined
    /** 可选：随内容长高，封顶 max 行后内部滚动（min 行起步）。 */
    autosize?: { min: number; max: number } | null | undefined
    oninput?: ((e: Event) => void) | null | undefined
    onkeydown?: ((e: KeyboardEvent) => void) | null | undefined
    required?: boolean | undefined
    /** textarea 原生 autocomplete（Svelte 类型是 FullAutoFill，不能用 string）。 */
    autocomplete?: HTMLTextAreaElement['autocomplete'] | undefined
  } = $props()

  let editorOpen = $state(false)
  let ta: HTMLTextAreaElement | null = null

  // autosize：先放平（height=auto）再按 scrollHeight 撑起来，封顶 max 行行高 +
  // 上下内边距；value 程序化变化（预填/清空）也要重量，所以依赖里带上 value。
  $effect(() => {
    const el = ta
    if (!el || !autosize) return
    const fit = (): void => {
      el.style.height = 'auto'
      const cs = getComputedStyle(el)
      const line = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.6 || 22
      const chrome =
        Number.parseFloat(cs.paddingTop) || 0 + (Number.parseFloat(cs.paddingBottom) || 0)
      const maxH = line * autosize.max + chrome
      const want = el.scrollHeight
      el.style.height = `${Math.min(want, maxH)}px`
      el.style.overflowY = want > maxH ? 'auto' : 'hidden'
    }
    const onInput = (): void => fit()
    el.addEventListener('input', onInput)
    fit()
    return () => el.removeEventListener('input', onInput)
  })
</script>

<div class="field-prompt">
  <textarea
    id={id}
    class={cls}
    class:locked={locked}
    bind:value={value}
    bind:this={ta}
    rows={rows}
    placeholder={placeholder}
    readonly={locked}
    required={required}
    autocomplete={autocomplete}
    oninput={(e) => {
      if (oninput) oninput(e)
    }}
    onkeydown={(e) => {
      if (onkeydown) onkeydown(e)
    }}
  ></textarea>
  {#if !locked}
    <button
      type="button"
      class="prompt-expand"
      title={$t('editor.expand')}
      onclick={() => (editorOpen = true)}
    >⛶</button>
  {/if}
</div>

<PromptEditor
  open={editorOpen}
  title={label ?? ''}
  value={value}
  vars={vars}
  onSave={(v) => (value = v)}
  onCancel={() => (editorOpen = false)}
/>
