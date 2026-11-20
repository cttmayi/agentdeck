/**
 * 「拖出来的宽度」只有一个出处（2026-11，D175）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么收成一份
 * ══════════════════════════════════════════════════════════════════
 *
 * 同一件事原来**写了两遍**：列表栏（`lib/list-grip.ts`）与沉淀页的产物栏
 * （`views/Crystallize.svelte` 里内联的 `startResize`）。两处各有一份 clamp、
 * 各写一遍"挂 window 的 pointermove/pointerup"（和那句踩过坑的注释：把手只有
 * 6–8px，挂在把手上会"拖一下就断"）、各写一遍"存不上不影响用"、各有一份
 * localStorage 键。改一处漏一处，正是本仓库最想避免的那种重复。
 *
 * 两处真正的差别只有三件事，都做成了参数：
 *   ① 把手从哪来：列表是**动作插入**的 `.split-grip`（它是网格里的一列），
 *      产物栏是**模板里就有**的 `.pane-resizer`（绝对定位在网格上）；
 *   ② 鼠标往右拖是变宽还是变窄：产物栏的把手贴在自己左缘，所以是**反的**；
 *   ③ 可拖的范围（列表 240–640，产物栏 320–760）。
 *
 * 存档键统一成 `agentdeck.pane.<name>`（列表是 `list.<视图>`、产物栏是 `artifact`）。
 * ⚠️ 老键**照读**：`agentdeck.listW.<视图>` 与 `agentdeck.crystallize.artifactW`。
 *    读到老键就搬进新键再删掉老键——使用者已经拖好的宽度不能因为一次重构丢掉。
 * ⚠️ 探针原先按老键清理（`tools/layout-probe/probe.html` 里
 *    `removeItem('agentdeck.listW.chat')`），所以那边也一并清两种键。
 *
 * 用法（列表，六个视图都这么写，参数从 `data-list-*` 来）：
 *   <div class="split-layout" data-list-key="chat" data-list-label={$t('shell.resizeList')} use:paneResize>
 * 用法（产物栏，把手在标记里）：
 *   <div class="split-layout with-artifact" use:paneResize={{ name: 'artifact', …, handle: '.pane-resizer' }}>
 */

/** 列表栏的默认档（六个视图共用；两者都是"阅读宽度"的边界，不是自适应分配） */
const LIST_MIN = 240 // 15rem：再窄列表没法读
const LIST_MAX = 640 // 40rem：再宽就抢正文的地盘
const LIST_VAR = '--list-w'

export const PANE_KEY_PREFIX = 'agentdeck.pane.'

/** 沉淀页产物栏的存档名 */
export const ARTIFACT_PANE = 'artifact'

/**
 * 老键（D175 之前）：读到就搬进新键。**按名字推**，不要让每个调用点再传一遍——
 * 传一遍就等于第二处定义"老键长什么样"。
 */
function legacyFor(name: string): readonly string[] {
  if (name === ARTIFACT_PANE) return ['agentdeck.crystallize.artifactW']
  if (name.startsWith('list.')) return [`agentdeck.listW.${name.slice('list.'.length)}`]
  return []
}

/**
 * **有可拖列表栏的地方**（设置页「布局」照它列）。名称用侧栏同一批词条——
 * 同一个页面对使用者只有一个名字。
 * ⚠️ 加一个可拖的列表：视图模板里加 `data-list-key`，并在这里加一行；
 *    `tests/web-pane-keys.test.ts` 盯着两边一致（少一行、多一行都红）。
 */
export const LIST_PANES = [
  { name: 'list.chat', labelId: 'shell.navChat' },
  { name: 'list.tasks', labelId: 'shell.navTasks' },
  { name: 'list.agents', labelId: 'shell.navAgents' },
  { name: 'list.workflows', labelId: 'workflows.navTitle' },
  { name: 'list.schedules', labelId: 'schedules.navTitle' },
  { name: 'list.crystallize', labelId: 'crystallize.navTitle' },
] as const

export type PaneResizeSpec = {
  /** 存档名（拼在 `agentdeck.pane.` 后面）。缺省时从 `data-list-key` 推成 `list.<key>` */
  name?: string
  min?: number
  max?: number
  /** 宽度写进哪个 CSS 变量 */
  cssVar?: string
  /** 量宽度用哪个元素（变量还没写过时，用它现在的实际宽度当起点） */
  measure?: string
  /** 鼠标往右拖是否变宽。右侧产物栏的把手在自己左缘 ⇒ false */
  rightWidens?: boolean
  /** 现成把手的 CSS 选择器。不传就由动作插入一个 `.split-grip`（列表那种网格列） */
  handle?: string
  /** 把手的无障碍标签（插入模式用；现成把手自己带 `aria-label`） */
  label?: string
}

const clampTo = (px: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(px)))

