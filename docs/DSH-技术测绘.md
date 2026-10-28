# DSH 压缩插件技术测绘（2026-10-28，实测版本 0.2.0-rc.2）

> **版本更正（先看这条）**：任务书写「DSH 版本 0.2.1-rc.2」，实测不是。
> asar 根 `package.json` = `"version": "0.2.0-rc.2"`（`app.asar:/package.json`）；
> 运行时清单 `app.asar:/dsh/package.json` = `"@deepseek-ai/dsh-desktop-runtime" 0.2.0-rc.2`，
> 其 `dependencies` 里每个包（`@deepseek-ai/dsh`、`dsh-compaction`、`dsh-compaction-basic`…）都是 `0.2.0-rc.2`；
> `D:\DeepSeek Harness\resources\runtime\versions.json` = `{"node":"24.18.1","pnpm":"11.7.0"}`。
> 全文按 **0.2.0-rc.2** 取证。若实现时要写 peer 版本，必须写精确 `0.2.0-rc.2`（见 §9 陷阱 12）。

> **取证方式**：所有源码结论来自对 `D:\DeepSeek Harness\resources\app.asar` 的只读导出。
> 逐字引用的行号 = 包内 `lib/index.js` 的行号（导出件与 asar 内文件 `diff` 一致，已核）。
> 导出件在 `D:\主工作区\tmp\context-plugin\asar-extract\`，复现命令见附录 A。
> 材料清单里的 `tmp/context-plugin/docs/dsh-compaction.lib.index.js`（seam 175 行）与
> `dsh-compaction-basic.lib.index.js`（1027 行）与 asar 内文件**逐字节相同**（`diff -q` 无输出）。

---

## 0. 一页速查（做插件必须知道的 10 条）

1. **契约只有 3 个方法**：`compactIfNeeded(agent, trigger, signal)`、`compactNow(agent, signal, sourceCommandId?)`、`compactRegion(start, end, agent, signal?)`。基类 `CompactionEngine` 里**没有抽象方法实现**，它只做 `super(ctx, "compaction")` 注册服务（seam `lib/index.js:169-173`）。签名逐字见 §1。
2. **服务注册 = `Service` 构造器副作用**：`new Service(ctx, "compaction")` → `ctx.reflect.provide(name, self, check)`；**同一 isolate realm 里第二个实现直接抛错** `service "compaction" has been registered at <fiber>`（cordis `src/reflect.ts:277-304`）。
3. **官方后端真正生效的位置在 preset 里，不在 host 层**：`dsh-base/cordis.patch.yml:341` 插一行 `compaction-basic`，但 `dsh-web-app/cordis.patch.yml:509-510` 把 host 行 `disabled: true` 了；真正跑的是 `presets/standard.patch.yml:63-79` 的 `compaction` group 内那份。**`- id: compaction-basic` 形式的 profile patch 打不中它**（patch 索引只递归 `group && Array.isArray(config)`，`preset-standard` 的 config 是对象）。见 §1.6 / §7.6。
4. **替换官方后端 = 整份重写 `preset-standard` 的 `config.plugins`**：因为 profile patch 对命中的条目是**整值替换**，不做深合并（`dsh-app-boot/lib/index.js:61-122`）。把 `compaction` group 里的 `compaction-basic` 行换成你的行，或给它 `disabled: true` 再加你的行。**两行并存必炸**（见第 2 条）。
5. **preset 内的服务必须被 isolate**：`mountPreset` 在挂载后审计「泄漏到 root realm 的服务」，有就拒绝整个 preset：`Preset services require isolate realms: ...`（`dsh-agent-preset-registry/lib/index.js:250-273` + `leakedServices` 112-137）。`compaction` group 的 `isolate: {compaction: true, toolResultPruner: true}` 就是为此。你的插件必须挂在这个 group 里。
6. **surface 替换只有一条路**：`session.append("user/message", checkpointMessage, { surfaceOp: {op:'replace', startSeq, endSeq}, sourceEventSeqs:[...] })`。`sourceEventSeqs` **必须覆盖被遮蔽的每一个 surface 节点**，少一个就抛 `surface replace: sourceEventSeqs must include every shadowed surface node`（`dsh-session/lib/index.js:311-329`）。端点必须早于当前 seq（同文件 356）；节点 0 是 system 时只允许被恰好覆盖它的 `system/message` 替换（416-420）。
7. **不要在 `session/event` 监听器里调 `session.append`**：append 在广播期间置 `entry.appending = true`，重入直接抛错，而错误被 `invokeContainedSessionObservers` **吞成 logger.warn**（`dsh-session/lib/index.js:1441-1481`、`1228-1237`）。每步落账要么只写文件，要么用 `agent/pre-step` / `agent/turn-stopping` 这两个可 await 的钩子，要么 `queueMicrotask` 延后。
8. **`agent/pre-step` 是「每步边界」唯一可安全落账的 durable 写点**：waterfall，入参 `{agent, messages, turn, step, signal}`，返回 `PreStepDecision = {kind:'reject'} | {kind:'enter', messages, startsRequestSeries?}`（api-catalog:5951、3764-3770）。官方自动压缩就挂在这里（basic:839-852）。
9. **摘要必须严格更小**：`estimateMessage(checkpointMessage) >= shadowedRouteTokenCount` 直接抛 `summary is not smaller than the shadowed content`（basic:600-601）。想「压完反而更大」的路子在事务层就被拒。
10. **`dsh plugin --profile desktop` 只有 Desktop 自带 CLI 能跑**：`manageDesktopProfile` 只有 `dsh-desktop-host/lib/cli.js:94` 传 true；普通 `dsh` 二进制的 `runCli()` 不传 → `rejectElectronProfile` 报 "profile desktop is managed exclusively by the Electron application"（`dsh/lib/bin.js:101/119/209`）。包装器在 `D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。

> **补充（比上面十条更阴的一条）**：自定义 session 事件类型写进日志 = 会话重启后**打不开**（fail-closed，§9 陷阱 19）。账本进 sidecar，别进日志。

---

## 1. CompactionEngine 契约（含逐字签名）

### 1.1 seam 全文（`@deepseek-ai/dsh-compaction`，`lib/index.js`）

`lib/index.js:160-173` 逐字：

```js
/**
* Abstract compaction service. Implementations own trigger policy, retention,
* and summarization, and may consume a separate measurement service. A
* successful run replaces the selected surface span with one summary node and
* prevents concurrent compaction of the same session. The replacement user
* message uses {@link compactCheckpointSource} with the transaction identity
* so consumers recognize and correlate it independently of the backend. Load
* one implementation per context as `ctx.compaction`.
*/
var CompactionEngine = class extends Service {
	constructor(ctx) {
		super(ctx, "compaction");
	}
};
```

`lib/index.js:146-159` 手动失败类型：

```js
var ManualCompactionError = class extends Error {
	code;
	name = "ManualCompactionError";
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
	}
};
```

`lib/index.js:116-130` 检查点来源（这是「后端无关」的持久标记，必须用）：

```js
function compactCheckpointSource(compactionId, sourceCommandId) {
	return Object.freeze({
		...COMPACT_CHECKPOINT_MARKER,
		compactionId,
		...sourceCommandId === void 0 ? {} : { sourceCommandId }
	});
}
function isCompactCheckpointSource(source) {
	return source.kind === "compact-checkpoint";
}
```

`lib/index.js:109`：`const COMPACT_CHECKPOINT_MARKER = Object.freeze({ kind: "compact-checkpoint" });`

`lib/index.js:80-93` 工具对边界（替换端点必须用它校验）：

```js
function toolPairingBalancedBefore(session, seq) {
	return cutBalance(balanceCache(session), seq, 0);
}
function toolPairingBalancedAfter(session, seq) {
	return cutBalance(balanceCache(session), seq, 1);
}
```

`lib/index.js:21-27` 定义「配对是否平衡」的算法：`assistant/message` 里每个 `tool-call` 块 +1，`tool/result` −1，归零处才算平衡切点；`<0` 直接抛「corrupt surface」。

### 1.2 三个必须实现的操作（逐字类型，来自 asar 内生成的 API 目录）

证据：`app.asar:/dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js`（服务条目 `compaction`，行 577-602）。

```
signature: 'abstract compactIfNeeded( agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal, ): Promise<CompactionResult | null>'
signature: 'abstract compactNow( agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId, ): Promise<CompactionResult | null>'
signature: 'abstract compactRegion( start: SessionSeq, end: SessionSeq, agent: CompactionAgentContext, signal?: AbortSignal, ): Promise<CompactionResult>'
```

配套类型（同文件）：

- `CompactionAgentContext`（4699-4702）：
  ```ts
  export interface CompactionAgentContext {
      session: Session;
      options: { provider?: string; model?: string; };
  }
  ```
- `ManualCompactAgentContext`（5627-5630）：
  ```ts
  export interface ManualCompactAgentContext extends CompactionAgentContext {
      runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  }
  ```
- `CompactionTrigger`（4711）：`export type CompactionTrigger = 'pressure' | 'context-overflow';`
- `CompactionResult`（4707-4722）：
  ```ts
  export interface CompactionResult {
      compactionId: CompactionId;
      sourceCommandId?: CommandId;
      startSeq: SessionSeq;
      summarySeq: SessionSeq;
      endSeq: SessionSeq;
      summary: ContentBlock[];
      shadowedRange: { start: SessionSeq; end: SessionSeq; };
      shadowedSeqs: SessionSeq[];
      shadowedTokenCount: number;
  }
  ```
- `ManualCompactionError` 的 `code` 闭集（消费方 `dsh-command-compact/lib/index.js:21-45` 穷举）：`busy | cancelled | changed | summary | commit | persistence`。
- 返回值语义：`compactIfNeeded` 返回 `null` = 无需压缩；`compactNow` 返回 `null` = 没有安全可用范围（**不写日志**，命令显示 "No compactable history yet."，`dsh-command-compact/lib/index.js:57-60`）；`compactRegion` 必定返回值或抛错。

