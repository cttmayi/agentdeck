/**
 * 沉淀材料：**从 GitHub 仓库拉一份文档进来当素材**（分批第 157 批，§12.54）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这一条要单独一个模块、而且**不自己写 fetch**
 * ══════════════════════════════════════════════════════════════════
 * 这个平台的既有边界是"浏览器是唯一的远端通道"，唯一例外是装 skill 时 daemon 自己去下载，
 * 而那条路（`packages/skill-source`）把边界写死成三条：**主机白名单**、**体量/数量上限**、
 * **凭证只在直连时带**。材料这一侧如果另起一个裸 `fetch(url)`，三条一条都不会自动成立——
 * 那等于给本机服务开一个"抓任意地址"的跳板（SSRF）。
 *
 * 所以这里：主机白名单照抄（只认 GitHub 那三个）、体量按"进素材的总字节"封顶、只收文本、
 * 而且**只走两种请求**：`api.github.com` 的 tree 列表 + `raw.githubusercontent.com` 的原文。
 * 没有 token、没有代理（材料不是安装，先不引入第三条可配路径）。
 *
 * ⚠️ 与 §12.54 的约定一致：仓库里若带 `SKILL.md`，调用方要把 `hasSkillMd` 告诉使用者
 *    （"这是要更新它，还是只当素材？"——两条路完全不同，见 §12.16 的方法表）。
 */

/** GitHub 允许的三个主机——**这是白名单，不是示例**（与 `skill-source` 同一份口径）。 */
export const REPO_ALLOWED_HOSTS = new Set(['github.com', 'raw.githubusercontent.com', 'api.github.com'])

/** 一次往素材里塞多少字节封顶（比单份材料的 100 KiB 宽松：一份仓库常常是好几个文件）。 */
export const REPO_MAX_TOTAL_BYTES = 1024 * 1024
/** 一次最多收几个文件（再多就等于把整个仓库同步进来，那不是"素材"）。 */
export const REPO_MAX_FILES = 40
/** 单文件上限：超过它的多半是数据/日志/压缩产物，进素材只会淹掉起草者。 */
export const REPO_MAX_FILE_BYTES = 256 * 1024

/** 递归时跳过的目录：版本库内部结构与依赖，都不是"要沉淀的依据"。 */
export const REPO_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.github',
  'dist',
  'build',
  'out',
  'vendor',
  '.venv',
  '__pycache__',
  'coverage',
])

/** 只收这些扩展名（与界面拖文件的判据同一份口径：文本才读得动）。 */
export const REPO_TEXT_EXT =
  /\.(md|markdown|txt|text|rst|json|ya?ml|csv|tsv|log|ts|tsx|js|mjs|cjs|py|sh|rb|go|rs|java|kt|html?|css|toml|ini|cfg|conf)$/i

/** 仓库地址解析出来的东西。 */
export interface RepoRef {
  owner: string
  repo: string
  /** 分支 / tag / sha；没写就 `HEAD`（默认分支）。 */
  ref: string
  /** 只取这个子目录（可空 = 整仓根）。 */
  subpath: string
}

export type RepoParseResult = { ok: true; ref: RepoRef } | { ok: false; error: string }

/**
 * 解析使用者给的仓库地址。
 *
 * 认这三种写法（都在**同一个白名单**内）：
 *   · `https://github.com/owner/repo`
 *   · `https://github.com/owner/repo/tree/<branch>/<sub/path>`
 *   · `owner/repo`（手输常见；补齐成 github.com）
 * 不认：别的站点、`http://`（明文）、带 `user@`、带 `?query`/`#`、空段。
 */
export function parseRepoUrl(input: string): RepoParseResult {
  const raw = input.trim()
  if (raw === '') return { ok: false, error: '仓库地址是空的' }

  let url: URL
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
    // `owner/repo`：补齐协议与主机，仍然要从白名单那一刻起走（下面统一判）
    url = new URL(`https://github.com/${raw}`)
  } else {
    try {
      url = new URL(raw)
    } catch {
      return { ok: false, error: '看不懂这个地址，形如 https://github.com/owner/repo' }
    }
  }
  if (url.protocol !== 'https:') return { ok: false, error: '只接受 https 地址' }
  if (url.username !== '' || url.password !== '') return { ok: false, error: '地址里不要带用户名/口令' }
  if (!REPO_ALLOWED_HOSTS.has(url.hostname)) {
    return { ok: false, error: `只接受 GitHub（${[...REPO_ALLOWED_HOSTS].join(' / ')}）` }
  }
  if (url.hostname !== 'github.com') {
    return { ok: false, error: '请给仓库主页地址：https://github.com/owner/repo' }
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, error: '地址里不要带查询串或锚点' }
  }

  const parts = url.pathname.split('/').filter((p) => p !== '')
  if (parts.length < 2) return { ok: false, error: '地址里缺 owner/repo' }
  const owner = parts[0] ?? ''
  const repo = parts[1] ?? ''
  const kind = parts[2]
  const ref = parts[3] ?? ''
  const rest = parts.slice(4)
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    return { ok: false, error: 'owner/repo 只能含字母、数字、`.`、`_`、`-`' }
  }
  if (kind === undefined) {
    return { ok: true, ref: { owner, repo, ref: 'HEAD', subpath: '' } }
  }
  if (kind !== 'tree' || ref === '') {
    return { ok: false, error: '只认仓库根或 /tree/<分支>/<子目录>' }
  }
  return {
    ok: true,
    ref: { owner, repo, ref, subpath: rest.join('/') },
  }
}

