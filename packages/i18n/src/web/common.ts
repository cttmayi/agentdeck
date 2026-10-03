import type { TextCatalog } from '../text.ts'

/**
 * 通用词：按钮、动作、以及会到处出现的短句。
 *
 * ⚠️ 只放**真正共用**的：同一个中文词在不同上下文里可能要译成不同的英文
 *    （"取消"在删除确认里是 Cancel，在"取消默认"里是 Unset）。硬凑共用键会让
 *    翻译在某一处别扭——宁可各写各的。
 *
 * ⚠️ 也**只放有人在用的**：这张表原来还铺了「删除 / 展开 / 重试 / 可选 / 是 / 否 /
 *    无 / 复制 / 已复制 / 加载中…」这些"以后总要用"的词，结果是**一条都没人用**，
 *    而各区域又各自写了一份同形的（D39 收尾时按"同一句话只有一个出处"收拢回来）。
 *    一张大部分没人用的共享词表比没有更糟：它会让人以为"这个词已经有人管了"。
 *    需要新词时再加一行，成本就是一行。
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
  'common.uninstall': { zh: '卸载', en: 'Uninstall' },
  'common.uninstalling': { zh: '卸载中…', en: 'Uninstalling…' },
  'common.preview': { zh: '预览', en: 'Preview' },
  'common.previewing': { zh: '预览中…', en: 'Rendering…' },
  'common.collapse': { zh: '收起', en: 'Collapse' },
  'common.required': { zh: '必需', en: 'Required' },
  /** 「这一项没有版本号」——技能与工具两页同用（原来是 `tools.versionNone` 独有）。 */
  'common.noVersion': { zh: '无版本', en: 'No version' },
  /** 按钮置灰时的通用解释：**上一次操作还没结束**（项目纪律：置灰必须写清为什么）。 */
  /** 相对时间的四档（`lib/time.ts` 用；列表一律用它，准确时间放 `title`）。 */
  'common.justNow': { zh: '刚刚', en: 'just now' },
  'common.minutesAgo': { zh: '{count} 分钟前', en: '{count} min ago' },
  'common.hoursAgo': { zh: '{count} 小时前', en: '{count} h ago' },
  'common.daysAgo': { zh: '{count} 天前', en: '{count} d ago' },
  'common.busyHint': { zh: '上一次操作还没结束，稍等一下', en: 'The previous action has not finished yet — one moment' },
} as const satisfies TextCatalog
