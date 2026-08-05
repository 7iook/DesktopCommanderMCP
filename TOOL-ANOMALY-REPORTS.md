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


### A-005: mcphub 宿主环境变量泄漏进 desktop-commander 子 shell,污染构建/服务(NODE_ENV / PORT 母题,两次实证)
- **日期**: 2026-07-27
- **现象**: ① `pnpm build`(Next 16.1.6)在 prerender `/_global-error` 时报 `TypeError: Cannot read properties of null (reading 'useContext')`,连纯上游干净代码也失败,极易误判为代码/框架回归;② 早前 `next dev` 抢绑 3799 撞 mcphub 自身端口(EADDRINUSE)。
- **根因**: desktop-commander 的子 shell 继承 mcphub 进程环境,其中带着 `NODE_ENV=development` 与 `PORT=3799`。Next 16 在 non-standard NODE_ENV 下触发已知 prerender bug(vercel/next.js#86146 明确记载该变体);PORT 则被 next dev 直接采用。受控对照:仅 `Remove-Item Env:NODE_ENV` 后同一 build 立即 EXIT=0。
- **处置**: 构建/启动前端命令前显式清理:`Remove-Item Env:NODE_ENV`、`$env:PORT='<期望端口>'`。
- **修复方向**: mcphub 启动 stdio server 时不向子进程透传自身的 NODE_ENV/PORT(或 desktop-commander spawn shell 时白名单化环境);至少在 README 声明该行为。


### A-006: edit_block_multiple 同文件两种路径写法被拆成两组,破坏「按文件原子」且报告自相矛盾
- **日期 / 报告者**: 2026-07-27 / JXai
- **工具**: edit_block_multiple（本分支新增，上游 main 无此工具）
- **环境**: Windows 11 + mcphub desktop-commander MCP
- **现象**: 一次调用内同一文件混用 `dir\a.txt` 与 `dir/a.txt`，报告同时出现 `✅ ...a.txt (1 edit applied)` 与 `❌ ...a.txt — file left UNCHANGED (per-file atomic — NOTHING saved)`，`totalFiles=2`；磁盘实际为第一组已落盘的中间态。AI 读到这份报告无法得出正确结论，且工具承诺的「按文件原子」实际失效。
- **复现**: `editBlockMultiple([{path: 'X\\a.txt', ...ok}, {path: 'X/a.txt', ...ok}, {path: 'X/a.txt', ...miss}])`；观察 `structuredContent.totalFiles` 与磁盘内容。
- **根因**: `editBlockMultiple` 的分组 key 用**原始 `args.file_path` 字符串**，两种拼写落入不同 bucket → 各自独立 read-modify-write，per-file 原子性与 per-path 锁的「同一文件」视图脱节。**这是 A-003 的同源指纹**：`write_multiple_files` 早已改用归一化 `groupKeyForPath()` 修掉同一问题，修复未传播到 edit 路径（E-060 改 A 漏传播母题）。触发场景很现实：路径来自不同来源（搜索结果给正斜杠、`list_directory` 给反斜杠）或盘符大小写不一致。
- **自动检测覆盖?** 无；调用返回 `isError` 为 false（有组成功即不算错），`get_recent_anomalies` 无对应规则。
- **修复**: 归一化收口为 SSOT —— `file-mutex.ts` 导出 `normalizePathKey()`（原私有 `normalizeKey`），`groupKeyForPath()` 改为委托它并导出，`editBlockMultiple` 与 `handleWriteMultipleFiles` 共用同一 key 函数，杜绝二次分叉。每组用组内首条 edit 的原始拼写驱动 `runFile`（归一化 key 在 win32 被小写，不能回显也不能喂 `validatePath`）。
- **回归测试**: `test/test-edit-block-multiple.js` Test 8（修复前红 4 条：`totalFiles=2`、中间态落盘、报告出现 `✅`、`editsApplied` 计数错）。相邻回归 `test-write-multiple-same-path.js` / `test-edit-block-line-endings.js` / `test-edit-block-occurrences.js` / `test-markdown-editor-edit-diff.js` 全绿。
- **状态**: fixed（2026-07-27）


### A-007: PowerShell 错误流被 CLIXML 过滤器整块删除 —— 失败命令返回「零输出」
- **日期 / 报告者**: 2026-08-04 / JXai
- **工具**: start_process / read_process_output(Windows + `powershell.exe`)
- **环境**: Windows 11 + pwsh/powershell 5.1 + node22 + mcphub desktop-commander MCP
- **现象**: 命令失败但捕获输出**完全为空**:`read_process_output` 返回 `[Reading 0 new lines (total: 0 lines)]` + `(No output in requested range)`。AI 无法得知失败原因,典型反应是把命令改成 `2>&1 | Tee-Object <file>` 再 `Get-Content` 绕回来 —— 绕的这一大圈本质是在人工修补工具层删掉的东西。
- **复现**(任一即可,均 0 行输出):`this-command-does-not-exist-xyz` / `Get-Item 'E:\no\such\file.txt'` / `Write-Error 'x'` / `throw 'x'` / 原生 stderr 经 `2>&1 | Out-String` 转进 PS 错误流。
- **不受影响**(对照,证明作用域):原生 stderr **未**重定向(`git checkout no-such-branch` 活着)、stdout 全程正常、pwsh 7 完全不受影响(实测其 stderr 为 271 字节纯文本,根本不发 CLIXML)。
- **根因**: `stripPsCliXml` / `filterCliXmlStreamImpl` 用 `/<Objs [\s\S]*?<\/Objs>/g → ''` 删**整个信封**。但字节级取证显示 PS 5.1 把两类东西装进**同一个** `<Objs>`:`<Obj S="progress">`(模块加载噪音,该删)与 `<S S="Error">`(真正的报错文本,被连坐删除)。即「删噪音」的实现顺手删掉了唯一的诊断信息。取证:绕过过滤器直抓 spawn stderr = 1371 字节且 `hasErrorRec=true`,经过滤器后缓冲区 0 行。
- **自动检测覆盖?** 无。调用 `isError=false`,`get_recent_anomalies` 无对应规则 —— 这正是它最危险的地方:三个信号(空输出 + 退出码 + 无错误标记)一致地指向「成功」。
- **上游对应**: issue **#395**(2026-03-25,open)现象逐字吻合(`0 lines` + `exit code 1`),报告者称「200 次调用 11 次失败里 6 次是这个形态,是 DC 最常见的失败模式」,但把原因归给「进程 <100ms 退出的竞态」。**该归因很可能是错的**:缓冲区在 data 回调里同步写入、退出时整体复制进 completedSessions,不需要竞态就能解释 0 行;真凶是上面的删除逻辑。
- **修复**: 新增 `src/utils/clixml.ts`,`extractClixmlRecords()` 只保留 `<S S="Error|Warning|Information|Verbose|Debug">` 的记录文本(还原 `_xNNNN_` 转义与 XML 实体),仅丢 `<Obj S="progress">`;两处调用点(`stripPsCliXml` 与流式 `filterCliXmlStreamImpl`)**同时**改为委托它,跨 chunk carry 机制不变。
- **回归测试**: `test/test-clixml-error-recovery.js`(24 断言)、`test/test-ps-error-visibility-e2e.js`(端到端 12 例)。**红检**在 `test-ps-cjk-and-redcheck.js` 里固化:同一真实信封喂旧正则得空串、喂新实现得回原文,防止测试空转。修复后四类失败命令捕获字符数 458/415/577/353(修复前均为 0)。
- **状态**: fixed(2026-08-04,本地分支;上游 #395 仍 open,可据此提 PR 并纠正其根因判断)


### A-008: `$LASTEXITCODE` 粘性导致失败命令上报 exit 0(与 A-007 叠加 = 空输出 + 退出码 0 + 实际失败)
- **日期 / 报告者**: 2026-08-04 / JXai
- **工具**: start_process(Windows + PowerShell)
- **环境**: Windows 11 + powershell 5.1 + node22
- **现象**: `node -e "process.exit(0)"; Get-Item 'E:\no\such\file.txt'` 上报 **exit code 0**,而后半句明确失败。与 A-007 叠加后 AI 收到的三个信号全部指向成功 —— 这是「AI 明明失败却继续往下走」最直接的成因。
- **复现**: 任何「原生命令成功 → 后续 cmdlet 失败」的组合。判定证据:`AFTER-NATIVE: LASTEXITCODE=[0]`(原生命令留下 0),`TAIL: LASTEXITCODE=[] ok=[False]`(cmdlet 失败只翻 `$?`,**不写** LASTEXITCODE)。
- **根因**: `POWERSHELL_EXIT_CODE_SUFFIX`(commit 3673c33 引入)判定顺序为「先 `$LASTEXITCODE` 后 `$?`」。但 `$LASTEXITCODE` 是**粘性**的:只有原生可执行文件写它,且事后无人清空;cmdlet 失败只翻 `$?`。于是失败的 cmdlet 读到前一条原生命令留下的陈旧 0 → 上报成功。注意 3673c33 本身修的是「原生退出码被压成 1」的真问题,不能回退,只能修正**顺序**。
- **自动检测覆盖?** 无。
- **修复**: 顺序反转为 `$?` 优先 —— `if (-not $__dcOk) { exit ($LASTEXITCODE ? $LASTEXITCODE : 1) } elseif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } else { exit 0 }`。`$?` 始终反映**最后一条语句**,故对失败具有权威性;`$LASTEXITCODE` 仅用于提供具体码值(7/127/2),保住 3673c33 的收益。
- **回归测试**: `test/test-ps-error-visibility-e2e.js` 8 例退出码矩阵(含本条 sticky 用例),既有 `test/test-exit-code-propagation.js` 5 例全绿(未回退 3673c33)。
- **状态**: fixed(2026-08-04)


### A-009: PS CLIXML / cmd 报错为 OEM 码页字节,按 UTF-8 解码成乱码
- **日期 / 报告者**: 2026-08-04 / JXai
- **工具**: start_process(Windows + powershell / cmd)
- **环境**: Windows 11(OEMCP=936)+ node22
- **现象**: 中文报错显示为 `����ڲ����ⲿ����`。本会话内实证两处:cmd `'xxx' 不是内部或外部命令`;PS CLIXML 信封内的中文错误文本。
- **根因**: `data.toString()` 隐式按 UTF-8 解码,但两者都发 OEM 码页(936/950/932)字节。PS 的 UTF-8 前缀管不到 CLIXML —— PS 在任何用户命令执行**之前**就初始化了 CLIXML writer;cmd 的注释早已说明其按 OEM 解析命令行、注入 `chcp` 只会更糟,但此前只是「放弃」,未在**读取侧**按码页解码。
- **修复**: `ShellByteDecoder` 按字节嗅探 —— 严格 UTF-8 校验通过则按 UTF-8,否则按 OEM 码页(从注册表 `Nls\CodePage\OEMCP` 读取并缓存,**不用 `chcp`**:chcp 报的是本进程控制台的码页,宿主已设 65001 时会误判)。方向可靠因 UTF-8 自校验:GBK/Big5/SJIS 几乎不可能构成合法 UTF-8,而真 UTF-8 必然合法。
- **陷阱(实施中实测踩到)**: 必须**先定编码再量尾巴**。`CE DE`(GBK「无」)里 0xDE 是完成字符的尾字节,在 UTF-8 里却是等待续字节的首字节;先量后猜会把完整 GBK 文本判成截断并从中间切开(该 bug 被 `split GBK reassembles` 断言抓到,当时得 3 字符而非 2)。修正后按「整体是合法 UTF-8?→ 去掉短尾后是否合法且尾部为合法 UTF-8 前缀?→ 否则按 DBCS 从头走 lead/trail 配对」三级判定。
- **回归测试**: `test-clixml-error-recovery.js` 的解码组(GBK→中文、真 UTF-8 不被破坏、逐字节切分重组、DBCS 切分重组、`incompleteTailLength` 边界);`test-ps-cjk-and-redcheck.js` 端到端验证中文报错可读、中文 stdout 无回归、40 行跨 chunk CJK 无 U+FFFD。
- **状态**: fixed(2026-08-04)。**遗留**:cmd.exe 的 CJK 仍受「命令行按 OEM 解析」限制(源码注释所述),本次只修读取侧解码;需要可靠 CJK 仍建议用 pwsh。
