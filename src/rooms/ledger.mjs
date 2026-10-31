/**
 * ledger.mjs —— 热上下文渲染
 *
 * 两个消费者：
 *   1. 给模型的「失败清单」（热、每步可见、有硬预算）
 *   2. 给摘要模型的「硬事实」（压缩时用，权威、不许改）
 *
 * ★ 2026-10-28 性能修正（bench 实测暴露）：
 *   旧版在失败边很多时会把所有边列出来 —— 1201 条边渲染出 28,800 tokens，
 *   比它要省的上下文还大。现在有**硬预算 + 五级降级**：
 *     L0 全量（意图 + 原因 + seq）
 *     L1 原因截短
 *     L2 只留意图
 *     L3 只留 id + 意图前 22 字
 *     L4 最近 N 条（L3 格式）+ 一行汇总（告诉模型还有多少条、去哪里查）
 *   原则不变：**能逐条列出的绝不合并**；实在列不下时用汇总行保证「可发现」，
 *   而不是假装不存在。摘要 prompt 的 renderFacts 仍然全量（那是一次性成本）。
 */

import { failureEdges, openEdges, currentPath, latestAgentNode, norm, tewariAnalysis, failureClass } from "./kifu-model.mjs";
import { weakKindOf } from "./verify.mjs";

/* ───────────────── P6-A：悬空边（to=null）的分类与排除 ───────────────── */

/**
 * ★ P6-A（2026-10-30，task-56）：悬空边的两类，必须**只排除残留、保留未结算**。
 *
 * 数据事实（ws-dangling 全库测量，133 会话 / 18,038 边）：
 *   · `to=null` 5,567 条：unverified 4,815 + success 481 + failure 268 + untested 3；
 *   · 5,564 条是 1.9.1 rewash 清自环时把 `to` 抹掉的**历史残留**（已结算却无终点 = 不可能）；
 *   · 3 条 untested 也是 18 小时前的陈旧 in-flight 残留；
 *   · 另有 214 条 `from` 悬空（全在 session-5acafe42，mergeNodeInto 老 bug）——**另一类**，
 *     判据必须以 `to == null` 开头，绝不能写成「任一端为空」（会误删）。
 *
 * 不变量（报告 §2，P6C-1 起四类）：
 *   residue(e)        := e.to == null && e.result !== "untested" && age > 10min        （已结算却没终点 = 不可能）
 *   live_unsettled(e) := e.to == null && e.result === "untested" && age <= 10min       （正在执行）
 *   candidate(e)      := e.to == null && e.result === "untested" && age > 10min        （未落地：可继续、也可放弃）
 *
 * ★ P6C-1（2026-10-30）：**超过 10 分钟的 untested 不再是 residue，而是 candidate。**
 *   旧判据把它当「死边」整条丢掉 —— 但模型崩溃/中断留下的未结算边恰恰是「下一步还能接着做」
 *   的信息，丢掉等于把线索一起丢了。现在它进热清单的 OPTIONS 区段（标 `[stale Xm]`），
 *   明确写成「not yet landed — you may continue or abandon」，不混进 UNVERIFIED（那是「跑了但没验证」）。
 *
 * 为什么 residue 只留「已结算」：结算过（success/failure/unverified）的边必须有终点，
 * 无终点只可能是 1.9.1 rewash 留下的历史残留（数据事实 5,564/5,567）。
 */
export const DANGLING_STALE_MS = 10 * 60 * 1000;

/**
 * @returns {"residue"|"candidate"|"live-unsettled"|"from-broken"|"none"}
 */
export function classifyDangling(edge, { graph = null, now = Date.now() } = {}) {
  if (!edge) return "none";
  if (edge.from != null && graph && !graph.nodes?.[edge.from]) return "from-broken";
  if (edge.to != null) return "none";
  // ★ 年龄护栏（实现比报告公式更保守一层）：报告公式是
  //   `to==null && (result!=="untested" || age>10min)` —— 但「已结算」不等于「一定是旧残留」：
  //   keeper 是「工具结果到达时先 settle、step/end 才回填 to」，所以**刚结算的失败边也可能 to=null**。
  //   按字面公式会把这种新鲜失败当场当残留隐藏掉（本仓库多组单测夹具正是这个形态，实测 10+ 用例变红）。
  //   ⇒ 统一要求 age > 10min 才算 residue；≤10min 一律按 live 保留（宁可多显示）。
  //   生产数字不受影响：全库 5,564 条 settled 残留的 ts 全部是 10-29 的老边，远超 10 分钟。
  const ts = Number(edge.ts);
  if (Number.isFinite(ts) && now - ts <= DANGLING_STALE_MS) return "live-unsettled";
  // 陈旧（或没有时间戳、无法证明新鲜）的 untested = candidate（P6C-1）
  if (edge.result === "untested") return "candidate";
  return "residue";
}

/**
 * 该边是否属于「OPTIONS」区段（未落地的尝试：新鲜 live 或陈旧 candidate）。
 * ★ 只认 `result === "untested"`：刚结算的失败边也可能因年龄护栏落进 live-unsettled，
 *   但它是**已发生的失败**（已在 LEARNED 里），不是「还没落地、可以继续或放弃」的选项。
 */
export function isDanglingOption(edge, { graph = null, now = Date.now() } = {}) {
  if (!edge || edge.result !== "untested" || edge.to != null) return false;
  const kind = classifyDangling(edge, { graph, now });
  return kind === "live-unsettled" || kind === "candidate";
}

/** 全图悬空统计：{residue, candidates, liveUnsettled, fromBroken}。只读，不改图。 */
export function danglingStats(g, { now = Date.now() } = {}) {
  let residue = 0;
  let candidates = 0;
  let liveUnsettled = 0;
  let fromBroken = 0;
  for (const e of Object.values(g?.edges ?? {})) {
    const kind = classifyDangling(e, { graph: g, now });
    if (kind === "residue") residue += 1;
    else if (kind === "candidate") candidates += 1;
    else if (kind === "live-unsettled") liveUnsettled += 1;
    else if (kind === "from-broken") fromBroken += 1;
  }
  return { residue, candidates, liveUnsettled, fromBroken };
}

/** 该边是否应从「失败边分析 / 热清单」排除。live_unsettled 永远保留。 */
export function isDanglingResidue(edge, { graph = null, now = Date.now() } = {}) {
  return classifyDangling(edge, { graph, now }) === "residue";
}


/**
 * 弱成功图例（S2a）。只要 WORKING 行出现 `[weak k/n]`，这一行解释就一定在同一条清单里 ——
 * 标记裸奔 = 模型把「读了一眼」当成已验证。措辞刻意不说 "verified / done"。
 */
// ★ C-17 rev6：图例必须**短**。它每条 weak 清单都要出现一次，旧文案 108 字符 ≈ 36 token，
//   单这一行就吃掉「L3+ 路径行净增 ≤50 token」额度的大半。压到 61 字符，信息不丢：
//   「k of n hops 未验证 = 不构成进展证据」。
const WEAK_LEGEND = "# weak k/n = k of n hops unverified — not proof of progress";

/**
 * OPTIONS 行尾的陈旧标记（P6C-1）：只有超过 10 分钟的 untested 才加。
 * 没有时间戳 ⇒ 无法证明新鲜，标 `[stale ?]`（宁可让模型知道「这条来路不明」）。
 */
function staleTagOf(edge, now) {
  if (edge?.result !== "untested") return "";
  const ts = Number(edge.ts);
  if (!Number.isFinite(ts)) return " [stale ?]";
  const age = now - ts;
  if (age <= DANGLING_STALE_MS) return "";
  return ` [stale ${Math.floor(age / 60000)}m]`;
}

/** 保守 token 估算（CJK 1 字≈1 token，英文 ~4 字/token；取 3 折中偏保守）。 */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 3);
}

/**
 * ★ P5（2026-10-30）：渲染结果的预算状态三态。**必须显式**，不许把超预算内容静默返回。
 *
 *   · `"none"`         —— tokens ≤ maxTokens，正常交付。
 *   · `"over-budget"`  —— 兜底档已是最省的一份，但仍超预算（`overBudgetBy` 给出超出量）。
 *     这是**可观测**的降级：调用方/doctor/审计可以单独统计「兜底超限」的会话数。
 *   · `"impossible"`   —— 连一份非空文本都构造不出来（`attempts` 为空）。
 *     实践上只在极端输入/内部异常出现；仍然显式标注，绝不返回空字符串假装成功。
 *
 * 为什么需要它：旧 `pickFallback` 在没有预算内候选时直接返回最省的超预算文本，
 * 调用方拿到的 `tokens` 大于 `maxTokens` 却没有任何标记 ——「已经尽力」和「出了 bug」不可区分。
 */
export function fallbackStatusOf(best, maxTokens) {
  if (!best || typeof best.text !== "string" || best.text.length === 0) return "impossible";
  return best.tokens > maxTokens ? "over-budget" : "none";
}

function clip(text, n) {
  const t = norm(text);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
}

