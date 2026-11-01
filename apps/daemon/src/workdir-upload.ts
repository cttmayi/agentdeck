/**
 * 把使用者**上传的文件**写进工作目录（分批第 203 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要一个单独的模块，而不是各自在路由里写 `writeFile`
 * ══════════════════════════════════════════════════════════════════
 *
 * 这条能力有**两个入口**：沉淀页（起草这一轮的工作目录，落在 `material/appended/`）与
 * 聊天页（这一轮对话的工作目录，落在 `uploads/`）。两处只差"落在哪个子目录"，
 * 而路径守卫、重名处理、尺寸上限、二进制判定的口径必须**一模一样**——各写一份就是
 * 迟早只修一处（本仓库最防的缺陷类型）。
 *
 * 几条写死的边界（每一条都对应一种会**静默**出事的情形）：
 *   · **只收文件名，不收路径**：`../../.ssh/authorized_keys` 这类必须在这里就被剥成 `authorized_keys`；
 *   · **落点由调用方给定、且必须是一个普通的相对子目录**：本模块不接受绝对路径、`..`、
 *     也不允许写进平台自己的状态目录（那个白名单在调用方，因为"哪些目录能放东西"是业务判断）；
 *   · **绝不覆盖**：同名自动 `-2`（覆盖会**静默**丢掉前一份，而两份都可能是有用的）；
 *   · **单份 / 总量上限**：走 JSON + base64，一次请求不可能太大；超了当场拒并说清数字。
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/** 单份上限：5 MiB（base64 后约 6.7 MiB，仍在请求体 8 MiB 之内）。 */
export const UPLOAD_MAX_FILE_BYTES = 5 * 1024 * 1024
/** 一次最多几份：再多就应该打成一个压缩包传（也不该把一次请求撑爆）。 */
export const UPLOAD_MAX_FILES = 10

export interface UploadedFile {
  /** 相对**工作目录**的路径（`material/appended/foo.png` / `uploads/foo.png`）。 */
  relPath: string
  /** 落盘时实际用的文件名（重名时是 `foo-2.png`）。 */
  name: string
  bytes: number
  /** 看着像二进制（决定"索引里要不要写一句用工具读"）。 */
  binary: boolean
}

export type UploadResult =
  | { ok: true; files: UploadedFile[]; bytes: number }
  | { ok: false; code: 'upload_too_large' | 'upload_too_many' | 'upload_empty' | 'unsafe_target'; error: string }

/**
 * 文件名清洗：只保留**最后一段**，去掉控制字符与路径分隔符，保留扩展名。
 *
 * ⚠️ 与 `safeMaterialName` 不同的两点：① **不补 `.md`**（上传的可能是 png/zip，
 *    补成 `.md` 等于把这个文件毁掉）；② 允许更长的名字（60 字），因为真实文件名常常带日期。
 */
export function safeUploadName(raw: string): string {
  const last = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = last
    // 控制字符与 Windows 非法字符一并折成 `-`
    .replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .slice(0, 80)
    .trim()
  return cleaned === '' ? 'file' : cleaned
}

/** 目录里不重名：`a.png` → `a-2.png` → `a-3.png`…（绝不覆盖）。 */
function nameWithoutClash(existing: ReadonlySet<string>, asked: string): string {
  if (!existing.has(asked)) return asked
  const dot = asked.lastIndexOf('.')
  const stem = dot === -1 ? asked : asked.slice(0, dot)
  const ext = dot === -1 ? '' : asked.slice(dot)
  let name = asked
  for (let i = 2; existing.has(name); i += 1) name = `${stem}-${i}${ext}`
  return name
}

/**
 * 看着像二进制吗。
 *
 * 判据刻意粗但**确定性**：前 8 KiB 里出现 NUL，或者可打印字符比例低于 70%。
 * 它只决定"素材索引里要不要写一句用工具读"，判错的代价是一句多余的提示——
 * 所以不需要（也不应该）在这里引入一个字符集嗅探库。
 */
export function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192)
  if (head.includes(0)) return true
  if (head.length === 0) return false
  let printable = 0
  for (const byte of head) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127)) printable += 1
  }
  return printable / head.length < 0.7
}

/**
 * 把一批文件写进 `workDir/<targetDir>/`。
 *
 * `targetDir` 由调用方给定（空串 = 工作目录根），必须是一段**普通的相对子目录**：
 * 绝对路径、`..`、反斜杠一律拒（`unsafe_target`），并且最终路径必须仍在 `workDir` 之下
 * （resolve 之后再看前缀——只靠字符串判断挡不住符号链接之外的边角）。
 */
export async function writeWorkDirUpload(
  workDir: string,
  targetDir: string,
  files: ReadonlyArray<{ name: string; base64: string }>,
): Promise<UploadResult> {
  if (files.length === 0) {
    return { ok: false, code: 'upload_empty', error: '没有要上传的文件' }
  }
  if (files.length > UPLOAD_MAX_FILES) {
    return {
      ok: false,
      code: 'upload_too_many',
      error: `一次最多 ${UPLOAD_MAX_FILES} 份（这次 ${files.length} 份）——更多的请打包成一个压缩包`,
    }
  }
  const segs = targetDir === '' ? [] : targetDir.split('/')
  if (segs.some((seg) => seg === '' || seg === '.' || seg === '..') || targetDir.includes('\\')) {
    return { ok: false, code: 'unsafe_target', error: `落点不合法：${targetDir}` }
  }
  const dir = resolve(workDir, ...segs)
  const root = resolve(workDir)
  if (dir !== root && !dir.startsWith(`${root}${sep}`)) {
    return { ok: false, code: 'unsafe_target', error: `落点跑出了工作目录：${targetDir}` }
  }

  // 先把所有解码结果算出来（超限的**整单拒**，不写半个进去）
  const decoded: Array<{ name: string; buf: Buffer }> = []
  for (const file of files) {
    const buf = Buffer.from(file.base64, 'base64')
    if (buf.length === 0) {
      return { ok: false, code: 'upload_empty', error: `「${file.name}」是空文件` }
    }
    if (buf.length > UPLOAD_MAX_FILE_BYTES) {
      return {
        ok: false,
        code: 'upload_too_large',
        error: `「${file.name}」${Math.round(buf.length / 1024)} KB，超过单份上限 ${UPLOAD_MAX_FILE_BYTES / 1024 / 1024} MB`,
      }
    }
    decoded.push({ name: safeUploadName(file.name), buf })
  }

  await mkdir(dir, { recursive: true })
  const existing = new Set(await readdir(dir).catch(() => [] as string[]))
  const out: UploadedFile[] = []
  let total = 0
  for (const file of decoded) {
    const name = nameWithoutClash(existing, file.name)
    existing.add(name)
    await writeFile(join(dir, name), file.buf)
    out.push({
      relPath: segs.length === 0 ? name : `${segs.join('/')}/${name}`,
      name,
      bytes: file.buf.length,
      binary: looksBinary(file.buf),
    })
    total += file.buf.length
  }
  return { ok: true, files: out, bytes: total }
}
