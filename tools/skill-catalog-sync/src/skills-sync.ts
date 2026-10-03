import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import {
  assertValidPathPatterns,
  githubRequestTarget,
  parseGithubUrl,
  resolveGithubUrl,
  resolveLocalPath,
  SkillSourceError,
} from '@agentdeck/skill-source'

/**
 * `sync-skills`：把**推荐清单**里的 GitHub 技能抓下来，放进公共目录。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么由远端来抓，而不是让每个使用者的 daemon 各自去 GitHub 取
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者的本机不一定能到 GitHub（公司代理、匿名限额 60 次/小时、要不要给令牌）。
 * 而"推荐"这条路本来就不该把这些当成前提。远端抓一次、集中校验、放进目录，
 * 使用者本机走的是既有的**payload 安装**（远端把内容交下来、daemon 再校验一遍），
 * 全程不需要出网。
 *
 * ★ **抓取规则与 daemon 装技能时是同一份实现**（`@agentdeck/skill-source`）：
 *   主机白名单、每跳校验、限额、必须有 `SKILL.md`、slug 怎么收敛——全都一样。
 *   各写一份就会长出这个仓库最忌讳的那种不一致（"远端说 A、daemon 按 B"），
 *   而这一次的后果特别具体：**远端会把一份 daemon 装不进来的东西列成"推荐"**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 两条硬规矩
 * ══════════════════════════════════════════════════════════════════
 *
 * **① 抓下来的内容**不进代码仓库：它落在远端的数据目录里（`<dataDir>/catalog-skills`），
 *    与插件、账号数据同一个地盘。清单（只有 URL 与我们自己写的说明）才在仓库里。
 *
 * **② 任一环节失败 ⇒ 一个字都不替换**（P7：宁可失败，不可静默降级）。半份目录
 *    比旧目录更糟：使用者会点一个"看起来能装、其实是半截"的条目，而维护者以为
 *    同步成功了。抓取全部成功才原子替换，失败就原样留着并大声报错。
 */

/**
 * 清单里的一条可以声明 **include / exclude**（可选）：
 *
 * ```json
 * { "url": "https://github.com/owner/repo", "exclude": ["docs/**", "assets/*.png"], … }
 * ```
 *
 * ★ 为什么这是"声明"而不是"自动判断"（2026-10 使用者问："类似这样的仓库（包括大量的
 *   其他文件），我有什么好的办法区分哪些是必须的吗？"）：**技能格式本身没有"必须文件
 *   清单"**（`SKILL.md` 的 frontmatter 不声明依赖）。实测两个真仓后可以看到，任何单一
 *   自动判据都会判错：
 *     · `op7418/guizang-ppt-skill`：`assets/` 13 个里只有 3 个被引用，超限的展示图
 *       （3.5 MB）与背景图**没人引用** ⇒ 可以排除；
 *     · `lewislulu/html-ppt-skill`：`assets/` 70 个**全部**被引用（所以"assets 一律可丢"
 *       是错的），而 `docs/readme/**`（4.7 MB）与 `scripts/verify-output/**`（测试产物）
 *       没人引用 ⇒ 可以排除。
 *   所以：维护者读一次仓库、把决定写进清单，机器只执行——**可复核、可复现**。
 *   被排除的文件会逐个列出来（同步日志 + 装进来的记录 + 目录条目），绝不静默少文件。
 */
/** 推荐清单里的一条（维护者手写）。 */
export interface RecommendedItem {
  /** GitHub 链接（含目录）；仓库根也认。 */
  url: string
  /** 给人看的名字（列表里那一格）。 */
  name: string
  /** 粗分类：slides / docs / report / research。界面按它提示用途。 */
  category: string
  origin: 'official' | 'community'
  /** 一句话说明。 */
  summary: string
  /** 相对"你已经有的能力"补什么（没有就 null）。 */
  fills: string | null
  /** 装完还得自己配的东西（没有就 null）。**必须在装之前显示**。 */
  needs: string | null
  /** 只取匹配这些图案的文件（相对技能目录的 glob；`SKILL.md` 始终保留）。 */
  include?: string[]
  /** 跳过匹配这些图案的文件（相对技能目录的 glob；`SKILL.md` 不许被排除）。 */
  exclude?: string[]
}