/**
 * ★ P6a（2026-10-30）：把 `treeDir` 变成**相对** TRACE 路径（默认挂在 `sessions/` 下）。
 *
 * 为什么：生产口径实测 94/133 个会话带 TRACE 行，绝对路径平均 137.7 字符 ——
 *   ① 把本机盘符/用户名泄漏进热清单（模型不需要，也不该看到）；
 *   ② 白烧 token（task-36 对账：TRACE 绝对路径净 +2318 token = avg +17.43/图）。
 *
 * 规则：
 *   · 路径里含 `sessions/<sid>` ⇒ `sessions/<sid>`（最常见的生产形态，正反斜杠都吃）；
 *   · 否则取最后一段目录名 ⇒ `<root>/<basename>`（仍然不泄漏绝对路径）；
 *   · 空 ⇒ `<root>`。
 * **永远不会**返回以盘符/`/` 开头的绝对路径。
 */
export function traceRelativeDir(treeDir, root = "") {
  const p = String(treeDir ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const m = /(?:^|\/)sessions\/([^/]+)$/.exec(p);
  let sid = m ? m[1] : (p.split("/").filter(Boolean).at(-1) ?? "");
  // 盘符本身不是会话名（`treeDir = "D:\\"` ⇒ 最后一段是 "D:"）——不许把 "D:" 印成相对路径。
  if (/^[A-Za-z]:$/.test(sid) || sid.includes(":")) sid = "";
  if (!sid) return root || ".";
  return root ? `${root}/${sid}` : sid;
}

/**
 * ★ S5（2026-10-31）：TRACE 行附带「最近 3 个路径节点 id + 一句话」。
 *
 * 为什么：TRACE 原来只说「细节在 sessions/<sid>/index.md」—— 模型不知道最近走了哪三步，
 *   想定位就得先读 index.md（一次工具调用 + 一轮上下文）。把最近三步的 id 与一句话直接放进清单，
 *   模型不读盘也能认出「我刚刚在改哪个文件 / 跑哪个测试」。
 *
 * 约束：
 *   · **不新增 IO**：只用已经算好的 `path`（`currentPath` 返回的节点对象）与节点自带字段；
 *   · 短语取 agent 的 `goal` / user 的 `text`，截 {@link TRACE_PHRASE_CHARS} 字符；
 *   · **绝对路径必须打码**：P6a 的硬约束是 TRACE 行不泄漏盘符/用户名，而 goal 里完全可能写着
 *     `D:/repo/x.mjs` —— 这里把盘符路径 / `/Users/` / `/d/` / `/home/` 一律换成 `…`；
 *   · 路径为空 ⇒ 返回空串，TRACE 行逐字不变（「无路径时保持现状」）；
 *   · 路径短于 3 个节点时按实际个数给，不补齐。
 */
const TRACE_RECENT_MAX = 3;
const TRACE_PHRASE_CHARS = 18;
/** 绝对路径样式的片段（盘符 / POSIX 家目录 / Git-Bash 风格 /d/）—— 命中即打码。 */
const ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|\/d\/)[^\s，。；、,;)\]]*/g;

function tracePhraseOf(node) {
  const raw = node?.kind === "user" ? node.text : (node?.goal ?? node?.text ?? "");
  const text = norm(raw).replace(ABS_PATH_RE, "…");
  return text === "" ? "" : clip(text, TRACE_PHRASE_CHARS);
}

/**
 * `recent: n120 读文件 → n121 跑测试 → n122`。
 * @param {Array<object>} path currentPath 的结果（节点对象数组）
 */
function traceRecentSegment(path) {
  if (!Array.isArray(path) || path.length === 0) return "";
  const parts = path
    .slice(-TRACE_RECENT_MAX)
    .map((node) => {
      const id = String(node?.id ?? "");
      if (id === "") return "";
      const phrase = tracePhraseOf(node);
      return phrase === "" ? id : `${id} ${phrase}`;
    })
    .filter(Boolean);
  return parts.length === 0 ? "" : `recent: ${parts.join(" → ")}`;
}

/**
 * 只取哈希的前 n 位。兼容字符串与历史脏数据里的 { hash, mode, files } 对象 ——
 * 旧版直接 `.slice()`，遇到对象就抛 "latest?.worldHash?.slice is not a function"，
 * 导致 renderLedger 整体失败、压缩链路 100% 中断。
 */
function shortHash(value, n = 12) {
  if (typeof value === "string") return value.slice(0, n);
  if (value && typeof value === "object" && typeof value.hash === "string") return value.hash.slice(0, n);
  return "";
}

function seqSpan(edge) {
  const e = edge.evidence;
  if (!e) return "";
  if (typeof e === "string") return e;
  if (typeof e.start === "number" && typeof e.end === "number") return e.start === e.end ? `${e.start}` : `${e.start}-${e.end}`;
  return "";
}

/**
 * 标记图例（给模型看，不是给人看的缩写）。
 *
 * ★ 2026-10-29 修正（模型消费者视角）：旧版把图例**绑在「检测到手割」**上 ——
 *   一个只有 EACCES 失败、没有成功路径的会话，标记 `[blocked]` 会**裸奔**（没有任何解释）；
 *   而 `redundant` / `longer` 这两个真的出现在清单里的标记，图例里**从来没有**过。
 *   新规则：**只要清单里出现某个标记，它的解释就一定出现**（按实际用到的标记动态生成，不浪费 token）。
 *
 * 键是标记前缀（`redundant:e1+2` 的键是 `redundant`）。
 */
const MARKER_LEGEND = {
  dead: "a working path avoids it — retry only if retry-if breaks",
  "blocked:permission": "needs a permission this environment lacks — retry when it changes",
  "blocked:missing-resource": "absent — retry when it appears, or create it",
  "blocked:timeout": "no answer in time — retry when it recovers",
  "blocked:unreachable": "connection refused — retry when it is up",
  blocked: "not available right now — retry when that changes",
  failed: "retryability unknown",
  redundant: "working edge <edge> reaches the SAME position — take it",
  longer: "working edge <edge> reaches it in fewer steps — take it",
  novel: "reached positions no working path covers — new information",
};

/** 标记 → 图例键（`redundant:e1+2` → `redundant`；`dead retry-if:e1` → `dead`）。 */
export function legendKey(tag) {
  const base = String(tag).split("+")[0];
  if (base.startsWith("redundant")) return "redundant";
  if (base.startsWith("longer")) return "longer";
  if (base.startsWith("dead")) return "dead";
  if (base.startsWith("blocked")) return Object.hasOwn(MARKER_LEGEND, base) ? base : "blocked";
  return base;
}

/**
 * 一条失败边的标记。`mode`：
 *   · `semantic`（默认）—— 标记自带语义：`blocked:permission`（模型不用猜是什么被挡住了，
 *     这正是「什么条件变了就能再试」的机器可判形式）
 *   · `terse`    —— 只写三态（`blocked` / `dead` / `failed`）省 token，图例仍然给
 *   · `off`      —— 完全不打标记（热清单退回纯失败列表）
 * 手割标记（`redundant:<edge>` / `longer:<edge>` / `novel`）在非 off 模式下都会带上 ——
 * 它回答的是「这一步为什么多余、相对哪条成功路径」，正是模型下一步要用的信息。
 */
export function failureTags(edge, tewari = null, mode = "semantic") {
  if (mode === "off") return [];
  const cls = failureClass(edge, tewari);
  const tags = [mode === "semantic" && cls.kind === "blocked" && cls.reason ? `blocked:${cls.reason}` : cls.kind];
  // ★ 2026-10-29（goal ③）：「dead」不能是永久墓碑。它成立的依据是「某条成功边不经过这里」，
  //   所以把那条边直接写进标记：`dead retry-if:e1` —— 那条成功路径一旦不通，就是该回头重试的信号。
  //   依据由 tewari 给（dead 的定义就是 same_position ⇒ redundantVs 非空），不是猜的。
  if (cls.kind === "dead" && tewari?.redundantVs?.length) {
    const n = tewari.redundantVs.length;
    tags[0] = `dead retry-if:${tewari.redundantVs[0]}${n > 1 ? `+${n - 1}` : ""}`;
  } else if (tewari?.redundantVs?.length) {
    // 非 dead（典型是 blocked + 同终点）：冗余关系照旧单独标注
    const n = tewari.redundantVs.length;
    tags.push(`redundant:${tewari.redundantVs[0]}${n > 1 ? `+${n - 1}` : ""}`);
  }
  if (tewari?.probes?.length > 0) tags.push("novel");
  if (tewari?.longerVs?.length) {
    const n = tewari.longerVs.length;
    tags.push(`longer:${tewari.longerVs[0]}${n > 1 ? `+${n - 1}` : ""}`);
  }
  return tags;
}

