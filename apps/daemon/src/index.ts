/**
 * `@alpha-helper/daemon` —— 本机服务。
 *
 * 托管 Web UI、接受同源页面请求、执行 run。**不发起任何对远端的请求**
 * （FR-BRIDGE-08）——取 run、下载 skill、上报记录都由页面代为发起。
 */

export { startDaemon, isAllowedHost, type DaemonOptions, type DaemonHandle } from './server.ts'
export { RunExecutor, type SubmitOutcome, type ExecutorDeps } from './executor.ts'
export { RunRegistry, replayMessagesSince, type RunEventInput } from './registry.ts'
export { Semaphore } from './semaphore.ts'
export { WorkDirLocks } from './workdir-locks.ts'
export { DEFAULT_PORT, DEFAULT_DATA_DIR, parseCliArgs, HELP } from './cli.ts'
