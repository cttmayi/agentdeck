import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { executableWrapper } from '@agentdeck/agent-core'
import {
  cleanupDoctorReport,
  digestBytes,
  renderCodexDoctorReport,
  runCodexDoctor,
} from './codex-doctor.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * `--doctor codex` 自检本身的行为。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这份测试必须存在（而且必须有**假 codex**）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这条命令的用途是"使用者在 Windows 上说 codex 跑不通时，让他一条命令量出真相"。
 * 如果**它自己**判错了（把正常的配置报成坏的、把坏字节报成好的），那比没有它更糟：
 * 使用者会拿着一个错的结论去改配置。
 *
 * 而它又不能依赖真 codex（NFR-T-01：不调真实 CLI）。所以这里造一个**假 codex**：
 * 一个走 `executableWrapper` 的脚本（Unix 是 `#!/bin/sh`，Windows 是 npm 垫片形状的
 * `.cmd`），它对 `--version` 输出我们指定的字节，对 `app-server` 回一个 JSON-RPC
 * `initialize` 响应。于是"字节判定"和"握手"两条硬逻辑都能在 mac 上量。
 */

interface FakeCodex {
  dir: string
  path: string
}

/**
 * 造一个假 codex。
 *
 * `versionBytes` 直接写进脚本里——用**文件**而不是命令行参数传中文/GBK 字节，
 * 免得多一层 shell 编码问题把这份测试自己搞乱。
 */
async function makeFakeCodex(
  label: string,
  options: {
    /** `--version` 要吐的字节（hex）。默认是正常的 UTF-8 "codex-cli 9.9.9"。 */
    versionHex?: string
    /** 收到 app-server 时是否回 initialize 响应。 */
    answerHandshake?: boolean
  } = {},
): Promise<FakeCodex> {
  const dir = await makeTempDir(`doctor-${label}`)
  const versionHex = options.versionHex ?? Buffer.from('codex-cli 9.9.9\n', 'utf8').toString('hex')
  const answer = options.answerHandshake !== false
  const payload = join(dir, 'version.bin')
  await writeFile(payload, Buffer.from(versionHex, 'hex'))

  const script = [
    "import { readFileSync } from 'node:fs'",
    "import { createInterface } from 'node:readline'",
    `const payload = ${JSON.stringify(payload)}`,
    'const argv = process.argv.slice(2)',
    "if (argv.includes('--version')) {",
    '  process.stdout.write(readFileSync(payload))',
    '  process.exit(0)',
    '}',
    "if (argv.includes('app-server')) {",
    `  ${answer ? '' : "process.exit(3)"}`,
    '  try {',
    `    process.env.AGENTDECK_FAKE_CODEX_HOME_FILE &&`,
    `      (await import('node:fs')).writeFileSync(process.env.AGENTDECK_FAKE_CODEX_HOME_FILE, String(process.env.CODEX_HOME ?? ''))`,
    '  } catch {}',
    '  const rl = createInterface({ input: process.stdin })',
    "  rl.on('line', (line) => {",
    '    let frame',
    '    try { frame = JSON.parse(line) } catch { return }',
    "    if (frame.method === 'initialize') {",
    '      process.stdout.write(',
    "        JSON.stringify({ id: frame.id, result: { userAgent: 'fake-codex/9.9.9' } }) + '\\n',",
    '      )',
    '    }',
    '  })',
    '}',
    '',
  ].join('\n')
  const scriptPath = join(dir, 'codex.mjs')
  await writeFile(scriptPath, script, 'utf8')

  const wrapper = executableWrapper({
    name: 'codex',
    nodePath: process.execPath,
    scriptPath,
  })
  const path = join(dir, wrapper.name)
  await writeFile(path, wrapper.content, 'utf8')
  if (wrapper.needsChmod) await chmod(path, 0o755)
  return { dir, path }
}

/** 造一份"用户的 ~/.codex"。 */
async function makeCodexHome(
  label: string,
  opts: { auth?: Buffer; config?: Buffer } = {},
): Promise<string> {
  const dir = await makeTempDir(`doctor-home-${label}`)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'auth.json'),
    opts.auth ?? Buffer.from('{"OPENAI_API_KEY":"sk-fake"}\n', 'utf8'),
  )
  await writeFile(join(dir, 'config.toml'), opts.config ?? Buffer.from('model = "gpt-5"\n', 'utf8'))
  return dir
}

