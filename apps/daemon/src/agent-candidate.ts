/**
 * **候选智能体**：读聊天工作目录里的 `agent-draft/<岗位名>/`，校验，给界面用（2026-11，D256）。
 *
 * 与「候选编排」（`workflow-candidate.ts`）**同一张图纸**（D255 定的那张）：
 *
 *   <工作目录>/agent-draft/<岗位名>/
 *     agent.json          { name?, runtimeKey? }
 *     instructions.md     那段唯一正文
 *     skills/<技能名>/SKILL.md   可选：它自己带的配套技能（可以 0 条）
 *
 * 入库 = **校验 + 建智能体 + 落独有技能**（`agent-adopt.ts`），没有中间格式。
 *
 * ⚠️ 与 D109 那一版的区别：产物从"一张岗位卡 md + `skill/` 目录"换成"存储形状的目录"。
 *   为什么不翻译：翻译就有两处形状要同步；而落库本来就是"建一个 `agents/<名字>/` 目录"，
 *   两边同构之后入库只是"搬"。
 *
 * 校验纪律与候选编排一致：**确定错的一定拒**（缺正文 / 名字不合法 / 技能 frontmatter 缺项 /
 * runtime 不认识），**不确定的只提示**（`runtimeKey` 没写 = 跟随工作区默认，合法）。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSkillMd } from './crystallize-artifacts.ts'
import { AGENT_DRAFT_DIR } from './agent-maker.ts'

/** 一条候选里带的配套技能。 */
export interface AgentCandidateSkill {
  name: string
  /** `SKILL.md` 原文（落库时与安装同一关再验一遍）。 */
  body: string
  description: string
}

export interface AgentCandidateProblem {
  level: 'error' | 'warn'
  message: string
}

/** 预检结果（也直接进对话详情给界面画卡片）。 */
export interface AgentCandidate {
  /** 子目录名（入库时原样传回）。 */
  dir: string
  name: string
  /** 指令前两行（卡片上"这是个什么人"）。 */
  instructionsPreview: string
  /** 指令字数（卡片上"有多长"）。 */
  instructionsChars: number
  runtimeKey: string
  skills: AgentCandidateSkill[]
  problems: AgentCandidateProblem[]
  /** 绝对路径（"打开目录"用）。 */
  absDir: string
}

/** 名字上限（与 `POST /api/agents` 同一条）。 */
export const AGENT_NAME_MAX = 100

/** 列出候选目录（一个候选 = 一个**目录**；`agent-draft.md` 那种老文件不算）。 */
export async function listAgentCandidateDirs(workDir: string): Promise<string[]> {
  const root = join(workDir, AGENT_DRAFT_DIR)
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    try {
      if ((await stat(join(root, name))).isDirectory()) out.push(name)
    } catch {
      // 读不到就跳过（坏一条不牵连别的）
    }
  }
  out.sort((a, b) => a.localeCompare(b))
  return out
}

/**
 * 读一个候选并校验。
 *
 * 不抛错：读不到的东西一律变成 `problems` 里的一条 `error`（界面照原样说）。
 */
