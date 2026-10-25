/**
 * 沉淀素材**落盘**（2026-10-19 四轮）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么从"一整块文本"改成"一个目录"
 * ══════════════════════════════════════════════════════════════════
 *
 * 四轮之前素材是 `buildMaterial` 拼出来的一大段文本，直接塞进起草 run 的第一句话。
 * 三个问题：
 *
 *   1. **长对话撑爆 prompt**。轮数一多，第一句话就是几万字，agent 还没开始就被截断。
 *   2. **不能回查**。agent 只能"通读一遍"，想问"第 3 轮那条命令的完整参数是什么"没有
 *      办法再去看——而写步骤恰恰需要精确的原命令。
 *   3. **人看不见**。使用者审阅时无法核对"这句话是从哪一轮来的"。
 *
 * 改成目录之后：第一句话只给指针（先读 `material/00-README.md`），agent 用工具按需读；
 * 人在界面上也能翻同一份文件。素材同时成了"这份 skill 依据什么生成"的证据
 * （使用者定稿：**永久保留，不自动清理**）。
 *
 * ⚠️ 目录必须落在**起草 run 的工作目录里**：claude run 有 PreToolUse 隔离 hook，
 *    越界路径直接 deny（见 executor.ts 那段注释）。放别处 agent 根本读不到。
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Store } from '@agentdeck/domain'
import type { Conversation, Issue, Run, RunId } from '@agentdeck/protocol'
import { formatRunMessages, lastTextOf } from './run-text.ts'
// ★ 分批第 26 批：从素材里机械抽出"使用者的要求"（见该文件头注与 §10.41）
import {
  extractRequirements,
  renderUserRequirements,
  requirementTerms,
} from './user-requirements.ts'

/** 一片素材 = 一个文件。 */
export interface MaterialPiece {
  relPath: string
  text: string
}

/** 素材统计（界面在目标态就要显示，起草前可见）。 */
export interface MaterialStats {
  turns: number
  toolCalls: number
}

/** 现有技能（更新场景要把它整份摆进素材，agent 才能"修订"而不是重写）。 */
export interface ExistingSkillSnapshot {
  slug: string
  name: string
  description: string | null
  body: string
  files: Record<string, string>
}

/**
 * ★ 分批第 34 批：要**优化指令**的那条智能体（沉淀成 Agent 的“上一版”）。
 *
 * 和 `ExistingSkillSnapshot` 同一个用途、同一个理由：不在素材里摆出"它现在的指令全文"，
 * 起草者就只能重写一份——而使用者要的是"在这条指令上改"，改坏一处都可能让它下次干错活。
 */
export interface ExistingAgentSnapshot {
  id: string
  name: string
  /** `executor` / `reviewer` / 平台内置的两条。指令的写法跟角色有关（审核者要判事、执行者要干活）。 */
  role: string
  instructions: string
}

/** 落盘时的上下文（这些进 `00-README.md` 与 `meta.json`）。 */
export interface MaterialContext {
  scope: 'conversation' | 'task'
  /** 来源标题（对话标题 / 任务标题）。 */
  sourceLabel: string
  /**
   * 本次目标：新建 skill（可带作用描述）/ 更新某个 skill / **优化某条智能体的指令**。
   * 三者共用同一套素材（会话/任务记录），差别只在"上一版"摆不摆、契约指向哪个目录。
   */
  target:
    | { kind: 'new'; purpose: string }
    | { kind: 'update'; skill: ExistingSkillSnapshot }
    | { kind: 'agent'; agent: ExistingAgentSnapshot }
  /** 现有技能清单（判重与 FOLD_INTO）。 */
  existingSkills: Array<{ slug: string; name: string; description: string | null }>
}

/**
 * 把一条 run（对话轮次 / 任务执行）的消息切成素材文件。
 *
 * 对话：一轮一个文件（`turns/001.md`）——按轮切而不是一个大文件，是为了让 agent
 * 能"只读第 3 轮"，也让使用者能一眼定位某句话的来源。
 */
