# 测绘：UI 声明下沉（现状盘点 + 下沉清单）

> **时点**：`main@6f77089`（2026-11-26）。本文**只读**，未改 `src/` `lib/` `test/` `scripts/`。
> **任务**：按 `docs/方案-繁复收敛.md` §3 的五条动作，把「现在的 UI 是怎么长出来的」钉死，给出下沉到各房间的清单。
> **复现方式**：每一节末尾的命令都在仓库根目录跑过，输出**逐字粘贴**。

---

## 0 结论摘要（先看这 7 条）

1. **没有路由表，只有一条路由。** `src/ui.mjs` 里**不存在** `if (path === ...)`、也不存在 `switch`；全部 HTTP 面是**一个** `{kind:"prefix", path:"/gokifu/api"}` 注册 + handler 内一串 `if (action === "...")`（8 个 action）。另有 1 处**兜底路由**注册同一路径（初始化失败时回 500）。
2. **`src/ui.mjs` 2133 行 = 7 件事**，不是 AGENTS 记的「HTTP + 配置文件读写」两件：①插件元信息/常量 ②home 解析 + preset 发现 ③会话态聚合（图扫描/折痕/今日/费用）④健康自检 ⑤模型目录 ⑥版本检查 ⑦HTTP+配置读写（其中还含 CSRF 校验、备份轮转、面板字段口径、路由心跳诊断两件独立的事）。
3. **口径已经对不上了 —— 但方向和任务书写的相反。** 实测 `SCHEMA` **33** 键 / `FIELDS` **23** 键（不是 23/15）。`只在 FIELDS` **0 条**，`只在 SCHEMA` **10 条**，`label/type/options 不一致` **0 条**。
4. **真正对不上的是三样东西，都不是键名：** ①**数值范围** 5 处不一致（3 处 host 更严 ⇒ 面板放行的值会被 400）；②`thresholdRatio` **两套取值域**（host 连续 `[0.05,0.95]`，client 硬编码 5 档 + 客户端硬拒）；③**取整规则把比例键取成整数** —— `firstFoldRatio: 0.9` 经 host 变成 `1`（面板可达，且越界）。**这三条才是「假 UI / 文本填进去不是真生效」的实证。**
5. **host 已经把「声明式数据」算好了，client 全都没读**：`state` 里 16 个字段，`fieldLabels` / `configItems` / `presetConfig` / `configOrigins` / `unconfiguredKeys` / `version` **6 个字段在 `lib/client.js` 里出现 0 次**。UI 的字段表、标签、档位、页签全部是 client 手写的第二份。
6. **一个键已经掉在缝里**：`autoArchiveBackfill`（引擎 `engine.mjs:737` + `ui.mjs:102` 两处各定义一次，**不在** `SCHEMA`），它才决定后台补折是否启动；面板唯一的「自动补账」勾选写的是 `autoBackfill`（`SCHEMA` 键），**单独写它不够**。⇒ 面板上那个开关，用户勾了也可能不生效。
7. **需要 `ui` 声明的房间 = 13 个**（28 个房间中），其中 **12 个有实际渲染项**、1 个（`fact-guard`）只需要一条「实验键不许上 UI」的声明；判据见 §5。

---

## 1 现在的 UI 是怎么长出来的（两条半）

「插件自己注册 UI」在本仓已经是**既成事实**，只是注册的是**壳**，不是**字段**。

### 1.1 浏览器半：注册进两个官方 slot（形状对）

`lib/client.js` 是 classic script bundle，`exports` 形状是 `{name, inject:["slots"], apply}`，注册两个 slot：

```
$ sed -n '1650,1659p' lib/client.js
```

```
    function apply(ctx) {
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          { name: "sidebar.panellist", id: PANEL_ID, order: 30, label: () => "上下文压缩" },
          Icon,
        ));
      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID }, Page));
    }

    exports.name = "gokifu-compact-ui";
    exports.inject = ["slots"];
```

⇒ 「UI 在插件自己注册」这件事**已经做到了**。缺的是「**声明**」：`Page` 内部的一切几何、字段、标签、档位都是画出来的。

### 1.2 host 半：一条 prefix 路由 + 8 个 action

```
$ grep -n 'kind: "prefix"\|path: "/gokifu/api"' src/ui.mjs
```

```
1546:    kind: "prefix",
1547:    path: "/gokifu/api",
1585:    kind: "prefix",
1586:    path: "/gokifu/api",
```

两条都是**同一个路径**：1585 是主 route，1546 是 `registerFallbackRoute` 的兜底（面板初始化失败时回 500 而不是 404）。

```
$ grep -n "action ===" src/ui.mjs
```

```
1601:        if (action === "state") {
1638:        if (action === "update") {
1645:        if (action === "backfill-subagent") {
1690:        if (action === "backfill") {
1880:        if (action === "models") {
1884:        if (action === "defaults") {
1887:        if (action === "save") {
1891:        if (action === "health") {
```

⇒ **判定依据**：本仓的「路由」是**一个前缀注册 + action 字符串派发**，不是 `if (path === ...)`、不是 `switch`、没有路由表。所以「把 UI 声明下沉到房间」时**不需要动 HTTP 面**，只需要让 action handler 去房间取声明。

### 1.3 第三半：`state` 已经把声明式数据送到浏览器了，浏览器不读

```
$ for f in profile version config presetConfig configOrigins unconfiguredKeys defaults fieldLabels configItems configFile latest foldMarks today health models update; do echo -n "$f: "; grep -c "\b$f\b" lib/client.js; done
```

```
profile: 6
version: 0
config: 13
presetConfig: 0
configOrigins: 0
unconfiguredKeys: 0
defaults: 2
fieldLabels: 0
configItems: 0
configFile: 1
latest: 16
foldMarks: 2
today: 14
health: 12
models: 57
update: 29
```

**6 个字段在浏览器半出现 0 次**（`version` / `presetConfig` / `configOrigins` / `unconfiguredKeys` / `fieldLabels` / `configItems`）。
其中 `fieldLabels`（host 已由 R15 生成的 23 条中文名）与 `configItems`（`autoArchiveBackfill` 的唯一暴露口）**正是下沉后要用的两个**。今天的形状是：**host 算好了、发出去、浏览器丢掉、浏览器自己再手写一份**。

> 顺带一个**注释失效**证据：`src/ui.mjs:82-84` 的注释说 `readVersion()` 为 null 会让「页面标题渲染成 `v?`（`lib/client.js:197` 的 `v${state?.version ?? "?"}`）」——但 `lib/client.js` 里 `version` 出现 **0** 次，页面标题是写死的 `"上下文压缩"`（`lib/client.js:1406`）。这条注释解释的机制已经不存在了。

---

## 2 `src/ui.mjs` 2133 行的段落测绘

区间**互不重叠**，覆盖 1–2133。中间的空行单独列为「杂项」（共 15 行分隔空行）。

