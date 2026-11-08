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
| 模型目录 | 只剩**两档**：`small-q5_1`（181 MiB，**默认**）与 `small`（466 MiB，最准最慢）。<br>`base-q5_1` 已在 294 批**从目录删除**（使用者："去掉 base 的选项，我感觉它基本不可用"）——实测它会把 `pnpm`/`VAD` 这类缩写整个毁掉（§7.7）。老 `settings.json` 里存过 `base-q5_1` 的人会自动回落到默认档 |
| 上游基址 | **回退链**：先 huggingface.co，不通就自动换 hf-mirror.com（两者内容一致）；`--asr-model-base` 给了就**只用它、不回落**。结果里带 `source`，界面会说清"来自哪个 host" |
| 语言 | 默认 `zh`，可选 `en` / `auto`（口径见下面 §7.7：中英混说 `zh` 与 `auto` **一样好**；`zh` 的坑是**整段英文会被翻成中文**） |
| 灵敏度 | 三档 `stable`(0.6/1200ms) / `normal`(0.5/800ms) / `quick`(0.4/500ms) |

---

## 7.5 用对话里的词辅助识别（批 286）

使用者问："有没有可能用对话的上下文来优化录音识别率？"——可以，但**不是把对话原文塞进去**。
真模型实测（base-q5_1 + TTS，三句含标识符的话）：

| 条件 | `wiki capture 那条链路` | `distilly 技能` | `agent deck 昨天的任务` | 命中 |
|---|---|---|---|---|
| 不带 prompt | `Wiki Capture` | `Distly` | `Agent Deck` | 0/3 |
| 只放 3 个标识符 | `capturne`（这句崩了） | **`distilly` ✓** | **`AgentDeck` ✓** | 2/3 |
| 3 个 + 20 个无关词 | `toucher` | `distilly` ✓ | `AgentDeck` ✓ | 2/3 |
| **上一轮整句话**当 prompt | `Wiki Capture` | `Distley` | `Agent Deck` | **0/3** |

结论：**抽"标识符"有用，塞整段上下文没用**（后者只是噪声）。

实现（`voice/context-terms.ts`，正则 + 词频，**不用 LLM**）：
- 抽：带分隔符（`whisper.cpp`/`wiki-capture`/`SKILL.md`）、camelCase（`openConversation`）、
  PascalCase（`AgentDeck`）、缩写（`VAD`）；外加"全小写但不在常见词表里、≥4 字母"的
  自造词（`distilly`/`whisper`）
- 不抽：纯中文（没有分词器时最容易误伤）、纯数字、长 hash、常见英文词（一张 300+ 词的
  白名单反面，`model/test/commit/fine/please` 都在里面）
- 上限：取最后 20 条消息、最多 12 个词；**手动词表先占 180 字预算**，自动词只填剩下的
- 接口：`POST /api/voice/sessions { context: { conversationId } }`——只传 id，读库是 daemon 的事；
  只读 `ChatTurn.userText`（**你说的话**），不读 agent 输出（路径与代码片段会把偏见拉偏）
- 回显：快照里带 `contextTerms`，识别完成后 toast 说「用了 N 个对话里的词，纠正 M 处」
- 开关：设置里「用对话里的词」（默认开）。抽词失败**不影响录音**（少一层帮助而已）

两个风险都实测过：**静音 + prompt 会幻觉**（吐"这些人都在这儿。"）——被已有的"2 秒全零
⇒ 判没声音"那道闸挡住；**prompt 会诱导**（杂词让 `我下午把` 变 `我下无法规及`）——
所以只放标识符、控预算、可关闭。

## 7.6 抽词的完整规则（批 286–287）

素材来自**当前对话**的两个来源，**两套门槛**（使用者定："≥2 次只用在用户语句上，
大模型的答复不需要，因为只有用户会输出错误"）：

