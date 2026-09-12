import type { RuntimeDescriptor, SupportedVersions } from './runtime-table.ts'

/**
 * CLI 版本支持判定（FR-CLI-07）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 需求里那句话的重点
 * ══════════════════════════════════════════════════════════════════
 *
 * 「必须声明并测试受支持的 CLI 版本范围。**以实际版本验证，不得凭文档推断**」
 *
 * 前半句容易被做成"表里填个范围字符串就完事"，那样它只是一个注释——
 * 而且是一个**会骗人的注释**：填了范围，看起来就像验证过了。
 *
 * 所以这里的判定把"有没有真的验证过"当成一等公民：`verifiedWith` 为空
 * 的一行会被报成 `undeclared`（**未声明**），而不是 `supported`。
 * 一个没跑通过的版本区间，不该因为我们写了它就被当成可信。
 *
 * ══════════════════════════════════════════════════════════════════
 * 关于这个匹配器的能力边界（如实说明）
 * ══════════════════════════════════════════════════════════════════
 *
 * **它不是完整 semver**：不支持 `||`、不支持 `^` / `~` 的前导零与预发布
 * 特殊规则、预发布版本只做字符串比较。刻意如此——引入一整个 semver 实现
 * 只为了判断"这个 CLI 版本我们验没验过"，代价与收益不成比例。
 *
 * 支持的形式（够用，且好读）：
 *
 * | 写法 | 含义 |
 * |---|---|
 * | `*` | 任意版本 |
 * | `2.1.143` | 恰好这个版本 |
 * | `2.1.x` | 主次版本相同即可 |
 * | `>=2.0.0` | 比较运算，可写多个（空格分隔，**全部满足**才算匹配） |
 * | `>=2.0.0 <3.0.0` | 区间 |
 */

export type VersionSupportStatus =
  /** 在范围内，且该版本被实测过。 */
  | 'verified'
  /** 在范围内，但没实测过这个具体版本。 */
  | 'in-range-unverified'
  /** 有声明也有实测，但当前版本落到范围外。 */
  | 'out-of-range'
  /** 没有实测版本 ⇒ **不算声明**（"不得凭文档推断"）。 */
  | 'undeclared'
  /** 没拿到版本号（探测失败或 CLI 不报版本）。 */
  | 'unknown'

export interface VersionSupportResult {
  status: VersionSupportStatus
  /** 拿到的原始版本串。 */
  detected: string | null
  /** 声明里实测过的版本，便于直接显示"我们验过这些"。 */
  verifiedWith: readonly string[]
  /** 落到范围外时是否应当拒绝执行。 */
  refuse: boolean
  /** 一句可直接展示给人看的话。 */
  message: string
}

/** 解析 `1.2.3` / `1.2` / `1`，返回数字数组；解析不出返回 null。 */
export function parseVersion(text: string): number[] | null {
  const cleaned = text.trim().replace(/^v/i, '')
  // 预发布与构建元数据在这里被截掉：本匹配器只比主.次.补丁
  const core = cleaned.split(/[-+]/)[0] ?? ''
  if (core === '') return null
  const parts = core.split('.')
  const nums: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    nums.push(Number(part))
  }
  return nums.length > 0 ? nums : null
}

/** 逐段比较，缺的段按 0 补齐。返回 -1 / 0 / 1。 */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * 判断版本是否落在范围表达式内。
 *
 * 表达式无法解析时返回 `null`——**不返回 false**。
 * 这两者必须分开："解析不了"是表写错了，"不匹配"是版本真的不匹配。
 * 混成一个 `false` 会让一个笔误看起来很像是版本的问题。
 */
