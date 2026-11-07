# 离线语音口述（voice dictation）

> **状态**：后端已落地（分批第 277 批）；**界面还没做**（批 278 起）。
> 现在可以用 curl 跑通整条链：开录音 → 说话 → 自动/手动结束 → 拿回文本。

目标：**离线把话说成字**，按钮触发，说完自动停，文本交给上层（`wiki-capture` 之类的
SKILL）决定怎么用。平台**只产出文本**——不写库、不建链接、不做检索、不自动记忆。

---

## 1. 约束（使用者定）

1. 全程离线 ASR；采集用 `decibri`、识别用 `whisper-cpp-node`。
2. 只有点按钮才录；VAD 静音自动结束，也支持手动停。
3. 专有名词矫正两层：whisper `initialPrompt` + 词典替换表。
4. 不做向量检索、不自动记忆、不自动建链接；保存 / 链接由上层 SKILL 控制。
5. 输出：识别文本，供上层调用。

---

## 2. 为什么采集放在 daemon 侧（方案 A）

一开始选的是"页面采集（decibri 的浏览器 entry）+ daemon 只做识别"。核包之后改了，理由是
**浏览器版 decibri 缺三样东西**（`src/browser/decibri-browser.js` 里写死的）：

| | daemon 侧（Node 版） | 页面侧（浏览器版） |
|---|---|---|
| 静音自动结束 | **Silero VAD**，模型 2.2 MiB 随包内置、离线 | 只有 `energy`（RMS 阈值）：要开场标定 + 灵敏度档，噪声环境仍误判 |
| 音频前处理 | `highpass` / `denoise`(fastenhancer，模型 124 KiB 内置) / `agc` / `limiter` / `aec` | **全部不支持**（`UNSUPPORTED_OPTIONS` 直接抛），只能自己写高通 |
| 音频边界 | 不出进程 | WAV 编解码 + 上传 + 体积上限 |
| 麦克风权限 | daemon 进程的（macOS TCC 跟着"谁拉起 daemon"） | 浏览器的（更友好） |
| daemon 跑容器/远程时 | 没有麦克风 ⇒ 不可用 | 可用 |

最后一条是页面采集**唯一**的真收益，而当前用法是"本机桌面工作台"，用不上；而前面三条
（真 VAD、整套前处理、少一层音频边界）全都能吃到。所以按 A 落地。

⚠️ 采集仍然是一层**端口**（`CapturePort`）：将来真要"页面采集 + 音频传到 daemon"，
只换实现，会话与转写一行不用动。

---

## 3. 模块

```
apps/daemon/src/voice/
  paths.ts        落点约定（vocab.json / settings.json / models/ / models.lock.json）
  vocab.ts        两层矫正：prompt 组装 + 确定性替换（区间不重叠、可回显）
  text.ts         分段拼接与排版收拾（不改词）
  models.ts       模型目录、下载、魔数/哈希校验、锁定文件
  transcriber.ts  转写端口 + whisper-cpp-node 实现（懒加载、常驻上下文）
  capture.ts      采集端口 + decibri 实现（Silero VAD）
  session.ts      会话状态机（三条闸 + 转写流水线）
  capability.ts   能力探测与**逐环归因**
  settings.ts     模型 / 语言 / 灵敏度 / 输出方式
  service.ts      装配点（单例会话、模型上下文缓存）——**不认识 store / skill / run**
  defaults.ts     真实实现的默认值（避免循环引用）
```

**一条硬纪律**：`voice/` 里没有任何写库、建 run、调 skill 的路径。约束 4 与 5 在代码里就是
这句话，不是靠自觉。

---

## 4. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/voice/capability` | 能不能用、为什么不能、模型在不在、目录在哪 |
| GET/PATCH | `/api/voice/vocab` | 词表（`promptTerms` + `rules`），连同 `problems` 一起回 |
| GET/PATCH | `/api/voice/settings` | 模型 / 语言 / 灵敏度 / 输出方式 |
| POST | `/api/voice/models/ensure` | 首次下载模型（之后全离线）；失败 502 + 人话 |
| POST | `/api/voice/sessions` | 开录音 ⇒ 201 + `{id, state}`；已在录 ⇒ **409** |
| GET | `/api/voice/sessions/{id}` | 轮询状态（`recording` / `transcribing` / `done` / `failed` / `cancelled`） |
| POST | `/api/voice/sessions/{id}/stop` | 手动结束 ⇒ 202，转写在后台跑 |
| POST | `/api/voice/sessions/{id}/cancel` | 丢弃这段音频（不转写） |