export async function collectMaterial(
  store: Store,
  run: Run,
  userFeedback?: string,
): Promise<{ pieces: MaterialPiece[]; stats: MaterialStats }> {
  const pieces: MaterialPiece[] = []
  let turns = 0
  let toolCalls = 0

  const countTools = (messages: Array<{ type: string }>): number =>
    messages.filter((m) => m.type === 'tool_use').length

  if (run.subject.type === 'conversation') {
    const conversationId = run.subject.id as Conversation['id']
    const allTurns = await store.listChatTurns(conversationId)
    for (const turn of allTurns) {
      const seq = String(turn.seq).padStart(3, '0')
      if (!turn.runId) {
        pieces.push({
          relPath: `turns/${seq}.md`,
          text: `# 第 ${turn.seq} 轮\n\n## 使用者\n\n${turn.userText}\n\n## 执行记录\n\n（这一轮没有跑起来）\n`,
        })
        continue
      }
      turns += 1
      const messages = await store.listRunMessages(turn.runId)
      toolCalls += countTools(messages)
      const body = formatRunMessages(turn.runId, messages)
      pieces.push({
        relPath: `turns/${seq}.md`,
        text:
          `# 第 ${turn.seq} 轮\n\n## 使用者\n\n${turn.userText}\n\n` +
          `## 执行记录\n\n${body === '' ? '（这一轮没有消息）' : body}\n`,
      })
    }
  } else {
    turns = 1
    const messages = await store.listRunMessages(run.id)
    toolCalls += countTools(messages)
    const body = formatRunMessages(run.id, messages)
    pieces.push({
      relPath: 'task-run.md',
      text: `# 任务执行记录\n\n${body === '' ? '（这条 run 没有消息）' : body}\n`,
    })
    // 审核判决（有则带）：找 completed 的 review run，取它最后一条 text。
    const page = await store.listRuns({ workspaceId: run.workspaceId, limit: 10_000 })
    const review = page.items
      .filter((r) => r.kind === 'review' && r.subject.type === 'run' && r.subject.id === run.id)
      .sort((a, b) => b.queuedAt - a.queuedAt)[0]
    if (review && review.status === 'completed') {
      const verdict = lastTextOf(await store.listRunMessages(review.id))
      if (verdict) pieces.push({ relPath: 'verdict.md', text: `# 审核判决\n\n${verdict}\n` })
    }
    if (userFeedback && userFeedback.trim() !== '') {
      pieces.push({ relPath: 'feedback.md', text: `# 使用者的反馈\n\n${userFeedback.trim()}\n` })
    }
  }

  /**
   * ★ 分批第 26 批：把「使用者在素材里提出的要求」**机械**抽出来，单独成一份。
   *
   * 为什么必须单独一份、而不是指望起草者从 turns 里认出来：真机上它没认出来——
   * 使用者在素材里写了「使用 ASD-STE100 的方式写成一篇文章」和「参考《金字塔原理》」，
   * 产出却写成「**如果**用户要求 STE100 / 金字塔原理…」（可选开关）⇒ 使用者的原话
   * 「这些要求就是我对此部分的习惯…这才有沉淀的意义」。
   * 根子就在本文件下面那段指令：它把"使用者的话"和"这一次的执行细节"归成了一类。
   */
  const requirements = extractRequirements(
    pieces
      .filter((p) => p.relPath.startsWith('turns/') || p.relPath === 'task-run.md')
      .map((p) => ({ relPath: p.relPath, text: p.text })),
  )
  if (requirements.length > 0) {
    const terms = [...new Set(requirements.flatMap((r) => requirementTerms(r.quote)))]
    pieces.push({
      relPath: 'user-requirements.md',
      // 落点检查此刻还没法做（skill/ 还没写出来）⇒ 先只渲染清单，覆盖率在起审核前补
      text: renderUserRequirements(requirements, []),
    })
    void terms
  }

  return { pieces, stats: { turns, toolCalls } }
}

/** 素材是否为空（起草前就该拦，别让它跑完才发现）。 */
export function isMaterialEmpty(collected: { pieces: MaterialPiece[] }): boolean {
  return collected.pieces.every((p) => p.text.trim() === '')
}

