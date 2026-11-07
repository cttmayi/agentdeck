import { createDecibriCapture, type CaptureFactory } from './capture.ts'
import { loadWhisperTranscriber, type TranscriberLoader } from './transcriber.ts'

/**
 * 真实实现的**默认值**（单独一个文件，避免循环引用）。
 *
 * ⚠️ 为什么拆出来：`service.ts` 要用默认实现，而默认实现所在的模块（`capture.ts` /
 *   `transcriber.ts`）只依赖端口定义。把它们写进 `service.ts` 会让"端口 ← 实现 ←
 *   装配"变成一条环，将来谁 import 谁就说不清了。
 *
 * ⚠️ 这两个值的加载都是**懒的**：`capture.ts` / `transcriber.ts` 里真正 `require`
 *   原生模块发生在第一次调用时。所以"这台机器没有预编译包"不会让 daemon 起不来——
 *   只会让语音那一块报不可用（见 capability 的归因）。
 */

export const defaultCaptureFactory: CaptureFactory = createDecibriCapture
export const DEFAULT_TRANSCRIBER_LOADER: TranscriberLoader = loadWhisperTranscriber
