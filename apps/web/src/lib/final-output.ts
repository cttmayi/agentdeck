/**
 * 判决块的显示层处理：把**机器读的那一段**从人读的正文里剥掉。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有这个函数
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者的原话：「在任务的细节显示中 审核 Agent 执行的最后结果 显示
 * `<<<ALPHA_VERDICT>>>` 不优美，建议解析后显示」。
 *
 * 那段围栏是**协议约定**（`packages/protocol/src/verdict.ts`）：判决是机器读的
 * JSON，平台按它校验、落库、驱动动作。任务详情里**已经**把它按结论 / 理由码 /
 * 证据 / 行动分项显示出来了（判决卡片）。所以「最后结果」那段正文里再摊一遍
 * 原始标记与 JSON，只是噪音——而且它看起来像"平台没处理"。
 *
 * ⚠️ 前端**不 import `@agentdeck/protocol`**（`api.ts` 顶部写着理由：前端类型是
 *    独立的视图形状）。所以这对标记、以及下面的扫描规则在这边是**抄的一份**。
 *    抄的东西会腐烂——`final-output.test.ts` 里有一条测试**读协议源码**把标记
 *    对上（与 `chat.ts` 的终态那一列同一个做法），协议改名时那条当场变红。
 *
 * ══════════════════════════════════════════════════════════════════
 * 两条刻意的规矩
 * ══════════════════════════════════════════════════════════════════
 *
 * **① 只剥「完整块」，半开的块留着。** 半开（有 BEGIN 没有 END）意味着这条判决
 *    本来就没被接受，而那段原文是使用者**唯一**能看到"它到底写了什么"的地方。
 *    替人把现场擦掉比难看更糟。而"从 BEGIN 一路猜到文末"属于在自由文本里猜边界，
 *    本项目不干这个（`extractVerdictJson` 的注释里写着同一条）。
 *
 * **② 剥的是「所有完整块」，不是「最后一个」。** 判决指令里自带一份示例围栏
 *    （`renderVerdictInstruction`），模型有可能把它回显出来。协议那边取**最后一个**
 *    当判决，显示这边把**完整块都剥掉**——两者不会各说各话：被采纳的那个判决，
 *    必然是这里剥掉的其中之一。
 */

/** 与协议一致的围栏标记（`final-output.test.ts` 读协议源码钉住）。 */
export const VERDICT_FENCE_BEGIN = '<<<ALPHA_VERDICT>>>'
export const VERDICT_FENCE_END = '<<<END_ALPHA_VERDICT>>>'

/**
 * 扫描**完整**判决块，产出它们在原文里的位置。
 *
 * 规则与协议里的 `extractVerdictJson` 逐条对齐：
 *   - 只认"先 BEGIN 再 END"的顺序（孤立的 END 不参与切分）；
 *   - 块的结束取"正确的 END"与"又一个 BEGIN"中**更早**出现的那个——
 *     真实发生过两次：模型内容完全合法，只是把结尾也写成了开头标记；
 *   - 两个都没有 ⇒ 半开块，到此为止（后面的内容不再参与扫描，与协议一致）。
 */
function* verdictBlockRanges(text: string): Generator<{ start: number; end: number }> {
  let searchFrom = 0
  for (;;) {
    const begin = text.indexOf(VERDICT_FENCE_BEGIN, searchFrom)
    if (begin === -1) return
    const bodyStart = begin + VERDICT_FENCE_BEGIN.length

    const endCorrect = text.indexOf(VERDICT_FENCE_END, bodyStart)
    const endRepeated = text.indexOf(VERDICT_FENCE_BEGIN, bodyStart)
    const end =
      endCorrect === -1
        ? endRepeated
        : endRepeated === -1
          ? endCorrect
          : Math.min(endCorrect, endRepeated)
    if (end === -1) return

    const endLen = end === endCorrect ? VERDICT_FENCE_END.length : VERDICT_FENCE_BEGIN.length
    yield { start: begin, end: end + endLen }
    searchFrom = end + endLen
  }
}

/**
 * 把判决块从正文里剥掉，只留下人该读的解释文字。
 *
 * 没有完整块时**原样返回**（一个字符都不动）：执行 run 的报告、聊天那一轮的话
 * 都不带围栏，这个函数对它们是恒等变换。
 */
export function stripVerdictBlocks(text: string): string {
  const ranges = [...verdictBlockRanges(text)]
  if (ranges.length === 0) return text

  let out = ''
  let cursor = 0
  for (const r of ranges) {
    out += text.slice(cursor, r.start)
    cursor = r.end
  }
  out += text.slice(cursor)

  // 块被拿掉之后常见的残留：连着好几个空行、或行尾留白。
  // ⚠️ 只在真的剥过块之后才收拾——没剥过就动原文，等于替使用者重排他写的字。
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 「最后结果」该显示哪段文字——**策略在这里**，模板只负责画。
 *
 * 抽成纯函数是因为这是一条**判断**，而 `apps/web` 没有组件级测试：写在模板里
 * 就只能靠手点界面验证（这个项目被这种"看起来对"的分支咬过好几次）。
 *
 * 策略只有两条：
 *   - `hasVerdict` ⇒ 剥掉判决块：那段是机器读的，平台已经按项显示在判决卡片里；
 *   - 否则 ⇒ **原样**。没有判决记录时（块半开、或块没通过校验），那段原文是
 *     使用者唯一能看到"它到底写了什么"的地方——替人擦掉现场比难看更糟。
 */
export function finalResultText(output: string, hasVerdict: boolean): string {
  if (output === '') return ''
  return hasVerdict ? stripVerdictBlocks(output) : output
}
