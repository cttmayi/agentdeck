/**
 * **把「生成资料」落进工作目录**（2026-11，D255）。
 *
 * 使用者定调（两次）：
 *
 *   1. 「由于 workflow 的代码形式会**经常变化**，最好以**资料**的形式动态输入到工作目录，
 *      类似于技能起草的方式」；
 *   2. 「material 也在代码中**单独目录维护**，不要分散在各个地方，最好和 docs 链接起来，
 *      直接作为文档的一部分，**人和 LLM 看到的是一份资料**」。
 *
 * 于是有三层，本文件负责最后一层（复制）：
 *
 *   docs/material/**                    ← 唯一手写源（人读；`docs/README.md` 有链接）
 *   apps/daemon/catalog/material/**     ← 同步产物（`pnpm run sync:material`；测试逐字节比对）
 *   <工作目录>/material/**              ← **本文件写的那一份**（每次覆盖，agent 读它）
 *
 * 为什么每次覆盖写而不是"启动时塞一次"：
 *   · API 改了之后，**下一轮**就应该是新版——不需要重启 daemon、不需要升"内置身份版本"
 *     （D143 踩过：老工作区默认身份不会自动升级）；
 *   · 资料同时是**证据**：跑完之后人还能在工作目录里翻到"它当时照哪一版写的"。
 *
 * ⚠️ 失败**不许打断对话**：资料是辅助，缺了最多写得差一点；吐一句告警就够了
 *   （对话照常跑）。
 */

import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 资料包（与 `docs/material/` 下的目录同名）。 */
export type MaterialPack = 'orchestration' | 'agent' | 'skill'

/** 工作目录里资料根的名字（`<工作目录>/material`）。 */
export const MATERIAL_DIR = 'material'

/** 随包分发的那份资料（`apps/daemon/catalog/material/`）。 */
const BUNDLED_ROOT = fileURLToPath(new URL('../catalog/material/', import.meta.url))

/** 这一包当前的身份模板（写进 `material/README.md` 的索引行，人一眼看得出"这次做哪一类"）。 */
const PACK_LABEL: Record<MaterialPack, string> = {
  orchestration: '编排写法（给「编排生成者」）',
  agent: '智能体写法（给「智能体生成者」）',
  skill: '技能写法（给「技能起草者」）',
}

export interface SeedMaterialOptions {
  /** 工作目录（对话的目录；`resolveWorkDir` 算出来的那个）。 */
  workDir: string
  /** 这次要哪一包。 */
  pack: MaterialPack
  /** 读 `api-version.json` 用的（只是写进索引，缺了也不影响）。 */
  now?: number
}

/**
 * 写（覆盖）一包资料到 `<workDir>/material/`，并更新顶层索引。
 *
 * 返回 `true` = 落了；`false` = 打包坏了（读不到 `catalog/material`）——调用方只记一条告警。
 */
export async function seedMaterial(opts: SeedMaterialOptions): Promise<boolean> {
  const target = join(opts.workDir, MATERIAL_DIR)
  const packDir = join(BUNDLED_ROOT, opts.pack)
  try {
    await mkdir(target, { recursive: true })
    // 只换这一包：别的包（如果以后同一对话里用过两类生成者）留着
    await rm(join(target, opts.pack), { recursive: true, force: true })
    await cp(packDir, join(target, opts.pack), { recursive: true })
  } catch (err) {
    void err
    return false
  }

  // 顶层索引：这次是哪一类、先读哪一份、什么时候落的
  const version = await readVersion(join(packDir, 'api-version.json')).catch(() => null)
  const stamp = new Date(opts.now ?? Date.now()).toISOString()
  const lines = [
    '# 这次用到的资料（material）',
    '',
    '平台在每次对话开始时**覆盖写**这一份；它和仓库里的 `docs/material/` 是同一份资料',
    '（人读的和这里看到的一字不差）。',
    '',
    `- 本次包：\`${opts.pack}/\` —— ${PACK_LABEL[opts.pack]}`,
    `- 先读：\`${opts.pack}/README.md\``,
    ...(version === null ? [] : [`- 版本：${version}（见 \`${opts.pack}/api-version.json\`）`]),
    `- 落盘时间：${stamp}`,
    '',
    '> 其它包只放说明（`agent/`、`skill/` 还没接，里面写的是"资料在仓库哪儿"）。',
    '',
  ]
  try {
    await writeFile(join(target, 'README.md'), lines.join('\n'), 'utf8')
  } catch {
    // 索引写不进去不是大事（包已经在了）
  }
  return true
}

async function readVersion(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(path, 'utf8')
  const parsed = JSON.parse(raw) as { version?: unknown }
  return typeof parsed.version === 'string' ? parsed.version : ''
}

/**
 * **哪一类生成者该读哪一包**（`Agent.slot` → 包）。
 *
 * 三种生成者共用同一个机制，只是包不同。没接的那两包（agent / skill）暂时也照发——
 * 里面写的是"资料在仓库哪儿"，agent 读了不会以为"漏了"。
 * ⚠️ 返回 `null` = 这个 agent 不是生成者，**什么都不写**（普通对话的工作目录不该多出 `material/`）。
 */
export function materialPackForSlot(slot: string | null | undefined): MaterialPack | null {
  if (slot === 'workflow-maker') return 'orchestration'
  if (slot === 'agent-maker') return 'agent'
  /*
   * ⚠️ 起草者（drafter）**不在这里发**：它的素材是沉淀那条链自己写进
   *   起草 run 工作目录下的 `material/`（轮次记录、来源文件，`crystallize-material.ts`），
   *   往聊天目录里再塞一个 `material/skill/` 会让"这次的依据在哪"出现两种答案。
   *   等接「技能起草者」那一条时，按同一套约定接到沉淀那条链上。
   */
  return null
}

/**
 * 随包分发那一包资料的版本（`api-version.json` 里的 `version`）。
 *
 * 入库时写进 `workflow.json` 的 `apiVersion`——"这条编排按哪一版写法写的"是**事实**，
 * 将来原语改版能据此说清"它是老版本"。读不到就返回 `undefined`（不编造）。
 */
export async function bundledMaterialVersion(pack: MaterialPack): Promise<string | undefined> {
  try {
    const v = await readVersion(join(BUNDLED_ROOT, pack, 'api-version.json'))
    return v === '' ? undefined : v
  } catch {
    return undefined
  }
}
