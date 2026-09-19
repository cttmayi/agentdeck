import { mount } from 'svelte'
import { DEFAULT_LOCALE, renderText, webText } from '@alpha-helper/i18n'
import App from './App.svelte'
import './styles/app.css'

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
