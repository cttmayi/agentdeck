import { mount } from 'svelte'
import App from './App.svelte'
import './styles/app.css'

/**
 * 入口。
 *
 * Svelte 5 用 `mount()` 而不是 `new App({target})`——旧写法在 5.x 里已废弃。
 * `target` 由 index.html 里的 `#app` 提供。
 */
const target = document.getElementById('app')
if (!target) throw new Error('找不到 #app 挂载点——index.html 被改坏了')

export default mount(App, { target })