export interface RecommendedManifest {
  verifiedAt: string
  items: RecommendedItem[]
}

/**
 * 同步索引里的一条：内容在磁盘上，这份记元数据。
 *
 * ★ 它 `extends RecommendedItem`，所以清单里的 `include`/`exclude` **也记在索引里**——
 *   这不是冗余：改过排除图案之后，旧内容（按旧图案抓的）**不该被复用**（见 `tryReuse`
 *   里那条比对），否则"我明明加了 exclude，怎么还是旧的那份"。
 */
export interface SyncIndexItem extends RecommendedItem {
  /** 由取包规则算出来的 slug——与 daemon 装出来的是同一个。 */
  slug: string
  /** 原始 GitHub 来源（`github:owner/repo@ref:dir`）。落库时原样交给 daemon，审计链指回上游。 */
  sourceRef: string
  /** 这份内容取自上游哪个提交（短 sha）。上游一动，它就不一样了。 */
  version: string | null
  /** 抓取时刻（ISO）。 */
  fetchedAt: string
  /** 包里带了哪些文件（相对路径），含 `SKILL.md`。 */
  files: string[]
  /**
   * 清单里排除了、**没有装进来**的文件（相对路径）。
   *
   * ⚠️ 这个字段要一路传到界面上：使用者得在**装之前**就知道"这一条的内容不完整"，
   *    而不是装完跑起来才发现少零件。
   */
  excluded: string[]
}

export interface SyncIndex {
  schema: 'agentdeck/recommended-skills-sync@1'
  syncedAt: string
  items: SyncIndexItem[]
}

export interface SyncReport {
  /** 计划/已写入的条目（新抓的 + 沿用本地那份的）。 */
  items: SyncIndexItem[]
  /**
   * 失败原因（**非空就不替换**）。
   *
   * ★ 2026-10 起**最多一条**：第一条失败就停（见 `stoppedEarly`）。撞限额时后面
   *   每一条都是同一句"匿名次数用完了"，继续试只会把一屏同样的话刷出来，而
   *   结论一个字都不会变。
   */
  failures: Array<{ url: string; reason: string }>
  /** 沿用了本地那份、**没有重新下载**的 slug（已发布目录 1 小时窗口内）。 */
  reused: string[]
  /** 沿用了**断点目录**那份、没有重新下载的 slug（上一轮抓过、还没发布的）。 */
  fromCheckpoint: string[]
  /** 因为第一条失败就停了（后面 `remaining` 条没有再试）。 */
  stoppedEarly: boolean
  /** 没有再试的条数（`stoppedEarly` 时才有意义）。 */
  remaining: number
  /** 不致命但要人知道的（比如取版本号失败、本地那份读不出来只好重抓）。 */
  warnings: string[]
  /** 真的替换了目录吗（`--dry-run` 与失败都是 false）。 */
  swapped: boolean
  dryRun: boolean
  /** **绝对路径**的落盘位置（`--out` 给相对路径时，这里给你它真正指的是哪儿）。 */
  skillsDir: string
  /** 断点目录的绝对路径（`<skillsDir>.partial`）。 */
  checkpointDir: string
  /** 失败停下时，断点目录里替下一轮攒着多少条。 */
  checkpointed: number
}

export interface SyncOptions {
  manifestPath: string
  /** 内容落盘的位置（**数据目录里**，不在代码仓库里）。 */
  skillsDir: string
  /** 注入 fetch 以便测试（NFR-T-01：测试绝不联网）。 */
  fetchImpl?: typeof fetch
  githubToken?: string | null
  now?: () => Date
  dryRun?: boolean
  log?: (line: string) => void
  /**
   * **复用窗口**：本地那份内容是这段时间内抓的，就不再下载（默认 1 小时，见
   * `REUSE_WINDOW_MS`）。设 0 = 不复用（每次都抓）。
   */
  reuseWindowMs?: number
  /** 忽略复用窗口，**全部重新下载**（想强制刷新上游内容时用）。 */
  refresh?: boolean
  /**
   * GitHub 加速器（`parseGithubProxy` 规范化过的）。不给 = 直连 GitHub。
   * ⚠️ 它是**第三方**：默认不用，由使用者在命令行/环境变量里显式指定。
   */
  githubProxy?: string | null
}

