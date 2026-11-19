/**
 * **启动对账**（2026-11，D149）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有这一个函数
 * ══════════════════════════════════════════════════════════════════
 *
 * 到这一版，`startDaemon()` 里排着**八段**"每次启动都要做一次"的事：记忆默认值迁移、
 * 内置成员对账、起草者的技能挂载、生成者平台技能（迁移 + 播种）、编排生成者平台技能
 * 播种、老字段清理、`owner`/`entries` 写回、老编排引用扫描。
 *
 * 它们原来散在两百行里，而**顺序**这件事只写在注释里：
 *
 *   · `owner`/`entries` 写回必须排在老字段清理**之后**（反了会让清理"没东西可清"，
 *     日志里那句"清了谁"随之消失——`agent-legacy-cleanup.test.ts` 当场抓过这次）；
 *   · 技能挂载 / 平台技能播种必须排在**内置成员对账之后**（成员还不存在，挂给谁）；
 *   · 编排引用扫描必须排在 `owner`/`entries` 写回**之后**（它读的就是那两份数据）。
 *
 * 顺序写在注释里 = 下一个人搬家时看不见。现在顺序是**数据**（`RECONCILE_PLAN`），
 * 有判据、也有运行时自检：跑的时候如果某个步骤的依赖还没跑过，直接抛——宁可启动就
 * 炸，也不要安静地跑出一个半对账的状态。
 *
 * ══════════════════════════════════════════════════════════════════
 * 边界：这里只做"补"与"报"，不做"删"
 * ══════════════════════════════════════════════════════════════════
 *
 * 每一步的幂等性由它自己的模块保证（那几处各有测试）。这个函数只负责
 * **按声明的顺序调用它们，并把结果说给人听**——它自己一行数据都不写。
 *
 * ⚠️ 加一步 = `RECONCILE_PLAN` 加一行（含 `needs`）+ 下面 `steps` 里加实现。
 *    `RECONCILE_PLAN` 与 `steps` 的键必须一一对应：漏一边
 *    `startup-reconcile.test.ts` 会红（"计划里有、实现里没有"是本仓库最怕的那类死接口）。
 */

import type { WorkspaceId } from '@agentdeck/protocol'
import type { Store } from '@agentdeck/domain'
import {
  ensureBuiltinAgents,
  syncDrafterSkillMount,
  type EnsureDrafterResult,
} from './builtin-drafter.ts'
import {
  ensureBuiltinAgentMakerSkills,
  migratePlatformSkillsToExclusive,
} from './agent-maker-skills.ts'
import { ensureBuiltinWorkflowMakerSkills } from './workflow-maker-skills.ts'
import { runAgentLegacyCleanupOnce } from './agent-legacy-cleanup.ts'
import { migrateMemoryEnabledDefaults } from './memory.ts'
import {
  migratePlatformMemberFields,
  platformMemberRefsInWorkflows,
} from './platform-member.ts'
import { DRAFTER_SKILL_SLUG } from './builtin-drafter.ts'
import { alignMemberEntries, loadSlotTable, saveSlotTable, type SlotTable } from './platform-slots.ts'
import { PLATFORM_MEMBER_ENTRIES } from './platform-member.ts'

/* ══════════════════════════════════════════════════════════════════
 * 内置成员对账结果的"日志行"（D144：逐项都要说得出来）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 每一个内置成员该说的那句话（标签 + 它在对账里怎么了 + 它是用来干嘛的）。
 *
 * ★ 2026-11（D144）：这里原来漏了「编排生成者」——它被建出来时**一行日志都没有**，
 *   而"某个内置被重建 / 被修复"正是靠这条日志才看得见。
 *
 * ⚠️ 新增一个内置岗位必须在这里加一行：`builtin-role-identity.test.ts` 有一条判据按
 *    `ensureBuiltinAgents()` 的返回**逐项**核对，漏了当场红。
 */
export function builtinAccountingRows(
  builtin: Awaited<ReturnType<typeof ensureBuiltinAgents>>,
): ReadonlyArray<readonly [string, EnsureDrafterResult, string]> {
  return [
    ['内置起草者', builtin.drafter, '沉淀这条链用的'],
    ['内置记忆整理者', builtin.memoryTidy, '「整理记忆」用的'],
    ['内置智能体生成者', builtin.agentMaker, '「确认生成智能体」用的'],
    ['内置编排生成者', builtin.workflowMaker, '「确认采纳编排」用的'],
  ]
}

