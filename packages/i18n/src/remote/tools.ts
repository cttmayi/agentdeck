import type { TextCatalog } from '../text.ts'

/** 远端管理页：工具包目录。 */
export const remoteToolsText = {
  'remote.toolsTitle': { zh: '工具包（公共目录）', en: 'Tool packages (public catalog)' },
  'remote.toolsCount': { zh: '共 {count} 个包', en: '{count} packages' },
  'remote.toolsEmpty': {
    zh: '目录里现在没有工具包。',
    en: 'No tool packages in the catalog right now.',
  },
  'remote.colPackage': { zh: '工具包', en: 'Package' },
  'remote.colActions': { zh: '声明的动作', en: 'Declared actions' },
  // ⚠️ 「版本」那一列用 `remote.colVersion`——它已经在 `skills.ts` 里定义过了。
  //    这里再写一份就是**重名键**：对象展开时后者赢，先来的那条**静默消失**
  //    （`i18n.test.ts` 的"合并后少了 N 条"正是抓这个的，加这张表时当场就红了）。
  'remote.toolManifest': { zh: '清单（{file}）', en: 'Manifest ({file})' },
  'remote.toolDocs': { zh: '说明（{file}）', en: 'Docs ({file})' },
  'remote.toolEntryFound': { zh: '入口脚本在包里', en: 'Entry script is bundled' },
  'remote.toolEntryMissing': { zh: '入口脚本不在包里：{entry}', en: 'Entry script missing: {entry}' },
  'remote.toolsFromRepo': {
    zh: '工具包是仓库里的文件（apps/remote/catalog/tools/），改它要提交改动——工具包这一块只读（技能那块能在页面上装 / 卸）。',
    en: 'Tool packages are files in the repo (apps/remote/catalog/tools/); changing them is a commit — this section is read-only (skills can be installed/removed on this page).',
  },
} as const satisfies TextCatalog
