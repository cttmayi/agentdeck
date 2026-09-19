<script lang="ts">
  import type { TextMessage } from '../lib/tool-view.ts'
  import { t } from '../lib/i18n.ts'

  /**
   * 动作的**固定参数**编辑器（D43）：给已授权的动作的 open 参数钉值。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它回答的是"这个动作要用什么参数"，而"固定"与"模型填"是两种身份
   * ══════════════════════════════════════════════════════════════════
   *
   * 每个 open 参数只有两种状态：**不固定**（留给模型在判决时填，默认）或
   * **固定成一个值**（执行时由平台注入，模型不许写）。两种状态必须**一眼可分**。
   *
   * ⚠️ 两轮界面反馈之后定下的形状：
   *   · 第一版：字符串/整数只有一个输入框，placeholder 写"不固定（模型填）"——
   *     使用者看到的就只有"不固定"，看不出哪里能设固定值 ⇒ 加显式开关；
   *   · 第二版：开关选「固定」之后**才**出现输入框——使用者选了「固定」却不知道
   *     平台会传入什么（固定是个模式，不是值）⇒ 输入框**常驻**：**直接写值 =
   *     固定**（开关自动跟着变），清空 = 不固定；选了「固定」但还没填值时，
   *     明确提示"还没填值，填了才生效"。
   *
   * 控件按类型给：
   *   · enum → 下拉：「不固定（模型填）」空档 + 允许的取值（契约值原样显示，
   *     选一个取值 = 固定成它）；
   *   · boolean → 下拉：「不固定（模型填）」+ true / false（**存成真正的
   *     布尔值**，不是字符串——服务端校验要的是 `typeof value === 'boolean'`）；
   *   · string / integer → 开关（不固定 / 固定）+ **常驻**输入框。
   *
   * ⚠️ 受控组件（父组件持有值）：这里只画、只发 onparams，不存。父组件把它
   *    并进 `actionParams[type]`。
   *
   * ⚠️ 只列 **open** 参数（`params.open`）：绑定参数（`params.bound`）是平台按
   *    事实注入的，不归使用者钉——列出来只会诱导人去设一个根本不该设的东西。
   */
  export let items: Array<{
    name: string
    label: TextMessage
    required: boolean
    kind: 'string' | 'integer' | 'boolean' | 'enum'
    values: string[]
  }> = []
  export let params: Record<string, unknown> = {}
  export let onparams: (next: Record<string, unknown>) => void = () => {}

  /**
   * 唯一的本地过渡态：使用者在字符串/整数上选了「固定」、但还没填值的那一瞬间
   * （`params` 里还没有这个键，而界面必须已经显示"已选固定"并催他填）。一填值 /
   * 一取消就清掉——值本身永远在父组件手里。
   */
  let pendingFixed: string | null = null

  function onMode(name: string, mode: string): void {
    if (mode === 'open') {
      const next = { ...params }
      delete next[name]
      pendingFixed = null
      onparams(next)
      return
    }
    // 切到「固定」：已经固定（有值）就什么都不用做；否则先挂着，等输入
    if (name in params) return
    pendingFixed = name
  }

  /** 字符串值：空 = 不固定（删键）；否则 = 固定成这个值。 */
  function setValue(name: string, value: string): void {
    const next = { ...params }
    if (value === '') {
      delete next[name]
    } else {
      next[name] = value
    }
    pendingFixed = null
    onparams(next)
  }

  /** 布尔值：空 = 不固定；否则**存成真正的 boolean**（`'true'` 字符串会被服务端拒）。 */
  function setBoolean(name: string, raw: string): void {
    const next = { ...params }
    if (raw === '') {
      delete next[name]
    } else {
      next[name] = raw === 'true'
    }
    pendingFixed = null
    onparams(next)
  }

  /** 整数值：空 = 不固定；否则存成 number（与服务端校验一致）。 */
  function setNumber(name: string, raw: string): void {
    if (raw.trim() === '') {
      const next = { ...params }
      delete next[name]
      pendingFixed = null
      onparams(next)
      return
    }
    const value = Number(raw)
    if (Number.isNaN(value)) return
    pendingFixed = null
    onparams({ ...params, [name]: value })
  }
