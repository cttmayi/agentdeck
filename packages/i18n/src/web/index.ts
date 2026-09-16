import type { TextCatalog } from '../text.ts'
import { commonText } from './common.ts'
import { shellText } from './shell.ts'

/**
 * 界面文案总表。
 *
 * ⚠️ **合并时会静默覆盖**（对象展开的语义就是"后者赢"），所以有一条测试专门
 *    检查"合并后的键数 == 各表键数之和"——重名的键会让一条词条凭空消失，
 *    而症状是"某个地方显示成键名"，很难联想到是重名。
 */
export const webText = {
  ...commonText,
  ...shellText,
} as const satisfies TextCatalog

export type WebTextId = keyof typeof webText
