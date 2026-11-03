import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/**
 * 目录浏览：给「新建对话 / 新建任务」里那个工作目录输入框提供**点着选**的能力。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这件事必须由 daemon 做，而不是浏览器自己弹一个选择框
 * ══════════════════════════════════════════════════════════════════
 *
 * 浏览器里有 `<input type="file" webkitdirectory>`，但它交出来的是文件**本身**
 * 与**相对**路径（`webkitRelativePath`），拿不到绝对路径——而工作目录要的正是一个
 * 绝对路径（它会被写进 `conversation.workDir` / `run.workDir`，再由 daemon `chdir`
 * 过去）。所以"点着选"这条路只有一条：**daemon 列出磁盘上的目录，页面画出来**。
 *
 * 边界（这一批刻意收窄的地方）：
 *   · 只给**名字与类型**（目录 / 文件），**绝不读内容**——这不是文件浏览器，是
 *     "这个目录是不是我要接进来的那个"的确认现场；
 *   · 不提供删除 / 重命名 / 新建，也不写任何东西（纯 `readdir`）；
 *   · 不跟随隐藏项（`.` 开头）：仓库的 `.git` 之类对"是不是这里"毫无帮助，只会
 *     把清单淹掉。真要进一个隐藏目录，界面上的路径输入框仍然能直接打到。
 */
export interface DirEntry {
  name: string
  /** 绝对路径（父目录 + 名字，已经过 realpath 的父目录）。 */
  path: string
  kind: 'dir' | 'file'
}

export interface DirListing {
  /** 正在列出的目录：绝对、已解析符号链接。 */
  path: string
  /** 上一级；`null` = 已经在根（再往上还是根，界面据此禁掉「上一级」）。 */
  parent: string | null
  /** 家目录与工作区根：界面上两个"回到熟悉地方"的快捷入口（都由 daemon 给，页面不猜）。 */
  home: string
  workRoot: string
  /** 目录在前、文件在后（文件只是让人确认"这里面确实是我的仓库"，不可选）。 */
  entries: DirEntry[]
  /** 条数被截断：大目录只用来确认，不当文件管理器用。 */
  truncated: boolean
}

export type DirListResult =
  | { ok: true; listing: DirListing }
  | { ok: false; code: 'not_found' | 'not_a_dir' | 'denied' | 'not_absolute'; error: string }

export interface ListDirInput {
  /** 要列的目录；空串 = 家目录（界面第一次打开时什么都不用传）。 */
  path?: string
  /** 家目录（测试注入用；缺省 `os.homedir()`）。 */
  home?: string
  /** 工作区根（默认的自动分配目录），让界面能把它做成快捷入口。 */
  workRoot: string
  /** 最多列多少条（默认 400）。 */
  limit?: number
}

/** 一次最多列多少条。够看清一个仓库根目录，又不至于把页面拖住。 */
const DEFAULT_LIMIT = 400

/**
 * `~` 展开。
 *
 * ⚠️ 与 `tool-source.ts` 的 `expandHome` 是**同一条规则**（那边在装工具时用）：
 *    这里自己再写一遍是因为那个函数的用途是"安装来源"，将来它可能收紧成只认
 *    安装语义；`~` 的展开本身是个纯语法糖，不该被安装逻辑绑住。两边都改的时候
 *    记得对一下（`fs-browse.test.ts` 有一条只覆盖 `~` 与 `~/x`）。
 */
function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2))
  return input
}

/** 把 `readdir` / `realpath` 的原生错误翻译成能显示的码与一句话。 */
function mapError(error: unknown, path: string): DirListResult {
  const code = (error as NodeJS.ErrnoException | null)?.code ?? ''
  if (code === 'ENOENT') {
    return { ok: false, code: 'not_found', error: `这个目录不存在：${path}` }
  }
  if (code === 'ENOTDIR') {
    return { ok: false, code: 'not_a_dir', error: `这不是一个目录：${path}` }
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return { ok: false, code: 'denied', error: `没有权限读这个目录：${path}` }
  }
  return { ok: false, code: 'not_found', error: `这个目录读不出来：${path}` }
}

/**
 * 列一个目录。**纯读**，不创建、不修改任何东西。
 *
 * ★ 先 `realpath` 再 `readdir`，而不是直接列给进来的路径：
 *   路径里可能带符号链接（`~/repo -> /Volumes/x/repo`），不解析的话
 *   「上一级」会沿着**字面**父目录走，界面上就会出现"点了上一级，路径变了，
 *   列出来的东西却还是一样的"这种谁也看不懂的循环。解析之后，清单里每一行
 *   都是真实位置，"上一级"也总是真的上一级。
 *
 *   代价：使用者选中的是这个**真实**路径（写进 `conversation.workDir` 的是它，
 *   不是那个链接）——这对 agent 是好事（同一个目录只会有一条路径），对人也
 *   不意外（选择框里显示的正是解析后的路径）。
 */
export async function listDir(input: ListDirInput): Promise<DirListResult> {
  const raw = (input.path ?? '').trim()
  const home = input.home ?? homedir()
  const asked = raw === '' ? home : expandHome(raw)
  if (!isAbsolute(asked)) {
    return {
      ok: false,
      code: 'not_absolute',
      error: `需要一个绝对路径（收到的是「${raw}」）`,
    }
  }

  let real: string
  try {
    real = await realpath(asked)
  } catch (error) {
    return mapError(error, asked)
  }

  let dirents
  try {
    dirents = await readdir(real, { withFileTypes: true })
  } catch (error) {
    return mapError(error, real)
  }

  const limit = input.limit ?? DEFAULT_LIMIT
  const entries: DirEntry[] = []
  let truncated = false
  for (const entry of dirents) {
    if (entry.name.startsWith('.')) continue
    /**
     * ⚠️ 符号链接必须**先认出来**：`readdir` 的 Dirent 对链接**不跟随**，
     *    `isDirectory()` / `isFile()` 对它**都是 false**——照直写会把 `~/repo`
     *    这种链接目录整条丢掉（`local-skill-dirs.ts` 里踩过同一个坑）。
     *    所以对链接补一次 `stat`（跟随），再定类型。
     */
    let kind: 'dir' | 'file' | null = entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : null
    if (kind === null && entry.isSymbolicLink()) {
      try {
        const followed = await stat(join(real, entry.name))
        kind = followed.isDirectory() ? 'dir' : followed.isFile() ? 'file' : null
      } catch {
        // 断链：列出来点不动，不如不列
        kind = null
      }
    }
    // 管道 / 设备 / 套接字：既不是目录也不是文件，对"选工作目录"没有意义
    if (kind === null) continue
    if (entries.length >= limit) {
      truncated = true
      break
    }
    entries.push({ name: entry.name, path: join(real, entry.name), kind })
  }

  // 目录在前（要选的是它们），同类按名字排——顺序必须稳，否则同样的目录每次打开都换个次序
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })

  const up = dirname(real)
  return {
    ok: true,
    listing: {
      path: real,
      // 已经在根：`dirname('/') === '/'`，此时「上一级」没有意义，给 `null` 让界面禁掉
      parent: up === real ? null : up,
      home,
      workRoot: input.workRoot,
      entries,
      truncated,
    },
  }
}
