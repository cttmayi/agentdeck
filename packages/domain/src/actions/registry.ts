import { z } from 'zod'
import {
  ActionType,
  IssueStatus,
  type ActionPlane,
  type ActionRef,
} from '@alpha-helper/protocol'

/**
 * 动作注册表（FR-ACTION-01~11）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么执行端放在**注册表**而不是 verdict 里
 * ══════════════════════════════════════════════════════════════════
 *
 * `verdict` 里只写 `action.type`，**不写**执行端（INV-13）。
 *
 * 这样本地动作将来迁移到远端时，**已经产生的历史判决不需要做数据迁移**——
 * 它引用的还是同一个 type，只是注册表里那一行的 `plane` 变了。
 * 反过来若把 plane 固化进判决，迁移就得回头改历史数据。
 *
 * ══════════════════════════════════════════════════════════════════
 * 未声明即拒绝
 * ══════════════════════════════════════════════════════════════════
 *
 * `action.type` 必须是本表的键。不在表内的取值会让**整个判决**判定为不合规，
 * 走 invalid 路径——而不是"忽略这个动作继续"。
 * 忽略等于给了模型一条绕过边界的路。
 */

export interface ActionValidationOk {
  ok: true
}
export interface ActionValidationFail {
  ok: false
  issues: string[]
}
export type ActionValidation = ActionValidationOk | ActionValidationFail

export interface ActionDefinition {
  type: ActionType
  /** ★ 执行端。本地由 daemon 执行；远端由远端的服务执行（首版留扩展位）。 */
  plane: ActionPlane
  /** 参数 schema。 */
  params: z.ZodType
  /**
   * 是否需要人批准。
   *
   * 默认 `false` —— **默认路径必须是可以自动执行的**（INV-4）。
   * 若默认要人批准，人又变回了默认关卡，整个产品定位就没了。
   */
  requiresApproval?: boolean
  /** 可回滚。不可回滚的动作必须显式标注（FR-ACTION-05）。 */
  reversible: boolean
  /** 是否可能派生出新的 run —— 影响回路边界判定（INV-16）。 */
  spawnsRun?: boolean
  /** 一行摘要，用于日志与审计。 */
  describe: (params: Record<string, unknown>) => string
}

const issueIdParam = z.string().min(1)

export const ACTION_REGISTRY: Record<ActionType, ActionDefinition> = {
  'comment.create': {
    type: 'comment.create',
    plane: 'local',
    params: z.strictObject({ issueId: issueIdParam, body: z.string().min(1).max(20_000) }),
    reversible: true,
    describe: (p) => `在 issue ${String(p['issueId'])} 上发表评论`,
  },
  'issue.update_status': {
    type: 'issue.update_status',
    plane: 'local',
    params: z.strictObject({ issueId: issueIdParam, status: IssueStatus }),
    reversible: true,
    describe: (p) => `把 issue ${String(p['issueId'])} 的状态改为 ${String(p['status'])}`,
  },
  'issue.add_label': {
    type: 'issue.add_label',
    plane: 'local',
    params: z.strictObject({ issueId: issueIdParam, label: z.string().min(1).max(64) }),
    reversible: true,
    describe: (p) => `给 issue ${String(p['issueId'])} 打标签 ${String(p['label'])}`,
  },
  'issue.create': {
    type: 'issue.create',
    plane: 'local',
    params: z.strictObject({
      title: z.string().min(1).max(500),
      description: z.string().max(20_000).default(''),
    }),
    reversible: true,
    describe: (p) => `创建 issue「${String(p['title'])}」`,
  },
  'issue.assign_agent': {
    type: 'issue.assign_agent',
    plane: 'local',
    params: z.strictObject({ issueId: issueIdParam, agentId: z.string().min(1) }),
    reversible: true,
    // ★ 会派生出新的 execute run —— 回路边界必须把这种边算进去
    spawnsRun: true,
    describe: (p) => `把 issue ${String(p['issueId'])} 指派给 ${String(p['agentId'])}`,
  },
  'notify.emit': {
    type: 'notify.emit',
    plane: 'local',
    params: z.strictObject({
      title: z.string().min(1).max(200),
      body: z.string().max(2_000).default(''),
      severity: z.enum(['action_required', 'attention', 'info']).default('info'),
    }),
    // 通知发出去就收不回
    reversible: false,
    describe: (p) => `发出通知「${String(p['title'])}」`,
  },
}

export function getActionDefinition(type: ActionType): ActionDefinition {
  return ACTION_REGISTRY[type]
}

export function isKnownActionType(type: string): type is ActionType {
  return Object.prototype.hasOwnProperty.call(ACTION_REGISTRY, type)
}

/**
 * 校验一个 `ActionRef`。
 *
 * 两层：**是否在表内**，以及**参数是否符合该动作的 schema**。
 * 第二层不做的话，模型可以传一个 `issue.update_status` 但把 status 写成
 * 任意字符串——那时错误会以"执行失败"的形式出现，而不是"判决不合规"，
 * 两者该走完全不同的处置路径。
 */
export function validateActionRef(ref: ActionRef): ActionValidation {
  if (!isKnownActionType(ref.type)) {
    return { ok: false, issues: [`未知动作类型：${ref.type}（必须来自动作注册表）`] }
  }

  const definition = ACTION_REGISTRY[ref.type]
  const parsed = definition.params.safeParse(ref.params)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (i) => `动作参数 ${i.path.map(String).join('.') || '(根)'}：${i.message}`,
      ),
    }
  }
  return { ok: true }
}

/**
 * 校验"这个 skill 允不允许触发这个动作"。
 *
 * skill 声明的是一份**子集**，不是"全部动作都可以"。缺了这一层，
 * 一个只该打标签的审核 skill 就能去改状态、建 issue。
 */
export function validateActionAllowed(
  ref: ActionRef,
  allowedActions: readonly ActionType[],
): ActionValidation {
  if (!allowedActions.includes(ref.type)) {
    return {
      ok: false,
      issues: [
        `动作 ${ref.type} 不在该 skill 允许的动作子集内（允许：${allowedActions.join(', ') || '无'}）`,
      ],
    }
  }
  return { ok: true }
}
