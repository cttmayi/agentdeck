import type { WorkDirFile } from './api.ts'

/**
 * 工作目录那一栏的显示逻辑。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要从组件里提出来
 * ══════════════════════════════════════════════════════════════════
 *
 * 这一栏出过两次"看起来像没数据"的问题，两次都不是数据的问题：
 *
 *   1. 判断 `entries.length === 0` 显示"空目录"，渲染时却把平台注入的项
 *      **过滤掉**了 —— 目录里只有平台文件时，两边都不成立，于是一栏空白、
 *      连"空目录"都不说；
 *   2. 递归列整棵树，一个技能目录就能带出
 *      `.claude/skills/algorithmic-art/templates/viewer.html` 这种一长串路径，
 *      把真正的产出淹掉十几行里。
 *
 * 两次的修法都是"把判断与渲染绑在同一份逻辑上"，而那份逻辑放在组件里就只能靠
 * 手点界面来验证。所以提到这里：纯函数、可穷举。
 */

/**
 * 显示顺序：**产出在前、平台注入在后**；每一拨里目录在前、再按名字。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么"平台注入的"必须排最后
 * ══════════════════════════════════════════════════════════════════
 *
 * 只按"目录优先"排会把 `.claude/` 顶到第一位——而它是平台自己的东西
 *（技能、上下文文件），不是这次任务做出来的东西。使用者的原话是这一栏
 * "把真正的产出淹掉"；注入物排在前面正好又犯一次同样的错。
 */
export function sortWorkDirEntries(entries: readonly WorkDirFile[]): WorkDirFile[] {
  const rank = (e: WorkDirFile): number => (e.managed ? 2 : 0) + (e.kind === 'dir' ? 0 : 1)
  return [...entries].sort((a, b) =>
    rank(a) === rank(b) ? a.name.localeCompare(b.name) : rank(a) - rank(b),
  )
}

export interface WorkDirRow {
  entry: WorkDirFile
  /** 缩进层级：0 = 顶层。界面按它算 `padding-left`。 */
  depth: number
}

/**
 * 把"已展开的树"摊平成一串行。
 *
 * ★ 摊平而不是在模板里递归：递归模板很难测（要渲染组件），而"哪些行该出现、
 *   缩进多少"恰恰是最容易错的地方（展开了不显示、没展开却显示、层级算错）。
 *   摊平之后就是一次遍历，可以拿数据直接断言。
 *
 * `children` 是"目录路径 → 它的子项"，只包含**已经被取回来**的那些。
 * 展开但还没取回来的目录会出现空档——那时上层应显示"正在读…"，
 * 所以这里不替它编造行。
 */
export function flattenWorkDir(
  roots: readonly WorkDirFile[],
  children: ReadonlyMap<string, readonly WorkDirFile[]>,
  expanded: ReadonlySet<string>,
): WorkDirRow[] {
  const rows: WorkDirRow[] = []

  const walk = (list: readonly WorkDirFile[], depth: number): void => {
    for (const entry of sortWorkDirEntries(list)) {
      rows.push({ entry, depth })
      // 只有"是目录、有子项、而且已经展开"才往下走
      if (entry.kind !== 'dir' || !expanded.has(entry.path)) continue
      const kids = children.get(entry.path)
      if (kids) walk(kids, depth + 1)
    }
  }

  walk(roots, 0)
  return rows
}

/** 人类可读的大小。目录没有大小，不显示。 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
