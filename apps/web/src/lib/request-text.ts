/**
 * 「要做什么」那一个多行框，怎么切成一条记录。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么切分在平台这边，而不是让使用者填两个框
 * ══════════════════════════════════════════════════════════════════
 *
 * 原来是两个字段：「要做什么」（单行 `input`）+「补充说明（可选）」（textarea）。
 * 两件事都不对：
 *
 *   ① 单行框装不下真正要说的东西——按回车就提交了，写得长一点只能横着滚；
 *   ② "标题 + 补充说明"是**记录格式**的分法，不是使用者的分法。他要说的是
 *      "帮我做这件事"，至于哪半句算标题是平台的事。摆成两个框等于让他先做一次
 *      分类，而**分错了没有任何提示**（把整段话填进单行框是合法的，只是难看）。
 *
 * 现在只有一个多行框，切分在这里做。规矩只有一条：**第一行当标题**。
 * 为什么是"第一行"而不是"第一句"、不是"前 80 个字"——因为它是使用者**能控制**
 * 的：想换标题就按一下回车。按句子切、按字数切都是看不见的启发式，猜错了
 * 他没法改（唯一能做的就是把整段话重写一遍）。
 *
 * ⚠️ 切分只影响**记录里怎么存**（`Issue.title` / `Issue.description`）。
 *    发给 agent 的 `prompt` 是**全文、不切**——执行者要看到使用者写的每一个字。
 *    这一点很要紧：如果哪天有人图省事把 prompt 也按这里切了，"第二行之后的
 *    要求 agent 看不到"会是一个**静默**的错（任务照样跑、判决照样出）。
 */

/**
 * `Issue.title` 的上限（协议里 `z.string().min(1).max(500)`）。
 *
 * ⚠️ 超了不是"标题难看"而是**整条创建请求被拒**（400），使用者的那一段话就白
 *    写了。所以这里必须截断——而且截断只影响标题，全文照旧进 `description`
 *    与 `prompt`（一个字都不丢）。
 */
export const ISSUE_TITLE_MAX = 500

export interface SplitRequest {
  /** 存进 `Issue.title` 的那一行（任务清单里显示的就是它）。 */
  issueTitle: string
  /** 第一行之后的全部内容（可能为空串）。 */
  issueDescription: string
}

/**
 * 把一段多行文本切成"标题 + 其余"。
 *
 * 规矩：
 *   · 标题 = **第一个非空行**（前面空几行不算，那通常只是顺手按了一下回车）；
 *   · 其余 = 那一行**之后**的全部内容（原样保留换行，只去掉首尾空白）；
 *   · 标题超过 `ISSUE_TITLE_MAX` ⇒ 截断（**只截标题**，其余一个字不丢）。
 *
 * ⚠️ 返回值**不保证非空**：`splitRequest('   ')` 给的是两个空串。调用方（提交
 *    按钮的 `disabled`）已经挡掉了空提交，这里不做二次判断——在一个纯函数里
 *    编一个"其实不会发生"的分支，只会让人以为它会发生。
 */
export function splitRequest(text: string): SplitRequest {
  const lines = text.split('\n')
  const titleIndex = lines.findIndex((line) => line.trim() !== '')
  // 全是空白：调用方挡过了，这里给一个形状正确的空结果（见上面那条注释）
  if (titleIndex === -1) return { issueTitle: '', issueDescription: '' }

  const firstLine = lines[titleIndex]!.trim()
  return {
    issueTitle: firstLine.slice(0, ISSUE_TITLE_MAX),
    issueDescription: lines
      .slice(titleIndex + 1)
      .join('\n')
      .trim(),
  }
}
