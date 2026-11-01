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
import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
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

/** 落盘时的上下文（这些进 `00-README.md` 与 `meta.json`）。 */
export interface MaterialContext {
  /**
   * ★ 分批第 133 批（「从空白/材料起」）：`blank` = **没有来源 run**——素材只有使用者
   * 在开始提炼时给的那几份（可能一份都没有）。索引页要如实写"没有轨迹可回查"，
   * 否则起草者会以为 `turns/` 只是它没找到。
   */
  scope: 'conversation' | 'task' | 'blank'
  /** 来源标题（对话标题 / 任务标题；空白起为空串）。 */
  sourceLabel: string
  /**
   * 本次目标：新建 skill（可带作用描述）/ 更新某个 skill。
   * 两者共用同一套素材（会话/任务记录），差别只在"上一版"摆不摆。
   *
   * ⚠️ 分批第 191 批删掉了第三种 `{ kind: 'agent' }`（"优化智能体指令"）：使用者定稿
   * 沉淀只产出 skill —— 起草者照被注入的那份技能写字，不再改平台/使用者的智能体。
   */
  target: { kind: 'new'; purpose: string } | { kind: 'update'; skill: ExistingSkillSnapshot }
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
      : ctx.scope === 'blank'
        ? // ★ 分批第 133 批：空白起没有轨迹，索引里要**如实说**，并把使用者给的每份材料列出来
          //   （"先读这一页"是起草者的第一条指令——不列在这儿，它们就等于不存在）。
          pieces.length === 0
          ? '- **这次没有材料**：既没有来源 run，使用者也没给材料。只按作用描述起草，并明说依据不足。'
          : pieces.map((p) => `- \`${p.relPath}\` — 使用者给的材料（外部）`).join('\n')
        : '- `task-run.md` — 这条任务的完整执行记录'

  const sourceLine =
    ctx.scope === 'blank'
      ? '来源：**空白起**（没有来源 run）'
      : `来源：${ctx.scope === 'conversation' ? '对话' : '任务'}「${ctx.sourceLabel}」`
  const pieceCount = pieces.filter((p) => p.relPath.startsWith('appended/')).length
  const scaleLine =
    ctx.scope === 'blank'
      ? `规模：使用者给的材料 ${pieceCount} 份（**没有轨迹可回查**）`
      : `规模：${stats.turns} 轮 · ${stats.toolCalls} 次工具调用`