/** 读清单并做**形状**校验（坏清单要当场说清是哪一条坏）。 */
export async function readRecommendedManifest(path: string): Promise<RecommendedManifest> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  if (raw['schema'] !== 'agentdeck/recommended-skills@1') {
    throw new Error(`推荐清单的 schema 不是 agentdeck/recommended-skills@1：${path}`)
  }
  const items = raw['items']
  if (!Array.isArray(items)) throw new Error(`推荐清单缺少 items 数组：${path}`)
  const out: RecommendedItem[] = []
  const seen = new Set<string>()
  items.forEach((entry, i) => {
    const it = entry as Record<string, unknown>
    const url = it['url']
    if (typeof url !== 'string' || !url.startsWith('https://github.com/')) {
      throw new Error(`第 ${i + 1} 条的 url 必须是 https://github.com/… 的链接（收到 ${String(url)}）`)
    }
    if (seen.has(url)) throw new Error(`第 ${i + 1} 条与前面重复：${url}`)
    seen.add(url)
    for (const field of ['name', 'category', 'summary'] as const) {
      if (typeof it[field] !== 'string' || (it[field] as string).trim() === '') {
        throw new Error(`第 ${i + 1} 条缺 ${field}（它是列表里给人看的那一格）`)
      }
    }
    // `include` / `exclude`：形状与**语义**校验都交给共用取包规则（判据一处）——
    // 尤其"不许排除 SKILL.md"那条，写错了要当场报错，而不是抓出一个没有入口的"技能"。
    const where = `第 ${i + 1} 条（${url}）`
    const patterns: { include?: string[]; exclude?: string[] } = {}
    for (const field of ['include', 'exclude'] as const) {
      const raw = it[field]
      if (raw === undefined || raw === null) continue
      if (!Array.isArray(raw) || raw.some((p) => typeof p !== 'string')) {
        throw new Error(`${where} 的 ${field} 必须是字符串数组`)
      }
      const list = raw as string[]
      assertValidPathPatterns(list, field, where)
      patterns[field] = list
    }
    out.push({
      url,
      name: String(it['name']),
      category: String(it['category']),
      origin: it['origin'] === 'official' ? 'official' : 'community',
      summary: String(it['summary']),
      fills: typeof it['fills'] === 'string' ? it['fills'] : null,
      needs: typeof it['needs'] === 'string' ? it['needs'] : null,
      ...patterns,
    })
  })
  return { verifiedAt: typeof raw['verifiedAt'] === 'string' ? raw['verifiedAt'] : '', items: out }
}

/**
 * 上游那个目录**最近一次提交**的短 sha。
 *
 * ★ 为什么用提交而不是"抓取时间"：抓取时间每次重跑都不一样，于是"有没有更新"
 *   这条判据（界面拿它比本地版本）会在每次同步后都变成"有更新"——那种噪音会让
 *   使用者学会无视它。上游没动时 sha 不动，动了才变。
 * ⚠️ 取不到**不算失败**（匿名限额、网络抖动）：版本记 null 并记一条 warning——
 *   目录本身是好的，只是这一条没法比版本。
 */