/** 素材索引：agent 的第一个入口，也是人翻素材时的目录页。 */
function buildIndex(ctx: MaterialContext, stats: MaterialStats, pieces: MaterialPiece[]): string {
  const targetLine =
    ctx.target.kind === 'new'
      ? ctx.target.purpose.trim() === ''
        ? '新建一个 skill（使用者没有给作用描述——由你从素材推断定位）'
        : `新建一个 skill。使用者的作用描述（description 以它为基底）：${ctx.target.purpose.trim()}`
      : ctx.target.kind === 'agent'
        ? `**优化智能体「${ctx.target.agent.name}」的指令（角色：${ctx.target.agent.role}）**——` +
          '它现在这份指令的全文在 `existing-agent.md`。产出是**改好的整份指令**（`agent/instructions.md`），' +
          '不是 skill：名字、技能、工具、模型都不归你定，也不要新建任何智能体。'
        : `更新现有 skill「${ctx.target.skill.slug}」（${ctx.target.skill.name}）——它的当前全文在 ` +
          '`existing-skill/`，请**修订**而不是重写：保留仍然正确的部分，只改与素材冲突或缺失的部分。'

  const turnList =
    ctx.scope === 'conversation'
      ? pieces
          .filter((p) => p.relPath.startsWith('turns/'))
          .map((p) => {
            const firstLine = p.text.split('\n').find((l) => l.startsWith('# 第 ')) ?? ''
            return `- \`${p.relPath}\` — ${firstLine.replace(/^# /, '')}`
          })
          .join('\n')
      : '- `task-run.md` — 这条任务的完整执行记录'

  return `# 素材索引

来源：${ctx.scope === 'conversation' ? '对话' : '任务'}「${ctx.sourceLabel}」
规模：${stats.turns} 轮 · ${stats.toolCalls} 次工具调用

## 本次要做什么

${targetLine}

## 里面有什么

${turnList}
${ctx.scope === 'task' && pieces.some((p) => p.relPath === 'verdict.md') ? '- `verdict.md` — 审核判决（哪些做对了、哪些要改，这是最可信的判据）\n' : ''}${pieces.some((p) => p.relPath === 'feedback.md') ? '- `feedback.md` — 使用者的反馈\n' : ''}- \`meta.json\` — 结构化元信息（轮数/工具调用数/目标）
- \`skills-index.md\` — 现有技能清单（判重：素材明显属于某个已有技能时，在结论里说明并给出依据）
${pieces.some((p) => p.relPath === 'user-requirements.md') ? '- \`user-requirements.md\` — **使用者在素材里提出来的要求**（平台机械抽取，原文照抄）——每一条都要有落点\n' : ''}
${ctx.target.kind === 'update' ? '- `existing-skill/` — 要更新的技能当前全文（含支持文件）\n' : ''}${ctx.target.kind === 'agent' ? '- `existing-agent.md` — **要优化的那条智能体的当前指令全文**（这就是"上一版"，在它上面改）\n' : ''}
## 怎么用这些文件

1. **先读这一页**，再决定要读哪些文件——不要一次性把全部素材读进上下文。
2. 写 Procedure 之前，回查**原始命令与参数**（在 \`turns/*.md\` 的「工具调用」里），
   不要凭印象重写；命令要能直接复制就跑。
3. **分清两类东西**（2026-10-25 改，使用者："这些要求就是我对此部分的习惯…这才有沉淀的意义"）：
   - **使用者的要求**（\`## 使用者\` 段里的话，清单见 \`user-requirements.md\`）⇒ 这是**约定的来源**：
     默认写进 \`skill/SKILL.md\` 的「约定」一节，**无条件生效**。**只有**素材里明确写了
     "这次/本次/临时/就这一篇"，才允许写成"如果用户要求…"的条件分支。
   - **这一次的执行细节**（\`## 执行记录\` 段里的命令、顺序、试错）⇒ 素材是证据、skill 是做法：
     把"这次我做了 X"改写成"当需要 X 时，先……再……"。
   ⚠️ 旧版这里只有第二条，于是"使用者要求 STE100"被当成一次性细节抽象成了可选开关
     —— 使用者原话就是那次投诉。不要再用一条规则同时处理这两类东西。
4. 素材里凡是**环境依赖的失败、工具吐槽、一次性重试**，不要写进 skill（不结晶清单）。
   这条**只针对执行细节**，不针对使用者的要求。

## 产出写在哪

写到同级的 \`skill/\` 目录（不是本目录）：\`skill/SKILL.md\` 必须有，支持文件放
\`skill/references/\`、\`skill/scripts/\`、\`skill/templates/\`。
`
}

/**
 * 把素材写到 `dir`。返回写出的文件相对路径（给日志与界面用）。
 *
 * 幂等：同一个目录可以被重写（重新起草时复用旧目录）。
 */
