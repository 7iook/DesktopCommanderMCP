# Desktop Commander — 工具异常补充报告 (Tool Anomaly Reports)

> **固定报告位置**。任何仓库的执行 AI 在使用 desktop-commander MCP 工具时,
> 若观察到工具层异常 / 反模式 / 误报 / 行为不一致,**一律追加到本文件末尾的
> 「补充项」区**(append-only,绝不改写他人条目)。维护者据此决定是否要在
> `src/utils/anomaly-detector.ts` 加规则、或修工具本身。
>
> 这是对自动信号的**人工补充**,二者职责不重叠:
> - `get_recent_anomalies` MCP 工具 = **自动**聚合 `~/.claude-server-commander/tool-history.jsonl`
>   里已知反模式的发生次数(cmd timeout 陷阱、嵌套 powershell 吞 `$var`、
>   ERR_CWD_NOT_FOUND、edit_block 过期快照、write_file 覆盖拦截、read_file
>   压缩大文件、命令被拦、interact 送输入失败……)。会话开始时调用一次即可。
> - **本文件** = AI **手写**的补充,记录自动规则**还没覆盖**的新异常,或对已知
>   异常的实测补充说明。

---

## 写入规范 (append-only)

1. **只追加**到「补充项」区末尾;不改、不删他人条目。
2. 一次会话最多沉淀几条真正有价值的;琐碎一次性问题不必堆。
3. 每条用下面的模板,字段尽量填全(留 machine-grep 锚点:工具名 + 现象)。
4. 写之前**先调 `get_recent_anomalies(since_minutes=1440)`** 看自动信号,
   避免和已有规则重复;若只是已知规则的又一次命中,通常不必手写。

### 条目模板

```md
### A-NNN: <一句话现象>
- 日期 / 报告者: 2026-06-21 / <repo 或 agent 名>
- 工具: <tool 名,如 read_process_output / interact_with_process_lines>
- 环境: <OS + shell + node 版本,如 Win11 + pwsh7 + node22>
- 现象: <observable 行为>
- 复现: <最小复现步骤,有就写>
- 推测根因: <可选>
- 自动检测覆盖? <get_recent_anomalies 是否已命中对应规则 / 无>
- 状态: open | fixed(commit) | wontfix(原因)
```

---

## 补充项 (Entries)

<!-- 新条目追加到本行下方,最新在最下面。编号 A-NNN 递增。 -->

### A-001: interact_with_process_lines 默认正则漏掉无标点 / 中文括号 prompt
- 日期 / 报告者: 2026-06-21 / oebb (reverse-refs)
- 工具: interact_with_process_lines
- 环境: Win11 + pwsh7/cmd + node22
- 现象: 菜单 prompt 如 `Press Enter to continue`(无标点结尾)、`请选择 (0退出 / 1 / 2)>`(中文括号)默认 wait_for 不命中,fail_fast 卡 timeout。
- 复现: 对以无标点结尾 prompt 的交互程序跑 lines,默认 wait_for。
- 推测根因: 纯正则检测,未考虑「输出停顿」信号。
- 自动检测覆盖? get_recent_anomalies 命中 tool_isError(timeout 兜底),非专门规则。
- 状态: open(`]` 已纳入默认正则 commit 071f6d7;无标点 prompt 的停顿 fallback 待做)

### A-002: ps_nested_var_swallowed hint 在「确实嵌套」时也提示,部分为预期
- 日期 / 报告者: 2026-06-21 / oebb
- 工具: start_process
- 环境: Win11 + pwsh7
- 现象: 本会话触发 ~7-10 次;实测均为 wrapper 内 `$var` 真被外层吞(非误报),hint 属实有用。纯 `Get-Process | %{...}`(不带外层 -Command wrapper)经核查不会触发。
- 自动检测覆盖? 是(ps_nested_var_swallowed,本轮 10 hits)。
- 状态: wontfix(行为符合预期;hint 仅在 `powershell -Command "..."` + `$var` 同时出现时触发)