async function latestCommitSha(
  url: string,
  deps: { fetchImpl: typeof fetch; githubToken?: string; githubProxy?: string | null },
  warn: (line: string) => void,
): Promise<string | null> {
  const target = parseGithubUrl(url)
  const q = target.dir ? `?path=${encodeURIComponent(target.dir)}&per_page=1` : '?per_page=1'
  const ref = target.ref ? `&sha=${encodeURIComponent(target.ref)}` : ''
  const api = `https://api.github.com/repos/${target.owner}/${target.repo}/commits${q}${ref}`
  // ★ 与取包规则**同一个判据**（`githubRequestTarget`）：走不走加速器、要不要带 token。
  //   这里原来自己拼地址、自己塞 authorization——两处各写一套就迟早会漂移
  //   （最坏的一种漂移是"这里还在把 token 交给第三方"）。
  const routed = githubRequestTarget(api, deps.githubProxy ?? null)
  try {
    const res = await deps.fetchImpl(routed.url, {
      headers: {
        accept: 'application/vnd.github+json',
        ...(routed.sendAuth && deps.githubToken
          ? { authorization: `Bearer ${deps.githubToken}` }
          : {}),
      },
    })
    if (!res.ok) {
      warn(`取版本号失败（HTTP ${res.status}）：${url}`)
      return null
    }
    const body = (await res.json()) as Array<{ sha?: string }>
    const sha = body[0]?.sha
    return typeof sha === 'string' && sha.length >= 7 ? sha.slice(0, 7) : null
  } catch (err) {
    warn(`取版本号失败（${err instanceof Error ? err.message : String(err)}）：${url}`)
    return null
  }
}

/**
 * 复用窗口：**本地那份是 1 小时内抓的就不再下载**（使用者 2026-10 的要求）。
 *
 * ★ 为什么要有这个窗口（不是省事，是省配额）：一条技能要花 **1 + 目录数 + 1** 次
 *   API 调用（实测 `pptx` 一条 **11 次**：52 个文件、9 个目录），而匿名限额只有
 *   60 次/小时——**12 条的清单在匿名下装不下一整轮**。撞限额之后重跑，如果从头再抓
 *   一遍，那个小时里就永远凑不齐：每次都把配额花在已经抓到的前几条上。有了窗口，
 *   重跑只会去抓缺的那几条（已抓到的沿用本地那份），于是**几次运行能收敛**。
 *
 * ⚠️ 代价说清楚：窗口内**不会**发现上游已经变了（那需要一次"取版本"调用，正是
 *   要省的那样东西）。所以重跑是"补齐缺的"，不是"看看有没有更新"——后者用
 *   `--refresh`，或者等窗口过去。
 */
export const REUSE_WINDOW_MS = 60 * 60 * 1000

/**
 * **断点目录**的后缀：`<out>.partial`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它（2026-10：我先前那句"撞墙后重跑会收敛"是错的）
 * ══════════════════════════════════════════════════════════════════
 *
 * 一开始只有"1 小时内抓过的不再下载"这一条复用规则，而它读的是**已发布目录**里的
 * `.sync.json`——那个文件只在**整轮成功**时才被写。于是撞限额时的真实循环是：
 *
 *     跑 → 抓到第 5 条撞墙 → **一个字都不写**（P7）→ 已抓到的 5 条一起丢掉
 *        → 下一轮从零开始 → 又撞在同一处
 *
 * 也就是说：**12 条在匿名限额下永远跑不完**，等多少个小时都一样（每条要 1+目录数+1
 * 次调用，实测 `pptx` 一条就 11 次，而匿名只有 60 次/小时）。
 *
 * 断点目录把"已发布"和"已抓到"分开：
 *
 *   · **已发布目录**（`<out>`）—— 界面读的那个。失败时**仍然一个字都不改**（P7 不破）。
 *   · **断点目录**（`<out>.partial`）—— 抓一条落一条。失败时它留着，下一轮只补缺的。
 *     整轮成功之后它就没用了（内容已经发布），**收尾时删掉**。
 *
 * ⚠️ 断点目录里的条目**不受 1 小时窗口管**（粘性）：那是**已经花过配额**换来的内容，
 *    只是还没装上。否则"跨小时续跑"又会退化成"从头再抓一遍"，而配额白花。
 *    已发布目录里的条目该不该重抓，仍然按 1 小时窗口（使用者定的规格）。
 *    `--refresh` 与 `--dry-run` 都无视断点（前者是"全部重新下载"，后者是逐条真抓一遍）。
 */
export const CHECKPOINT_SUFFIX = '.partial'

