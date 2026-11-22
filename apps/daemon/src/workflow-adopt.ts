/**
 * **把一条候选编排收进库**（2026-11，D255）。
 *
 * 使用者：「在聊天的工作目录生成存储的格式，**等人点确认后再入库**」＋
 * 「点「收进编排库」→ **直接保存，进入编辑编排页面**（如果有同名，要提示是否覆盖）」。
 *
 * 所以这一支只做"校验 + 整目录搬 + 补字段"，没有中间格式：
 *
 *   <工作目录>/workflow-draft/<名字>/          （生成者写的就是存储形状）
 *     workflow.json  main.js  agents/<名字>/{agent.json,instructions.md,skills/**}
 *                 │
 *                 │  adopt（本文件）
 *                 ▼
 *   <dataDir>/workflows/<id>/                  （库里那条的形状，D234：
 *     workflow.json  main.js  agents/<名字>/…    workflow.json 不含代码、也不含内建人清单）
 *
 * 三条纪律：
 *
 *   1. **服务端重新校验**（`readCandidate` 的 error 一律拒）：界面那份是预检，不是判据；
 *   2. **同名冲突由调用方先确认**（`workflow_name_taken` 在路由里判，见 server.ts），
 *      本文件按 `existingId` 选择"新建 / 原地替换"；
 *   3. **先写临时目录再 rename**：搬一半失败不留半条编排（与 `writeWorkflowDir` 的原子写同一档）。
 */

import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { slugForAgentName, uniqueAgentDirName } from '@agentdeck/store-file'
import type { WorkspaceId } from '@agentdeck/protocol'
import { ulid } from '@agentdeck/protocol'
import { readCandidate, type WorkflowCandidate } from './workflow-candidate.ts'
import { WORKFLOW_DRAFT_DIR } from './workflow-maker.ts'
import type { Workflow, WorkflowInlineAgent } from './workflows.ts'
import { removeWorkflowDir, workflowsRoot } from './workflows-dirs.ts'

export interface AdoptOptions {
  dataDir: string
  /** 对话的工作目录（候选就在它下面的 `workflow-draft/` 里）。 */
  workDir: string
  /** 候选子目录名（就是 `readCandidates` 给回来的 `dir`）。 */
  dir: string
  workspaceId: WorkspaceId
  conversationId: string
  /** 资料包的版本（写进 `apiVersion`；没有就省略）。 */
  apiVersion?: string
  /** 覆盖哪一条（传了就是原地替换；调用方已经问过使用者）。 */
  existingId?: string
  now?: number
}

export type AdoptResult =
  | { ok: true; workflow: Workflow }
  /** 校验不过：`candidate.problems` 里已经写清哪一条不对（界面照原样说）。 */
  | { ok: false; reason: 'invalid'; candidate: WorkflowCandidate }
  | { ok: false; reason: 'missing'; message: string }

/** 目录名合法（不能带 `/`、`..`——它来自界面参数）。 */
function assertSafeDir(dir: string): string {
  if (dir === '' || dir.includes('/') || dir.includes('\\') || dir === '.' || dir === '..') {
    throw new Error(`候选目录名不合法：${JSON.stringify(dir)}`)
  }
  return dir
}

/**
 * 入库。
 *
 * ⚠️ 覆盖（`existingId`）时**整个目录换掉**：旧编排的内建智能体不在这次候选里的，
 *   会被一起删掉——使用者点确认时已经在问过这一点（确认框里写着"整份替换"）。
 */