let fakes: string[] = []

before(() => {
  fakes = []
})

after(async () => {
  for (const dir of fakes) await cleanup(dir)
})

async function fake(
  label: string,
  options: Parameters<typeof makeFakeCodex>[1] = {},
): Promise<FakeCodex> {
  const made = await makeFakeCodex(label, options)
  fakes.push(made.dir)
  return made
}

async function home(label: string, opts?: Parameters<typeof makeCodexHome>[1]): Promise<string> {
  const made = await makeCodexHome(label, opts)
  fakes.push(made)
  return made
}

describe('★ 分批第 42 批：--doctor codex 自检（Windows 上"codex 通不通"的那条命令）', () => {
  test('★★ 正常的一台机器：五项全过（可执行文件 / 版本字节 / 配置 / 复制 / 握手）', async () => {
    const codex = await fake('ok')
    const configHome = await home('ok')
    const report = await runCodexDoctor({
      executablePath: codex.path,
      configSource: configHome,
    })
    try {
      const failed = report.checks.filter((c) => !c.ok)
      assert.deepEqual(failed, [], `不该有失败项：${failed.map((c) => `${c.id}: ${c.detail}`).join(' | ')}`)
      assert.equal(report.executable.found, true)
      assert.equal(report.version.reported, 'codex-cli 9.9.9')
      assert.equal(report.version.bytes?.utf8HasReplacement, false)
      assert.equal(report.config.files.every((f) => f.exists), true)
      assert.equal(report.copy.ok, true, `复制应该成功：${report.copy.reason ?? ''}`)
      // 分批第 56 批：平台会在复制之后追加自己的段（trust / skills.bundled），
      // 所以判据从"逐字节相同"改成"**源内容逐字保留**（受管那份以源为前缀）"
      assert.equal(report.copy.contentPreserved, true, '源内容必须完整保留（复制是字节搬运）')
      assert.equal(report.handshake.ok, true, `握手应该成功：${report.handshake.error ?? ''}`)
      // 报告要能整段复制粘贴：几个关键段落都得在
      const text = renderCodexDoctorReport(report)
      for (const section of ['【环境】', '【可执行文件】', '【配置】', '【复制演练', '【app-server 握手', '【逐条结论】']) {
        assert.ok(text.includes(section), `报告里缺 ${section}`)
      }
      assert.match(text, /结论：全部通过/u)
    } finally {
      await cleanupDoctorReport(report)
    }
  })

  test('★★★ 乱码：`--version` 吐的是 GBK 字节 ⇒ 判成「不是合法 UTF-8」并给出两种读法', async () => {
    /**
     * 这一段字节是「codex-cli 版本」的中文 GBK 写法（`版本` 的 GBK 是 b0e6 b1be）。
     * 它正是使用者看到乱码时的情形：客户端按 ANSI 代码页吐字节，我们按 UTF-8 读。
     */
    const gbkBytes = Buffer.concat([
      Buffer.from('codex-cli ', 'ascii'),
      Buffer.from('b0e6b1be', 'hex'),
      Buffer.from('\n', 'ascii'),
    ])
    const codex = await fake('gbk', { versionHex: gbkBytes.toString('hex') })
    const configHome = await home('gbk')
    const report = await runCodexDoctor({ executablePath: codex.path, configSource: configHome })
    try {
      const check = report.checks.find((c) => c.id === 'version-bytes')
      assert.ok(check, '必须有 version-bytes 这条结论')
      assert.equal(check.ok, false, '不是合法 UTF-8 时必须判失败（不许把它当"读出来了"放过去）')
      assert.match(check.detail, /不是合法 UTF-8/u)
      assert.equal(report.version.bytes?.gbk?.includes('版本'), true, 'GBK 读法要能解出原意')
      assert.ok(report.nextSteps.some((s) => s.includes('chcp 65001')), '要给出立刻能做的下一步')
    } finally {
      await cleanupDoctorReport(report)
    }
  })

  test('★★★ 配置是 UTF-16（PowerShell `>` 重定向的产物）⇒ 指出来，并给转换办法', async () => {
    // `model = "gpt-5"` 的 UTF-16LE 写法（带 BOM）——PS 5.1 的 `>` 就是这个形状
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('model = "gpt-5"\n', 'utf16le'),
    ])
    const codex = await fake('utf16')
    const configHome = await home('utf16', { config: utf16 })
    const report = await runCodexDoctor({ executablePath: codex.path, configSource: configHome })
    try {
      const file = report.config.files.find((f) => f.name === 'config.toml')
      assert.equal(file?.bytes?.bom, 'utf16le', 'BOM 必须判成 utf16le')
      assert.equal(
        file?.problems.some((p) => p.includes('UTF-16')),
        true,
        `要指出它是 UTF-16：${file?.problems.join(' | ')}`,
      )
      const check = report.checks.find((c) => c.id === 'config-encoding')
      assert.equal(check?.ok, false)
      assert.ok(
        report.nextSteps.some((s) => s.includes('UF8') || s.includes('UTF8')),
        '要给出"转成无 BOM UTF-8"的具体写法',
      )
    } finally {
      await cleanupDoctorReport(report)
    }
  })

  test('★★ 缺 auth.json ⇒ 判失败，并提示"设置里取消那个勾"这条临时路', async () => {
    const codex = await fake('missing')
    const configHome = await makeTempDir('doctor-home-missing')
    fakes.push(configHome)
    await writeFile(join(configHome, 'config.toml'), 'model = "x"\n', 'utf8')
    const report = await runCodexDoctor({ executablePath: codex.path, configSource: configHome })
    try {
      const check = report.checks.find((c) => c.id === 'config-present')
      assert.equal(check?.ok, false)
      assert.match(check?.detail ?? '', /缺 auth\.json/u)
      assert.ok(
        report.nextSteps.some((s) => s.includes('运行时配置')),
        '复制失败时要告诉使用者"把设置里那个勾取消"这条临时路',
      )
    } finally {
      await cleanupDoctorReport(report)
    }
  })

  test('★★★ 握手用的是**生产的形状**：CODEX_HOME 指向复制演练目录（不是你的 ~/.codex）', async () => {
    const codex = await fake('home')
    const configHome = await home('home')
    const markerFile = join(await makeTempDir('doctor-home-marker'), 'codex-home.txt')
    process.env['AGENTDECK_FAKE_CODEX_HOME_FILE'] = markerFile
    let report: Awaited<ReturnType<typeof runCodexDoctor>> | null = null
    try {
      report = await runCodexDoctor({ executablePath: codex.path, configSource: configHome })
      assert.equal(report.handshake.ok, true, `握手应该成功：${report.handshake.error ?? ''}`)
      const seen = await readFile(markerFile, 'utf8')
      assert.equal(
        seen,
        report.copy.targetDir,
        '★ 握手必须把 CODEX_HOME 指到那个可写目录（生产里是受管目录）——' +
          '指到 ~/.codex 时 codex 会因建不了状态库而"起不来"，量到的就不是 codex 本身了',
      )
    } finally {
      delete process.env['AGENTDECK_FAKE_CODEX_HOME_FILE']
      if (report) await cleanupDoctorReport(report)
    }
  })

  test('★★ app-server 不回 initialize ⇒ 握手判失败，且不假装通过', async () => {
    const codex = await fake('nohand', { answerHandshake: false })
    const configHome = await home('nohand')
    const report = await runCodexDoctor({
      executablePath: codex.path,
      configSource: configHome,
      handshakeTimeoutMs: 1_500,
    })
    try {
      const check = report.checks.find((c) => c.id === 'app-server-handshake')
      assert.equal(check?.ok, false)
      assert.ok(
        report.nextSteps.some((s) => s.includes('起进程/协议')),
        '握手失败要指到"起进程/协议"这一层，而不是让人去改配置',
      )
    } finally {
      await cleanupDoctorReport(report)
    }
  })

  test('★ digestBytes：三种 BOM 与"非法 UTF-8"都要分得开', () => {
    assert.equal(digestBytes(Buffer.from('abc', 'utf8')).bom, 'none')
    assert.equal(digestBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x61])).bom, 'utf8')
    assert.equal(digestBytes(Buffer.from([0xff, 0xfe, 0x61, 0x00])).bom, 'utf16le')
    assert.equal(digestBytes(Buffer.from([0xfe, 0xff, 0x00, 0x61])).bom, 'utf16be')
    assert.equal(digestBytes(Buffer.from('b0e6b1be', 'hex')).utf8HasReplacement, true)
    assert.equal(digestBytes(Buffer.from('好', 'utf8')).utf8HasReplacement, false)
  })
})
