import type { WebTextId } from '@agentdeck/i18n'
import type { BoundParamSpec, OpenParamSpec, Tool, ToolActionSpec } from './api.ts'

/**
 * 工具的**展示层纯函数**（D40）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这些不放组件里
 * ══════════════════════════════════════════════════════════════════
 *
 * "一个动作该显示成什么样"这件事有**判据**：动作名是契约值（`<slug>.<name>`，
 * 判决里写的就是它），`reversible: false` 必须显式标"不可回滚"，`dryRun:
 * 'unsupported'` 必须显式标"不支持预演"。散在标记里写 `{#if}` 的话，改一处
 * 漏一处是迟早的事——而漏掉的那一处**看起来完全正常**（动作还是列出来了，
 * 只是少了那条警告）。
 *
 * ⚠️ 这里**只产出文案键 + 插值**，不产出中文句子：库层不知道当前界面语言
 *    （D39），渲染交给界面用 `$t(...)` 做。与 `skill-install.ts` 同一条规矩。
 *
 * ⚠️ 与 `packages/protocol/src/tools.ts` 的 `toolActionType()` **同形**。不 import
 *    它（网页不 import protocol，理由见 `api.ts` 里那段），但两边算的是同一个
 *    字符串——契约值错一个字符，判决里那个动作就永远找不到。
 */

/** 一段待渲染的文案：键 + 插值。 */
export interface TextMessage {
  id: WebTextId
  params?: Readonly<Record<string, string | number>>
}

/** 完整动作名：`<包 slug>.<动作名>`（契约值，不翻译）。 */
export function actionTypeOf(tool: Pick<Tool, 'slug'>, action: Pick<ToolActionSpec, 'name'>): string {
  return `${tool.slug}.${action.name}`
}

/** 组内动作清单：带上各自的**完整动作名**（界面显示的就是这个）。 */
export function actionsOf(tool: Tool): Array<{ type: string; action: ToolActionSpec }> {
  return (tool.manifest?.actions ?? []).map((action) => ({
    type: actionTypeOf(tool, action),
    action,
  }))
}

/** 组里有多少个动作（列表里那一列）。 */
export function actionCountOf(tool: Tool): number {
  return tool.manifest?.actions?.length ?? 0
}

/**
 * **所有已装工具包一共声明了多少个动作**。
 *
 * ★ 它是一个**共享的分母**，所以只写这一遍：`ActionPicker` 的状态条（"已允许
 *   1/5"）与新建任务 ③ 那颗按钮旁边的计数（"已允许 1 / 5 个动作"）说的是同一个
 *   比值——两处各算一遍的话，两边会在"装了什么包"变化时分叉，而那种分叉的表现
 *   是**同一屏上两个不同的总数**，看起来像其中一个坏了。
 *
 * ⚠️ 分母是**装进来的动作总数**，不是"这个审核者当前允许的那几个"（那是分子那
 *    一档的事）。实测踩过：拿 `chain.actions.length` 当分母，勾第二个动作之后
 *    界面上写着"已允许 2 / 1 个动作"。
 */
export function installedActionCount(tools: readonly Tool[]): number {
  return tools.reduce((sum, tool) => sum + actionCountOf(tool), 0)
}
/** 绑定参数：名称 + "这个值从哪来"。 */
export function boundParams(action: ToolActionSpec): Array<{ name: string; label: TextMessage }> {
  return Object.entries(action.params?.bound ?? {}).map(([name, spec]) => ({
    name,
    label: boundLabel(spec),
  }))
}

function boundLabel(spec: BoundParamSpec): TextMessage {
  // `literal` 与其它来源分成两条词条：一条说"固定值 X"，一条说"来自 X"。
  // 合成一条（"来自 {value}"）会在 `from: 'workdir'` 时读成"来自 工作目录"，
  // 看着像中文翻译，其实那一格是**契约值**。
  return spec.from === 'literal'
    ? { id: 'tools.paramBoundLiteral', params: { value: String(spec.value ?? '') } }
    : { id: 'tools.paramBoundFrom', params: { from: spec.from } }
}

/** 开放参数：名称 + 类型与上限 + 是否必需。 */
export function openParams(action: ToolActionSpec): Array<{
  name: string
  label: TextMessage
  required: boolean
  /** 参数类型（固定参数编辑器按它选控件）。 */
  kind: 'string' | 'integer' | 'boolean' | 'enum'
  /** 枚举的可选值（契约值，原样显示）；其余类型是空数组。 */
  values: string[]
}> {
  return Object.entries(action.params?.open ?? {}).map(([name, spec]) => ({
    name,
    label: openLabel(spec),
    required: spec.required !== false,
    kind: spec.type,
    values: spec.type === 'enum' ? spec.values : [],
  }))
}

function openLabel(spec: OpenParamSpec): TextMessage {
  switch (spec.type) {
    case 'string':
      return { id: 'tools.paramTypeString', params: { max: spec.max } }
    case 'integer':
      return { id: 'tools.paramTypeInteger', params: { min: spec.min, max: spec.max } }
    case 'boolean':
      return { id: 'tools.paramTypeBoolean' }
    case 'enum':
      // 值域本身（`a` / `b`）是契约值，由界面用 `<code>` 逐个显示——
      // 塞进插值里的话，英文界面会拿到一串用中文顿号连起来的枚举值。
      return { id: 'tools.paramTypeEnum' }
  }
}

/**
 * 一个工具包**装进来了什么**（安装结果里那一段）。
 *
 * ★ `files` 里不含 `tool.json` / `TOOL.md`（协议那边就只收"除这两个之外"的文件），
 *   所以清单与说明各自单独提一句，否则"装进来了什么"会漏掉最要紧的那两个。
 */
export function includedPaths(tool: Tool): string[] {
  const paths = Object.keys(tool.files ?? {}).sort()
  return paths
}
