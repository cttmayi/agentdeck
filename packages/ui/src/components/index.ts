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
