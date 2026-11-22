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
  /**
   * 这次要哪几包（★ D259：**一个生成者可以要多包**——见 `materialPackForSlot`）。
   *
   * 空数组 = 什么都不写（调用方本来就不该调）。
   */
  packs: MaterialPack[]
  /** 读 `api-version.json` 用的（只是写进索引，缺了也不影响）。 */
  now?: number
}

/**
 * 写（覆盖）每一包资料到 `<workDir>/material/<包>/`，并更新顶层索引。
 *
 * 返回 `true` = 全落了；`false` = 至少一包坏了（读不到 `catalog/material`）——调用方只记一条告警。
 *
 * ★ D259：**一个生成者不止一种写法要读**。「编排生成者」既写编排代码，也**自己写内建智能体**
 *   （`agents/<名字>/{agent.json,instructions.md,skills/**}`）⇒ 它要 `orchestration` + `agent` +
 *   `skill` 三包；「智能体生成者」也写配套技能 ⇒ `agent` + `skill`。原先一对一映射，于是编排
 *   生成者只能从 `orchestration/api.md` 的目录树里那两行猜"指令怎么写"——资料是按**谁写**发的，
 *   不是按**槽位**发的。
 *
 * 为什么按包各写各的（而不是合并成一份）：包在仓库里是**按读者**维护的（`docs/material/<包>/`），
 * 合并会立刻出现"同一段话两处维护"。索引页承担"这次有哪些包、先读哪个"。
 */
export async function seedMaterial(opts: SeedMaterialOptions): Promise<boolean> {
  const target = join(opts.workDir, MATERIAL_DIR)
  let ok = true
  const seeded: Array<{ pack: MaterialPack; version: string | null }> = []
  try {
    await mkdir(target, { recursive: true })
    for (const pack of opts.packs) {
      // 只换这一包：别的包（同一对话里换过生成者时留下的）留着
      await rm(join(target, pack), { recursive: true, force: true })
      await cp(join(BUNDLED_ROOT, pack), join(target, pack), { recursive: true })
      seeded.push({
        pack,
        version: await readVersion(join(BUNDLED_ROOT, pack, 'api-version.json')).catch(() => null),
      })
    }
  } catch (err) {
    void err
    ok = false
  }
  if (seeded.length === 0) return false

  // 顶层索引：这次有哪几包、每包先读哪一份、什么时候落的
  const stamp = new Date(opts.now ?? Date.now()).toISOString()
  const lines = [
    '# 这次用到的资料（material）',
    '',
    '平台在每次对话开始时**覆盖写**这一份；它和仓库里的 `docs/material/` 是同一份资料',
    '（人读的和这里看到的一字不差）。',
    '',
    ...seeded.flatMap(({ pack, version }) => [
      `- \`${pack}/\` —— ${PACK_LABEL[pack]}`,
      `  - 先读：\`${pack}/README.md\``,
      ...(version === null ? [] : [`  - 版本：${version}（见 \`${pack}/api-version.json\`）`]),
    ]),
    `- 落盘时间：${stamp}`,
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
 * **哪一类生成者该读哪几包**（`Agent.slot` → 包列表）。
 *
 * 三种生成者共用同一个机制，只是**要读的东西不同**——而"要读几包"由**它写什么**决定，
 * 不由"它叫什么"决定（★ D259，见 `seedMaterial` 那段说明）：
 *
 *   · 编排生成者 → `orchestration`（代码与原语）+ `agent`（内建智能体怎么写）+ `skill`
 *     （内建人自带技能的格式）。少后两包，它只能从 api.md 目录树里那两行猜。
 *   · 智能体生成者 → `agent` + `skill`（它写的候选里就有配套技能）。
 *   · 起草者（drafter）→ 空：它的素材与资料都由沉淀那条链写进**起草 run** 的
 *     `material/`（素材 + `material/skill/`，D257），往聊天目录里再塞一份会让
 *     "这次的依据在哪"出现两种答案。
 *
 * ⚠️ 返回空数组 = 这个 agent 不是生成者，**什么都不写**（普通对话的工作目录不该多出 `material/`）。
 */
export function materialPackForSlot(slot: string | null | undefined): MaterialPack[] {
  if (slot === 'workflow-maker') return ['orchestration', 'agent', 'skill']
  if (slot === 'agent-maker') return ['agent', 'skill']
  return []
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

/**
 * ★ D257：**沉淀起草 run 的资料**——`material/skill/`（`format.md` 与 `checklist.md`）。
 *
 * 为什么单独一个入口：起草 run 的素材是 `crystallize-material.ts` 写进同一个
 * `material/` 的（`00-README.md` + 轮次记录 + 来源文件），资料包要**并排**落在
 * 它旁边（`material/skill/`），而不是占掉那份素材目录。所以调用点在"素材写完、
 * 起 run 之前"，失败只告警（素材才是这一轮的依据，资料缺了最多写得糙一点）。
 */
export async function seedDrafterMaterial(opts: { workDir: string; now?: number }): Promise<boolean> {
  return seedMaterial({
    workDir: opts.workDir,
    packs: ['skill'],
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })
}