/** 上一次同步的索引，按 `url` 索引——复用要按清单里的 url 找对应的本地那份。 */
async function readPreviousIndex(
  skillsDir: string,
  warn: (line: string) => void,
): Promise<Map<string, SyncIndexItem>> {
  const map = new Map<string, SyncIndexItem>()
  let raw: string
  try {
    raw = await readFile(join(skillsDir, '.sync.json'), 'utf8')
  } catch {
    return map // 还没同步过：没有可复用的东西，不是错误
  }
  try {
    const parsed = JSON.parse(raw) as { items?: unknown }
    const list = Array.isArray(parsed.items) ? parsed.items : []
    for (const entry of list) {
      const rec = entry as Record<string, unknown>
      if (typeof rec['url'] === 'string' && typeof rec['slug'] === 'string') {
        map.set(rec['url'], rec as unknown as SyncIndexItem)
      }
    }
  } catch (err) {
    // ⚠️ 索引坏了 ⇒ 当作"没同步过"（全部重抓），并且**说出来**：它可能是被手改过，
    //   而"静默当作没同步过"会让下一次配额白花一轮。
    warn(`上一次的索引读不了（${err instanceof Error ? err.message : String(err)}）：这一次全部重新抓`)
  }
  return map
}

interface ReuseResult {
  entry: SyncIndexItem
  files: Record<string, string>
  ageMinutes: number
  /** `已发布` / `断点`——日志要说清这一条是从哪儿沿用的。 */
  source: string
}

/**
 * 这条能不能**沿用本地那一份**（不下载）？不能就返回 null，照常去抓。
 *
 * ⚠️ 复用不是"相信索引里那几行字"：内容必须**真的从磁盘上读回来、并且过一遍
 *   共用取包规则**（`resolveLocalPath`：有没有 `SKILL.md`、限额、能不能读）。
 *   目录被人手删/改坏时它会抛 ⇒ 返回 null 去重抓，而不是把一个坏目录继续当好的用。
 *
 * ⚠️ 文件内容**逐字节照搬磁盘上那份**（不经过任何重新拼装）：复用必须是"原样保留"，
 *   一旦在这里重新生成内容，磁盘上的东西就与上一次同步写下的悄悄不一样了。
 */
async function tryReuse(
  item: RecommendedItem,
  deps: {
    previous: Map<string, SyncIndexItem>
    /** 那份内容住在哪个目录下（已发布目录，或断点目录）。 */
    rootDir: string
    /** 复用窗口；传 `Infinity` = 粘性（断点目录：花过配额的不丢）。 */
    reuseWindowMs: number
    now: () => Date
    warn: (line: string) => void
    /** 日志用语：`已发布` / `断点`。 */
    source: string
  },
): Promise<ReuseResult | null> {
  const prev = deps.previous.get(item.url)
  if (!prev) return null

  // ★ 清单里的 include/exclude 变了 ⇒ **不复用**：那份内容是按**旧图案**抓的，
  //   沿用它会得到"我明明加了 exclude，结果还是旧的那份"这种说不清的状态。
  const samePatterns =
    (prev.include ?? []).join('|') === (item.include ?? []).join('|') &&
    (prev.exclude ?? []).join('|') === (item.exclude ?? []).join('|')
  if (!samePatterns) return null

  const age = deps.now().getTime() - Date.parse(prev.fetchedAt)
  // 时间读不出来（NaN）⇒ 当作过期：宁可多抓一次，也不能拿一个说不清时间的东西当"新的"
  if (!Number.isFinite(age) || age > deps.reuseWindowMs) return null

  const dir = join(deps.rootDir, prev.slug)
  try {
    const resolved = await resolveLocalPath(dir)
    const files: Record<string, string> = {}
    for (const rel of ['SKILL.md', ...Object.keys(resolved.files)]) {
      files[rel] = await readFile(join(dir, rel), 'utf8')
    }
    return {
      // ★ 展示文案用**清单里现在的**（改名字/改说明立刻生效），身份与版本沿用本地那份
      //   （slug / sourceRef / version / fetchedAt / files）——内容没重新抓，那些就不该变。
      entry: { ...prev, ...item, files: Object.keys(files).sort() },
      files,
      ageMinutes: Math.max(0, Math.round(age / 60000)),
      source: deps.source,
    }
  } catch (err) {
    deps.warn(
      `${deps.source}那份读不出来（${prev.slug}：${err instanceof Error ? err.message : String(err)}）：改为重新抓`,
    )
    return null
  }
}

