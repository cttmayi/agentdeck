/**
 * 识别文本的整理（第一层之后、词典替换之前）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要一个独立的小模块
 * ══════════════════════════════════════════════════════════════════
 *
 * whisper 的输出是**分段时间戳 + 每段自带前导空格**的片段（`["00:00:00,000",
 * "00:00:02,500", " 我们来讨论一下"]`）。直接把它们拼起来会得到：
 *
 *   "  我们来讨论一下 。 语音方案"
 *
 * ——句首多空格、中文标点前多一个空格、句子被时间戳切成两截。这些不是"美观问题"：
 * 它是**要送进聊天输入框**的文本，人多半会直接发出去；而 `wiki-capture` 之类上层
 * skill 也会按标点与空格切分内容。所以这一步必须在**替换规则之前**做完：先给规则
 * 一个干净的输入，规则才好写（否则每条规则都得考虑"前后可能有个空格"）。
 *
 * ⚠️ 纪律：这一步只做**可逆的排版**（空格、全半角边角），**不改词**。任何一个
 *   改动词的规则都必须住在词典层，因为那一层会回显（`corrections`）——把改写藏进
 *   "排版"里，就等于绕过回显。
 */

/**
 * 把 whisper 的分段拼成一段文字。
 *
 * 每段自带前导空格（英文需要它，中文不需要），所以先按段拼、再统一收拾。
 *
 * ⚠️ 两种形状都认：包 0.2.12 实际返回 `{start, end, text}`，而它的 README 写的是
 *   三元组 `[start, end, text]`。第一版只按 README 取 `seg[2]` ⇒ 真机上拿到
 *   `undefined`、整段变空（直接调包能看到正确文本，所以这个缺陷藏得很深）。
 *   现在对象优先、三元组兜底——**文档与实现不一致时，两种都接受**比猜一边安全。
 */
export function joinSegments(
  segments: readonly (TranscriptSegment | readonly [string, string, string])[],
): string {
  return segments
    .map((seg) => {
      if (Array.isArray(seg)) return (seg[2] as string | undefined) ?? ''
      return (seg as TranscriptSegment).text ?? ''
    })
    .join('')
}

/** 分段（与 `transcriber.ts` 的 `TranscriptSegment` 同一件事；这里不 import 以免循环）。 */
interface TranscriptSegment {
  start: string
  end: string
  text: string
}

/** 中文/中文标点：用来判断"这个空格该不该留"。 */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/
const CJK_PUNCT_BEFORE = /([\u3001-\u303f\uff01\uff09\uff0c\uff0e\uff1a\uff1b\uff1f])\s+/g
const CJK_PUNCT_AFTER = /\s+([\u3001-\u303f\uff01\uff09\uff0c\uff0e\uff1a\uff1b\uff1f])/g

/**
 * 收拾排版：合并多空格、去掉中文标点前后的空格、去掉中文字之间的空格、修剪首尾。
 *
 * ★ 只做这几件，别加"智能"变换：
 *   · 不补句号（人说没说完只有人知道；补上去会让"下一句接着说"变得别扭）；
 *   · 不删重复的字（那是模型的错，要留给人看见）；
 *   · 不做繁简转换（改词就得回显）。
 */
export function normalizeText(input: string): string {
  let text = input.replace(/\r\n?/g, '\n')
  // 0x00 之类的控制字符：麦克风断流时偶尔会漏进来，进输入框就是脏字符
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  text = text.replace(/[ \t]{2,}/g, ' ')
  text = text.replace(CJK_PUNCT_AFTER, '$1')
  text = text.replace(CJK_PUNCT_BEFORE, '$1')
  // 中文字之间被模型插了空格（"你 好"）——中文不写空格，去掉它
  text = text.replace(/(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '')
  // 中英文交界留一个空格（"用 pnpm 跑测试"读起来才对）
  text = text.replace(/(?<=[\u4e00-\u9fff])[ \t]*(?=[A-Za-z0-9])/g, ' ')
  text = text.replace(/(?<=[A-Za-z0-9])[ \t]*(?=[\u4e00-\u9fff])/g, ' ')
  return text.replace(/^[ \t\n]+|[ \t\n]+$/g, '')
}

/** 这段文本里有没有"真的说话"（全空白 / 全是标点 ⇒ 没有）。 */
export function hasSpeechContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
}

/** 判断一个字符是不是中日韩文字（导出给调用方做"英文/中文"提示用）。 */
export function isCjk(char: string): boolean {
  return CJK.test(char)
}
