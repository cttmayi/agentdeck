export {
  askConfirm,
  pendingConfirm,
  settleConfirm,
  type ConfirmRequest,
} from '@agentdeck/ui'

/**
 * 平台自己的确认框状态（2026-11：搬进 `@agentdeck/ui`，daemon 界面与远端
 * 管理页共用同一份——两边弹的是同一个组件、同一份状态）。
 *
 * 接口位置不变（`askConfirm` / `pendingConfirm` / `settleConfirm`），调用点
 * 不用改；组件 `ConfirmDialog.svelte` 的 import 换到 `@agentdeck/ui`。
 */
