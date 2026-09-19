import { z } from 'zod'
import type { ActionPlane, ActionRef, ActionRefType } from '@alpha-helper/protocol'

/**
 * 动作的**形状**与白名单校验（D41）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件原来叫 `registry.ts`，里面真的有一张注册表
 * ══════════════════════════════════════════════════════════════════
 *
 * 那张表是平台的**六个内置动作**（`comment.create` / `issue.update_status` /
 * `issue.add_label` / `issue.create` / `issue.assign_agent` / `notify.emit`），
 * 连同 `getActionDefinition` / `isKnownActionType` / `validateActionRef` 一起
 * 提供"在不在表里"的判据。
 *
 * 使用者把内置动作**全部移除**了（D41）——动作只能来自装进来的工具包。于是：
 *
 *   · **注册表不存在了**（"注册"这件事现在等于"装了一个包"）；
 *   · 定义由工具包摊出来（`tool-actions.ts` 的 `toolActionDefinitions`）；
 *   · "在不在"由运行时按已安装包解析（`resolveActionDefinition`）。
 *
 * 这个文件因此只剩两样**与实现无关**的东西：动作定义的**形状**，以及
 * "这个动作允不允许被触发"那一次成员判断。它不 import 工具包的任何概念
 * ——判据换来源时，这里一行都不用改。
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
  /**
   * 动作名：`<包 slug>.<动作名>`（D41 起**只有**这一种形状）。
   *
   * ⚠️ 它来自已安装包的清单，而不是平台内置的一张表——"平台认识哪些动作"
   *    这个问题在 D41 之后没有答案，只有"**这个工作区装了什么**"。
   */
  type: ActionRefType
  /** ★ 执行端。本地由 daemon 执行；远端由远端的服务执行（远端形态仍是扩展位）。 */
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
  /** 一行摘要，用于日志与审计。 */
  describe: (params: Record<string, unknown>) => string
}

/**
 * 校验"这个动作允不允许被触发"。
 *
 * 判据只有一条：它在不在**这个审核者的行动权限**里。而"这个动作本身存在吗"
 * 是另一层（`tool-actions.ts` 的 `validateActionRefWith`：那个包装没装、
 * 有没有声明这个动作）——两层分开，是因为它们的**处置完全不同**：
 * 前者是"配置里没勾"（去勾上），后者是"平台不认识这个动作"（去装包）。
 *
 * ⚠️ 参数类型是 `ActionRefType`（`<包 slug>.<动作名>`，D41 起只有这一种形状）。
 *    这里做的只是一次成员判断——把类型收窄成"平台认识的几个名字"会在白名单
 *    含工具动作时**撒谎**，而"白名单里写了、但类型上不允许"正是最容易在半年后
 *    变成运行时惊喜的那种写法。
 */
export function validateActionAllowed(
  ref: ActionRef,
  allowedActions: readonly ActionRefType[],
): ActionValidation {
  if (!allowedActions.includes(ref.type)) {
    return {
      ok: false,
      issues: [
        // ⚠️ 这句话原来写的是"不在该 skill 允许的动作子集内"——skill 不参与动作
        //    授权，而**错误信息是使用者唯一能看到的东西**：指错地方会让他去
        //    Skills 页翻半天，而该去的是那个**审核者**的「行动权限」。所以这里
        //    连"去哪儿改"一起说。
        `动作 ${ref.type} 不在这个审核者的行动权限里（当前允许：${
          allowedActions.join(', ') || '无'
        }）；要去审核者的「行动权限」里把它勾上`,
      ],
    }
  }
  return { ok: true }
}
