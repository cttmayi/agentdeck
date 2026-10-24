/**
 * 起草产出的**读取与校验**（2026-10-19 四轮）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么产出从"一段文本"变成"一个目录"
 * ══════════════════════════════════════════════════════════════════
 *
 * 四轮之前：起草 run 的产出 = 最后一条 text 消息（一份 SKILL.md），多文件靠
 * `===== FILE: scripts/x.sh =====` 这种尾巴约定。问题是**前端压根没解析那段尾巴**
 * ——多文件产物被当成正文的一部分塞进 SKILL.md，界面上也只有一个大文本框。
 *
 * 现在：agent 把文件写进 `<草稿目录>/skill/`，平台递归读成 `files` 映射
 * （与 `Skill.files`、`resolvePayloadEntry` 同一套形状），多文件天然成立。
 *
 * **文本兜底**（2026-10-19 定稿）：generic 之类没有写文件能力的 runtime 退化成
 * 单文件文本，界面上明说"这条是文本产物，没有支持文件"——不假装有目录。
 *
 * 校验放在这里、而不是只在前端：入库前服务端要复算一遍（客户端说的不算），
 * 而且界面要能**定位**到是哪个文件哪一条不满足。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** SKILL.md 的解析结果（frontmatter 拆出来的三个字段 + 全文）。 */
export interface SkillMd {
  /** frontmatter 里的 name（可能为空 = 没写）。 */
  name: string
  /** frontmatter 里的 description（可能为空）。 */
  description: string
  /** 去掉 frontmatter 的正文（预览用）。 */
  body: string
  /** SKILL.md 全文（含 frontmatter）——入库时原样交给 resolvePayloadEntry。 */
  raw: string
}

/** 校验问题：带文件位置，界面能定位。 */
export interface ArtifactProblem {
  /** 出问题的文件（相对 skill/ 目录）；整体性问题时为 'SKILL.md' 或 ''。 */
  file: string
  message: string
}

export interface DraftArtifacts {
  /**
   * `files` = agent 写出了目录（多文件成立）；`text` = 退回单文件文本
   * （没有写文件能力的 runtime，或没写出目录）；`refused` = 起草者判定素材不可沉淀
   * （写了 `REFUSED.md`，带原因——界面只给「重新起草 / 放弃」，不给入库）。
   */
  mode: 'files' | 'text' | 'refused'
  /** `refused` 时的原因（REFUSED.md 的内容）。 */
  refusalReason?: string
  /** 相对路径 → 内容。SKILL.md 一定在里面（文本兜底时它是唯一的一项）。 */
  files: Record<string, string>
  /** SKILL.md 的解析结果。 */
  skillMd: SkillMd
  /** 校验结果：ok=true 才允许入库。 */
  validation: { ok: boolean; problems: ArtifactProblem[] }
}

/** 限额（与 `resolvePayloadEntry` 的口径一致，超了在入库那关也会被拒）。 */
const MAX_FILE_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 1024 * 1024
const MAX_FILES = 64

/** 文件首行的摘要（报错时引出来，使用者一眼知道该删哪一行）。 */
export function firstLineOf(text: string): string {
  const line = text.replace(/^\uFEFF/, '').split('\n').find((l) => l.trim() !== '') ?? ''
  return line.trim().slice(0, 60)
}

/**
 * 极简 frontmatter 拆解：`---` 头块里的 `name:` / `description:`。
 *
 * 只容忍**空行**：SKILL.md 的 frontmatter 必须在第一个非空行——CLI 就是靠它认出
 * 技能的，前面多一行（实测有旧草稿写成「应并入：xxx」）在运行时就是"技能没装上"。
 */
export function parseSkillMd(text: string): SkillMd {
  const trimmed = text.replace(/^\uFEFF/, '').trimStart()
  if (!trimmed.startsWith('---')) return { name: '', description: '', body: trimmed, raw: text }
  const end = trimmed.indexOf('\n---', 3)
  if (end < 0) return { name: '', description: '', body: trimmed, raw: text }
  const head = trimmed.slice(3, end)
  let name = ''
  let description = ''
  for (const line of head.split('\n')) {
    const mName = line.match(/^name\s*:\s*(.+)$/)
    if (mName?.[1]) name = stripQuotes(mName[1].trim())
    const mDesc = line.match(/^description\s*:\s*(.+)$/)
    if (mDesc?.[1]) description = stripQuotes(mDesc[1].trim())
  }
  return { name, description, body: trimmed.slice(end + 4), raw: text }
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

/** 递归读目录（跳过隐藏文件与 `.claude`——那是注入的技能，不是产出）。 */
async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (current: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full, rel)
      else if (entry.isFile()) out[rel] = await readFile(full, 'utf8')
    }
  }
  await walk(dir, '')
  return out
}