### A-003: write_multiple_files 同路径 rewrite+append 报全成功但 append 静默丢失
- 日期 / 报告者: 2026-07-14 / JXai rca-gate
- 工具: write_multiple_files
- 环境: Windows 11 + mcphub desktop-commander MCP
- 现象: 同一 `files` 数组含同路径 1 个 rewrite + 7 个 append，返回 `8 succeeded, 0 failed`；随后的 `inspect_file/read_file` 显示磁盘仅首块 17 行，7 个 append 全部未落盘。
- 复现: 对新 Markdown 文件调用 `write_multiple_files`，同路径条目按 rewrite→append×7 排列；成功响应后立刻检查行数。
- 推测根因: 文档声称同路径条目按 per-path mutex 串行，但实际批处理可能仍并发或最终写覆盖，且结果汇总未校验最终内容。
- 自动检测覆盖? 无；`get_recent_anomalies` 未命中对应规则，工具调用也未返回 isError。
- 状态: **fixed**（2026-07-27）。根因不是 mutex 失效——`withFileLock` 本身保序（同步建链）。真凶是 `writeFile()` 在**取锁之前** `await validatePath()`：批处理用 `Promise.all` 并发派发后，各条目经过一次异步跳变才到达锁，入队顺序不再等于数组顺序，`rewrite` 落到 append 之后 → 截断已追加内容，而每条仍各自返回 ok。受控实验证据（唯一变量=锁前有无 await）：同步入队 `0,1,2,3,4`；锁前加 await `4,3,2,1,0`。
  修复：`handleWriteMultipleFiles` 按归一化路径分组，同路径**串行 await**、不同路径仍并发，报告按调用方原始顺序还原。分组 key 与 file-mutex 的归一化一致（Win32 lowercase），避免 `C:/foo` 与 `c:\foo` 分到两组重新竞速。
  回归测试: `test/test-write-multiple-same-path.js`（修复前红：报 8 成功、磁盘仅 `block-0`）。
  注: 该工具为本分支新增，上游 main 无此工具，故社区无对应 issue。

### A-004: read_file/write_file 泄漏 RWD 文件句柄,致文件 delete-pending 无法删除
- **日期**: 2026-07-27
- **现象**: `rmdir /s /q` 删除 `docs/specs/delegation-continue-session/` 时 3 个 `.md` 报「拒绝访问」;`attrib`/`Remove-Item`/`icacls` 全部 ACCESS_DENIED;`git merge` 因 `cannot stat ... Permission denied` 被挡。
- **根因**: `handle64.exe` 定位到句柄持有者 = desktop-commander 本体 (node.exe, `E:\MCP\DesktopCommanderMCP\dist\index.js`),对前一日 read_file/write_file 操作过的多个 md 文件持有 **RWD 句柄未释放**(含 review.codex.md ×1、review3.codex.md ×2、review2.codex.md ×1、.agent-workspace 下 recon.md ×1)。首次 rmdir 已发出删除 → 文件进入 Windows delete-pending:目录条目残留、一切访问 ACCESS_DENIED,直到句柄关闭。
- **处置**: `handle64 -p <pid> -c <hex> -y` 逐个关闭泄漏句柄(勿杀进程——是 MCP 本体),文件随即消失。
- **修复方向**: 排查 dist 中 read/write 路径上未 close 的 fd(疑似 fs.open 后异常路径早退未 finally close);同一文件出现双句柄 (review3 ×2) 提示重复 open。
- **根因（已确认，2026-07-27）**: 不在 `fs.open`，而在 `src/utils/files/text.ts` 的 readline 读路径。`rl.close()` 只拆 readline 接口，**不关闭 input stream**；stream 读到 EOF 会自关（所以小文件/整读从不泄漏，与 #476「小文件不复现」一致），但每个提前 `break` 都让 fd 悬到 GC。三处提前退出：`readFromStartWithReadline`（行数达上限——默认 1000 行截断，最高频路径）、`readFromEstimatedPosition`（采样满 SAMPLE_SIZE、rl2 取够 length）。「同一文件双句柄」= 该文件被读了两次，每次各漏一个。
- **上游对应**: issue **#476**（2026-05-18）Windows 大文件前缀读后原子 rename 报 `WinError 5`，其推测的可疑实现区域与实测根因逐字吻合；issue **#502**（2026-06-10，维护者本人开）`Source.cpp.tmp*` 被 Sysinternals handle 确认由 DC 本体锁住。**两条至今 open，58 个 open PR 中无任何句柄/stream 相关提交** —— 社区未修。
- **修复**: 新增 `withLineReader()` helper 统一收口，`finally { rl.close(); stream.destroy(); }`，四处 readline 调用点（含本身无 break 的 `readFromEndWithReadline`）全部迁移，`signal` 透传保留。收口后该文件内 `createReadStream`/`createInterface` 仅剩 helper 内部一处，杜绝第二种写法复发。
- **回归测试**: `test/test-read-file-handle-release.js`。修复前红，且失败签名 `EPERM: rename ....tmp -> ...` 与 #476 报告的 `PermissionError: [WinError 5]` 完全同一形态；修复后 3/3 绿。
- **状态**: fixed（本地分支；上游 #476 / #502 仍 open，可据此提 PR）
