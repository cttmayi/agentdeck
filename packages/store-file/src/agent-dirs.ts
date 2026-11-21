import { join } from 'node:path'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import type { Agent } from '@agentdeck/protocol'
import { slugForAgentName, uniqueAgentDirName } from './agent-slug.ts'
import { atomicWrite, ensureDir, exists, readJsonOrNull, removeQuietly } from './fs-utils.ts'

/**
 * ★ 2026-11（D111，设计定稿 `docs/design/agent-directory.md`）：
 * **一个智能体 = 一个目录**。目录是智能体**唯一的真相**，与 JSONL 那条老路彻底分家：
 *
 *   agents/<目录名>/agent.json          ← 结构化资讯（不含指令正文；**`id` 在这里**）
 *   agents/<目录名>/instructions.md     ← 指令**组装前**正文（内置 = 身份块；自建 = 全文）
 *   agents/<目录名>/skills/<slug>/SKILL.md ← 这个智能体**独有的**技能（文件资产，不进技能库）
 *
 * ★★ D231（2026-11，方案 D）：**目录名 = 名字的 slug，不再是 id**。
 *
 *   目录名是**给人看的标签**（`agents/助手审核员/`），身份仍是 `agent.json` 里的 `id`
 *   （ULID，永不变）。于是：
 *     · 改名 = 改 `name` + 改目录名，**8 处引用一个都不动**（id 没变）；
 *     · 目录名是**可重算**的（`slugForAgentName(name)`），所以对账能发现"有人在别处改过"；
 *     · 解析不能靠拼路径了 ⇒ 由 `file-store.ts` 维护 `id → 目录名` 的内存索引
 *       （miss 时全量扫一次，磁盘是真相、内存只是缓存）。
 *
 *   ⚠️ 本文件的函数因此**一律吃"目录名"**（`dirName`），不再吃 id。谁有 id、
 *      谁就得先把它解析成目录名——那件事只有 `file-store.ts` 会做。
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

/** 一个智能体的目录（参数是**目录名**，不是 id——见文件头 D231）。 */
export function agentDirPath(dataDir: string, dirName: string): string {
  return join(agentsRoot(dataDir), dirName)
}

/** 结构化资讯落点（不含指令正文）。 */
function agentJsonPath(dataDir: string, dirName: string): string {
  return join(agentDirPath(dataDir, dirName), 'agent.json')
}

/** 指令正文落点（组装前）。 */
function instructionsMdPath(dataDir: string, dirName: string): string {
  return join(agentDirPath(dataDir, dirName), 'instructions.md')
}

/**
 * 独有技能根（这个智能体自己的技能文件）。
 *
 * ★ D228：`agent` 这一种来源的路径由**本文件**负责（它拥有智能体目录的形状）；
 *   另一种来源（编排内建智能体，`workflows/<wid>/agents/<名字>/skills/`）的形状归
 *   `apps/daemon/src/workflows-dirs.ts`，由 daemon 在装配时把解析函数注入进来
 *   （`FileStoreOptions.exclusiveSkillsDir`）。这样"谁知道路径"仍然只有一处。
 */
function skillsDir(dataDir: string, dirName: string): string {
  return join(agentDirPath(dataDir, dirName), 'skills')
}

/** 导出给 `FileStore` 拼 `owner.kind === 'agent'` 的目录（别的包别自己拼）。 */
export function agentExclusiveSkillsDir(dataDir: string, dirName: string): string {
  return skillsDir(dataDir, dirName)
}

function skillMdPath(dataDir: string, dirName: string, slug: string): string {
  return join(skillsDir(dataDir, dirName), slug, 'SKILL.md')
}

/**
 * 把一条 `Agent` 落成目录：agent.json（结构化，不含指令）+ instructions.md（组装前正文）。
 *
 * @param dirName 目录名（= 名字的 slug，D231）。调用方负责**唯一性**（`uniqueAgentDirName`）
 *   与"改名时把旧目录搬过来"——本函数只写内容，不搬目录。
 */
