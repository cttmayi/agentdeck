/**
 * 造一个"运行时带 `undefined` 的 patch"。
 *
 * 这不是硬凑的用例，而是真实事故的形状：patch 在调用点常常是**拼出来的**
 * ——把可选字段直接塞进对象字面量。那时类型上写的是 `string | null`，运行时
 * 却可能是 `undefined`。`exactOptionalPropertyTypes` 管不住这种对象（它只管
 * 字面量直写），于是 `{ ...当前值, ...patch }` 会把已存的值覆盖成 undefined。
 * 文件适配器的 `pruneUndefined` 就是为这个而存在的，这一层薄封装让测试能
 * 造出同样的运行时值。
 */
export function loosePatch<T>(patch: Record<string, unknown>): T {
  return patch as T
}
