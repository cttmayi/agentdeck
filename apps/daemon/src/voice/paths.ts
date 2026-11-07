import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 语音（离线口述）的**落点约定**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么单独有一层"根"，而不是塞进数据目录
 * ══════════════════════════════════════════════════════════════════
 *
 * ★ 分批第 277 批（使用者定：词典"可以"，指全局一份）：口述词表是**使用者的个人
 *   习惯**（他家的产品名、同事的姓、自己常说错的技术词），不属于某一个 workspace，
 *   也不属于某一条链——所以它跟 `~/.agentdeck/skills`（技能正文）同一层次：
 *   **可见、可预期、人能直接改**。
 *
 * 对比数据目录 `~/.agentdeck/data`：那里是应用自己的东西（store 文件、run 日志），
 * 人不太会去翻。词表与模型正好相反——人一定会想去加一条、也想看到"模型到底下到
 * 哪儿了"。所以给它们一个同级但不是"数据"的位置。
 *
 * ⚠️ 缺省值只在 CLI 里算一次（`--asr-root` 可覆盖），这里只接受**已经定好的根**：
 *   测试要能把它指到 `.cache/test-tmp`，不能在库里自己 `homedir()`——那样测试
 *   会把东西写进真实的家目录（本仓库为这类事付出过代价）。
 */

/**
 * 语音功能自己的根（缺省 `~/.agentdeck/asr`，由 `cli.ts` 给出）。
 *
 * 目录内容：
 *   `vocab.json`       词典（prompt 词 + 替换规则），人可读可改
 *   `settings.json`    语音的选项（模型 / 语言 / 灵敏度 / 输出方式）
 *   `models/`          模型文件（`ggml-base-q5_1.bin` 等，几十到几百 MiB）
 *   `models.lock.json` 模型的 sha256 记录（下载时算、之后每次加载都核对）
 */
export function asrRootJoin(root: string, ...parts: string[]): string {
  return join(root, ...parts)
}

/** `<root>/models`（模型文件）——单独一层，因为那里的文件大且不该被当作配置读。 */
export function modelsDirOf(asrRoot: string): string {
  return join(asrRoot, 'models')
}

/**
 * 写一份 JSON（缩进 2、结尾换行）。
 *
 * ⚠️ 为什么统一走这里：词表与设置**都是人能直接打开改**的文件，所以格式要稳定
 *   （两处各写一份 `JSON.stringify` 早晚会出现一处缩进 2、一处不缩进，diff 一片红）。
 *   先写临时文件再 rename，避免"写到一半断电 ⇒ 词表成了半截 JSON"。
 */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/**
 * 读一份 JSON；文件不在 / 读不动 / 不是对象 ⇒ 返回 null。
 *
 * ⚠️ 读不动时**不抛**：词表文件被手改坏了不该让整个语音功能不可用。调用方拿到
 *   null 之后用默认值继续，并在 capability 里如实报 `vocab: 'broken'`——"坏了但
 *   还能录"比"一进页面就红"好。
 */
export async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    const text = await readFile(path, 'utf8')
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? value : null
  } catch {
    return null
  }
}