export async function writeAgentDir(
  dataDir: string,
  agent: Agent,
  dirName: string,
): Promise<void> {
  await ensureDir(agentDirPath(dataDir, dirName))
  const { instructions, ...structured } = agent
  await atomicWrite(agentJsonPath(dataDir, dirName), JSON.stringify(structured, null, 2))
  await atomicWrite(instructionsMdPath(dataDir, dirName), instructions)
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
export async function readAgentDirIn(dataDir: string, dirName: string): Promise<Agent | null> {
  const json = await readJsonOrNull<Record<string, unknown>>(agentJsonPath(dataDir, dirName))
  if (json === null) return null
  let instructions = ''
  try {
    instructions = await readFile(instructionsMdPath(dataDir, dirName), 'utf8')
  } catch {
    // instructions.md 缺失 ⇒ 空正文（损坏/手工删了）。由上层决定怎么处理。
  }
  /*
   * ⚠️ D231：**`id` 从 agent.json 里取**（以前是拿目录名当 id——名字当目录之后
   *   那条路就错了）。`agent.json` 里没有 id 的记录（手改坏了）退化成用目录名，
   *   总比"读不出这个智能体"好：它仍然能被解析、被改名修好。
   */
  const rawId = json['id']
  const id = typeof rawId === 'string' && rawId !== '' ? rawId : dirName
  return { ...(json as unknown as Agent), id: id as Agent['id'], instructions }
}

/**
 * 列出全部智能体目录（跨工作区；`workspaceId` 过滤由调用方做）。
 *
 * 返回**目录名**与记录（D231：目录名是标签，`agent.id` 是身份——两者不再是同一个东西，
 * 所以必须一起带出去，索引要靠它对上）。
 */
export async function listAgentDirs(
  dataDir: string,
): Promise<Array<{ dirName: string; agent: Agent }>> {
  let dirNames: string[]
  try {
    dirNames = await readdir(agentsRoot(dataDir))
  } catch {
    return []
  }
  const out: Array<{ dirName: string; agent: Agent }> = []
  for (const dirName of dirNames) {
    if (dirName.startsWith('.')) continue // 占位/元文件不读
    const agent = await readAgentDirIn(dataDir, dirName)
    if (agent) out.push({ dirName, agent })
  }
  /*
   * ★★ D231：**顺序必须是"创建先后"，不能是 `readdir` 的顺序**。
   *
   * 目录名变成名字之后，`readdir` 返回的是**按名字排**（还与语言环境有关）——
   * 于是同一个库在不同机器上、改一次名字之后，列表顺序就变了。实测代价：
   * 探针里"长名字那一行"从最后一行变成第一行，界面顺势把它选中、详情栏打开、
   * 列表变窄 ⇒ 它的副行换成两行 ⇒ 行高 96 而别人 64（一条本来与它无关的判据红了）。
   *
   * 按 `createdAt` 排（再用 id 兜底）与改之前"ULID 目录名天然按创建排"等价，
   * 而且**是显式的**：目录名怎么变，列表顺序都不动。
   */
  out.sort(
    (a, b) =>
      a.agent.createdAt - b.agent.createdAt || String(a.agent.id).localeCompare(String(b.agent.id)),
  )
  return out
}

/** 删掉整个智能体目录（连同它的独有技能文件）。 */
export async function removeAgentDirIn(dataDir: string, dirName: string): Promise<boolean> {
  const had = await exists(agentJsonPath(dataDir, dirName))
  await removeQuietly(agentDirPath(dataDir, dirName))
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
 * @returns 改名的智能体 id（调用方拿去打日志）；需要人看的冲突 / 失败也在这份里
 *
 * ⚠️ **单个智能体改名失败不抛**（Windows 上文件被占用是常态）：收进 `failed` 让调用方
 *    报出来，别的照改。迁移是"顺手把它改对"，不该因为一个目录被占用就让整个 daemon
 *    起不来——那是把装饰性的活当成了启动前提。
 */
export async function migrateExclusiveSkillsDirCase(dataDir: string): Promise<{
  renamed: string[]
  conflicts: string[]
  failed: Array<{ id: string; error: string }>
}> {
  const renamed: string[] = []
  const conflicts: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  let ids: string[]
  try {
    ids = await readdir(agentsRoot(dataDir))
  } catch {
    return { renamed, conflicts, failed } // 还没有 agents/ ⇒ 没什么可迁
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
    try {
      await rename(upper, tmp)
      await rename(tmp, lower)
      renamed.push(id)
    } catch (err) {
      failed.push({ id, error: String(err) })
      // 尽力把半途的临时目录还原回去，免得盘上多一个 `skills.tmp-*`
      try {
        await rename(tmp, upper)
      } catch {
        // 还原也失败 ⇒ 原样留着（数据没动，只是名字怪），由调用方点名
      }
    }
  }
  return { renamed, conflicts, failed }
}

/** 列出这个目录下的独有技能（名字 + 正文）。目录由调用方按来源解析（D228）。 */
export async function listExclusiveSkillBodiesIn(
  skillsDirectory: string,
): Promise<Array<{ name: string; body: string }>> {
  let names: string[]
  try {
    names = await readdir(skillsDirectory)
  } catch {
    return []
  }
  const out: Array<{ name: string; body: string }> = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    try {
      const body = await readFile(join(skillsDirectory, name, 'SKILL.md'), 'utf8')
      out.push({ name, body })
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
 * 编排内建智能体走 `workflows/<wid>/agents/<名字>/skills/`（D235）——**同一份实现**
 * 服务两种来源，路径形状仍然只有各自的拥有者知道。
 */
export async function getExclusiveSkillBodyIn(
  skillsDirectory: string,
  name: string,
): Promise<string | null> {
  try {
    return await readFile(join(skillsDirectory, name, 'SKILL.md'), 'utf8')
  } catch {
    return null
  }
}

export async function writeExclusiveSkillBodyIn(
  skillsDirectory: string,
  name: string,
  body: string,
): Promise<void> {
  await ensureDir(join(skillsDirectory, name))
  await atomicWrite(join(skillsDirectory, name, 'SKILL.md'), body)
}

export async function removeExclusiveSkillBodyIn(
  skillsDirectory: string,
  name: string,
): Promise<boolean> {
  const had = await exists(join(skillsDirectory, name, 'SKILL.md'))
  await removeQuietly(join(skillsDirectory, name))
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
  dirName: string,
): Promise<void> {
  await ensureDir(agentDirPath(dataDir, dirName))
  const { instructions, ...structured } = agent
  await atomicWrite(
    agentJsonPath(dataDir, dirName),
    JSON.stringify(
      { ...structured, instructionsAssembled: agent.builtin === true },
      null,
      2,
    ),
  )
  await atomicWrite(instructionsMdPath(dataDir, dirName), instructions)
}

/**
 * **把"用 id 命名的老目录"改成"用名字命名的目录"**（D231，一次性迁移）。
 *
 * 改之前：`agents/01M72Y8XZRYQ0F643Z3Y2N8A1D/`
 * 改之后：`agents/智能体生成者/`
 *
 * 三条口径：
 *   · **只改目录名，什么都不动**：`agent.json` 里的 `id` 一个字都不改 ⇒
 *     run / issue / conversation 里那些引用**全部照旧有效**（这是方案 D 相对
 *     "名字当键" 的最大收益）；
 *   · **幂等**：目录名已经等于 `slug(name)` 就跳过（所以重跑安全）；
 *   · **两步 rename**：先 `<目标>.tmp-<随机>` 再目标名（macOS 大小写不敏感，
 *     直接改大小写会 EEXIST——D229 踩过）。
 *
 * 撞名（两个名字算出同一个 slug，如 `写作员` 与 `写作 员`）⇒ 加 `-2` / `-3` 后缀，
 * 并在返回值里报出来。**不合并、不猜**。
 */
export async function migrateAgentDirsToNames(dataDir: string): Promise<{
  renamed: Array<{ from: string; to: string; id: string }>
  conflicts: string[]
  failed: Array<{ dirName: string; error: string }>
}> {
  const renamed: Array<{ from: string; to: string; id: string }> = []
  const conflicts: string[] = []
  const failed: Array<{ dirName: string; error: string }> = []
  let dirNames: string[]
  try {
    dirNames = await readdir(agentsRoot(dataDir))
  } catch {
    return { renamed, conflicts, failed } // 还没有 agents/ ⇒ 没什么可迁
  }

  // 先把现有目录读一遍：拿到每个目录的 id 与名字（读不出来的跳过，交给对账）
  const entries: Array<{ dirName: string; id: string; name: string }> = []
  for (const dirName of dirNames) {
    if (dirName.startsWith('.')) continue
    const agent = await readAgentDirIn(dataDir, dirName)
    if (agent === null) continue
    entries.push({ dirName, id: String(agent.id), name: String(agent.name ?? dirName) })
  }

  /*
   * `taken` 的初值是**所有已经不需要改的目录名**（已经是 slug 的那些）。
   * 逐个迁的时候把新名字也加进去——否则两个"待迁"的名字可能算出同一个 slug 而撞车。
   */
  const taken = new Set<string>()
  const pending: typeof entries = []
  for (const e of entries) {
    if (e.dirName === slugForAgentName(e.name)) taken.add(e.dirName)
    else pending.push(e)
  }

  for (const e of pending) {
    const target = uniqueAgentDirName(e.name, taken)
    if (target.toLowerCase() === e.dirName.toLowerCase() && target !== e.dirName) {
      // 只有大小写不同（APFS 上其实是同一个目录）⇒ 仍然走两步 rename 把大小写改对
    }
    const from = agentDirPath(dataDir, e.dirName)
    const to = agentDirPath(dataDir, target)
    const tmp = `${to}.tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    try {
      await rename(from, tmp)
      await rename(tmp, to)
      taken.add(target)
      renamed.push({ from: e.dirName, to: target, id: e.id })
      if (target !== slugForAgentName(e.name)) conflicts.push(`${e.name} → ${target}（slug 撞名）`)
    } catch (err) {
      failed.push({ dirName: e.dirName, error: String(err) })
      // 尽力还原，别留一个 `xxx.tmp-*`
      try {
        await rename(tmp, from)
      } catch {
        // 还原也失败 ⇒ 原样留着（数据没动，只是名字怪），由调用方点名
      }
    }
  }
  return { renamed, conflicts, failed }
}

/** 给目录化迁移用的判断：这个**目录名**已经有记录了（幂等：迁过的不重迁）。 */
export async function agentDirExists(dataDir: string, dirName: string): Promise<boolean> {
  return (await readJsonOrNull(agentJsonPath(dataDir, dirName))) !== null
}