  return `# 素材索引

${sourceLine}
${scaleLine}

## 本次要做什么

${targetLine}

## 里面有什么

${turnList}
${ctx.scope === 'task' && pieces.some((p) => p.relPath === 'verdict.md') ? '- `verdict.md` — 审核判决（哪些做对了、哪些要改，这是最可信的判据）\n' : ''}${pieces.some((p) => p.relPath === 'feedback.md') ? '- `feedback.md` — 使用者的反馈\n' : ''}- \`meta.json\` — 结构化元信息（轮数/工具调用数/目标）
- \`skills-index.md\` — 现有技能清单（判重：素材明显属于某个已有技能时，在结论里说明并给出依据）
${pieces.some((p) => p.relPath === 'user-requirements.md') ? '- \`user-requirements.md\` — **使用者在素材里提出来的要求**（平台机械抽取，原文照抄）——每一条都要有落点\n' : ''}
${ctx.target.kind === 'update' ? '- `existing-skill/` — 要更新的技能当前全文（含支持文件）\n' : ''}
## 怎么用这些文件

1. **先读这一页**，再决定要读哪些文件——不要一次性把全部素材读进上下文。
2. 写 Procedure 之前，${
    ctx.scope === 'blank'
      ? '**空白起没有轨迹可回查**：材料里没有的命令、路径、事实一律不要编，缺就如实写"没覆盖到"'
      : '回查**原始命令与参数**（在 \`turns/*.md\` 的「工具调用」里）'
  }，
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

/**
 * ★ 分批第 130 批（§12.14 材料 / U3d 第二半）：使用者**追加材料**——把一段文本落进 `material/`。
 *
 * 为什么这不是"界面上多一个框"：素材是起草者**唯一**的依据，而 `material/` 里每个文件都是
 * 平台在起草前一次性写好的（`writeMaterial`）。追加材料如果没有**写接口**，输入条里那句
 * 「追加材料：…」就只能如实说"没有落点"（§12.41 的不放假接口原则）。这一批把落点补上。
 *
 * 落点有三处，少一处就是"写了但没人读"：
 *   ① 文件本身 → `material/appended/<名字>.md`。单独一档：一眼能看出哪些是自动带的、
 *      哪些是人加的（界面的「素材」清单按相对路径排，`appended/` 会聚在一起）；
 *   ② **索引页** `00-README.md` → 追加一段。起草者第一个读的就是它（"先读这一页，再决定
 *      要读哪些文件"）——不登记等于让这份材料永远躺在磁盘上没人翻；
 *   ③ 下一版草稿：`startReviseRun` 在原地改、`material/` 是**任务级**的 ⇒ 追加的内容天然
 *      进入下一版的素材（"一个任务一个目录"带来的便宜，不需要复制或额外登记）。
 *
 * ⚠️ 名字只当**文件名**用：永远拼在 `material/appended/` 下面，`../` 与绝对路径在
 *    `safeMaterialName` 里被剥掉。不能靠"界面上不会有人这么传"来省校验——API 是公开的。
 */
export interface AppendedMaterial {
  /** 相对 `material/` 的路径，形如 `appended/我的复盘.md`。 */
  relPath: string
  /** 正文的字节数（不含平台补的那几行头）。 */
  bytes: number
}

/** 追加材料落在这个子目录（与自动带的 `turns/`、`task-run.md` 分开，便于分辨来源）。 */
export const APPENDED_MATERIAL_DIR = 'appended'

/** 使用者给的名字 → 安全文件名（只看最后一段；不安全字符折成 `-`；默认 `.md`）。 */
export function safeMaterialName(raw: string | undefined): string {
  const last = (raw ?? '').trim().split(/[\\/]/).pop() ?? ''
  const base = last
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 60)
  if (base === '') return ''
  return /\.[a-z0-9]{1,8}$/i.test(base) ? base : `${base}.md`
}

/**
 * 同一目录里**不重名**：`x.md` → `x-2.md` → `x-3.md`…
 *
 * 为什么不能直接覆盖：同名追加会**静默**丢掉前一份材料——而两份都可能是使用者特意给的。
 * 改名虽然丑一点，但"看得见的第二份"远好过"看不见的丢失"。
 */
function nameWithoutClash(existing: ReadonlySet<string>, asked: string): string {
  if (asked === '') {
    let i = 1
    while (existing.has(`appended-${i}.md`)) i += 1
    return `appended-${i}.md`
  }
  const dot = asked.lastIndexOf('.')
  const stem = dot === -1 ? asked : asked.slice(0, dot)
  const ext = dot === -1 ? '' : asked.slice(dot)
  let name = asked
  for (let i = 2; existing.has(name); i += 1) name = `${stem}-${i}${ext}`
  return name
}

/**
 * ★ 分批第 133 批（「从空白/材料起」）：把使用者**一开始就给**的那几份材料做成素材文件。
 *
 * 与 `collectMaterial` 的差别只有一个：**没有来源 run**（也就没有轨迹可切）。
 * 落点与「追加材料」同一档（`material/appended/`）——一开始给的、后来追加的是同一类东西，
 * 界面上也该聚在一起、后面「按意见改一版」也天然带着。
 *
 * ⚠️ **允许零份**：空白起最常见的用法就是"什么都没有，先按作用描述写一版"。空材料不是错误
 * （与 `collectMaterial` 那条 `isMaterialEmpty` 不同——那条防的是"任务/对话根本没内容"，
 * 而这里使用者明确选了从空白起）。
 */
export function collectBlankMaterial(
  inputs: ReadonlyArray<{ name?: string; text: string }>,
): { pieces: MaterialPiece[]; stats: MaterialStats } {
  const used = new Set<string>()
  const pieces: MaterialPiece[] = []
  inputs.forEach((input, i) => {
    const asked = safeMaterialName(input.name)
    let name: string
    if (asked === '') {
      let n = i + 1
      while (used.has(`appended-${n}.md`)) n += 1
      name = `appended-${n}.md`
    } else {
      const dot = asked.lastIndexOf('.')
      const stem = dot === -1 ? asked : asked.slice(0, dot)
      const ext = dot === -1 ? '' : asked.slice(dot)
      let candidate = asked
      for (let k = 2; used.has(candidate); k += 1) candidate = `${stem}-${k}${ext}`
      name = candidate
    }
    used.add(name)
    pieces.push({ relPath: `${APPENDED_MATERIAL_DIR}/${name}`, text: input.text })
  })
  return { pieces, stats: { turns: 0, toolCalls: 0 } }
}

/**
 * 索引页里"使用者后来追加的材料"那几个分节的**固定前缀**（追加与删除共用同一个锚点）。
 * 追加时写成 `## 使用者后来追加的材料（<时间>）`，删除时按这个前缀找整节删掉。
 */
const APPENDED_NOTE_HEAD = '## 使用者后来追加的材料'

/** 索引页追加一段"使用者后来追加的材料"（起草者读的第一个文件）。 */
async function noteAppendedInIndex(
  materialDir: string,
  relPath: string,
  bytes: number,
  at: string,
): Promise<void> {
  const indexPath = join(materialDir, '00-README.md')
  const index = await readFile(indexPath, 'utf8').catch(() => '')
  const note =
    `${APPENDED_NOTE_HEAD}（${at}）\n\n` +
    `- \`${relPath}\`（${bytes} 字节）——使用者明确要求把它当成素材；` +
    '**和上面自动带上的素材同等有效**。\n' +
    '  它可能补充或推翻前面某一条做法，动手前先读一遍。\n'
  await writeFile(indexPath, `${index.trimEnd()}\n\n${note}`, 'utf8')
}

export async function appendMaterial(
  materialDir: string,
  input: { name?: string; text: string; now?: Date },
): Promise<AppendedMaterial> {
  const dir = join(materialDir, APPENDED_MATERIAL_DIR)
  await mkdir(dir, { recursive: true })
  const existing = new Set(await readdir(dir).catch(() => [] as string[]))
  const name = nameWithoutClash(existing, safeMaterialName(input.name))
  const at = (input.now ?? new Date()).toISOString()
  // 头几行写清"这是谁加的、什么时候"：起草者与人都要能一眼分辨它不是自动素材
  const header =
    `# 使用者追加的材料\n\n（${at} 由使用者在审阅界面追加；下面正文原样保留。）\n\n`
  await writeFile(join(dir, name), `${header}${input.text}`, 'utf8')
  const relPath = `${APPENDED_MATERIAL_DIR}/${name}`
  const bytes = Buffer.byteLength(input.text, 'utf8')
  await noteAppendedInIndex(materialDir, relPath, bytes, at)
  return { relPath, bytes }
}

/**
 * ★ 分批第 147 批（§12.14「右栏清单回答"它现在手上有什么"——看体量、删掉错的、追加新的」）：
 * **删掉一条使用者给的材料**。
 *
 * 为什么只许删 `appended/` 下的：那里放的是**使用者给的**（空白起一开始给的 + 后来追加的），
 * 也是唯一可能"给错了"的东西。其余材料是平台从来源 run 机械切出来的证据
 * （`turns/*.md`、`task-run.md`、`verdict.md`、`user-requirements.md`、索引页、`meta.json`）——
 * 删了它，起草者读到的"依据"就和来源对不上了，而且下次起草也会从库里重新切回来（删了又回来，
 * 比不给删更让人困惑）。要换来源就重新起一条草稿。
 *
 * 三处一起改，少一处就是"删了但索引还在说它"：
 *   ① 文件本身 → 删掉；
 *   ② 索引页 `00-README.md` → 去掉提到它的那一节（追加时登记的那段）；空白起的草稿把材料
 *      列在「里面有什么」里（`- \`appended/x.md\` — 使用者给的材料（外部）`），那一行也去掉；
 *      空白起还有一行 `规模：使用者给的材料 N 份`，不同步改数，索引就在撒谎；
 *   ③ 下一版草稿：`material/` 是任务级的、原地复用 ⇒ 删掉的就是下一版读不到的了（不用额外做什么）。
 *
 * ⚠️ 返回**判别结果而不是抛异常**：调用方（HTTP 路由）要把"不给删"与"没这份"翻成不同的状态码，
 *    而异常在跨进程边界上是最容易丢信息的一种传递方式。
 */
export type RemoveMaterialResult =
  | { ok: true; relPath: string; remaining: number }
  | { ok: false; code: 'material_not_removable' | 'material_not_found'; relPath: string }

/** 索引页里"提到这份材料的那一节"整节去掉（追加时每份材料各成一节，一节一份）。 */
function dropAppendedNote(index: string, relPath: string): string {
  const parts = index.split(/\n(?=## )/)
  const kept = parts.filter(
    (part) => !(part.startsWith(APPENDED_NOTE_HEAD) && part.includes(`\`${relPath}\``)),
  )
  return kept.join('\n')
}

/**
 * 删完之后把索引页改到"没有这份材料"的状态（见上面 ②）。
 *
 * 索引页是起草者读的**第一个文件**（"先读这一页，再决定读哪些"）——它若还指着一份不存在的
 * 文件，起草者会去读、读不到、然后以为素材坏了。所以这里不是"追加一句已删除"，而是**真的
 * 把引用拿掉**：索引页要始终是"磁盘上现在有什么"的一份准确说明。
 */
async function rewriteIndexAfterRemove(
  materialDir: string,
  relPath: string,
  remaining: number,
): Promise<void> {
  const indexPath = join(materialDir, '00-README.md')
  const index = await readFile(indexPath, 'utf8').catch(() => null)
  if (index === null) return
  // 空白起时材料会作为「里面有什么」的一行列出（自动带的轨迹没有这种行）
  const blankBullet = `- \`${relPath}\` — 使用者给的材料（外部）`
  const kept = dropAppendedNote(index, relPath)
    .split('\n')
    .filter((line) => line.trim() !== blankBullet)
    .join('\n')
  const next = kept.replace(/(规模：使用者给的材料\s*)\d+(\s*份)/, `$1${remaining}$2`)
  if (next === index) return
  await writeFile(indexPath, `${next.trimEnd()}\n`, 'utf8')
}

export async function removeMaterial(
  materialDir: string,
  relPath: string,
): Promise<RemoveMaterialResult> {
  const asked = relPath.trim().replace(/^\.\//, '')
  const prefix = `${APPENDED_MATERIAL_DIR}/`
  const name = asked.startsWith(prefix) ? asked.slice(prefix.length) : ''
  // 只看 `appended/` 下的**单段文件名**：多段、`..`、绝对路径一律不给删（API 是公开的，
  // 不能靠"界面不会这么传"来省校验——与追加那边的 `safeMaterialName` 同一条纪律）。
  if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name)) {
    return { ok: false, code: 'material_not_removable', relPath: asked }
  }
  const dir = join(materialDir, APPENDED_MATERIAL_DIR)
  const existing = await readdir(dir).catch(() => [] as string[])
  if (!existing.includes(name)) {
    return { ok: false, code: 'material_not_found', relPath: `${prefix}${name}` }
  }
  await unlink(join(dir, name))
  const remaining = existing.length - 1
  await rewriteIndexAfterRemove(materialDir, `${prefix}${name}`, remaining)
  return { ok: true, relPath: `${prefix}${name}`, remaining }
}

// ★ 分批第 201 批：`appendRepoMaterial` / `noteRepoInIndex`（"从仓库拉材料"的落盘与索引
//   登记）随那条功能一起删掉了（使用者："直接删掉这个功能"，§12.54 下线）。

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
