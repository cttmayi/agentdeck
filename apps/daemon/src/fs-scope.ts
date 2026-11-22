import { readFile, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { atomicWrite } from '@agentdeck/store-file'
import { listWorkDir, resolveWorkFilePath, type ManagedPaths } from './workdir-files.ts'

import { workflowsRoot } from './workflows-dirs.ts'

/**
 * **按 scope 打开一个目录**（2026-11，D245）——把 `GET …/files` 那条链泛化：
 * 调用方只说"哪一类东西"，目录由这里算（路径词汇只在这一个文件里）。
 *
 *   agent:<id>          → agents/<目录名>/
 *   workflow:<id>       → workflows/<id>/
 *   wf-agent:<wid>/<aid>→ workflows/<wid>/agents/<名字>/
 *   schedule:<id>       → schedules/<id>/          （D253）
 *   skill:<名字>        → <该技能自己的目录>       （D253：提炼的在 `skills-mine/`、安装的在 `skills/`，
 *                                                    由调用方按技能的 `source` 解析，不在这里猜）
 *   run:<id> / conversation:<id> 由各自路由保持原样（工作目录，别的东西算不出来）
 */
export type FsScope =
  | { kind: 'agent'; agentId: string }
  | { kind: 'workflow'; workflowId: string }
  | { kind: 'wf-agent'; workflowId: string; agentId: string }
  | { kind: 'schedule'; scheduleId: string }
  | { kind: 'skill'; name: string }

/** id 形态检查（通用）：只允许字母数字与 `-`/`_`，长度 1–64——目录名拼进去之前先挡一道。 */
function isPlainId(s: string): boolean {
  return /^[0-9A-Za-z_-]{1,64}$/.test(s)
}

export function parseScope(raw: string): FsScope | null {
  const m = /^(agent|workflow|wf-agent|schedule|skill):(.+)$/.exec(raw)
  if (!m) return null
  const kind = m[1]!
  const rest = m[2]!
  if (kind === 'skill') {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(rest)) return null
    return { kind: 'skill', name: rest }
  }
  if (kind === 'schedule') return isPlainId(rest) ? { kind: 'schedule', scheduleId: rest } : null
  const parts = rest.split('/')
  if (kind === 'agent') return parts.length === 1 ? { kind: 'agent', agentId: parts[0]! } : null
  if (kind === 'workflow') return parts.length === 1 ? { kind: 'workflow', workflowId: parts[0]! } : null
  return parts.length === 2 ? { kind: 'wf-agent', workflowId: parts[0]!, agentId: parts[1]! } : null
}

export async function dirOfScope(
  scope: FsScope,
  deps: {
    dataDir: string
    skillsRoot: string
    agentDirNameOf: (id: string) => Promise<string | null>
    workflowAgent: (wid: string, aid: string) => Promise<{ dirName: string } | null>
    /**
     * ★ D253：技能目录**按技能自己的 source 解析**（提炼的在 `skills-mine/`、安装的在
     *   `skills/`）。没给这一项时退回 `skillsRoot/<名字>`（老调用点 / 测试）。
     *   ⚠️ 不要在这里"猜两个根、哪个存在用哪个"：两个根都可能有同名技能（提炼一份、
     *      又装一份），猜会把使用者带到**另一条**技能的目录去改。
     */
    skillDirOf?: (name: string) => Promise<string | null>
  },
): Promise<string | null> {
  if (scope.kind === 'skill') {
    if (deps.skillDirOf) return deps.skillDirOf(scope.name)
    return join(deps.skillsRoot, scope.name)
  }
  if (scope.kind === 'schedule') return join(deps.dataDir, 'schedules', scope.scheduleId)
  if (scope.kind === 'workflow') return join(workflowsRoot(deps.dataDir), scope.workflowId)
  if (scope.kind === 'agent') {
    const dirName = await deps.agentDirNameOf(scope.agentId)
    return dirName === null ? null : join(deps.dataDir, 'agents', dirName)
  }
  const hit = await deps.workflowAgent(scope.workflowId, scope.agentId)
  return hit === null ? null : join(workflowsRoot(deps.dataDir), scope.workflowId, 'agents', hit.dirName)
}

export async function listScope(dir: string, sub: string): Promise<unknown> {
  return listWorkDir(dir, sub, { dirs: [], files: [] } as ManagedPaths)
}

export async function readScopeFile(dir: string, rel: string): Promise<Buffer> {
  const abs = await resolveWorkFilePath(dir, rel)
  return readFile(abs)
}

const TEXT_MAX = 256 * 1024

/**
 * 写一个**文本**文件（D245）：只过通用限制——UTF-8 文本、大小上限、路径不出目录、
 * `.json` / `.jsonl` 必须能 parse、原子写。**没有按文件名的白名单黑名单**。
 */
export async function writeScopeFile(dir: string, rel: string, text: string): Promise<void> {
  if (Buffer.byteLength(text, 'utf8') > TEXT_MAX) throw new Error(`超过大小上限（${TEXT_MAX} 字节）`)
  /*
   * ⚠️ 写可能是**新建**文件（拖进来、新加一条独有技能），所以不能用"必须已存在"的
   *   `resolveWorkFilePath`；这里自己拼绝对路径并逐条挡越界（与它同一套规则）。
   */
  const root = await realpath(dir).catch(() => resolve(dir))
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error('路径跑到目录外面了')
  if (rel.split('/').some((seg) => seg === '..' || seg === '')) throw new Error('路径不合法')
  if (rel.endsWith('.jsonl')) {
    text.split('\n').forEach((line, i) => {
      if (line.trim() === '') return
      try { JSON.parse(line) } catch { throw new Error(`第 ${i + 1} 行不是合法 JSON`) }
    })
  } else if (rel.endsWith('.json')) {
    try { JSON.parse(text) } catch (err) { throw new Error(`不是合法 JSON：${String(err instanceof Error ? err.message : err)}`) }
  }
  await atomicWrite(abs, text)
}
