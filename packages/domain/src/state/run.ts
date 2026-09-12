import type { RunStatus } from '@alpha-helper/protocol'
import { IllegalTransitionError } from '../errors.ts'

/**
 * Run 状态机的合法转移表（requirements §10.1、SM-RUN-1）。
 *
 * 三条语义必须记住：
 * 1. `completed` 只表示**这次 run 结束了**，不代表 issue 完成；
 * 2. 改变 issue 的指派人或状态**不得**停止已启动的 run；
 * 3. 终态没有出边——**重试是新建一个 run**，不是复活旧记录。
 *    这是 DR-3「历史不得被覆盖」的直接后果。
 */
const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  // 定时未到点
  deferred: ['queued', 'cancelled'],

  // 等待页面把它交给本机 daemon
  //
  // ★ `failed` 这条出边是**后加的**，理由见下面 `waiting_local_directory` 那段：
  //   run 可能在**还没开始执行**的时候就因为与它自身无关的原因终结。
  queued: ['dispatched', 'cancelled', 'failed'],

  // daemon 已受理。可能起不来（注入失败）、也可能要等目录释放
  dispatched: ['running', 'waiting_local_directory', 'completed', 'failed', 'cancelled'],

  // 目录被占用而停放；释放后重新排队
  //
  // ══════════════════════════════════════════════════════════════════
  // 为什么 `queued` 与这里都需要一条通向 `failed` 的边
  // ══════════════════════════════════════════════════════════════════
  //
  // 需求 §10.1 对 `failed` 的定义是"**出错或被中断**"——"被中断"是它字面
  // 含义的一部分。但转移表原来只允许从 `dispatched` / `running` 进入它，
  // 那等于假设**run 只可能在开始执行之后出问题**。
  //
  // 一个反例就摆在眼前：daemon 重启。状态是持久化的，所以上次退出时还在
  // 排队的 run 会停在 `queued` / `waiting_local_directory` 上。它们同样
  // **再也不会有结果**（执行所需的 prompt 与技能正文没有落盘），而原来的
  // 表只给它们留了 `cancelled` 一条出边——那是"使用者主动停止"，写成这个
  // 等于**在数据里撒一个谎**：明明是被重启中断的，却记成用户取消的。
  //
  // 所以补这两条边，让"被中断"能落进它本该落的地方。
  waiting_local_directory: ['queued', 'cancelled', 'failed'],

  // CLI 正在执行
  running: ['completed', 'failed', 'cancelled'],

  // ── 终态：无出边 ──
  completed: [],
  failed: [],
  cancelled: [],
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to)
}

export function allowedRunTransitions(from: RunStatus): readonly RunStatus[] {
  return RUN_TRANSITIONS[from]
}

/** 非法转移直接抛——静默忽略会让状态机失去意义。 */
export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new IllegalTransitionError('run', from, to)
  }
}

/**
 * daemon 受理一个 run 时，要把它落到哪个状态。
 *
 * 这里是 D20「同一工作目录串行化」的落点：
 * 目录被占用时不失败，而是停放并携带原因——因为占用是**可恢复的**，
 * 失败只会让使用者重跑一次。
 */
export function statusAfterDispatch(workDirHeldByOther: boolean): RunStatus {
  return workDirHeldByOther ? 'waiting_local_directory' : 'running'
}