| # | 件事 | 行区间 | 主要符号 | 判定依据（怎么认出来的） |
|---|---|---|---|---|
| A | 模块头 + 依赖 + 插件元信息 + 常量 | 1–113 | `name` / `inject` / `DEFAULTS` / `AUTO_ARCHIVE_BACKFILL_CONFIG` / `CONFIG_ITEMS` / `uiDefaults` | 1–53 是文件头注释；54–75 是 `import`（含 8 条 `./rooms/*` 依赖）；88/92 是插件 `name`/`inject`；99/102/109 是三个 `Object.freeze` 常量 |
| B | home 解析 + preset 文件发现 | 115–216 | `resolveHome` / `findPresetFiles` | `resolveHome` 读 `process.env.DSH_HOME` 后回落 `~/.dsh`；`findPresetFiles` 走 `readProfileBundles` + 扫 `profiles/*/cordis.patch.yml`，返回 `{name,file,text}` |
| C | **会话态聚合**（图扫描 / 折痕 / 今日 / 费用估算） | 218–622 | `GRAPH_CACHE` / `collectGraphFiles` / `graphSummary` / `latestGraphFrom` / `foldMarksForUi` / `latestFoldMarksFrom` / `PRICE_USD_PER_MTOK` / `estimateFoldCostUsd` / `todayAggregateFrom` / `scanGraphs` | 段首有显式横幅注释「棋谱扫描/解析缓存（P4：首屏 state 性能）」（218）；全部函数只吃 `scan` 或 `foldMarks`，不碰 `res`/`req`/preset |
| D | 请求档位 + 健康自检 | 624–679 | `profileFromRequest` / `health` | `profileFromRequest` 只从 body 取 `profile` 并挡 `../`；`health` 返回 `{installed,mounted,singleInstance,notInBundles,profile,presets[]}` 全布尔/列表，不写盘 |
| E | 模型目录（只读宿主 `llm`） | 681–806 | `CATALOG_CALL_TIMEOUT_MS` / `withinBudget` / `contextWindowOf` / `modelCatalog` | 段首横幅「模型目录（U1）：只读宿主，不存凭据」（681）；唯一外部调用是 `llm.listProviders/listModels/resolveModelInfo` |
| F | 版本检查（只读 registry） | 808–1045 | `parseVersion` / `compareVersions` / `versionRelation` / `cachedUpdate` / `checkUpdate` | 段首横幅「版本检查（U5）：只读 registry，绝不安装」（808）；只 `fetch` npm packument，注释明写「只拼一条给人执行的命令」 |
| G | HTTP 基础（读体 / 写响应） | 1047–1077 | `readBody` / `sendJson` | 两个函数签名分别是 `(req)` 和 `(res, status, payload)`，无业务 |
| H | **配置文件读写 ①**：备份/staging 常量 + pending 感知读 | 1079–1092 | `BACKUP_KEEP` / `BACKUP_MARK` / `PENDING_SUFFIX` / `readPresetTextOrNull` | 常量名全带 `BACKUP`/`PENDING`；`readPresetTextOrNull` = `pending 优先，否则原文` |
| I | **HTTP 路由层**：请求可信度（CSRF） | 1094–1252 | `SECRET_KEY_RE` / `SECRET_VALUE_RE` / `canonicalHostname` / `parseAuthority` / `isLoopbackHostname` / `isJsonContentType` / `checkRequestTrust` / `findSecretLike` | 段首横幅「请求可信度（CSRF 防护）」（1079，**该横幅实际打在 H 的内容上**，H/I 分界是我按内容重划的）；`checkRequestTrust` 返回 `{ok,status,reason,mode}`，只判 Host/Origin/Sec-Fetch-Site |
| J | **配置文件读写 ②**：备份轮转 | 1254–1281 | `listBackups` / `pruneBackups` | 都只操作 `<preset>.bak-before-ui-*` 文件 |
| K | **面板字段定义**（中文名 / 生效值 / patch 规整） | 1283–1372 | `FIELD_LABELS` / `uiFieldLabels` / `describeConfig` / `sanitizePatch` | `FIELD_LABELS = Object.freeze(fieldLabels())`（R15 派生）；`describeConfig` 产出 `{effective,origins,unconfiguredKeys}`；`sanitizePatch` 产出 `{patch,skipped}`。**这三个正是「页面上该有哪些字段、叫什么、能填什么」的口径** |
| L | **配置文件读写 ③**：`saveConfig`（唯一写入面） | 1373–1459 | `saveConfig` | 只有它 `writeFileSync` 到 preset（经 `renderEngineBlock` 文本级块替换）+ 轮转备份 + 返回 `{changed,backup,restartRequired,effectiveConfig}` |
| M | 配置自愈（用户层 patch 遮蔽时登记 home 层） | 1461–1502 | `scheduleHomePatchHeal` | 只做 `planHomePatch`/`healHomePatch` 接线，退出钩子里写 home 层一次 |
| N | 路由注册与挂载（幂等 + 兜底） | 1504–1556 | `ensureUiRoute` / `apply` / `registerFallbackRoute` | 三个都是「把 route 交给 `ctx.webServer.register`」的外壳，`ctx.effect(...)` 包一次 |
| O | **HTTP 路由 handler**：`applyInner`（action 派发 + state 组装） | 1558–1967 | `applyInner` | 唯一含 `req.method`/`checkRequestTrust`/`readBody`/`sendJson` 的 400 行长函数；1601–1891 是 8 个 action |
| P | 路由心跳诊断 | 1969–2124 | `routeHeartbeatFile` / `ROUTE_HEARTBEAT_VERDICT` / `pidAlive` / `judgeRouteHeartbeat` / `readRouteHeartbeat` | 全部围绕 `route-heartbeat.json` 的读/判，返回 `{state,reason,hint}` 供 doctor 用 |
| Q | 版本读取 | 2126–2133 | `readVersion` | 读 `../package.json` 的 `version`，catch 吞成 `null` |
| — | **杂项**：段间分隔空行 | 114, 217, 623, 680, 807, 1046, 1078, 1093, 1253, 1282, 1460, 1503, 1557, 1968, 2125 | — | 共 **15** 行，相邻两段之间恰好一行空行 |

> **`state` 的 16 个字段全在 O 里组装**（`src/ui.mjs:1611-1635`）：
> `profile / version / update / config / presetConfig / configOrigins / unconfiguredKeys / defaults / fieldLabels / configItems / configFile / latest / foldMarks / today / health / models`。
> ⇒ 这就是下沉时要改的那**一处**：这 16 个字段的来源从「O 内联算」变成「向 13 个房间要 `ui` 声明后汇总」。

**类别小计（严格分区，行数逐段相加，合计 = 2133）**

| 件事 | 由哪几段构成 | 行数 |
|---|---|---:|
| **HTTP 路由** | G(31) + I(159) + N(53) + O(410) | **653** |
| **配置文件读写** | H(14) + J(28) + L(87) + M(42) | **171** |
| **面板字段定义** | K(90) | **90** |
| **会话态聚合** | C(405) | **405** |
| **preset 处理** | B(102) —— 注意：`preset 文本的读/写` 横跨 B/H/J/L/M，属**横切关注点**，不单独占区间 | **102** |
| 其余（插件元信息 / 健康 / 模型目录 / 版本检查 / 心跳 / 版本读取） | A(113) + D(56) + E(126) + F(238) + P(156) + Q(8) | **697** |
| 杂项（空行） | 15 行 | **15** |
| **合计** | | **2133** ✅ |