能力标志：`/api/identity` 的 `capabilities` 里有 `voice-dictation`（旧 daemon 没有这条路径，
界面靠它决定画不画按钮）。

`done` 的快照带 `{ text, raw, corrections[], ms }`：`text` 是替换后的结果，`raw` 是原始识别，
`corrections` 是"改了哪几处、几遍"——**静默改写是最危险的一种失败**，所以必须能回显。

---

## 5. 状态机与三条闸

```
idle ──start──▶ recording:waiting-speech ──首个 speech──▶ recording:speaking
                    │                                        ├─ silence ≥ holdoff ⇒ 转写
                    │                                        ├─ 手动 stop ────────⇒ 转写
                    └─ 8s 没开口 ⇒ failed("没听到声音")        └─ > 120s ⇒ 转写（truncated）
```

- **静音计时只在"说过话之后"启动**：一按按钮就开始计时是"点一下就没"的根因。
- **没开口超时 8s**：防"点了按钮就走开"把麦克风一直占着。
- **最长录音 120s**：到点**转写**（不是丢弃）并标 `truncated`。
- **没声音兜底**：2 秒内一帧非零都没有 ⇒ 失败并叫人检查麦克风（比"录完什么都没发生"好）。
- **转写超时 120s**：超时只放弃等待，不取消底层调用（whisper 无法中断）。

---

## 6. 两层矫正

1. **initialPrompt**（软）：把词表拼成一句自然话，按 **180 字字符预算**截断
   （whisper 的 prompt 上限约 224 token，超了会**静默截断**——所以要自己先截）。
2. **替换表**（硬，确定性）：只允许字面串（不给正则），`from` **长串优先**、命中区间
   **不重叠**（杜绝链式改写），英文按词边界、中文按整串，命中**计数并回显**。

误伤反例（测试钉着）：`我家的 deck` 不许变成 `我家的 AgentDeck`；`captured` 不许被
`capture` 规则咬掉。

---

## 7. 平台与落点

| 项 | 值 |
|---|---|
| 支持平台 | **macOS（Apple Silicon，13.3+）**、**Windows（x64）**——`whisper-cpp-node` 只发这两个预编译包 |
| Intel Mac / Windows ARM / Linux | 能力探测判不可用，界面不画按钮（不是运行时崩） |
| 落点 | `~/.agentdeck/asr/`（`--asr-root` 可覆盖）：`vocab.json` / `settings.json` / `models/` / `models.lock.json` |
| 默认模型 | `ggml-base-q5_1.bin`（约 57 MiB，多语言）；可切 `small-q5_1`（181 MiB）/ `small`（466 MiB） |
| 上游基址 | 默认 HuggingFace，`--asr-model-base` 可换镜像（国内直连常常不通） |
| 语言 | 默认 `zh`，可选 `en` / `auto`（中英混说时 auto 容易判错） |
| 灵敏度 | 三档 `stable`(0.6/1200ms) / `normal`(0.5/800ms) / `quick`(0.4/500ms) |

---

## 8. 踩过的坑（写在这里免得再踩）

1. **`import('whisper-cpp-node')` 是坏的**（0.2.12）：`exports.import` 指向不存在的
   `dist/index.mjs`。必须 `createRequire(...)` 拿 CJS 入口。
2. **`new Microphone()` 会阻塞 event loop**（同步做 Silero 模型加载）⇒ 一律
   `Microphone.open()`。daemon 里还挂着 SSE 长连接，一次录音会把整页卡住。
3. **`Buffer` 的 `byteOffset` 不保证偶数** ⇒ 直接 `new Int16Array(buf.buffer, …)` 会抛
   `RangeError`；拷贝一份再当 Int16 看。
4. **浏览器版 decibri 关不掉 `echoCancellation`/`noiseSuppression` 的默认值以外的东西**
   ——它对 ASR 有害（NS 削气声、AEC 门限化），Node 版要显式 `false`。
5. **模型的"下了一半"是最常见的失败**：反代/镜像返回 200 + HTML。所以校验三层：
   `ggml` 魔数、Content-Length 对齐、锁定哈希（`models.lock.json`）。
