/**
 * 列表宽度拖动把手（2026-11，使用者：每个列表的宽度要能拖动）。
 *
 * 用法：挂在 `.split-layout` 上——
 *   <div class="split-layout" data-list-key="chat" data-list-label={$t('shell.resizeList')} use:listGrip>
 * 动作会：
 *   ① 在列表栏与详情栏之间插一个 `.split-grip` 把手（grid 第 2 列，不用算绝对位置——
 *      与沉淀页产物栏那个**绝对定位**的把手不同，列表把手是网格里的一列，宽窄由网格自己摆）；
 *   ② 挂载时从 localStorage 读出存档宽度写进 `--list-w`（没拖过不写，网格退回默认的
 *      "阅读宽度" minmax(20rem, 26rem)）；
 *   ③ pointerdown 后监听 **window** 的 pointermove / pointerup——拖动时鼠标会快速离开
 *      那个 6px 的把手，挂在把手上会"拖一下就断"（产物栏把手踩过的同一个坑）。
 *
 * 存档按视图分开（localStorage 键 `agentdeck.listW.<data-list-key>`）：聊天、任务、
 * 智能体、组、沉淀各记各的宽度，换页互不干扰。
 *
 * ⚠️ 把手由动作**插入**，不要在模板里手写——手写第二个会叠在同一个格子里。
 * ⚠️ 看板模式与窄屏（≤72rem）由 CSS 把把手藏掉（`.split-layout.board .split-grip` /
 *    72rem 媒体查询），动作只负责"在时可用"。
 */

const MIN = 240 // 15rem：再窄列表没法读
const MAX = 640 // 40rem：再宽就抢正文的地盘（列表是"阅读宽度"，不是自适应分配）
const clamp = (px: number): number => Math.min(MAX, Math.max(MIN, Math.round(px)))

export function listGrip(node: HTMLElement): { destroy(): void } {
  const key = node.dataset.listKey ?? 'default'
  const storeKey = `agentdeck.listW.${key}`
  const label = node.dataset.listLabel ?? ''

  const grip = document.createElement('button')
  grip.type = 'button'
  grip.className = 'split-grip'
  grip.setAttribute('role', 'separator')
  grip.setAttribute('aria-orientation', 'vertical')
  grip.setAttribute('aria-label', label)
  // 插到列表与详情之间（网格顺序：列表 | 把手 | 详情 | …）
  node.insertBefore(grip, node.children[1] ?? null)

  try {
    const raw = Number(localStorage.getItem(storeKey))
    if (Number.isFinite(raw) && raw > 0) {
      node.style.setProperty('--list-w', `${clamp(raw)}px`)
    }
  } catch {
    // 读不到存档就用默认（localStorage 被禁时拖动照常可用，只是记不住）
  }

  const listPane = node.querySelector(':scope > .list-pane')
  const currentWidth = (): number => {
    const fromVar = parseFloat(node.style.getPropertyValue('--list-w') || '')
    if (Number.isFinite(fromVar) && fromVar > 0) return fromVar
    return listPane ? Math.round(listPane.getBoundingClientRect().width) : MIN
  }

  let lastW = 0
  const onDown = (event: PointerEvent): void => {
    event.preventDefault()
    const startX = event.clientX
    const startW = currentWidth()
    lastW = startW
    grip.classList.add('dragging')
    const move = (ev: PointerEvent): void => {
      lastW = clamp(startW + (ev.clientX - startX))
      node.style.setProperty('--list-w', `${lastW}px`)
    }
    const up = (): void => {
      grip.classList.remove('dragging')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem(storeKey, String(lastW))
      } catch {
        // 存不上不影响用（下次开是默认值）
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  grip.addEventListener('pointerdown', onDown)

  return {
    destroy(): void {
      grip.remove()
    },
  }
}
