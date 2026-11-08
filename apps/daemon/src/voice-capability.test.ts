/**
 * 能力探测（分批第 277 批）。
 *
 * 这一层存在的理由只有一个：**三处失败看起来一模一样**（按钮点了没反应），而修法
 * 完全不同——换机器 / 下一次 / 去系统设置勾权限。所以它必须说清是**哪一环**，
 * 而不是一个 in/out 的布尔。
 *
 * 测试钉住四件事：
 *   ① 平台判定（在 macOS 上要能判出 Windows 那条分支，所以平台是注入的）；
 *   ② 逐环归因的顺序——先平台、再采集、再转写、最后模型（修法只有一条，只说一条）；
 *   ③ **探测不弹权限窗**：`mic` 永远是 `unknown`，直到使用者主动按「试录」；
 *   ④ 模型文件的四种状态（不在 / 坏了 / 哈希不符 / 好）分别给出不同的 reason。
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { probeVoiceCapability, type CapabilityDeps } from '../src/voice/capability.ts'
import { ASR_MODELS } from '../src/voice/models.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

let root: string

before(async () => {
  root = await makeTempDir('voice-capability')
})
after(async () => {
  await cleanup(root)
})

const SPEC = ASR_MODELS[0]
if (SPEC === undefined) throw new Error('ASR_MODELS 不该是空的')

const goodNative = () => ({
  capture: { ok: true, detail: 'ok' },
  transcribe: { ok: true, detail: 'ok' },
})

const goodModel = (path = '/fake/models/ggml-base-q5_1.bin') => async () => ({
  id: SPEC.id,
  path,
  present: true,
  looksValid: true,
  bytes: 60_000_000,
  hashOk: true,
})

function deps(overrides: Partial<CapabilityDeps> = {}): CapabilityDeps {
  return {
    asrRoot: root,
    platform: 'darwin',
    arch: 'arm64',
    probeNative: goodNative,
    modelStateOf: goodModel(),
    ...overrides,
  }
}

describe('平台与原生模块', () => {
  test('★ 两个受支持平台：macOS(arm64) 与 Windows(x64)', async () => {
    const mac = await probeVoiceCapability(deps())
    assert.equal(mac.available, true)
    assert.equal(mac.reason, '')
    assert.equal(mac.platformLabel, 'macOS（Apple Silicon）')

    const win = await probeVoiceCapability(deps({ platform: 'win32', arch: 'x64' }))
    assert.equal(win.available, true)
    assert.equal(win.platformLabel, 'Windows（x64）')
  })

  test('★★ 不支持的平台说清是"这台机器没有预编译包"，而不是笼统的不可用', async () => {
    const cases: Array<[string, string]> = [
      ['darwin', 'x64'],
      ['win32', 'arm64'],
      ['linux', 'x64'],
    ]
    for (const [platform, arch] of cases) {
      const cap = await probeVoiceCapability(deps({ platform, arch }))
      assert.equal(cap.available, false, `${platform}-${arch} 不该判成可用`)
      assert.match(cap.reason, /macOS（Apple Silicon|预编译包/)
    }
  })

  test('★★ 采集装不上时，reason 是采集那一句（不是模数那一句）', async () => {
    const cap = await probeVoiceCapability(
      deps({
        probeNative: () => ({
          capture: { ok: false, detail: '装不上 decibri（ERR_MODULE_NOT_FOUND）' },
          transcribe: { ok: false, detail: '装不上 whisper-cpp-node' },
        }),
      }),
    )
    assert.equal(cap.available, false)
    assert.match(cap.reason, /decibri/)
  })

  test('★ 采集在、转写不在 ⇒ 报转写那一句', async () => {
    const cap = await probeVoiceCapability(
      deps({
        probeNative: () => ({
          capture: { ok: true, detail: 'ok' },
          transcribe: { ok: false, detail: '装不上 whisper-cpp-node（只发 arm64/x64）' },
        }),
      }),
    )
    assert.match(cap.reason, /whisper-cpp-node/)
  })
})

describe('模型状态与归因', () => {
  test('★★ 模型不在 ⇒ 告诉人"首次要下一次、之后离线"，并给出体积', async () => {
    const cap = await probeVoiceCapability(
      deps({
        modelStateOf: async () => ({
          id: SPEC.id,
          path: '/x/ggml-base-q5_1.bin',
          present: false,
          looksValid: false,
          bytes: 0,
          hashOk: null,
        }),
      }),
    )
    assert.equal(cap.available, false)
    assert.match(cap.reason, /首次使用需要下载/)
    // ★ 293 批：默认档换成 small-q5_1 ⇒ 首次下载约 181 MiB
    assert.match(cap.reason, /181 MiB/)
    assert.equal(cap.model.approxMb, SPEC.approxMb)
  })

  test('★★ 模型在但"不是模型"（下了一半/错误页）⇒ 叫人删掉重下，而不是说"没装"', async () => {
    const cap = await probeVoiceCapability(
      deps({
        modelStateOf: async () => ({
          id: SPEC.id,
          path: '/x/broken.bin',
          present: true,
          looksValid: false,
          bytes: 1024,
          hashOk: null,
        }),
      }),
    )
    assert.match(cap.reason, /模型文件不对/)
  })

  test('★★ 哈希不符（文件被动过）⇒ 也要说清，而不是当没事', async () => {
    const cap = await probeVoiceCapability(
      deps({
        modelStateOf: async () => ({
          id: SPEC.id,
          path: '/x/tampered.bin',
          present: true,
          looksValid: true,
          bytes: 60_000_000,
          hashOk: false,
        }),
      }),
    )
    assert.equal(cap.available, false)
    assert.match(cap.reason, /哈希与记录不一致/)
  })

  test('★★ 探测**不弹麦克风权限窗**：mic 恒为 unknown，直到人按「试录」', async () => {
    const cap = await probeVoiceCapability(deps())
    assert.equal(cap.mic, 'unknown')
  })

  test('★ 目录信息带出来（诊断用：人能一眼看到模型该放哪儿）', async () => {
    const cap = await probeVoiceCapability(deps())
    assert.equal(cap.paths.asrRoot, root)
    assert.equal(cap.paths.models, `${root}/models`)
    assert.equal(cap.model.approxMb, SPEC.approxMb)
  })
})