> **口径说明**：「preset 处理」**不是一段连续区间**，而是分散在 B（发现文件）/ H（pending 感知读）/ J（备份轮转）/ L（写回）/ M（home 层登记）五处的**同一职责**。这是本次测绘最重要的形状判断：**`ui.mjs` 是按「技术手段」分段（HTTP / 文件 / 扫描 / 目录），不是按「职责」分段** —— 同一件事被 HTTP 面切成五块，这也是它必须下沉的原因。

复现命令：

```bash
awk '/^function |^const |^export |^async function |^let |^class /{print NR": "$0}' src/ui.mjs   # 顶层符号清单（本文表格的骨架）
grep -n 'kind: "prefix"\|path: "/gokifu/api"' src/ui.mjs                                        # 只有 2 条注册、同一条路径
grep -n 'action ===' src/ui.mjs                                                                  # 8 个 action，无 switch
sed -n '1611,1635p' src/ui.mjs                                                                   # state 的 16 个字段
```

---

## 3 FIELDS（client）vs SCHEMA（R15）逐键比对

### 3.1 先纠正引用口径（任务书给的是旧数）

| 口径 | `SCHEMA` | `PRESET_KEYS` | `FIELDS` | 出处 |
|---|---:|---:|---:|---|
| 任务书 / `docs/方案-繁复收敛.md:61-62` | 23 | — | 15 | 「`FIELDS`（15 键）里又抄了一遍 `config-schema.mjs`（23 键）」 |
| `AGENTS.md` §1 / §1.1 | 23 | 16 | 15 | 「`config-schema.mjs` = `SCHEMA` 23 键 / `PRESET_KEYS` 16 / `BASE_KEYS` 11」 |
| **实测（本文）** | **33** | **23** | **23** | 见下方命令 |

```bash
node --input-type=module -e '
import s from "node:fs";
const fs = await import("node:fs");
const c = await import("./src/rooms/config-schema.mjs");
const n = (fs.readFileSync("lib/client.js","utf8").match(/^\s{6}\{ key: "/gm) ?? []).length;
console.log("SCHEMA=" + c.SCHEMA.length, "PRESET_KEYS=" + c.PRESET_KEYS.length, "BASE_KEYS=" + c.BASE_KEYS.length, "FIELDS=" + n);
'
```

```
SCHEMA=33 PRESET_KEYS=23 BASE_KEYS=11 FIELDS=23
```

唯一与本仓当前事实一致的是 `docs/配置总表.md`（**自动生成**，`共 **33** 项`）——它是 `scripts/config-table.mjs` 从 `SCHEMA` 生成的，`test/config-table.test.mjs` 会钉住。
⇒ **手写的数字（方案文档、AGENTS）已经漂移，生成的数字没漂移**。这本身就是「UI 声明必须由代码生成、不许手写」的同类证据。

### 3.2 三张清单

```bash
node --input-type=module -e '
import fs from "node:fs";
import { SCHEMA } from "./src/rooms/config-schema.mjs";
const L = fs.readFileSync("lib/client.js", "utf8").split("\n");
const FIELDS = L.slice(785, 813).filter((l) => l.trim().startsWith("{ key:")).map((l) => new Function("return " + l.trim().replace(/,\s*$/, ""))());
const sk = SCHEMA.map((s) => s.key), fk = FIELDS.map((f) => f.key);
console.log("SCHEMA=" + sk.length, "FIELDS=" + fk.length);
console.log("只在FIELDS: " + JSON.stringify(fk.filter((k) => !sk.includes(k))));
console.log("只在SCHEMA: " + JSON.stringify(sk.filter((k) => !fk.includes(k))));
for (const k of sk.filter((x) => fk.includes(x))) {
  const s = SCHEMA.find((x) => x.key === k), f = FIELDS.find((x) => x.key === k);
  const d = [];
  if (f.label !== s.label) d.push("label");
  if (s.values && JSON.stringify(f.options ?? null) !== JSON.stringify(s.values)) d.push("options");
  if (s.type === "number" && Array.isArray(s.range) && (f.min !== s.range[0] || f.max === undefined || f.max !== s.range[1])) d.push("range:client[" + f.min + "," + f.max + "] vs schema[" + s.range + "]");
  if (d.length) console.log(k + " => " + d.join(" ; "));
}
'
```

```
SCHEMA=33 FIELDS=23
只在FIELDS: []
只在SCHEMA: ["retainTokens","compactionRetries","maxOverflowRetries","modelPolicies","hotLedgerMinEvents","hotLedgerMinFailureDelta","hotLedgerTraceRoot","graphDir","worldHashMaxFiles","factGuard"]
thresholdRatio => range:client[undefined,undefined] vs schema[0.05,0.95]
firstFoldRatio => range:client[0,0.9] vs schema[0,0.95]
headroomTokens => range:client[0,1048576] vs schema[0,512000]
closeoutMinEvents => range:client[0,10000] vs schema[1,10000]
closeoutTimeoutMs => range:client[0,600000] vs schema[1000,600000]
```

**清单一：只在 `FIELDS`（client 有、SCHEMA 没有）—— 0 条。**
好处：不存在「面板凭空长出一个 host 不认识的键」。这一条 AGENTS §2.6 / 方案 §3 担心的形态**今天不成立**。

**清单二：只在 `SCHEMA`（host 有、面板没有）—— 10 条。** 逐条给出「面板看不见」的性质：

| # | 键 | `where` | 为何面板没有 | 面板看不见的后果 |
|---|---|---|---|---|
| 1 | `retainTokens` | engine | `PRESET_KEYS` 不含它 | 只能手改 preset / 走 `config:` 块；无 UI 是**正确**的（与 `retainRatio` 互斥） |
| 2 | `compactionRetries` | engine | 宿主消费，本插件不读 | 无 UI 合理 |
| 3 | `maxOverflowRetries` | engine | 宿主消费 | 无 UI 合理 |
| 4 | `modelPolicies` | engine | 宿主消费，`array` 类型 | 无 UI 合理 |
| 5 | `hotLedgerMinEvents` | engine | 见 `config-schema.mjs:230-234` 注释：**故意**只放 preset 键进 UI 表 | 用户在面板上看不到「清单刷新间隔」——但它是 C248 明确要「交给用户调」的键，**面板上没有** |
| 6 | `hotLedgerMinFailureDelta` | engine | 同上 | 同上 |
| 7 | `hotLedgerTraceRoot` | engine | 同上 | 排查用，无 UI 合理 |
| 8 | `graphDir` | engine | 路径类，`preset-format` 不写 | 无 UI 合理 |
| 9 | `worldHashMaxFiles` | engine | 调参用 | 无 UI 合理 |
| 10 | `factGuard` | engine | **实验开关，默认关** | 无 UI **合理且必须**：它是实验线，面板不该给用户开 |

