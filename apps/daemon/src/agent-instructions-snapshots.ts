/**
 * 智能体指令的历史快照（分批第 36 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有这个文件
 * ══════════════════════════════════════════════════════════════════
 *
 * 「沉淀成 Agent」做的事是**覆盖一条正在生产用的智能体的指令**。store 是 append-only，
 * 旧值其实还在 `log/agent.jsonl` 里——但那条日志的读法是"重放整份日志"，
 * 界面上要一个「恢复上一版」，不该逼人去翻 JSONL。
 *
 * 所以入库那一刻顺手把**旧指令**存成一个文件：
 *
 *   <dataDir>/agent-instructions/<agentId>/<ulid>.json
 *   { agentId, agentName, at, previous, nextChars, runId }
 *
 * 几条口径：
 *   · **只存旧值**，不存新值（新值就在 store 里，是当前值）；这样"恢复"就是把
 *     `previous` 写回去，语义单一。
 *   · 一代一个文件、只增不删：恢复也可以被再恢复（恢复前会先把当前值存成一代），
 *     于是"手滑两次"也能退回去。
 *   · 写失败**不拦入库**：快照是退路，不是入库的前提。但要把原因说出来（`note`），
 *     否则使用者会以为有退路而其实没有——那比没有更坏。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 一代快照（存的是入库那一刻的**旧指令**）。 */
export interface InstructionsSnapshot {
  /** 文件名（不含扩展名）——恢复时按它点名要哪一代。 */
  id: string
  agentId: string
  agentName: string
  /** 存下来的那份：入库之前的指令。 */
  previous: string
  /** 入库之后那版有多少字符（只用于界面上说清"从 X 字变成 Y 字"）。 */
  nextChars: number
  /** 由哪条起草 run 入库（可追溯到那次审核）。 */
  runId: string
  at: number
}

function agentDir(dataDir: string, agentId: string): string {
  return join(dataDir, 'agent-instructions', agentId)
}

/** 存一代快照。**不抛**：写不进去就返回 `{ok:false}`，由调用方决定怎么说。 */
export async function saveInstructionsSnapshot(
  dataDir: string,
  snap: Omit<InstructionsSnapshot, 'id'>,
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const id = `${String(snap.at).padStart(13, '0')}-${snap.runId.slice(-8)}`
  try {
    await mkdir(agentDir(dataDir, snap.agentId), { recursive: true })
    await writeFile(
      join(agentDir(dataDir, snap.agentId), `${id}.json`),
      `${JSON.stringify({ ...snap, id }, null, 2)}\n`,
      'utf8',
    )
    return { ok: true, id }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** 这个 agent 的所有快照，**新的在前**。读不出来的那几代跳过（不因为一条坏记录让整页打不开）。 */
export async function listInstructionsSnapshots(
  dataDir: string,
  agentId: string,
): Promise<InstructionsSnapshot[]> {
  let names: string[]
  try {
    names = await readdir(agentDir(dataDir, agentId))
  } catch {
    return []
  }
  const out: InstructionsSnapshot[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = JSON.parse(
        await readFile(join(agentDir(dataDir, agentId), name), 'utf8'),
      ) as InstructionsSnapshot
      if (typeof raw.previous === 'string' && typeof raw.at === 'number') out.push(raw)
    } catch {
      continue
    }
  }
  out.sort((a, b) => b.at - a.at)
  return out
}

/** 最新那一代（没有 ⇒ null）。 */
export async function latestInstructionsSnapshot(
  dataDir: string,
  agentId: string,
): Promise<InstructionsSnapshot | null> {
  const all = await listInstructionsSnapshots(dataDir, agentId)
  return all[0] ?? null
}
