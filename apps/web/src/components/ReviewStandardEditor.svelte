<script lang="ts">
  import { ACTION_TYPES, DEFAULT_ACTIONS } from '../lib/skill-install.ts'
  import type { ReviewStandard } from '../lib/api.ts'

  /**
   * 「审核标准」编辑栏（D37）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它是**一条记录**，不是一个字段
   * ══════════════════════════════════════════════════════════════════
   *
   * 名字 + 正文 + **允许触发哪些动作**——三样一起构成"这个审核者按什么判"。
   * 特别提示最后一样：判决里的动作是按它校验的（写错一个动作名，那份判决会
   * **永远不合规**，而使用者以为自己配好了）。所以它必须是**勾选**，不是
   * 手写的一串字符串。
   *
   * ⚠️ 与「指令」的区别：指令是"它的态度与角色"（进 `{{instructions}}`），
   *    标准是"它按什么判"（进 `{{standards}}`）。两者是两件事。
   *
   * ⚠️ 它是**受控**的（父组件持有值）：这个组件只画，不存。
   */
  export let value: ReviewStandard | null = null
  export let onchange: (next: ReviewStandard | null) => void = () => {}

  /** 名称默认给一个——空名字的标准在列表与日志里没法认。 */
  const fallbackName = '审核标准'

  let actions: string[] = value?.allowedActions ?? [...DEFAULT_ACTIONS]

  // 父组件的值变了（例如「把挂载的 skill 转成内联标准」）⇒ 勾选也要跟着走
  $: if (value && value.allowedActions.join() !== actions.join() && actions.length === 0) {
    actions = [...value.allowedActions]
  }

  function emit(patch: Partial<ReviewStandard>): void {
    const next: ReviewStandard = {
      name: (patch.name ?? value?.name ?? fallbackName).trim() || fallbackName,
      body: patch.body ?? value?.body ?? '',
      allowedActions: patch.allowedActions ?? actions,
    }
    // 正文空白 ⇒ 当成"没有标准"（与手写的语义一致：没有标准就拿不到审核任务）
    onchange(next.body.trim() === '' ? null : next)
  }
</script>

<div class="standard">
  <div class="std-head">
    <span class="std-label">审核标准</span>
    {#if value}
      <span class="badge std-on">已写</span>
    {:else}
      <span class="badge">没有标准</span>
    {/if}
  </div>

  <p class="std-hint">
    它按这份标准判断产出。<strong>没有标准的审核者拿不到审核任务</strong>——没有标准的
    审核不算审核。与上面的「指令」是两件事：指令管它的态度，标准管它按什么判。
  </p>

  <label>
    标准的名字
    <input
      value={value?.name ?? ''}
      placeholder={fallbackName}
      autocomplete="off"
      oninput={(e) => emit({ name: (e.currentTarget as HTMLInputElement).value })}
    />
  </label>

  <label>
    标准正文
    <textarea
      rows="8"
      spellcheck="false"
      placeholder={'例如：\n1. 能明确判断时给出 pass 或 fail，并把证据指回原文。\n2. 依据不足时给出 needs_human，写清楚缺什么。\n3. 不要引入这份标准之外的要求。'}
      value={value?.body ?? ''}
      oninput={(e) => emit({ body: (e.currentTarget as HTMLTextAreaElement).value })}
    ></textarea>
  </label>

  <div class="field">
    <span class="field-label">允许它触发哪些动作</span>
    <div class="action-picker">
      {#each ACTION_TYPES as action (action)}
        <label class="action-option">
          <input
            type="checkbox"
            value={action}
            checked={actions.includes(action)}
            onchange={(e) => {
              const on = (e.currentTarget as HTMLInputElement).checked
              actions = on ? [...actions, action] : actions.filter((a) => a !== action)
              emit({ allowedActions: actions })
            }}
          />
          <code>{action}</code>
        </label>
      {/each}
    </div>
    <span class="hint">
      判决里出现的动作必须在这里面。<strong>一个都不勾 = 只报告、不动作</strong>
      （需要改动的标准就把对应动作勾上；只读审核通常只要 <code>comment.create</code>）。
    </span>
  </div>
</div>

<style>
  .standard { display: flex; flex-direction: column; gap: var(--sp-3); }

  .std-head { display: flex; align-items: center; gap: var(--sp-2); }

  .std-label { font-size: var(--fs-sm); color: var(--text-dim); }

  .std-on { color: var(--accent); }

  .std-hint {
    font-size: var(--fs-xs);
    color: var(--text-faint);
    line-height: 1.6;
    margin: 0;
  }

  .field > .field-label {
    display: block;
    font-size: var(--fs-sm);
    color: var(--text-dim);
    margin-bottom: var(--sp-1);
  }

  .action-picker {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    gap: var(--sp-1);
    margin: var(--sp-2) 0;
    padding: var(--sp-2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
  }

  .action-option { display: flex; align-items: center; gap: var(--sp-2); margin: 0; cursor: pointer; }
  .action-option input { width: auto; }
</style>
