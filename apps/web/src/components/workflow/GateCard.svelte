<script lang="ts">
  /**
   * GateCard —— **人确认**（`gate()`）。这一步没有 run，所以没有日志、没有 Agent 名。
   *
   * 与 `RunCard` 分开是刻意的：它们的正文完全不同（一个是产出、一个是意见框），
   * 硬塞进一张卡会让"这里到底有没有 Agent 在跑"变得要靠状态去猜。
   */
  import { t } from '../../lib/i18n.ts'

  /** gate 的那句文案（"这份周报可以发了吗"）。 */
  export let text: string
  /** 确认 / 否决（否决必须带意见——意见会附加给下一轮执行者）。 */
  export let busy = false
  export let onconfirm: () => void = () => {}
  export let onreject: (feedback: string) => void = () => {}

  let feedback = ''

  function reject(): void {
    if (feedback.trim() === '') return
    onreject(feedback)
    feedback = ''
  }
</script>

<div class="card card--gate">
  <div class="card-head">
    <span class="card-line">
      <span class="badge blocked">{$t('workflows.stepWaitingHuman')}</span>
      <span class="kind">{$t('workflows.stepKindGate')}</span>
      <span class="gate-text">{text}</span>
    </span>
  </div>
  <div class="card-body">
    <article class="gate">
      <label class="field">
        <span class="faint fs-xs">{$t('workflows.gateFeedbackLabel')}</span>
        <textarea rows="2" bind:value={feedback}></textarea>
      </label>
      <div class="gate-actions">
        <button type="button" class="btn btn--primary" disabled={busy} onclick={onconfirm}>
          {$t('workflows.confirm')}
        </button>
        <button
          type="button"
          class="btn btn--danger"
          disabled={busy || feedback.trim() === ''}
          title={feedback.trim() === '' ? $t('workflows.gateFeedbackLabel') : ''}
          onclick={reject}
        >
          {$t('workflows.gateReject')}
        </button>
      </div>
    </article>
  </div>
</div>

<style>
  .card {
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--surface);
    overflow: hidden;
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
  }
  .card-line {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .kind {
    flex: 0 0 auto;
    font-size: var(--fs-2xs);
    color: var(--text-dim);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    padding: 0 var(--sp-1);
    white-space: nowrap;
  }
  .gate-text {
    min-width: 0;
    color: var(--text-dim);
    font-size: var(--fs-sm);
  }
  .card-body {
    padding: 0 var(--sp-3) var(--sp-3);
  }
  .gate {
    border: 1px solid var(--status-blocked);
    background: color-mix(in srgb, var(--status-blocked) 8%, transparent);
    border-radius: var(--radius);
    padding: var(--sp-2) var(--sp-3);
  }
  .gate-actions {
    display: flex;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }
</style>
