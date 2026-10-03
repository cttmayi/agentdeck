import { get, writable } from 'svelte/store'

/**
 * 平台自己的确认框（**居中对话框**），替代浏览器的 `window.confirm`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不用 `window.confirm`
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者的原话：「点删除对话，弹出来系统提示框，改用平台框，放中间」。
 *
 * 理由不止"好看"：`window.confirm` 是**浏览器 chrome**——
 *   · 位置由浏览器决定（多数在顶部居中，与页面无关）；
 *   · 样式、按钮文案、语言都归浏览器管（中文界面上可能是英文按钮）；
 *   · 它会**阻塞整个 JS 线程**，进度条/动画全停；
 *   · 在部分环境里（如某些嵌入式 webview）它直接被静默忽略——于是"确认"
 *     这一步**根本没发生**，而代码以为使用者点了。
 *
 * 所以确认这件事必须由平台自己画：位置、文案、危险色、语言都跟着平台走。
 *
 * ⚠️ 这一层做成**命令式**（`await askConfirm({...})`）而不是让每个视图各写一份
 *    弹窗状态：调用点（删对话 / 删任务 / 卸技能 / 卸工具包 / 卸远端技能）要的
 *    是同一件东西——"问一句、拿到是与否"。各写一份的结果是各处各演化一次。
 *
 * ★ 两个前端共用（2026-11 抽进 `@agentdeck/ui`）：daemon 界面与远端管理页
 *    （4518）的确认框由同一份状态驱动，`ConfirmDialog.svelte` 是同一个组件。
 */
export interface ConfirmRequest {
  /** 标题：**动作名**（「删除对话」「卸载工具」）。 */
  title: string
  /** 说清后果的那句话（删掉什么、能不能找回）。 */
  message: string
  /** 确认按钮上的字——用动作名，不用「确定」：按钮说什么就做什么。 */
  confirmLabel: string
  /** 危险动作（不可撤销、会删数据）⇒ 确认按钮用危险色。 */
  danger?: boolean
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (ok: boolean) => void
}

/**
 * 当前等待回答的那一个（`null` = 没有弹窗）。
 *
 * ⚠️ **全局只有一个**：确认框是模态的，同一时刻多于一个是说不通的
 *    （叠两层遮罩时使用者不知道该答哪一个，而且 Esc 该关哪个也没有答案）。
 */
export const pendingConfirm = writable<PendingConfirm | null>(null)

/**
 * 弹一个确认框，等使用者点。
 *
 * 返回 `true` = 确认（点了确认按钮）；`false` = 取消（取消按钮、Esc、点遮罩、
 * 右上角关闭，以及"被后来的弹窗挤掉"）。
 */
export function askConfirm(req: ConfirmRequest): Promise<boolean> {
  // ★ 上一个还没答就又来一个：把上一个当作**取消**收场。
  //   不这么做的话，先前那个 `await` 所在的代码会**永远挂着**
  //   （它拿不到答案，后面半句代码永远不执行）——这类挂起最难查，
  //   因为界面上什么都看不出来。
  get(pendingConfirm)?.resolve(false)
  return new Promise<boolean>((resolve) => {
    pendingConfirm.set({ ...req, resolve })
  })
}

/** 由 `ConfirmDialog` 调用：给出答案并关掉弹窗。 */
export function settleConfirm(ok: boolean): void {
  const current = get(pendingConfirm)
  if (!current) return
  // 先清掉再 resolve：resolve 之后调用方会继续跑（可能是同步的一大段），
  // 那一刻弹窗必须已经算"关掉了"，否则那段代码里再弹一个会被自己挤掉。
  pendingConfirm.set(null)
  current.resolve(ok)
}