⇒ 10 条里 **8 条是「引擎作用域/宿主消费」，本来就不该有面板控件**；真正值得记的是 **`hotLedgerMinEvents` / `hotLedgerMinFailureDelta` 两条**：`config-schema.mjs:101-106` 的注释说 C248 把它们「交给用户调」，但它们 `where:"engine"` 且不在 `PRESET_KEYS` ⇒ **`validatePatch` 会把它当白名单外的键丢掉**：

```bash
node --input-type=module -e '
const m = await import("./src/rooms/config-schema.mjs");
console.log(JSON.stringify(m.validatePatch({ hotLedgerMinEvents: 40 })));
'
```

```
{"patch":{},"skipped":["hotLedgerMinEvents"]}
```

**即「交给用户调」的注释与「不许通过页面写入」的实现互相矛盾。** 这是下游 `ui` 声明门禁必须处理的真实边界：**`key ∈ SCHEMA` 不足以说明它能上 UI，必须再判 `key ∈ PRESET_KEYS`。**

**清单三：两边都有但 `label` / `type` / `default` / `options` 不一致 —— 0 条。**

- `label` 0 条：`FIELDS` 的 23 条中文名与 `fieldLabels()` 逐字相同（`test/ui-config.test.mjs:353` 已用正则抽出 client 的 `{key,label}` 对并逐条断言，这条**已有门禁**）。
- `options` 0 条：两个 `enum`（`summaryMode` / `hotLedgerMarkers`）的 `options` 与 `SCHEMA.values` 逐字相同。
- `default` 0 条：`FIELDS` 条目**根本没有 `default` 字段**，默认值一律来自 `state.defaults`（host 的 `configDefaults()`）⇒ 这一维天然单一来源。

### 3.3 那「对不上」到底对在哪：四处（这才是实证）

**(a) 数值范围 5 处不一致，其中 3 处 host 更严 ⇒ 面板放行的值会被 400 打回**

| 键 | client `min/max` | schema `range` | 方向 | 用户操作的结果 |
|---|---|---|---|---|
| `headroomTokens` | `[0, 1048576]` | `[0, 512000]` | client 宽 2 倍 | 填 800000 → **400** |
| `closeoutMinEvents` | `[0, 10000]` | `[1, 10000]` | client 少了下界 | 填 0 → **400** |
| `closeoutTimeoutMs` | `[0, 600000]` | `[1000, 600000]` | client 少了下界 | 填 0 → **400** |
| `firstFoldRatio` | `[0, 0.9]` | `[0, 0.95]` | client 窄 | 0.92 选不到（host 本来接受） |
| `thresholdRatio` | 未写 min/max（控件是下拉） | `[0.05, 0.95]` | 形状不同 | 见 (b) |

把「面板会放行的值」逐个喂给 host 的唯一写入闸门 `validatePatch`：

```bash
node --input-type=module -e '
const m = await import("./src/rooms/config-schema.mjs");
for (const p of [{headroomTokens:800000},{closeoutMinEvents:0},{closeoutTimeoutMs:0}]) {
  try { const r = m.validatePatch(p); console.log(JSON.stringify(p), "=> ok", JSON.stringify(r.patch)); }
  catch (e) { console.log(JSON.stringify(p), "=> 400:", e.message); }
}
'
```

```
{"headroomTokens":800000} => 400: 压力余量（tokens） 超出范围 [0, 512000]（收到 800000）
{"closeoutMinEvents":0} => 400: 归档收尾最小事件数 超出范围 [1, 10000]（收到 0）
{"closeoutTimeoutMs":0} => 400: 归档收尾超时(ms) 超出范围 [1000, 600000]（收到 0）
```

（三个值都是**按 client 自己的 `min/max` 判定为「表单允许」**的：`800000 ≤ 1048576`、`0 ≥ 0`、`0 ≥ 0`。）
⇒ 用户看到的是：**表单接受、点保存、红字报错**。这是「UI 对不上」最轻的一种（会报错、不静默）。

**(b) `thresholdRatio` 两套取值域（会静默拒绝）**

host 侧：`SCHEMA.thresholdRatio = {type:"number", range:[0.05,0.95]}`，`validatePatch` 接受**区间内任意数**：

```
{"thresholdRatio":0.51} => ok {"patch":{"thresholdRatio":0.51},"skipped":[]}
```

client 侧：`lib/client.js:250` 硬编码 5 档，且保存前**客户端自己先拒**：

```js
// lib/client.js:250
const THRESHOLD_TIERS = Object.freeze([0.45, 0.5, 0.65, 0.75, 0.85]);
// lib/client.js:261-266
function thresholdPatchForSave(patch) {
  ...
  if (selected === "") return { ok: false, error: "压缩阈值只能选择固定档位：45% / 50% / 65% / 75% / 85%" };
```

⇒ 同一个字段：host 认连续值，client 只认 5 个值并**在客户端就拦下**。改档位要改 `client.js`，改范围要改 `config-schema.mjs`，**两处都不报错**。这是最典型的「改一处不改另一处，界面不报错」。

**(c) 取整规则把「比例键」取成整数（会静默写错值）**

`config-schema.mjs:391`：

```js
out[key] = key === "thresholdRatio" || key === "retainRatio" ? Math.round(n * 1000) / 1000 : Math.round(n);
```

只给 `thresholdRatio` / `retainRatio` 保留小数，**`firstFoldRatio` 落进整数分支**：

```
{"firstFoldRatio":0.9} => ok {"patch":{"firstFoldRatio":1},"skipped":[]}
{"firstFoldRatio":0.92} => ok {"patch":{"firstFoldRatio":1},"skipped":[]}
```

而 client 的 `firstFoldRatio` 控件是 `step: 0.01, min: 0, max: 0.9`（`lib/client.js:805`）⇒ **面板可达、host 返回 ok、真写进 preset 的是 `1`**，而 `1` 既超出 `schema.range=[0,0.95]`、也超出 client 自己的 `max:0.9`。
这条最符合用户说的「文本填进去不是真生效」——**连错误都没有**。

**(d) 还有一个键整条腿掉在缝里：`autoArchiveBackfill`**

| 事实 | 证据 |
|---|---|
| 引擎读它、且它是后台补折的**总闸** | `src/engine.mjs:2829` `if (this.chess.autoArchiveBackfill !== true) return;` |
| 引擎的 schema 里有它 | `src/engine.mjs:737` `autoArchiveBackfill: z.boolean().default(false)` |
| **`SCHEMA`（R15）里没有它** | `grep` 33 键清单无此项 |
| `ui.mjs` **又手写了一份**键/类型/默认/文案 | `src/ui.mjs:102-108`（`AUTO_ARCHIVE_BACKFILL_CONFIG`） |
| 它靠 `defaults` / `configItems` 送到浏览器，浏览器**不读 `configItems`** | §1.3 计数表：`configItems: 0` |
| 面板上唯一的「自动补账」勾选写的是 `autoBackfill`（另一个键） | `lib/client.js:793` `{key:"autoBackfill", label:"自动补账"}` |
| 两个键都要过闸才算开 | `engine.mjs:2829`（`autoArchiveBackfill`）+ `2830`（`autoBackfill === false` 则 return） |

