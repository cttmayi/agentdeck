/**
 * **编排的磁盘形状**（2026-11，使用者："先把编排改成目录存储吧"）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 与智能体同一副形状（`packages/store-file/src/agent-dirs.ts`）
 * ══════════════════════════════════════════════════════════════════
 *
 *   <dataDir>/workflows/<workflowId>/
 *   ├── workflow.json     结构化（id / name / source / templateKey / 时间）——**不含代码**
 *   └── main.js           编排代码本体（纯文本）——与 `instructions.md` 同一个角色
 *
 *   <dataDir>/workflow-runs/<runId>.json   一条运行一个文件
 *
 * 三条照抄过来的道理（`docs/design/storage-layout.md` §0）：
 *
 *   · **结构化的进 json、成篇的正文进独立文本文件**：代码放在 `main.js` 里，人能
 *     直接打开、能用编辑器改、`git diff` 看得清；`workflow.json` 只留机器要的字段。
 *   · **一个实体一个目录**：删一条编排不影响别的；坏一条不会毁掉全部（改之前是
 *     `workflows.json` 一个数组，**一个坏字节 = 编排页全空**）。
 *   · **权威只有一个**：`main.js` 是代码的唯一真相，json 里不再存第二份。
 *
 * ⚠️ 运行记录**不进**编排目录：`DELETE /api/workflows/:id` 只删定义、保留历史
 *   （`server.ts`）。挂在编排目录下面的话，删一条编排就把它的运行历史一起埋了——
 *   那是行为改变，不是存储搬家。
 *
 * ⚠️ 这里**不建** `agents/<agentId>/` 子目录：编排内建智能体（`Workflow.inlineAgents`）
 *   那条功能还没做，现在建空目录就是造死结构。等它落地时按 `agents/<id>/` 的形状加
 *   到本文件里（`workflow.json` 里的 `inlineAgents` 字段先原样留着，那条功能要用它）。
 */

import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite, ensureDir, readJsonOrNull } from '@agentdeck/store-file'
import type { Workflow } from './workflows.ts'
import type { WorkflowRun } from '@agentdeck/orchestration'

/* ══════════════════════════════════════════════════════════════════
 * 路径
 * ══════════════════════════════════════════════════════════════════ */

/** 编排目录的根（`<dataDir>/workflows`）。 */
export function workflowsRoot(dir: string): string {
  return join(dir, 'workflows')
}

/** 一条编排的目录（`<dataDir>/workflows/<id>`）。 */
export function workflowDirPath(dir: string, id: string): string {
  return join(workflowsRoot(dir), id)
}

/** 结构化信息落点（**不含代码**）。 */
function workflowJsonPath(dir: string, id: string): string {
  return join(workflowDirPath(dir, id), 'workflow.json')
}

/** 代码落点。 */
function workflowCodePath(dir: string, id: string): string {
  return join(workflowDirPath(dir, id), 'main.js')
}

/**
 * **编排内建智能体的独有技能目录**（D228）。
 *
 * `workflows/<id>/agents/<agentId>/skills/` —— 与 `agents/<id>/skills/` 逐字同形，
 * 这样技能注入那一层不需要知道两种来源的差别（它只拿到一个目录）。
 *
 * ⚠️ 这个形状归本文件（workflow 目录的拥有者）；daemon 在装配 `FileStore` 时
 *   把"owner → 目录"的解析函数注入进去，store-file 只认目录、不认 workflow
 *   的布局（`packages/domain` 的端口里也不许出现路径词汇，见 FR-STOR-03）。
 */
export function workflowAgentExclusiveSkillsDir(
  dir: string,
  workflowId: string,
  agentId: string,
): string {
  return join(workflowDirPath(dir, assertSafeId(workflowId)), 'agents', assertSafeId(agentId), 'skills')
}

/** 运行记录的根（`<dataDir>/workflow-runs`）。 */
export function workflowRunsRoot(dir: string): string {
  return join(dir, 'workflow-runs')
}