/** 校验一组文件（供 artifacts 与入库路由共用：同一套规则只写一遍）。 */
export function validateArtifactFiles(files: Record<string, string>): {
  ok: boolean
  problems: ArtifactProblem[]
} {
  const problems: ArtifactProblem[] = []
  const names = Object.keys(files)

  if (names.length === 0) {
    problems.push({ file: '', message: '没有任何文件' })
  }
  if (!names.includes('SKILL.md')) {
    problems.push({ file: 'SKILL.md', message: '缺少 SKILL.md（技能正文必须在根上）' })
  }
  if (names.length > MAX_FILES) {
    problems.push({ file: '', message: `文件太多（${names.length} > ${MAX_FILES}），考虑合并同主题文件` })
  }

  let total = 0
  for (const [rel, text] of Object.entries(files)) {
    // 路径安全：与安装同一关（`resolvePayloadEntry` 也会拦，但这里要能指出是哪一个）
    if (rel.includes('..') || rel.startsWith('/')) {
      problems.push({ file: rel, message: '路径不合法（不许 .. 或绝对路径）' })
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    total += bytes
    if (bytes > MAX_FILE_BYTES) {
      problems.push({ file: rel, message: `文件过大（${Math.round(bytes / 1024)} KB > 256 KB）` })
    }
  }
  if (total > MAX_TOTAL_BYTES) {
    problems.push({ file: '', message: `总量过大（${Math.round(total / 1024)} KB > 1 MB）` })
  }

  const skillMd = files['SKILL.md']
  if (skillMd !== undefined) {
    const parsed = parseSkillMd(skillMd)
    if (!skillMd.replace(/^\uFEFF/, '').trimStart().startsWith('---')) {
      // 把当前首行引出来：只说"缺少 frontmatter"的话，使用者还得自己找是哪一行挡着
      problems.push({
        file: 'SKILL.md',
        message: `frontmatter 必须在第一行（现在是「${firstLineOf(skillMd)}」）`,
      })
    } else {
      if (parsed.name === '') {
        problems.push({ file: 'SKILL.md', message: 'frontmatter 缺少 name' })
      } else if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(parsed.name)) {
        problems.push({ file: 'SKILL.md', message: `name 必须是 kebab-case（现在是「${parsed.name}」）` })
      }
      if (parsed.description === '') {
        problems.push({ file: 'SKILL.md', message: 'frontmatter 缺少 description（模型靠它决定何时加载）' })
      }
    }
    if (!/^##\s+When to Use/m.test(parsed.body)) {
      problems.push({ file: 'SKILL.md', message: '正文缺少「## When to Use」一节' })
    }
    if (!/^##\s+Procedure/m.test(parsed.body)) {
      problems.push({ file: 'SKILL.md', message: '正文缺少「## Procedure」一节' })
    }
  }

  return { ok: problems.length === 0, problems }
}

/**
 * ══════════════════════════════════════════════════════════════════
 * 人改草稿这一条路（2026-10-21，分批第 8 批）：指纹、写回、路径守卫
 * ══════════════════════════════════════════════════════════════════
 *
 * 起因（使用者原话）：「缺少一个可以改的地方」——编辑器**一直都在**（草稿 tab 的文件树
 * 每个文本文件都能改），缺的是**改完能不能算数**：改动只活在浏览器内存里，而审核读的是
 * 磁盘上那份草稿 ⇒ 改了等于没改、审的还不是你改的那份，结论条也不提示。
 *
 * 这一组函数让"人改"变成一等公民：改动**写回**草稿小屋的 `skill/`，并且记下**审核当时
 * 那份产出的指纹**——界面拿指纹一比就知道"这个结论是不是改之前的"，据此标过期、给重审。
 */

/** 单份产出文件的上限：编辑器保存不该被用来往草稿里塞大文件（素材/文本兜底同一量级）。 */
export const MAX_DRAFT_FILE_BYTES = 2 * 1024 * 1024

/**
 * 这个相对路径能不能安全地写在 `skill/` 下。
 *
 * 两种逃逸都封（教训与 `workdir-files.ts` 同源）：
 *   1. **`..` / 绝对路径 / 反斜杠**：`rel = '../../../../.ssh/authorized_keys'`。
 *      不要靠"拼完再看前缀"挡——那是第二道（下面 `resolveDraftWritePath` 做），
 *      第一道就在这里：路径的形状本身必须是一段**普通的、往下的**相对路径；
 *   2. **空段**（`a//b`、结尾斜杠、`.`、`..`）：`resolve` 之后它们会"消失"，
 *      于是 `skill/a/../b` 看起来像合法路径。逐段判，别只看整体。
 */
