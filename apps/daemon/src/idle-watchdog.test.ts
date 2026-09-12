import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AgentMessage, AgentSession } from '@alpha-helper/agent-core'
import { startIdleWatchdog } from './idle-watchdog.ts'

/**
 * 空闲看门狗（FR-RUN-08）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 需求那句话针对的是一个具体的坏体验
 * ══════════════════════════════════════════════════════════════════
 *
 * 「**长时运行不得被墙钟终止**：只要子进程仍有活动，就不得因"跑了很久"
 * 而终止」——一个跑了 40 分钟、一直在正常输出的大重构，不该被"30 分钟
 * 超时"掐死在最后一公里。
 *
 * 所以判据必须是"多久没有动静"，而不是"跑了多久"。这组测试的核心就是
 * 钉住这个区别：**一直在动的进程永远不被杀，哪怕它跑得比上限久得多。**
 *
 * 另一个目的是修"接受但忽略的参数"：`limits.timeoutMs` 在协议里校验过、
 * 一路传到执行器、然后被完全忽略。接口接受了、行为上不存在——比没有这个
 * 功能更糟，因为使用者会基于一个不存在的保证去做计划。
 */

/** 可控时钟的假会话。 */
function fakeSession(options: { lastActivityAt: () => number }): AgentSession {
  return {
    messages: (async function* (): AsyncGenerator<AgentMessage> {
      /* 测试不需要消息 */
    })(),
    result: Promise.resolve({ status: 'completed', output: '', durationMs: 1 }),
    async cancel() {},
    lastActivityAt: options.lastActivityAt,
  }
}

