import { writable } from 'svelte/store'

/**
 * 语音能力的**共享状态**（分批第 284 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要这一层：一个真实的、让人困惑的报错
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者报的："small 提示已经下载好了吗，录制的时候还是提示『还没有语音模型 small』，
 * 重新刷新后正常。"
 *
 * 根因是**两处各自缓存**：
 *   · 「语音输入」设置里下载完模型之后，**它自己**重新查了一次能力（所以那里显示"可以用"）；
 *   · 而输入条上那颗麦克风按钮**只在页面挂载时**查过一次，之后一直用那份旧结论
 *     ⇒ 点下去还在说"还没有语音模型"，直到整页刷新。
 *
 * 两处各自持有一份判断，就必然会出现"一边说好、一边说没有"。
 * 所以收成一份 store：谁查到了（或谁让它变了，比如下载完成）都写这里，两边都读它。
 *
 * ★ 另一条同样重要：**点的时候再查一次**（见 `VoiceButton.start()`）。能力是会变的
 *   （刚下完模型、刚删了文件、刚插了麦克风），而"点一下"正是最该拿最新事实的时刻。
 */

export interface VoiceModelState {
  id: string
  path: string
  present: boolean
  looksValid: boolean
  approxMb: number
}

export interface VoiceCapabilityView {
  available: boolean
  reason: string
  platformLabel: string | null
  model: VoiceModelState
  mic: 'unknown' | 'ok' | 'denied' | 'error'
  paths: { asrRoot: string; models: string }
}

/** 最近一次查到的能力（null = 还没查过）。 */
export const voiceCapability = writable<VoiceCapabilityView | null>(null)

/** 正在查（防连点重复请求；也让界面能区分"还没查"与"在查"）。 */
let inflight: Promise<VoiceCapabilityView | null> | null = null

/**
 * 重新查一次能力并写进 store。
 *
 * ⚠️ 失败时**不**把 store 清成 null：保留上一次的结论，比让界面忽然变"不知道"更有用
 *   （真要用的时候 `VoiceButton.start()` 会再查一次，那一次失败会带出具体原因）。
 */
export async function refreshVoiceCapability(): Promise<VoiceCapabilityView | null> {
  if (inflight !== null) return inflight
  inflight = (async () => {
    try {
      const res = await fetch('/api/voice/capability')
      if (!res.ok) return null
      const cap = (await res.json()) as VoiceCapabilityView
      voiceCapability.set(cap)
      return cap
    } catch {
      return null
    } finally {
      inflight = null
    }
  })()
  return inflight
}
