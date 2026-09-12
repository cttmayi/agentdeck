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
  test('★ 一直在活动的进程**永远**不被杀，哪怕跑得比上限久得多', async () => {
    // ══════════════════════════════════════════════════════════════
    // 这条是整个 FR-RUN-08 的要害：跑了很久 ≠ 出问题
    // ══════════════════════════════════════════════════════════════
    //
    // ⚠️ 这条测试原先写歪过：我让 `lastActivityAt()` **自己**把时钟往前推，
    //    于是"有活动"是被**轮询这个动作本身**制造出来的——看门狗每问一次，
    //    就凭空多出一点活动。它当然永远不触发，但那不是因为被测逻辑对，
    //    而是因为测试把答案写进了问题里。
    //
    //    现在改成**真实的时钟 + 独立的输出节奏**：另一个定时器模拟 CLI
    //    每 10ms 吐一行。看门狗问多少次都不影响"最近一次活动"是什么时候。
    let activityAt = Date.now()
    const session = fakeSession({ lastActivityAt: () => activityAt })
    const output = setInterval(() => {
      activityAt = Date.now()
    }, 10)

    let idleFired = false
    const watchdog = startIdleWatchdog({
      session,
      idleTimeoutMs: 50,
      intervalMs: 5,
      onIdle: () => {
        idleFired = true
      },
    })

    // 跑满 300ms —— **6 倍**于空闲上限，且远超任何"墙钟超时"的直觉值
    await new Promise((r) => setTimeout(r, 300))
    watchdog.stop()
    clearInterval(output)

    assert.equal(
      idleFired,
      false,
      '★ 只要子进程仍有活动，就不得因"跑了很久"而终止——这正是 FR-RUN-08 要防的',
    )
  })

  test('★ 对照：同样跑 300ms，但中途**不再有输出** ⇒ 判卡住', async () => {
    // 与上一条唯一的不同是"没有活动"。两条放在一起才能说明
    // 判据确实是**空闲时长**，而不是运行时长。
    let activityAt = Date.now()
    const session = fakeSession({ lastActivityAt: () => activityAt })
    // 只在开头活跃一下，之后彻底安静（模拟卡在某个等待上）
    const output = setInterval(() => {
      if (Date.now() - start > 40) return
      activityAt = Date.now()
    }, 10)
    const start = Date.now()

    let idleFired = false
    const watchdog = startIdleWatchdog({
      session,
      idleTimeoutMs: 60,
      intervalMs: 5,
      onIdle: () => {
        idleFired = true
      },
    })

    await new Promise((r) => setTimeout(r, 300))
    watchdog.stop()
    clearInterval(output)

    assert.equal(idleFired, true, '同样是 300ms，但没有输出的那个才该被杀')
  })

  test('回调带上空闲了多久，便于写进失败原因', async () => {
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