| 来源 | 取什么 | 准入门槛 |
|---|---|---|
| **你说的话** | 最近 20 轮 `ChatTurn.userText` | 强形状 1 次即可；**全小写自造词要 ≥2 次** |
| **模型的回复** | 每轮 run 的**最后一条文本**（`lastTextOf`） | **只收强形状**，且排除路径（`/`）、引用（`:`）、文件名（`.md`/`.png`）、超 24 字符；**最多补 3 个** |

**强形状** = 带分隔符（`whisper.cpp`/`wiki-capture`/`base-q5_1`）｜camelCase（`openConversation`）｜
PascalCase（`AgentDeck`）｜缩写（`VAD`、`ARC`、`STE100`）｜含大写字母。

一律不收：纯中文（没有分词器时最容易误伤）、纯数字、长 hash、表达式（`N=1`）、
图尺寸（`1800×1306`）、`COMMON_ENGLISH`（约 500 词：常见英文词 + 开发通用词 +
缩写形态的通用词 `LLM/API/SVG/PNG/Git`…）。

其它细节：
- **URL 取最后一段路径**（`…/ar9av/obsidian-wiki` → `obsidian-wiki`）
- 排序：你说过的词永远在前（次数 → 新鲜度），模型的补充词排后面；总数上限 12
- **模型的名额 = `min(6, 12 − 你说的话占的名额)`**（288 批调过）：
  你说得少，模型可以补到 6 个；你说了很多，它自然被挤到后面。原来写死 3 个
  ——实测「调查 Memento 3」里模型能补出 `STE100/RHAE/RSI`，正好顶到 3 就没位置了
- **取词**（288 批做、289 批搬家并改名）：不是设置里的"预览"，而是**麦克风按钮下面那行小字**
  「取词 6」——点它在按钮上方弹出这一句识别会带上的专有名词 + 素材条数
  （你说的话 N 条 / 它的回复 M 段），关着/没对话/抽不到时各给一句话。
  ⚠️ 名字不叫"预览"：它不预览"将要发生的事"，它就是"这一句会带上的词"。
  ⚠️ 它走的**和真正录音同一条路**（同一个抽词器 + 同一份手动词表 + 同一套预算），
  所以"看到的"就是"录的时候会用的"。`POST /api/voice/context-terms { conversationId }`
  ⚠️ 浮层是 `position: absolute`（不占栏脚高度）；探针量的"语音那一格"包含按钮与这行小字，
  与输入框同高。
- 进 prompt 时**手动词表先占 180 字预算**，自动词只填剩下的
- 回显：快照带 `contextTerms`；识别完成 toast 说「用了 N 个对话里的词，纠正 M 处」
- 开关：设置里「用对话里的词」（默认开）；抽词失败不影响录音

真数据验收（本机 store 里的两个真实对话）：

```
「调查 Memento 3」(5 轮)  → ASD-STE100 · arXiv · Memento · STE100 · RHAE · RSI
「obsidian-wiki」(2 轮)   → wiki-skills · obsidian-wiki
```

⚠️ 不加"模型来源限定"时的对照（说明为什么要有那三条过滤）：模型那一侧会灌进
`SVG/PNG/Git/Agentic/Workflow/recap/unittest/1800×1306/doc/image/…-flow.svg`——
"写下来的字"不等于"会说出口的名字"。

## 7.7 语言档与模型档：small-q5_1 实测（批 292）

使用者问："当前我语音识别默认是中文，是否合理，我们确实有可能在中文中说一下英语单词，
比如 Agent、LLM 等"。

用 **small-q5_1** + TTS 合成语音实测（5 段 × 3 档）：

