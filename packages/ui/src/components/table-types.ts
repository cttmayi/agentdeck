/**
 * `Table.svelte` 的列定义——独立成 `.ts`，这样 `@agentdeck/ui/components` 的
 * 类型导出不依赖 `.svelte` 模块（node 测试 / `tsc` 的测试 tsconfig 不加载
 * `.svelte` 的命名导出）。
 */
export interface TableColumn {
  /** 表头文案。 */
  label: string
  /** 操作列这类没有可见表头的列：给读屏器一个名字（渲染成 `aria-label`）。 */
  ariaLabel?: string
}