### 1.3 唯一调用方

全 asar 只有一处调用 `ctx.compaction.*`：`dsh-command-compact/lib/index.js:55`

```js
const result = await ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId);
```

`inject = ["commands", "compaction"]`（同文件 12 行）。也就是说：**引擎的 `compactNow` 是 `/compact` 唯一入口；`compactIfNeeded` 由引擎自己的 `agent/pre-step` / `agent/request-error` 监听器调用**（官方就是这么做，basic:839-887）。别指望 loop 帮你调。

### 1.4 如何注册 `ctx.compaction`

```js
import { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import z from '@deepseek-ai/schemastery'   // 只有要 Config 校验时才需要

export default class MyEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']
  static Config = z.object({ /* ... */ })
  constructor(ctx, config = {}) {
    super(ctx)          // ← 这一行完成 ctx.compaction 注册
    /* 注册自己的 agent/pre-step 等监听器 */
  }
}
```

Cordis 的类插件路径：`isConstructor(runtime.callback)` → `new runtime.callback(this.ctx, this.config)`（`cordis/src/fiber.ts:251-258`）。`inject` 静态字段让 fiber 等到这些服务可用才构造；`Config` 用 schemastery 校验（`fiber.ts:50-53` 调 `runtime.Config['~standard'].validate`）。

`Service` 构造器逐字（`cordis/src/service.ts:42-57`）：

```ts
constructor(protected ctx: Context, name: string) {
    name ??= this.constructor['provide'] as string
    let self = this
    const tracker: Tracker = { associate: name, property: 'ctx' }
    if (self[symbols.invoke]) {
      self = createCallable(name, joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker)
    }
    self.ctx = ctx
    self.name = name
    defineProperty(self, symbols.tracker, tracker)
    self.ctx.reflect.provide(name, self, this[symbols.check])
    return self
}
```

**实例粒度（容易误判）**：preset 的子插件列表是**按 generation 挂载一次**的（`mountPreset(scope.ctx, id, record.config.plugins)`，`dsh-agent-preset-registry/lib/index.js:534`），同一 generation 的所有 agent 共用同一个引擎实例；`ctx.compaction` 也只在这个 generation 的 isolate realm 里。所以引擎内部状态**必须按 `agent`/`session` 做键**（官方用 `WeakMap<Agent|Session, T>`，basic:821-823）。`/compact` 调 `compactNow(agent,...)` 时传的就是具体 agent。

### 1.5 同一 context 注册两个会怎样

`cordis/src/reflect.ts:277-304` 的关键三行：

```ts
this.ctx.root[symbols.isolate][name] ??= Symbol(name)
const key = this.ctx[symbols.isolate][name]
const impl: Impl = { name, value, fiber: this.ctx.fiber, check }
if (this.store[key]) {
  throw new Error(`service "${name}" has been registered at <${this.store[key].fiber.name}>`)
}
```

结论：
- **同一 isolate realm、同一 fiber 树里的两次注册 = 构造器抛错**。因为发生在 `new` 里，插件 fiber 启动失败；`fiber.await()` 会把错误重新抛出（`cordis/src/fiber.ts:704-711`：「Wait for current lifecycle work and rethrow startup errors」）。
- 在 preset 里，行失败 → `auditRows` 收进 `failed` → `mountPreset` 抛 `Preset services require isolate realms` 之外的 audit 错误 → 整个 preset generation 失败（`dsh-agent-preset-registry/lib/index.js:197-222, 250-273`），日志形如 `agent preset standard: <detail>`（同文件 534-540）。
- **不同 isolate realm 可以共存**：`isolate: { compaction: true }` 让该子树拿到 realm 私有 symbol，所以 host 层一个、preset 内一个并不冲突 —— 但 agent 根本看不到 host 层那个（它只被 group 内的插件解析）。

### 1.6 「替换掉」官方的正确姿势

| 层 | 做法 | 证据 |
|---|---|---|
| host 层那一行 | `- id: compaction-basic` + `disabled: true` | `dsh-web-app/cordis.patch.yml:509-510` 现成实例 |
| **preset 内真正生效的那一行** | **profile patch 里整份重写 `preset-standard` 的 `config.plugins`**，在 `compaction` group 的 `config` 数组里：① 给 `compaction-basic` 加 `disabled: true`，或直接删掉该行；② 加你自己的行 `- id: chess-compaction  name: 'dsh-chess-context'` | `applyEntryPatches` 的 `buildMap` 只递归 `entry.group && Array.isArray(entry.config)`（`dsh-app-boot/lib/index.js:63-72`）；本机 profile 的实测记录见 `D:\DeepSeek Harness\home\profiles\desktop\cordis.patch.yml:314-342`（作者已踩过：`auto:false` 的 patch 从未生效） |
| 只 disable 不新增 | 不行：`ctx.compaction` 缺失 → `/compact` 与自动压缩全失效（`dsh-compaction/README.zh.md:47`「如果未挂载后端，什么都不会压缩，`/compact` 也会失败」） | — |

> **继承官方实现是允许且推荐的**：`dsh-compaction-basic` 默认导出 `BasicCompactionEngine`（basic:1027 `export { BasicCompactionEngine, BasicCompactionEngine as default }`）。你可以 `import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'` 后 `class Mine extends BasicCompactionEngine`，只挂 Mine 这一行 —— 不会出现两个服务，因为父类本身没被单独挂载。构造器里的 `if (this.config.auto) this._registerAutomaticCompaction()`（basic:827）是**动态派发**的，子类覆盖 `_registerAutomaticCompaction()` 即可整体替换自动触发逻辑；`summarize()` 是官方声明的唯一子类钩子（basic:889-903 注释）。

---

## 2. surface 替换事务与事件 payload

### 2.1 `session.append` 的精确签名

类型（api-catalog:6355-6379 的 `Session` 类声明）：

```ts
export class Session {
    get surface(): SessionSurface;
    readonly header: SessionHeader;
    readonly inheritedEventCount: SessionLogOffset;
    get id(): SessionId;
    readonly firstLiveSeq: SessionLogOffset;
    readonly firstLifecycleSeq: SessionLogOffset;
    static create(...): Session;
    static fromRestore(...): Session;
    eventAt(seq: SessionSeq): SessionEvent | undefined;
    snapshotEvents(fromSeq?, toSeqExclusive?): readonly SessionEvent[];
    ownEvents(): readonly SessionEvent[];
    isOwnSeq(seq: SessionSeq): boolean;
    get seq(): SessionLogOffset;
    append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts: T extends SurfaceEventType ? [
        opts: SurfaceIntent<T>
    ] : [
    ]): SessionEvent<T>;
    requestHeader(): EpochHeader | undefined;
    requestContext(): RequestContext | undefined;
    toolHistory(): ToolHistory;
    deriveMessages(): Message[];
    deriveEventMessage(event: SessionEvent): Message | null;
}
```

运行时实现（`dsh-session/lib/index.js:1441-1481`）关键行：

```js
append(type, data, ...opts) {
    const surfaceOpts = opts[0];
    const surfaceMetadata = {
        ...surfaceOpts?.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: surfaceOpts.sourceEventSeqs },
        ...surfaceOpts?.surfaceOp === void 0 ? {} : { surfaceOp: surfaceOpts.surfaceOp }
    };
    const dataSnapshot = snapshotJsonValue(data);
    if (dataSnapshot === void 0) throw new Error(`session event "${type}" carries non-JSON-serializable data`);
    const surfaceMetadataSnapshot = snapshotJsonValue(surfaceMetadata);
    if (surfaceMetadataSnapshot === void 0) throw new Error(`session event "${type}" carries non-JSON-serializable surface metadata`);
    const entry = attachments.get(this);
    if (entry?.appending) throw new Error("session append cannot reenter while another append is being published");
    const event = deepFreeze({
        type,
        seq: SessionSeq(this.log.length),
        time: Date.now(),
        data: dataSnapshot,
        ...surfaceMetadataSnapshot
    });
    validateSessionEventData(event, `session event "${type}" at seq ${event.seq}`);
    this.surfaceManager.validateNext(event);
    ...
    this.log.push(event);
    this.eventsSnapshot = void 0;
    if (callbacks !== void 0 && entry !== void 0) invokeContainedSessionObservers(entry.emitCtx, "session/event", entry.id, callbackArgs, callbacks);
    return event;
}
```

返回值 = 已入日志的**冻结事件**（含 `seq`/`time`/`data`/`surfaceOp`/`sourceEventSeqs`）。

`SurfaceOp` 与 `SurfaceIntent`（api-catalog:7319-7317）：

```ts
export type SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq; };
export type SurfaceIntent<T extends SurfaceEventType = SurfaceEventType> = {
    surfaceOp: SurfaceOp;
} & (T extends 'assistant/message' ? { sourceEventSeqs?: never; } : { sourceEventSeqs?: SessionSeq[]; });
```

`SurfaceEventType`（同文件 7311）：`'system/message' | 'developer/message' | 'user/message' | 'assistant/message' | 'tool/result'`。

规则（`dsh-session/lib/index.js`）：
- `surfaceOp` 必须具备且形状精确：`Object.keys(op).length === 3` 且 `op==='replace'` 且两个端点是安全非负整数（290-293、294-309）。
- 替换端点必须 `< event.seq`（356）。
- `sourceEventSeqs`：非空、无重复、必须都是更早事件、**必须覆盖全部被遮蔽节点**（311-329）。
- `tool/result` 替换只能改 `content`，且只能再写一条当前节点（391-409）。
- 节点 0 是 `system/message` 时，只允许一个恰好覆盖它的 `system/message` 来替换（416-420）。
- 替换提交：`state.nodes.splice(startIdx, len, plan.seq)`，`replaceGeneration += 1`，`contentGeneration += 1`（459-465）。

