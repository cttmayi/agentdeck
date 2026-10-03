import { mount } from 'svelte'
import { DEFAULT_LOCALE, renderText, webText } from '@agentdeck/i18n'
import App from './App.svelte'
// ★ 设计系统现在住在共用包里（`@agentdeck/ui`）：**远端管理页与 daemon 界面用的是
//   同一份 CSS**（2026-10）。抽出去的理由很实际——"两个前端长得像"不能靠各抄一份
//   样式表，那种复制两天就会漂移，而漂移的表现是"同一个按钮在两页不一样高"这种
//   没人会去报的小差别，累积起来就是"不是同一个产品"。
import '@agentdeck/ui/styles/app.css'
// ⚠️ 主题（亮/暗/跟随系统）：import 即订阅生效——`data-theme` 由 index.html 里
//    那段同步脚本在首帧前打好，这里接手"偏好变化 / 系统变化"之后的实时切换。
import '@agentdeck/ui' // 主题：import 即订阅生效（判定与远端管理页共用同一份）

/**
 * 入口。
 *
 * Svelte 5 用 `mount()` 而不是 `new App({target})`——旧写法在 5.x 里已废弃。
 * `target` 由 index.html 里的 `#app` 提供。
 */
const target = document.getElementById('app')
/**
 * 挂载点没了，页面什么都渲染不出来——这句话**只能**用默认语言写。
 *
 * ⚠️ 为什么不是 `currentLocale()`：界面语言存在 workspace 上，要等身份接口回来
 *    （`setLocaleFromIdentity`）才装上，而那发生在 `mount()` **之后**——此刻
 *    store 里必然还是默认值。这里显式用 `DEFAULT_LOCALE`，是不假装"语言已经
 *    知道"：真按 `currentLocale()` 取，读到的也是同一个值，但读起来像在问一个
 *    还没加载的东西。
 *
 * ⚠️ 用 `renderText` 而不是把中文写死：词表以后改词（或加第三种语言）时，这句
 *    也在同一处，不会成为漏网之鱼。
 */
if (!target) throw new Error(renderText(webText, 'err.mountPointMissing', DEFAULT_LOCALE))

export default mount(App, { target })
