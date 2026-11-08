import { createRequire } from 'node:module'
import { join } from 'node:path'
import { readJsonFile, writeJsonFile } from './paths.ts'
import type { VoiceLanguage } from './transcriber.ts'

/**
 * 语音的**选项**（不是词表——词表在 `vocab.json`，这一份是"怎么录、怎么出"）。
 *
 * ★ 分批第 277 批的几个默认值都是使用者定的：
 *   · 模型默认 `base-q5_1`（体积小的那档，快）；
 *   · 语言默认 `zh`，可选 `en` / `auto`；
 *   · 灵敏度三档**要界面**（外接麦/笔记本麦/嘈杂环境差别很大），默认"中"；
 *   · 输出默认直接回填输入框；另一种是"先发一条消息让 wiki-capture 处理"。
 *
 * ⚠️ 这份设置是**全局**的（与人定的词表同一个口径：口述是个人习惯，不跟 workspace 走）。
 *   将来真需要按 workspace 分开时，再在这份之上加一层覆盖（那时才加，不预留）。
 */

export type VoiceSensitivity = 'stable' | 'normal' | 'quick'
export type VoiceOutputMode = 'input' | 'via-skill'

export interface VoiceSettings {
  version: number
  /** 模型 id（`base-q5_1` / `small-q5_1` / `small`）。 */
  model: string
  language: VoiceLanguage
  sensitivity: VoiceSensitivity
  /** 是否开 denoise（decibri 的 fastenhancer）。默认关：它会削掉轻声。 */
  denoise: boolean
  /**
   * ★ 分批第 286 批：是否**从当前对话里抽标识符**辅助识别（默认开）。
   *   它只往 `initialPrompt` 里补词，不改写任何文本；关掉之后手动词表照旧生效。
   */
  useContextTerms: boolean
  outputMode: VoiceOutputMode
}

export const DEFAULT_SETTINGS: VoiceSettings = {
  version: 1,
  /**
   * ★ 分批第 293 批：默认模型改成 `small-q5_1`（实测比 base 明显准，见 `models.ts` 的
   *   `ASR_MODELS[0]` 那段）。⚠️ 只是**新装/没选过**时的默认——已经存过
   *   `settings.json` 的人不会被悄悄换掉（那是他自己选过的）。
   */
  model: 'small-q5_1',
  language: 'zh',
  sensitivity: 'normal',
  denoise: false,
  useContextTerms: true,
  outputMode: 'input',
}

/**
 * 灵敏度 → (Silero 阈值, 静音判定的 holdoff 毫秒)。
 *
 * ★ 为什么两件事绑在一起：它们是同一个旋钮的两面。"稳"= 不容易被噪声打断（阈值高、
 *   holdoff 长），代价是"我说完它还要等一会儿才停"；"快"= 反应快，代价是句中的停顿
 *   可能被当成句尾（说完"我、我觉…"就被切了）。让使用者只调一个档，比让他调两个
 *   互相影响的数字现实。
 */
export const SENSITIVITY: Record<VoiceSensitivity, { threshold: number; holdoffMs: number }> = {
  stable: { threshold: 0.6, holdoffMs: 1200 },
  normal: { threshold: 0.5, holdoffMs: 800 },
  quick: { threshold: 0.4, holdoffMs: 500 },
}

export function settingsPathOf(asrRoot: string): string {
  return join(asrRoot, 'settings.json')
}

const LANGUAGES: readonly VoiceLanguage[] = ['zh', 'en', 'auto']
const SENSITIVITIES: readonly VoiceSensitivity[] = ['stable', 'normal', 'quick']
const OUTPUT_MODES: readonly VoiceOutputMode[] = ['input', 'via-skill']

/**
 * 收拾一份设置：认不出来的字段一律回默认值（**不报错**）。
 *
 * ⚠️ 与词表不同：设置坏了没有"保留部分"的价值（模型 id 写错就让语音起不来），
 *   所以这里按字段退默认，并且**只在完全读不出来时**才当空。界面上永远有一个
 *   能用的值，好过一进设置页就红。
 */
export function normalizeSettings(raw: unknown, knownModels: readonly string[]): VoiceSettings {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const model = typeof obj['model'] === 'string' && knownModels.includes(obj['model'])
    ? obj['model']
    : DEFAULT_SETTINGS.model
  const language = LANGUAGES.includes(obj['language'] as VoiceLanguage)
    ? (obj['language'] as VoiceLanguage)
    : DEFAULT_SETTINGS.language
  const sensitivity = SENSITIVITIES.includes(obj['sensitivity'] as VoiceSensitivity)
    ? (obj['sensitivity'] as VoiceSensitivity)
    : DEFAULT_SETTINGS.sensitivity
  const outputMode = OUTPUT_MODES.includes(obj['outputMode'] as VoiceOutputMode)
    ? (obj['outputMode'] as VoiceOutputMode)
    : DEFAULT_SETTINGS.outputMode
  return {
    version: 1,
    model,
    language,
    sensitivity,
    denoise: obj['denoise'] === true,
    // 默认开：它是"提高识别率"的那一半，而关掉只需要一次点击
    useContextTerms: obj['useContextTerms'] !== false,
    outputMode,
  }
}

export async function readSettings(asrRoot: string, knownModels: readonly string[]): Promise<VoiceSettings> {
  const raw = await readJsonFile(settingsPathOf(asrRoot))
  return normalizeSettings(raw, knownModels)
}

export async function writeSettings(
  asrRoot: string,
  input: unknown,
  knownModels: readonly string[],
): Promise<VoiceSettings> {
  const normalized = normalizeSettings(input, knownModels)
  await writeJsonFile(settingsPathOf(asrRoot), normalized)
  return normalized
}
