# 真机踩坑：后台 job 与探测器（2026-11-04 深夜批次）

> 来源：2026-11-04 21:37 起两次重启后的真机排查，对应 CHANGELOG 的 C570 / C576 / C578 / C582 / C593 一批。
> 六条都在讲同一件事：**出问题时磁盘上看不出来** —— 所以先做观测，再猜原因。
> 标记：**已核实** = 真机现场 + 代码/测试双向印证（本文六条均属此类，路径都是仓库内实际文件与 `DSH_HOME` 下的落盘物）；**待核实** = 只有外部说法、本机未验证（本文无此类）。

**边界**：这六条都是**观测与判据**的教训，不改变折叠算法本身 —— 修完不会让补账变快，只会让「为什么不动」可回答。「已核实」的判据是：每条都能指到一个仓库内的 `文件:行号`，且都有反向用例（该红时会绿）。仍未覆盖的两块：**并发折叠**（两个引擎实例争同一张图）只有推理、没有实验；**分段折叠**（`chunkedFolded > 1`）只有沙盒证据，真机 100% 是单段。

## 1. 「零产出」与「从没跑过」在磁盘上长得一模一样

**一句话结论**：后台任务不写结局时，「没干活」和「没启动」是同一份磁盘状态 —— 所以先让每轮把结局落盘，再谈排查。

- **现象**：2026-11-04 21:37 / 21:57 两次重启后，补账连续零产出；日志在宿主控制台里看不到，`chunks.length === 0` 时引擎直接 return，图上一个字段都不写。
- **根因**：磁盘上没有任何「这一轮跑过」的痕迹。于是「零产出」和「从没跑过」写出来的东西完全相同，只能靠猜 —— 而这正是那次排查连错两轮的原因。
- **以后怎么一眼认出来**：跑 `node scripts/backfill-state.mjs`（加 `--json` 原样输出），三种形态各对应一个结论：
  - 文件不存在 ⇒ 本版没重启（引擎不写这个文件），或自动补账被关掉；
  - `{armed:true, picked:undefined}` ⇒ 定时器起了但首轮未到；超过「首轮延迟 + 一轮间隔」仍是这条 ⇒ 定时器没跑起来；
  - 有 `results` 而 `folded` 全为 0 ⇒ 跑了但一段都没折，这时看每条的 `stopped` 与 `error`。
- **配套落盘**：引擎启动先写 `{at, armed:true, everyMs, firstDelayMs, pid}`，每轮再写 `{due, max, picked, results, doneMs}`；抛错写 `{error}`。

- 出处：`src/engine.mjs:2047-2054`、`src/engine.mjs:2183`、`scripts/backfill-state.mjs:21-26`、`CHANGELOG.md:1006-1026`（C593）

## 2. 两个判据同时成立：`due: true` 与 `already-folded`

**一句话结论**：`debtOfGraph().due === true` 与 `shouldTryOfflineFold()` 返回 `already-folded` 同时成立时，每轮名额会被「已折过」占满，一个都不真折，而且全程不报错。

- **现象**：21:37 重启后连续 12 分钟零折叠；前五名会话每一条都是 `due true · go false · already-folded`（缺口 10158 / 4591、尾巴 3432…）。
- **根因**：两套判据各说各的 —— 账本说还欠（`due: true`），补折入口却因为 `closeout.folded > 0` 且有 mark 就返回 `already-folded`（不补）。5 个名额全被「已折过」占掉，日志里一条都没有。
- **以后怎么一眼认出来**：把两个判据**并排打**：`due === true` 且 `go === false && why === "already-folded"` ⇒ 就是这条，与「真的没欠账」无关。
- **改法**：给 `shouldTryOfflineFold` 传 `stillDue: debtOfGraph(live).due === true` —— 还有欠账就必须允许再折；`folded > 0` 不再等于「没活了」（C555 已经证明过它可能是「假冒成功」）。

- 出处：`src/rooms/offline-fold.mjs:690-696`、`CHANGELOG.md:1037-1062`（C576）、回归 `test/offline-fold.test.mjs:472`（C592）

## 3. 三个各自合理的改动叠成「每次都撞截止」

**一句话结论**：估算变大（中文 0.6 token/字）× 输出预算翻倍 × 固定 240 秒截止，三者叠加 ⇒ 每段都跑不完 ⇒ `stopped: "deadline"` ⇒ 零折叠。

- **现象**：补账每轮 `stopped: "deadline"`、`chunks.length === 0`，表现为「补账完全不动」；任何一张图上都看不出原因。
- **三个数字**（都能在仓库里 grep 到）：
  - 中文 0.6 token/字、英文 0.3 token/字（`estimateTokens` 的实现口径）；
  - 真机 8,192 预算 ≈ **169 秒/段**；按语言估算放到 16,384 ⇒ 生成时间约翻倍 ≈ 340 秒；
  - 补账截止时间曾固定 **240 秒**（现在取 `max(240_000, 预算 × 25ms)` 的低值分支）。
- **根因**：三个改动单独看都合理 —— 估算更准、预算更足、截止更稳；但换成更慢的模型把余量吃光，于是每段都撞截止，且已折好的段一起作废。
- **以后怎么一眼认出来**：把「实测段耗时」和「deadline 配置」并排看 —— 段耗时 > 截止时间就是这条。这类 bug 测试跑不出来（测试里没有真模型）。
- **改法**：单段输出预算封顶 8,192（`offlineMaxTokens` 可调）；截止按预算给足，不再写死。