function readStored(name: string): number | null {
  const legacy = legacyFor(name)
  try {
    const raw = localStorage.getItem(PANE_KEY_PREFIX + name)
    const fromNew = Number(raw)
    if (raw !== null && Number.isFinite(fromNew) && fromNew > 0) return fromNew
    for (const key of legacy) {
      const old = Number(localStorage.getItem(key))
      if (Number.isFinite(old) && old > 0) {
        // 搬进新键：老键留着没有用处，删掉（下一次就是"新键直接命中"这条路）
        localStorage.setItem(PANE_KEY_PREFIX + name, String(old))
        localStorage.removeItem(key)
        return old
      }
    }
  } catch {
    // 读不到存档就用默认（localStorage 被禁时拖动照常可用，只是记不住）
  }
  return null
}

/**
 * 某个可拖位置**存下来的**宽度（没拖过 = null）。
 * 设置页「布局」用它列"当前 / 默认"。
 */
export function paneWidth(name: string): number | null {
  try {
    const raw = Number(localStorage.getItem(PANE_KEY_PREFIX + name))
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null
  } catch {
    return null
  }
}

/**
 * 恢复默认宽度：把新键与老键一起删掉。
 * ⚠️ 不"写一个 448 进去"——默认宽度是 CSS 那一侧的事（`var(--list-w, …)` /
 *    `var(--artifact-w, 28rem)`）；这里写死一个数就成了第二处定义。
 * 挂着的那个视图要等下次挂载才回到默认（设置页与列表页不在同一屏，够用）。
 */
export function resetPaneWidth(name: string): void {
  try {
    localStorage.removeItem(PANE_KEY_PREFIX + name)
    for (const legacy of legacyFor(name)) localStorage.removeItem(legacy)
  } catch {
    // 存不上不影响用
  }
}

/** 全部恢复默认（六个列表栏 + 产物栏） */
export function resetAllPaneWidths(): void {
  for (const pane of LIST_PANES) resetPaneWidth(pane.name)
  resetPaneWidth(ARTIFACT_PANE)
}

export function paneResize(node: HTMLElement, spec: PaneResizeSpec = {}): { destroy(): void } {
  const listKey = node.dataset.listKey
  const name = spec.name ?? `list.${listKey ?? 'default'}`
  const min = spec.min ?? LIST_MIN
  const max = spec.max ?? LIST_MAX
  const cssVar = spec.cssVar ?? LIST_VAR
  const measureSel = spec.measure ?? '.list-pane'
  const rightWidens = spec.rightWidens ?? true

  const storeKey = PANE_KEY_PREFIX + name
  const apply = (px: number): void => node.style.setProperty(cssVar, `${px}px`)
  const currentWidth = (): number => {
    const fromVar = parseFloat(node.style.getPropertyValue(cssVar) || '')
    if (Number.isFinite(fromVar) && fromVar > 0) return fromVar
    const pane = node.querySelector(':scope > ' + measureSel) ?? node.querySelector(measureSel)
    return pane ? Math.round(pane.getBoundingClientRect().width) : min
  }

  // ── 把手：插入一个（列表），或者接管标记里那个（产物栏） ──
  let grip: HTMLButtonElement | null = null
  if (spec.handle === undefined) {
    grip = document.createElement('button')
    grip.type = 'button'
    grip.className = 'split-grip'
    grip.setAttribute('role', 'separator')
    grip.setAttribute('aria-orientation', 'vertical')
    grip.setAttribute('aria-label', spec.label ?? node.dataset.listLabel ?? '')
    // 插到列表与详情之间（网格顺序：列表 | 把手 | 详情 | …）
    node.insertBefore(grip, node.children[1] ?? null)
  }

  const stored = readStored(name)
  if (stored !== null) apply(clampTo(stored, min, max))

  const wantsHandle = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null
    if (grip !== null) return target.closest('.split-grip') === grip ? grip : null
    // 接管模式：把手在标记里，用现成的选择器判断（不要在挂载时抓引用——
    // 动作可能先于子元素挂上来）
    const hit = target.closest(spec.handle ?? '')
    return hit instanceof HTMLElement ? hit : null
  }

  let lastW = 0
  const onDown = (event: PointerEvent): void => {
    const handle = wantsHandle(event.target)
    if (handle === null) return
    event.preventDefault()
    const startX = event.clientX
    const startW = currentWidth()
    lastW = startW
    handle.classList.add('dragging')
    const move = (ev: PointerEvent): void => {
      const dx = rightWidens ? ev.clientX - startX : startX - ev.clientX
      lastW = clampTo(startW + dx, min, max)
      apply(lastW)
    }
    const up = (): void => {
      handle.classList.remove('dragging')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem(storeKey, String(lastW))
      } catch {
        // 存不上不影响用（下次开是默认值）
      }
    }
    // ⚠️ 监听挂 window：拖动时鼠标会很快离开那个 6–8px 的把手，
    //    挂在把手上会"拖一下就断"（两处实现都踩过这个坑，收进来只写一次）
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  node.addEventListener('pointerdown', onDown)

  return {
    destroy(): void {
      node.removeEventListener('pointerdown', onDown)
      grip?.remove()
    },
  }
}