export function isSafeDraftRelPath(rel: string): boolean {
  if (rel === '' || rel.includes('\\')) return false
  if (isAbsolute(rel) || rel.startsWith('/')) return false
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

/**
 * 内容指纹：**审的到底是哪一版产出**。
 *
 * ⚠️ 用长度前缀拼，不要用分隔符拼。写成 `rel + '\n' + text + '\n'` 的话，
 *    两组**不同**的文件能拼出同一个串（内容里本身带换行的文件最先撞上），
 *    而表现是"内容改了却仍判为没过期"——正是这个指纹唯一要防的事。
 *    长度前缀让每一段的边界都由长度钉死，拼接结果无歧义。
 */
export function hashDraftFiles(files: Record<string, string>): string {
  const h = createHash('sha256')
  for (const rel of Object.keys(files).sort()) {
    const text = files[rel] ?? ''
    h.update(`${Buffer.byteLength(rel, 'utf8')}:${rel}:${Buffer.byteLength(text, 'utf8')}:`)
    h.update(text, 'utf8')
  }
  return h.digest('hex')
}

/** 草稿当前产出的指纹（目录读不到 = 空集合的指纹，调用方自己判"有没有产出"）。 */
export async function hashDraftDir(skillDir: string): Promise<string> {
  const files = (await readDraftSkillDir(skillDir)) ?? {}
  return hashDraftFiles(files)
}

/** 审核当时那份产出的指纹（落在草稿小屋**根**上的点文件里）。 */
export interface AuditStamp {
  reviewRunId: string
  hash: string
  at: number
}

/**
 * 指纹落在哪：`<草稿小屋>/.audited.json`。
 *
 * ⚠️ 两个位置上的讲究：
 *   · 放在**根**上、不放 `skill/` 里——`readTree` 会跳过点文件，但把非产出文件塞进产出
 *     目录本身就是脏的（`artifacts` 的文件树、diff、入库的 `files` 都从那里读）；
 *   · 用**点文件**——万一将来有人把 `skill/` 整个拷走，别把审核元数据一起当成产出带走。
 */
export const AUDIT_STAMP_FILE = '.audited.json'

export async function readAuditStamp(draftDir: string): Promise<AuditStamp | null> {
  try {
    const raw = JSON.parse(await readFile(join(draftDir, AUDIT_STAMP_FILE), 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null) return null
    const obj = raw as Record<string, unknown>
    const reviewRunId = obj['reviewRunId']
    const hash = obj['hash']
    const at = obj['at']
    if (typeof reviewRunId !== 'string' || typeof hash !== 'string') return null
    return { reviewRunId, hash, at: typeof at === 'number' ? at : 0 }
  } catch {
    // 没有 / 坏了都当"判不出来"（旧数据里本来就没有这个文件）。由调用方决定怎么呈现，
    // 不要在这里编一个 false——那会让"无法判定"看起来像"没过期"。
    return null
  }
}

export async function writeAuditStamp(draftDir: string, stamp: AuditStamp): Promise<void> {
  await mkdir(draftDir, { recursive: true })
  await writeFile(join(draftDir, AUDIT_STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`, 'utf8')
}

/** 写回的结果：写了几份、以及拒绝了的路径（拒绝要能说出来，不能静默跳过）。 */
export interface WriteDraftResult {
  written: string[]
  rejected: string[]
}

/**
 * 把人改过的文件写回 `<草稿小屋>/skill/`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条纪律（每条都是踩过的坑的形状）
 * ══════════════════════════════════════════════════════════════════
 *
 * 1. **只写、不删**。入库那条路是"清空目录再写"，于是文本兜底草稿更新时会把目标技能的
 *    支持文件全删掉（见 server.ts 里那段注释）——同一个错误在这里更贵：人只是改了
 *    `SKILL.md`，保存却把他没看见（点文件、二进制、`readTree` 之外的东西）的文件删了。
 *    "删文件"该是**一个明确的动作**，不是"保存"的副作用。
 *
 * 2. **每个路径都要过 `resolveDraftWritePath`**（形状 + 前缀 + 真实路径三层）。
 *
 * 3. **有拒绝就整单拒绝**（返回空 written）——不半写。半写会让磁盘进入一个
 *    使用者没要求过的中间状态，而审核随后看到的就是它。
 */
export async function writeDraftSkillFiles(
  skillDir: string,
  files: Record<string, string>,
): Promise<WriteDraftResult> {
  const rejected: string[] = []
  const targets: Array<{ rel: string; full: string; text: string }> = []
  for (const [rel, text] of Object.entries(files)) {
    if (!isSafeDraftRelPath(rel) || typeof text !== 'string') {
      rejected.push(rel)
      continue
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_DRAFT_FILE_BYTES) {
      rejected.push(rel)
      continue
    }
    const full = await resolveDraftWritePath(skillDir, rel)
    if (full === null) {
      rejected.push(rel)
      continue
    }
    targets.push({ rel, full, text })
  }
  if (rejected.length > 0) return { written: [], rejected }
  const written: string[] = []
  for (const t of targets) {
    await mkdir(dirname(t.full), { recursive: true })
    await writeFile(t.full, t.text, 'utf8')
    written.push(t.rel)
  }
  return { written, rejected }
}

/**
 * 解析一个写入路径，并确认它真的落在 `skillDir` 里；不安全 → null。
 *
 * 三层，缺一层都不够：
 *   ① 形状（`isSafeDraftRelPath`）；
 *   ② **拼出来的**路径按**路径分隔符**比前缀——不能按字符串前缀比，否则
 *      `/work-other` 会被当成 `/work` 的子路径（`workdir-files.ts` 里那条经典教训）；
 *   ③ **真实路径**：`skill/` 下放一个指向 `/etc` 的软链，① ② 全都正常。
 *      所以父目录存在时比 `realpath`——**父目录**（不是目标文件：目标还不存在）。
 */
async function resolveDraftWritePath(skillDir: string, rel: string): Promise<string | null> {
  const base = resolve(skillDir)
  const full = resolve(base, rel)
  if (full !== base && !full.startsWith(base + sep)) return null
  let probe = dirname(full)
  try {
    const realBase = await realpath(base)
    while (true) {
      try {
        const realProbe = await realpath(probe)
        if (realProbe !== realBase && !realProbe.startsWith(realBase + sep)) return null
        return full
      } catch {
        const parent = dirname(probe)
        if (parent === probe) return null
        probe = parent
      }
    }
  } catch {
    // `skill/` 目录本身还不存在（第一次保存）⇒ 没有软链可谈，形状与前缀已经够
    return full
  }
}

/** 从 `skill/` 目录读产出；目录不存在或为空 → 返回 null（交给文本兜底）。 */
export async function readDraftSkillDir(dir: string): Promise<Record<string, string> | null> {
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) return null
  } catch {
    return null
  }
  const files = await readTree(dir)
  return Object.keys(files).length === 0 ? null : files
}

/**
 * 组装一份草稿的产出。
 *
 * @param draftDir 草稿根目录（`<workRoot>/skill-draft-<id>`），产出在它的 `skill/` 下
 * @param textFallback 没有目录产出时的文本兜底（起草 run 的最后一条 text 消息）
 */
export function assembleArtifacts(
  dirFiles: Record<string, string> | null,
  textFallback: string | null,
): DraftArtifacts {
  // 起草者主动拒绝：它写的是 REFUSED.md 而不是 SKILL.md。这是一种**结论**，不是失败，
  // 所以单独一种模式——界面据此把"入库"换掉，避免出现一个空 frontmatter 的红条。
  const refusal = dirFiles?.['REFUSED.md']
  if (dirFiles !== null && dirFiles['SKILL.md'] === undefined && refusal !== undefined) {
    return {
      mode: 'refused',
      refusalReason: refusal.trim(),
      files: dirFiles,
      skillMd: { name: '', description: '', body: '', raw: '' },
      validation: { ok: false, problems: [{ file: 'REFUSED.md', message: refusal.trim() }] },
    }
  }
  if (dirFiles !== null && dirFiles['SKILL.md'] !== undefined) {
    return {
      mode: 'files',
      files: dirFiles,
      skillMd: parseSkillMd(dirFiles['SKILL.md']),
      validation: validateArtifactFiles(dirFiles),
    }
  }
  // 有目录但缺 SKILL.md：仍然按 files 报出来（校验会说缺 SKILL.md），让使用者看到
  // agent 到底写了什么——比"什么都没读出来"有用。
  if (dirFiles !== null) {
    return {
      mode: 'files',
      files: dirFiles,
      skillMd: {
        name: '',
        description: '',
        body: dirFiles['SKILL.md'] ?? '',
        raw: dirFiles['SKILL.md'] ?? '',
      },
      validation: validateArtifactFiles(dirFiles),
    }
  }
  const text = textFallback ?? ''
  if (text.trim() === '') {
    return {
      mode: 'text',
      files: {},
      skillMd: { name: '', description: '', body: '', raw: '' },
      validation: { ok: false, problems: [{ file: '', message: '这条起草 run 没有产出任何内容' }] },
    }
  }
  return {
    mode: 'text',
    files: { 'SKILL.md': text },
    skillMd: parseSkillMd(text),
    validation: validateArtifactFiles({ 'SKILL.md': text }),
  }
}

/**
 * 「这一版被人手改过」的标记（分批第 14 批，落在 `<草稿小屋>/.human-edits.json`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要一个标记：返工要不要**接上一版的 CLI 会话**（resume）
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者的判断是"resume 更合适"（对：起草者刚写过这一版，材料、规范、为什么这么组织都在它的
 * 上下文里；接上就省一遍重读，风格也连得上）。但有一条真实风险必须**结构上**挡住，而不是
 * 指望模型听话：
 *
 *   第 8 批开始，人可以在编辑器里改草稿并**落盘**（`POST /api/crystallize/save-draft`）。
 *   那条被改过的草稿如果走 resume，起草者脑子里的"上一版"和人手上的"上一版"**不是一个东西**
 *   ——它按记忆里的内容去"改"，就会把人改的地方**改回去**，而且没有任何地方会提示这件事。
 *
 * 所以：**人改过 ⇒ 不接会话**，走全新进程 + 以磁盘里的文件为准（那是今天已经验证过的行为）；
 * 没改过 ⇒ 接会话（连续性 + 省一遍重读）。两种情况在索引页里都写清"这一版的依据是什么"。
 *
 * ⚠️ 为什么是"标记文件"而不是"比指纹"：指纹只能回答"和某一次审核时相比变没变"，而这里要问的是
 *    "**在起草者写完这一版之后**，有没有人动过它"——起草时根本没有指纹可比（审核可能还没跑）。
 *    标记由 `save-draft` 落，语义直接：这个文件在 ⇒ 有人动过。
 */
export interface HumanEditStamp {
  /** 第一次被改的时间（人可能改好几次，保留最早的，便于回答"这版从什么时候起不是起草者写的了"）。 */
  firstAt: number
  lastAt: number
  /** 改过哪些文件（进日志/索引页，让起草者知道"哪几份不是它写的那份"）。 */
  files: string[]
}

export const HUMAN_EDIT_STAMP_FILE = '.human-edits.json'

export async function readHumanEditStamp(draftDir: string): Promise<HumanEditStamp | null> {
  try {
    const raw = JSON.parse(await readFile(join(draftDir, HUMAN_EDIT_STAMP_FILE), 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null) return null
    const obj = raw as Record<string, unknown>
    const firstAt = obj['firstAt']
    const lastAt = obj['lastAt']
    const files = obj['files']
    return {
      firstAt: typeof firstAt === 'number' ? firstAt : 0,
      lastAt: typeof lastAt === 'number' ? lastAt : 0,
      files: Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [],
    }
  } catch {
    // 没有这个文件是**最常见**的情况（从没人手改过）⇒ 返回 null，调用方按"没改过"处理。
    // 坏了（JSON 不完整）也返回 null：那种情况下"接会话"的风险是把人改的改回去，
    // 而"不接会话"最坏只是少省一遍重读——方向相反的两个错，选后果轻的那个。
    return null
  }
}

/**
 * 记下"这一版被人改过"。**合并写**：已有标记时保留最早的 `firstAt`，并把文件并起来
 * （人可能改两次、改不同文件；覆盖写会把第一次的痕迹抹掉，日志里就说不清"这版从什么时候
 * 起不是起草者写的了"）。
 */
export async function writeHumanEditStamp(
  draftDir: string,
  edit: { at: number; files: string[] },
): Promise<HumanEditStamp> {
  const previous = await readHumanEditStamp(draftDir)
  const merged: HumanEditStamp = {
    firstAt: previous?.firstAt ?? edit.at,
    lastAt: edit.at,
    files: [...new Set([...(previous?.files ?? []), ...edit.files])].sort(),
  }
  await mkdir(draftDir, { recursive: true })
  await writeFile(
    join(draftDir, HUMAN_EDIT_STAMP_FILE),
    `${JSON.stringify(merged, null, 2)}\n`,
    'utf8',
  )
  return merged
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * 一个沉淀任务 = 一个目录（分批第 16 批）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 使用者给的判断：「给意见后点"重新起草"逻辑不好：新增加了一个沉淀任务，而不是在原沉淀任务中执行。
 * 原则上应该叫"反馈"，在原任务中执行；skill 差异对比也应该是原 skill 变化。」
 *
 * 查下来他说的两件都成立：
 *   · 列表 `listCrystallizeDrafts` 是**一条 run 一行** ⇒ 一条 7 版的链在沉淀列表里是 7 个条目
 *     （他自己机器上真有一条 7 版的链：`9D67DN → … → B3R0ST`）；
 *   · 一条 run 一间小屋（`draftRoot(workRoot, runId)`）⇒ "差异对比"天然是"v2 vs v1"，
 *     而不是"这份 skill 变成什么样了"。
 *
 * 现在的模型：**首次起草的那一刻定下任务目录**（= 首版那条 run 的小屋，`skill-draft-<首版 runId>`），
 * 之后每一版都在**同一个目录里改**——这就是"在原任务中执行"。每改一版之前，把当前 `skill/`
 * **快照**一份到 `history/<那一版的 runId>/skill/`，于是：
 *   · 差异对比 = 当前 vs 快照（"这份 skill 的变化"）；
 *   · 上一版**仍然完整可查**（快照是不可变的：只写一次、之后只读）；
 *   · 审核指纹（`.audited.json`）与"人改过的痕迹"（`.human-edits.json`）语义不变——它们本来就
 *     回答"和某一次审核时相比变没变"，而"当前内容"现在只有一个地方，反而更清楚。
 *
 * ⚠️ 一条 run 仍然是**终态机**（completed/failed/cancelled 不能再开）⇒ 每一次反馈依然起一条新 run
 *    （新进程）；变的只是"任务"落到哪个目录。使用者看到的"任务"是**目录 + 这条链**，不是某一条 run。
 */
export interface DraftVersionRecord {
  /** 这一版是哪条 run 跑出来的。 */
  runId: string
  at: number
  /** 这一版产出之后，有没有被人手改过（保留下来：resume 决策与溯源都要用）。 */
  humanEdited: boolean
  /**
   * 这一版的内容快照在哪。
   *
   * `null` = 它**就是任务目录里的当前内容**（只有最新一版是这样）；
   * 相对路径 = 任务目录里的 `history/<runId>`；
   * 绝对路径 = 老数据留下的"自己那间小屋"（见下面的自愈迁移）——本期不改写老目录。
   */
  snapshot: string | null
}

export interface DraftVersions {
  /** 这个任务的目录（= 首版那条 run 的小屋）。 */
  versions: DraftVersionRecord[]
  /**
   * 老形状自愈时记一笔（`null` = 没发生过）。
   *
   * 为什么要记：迁移会**改动使用者的目录**（把最新一版的内容搬进任务目录），这种事必须留下痕迹，
   * 否则以后看到"任务目录里的内容和首版小屋的名字对不上"，没人说得清是怎么来的。
   */
  healedAt: number | null
}

export const DRAFT_VERSIONS_FILE = '.versions.json'
/**
 * 「停止自动循环」的标记文件（分批第 23 批）。
 *
 * 放在任务目录里而不是 run 字段上：它是**任务级**的决定（"这个沉淀任务别再自动改下去了"），
 * 与 `.versions.json` / `.human-edits.json` 同一族；而且使用者 `cat` 一眼就能看出它是怎么停的。
 */
export const AUTO_REWORK_STOP_FILE = '.auto-rework.json'
export const DRAFT_HISTORY_DIR = 'history'

export async function readDraftVersions(taskDir: string): Promise<DraftVersions | null> {
  try {
    const raw = JSON.parse(await readFile(join(taskDir, DRAFT_VERSIONS_FILE), 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null) return null
    const obj = raw as Record<string, unknown>
    const list = obj['versions']
    if (!Array.isArray(list)) return null
    return {
      versions: list
        .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
        .map((v) => ({
          runId: typeof v['runId'] === 'string' ? v['runId'] : '',
          at: typeof v['at'] === 'number' ? v['at'] : 0,
          humanEdited: v['humanEdited'] === true,
          snapshot: typeof v['snapshot'] === 'string' ? v['snapshot'] : null,
        }))
        .filter((v) => v.runId !== ''),
      healedAt: typeof obj['healedAt'] === 'number' ? obj['healedAt'] : null,
    }
  } catch {
    // 没有这个文件 = 这个任务还没有第二版（最常见）⇒ null，调用方按"当前内容就在任务目录里"处理。
    return null
  }
}

/**
 * 把版本表里**不属于这条链**的条目剔掉。
 *
 * 为什么会有：`9D67DN` 的任务目录里，`.versions.json` 记着 14 条，其中 4 条属于同一来源下的
 * **另一条链** `H5YM0E`（旧口径"同来源 + 同目标"在自愈时写进去的）⇒ 目录里"这一任务有几版"
 * 与磁盘实际不符，界面的"第几版"也跟着错。
 *
 * 只剔不补：缺的条目由老形状自愈那条路补（它会连快照一起补），这里凭空加一条会让
 * "有没有人改过 / 快照在哪"变成编出来的。
 */
export function dropForeignVersions(
  versions: DraftVersions,
  chainIds: ReadonlySet<string>,
): { kept: DraftVersions; dropped: string[] } {
  const dropped = versions.versions.filter((v) => !chainIds.has(v.runId)).map((v) => v.runId)
  if (dropped.length === 0) return { kept: versions, dropped: [] }
  return {
    kept: { ...versions, versions: versions.versions.filter((v) => chainIds.has(v.runId)) },
    dropped,
  }
}

export async function writeDraftVersions(taskDir: string, versions: DraftVersions): Promise<void> {
  await mkdir(taskDir, { recursive: true })
  await writeFile(
    join(taskDir, DRAFT_VERSIONS_FILE),
    `${JSON.stringify(versions, null, 2)}\n`,
    'utf8',
  )
}

/** 把当前 `skill/` 快照到 `history/<runId>/skill/`（**只写一次**：已经存在就不动）。 */
export async function snapshotDraftSkill(
  taskDir: string,
  versionRunId: string,
): Promise<string | null> {
  const from = join(taskDir, 'skill')
  const rel = `${DRAFT_HISTORY_DIR}/${versionRunId}`
  const to = join(taskDir, rel, 'skill')
  const current = await readDraftSkillDir(from)
  if (current === null) return null
  // 已经快照过 ⇒ 不动它。快照是**不可变**的：重写会让"上一版到底是什么"随最后一次调用而变。
  const existing = await readDraftSkillDir(to)
  if (existing !== null) return rel
  for (const [relPath, text] of Object.entries(current)) {
    const full = join(to, relPath)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, text, 'utf8')
  }
  return rel
}

/** 解析一版内容的位置（`snapshot` 为 null 时就是任务目录自己）。 */
export function draftVersionSkillDir(taskDir: string, version: DraftVersionRecord): string {
  if (version.snapshot === null) return join(taskDir, 'skill')
  return isAbsolute(version.snapshot)
    ? join(version.snapshot, 'skill')
    : join(taskDir, version.snapshot, 'skill')
}

/** 老数据（一版一间小屋）在磁盘上的形状：`skill-draft-<runId>`，由调用方拼好传进来。 */
export interface DraftRunLine {
  id: string
  revisedFrom?: string | null
  queuedAt?: number
}

/**
 * 把一条起草 run 归到它**所属任务的目录**上。
 *
 * 规则：沿着 `revisedFrom` 往回走到**首版**，首版那条 run 的小屋就是任务目录
 * （新数据全是这个形状；老数据的第一版小屋就是首版小屋，也一样）。
 *
 * ⚠️ 老数据要**自愈**：分批第 16 批之前"一版一间小屋"，所以老链的最新一版内容在**它自己**的小屋里，
 *    而任务目录里躺着的是首版。不自愈的话，读取当前内容、审核、人保存、差异对比会**集体看错一版**
 *    （而且是静默的：目录在、文件在、只是内容旧了）。自愈做四件事，只做一次（`.versions.json` 是锁）：
 *    ① 把首版小屋的 `skill/` 抄进 `history/<首版 runId>/skill/`（首版内容要留在原地当快照前先备份）；
 *    ② 中间各版记成"快照 = 它自己那间小屋"（绝对路径，**不搬**——老目录保持原样，只是被指向）；
 *    ③ 把**最新一版**小屋的 `skill/` 抄进任务目录（它才是当前内容）；
 *    ④ 写 `.versions.json`，并把 `healedAt` 记上。
 *
 * 判据读的是结果，不是过程：自愈之后，问**任何一版** run 都得到同一个任务目录，而"当前内容"
 * 就是最新那一版的内容（e2e 里拿老形状的假数据量）。
 */
export async function resolveDraftTaskDir(input: {
  workRoot: string
  draftRunId: string
  draftDirName: (runId: string) => string
  getRun: (runId: string) => Promise<DraftRunLine | null>
  listChain: (rootRunId: string) => Promise<DraftRunLine[]>
  now: number
}): Promise<string> {
  const rootId = await findRootDraftRunId(input.draftRunId, input.getRun)
  const taskDir = join(input.workRoot, input.draftDirName(rootId))
  if (rootId === input.draftRunId) return taskDir
  // ⚠️ 自愈的门是"**表里没有这一版**"，不是"表不存在"。
  //
  //    第一版我把门写成"`.versions.json` 不存在就自愈"，结果**永远不自愈**：那张表在 v1 一跑完
  //    就被完成钩子写下了（登记"当前版本"），所以表总是存在 ⇒ 老形状的链（每一版自己的小屋）
  //    压根进不了自愈分支。表现是最坏的那种：问 v7 的产出，接口 200、文件都在、内容是 **v1 的**
  //    ——e2e 里把这条钉住了（造一条老形状的链，问老那一版）。
  //    反过来，表里**已有这一版** ⇒ 要么是新形状（每版都登记），要么已经迁过了 ⇒ 直接返回，
  //    不做链条扫描（这是一条会被频繁调用的路径）。
  const versions = await readDraftVersions(taskDir)
  if (versions !== null && versions.versions.some((v) => v.runId === input.draftRunId)) {
    return taskDir
  }
  await healLegacyChain(input, rootId, taskDir)
  return taskDir
}

async function findRootDraftRunId(
  draftRunId: string,
  getRun: (runId: string) => Promise<DraftRunLine | null>,
): Promise<string> {
  let current = draftRunId
  // 上限 50：链再长也够（真机上最长的一条是 7 版），同时挡住"环"把守护进程转死。
  for (let i = 0; i < 50; i += 1) {
    const run = await getRun(current)
    const prev = run?.revisedFrom ?? null
    if (prev === null || prev === '') return current
    current = prev
  }
  return current
}

async function healLegacyChain(
  input: {
    workRoot: string
    draftDirName: (runId: string) => string
    listChain: (rootRunId: string) => Promise<DraftRunLine[]>
    now: number
  },
  rootId: string,
  taskDir: string,
): Promise<void> {
  const chain = await input.listChain(rootId)
  if (chain.length === 0) return
  const latest = chain[chain.length - 1]
  if (latest === undefined || latest.id === rootId) return
  const latestDir = join(input.workRoot, input.draftDirName(latest.id))
  // 最新那一版本来就在任务目录里 ⇒ 没有"搬家"这回事（新形状的链随时会走到这儿，
  // 比如返工 run 刚提交、还没跑完：这时表里还没有它，但它的小屋就是任务目录）。
  if (resolve(latestDir) === resolve(taskDir)) return
  const latestSkill = await readDraftSkillDir(join(latestDir, 'skill'))
  if (latestSkill === null) return
  const versions: DraftVersionRecord[] = []
  for (const run of chain) {
    const hut = join(input.workRoot, input.draftDirName(run.id))
    const human = (await readHumanEditStamp(hut)) !== null
    if (run.id === rootId) {
      const snapshot = await snapshotDraftSkill(taskDir, run.id)
      versions.push({ runId: run.id, at: run.queuedAt ?? 0, humanEdited: human, snapshot })
    } else if (run.id === latest.id) {
      versions.push({ runId: run.id, at: run.queuedAt ?? 0, humanEdited: human, snapshot: null })
    } else {
      versions.push({
        runId: run.id,
        at: run.queuedAt ?? 0,
        humanEdited: human,
        snapshot: hut,
      })
    }
  }
  // ③ 最新一版的内容搬进任务目录（它才是"当前内容"）
  for (const [relPath, text] of Object.entries(latestSkill)) {
    const full = join(taskDir, 'skill', relPath)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, text, 'utf8')
  }
  await writeDraftVersions(taskDir, { versions, healedAt: input.now })
}

/**
 * 记一笔版本（同 runId 就覆盖，否则追加，按 `at` 排序）。
 *
 * 两个写入时机（都在 server.ts 里，注释写在那儿）：
 *   · **返工开工前**：给"当前这一版"补上快照与 `humanEdited`；
 *   · **起草 run 跑完**：把新产出登记成"当前版本"（`snapshot: null`）。
 */
export async function recordDraftVersion(
  taskDir: string,
  version: DraftVersionRecord,
): Promise<DraftVersions> {
  const existing = await readDraftVersions(taskDir)
  const versions = (existing?.versions ?? []).filter((v) => v.runId !== version.runId)
  versions.push(version)
  versions.sort((a, b) => a.at - b.at)
  const next: DraftVersions = { versions, healedAt: existing?.healedAt ?? null }
  await writeDraftVersions(taskDir, next)
  return next
}

/**
 * 抹掉"人改过"的标记：新一版产出**并落盘之后**才做。
 *
 * 为什么不在返工开工时就抹：开工到跑完这段时间里，这一版的内容**还是**人改过的那份，
 * 中途失败（CLI 崩了、超时）之后它依然是 ⇒ 提前抹掉会让下一次反馈走 resume，
 * 于是起草者按记忆去改人改过的文件（第 14 批要挡的正是这件事）。
 */
export async function clearHumanEditStamp(taskDir: string): Promise<void> {
  await rm(join(taskDir, HUMAN_EDIT_STAMP_FILE), { force: true })
}
