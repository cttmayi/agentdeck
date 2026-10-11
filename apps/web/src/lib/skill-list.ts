import { api } from './api.ts'

/**
 * 「本地安装清单」（`GET /api/skills/install-list`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它取的是**安装方法**，不是内容
 * ══════════════════════════════════════════════════════════════════
 *
 * 与远端目录（`remote-store.ts`）不同：那边取回来的是**已经抓好的内容**，这边取
 * 回来的是**怎么装**——每条一个 GitHub 链接或本地路径。真正装的时候还是走
 * 「路径 / GitHub」那条老路（`installFromPathOrUrl`），由 daemon 现去取。
 *
 * ★ 所以这条路的三个前提都不需要：**不用远端起起来、不用同步工具、不用登录**。
 *   清单是一份仓库自带的 JSON（daemon 侧 `apps/daemon/catalog/skills.json`）。
 *
 * ⚠️ 这里**不写中文**（D39）：`name` / `summary` / `needs` 是清单作者写的原文，
 *    原样显示；界面自己那几句话用 `skills.*` 词条，由组件按当前语言渲染。
 */

/** 一条来源的两种形态，形状直接对上 `installFromPathOrUrl` 的入参。 */
export type SkillListSourceKind = 'url' | 'path'

export interface SkillListSource {
  kind: SkillListSourceKind
  value: string
}

/**
 * 一条清单条目。
 *
 * ⚠️ 这里**只声明界面真的用到的字段**（与 `api.ts` 里其它接口形状同一规矩）：
 *    清单里还有 `origin`，界面这一版不显示它，所以不声明。
 */
export interface SkillListEntry {
  /**
   * 由取包规则算出（与 daemon 装的时候**逐字相同**）——界面拿它判断"装没装过"。
   *
   * ★ 它**不在清单里**：清单声明 slug 会与安装时重算出来的不一致，那样界面会拿
   *   错 slug 去比，把一条已装的技能显示成「安装」。所以它只由 daemon 算。
   */
  slug: string
  name: string
  summary: string
  /**
   * 分组用的**机器值**（英文 id，如 `software` / `docs`）。
   *
   * ★ 界面按它把清单分成可折叠的几组。**显示名不在这里**——它是词表里的
   *   `skills.cat*`（D39：机器值一个字都不翻，翻译只加在为它配的标签上）；
   *   认不出的 id（清单比界面新）排到最后并原样显示那个 id。
   *   daemon 侧缺省是 `other`（见 `skill-list.ts`），所以这里不会是空串。
   */
  category: string
  /** 装之前还得自己准备什么（如某个 API key）；没有就是 null。 */
  needs: string | null
  source: SkillListSource
}

/** 清单里**明确没列出来**的条目及原因（缺 url/path、主机不在白名单……）。 */
export interface SkillListSkipped {
  path: string
  reason: string
}

export interface SkillListResult {
  entries: SkillListEntry[]
  /**
   * 坏条目及原因。
   *
   * ★ 它**不**让整份清单不可用：一条手滑不该拖垮整张表。但也不能不说——静默跳过
   *   正是这类功能最容易让人困惑的地方（"我清单里明明写了 12 条，怎么只有 11 条"）。
   */
  skipped: SkillListSkipped[]
}

/** 取本地安装清单。清单**本身**坏掉时 daemon 返回非 2xx，`api()` 会抛出。 */
export function fetchSkillList(): Promise<SkillListResult> {
  return api<SkillListResult>('/api/skills/install-list')
}
