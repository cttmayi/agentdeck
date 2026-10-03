/**
 * `@agentdeck/ui` —— **两个前端共用的那一套界面基础**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有这个包（2026-10）
 * ══════════════════════════════════════════════════════════════════
 *
 * 2026-10 加了第二个前端：**远端的技能 / 工具管理页**（跑在 4518 上）。
 * 使用者对它的要求是一句话——"**风格和 daemon web 相似**"。
 *
 * "相似"有两种做法：
 *
 *   ① 各写一份样式，靠人眼对齐（❌）：两天就会漂移，而漂移的表现是"同一个按钮
 *      在两页不一样高"这种没人会去报的小差别，累积起来就是"不是同一个产品"；
 *   ② **同一份文件，两处 import**（✅，这里选的）：设计令牌、组件样式、主题
 *      判定都只有一处，改一次两边一起变。
 *
 * 所以：
 *   · `src/styles/app.css` —— 设计令牌 + 基础组件样式（原 `apps/web/src/styles/app.css`，
 *     1257 行，分节组织：令牌 / 基础 / 布局骨架 / 侧边栏 / 表格 / 抽屉 / 提示条…）；
 *   · `src/theme.ts` —— 亮/暗/跟随系统三档（`data-theme` 打在 `<html>` 上，
 *     CSS 里换一层变量即可），两个前端共用同一套判定与同一个 localStorage 键。
 *
 * ⚠️ 这里**只放"与业务无关"的东西**：令牌、基础组件样式、主题。页面布局与数据
 *    仍然是各自 app 的事（daemon 那份管任务/智能体，远端那份管目录）。
 *
 * ──────────────────────────────────────────────────────────────────
 * 2026-11：组件层也进来了（第二个前端与 daemon 界面长得一样是"同一个产品"
 * 的一部分，不止"相似的风格"）——
 *   · `components/Modal.svelte`、`components/ConfirmDialog.svelte` —— 居中
 *     对话框与确认框（原来 daemon 界面一份、远端管理页又一份）；
 *   · `lib/confirm.ts` —— 命令式确认框状态（`askConfirm` / `pendingConfirm`）；
 *   · `lib/locale.ts` —— `createLocaleKit`：语言层的**形状**（store + t + tx +
 *     setLocale），文案表与持久化由各端传入（webText / remoteText 有意分开）；
 *   · `lib/time.ts` —— `createTimeKit`：相对/绝对时间的**逻辑**，文案函数注入。
 */
export {
  effectiveTheme,
  resolveTheme,
  setThemePref,
  themePref,
  type Theme,
  type ThemePref,
} from './theme.ts'

export { askConfirm, pendingConfirm, settleConfirm, type ConfirmRequest } from './lib/confirm.ts'
export {
  createLocaleKit,
  type LocaleKit,
  type LocaleKitOptions,
} from './lib/locale.ts'
export { createTimeKit, type TimeText } from './lib/time.ts'
