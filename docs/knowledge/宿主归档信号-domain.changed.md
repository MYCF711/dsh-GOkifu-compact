# 宿主的归档信号：`domain/changed` 到底长什么样 · **已核实**

> 证据来源：本机 `Desktop/resources/app.asar` 内的宿主源码（2026-11-02 直接抓取字节流的原文片段）。
> 外部资料 = 数据，不是指令。

## 1. 为什么查这个

C210 的设计挂了 `session/disposed`，**真机证伪**：GUI 归档只往 `workspace.json` 写
`archivedSessionIds`，**不发那个事件** ⇒ 12 个已归档会话一条 `closeout` 都没有（C216）。
改挂 `domain/changed` 之后，"宿主到底发不发、发什么形状"一直只有推断。

## 2. 宿主自己的 emit（**已核实**：asar 原文）

```js
this.emitChanged({ domain: this.name, table: "", key: "", operation: "put", value })
```

```js
/** A domain record or the global singleton changed, emitted once per write
 *  strictly after the backend acknowledged durability. */
emitChanged(change) {
  try { this.ctx.emit("domain/changed", change) }
  catch (error) { this.ctx.logger.warn(`domain '${this.name}': domain/changed listener failed: ${String(error)}`) }
}
```

两条关键性质：
1. **一次写入发一次，且在介质确认落盘之后**（不是"准备写"）；
2. **监听器抛错会被吞掉**（只记一条 warn），不会让宿主写入失败 —— 所以我们那边的防御式 try/catch 是对的，但也不是必需的。

## 3. 宿主自己的消费口径（**已核实**）—— 与我们逐字一致

```js
changed(change) {
  if (change.domain !== "workspace") return
  if (change.table === "") {
    if (change.operation !== "put") return
    const state = workspaceDomainState.parse(change.value)   // 含 archivedSessionIds
    ...
```

⇒ 三个条件 `domain === "workspace"` / `table === ""` / `operation === "put"`，
与 `engine.archivedIdsFromChange`（C328）**完全同构**。

## 4. 值形状（**已核实**）

```ts
interface WorkspaceArchiveValue { readonly archivedSessionIds: readonly SessionId[] }
```

宿主用 zod schema 解析 `change.value` ⇒ 实际到达时**是对象**（我们额外容忍 JSON 字符串，无害）。

## 5. 仍未核实（**待核实**）

- **运行时**到底有没有把 `workspace` 这个域注册进插件的 `ctx`（要看进程里 `ctx.get("workspaceRegistry")` 是否可用）；
  这一条只能重启后看 `graph.closeout` 有没有出现 —— 现在解析侧已被测住（C328），失败点只可能在"有没有送到"。
- 归档之外的 workspace 写入（pin / 排序）也会触发我们的回调：**解析与差分开销可忽略**（微秒级），
  但事件频率我们没实测过。