/** 一条失败边的单行渲染。level 控制长度：0=最详细，3=最省。 */
export function renderFailureLine(edge, level = 0, tewari = null, mode = "semantic") {
  const intentLen = [70, 50, 34, 22][Math.min(level, 3)];
  // ★ 2026-10-29：原因（报错原文）**任何级别都保留**，只是越来越短。
  //   旧版 level ≥3 直接把 `→ 原因` 整段砍掉 ⇒ 全库实测 133 条可见失败边里只有 25 条带原因，
  //   模型看到「我试过 X、它 blocked」却看不到「报错是什么」。而原因正是它避免重犯的判据。
  //   现在最省的一档也留 25 字（"Error: EACCES: permissio…" 足够认出是什么错）。
  const reasonLen = [90, 60, 36, 25][Math.min(level, 3)];
  const intent = clip(edge.intent || edge.action || "(未记录意图)", intentLen);
  const reason = clip(edge.errorSnippet || edge.verify?.summary || edge.action || "(未记录原因)", reasonLen);
  const seq = seqSpan(edge);
  const tags = failureTags(edge, tewari, mode);
  const tag = tags.length > 0 ? ` [${tags.join(" ")}]` : "";
  return `- ${edge.id} "${intent}" → ${reason}${seq && level <= 1 ? ` (seq ${seq})` : ""}${tag}`;
}

/**
 * 路径行（CURRENT PATH / WORKING）的形态。★ C-17（2026-10-30）。
 *
 * 背景（实测）：渲染链原本是 `path.length > 1 && level <= 2` —— **L3 起整块路径段不渲染**。
 * S2a 的 `WORKING:` 行让 3 个会话多出 28~46 tokens，从 L2 掉到 L3，于是「为了显示工作路径」
 * 反而把路径（连同工作位置）一起挤没了：
 *   session-569f9cd0 L2=453 → L3=376 / session-8bfe7040 L2=438 → L3=356 / session-e02194c6 L2=489 → L3=394。
 *
 * 修法：**按档位决定路径行的形态 —— 越高越省，而不是越高越没有。**
 *   · `full` —— L0–L2：与 1.9.1 **逐字相同**（不省一个字符，行为不变）。
 *   · `head` —— L3：按**剩余预算**折叠（见 fitPaths）。折叠掉的永远是「同一个前缀被重述两遍」
 *     的那部分：WORKING 的尾节点就是当前位置时，WORKING 一个字符都不用写，只在 CURRENT PATH
 *     末尾标 `(working)`，不让模型误以为「工作位置」与「当前位置」不一致。
 *   · `n1`   —— L4/L5（兜底）：两条路径行合成一行 —— `路径（working）`，折叠掉中段；
 *     CURRENT PATH 省不出来时改写成 `# path:` 摘要行（当前位置 + 起点 + 折叠数），**当前位置永在**。
 * 任何形态都必须含**最后一个节点**（当前位置）；`[weak k/n]`、图例、置换提示一律不省。
 * 「折叠数」永远等于真实省略的节点数 —— 不印 `… +0`，也不凭空造节点。
 */
const PATH_SHAPE = ["full", "full", "full", "head", "n1", "n1"];
/** 折叠时头尾各至少保留几个节点。 */
const KEEP_HEAD = 2;
const KEEP_TAIL = 2;
/**
 * 路径行的**固定额度**（字符）。★ C-17 rev6（2026-10-30，Lead 定稿验收线②）：
 * 「L3+ 路径行相对 HEAD 净增 ≤50 tokens/会话」是硬额度。
 *
 * 为什么不能用「剩余预算」：`maxTokens×3 − 已用` 在多数会话里是 1000+ 字符，于是整条
 * n1→…→n177 的路径（1064 字符）会被判「放得下」，路径行把预算吃光 —— 实测 500 预算下
 * 超预算会话 7 → 29、avg 比 S2a 基线高 22 token。按固定 150 字符（≈50 token）封顶后，
 * 路径行永远只花一小份，档位越高折得越狠。
 */
const PATH_QUOTA_CHARS = 150;

const pathBody = (line, prefix) => (line ? line.slice(prefix.length + 2) : null);

/**
 * 把一串节点 id 按「头 head + 尾 tail」折叠成 `CURRENT PATH: …` 形态的行。
 * 短到折不出东西时原样返回（绝不印 `… +0`）。
 * @param {(id:string)=>string} [label] 节点 id → 显示名（默认原样）
 */
function foldIds(ids, label = (x) => x, head = KEEP_HEAD, tail = KEEP_TAIL) {
  if (ids.length <= head + tail + 1) return ids.map(label).join(" → ");
  const headIds = ids.slice(0, head);
  const tailIds = ids.slice(ids.length - tail);
  const omitted = ids.length - head - tail;
  return `${headIds.map(label).join(" → ")} → … +${omitted} → ${tailIds.map(label).join(" → ")}`;
}

/**
 * 生成两条路径行的 `full` 形态文本（L0–L2 用它，逐字不变）。
 * WORKING 为 null（没有工作路径）时 workingLine 也是 null。
 */
function foldPaths(currentIds, workingIds, sameAsWorking, pathLabel, workingLabel) {
  // 当前路径 === 工作路径：只显示 WORKING 一份（旧行为；S2a 定稿：打 weak 标 + 图例）
  return {
    droppedCurrent: sameAsWorking,
    currentLine: sameAsWorking || currentIds.length === 0 ? null : `CURRENT PATH: ${currentIds.map(pathLabel).join(" → ")}`,
    workingLine: workingIds === null || workingIds.length === 0 ? null : `WORKING: ${workingIds.map(workingLabel).join(" → ")}`,
  };
}

/** 一行折叠摘要：保住「起点 + 当前位置 + 折了几个」（比整条路径短一个数量级）。 */
function pathDigestLine(ids) {
  if (ids.length <= KEEP_HEAD + KEEP_TAIL + 1) return `# path: ${ids.join(" → ")}`;
  return `# path: ${foldIds(ids, (x) => x, 1, 1)} (current: ${ids.at(-1)})`;
}

/**
 * 按**剩余预算**（字符）把两条路径行折到装得下。L3(`head`) / L4-L5(`n1`) 都用它。
 *
 * `budget` = `maxTokens × 3 - 已用字符 - 余量`。为什么按剩余预算而不是固定配比：
 * 实测 session-c328440a 的 CURRENT PATH 有 158 个节点，各砍一半仍超预算（整条 708 tokens）；
 * 按剩余预算折才有上界。
 *
 * 规则：
 *  1. WORKING 尾节点 === CURRENT PATH 尾节点 ⇒ 当前路径本身就是工作路径的延续，
 *     不重述 WORKING —— CURRENT PATH 末尾标 `(working edge: <id>)`，保住那条边的 id（weak 标记也在）。
 *  2. 两条行都放得下就不折（`… +` 只在真的省下字符时才出现）。
 *  3. 放不下：先折 WORKING（它通常很短、本来就折不动），再折 CURRENT PATH；
 *     仍不行 ⇒ CURRENT PATH 退化成 `# path:` 摘要行，**当前位置永远在**。
 *  4. 预算为负（连标题都放不下）时也要给出一行 `# path: <当前位置>` —— 路径行不是可选项。
 */