⇒ **面板上勾「自动补账」并不足以打开后台补折**：`autoArchiveBackfill` 默认 `false`，而面板没有它的控件。用户勾了、保存成功、然后后台什么也不干。这是「假 UI」最严重的一例，也是下沉后「每个键只能有一个声明处」最直接的理由。

---

## 4 client 手写、host 侧没有同源的常量

`lib/client.js` 全部全大写常量：

```bash
grep -n "const [A-Z][A-Z0-9_]* = " lib/client.js
```

```
42:    const PANEL_ID = "gokifu-compact";
43:    const API = "/gokifu/api";
48:    const TWO_COLUMN_MIN_WIDTH = 1280;
50:    const VIEWPORT_QUERY = `(min-width: ${TWO_COLUMN_MIN_WIDTH}px)`;
62:    const SPACING = Object.freeze({ section: 16, card: 8, inline: 12, micro: 4 });
69:    const FIELD_STACK_BELOW_WIDTH = 600;
105:    const FOCUS_OUTLINE = "2px solid #4c8dff";
106:    const FOCUS_OUTLINE_OFFSET = "2px";
242:    const RECENT_FOLD_LIMIT = 5;
243:    const RECENT_FOLD_LIMIT_WITH_UPDATE = 3;
244:    const COMMON_FIELD_KEYS = Object.freeze(["thresholdRatio", "summaryMode", "summarizationProvider", "summarizationModel"]);
250:    const THRESHOLD_TIERS = Object.freeze([0.45, 0.5, 0.65, 0.75, 0.85]);
478:        const BIG_TAIL_TOKENS = 150_000;
633:    const PAGE_STYLE = {
653:    const COLUMNS_STYLE = {
659:    const COLUMN_STYLE = { display: "flex", flexDirection: "column", gap: SPACING.section, minWidth: 0 };
661:    const COLUMN_LEFT_STYLE = { ...COLUMN_STYLE, gridColumn: "1", gridRow: "1" };
663:    const COLUMN_RIGHT_STYLE = { ...COLUMN_STYLE, gridColumn: "2", gridRow: "1" };
786:    const FIELDS = [
997:    const PANEL_TABS = Object.freeze([
```

按「是否是**数据**（会被当成事实展示 / 参与校验），还是**皮肤**（几何样式）」分两张表。

### 4.1 数据类常量（下沉时必须处理）

| # | 常量 | 行号 | host 侧对应物 | 判定 |
|---|---|---|---|---|
| 1 | `THRESHOLD_TIERS = [0.45,0.5,0.65,0.75,0.85]` | 250 | **无同源**。`SCHEMA.thresholdRatio` 只有 `default:0.45` + `range:[0.05,0.95]`，没有档位表；`grep -rn "THRESHOLD_TIER" src/` 0 命中 | **无同源**（且与 host 取值域冲突，见 §3.3(b)） |
| 2 | `"（默认）"` 挂在 `tier === 0.45` 上 | 1060 | `SCHEMA.thresholdRatio.default = 0.45` | 同值**手抄**：改 schema 默认值后，面板仍会标 45% |
| 3 | `COMMON_FIELD_KEYS = [4 键]` | 244 | **无同源**。host 无「常用/高级」分组概念；`PRESET_KEYS`（23，有序）不含分组 | **无同源** |
| 4 | `RECENT_FOLD_LIMIT = 5` / `_WITH_UPDATE = 3` | 242-243 | host 有 `FOLD_LIST_LIMIT = 20`（`src/ui.mjs:359`） | 口径不同：host 是「panel payload 上限」，client 是「首屏显示条数」；**无共同来源** |
| 5 | `BIG_TAIL_TOKENS = 150_000` | 478 | `SCHEMA.closeoutMaxFoldTokens.default = 150000` | **无语义同源**（只是数值巧合：此处指「常见模型窗口」启发式）。两个 150k 各改各的 |
| 6 | `PANEL_TABS = [总览/折痕/配置]` | 997 | **无同源** | **无同源**（页签结构只在浏览器半） |
| 7 | 状态判定文案 `"正常"/"未启用"/"出错"/"检查中"` | 272-291 | `health()` 只回布尔（`src/ui.mjs:646-679`），**判定逻辑整体在 client** | **无同源**（哪些字段组合算「出错」只有 client 知道） |
| 8 | `FIELDS` 的 23 条 `{key,label}` | 786-813 | `fieldLabels()`（`config-schema.mjs:249`）→ `state.fieldLabels` | **有同源但双写**，已被 `test/ui-config.test.mjs:353` 钉住 |
| 9 | `FIELDS` 的 `min/max/step` | 789-812 | `SCHEMA[].range` / 无量化的 step | **部分同源，未钉住**（5 处不一致，见 §3.3(a)） |
| 10 | `PANEL_ID = "gokifu-compact"` | 42 | `ENTRY_ID = "gokifu-compact"`（`preset-format.mjs:20`） | 同字面量、**不同语义**（slot id vs preset 条目 id），无结构同源 |
| 11 | `API = "/gokifu/api"` | 43 | route `path: "/gokifu/api"`（`ui.mjs:1547,1586`） | **双写字面量**（client 改路径 = 面板全挂，host 不知道） |

### 4.2 皮肤类常量（下沉不处理，但记一笔）

| 常量 | 行号 | host 侧 |
|---|---|---|
| `TWO_COLUMN_MIN_WIDTH = 1280` | 48 | 无 |
| `SPACING = {16,8,12,4}` | 62 | 无（`test/ui-layout` 限制在四档内） |
| `FIELD_STACK_BELOW_WIDTH = 600` | 69 | 无 |
| `FOCUS_OUTLINE` / `OFFSET` | 105-106 | 无 |
| `PAGE_STYLE` / `COLUMNS_STYLE` / … | 633-663 | 无 |

⇒ 这 5 组属「皮肤」，AGENTS 铁律 16 要求走设计令牌，与本次「UI 声明下沉」不是同一条线。**本文只记录存在性，不把它们列进下沉清单。**

---

## 5 哪些房间需要 ui 声明（按 `ROOMS` 表 28 项逐个判）

### 5.1 判据（三条，任一成立即需要）

- **U1 拥有面板可改的配置键**：该房间是 `SCHEMA` 中某键的**读取方**，且该键 `∈ PRESET_KEYS`（可写）。
- **U2 拥有面板要渲染的数据/列**：`state` 的 16 字段中至少一个由它产出或由它定义语义。
- **U3 拥有一个用户可点的动作**。

### 5.2 房间 → 配置键的归属（机器可复现）

