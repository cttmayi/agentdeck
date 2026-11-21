import { join } from 'node:path'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import type { Agent, AgentId } from '@agentdeck/protocol'
import { atomicWrite, ensureDir, exists, readJsonOrNull, removeQuietly } from './fs-utils.ts'

/**
 * ★ 2026-11（D111，设计定稿 `docs/design/agent-directory.md`）：
 * **一个智能体 = 一个目录**——`<dataDir>/agents/<id>/`。
 *
 * 目录是智能体**唯一的真相**，与 JSONL 那条老路彻底分家：
 *
 *   agents/<id>/agent.json          ← 结构化资讯（不含指令正文）
 *   agents/<id>/instructions.md     ← 指令**组装前**正文（内置 = 身份块；自建 = 全文）
 *   agents/<id>/skills/<slug>/SKILL.md ← 这个智能体**独有的**技能（文件资产，不进技能库）
 *
 * 为什么目录而不是 JSONL（使用者的决定，逐条记在这里，防倒退）：
 *
 *   · 内置与自建**同形**——生成之后都是"一个目录"，区别只在 `agent.json` 里的
 *     `builtin` 标记，不再有"内置是代码常量、自建是记录"的两套形态；
 *   · 人可以直接打开目录读/改（md 是给人看的，json 是给机器看的，分开）；
 *   · 技能分两类、**没有镜像**：独有的技能就是目录里的文件（不进技能库、不进
 *     技能页、不可卸载）；共享的技能仍在技能库，智能体用 `skillIds` 引用。
 *
 * ⚠️ 读写都在这里，`file-store.ts` 只做薄封装——不要绕过本文件直接碰目录。
 */

/** 智能体目录的根（与 `skills/`、`skills-mine/` 并列，使用者的决定）。 */
export function agentsRoot(dataDir: string): string {
  return join(dataDir, 'agents')
}

export function agentDirPath(dataDir: string, id: AgentId | string): string {
  return join(agentsRoot(dataDir), String(id))
}

/** 结构化资讯落点（不含指令正文）。 */
function agentJsonPath(dataDir: string, id: AgentId | string): string {
  return join(agentDirPath(dataDir, id), 'agent.json')
}

/** 指令正文落点（组装前）。 */
function instructionsMdPath(dataDir: string, id: AgentId | string): string {
  return join(agentDirPath(dataDir, id), 'instructions.md')
}

/**
 * 独有技能根（这个智能体自己的技能文件）。
 *
 * ★ D228：`agent` 这一种来源的路径由**本文件**负责（它拥有智能体目录的形状）；
 *   另一种来源（编排内建智能体，`workflows/<wid>/agents/<aid>/skills/`）的形状归
 *   `apps/daemon/src/workflows-dirs.ts`，由 daemon 在装配时把解析函数注入进来
 *   （`FileStoreOptions.exclusiveSkillsDir`）。这样"谁知道路径"仍然只有一处。
 */
function skillsDir(dataDir: string, id: AgentId | string): string {
  return join(agentDirPath(dataDir, id), 'skills')
}

/** 导出给 `FileStore` 拼 `owner.kind === 'agent'` 的目录（别的包别自己拼）。 */
export function agentExclusiveSkillsDir(dataDir: string, id: AgentId | string): string {
  return skillsDir(dataDir, id)
}

function skillMdPath(dataDir: string, id: AgentId | string, slug: string): string {
  return join(skillsDir(dataDir, id), slug, 'SKILL.md')
}

/** 把一条 `Agent` 落成目录：agent.json（结构化，不含指令）+ instructions.md（组装前正文）。 */
export async function writeAgentDir(dataDir: string, agent: Agent): Promise<void> {
  const dir = agentDirPath(dataDir, agent.id)
  await ensureDir(dir)
  const { instructions, ...structured } = agent
  await atomicWrite(agentJsonPath(dataDir, agent.id), JSON.stringify(structured, null, 2))
  await atomicWrite(instructionsMdPath(dataDir, agent.id), instructions)
}

