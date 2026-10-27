# 一次性任务接口示例（`POST /api/task`）

给一句提示词，跑一次 agent，把结果拿回来。**只在本机回环上可用**（`127.0.0.1`），
所以脚本、定时任务、别的程序里的一步都能直接调它。

```
task-api/
  README.md     ← 你正在读的这份
  task.mjs      ← 推荐：node 内置 fetch，零依赖（会自动轮询 202）
  quick.sh      ← curl 版四个场景，照着抄即可（同步 / 异步 / 带组 / 会被拒的写法）
```

## 先做一次：确认 daemon 是新版

这个接口是 2026-10 新加的。**旧 daemon 上它会回 `未知路径 /api/task`**，
所以先把 daemon 重启一次（`Ctrl+C` 之后重新 `pnpm run daemon`），然后：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4517/api/task \
  -H 'content-type: application/json' -d '{}'
#   400  ← 新版（提示 prompt 必填）
#   404  ← 旧版，还在跑老代码
```

## 最快的三条

```bash
# ① 同步：等它跑完，一次拿到结果
curl -sS -X POST http://127.0.0.1:4517/api/task \
  -H 'content-type: application/json' \
  -d '{"prompt":"写一个 hello.txt，内容是 hi，然后回复 DONE","wait":60}'

# ② 异步：立刻返回 runId（wait=0），再用 GET 收口
curl -sS -X POST http://127.0.0.1:4517/api/task \
  -H 'content-type: application/json' -d '{"prompt":"回复 READY","wait":0}'
curl -sS http://127.0.0.1:4517/api/task/<上面那个 runId>

# ③ 让它直接在你的仓库里干活
curl -sS -X POST http://127.0.0.1:4517/api/task \
  -H 'content-type: application/json' \
  -d '{"prompt":"把 README 的错别字列出来，写进 typos.md","workDir":"/Users/you/repo","wait":120}'
```

## 用脚本（推荐，省掉拼 JSON 和轮询）

```bash
node examples/task-api/task.mjs --prompt "写一个 hello.txt 内容是 hi，然后回复 DONE"
node examples/task-api/task.mjs --prompt "..." --workdir /Users/you/repo --wait 120
node examples/task-api/task.mjs --prompt "..." --group 01M…      # 走智能体组（会审）
node examples/task-api/task.mjs --prompt "..." --key job-2024-1  # 幂等键：重跑不二次执行
node examples/task-api/task.mjs --prompt "..." --out result.md   # 只把结论写进文件
node examples/task-api/task.mjs --prompt "..." --json            # 原始返回体，喂给 jq

node examples/task-api/task.mjs --help    # 全部参数
```

退出码：**0** 跑完 / **1** 跑失败 / **2** 用法错 / **3** 请求没跑起来（连不上、字段被拒）。

`quick.sh` 是 curl 版（每一节都会真的跑一次 agent）：

```bash
bash examples/task-api/quick.sh           # 四节都跑
bash examples/task-api/quick.sh sync      # 只跑同步那条
bash examples/task-api/quick.sh async|group|errors
AGENTDECK_URL=http://127.0.0.1:4599 bash examples/task-api/quick.sh   # 换地址
```

> `quick.sh` 里用 `python3` 解析 JSON（格式化输出、取 `runId`）。没有也能跑，
> 只是输出不美化、异步那一节取不到 runId。`task.mjs` 不需要它。

## 请求只认这六个字段

`prompt`（必填）、`workDir`、`agent`、`groupId`、`maxTurns`、`wait`。

**多一个就 400**，包括 `systemPrompt`、`env`、`skills`、`customArgs`、`reviewerAgentId`——
身份、环境变量、技能、CLI 参数都由平台决定：这个接口让你说**干什么**，
不说**用谁、怎么跑**。拼错字段（`workdir`）也会 400，这是白名单的直接好处。

## 返回体里有什么

```jsonc
{
  "runId":     "task-5406de…",     // 幂等键派生 or 普通 ULID
  "status":    "completed",        // completed / failed / cancelled / running…
  "output":    "DONE",             // 最后一段话（与任务详情页同一口径）
  "transcript": "…",               // 本次全部 assistant 文本按顺序拼接
  "issueId":   "01M5Z8…",          // 自动建的那条任务（界面「任务」页里标题以 [API] 开头）
  "workDir":   "/…/issue-01M5Z8…", // 自动分配的工作目录（除非你给了 workDir）
  "sessionId": "914c2261-…",        // 想在下一轮"接着上次说"可以用它
  "usage":     { "inputTokens": 43128, "outputTokens": 218, "costUsdMicros": 95157, "costSource": "provider" },
  "files":     [ { "relPath": "answer.txt", "bytes": 3 } ],  // 工作目录顶层的产物清单
  "review":    null,               // 没传 groupId ⇒ 不审；传了 ⇒ 判决
  "failureReason": null,
  "events":    "/api/runs/task-…/events"   // SSE，想实时看就用它
}
```

- **产物内容不在返回体里**（只给清单）：`GET /api/runs/{runId}/file?path=answer.txt`。
- **`review` 可能一开始是 `null`**：传了 `groupId` 时审核是执行完成**之后**才派生的，
  那一刻还没判决——再 `GET /api/task/{runId}` 一次就有了。
- **`wait` 是"最多等多久"**：到点没跑完就 `202` + `runId`，用 `GET` 收口（`task.mjs` 自动做了）。

## 常见状态码

| 状态 | `code` | 意思 / 怎么办 |
|---|---|---|
| 400 | `task_field_not_allowed` | 传了不认识的字段（`fields` 会点名）——删掉它 |
| 400 | `task_prompt_missing` | `prompt` 空或只有空白 |
| 400 | `task_workdir_not_absolute` | `workDir` 只收绝对路径；不想指定就别传 |
| 400 | `task_no_executor` | 工作区里没有 `role: executor` 的 agent——先去「智能体」页建一个 |
| 404 | `task_agent_not_found` / `task_group_not_found` | id 不对，或那条被删了 |
| 409 | `task_key_conflict` | 同一个幂等键配了不同内容——换个键，或让键随内容变化 |
| 429 | —（带 `retry-after` 头） | 并发满了，等几秒重试 |
| 200 | `status: "failed"` | 请求是合法的，但**活没干成**——看 `failureReason` |

## 两条要知道的边界

1. **它只从回环可达**：daemon 只 `listen 127.0.0.1`。**绝不要**把这个端口经隧道 /
   内网穿透暴露出去——那样它等于把"在你机器上执行命令"开放给那个隧道。
2. **不传 `groupId` 就不审**：返回 `review: null` 是刻意的（省一半钱与时间）。
   要"执行 → 审核 → 按组动作权限"这条闭环，就传一个 `groupId`。