export async function adoptCandidate(opts: AdoptOptions): Promise<AdoptResult> {
  const dir = assertSafeDir(opts.dir)
  const candidate = await readCandidate(opts.workDir, dir)
  const errors = candidate.problems.filter((p) => p.level === 'error')
  if (errors.length > 0) return { ok: false, reason: 'invalid', candidate }

  const now = opts.now ?? Date.now()
  const id = (opts.existingId ?? (ulid() as string)) as string
  const staging = join(opts.workDir, WORKFLOW_DRAFT_DIR, dir)

  // 内建智能体：从候选目录读出来（名字 = 目录名），逐个落成 `agents/<名字>/`
  const inlineAgents: WorkflowInlineAgent[] = []
  try {
    await mkdir(join(staging, 'agents'), { recursive: true })
  } catch {
    // 没有 agents/ 也合法（纯 gate 的编排）
  }

  const workflow: Workflow = {
    id,
    workspaceId: opts.workspaceId,
    name: candidate.name,
    code: await readFile(join(staging, 'main.js'), 'utf8').catch(() => ''),
    source: 'ai',
    templateKey: null,
    ...(candidate.summary === '' ? {} : { summary: candidate.summary }),
    ...(opts.apiVersion === undefined || opts.apiVersion === '' ? {} : { apiVersion: opts.apiVersion }),
    origin: `conversation:${opts.conversationId}`,
    inlineAgents,
    createdAt: now,
    updatedAt: now,
  }

  /*
   * 覆盖时先删旧目录：`writeWorkflowDir` 是"写 json + 写代码"，不会清掉旧的内建人。
   * 删的这一刻到写之间有窗口，但这是本机单写者（同一个 daemon 串行处理请求），
   * 与 `removeWorkflowDir` 在删除接口里的用法一致。
   */
  if (opts.existingId !== undefined) await removeWorkflowDir(opts.dataDir, id)

  const target = join(workflowsRoot(opts.dataDir), id)
  const tmp = `${target}.tmp-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const taken = new Set<string>()
  try {
    await mkdir(join(tmp, 'agents'), { recursive: true })
    await writeFile(join(tmp, 'main.js'), workflow.code, 'utf8')
    /*
     * `workflow.json` **不含代码、也不含 inlineAgents 清单**（D234：目录是真相）。
     * `createdAt` 沿用旧值（覆盖时保序）。
     */
    const previous =
      opts.existingId === undefined
        ? null
        : await readFile(join(target, 'workflow.json'), 'utf8')
            .then((raw) => JSON.parse(raw) as Record<string, unknown>)
            .catch(() => null)
    const createdAt = typeof previous?.['createdAt'] === 'number' ? previous['createdAt'] : now
    const { code: _code, inlineAgents: _agents, ...structured } = workflow
    void _code
    void _agents
    await writeFile(
      join(tmp, 'workflow.json'),
      `${JSON.stringify({ ...structured, createdAt, updatedAt: now }, null, 2)}\n`,
      'utf8',
    )

    // 内建智能体：名字（可以中文）/ 指令 / 自带的技能——整目录搬
    for (const agent of candidate.agents) {
      const dirName = uniqueAgentDirName(agent.name, taken)
      taken.add(slugForAgentName(agent.name))
      const agentTarget = join(tmp, 'agents', dirName)
      await mkdir(agentTarget, { recursive: true })
      const src = join(staging, 'agents', agent.name)
      const agentJson = await readFile(join(src, 'agent.json'), 'utf8').catch(() => null)
      const structuredAgent: Record<string, unknown> =
        agentJson === null
          ? {}
          : (JSON.parse(agentJson) as Record<string, unknown>)
      const instructions = await readFile(join(src, 'instructions.md'), 'utf8').catch(() => '')
      await writeFile(
        join(agentTarget, 'agent.json'),
        `${JSON.stringify(
          {
            ...structuredAgent,
            id: ulid() as string,
            name: agent.name,
            skillIds: [],
            runtimeKey:
              typeof structuredAgent['runtimeKey'] === 'string' && structuredAgent['runtimeKey'] !== ''
                ? structuredAgent['runtimeKey']
                : 'default',
            createdAt: now,
            updatedAt: now,
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      await writeFile(join(agentTarget, 'instructions.md'), instructions, 'utf8')
      if (agent.skills.length > 0) {
        await cp(join(src, 'skills'), join(agentTarget, 'skills'), { recursive: true })
      }
    }
  } catch (err) {
    await rm(tmp, { recursive: true, force: true })
    return { ok: false, reason: 'missing', message: err instanceof Error ? err.message : String(err) }
  }

  // 落位：先删旧目录（覆盖时已删过，这里兜底），再把临时目录改名过去
  await rm(target, { recursive: true, force: true })
  await mkdir(workflowsRoot(opts.dataDir), { recursive: true })
  await rename(tmp, target)

  return { ok: true, workflow }
}
