/**
 * @agentdeck/orchestration —— 编排引擎（与界面/daemon 解耦）。
 *
 * 导出：执行引擎 / 原语 / 契约类型 / 运行模型。
 * 执行侧（submitStep、等人确认、持久化）以 EngineHooks 注入。
 */

export { executeWorkflow } from './engine.ts'
export { makePrimitives, type Primitives, type Env } from './primitives.ts'
export type {
  Reply,
  Handle,
  StepSubmitOptions,
  StepSubmitResult,
  EngineHooks,
  GateVerdict,
  WorkflowRun,
  WorkflowStep,
} from './types.ts'