/**
 * 把**刚抓到的那一条**立刻落进断点目录（连同索引）。
 *
 * ★ 抓一条落一条，而不是"等整轮结束再写"：撞限额、被 Ctrl-C、进程被杀……任何一种
 *   中断之后，已经花掉的配额都不该白花。代价是每条一次小写入（几十 KB），
 *   换来的是"中断了也只用补缺的"。
 */
async function checkpointItem(
  checkpointDir: string,
  index: Map<string, SyncIndexItem>,
  entry: SyncIndexItem,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const target = join(checkpointDir, entry.slug, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text, 'utf8')
  }
  index.set(entry.url, entry)
  await writeFile(
    join(checkpointDir, '.sync.json'),
    `${JSON.stringify({ schema: 'agentdeck/recommended-skills-sync@1', syncedAt: entry.fetchedAt, items: [...index.values()] }, null, 2)}\n`,
    'utf8',
  )
}

/**
 * 跑一次同步。
 *
 * 流程：清单 →（逐条抓取 + 校验）→ 写进**临时目录** → 全绿才替换。
 *
 * ★ 两条 2026-10 的行为（使用者要求）：
 *   1. **第一条失败就停**，不把剩下的条目挨个试一遍（撞限额时那一屏全是同一句话）；
 *   2. **1 小时内抓过的不再下载**（见 `REUSE_WINDOW_MS`）。
 */