export function matchesVersionRange(version: string, range: string): boolean | null {
  const actual = parseVersion(version)
  if (!actual) return null

  const expr = range.trim()
  if (expr === '' || expr === '*') return true

  // 空格分隔的多个条件，**全部满足**才算匹配
  for (const term of expr.split(/\s+/).filter((t) => t !== '')) {
    const op = /^(>=|<=|>|<|=)?(.*)$/.exec(term)
    if (!op) return null
    const operator = op[1] ?? '='
    const operandText = (op[2] ?? '').trim()
    if (operandText === '') return null

    // 通配写法：`2.1.x` / `2.x`
    if (/^[0-9xX.*]+$/.test(operandText) && /[xX*]/.test(operandText)) {
      const wanted = operandText.split('.')
      for (let i = 0; i < wanted.length; i += 1) {
        const seg = wanted[i]!
        if (seg === 'x' || seg === 'X' || seg === '*') break
        if (!/^\d+$/.test(seg)) return null
        if ((actual[i] ?? 0) !== Number(seg)) return false
      }
      continue
    }

    const operand = parseVersion(operandText)
    if (!operand) return null
    const cmp = compareVersions(actual, operand)
    const ok =
      operator === '=' ? cmp === 0
      : operator === '>=' ? cmp >= 0
      : operator === '<=' ? cmp <= 0
      : operator === '>' ? cmp > 0
      : cmp < 0
    if (!ok) return false
  }
  return true
}

/**
 * 判定一个 runtime 在当前 CLI 版本下的支持状态。
 *
 * ★ 这是"不得凭文档推断"落到代码里的地方：`verifiedWith` 为空 ⇒
 *   **不算声明**。填一个范围字符串就宣称支持，是最容易发生也最有害的做法，
 *   因为它看起来像是验证过了。
 */
export function checkVersionSupport(
  descriptor: RuntimeDescriptor,
  detectedVersion: string | null,
): VersionSupportResult {
  const declared: SupportedVersions | undefined = descriptor.versions
  const verifiedWith = declared?.verifiedWith ?? []

  if (!declared || verifiedWith.length === 0) {
    return {
      status: 'undeclared',
      detected: detectedVersion,
      verifiedWith,
      refuse: false,
      message:
        `${descriptor.key} 没有声明受支持的 CLI 版本（或声明里没有**实测过**的版本）。` +
        `按 FR-CLI-07，凭文档推断的范围不算声明——所以这里如实报成"未声明"，` +
        `而不是当成"都支持"。`,
    }
  }

  if (!detectedVersion) {
    return {
      status: 'unknown',
      detected: null,
      verifiedWith,
      refuse: false,
      message:
        `没能拿到 ${descriptor.key} 的版本号，无法判断是否落在已声明的范围内。` +
        `已声明的范围：${declared.range}（实测过：${verifiedWith.join(', ')}）。`,
    }
  }

  // 先看是不是**实测过的具体版本**——这一条比范围更强
  if (verifiedWith.some((v) => compareVersions(parseVersion(v) ?? [], parseVersion(detectedVersion) ?? []) === 0)) {
    return {
      status: 'verified',
      detected: detectedVersion,
      verifiedWith,
      refuse: false,
      message: `${descriptor.key} ${detectedVersion} 是实测过的版本。`,
    }
  }

  const matched = matchesVersionRange(detectedVersion, declared.range)
  if (matched === null) {
    return {
      status: 'undeclared',
      detected: detectedVersion,
      verifiedWith,
      refuse: false,
      message:
        `版本范围表达式无法解析：${JSON.stringify(declared.range)}。` +
        `这是**表写错了**，不是版本不匹配——请修正描述表。`,
    }
  }

  if (matched) {
    return {
      status: 'in-range-unverified',
      detected: detectedVersion,
      verifiedWith,
      refuse: false,
      message:
        `${descriptor.key} ${detectedVersion} 落在声明的范围内（${declared.range}），` +
        `但这个具体版本没有被实测过。实测过的是：${verifiedWith.join(', ')}。`,
    }
  }

  return {
    status: 'out-of-range',
    detected: detectedVersion,
    verifiedWith,
    refuse: declared.onMismatch === 'refuse',
    message:
      `${descriptor.key} ${detectedVersion} **落在声明的范围之外**（${declared.range}）。` +
      `实测过的是：${verifiedWith.join(', ')}。` +
      (declared.onMismatch === 'refuse'
        ? `该 runtime 声明为拒绝执行——继续跑很可能产出不可解析的输出。`
        : `仍会继续执行，但这一条会记进审计：出问题时先看这里。`),
  }
}

/**
 * 版本判定是否属于"不该继续跑"的情形。
 *
 * 单独拆出来是因为调用点需要**先问、再决定**，而不是从 `message` 里猜。
 */
export function shouldRefuseToRun(result: VersionSupportResult): boolean {
  return result.status === 'out-of-range' && result.refuse
}