/* ══════════════════════════════════════════════════════════════════
 * 计划（顺序 = 数据）
 * ══════════════════════════════════════════════════════════════════ */

export type ReconcileStepId =
  | 'memory-defaults'
  | 'builtin-agents'
  | 'drafter-skill-mount'
  | 'agent-maker-skills'
  | 'workflow-maker-skills'
  | 'agent-legacy-cleanup'
  | 'platform-member-fields'
  | 'workflow-refs-scan'

/**
 * 每一步"必须已经跑过谁"。
 *
 * ⚠️ `needs` 不是装饰：`reconcileStartup()` 真的按它自检（依赖没跑过就抛）。
 *    写在这里的每一条都对应一次**真实的**踩坑或真实的不变量：
 */
export const RECONCILE_PLAN: ReadonlyArray<{
  id: ReconcileStepId
  needs: readonly ReconcileStepId[]
  /** 一句话说清这一步在补什么（给人读，也进日志的错误信息）。 */
  what: string
}> = [
  {
    id: 'memory-defaults',
    needs: [],
    what: '记忆默认关（只有「助手」保持开着）：一次性开关迁移',
  },
  {
    id: 'builtin-agents',
    needs: [],
    what: '内置成员对账：缺的建回、坏的修回默认（使用者改过的指令一字不动）',
  },
  {
    id: 'drafter-skill-mount',
    needs: ['builtin-agents'],
    what: '起草者的「沉淀用技能」挂载对齐技能库现状',
  },
  {
    id: 'agent-maker-skills',
    needs: ['builtin-agents'],
    what: '智能体生成者的平台技能：老库里的迁进独有目录 + 缺的播种',
  },
  {
    id: 'workflow-maker-skills',
    needs: ['builtin-agents'],
    what: '编排生成者的平台技能（orchestration-authoring）播种',
  },
  {
    id: 'agent-legacy-cleanup',
    needs: [],
    what: '把老 agent 记录里已撤下的字段真的从磁盘摘掉（并点名清了谁）',
  },
  {
    id: 'platform-member-fields',
    needs: ['agent-legacy-cleanup'],
    what: '把 owner + entries 写进数据（只补缺的；半内置点名）',
  },
  {
    id: 'workflow-refs-scan',
    needs: ['platform-member-fields'],
    what: '扫一遍现有编排有没有引用平台成员（只报不改）',
  },
]

/* ══════════════════════════════════════════════════════════════════
 * 跑一遍
 * ══════════════════════════════════════════════════════════════════ */

export type ReconcileDeps = {
  store: Store
  workspaceId: WorkspaceId
  /** 现有编排（引用扫描要用；调用方已经读过了，这里不再读一遍）。 */
  workflows: ReadonlyArray<{ name: string; code: string }>
  info: (message: string) => void
  warn: (message: string) => void
}

export type ReconcileResult = {
  /** 实际跑过的步骤（顺序就是执行顺序）。 */
  steps: readonly ReconcileStepId[]
  /** 内置成员对账的原始结果（测试与调用方可能要它）。 */
  builtin: Awaited<ReturnType<typeof ensureBuiltinAgents>>
}

/**
 * 按 `RECONCILE_PLAN` 的顺序跑一遍启动对账。
 *
 * 只在**真动手**时吭声：正常启动不该多一句噪音（这是使用者对启动日志的要求）。
 */
