/**
 * **智能体生成者的领域逻辑**（2026-11，设计定稿 §3.4–§3.6）。
 *
 * 只做"岗位卡怎么解析、怎么读、怎么校验"这几件事；起 run、落库、git 化由
 * server.ts 的确认路由调用 store / skill-mine 完成（与 crystallize.ts 同一条分工）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 岗位卡（agent-draft.md）是什么
 * ══════════════════════════════════════════════════════════════════
 *
 * 智能体生成者在聊天里问五字段、**规则由它描述**（用户只回答只确认），聊完把岗位卡
 * 写进工作目录的 **`agent-draft/` 目录**（2026-11 使用者拍板："放一个目录里面，
 * 比如目录的名字叫 agent-draft。在工作目录下，很容易和其他文件干扰"）：
 *
 *   agent-draft/
 *     agent-draft.md        ← 岗位卡：frontmatter `name` + `role`，正文从
 *                             "你是<name>。"开始，然后 `## 目标` / `## 职责` /
 *                             `## 边界（不能碰）` / `## 输出格式` / `## 验收标准`
 *                             （见 `AGENT_MAKER_INSTRUCTIONS` 与平台技能
 *                             agent-design-norms）
 *     skill/<slug>/SKILL.md ← 配套技能草稿（生成者按 skill-eligibility 判定后
 *                             逐条起草；没有就 0 条）
 *
 * 一个"生成产物"是一个包，不散在工作目录里，也不和 agent 写的其他文件混在一起。
 * **只认新位置**（使用者拍板）：工作目录顶层的老 `agent-draft.md` 不再被认，
 * 按钮不出现（需重新聊）。
 *
 * 生成智能体时：`instructions` = 正文（frontmatter 之外的整段）——岗位卡的节
 * 就是智能体的指令，没有第二处注入位（D29）。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSkillMd } from './crystallize-artifacts.ts'

/** 生成产物包目录（生成者写 `agent-draft/`，确认路由/界面都认这个名字）。 */
export const AGENT_DRAFT_DIR = 'agent-draft'

/** 岗位卡文件名（在 `agent-draft/` 目录内）。 */
export const AGENT_DRAFT_FILE = 'agent-draft.md'

/** 配套技能草稿的目录名（生成者写 `agent-draft/skill/<slug>/SKILL.md`）。 */
export const AGENT_DRAFT_SKILL_DIR = 'skill'

/** 岗位卡解析结果：失败给 `error`（界面/路由据此说清哪里不对，不猜）。 */
export type AgentDraftParsed =
  | { ok: true; name: string; role: string; instructions: string }
  | { ok: false; error: string }

/**
 * 解析岗位卡：frontmatter 的 `name` / `role` + 正文（= 要生成的智能体的指令）。
 *
 * 与 `parseSkillMd` 同一套极简 frontmatter 规则（`---` 头块、容忍空行、不许前面多行）：
 * CLI 靠 frontmatter 认技能，这里靠它认岗位卡——前面多一行就是"岗位卡没被认出"。
 */
export function parseAgentDraft(text: string): AgentDraftParsed {
  const trimmed = text.replace(/^\uFEFF/, '').trimStart()
  if (!trimmed.startsWith('---')) {
    return { ok: false, error: 'frontmatter 必须在第一行（现在开头不是 `---`）' }
  }
  const end = trimmed.indexOf('\n---', 3)
  if (end < 0) {
    return { ok: false, error: 'frontmatter 没有闭合（缺少第二个 `---`）' }
  }
  const head = trimmed.slice(3, end)
  let name = ''
  let role = ''
  for (const line of head.split('\n')) {
    const mName = line.match(/^name\s*:\s*(.+)$/)
    if (mName?.[1]) name = stripQuotes(mName[1].trim())
    const mRole = line.match(/^role\s*:\s*(.+)$/)
    if (mRole?.[1]) role = stripQuotes(mRole[1].trim())
  }
  const instructions = trimmed.slice(end + 4).trim()
  if (name === '') {
    return { ok: false, error: 'frontmatter 缺少 `name`（岗位名，如"会议纪要助理"）' }
  }
  if (role === '') {
    return { ok: false, error: 'frontmatter 缺少 `role`（executor 或 reviewer）' }
  }
  if (instructions === '') {
    return { ok: false, error: '正文是空的——岗位卡至少要有一段指令' }
  }
  return { ok: true, name, role, instructions }
}

/** 一条配套技能草稿（`skill/<slug>/SKILL.md` 解析出来的样子）。 */
export interface AgentDraftSkill {
  slug: string
  name: string
  description: string
  body: string
}

/** 工作目录里读出来的生成产物（岗位卡 + 配套技能草稿）。 */
export interface AgentDraftArtifacts {
  /** `agent-draft.md` 的原文；目录里没有 = null（按钮出现条件就是它）。 */
  agentDraft: string | null
  /** `skill/<slug>/SKILL.md` 逐条解析；目录没有 = 空数组（配套技能 0 条）。 */
  skills: AgentDraftSkill[]
}

/**
 * 读一份生成产物的全部内容。
 *
 * ⚠️ 只读 **`agent-draft/` 目录内**的 `agent-draft.md` 与 `skill/` 下每个子目录的
 * `SKILL.md`：不递归、不进 `material/`（那是沉淀的，不是生成者的）。读不到 =
 * 没产出，**不抛**——按钮出现条件就是"有 agent-draft/agent-draft.md"，没有就
 * 返回 null，让界面说"还没产出岗位卡"。只认新位置（使用者拍板）。
 */
export async function readAgentDraftArtifacts(dir: string): Promise<AgentDraftArtifacts> {
  let agentDraft: string | null = null
  try {
    agentDraft = await readFile(join(dir, AGENT_DRAFT_DIR, AGENT_DRAFT_FILE), 'utf8')
  } catch {
    agentDraft = null
  }
  const skills: AgentDraftSkill[] = []
  try {
    const entries = await readdir(join(dir, AGENT_DRAFT_DIR, AGENT_DRAFT_SKILL_DIR), { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const slug = entry.name
      try {
        const raw = await readFile(join(dir, AGENT_DRAFT_DIR, AGENT_DRAFT_SKILL_DIR, slug, 'SKILL.md'), 'utf8')
        const parsed = parseSkillMd(raw)
        if (parsed.body.trim() === '') continue
        skills.push({
          slug,
          name: parsed.name !== '' ? parsed.name : slug,
          description: parsed.description,
          body: raw,
        })
      } catch {
        // 那个子目录里没有 SKILL.md = 不是一条配套技能草稿（生成者可能放了别的文件），
        // 跳过——不是错误，是"它没写完"或"那不是技能"。
      }
    }
  } catch {
    // skill/ 目录不存在 = 配套技能 0 条（生成者判定没有值得抽的，完全正常）。
  }
  return { agentDraft, skills }
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}