```bash
node --input-type=module -e '
import fs from "node:fs";
import nodePath from "node:path";
import { SCHEMA } from "./src/rooms/config-schema.mjs";
const DIR = "src/rooms";
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".mjs")).sort();
const keys = SCHEMA.map((s) => s.key);
const isKey = (k) => new RegExp("(^|[^A-Za-z0-9_$])" + k + "([^A-Za-z0-9_$]|$)");
const rows = [];
for (const f of files) {
  const src = fs.readFileSync(nodePath.join(DIR, f), "utf8");
  // 按行去掉注释行，避免注释里的键名冒充实现
  const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const hits = keys.filter((k) => isKey(k).test(code));
  if (hits.length) rows.push({ file: f, hits });
}
for (const r of rows) console.log(r.file.padEnd(22) + " " + String(r.hits.length).padStart(2) + "  " + r.hits.join(", "));
const hitFiles = new Set(rows.map((r) => r.file));
const none = files.filter((f) => !hitFiles.has(f));
console.log("无 SCHEMA 键命中（" + none.length + "）: " + none.join(", "));
'
```

```
closeout-plan.mjs       3  maxTokens, closeoutTimeoutMs, closeoutMaxFoldTokens
config-schema.mjs      33  thresholdRatio, firstFoldRatio, headroomTokens, retainRatio, retainTokens, summarizationProvider, summarizationModel, maxTokens, compactionRetries, maxOverflowRetries, modelPolicies, auto, autoBackfill, summaryMode, growthFloorTokens, minFoldTokens, hotLedger, hotLedgerMaxTokens, hotLedgerMinEvents, hotLedgerMinFailureDelta, hotLedgerMarkers, hotLedgerTraceRoot, hotLedgerReplace, transposition, tier2After, closeoutFold, closeoutMinEvents, closeoutTimeoutMs, closeoutMaxFoldTokens, graphDir, worldHashMaxFiles, factGuard, queryRecall
fact-guard.mjs          1  factGuard
facts-prompt.mjs        1  factGuard
fold-planner.mjs        2  retainTokens, minFoldTokens
hot-inject.mjs          9  maxTokens, hotLedgerMaxTokens, hotLedgerMinEvents, hotLedgerMinFailureDelta, hotLedgerMarkers, hotLedgerTraceRoot, hotLedgerReplace, factGuard, queryRecall
kifu-model.mjs          1  transposition
kifu-persist.mjs        1  graphDir
ledger.mjs              3  maxTokens, transposition, factGuard
migrate.mjs             1  graphDir
offline-fold.mjs        2  maxTokens, factGuard
preset-format.mjs      25  thresholdRatio, firstFoldRatio, headroomTokens, retainRatio, summarizationProvider, summarizationModel, maxTokens, auto, autoBackfill, summaryMode, growthFloorTokens, minFoldTokens, hotLedger, hotLedgerMaxTokens, hotLedgerMarkers, hotLedgerReplace, transposition, tier2After, closeoutFold, closeoutMinEvents, closeoutTimeoutMs, closeoutMaxFoldTokens, graphDir, worldHashMaxFiles, queryRecall
tool-value-facts.mjs    1  factGuard
无 SCHEMA 键命中（15）: build-stamp.mjs, closeout-backfill.mjs, fold-quality.mjs, keeper.mjs, loop-guard.mjs, manual-compact.mjs, node-docs.mjs, profile-io.mjs, query-recall.mjs, touched-files.mjs, user-patch.mjs, user-route.mjs, verify.mjs, world.mjs, zstd-log.mjs
```

⚠ **「键名在该文件里出现」≠「该房拥有这个键」**。两个必须排除的假阳性：

- `config-schema.mjs` 33/33 —— 它是**定义方**（`SCHEMA` 本身），必然全中，不算「消费者」；
- `preset-format.mjs` 25 键 —— 它是**模板渲染方**（`engineBlock()` 把 23 个 preset 键写进 YAML），也是「搬运工」不是「拥有者」。
- `ledger.mjs` 的 `maxTokens` 是**函数参数的 `maxTokens`**（渲染预算），不是配置键 `maxTokens`（摘要输出上限）。同名不同物。

⇒ 真正「读了配置并据此改变行为」的房间只有 5 个：`hot-inject`（9 键）、`closeout-plan`（3 键）、`fold-planner`（2 键）、`fact-guard`（1 键）、`kifu-model`/`kifu-persist`（各 1 键）。**其余 18 个键的最终消费者是 `src/engine.mjs`（R09）** —— 而 `engine.mjs` 不在 `ROOMS` 表里（它是永久顶层文件）。**这是下沉清单最大的结构性事实：大部分配置键的归属方不参与 `ROOMS` 登记。**

### 5.3 28 项逐个判

「需要 ui」= U1/U2/U3 任一成立。理由里给的是**该房间今天在面板上留下的痕迹**。