</script>

<div class="param-editor">
  {#if items.length === 0}
    <p class="hint">{$t('tools.paramFixedNone')}</p>
  {:else}
    {#each items as item (item.name)}
      <label class="param-row">
        <span class="param-name">
          <code>{item.name}</code>
          <span class="param-spec">{$t(item.label.id, item.label.params ?? {})}</span>
        </span>
        {#if item.values.length > 0}
          <!-- 枚举：一个下拉。第一项就是「不固定（模型填）」，其余是可选**固定值**
               ——选一个取值 = 钉死成它，一眼能看见"可以钉什么"。 -->
          <select
            value={typeof params[item.name] === 'string' ? String(params[item.name]) : ''}
            onchange={(e) => setValue(item.name, (e.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">{$t('tools.paramFixedUnset')}</option>
            {#each item.values as v (v)}
              <option value={v}>{v}</option>
            {/each}
          </select>
        {:else if item.kind === 'boolean'}
          <!-- 布尔：同一个下拉形状，但存真正的 boolean -->
          <select
            value={
              typeof params[item.name] === 'boolean' ? String(params[item.name]) : ''
            }
            onchange={(e) => setBoolean(item.name, (e.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">{$t('tools.paramFixedUnset')}</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        {:else}
          <!-- 字符串 / 整数：开关 + **常驻**输入框。直接写值 = 固定（开关跟着变），
               清空 = 不固定；开关只是状态的另一种看法/快捷方式，两边同源。
               ⚠️ `pendingFixed` 必须**直接写在模板里**（不能经 `fixedOf()` 函数）：
               Svelte 4 编译期只追踪模板直接引用的变量，经函数读它 = 赋值后不重渲染
               （点「固定」时开关不跳、提示不出现——探针 D43 抓出来的真 bug）。 -->
          <span class="param-fixed-pair">
            <select
              value={pendingFixed === item.name || item.name in params ? 'fixed' : 'open'}
              onchange={(e) => onMode(item.name, (e.currentTarget as HTMLSelectElement).value)}
            >
              <option value="open">{$t('tools.paramFixedUnset')}</option>
              <option value="fixed">{$t('tools.paramFixedYes')}</option>
            </select>
            {#if item.kind === 'integer'}
              <input
                type="number"
                value={typeof params[item.name] === 'number' ? String(params[item.name]) : ''}
                oninput={(e) => setNumber(item.name, (e.currentTarget as HTMLInputElement).value)}
                placeholder={$t('tools.paramFixedValuePlaceholder')}
              />
            {:else}
              <input
                type="text"
                value={typeof params[item.name] === 'string' ? String(params[item.name]) : ''}
                oninput={(e) => setValue(item.name, (e.currentTarget as HTMLInputElement).value)}
                placeholder={$t('tools.paramFixedValuePlaceholder')}
              />
            {/if}
          </span>
          {#if pendingFixed === item.name && !(item.name in params)}
            <!-- ⚠️ 选了「固定」但还没填值：不许静默——不然使用者以为钉上了，其实
                 什么都没存（那个键还没进 params）。 -->
            <span class="param-pending-hint">{$t('tools.paramFixedPending')}</span>
          {/if}
        {/if}
      </label>
    {/each}
    <p class="hint">{$t('tools.paramFixedHint')}</p>
  {/if}
</div>

<style>
  .param-editor {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    margin-top: var(--sp-1);
    padding: var(--sp-2);
    border-left: 2px solid var(--line);
    background: var(--bg);
    border-radius: 0 var(--radius) var(--radius) 0;
  }

  .param-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
    margin: 0;
  }

  .param-name {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    min-width: 0;
  }

  .param-spec {
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }

  .param-fixed-pair {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }

  .param-pending-hint {
    flex-basis: 100%;
    font-size: var(--fs-xs);
    color: var(--warn, #b45309);
  }

  .param-editor input[type='text'],
  .param-editor input[type='number'],
  .param-editor select {
    width: auto;
    min-width: 8rem;
    font-size: var(--fs-sm);
  }
</style>