/** 一个拉下来的文件。 */
export interface RepoFile {
  /** 相对**子目录**的路径（落盘时再接上仓库名做前缀）。 */
  relPath: string
  text: string
}

export interface RepoFilesResult {
  files: RepoFile[]
  /** 被跳过的（太大 / 非文本 / 超出数量与体量上限），每条一句话说明为什么。 */
  skipped: string[]
  /** 仓库里带了 `SKILL.md`：调用方要问"更新它还是只当素材"（§12.54）。 */
  hasSkillMd: boolean
  /** 这个仓库里一共扫到多少个 blob（用来解释"为什么只拉了 40 个"）。 */
  scanned: number
}

interface TreeEntry {
  path?: unknown
  type?: unknown
  size?: unknown
}

/**
 * 拉一个仓库里的文本文件（tree 列表 + 逐个 raw）。
 *
 * ⚠️ `fetchImpl` 必须可注入：测试里**绝不**打真 GitHub（NFR-T-01 的同一条精神：
 * 不碰真实外部服务，也不让测试依赖网络）。
 */
export async function fetchRepoTextFiles(
  ref: RepoRef,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<RepoFilesResult> {
  const doFetch = options.fetchImpl ?? fetch
  const slug = `${ref.owner}/${ref.repo}`
  const treeUrl =
    `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}` +
    `/git/trees/${encodeURIComponent(ref.ref)}?recursive=1`
  const treeRes = await doFetch(treeUrl, {
    headers: { accept: 'application/vnd.github+json' },
  })
  if (!treeRes.ok) {
    throw new Error(`读不到 ${slug} 的文件列表（GitHub 返回 ${treeRes.status}）`)
  }
  const tree = (await treeRes.json()) as { tree?: TreeEntry[] }
  const entries = Array.isArray(tree.tree) ? tree.tree : []

  const prefix = ref.subpath === '' ? '' : `${ref.subpath.replace(/\/+$/, '')}/`
  const candidates: Array<{ path: string; size: number }> = []
  const skipped: string[] = []
  let hasSkillMd = false
  for (const entry of entries) {
    if (entry.type !== 'blob' || typeof entry.path !== 'string') continue
    const path = entry.path
    if (prefix !== '' && !path.startsWith(prefix)) continue
    const rel = prefix === '' ? path : path.slice(prefix.length)
    if (rel === '') continue
    if (rel.split('/').some((seg) => REPO_SKIP_DIRS.has(seg))) {
      skipped.push(`${rel}（跳过目录）`)
      continue
    }
    if (rel === 'SKILL.md' || path.endsWith('/SKILL.md')) hasSkillMd = true
    if (!REPO_TEXT_EXT.test(rel)) {
      skipped.push(`${rel}（不是文本）`)
      continue
    }
    const size = typeof entry.size === 'number' ? entry.size : 0
    if (size > REPO_MAX_FILE_BYTES) {
      skipped.push(`${rel}（${Math.round(size / 1024)} KB 超过单文件上限）`)
      continue
    }
    candidates.push({ path: rel, size })
  }
  // 小文件优先：同样是 40 个名额，README / 笔记比大日志更该进素材
  candidates.sort((a, b) => a.size - b.size || (a.path < b.path ? -1 : 1))

  const files: RepoFile[] = []
  let total = 0
  for (const candidate of candidates) {
    if (files.length >= REPO_MAX_FILES) {
      skipped.push(`${candidate.path}（超出 ${REPO_MAX_FILES} 个文件的上限）`)
      continue
    }
    if (total + candidate.size > REPO_MAX_TOTAL_BYTES) {
      skipped.push(`${candidate.path}（超出 ${Math.round(REPO_MAX_TOTAL_BYTES / 1024)} KB 总上限）`)
      continue
    }
    const rawUrl =
      `https://raw.githubusercontent.com/${encodeURIComponent(ref.owner)}/` +
      `${encodeURIComponent(ref.repo)}/${encodeURIComponent(ref.ref)}/` +
      candidate.path.split('/').map(encodeURIComponent).join('/')
    const res = await doFetch(rawUrl)
    if (!res.ok) {
      skipped.push(`${candidate.path}（下载失败 ${res.status}）`)
      continue
    }
    const text = await res.text()
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > REPO_MAX_FILE_BYTES) {
      skipped.push(`${candidate.path}（下载后 ${Math.round(bytes / 1024)} KB，超过单文件上限）`)
      continue
    }
    if (total + bytes > REPO_MAX_TOTAL_BYTES) {
      skipped.push(`${candidate.path}（超出总上限）`)
      continue
    }
    total += bytes
    files.push({ relPath: candidate.path, text })
  }

  return { files, skipped, hasSkillMd, scanned: entries.length }
}

/**
 * 仓库名 → 落盘用的目录名（`material/appended/<owner>-<repo>/`）。
 *
 * 为什么带 owner：两个仓库同名是常事，而素材清单里只看文件名（`appended/notes.md`）分不出谁是谁。
 */
export function repoDirName(ref: RepoRef): string {
  const base = `${ref.owner}-${ref.repo}`
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 60)
  // 兜底：全是不安全字符时也别给一个空目录名
  return base === '' ? 'repo' : base
}
