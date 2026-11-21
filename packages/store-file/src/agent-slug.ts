/**
 * **智能体目录名 = 名字的 slug**（D231，2026-11 使用者定的方案 D）。
 *
 * 目录名是**给人看的标签**（`agents/助手审核员/`），身份仍然是 `agent.json` 里的 `id`
 * （ULID，永不变）。所以这里只做一件事：把一个自由文本的名字算成一个**安全的目录名**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 规则（每条都对应一种真会踩到的坏法）
 * ══════════════════════════════════════════════════════════════════
 *
 *   ① **保留中日韩字符**：`智能体生成者` → `智能体生成者`。本机工具，人能认最重要；
 *      拼音化会让"目录名"与"界面上的名字"对不上，比 ULID 更糟。
 *   ② **ASCII 一律转小写**：macOS 默认 APFS **大小写不敏感**，`Writer` 与 `writer`
 *      会是同一个目录——不定下规则就会"建了第二个，第一个被覆盖"。
 *   ③ **非法字符 → `-`**：`/ \ : * ? " < > |`（Windows 保留字符，`platform-compat.md`）、
 *      控制字符、空白。
 *   ④ **压掉连续 `-`、去掉首尾 `-`**；算完是空的 ⇒ `agent`（调用方再解决唯一性）。
 *   ⑤ **长度上限 60**：多数文件系统单段 255 字节，中文 3 字节/字 ⇒ 60 字 ≈ 180 字节，留足余量。
 *   ⑥ **保留名加前缀**：`.` / `..` / 以 `.` 开头（本仓库把点开头当"占位/元文件"跳过）、
 *      Windows 设备名（`CON` `PRN` `AUX` `NUL` `COM1..9` `LPT1..9`）。
 *
 * ⚠️ **唯一性不在这里解决**：slug 是**多对一**的（`写作员` 与 `写作 员` 都算出 `写作员`），
 * 撞车由调用方加 `-2` / `-3` 后缀处理（`uniqueAgentDirName`）。
 */

/** 目录名长度上限（见规则 ⑤）。 */
export const AGENT_DIR_NAME_MAX = 60

/** Windows 上建不出目录的名字（大小写无关）。 */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/**
 * 名字 → 目录名（slug）。**不保证唯一**，只保证"安全 + 可读 + 稳定"。
 *
 * 同样的名字永远算出同样的 slug（没有随机、没有时间）——所以它是**可以重算的**：
 * 对账时拿它和磁盘上的目录名比，就能发现"有人在别处改过"。
 */
export function slugForAgentName(name: string): string {
  const lowered = name.trim().toLowerCase()
  let out = ''
  for (const ch of lowered) {
    // 控制字符与已列出的 Windows 非法字符一律变 `-`
    if ('/\\:*?"<>|'.includes(ch) || ch.charCodeAt(0) < 0x20) {
      out += '-'
      continue
    }
    // 空白（含全角空格）也折成 `-`
    if (/\s/u.test(ch)) {
      out += '-'
      continue
    }
    out += ch
  }
  out = out.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  if (out.length > AGENT_DIR_NAME_MAX) out = out.slice(0, AGENT_DIR_NAME_MAX).replace(/-+$/g, '')
  // 保留名 / 点开头：加前缀（本仓库把点开头当元文件跳过，不许智能体用）
  if (out === '' || out.startsWith('.') || WINDOWS_RESERVED.has(out)) {
    out = `agent-${out}`.replace(/-+$/g, '')
  }
  return out
}

/**
 * 在**已占用的目录名**里挑一个唯一的：`写作员` → `写作员` / `写作员-2` / `写作员-3`……
 *
 * @param taken 已经用在别的智能体上的目录名（大小写不敏感地比：APFS 上 `A` 与 `a` 是同一个）
 *
 * ⚠️ 只在**建目录 / 改名**时用。日常读盘**不重算**——磁盘上的目录名就是事实
 * （索引启动时从 `readdir` 建，见 `file-store.ts`）。
 */
export function uniqueAgentDirName(name: string, taken: ReadonlySet<string>): string {
  const base = slugForAgentName(name)
  const used = new Set([...taken].map((x) => x.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  // 极端情况（同一名字被建了上千次）：退化成随机后缀，仍然是安全的目录名
  return `${base}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 磁盘上的目录名**是不是**这个名字该有的样子（对账用）。
 *
 * 允许带唯一性后缀：`写作员` 与 `写作员-2` 都算"对"（后者是 slug 撞名时加的）。
 * 反过来说，`外面改的名字` 这种就是**不对**——对账只报不改（D231）。
 */
export function agentDirNameMatches(name: string, dirName: string): boolean {
  const base = slugForAgentName(name)
  return dirName.toLowerCase() === base.toLowerCase() || dirName.toLowerCase().startsWith(`${base.toLowerCase()}-`)
}
