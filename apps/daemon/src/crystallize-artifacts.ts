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
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
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