/**
 * 从目录读回一条 `Agent`。
 *
 * `instructions` 恒为 **instructions.md 的内容**（组装前正文）——组装（平台守则）
 * 在 daemon 读取端做（`effectiveInstructions`），这里不拼。
 *
 * ⚠️ 目录损坏（agent.json 读不到）⇒ 返回 null（"没有这个智能体"）；
 *    instructions.md 读不到 ⇒ 正文空（`ensure` 会自愈内置；自建的会露出"指令空"）。
 */
export async function readAgentDir(dataDir: string, id: AgentId | string): Promise<Agent | null> {
  const json = await readJsonOrNull<Record<string, unknown>>(agentJsonPath(dataDir, id))
  if (json === null) return null
  let instructions = ''
  try {
    instructions = await readFile(instructionsMdPath(dataDir, id), 'utf8')
  } catch {
    // instructions.md 缺失 ⇒ 空正文（损坏/手工删了）。由上层决定怎么处理。
  }
  return { ...(json as Agent), id: String(id) as Agent['id'], instructions }
}

/** 列出全部智能体目录（跨工作区；`workspaceId` 过滤由调用方做）。 */
export async function listAgentDirs(dataDir: string): Promise<Agent[]> {
  let ids: string[]
  try {
    ids = await readdir(agentsRoot(dataDir))
  } catch {
    return []
  }
  const out: Agent[] = []
  for (const id of ids) {
    if (id.startsWith('.')) continue // 占位/元文件不读
    const agent = await readAgentDir(dataDir, id)
    if (agent) out.push(agent)
  }
  return out
}

/** 删掉整个智能体目录（连同它的独有技能文件）。 */
export async function removeAgentDir(dataDir: string, id: AgentId | string): Promise<boolean> {
  const had = await exists(agentJsonPath(dataDir, id))
  await removeQuietly(agentDirPath(dataDir, id))
  return had
}

// ── 独有技能（Agent skills/ 下的文件资产，不进技能库）──

/** 目录在不在（`exists()` 走的是 `readFile`，对目录恒 false，见下面那条注释）。 */
async function dirExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

/**
 * **把老的 `SKILL/` 目录名改成小写 `skills/`**（D229，2026-11 使用者："SKILL 目录名改小写
 * skills 吧"）。
 *
 * 两件事要一起做对：
 *
 *   ① **大小写只差一个字母的重命名在 macOS 上会踩坑**：APFS 默认大小写不敏感，
 *      `rename('SKILL','skills')` 在那边可能报 `EEXIST` / `ENOTEMPTY`（目标"已存在"——
 *      其实就是它自己）。所以走**两步**：先改成 `skills.tmp-<随机>`，再改成 `skills`。
 *      两步都在同一个父目录里，任何一步失败都不会丢数据（最多留下一个 `.tmp-` 目录，
 *      下次启动会再试）。
 *
 *   ② **幂等 + 不猜**：`skills/` 已经在了就跳过（已经是新名字，或手工建过）；两个都在
 *      （比如从备份里拷回来一份）**不合并、不动手**，把 id 报给调用方去喊人——
 *      合并技能目录是"猜哪一份对"，本仓库不做这种事。
 *
 * @returns 改名的智能体 id（调用方拿去打日志）；需要人看的冲突也在这份里
 */
