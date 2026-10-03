export {
  askConfirm,
  pendingConfirm,
  settleConfirm,
  type ConfirmRequest,
} from '@agentdeck/ui'

/**
 * 确认框状态（2026-11：daemon 界面与远端管理页共用 `@agentdeck/ui` 的同一份）。
 *
 * 接口从本端的 `confirmDialog()/answerConfirm()/currentConfirm()` 统一成
 * daemon 那套 `askConfirm()/settleConfirm()/pendingConfirm`——两个前端同一件事
 * 只有一个名字（探针断言"点卸载弹的是平台自己的确认框"依赖的 `.modal` 结构
 * 由共用的 `ConfirmDialog` 渲染）。
 */
