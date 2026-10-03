import type { TextCatalog } from '../text.ts'

/**
 * 远端管理页的通用词。
 *
 * ⚠️ 与 `web/common.ts` **分开**，不是重复：这是另一个前端（跑在 4518 上的远端
 *    服务），它的词条集合与 daemon 界面不同。同形的短词（"关闭"）各自写一份是有意的
 *    ——两个界面的翻译可以各自演进，硬凑共用键会让某一处别扭（见 `web/common.ts`
 *    那段同样的说明）。
 */
export const remoteCommonText = {
  'remote.loading': { zh: '正在读取…', en: 'Loading…' },
  'remote.error': { zh: '取不到数据：{error}', en: 'Could not load: {error}' },
  'remote.retry': { zh: '重试', en: 'Retry' },
  'remote.close': { zh: '关闭', en: 'Close' },
  'remote.cancel': { zh: '取消', en: 'Cancel' },
  'remote.noVersion': { zh: '无版本号', en: 'no version' },
  'remote.language': { zh: '语言', en: 'Language' },
  'remote.theme': { zh: '主题', en: 'Theme' },
  'remote.themeLight': { zh: '亮色', en: 'Light' },
  'remote.themeDark': { zh: '暗色', en: 'Dark' },
  'remote.themeSystem': { zh: '跟随系统', en: 'System' },
  // 相对时间（与 daemon 界面同形；2026-11 远端管理页换用共用的
  // `@agentdeck/ui` 时间工厂后，需要自己的这份文案）
  'remote.justNow': { zh: '刚刚', en: 'just now' },
  'remote.minutesAgo': { zh: '{count} 分钟前', en: '{count} min ago' },
  'remote.hoursAgo': { zh: '{count} 小时前', en: '{count} h ago' },
  'remote.daysAgo': { zh: '{count} 天前', en: '{count} d ago' },
} as const satisfies TextCatalog