export async function migrateExclusiveSkillsDirCase(
  dataDir: string,
): Promise<{ renamed: string[]; conflicts: string[] }> {
  const renamed: string[] = []
  const conflicts: string[] = []
  let ids: string[]
  try {
    ids = await readdir(agentsRoot(dataDir))
  } catch {
    return { renamed, conflicts } // 还没有 agents/ ⇒ 没什么可迁
  }
  for (const id of ids) {
    if (id.startsWith('.')) continue
    const upper = join(agentDirPath(dataDir, id), 'SKILL')
    const lower = join(agentDirPath(dataDir, id), 'skills')
    // ⚠️ 这里必须用 `stat`，不能用本包的 `exists()`——那个是 `readFile` 实现的，
    //    对**目录**恒返回 false（读目录会 EISDIR）。这个坑当场踩过：迁移"成功"了
    //    但一条都没改，测试里表现为 listExclusiveSkills 读不到任何技能。
    const hasUpper = await dirExists(upper)
    if (!hasUpper) continue // 没有老目录（新库/已迁过）
    if (await dirExists(lower)) {
      conflicts.push(id) // 两个都在 ⇒ 不合并，喊人
      continue
    }
    const tmp = `${lower}.tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    await rename(upper, tmp)
    await rename(tmp, lower)
    renamed.push(id)
  }
  return { renamed, conflicts }
}

/** 列出这个目录下的独有技能（slug + 正文）。目录由调用方按来源解析（D228）。 */
export async function listExclusiveSkillBodiesIn(
  skillsDirectory: string,
): Promise<Array<{ slug: string; body: string }>> {
  let slugs: string[]
  try {
    slugs = await readdir(skillsDirectory)
  } catch {
    return []
  }
  const out: Array<{ slug: string; body: string }> = []
  for (const slug of slugs) {
    if (slug.startsWith('.')) continue
    try {
      const body = await readFile(join(skillsDirectory, slug, 'SKILL.md'), 'utf8')
      out.push({ slug, body })
    } catch {
      // 某个 SKILL.md 缺失 ⇒ 跳过（独有技能不是共享技能，缺一个不该让整个列表失败）
    }
  }
  return out
}

/*
 * ★ D228：下面三个（连同上面的 list）改成**吃目录**的 "In" 版。
 *
 * 原先是 `(dataDir, agentId, slug)`——路径在里面拼死。改成吃目录之后，
 * "这份技能文件属于谁、它的目录在哪"由调用方（`FileStore`）按
 * `ExclusiveSkillOwner` 解析：账号智能体走 `agents/<id>/skills/`，
 * 编排内建智能体走 `workflows/<wid>/agents/<aid>/skills/`——**同一份实现**
 * 服务两种来源，路径形状仍然只有各自的拥有者知道。
 */
export async function getExclusiveSkillBodyIn(
  skillsDirectory: string,
  slug: string,
): Promise<string | null> {
  try {
    return await readFile(join(skillsDirectory, slug, 'SKILL.md'), 'utf8')
  } catch {
    return null
  }
}

export async function writeExclusiveSkillBodyIn(
  skillsDirectory: string,
  slug: string,
  body: string,
): Promise<void> {
  await ensureDir(join(skillsDirectory, slug))
  await atomicWrite(join(skillsDirectory, slug, 'SKILL.md'), body)
}

export async function removeExclusiveSkillBodyIn(
  skillsDirectory: string,
  slug: string,
): Promise<boolean> {
  const had = await exists(join(skillsDirectory, slug, 'SKILL.md'))
  await removeQuietly(join(skillsDirectory, slug))
  return had
}

/**
 * 迁移用的内部落盘：老 JSONL 记录 → 目录。
 *
 * 与 `writeAgentDir` 唯一差别：老记录里内置的指令是**组装后**的（平台守则已经
 * 拼在末尾），正文原样落 md、`instructionsAssembled: true`——读取端靠这个标记
 * 决定不再拼一遍（拼两遍 = 守则出现两次）。自建的老记录恒为 false。
 */
export async function writeLegacyAgentDir(
  dataDir: string,
  agent: Agent & { id: string },
): Promise<void> {
  const dir = agentDirPath(dataDir, agent.id)
  await ensureDir(dir)
  const { instructions, ...structured } = agent
  await atomicWrite(
    agentJsonPath(dataDir, agent.id),
    JSON.stringify(
      { ...structured, instructionsAssembled: agent.builtin === true },
      null,
      2,
    ),
  )
  await atomicWrite(instructionsMdPath(dataDir, agent.id), instructions)
}

/** 给目录化迁移用的判断：id 对应目录是否已经存在（幂等：迁过的不重迁）。 */
export async function agentDirExists(dataDir: string, id: AgentId | string): Promise<boolean> {
  return (await readJsonOrNull(agentJsonPath(dataDir, id))) !== null
}