export async function reconcileStartup(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { store, workspaceId, workflows, info, warn } = deps
  const done = new Set<ReconcileStepId>()
  let builtin: ReconcileResult['builtin'] | null = null
  /** 对账认领过的槽位表（后面的步骤要用它认人，见 `drafter-skill-mount`）。 */
  let slots: SlotTable = {}

  const steps: Record<ReconcileStepId, () => Promise<void>> = {
    'memory-defaults': async () => {
      /*
       * ★ 分批第 259 批（使用者："除了助手，启用记忆的默认值需要是关闭"）。
       *   逻辑与三条边界在 `memory.ts` 的 `migrateMemoryEnabledDefaults` 里（那里有测试）。
       *   它只改开关，不动记忆条目。
       */
      const { switched } = await migrateMemoryEnabledDefaults(store, workspaceId)
      if (switched.length > 0) {
        info(
          `记忆默认关：${switched.length} 个智能体已关掉记忆（只有「助手」保持开）——` +
            '要用的话在它自己的配置页打开「启用记忆」；已有条目一条都没删',
        )
      }
    },

    'builtin-agents': async () => {
      /*
       * ⚠️ **每次启动**都跑，不是"首启播种一次"：它要满足"不许删"（使用者绕过界面删掉，
       *    下次启动要回来）与"自愈"（内置标记丢了、指令被清空了要补回默认）。幂等由
       *    `ensureBuiltinDrafter` 内部保证：**使用者改过的指令一字不动**。
       */
      /*
       * ★ 2026-11（D154）：`ensureBuiltinAgents` 会返回**对账之后的槽位表**
       *   （新建出来的成员要认领槽位），这里负责**持久化一次**——它自己不动工作区。
       */
      const table = await loadSlotTable(store, workspaceId)
      const ensured = await ensureBuiltinAgents(store, workspaceId, table)
      await saveSlotTable(store, workspaceId, table)
      slots = table
      builtin = ensured
      /*
       * ★ 2026-11（D155）：**把平台成员的接入点对齐到注册表**（平台声明的那一份）。
       *   注册表一变（比如删掉死接口 `agent-draft`），老记录里存的 `entries` 就过期了——
       *   不修的话同一页会出现"老成员多一枚没人认的动作徽标、新成员没有"。
       *   ⚠️ 只动平台成员；用户智能体的 `entries` 是使用者勾的，不碰。
       */
      const realigned = await alignMemberEntries(
        store,
        workspaceId,
        table,
        (slot) => PLATFORM_MEMBER_ENTRIES[slot],
      )
      if (realigned.length > 0) {
        info(`平台成员的接入点已对齐注册表：${realigned.join('、')}`)
      }
      for (const [label, r, why] of builtinAccountingRows(ensured)) {
        if (r.action === 'created') {
          info(`已建立${label}（${why}，可在「智能体」页查看与编辑）`)
        } else if (r.action === 'healed') {
          warn(`${label}被修复：${r.why}（已恢复成默认，使用者改过的内容不会被动）`)
        }
      }
    },

    'drafter-skill-mount': async () => {
      /*
       * ★ 分批第 207 批：**把起草者的技能挂载与技能库对齐**。
       *   内置 agent 是只读的，使用者没法自己把 distilly 挂上去；而"起草 run 注入什么"
       *   完全由**挂载**决定 ⇒ 挂载必须始终对着技能库的现状。装/卸技能之后也有一次
       *   （见那两条路由），启动这一次是兜底（比如使用者手改了数据目录）。
       */
      const mount = await syncDrafterSkillMount(store, workspaceId, slots)
      if (mount.skillIds.length === 0) {
        info(
          `起草者还没挂上「沉淀用技能」（${DRAFTER_SKILL_SLUG}）：装好之后自动挂上，` +
            '在装好之前不能开始沉淀',
        )
      } else {
        info(`起草者挂了：${mount.skillSlugs.join('、')}`)
      }
    },

    'agent-maker-skills': async () => {
      /*
       * ★ 设计定稿（§3.3）+ D111：**智能体生成者的平台技能 = 它的独有技能**。
       *   上一版是"动态安装进技能库 + 挂载对齐"——技能页会看到三条、还能卸。现在这三份
       *   是生成者目录里的**文件资产**（不进技能库、不进技能页、不可卸载）：老库里的三条
       *   **搬进**生成者目录（一次性迁移），缺的从随仓库分发的 `catalog/platform-skills/`
       *   **播种**（幂等）。装不上只是"规范没注入"，不阻塞启动。
       */
      const migrated = await migratePlatformSkillsToExclusive(store, workspaceId)
      if (migrated.moved.length > 0) {
        info(`生成者平台技能已从技能库迁入独有目录：${migrated.moved.join('、')}`)
      }
      const ensure = await ensureBuiltinAgentMakerSkills(store, workspaceId)
      if (ensure.seeded.length > 0) {
        info(`生成者平台技能已就位（独有技能）：${ensure.seeded.join('、')}`)
      }
      if (ensure.skipped.length > 0) {
        warn(`生成者平台技能播种跳过：${ensure.skipped.join('；')}`)
      }
    },

    'workflow-maker-skills': async () => {
      /*
       * ★ 2026-11（D143）：使用者问「"编排生成者（内置）" 里面并没有描述 API 的细节，
       *   它怎么会知道怎么写编排呢」——API 细节走技能（与生成者同一分工，D111），
       *   指令里只留"动笔之前照它写"。播种失败不阻塞启动（与上面同一口径）。
       */
      const ensure = await ensureBuiltinWorkflowMakerSkills(store, workspaceId)
      if (ensure.seeded.length > 0) {
        info(`编排生成者平台技能已就位（独有技能）：${ensure.seeded.join('、')}`)
      }
      if (ensure.skipped.length > 0) {
        warn(`编排生成者平台技能播种跳过：${ensure.skipped.join('；')}`)
      }
    },

    'agent-legacy-cleanup': async () => {
      /*
       * ★ 撤掉的是 `reviewerAgentId` 与行动权限那三个字段——schema 字段删掉之后老记录里的
       *   键**不会自己消失**，所以这里真的改一遍：使用者要的是"不要遗留旧数据"，
       *   不是"界面看不见"。
       *
       * ⚠️ 它必须排在 `platform-member-fields` **之前**：那一步是把整条记录重写一遍，
       *    跑在前面会把老键提前抹掉 ⇒ 这一步变成"没东西可清"，日志里那句"清了谁"也消失了。
       */
      await runAgentLegacyCleanupOnce({ store, info })
    },

    'platform-member-fields': async () => {
      /*
       * ★ 2026-11（D145）：**把归属与接入点写进数据**（`owner` + `entries`）。
       *   三条口径：只补缺的、不删老字段、半内置不猜但**点名**。
       */
      const migrated = await migratePlatformMemberFields(store, workspaceId)
      if (migrated.migrated.length > 0) {
        info(`平台成员属性已写入（owner + entries）：${migrated.migrated.length} 条记录`)
      }
      if (migrated.halfBuiltin.length > 0) {
        warn(
          `有 ${migrated.halfBuiltin.length} 条记录配置损坏（builtin 标记在、岗位值缺）：` +
            `${migrated.halfBuiltin.join('、')}——已按「用户的普通智能体」处理（可改可删），` +
            '要恢复平台成员请用「恢复成默认值」或重新出厂',
        )
      }
    },

    'workflow-refs-scan': async () => {
      /*
       * ★ 2026-11（D145）：**上线前扫一遍现有编排代码**。
       *   "被编排引用"那道守卫是这一轮新加的：改之前引擎解析是全量名单，所以升级当天老编排
       *   里很可能已经引用了平台成员——那样它会**在运行时被拒**。与其让人跑到一半撞墙，
       *   不如启动时点名说出来（只报不改，改哪条由人决定）。
       */
      const stale = await platformMemberRefsInWorkflows(store, workspaceId, workflows)
      if (stale.length > 0) {
        warn(
          `有 ${stale.length} 条编排引用了平台成员（它们的接入点里没有「被编排调用」，` +
            `运行会被拒）：${stale.join('、')}——把里面的名字换成自己建的智能体即可`,
        )
      }
    },
  }

  const ran: ReconcileStepId[] = []
  for (const step of RECONCILE_PLAN) {
    // 自检：依赖必须已经跑过（顺序写在数据里，就得在运行时也认这份数据）
    for (const need of step.needs) {
      if (!done.has(need)) {
        throw new Error(
          `启动对账顺序错了：「${step.id}」（${step.what}）依赖「${need}」，但后者还没跑。` +
            '改 `RECONCILE_PLAN` 的顺序即可——这条自检存在，就是为了别让"顺序只写在注释里"。',
        )
      }
    }
    const run = steps[step.id]
    if (run === undefined) {
      throw new Error(`启动对账：计划里有「${step.id}」但实现里没有（死接口）`)
    }
    await run()
    done.add(step.id)
    ran.push(step.id)
  }

  if (builtin === null) {
    // 计划里没有 builtin-agents 这一步就说明计划被改坏了
    throw new Error('启动对账：没有跑「内置成员对账」——RECONCILE_PLAN 被改坏了')
  }
  return { steps: ran, builtin }
}
