#!/usr/bin/env python3
"""
AgentDeck PreToolUse hook：把工具的访问限制在工作目录内（任务隔离，2026-10）。

为什么有它：claude 会把 Bash/Read 跑到工作目录之外——实测它会 `ls ..` 去看
兄弟任务的目录、读其他 issue 的产出当参考。工作目录是"分配给你干活的地方"，
不是"你只能看这里"（NG7：不做沙箱隔离）。第一句话里的「任务边界」是引导层，
这里是硬拦截：工具执行前 claude 调本脚本，越界就 deny，工具不执行。

允许根 = hook 输入里的 cwd（工作目录）。claude 2.1.143 的 `-p` 非交互模式
确认会执行工作目录 `.claude/settings.json` 里配置的 PreToolUse hook
（2026-10-17 实测）。

⚠️ 误伤策略：宁可少拦、不可误伤（误伤会让正常任务跑不了）。所以只拦
**明确越界**的信号（结构化路径在工作目录外、Bash 里的 `..` / `~` / 工作目录外
的绝对路径），不试图理解命令语义。deny 之后模型会换一种写法（一般改成相对
路径或拆两步），run 不会因此失败。
"""

import json
import os
import re
import sys


def respond(decision: str, reason: str = "") -> None:
    out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": decision}}
    if reason:
        out["hookSpecificOutput"]["permissionDecisionReason"] = reason
    print(json.dumps(out))
    sys.exit(0)


def main() -> None:
    try:
        inp = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError):
        # 读不到输入就别拦——宁可放行也不能让 claude 因为 hook 崩掉
        respond("allow")

    tool = inp.get("tool_name", "") or ""
    cwd = inp.get("cwd") or os.getcwd()
    root = os.path.realpath(cwd)
    ti = inp.get("tool_input") or {}

    def inside(path: str) -> bool:
        p = os.path.realpath(os.path.join(root, path) if not os.path.isabs(path) else path)
        return p == root or p.startswith(root + os.sep)

    # 结构化路径工具：直接校验目标路径
    structured = {"Read": "file_path", "Edit": "file_path", "Write": "file_path"}
    if tool in structured:
        p = ti.get(structured[tool])
        if p and not inside(p):
            respond("deny", f"越界：{p} 在工作目录之外（任务隔离：只在自己的工作目录里活动）")
        respond("allow")

    if tool == "Glob":
        pat = ti.get("pattern", "") or ""
        if ".." in pat or os.path.isabs(pat):
            respond("deny", f"越界：glob 模式 {pat!r} 指向工作目录之外（任务隔离）")
        respond("allow")

    if tool == "Grep":
        p = ti.get("path")
        if p and not inside(p):
            respond("deny", f"越界：{p} 在工作目录之外（任务隔离）")
        respond("allow")

    if tool == "Bash":
        cmd = ti.get("command", "") or ""
        bad: list[str] = []
        # 父目录：行首或运算符后的 `..` / `../`
        if re.search(r"(^|[\s;|&()])(\.\./|\.\.\s|\.\.$)", cmd):
            bad.append("父目录 `..`")
        # 家目录
        if "${HOME}" in cmd or re.search(r"(^|[\s;|&()])~(/|\s|$)", cmd):
            bad.append("家目录 `~`")
        # 工作目录之外的绝对路径（`curl URL` 的 http 前缀不会命中这个正则）
        for m in re.finditer(r"(?:^|[\s;|&()])(/[^\s;|&()\"']+)", cmd):
            p = m.group(1)
            if not inside(p):
                bad.append(f"绝对路径 {p}")
        if bad:
            respond("deny", "越界：" + "、".join(dict.fromkeys(bad)) + "（任务隔离：只在自己的工作目录里活动）")
        respond("allow")

    # 其他工具（Task 子代理等）不拦
    respond("allow")


if __name__ == "__main__":
    main()