export async function readAgentCandidate(workDir: string, dir: string): Promise<AgentCandidate> {
  const absDir = join(workDir, AGENT_DRAFT_DIR, dir)
  const problems: AgentCandidateProblem[] = []
  let name = dir
  let runtimeKey = 'default'
  let instructions = ''

  // ── ① agent.json（可缺：名字就是目录名）──
  let json: Record<string, unknown> | null = null
  try {
    const raw = await readFile(join(absDir, 'agent.json'), 'utf8')
    try {
      const parsed = JSON.parse(raw) as unknown
      json = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
      if (json === null) problems.push({ level: 'error', message: 'agent.json 不是对象' })
    } catch (err) {
      problems.push({
        level: 'error',
        message: `agent.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
      })
    }
  } catch {
    json = null // 没有 agent.json：用目录名，合法
  }
  if (json !== null) {
    const declared = typeof json['name'] === 'string' ? json['name'].trim() : ''
    if (declared !== '' && declared !== dir) {
      problems.push({
        level: 'error',
        message: `目录叫「${dir}」，但 agent.json 里的 name 是「${declared}」（两者要一致）`,
      })
    }
    if (declared !== '') name = declared
    const key = typeof json['runtimeKey'] === 'string' ? json['runtimeKey'].trim() : ''
    if (key !== '') runtimeKey = key
  }
  if (name.trim() === '') problems.push({ level: 'error', message: '岗位名不能为空' })
  else if (name.length > AGENT_NAME_MAX) {
    problems.push({ level: 'error', message: `岗位名太长（${name.length} 字，上限 ${AGENT_NAME_MAX}）` })
  }

  // ── ② instructions.md（唯一的那段正文，必填）──
  try {
    instructions = await readFile(join(absDir, 'instructions.md'), 'utf8')
  } catch {
    problems.push({ level: 'error', message: '缺 instructions.md（那段唯一正文）' })
  }
  if (instructions.trim() === '') {
    if (instructions !== '') problems.push({ level: 'error', message: 'instructions.md 是空的' })
    else problems.push({ level: 'error', message: '缺 instructions.md（那段唯一正文）' })
  }

  // ── ③ skills/<技能名>/SKILL.md（可选，但写了就得合格）──
  const skills: AgentCandidateSkill[] = []
  try {
    for (const s of await readdir(join(absDir, 'skills'))) {
      if (s.startsWith('.')) continue
      let base: string
      try {
        base = join(absDir, 'skills', s)
        if (!(await stat(base)).isDirectory()) continue
      } catch {
        continue
      }
      let body = ''
      try {
        body = await readFile(join(base, 'SKILL.md'), 'utf8')
      } catch {
        problems.push({
          level: 'error',
          message: `技能目录 \`skills/${s}/\` 里没有 SKILL.md`,
        })
        continue
      }
      const parsed = parseSkillMd(body)
      if (!body.replace(/^\uFEFF/, '').trimStart().startsWith('---')) {
        problems.push({
          level: 'error',
          message: `技能 \`${s}\` 的 SKILL.md 缺 frontmatter（第一行必须是 \`---\`）`,
        })
        continue
      }
      if (parsed.name === '') {
        problems.push({ level: 'error', message: `技能 \`${s}\` 的 frontmatter 缺 \`name\`` })
        continue
      }
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(parsed.name)) {
        problems.push({
          level: 'error',
          message: `技能 \`${s}\` 的 name 必须是 kebab-case（现在是「${parsed.name}」）`,
        })
        continue
      }
      if (parsed.description === '') {
        problems.push({
          level: 'error',
          message: `技能 \`${s}\` 的 frontmatter 缺 \`description\`（模型靠它决定何时加载）`,
        })
        continue
      }
      if (body.trim() === '') {
        problems.push({ level: 'error', message: `技能 \`${s}\` 是空的` })
        continue
      }
      skills.push({ name: parsed.name, body, description: parsed.description })
    }
  } catch {
    // 没有 skills/ = 配套技能 0 条，合法（使用者：不值得抽就 0 条）
  }

  if (skills.length > 5) {
    problems.push({
      level: 'warn',
      message: `这个岗位带了 ${skills.length} 条配套技能：多数岗位 0–2 条就够，多了说明抽得太细`,
    })
  }

  const preview = instructions
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(0, 2)
    .join(' / ')

  return {
    dir,
    name,
    instructionsPreview: preview,
    instructionsChars: instructions.length,
    runtimeKey,
    skills,
    problems,
    absDir,
  }
}

/** `readAgentCandidate` 的批量版（按目录名排）。 */
export async function readAgentCandidates(workDir: string): Promise<AgentCandidate[]> {
  const dirs = await listAgentCandidateDirs(workDir)
  const out: AgentCandidate[] = []
  for (const dir of dirs) out.push(await readAgentCandidate(workDir, dir))
  return out
}