function fitPaths(currentLine, workingLine, budget, shape, workingTag = "", { allowMerge = true } = {}) {
  const curBody = pathBody(currentLine, "CURRENT PATH");
  const workBody = pathBody(workingLine, "WORKING");
  if (curBody === null && workBody === null) return { currentLine, workingLine };
  const curIds = curBody === null ? null : curBody.split(" → ");
  const workIds = workBody === null ? null : workBody.split(" → ");

  // 规则 1：WORKING 尾节点 === 当前位置 ⇒ 工作路径就是当前路径的延续，不重述；
  //   改在其后标 `(working edge eN)`，这样「工作位置」和「哪条边算工作」（含 weak）都保住了。
  // allowMerge=false：即使两条路径同尾也**分开写**（L3+ 优先给显式的 `WORKING:` 行，
  // 模型不该靠 `(working edge e74)` 这种括号标记去猜工作位置）。预算不够时才允许合并。
  const sameTail = allowMerge && curIds !== null && workIds !== null && curIds.at(-1) === workIds.at(-1);
  const work = sameTail ? null : workIds;
  const tag = sameTail ? (workingTag ? ` (working edge ${workingTag})` : " (working)") : "";

  const curFull = curIds === null ? null : `CURRENT PATH: ${curIds.join(" → ")}${tag}`;
  const workFull = work === null ? null : `WORKING: ${work.join(" → ")}`;

  // 规则 2：整条清单放得下 ⇒ 原样（L0–L2 就是这个形态，逐字不变；L3 短路径也走这里）
  if ((curFull?.length ?? 0) + (workFull?.length ?? 0) <= budget) return { currentLine: curFull, workingLine: workFull };

  // 三种能省字符的形态，按「省得多、保得多」取第一个装得下的：
  //   A 两条行各折中段（保 CURRENT PATH 完整头尾 + WORKING 完整）
  //   B WORKING 折成 1+1，CURRENT PATH 完整 —— 工作位置的锚点（头尾）比中段重要
  //   C CURRENT PATH 退化成 `# path:` 摘要，WORKING 完整 —— 兜底：当前位置与工作位置都还在
  const shapes = [];
  if (curIds === null) {
    // ★ 只有 WORKING（当前路径 === 工作路径，foldPaths 已把 CURRENT PATH 省掉）。
    //   C17 初版在这里直接落进下面的 `else` 分支读 `curIds.length` ⇒
    //   `TypeError: Cannot read properties of null (reading 'length')`（实测崩在原 line 244，
    //   全量测试 C17-11/12/13 三红、runner 只打印到崩溃点）。这个形态必须自己折 WORKING。
    //   语义不变：WORKING 的尾节点就是当前位置；头 1 + 尾 1 起步，`… +N` 只在真省得下时出现。
    for (let keep = work.length - 1; keep >= KEEP_HEAD + KEEP_TAIL + 1; keep -= 1) {
      const tailK = Math.max(KEEP_TAIL, Math.round((keep * KEEP_TAIL) / (KEEP_HEAD + KEEP_TAIL)));
      const line = `WORKING: ${foldIds(work, (x) => x, Math.max(KEEP_HEAD, keep - tailK), tailK)}`;
      shapes.push({ currentLine: null, workingLine: line });
      if (line.length <= budget) return shapes.at(-1);
    }
    const workShortest = `WORKING: ${foldIds(work, (x) => x, 1, 1)}`;
    shapes.push({ currentLine: null, workingLine: workShortest });
    if (workShortest.length <= budget) return shapes.at(-1);
  } else if (work === null) {
    // 只有 CURRENT PATH：折中段
    for (let keep = curIds.length - 1; keep >= KEEP_HEAD + KEEP_TAIL + 1; keep -= 1) {
      const tailK = Math.max(KEEP_TAIL, Math.round((keep * KEEP_TAIL) / (KEEP_HEAD + KEEP_TAIL)));
      const line = `CURRENT PATH: ${foldIds(curIds, (x) => x, Math.max(KEEP_HEAD, keep - tailK), tailK)}${tag}`;
      shapes.push({ currentLine: line, workingLine: null });
      if (line.length <= budget) return shapes.at(-1);
    }
  } else {
    for (let keep = curIds.length - 1; keep >= KEEP_HEAD + KEEP_TAIL + 1; keep -= 1) {
      const tailK = Math.max(KEEP_TAIL, Math.round((keep * KEEP_TAIL) / (KEEP_HEAD + KEEP_TAIL)));
      const line = `CURRENT PATH: ${foldIds(curIds, (x) => x, Math.max(KEEP_HEAD, keep - tailK), tailK)}${tag}`;
      shapes.push({ currentLine: line, workingLine: workFull });
      if (line.length + (workFull?.length ?? 0) <= budget) return shapes.at(-1);
    }
    // ★ C-17 rev6：`head` 形态的正解是「两条都折、都保留可读头尾」，而不是直接退到 `# path:` 摘要
    //   （摘要是 L4/L5 `n1` 形态的兜底）。上方循环只把 WORKING 当整条配对，长 WORKING 会让每次配对都
    //   放不下，于是 L3 直接跳到摘要 —— 实测 mixed(40,6) 在 L3 只拿到 `# path: n1(user) → … +45 → n47`，
    //   路径形态全丢了。这里补「折 CURRENT PATH（头 3 尾 3）+ 折 WORKING（头 2 尾 2）」这一档。
    if (shape === "head") {
      const curHead = `CURRENT PATH: ${foldIds(curIds, (x) => x, 3, 3)}${tag}`;
      const workHead = `WORKING: ${foldIds(work, (x) => x, 2, 2)}`;
      shapes.push({ currentLine: curHead, workingLine: workHead });
      if (curHead.length + workHead.length <= budget) return shapes.at(-1);
    }
    const workShort = `WORKING: ${foldIds(work, (x) => x, 1, 1)}`;
    shapes.push({ currentLine: curFull, workingLine: workShort });
    if ((curFull?.length ?? 0) + workShort.length <= budget) return shapes.at(-1);
    shapes.push({ currentLine: `${pathDigestLine(curIds)}${tag}`, workingLine: workShort });
    if (`${pathDigestLine(curIds)}${tag}`.length + workShort.length <= budget) return shapes.at(-1);
    shapes.push({ currentLine: `${pathDigestLine(curIds)}${tag}`, workingLine: workFull });
    if (`${pathDigestLine(curIds)}${tag}`.length + (workFull?.length ?? 0) <= budget) return shapes.at(-1);
  }
  // 规则 3：一条都装不下 ⇒ 取最短的那条（绝不返回空 → 路径行不是可选项）
  shapes.sort((a, b) => (a.currentLine?.length ?? 0) + (a.workingLine?.length ?? 0) - ((b.currentLine?.length ?? 0) + (b.workingLine?.length ?? 0)));
  if (shapes.length > 0) return shapes[0];
  return {
    currentLine: curIds === null ? null : `${pathDigestLine(curIds)}${tag}`,
    workingLine: workFull,
  };
}


/**
 * 渲染热上下文。
 * @param {{maxTokens?:number, tailFailures?:number, markers?:'semantic'|'terse'|'off'}} [options]
 * @returns {{text:string, tokens:number, level:number, omittedEdges:number, failureCount:number, shownFailures:number}}
 */
