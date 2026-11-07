/**
 * 「识别完就自动发出去」的那点判断（分批第 281 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这里只是几个纯函数，而不是一堆 if
 * ══════════════════════════════════════════════════════════════════
 *
 * 自动发送是**代替人按回车**，所以它必须比人更小心。四条判断都是"到了那一步才想起来
 * 会出事"的那类，写成一处、能单测，比散在页面里靠人记着强：
 *
 *   ① 模式不是 `via-skill` ⇒ 不自动发（默认是"只回填"，那条路必须一直是默认）；
 *   ② 输入框里**原本有字** ⇒ 不自动发：那份字是人写的，自动发送会把他的话一起送出去
 *      （他会以为只发了刚说的那一句）；
 *   ③ 这一轮还在跑 ⇒ 不自动发（框架本来就不让连发，硬发只会静默丢掉）；
 *   ④ 识别出来是空的 ⇒ 没什么可发。
 *
 * ⚠️ **3 秒倒计时**是这件事的安全带：自动发送前留一个能看见、能按停的窗口。
 *   没有它，一次识别错误就直接进了对话（甚至可能被上层 skill 记进 wiki）。
 */

export type VoiceOutputMode = 'input' | 'via-skill'

export interface AutoSendContext {
  mode: VoiceOutputMode
  /** 这次口述之前输入框是空的吗（空 = 只有这一句刚识别的字）。 */
  composerWasEmpty: boolean
  /** 这一轮是否还在跑。 */
  turnRunning: boolean
  /** 识别出来的文本。 */
  text: string
}

/** 该不该**安排**一次自动发送（安排之后还有 3 秒可撤销）。 */
export function shouldAutoSend(ctx: AutoSendContext): boolean {
  if (ctx.mode !== 'via-skill') return false
  if (ctx.text.trim() === '') return false
  if (ctx.turnRunning) return false
  if (!ctx.composerWasEmpty) return false
  return true
}

/** 倒计时秒数。改它要同时改文案里的数字（`chat.voiceAutoSendPending`）。 */
export const AUTO_SEND_SECONDS = 3

/**
 * 撤销之后应该留下什么。
 *
 * ★ 一个字都不丢：撤销只是"别自动发"，那段识别结果仍然在输入框里，人可以改完自己发。
 *   把字一起清掉是最糟的做法——他会以为识别失败了，得再说一遍。
 */
export function afterUndo(text: string): { input: string; hint: string } {
  return { input: text, hint: 'cancelled' }
}