### 2.2 官方压缩的完整事务（逐字，来自 basic）

`dsh-compaction-basic/lib/index.js:450-522`（我按顺序摘关键行）：

```js
async function compactSurfaceRegion(dependencies, session, start, end, agent, options, signal) {
	if (options.owner === null) signal?.throwIfAborted();
	const selection = validateSurfaceRegion(session, start, end);
	const entryState = inspectCompactionEntryState(session);
	assertCompactionInactive(entryState.unmatchedCompactionStart, entryState.latestEndSeedSeq, "compaction");
	let owner;
	if (options.owner === null) {
		if (entryState.openTurn !== null) throw new ManualCompactionError("busy", "manual compaction: the session already has an open turn");
		owner = null;
	} else {
		if (entryState.openTurn === null) throw new Error("compactRegion: no open turn — automatic compaction events must be enclosed in a turn");
		owner = entryState.openTurn;
	}
	const compactionId = CompactionId(randomUUID());
	const lifecycle = {
		compactionId,
		...options.sourceCommandId === void 0 ? {} : { sourceCommandId: options.sourceCommandId },
		turn: owner
	};
	const startEvent = session.append("compaction/start", lifecycle);
	const assertStable = options.stability === "whole-surface" ? assertWholeSurfaceUnchanged : assertSelectedSpanStable;
	let failure;
	let flushFailure;
	let result;
	let closed = false;
	let closing = false;
	let stage = "summary";
	try {
		const summarized = await summarizeCompaction(dependencies, prepareCompaction(dependencies, session, selection), agent, compactionId, options.sourceCommandId, assertStable, signal);
		if (options.owner === null) signal?.throwIfAborted();
		assertStable(dependencies, session, summarized);
		stage = "commit";
		const pending = commitCompactionBody(session, startEvent, summarized);
		closing = true;
		const endEvent = session.append("compaction/end", lifecycle);
		closed = true;
		result = completeCompaction(pending, endEvent);
	} catch (error) {
		failure = {
			error,
			stage: closing ? "commit" : stage
		};
		if (!closing) {
			closing = true;
			try {
				session.append("compaction/end", {
					...lifecycle,
					error: errorChain(error)
				});
				closed = true;
			} catch (closeError) {
				failure = {
					error: closeError,
					stage: "commit"
				};
			}
		}
	}
	if (closed && options.flush !== void 0) try {
		await options.flush();
	} catch (error) {
		flushFailure = error;
	}
	if (options.owner === null) signal?.throwIfAborted();
	if (failure !== void 0) {
		if (options.owner === null) throwManualFailure(failure);
		throw failure.error;
	}
	if (flushFailure !== void 0) throw new ManualCompactionError("persistence", "manual compaction durability checkpoint failed", { cause: flushFailure });
	if (result === void 0) throw new Error("compaction committed without a result");
	return result;
}
```

事务不变量（必须照抄，不要自创）：
1. **锁 = 日志标记对**：`compaction/start` 在摘要让出控制权（`await`）之前同步追加；每次失败恰好一次 `compaction/end`；闭合失败会留下未匹配 start 作为 busy 信号（basic:434-441 注释）。
2. 标记对必须**整段落在一个 turn 内**：`dsh-compaction/lib/invariant.js` 的 `validateTurnBoundary` 会拒绝跨越 `turn/start`/`turn/end` 的未闭合 bracket。
3. 成功的 `compaction/end` 必须已有一次 `compaction/summary`（invariant：`if (event.data.error === void 0 && !open.summarized) fail("successful compaction/end requires one compaction/summary")`）。
4. 手动路径 `owner === null` → `turn: null`，要求 agent 空闲（`compactNow` 用 `runMaintenance` 预留），且**每次都 flush**。

### 2.3 事件 payload（逐字抄自 basic）

#### `compaction/start`（basic:469）

```js
const startEvent = session.append("compaction/start", lifecycle);
```

`lifecycle` 构造（basic:464-468）：

```js
	const lifecycle = {
		compactionId,
		...options.sourceCommandId === void 0 ? {} : { sourceCommandId: options.sourceCommandId },
		turn: owner
	};
```

即 payload = `{ compactionId: string, sourceCommandId?: string, turn: number | null }`。

#### `compaction/summary`（basic:628-649）

```js
function commitCompactionBody(session, startEvent, summarized) {
	const { start, end, shadowedSeqs, shadowedTokenCount, summary, provider, model, maxTokens, usage, checkpointMessage } = summarized;
	const callRecord = summarized.llmStreamCall === true ? {
		rawOutput: summarized.rawOutput,
		llmStreamCall: true
	} : summarized.rawOutput === void 0 ? {} : { rawOutput: summarized.rawOutput };
	const summaryEvent = session.append("compaction/summary", {
		compactionId: startEvent.data.compactionId,
		...startEvent.data.sourceCommandId === void 0 ? {} : { sourceCommandId: startEvent.data.sourceCommandId },
		summary,
		...callRecord,
		shadowedRange: {
			start,
			end
		},
		shadowedSeqs: [...shadowedSeqs],
		shadowedTokenCount,
		provider,
		model,
		...maxTokens === void 0 ? {} : { maxTokens },
		...usage === void 0 ? {} : { usage }
	});
```

payload 字段：`compactionId`、`sourceCommandId?`、`summary`（`ContentBlock[]`，**只含 text**）、`rawOutput?`、`llmStreamCall?`、`shadowedRange{start,end}`、`shadowedSeqs[]`、`shadowedTokenCount`、`provider`、`model`、`maxTokens?`、`usage?`。

不变式额外要求：`shadowedSeqs` 非空、首尾等于 `shadowedRange.start/end`、且**逐项等于当前 surface 区间**（invariant `validateShadowedSeqs`）。

#### 表层替换 + `compaction/end`（basic:650-661、484、495-498）

```js
	session.append("user/message", checkpointMessage, {
		surfaceOp: {
			op: "replace",
			startSeq: start,
			endSeq: end
		},
		sourceEventSeqs: [
			startEvent.seq,
			summaryEvent.seq,
			...shadowedSeqs
		]
	});
```

```js
		const endEvent = session.append("compaction/end", lifecycle);       // 成功
		...
				session.append("compaction/end", {                            // 失败
					...lifecycle,
					error: errorChain(error)
				});
```

`compaction/end` payload = `{compactionId, sourceCommandId?, turn, error?: <errorChain 字符串>}`。

> 注意 `sourceEventSeqs` 里除了被遮蔽节点，还塞了 `startEvent.seq` 和 `summaryEvent.seq` —— 这是合法且被官方 invariant 认可的（只要求**覆盖**全部 shadowed，不禁止额外引用）。

### 2.4 checkpoint 消息的构造（逐字）

`compactCheckpointSource`（seam，§1.1）+ `createUserMessage`（`dsh-llm/lib/types/message.js:53-59`）：

```js
export function createUserMessage(input) {
    return createMessage({
        ...input,
        role: 'user',
    });
}
```

basic:596-599：

```js
	const checkpointMessage = createUserMessage({
		content: frameSummary(summaryResult.summary),
		source: compactCheckpointSource(compactionId, sourceCommandId)
	});
```

`frameSummary`（basic:344-356）逐字：

```js
function frameSummary(summary) {
	return [
		{
			type: "text",
			text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}`
		},
		...summary,
		{
			type: "text",
			text: SUMMARY_CLOSE_TAG
		}
	];
}
```

标签与前言（basic:234-235、280）：

```js
const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";
const CHECKPOINT_PREAMBLE = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";
```

**`RequestUserInput`** 不是 checkpoint 消息。它是「仅供请求、无持久身份」的 user 输入，用在**摘要调用**里（api-catalog:6159-6160）：

```ts
export interface RequestUserInput {
    readonly role: 'user';
    readonly content: UserMessage['content'];
    readonly id?: never;
    readonly source?: never;
}
```

`RequestMessage = Message | RequestUserInput`（api-catalog:6152）。basic 把压缩指令作为**普通冻结对象**（不是 `createUserMessage`）追加到 messages 末尾（basic:305-311）：

```js
	const messages = [...input.messages, deepFreeze({
		role: "user",
		content: [{
			type: "text",
			text: COMPACTION_INSTRUCTION
		}]
	})];