| 素材 | `zh` | `auto` | `en` |
|---|---|---|---|
| 这个 Agent 跑在 LLM 上，我们用 AgentDeck 试一下 | `这个 Agent 好在 LLM 上,我们用 AgentDeck 试一下。` | **与 zh 相同** | 整段翻成英文（不能用） |
| 我们今天讨论 Memento 3 的 RSI 机制，它用的是 frozen LLM | `Memento3 的 RSI 机制,它用的是 Frozen、LLM,不是微条。` | **与 zh 相同** | 翻成英文 |
| 用 pnpm 装一下 distilly，然后跑 VAD 测试 | **`用 pnpm 装一下 distilly,然后跑 VAD 测试。`（全对）** | **与 zh 相同** | 翻成英文 |
| 今天我们讨论一下离线语音识别的方案 | `离线与音识别`（与音 = 语音，差一字） | 与 zh 相同 | 翻成英文 |
| **整段英文**：Let us ship the AgentDeck VAD fix today | **`当我们发行的 AgentDeck…评论给你。`（整段翻成中文幻觉）** | **判成英文，输出英文** | 英文（仍不准） |
| 短句「好的，继续」/「试一下这个」 | 正确 | **同样正确**（短句没判错） | — |

**结论**：
1. **默认 `zh` 合理**——你说的"中英混说"这一档，`zh` 与 `auto` 结果**完全一样**，
   英文术语（`Agent`/`LLM`/`AgentDeck`/`distilly`）都被保留。原来设置里那句
   "中英混说容易判错"是不准的，已按实测改写。
2. **`zh` 唯一的坑是整段说英文**：它会把整段**翻译成中文**（上表最后一行）。
   那种情况用 `auto`（或 `en`）。`en` 反过来会把中文翻成英文，所以不能当默认。
3. **模型档的差距比语言档大得多**：`small-q5_1` 上表第 3 行**全对**，而 `base-q5_1`
   同一句是 `用 pm、tm、装衣下 distilly,然后跑达的测试。`——`pnpm`、`VAD` 全毁。
   速度：small ≈ 0.13×（约 8 倍实时）、base ≈ 0.06×（约 17 倍实时）。**default 已改成 small**
   （293 批）：`DEFAULT_ASR_MODEL` 与 `DEFAULT_SETTINGS.model` 都换了，模型目录里
   small 排第一；首次下载因此从 57 MiB 变成 181 MiB（一次性）。
   ⚠️ 已经存过 `settings.json` 的人**不会被悄悄换掉**——那是他自己选过的。
4. **`base` 那一档直接删掉**（294 批）：一个"每个缩写都可能被毁"的档，留着只会让人
   踩一次坑。磁盘上那份 `ggml-base-q5_1.bin` 不再被引用（留着也不影响，删掉省 57 MiB）。

## 8. 踩过的坑（写在这里免得再踩）

**真机验证（2026-11，真模型 + 真 whisper + `say` 合成语音）抓到的两个真缺陷**——它们
在全部单测与探针都绿的条件下存在，正是"夹具跟着错代码一起错"的典型：

0. **ggml 魔数是按小端整数写的**：文件头是 `6c 6d 67 67`（读出来 "lmgg"），不是 ASCII
   的 `ggml`。第一版拿 `Buffer.from('ggml')` 去比 ⇒ **每个真模型都被判成"不是模型"**，
   下载永远失败在最后一步，而报错还说"可能返回了错误页"（指向完全错误的方向）。
   修法：按 `readUInt32LE(0) === 0x67676d6c` 比，并顺带认 `ggmf` 与 `GGUF`。
0b. **`whisper-cpp-node` 返回的分段是对象**（`{start,end,text}`），而它的 README 写的是
   三元组 ⇒ 第一版 `seg[2]` 全是 `undefined`，整段文本变空、界面显示"没听清"，而模型
   其实认得好好的。修法：按对象定义，`joinSegments` 两种形状都认。
0c. 替换规则把词改短/改长之后，**中英文交界会缺空格**（`Whisp 古来` → `Whisper来`）⇒
   替换之后再跑一遍 `normalizeText`（只动排版、不动词）。

验证结果（`base-q5_1`，Apple Silicon，GPU）：模型加载 ~10s（一次性、常驻），**4.96s 音频
转写 0.78s（约 6x 实时）**；`initialPrompt` 确实起了作用（不加 prompt 时 "AgentDeck"
被认成 "AgentStack"），替换规则命中并回显 `corrections`。

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

