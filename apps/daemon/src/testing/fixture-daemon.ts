/**
 * HTTP 夹具只要能拿到 URL 就够——**不要**要求完整的 `DaemonHandle`。
 *
 * 有些测试的 `withDaemon` 只把 `url` 传进来（它们的夹具不关心 store），
 * 收窄成 `DaemonHandle` 会逼着调用方为一个类型去改自己的夹具形状，
 * 而这里真正用到的只有 `d.url`。
 *
 * ⚠️ 2026-11（D123）：这个类型原来住在 `testing/tool-fixture.ts`（工具包夹具）。
 *    工具包与动作能力一起退场，那份夹具整个删了，但**这个类型不是工具包的**——
 *    它只是"测试里一个 daemon 至少长什么样"，`testing/chain.ts`（建组助手）与
 *    它的一批用例都靠它，所以搬到这里（`testing/fixture-daemon.ts`）。
 */
export interface FixtureDaemon {
  url: string
}