export function renderLedger(g, { maxTokens = 500, tailFailures = 20, markers = "semantic", treeDir = "", traceRoot = "", now = Date.now() } = {}) {
  // ★ P6-A（task-56）：热清单只展示「有终点」的失败边。`to=null` 且已结算（或 untested 超 10 分钟）
  //   的是 rewash 历史残留，占全库失败边的 27.8%（268/964）——它们没有终点，构不成「哪一步失败了」，
  //   留在清单里只是噪声。**live_unsettled（新产生、≤10min 的 untested）必须保留**，否则会把
  //   「正在执行、还没结算」误判成不存在。
  const allFailures = failureEdges(g);
  const failures = allFailures.filter((e) => !isDanglingResidue(e, { graph: g, now }));
  const omittedResidue = allFailures.length - failures.length;
  const dangling = danglingStats(g, { now });
  // ★ P6-A：UNVERIFIED_CLAIMS 里的 rewash 残留（to=null 的 unverified）同样是噪声 ——
  //   它们既没有终点、也不可能再被结算（result 已写死 unverified），展示出来只会占行数。
  //   live_unsettled 必须保留（正在执行、还没结算）。
  // ★ P6C-1（2026-10-30）：**未落地（untested + to=null）的边不再混进 UNVERIFIED** ——
  //   「跑了但没外部验证信号」和「还没落地、可以继续也可以放弃」是两类信息，混在一起模型会当成
  //   「已验证过但不可信」，于是不敢用也不敢弃。现在它们单独进 OPTIONS 区段。
  const options = Object.values(g.edges).filter((e) => isDanglingOption(e, { graph: g, now }));
  const open = openEdges(g).filter((e) => !isDanglingResidue(e, { graph: g, now }) && !isDanglingOption(e, { graph: g, now }));
  const latest = latestAgentNode(g);
  const path = latest ? currentPath(g, latest.id) : [];
  const root = g.rootNode ?? g.rootUserNodeIds.map((id) => g.nodes[id]).filter(Boolean)[0];

  // ★ 手割分析（每条边一次 BFS）**只算一次**，算在「最后 30 条失败边」上：
  //   降级链的 L4/L5 只列尾部若干条，都是这 30 条的子集 ⇒ 一次计算够所有档位用。
  //   旧版放在档位循环里，2000 边时要跑 6 档 × 30 条 BFS（实测渲染 4.9 → 7.5ms）；
  //   旧旧版更糟：显示条数 >30 时一条都不算 ⇒ 大会话里手割标记全丢。
  const tewariMap = new Map();
  for (const e of failures.slice(-30)) tewariMap.set(e.id, tewariAnalysis(g, e));

  // ★ P1（2026-10-30）：置换索引，一次建好。
  //   旧写法在**每个档位**里、对**每个 path hop** 都做一次 `Object.values(g.edges).some(...)`
  //   ⇒ O(档位 × path × E)：真实最大图 852 边 / 16 跳实测 0.92–1.17ms/档位（索引化后 0.06ms）。
  const transpositionKeys = new Set();
  for (const e of Object.values(g.edges)) {
    if (e.transposition && e.from && e.to) transpositionKeys.add(`${e.from}>${e.to}`);
  }

  // ★ 便宜的降级：某一档**注定装不下**时不要白渲染（2000 边时要为 L0–L3 各拼 1201 行字符串，
  //   实测渲染 7.6ms/步；跳过装不下的档位后回到 ~5ms）。判据是每行的**下界**长度
  //   （id + 意图上限 + 原因上限 + 标记余量），再乘条数 —— 比真实输出小，所以只会跳过
  //   铁定不合规的档位，不会误伤。
  const LEVEL_LEN = [[70, 90], [50, 60], [34, 36], [22, 25]];

  // ★ C-17（2026-10-30）：路径行按档位**变省**，而不是 L3 起消失。
  //   旧版 `path.length > 1 && level <= 2` ⇒ S2a 的 WORKING 行让 3 个会话多出 ~28~46 tokens
  //   从 L2 掉到 L3，于是「唯一的新信息」（工作路径）反而消失（实测见 docs 与
  //   test/c17-path-at-every-level.test.mjs 头部）。现在每档都渲染，形态见 PATH_SHAPE。
  //
  //   WORKING 的锚点规则（2026-10-30 S2a 定稿，C-17 **不变**）：有强 success 就只用强 success；
  //   一条都没有时才退到弱成功（prefer-strong）。为什么不是 union 见下；旧图没有 weak 字段时
  //   由 weakKindOf 用 settled 的 verify.kind === "read" 识别（读旧图不掉行）。
  //   这段计算与档位无关 ⇒ 提到循环外，每档只做一次字符串折叠（省 CPU，也保证各档看到同一条链）。
  const navigable = (e) => Boolean(e.to && e.from !== e.to && g.nodes[e.to]);
  const strongAnchors = Object.values(g.edges).filter((e) => e.result === "success").filter(navigable);
  const anchorEdges = strongAnchors.length > 0 ? strongAnchors : Object.values(g.edges).filter((e) => weakKindOf(e)).filter(navigable);
  let workingIds = null;
  let workingTail = null;
  let workingWeak = 0;
  if (anchorEdges.length > 0) {
    const last = anchorEdges[anchorEdges.length - 1];
    const ids = [last.from, last.to];
    const chainEdges = [last];
    const seen = new Set(ids);
    let cur = last.from;
    for (;;) {
      const prev = anchorEdges.find((e) => e.to === cur && e.from !== e.to && g.nodes[e.from] && !seen.has(e.from));
      if (!prev) break;
      ids.unshift(prev.from);
      chainEdges.unshift(prev);
      seen.add(prev.from);
      cur = prev.from;
    }
    workingIds = ids;
    workingTail = last;
    workingWeak = chainEdges.filter((e) => weakKindOf(e)).length;
  }
  const currentIds = path.map((n) => n.id);
  // 「当前路径 === 工作路径」就只显示一份（旧行为，S2a 定稿：行内容打标 + 图例，省 20~40 tokens）
  const sameAsWorking =
    workingIds !== null && workingIds.length === currentIds.length && workingIds.every((id, i) => id === currentIds[i]);
  const pathLabel = (id) => `${id}${g.nodes[id]?.kind === "user" ? "(user)" : ""}`;
  const workingLabel = (id) => (g.nodes[id]?.kind === "user" ? "user" : id);
  // 两条待渲染的路径行（full 形态）；L3+ 再按剩余预算折叠（见 fitPaths）
  const { currentLine, workingLine } = foldPaths(currentIds, workingIds, sameAsWorking, pathLabel, workingLabel);
  // WORKING 尾部那条边的 id：L3+ 把 WORKING 合并进 CURRENT PATH 时用它保住「哪条边算工作」
  const workingTailId = workingTail?.id ?? "";

  /** 各档渲染结果（L4/L5 比过再定，见循环末尾）。 */
  const attempts = [];

  // ★ S5（2026-10-31）：TRACE 行两形态。带 recent 的版本在**预算装不下时退回旧形态**，
  //   否则「加一条新信息」会把本来刚好装下的会话顶到 500 以上（真实语料实测 30→31 个超预算）。
  //   先算好两条候选行，各档按预算选（见循环末尾的 dropped 逻辑）。
  const traceBaseLine = treeDir ? `TRACE: ${traceRelativeDir(treeDir, traceRoot)}/index.md` : null;
  const traceRecentSeg = traceBaseLine === null ? "" : traceRecentSegment(path);
  const traceRecentLine = traceRecentSeg === "" ? null : `${traceBaseLine} · ${traceRecentSeg}`;

  /** 某一档「注定装不下」的下界（只会跳过铁定超预算的档，不误伤）。 */
  const doomed = (lv) => {
    if (failures.length === 0) return false;
    const shownCount = lv === 4 ? Math.min(failures.length, tailFailures) : lv === 5 ? Math.min(failures.length, 10) : failures.length;
    const [intentLen, reasonLen] = LEVEL_LEN[Math.min(lv, 3)];
    return Math.ceil((shownCount * (25 + intentLen + reasonLen) + 300) / 3) > maxTokens;
  };

  for (let level = 0; level <= 5; level += 1) {
    if (level < 4 && doomed(level)) continue; // L0–L3：装不下的档不必白渲染（旧行为）
    // L4：只有**连 L5 都装不下**时才跳过 —— 否则「装不下也必须渲染一遍再比」（旧版语义：兜底要有下文）。
    //   旧条件是 `failures.length > tailFailures`（20），而 L5 的 shownCount 用 10 ⇒ 预算只够 L3 时
    //   L5 的下界变小、L4 被跳过 —— 实测 6 张图因此从「L3 全量」直接落成「L5 只列 10 条」并超预算。
    if (level === 4 && doomed(4) && doomed(5)) continue;
    const lines = [];
    lines.push("<chess-ledger>");
    // ★ C-17 rev6：L3+ 的 root 裁剪从 180 收到 168 —— 给「最小路径行」预留 12 字符。
    //   不这么做时，1.9.1 在 L3 恰好用满预算的会话（如 5b38b355 HEAD=497/1490 字符）
    //   只要多一行 `# path: n185` 就 501，成为唯一一个「新增超预算」。路径信息优先于
    //   root 尾部 12 个字符（root 本来就已被 clip，且 L0–L2 逐字不变）。
    if (root) lines.push(`ROOT USER (verbatim): ${clip(root.text, level === 0 ? 900 : level === 1 ? 500 : level === 2 ? 300 : 168)}`);
    // 始终收集**所有** user 节点的约束：旧版只要 root 有约束就只看 root，
    // 后续用户消息里的约束（"不要动 prod 配置"）在热清单里消失（审查 P1-6）。
    const cons = collectConstraints(g);
    if (cons.length) {
      lines.push("CONSTRAINTS (verbatim):");
      for (const c of cons.slice(0, 12)) lines.push(`- ${clip(c, level <= 1 ? 220 : 120)}`);
    }
    // ★ C-17（2026-10-30，verifier 抓到的回归修复）：失败边块**先算成字符串数组**（先不 push），
    //   这样路径行的预算能扣掉它的**真实长度**。
    //   旧写法只扣 header/root/constraints ⇒ pathBudget 恒 ≈ 1360 字符 ⇒ L3 把整条 177 节点路径
    //   原样塞进去（e3820651 一图 331→742 tokens）。实测 500 预算下超预算会话 7 → 25，全是这条。
    //   先算后扣 ⇒ 折出来的路径行才是「整条清单真的装得下」，而不是「路径自己装得下」。
    let shown = failures;
    let omitted = 0;
    if (level === 4 && failures.length > tailFailures) {
      // L4：只列最近的若干条，其余用汇总行保证可发现（不假装不存在）
      shown = failures.slice(-tailFailures);
      omitted = failures.length - shown.length;
    }
    if (level === 5 && failures.length > 10) {
      // L5（P2-13 兜底）：极端输入（如 12 条 200 字约束）下 L4 仍会超预算，最后只留最近 10 条
      shown = failures.slice(-10);
      omitted = failures.length - shown.length;
    }
    const tailLines = [];
    // ★ P6-A：被排除的残留必须**说一句**（不能静默消失）。一行、带计数，模型知道「有东西被省了」。
    // 残留省略不单独站一行（每行都是 token）：renderFacts 里有 DANGLING_RESIDUE 计数，热清单只求不展示。
    if (failures.length) {
      tailLines.push(`LEARNED (${failures.length} failed attempts):`);
      // ★ 2026-10-29（goal ⑤）：旧版让模型去读 `graph.md` —— 而那个文件从 v1.2.2 起就不再自动写了（死指针）。
      //   真实的三层树是 index.md + nodes/<id>.md。这里给出**可点的实际路径**，模型要细节时知道去哪。
      // ★ P6a（2026-10-30）：TRACE 只给**相对路径**（`sessions/<sid>/index.md`）。
      //   旧版把 `treeDir` 的绝对路径整条写进去（`D:\DeepSeek Harness\home\chess-context\sessions\<sid>`，
      //   实测 137.7 字符/行）——既把本机用户名/盘符泄漏给模型，又白烧 token（生产口径 94/133 个会话
      //   带 TRACE 行，平均 +45 token）。相对路径对模型足够定位（会话根 = DSH_HOME/chess-context），
      //   且 `traceRoot` 可配置（默认 "sessions"）。
      // ★ S5（2026-10-31）：TRACE 行在相对路径后面附「最近 3 个路径节点 + 一句话」。
      //   仍是一行；空路径时 traceRecentLine 为 null ⇒ 这一行与旧版逐字相同。
      if (traceRecentLine !== null) tailLines.push(traceRecentLine);
      else if (traceBaseLine !== null) tailLines.push(traceBaseLine);
      // 手割分析（tewari）：每条边一次 BFS，防 O(E²) —— 只对**最近 30 条**做。
      // ★ 2026-10-29：旧版是「显示条数 ≤30 才算」⇒ 一次有 40 条失败边的会话里，
      //   手割标记**一条都没有**（而模型永远只对最近几步做决策）。改成对尾部 30 条算，
      //   无论总数多少，最近这批边都有标记。
      // ★ P1（2026-10-30）：直接复用本函数开头算好的 tewariMap（失败边尾部 30 条，覆盖所有档位），
      //   不再每个档位重算一遍 —— 旧写法 6 个档位 × 30 条 = 180 次重复手割，是渲染耗时的主因。
      const markerLines = markerLegendLines(shown.map((e) => failureTags(e, tewariMap.get(e.id) ?? null, markers)));
      for (const line of markerLines) tailLines.push(line);
      if (omitted > 0) {
        tailLines.push(
          `- … ${omitted} earlier dead ends omitted for budget: ${failures[0].id}..${failures[omitted - 1].id} — full text: ${treeDir ? `${treeDir}/index.md` : "index.md"} (per node: nodes/<id>.md) / by seq in the session log`,
        );
      }
      for (const e of shown) tailLines.push(renderFailureLine(e, level, tewariMap.get(e.id) ?? null, markers));
    }
    // ★ P6C-1：OPTIONS 区段（新鲜 + 陈旧，陈旧标 `[stale Xm]`）。只在 L0/L1 出现，
  //   与 UNVERIFIED 同档 —— 它们是「下一步要不要接着做」的决策信息，预算紧张时先让位给失败记忆。
  if (options.length && level <= 1) {
      tailLines.push("OPTIONS (not yet landed — you may continue or abandon):");
      for (const e of options.slice(-6)) tailLines.push(`- ${e.id} "${clip(e.intent || e.action, 50)}"${staleTagOf(e, now)}`);
    }
    if (open.length && level <= 1) {
      tailLines.push("UNVERIFIED (ran, but no external signal — treat as unproven):");
      for (const e of open.slice(-6)) tailLines.push(`- ${e.id} "${clip(e.intent || e.action, 50)}"`);
    }
    if (path.length > 1) {
      const shape = PATH_SHAPE[Math.min(level, PATH_SHAPE.length - 1)];
      // ★ C-17（2026-10-30，第二轮修）：路径行预算必须扣掉**这一档除路径以外的全部行** ——
      //   header / root / constraints **以及已经算好的 tailLines（失败边块）**、还要 push 的
      //   CURRENT GOAL / weak 图例 / `# WORKING: none` / 置换提示 / `</chess-ledger>`。
      //   第一版只扣了 header 那几行 ⇒ pathBudget 恒 ≈ maxTokens×3 ⇒「整条路径放得下就原样」，
      //   于是 L3 把 n1→…→n177 共 1064 字符原样塞进去：实测 500 预算下超预算会话 7 → 25
      //   （verifier 复验抓到；e3820651 331→742、6f90bd1d 453→810 …）。
      //   现在 prePathChars 是**精确字符数**，`available` 才是路径行真正能用的额度。
      const goal = latest?.goal;
      const goalLine = goal ? `CURRENT GOAL: ${clip(goal, level <= 1 ? 240 : 120)}` : null;
      const transpositionNote = (() => {
        let transposed = 0;
        for (let i = 1; i < path.length; i += 1) {
          const fromId = path[i - 1].id;
          const toId = path[i].id;
          if (transpositionKeys.has(`${fromId}>${toId}`)) transposed += 1;
        }
        if (transposed === 0) return null;
        return `⚠ 置换：当前路径有 ${transposed} 处回到已走过的状态（共 ${path.length - 1} 跳）——那些状态上试过的做法都记在下面的死路清单里，别重复。`;
      })();
      const sizeOf = (arr) => arr.reduce((n, l) => n + l.length + 1, 0);
      const fixedLines = [
        ...(goalLine ? [goalLine] : []),
        ...(workingWeak > 0 ? [WEAK_LEGEND] : []),
        ...(workingIds === null && shape !== "full" ? ["# WORKING: none"] : []),
        ...(transpositionNote ? [transpositionNote] : []),
      ];
      // ★ 行尾后缀（` (exit 0)` / ` [weak k/n]`）也要算进路径行的字符：它是拼在路径行尾巴上的，
      //   但 fitPaths 看不到它。漏扣的实测后果：「498 字符的整条路径在 525 额度内放得下」成立、
      //   加上 43 字符后缀就超了 ⇒ 每张图稳定落在 518~519 tokens（超预算会话 7 → 29）。
      const tailWeak = workingIds !== null && weakKindOf(workingTail);
      // 尾部是弱边时**不出** verify 摘要：弱边的 summary 是「1234 chars」，放在这里会被读成验证信号
      const workSummary = workingIds !== null && !tailWeak && workingTail?.verify?.summary ? ` (${clip(workingTail.verify.summary, 40)})` : "";
      const weakTag = workingIds !== null && workingWeak > 0 ? ` [weak ${workingWeak}/${workingIds.length - 1}]` : "";
      const suffixChars = workSummary.length + weakTag.length;
      // 精确口径：正文由各 line 用换行拼成 ⇒ 总字符 = Σ(len+1) − 1；结尾行 `</chess-ledger>` 也要算。
      const prePathChars = sizeOf(lines) + sizeOf(tailLines) + sizeOf(fixedLines) + "</chess-ledger>".length; // sizeOf 已含各行 +1，join 少 1 由这里抵掉
      /** 两条路径行真正能用的字符额度（已扣掉后缀）。 */
      // 再减 2：`actual = prePathChars + pathChars − suffixChars − 1`，而 fitPaths 只看行长度、
      // 不含每行换行（最多 2 行）—— 不扣这 2 个字符就会稳定超 1~2 字符（实测 501 tokens 就是这么来的）。
      // ★ rev6：额度 = min(固定 150 字符, 真实剩余)，并且**这 150 字符要含 weak 图例与行尾后缀** ——
      //   它们都由路径块引起，不能只算路径行本身。实测漏算时单会话净增 90 token（04538c62 346→436：
      //   路径行 159 字符 + 图例 109 字符），直接突破「≤50 token/会话」的硬额度。
      const legendChars = workingWeak > 0 ? WEAK_LEGEND.length + 1 : 0;
      const quota = Math.max(0, PATH_QUOTA_CHARS - suffixChars - legendChars - 2);
      const available = Math.max(0, Math.min(quota, maxTokens * 3 - prePathChars - suffixChars - 2));
      /** 两条路径行占用的字符数（含各自的行尾换行 + 后缀）。 */
      const pathChars = (f) =>
        (f.currentLine ? f.currentLine.length + 1 : 0) + (f.workingLine ? f.workingLine.length + 1 : 0) + (f.currentLine || f.workingLine ? suffixChars : 0);
      let folded;
      /** 极端兜底：路径降到「一行最小形态」时为 true（此时不挂 weak 标记，见下）。 */
      let minimalPath = false;
      if (shape === "full") {
        folded = { currentLine, workingLine };
      } else {
        // ① 先按**分开写**折（显式 `WORKING:` 行）：模型不该靠 `(working edge e74)` 猜工作位置。
        folded = fitPaths(currentLine, workingLine, available, shape, workingTailId, { allowMerge: false });
        // ② 分开写装不下 ⇒ 允许把同尾的 WORKING 并进 CURRENT PATH（省一整行）
        if (Math.ceil((prePathChars + pathChars(folded)) / 3) > maxTokens) {
          const mergedTry = fitPaths(currentLine, workingLine, available, shape, workingTailId, { allowMerge: true });
          if (pathChars(mergedTry) < pathChars(folded)) folded = mergedTry;
        }
        // ③ 折完**实测**一次：`estimateTokens` 数的是整条文本，`(user)` 后缀等会让「路径字符串长度」
        //    与真实占用对不上。装不下就按真实剩余重折，仍装不下再退到摘要形态；折不动了就停（不空转）。
        for (let pass = 0; pass < 3; pass += 1) {
          if (Math.ceil((prePathChars + pathChars(folded)) / 3) <= maxTokens) break;
          const remaining = Math.max(0, Math.min(quota, maxTokens * 3 - prePathChars - suffixChars - 2));
          const next = fitPaths(currentLine, workingLine, remaining, pass >= 1 ? "n1" : shape, workingTailId, { allowMerge: true });
          if (pathChars(next) >= pathChars(folded)) break;
          folded = next;
        }
        // ★ 最后兜底（C-17 第四轮修）：正文（root/约束/失败边）本身已经把预算吃满时，任何带路径的形态
        //   都可能装不下。**但 L3+ 绝不允许静默省略路径**（verifier 实测有 19 个会话一行路径都没有，
        //   其中 06698df9 pathLen=134、195ca61a 211、c4e44fab 151）——至少必须给出一行「当前位置」。
        //   阶梯：`# path: current <cur> working <work>` → `# path: current <cur>` → `# path: <cur>`。
        //   ★ 这一档不挂 `[weak k/n]`：标记必须与图例同行，图例（~108 字符）在这个预算下放不下；
        //     要么「标记 + 图例」一起有，要么都没有 —— 不许让标记裸奔。
        if (Math.ceil((prePathChars + pathChars(folded)) / 3) > maxTokens) {
          const curTail = currentIds.at(-1) ?? "?";
          const workTail = workingIds !== null ? workingIds.at(-1) : null;
          const ladder = [
            `# path: current ${curTail}${workTail && workTail !== curTail ? ` working ${workTail}` : ""}`,
            `# path: current ${curTail}`,
            `# path: ${curTail}`,
          ];
          const pick = ladder.find((line) => Math.ceil((prePathChars + line.length + 1) / 3) <= maxTokens);
          // ★ 连最短一行都装不下也**照样输出最短那行**：宁可这一档超预算（会落到 L4/L5 由 pickFallback 择优），
          //   也不允许「路径整块消失」——静默省略比超预算更危险（模型会以为没有路径）。
          folded = { currentLine: pick ?? ladder[ladder.length - 1], workingLine: null };
          minimalPath = true;
        }
      }
      // ★ C-17 修（2026-10-30）：WORKING 可能被**并进** CURRENT PATH（同尾 ⇒ fitPaths 规则 1，
      //   workingLine 返回 null）。旧写法直接 `${folded.workingLine}${summary}${weakTag}` ⇒
      //   实测 session-569f9cd0 输出一行字面量 `null [weak 1/1]`：
      //   既印了 "null"，又把「工作位置」藏了。现在把摘要与 weak 标记挂到**合并后的那一行**上。
      const mergedIntoCurrent = workingIds !== null && folded.workingLine === null;
      // 最小形态/整块省略时，摘要与 weak 标记必须一起压掉（否则标记裸奔、或又超预算）
      const suffixSummary = minimalPath ? "" : workSummary;
      const suffixWeak = minimalPath ? "" : weakTag;
      // 只有「当前路径 ≠ 成功路径」时才额外显示 CURRENT PATH（否则 WORKING 已经说了）
      if (folded.currentLine) lines.push(`${folded.currentLine}${mergedIntoCurrent ? `${suffixSummary}${suffixWeak}` : ""}`);
      if (goalLine) lines.push(goalLine);
      if (workingIds !== null) {
        if (!mergedIntoCurrent) lines.push(`${folded.workingLine}${suffixSummary}${suffixWeak}`);
        if (workingWeak > 0 && !minimalPath) lines.push(WEAK_LEGEND);
      } else if (shape !== "full") {
        // 没有工作路径（没有强 success、也没有弱锚点）时的退化：只说一句「这一行缺失是有原因的」，
        // 不给模型留「路径被省掉了、去别处找」的错觉。L0–L2 维持旧行为（不出这一行）。
        lines.push("# WORKING: none — no step in this session reached a new position yet");
      }
      // ★ 置换提示（P1-12）：路径上出现 transposition 标记的边 = 回到了走过的状态。
      //   （A2-5 已删掉那个从来没有调用点的旧包装；提示由 transpositionNote 直接生成。）
      if (transpositionNote) lines.push(transpositionNote);
    } else if (PATH_SHAPE[Math.min(level, PATH_SHAPE.length - 1)] !== "full") {
      // ★ C-17：L3+ 连「路径」本身都不存在时也要留一行说明 —— 「没有路径」和「路径被省掉了」
      //   对模型是两件事，静默省略会让它以为路径藏起来了。L0–L2 保持旧行为（不出这一行）。
      lines.push("# path: none — no navigable path from the root yet (no step has reached a position)");
    }

    for (const tailLine of tailLines) lines.push(tailLine);
    lines.push("</chess-ledger>");
    let text = lines.join("\n");
    let tokens = estimateTokens(text);
    // ★ S5：带 recent 的 TRACE 把这一档顶出预算时，**先退回旧 TRACE 形态**再判档 ——
    //   宁可少给一条新信息，也不让本来装得下的会话变成 over-budget（真实语料实测 30→31）。
    //   没有失败边时 TRACE 行根本不出现（它在 LEARNED 块里）⇒ 记 "none"，别让调用方以为给了。
    let traceRecent = traceRecentLine === null || failures.length === 0 ? "none" : "full";
    if (traceRecent === "full" && tokens > maxTokens) {
      const stripped = text.replace(traceRecentLine, traceBaseLine);
      const strippedTokens = estimateTokens(stripped);
      if (strippedTokens <= maxTokens) {
        text = stripped;
        tokens = strippedTokens;
        traceRecent = "dropped-for-budget";
      }
    }
    attempts.push({ text, tokens, level, omittedEdges: omitted, failureCount: failures.length, shownFailures: shown.length, traceRecent });
    // ★ C-17：L0–L3 装下就立刻返回（与旧版一致）；L4/L5 是兜底但要**比一比**再定 ——
    //   旧版 L4 只要走进来就无条件返回，即使它比 L5 更费（L4 列 20 条、L5 列 10 条）。
    //   现在两档都渲染后再选：优先「预算内 tokens 最小」，其次「tokens 最小」，最后「列得最多」。
    if (level < 4 && tokens <= maxTokens) return { ...attempts.at(-1), fallback: "none", budgetMax: maxTokens, overBudgetBy: 0 };
  }
  const best = pickFallback(attempts, maxTokens, failures.length);
  if (best) {
    // ★ P5（2026-10-30）：`pickFallback` 不得**静默**返回超预算内容。
    //   `fallback` 三态：none（预算内）/ over-budget（兜底超限，但已是最省的那份）/ impossible（连兜底都构造不出）。
    //   `overBudgetBy` 给指标系统单独统计，调用方（engine/doctor/审计）不需要自己再算一遍。
    const over = Math.max(0, best.tokens - maxTokens);
    return { ...best, fallback: fallbackStatusOf(best, maxTokens), budgetMax: maxTokens, overBudgetBy: over };
  }
  /* istanbul ignore next -- 循环必然返回 */
  return {
    text: "",
    tokens: 0,
    level: 5,
    omittedEdges: failures.length,
    failureCount: failures.length,
    shownFailures: 0,
    fallback: "impossible",
    budgetMax: maxTokens,
    overBudgetBy: 0,
  };
}