export async function writeMaterial(
  dir: string,
  collected: { pieces: MaterialPiece[]; stats: MaterialStats },
  ctx: MaterialContext,
): Promise<string[]> {
  const written: string[] = []
  const put = async (relPath: string, text: string): Promise<void> => {
    const full = join(dir, relPath)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, text, 'utf8')
    written.push(relPath)
  }

  await put('00-README.md', buildIndex(ctx, collected.stats, collected.pieces))
  for (const piece of collected.pieces) await put(piece.relPath, piece.text)

  await put(
    'skills-index.md',
    `# 现有技能清单\n\n${
      ctx.existingSkills.length === 0
        ? '（当前没有已加载的技能）'
        : ctx.existingSkills
            .map((s) => `- \`${s.slug}\`（${s.name}）${s.description ? `：${s.description}` : ''}`)
            .join('\n')
    }\n`,
  )

  if (ctx.target.kind === 'update') {
    const snap = ctx.target.skill
    await put('existing-skill/SKILL.md', snap.body)
    for (const [rel, text] of Object.entries(snap.files)) {
      await put(`existing-skill/${rel}`, text)
    }
  }
  if (ctx.target.kind === 'agent') {
    const snap = ctx.target.agent
    // 只落**指令正文**（外加名字与角色两行元信息）：入库只覆盖 instructions 一个字段，
    // 素材里多摆技能/工具清单会诱导起草者去改那些（使用者明确说过不碰、不新建）。
    await put(
      'existing-agent.md',
      `# 要优化的智能体

- 名字：${snap.name}\n- 角色：${snap.role}\n\n` +
        `## 它当前的指令（全文，共 ${snap.instructions.length} 字符）\n\n` +
        `${snap.instructions.trim() === '' ? '（当前指令是空的——这条智能体还没有任何指令）' : snap.instructions}\n`,
    )
  }

  await put(
    'meta.json',
    `${JSON.stringify(
      {
        scope: ctx.scope,
        sourceLabel: ctx.sourceLabel,
        turns: collected.stats.turns,
        toolCalls: collected.stats.toolCalls,
        target:
          ctx.target.kind === 'new'
            ? { kind: 'new', purpose: ctx.target.purpose }
            : ctx.target.kind === 'agent'
              ? { kind: 'agent', agentId: ctx.target.agent.id, name: ctx.target.agent.name, role: ctx.target.agent.role }
              : { kind: 'update', slug: ctx.target.skill.slug, name: ctx.target.skill.name },
        existingSkills: ctx.existingSkills.map((s) => s.slug),
      },
      null,
      2,
    )}\n`,
  )

  return written
}

/**
 * ⚠️ 这里原来有一个 `copyMaterial`（"按意见改一版"时把上一版的素材复制到新小屋）。
 *
 * 分批第 16 批删掉它的**原因**值得留着：那个函数存在的唯一理由是"每一版都自己一间小屋"——
 * 素材在起草 run 自己的工作目录里（隔离 hook 只放行 workDir），所以换小屋就得复制一份。
 * 现在一个任务一个目录、返工在原地改，素材本来就在那儿 ⇒ 没有东西可复制。
 * 留着它就是一条**死接口**（本仓库最常见的缺陷），而它还会误导后来的人以为"改一版"要换目录。
 */

/** 素材目录里已有哪些文件（界面「素材」分节 / 测试用）。 */
export async function listMaterialFiles(
  dir: string,
): Promise<Array<{ relPath: string; text: string }>> {
  const out: Array<{ relPath: string; text: string }> = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full, rel)
      else if (entry.isFile()) {
        out.push({ relPath: rel, text: await readFile(full, 'utf8') })
      }
    }
  }
  await walk(dir, '')
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  return out
}

/** 任务标题 / 对话标题（界面与索引都要）。 */
export async function sourceLabelOf(store: Store, run: Run): Promise<string> {
  if (run.subject.type === 'conversation') {
    const conv = await store.getConversation(run.subject.id as Conversation['id'])
    return conv?.title ?? ''
  }
  if (run.subject.type === 'issue') {
    const issue = await store.getIssue(run.subject.id as Issue['id'])
    return issue?.title ?? ''
  }
  return ''
}

/** 兜底：源 run id（素材目录名按它定，与界面里的「来源 run」一致）。 */
export function draftDirName(draftRunId: string): string {
  return `skill-draft-${draftRunId}`
}

/** 草稿目录（工作目录）——素材在 `<它>/material`，产出在 `<它>/skill`。 */
export function draftRoot(workRoot: string, draftRunId: string): string {
  return join(workRoot, draftDirName(draftRunId))
}

/** 引用一下未使用的类型，保证导出面稳定（`RunId` 用于调用方标注）。 */
export type DraftRunId = RunId