export async function syncRecommendedSkills(options: SyncOptions): Promise<SyncReport> {
  const log = options.log ?? (() => {})
  const now = options.now ?? (() => new Date())
  const fetcher = options.fetchImpl ?? fetch
  const failures: SyncReport['failures'] = []
  const warnings: string[] = []
  const items: SyncIndexItem[] = []
  const reused: string[] = []
  const fromCheckpoint: string[] = []
  const warn = (line: string): void => {
    warnings.push(line)
  }

  const manifest = await readRecommendedManifest(options.manifestPath)
  log(`清单：${manifest.items.length} 条（核对于 ${manifest.verifiedAt || '未记录'}）`)

  // ★ 一律先转成**绝对路径**（`resolve`），两个理由：
  //   1. `resolveLocalPath`（共用取包规则）**只收绝对路径**——这是它刻意的规定
  //      （相对路径取决于调用方从哪个目录启动）。复用那条路要拿它校验本地那份，
  //      于是相对 `--out` 会**悄悄走不到复用**、白花一轮配额（2026-10 实测踩到，
  //      当时只留了一条 warning）；
  //   2. "写到了哪儿"必须是一个不管 cwd 在哪儿都指同一个地方的字符串——报告与
  //      日志都印它。
  const skillsDir = resolve(options.skillsDir)
  const reuseWindowMs = options.reuseWindowMs ?? REUSE_WINDOW_MS
  const refresh = options.refresh === true
  // ⚠️ `--dry-run` 不用复用窗口：它的用途就是**逐条真抓一遍**（查坏链接、查限额），
  //   跳过任何一条都让这次检查说了假话。
  const mayReuse = !refresh && options.dryRun !== true && reuseWindowMs > 0
  // ★ 断点目录：上一轮（或上几轮）**已经花过配额抓到、但还没发布**的那些条目。
  const checkpointDir = `${skillsDir}${CHECKPOINT_SUFFIX}`
  const emptyIndex = new Map<string, SyncIndexItem>()
  const previousIndex = mayReuse ? await readPreviousIndex(skillsDir, warn) : emptyIndex
  const checkpointIndex = mayReuse ? await readPreviousIndex(checkpointDir, warn) : emptyIndex
  if (refresh) log('--refresh：忽略复用窗口，全部重新下载')

  // ★ 先全部抓进**内存**：失败就不写盘，连临时目录都不留。
  const payloads = new Map<string, Record<string, string>>()
  let tried = 0
  let stoppedEarly = false
  for (const item of manifest.items) {
    tried += 1
    try {
      // ── ① 本地那份够新 ⇒ 直接用，连一次 API 都不花 ──
      const reuseDeps = { now, warn }
      const kept = mayReuse
        ? ((await tryReuse(item, {
            ...reuseDeps,
            previous: previousIndex,
            rootDir: skillsDir,
            reuseWindowMs,
            source: '已发布',
          })) ??
          // ⚠️ 断点那份用 `Infinity`（粘性）：它跨小时也要留着——那是花过配额的
          //   东西，丢了就只能重花一次（见 CHECKPOINT_SUFFIX 那段）。
          (await tryReuse(item, {
            ...reuseDeps,
            previous: checkpointIndex,
            rootDir: checkpointDir,
            reuseWindowMs: Number.POSITIVE_INFINITY,
            source: '断点',
          })))
        : null
      if (kept) {
        if (payloads.has(kept.entry.slug)) {
          failures.push({
            url: item.url,
            reason: `slug 与清单里另一条撞了（${kept.entry.slug}）——技能库按 slug 唯一，装第二条会顶掉第一条`,
          })
          break
        }
        payloads.set(kept.entry.slug, kept.files)
        items.push(kept.entry)
        if (kept.source === '断点') fromCheckpoint.push(kept.entry.slug)
        else reused.push(kept.entry.slug)
        log(
          kept.source === '断点'
            ? `⏭ ${kept.entry.slug}（沿用**断点目录**里那份——上一轮抓过、还没发布 ⇒ 不重抓）`
            : `⏭ ${kept.entry.slug}（本地那份是 ${kept.ageMinutes} 分钟前抓的，未过 1 小时 ⇒ 跳过下载，沿用本地）`,
        )
        continue
      }

      // ── ② 抓 ──
      const resolved = await resolveGithubUrl(item.url, {}, {
        fetchImpl: fetcher,
        // `exactOptionalPropertyTypes` 下不能显式传 undefined：省略才是"没给"
        ...(options.githubToken ? { githubToken: options.githubToken } : {}),
        ...(options.githubProxy ? { githubProxy: options.githubProxy } : {}),
        // 清单里声明的 include/exclude（不许排除 SKILL.md 那条已经在读清单时挡过）
        ...(item.include || item.exclude
          ? {
              filter: {
                ...(item.include ? { include: item.include } : {}),
                ...(item.exclude ? { exclude: item.exclude } : {}),
              },
            }
          : {}),
      })
      if (payloads.has(resolved.slug)) {
        failures.push({
          url: item.url,
          reason: `slug 与清单里另一条撞了（${resolved.slug}）——技能库按 slug 唯一，装第二条会顶掉第一条`,
        })
        break
      }
      const files: Record<string, string> = { 'SKILL.md': resolved.body, ...resolved.files }
      payloads.set(resolved.slug, files)
      const entry: SyncIndexItem = {
        ...item,
        slug: resolved.slug,
        sourceRef: resolved.sourceRef,
        version: await latestCommitSha(
          item.url,
          {
            fetchImpl: fetcher,
            ...(options.githubToken ? { githubToken: options.githubToken } : {}),
            ...(options.githubProxy ? { githubProxy: options.githubProxy } : {}),
          },
          warn,
        ),
        fetchedAt: now().toISOString(),
        files: Object.keys(files).sort(),
        excluded: resolved.excluded.map((e) => e.path),
      }
      items.push(entry)
      // ★ 抓一条就落一条（`--dry-run` 除外：那是检查，不许写盘）
      if (options.dryRun !== true) await checkpointItem(checkpointDir, checkpointIndex, entry, files)
      log(
        `✓ ${resolved.slug}（${Object.keys(files).length} 个文件，${resolved.resolvedFrom}）` +
          (resolved.excluded.length > 0
            ? `\n    清单里排除了 ${resolved.excluded.length} 个：` +
              `${resolved.excluded.map((e) => e.path).slice(0, 6).join('、')}` +
              `${resolved.excluded.length > 6 ? ` …（共 ${resolved.excluded.length} 个）` : ''}`
            : ''),
      )
    } catch (err) {
      const reason =
        err instanceof SkillSourceError
          ? `${err.message}${err.detail ? ` —— ${err.detail}` : ''}`
          : err instanceof Error
            ? err.message
            : String(err)
      failures.push({ url: item.url, reason })
      log(`✗ 第 ${tried} 条：${item.url}\n    ${reason}`)
      // ★ 一次失败就退出（2026-10 使用者要求）：剩下的不再挨个试。
      //   撞限额时后面每条都是同一句话，再试一遍只会刷一屏同样的话——
      //   而结论（目录一个字都不改）在第一条失败时就定了。
      stoppedEarly = true
      break
    }
  }
  const remaining = stoppedEarly ? manifest.items.length - tried : 0

  const index: SyncIndex = {
    schema: 'agentdeck/recommended-skills-sync@1',
    syncedAt: now().toISOString(),
    items,
  }

  if (failures.length > 0) {
    // ★ 一个字都不替换：半份目录比旧目录更糟（P7）
    // ★ 断点目录里现在有多少条替下一轮攒着（**已发布目录一个字都没改**）。
    //   这句话是这次失败留给使用者的**唯一**有用的东西：下一轮只补缺的。
    const checkpointed = checkpointIndex.size
    log(
      `第 ${tried} 条失败就停了：后面 ${remaining} 条没有再试（一次失败就退出）。` +
        `**已发布目录没有改动**（P7）`,
    )
    log(
      checkpointed > 0
        ? `已抓到的 ${checkpointed} 条留在断点目录里（${checkpointDir}）——` +
            `下一次只补缺的那几条，配额不会白花`
        : '断点目录是空的（这一轮一条都没抓成）',
    )
    return {
      items,
      failures,
      reused,
      fromCheckpoint,
      stoppedEarly,
      remaining,
      warnings,
      swapped: false,
      dryRun: options.dryRun === true,
      skillsDir,
      checkpointDir,
      checkpointed,
    }
  }

  if (options.dryRun === true) {
    log(`--dry-run：以上 ${items.length} 条都会写进 ${skillsDir}，但这次没有写`)
    return {
      items,
      failures,
      reused,
      fromCheckpoint,
      stoppedEarly,
      remaining,
      warnings,
      swapped: false,
      dryRun: true,
      skillsDir,
      checkpointDir,
      // dry-run 不写断点，所以这里如实报 0（不是"没抓成"）
      checkpointed: 0,
    }
  }

  // ── 写盘：临时目录 → 原子替换 ──
  //
  // 顺序是"先建全、再换"：staging 建完之后才动现有目录；换的过程中任何一步
  // 失败都把旧的挪回来。**目录绝不会出现"一半新一半旧"或"什么都不剩"**。
  const staging = `${skillsDir}.staging-${process.pid}`
  const previous = `${skillsDir}.old-${process.pid}`
  await rm(staging, { recursive: true, force: true })
  await rm(previous, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  for (const [slug, files] of payloads) {
    for (const [rel, text] of Object.entries(files)) {
      const target = join(staging, slug, rel)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, text, 'utf8')
    }
  }
  await writeFile(join(staging, '.sync.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')

  let movedAside = false
  try {
    await rename(skillsDir, previous)
    movedAside = true
  } catch {
    // 现有目录不存在（第一次同步）：正常，继续
  }
  try {
    await mkdir(dirname(skillsDir), { recursive: true })
    await rename(staging, skillsDir)
  } catch (err) {
    if (movedAside) await rename(previous, skillsDir).catch(() => undefined)
    await rm(staging, { recursive: true, force: true })
    throw err
  }
  if (movedAside) await rm(previous, { recursive: true, force: true })

  // ★ 内容已经发布 ⇒ 断点目录没用了，删掉。留着它反而会变成"下次会不会用旧的"
  //   这种说不清的状态（复用优先级已经写明：先已发布、后断点）。
  await rm(checkpointDir, { recursive: true, force: true })

  const kept = reused.length + fromCheckpoint.length
  log(
    `已替换 ${skillsDir}（${items.length} 条` +
      `${kept > 0 ? `，其中 ${kept} 条沿用旧内容、没有重新下载` : ''}）`,
  )
  return {
    items,
    failures,
    reused,
    fromCheckpoint,
    stoppedEarly,
    remaining,
    warnings,
    swapped: true,
    dryRun: false,
    skillsDir,
    checkpointDir,
    checkpointed: 0,
  }
}
