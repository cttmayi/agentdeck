<script lang="ts">
  import Modal from './Modal.svelte'
  import { pendingConfirm, settleConfirm } from '../lib/confirm.ts'

  /**
   * 确认框（居中）——`askConfirm()` 画出来的那一个（2026-11 抽进
   * `@agentdeck/ui`，daemon 界面与远端管理页共用同一份）。
   *
   * 挂在各 app 的 `App.svelte` 上**只有一份**（理由见 `lib/confirm.ts`）。放在
   * 这一层而不是各视图里，是因为"点删除"可能是整页要离开的动作：弹窗挂在被删掉
   * 的那个视图里，视图一卸载弹窗跟着消失，使用者会看到它闪一下。
   *
   * 复用 `Modal.svelte`（居中对话框）：遮罩、Esc、关闭按钮那三件事已经在它里面
   * 做过了。确认框与"挑选器"是同一个形状——停下来答一个问题。
   *
   * ⚠️ `cancelLabel` / `closeLabel` 由挂载端传入（webText / remoteText 有意分开）。
   */
  export let cancelLabel = ''
  export let closeLabel = ''
  $: req = $pendingConfirm
</script>

<Modal
  open={req !== null}
  title={req?.title ?? ''}
  ariaLabel={req?.title ?? ''}
  onclose={() => settleConfirm(false)}
  closeLabel={closeLabel}
>
  <p class="confirm-message">{req?.message ?? ''}</p>

  <svelte:fragment slot="foot">
    <!-- 取消在左、确认在右（与系统对话框同一个顺序），危险动作用危险色 -->
    <button type="button" class="secondary" onclick={() => settleConfirm(false)}>
      {cancelLabel}
    </button>
    <button
      type="button"
      class={req?.danger ? 'danger' : ''}
      onclick={() => settleConfirm(true)}
    >
      {req?.confirmLabel ?? ''}
    </button>
  </svelte:fragment>
</Modal>

<style>
  /* 一句话的正文：行距放宽一点，别让它挤成一坨（这段字是"点下去会发生什么"） */
  .confirm-message {
    margin: 0;
    line-height: 1.6;
  }
</style>