/** 一条运行的文件（`<dataDir>/workflow-runs/<runId>.json`）。 */
export function workflowRunPath(dir: string, runId: string): string {
  return join(workflowRunsRoot(dir), `${runId}.json`)
}

/**
 * id 要能安全地当目录名/文件名用。
 *
 * 今天所有 id 都是 ULID（`[0-9A-Z]`），但这两个函数是**公开**的（路由把 URL 里的 id
 * 直接递进来），所以按"路径不能由外部输入决定"这条老规矩挡一道：`..`、`/`、
 * 绝对路径都不许。（与技能 slug、支持文件路径同一类防线。）
 */
function assertSafeId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`编排 id 不能当目录名：${JSON.stringify(id)}`)
  return id
}

/* ══════════════════════════════════════════════════════════════════
 * 写
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 把一条编排落成目录：`workflow.json`（结构化）+ `main.js`（代码）。
 *
 * 两份都是**原子写**（tmp → fsync → rename），所以任何时刻读到的都是完整的旧版或新版。
 */
export async function writeWorkflowDir(dir: string, workflow: Workflow): Promise<void> {
  const id = assertSafeId(workflow.id)
  await ensureDir(workflowDirPath(dir, id))
  const { code, ...structured } = workflow
  await atomicWrite(workflowJsonPath(dir, id), `${JSON.stringify(structured, null, 2)}\n`)
  await atomicWrite(workflowCodePath(dir, id), code)
}

/** 删掉一条编排的整个目录（含代码）。 */
export async function removeWorkflowDir(dir: string, id: string): Promise<void> {
  await rm(workflowDirPath(dir, assertSafeId(id)), { recursive: true, force: true })
}

/** 把一条运行落成文件（一条一个文件：删/查/坏一个都不牵连别的）。 */
export async function writeWorkflowRunFile(dir: string, run: WorkflowRun): Promise<void> {
  const id = assertSafeId(run.id)
  await ensureDir(workflowRunsRoot(dir))
  await atomicWrite(workflowRunPath(dir, id), `${JSON.stringify(run, null, 2)}\n`)
}

/* ══════════════════════════════════════════════════════════════════
 * 读
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 读回一条编排。目录里没有 `workflow.json` ⇒ `null`（"没有这一条"）。
 *
 * 两种残缺分开处置——这正是"坏一条不毁全部"的落点：
 *   · `workflow.json` **读不出来** ⇒ 这条**跳过**，错误报出去（没有元数据就画不出列表行，
 *     留着一个空壳也没有意义）；
 *   · `main.js` **缺了** ⇒ 这条**照样列出**（代码当空串），同时报一条错误。
 *     为什么不跳过它：使用者在编排页看到的是"我那条编排不见了"，而真相是"代码文件被删了、
 *     标题还在"。列出来他才知道该把代码贴回去——**列出来 + 说话** 比 **消失 + 只在日志里说** 好。
 */
async function readWorkflowDir(
  dir: string,
  id: string,
): Promise<{ workflow: Workflow; errors: string[] } | { error: string } | null> {
  const jsonPath = workflowJsonPath(dir, id)
  let structured: Record<string, unknown>
  try {
    const raw = await readFile(jsonPath, 'utf8')
    structured = JSON.parse(raw) as Record<string, unknown>
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { error: `${id}/workflow.json 读不出来：${String(err)}` }
  }
  let code = ''
  const errors: string[] = []
  try {
    code = await readFile(workflowCodePath(dir, id), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { error: `${id}/main.js 读不出来：${String(err)}` }
    }
    errors.push(`${String(structured['name'] ?? id)}：缺 main.js（代码丢了，页面上的代码框会是空的）`)
  }
  return { workflow: { ...(structured as unknown as Workflow), id, code }, errors }
}