- 出处：`src/rooms/offline-fold.mjs:570-573`、`src/engine.mjs:2551-2553`、`CHANGELOG.md:942-982`（C578）

## 4. 后台定时器里拿不到宿主服务：`cannot get required service "llm" in inactive context`

**一句话结论**：后台定时器里宿主的服务容器是 inactive 的，`ctx.llm` 每次访问都抛；正确解法是在**活跃回合**捕获句柄，**不是**直连网关端口（那条有红线守卫）。

- **现象**：doctor 报「5 个结局全是 error（没有一个 done）」，首个错误 `Error: cannot get required service "llm" in inactive context` —— 而状态文件里 `due` / `doneMs` 看起来都正常。
- **根因**：回合之间服务容器失活，补账在定时器里做模型调用必然失败；失败只进控制台，图上零字段，于是「空转」与「健康」在磁盘上长得一样。
- **错误解法（已撤销）**：回退到本地网关 HTTP 直连 —— 直接撞 C500 红线：守卫 `test/engine-harness.test.mjs:2843` 断言引擎源码里不许出现 `3425/v1`，模型调用必须走 `ctx.llm.stream`。
- **正确解法**：定时器只置 `this._backfillPending = true`；`compactIfNeeded`（活跃回合）里把 `ctx.llm` 抓成 `_llmHandle`；补账用这份捕获的引用。拿不到句柄就诚实返回 `stopped: "inactive-context"`，并登记进停止原因闭集。
- **以后怎么一眼认出来**：状态文件里 `stopped: "inactive-context"` ⇒ 在等活跃回合（无人用机时正常），不是「停了」。

- 出处：`src/engine.mjs:2029-2033`、`src/engine.mjs:2491-2495`、`src/engine.mjs:2714`、`test/engine-harness.test.mjs:2843`、`CHANGELOG.md:747-773`（C582）

## 5. 探测器自己恒真/恒假：判据永远为真或永远为假

**一句话结论**：一个永远为真或永远为假的探测器比没有更糟 —— 它会让人对真实信号也失去信任，所以每条判据都要配一条「会在什么时候红」的反向用例。

- **现象**：状态页报「⚠ 新字段一个都没写 ⇒ 跑的还是旧代码」，而真机明明是新代码在跑（19:57 已写出 11,257 / 2,647 字符的摘要）。
- **三种写法**（都在本仓库踩过）：
  1. **`Number(null) === 0` 且 `Number.isFinite(0) === true`** ⇒ 没采集的字段被印成 `0`（`0 ms` / `0 token`），假数据比空更坏；
  2. **`every()` 在空数组上恒真** ⇒ 一条都没检查也算「全绿」（空集只该报「未采集」，不该报通过）；
  3. **要求一个从没被写过的字段** ⇒ 条件恒假：判据写 `mark.truncated !== undefined`，而离线折叠写 mark 时根本没写 `truncated` ⇒ 无论代码多新都报「旧代码」。
- **以后怎么一眼认出来**：问两句 —— ① 这条判据为真时，磁盘上一定有什么东西？② 它有没有反向用例（该红的时候会不会绿）？两个都答不上来，就是恒真/恒假。
- **改法**：先判空再 `Number()`；空集单独报「未采集」；判据只认**当前路径真的会写**的字段（补写 `truncated`，判据放宽为「任一在就算新代码」）。

- 出处：`scripts/fold-timeline.mjs:105`、`scripts/fold-timeline.mjs:134`、`scripts/status.mjs:240`、`scripts/post-restart-check.mjs:160`、`scripts/doctor.mjs:83`、`CHANGELOG.md:1289-1322`（C570）

## 6. 心跳/构建戳由已经退出的进程写

**一句话结论**：`build.json` / `ui-route.json` 记的是「最后一次写入的进程」，那个 pid 可能早已退出 ⇒ 拿它判断「运行版本 / 面板状态」会得到**反向**结论。

- **现象**：`build.json` 写 `pid 37616 / startedAt 12:30:05Z`，而 `Get-Process` 查无此 pid；`ui-route.json` 写 pid 22508 / 端口 64535，而该 pid 已退出、实际活的是 pid 4532。
- **根因**：两个文件都是「最后写入者」的残留，没有存活校验。读的人会把「旧进程写的戳」当成「当前实例的状态」，于是「新代码没生效」「面板不可用」这类结论全是反的 —— 而且它会被当成其他红项的成因，整轮带偏。
- **以后怎么一眼认出来**：读之前先探活（`process.kill(pid, 0)`，只探测不发信号，不会误杀）；pid 不在了 ⇒ `state: "stale"`、`usable: false`，**明说不可知**，不许据此断言。
- **改法**：`readBuildStamp` / `readUiRouteHeartbeat` 统一返回 `fresh | stale | missing | invalid | unverifiable` 五态；`stale` 只报「运行版本不可知，先确认现在跑的是哪个 pid」；`unverifiable`（探测出错）是另一种结论，不许被读成「未生效」。

- 出处：`src/rooms/build-stamp.mjs:225-249`、`src/rooms/build-stamp.mjs:295-305`、`scripts/checkup.mjs:46-51`、`CHANGELOG.md:7856`、`docs/派单表.md:12`
