import { createRequire } from 'node:module'
import { asrRootJoin, modelsDirOf } from './paths.ts'
import { DEFAULT_ASR_MODEL, findModelSpec, modelState, type ModelState } from './models.ts'
import { probeWhisperModule } from './transcriber.ts'

/**
 * 能力探测：这个功能**在这台机器上到底能不能用**，以及不能用时是哪一环不对。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么值得单独一层
 * ══════════════════════════════════════════════════════════════════
 *
 * 语音这条链有三处会"静默地不成立"：平台没有预编译包、模型还没下载、麦克风权限被拒。
 * 三者表现完全一样——**按钮点了没反应**——而修法完全不同（换机器 / 下一次 / 去系统
 * 设置里勾）。所以界面不能只知道"可用/不可用"，必须知道**哪一环**，这才有了这一层。
 *
 * ★ 与 `environment.ts`（运行时预检）同一条路子：提前把话说清，比让人从"没有反应"
 *   往回猜便宜得多。
 *
 * ⚠️ **探测不许有副作用**：这里绝不 `Microphone.open()`——那会在 macOS 上弹系统授权
 *   弹窗，而"我只是打开设置页看看"不该触发权限申请。麦克风的真实状态只能由使用者
 *   主动按「试录」那一下确定（那时才有 user gesture，弹窗也才是合理的）。
 */

/** 有预编译包的平台（whisper-cpp-node 只发这两个）。 */
const SUPPORTED_PLATFORMS: Record<string, string> = {
  'darwin-arm64': 'macOS（Apple Silicon）',
  'win32-x64': 'Windows（x64）',
}

export type MicState = 'unknown' | 'ok' | 'denied' | 'error'

export interface VoiceCapability {
  /** 整条链能不能用（平台 + 原生模块 + 模型都在）。 */
  available: boolean
  /** 给人看的一句话结论；`available` 时为空串。 */
  reason: string
  platform: string
  arch: string
  platformLabel: string | null
  native: {
    /** 采集（decibri）。 */
    capture: { ok: boolean; detail: string }
    /** 转写（whisper-cpp-node）。 */
    transcribe: { ok: boolean; detail: string }
  }
  model: {
    id: string
    path: string
    present: boolean
    looksValid: boolean
    hashOk: boolean | null
    approxMb: number
  }
  /**
   * 麦克风状态。**永远是 `unknown`**，直到使用者按过「试录」——
   * 理由见上面那段（探测不许弹权限窗）。字段留着是因为界面要能显示"上次试录失败"。
   */
  mic: MicState
  /** 目录（诊断用：让人一眼看到模型该放哪儿）。 */
  paths: { asrRoot: string; models: string }
}

export interface CapabilityDeps {
  asrRoot: string
  /** 模型 id（默认取设置里的那一档）。 */
  modelId?: string
  /** 注入平台 / 架构（测试要在 macOS 上判 Windows 那条分支，反之亦然）。 */
  platform?: string
  arch?: string
  /** 注入原生模块探测（测试不加载真模块）。 */
  probeNative?: () => { capture: { ok: boolean; detail: string }; transcribe: { ok: boolean; detail: string } }
  /** 注入模型状态（测试不落盘）。 */
  modelStateOf?: (asrRoot: string, id: string) => Promise<ModelState | null>
}

/** decibri 的加载探测（缓存，与 whisper 那边同一个理由：失败重试没有意义）。 */
let cachedCapture: { ok: boolean; detail: string } | null = null

export function probeCaptureModule(): { ok: boolean; detail: string } {
  if (cachedCapture !== null) return cachedCapture
  try {
    const require = createRequire(import.meta.url)
    const mod = require('decibri') as { Microphone?: unknown }
    cachedCapture =
      mod.Microphone === undefined
        ? { ok: false, detail: 'decibri 装上了但没有 Microphone 导出（版本不对？）' }
        : { ok: true, detail: 'ok' }
  } catch (err) {
    cachedCapture = {
      ok: false,
      detail:
        `装不上 decibri（${err instanceof Error ? err.message : String(err)}）。` +
        `它只提供 macOS / Windows / Linux 的预编译版本。`,
    }
  }
  return cachedCapture
}

export async function probeVoiceCapability(deps: CapabilityDeps): Promise<VoiceCapability> {
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  const key = `${platform}-${arch}`
  const platformLabel = SUPPORTED_PLATFORMS[key] ?? null

  const native =
    deps.probeNative === undefined
      ? { capture: probeCaptureModule(), transcribe: probeWhisperModule() }
      : deps.probeNative()

  const modelId = deps.modelId ?? DEFAULT_ASR_MODEL
  const spec = findModelSpec(modelId) ?? findModelSpec(DEFAULT_ASR_MODEL)
  const state =
    deps.modelStateOf !== undefined
      ? await deps.modelStateOf(deps.asrRoot, modelId)
      : spec === null
        ? null
        : await modelState(deps.asrRoot, spec)

  const model = {
    id: modelId,
    path: state?.path ?? asrRootJoin(modelsDirOf(deps.asrRoot), spec?.file ?? ''),
    present: state?.present ?? false,
    looksValid: state?.looksValid ?? false,
    hashOk: state?.hashOk ?? null,
    approxMb: spec?.approxMb ?? 0,
  }

  // 逐环检查，第一个不成立的那一环就是 reason——只说一个，因为修法只有一条
  let reason = ''
  if (platformLabel === null) {
    reason =
      `这台机器（${key}）没有离线语音的预编译包。` +
      `目前支持 macOS（Apple Silicon，13.3+）与 Windows（x64）。`
  } else if (!native.capture.ok) {
    reason = native.capture.detail
  } else if (!native.transcribe.ok) {
    reason = native.transcribe.detail
  } else if (!model.present) {
    reason = `还没有语音模型（${spec?.label ?? modelId}，约 ${model.approxMb} MiB）——首次使用需要下载一次，之后全程离线。`
  } else if (!model.looksValid) {
    reason = `模型文件不对（${model.path}）：它可能下了一半、或者是反代返回的错误页。删掉它重新下载即可。`
  } else if (model.hashOk === false) {
    reason = `模型文件的哈希与记录不一致（${model.path}）：文件被改过或损坏，删掉它重新下载即可。`
  }

  return {
    available: reason === '',
    reason,
    platform,
    arch,
    platformLabel,
    native,
    model,
    mic: 'unknown',
    paths: { asrRoot: deps.asrRoot, models: modelsDirOf(deps.asrRoot) },
  }
}