/**
 * ★ OPT-EMPTY（task-130）：**零失败边**会话的最小注入内容。
 *
 * 背景：真实 167 个会话里 42 个（25.1%）没有任何失败边 —— 旧版 `decideInjection` 直接
 * `skip("no-ledger")`，这些会话连根目标/约束都拿不到。但它们**不是空的**：42/42 有 root，
 * 32/42 有 constraints（见 ws-opt-empty-ledger/REPORT.md 的只读统计）。
 *
 * 为什么不用 `renderLedger` 的最小档：那档仍会带 ROOT 原文，实测 42 个零失败会话
 * avg 386 tok / max 497 —— 对「没有任何失败记忆」的会话是纯噪声。
 * 这里只给三行事实（仍是既有的 `<chess-ledger>` 包裹，不是新的消息格式）：
 *   GOAL: …            （有 goal 用 goal，否则用 root 原话）
 *   CONSTRAINTS: N     （数量，不展开原文）
 *   NO_FAILED_ATTEMPTS_YET
 *
 * @returns {{text:string, tokens:number, level:number, omittedEdges:number, failureCount:number, shownFailures:number, fallback:string, budgetMax:number, overBudgetBy:number}}
 */
export function renderMinimalLedger(g, { maxTokens = 500 } = {}) {
  const root = g?.rootNode ?? (g?.rootUserNodeIds ?? []).map((id) => g?.nodes?.[id]).filter(Boolean)[0];
  const latest = latestAgentNode(g);
  const goalText = clip(String(latest?.goal ?? root?.text ?? "").replace(/\s+/g, " ").trim(), 120);
  const constraints = root?.constraints ?? [];
  const lines = ["<chess-ledger>"];
  if (goalText) lines.push(`GOAL: ${goalText}`);
  lines.push(`CONSTRAINTS: ${constraints.length}`);
  lines.push("NO_FAILED_ATTEMPTS_YET");
  lines.push("</chess-ledger>");
  const text = lines.join("\n");
  const tokens = estimateTokens(text);
  const over = Math.max(0, tokens - maxTokens);
  return {
    text,
    tokens,
    level: 5,
    omittedEdges: 0,
    failureCount: 0,
    shownFailures: 0,
    fallback: over > 0 ? "over-budget" : "none",
    budgetMax: maxTokens,
    overBudgetBy: over,
    minimal: true,
  };
}

