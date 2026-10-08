import type { TextCatalog } from '../text.ts'
import { agentsText } from './agents.ts'
import { chatText } from './chat.ts'
import { commonText } from './common.ts'
import { errorsText } from './errors.ts'
import { filesText } from './files.ts'
import { groupsText } from './groups.ts'
import { installText } from './install.ts'
import { newtaskText } from './newtask.ts'
import { runsText } from './runs.ts'
import { settingsText } from './settings.ts'
import { shellText } from './shell.ts'
import { skillsText } from './skills.ts'
import { tasksText } from './tasks.ts'
import { templatesText } from './templates.ts'
import { termsText } from './terms.ts'
import { toolsText } from './tools.ts'

/**
 * 界面文案总表。
 *
 * 分文件的依据是**代码结构**（一个区域一份）——看到 `agents.new` 就知道去
 * `Agents.svelte` / `NewAgentForm.svelte` 找调用点，改文案时不用全局搜中文。
 *
 * ⚠️ **合并时同名的键会静默覆盖**（对象展开的语义就是"后者赢"），而且**漏接
 *    一张表不会有任何报错**——症状只是那个区域的词条在界面上显示成键名
 *    （`tools.title`），人只会怀疑"是不是渲染错了"。这两件事各有一条测试守着，
 *    而且那两条测试**自己把 `web/` 目录扫一遍**（见 `i18n.test.ts`），所以
 *    这里的清单是唯一要改的地方：加一个 `web/xxx.ts` 就只加下面这一行。
 *
 * ⚠️ 这里**必须**是这种显式展开的写法，不能图省事写成
 *    `Object.assign({}, ...Object.values(someList))`：那样 `keyof` 会退化成
 *    `string`，于是 `$t('agents.typo')` 不再是编译错误、运行时也不报错，界面
 *    安静地显示成键名。这个坑试过——`i18n.test.ts` 里有一条反向断言钉住它
 *    （`WebTextId` 一旦变成 `string` 就编译失败）。
 */
export const webText = {
  ...commonText,
  // ★ 聊天：闭环的旁路（没有判决，因此也没有动作）
  ...chatText,
  ...shellText,
  ...tasksText,
  ...agentsText,
  // ★ D70：智能体组（执行 → 审核 → 行动 整链的默认配置）。
  ...groupsText,
  ...skillsText,
  ...installText,
  ...settingsText,
  ...templatesText,
  ...newtaskText,
  ...runsText,
  ...errorsText,
  ...filesText,
  ...termsText,
  // ★ D40：工具（列表 / 安装抽屉 / 智能体详情里的挂载 / 审核标准里可勾的工具动作）
  ...toolsText,
} as const satisfies TextCatalog

export type WebTextId = keyof typeof webText