**`via-skill` 输出方式（批 281）**：识别完替你按回车
- 设置里「识别完」两档：`只放进输入框`（默认）/ `先发一条消息`（交给那个对话里的
  skill，比如 wiki-capture）
- **3 秒倒计时 + 一枚「撤销」**：一次识别错误不该直接进对话（更不该被 skill 记进 wiki）；
  撤销之后**一个字都不丢**（字仍在输入框里，人改完自己发）
- 四条自我保护（`apps/web/src/lib/auto-send.ts`，6 条单测）：只有 `via-skill` 才发、
  输入框原本有字不发（那份字是人写的）、这一轮还在跑不发（硬发会被静默丢）、识别为空不发
- 人一动笔就撤销自动发送（他开始改字 = 这一句还没准备好发出去）

**下载源回退（批 283）**：使用者实测报的 `模型下载失败（连不上 huggingface.co…）：fetch failed`
- 默认按 **huggingface.co → hf-mirror.com** 顺序试；连不上、非 200、缺 Content-Length、
  传输中断、下完发现不是模型——**任何一次失败都换下一个源**（这些都不该把整次下载判死）
- 全都失败时把**每一个源的失败原因**一起报出来，并给出下一步（`--asr-model-base`）
- 结果里带 `source`，界面显示"来自哪个 host"——"这文件哪来的"不该是个谜

**下载进度（批 282）**
- `GET /api/voice/models/progress` 轮询（不用 SSE：一次下载几十秒，轮询不怕丢首帧、
  也不给 daemon 多条长连接）；设置里显示百分比 + 进度条 + `x / y MiB`
- 为什么值得做：一次 57 MiB 在慢网络下能跑几十秒，只有"正在下载…"的话，人分不出
  "在动"和"卡死"（实测慢网 400 秒）

**失败原因改走 toast（批 285）**：使用者："我也不想占高度，或许 Toast 的提示就可以了"
- 原来原因是一句话塞在**动作条里、紧贴麦克风按钮右边**，还截断成 24 字 ⇒ 动作条被挤窄、
  句子变成半截、而且和按钮同高看着像控件。三条都不对。
- 现在：原因一律走 **toast**（`.toast` 是 `position: fixed` 的浮层，**一点栏脚高度都不占**）；
  按钮本身**一个字都不显示**——可用 / 录音中（红点+秒数）/ 不可用（**虚线 + 灰**）。
- "可用不可用"仍然一眼看得出（那是形状，不是文字），点一下就把完整原因浮出来。
- 探针 `chat.voiceButton` 改成等 `.toast` 出现，并顺手量栏脚高度（浮层不许把它撑高）。

**能力状态不再各存一份（批 284）**：使用者报的"small 已经下载好了，录制时还提示『还没有语音
模型 small』，重新刷新后正常"
- 根因是**两处各自缓存**：设置里下载完只刷新了它自己那份，输入条那颗按钮还拿着页面挂载时的
  旧结论
- 修法两条：① 能力收成一份共享 store（`apps/web/src/lib/voice.ts`），设置与按钮都读它；
  ② **点的时候现查一次**（能力会变：刚下完模型、刚删了文件、刚插麦克风）
- 探针 `chat.voiceRechecksOnClick` 钉着②：点一下按钮，`/api/voice/capability` 必须被请求

**还没做**：
- 任务输入条的麦克风按钮（`VoiceButton` 不认识聊天，直接接即可）
- `outputMode: 'via-skill'`：识别后**自动发送一条聊天消息** + 3 秒可撤销（平台不自己调 skill）
- 词典编辑与「一键加词」（从 `raw` 与改后文本的差异生成规则）
- 任务输入框的麦克风按钮（使用者：先做聊天，做好兼容——`VoiceButton` 不认识聊天，直接接就行）
- 模型下载进度（现在是"下完才回"，没有中间进度）
