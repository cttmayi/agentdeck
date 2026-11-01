/**
 * `@agentdeck/ui` 的 Svelte 组件（独立子路径）。
 *
 * ⚠️ 与主入口分开是刻意的：主入口（`@agentdeck/ui`）只放**纯 TS**（theme /
 * confirm / locale / time），node 测试直接 import 它没有问题；`.svelte` 组件
 * 在这里，只有 Svelte 应用才 import（`@agentdeck/ui/components`）。
 */
export { default as Modal } from './Modal.svelte'
export { default as ConfirmDialog } from './ConfirmDialog.svelte'
export { default as Table } from './Table.svelte'
export type { TableColumn } from './table-types.ts'
export { default as ExpandToggle } from './ExpandToggle.svelte'
export { default as SourceRef } from './SourceRef.svelte'
export { default as FoldSection } from './FoldSection.svelte'
/**
 * ★ 分批第 194 批：一条对话消息（`说的人 + 气泡`）。
 *
 * 聊天页与沉淀页**共用这一份**——沉淀线的中间栏原来是第三套形状（`.qa-msg` / 抽屉分节），
 * 于是同一个"对话"在两页里长得不一样，使用者连提了两次「应该像聊天那页的对话方式」。
 */
export { default as ChatBubble } from './ChatBubble.svelte'
/**
 * ★ 分批第 197 批：栏脚的**折叠清单**与**输入条**（聊天页与沉淀页共用）。
 * 使用者："材料现在在右栏，我想用类似聊天页一样，将工作目录放在「发送」的上方……
 * 关于「发送」一起，用相同的控件，不然不一致。"
 */
export { default as FootFiles } from './FootFiles.svelte'
export { default as ChatComposer } from './ChatComposer.svelte'
