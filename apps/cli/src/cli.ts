#!/usr/bin/env node
// 入口只做转发。真正的逻辑放在 main.ts，这样测试可以直接 import 它
// 而不必启动一个子进程——`main()` 返回退出码而不是直接 `process.exit()`，
// 正是为了让"退出码语义"能被测试钉住。
import './main.ts'
