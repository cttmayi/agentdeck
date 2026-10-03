import type { TextCatalog } from '../text.ts'

/** 远端管理页的外壳：标题、导航、页脚说明。 */
export const remoteShellText = {
  'remote.title': { zh: '远端控制台', en: 'Remote console' },
  'remote.subtitle': {
    zh: 'agentdeck 远端服务的公共目录：技能与工具',
    en: 'The agentdeck remote service catalog: skills and tools',
  },
  'remote.navSkills': { zh: '技能', en: 'Skills' },
  'remote.navTools': { zh: '工具', en: 'Tools' },
  // ⚠️ 这两句在 D52 之后**改过**：这一页不再是只读的（多了手动装 / 卸）。
  //    原来那句"只读"留在这里就是一句假话——文案必须跟着实现走。
  'remote.servedBy': {
    zh: '这一页由远端服务托管（默认 http://127.0.0.1:4518）。',
    en: 'This page is served by the remote service (default http://127.0.0.1:4518).',
  },
  'remote.whereToInstall': {
    zh: '这一页管的是远端目录（推荐清单 + 手动装的）。要装进你自己本机的技能库，去 daemon 界面（「技能」页 →「安装技能」）。',
    en: 'This page manages the remote catalog (recommended list + manual installs). To install into your own machine\'s skill library, use the daemon UI (Skills page → Install).',
  },
} as const satisfies TextCatalog