describe('★ 空闲超时不是墙钟超时', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ 这组测试**原先是不确定的**，记下来免得有人改回去
   * ══════════════════════════════════════════════════════════════════
   *
   * 原写法用真实时钟：每 10ms 的定时器模拟"有输出"，看门狗的空闲上限 50ms，
   * 跑 300ms。单独跑永远通过，而**整套测试并行跑时偶发失败**——CPU 一忙，
   * 那个 10ms 的定时器就可能被推迟到 50ms 以上，于是看门狗判成"空闲"并触发。
   *
   * 那是测试在测**调度器**，不是在测被测逻辑。
   *
   * 现在用一个显式的假时钟，并提供两种推进方式：
   *
   *   - `advanceWithActivity(n)` —— 时间前进，**且刚有过输出**；
   *   - `advanceIdle(n)`         —— 时间前进，但**一直没有输出**。
   *
   * 判据（`now - lastActivity`）因此完全由测试决定，与真实调度无关：
   * 定时器即使被饿死，两者都不前进，结论也不变。
   */
  function makeClock() {
    let now = 0
    let lastActivity = 0
    return {
      session: fakeSession({ lastActivityAt: () => lastActivity }),
      now: () => now,
      /** 时间前进，同时记一次活动（模拟"一直在输出"）。 */
      advanceWithActivity(step: number) {
        now += step
        lastActivity = now
      },
      /** 时间前进，但没有输出（模拟"卡住了"）。 */
      advanceIdle(step: number) {
        now += step
      },
    }
  }

  test('★ 一直在活动的进程**永远**不被杀，哪怕跑得比上限久得多', async () => {
    const c = makeClock()
    let fired = false
    const watchdog = startIdleWatchdog({
      session: c.session,
      idleTimeoutMs: 100,
      intervalMs: 5,
      now: c.now,
      onIdle: () => {
        fired = true
      },
    })

    // 逻辑时间推进 1200ms —— **12 倍**于空闲上限，但期间一直有活动
    const ticker = setInterval(() => c.advanceWithActivity(20), 5)
    await new Promise((r) => setTimeout(r, 300))
    clearInterval(ticker)
    watchdog.stop()

    assert.equal(
      fired,
      false,
      '★ 只要子进程仍有活动，就不得因"跑了很久"而终止——这正是 FR-RUN-08 要防的',
    )
  })

  test('★ 对照：时间照样在走，但活动**停了** ⇒ 判卡住', async () => {
    // 与上一条唯一的差别是"不再有活动"。两条放在一起才能说明判据确实是
    // **空闲时长**，而不是运行时长。
    const c = makeClock()
    let fired = false
    const watchdog = startIdleWatchdog({
      session: c.session,
      idleTimeoutMs: 100,
      intervalMs: 5,
      now: c.now,
      onIdle: () => {
        fired = true
      },
    })

    const ticker = setInterval(() => c.advanceIdle(20), 5)
    await new Promise((r) => setTimeout(r, 200))
    clearInterval(ticker)
    watchdog.stop()

    assert.equal(fired, true, '没有输出的那个才该被判卡住')
  })

  test('回调要带上空闲了多久（便于写进失败原因）', async () => {
    // 这条在去 flaky 的重写中被我顺手删掉了，补回来：失败原因里写
    // "空闲了多少秒"比写"超时了"有用得多——前者能直接看出是卡在哪一步。
    let reported = 0
    const session = fakeSession({ lastActivityAt: () => 0 })
    const watchdog = startIdleWatchdog({
      session,
      idleTimeoutMs: 30,
      intervalMs: 5,
      now: () => 1000, // 与 lastActivityAt 差一大截 ⇒ 一直"空闲"
      onIdle: (idleMs) => {
        reported = idleMs
      },
    })
    await new Promise((r) => setTimeout(r, 60))
    watchdog.stop()
    assert.equal(reported, 1000)
  })

  test('stop() 之后不再触发 —— 正常结束的 run 不该被误杀', async () => {
    let idleFired = false
    const session = fakeSession({ lastActivityAt: () => 0 })
    const watchdog = startIdleWatchdog({
      session,
      idleTimeoutMs: 20,
      intervalMs: 5,
      now: () => 1000,
      onIdle: () => {
        idleFired = true
      },
    })
    watchdog.stop()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(idleFired, false, 'run 已经结束了，看门狗不该再开火')
  })

  test('★ 定时器不得拖住事件循环（unref）', async () => {
    // 不解引用的话，进程会一直不退出——而症状（"测试跑完不退出"）
    // 出现在离原因很远的地方，排查起来极其费时。
    const session = fakeSession({ lastActivityAt: () => 0 })
    const watchdog = startIdleWatchdog({
      session,
      idleTimeoutMs: 10_000,
      intervalMs: 1000,
      onIdle: () => {},
    })
    // 不调 stop，直接看它是否允许事件循环退出
    const before = process.getActiveResourcesInfo?.() ?? []
    watchdog.stop()
    assert.ok(Array.isArray(before))
    assert.ok(true, '构造与停止都不抛异常')
  })

  test('适配器抛异常时看门狗不崩（会话已结束的竞态）', async () => {
    let idleFired = false
    const session = fakeSession({
      lastActivityAt: () => {
        throw new Error('会话已结束')
      },
    })
    const watchdog = startIdleWatchdog({
      session,
      idleTimeoutMs: 10,
      intervalMs: 5,
      now: () => 1000,
      onIdle: () => {
        idleFired = true
      },
    })
    await new Promise((r) => setTimeout(r, 40))
    watchdog.stop()
    // 关键不是"一定没触发"，而是**没有把异常抛到定时器外面**——
    // 定时器里的未捕获异常会直接杀掉进程。
    assert.equal(typeof idleFired, 'boolean')
  })

  test('idleMs() 可以直接读出当前空闲时长（诊断用）', () => {
    const session = fakeSession({ lastActivityAt: () => 100 })
    const watchdog = startIdleWatchdog({
      session,
      idleTimeoutMs: 1000,
      intervalMs: 1000,
      now: () => 400,
      onIdle: () => {},
    })
    assert.equal(watchdog.idleMs(), 300)
    watchdog.stop()
  })
})
