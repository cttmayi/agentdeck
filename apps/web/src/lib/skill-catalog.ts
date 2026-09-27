/**
 * 远端目录条目 vs 本地已装 skill：**该显示什么**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这条逻辑原来不存在，后果是"同名 = 一条死路"
 * ══════════════════════════════════════════════════════════════════
 *
 * daemon 对同名一律拒绝写入（"避免下载顺手覆盖了你自己的东西"，这条是对的），
 * 但界面此前**不做任何比较**：只要本地有同名条目，点击就是一句
 * "已有同名 skill……确实要替换请显式传 overwrite: true"。
 *
 * 于是最常见的两种情况都无法表达：
 *
 *   - **本地装的就是目录里那一版**（版本一致）——本该说"已经安装"，
 *     结果每次点都是一条看起来像出错的提示；
 *   - **目录里是新版本**——本该有一个「更新」的动作，结果使用者只能自己去
 *     猜"我是不是该勾那个替换"。
 *
 * 所以这里做一次**诚实的比较**，并把结论落成界面上的一个状态。
 * 比较是纯函数：不碰网络、不碰存储，可以被穷举地测。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个状态里**没有中文**（D39）
 * ══════════════════════════════════════════════════════════════════
 *
 * 界面语言可切之后，"该显示什么字"就不是这层的事了：这里只说清"按钮上那条
 * 文案是哪个键、插什么值"（`labelId` / `hintId`），由界面按当前语言渲染
 * （`Skills.svelte` 写的是 `$t(state.labelId, state.labelParams)`）。
 * 否则切到英文时，这一层的按钮会留在中文里——而且没有任何编译期信号。
 */
import type { TextParams, WebTextId } from '@agentdeck/i18n'

/** 本地那一条需要的最小信息（只需要这几个字段，便于测试）。 */
export interface LocalSkillLike {
  slug: string
  version?: string | null
  source?: string
}

/** 远端目录里那一条。 */
export interface CatalogEntryLike {
  slug: string
  version: string
}

export type CatalogAction = 'install' | 'installed' | 'update' | 'downgrade' | 'replace'

export interface CatalogEntryState {
  /** 界面该给的动作。 */
  action: CatalogAction
  /**
   * 按钮上的字的**文案键**。
   *
   * ★ 类型是 `WebTextId`（= 词表里真实存在的键）：写错一个字母，`tsc` 就会红，
   *   而不是等到界面上冒出一串 `install.actionInstal` 才被发现。
   */
  labelId: WebTextId
  /** 按钮文案的插值（只有带版本号的动作才有）。 */
  labelParams?: TextParams
  /** 一句话说明为什么是它（要显示出来，别让人猜）的**文案键**。 */
  hintId: WebTextId
  /** 提示文案的插值。 */
  hintParams?: TextParams
  /** 按钮是否不可点。 */
  disabled: boolean
  /**
   * 安装时要不要带 `overwrite: true`。
   *
   * ★ 只有"明确要动本地已有的东西"时才为真。**新装永远是 false**——
   *   `overwrite` 是"我知道我在覆盖"的确认，不该被顺手加上。
   */
  needsOverwrite: boolean
}

/**
 * 组装一个状态。
 *
 * 抽出来是为了让"哪个动作带插值"只在这里决定一次：六个分支里带版本号的两个不一样，
 * 而缺省时那个字段必须**整个不出现**（`exactOptionalPropertyTypes` 下
 * `labelParams: undefined` 是编译错误）——手写六遍就是六处能写错的地方。
 */
function makeState(input: {
  action: CatalogAction
  labelId: WebTextId
  hintId: WebTextId
  labelParams?: TextParams
  hintParams?: TextParams
  disabled: boolean
  needsOverwrite: boolean
}): CatalogEntryState {
  return {
    action: input.action,
    labelId: input.labelId,
    ...(input.labelParams ? { labelParams: input.labelParams } : {}),
    hintId: input.hintId,
    ...(input.hintParams ? { hintParams: input.hintParams } : {}),
    disabled: input.disabled,
    needsOverwrite: input.needsOverwrite,
  }
}

