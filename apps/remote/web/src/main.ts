import { mount } from 'svelte'
// ★ 与 daemon 界面**同一份**设计系统（`@agentdeck/ui`）：令牌、基础组件样式、
//   表格/抽屉/提示条……两页长得像靠的是这个，而不是各抄一份样式表。
import '@agentdeck/ui/styles/app.css'
// 主题（亮/暗/跟随系统）：import 即订阅生效，`data-theme` 打在 <html> 上
import '@agentdeck/ui'
import App from './App.svelte'

const target = document.getElementById('app')
if (!target) throw new Error('找不到 #app 节点（index.html 里应当有）')

mount(App, { target })
