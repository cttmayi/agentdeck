import type { TextCatalog } from '../text.ts'
import { remoteCommonText } from './common.ts'
import { remoteShellText } from './shell.ts'
import { remoteSkillsText } from './skills.ts'
import { remoteToolsText } from './tools.ts'

/**
 * 远端管理页的文案总表（2026-10）。
 *
 * 与 `web/index.ts` 完全同一套约定与同一套守卫（`i18n.test.ts` 会把 `remote/`
 * 也扫一遍：zh/en 齐不齐、占位符一不一致、有没有漏接的表、有没有 markdown 强调号）。
 * 合并**必须**写成显式展开——理由见 `web/index.ts` 里那段（`keyof` 退化成
 * `string` 之后 `$t('remote.typo')` 就不再是编译错误）。
 */
export const remoteText = {
  ...remoteCommonText,
  ...remoteShellText,
  ...remoteSkillsText,
  ...remoteToolsText,
} as const satisfies TextCatalog

export type RemoteTextId = keyof typeof remoteText