/**
 * 比较两个版本号。
 *
 * 只认 `数字.数字[.数字…]` 这种最常见的形式；认不出来就返回 `null`
 * 表示**无法比较**（而不是猜一个大小）。
 *
 * ★ 但**两个字符串一模一样**时一定返回 `0`：相等这件事我们判得了，哪怕它不是
 *   `x.y.z` 的形式。不先判这一条，`beta` vs `beta` 会掉进下面"认不出来 ⇒ null"，
 *   而调用方（`catalogEntryState`）把 `null` 当成"版本不同 ⇒ 可以更新"——于是
 *   **两个完全相同的版本号**会在界面上显示成「更新」。
 *   （这一条是加工具页的更新按钮时才发现的：那边有测试直接断言它。）
 *
 * ⚠️ 不引 semver 依赖的理由：目录里的版本是发布者自己写的字符串，
 *    可能根本不是 semver（`2024-05`、`v2`、`beta`）。引一个严格实现
 *    只会让这些情况统统抛错，而这里的用途只是决定按钮上写什么字。
 *    认不出来时按"版本不同 ⇒ 可以更新"处理，并把版本号原样显示给使用者看，
 *    由他判断——这比替他猜要诚实。
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+(?:\.\d+)*)$/.exec(v.trim())
    if (!m) return null
    return m[1]!.split('.').map((n) => Number(n))
  }
  if (a.trim() === b.trim()) return 0
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return null

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0
    const y = right[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * 算出这个目录条目在界面上的状态。
 *
 * 四种情况，**不能合并**：
 *
 * 1. 本地没有 ⇒ 安装。
 * 2. 本地有、而且**有版本**（说明它记的是哪一版）：
 *    - 版本相同 ⇒ 已安装（按钮禁用）。这就是"版本一致提示已安装"。
 *    - 远端更新 ⇒ 更新。
 *    - 远端更旧 ⇒ 仍然是替换，但**说清是往回退**：把降级说成"更新"是在骗人。
 * 3. 本地有、**没有版本**（本地自建、或从路径/GitHub 装的 —— 那些本来就没有
 *    版本）⇒ 不能说"已安装"：我们**根本不知道**手上这份是不是同一份内容。
 *    所以是「替换」，并且提示来源不同。
 */
export function catalogEntryState(
  local: LocalSkillLike | undefined,
  entry: CatalogEntryLike,
): CatalogEntryState {
  // slug 不一致就当作"本地没有"。
  //
  // 调用方是按 slug 找到 local 再传进来的；万一哪天找错了（拿到别的 slug 的那条），
  // 不做这个检查就会拿两个**毫不相干**的版本号去比，然后在界面上写一句
  // "更新到 x.y.z"——错得毫无痕迹。防御成本近乎为零。
  if (!local || local.slug !== entry.slug) {
    return makeState({
      action: 'install',
      labelId: 'install.actionInstall',
      hintId: 'install.foundInDir',
      hintParams: { slug: entry.slug, version: entry.version },
      disabled: false,
      needsOverwrite: false,
    })
  }

  const localVersion = local.version ?? null

  if (localVersion === null) {
    return makeState({
      action: 'replace',
      labelId: 'install.actionReplace',
      hintId: 'install.replaceLocalHint',
      hintParams: { slug: entry.slug, version: entry.version },
      disabled: false,
      needsOverwrite: true,
    })
  }

  const cmp = compareVersions(localVersion, entry.version)

  if (cmp === 0) {
    return makeState({
      action: 'installed',
      labelId: 'install.actionInstalled',
      // 措辞只说版本，不说"内容相同"：我们比的是版本号，没有逐字节核对过内容。
      // 版本本来就该标识内容，但**别替它多说一句我们自己没验证的话**。
      hintId: 'install.installedHint',
      hintParams: { version: entry.version },
      disabled: true,
      needsOverwrite: false,
    })
  }

  if (cmp === null) {
    // 版本号认不出来（不是 x.y.z）。**不猜大小**，但要给得出动作：
    // 版本字符串不同就是不同，交给使用者看两个版本号自己判断。
    return makeState({
      action: 'update',
      labelId: 'install.actionUpdate',
      hintId: 'install.updateUnknownHint',
      hintParams: { local: localVersion, remote: entry.version },
      disabled: false,
      needsOverwrite: true,
    })
  }

  if (cmp < 0) {
    return makeState({
      action: 'update',
      labelId: 'install.actionUpdateTo',
      labelParams: { version: entry.version },
      hintId: 'install.updateHint',
      hintParams: { local: localVersion, remote: entry.version },
      disabled: false,
      needsOverwrite: true,
    })
  }

  return makeState({
    action: 'downgrade',
    labelId: 'install.actionDowngradeTo',
    labelParams: { version: entry.version },
    hintId: 'install.downgradeHint',
    hintParams: { local: localVersion, remote: entry.version },
    disabled: false,
    needsOverwrite: true,
  })
}
