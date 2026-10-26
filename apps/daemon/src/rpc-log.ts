/**
 * 「发给 CLI 的内容是不是我日志里看到的那一份」——分批第 44 批。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要这个函数（使用者报的原话）
 * ══════════════════════════════════════════════════════════════════
 *
 * 「我在日志中有看到『命令行：/opt/homebrew/bin/codex app-server --stdio』，
 *   后面应该有发给它的命令，没有打印出来」。
 *
 * cli 形状（claude / generic）把第一句话拼在 argv 里，"命令行"那一行顺手把内容
 * 也显示了；service 形状（codex）的内容在 JSON-RPC 帧里，日志里一个字节都没有。
 *
 * 补日志有两条路，这里选了第二条：
 *
 *   ① 把 `turn/start` 的 input 原文**再打印一遍** —— 直白，但同一段几十 KB 的
 *      第一句话会在日志里出现两次，"哪一份是真的"立刻变成新的误解源。
 *   ② **逐字比对**：拿帧里真的发出去的那段 `sentText` 与日志里已经记下的
 *      "第一句话 user 部分"比。一致就一行话说清；**不一致才把原文打出来**
 *      （那才是异常现场，也正是必须看见全文的时候）。
 *
 * 这就是本函数的全部逻辑。它的价值在于把"日志"与"线上"钉在一起：
 * 以后任何一次"我明明写了它却没照做"的争论，都可以先看这一行。
 */

export interface SentTextVerdict {
  /** 发出去的与日志里记的**逐字相同**。 */
  identical: boolean
  /** 要进日志的那一行结论。 */
  headline: string
  /** 不一致时的原文（一致时为 undefined：不重复打印）。 */
  body?: string
}

/**
 * 比对"帧里真的发出去的文本"与"日志里记下的第一句话（user 部分）"。
 *
 * @param declared 日志里记下的那份（executor 的 `delivery.user`；A 档是 ③ 那一块）
 * @param sent 帧里真的发出去的那份（`turn/start` 的 input[0].text）
 */
export function verifySentText(declared: string, sent: string): SentTextVerdict {
  if (declared === sent) {
    return {
      identical: true,
      headline:
        `✓ 发给 CLI 的内容 = 上面「第一句话」的 user 部分（逐字相同，${String(sent.length)} 字符）` +
        '——这一行是把"日志里读到的"与"CLI 真收到的"钉在一起的那颗钉子',
    }
  }
  /**
   * 不一致 ⇒ **把原文打出来**。
   *
   * 这时不能只说"不一致"：使用者接下来要判断的是"哪一份才是它真收到的"，
   * 而答案只能是 sent（那是线上那一份）。所以正文必须是 sent，而不是 declared。
   */
  const firstDiff = (() => {
    const max = Math.min(declared.length, sent.length)
    for (let i = 0; i < max; i += 1) if (declared[i] !== sent[i]) return i
    return max
  })()
  return {
    identical: false,
    headline:
      `⚠️ 发给 CLI 的内容与上面「第一句话」**不一致**（日志 ${String(declared.length)} 字符 / ` +
      `线上 ${String(sent.length)} 字符，第 ${String(firstDiff + 1)} 个字符起不同）` +
      '——下面这一份是**真的送出去**的原文：',
    body: sent,
  }
}