/**
 * 列出全部编排。
 *
 * 返回 `{ workflows, errors }`：**逐条读、逐条报**——坏的那条点名，其余照常。
 * 改之前这里是 `catch { return [] }`：一个坏字节让整页变空，而且一个字都不说。
 */
export async function listWorkflowDirs(
  dir: string,
): Promise<{ workflows: Workflow[]; errors: string[] }> {
  let ids: string[]
  try {
    ids = await readdir(workflowsRoot(dir))
  } catch {
    return { workflows: [], errors: [] } // 从没建过编排 ≠ 出错
  }
  const workflows: Workflow[] = []
  const errors: string[] = []
  for (const id of ids) {
    if (id.startsWith('.')) continue // 占位/临时文件不读（`.migrated` 那种）
    let entry: Awaited<ReturnType<typeof readWorkflowDir>>
    try {
      entry = await readWorkflowDir(dir, id)
    } catch (err) {
      errors.push(`${id}：${String(err)}`)
      continue
    }
    if (entry === null) continue // 空目录/别的文件，不算错误
    if ('error' in entry) {
      errors.push(entry.error)
      continue
    }
    workflows.push(entry.workflow)
    errors.push(...entry.errors)
  }
  // 稳定顺序：按创建时间（ULID 与它同序）。readdir 的顺序不保证，界面不该跟着抖。
  workflows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return { workflows, errors }
}

/** 列出全部运行记录（同样逐条读、逐条报）。 */
export async function listWorkflowRunFiles(
  dir: string,
): Promise<{ runs: WorkflowRun[]; errors: string[] }> {
  let names: string[]
  try {
    names = await readdir(workflowRunsRoot(dir))
  } catch {
    return { runs: [], errors: [] }
  }
  const runs: WorkflowRun[] = []
  const errors: string[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    const id = name.slice(0, -'.json'.length)
    try {
      const run = await readJsonOrNull<WorkflowRun>(workflowRunPath(dir, id))
      if (run === null) continue
      runs.push({ ...run, id })
    } catch (err) {
      errors.push(`运行 ${id} 读不出来：${String(err)}`)
    }
  }
  runs.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return { runs, errors }
}

/* ══════════════════════════════════════════════════════════════════
 * 迁移（老的两个大 JSON → 目录；幂等、可回滚）
 * ══════════════════════════════════════════════════════════════════ */

/** 老文件的落点（它们曾经是唯一的存储）。 */
export function legacyWorkflowsPath(dir: string): string {
  return join(dir, 'workflows.json')
}
export function legacyWorkflowRunsPath(dir: string): string {
  return join(dir, 'workflow-runs.json')
}

/**
 * 迁移成功后**删掉**老文件（D227，2026-11 使用者："migrated 文件也清掉"）。
 *
 * ⚠️ 删之前**必须核对**：调用方把新存储读回来数一遍，只有"读得回来、条数不少于
 *   刚迁过去的"才删。这一步是删老文件唯一的安全垫——没有它，删就是赌。
 *   核对不通过 ⇒ 老文件原样留着，并把原因写进 `errors`（启动日志会打出来）。
 *
 * 历史沿革：D224/D225 那两版是改名 `.migrated` 留档（可回滚）；使用者看过之后
 * 要求清掉——数据已经在新地方，留着只是数据目录里的垃圾。
 */
async function dropLegacy(path: string): Promise<string | null> {
  try {
    await rm(path, { force: true })
    return null
  } catch (err) {
    return `老文件删除失败（不影响已迁数据）：${String(err)}`
  }
}

/**
 * 迁移老的 `workflows.json`（一个数组）到目录形状。
 *
 * 口径（三条都是"宁可少做、不要做错"）：
 *   · 老文件**不存在** ⇒ 什么都不做（返回值 `null`，不是 0——两件事不一样）；
 *   · 老文件**读不出来** ⇒ **不改名、不删**，把错误报出去（迁移不该掩盖坏数据）；
 *   · 目标目录**已经存在** ⇒ 跳过那一条（目录是新的真相，老文件里那份是旧的）。
 *
 * 幂等：跑完就没有 `workflows.json` 了，再跑一次直接返回 `null`。
 */