/**
 * L4/L5 的裁决（C-17）。两个兜底档都可能越过预算，选的时候按三层优先：
 *   1. 预算内优先（`tokens <= maxTokens`）；
 *   2. 可比时 tokens 小者胜 —— 预算内、预算外分别比；
 *   3. 平手时列得多的胜（L4 的 20 条 > L5 的 10 条）：能多给一条真实失败原因，就多给一条。
 */
function pickFallback(attempts, maxTokens, failureCount) {
  if (attempts.length === 0) return null;
  const within = attempts.filter((a) => a.tokens <= maxTokens);
  const pool = within.length > 0 ? within : attempts;
  pool.sort((a, b) => a.tokens - b.tokens || b.shownFailures - a.shownFailures);
  return pool[0] ?? { text: "", tokens: 0, level: 5, omittedEdges: failureCount, failureCount, shownFailures: 0 };
}

/**
 * 按**实际用到**的标记生成图例 —— 每个用到的标记一行，没用到的不出现。
 * 这是「模型能不能看懂标记」的兜底：标记只要出现，解释就一定在同一份清单里，
 * 不依赖「有没有检测到手割」这种无关条件（旧版的 bug：只有 EACCES 的会话里 [blocked] 裸奔）。
 */
function markerLegendLines(tagLists) {
  const seen = [];
  for (const tags of tagLists) {
    for (const tag of tags ?? []) {
      const key = legendKey(tag);
      if (!seen.includes(key)) seen.push(key);
    }
  }
  if (seen.length === 0) return [];
  const out = ["# markers:"];
  for (const key of seen) out.push(`#   ${key} = ${MARKER_LEGEND[key] ?? "(unknown marker)"}`);
  return out;
}

