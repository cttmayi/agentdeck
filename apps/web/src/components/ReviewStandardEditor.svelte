<script lang="ts">
  import type { ReviewStandard } from '../lib/api.ts'
  import { t } from '../lib/i18n.ts'

  /**
   * 「审核标准」编辑栏（D37）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它是一条记录：**名字 + 正文**
   * ══════════════════════════════════════════════════════════════════
   *
   * 名字给人看（列表与日志里认得出是哪一份），正文进第一句话的 `{{standards}}`。
   *
   * ⚠️ **"允许触发哪些动作"不在这里**（D40 收口搬走了）：那是审核者的**能力**，
   *    住在 `Agent.allowedActions`，界面上是**另一段**（`ActionPicker.svelte`
   *    ＋智能体详情里的「行动权限」）。它原来挤在这一栏里的后果很具体——改标准
   *    正文的时候顺手就改了权限，而那是两次不同的决定，混在一起之后审计里看不出
   *    差别。所以这里只回答"按什么判"。
   *
   * ⚠️ 与「指令」的区别：指令是"它的态度与角色"（进 `{{instructions}}`），
   *    标准是"它按什么判"（进 `{{standards}}`）。两者是两件事。
   *
   * ⚠️ 它是**受控**的（父组件持有值）：这个组件只画，不存。
   */
  export let value: ReviewStandard | null = null
  export let onchange: (next: ReviewStandard | null) => void = () => {}

  /**
   * 名称默认给一个——空名字的标准在列表与日志里没法认。
   *
   * ⚠️ 它**不进词表**（D39）：这个值会被 `emit()` 当成默认名字**存进标准记录**，
   *    不是一句界面文字。跟着界面语言变，会让同一条标准在两种语言下存成两个
   *    不同的名字；占位符（`placeholder={fallbackName}`）显示的就是这个真值。
   */
  const fallbackName = '审核标准'

  /**
   * 往上抛一条新标准。
   *
   * ★ 返回值**只有 name 与 body**，而且是**新对象**：老数据里可能还留着
   *   `allowedActions`（搬走之前的只读兼容字段），把它原样带上去等于让界面上
   *   任何一次"改个名字"都在重写那份旧配置——而写入口只有 `Agent.allowedActions`
   *   一处。少带一个键，是这件事在代码里的样子。
   */
  function emit(patch: { name?: string; body?: string }): void {
    const next: ReviewStandard = {
      name: (patch.name ?? value?.name ?? fallbackName).trim() || fallbackName,
      body: patch.body ?? value?.body ?? '',
    }
    // 正文空白 ⇒ 当成"没有标准"（与手写的语义一致：没有标准就拿不到审核任务）
    onchange(next.body.trim() === '' ? null : next)
  }
</script>

<div class="standard">
  <div class="std-head">
    <span class="std-label">{$t('agents.standardLabel')}</span>
    {#if value}
      <span class="badge std-on">{$t('agents.standardWritten')}</span>
    {:else}
      <span class="badge">{$t('agents.standardNone')}</span>
    {/if}
  </div>

  <p class="std-hint">
    {$t('agents.standardHintBefore')}<strong>{$t('agents.standardHintStrong')}</strong>{$t('agents.standardHintAfter')}
  </p>

  <label>
    {$t('agents.standardNameLabel')}
    <input
      value={value?.name ?? ''}
      placeholder={fallbackName}
      autocomplete="off"
      oninput={(e) => emit({ name: (e.currentTarget as HTMLInputElement).value })}
    />
  </label>

  <label>
    {$t('agents.standardBodyLabel')}
    <textarea
      rows="8"
      spellcheck="false"
      placeholder={$t('agents.standardBodyPlaceholder')}
      value={value?.body ?? ''}
      oninput={(e) => emit({ body: (e.currentTarget as HTMLTextAreaElement).value })}
    ></textarea>
  </label>
</div>

<style>
  .standard {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }

  .std-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }

  .std-label {
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }

  .std-on {
    color: var(--accent);
  }

  .std-hint {
    font-size: var(--fs-xs);
    color: var(--text-faint);
    line-height: 1.6;
    margin: 0;
  }

  /* ⚠️ 这一栏原来还有 `.field` / `.action-picker` / `.tool-action-*` 几组样式：
     它们服务的两块勾选（内置动作 + 已装工具的动作）已经搬到
     `ActionPicker.svelte`，样式跟着那一块走了。留在这里的选择器会选不中
     任何元素（`svelte-check` 报未使用），而且会把"权限住在哪里"这件事又说乱一次。 */
</style>