```

---

## 3. Session / Surface API

### 3.1 `session.surface`（`SessionSurface`）

api-catalog:6803-6807：

```ts
export interface SessionSurface {
    readonly nodes: readonly SessionSeq[];
    readonly replaceGeneration: number;
    readonly contentGeneration: number;
}
```

实现 `dsh-session/lib/index.js`：`get surface() { return this.surfaceManager; }`（1252-1255）；`get replaceGeneration()`（536-540）、`get contentGeneration()`（542-546）、`get nodes()`（558-562）。

语义差异（重要）：
- `replaceGeneration`：只被**位置替换**推进（459-465）。
- `contentGeneration`：位置替换 **+ 插件拥有的消息投影**都会推进（459-470）。`deriveMessages()` 的缓存按 `contentGeneration` 失效（1554-1569）。
- 官方 loop 用 `contentGeneration` 判断是否开始新的请求序列（`dsh-agent-loop/lib/index.js:1054`、`1211`）—— 这就是「一次压缩会让 KV 前缀从替换点起失效」的机制来源。

### 3.2 `session.eventAt(seq)` / `deriveEventMessage`

- `eventAt(seq)`：`return this.log[seq];`（1363-1365）。**已被官方标记 deprecated**（1366-1372：「new calls are prohibited」），但 sampler/token-meter/basic 都还在用；插件里用它是安全的（同一构建内不会移除），只是新代码最好改用 `snapshotEvents` 或事件流。
- `deriveEventMessage(event)`：先查投影，再按类型取 message（`dsh-session/lib/index.js:214-227`）：
  ```js
  function deriveEventMessage(event, projectedMessages) {
      const projected = projectedMessages?.get(event.seq);
      if (projected !== void 0) return projected;
      switch (event.type) {
          case "user/message": return event.data;
          case "system/message":
          case "developer/message":
          case "assistant/message":
              if (event.data.message.content.length === 0) return null;
              return event.data.message;
          case "tool/result": return event.data.message;
          default: return null;
      }
  }
  ```
- `deriveMessages()`：沿 `surface.nodes` 增量投影，替换/投影使缓存重建（1554-1569）；返回**新数组**，元素是共享的深冻结 Message。

### 3.3 `toolHistory()` / `requestHeader()`

- `toolHistory(): ToolHistory`（1525-1529），类型 api-catalog:7579-7586：
  ```ts
  export interface ToolHistory {
      readonly tools: readonly ToolSchema[];
      readonly updates: readonly {
          readonly messageId: MessageId;
          readonly additions: readonly ToolSchema[];
      }[];
  }
  ```
- `requestHeader(): EpochHeader | undefined`（1494-1500），类型 api-catalog:5087-5092：
  ```ts
  export interface EpochHeader {
      config: LlmCallConfig;
      adapterDefaults?: LlmCallConfigAdapterDefaults;
      tools?: ToolSchema[];
      system?: never;
  }
  ```
- `session.seq` = 日志长度（1401-1403）。

### 3.4 「往对话追加不改变 surface 的上下文」——没有这个接口

结论（逐条证据）：
1. 模型只看 surface 事件：`SURFACE_EVENT_TYPES = {system/message, developer/message, user/message, assistant/message, tool/result}`（`dsh-session/lib/index.js:154-160`）；`deriveMessages()` 只遍历 `surface.nodes`（1554-1569）。**非 surface 事件永远不会进模型请求。**
2. surface 事件必须带 `surfaceOp`；非 surface 事件**禁止**带 `surfaceOp`/`sourceEventSeqs`，否则抛错（295-309）。所以不存在「追加一条表面事件但不进 surface」的写法。
3. `KNOWN_SESSION_EVENT_TYPES`（79-139）里没有任何 `context/*` 事件类型。自定义类型**在内存里可以 append**（未知类型只要不带 `surfaceOp`/`sourceEventSeqs` 就通过校验，`surfaceOpOf` 295-309），但它只存在于日志、不产生消息；**而且它会让会话在重启后打不开**（见 §9 陷阱 19）。所以「给模型看的上下文」只能走 surface，「给插件自己看的账」应走 sidecar 文件。
4. 官方「注入上下文」的机制是 **agent 收件箱**，最终落成 `user/message` 表面追加：
   - `agent.inject(input)` → `send(input, "next-step", false)`（`dsh-agent-loop/lib/index.js:812-814`）——不唤醒 driver，落在下一个被接纳的步骤；
   - `agent.steer(input)` → `send(input, "next-step", true)`（809-811）；
   - `agent.followup(input)` → `send(input, "next-turn", true)`（806-808）；
   - 落实点：`if (firstAttempt) for (const message of decision.messages) this.session.append("user/message", message, { surfaceOp: "append" });`（1061）。
   所以**注入即改 surface**，只是位置在尾部、且可以与 pre-step 的 messages 合并。
5. 若只想「留一份给模型看不见的账」：**不要**往会话日志 append 自定义类型（第 3 条的 fail-closed），也不要借 `system/developer` 节点变相塞字（那是 surface 事件，会进请求）。正确做法是 sidecar 文件（方案书 §3.4 的 graph.json 就走这条）；若坚持要进日志，只能借用已知类型（如 `compaction/summary` 的额外字段）并自测恢复。

### 3.5 全仓 `session.append(...)` 调用点与事件类型

扫描方式：遍历 asar 内所有 `lib/**/*.js`，正则 `\w+\.append\(\s*["']<type>["']`（脚本见附录 A）。**只保留 session 对象上的调用**，剔除浏览器 `Headers.append` 噪音后：

| 事件类型 | 生产者（包:行） |
|---|---|
| `turn/start` / `turn/end` / `step/start` / `step/end` | dsh-agent-loop 943 / 1027 / 968 / 992 |
| `system/message` / `developer/message` | dsh-agent-loop 1056 / 1240 |
| `user/message` | dsh-agent-loop 1061；**dsh-compaction-basic 650** |
| `assistant/message` / `assistant/attempt` | dsh-agent-loop 1144 / 1101（+1086 中断） |
| `tool/call` / `tool/result` | dsh-agent-loop 681-689 / 691-703（`appendToolCall` / `appendToolResult`，含 `appendSkippedToolCall` 663）；dsh-compaction-tool-result-pruner |
| `request/header` / `request/context` | dsh-agent-loop 1214,1220,1225 / 1259 |
| `agent/inbox/spliced` | dsh-agent-loop 204 |
| `compaction/start` / `compaction/summary` / `compaction/end` | dsh-compaction-basic 469 / 634 / 484,495 |
| `compaction/prune` | dsh-compaction-tool-result-pruner |
| `image/offload` | dsh-compaction-image-offload |
| `hook/invoked` / `hook/result` | dsh-hook-protocol |
| `llm/retry` / `llm/retry-started` | dsh-llm-retry |
| `approval/asked` / `approval/decided` / `approval/policy` | dsh-user-approval / dsh-subagent |
| `todo/write` | dsh-tool-todo |
| `goal/change` | dsh-goal |
| `plan/mode` | dsh-plan-mode |
| `permission/preset` / `sandbox/mode` | dsh-permission-presets / dsh-sandbox-policy / dsh-subagent |
| `agent-preset/selected` | dsh-agent-preset-registry |
| `model/selection` | dsh-api-session-controller |
| `subagent/catalog` / `subagent/descriptor` / `subagent/model-selection-policy` | dsh-subagent / dsh-subagent-in-process-driver / dsh-tool-subagent |
| `session/title` / `session/title-llm-request` | dsh-session-title / dsh-session-title-llm |
| `deliverables/presented` | dsh-tool-present |
| `feedback/record` | dsh-command-feedback |
| `workspace/changes` | dsh-workspace-changes |
| `tool/ptc-dispatch` / `tool/ptc-dispatch-start` | dsh-tools |
| `web/deepseek-search-llm-request` | dsh-web-search-deepseek |
| `session-log-deepseek/delivery-accepted` | dsh-session-log-deepseek |
| `session/end-seed` | dsh-session（构造/恢复时，1351-1352） |

（完整 `KNOWN_SESSION_EVENT_TYPES` 见 `dsh-session/lib/index.js:79-139`，共 59 项。）

---

## 4. tokenMeter API

### 4.1 两个方法

api-catalog:3147-3164：

```
signature: 'measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement'
signature: 'estimateMessage(message: Message): number'
```

### 4.2 `TokenMeasurement` 返回结构（逐字）

api-catalog:7495-7513：

```ts
export interface TokenMeasurement {
    readonly logRevision: SessionLogOffset;
    readonly baseline: TokenMeasurementBaseline;
    readonly surfaceDeltaTokens: number;
    readonly totalTokens: number;
    readonly surfaceTokens: number;
    readonly nodes: readonly TokenSurfaceNode[];
}
export type TokenMeasurementBaseline = {
    readonly kind: 'none';
    readonly tokens: 0;
} | {
    readonly kind: 'estimated';
    readonly tokens: number;
} | {
    readonly kind: 'usage';
    readonly tokens: number;
    readonly usage: Readonly<TokenUsage>;
};
export interface TokenSurfaceNode {
    readonly seq: SessionSeq;
    readonly tokens: number;
    readonly heuristicTokens: number;
}
```

`TokenUsage`（7507-7513）：
```ts
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}
```

实现 `dsh-token-meter/lib/index.js:641-684`（返回值）逐字：

```js
		return deepFreeze(structuredClone({
			logRevision: state.consumedEvents,
			baseline,
			surfaceDeltaTokens,
			totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens),
			surfaceTokens: surface.surfaceTokens,
			nodes: surface.nodes
		}));
```

要点：
- `nodes` 与 `session.surface.nodes` **同序同长**，每项 `{seq, tokens, heuristicTokens}`（route-pricing.js:24、52）。
- `tokens` = 路由定价（图片/文件按适配器投影），`heuristicTokens` = 固定启发式（4 字符/token + 结构开销），两者用途不同：**替换影子价用 heuristic，压力判断用 totalTokens**。
- `measure()` 每次 `structuredClone` 整个 surface → **O(surface)**（token-meter README:36、141）。每步无条件调一次有成本，务必先判断廉价条件（例如先看 `session.seq` 增长量）。
- 固定启发式常量：`CHARS_PER_TOKEN = 4`（lib/index.js:16）、`BLOCK_OVERHEAD = 4`（:18）、角色开销在打包版里被内联成 `+ 4`（:74；源码里叫 `ROLE_OVERHEAD`，见 `lib/types/estimate.js`）。CJK 与 JSON schema 会被严重低估（README:68）。

### 4.3 `estimateMessage`

实例方法（`dsh-token-meter/lib/index.js:702-704`）直接转发纯函数；纯函数实现（`lib/types/estimate.js:79-84`）：

```js
export function estimateMessage(message) {
    if (message.role === 'system')
        return estimateSystemMessage(message);
    return estimateContent(message.content) + ROLE_OVERHEAD;
}
```

官方用它做「摘要必须更小」的判定（basic:600-601），以及 `compaction/summary` 里 `shadowedTokenCount` 用 `heuristicTokens` 求和（basic:576-577）。

---

## 5. 生命周期 hook 全集

### 5.1 事件清单（从 asar 全量 grep `ctx.on("agent/`、`ctx.on("session/` 得到）

Cordis 侧（`ctx.on` / `ctx.waterfall` / `ctx.emit` / `ctx.serial` / `ctx.parallel`）：

| 事件名 | 分发模式 | 入参（payload） | 返回值语义 | 用途 | 证据 |
|---|---|---|---|---|---|
| `agent/pre-step` | **waterfall** | `{agent, messages: UserMessage[], turn, step, signal}` | `PreStepDecision`；`next()` 取下游默认（`{kind:'enter', messages}`）；返回 `{kind:'reject'}` 阻断该步；返回新 `{kind:'enter', messages, startsRequestSeries?}` 替换入步消息 | **每步边界（派发请求前）**：官方自动压缩就挂这里；可安全 append 事件 | api-catalog:3764-3770；loop 911-918 |
| `agent/request` | **waterfall** | `{agent, turn, step, signal}` | `LlmCallConfig`；`await next()` 得默认配置（首发取 AgentOptions，之后取已记录 header）；返回替换配置 | 改写路由/推理强度/token 上限（不能改 messages） | api-catalog:3772-3778；loop 1179-1183 |
| `agent/request-error` | **waterfall** | `{agent, turn, step, provider, failure: LlmFailure, retryPolicy, signal}` | `RequestErrorAction = {kind:'retry'} \| undefined`；不调 `next()` 直接返回 retry = 自己负责恢复；`next()` = 交给下游；默认 `undefined` = 终态失败 | 上下文溢出自救：压缩后返回 retry | api-catalog:3780-3786；loop 1124-1134；basic 861-887 |
| `agent/turn-stopping` | **serial** | `{agent, turn, signal}` | `Promise<void> \| void`（**返回值被忽略**；想阻止收尾就 `agent.steer(...)` 往里塞消息） | 轮次即将关闭前的最后钩子；可 append（不在 append 广播中） | api-catalog:3796-3802；loop 998-1004 |
| `agent/status` | emit | `{agent, status: 'idle'\|'running'}` | void | 状态跟踪（basic 用来清溢出重试计数） | api-catalog:3788-3794；loop 790-799 |
| `agent/error` | emit | `{agent, turn, step, error}` | void | 错误上报 | api-catalog:3732-3737；loop 877-885 |
| `agent/created` | serial | `{agent, source, signal?}` | `undefined \| Promise<undefined>` | 新 agent 初始化（hooks 桥、外部钩子） | api-catalog:3716-3722；agent 579 |
| `agent/disposed` | emit | `{agent}` | void | 清理 | api-catalog:3724-3730 |
| `agent/assistant-stream` | emit | `{agent, frame: AssistantStreamFrame}` | void | 进程内流式帧（start/chunk/end），**非持久来源** | api-catalog:3708-3714；loop 1067-1069 |
| `agent/inbox/inserted` | emit | `{agent, message}` | void | 收件箱逐消息通知 | api-catalog:3755-3762；loop 206 |
| `agent/inbox/claimed` | emit | `{agent, message, turn}` | void | 同上 | loop 106 |
| `agent/inbox/discarded` | emit | `{agent, message}` | void | 同上 | loop 205 |
| `session/event` | emit（**同步广播，非 await**） | `(session, event)` —— **注意是位置参数，不是 payload 对象** | void；抛错/reject 只被 logger.warn 吞掉 | 观察已提交事件（token-meter、basic、标题等都挂这里） | api-catalog:4132-4141；session 1466-1474、1228-1237 |
| `session/created` | emit | `(session)` | void | 会话发布公告 | api-catalog:4116-4122 |
| `session/disposed` | emit | `(session)` | void | 会话离开 store | api-catalog:4124-4130 |
| `session/flush` | **parallel** | `(session)` | `Promise<void>\|void`，调用方等全部 | 持久性屏障 | api-catalog:4140-4146；session 1832-1838 |
| `llm/stream` | **waterfall** | `(options: GenerateOptions, next)` | `AsyncIterable<StreamChunk>`；`next()` 到适配器，或自行产出 | 每次模型调用（重试/路由/压缩都能被拦） | api-catalog:4060-4066；dsh-llm 2371 |
| `compaction/summary-error` | **waterfall** | `{session, sourceEventSeqs, error, signal?}` | `boolean`；`true` = 已产生持久进展，可重试；`next()` = 不能恢复 | 摘要失败恢复（图片省略插件挂这里） | api-catalog:3876-3882；basic 1017-1022；image-offload 146 |
| `system-prompt/assemble` | **waterfall** | `(assembly, context: AssembleContext, next)` | `PromptAssembly` | 系统提示词组装 | api-catalog:4196-4202 |

**不是 Cordis 钩子**、但同样触发的会话事件（`session/event` 里能看到的）：`session/event` 拿到的是**全部**已提交事件，包括 `step/start`、`step/end`、`turn/start`、`turn/end`、`assistant/message`、`tool/result`…… 所以「等 step/assistant 结束」可以在 `session/event` 里按 `event.type` 过滤，但**不能在里面 append**（见 §9 陷阱 7）。

作用域：这些 `agent/*`、`session/*` 监听默认是**带作用域**的。`agentEvents` 在 payload 上强制注入 `agent`（`dsh-agent/lib/index.js:242-246`）：
```js
function agentEvents(ctx, agent, carrier = agentCarrier(agent)) {
	const fused = (payload) => ({
		...payload,
		agent
	});
```
所以 handler 的入参**一定**含 `agent`，哪怕类型签名没写。要跨 agent 全局监听，传 `{ global: true }`（dsh-scope README：「带 `{ global: true }` 的监听器绕过筛选」）；`prepend: true` 插到监听链最前。

### 5.2 「每步思考结束后跑一次轻量节点落账」——可行，但选点要对

| 方案 | 可行性 | 说明 |
|---|---|---|
| `session/event` 里直接 `session.append` | **不行** | 重入抛错 + 被吞成 warn，静默丢写。见 §9 陷阱 7 |
| `session/event` 里只写文件 / 更新内存图 | **可以** | 同步回调，异常只 warn，不阻塞 append；注意它发生在 append **之后**（1466-1474） |
| `session/event` 里 `queueMicrotask(() => session.append(...))` | 可以 | 广播结束后 `entry.appending=false`，但这段微任务可能在 step 执行中途跑，写入的事件会出现在 assistant/message 与 tool/result 之间 —— 只写日志事件没问题，写 surface 事件会打乱「工具对」顺序 |
| **`agent/pre-step`** | **推荐**（每步边界） | 可 `await`，可 append，和官方压缩同点；拿得到 `turn/step/signal/messages`。等价于「上一步结束后、下一步派发前」 |
| `agent/turn-stopping` | 推荐（轮次收尾） | serial + awaited，适合做「收尾落账/汇总」；此处 append 合法（尚未 `turn/end`），也能 `agent.steer()` 把轮次拉回来 |
| `agent/assistant-stream` | 不适合 | 进程内帧，不持久，重放拿不到 |

一句话：**「每步落账」挂 `agent/pre-step`，「每轮落账」挂 `agent/turn-stopping` 或 `session/event`（只做无 append 的更新）**。

---

## 6. llm.stream 摘要调用

### 6.1 逐字（basic:292-338）

```js
async function summarizeWithLlm(ctx, config, input, agent, signal) {
	const latest = agent.session.requestHeader()?.config;
	const configured = config.summarizationProvider.length === 0 ? void 0 : {
		provider: config.summarizationProvider,
		model: config.summarizationModel
	};
	const agentTarget = agent.options.provider !== void 0 && agent.options.provider.length > 0 && agent.options.model !== void 0 && agent.options.model.length > 0 ? {
		provider: agent.options.provider,
		model: agent.options.model
	} : void 0;
	const target = configured ?? latest ?? agentTarget;
	if (target === void 0) throw new Error("no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields");
	const assembler = new BlockAssembler();
	const messages = [...input.messages, deepFreeze({
		role: "user",
		content: [{
			type: "text",
			text: COMPACTION_INSTRUCTION
		}]
	})];
	const options = {
		provider: target.provider,
		model: target.model,
		messages,
		toolHistory: agent.session.toolHistory(),
		...input.tools === void 0 ? {} : { tools: [...input.tools] },
		maxTokens: config.maxTokens,
		sessionId: agent.session.id,
		purpose: "compaction",
		...signal === void 0 ? {} : { signal }
	};
	for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
	const error = finishError(assembler.finish);
	if (error !== void 0) throw error;
	const rawOutput = assembler.blocks();
	const summary = summaryText(rawOutput);
	if (!summary.some((block) => block.text.trim().length > 0)) throw new Error("summarization produced no text summary content");
	return {
		summary,
		rawOutput,
		llmStreamCall: true,
		provider: options.provider,
		model: options.model,
		maxTokens: config.maxTokens,
		...assembler.usage === void 0 ? {} : { usage: assembler.usage }
	};
}
```

### 6.2 `GenerateOptions`（api-catalog:5195-5210）

```ts
export interface GenerateOptions {
    provider: string;
    model: string;
    reasoningEffort?: ReasoningEffortId;
    messages: RequestMessage[];
    system?: string;
    tools?: ToolSchema[];
    toolHistory?: ToolHistory;
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
    signal?: AbortSignal;
    sessionId?: Branded<'SessionId'>;
    purpose?: 'compaction' | 'session-title';
}
```

### 6.3 回放输入的构造（basic:695-704）

```js
function buildSummarizationInput(session, shadowedSeqs) {
	const header = session.requestHeader();
	const head = systemHead(session, session.surface.nodes[0]);
	const system = head === void 0 ? null : session.deriveEventMessage(head);
	const regionMessages = shadowedSeqs.map((seq) => session.deriveEventMessage(session.eventAt(seq))).filter((message) => message !== null);
	return {
		...header?.tools === void 0 ? {} : { tools: header.tools },
		messages: system === null ? regionMessages : [system, ...regionMessages]
	};
}
```

- system 提示词来自 surface 节点 0 的 `system/message`，作为 **messages[0]**，不是 `options.system`。
- `tools` 回放自 `requestHeader().tools`；`toolHistory` 每次调用 `agent.session.toolHistory()`。
- 指令是最后一条 user（`RequestUserInput` 形状，无 id/source）。
- `purpose: 'compaction'` 与 `sessionId` 都被传了；后者会让 `dsh-session-checkpoint-policy` 在派发前 flush（`llm/stream` 监听器，`dsh-session-checkpoint-policy/lib/index.js:61-63`）。
- **`signal` 必须转发**；seam README:80 明确要求。

### 6.4 结果清洗与失败分类（basic:357-374）

```js
function finishError(finish) {
	switch (finish.kind) {
		case "error":
		case "aborted": return new LlmError(finish.failure.message, finish.failure.code, finish.failure);
		case "max-tokens": {
			const error = /* @__PURE__ */ new Error("summarization truncated at the token cap (incomplete checkpoint)");
			error.code = "MAX_TOKENS";
			return error;
		}
		default: return;
	}
}
function summaryText(blocks) {
	if (contentHasImage(blocks)) throw new LlmError("compaction summary cannot contain image output", "UNSUPPORTED_CONTENT");
	return blocks.filter((block) => block.type === "text");
}
```

`BlockAssembler` 的读取面：`push(chunk)`、`finish`（缺省 `{kind:'stop'}`）、`blocks()`、`usage`（`dsh-llm/lib/types/assembler.js`）。`max-tokens` 时 `blocks()` 会丢掉所有 `tool-call`（同文件 `assembled()`）。

---

## 7. 打包、安装、替换官方后端

### 7.1 官方后端的 `package.json`（逐字，`tmp/context-plugin/docs/compaction-basic.package.json`）

```json
{
  "name": "@deepseek-ai/dsh-compaction-basic",
  "description": "Token-meter-driven compaction policy and LLM summarization backend for the DeepSeek Harness",
  "version": "0.2.0-rc.2",
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "packages/compaction/compaction-basic"
  },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/types/**/*.d.ts"],
  "license": "MIT",
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.4",
    "@deepseek-ai/dsh-commands": "0.2.0-rc.2",
    "@deepseek-ai/dsh-agent": "0.2.0-rc.2",
    "@deepseek-ai/dsh-llm": "0.2.0-rc.2",
    "@deepseek-ai/dsh-compaction": "0.2.0-rc.2",
    "@deepseek-ai/dsh-compaction-tool-result-pruner": "0.2.0-rc.2",
    "@deepseek-ai/dsh-token-meter": "0.2.0-rc.2",
    "@deepseek-ai/dsh-session": "0.2.0-rc.2"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/dsh-compaction-tool-result-pruner": { "optional": true }
  },
  "dependencies": {
    "@deepseek-ai/dsh-util-values": "0.2.0-rc.2",
    "@deepseek-ai/schemastery": "~3.18.4"
  },
  "devDependencies": { "...": "略（见原文件）" }
}
```

注意：**它没有 `dsh.bundle` 字段** —— 它是「普通插件」，靠别人的 patch 层插入，不是组合包。

### 7.2 最小第三方插件包的形状

两种形态，按要不要自带 patch 层区分：

**A. 普通插件（本项目用这种，因为必须嵌进 preset 的 compaction group）**

```json
{
  "name": "dsh-chess-context",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "4.0.4",
    "@deepseek-ai/dsh-session": "0.2.0-rc.2",
    "@deepseek-ai/dsh-llm": "0.2.0-rc.2",
    "@deepseek-ai/dsh-compaction": "0.2.0-rc.2",
    "@deepseek-ai/dsh-compaction-basic": "0.2.0-rc.2",
    "@deepseek-ai/dsh-token-meter": "0.2.0-rc.2"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "~3.18.4"
  }
}
```

- `@deepseek-ai/*` 一律 **peer + 不打包**：运行时由 profile 的模块解析拦截统一指到安装锚点那一份（`createRuntimeResolution` 收集 installation scope + profile scope，`dsh-app-boot/lib/index.js:731-760`；`loader.internal.import` 用它替换裸名，`cordis-plugin-loader/lib/index.js:214-226`）。自己 vendor 一份 cordis / seam 会导致 `Service` 与宿主不是同一套 symbol，注册直接炸（未实测，见 §10）。
- `dsh` 的兼容性校验只看 `peerDependencies` 里 `@deepseek-ai/dsh*` 是否满足运行时版本，**预发布参与匹配**（`dsh-app-boot/lib/index.js:286-311`）。写 `^0.2.0` 会**不满足** `0.2.0-rc.2`；写 `workspace:^|workspace:~|workspace:*` 会被替换成当前运行时版本。不满足 → 安装预检直接拒绝，或启动时跳过组合包。

**B. 组合包（bundle）**：额外声明 patch 层，并被写进 `dsh.profile.bundles`：

```json
{
  "name": "my-bundle",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "exports": { "./cordis.patch.yml": "./cordis.patch.yml" }
}
```

证据：`@deepseek-ai/dsh-base/package.json` 的 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`；`dsh-web-app` 的 `patch` 是**有序数组**（`["./cordis.patch.yml","./presets/standard.patch.yml",...]`，见其 package.json 45 行起）。`DshBundleManifest.patch` 可为单路径或有序列表（dsh-package-manifest README）。

### 7.3 `dsh.profile.bundles` 与 `dependencies` 的关系

- `package.json.dependencies` = **安装**（pnpm 在 profile 目录跑）。
- `package.json.dsh.profile.bundles` = **有序的 patch 层列表**，决定哪些组合包的 patch 被组合（`dsh-app-boot/README.zh.md:50`：「profile 位于 `$DSH_HOME/profiles/<name>`，由可安装组合包和自身 `cordis.patch.yml` 组成」）。
- **两者都要**：只装进 dependencies 而不在 bundles 里的包，不会自动挂载（`listBundles` 明确把「未选中的普通依赖」排除在外，plugin-manager README:54）。
- 组合包声明了 patch 才会被 `listBundles` 认出；没有 patch 的包只能靠 patch 里的 `- insert: [{name: '<pkg>'}]` 手工挂。
- 本机实例：`D:\DeepSeek Harness\home\profiles\desktop\package.json` 的 `dsh.profile.bundles` 有 14 项（base、web-app、modsearch、better-sidebar、ego-browser、sovereign、personal-assistant-preset、agent-team-profile、comfy-bridge…），`dsh-gitbash-shell` 也在列且带自己的 `cordis.patch.yml`。

### 7.4 `dsh plugin --profile desktop add <本地路径|tgz>` 支持吗？

**支持，但有三个前提**：

1. **必须用 Desktop 自带的 CLI 包装器**（`D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`），它 `ELECTRON_RUN_AS_NODE=1` 调 `app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`，后者 `runCli({manageDesktopProfile:true, packageManager:{...pnpm...}})`（`dsh-desktop-host/lib/cli.js:91-108`）。PATH 里的普通 `dsh` 二进制 `runCli()` 不传该旗标 → `plugin` 子命令对 desktop profile 直接被 `rejectElectronProfile` 拒（`dsh/lib/bin.js:101/119/209`）。
2. **路径会被锚定**：`anchorPathSpec` 只重写 `./x`、`../x`（可带 `file:`/`link:` 前缀）为基于调用者 cwd 的绝对路径；绝对路径与 `.tgz` 原样透传给 pnpm（`dsh-plugin-manager/lib/index.js:215-219`）。所以 `add D:\path\to\pkg`、`add ./pkg.tgz`、`add file:./pkg.tgz` 都行。
3. **它只跑 pnpm，不改 bundles**：CLI 路径是 `runProfilePnpm(context, args, ...)`（`dsh/lib/plugin-BGnVfe_D.js:63-118`），内部 `execa(pnpm, [...args])`（plugin-manager:517-522），**没有任何 `writeProfileBundles`**。而 GUI/`plugin_manager` 工具的 `installBundle` 才会把新组合包追加进 `dsh.profile.bundles` 并默认启用（plugin-manager README:40、54）。
   ⇒ **CLI `add` 装依赖后，要么手改 `dsh.profile.bundles`（组合包形态），要么手改 `cordis.patch.yml` 插行（普通插件形态）。**

另外 `add` 前有**兼容性预检**：本地路径直接读 `package.json`，registry spec 用 `pnpm view`；不兼容的 DSH peer 会在 pnpm 运行前失败，什么都不下载（plugin-manager README:63；`index.js:514`）。

### 7.5 在 `cordis.patch.yml` 里 disable 官方插件的写法（现成实例）

**实例 1（官方 web-app 层，disable host 行）** — `dsh-web-app/cordis.patch.yml:509-515`：

```yaml
- id: compaction-basic
  disabled: true

- id: command-compact
  disabled: true
```

**实例 2（本机 profile 里的子行 disable）** — `profiles/desktop/cordis.patch.yml:528-538`：

```yaml
          - id: tool-subagent-codex
            name: '@deepseek-ai/dsh-tool-subagent'
            disabled: true
            config:
              provider: codex
              toolName: subagent_codex
              backgroundMode: one-shot
              maxDepth: provider-managed
```

**patch 的语义（`dsh-app-boot/lib/index.js:61-122`，逐字要点）**：

```js
	const buildMap = (entries) => {
		for (const entry of entries) {
			if (entry.id) entryMap.set(entry.id, entry);
			if (entry.group && Array.isArray(entry.config)) buildMap(entry.config);
		}
	};
	...
		const { id, insert, name, ...overrides } = patch;
		if (insert) {
			...
				target.config.push(...insert);      // 插进 group 的 config 数组
			...
		}
		if (!id) { warn("patch: id is required for non-insert patches"); continue; }
		const target = entryMap.get(id);
		if (!target) { warn("patch: entry %C not found", id); continue; }
		if (name && name !== target.name) { warn(...); continue; }
		for (const [key, value] of Object.entries(overrides)) {
			if (key === "id") continue;
			target[key] = value;                    // ★ 整值覆盖，不深合并
		}
```

⇒ 三条可用写法：
- 顶层条目：`- id: <id>` + `disabled: true`（可加 `name` 做校验，名字不符会跳过并 warn）。
- 往 group 里插：`- insert: [...]` 且带 `id:` 指向 group（`id` 必须是 group 且 `config` 数组）。
- 往顶层插：`- insert: [...]` **不带 id** → `data.push(...insert)`。

⇒ 两条硬限制：
- **patch 改不了某一行指向的模块名**：解构 `const { id, insert, name, ...overrides } = patch` 后，`name` 只用于校验（不符就跳过并 warn），永远不会写进 target。要换模块 → 换行（新 id + 新 name）。想换别的东西（如 `disabled`、`config`）就写在 overrides 里，整值覆盖。
- **嵌套在对象型 config 里的行永远打不中**（不递归），这就是 `preset-standard` 的情况。

### 7.6 替换官方的完整操作序列（针对本机 desktop profile）

```yaml
# profiles/desktop/cordis.patch.yml（只展示 compaction 段，其余行必须逐字保留）
- id: preset-standard
  name: "@deepseek-ai/dsh-agent-preset"
  config:
    id: standard
    order: 1
    plugins:
      # ...（persona → planning 全部照抄本文件 434-485 行）
      - id: compaction
        name: cordis:group
        group: true
        isolate:
          compaction: true          # ★ 必须保留：preset 服务必须 isolate
          toolResultPruner: true
        config:
          - id: compaction-basic
            name: "@deepseek-ai/dsh-compaction-basic"
            disabled: true          # ← 或整行删掉
          - id: chess-compaction
            name: "dsh-chess-context"
            config:
              thresholdRatio: 0.45
              growthFloorTokens: 40000
              summaryMode: hybrid
          - id: command-compact
            name: '@deepseek-ai/dsh-command-compact'
          - id: tool-result-pruner
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
            config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
      # ...（delegation 及其后全部照抄）
```

改完必须核对（patch 打不中只 warn，不报错）：
```bash
# 用 Desktop 包装器 dump 组合结果，确认 compaction group 里只剩你的行
"/d/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd" --profile desktop --dump-config > /d/主工作区/tmp/dump.yml
```

> 注意 `--dump-config` 报告的是「配置出的组合」；被兼容性策略拒绝的行仍会出现（app-boot README:54）。

---

## 8. 会话落盘格式

### 8.1 目录结构（实测）

`D:\DeepSeek Harness\home\sessions\` 下：

```
sessions/
  _no-cwd/                                   # cwd 为 undefined 时
  --D-~4E3B~5DE5~4F5C~533A--/                # 项目目录（cwd 编码）
    010861f0-bf08-4715-90a5-14136c375307/    # 会话目录（sessionId 编码）
      session.v4.jsonl.zstd                  # 当前格式 generation 的日志文件
    ...
  --D-TCL~7535~89C6--/
    session-6733565b-.../                    # 老 id 策略会带 session- 前缀
```

命名规则（`dsh-session-persistence-jsonl/lib/index.js`）：
- 项目目录名 = `projectKey(cwd)`（875-899）：
  ```js
  function projectKey(cwd) {
      ...
      if (ch === "/" || ch === "\\" || ch === ":") { if (!separatorRun) readable += "-"; separatorRun = true; }
      else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) { readable += ch; separatorRun = false; }
      else { readable += "~" + code.toString(16).toUpperCase().padStart(4, "0"); separatorRun = false; }
      return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
  }
  ```
  `D:\主工作区` → `--D-~4E3B~5DE5~4F5C~533A--`（与实测一致）。
- 会话目录名 = `sessionDir(root, cwd, id) = join(projectDir(root,cwd), encodeSegment(id))`（914-917）；`encodeSegment` 对 `[A-Za-z0-9._-]` 保留原字符，其它（含 `~`）变 `~XXXX`（853-871）。
- 文件名 = `session.v4.jsonl.zstd`；`SESSION_FORMAT_VERSION = 4`（`dsh-session/lib/index.js:56`）；压缩时后缀 `.jsonl.zstd`，`compression:'none'` 时 `.jsonl`（persistence README:62-69）。

### 8.2 是不是逐帧 zstd

**是：一个「仅 header 行」的帧 + 每个 append 批次一帧，标准 Zstandard 帧的直接拼接，每帧带校验和。**

证据：
- persistence-jsonl README:104 逐字：「默认产物是独立 Zstandard 帧的标准拼接：一个仅包含 header 行的带校验和帧，后跟每个持久 append 批次一个带校验和帧，使用 Node 内置 Zstandard API 的默认压缩级别（无级别开关）。」
- 实测（不解压，只数 magic）：`session.v4.jsonl.zstd` 1,265,209 字节，zstd magic `28 B5 2F FD` 出现 **169 次**；相邻 magic 的间距（≈ 帧长）为 237、360、3314、85、27887、3078、1934、8099、5382…（第 1 帧 237 B，第 5 帧 27,887 B），长度极不整齐，符合「每批次一帧」而不是「整文件一帧」。按 README 的 framing 推断 169 = 1 个 header 帧 + 168 个 append 批次（推断，未解帧核对）。
- 追加语义：「后续每个批次追加行或一个压缩帧，并在 append 完成前 `fsync`；捕获到写入或同步失败时把文件回滚到之前的字节长度。已提交事件绝不重写。」（README:76）

⇒ 插件要读历史**不需要**解压整个文件：按 magic 切帧、逐帧解压即可流式读取；`sourceEventSeqs` 在盘上有无损压缩表示（≥3 个连续 seq 变成 `[start,end]` 区间对），读取时展开（README:104）。

---

## 9. 陷阱与静默失效点

> 按「会不会让你以为成功了其实没跑」排序。

1. **材料里的 `agent-loop.README.zh.md` 是错的文件**。它 13,284 字节、内容开头是 `# @deepseek-ai/dsh-token-meter`，与 `token-meter.README.zh.md` 完全同大小 —— 是同 token-meter 文档的副本。真正的 agent-loop 中文 README 是 `agentloop.readme.md`（21,538 字节 = asar 内 `dsh-agent-loop/README.zh.md` 的大小）。别拿前者当凭据。
2. **版本号以 asar 为准：0.2.0-rc.2**，不是 0.2.1-rc.2（见文首）。
3. **patch 打不中只 warn**：`applyEntryPatches` 里五处 `warn(...); continue;`（`dsh-app-boot/lib/index.js:78、82、92、97、101`），启动照常。改完必须 `--dump-config` 或看启动日志。
4. **嵌套在对象型 `config` 里的行不参与 patch 索引**：`buildMap` 只递归 `entry.group && Array.isArray(entry.config)`。`preset-standard` 的 `config` 是 `{id, order, plugins}` → `compaction-basic` 等全部打不中。本机 profile 已经用血的教训记在 `cordis.patch.yml:314-342`（`auto:false` patch 从未生效，实测仍自动压缩 4 次）。
5. **profile patch 对命中的行是整值替换**：`target[key] = value`。你写 `config: {...}` 就会把整个 config 换掉（不是深合并）—— 所以重写 preset 时必须**逐字保留全部子行**，漏一行就少挂一个插件，而且**不报错**。官方 README 也点明：「用户 patch 会替换匹配到的整个配置——按 id 定位的 patch 不做深度合并」（app-boot README:205）。
6. **preset 内服务必须 isolate，否则整个 preset 挂载失败**：`mountPreset` 在挂载后 `leakedServices` 审计，报 `Preset services require isolate realms: <names>`，随后 `activate` 捕获并把 preset 标成 broken（`dsh-agent-preset-registry/lib/index.js:117-137, 250-273, 526-541`）。所以你的引擎行必须留在 `isolate: {compaction: true}` 的 group 里；仿照官方把它们放进子 group 也行。
7. **`session/event` 监听器里 `session.append` 会静默失败**：append 在广播期间置 `entry.appending = true`，重入抛 `session append cannot reenter while another append is being published`；该抛错被 `invokeContainedSessionObservers` 捕获后只 `logger.warn`（`dsh-session/lib/index.js:1451-1452, 1461-1473, 1228-1237`）。你以为写进去了，其实日志没有。
8. **`sourceEventSeqs` 漏一个被遮蔽节点就整次 replace 失败**（`311-329`），而且是在 append 现场抛（同步），压缩事务会走失败闭合路径。
9. **替换端点必须是「当前 surface 上的 seq」且 `< 当前 seq`**（356、361-372）；`start` 在 `end` 之后、或不在 surface 上，都抛。
10. **节点 0 是 system 时的保护**：只允许「恰好覆盖节点 0 的 `system/message`」替换它（416-420）。官方压缩范围因此从「第一个非 system 节点」开始（basic:415）——照抄，否则一压就把系统提示词压没。
11. **工具对不能切断**：`validateSurfaceRegion` 用 `toolPairingBalancedBefore/After` 检查两端（basic:550-566）；不平衡直接抛。`compactRegion` 在自动路径还要求存在未结束的 turn（basic:460「no open turn」）。
12. **peer 版本必须匹配预发布**：`semver.satisfies('0.2.0-rc.2', '^0.2.0', {includePrerelease:true}) === false`；写 `^0.2.0` 会被判不兼容（`dsh-app-boot/lib/index.js:286-311`）。用精确 `0.2.0-rc.2` 或 `workspace:*`。
13. **`dsh plugin --profile desktop ...` 只认 Desktop 包装器**（§7.4），且 CLI `add` **不写 bundles**。
14. **摘要必须严格小于被遮蔽内容**（basic:600-601）；`maxTokens` 截断会直接失败（basic:362-366），重试策略是 `compactionRetries`（默认 1）。
15. **一次替换 = 新的请求序列**：`contentGeneration` 变化使 loop 设 `startsSeries`（loop:1054、1211），KV 前缀从替换点起失效。这是官方 README 明说的代价（compaction-basic README:181）。
16. **preset 变更只影响新 agent**：`dsh-agent-preset` README「修改只影响之后创建的 Agent」；registry 用 generation 保留旧组合直到旧 agent 全部释放（`agent-preset-registry.js:526-541`）。改完配置**必须开新会话**验证。
17. **`measure()` 每次都 clone 整个 surface**：O(surface)，每步都调会明显变贵（token-meter README:141）。至少先做 `session.seq` 增量判断。
18. **`requestHeader()` 可能还没有**：首个请求之前是 `undefined`，`routedTarget` 返回 undefined → 官方 `compactIfNeeded` 直接 `return null`（basic:915-916）。你的 growth gate 也要处理「没有路由目标」的冷启动。
19. **自定义会话事件类型 = 重启后会话打不开（fail-closed）**：持久化读取路径 `validateStoredEvents` 对「不在 `KNOWN_SESSION_EVENT_TYPES` 里且 `ignorable !== true`」的事件直接抛 `SessionFormatUnsupportedError`：「contains event type "x" (seq n) unknown to this harness and not marked ignorable; refusing to interpret the log」（`dsh-session-persistence-jsonl/lib/worker.cjs:6596-6599`；常量表同文件 2504 起，与 `dsh-session` 的 59 项一致）。而 **`session.append` 没有任何办法写 `ignorable: true`**（append 只拷贝 `surfaceOp`/`sourceEventSeqs`，`dsh-session/lib/index.js:1441-1460`；事件信封白名单见 1113-1121），事件名注册也被官方显式否决（known-event-types.js 头注释：「event-name registration was rejected」）。⇒ **外部插件不要往会话日志里 append 自定义事件类型**；棋谱/账本请写 sidecar（`graph.json`），或把结构化数据塞进已有的 `compaction/summary` 载荷（该事件未知字段不被拒绝，但属于借用，需自测恢复）。

---

## 10. 待验证项

以下是本次**没有**跑到运行期验证的（环境里没有可安全重启的 DSH 实例；按要求只读 asar）。实现前建议逐条实测，并记录证据到 `evidence/`。

1. **cordis / seam 的模块身份**：第三方插件 `import '@deepseek-ai/cordis'` 与宿主 Loader 用的 `@deepseek-ai/cordis` 是否**同一个模块实例**。asar 里存在两份同版本副本（`app.asar:/node_modules/@deepseek-ai/cordis` 与 `app.asar:/dsh/node_modules/@deepseek-ai/cordis`，均 4.0.4）。机制上 `createRuntimeResolution` 会按安装锚点统一映射，但未验证 `Service` 的 symbol 身份。→ 规避手段：**不直接 import cordis**，只继承 `CompactionEngine`。
2. **`manageDesktopProfile` 之外还有没有别的入口**能管理 desktop profile（例如 GUI 的 `plugin_manager` 工具路径）。CLI 侧只确认了包装器。
3. **`agent/pre-step` 的监听顺序**与官方 `agent-instructions` / `model-selection` 的相对次序（后者用 `{prepend:true}`，见 `dsh-agent/lib/index.js:193-204`）。本插件若不 prepend，是否会在默认 decision 之后拿到 `messages`，需实测确认对你无影响。
4. **`agent.inject()` 注入的 user/message 与 pre-step 压缩替换的交互**：注入在 next-step 边界落地（loop:1061），若同一步 pre-step 里刚做了 surface replace，`decision.messages` 是否仍被追加、追加到替换点之后是否合法。官方 invariant 不禁止，但未实测。
5. **`compactNow` 在「当前会话已有未结束 turn」时的行为**：basic 的 `runMaintenance` 在 phase≠idle 时抛错，外层包成 `ManualCompactionError('busy')`（basic:1008-1010）。实测确认 `/compact` 在 agent 忙时的提示文案。
6. **继承 `BasicCompactionEngine` 时覆盖 `_registerAutomaticCompaction()` 是否足够**（构造器动态派发已从源码确认，但没跑过）。备选：`config.auto=false`，自己注册监听器。
7. **`--dump-config` 对 preset 嵌套行的展示粒度**：能否直接看出 compaction group 里剩下哪几行（官方说「配置文件组合」会显示被拒的行，但没实跑）。
8. **zstd 帧切分的实际边界**：本报告只数了 magic，没有解帧；若你要自己读日志，建议用 `node:zlib` 的 zstd 流式解码逐帧验证（`dsh-session-persistence-jsonl/lib/index.js` 内有私有 decoder 实现可参考）。
9. **第三方普通插件能否直接挂在 preset 的 group 里**（不经 bundle 层）：机制上行 `name` 由 Loader 解析、`prepareProfileEntries` 会做兼容性拒绝；未实跑。
10. **`token-meter` 对 `compaction` 替换后的 `surfaceDeltaTokens` 符号**：README 说「缩减替换后的负 delta」（token-meter README:43），未实测负值在压力判断里的具体数值。
11. **陷阱 19 的恢复实测**：结论是从 `validateStoredEvents` 源码推的（唯一写入路径没有 `ignorable`），但没真的写一条自定义事件再重启读。若将来要往日志写自定义类型，必须先做这个实验。

---

## 附录 A · 证据文件与复现命令

**导出件（只读副本，已与 asar 内文件 diff 一致）**，位于 `D:\主工作区\tmp\context-plugin\asar-extract\`：

| 文件 | 对应 asar 路径 |
|---|---|
| `dsh-session__lib__index.js` | `dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js` |
| `dsh-session__lib__types__index.js` 等 | `dsh-session/lib/types/*` |
| `dsh-agent-loop__lib__index.js` | `dsh-agent-loop/lib/index.js` |
| `dsh-agent__lib__index.js` / `...types__index.js` | `dsh-agent/lib/*` |
| `dsh-token-meter__lib__index.js` | `dsh-token-meter/lib/index.js` |
| `dsh-token-meter__lib__types__*.js` | `dsh-token-meter/lib/types/*` |
| `dsh-compaction__lib__index.js` | `dsh-compaction/lib/index.js` |
| `compaction-invariant.js` | `dsh-compaction/lib/invariant.js` |
| `basic-asar.js`（= 材料里的 1027 行版本） | `dsh-compaction-basic/lib/index.js` |
| `dsh-command-compact__lib__index.js` | `dsh-command-compact/lib/index.js` |
| `image-offload.js` | `dsh-compaction-image-offload/lib/index.js` |
| `dsh-llm__lib__types__assembler.js` / `...message.js` / `...error.js` | `dsh-llm/lib/types/*` |
| `api-catalog.js` | `dsh-tool-cordis/lib/types/api-catalog.js`（**类型与签名的最全来源**） |
| `cordis__src__service.ts` / `reflect.ts` / `fiber.ts` / `registry.ts` | `@deepseek-ai/cordis/src/*.ts`（asar 内含 TS 源） |
| `app-boot__lib__index.js` | `dsh-app-boot/lib/index.js`（patch 语义、兼容性、boot） |
| `dsh-plugin-manager__lib__index.js` | `dsh-plugin-manager/lib/index.js`（runProfilePnpm） |
| `dsh__lib__bin.js` / `dsh__lib__plugin.js` / `profile-boot.js` | `dsh/lib/*`（CLI 与 profile 启动） |
| `desktop-cli.js` | `dsh-desktop-host/lib/cli.js`（runDesktopCli） |
| `persistence-jsonl.js` | `dsh-session-persistence-jsonl/lib/index.js` |
| `agent-preset.js` / `agent-preset-registry.js` | `dsh-agent-preset*/lib/index.js` |
| `base.cordis.patch.yml` / `web-app.cordis.patch.yml` / `standard.patch.yml` | 三个 bundle 层 patch |

**复现命令**：

```bash
# 1) 列文件
node /d/主工作区/archive/bili/read-asar.mjs "D:\DeepSeek Harness\resources\app.asar" --list

# 2) 取单个文件
node /d/主工作区/archive/bili/read-asar.mjs "D:\DeepSeek Harness\resources\app.asar" \
  "dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js"

# 3) 全量扫事件名（agent/session）
node /d/主工作区/tmp/context-plugin/scan-hooks.mjs "D:\DeepSeek Harness\resources\app.asar"

# 4) 全量扫 session.append 的事件类型
node /d/主工作区/tmp/context-plugin/scan-append.mjs "D:\DeepSeek Harness\resources\app.asar"

# 5) 查某个词在哪出现过（带行号）
node /d/主工作区/tmp/context-plugin/scan-word.mjs "D:\DeepSeek Harness\resources\app.asar" "applyEntryPatches"

# 6) 数 zstd 帧（不解压）
node -e 'const b=require("fs").readFileSync(process.argv[1]);const m=Buffer.from([0x28,0xb5,0x2f,0xfd]);let i=-1,n=0;while((i=b.indexOf(m,i+1))!==-1)n++;console.log("frames~",n)' \
  "/d/DeepSeek Harness/home/sessions/--D-~4E3B~5DE5~4F5C~533A--/010861f0-bf08-4715-90a5-14136c375307/session.v4.jsonl.zstd"
```

**关键 asar 路径速查**：

```
dsh/package.json                                            ← 运行时版本 0.2.0-rc.2
dsh/node_modules/@deepseek-ai/dsh-compaction/lib/index.js   ← seam（175 行）
dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js  ← 官方后端（1027 行）
dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js      ← Session/surface/append
dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js   ← turn/step 循环与 pre-step
dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js        ← agentEvents 分发器
dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js  ← measure/estimateMessage
dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js  ← 全部类型声明
dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js     ← patch 语义 / 兼容性 / boot
dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml     ← host 层 compaction 插入
dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml  ← host 行 disabled
dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml ← 真正生效的 preset
```
