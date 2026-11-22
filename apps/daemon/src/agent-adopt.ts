/**
 * **把一条候选智能体收进库**（2026-11，D256）。
 *
 * 与「候选编排」（`workflow-adopt.ts`）同一张图纸：校验通过就**建库里的那条**，
 * 没有中间格式、不改写人写的东西。
 *
 *   <工作目录>/agent-draft/<岗位名>/           （生成者写的，存储形状）
 *     agent.json  instructions.md  skills/<技能名>/SKILL.md
 *                 │  adopt（本文件）
 *                 ▼
 *   <dataDir>/agents/<名字>/                    （库里那条，D231：目录名 = 名字）
 *     agent.json  instructions.md  skills/<技能名>/SKILL.md
 *
 * 三条纪律：
 *   1. **服务端重新校验**（`readAgentCandidate` 的 error 一律拒）：界面那份是预检；
 *   2. **配套技能落成它的独有技能**（`agents/<id>/skills/…`，D111）——与 D109 那一版
 *      同一条语义：配套技能是"这个岗位自己的东西"，不进共享技能池；
 *   3. **同名的智能体不覆盖**：工作区里已有同名智能体 ⇒ 调用方回 409，让人改名
 *      （覆盖一条已有的智能体会连带它的记忆/技能一起换掉，风险不对等）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentSkillOwner, type Store } from '@agentdeck/domain'
import { ulid, type Agent, type WorkspaceId } from '@agentdeck/protocol'
import { resolvePayloadEntry } from '@agentdeck/skill-source'
import { AGENT_DRAFT_DIR } from './agent-maker.ts'
import { readAgentCandidate, type AgentCandidate } from './agent-candidate.ts'

export interface AdoptAgentOptions {
  store: Store
  /** 对话的工作目录（候选在它下面的 `agent-draft/` 里）。 */
  workDir: string
  /** 候选目录名。 */
  dir: string
  workspaceId: WorkspaceId
  /** 已经校验过的运行时（`resolveRuntimeKey`）——由调用方先过一次，未知值当场 400。 */
  runtimeKey: string
  now?: number
}

export type AdoptAgentResult =
  | { ok: true; agent: Agent; exclusiveNames: string[] }
  | { ok: false; reason: 'invalid'; candidate: AgentCandidate }
  | { ok: false; reason: 'failed'; message: string }

/** 目录名合法（不能带 `/`、`..`——它来自界面参数）。 */
function assertSafeDir(dir: string): string {
  if (dir === '' || dir.includes('/') || dir.includes('\\') || dir === '.' || dir === '..') {
    throw new Error(`候选目录名不合法：${JSON.stringify(dir)}`)
  }
  return dir
}

/** 入库：建智能体 + 把它自带的技能落成独有技能。 */
export async function adoptAgentCandidate(opts: AdoptAgentOptions): Promise<AdoptAgentResult> {
  const dir = assertSafeDir(opts.dir)
  const candidate = await readAgentCandidate(opts.workDir, dir)
  if (candidate.problems.some((p) => p.level === 'error')) {
    return { ok: false, reason: 'invalid', candidate }
  }

  /*
   * 配套技能：与安装/沉淀**同一关**（`resolvePayloadEntry`）。质量关放在写之前——
   * 一条不合格就整条不落库（不留"建了人、技能少一份"的半成品）。
   */
  const validated: Array<{ name: string; body: string }> = []
  for (const s of candidate.skills) {
    try {
      const entry = resolvePayloadEntry({
        name: s.name,
        body: s.body,
        sourceRef: `exclusive:${s.name}`,
      })
      validated.push({ name: entry.name, body: entry.body })
    } catch (err) {
      const c2: AgentCandidate = {
        ...candidate,
        problems: [
          ...candidate.problems,
          {
            level: 'error',
            message: `配套技能「${s.name}」不合格：${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      }
      return { ok: false, reason: 'invalid', candidate: c2 }
    }
  }

  const now = opts.now ?? Date.now()
  const instructions = await readFile(join(opts.workDir, AGENT_DRAFT_DIR, dir, 'instructions.md'), 'utf8')
  const agent: Agent = {
    id: ulid() as Agent['id'],
    workspaceId: opts.workspaceId,
    name: candidate.name,
    instructions,
    model: null,
    runtimeKey: opts.runtimeKey,
    workDir: null,
    skillIds: [],
    env: {},
    builtin: false,
    reviewStandard: null,
    memoryEnabled: false,
    createdAt: now,
    updatedAt: now,
  }

  let created: Agent = agent
  try {
    // `insertAgent` 返回 void（端口约定）；库里那条就是这份 agent（id 是我们生成的）
    await opts.store.insertAgent(agent)
  } catch (err) {
    return { ok: false, reason: 'failed', message: err instanceof Error ? err.message : String(err) }
  }

  const exclusiveNames: string[] = []
  for (const s of validated) {
    try {
      await opts.store.writeExclusiveSkill(agentSkillOwner(created.id), s.name, s.body)
      exclusiveNames.push(s.name)
    } catch (err) {
      /*
       * 技能写失败：把刚建的智能体删掉（不留"人建好了、技能少一份"的半成品；
       * 独有技能随智能体删除一起删）。
       */
      await opts.store.deleteAgent(created.id).catch(() => undefined)
      return {
        ok: false,
        reason: 'failed',
        message: `配套技能「${s.name}」落盘失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
  return { ok: true, agent: created, exclusiveNames }
}