export async function migrateLegacyWorkflows(
  dir: string,
): Promise<{ migrated: number; skipped: number; errors: string[] } | null> {
  const path = legacyWorkflowsPath(dir)
  let list: Workflow[]
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Workflow[]
    if (!Array.isArray(parsed)) {
      return { migrated: 0, skipped: 0, errors: [`${path} 里不是数组，原样留着没动`] }
    }
    list = parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { migrated: 0, skipped: 0, errors: [`${path} 读不出来（原样留着没动）：${String(err)}`] }
  }
  const errors: string[] = []
  let migrated = 0
  let skipped = 0
  for (const wf of list) {
    if (typeof wf?.id !== 'string' || wf.id === '') {
      errors.push(`workflows.json 里有一条没有 id，跳过`)
      continue
    }
    const existing = await readJsonOrNull<unknown>(workflowJsonPath(dir, wf.id))
    if (existing !== null) {
      skipped += 1
      continue
    }
    try {
      await writeWorkflowDir(dir, wf)
      migrated += 1
    } catch (err) {
      errors.push(`编排 ${wf.id} 落盘失败：${String(err)}`)
    }
  }
  // 一条都没迁成（全失败）就别动老文件——留着，下次启动还能再试。
  if (errors.length === 0 || migrated > 0) {
    const back = await listWorkflowDirs(dir)
    const safe = back.errors.length === 0 && back.workflows.length >= migrated
    if (safe) {
      const why = await dropLegacy(path)
      if (why !== null) errors.push(why)
    } else {
      errors.push(`${path} 回读核对没通过（新存储 ${back.workflows.length} 条 < 迁入 ${migrated} 条），老文件原样留着`)
    }
  }
  return { migrated, skipped, errors }
}

/** 迁移老的 `workflow-runs.json`。口径与上面逐条相同。 */
export async function migrateLegacyWorkflowRuns(
  dir: string,
): Promise<{ migrated: number; skipped: number; errors: string[] } | null> {
  const path = legacyWorkflowRunsPath(dir)
  let list: WorkflowRun[]
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as WorkflowRun[]
    if (!Array.isArray(parsed)) {
      return { migrated: 0, skipped: 0, errors: [`${path} 里不是数组，原样留着没动`] }
    }
    list = parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { migrated: 0, skipped: 0, errors: [`${path} 读不出来（原样留着没动）：${String(err)}`] }
  }
  const errors: string[] = []
  let migrated = 0
  let skipped = 0
  await mkdir(workflowRunsRoot(dir), { recursive: true })
  for (const run of list) {
    if (typeof run?.id !== 'string' || run.id === '') {
      errors.push('workflow-runs.json 里有一条没有 id，跳过')
      continue
    }
    const existing = await readJsonOrNull<unknown>(workflowRunPath(dir, run.id))
    if (existing !== null) {
      skipped += 1
      continue
    }
    try {
      await writeWorkflowRunFile(dir, run)
      migrated += 1
    } catch (err) {
      errors.push(`运行 ${run.id} 落盘失败：${String(err)}`)
    }
  }
  // 一条都没迁成（全失败）就别动老文件——留着，下次启动还能再试。
  if (errors.length === 0 || migrated > 0) {
    const back = await listWorkflowDirs(dir)
    const safe = back.errors.length === 0 && back.workflows.length >= migrated
    if (safe) {
      const why = await dropLegacy(path)
      if (why !== null) errors.push(why)
    } else {
      errors.push(`${path} 回读核对没通过（新存储 ${back.workflows.length} 条 < 迁入 ${migrated} 条），老文件原样留着`)
    }
  }
  return { migrated, skipped, errors }
}
