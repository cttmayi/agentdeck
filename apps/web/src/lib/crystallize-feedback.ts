/**
 * 把审核判决的条目整理成**一段可以直接发给起草者**的话（分批第 12 批）。
 *
 * 使用者原话：「审核不过后，是否可以将"审核问题清单"直接填入"按意见重新起草"的框中，
 * 让用户点反馈」。查下来当时的实现做错了两件事，都在这个文件负责的那一段里：
 *
 *   ① 点了「按意见重新起草」**直接就提交了**（`await reviseDraft()`）——人根本没机会看一眼
 *      自己要发出去的是什么，更别说改。既然"按意见改一版"是人拍板的动作，就该让人**先看到、
 *      再点**。现在这里只负责"填"，提交永远由人点。
 *   ② 填进去的只有 `[严重度] 一句话`，**位置与原文都丢了**。而这一批（第 10 批）刚刚把
 *      返工改成"基于上一版改"——起草者要照它改，就必须知道**改哪一行**、**那一行现在写的是什么**。
 *      只有结论没有位置的清单，起草者只能自己猜，而猜错的表现是"改完了问题还在"。
 *
 * ⚠️ 形状必须与 daemon 那份（`server.ts` 的 `draftReviewFeedback`）**一致**：两份文本都会落到
 *    同一个 `material/feedback.md` 里给同一个起草者看（一份来自自动返工、一份来自人点的这条）。
 *    两处形状不同的表现是"自动改的那版和我说要改的那版，起草者读到的东西不一样"。
 *    差别只有标签语言（界面要双语，daemon 那份固定中文），结构（编号 / 严重度 / 位置 / 原文）
 *    必须逐条对齐——所以这个文件里有测试钉住形状。
 */
export interface AuditEvidence {
  locator: string | null
  excerpt: string | null
}

export interface AuditFinding {
  severity: string
  summary: string
  evidence: ReadonlyArray<AuditEvidence>
}

/**
 * 文案由调用方注入（界面有 zh/en 两套）。
 *
 * 为什么不由本文件写死中文：这段文字**既给起草者看、也给人改**——人看的那一遍必须是他选的
 * 语言，而 agent 那侧读中文或英文都无所谓。所以标签跟随界面语言，结构不跟随。
 */
export interface FeedbackLabels {
  /** 第一句（交代理由码与"逐条改"） */
  intro: (reasonCode: string) => string
  /** 位置那一行的标签（`位置：SKILL.md:12`） */
  where: string
  /** 原文那一行的标签（`原文：# 报告流程`） */
  quote: string
  /** 条目没有位置时如实说明（不许编一个位置） */
  noEvidence: string
  /** 条目清单整个是空的时如实说明 */
  emptyFindings: string
  /** 收尾：没提到的别动、改过的写完整文件 */
  outro: string
}

/**
 * 生成填进「按意见改一版」输入框的草稿。
 *
 * 注意它**不是**最终交给起草者的东西：人可以在框里改，改完点提交才会发出去。
 * 所以这里宁可写得啰嗦一点（每条都带位置与原文），也不替人做取舍。
 */
export function buildFeedbackDraft(
  reasonCode: string,
  findings: ReadonlyArray<AuditFinding>,
  labels: FeedbackLabels,
): string {
  const lines: string[] = [labels.intro(reasonCode)]
  if (findings.length === 0) {
    // 判决里没有条目 ⇒ 如实说明，不要编一条。理由码本身就是唯一线索。
    lines.push(labels.emptyFindings)
  }
  findings.forEach((f, i) => {
    lines.push(`${i + 1}. [${f.severity}] ${f.summary}`)
    const places = f.evidence.filter((e) => e.locator !== null || e.excerpt !== null)
    if (places.length === 0) {
      lines.push(`   ${labels.noEvidence}`)
      return
    }
    for (const e of places) {
      if (e.locator !== null && e.locator !== '') lines.push(`   ${labels.where}${e.locator}`)
      if (e.excerpt !== null && e.excerpt !== '') lines.push(`   ${labels.quote}${e.excerpt}`)
    }
  })
  lines.push(labels.outro)
  return lines.join('\n')
}
