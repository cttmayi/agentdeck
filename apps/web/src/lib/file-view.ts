/**
 * 工作目录文件的**查看器**：一份文件该按什么看、两面各是什么、要不要着色。
 *
 * ══════════════════════════════════════════════════════════════════
 * 「原文」是一个承诺，不是一种样式
 * ══════════════════════════════════════════════════════════════════
 *
 * 这一栏里的文件是 **agent 写的**，而使用者要靠它判断"到底做成了什么"。
 * 所以查看器必须能回答一个很具体的问题：**我现在看到的，是不是磁盘上那个文件？**
 *
 * 「原文」那一面的定义因此是死板的：**服务端 `/file` 发回来的那串字节，按 UTF-8
 * 解出来的文本**——不格式化 JSON、不重排 CSV、不导出行号、不加颜色。唯一动过的
 * 一层是浏览器必须转义 `< > &`（否则文件里一个 `</textarea>` 就能把页面搞坏）。
 *
 * 于是"渲染"那一面**只许加标记、不许改字**：Markdown 渲染成文档、代码套一层
 * `<span>` 着色，一个一个字符都还在。两条判据都由测试与布局探针钉着（探针会
 * 自己 `fetch` 一次接口，与「原文」面里的文本逐字比对）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么判据在这一层、而且是纯函数
 * ══════════════════════════════════════════════════════════════════
 *
 * `apps/web` 没有组件级测试，写在模板里的分支只能靠手点界面验证。而这里的分支
 * 恰好是"错了也不报错"的那一类：一个 `.md` 被当成纯文本显示，看起来完全正常，
 * 只是少了渲染——没人会发现。所以分类、默认面、着色阈值、语言映射全部提出来，
 * 由 `file-view.test.ts` 穷举。
 */
import type { WorkDirFile } from './api.ts'

/** 一份文件按内容分到哪一类。 */
export type FileKind =
  | 'markdown'
  | 'html'
  | 'image'
  | 'pdf'
  | 'json'
  | 'csv'
  | 'code'
  | 'text'
  | 'binary'

/** 两面：渲染过的那一面 / 原样的那一面。 */
export type FileFace = 'rendered' | 'raw'

/** 超过这个大小就不着色了——8MB 的 `<pre>` 套一层高亮会把页面卡死。 */
export const HIGHLIGHT_MAX_BYTES = 256 * 1024

/** 二进制「原文」面里给多少字节的十六进制。 */
export const HEX_PEEK_BYTES = 512

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif'])
const CODE_EXT = new Set([
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.sh',
  '.bash',
  '.zsh',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.css',
  '.scss',
  '.sql',
  '.go',
  '.rs',
  '.java',
  '.rb',
  '.php',
  '.c',
  '.h',
  '.cpp',
  '.xml',
  '.log',
])

/** 扩展名（小写，带点）。没有扩展名时给空串。 */
export function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/**
 * 分类。
 *
 * ⚠️ **主要看服务端给的 content-type，扩展名只用来细分文本**。
 *    理由：服务端那份表（`contentTypeFor`）是"这个文件是什么"的唯一出处，
 *    而 `.md` / `.py` / `.json` 在它那里都是 `text/plain`——单靠类型分不出
 *    Markdown 与普通文本，所以文本这一类必须再按扩展名细分。
 *
 * ⚠️ `application/octet-stream` 是服务端的**明确表态**："这不是我认识的文本类型"
 *    （见它的注释：认不出来的一律 octet-stream，**不猜** text/plain）。所以它优先
 *    于扩展名：一个叫 `.py` 但内容是二进制的东西，按二进制处理才对。
 */
export function fileKindOf(contentType: string, path: string): FileKind {
  const type = contentType.split(';')[0]!.trim().toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type === 'application/pdf') return 'pdf'
  if (type === 'text/html') return 'html'
  if (type === 'application/octet-stream') return 'binary'

  const ext = extOf(path)
  if (ext === '.md' || ext === '.markdown') return 'markdown'
  if (ext === '.json') return 'json'
  if (ext === '.csv' || ext === '.tsv') return 'csv'
  if (CODE_EXT.has(ext)) return 'code'
  if (type.startsWith('text/') || type === 'application/json') return 'text'
  return 'binary'
}

/**
 * 解出来的文本**其实是二进制**吗？
 *
 * 扩展名会说谎（有人把 zip 命名成 `.txt`），而那时把它当文本渲染会得到一屏
 * 替换字符——使用者看到的是"文件坏了"，而不是"这不是文本"。判据用 NUL 字节：
 * 真正的文本文件里不会有它，而压缩/可执行/图片里到处都是。
 */
export function looksBinaryText(text: string): boolean {
  return text.includes('\u0000')
}

/**
 * 分类之后再看内容：**只有文本类**才该问"解出来像不像二进制"。
 *
 * image / pdf 不参与——服务端给的 `image/*`、`application/pdf` 是**明确表态**
 * （与 octet-stream 同源的理由），不是扩展名在猜。而 PNG 按 UTF-8 解出来**必然
 * 带 NUL**，拿"内容像不像文本"去判断，只会把图片误伤成二进制——那正是
 * "PNG 显示成原文"这个 bug 的来源。
 */
export function refineKind(kind: FileKind, text: string): FileKind {
  if (kind === 'binary' || kind === 'image' || kind === 'pdf') return kind
  return looksBinaryText(text) ? 'binary' : kind
}