6. **会话取消时的空指针**：`cancel()` 会同步触发 `onChange` → `retire()` 把 `active`
   置空，之后再 `this.active.snapshot()` 就是 500（实测踩到）。

---

## 9. 测试（`pnpm run check` 里）

不碰真麦克风、不加载真模型、不联网——采集/转写/fetch/平台/时钟全都注入：

- `voice-vocab.test.ts`：替换规则的误伤反例、长串优先、区间不重叠、prompt 预算、坏词表降级
- `voice-models.test.ts`：HTML 错误页、缺 Content-Length、传输中断、哈希不符、镜像地址
- `voice-capability.test.ts`：平台判定、逐环归因、**探测不弹权限窗**
- `voice-session.test.ts`：三条闸、自动/手动结束、取消、转写失败、词典在会话里生效
- `voice-api.test.ts`：路由、单例 409、结束后仍可查、取消不留文本、模型缺失时说人话

**注**：`voice-api.test.ts` 必须注入 `voiceProbeNative` / `voiceModelStateOf`——否则同一份测试
在 macOS 上会走完会话流程、在 Linux 上"提前 return"，绿得毫无意义。

---

## 10. 界面（批 278 已做一半）

**已做**：聊天输入条的麦克风按钮（`apps/web/src/components/VoiceButton.svelte`）
- 走 `ChatComposer` 的 `extra` 槽位——与回形针、「发送」同一组，**同高**（探针钉着）
- 四态：`idle` / `recording`（红点按电平脉动 + 已录秒数）/ `transcribing` / 失败原因
- 再点一下 = 提前结束；`Esc` = 取消这一次（不产出文本）
- 识别完**只回填输入框**（接在已写的字后面，补一个空格），复焦给输入框，**不发送**
- 只有 daemon 报出 `voice-dictation` 能力时才渲染（旧 daemon 上不画按钮）
- 挂载时探一次 `/api/voice/capability`（**无副作用**，不弹权限窗）；不可用时点一下当场说明原因

**设置面板（批 279）**：聊天页「设置」抽屉里的「语音输入」一节
- 状态行说实话：能用 / 不能用的**原因**（没模型、平台不支持、装不上原生模块）
- 模型三档下拉 + 缺模型时一颗「下载模型（约 57 MiB）」；有模型时换「试录 3 秒」自检
- 语言 `zh` / `en` / `auto`；灵敏度 `稳 / 中 / 快`；降噪开关（默认关）
- 「试录 3 秒」一次验完三件事：麦克风权限、模型、写入口径（听到什么就回显什么）
- 新增 `GET /api/voice/models`（三档 + 每档在本地的状态），走 `VoiceService.modelCatalog()`
  以便测试注入

**词典那一节（批 280）**：同一个抽屉里的「专有名词」，两层都能编
- 词表 chips（加/删）——只放正确写法；替换规则列表（`听错的样子 → 正确写法`，加/删）
- 服务端整份替换写回；**被跳过的坏条目**（`problems`）原样显示，不假装保存成功
- 「一键加词」：识别完人如果**手动改了**，就用改动前后提一条规则（`apps/web/src/lib/dictation.ts`），
  聊天页弹一枚 chip「这是你改的：「微思普」→「Whisper」」+「记进词典」
  ⚠️ 只在**一处、像词、不跨标点、不只有大小写差别**时才提（词级 LCS；第一版用逐字符
  前后缀，`agent deck → AgentDeck` 会提出半截规则 `agent d → AgentD`，测试当场抓到）

**还没做**：
- `outputMode`（`input` / `via-skill`）的**开关与行为**——设置里这个字段已经有了，
  但界面还没给入口，等"自动发送 + 3 秒撤销"一起做（先摆一颗不起作用的开关就是死接口）
- 下载进度（现在只有一个"正在下载…"，没有百分比）
- `outputMode: 'via-skill'`：识别后**自动发送一条聊天消息** + 3 秒可撤销（平台不自己调 skill）
- 词典编辑与「一键加词」（从 `raw` 与改后文本的差异生成规则）
- 任务输入框的麦克风按钮（使用者：先做聊天，做好兼容——`VoiceButton` 不认识聊天，直接接就行）
- 模型下载进度（现在是"下完才回"，没有中间进度）
