import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { ToolManifest } from '@agentdeck/protocol'

/**
 * 远端公共目录里的**工具包**（D40）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它与 daemon 侧用的是**同一份清单 schema**
 * ══════════════════════════════════════════════════════════════════
 *
 * 这是这一节唯一重要的决定：`packages/protocol/src/tools.ts` 的 `ToolManifest`
 * 既在这里校验（远端拒绝把坏包列出去），也在 daemon 侧校验（装进来的包必须合规）。
 *
 * 如果远端自己另写一套"看起来差不多"的检查，就会长出那种最难查的不一致：
 * **远端说 A、daemon 按 B 解析**，而症状是"装进来的包少了一个动作"——
 * 没有报错、没有堆栈，只有一处功能静静地不工作。
 *
 * ⚠️ 远端**不做安装**：装工具包会在使用者机器上落盘、并让那些脚本真的被执行。
 *    它只回答"目录里有哪些包、内容是什么"，装与否、准不准自动执行，全部在本地。
 *
 * ⚠️ 与 skill 一样，目录里**只收文本文件**：二进制在这里就被拒并记下来，
 *    而不是送下去之后在某个环节写坏。
 */

/** 单文件上限（与 daemon 侧同一数量级；这里更小的原因是它要经网络传下去）。 */
const MAX_FILE_BYTES = 128 * 1024
/** 一个包所有文件加起来的上限。 */
const MAX_TOTAL_BYTES = 512 * 1024
/** 一个包的文件数上限。 */
const MAX_FILES = 32

export interface CatalogToolEntry {
  slug: string
  name: string
  version: string | null
  /** 一句话说明（取自清单的 `description`）。 */
  summary: string
  /** 清单原件——**原样**交给本地，判据在本地再走一遍。 */
  manifest: Record<string, unknown>
  /** 包里的文本文件（相对路径 → 内容），含入口脚本。 */
  files: Record<string, string>
  /** `TOOL.md` 的正文（没有就是空串）。 */
  docs: string
}

export interface CatalogLoadResult {
  tools: CatalogToolEntry[]
  /** 明确**没**收进来的东西及原因（坏清单、二进制、超限……）。 */
  skipped: Array<{ path: string; reason: string }>
}

function isProbablyText(buf: Buffer): boolean {
  if (buf.includes(0)) return false
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)
}

/**
 * 扫一个目录，把里面的包读出来。
 *
 * 目录布局：`<root>/<任意层级>/<包目录>/tool.json`——**以 `tool.json` 为准**，
 * 不要求固定的深度。这样把包按用途分文件夹也照样能列出来。
 */
export async function loadCatalogTools(root: string): Promise<CatalogLoadResult> {
  const tools: CatalogToolEntry[] = []
  const skipped: Array<{ path: string; reason: string }> = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      // 目录不存在是**正常**的（目录可以为空，界面要有空态）；其余如实记下来
      const code = (err as { code?: string }).code
      if (code !== 'ENOENT') skipped.push({ path: dir, reason: `目录读不了：${String(err)}` })
      return
    }

    const manifestEntry = entries.find((e) => e.isFile() && e.name === 'tool.json')
    if (manifestEntry) {
      const loaded = await loadOne(dir)
      if ('reason' in loaded) skipped.push({ path: relative(root, dir) || dir, reason: loaded.reason })
      else tools.push(loaded)
      return // 包目录里不再往下找：嵌套的 tool.json 只会是包自己的东西
    }

    if (depth >= 4) return
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      await walk(join(dir, entry.name), depth + 1)
    }
  }

  await walk(root, 0)
  tools.sort((a, b) => a.slug.localeCompare(b.slug))
  return { tools, skipped }
}

async function loadOne(dir: string): Promise<CatalogToolEntry | { reason: string }> {
  const manifestPath = join(dir, 'tool.json')
  let manifestText: string
  try {
    manifestText = await readFile(manifestPath, 'utf8')
  } catch (err) {
    return { reason: `tool.json 读不了：${String(err)}` }
  }

  let raw: unknown
  try {
    raw = JSON.parse(manifestText)
  } catch (err) {
    return { reason: `tool.json 不是合法 JSON：${String(err)}` }
  }

  // ★ 与 daemon 侧**同一份** schema（见文件头：不一致是这里最容易长出来的错）
  const parsed = ToolManifest.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(根)'}：${i.message}`)
    return { reason: `清单不合规（${issues.length} 处）：${issues.join('；')}` }
  }
  const manifest = parsed.data

  const files: Record<string, string> = {}
  let docs = ''
  let total = 0
  let count = 0

  /**
   * 收包里的文件（文本、限额、`TOOL.md` 单独放）。
   *
   * ⚠️ 逐文件返回**哪一种**问题（哪个文件是二进制、哪一条超限），而不是笼统地
   *    "这个包不行"——目录里的人（也就是写这个包的人）需要知道改哪儿。
   *    这也是这些包**没被列出来**时 `skipped` 里那句话的来源。
   */
  const collect = async (current: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      const rel = relative(dir, full).split(sep).join('/')
      // 符号链接一律不跟随：可能指到目录外面，也可能成环
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        const inner = await collect(full)
        if (!inner.ok) return inner
        continue
      }
      if (!entry.isFile() || rel === 'tool.json') continue

      const buf = await readFile(full)
      // 只收文本：二进制落下去只会变成坏文件，而且**是静默的**
      if (!isProbablyText(buf)) {
        return { ok: false, reason: `文件 ${rel} 不是文本（本目录只收脚本与文档）` }
      }
      count += 1
      if (count > MAX_FILES) return { ok: false, reason: `文件太多（上限 ${MAX_FILES} 个）` }
      if (buf.length > MAX_FILE_BYTES) {
        return { ok: false, reason: `文件 ${rel} 超过单文件上限 ${MAX_FILE_BYTES} 字节` }
      }
      total += buf.length
      if (total > MAX_TOTAL_BYTES) {
        return { ok: false, reason: `所有文件加起来超过上限 ${MAX_TOTAL_BYTES} 字节` }
      }
      if (rel === 'TOOL.md') docs = buf.toString('utf8')
      else files[rel] = buf.toString('utf8')
    }
    return { ok: true }
  }

  const collected = await collect(dir)
  if (!collected.ok) return { reason: collected.reason }

  // 入口必须在包里 —— 清单说了不算（与本地安装同一条判据）
  const entries = [manifest.entry, ...manifest.actions.map((a) => a.entry ?? manifest.entry)]
  const missing = entries.filter((p) => !(p in files))
  if (missing.length > 0) {
    return { reason: `清单声明的入口不在包里：${[...new Set(missing)].join('、')}` }
  }
  return {
    slug: manifest.slug,
    name: manifest.name,
    version: manifest.version,
    summary: manifest.description,
    // 原样交下去：本地会**再走一遍**同一份 schema（远端说 A、daemon 按 B 是最坏的一种错）
    manifest: manifest as unknown as Record<string, unknown>,
    files,
    docs,
  }
}
