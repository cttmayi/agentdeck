import type { AgentSession } from '@alpha-helper/agent-core'

/**
 * 空闲看门狗（FR-RUN-08）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要"空闲"超时，而不是"墙钟"超时
 * ══════════════════════════════════════════════════════════════════
 *
 * FR-RUN-08 的原话是：「**长时运行不得被墙钟终止**：只要子进程仍有活动，
 * 就不得因"跑了很久"而终止」。
 *
 * 它针对的是一个很具体的坏体验：一个跑了 40 分钟、一直在正常输出的大重构，
 * 被一个"30 分钟超时"掐死在最后一公里。**耗时长不等于出问题**。
 *
 * 所以超时的判据必须是**"多久没有动静"**，而不是"跑了多久"。
 * 一个每几秒就吐一行输出的进程，无论跑 5 分钟还是 5 小时都不该被杀；
 * 一个 10 分钟一个字都不吐的进程，才是真的卡住了。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里修的是一个"接受但忽略"的参数
 * ══════════════════════════════════════════════════════════════════
 *
 * `limits.timeoutMs` 在协议里是**校验过的正整数**（`z.number().int().positive()`），
 * 一路传到执行器……然后**被完全忽略**。调用方以为设了超时，实际没有。
 *
 * 这和一个吞掉选项的 `--`、一个不被执行的插件 `entry` 是同一类缺陷：
 * **接口接受了，行为上不存在**。它比"没有这个功能"更糟，因为使用者会基于
 * 一个不存在的保证去做计划。
 *
 * 顺带说明：`RunFailureReason` 里那个枚举值叫 **`idle_timeout`** 而不是
 * `timeout`——命名本身就写明了设计意图是空闲超时。这也是一条证据：
 * 要接的东西设计时就想好了，只是没接。
 */

export interface IdleWatchdogOptions {
  session: AgentSession
  /** 多久没动静算卡住（毫秒）。 */
  idleTimeoutMs: number
  /** 触发时的回调（用于取消与标记失败）。 */
  onIdle: (idleMs: number) => void
  /** 让调用方能注入时钟（测试不必真的等）。 */
  now?: () => number
  /** 检查间隔，默认 1 秒。 */
  intervalMs?: number
  onWarn?: (message: string) => void
}

export interface IdleWatchdog {
  /** 停掉看门狗。**必须在 finally 里调用**，否则进程里会留下一个永不结束的定时器。 */
  stop: () => void
  /** 已经空闲了多少毫秒（诊断用）。 */
  idleMs: () => number
}

/**
 * 起一个空闲看门狗。
 *
 * 用**轮询**而不是"活动事件驱动的重置定时器"：后者的前提是每一个活动点
 * 都会通知我们，而适配器那边只要漏掉一处（新加一种消息类型忘了回调），
 * 定时器就不会被重置——于是**一个正常干活的进程会被误杀**，而且原因很难查。
 * 轮询只依赖 `lastActivityAt()` 这一个接口，漏不掉。
 *
 * 代价是有最多 `intervalMs` 的判定延迟，对"多久没动静"这种量级完全无所谓。
 */
export function startIdleWatchdog(options: IdleWatchdogOptions): IdleWatchdog {
  const now = options.now ?? (() => Date.now())
  const intervalMs = options.intervalMs ?? 1000
  let stopped = false

  const timer = setInterval(() => {
    if (stopped) return
    let idleMs: number
    try {
      // 适配器可能已经结束了会话，此时读数没有意义
      idleMs = now() - options.session.lastActivityAt()
    } catch {
      return
    }
    if (idleMs >= options.idleTimeoutMs) {
      stopped = true
      clearInterval(timer)
      options.onIdle(idleMs)
    }
  }, intervalMs)

  // `unref` 很要紧：不解除引用的话，这个定时器会**拖住事件循环**，
  // 让测试进程（以及任何想退出的场景）一直不结束。这类"测试跑完不退出"
  // 的问题排查起来极其费时，因为症状出现在离原因很远的地方。
  if (typeof timer.unref === 'function') timer.unref()

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
    idleMs: () => now() - options.session.lastActivityAt(),
  }
}
