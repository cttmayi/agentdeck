/**
 * run 状态 → 徽标颜色类 / 词条 id（**全 App 一份**）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么从任务页搬出来（D80 三轮）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这段映射原来只写在 `views/Tasks.svelte` 里（任务详情的 run 列表用）。沉淀页的
 * 左栏也要显示起草 run 的状态徽标——如果就地再抄一份，两处就会各自演化：改一个
 * 状态的颜色要记得改两个文件，忘一处就是"同一个 run 在两个页面颜色不一样"。
 *
 * 使用者的原话是"UI 风格和任务差很多，怀疑你没有用同一控件"——同一份映射也是
 * 同一条纪律的一部分：**能共享的语义就别复制**。
 *
 * ★ 协议里的 `RunStatus` 有 8 个值，而 `app.css` 的状态色只覆盖了
 *   `completed`/`failed`/`cancelled` 三个——`running`/`queued`/`dispatched`/
 *   `deferred`/`waiting_local_directory` 原来一个颜色都没有（徽标落回
 *   `currentColor`，看起来"没有状态"）。这里映射到已有的那批语义色，
 *   不新增 CSS 变量：`queued`/`deferred`/`waiting_local_directory` 都表示
 *   "还没轮到它"，与看板的待办同色。
 */
import type { WebTextId } from '@agentdeck/i18n'

export const RUN_STATUS_CLASS: Record<string, string> = {
  queued: 'backlog',
  deferred: 'backlog',
  waiting_local_directory: 'backlog',
  dispatched: 'in_progress',
  running: 'in_progress',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** 状态徽标里的颜色类（未知状态返回空串——徽标自身仍然成形，只是不着色）。 */
export function runStatusClass(status: string): string {
  return RUN_STATUS_CLASS[status] ?? ''
}

/** 状态徽标里的字：走词表（`term.runStatus.*`），**不显示协议英文值**。 */
export function runStatusKey(status: string): WebTextId {
  return `term.runStatus.${status}` as WebTextId
}
