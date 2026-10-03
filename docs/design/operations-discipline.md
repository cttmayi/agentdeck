# 操作纪律（D66 Chrome 事故后固化，2026-10）

> 目的：把散落在各处的"教训"收拢成一页，**每次动这台机器前过一遍**。
> 这些规则不是新规定——每一条都来自仓库里真实发生过的事故，附来源。
> 违反规则造成的损失是使用者的（本机浏览器、数据、时间），不是我的。

## 1. 杀进程：只按本次专属标识匹配，绝不宽匹配

- ✅ 只 kill 自己启动的 headless Chrome：按 `--user-data-dir=$PWD/.cache/...`
  或 `--headless` 匹配；或按启动时记录的 PID。
- ❌ **禁止** `pkill -f "Google Chrome"`——会连使用者本人的浏览器一起杀。
- 事故记录：2026-09-13 首次（`tools/layout-probe/README.md`「四个坑」第 3 条，
  已提交 8bd2fb35/f03ee2f1）；**2026-10 D66 复发**（本会话截图清理时再次
  `pkill -f "Google Chrome"`，规则明明已提交在案——教训：记录要查，不是要记得）。

## 2. headless Chrome 不自己退出

- `--dump-dom` / `--screenshot` 打完会**挂住**：必须"后台跑 → 轮询输出文件 →
  再精确杀"，不能等它自然结束（来源：`tools/layout-probe/README.md`）。

## 3. 探针（probe.html 内联脚本）

- 整个内联脚本是一个作用域：**`const` 不能重名**，否则整段语法错误，症状像
  "Chrome 超时"（`#out` 还是 pending、零 error）。
  加检查后用 `node --check` 过一遍提取出的脚本（来源：README「四个坑」）。
- 探针要**收拾自己的现场**：localStorage 状态（如任务视图列表/看板模式）会带到
  下一轮，切视图前显式还原（来源：README，D39 事故）。

## 4. 改代码前先读判据（探针 + 文档）

- D66 教训：git HEAD 的智能体 runtime 卡是 3 行旧版、工作树是极简 1 行版，
  凭印象抄结构差点把旧版抄回来——**先查 probe 怎么量，再决定结构**。

## 5. 大块结构替换：行首锚定，不用子串

- D66 教训：`s.index('  </section>')` 会命中 8 空格缩进的内层闭合（substring
  命中）——替换 `<section>` 级结构用 `^\s{2}</section>` 行首锚定 + 校验内容。

## 6. 只写仓库内 + 收尾

- 数据、Chrome profile、DOM 全在 `.cache/`；临时 harness HTML（`_*test*.html`）
  用完删；不往用户目录（`~/Library/...`）写任何东西。

## 7. 变更纪律（D 系列一贯）

- 每个改动：typecheck → build（记 js+css 合并 md5）→ test → probe 全绿 →
  红证（变异 → 红 → 恢复 → md5 一致）→ 文档；报告给实测证据（来源：
  `docs/design/architecture.md` §12.4、`docs/srs/requirements.md` §11.6）。

---
*来源索引：`tools/layout-probe/README.md`、`docs/design/design.md`（探针工具节、
§15.42）、`docs/design/architecture.md` §12.4、`docs/srs/requirements.md` §11.6。*