| # | 房间（`ROOMS` 键） | 文件 | 需要 ui? | 理由 / 证据 |
|---:|---|---|---|---|
| 1 | `preset-format` | preset-format.mjs | **✅ U1** | 拥有 23 个 preset 键的**模板顺序**（`PRESET_KEYS` 顺序即 `engineBlock()` 顺序）；面板「保存后写到哪一行」由它决定；`ENTRY_ID`/`PKG_NAME` 也被 `health()` 用 |
| 2 | `loop-guard` | loop-guard.mjs | ❌ | 纯判据（连续相同动作 + 限流），无配置键、无面板数据、无动作 |
| 3 | `zstd-log` | zstd-log.mjs | ❌ | 会话日志读取工具，离线补折内部用 |
| 4 | `offline-fold` | offline-fold.mjs | ❌（仅 U1 弱） | 离线压缩编排，`maxTokens`/`factGuard` 是可调参数但无面板入口；补折卡的**按钮文案**在 client 手写（`backfillLines`） |
| 5 | `closeout-plan` | closeout-plan.mjs | **✅ U1+U2** | 读 `closeoutTimeoutMs`/`closeoutMaxFoldTokens`/`closeoutMinEvents`；`closeoutTimeoutAdvice`/`recentFoldP90` 直接进 host 补折提示（`src/ui.mjs:68` import） |
| 6 | `profile-io` | profile-io.mjs | **✅ U2** | `readProfileBundles` 决定 `health().mounted/notInBundles` ⇒ 面板「健康检查」卡三格的**是/否**来自它 |
| 7 | `config-schema` | config-schema.mjs | **✅ U1（定义方）** | `SCHEMA` 是全部字段的**唯一真值**；`fieldLabels()`/`configDefaults()`/`describeConfig()`/`validatePatch()` 是面板字段口径本身。**它是 `ui.fields` 的仲裁者，不是声明者** |
| 8 | `kifu-persist` | kifu-persist.mjs | **✅ U1+U2** | 读 `graphDir`；`collectGraphFiles`/`latestGraphFrom` 的读图口径决定 `state.latest`/`foldMarks`/`today` 三个字段 |
| 9 | `hot-inject` | hot-inject.mjs | **✅ U1（9 键）** | 面板「高级参数」里 `hotLedger*` 一族（5 个可写键）与 `queryRecall` 的**实际读取方**是它（`hot-inject.mjs:433` `config?.queryRecall === true`、`:496` `config.hotLedgerMaxTokens ?? 500`） |
| 10 | `query-recall` | query-recall.mjs | **✅ U1（弱）** | 它是 `queryRecall` 这个开关**实现的**能力（无配置读取，开关由 `hot-inject` 读）⇒ 声明应写在这里、门禁要能跨房间核对「同一个 key 只被声明一次」 |
| 11 | `user-route` | user-route.mjs | ❌（潜在 U2） | 会话级「棋路」容器，今天**没有任何面板入口**；若将来加「棋路」面板，它才是声明方 |
| 12 | `verify` | verify.mjs | ❌ | 判据集中处，内部信号 |
| 13 | `node-docs` | node-docs.mjs | ❌ | 图节点与 `nodes/` 目录一致性校验，doctor 用 |
| 14 | `fold-planner` | fold-planner.mjs | **✅ U1** | 读 `minFoldTokens`/`retainTokens`（`fold-planner.mjs` 2 键）⇒ `minFoldTokens` 的面板控件归它 |
| 15 | `build-stamp` | build-stamp.mjs | **✅ U2** | `health()` 的 `installed`/版本/`buildId` 来自它（`repoVersion`/`repoBuildId`/`processIsAlive`，`src/ui.mjs:62` import） |
| 16 | `user-patch` | user-patch.mjs | **✅ U3（弱）** | `scheduleHomePatchHeal` 会在退出时**替用户改配置**（`src/ui.mjs:1469`）⇒ 这是用户可见的写行为，面板应能声明「我已/将托管 home 层」 |
| 17 | `world` | world.mjs | ❌ | 世界状态哈希，无面板 |
| 18 | `kifu-model` | kifu-model.mjs | **✅ U1+U2** | 读 `transposition`；`foldMarks` 的结构（`at`/`seqStart`/`seqEnd`/`summaryChars`/`usage`/`trigger`）由它定义 ⇒ **折痕列表的列就是它的字段名** |
| 19 | `keeper` | keeper.mjs | ❌ | 事件→图，内部 |
| 20 | `ledger` | ledger.mjs | ❌（潜在 U2） | 热清单渲染；今天面板**没有热清单预览**。若加「本轮注入预览」面板，列定义归它 |
| 21 | `fact-guard` | fact-guard.mjs | **✅ U1（实验，必须无控件）** | 读 `factGuard`，但它 `where:"engine"` + 默认关 + 未过采纳门槛 ⇒ 声明应存在、且面板必须**不渲染**它（门禁正好要证这一点） |
| 22 | `tool-value-facts` | tool-value-facts.mjs | ❌ | 只复用 `factGuard` 开关，无独立 UI 面 |
| 23 | `facts-prompt` | facts-prompt.mjs | ❌ | 文本拼装 |
| 24 | `manual-compact` | manual-compact.mjs | ❌（潜在 U2） | 手动压缩失败诊断，今天面板未接；接了才是 U2 |
| 25 | `fold-quality` | fold-quality.mjs | ❌（潜在 U2） | L1 保真度指标，今天面板未展示 |
| 26 | `touched-files` | touched-files.mjs | ❌ | 路经机械解析 |
| 27 | `closeout-backfill` | closeout-backfill.mjs | **✅ U2+U3** | 面板「补折（点一下派一个子代理）」整张卡的**数据源 + 动作**：`listDebts`/`backfillArchivedSessions`（`src/ui.mjs:73` import；action `backfill`/`backfill-subagent`） |
| 28 | `migrate` | migrate.mjs | ❌（应保持无 UI） | 迁移是**显式 CLI + 主人授权 + 停插件窗口**（AGENTS §2.5）⇒ 面板**不许**给按钮 |

### 5.4 结果：**13 条 `ui` 声明**，其中 **12 个房间有实际渲染项**

| 判据 | 房间 | 数量 |
|---|---|---:|
| **U1 拥有可写配置键** | `config-schema`（仲裁）· `hot-inject` · `fold-planner` · `closeout-plan` · `kifu-model` · `kifu-persist` · `preset-format` · `query-recall`（弱）· `fact-guard`（仅声明、不渲染） | 9 |
| **U2 拥有面板数据/列** | 上面 + `profile-io` · `build-stamp` · `closeout-backfill` | +3 |
| **U3 拥有用户动作** | `closeout-backfill`（已在 U2）· `user-patch`（弱） | +1 |
| **合计（去重）** | `config-schema` · `preset-format` · `profile-io` · `build-stamp` · `user-patch` · `kifu-model` · `kifu-persist` · `hot-inject` · `query-recall` · `fold-planner` · `closeout-plan` · `closeout-backfill` · `fact-guard` | **13** |

> ⚠ **「一条声明」≠「一个渲染项」** —— 差异就是 `fact-guard`：它需要一条**声明**（让门禁能证「实验键不许上 UI」），但它**不产出任何渲染项**。
> 所以两个数都要给：**13 条声明 / 12 个房间有实际渲染项**。这个区别正是下沉设计必须写清的一条；只报一个数，接手的下一个人就会以为 `fact-guard` 被漏掉了。

---

## 6 样例声明（只写在文档里，不建文件）

### 6.1 选型

选 **1 个真实房间 + 1 个真实字段**：房间 `hot-inject.mjs`（R08），字段 `hotLedgerMaxTokens`。

选它的理由（每条都可核）：

- 它是这个键的**真实读取方**：`src/rooms/hot-inject.mjs:496` / `:498` `maxTokens: config.hotLedgerMaxTokens ?? 500`；
- 该键 `∈ PRESET_KEYS`（`config-schema.mjs:177`），所以**面板写入能落盘**；
- 今天它的面板控件**手写在 `lib/client.js:797`**（`{key:"hotLedgerMaxTokens", label:"热清单预算（tokens）", kind:"number", step:50, min:0, max:20000}`）；
- 它在 §3.3 的 5 条 range 不一致里**不在**名单上（两边都是 `[0,20000]`）⇒ 用它做样例不会把已知 bug 混进来。

### 6.2 声明（形态）

```js
// src/rooms/hot-inject.mjs —— 追加，纯数据、零 React、零 HTTP、零 import
export const ui = {
  // 本房在面板上「拥有」的字段。key 必须是 SCHEMA 里的键，且必须 ∈ PRESET_KEYS（可写）。
  fields: [
    {
      key: "hotLedgerMaxTokens",
      // 面板分组：client 的 COMMON_FIELD_KEYS / 其余 的二分今天写死在浏览器半
      group: "advanced",
      // kind 是**控件类型**，不是 schema.type 的镜像：
      //   SCHEMA 说 number + range[0,20000]，这里只说「画成数字框」
      kind: "number",
      // 门禁要求：range 必须逐值等于 SCHEMA.range，否则红（今天这 5 处不一致就是这么来的）
      range: [0, 20000],
      step: 50,
      // label/hint 可以从 SCHEMA 派生（label 已由 fieldLabels() 派生），
      // 只有 hint 是「面板专用说明」，SCHEMA 没有，必须由房间给
      hint: "清单自身的 token 上限",
    },
  ],
  // 本房拥有的面板块（可选）
  panels: [],
};
```

