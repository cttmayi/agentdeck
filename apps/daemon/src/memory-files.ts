import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryEntry } from '@agentdeck/protocol'
import type { Store } from '@agentdeck/domain'
import { sortMemoryForInjection } from '@agentdeck/agent-core'
import { commitMine, ensureMineRepo, probeGit } from './run-hooks/skill-mine.ts'

/**
 * 记忆的**人可读镜像**（磁盘上的 `MEMORY.md`）+ git 版本管理（分批第 241 批补）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么已经有 store 了还要落一份文件
 * ══════════════════════════════════════════════════════════════════
 *
 * 与技能那边同一个理由：**人要看、要能在 Finder 里翻、要能 `git log` 看"它什么时候
 * 开始这么想的"**。store 里的 JSONL 是给程序读的，藏在数据目录里、一条记录一行 JSON。
 *
 * ⚠️ **权威仍然是 store**。这个文件是**镜像**：文件头第一句就写着"改它不会生效"——
 *    一个看起来能改、改了却没用的文件，比没有这个文件更糟（本仓库的老毛病：
 *    "看起来生效了"）。
 */
export function memoryRootFor(fallbackDataDir: string, override?: string): string {
  return override ?? join(fallbackDataDir, 'memory')
}

/** 一个 agent 的镜像文件路径：`<root>/<agentId>/MEMORY.md`（按 **id** 分目录，改名不搬家）。 */
export function memoryFilePath(root: string, agentId: string): string {
  return join(root, agentId, 'MEMORY.md')
}

const KIND_HEADINGS: Array<{ kind: MemoryEntry['kind']; title: string }> = [
  { kind: 'commitment', title: '约定（答应过要做/不做的事）' },
  { kind: 'preference', title: '偏好（怎么对待人）' },
  { kind: 'fact', title: '事实（环境与项目的稳定事实）' },
  { kind: 'lesson', title: '教训（踩过的坑）' },
]

/**
 * 渲染镜像文件的内容。
 *
 * 顺序与**注入顺序**一致（`sortMemoryForInjection`）：人打开这个文件看到的顺序，
 * 就是它们进第一句话的顺序（第 266 批去掉字数预算之后，全部都会带上）。
 */
export function renderMemoryMirror(input: {
  agentName: string
  agentId: string
  entries: readonly MemoryEntry[]
}): string {
  const sorted = sortMemoryForInjection(input.entries)
  const lines: string[] = [
    `# 记忆：${input.agentName}`,
    '',
    '> ⚠️ 这是**平台自动写的镜像**，只供人阅读与追溯。真正的存储是 daemon 的 store，',
    '> 改这个文件**不会生效**——要改记忆，去「智能体 → 记忆」那一节（或聊天里用触发词）。',
    '',
    `agent：\`${input.agentId}\`　共 ${sorted.length} 条`,
    '',
  ]
  for (const { kind, title } of KIND_HEADINGS) {
    const group = sorted.filter((entry) => entry.kind === kind)
    if (group.length === 0) continue
    lines.push(`## ${title}`, '')
    for (const entry of group) {
      const star = entry.pinned ? ' ★' : ''
      const used =
        entry.useCount === 0 ? '还没用过' : `用过 ${entry.useCount} 次`
      const from = entry.evidence === undefined ? '' : `　出处 run ${entry.evidence}`
      lines.push(`- ${entry.text}${star}`, `  - ${used}${from}`)
    }
    lines.push('')
  }
  if (sorted.length === 0) lines.push('（还没有记忆）', '')
  return lines.join('\n')
}

export type MirrorSyncResult = {
  path: string
  /** 版本管理（git）可用与否；不可用时 `note` 说清原因——**镜像照写**。 */
  versioning: { enabled: boolean; note?: string }
}

/**
 * 把某个 agent 当前的记忆落到镜像文件，并（git 可用时）提交一条。
 *
 * 镜像写失败**不打断**调用方：它是给人看的附带产物，而记忆本身已经落到 store 里了。
 * 但 git 失败要说清楚（与技能那一套同一条规矩：可用性开关 + 降级说明）。
 */
export async function syncMemoryMirror(input: {
  store: Store
  workspaceId: MemoryEntry['workspaceId']
  agentId: MemoryEntry['agentId']
  agentName: string
  root: string
  /** 注入给测试用（生产走 PATH 里的 `git`）：与技能那一套同一把假 git 夹具。 */
  gitPath?: string
}): Promise<MirrorSyncResult> {
  const all = await input.store.listMemoryEntries(input.workspaceId, input.agentId)
  const alive = all.filter((entry) => entry.removedAt === null)
  const path = memoryFilePath(input.root, input.agentId as string)
  await mkdir(join(input.root, input.agentId as string), { recursive: true })
  await writeFile(
    path,
    renderMemoryMirror({ agentName: input.agentName, agentId: input.agentId as string, entries: alive }),
    'utf8',
  )

  const probe = await probeGit(input.gitPath)
  if (!probe.available) {
    return { path, versioning: { enabled: false, note: '版本管理未启用（系统无 git），记忆照常、无历史回退' } }
  }
  const ensure = await ensureMineRepo(input.root, input.gitPath)
  if (!ensure.ok) {
    return { path, versioning: { enabled: false, note: `版本管理未启用：${ensure.reason}` } }
  }
  const committed = await commitMine(
    input.root,
    `memory ${input.agentName}（${alive.length} 条）`,
    input.gitPath,
  )
  if (!committed.ok) {
    return { path, versioning: { enabled: false, note: `git 提交失败（已降级）：${committed.reason}` } }
  }
  return { path, versioning: { enabled: true } }
}
