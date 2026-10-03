import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { SkillSourceError, parseGithubProxy, resolveGithubUrl } from '@agentdeck/skill-source'

/**
 * 远端目录的**本地层**（手动安装的技能，D52）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是**另一个目录**，而不是写进同步目录
 * ══════════════════════════════════════════════════════════════════
 *
 * 同步目录（`<dataDir>/catalog-skills`）的内容归**同步工具**所有：它是整目录
 * 原子替换的（"失败就一个字都不改"）。手动往里塞一条，**下次同步就没了**——
 * 而且那种消失是静默的（界面只是少了一条）。
 *
 * 所以手动装的走**独立一层**（`<dataDir>/catalog-skills-local`）：
 *
 *   · 两个目录各有各的 `.sync.json`，**谁也不改谁**；
 *   · 读取时**合并成一份**给页面看（同步来的 + 本地添加的），每条标出来源；
 *   · 同名冲突时**同步来的优先**（那是维护者在清单里核过的），本地那条不列出
 *     并记一条 warning——"被顶掉了"要说出来，不能让它在目录里变成隐形条目。
 *
 * ══════════════════════════════════════════════════════════════════
 * 取包用的是**同一份规则**
 * ══════════════════════════════════════════════════════════════════
 *
 * `resolveGithubUrl`（`@agentdeck/skill-source`）——主机白名单、https、每跳校验、
 * 限额、必须有 `SKILL.md`、slug 怎么收敛，与 daemon 装技能、同步工具抓清单**完全
 * 一致**。所以"远端目录里能装的东西"与"daemon 装得进来的东西"永远是同一集合。
 */

/** 本地层的索引文件名——与同步目录同一个名字，好让 `loadCatalogSkills` 直接读。 */
const INDEX_FILE = '.sync.json'

export interface LocalSkillItem {
  url: string
  slug: string
  name: string
  category: string
  origin: 'official' | 'community'
  summary: string
  fills: string | null
  needs: string | null
  sourceRef: string
  version: string | null
  fetchedAt: string
  files: string[]
  excluded: string[]
  /** ★ 标记：这条是**手动装的**（同步工具永远不写它，页面据此显示来源与卸载按钮）。 */
  manual: true
}

interface LocalIndex {
  schema: 'agentdeck/recommended-skills-sync@1'
  syncedAt: string
  items: LocalSkillItem[]
}

async function readIndex(root: string): Promise<LocalIndex> {
  try {
    const parsed = JSON.parse(await readFile(join(root, INDEX_FILE), 'utf8')) as LocalIndex
    return { schema: 'agentdeck/recommended-skills-sync@1', syncedAt: parsed.syncedAt ?? '', items: Array.isArray(parsed.items) ? parsed.items : [] }
  } catch {
    // 还没有本地层：空目录是**真话**，不是错误
    return { schema: 'agentdeck/recommended-skills-sync@1', syncedAt: '', items: [] }
  }
}

async function writeIndex(root: string, index: LocalIndex): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}

/** 本地层里已装的条目（页面与卸载都要用它）。 */
export async function listLocalSkills(root: string): Promise<LocalSkillItem[]> {
  return (await readIndex(root)).items
}

export interface InstallLocalInput {
  url: string
  name?: string
  summary?: string
  needs?: string | null
  category?: string
  /** 注入 fetch 以便测试（NFR-T-01：测试绝不联网）。 */
  fetchImpl?: typeof fetch
  now?: () => Date
  /** 已经存在的 slug（同步目录里的也算）：撞上就拒绝，并说清撞在哪儿。 */
  takenSlugs: ReadonlySet<string>
}

/**
 * 从 GitHub 链接**手动装一条**进本地层。
 *
 * ★ 撞名一律拒绝（不覆盖）：技能库按 slug 唯一，静默顶掉一条别人正在用的东西，
 *   症状是"某个 agent 的参考突然变了"——那是很久以后才会被发现的那种坏。
 */
export async function installLocalSkill(
  root: string,
  input: InstallLocalInput,
): Promise<LocalSkillItem> {
  const now = input.now ?? (() => new Date())
  const proxy = parseGithubProxyOrNull(process.env['AGENTDECK_GITHUB_PROXY'])
  const token = process.env['AGENTDECK_GITHUB_TOKEN']

  const resolved = await resolveGithubUrl(
    input.url,
    {},
    {
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(token ? { githubToken: token } : {}),
      ...(proxy ? { githubProxy: proxy } : {}),
    },
  )

  if (input.takenSlugs.has(resolved.slug)) {
    throw new LocalSkillConflict(resolved.slug)
  }

  const files: Record<string, string> = { 'SKILL.md': resolved.body, ...resolved.files }
  // ★ 先写临时目录再换名：中途失败不会留下"半个技能"（同同步工具那套原子替换）
  const staging = `${join(root, resolved.slug)}.staging`
  await rm(staging, { recursive: true, force: true })
  for (const [rel, text] of Object.entries(files)) {
    const target = join(staging, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text, 'utf8')
  }
  await mkdir(root, { recursive: true })
  await rm(join(root, resolved.slug), { recursive: true, force: true })
  await rename(staging, join(root, resolved.slug))

  const item: LocalSkillItem = {
    url: input.url,
    slug: resolved.slug,
    name: input.name?.trim() || resolved.slug,
    category: input.category?.trim() || 'other',
    origin: 'community',
    summary: input.summary?.trim() || '',
    fills: null,
    needs: typeof input.needs === 'string' && input.needs.trim() !== '' ? input.needs.trim() : null,
    sourceRef: resolved.sourceRef,
    // 版本留空：这里没有"取上游提交"那一步（同步工具才有）。界面遇到 null 会如实说
    // "无法判断是不是同一份内容"，而不是编一个版本号。
    version: null,
    fetchedAt: now().toISOString(),
    files: Object.keys(files).sort(),
    excluded: resolved.excluded.map((e) => e.path),
    manual: true,
  }
  const index = await readIndex(root)
  await writeIndex(root, {
    ...index,
    syncedAt: now().toISOString(),
    items: [...index.items.filter((i) => i.slug !== item.slug), item],
  })
  return item
}

/** 卸载一条**本地装的**。同步来的不在这一层，删不到（调用方先行判断）。 */
export async function uninstallLocalSkill(root: string, slug: string): Promise<boolean> {
  const index = await readIndex(root)
  const hit = index.items.find((i) => i.slug === slug)
  if (!hit) return false
  await rm(join(root, slug), { recursive: true, force: true })
  await writeIndex(root, {
    ...index,
    syncedAt: new Date().toISOString(),
    items: index.items.filter((i) => i.slug !== slug),
  })
  return true
}

/** 撞名（本地层里、或同步目录里已经有了）。带上 slug，调用方要说清撞在哪儿。 */
export class LocalSkillConflict extends Error {
  readonly slug: string
  constructor(slug: string) {
    super(`已经有一个叫「${slug}」的技能了`)
    this.name = 'LocalSkillConflict'
    this.slug = slug
  }
}

/** 取包失败时的原话（`SkillSourceError` 自带 detail，一起给出去）。 */
export function describeInstallError(err: unknown): string {
  if (err instanceof SkillSourceError) {
    return `${err.message}${err.detail ? ` —— ${err.detail}` : ''}`
  }
  return err instanceof Error ? err.message : String(err)
}

function parseGithubProxyOrNull(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null
  try {
    return parseGithubProxy(raw.trim())
  } catch {
    // 配置错了不该让"装一条技能"整个不可用：这里降级为不用加速器，
    // 而**启动时**那条校验（`apps/remote/src/cli.ts`）已经把错报出来了。
    return null
  }
}