**「最多」边界：`ui` 只允许是纯数据。** `test/rooms.test.mjs` 的 R-B 已经禁止 R00–R08 import `@deepseek-ai/*` / `scripts/` / `lib/`；`ui` 声明必须继续满足这条（一个 `Object.freeze` 字面量，零 import、零函数）。

### 6.3 这条声明怎么让「文本填进去真生效」成立

用户要的四件事，靠**一条门禁 + 两个已有断言**落地。门禁要能回答的问题是：**这个 key 提交上去，会被 host 真的写进 preset 吗？**

链路（今天的真实代码路径，逐段可查）：

```
面板输入 → callApi("save", {patch})                     lib/client.js:1268（save() 在 1259）
        → POST /gokifu/api  {action:"save"}             src/ui.mjs:1887
        → saveConfig(patch)                             src/ui.mjs:1381
        → sanitizePatch → validatePatch(patch)          src/ui.mjs:1360 / config-schema.mjs:371
        → renderEngineBlock(...) → writeFileSync        src/ui.mjs L 段
```

`validatePatch` 的第一道判据就是**白名单**（`config-schema.mjs:372`）：

```js
const editable = new Set(Object.keys(configDefaults()));   // === PRESET_KEYS
...
if (!editable.has(key)) { skipped.push(key); continue; }
```

而 `saveConfig` 的 `strictKeys` 把 `skipped` 变成 **400 + 键名**（`src/ui.mjs:1384-1388`）。

⇒ **能保证「真生效」的不是 UI，是这条链上的 `editable` 白名单。** 所以门禁只需要一件事：

```js
// 建议形态（本文只写，不建文件）：
// test/ui-declarations.test.mjs
for (const room of Object.values(ROOMS)) {
  const mod = await import(room.path);
  for (const f of mod.ui?.fields ?? []) {
    assert(SCHEMA_KEYS.has(f.key),             `${room.id}.ui.fields 的 ${f.key} 不在 SCHEMA`);        // ← 防「假 UI」
    assert(PRESET_KEYS.includes(f.key),        `${room.id}.ui.fields 的 ${f.key} 不可写（不在 PRESET_KEYS）`); // ← 防「填了 400」
    assert.deepEqual(f.range, describe(f.key).range);   // ← 防今天这 5 处 range 不一致
    assert.equal(f.key in clientFields, false);         // ← 防 client 里还留着手写副本（逐步收紧）
  }
}
```

三点「为什么这样就够」：

1. **`key ∈ SCHEMA` 只挡掉「host 根本不认识的键」**——但 §3.2 已证今天这条不成立（只在 FIELDS 0 条），所以**只靠它不够**；
2. **`key ∈ PRESET_KEYS` 才是真正那一维**——`hotLedgerMinEvents` 就是反例（在 SCHEMA、不在 PRESET_KEYS、`validatePatch` 直接 `skipped`）。**这条是「文本填进去真生效」的机器判据**；
3. **`range` 逐值相等** 才能把 §3.3(a) 的 5 处不一致变成红灯，而不是靠人记。

### 6.4 需要一并处理的 3 个「声明不了的」字段（否则门禁装不上）

| 现象 | 位置 | 为什么挡住下沉 | 复现 |
|---|---|---|---|
| `autoArchiveBackfill` 不在 `SCHEMA` | `engine.mjs:737` + `ui.mjs:102` 两处定义 | 它无法被「声明 + 门禁」覆盖；要么进 `SCHEMA`，要么明确标注「无 UI 面」 | §3.3(d) |
| `firstFoldRatio` 被取整成整数 | `config-schema.mjs:391` | 声明里写的 `step:0.01` 与 host 的 `Math.round` 互相矛盾，门禁查不出来 | §3.3(c) |
| `thresholdRatio` 5 档 vs 连续区间 | `lib/client.js:250` + `config-schema.mjs:46-53` | 声明只能写一个形态，两套取值域必须先在 schema 侧定下来 | §3.3(b) |

---

## 7 我没能确定的部分

1. **`SCHEMA`/`FIELDS`/`FIELDS 15 键` 这些数字的历史来源没查。** 我只证明了「今天的实测是 33/23/23」和「手写数字已漂移」；**没有** `git log -S` 逐版追溯 `FIELDS` 曾是 15 键的那一版，也没确认方案文档的「15/23」是从哪个 commit 抄的。⇒ 谁要写「之前是 15 键」这种话，必须先跑 `git log -p lib/client.js | grep -c 'key: "'`，本文不背书。
2. **§5 的「房间 → 配置键归属」是静态文本匹配。** 已排除注释行、已手工剔掉 `config-schema`（定义方）、`preset-format`（模板方）、`ledger.maxTokens`（同名参数）三个假阳性，但**没有**逐个键做「运行时验证」（例如给引擎注入 `hotLedgerMarkers:"off"` 看渲染差异，来反证它真是 `hot-inject` 在读）。⇒ 5.2 的表是**文本级归属**，不是行为级归属。
3. **`engine.mjs`（R09）不在 `ROOMS` 表里，而它是 18 个键的最终消费者。** 我没能确定下沉后这 18 个键该由谁声明：`engine` 不属于 28 房，「挂在房间里」会造出「房间声明、引擎消费」的跨层引用。**这是下沉方案真正的设计缺口，本文只指出，没解。**
4. **「哪些房间需要 UI」里 5 个我标了「潜在」（`ledger`/`manual-compact`/`fold-quality`/`user-route`/`offline-fold`）。** 判定依据是「今天面板没有入口」，但我**没有**查证它们是否在 `计划表.md` 里已排期做面板。⇒ 若排期已定，这 5 个应转「需要」。
5. **`lib/client.js` 是 classic script，我没能用 Node 直接 import 它做运行时断言。** §3.2 的 `FIELDS` 提取走的是「按行 `new Function` 求值」（`L.slice(785,813)`），依赖「每条 FIELDS 都在单行」这个当前事实。**若将来 FIELDS 条目换行书写，这个命令会静默少抓**——`test/ui-config.test.mjs:361` 的正则也有同样的单行前提。⇒ 复现命令本身有脆弱性，已在 §3.2 命令里显式钉住行号区间。
6. **`state.version` 是死字段、`src/ui.mjs:82-84` 的注释已失效** —— 我确认了 `lib/client.js` 里 `version` 0 命中、标题写死（`:1406`），但**没有**确认是否还有其它消费方（例如某个测试断言页面显示版本号）。⇒ 「删掉它安不安全」本文不下结论。
7. **未跑 `node scripts/gate.mjs`。** 本文只跑了：`node test/run.mjs` = **2569 passed / 2 skipped / 0 failed**（本次会话实测，写本文前后同一棵树）；`node scripts/docs-index-check.mjs` = **171 个文件 / 未索引 0** —— 这里要说明一句：**本文件登记进 `docs/README.md` 的那一行不是我加的**（写作用域只含本文件，索引由另一个会话统一登记），我写完时它已经在索引里了，所以索引检查是绿而不是红。⇒ 若要把本文当 P2 的依据，建议再跑一次 `gate.mjs` 确认 9 个判分门。