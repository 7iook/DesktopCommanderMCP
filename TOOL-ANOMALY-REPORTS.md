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
- 状态: open（调用侧已改用单次 `write_file(mode=append)` 恢复内容）