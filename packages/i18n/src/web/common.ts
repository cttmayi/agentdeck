import type { TextCatalog } from '../text.ts'

/**
 * 通用词：按钮、动作、以及会到处出现的短句。
 *
 * ⚠️ 只放**真正共用**的：同一个中文词在不同上下文里可能要译成不同的英文
 *    （"取消"在删除确认里是 Cancel，在"取消默认"里是 Unset）。硬凑共用键会让
 *    翻译在某一处别扭——宁可各写各的。
 */
export const commonText = {
  'common.save': { zh: '保存', en: 'Save' },
  'common.saving': { zh: '保存中…', en: 'Saving…' },
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'common.close': { zh: '关闭', en: 'Close' },
  'common.create': { zh: '创建', en: 'Create' },
  'common.creating': { zh: '创建中…', en: 'Creating…' },
  'common.refresh': { zh: '刷新', en: 'Refresh' },
  'common.edit': { zh: '编辑', en: 'Edit' },
  'common.delete': { zh: '删除', en: 'Delete' },
  'common.uninstall': { zh: '卸载', en: 'Uninstall' },
  'common.uninstalling': { zh: '卸载中…', en: 'Uninstalling…' },
  'common.preview': { zh: '预览', en: 'Preview' },
  'common.previewing': { zh: '预览中…', en: 'Rendering…' },
  'common.expand': { zh: '展开', en: 'Expand' },
  'common.collapse': { zh: '收起', en: 'Collapse' },
  'common.retry': { zh: '重试', en: 'Retry' },
  'common.required': { zh: '必需', en: 'Required' },
  'common.optional': { zh: '可选', en: 'Optional' },
  'common.no': { zh: '没有', en: 'No' },
  'common.yes': { zh: '是', en: 'Yes' },
  'common.none': { zh: '无', en: 'None' },
  'common.copy': { zh: '复制', en: 'Copy' },
  'common.copied': { zh: '已复制', en: 'Copied' },
  'common.loading': { zh: '加载中…', en: 'Loading…' },
  'common.showMore': { zh: '看完整日志', en: 'Full log' },
} as const satisfies TextCatalog