/** 打开一份文件时默认看哪一面。 */
export function defaultFace(kind: FileKind): FileFace {
  // 二进制没有"渲染"可言；图片/PDF 的"渲染"就是它本身，那才是想看的东西。
  if (kind === 'binary') return 'raw'
  if (kind === 'markdown' || kind === 'html') return 'rendered'
  if (kind === 'json' || kind === 'csv') return 'rendered'
  if (kind === 'image' || kind === 'pdf') return 'rendered'
  // 代码与纯文本没有"渲染"：着色只是加标记，默认给的就是它。
  return 'rendered'
}

/**
 * 这一面存在吗——二进制没有「渲染」，PDF 没有可读的「原文」。
 *
 * ⚠️ 图片**两面都有**：SVG 是文本（XML），它的"原文"就是源码；位图（.png/.jpg/
 *    等）的"原文"按字节看是十六进制——两者都是使用者会想确认的东西
 *    （"这张图到底是不是磁盘上那个文件"，十六进制就是对得上号的证据）。
 *    原文面到底给文本还是 hex，由 `rawFaceIsHex` 按路径细分。
 */
export function hasFace(kind: FileKind, face: FileFace): boolean {
  if (kind === 'binary') return face === 'raw'
  if (kind === 'pdf') return face === 'rendered'
  return true
}

/**
 * 「原文」那一面是不是十六进制（没有可读文本时用 hex 代替）。
 *
 * 二进制是（`rawFaceIsHex` 的老语义）；位图也是——按字节看就是十六进制，
 * 与二进制共用同一个 hex 显示。**SVG 例外**：它是文本（XML），原文面给源码，
 * 不是 hex。判据用路径（`.svg`），不用 content-type——`image/svg+xml` 就是
 * `image/*`，类型上分不出位图与矢量。
 */
export function rawFaceIsHex(kind: FileKind, path = ''): boolean {
  if (kind === 'binary') return true
  if (kind === 'image') return extOf(path) !== '.svg'
  return false
}

/**
 * 要不要着色。
 *
 * ★ 阈值不是洁癖：那一栏的读取上限是 8MB，而给一屏 8MB 的文本套高亮会把页面
 *   卡死几秒到几十秒。超过阈值时**照样给原文**，只是不着色，并说明原因——
 *   "看不见"与"慢到不能用"之间，选前者。
 */
export function shouldHighlight(kind: FileKind, bytes: number): boolean {
  if (kind !== 'code') return false
  return bytes > 0 && bytes <= HIGHLIGHT_MAX_BYTES
}

/**
 * 这个后缀对应 highlight.js 的哪个语言——**认不出来就给 `null`（不着色）**。
 *
 * ⚠️ 不猜：一个认不出来的后缀如果硬塞给 `highlightAuto`，它会挑一个"最像"的
 *    语法，于是界面用一套**错的**配色讲一件看起来很权威的事。宁可不着色。
 */
export function languageOf(path: string): string | null {
  const map: Record<string, string> = {
    '.py': 'python',
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.jsx': 'javascript',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.json': 'json',
    '.html': 'xml',
    '.xml': 'xml',
    '.css': 'css',
    '.scss': 'scss',
    '.sql': 'sql',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.rb': 'ruby',
    '.php': 'php',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.toml': 'ini',
    '.ini': 'ini',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.log': 'plaintext',
  }
  return map[extOf(path)] ?? null
}

/** 这一份文件的路径要不要显示成两段（目录暗、文件名亮）——基名与目录。 */
export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/')
  if (slash === -1) return { dir: '', name: path }
  return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) }
}

/** 十六进制预览：每行 16 字节，右侧配可打印字符（不可打印打 `.`）。 */
export function hexDump(bytes: Uint8Array, max = HEX_PEEK_BYTES): string {
  const slice = bytes.subarray(0, max)
  const lines: string[] = []
  for (let i = 0; i < slice.length; i += 16) {
    const chunk = slice.subarray(i, i + 16)
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const text = [...chunk]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
      .join('')
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${text}`)
  }
  return lines.join('\n')
}

/** 给「新标签页打开」用的地址（界面里唯一直接拼 URL 的地方）。 */
export function fileUrl(base: string, entry: Pick<WorkDirFile, 'path'>): string {
  return `${base}/file?path=${encodeURIComponent(entry.path)}`
}

/** CSV 表格最多显示多少行/列——超出的部分明说截断了，不假装全在。 */
export const CSV_MAX_ROWS = 200
export const CSV_MAX_COLS = 30

/**
 * CSV 的「渲染」面：拆成表格。
 *
 * 按 RFC4180 的最小集做：引号包住的字段里的逗号与换行不算分隔符，两个连续引号
 * 表示一个引号。**不做类型推断**（不要把 `1.0` 显示成 `1`、不要把空串显示成
 * `null`）：这一面是"看得清楚一点"，不是"我替你解释你的数据"。
 */
export function parseCsv(source: string): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let truncated = false

  const pushField = (): void => {
    row.push(field)
    field = ''
  }
  const pushRow = (): void => {
    pushField()
    rows.push(row)
    row = []
  }

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      pushField()
    } else if (ch === '\n') {
      pushRow()
    } else if (ch !== '\r') {
      field += ch
    }
  }
  // 最后一行没有换行符结尾时也要收下（只有真有内容才算一行）
  if (field !== '' || row.length > 0) pushRow()

  let out = rows
  if (out.length > CSV_MAX_ROWS) {
    out = out.slice(0, CSV_MAX_ROWS)
    truncated = true
  }
  if (out.some((r) => r.length > CSV_MAX_COLS)) {
    out = out.map((r) => r.slice(0, CSV_MAX_COLS))
    truncated = true
  }
  return { rows: out, truncated }
}