export function collectConstraints(g) {
  const out = [];
  for (const id of g.order) {
    const node = g.nodes[id];
    if (node?.kind === "user" && Array.isArray(node.constraints)) out.push(...node.constraints);
  }
  return [...new Set(out)];
}

/**
 * 给摘要模型的「硬事实块」。这是防摘要漂移的核心：
 * 这些内容由规则抽取、逐字保留，模型只负责压缩表达，不负责决定丢什么。
 * ★ 这里**全量**（不降级）—— 摘要是一次性成本，且失败边正是压缩必须保住的东西。
 */
export function renderFacts(g, { maxFailures = 800, headFailures = 80, range = null, now = Date.now() } = {}) {
  let allFailures = failureEdges(g);
  // ★ P1-8：增量 fold 只应把**本段**失败边塞进摘要。旧版取全量 → 摘要体积随全局失败数增长，
  //   真实会话的 fold 摘要已 13,953 字符；再涨会触发官方「summary 不小于被遮蔽内容」，fold 永久失败。
  //   历史失败边由前一个 checkpoint 的摘要承载。
  if (range && typeof range.start === "number" && typeof range.end === "number") {
    const overlapped = allFailures.filter((e) => {
      const s = e.evidence?.start ?? (typeof e.evidence === "number" ? e.evidence : null);
      const t = e.evidence?.end ?? s;
      if (s === null) return true; // 没有位置信息的保守保留
      return t >= range.start && s <= range.end;
    });
    // 极端情况下本段没有失败边：保留最近 20 条，避免摘要完全失去失败记忆
    allFailures = overlapped.length > 0 ? overlapped : allFailures.slice(-20);
  }
  let failures = allFailures;
  let omitted = 0;
  let omittedSpan = "";
  if (allFailures.length > maxFailures) {
    // 极端规模（bench 实测 1201 条 ≈ 22 万字符 / 7.4 万 token，单次摘要就贵得离谱）：
    // 保留「最早的 headFailures 条（根因）+ 最近的部分（当前状态）」，中间用汇总行保证可发现。
    const head = allFailures.slice(0, headFailures);
    const tail = allFailures.slice(-(maxFailures - headFailures));
    failures = [...head, ...tail];
    omitted = allFailures.length - failures.length;
    const firstOmitted = allFailures[headFailures];
    const lastOmitted = allFailures[allFailures.length - (maxFailures - headFailures) - 1];
    omittedSpan = `${firstOmitted.id}..${lastOmitted.id}`;
  }
  const compact = allFailures.length > 300;
  const latest = latestAgentNode(g);
  const path = latest ? currentPath(g, latest.id) : [];
  const root = g.rootUserNodeIds.map((id) => g.nodes[id]).filter(Boolean)[0];
  const lines = [];
  lines.push("[HARD FACTS — mechanically extracted from the session log; authoritative; must survive compression unchanged]");
  if (root) {
    // 1MB 的粘贴内容不能整段进 prompt（实测：100 万字符）。保留前 4000 字符 + 明确标注截断。
    const ROOT_LIMIT = 4000;
    const rootText = root.text.length > ROOT_LIMIT ? `${root.text.slice(0, ROOT_LIMIT)}
[… truncated ${root.text.length - ROOT_LIMIT} chars; full text in session log seq ${root.seq}]` : root.text;
    lines.push(`ROOT_USER_REQUEST_VERBATIM >>`);
    lines.push(rootText);
    lines.push(`<< END ROOT_USER_REQUEST (seq ${root.seq})`);
  }
  const cons = collectConstraints(g);
  if (cons.length) {
    lines.push("CONSTRAINTS_VERBATIM:");
    for (const c of cons) lines.push(`* ${c}`);
  }
  if (omitted > 0) {
    lines.push(`FAILED_ATTEMPTS_OMITTED: ${omitted} earlier dead ends ${omittedSpan} are NOT listed here for budget — their full text is in graph.json; do not invent or merge them, just note that they exist.`);
  }
  if (failures.length) {
    lines.push(`FAILED_ATTEMPTS (${failures.length} listed of ${allFailures.length}; keep every line, never merge, never drop):`);
    for (const e of failures) {
      const seq = seqSpan(e);
      if (compact) {
        lines.push(`* ${e.id} "${clip(e.intent, 70) || "-"}" → ${clip(e.errorSnippet || e.verify?.summary, 80)}`);
      } else {
        lines.push(
          `* ${e.id} intent="${norm(e.intent) || "-"}" action="${clip(e.action, 120) || "-"}" reason="${clip(e.errorSnippet || e.verify?.summary, 160)}"${seq ? ` evidence=seq ${seq}` : ""}`,
        );
      }
    }
  }
  if (path.length) {
    lines.push(`CURRENT_PATH: ${path.map((n) => n.id).join(" -> ")}`);
    if (latest?.goal) lines.push(`CURRENT_GOAL: ${latest.goal}`);
    lines.push(`CURRENT_STATE_KEY: ${shortHash(latest?.worldHash)}/${shortHash(latest?.constraintHash)}`);
  }
  // ★ P6-A（task-56）：硬事实仍列**全部**失败边（失败记忆不能丢），但必须显式区分
  //   「无终点残留」—— 否则读者会把 rewash 残留当成真失败，或反过来以为清单被裁剪过。
  {
    const stats = danglingStats(g, { now });
    const residueFailures = allFailures.filter((e) => classifyDangling(e, { graph: g, now }) === "residue");
    if (residueFailures.length > 0) {
      lines.push(
        `DANGLING_RESIDUE: ${residueFailures.length} of the failed attempts above have no endpoint (to=null; 1.9.1 rewash residue) — excluded from hot-list analysis, data kept in graph.json.`,
      );
    }
    if (stats.fromBroken > 0) {
      lines.push(`FROM_DANGLING: ${stats.fromBroken} edges point from a non-existent node (separate corruption class; NOT residue; do not prune with to-null).`);
    }
    if (stats.liveUnsettled > 0) {
      lines.push(`LIVE_UNSETTLED: ${stats.liveUnsettled} edges are newly unsettled (untested, <=10min) — kept visible on purpose.`);
    }
    if (stats.candidates > 0) {
      lines.push(`STALE_UNSETTLED: ${stats.candidates} edges are untested and older than 10min — listed as OPTIONS (continue or abandon), NOT residue.`);
    }
  }
  // ★ P6C-1：未落地的尝试（untested + to=null）单独成段，不再混进 UNVERIFIED_CLAIMS。
  const openAll = openEdges(g);
  const options = openAll.filter((e) => isDanglingOption(e, { graph: g, now }));
  const open = openAll.filter((e) => !isDanglingOption(e, { graph: g, now }));
  if (options.length) {
    lines.push("OPTIONS (not yet landed — you may continue or abandon):");
    for (const e of options.slice(-40)) lines.push(`* ${e.id} "${clip(e.intent || e.action, 90)}"${staleTagOf(e, now)}`);
  }
  if (open.length) {
    lines.push("UNVERIFIED_CLAIMS (no external verification signal):");
    for (const e of open.slice(-40)) lines.push(`* ${e.id} "${clip(e.intent || e.action, 90)}"`);
  }
  return lines.join("\n");
}

/** 仅供测试的内部控制面（不在包导出面里；改这些等于改行为，必须有测试）。 */
export const _internal = { pickFallback, fitPaths, traceRecentSegment, tracePhraseOf };
