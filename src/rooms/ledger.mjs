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

import { failureEdges, openEdges, currentPath, latestAgentNode, norm, tewariAnalysis, failureClass, evidenceEndSeq, evidenceStartSeq } from "./kifu-model.mjs";
import { weakKindOf } from "./verify.mjs";

/* ───────────────── P6-A：悬空边（to=null）的分类与排除 ───────────────── */

/**
 * ★ P6-A（2026-10-30，task-56）：悬空边的两类，必须**只排除残留、保留未结算**。
 *
 * 数据事实（ws-dangling 全库测量，133 会话 / 18,038 边）：
 *   · `to=null` 5,567 条：unverified 4,815 + success 481 + failure 268 + untested 3；
 *   · 5,564 条是 1.9.1 rewash 清自环时把 `to` 抹掉的**历史残留**（已结算却无终点 = 不可能）；
 *   · 3 条 untested 也是 18 小时前的陈旧 in-flight 残留；
 *   · 另有 214 条 `from` 悬空（全在 session-example，mergeNodeInto 老 bug）——**另一类**，
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
 *   明确写成「not yet landed」，不混进 UNVERIFIED（那是「跑了但没验证」）。
 *   ★ 边界（2026-11-01）：旧文案还带「you may continue or abandon」—— 那是**行动许可**（指导模型
 *   怎么做），属于 AGENTS/persona；压缩只陈述「有哪些未落地的选项」（见 docs/压缩的职责边界.md）。
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

/* ═════════════════════ 热清单的 token 定价（W-A，2026-11-01） ═════════════════════
 *
 * 旧口径 `ceil(len / 3)` 是**一律按 3 字符/token** 估的 —— 对 CJK 系统性低估：
 * 实测（`计划表.md` 的 OPT-TOKENS，走网关 `usage.prompt_tokens`）纯中文 **−38%**、
 * 真实热清单 **−8.8%**。低估发生在「以为没超预算、其实超了」这一侧，对一个**硬预算**是危险方向。
 *
 * 新口径：**按字符类别加权**，再把加权字符数折成 token。
 *
 *   · CJK 字符（汉字/假名/谚文/CJK 标点与全角形）—— **4 单位 = 1 token = 1 token/字**（保守上界）；
 *   · 其余字符 —— **1 单位 = 1/4 token**，与宿主 `dsh-token-meter` 的 `CHARS_PER_TOKEN = 4` 对齐
 *     （出处：宿主 asar `@deepseek-ai/dsh-token-meter/lib/types/estimate.js` 实测，
 *      text 块 = `ceil(len / 4) + 4`；本函数**不含**该 +4 块开销，只用字符定价）。
 *
 * 为什么 CJK 取 1 token/字（而不是实测中位 0.54 token/字）：这是**故意取上界**。
 * 热清单的实际成分是「大量 ASCII（节点 id / 路径 / 标记）+ 少量中文（目标 / 失败原因）」——
 * 真实语料 176 会话合计 **217,567 字符，其中 CJK 只占 13.7%**。在这份混合比例上，
 * `CJK×1 + 其余×1/4` 恰好落在实测值附近：唯一有真实 usage 的样本（2478 字符 / 418 汉字，
 * 网关实测 **905 tokens**）旧口径给 **826（−8.8%）**、新口径给 **933（+3.1%）**。
 * 换句话说：CJK 侧取上界、ASCII 侧与宿主同系数，两者叠加后**在真实混合文本上对得上**；
 * 若把 CJK 侧按纯中文样本压到 0.54，真实热清单会重新掉回低估（745，−17.7%）。
 *
 * 全角标点（`，。！？：；（）「」` 等，U+3000–303F / U+FF00–FFEF）**算 CJK**，理由：
 * 它们在 BPE 词表里与汉字同一批 CJK 区间，实测与汉字同价（1 token 级），不是 1/4；
 * 且本仓热清单的标点几乎全是全角（`（逐条保留，一条不许少）` 这类），按 ASCII 计会稳定偏乐观。
 */
const UNITS_PER_TOKEN = 4;
const CJK_UNITS_PER_CHAR = 4;
/**
 * CJK 判定（逐码点）。含：谚文字母/音节、CJK 部首、CJK 标点（U+3000–303F，含 `、。「」`）、
 * 平假名/片假名、注音、CJK 扩展 A 与 URO、兼容汉字、CJK 兼容形、半角/全角形（U+FF00–FFEF，
 * 含全角标点与全角 ASCII）、以及**星形平面的扩展 B 及以后汉字**（U+20000–U+2FA1F）。
 * **不含**箭头 `→`、省略号 `…`、`⚠`、emoji —— 它们按「其余字符」1/4 token 计。
 * 这一条**不是**「BPE 里它们更便宜」的断言，而是**按真实语料锚点校准**出来的：
 * 418 汉字 + 2060 ASCII 的混合（含大量箭头/占位符）计 933，网关实测 905 —— 落在 3% 内。
 */
const CJK_RE = /[\u1100-\u11FF\u2E80-\u2FDF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3190-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u{20000}-\u{2FA1F}]/u;

/** 加权字符数（单位）：CJK 4 单位、其余 1 单位；4 单位 = 1 token。（内部：预算数学统一用「单位」，不对外。） */
function unitsOf(text) {
  const s = String(text ?? "");
  if (s.length === 0) return 0;
  let units = 0;
  for (const ch of s) units += CJK_RE.test(ch) ? CJK_UNITS_PER_CHAR : 1;
  return units;
}

/**
 * token 估算（热清单预算的唯一口径）。签名与名字保持不变 —— 引擎、测量器、C-17 测试都依赖它。
 * 空串 ⇒ 0（不因取整变成 1）。
 */
export function estimateTokens(text) {
  const s = String(text ?? "");
  if (s.length === 0) return 0;
  return Math.ceil(unitsOf(s) / UNITS_PER_TOKEN);
}

/** 预算数学的专用别名：`token 预算 × 它 = 单位预算`（与 `UNITS_PER_TOKEN` 同值，写出来只为了说明「这是预算域」）。 */
const BUDGET_UNITS_PER_TOKEN = UNITS_PER_TOKEN;

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
 * 中段省略截断：保留首部 + 尾部，丢掉中段。
 *
 * 为什么（2026-11-01，来自 docs/research/03-human-memory.md 建议 C）：
 *   失败原因是模型「避免重犯」的唯一判据，而关键 token 常常**不在开头**：
 *     `ERROR: EACCES: permission denied, open '/x/y/z.txt'` —— 开头是错误类，末尾才是**路径**；
 *     `bash(command=cd /a && node test.mjs 2>&1 | tail -3)` —— 开头是命令名，末尾才是**目标**。
 *   旧版 `clip` 是纯首部截断，预算紧的档位（reasonLen=25）会把路径整段切掉，
 *   模型看到「EACCES: permissio…」却不知道是哪个文件 —— 这条失败边就失去了判别价值。
 *   首尾各留一部分：代价是中间少几个字，收益是「错在哪 + 对什么操作」都还在。
 */
function clipMiddle(text, n) {
  const t = norm(text);
  if (t.length <= n) return t;
  if (n <= 2) return t.slice(0, n);
  const head = Math.max(1, Math.ceil((n - 1) * 0.55));
  const tail = Math.max(1, n - 1 - head);
  if (head + tail + 1 > n) return `${t.slice(0, Math.max(0, n - 1))}…`;
  return `${t.slice(0, head)}…${t.slice(-tail)}`;
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
  // 盘符本身不是会话名（`treeDir = "D:/fixture"` ⇒ 最后一段是 "D:"）——不许把 "D:" 印成相对路径。
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
// ★ C45：图例只陈述**事实**，不写行动建议。旧版带 "retry when …" / "take it" —— 那是
//   「该不该再试 / 该不该走这条路」的指导，属于 AGENTS/persona，不属于压缩（见 docs/压缩的职责边界.md）。
//   标记本身已经说了「为什么这条路不通」；要不要再试是模型自己的判断。
const MARKER_LEGEND = {
  // C64：只陈述事实 —— 标签里的 retry-if:eN 指「那条绕开它的工作边」，不写「何时可再试」
  dead: "a working path avoids it; the tag names that edge",
  "blocked:permission": "the environment lacks a required permission",
  "blocked:missing-resource": "the required resource is absent",
  "blocked:timeout": "no answer within the time limit",
  "blocked:unreachable": "connection refused",
  blocked: "not available in this environment",
  failed: "retryability unknown",
  redundant: "a working edge <edge> reaches the SAME position",
  longer: "a working edge <edge> reaches it in fewer steps",
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

/** 单行化：把换行/连续空白压成单个空格（失败边必须是物理上一行，见 renderFailureLine 注释）。 */
function oneLine(text) {
  return norm(text).replace(/\s+/g, " ").trim();
}

/** 一条失败边的单行渲染。level 控制长度：0=最详细，3=最省。 */
/**
 * 一条失败边后来被**同一 action 的成功边**解决了吗（图结构事实，不是判断）。
 *
 * 为什么重要（C17，来自 05 §7.2「因果配对是唯一无法重建的东西」）：失败边是永久记忆，
 * 但「同一个命令后来跑通了」这个事实只存在于历史里 —— 不标出来，模型会以为那条路仍然堵着。
 * 这里只陈述「后来 e34 成功了」，不写「你应该去试」。
 */
export function laterSuccessOf(edge, successEdges = []) {
  const action = edge?.action;
  if (!action) return null;
  const endOf = (e) => evidenceEndSeq(e, -Infinity);
  const failEnd = endOf(edge);
  if (!Number.isFinite(failEnd)) return null;
  let best = null;
  for (const candidate of successEdges) {
    if (candidate?.result !== "success" || candidate.action !== action) continue;
    const end = endOf(candidate);
    if (!(end > failEnd)) continue;
    if (best === null || end < endOf(best)) best = candidate;
  }
  return best;
}

/**
 * ★ C448：热清单里「当前目标」到底能取到什么 —— 纯函数，便于单测。
 *
 * 由来（真机实测）：`CURRENT GOAL` 这行**几乎从不出现**。查下来不是渲染写错，是**没有原料**：
 * 一个 35.7 MB 会话里 3,369 条 assistant 消息有 **93.3% 没有 `text` 块**（3,142 条），
 * 而 `goal` 只从 assistant 文本抽 ⇒ 19,375 个 agent 节点里只有 62 个（0.3%）有 goal。
 *
 * 所以补一个**一定存在**的兜底：最近一条 **user 原话**（多轮会话里 78% 有，长度中位 21 字）。
 * 只在两个条件下用，避免把噪声伪装成目标：
 *   · agent 节点自己没有 goal；
 *   · 最近一条 user **不是根节点**（是根的话它就等于已经渲染过的 ROOT USER，重复一遍是纯浪费）。
 *
 * 成本实测（37 个真机会话）：整库热清单 tokens 15803 → 16134（**+2.1%**，约 +9 tok/会话）。
 *
 * @returns {{text: string, source: "agent-goal"|"latest-user"}|null}
 */
/**
 * ★ C449：这条 user 原话**值不值得复诵**。
 *
 * 真机数据（29 个多轮会话，最新 user 消息长度**中位 12 字**）里最短的一批是：
 * `继续`×3、`go`、`修一下`、`都是0`、`我重启好了`×2 …
 * 把「继续」渲染成 `CURRENT GOAL: 继续` 不但没信息，还会让模型以为**当前目标就是"继续"**。
 *
 * 判据只拦**纯接续/确认词**（外加 ≤2 字的碎片），不做语义猜测：
 * 命中的东西模型本来也不需要被告知（它就在最后一条消息里）。
 */
const CONTINUATION_ONLY_RE = /^(?:继续|接着|再继续|继续吧|往下|go|continue|ok|okay|好|好的|行|嗯|可以|开始|请继续|继续推进)[\s。.!！?？~～]*$/i;

export function isInformativeAsk(text) {
  const t = String(text ?? "").trim();
  if (t.length === 0) return false;
  if (t.length <= 2) return false;
  return !CONTINUATION_ONLY_RE.test(t);
}

export function currentGoalOf(g, latestAgent) {
  const goal = typeof latestAgent?.goal === "string" ? latestAgent.goal.trim() : "";
  if (goal !== "") return { text: goal, source: "agent-goal" };
  const users = (g?.order ?? [])
    .map((id) => g.nodes?.[id])
    .filter((n) => n !== undefined && n !== null && n.kind === "user" && typeof n.text === "string" && n.text.trim() !== "");
  if (users.length === 0) return null;
  const last = users[users.length - 1];
  const rootIds = Array.isArray(g?.rootUserNodeIds) ? g.rootUserNodeIds : [];
  // 只有一条 user / 最新那条就是根 ⇒ 与 ROOT 重复，不给
  if (rootIds.includes(last.id) || users.length === 1) return null;
  // ★ C449：**只复诵"最新那条且它本身有信息量"**。
  //   为什么不去更早的消息里找一条有信息量的：那条多半**已经做完了**，
  //   把一个完成的旧任务写成 CURRENT GOAL，比不写更糟（会把模型拽回去重做）。
  const text = last.text.trim();
  if (!isInformativeAsk(text)) return null;
  return { text, source: "latest-user" };
}

export function renderFailureLine(edge, level = 0, tewari = null, mode = "semantic", resolvedBy = null, retried = 1) {
  const intentLen = [70, 50, 34, 22][Math.min(level, 3)];
  // ★ 2026-10-29：原因（报错原文）**任何级别都保留**，只是越来越短。
  //   旧版 level ≥3 直接把 `→ 原因` 整段砍掉 ⇒ 全库实测 133 条可见失败边里只有 25 条带原因，
  //   模型看到「我试过 X、它 blocked」却看不到「报错是什么」，而原因正是它避免重犯的判据。
  //   现在最省的一档也留 25 字（"Error: EACCES: permissio…" 足够认出是什么错）。
  const reasonLen = [90, 60, 36, 25][Math.min(level, 3)];
  // ★ 2026-11-01：intent / reason 都改用「中段省略」——命令与路径常在尾部，纯首部截断会丢掉它们。
  // ★ 2026-11-01（handoff-check 在 live 语料上抓到）：**失败边必须是物理上一行**。
  //   多行 errorSnippet（如 `----\n0\n[exit code: 1]`）会把 `(seq …)` 挤到后续几行，
  //   模型读到的是「一条边拆成四行」，出处覆盖率指标也会误判成「渲染器在砍 seq」。
  //   这里把换行/连续空白一律压成单个空格 —— 只影响排版，不丢任何字符内容。
  const intent = clipMiddle(oneLine(edge.intent || edge.action || "(未记录意图)"), intentLen);
  const reason = clipMiddle(oneLine(edge.errorSnippet || edge.verify?.summary || edge.action || "(未记录原因)"), reasonLen);
  const seq = seqSpan(edge);
  const tags = failureTags(edge, tewari, mode);
  const tag = tags.length > 0 ? ` [${tags.join(" ")}]` : "";
  // ★ 2026-11-01（docs/research/03-human-memory.md 建议 A）：出处（seq）任何档位都不砍。
  //   越紧的档位越需要判断「这条边是什么时候发生的」；只留 edge id 时模型知道「e12 失败过」，
  //   却无法把它和当前进度对齐。
  //   ★ 2026-11-01 二次修正（bench 实测）：全档位用 `(seq a-b)` 让 2000 边夹具从 351 涨到 453 tok（+29%）。
  //   预算紧的档位改用**短格式** `(sa-b)` —— 出处（数字）一个都没少，只省掉 3 个字符/边。
  const seqTag = seq ? ` (${level <= 1 ? "seq " : "s"}${seq})` : "";
  // ★ C17：后来被同一 action 的成功边解决 —— 只给边 id（可回查），不写行动建议。
  // ★ C18（调研候选 #15 的后半）：同一个 action 失败过 k 次（k≥2）⇒ 标 `↻k`。
  //   这是**计数事实**（同一命令被反复尝试），暗示在原地重试；不写「别重试」（那是 AGENTS 的事）。
  const retry = Number.isFinite(retried) && retried >= 2 ? ` ↻${retried}` : "";
  const later = resolvedBy ? ` ↑later-ok:${resolvedBy.id}` : "";
  return `- ${edge.id} "${intent}" → ${reason}${seqTag}${retry}${later}${tag}`;
}

/**
 * 路径行（CURRENT PATH / WORKING）的形态。★ C-17（2026-10-30）。
 *
 * 背景（实测）：渲染链原本是 `path.length > 1 && level <= 2` —— **L3 起整块路径段不渲染**。
 * S2a 的 `WORKING:` 行让 3 个会话多出 28~46 tokens，从 L2 掉到 L3，于是「为了显示工作路径」
 * 反而把路径（连同工作位置）一起挤没了：
 *   session-example L2=453 → L3=376 / session-example L2=438 → L3=356 / session-example L2=489 → L3=394。
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

/**
 * ★ C656：约束段的**病态上限**（字符）。正常会话远到不了这里（本次真机一份：14 条 / 1,585 字符）。
 *
 * 为什么不是「预算」：约束属于**不可裁下限**（C41「宁可超预算也不丢约束」、C44 `budgetFloorOver`
 * 把「约束+根目标下限即超预算」单列）—— 预算紧时正确的做法是**如实超预算**，不是裁约束。
 * 这个上限只挡 C533 那类**病态输入**（一次粘贴几十万字符，单条"约束"就能塞满上下文）。
 * 越过上限时：逐条逐字**放得下多少放多少** + 显式省略行（条数 + `graph.json` 回查指针），
 * 绝不静默丢、也不再把长约束截成「前 120 字符 + …」。
 */
const LEDGER_CONSTRAINTS_MAX_CHARS = 8000;

/**
 * ★ C656：约束在热清单里的**单行形态**。
 *
 * 只做两件**必要**的事：① 换行压成空格（热清单是逐行结构 —— 约束抽取本来就按换行切句，
 * 正常不会有换行，这里只是不让旧图/手工图把段落结构撑破）；② 剥掉用户自己写的 markdown 列表
 * 符号（否则渲染成 `- - …`，2026-11-01 的显示 bug）。**除此之外一个字都不改** ——
 * 不截断、不压空白，否则 `CONSTRAINTS (verbatim)` 与 `measureFoldQuality` 的逐字口径就对不上了。
 */
function constraintLineOf(c) {
  return String(c ?? "").replace(/\r?\n\s*/g, " ").replace(/^\s*[-*]\s+/, "");
}

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
 * 实测 session-example 的 CURRENT PATH 有 158 个节点，各砍一半仍超预算（整条 708 tokens）；
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
/**
 * ★ C562：**二分找「装得下的最大 keep」**。
 *
 * 旧写法从 `len-1` 逐 1 递减去找 —— 对 846 个节点的路径就是 ~840 次 `foldIds`（每次还要拼 840 个标签），
 * 实测单次渲染 **39.4% 的采样**花在这里（profile 头号热点 `foldIds`）。
 * 行长度对 `keep` 单调（keep 越小行越短）⇒ 二分与线性扫描**答案完全一致**，次数从 ~840 降到 ~10。
 *
 * @param {number} high 起始 keep（含）
 * @param {number} low 下界 keep（含）
 * @param {(keep:number)=>string} makeLine
 * @param {(line:string)=>boolean} fits
 * @returns {string|null} 第一个装得下的行（没有就 null）
 */
function firstFittingLine(high, low, makeLine, fits) {
  let lo = low;
  let hi = high;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const line = makeLine(mid);
    if (fits(line)) {
      best = line;
      lo = mid + 1; // 装得下 ⇒ 试更大的 keep（更保信息）
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

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
    {
      const line = firstFittingLine(
        work.length - 1,
        KEEP_HEAD + KEEP_TAIL + 1,
        (keep) => {
          const tailK = Math.max(KEEP_TAIL, Math.round((keep * KEEP_TAIL) / (KEEP_HEAD + KEEP_TAIL)));
          return `WORKING: ${foldIds(work, (x) => x, Math.max(KEEP_HEAD, keep - tailK), tailK)}`;
        },
        (l) => l.length <= budget,
      );
      if (line !== null) return { currentLine: null, workingLine: line };
    }
    const workShortest = `WORKING: ${foldIds(work, (x) => x, 1, 1)}`;
    shapes.push({ currentLine: null, workingLine: workShortest });
    if (workShortest.length <= budget) return shapes.at(-1);
  } else if (work === null) {
    // 只有 CURRENT PATH：折中段
    {
      const line = firstFittingLine(
        curIds.length - 1,
        KEEP_HEAD + KEEP_TAIL + 1,
        (keep) => {
          const tailK = Math.max(KEEP_TAIL, Math.round((keep * KEEP_TAIL) / (KEEP_HEAD + KEEP_TAIL)));
          return `CURRENT PATH: ${foldIds(curIds, (x) => x, Math.max(KEEP_HEAD, keep - tailK), tailK)}${tag}`;
        },
        (l) => l.length <= budget,
      );
      if (line !== null) return { currentLine: line, workingLine: null };
    }
  } else {
    {
      const line = firstFittingLine(
        curIds.length - 1,
        KEEP_HEAD + KEEP_TAIL + 1,
        (keep) => {
          const tailK = Math.max(KEEP_TAIL, Math.round((keep * KEEP_TAIL) / (KEEP_HEAD + KEEP_TAIL)));
          return `CURRENT PATH: ${foldIds(curIds, (x) => x, Math.max(KEEP_HEAD, keep - tailK), tailK)}${tag}`;
        },
        (l) => l.length + (workFull?.length ?? 0) <= budget,
      );
      if (line !== null) return { currentLine: line, workingLine: workFull };
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
/**
 * 出处覆盖率：**失败边行**里带 `(seq …)` 的比例。
 *
 * 为什么要有（2026-11-01，`docs/research/03-human-memory.md` 建议 I）：
 *   「来源监控」是我们刻意保留的能力，但它很容易在追 token 预算时被悄悄优化掉
 *   （`seq && level <= 1` 就是一次真实的回退）。有了这个数字，任何"为省 10 字符砍掉出处"
 *   的改动都会在测试里立刻显形；它也是 bench 的对照指标。
 *
 * ★ 2026-11-01 口径修正（`scripts/handoff-check.mjs` 在 live 语料上抓到两次）：
 *   ① 旧定义把**所有** `- e<id>` 行算进分母，OPTIONS / UNVERIFIED（本来就不带 seq）被当成
 *      「缺出处的失败边」⇒ 真实会话覆盖率恒 <1（0.22 / 0.43 / 0.80）。现在只统计**失败边行**
 *      （特征：带 `→`）。
 *   ② 真实语料里还有一类**数据缺口**：老图的失败边没有 `evidence`，渲染器再正确也印不出 seq
 *      （实测某会话 7 条失败边里 4 条无 evidence）。这不该算「渲染回退」，否则指标永远红。
 *      ⇒ 传入 `edgesById` 时按**结构化口径**算：只对「本来就有 evidence」的边要求 seq；
 *      没有 evidence 的边单独计数到 `evidenceMissing`（数据缺口，另一件事）。
 *
 * 只统计失败边行（汇总行、注释行、OPTIONS/UNVERIFIED 行不算），没有失败边行时返回 1。
 *
 * @param {string} text 渲染后的热清单
 * @param {Map<string, object>|Record<string, object>|null} [edgesById] 不传则退回纯文本口径（要求每行都有 seq）
 */
export function provenanceCoverageOf(text, edgesById = null) {
  const edgeLines = String(text ?? "")
    .split("\n")
    .filter((line) => /^- [a-z]\d+ /.test(line) && line.includes(" → "));
  if (edgeLines.length === 0) return 1;
  // ★ 2026-11-01 二次修正：出处有两种写法 —— L0/L1 用 `(seq a-b)`（可读），L2+ 用 `(sa-b)`（省字符）。
  //   只认前者会让覆盖率在降级档位掉成 0，把"省字符"误判成"丢出处"。
  const SEQ_TAG_RE = /\((?:seq |s)[\d-]+\)/;
  if (edgesById === null || edgesById === undefined) {
    const withSeq = edgeLines.filter((line) => SEQ_TAG_RE.test(line)).length;
    return withSeq / edgeLines.length;
  }
  const lookup = (id) => (typeof edgesById.get === "function" ? edgesById.get(id) : edgesById[id]);
  let ok = 0;
  for (const line of edgeLines) {
    const id = /^- ([a-z]\d+) /.exec(line)?.[1] ?? "";
    const edge = lookup(id);
    // 图里找不到这条边 / 它本来就没有 evidence ⇒ 不要求 seq（不是渲染的锅）
    const mustHaveSeq = edge !== undefined && edge !== null && seqSpan(edge) !== "";
    if (!mustHaveSeq || SEQ_TAG_RE.test(line)) ok += 1;
  }
  return ok / edgeLines.length;
}

/**
 * 分项占用：热清单的 token 花在哪一段上。
 *
 * 为什么需要（2026-11-01，做完 A/D 两项后 bench 从 351 涨到 446 才意识到）：
 *   只知道「总量超没超预算」不够 —— 要谈「分项预算（让约束/根目标永远逐字）」，
 *   必须先知道**现在各段各占多少**，否则抬某段下限就是在拍脑袋挪别人的钱。
 *   它让「给约束保底」变成一道算术题：从失败边条数挪，还是从根目标尾部挪。
 *
 * 纯函数、零副作用；按行首归类，同段累加，未识别归 other。
 */
export function measureLedgerSections(text) {
  const sizes = { root: 0, constraints: 0, failures: 0, options: 0, unverified: 0, path: 0, other: 0 };
  let mode = "other";
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("ROOT USER")) mode = "root";
    else if (line.startsWith("CONSTRAINTS")) mode = "constraints";
    else if (line.startsWith("LEARNED") || line.startsWith("FAILED_ATTEMPTS")) mode = "failures";
    else if (line.startsWith("OPTIONS")) mode = "options";
    else if (line.startsWith("UNVERIFIED")) mode = "unverified";
    else if (line.startsWith("# path") || line.startsWith("# WORKING") || line.startsWith("CURRENT PATH")) mode = "path";
    sizes[mode] += line.length + 1;
  }
  // 单位提醒：这里全是**字符数**，不是 token。要算占比请用 total 做分母，
  // 别拿 renderLedger().tokens 去除 —— 两者单位不同（2026-11-01 实测踩过：算出 238% 的失败边占比）。
  sizes.total = Object.values(sizes).reduce((a, b) => a + b, 0);
  return sizes;
}

/**
 * ★ C313：热清单渲染的**分项计时**（K-16 的前置仪器）。
 *
 * 为什么要有它：C312 踩过 `measureLedgerSections(text)` 的坑 —— 那是**按文本算字符数**，
 * 不是计时。想回答"哪一段最贵"，必须真的把各段重跑一遍并计时。
 *
 * 做法：把 `renderLedger` 内部要做的几件大活（建索引、筛悬空、算 options、算路径）**各自重跑一次**。
 * 这些都是幂等的纯查询，重跑不影响任何状态；数值是**近似**（真实渲染里还会叠加字符串拼接），
 * 但足以定位"哪一段最贵"。
 *
 * @param {object} g
 * @param {{reps?:number, now?:number}} [options]
 * @returns {{total:number, parts:Record<string, number>, split:string}}
 */
export function measureLedgerTimings(g, { reps = 10, now = Date.now() } = {}) {
  const once = (fn) => {
    try {
      fn();
    } catch {
      /* 某一段抛错不影响其它段 */
    }
  };
  const time = (fn) => {
    once(fn); // 预热
    const started = process.hrtime.bigint();
    for (let i = 0; i < reps; i += 1) once(fn);
    return Number(process.hrtime.bigint() - started) / 1e6 / reps;
  };
  const parts = {
    failureEdges: time(() => failureEdges(g)),
    successScan: time(() => Object.values(g.edges ?? {}).filter((e) => e?.result === "success" && typeof e.action === "string" && e.action !== "")),
    danglingStats: time(() => danglingStats(g, { now })),
    options: time(() => Object.values(g.edges ?? {}).filter((e) => isDanglingOption(e, { graph: g, now }))),
    paths: time(() => {
      currentPath(g);
      latestAgentNode(g);
    }),
    tewari: time(() => tewariAnalysis(g)),
  };
  const total = time(() => renderLedger(g, { now }));
  const sum = Object.values(parts).reduce((a, b) => a + b, 0);
  const split = sum > 0 ? `${((sum / total) * 100).toFixed(0)}% 可归因` : "无法归因";
  return { total, parts, split };
}

export function renderLedger(g, { maxTokens = 500, tailFailures = 20, markers = "semantic", treeDir = "", traceRoot = "", now = Date.now() } = {}) {
  // ★ P6-A（task-56）：热清单只展示「有终点」的失败边。`to=null` 且已结算（或 untested 超 10 分钟）
  //   的是 rewash 历史残留，占全库失败边的 27.8%（268/964）——它们没有终点，构不成「哪一步失败了」，
  //   留在清单里只是噪声。**live_unsettled（新产生、≤10min 的 untested）必须保留**，否则会把
  //   「正在执行、还没结算」误判成不存在。
  const allFailures = failureEdges(g);
  const failures = allFailures.filter((e) => !isDanglingResidue(e, { graph: g, now }));
  const omittedResidue = allFailures.length - failures.length;
  // ★ 2026-11-01（出处覆盖率口径修正）：按 id 查边，区分「渲染器砍了 seq」与「源数据本来就没有 evidence」。
  const failuresById = new Map(failures.map((e) => [e.id, e]));
  // ★ C17：成功边索引（按 action）—— 标注「这条失败后来被同一命令跑通了」，只建一次。
  const successEdges = Object.values(g.edges).filter((e) => e?.result === "success" && typeof e.action === "string" && e.action !== "");
  // ★ C18：同一 action 的失败次数（只在同一段历史里计数；用来标「这条命令被反复试过 k 次」）。
  const failureActionCounts = new Map();
  for (const e of failures) {
    if (typeof e?.action !== "string" || e.action === "") continue;
    failureActionCounts.set(e.action, (failureActionCounts.get(e.action) ?? 0) + 1);
  }
  // 只在同 action 组里**最近的那条**上标 ↻k（每条都标会白烧 token：计数是同一个数字）。
  const endSeqOf = (edge) => evidenceEndSeq(edge, -Infinity);
  const latestFailureByAction = new Map();
  for (const e of failures) {
    if (typeof e?.action !== "string" || e.action === "") continue;
    const prev = latestFailureByAction.get(e.action);
    if (prev === undefined || endSeqOf(e) >= endSeqOf(prev)) latestFailureByAction.set(e.action, e);
  }
  const retriedTimesOf = (edge) => {
    if (typeof edge?.action !== "string") return 1;
    if (latestFailureByAction.get(edge.action) !== edge) return 1;
    return failureActionCounts.get(edge.action) ?? 1;
  };
  /** 数据缺口：这些失败边连 evidence 都没有 ⇒ 模型无法回查（不是渲染的锅，指标里单独计）。 */
  const evidenceMissing = failures.filter((e) => seqSpan(e) === "").length;
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
  // ★ C561：**大图上别为 30 条边各跑一次 BFS**。真机（c0a5847a，5,885 节点 / 6,010 边）：
  //   单次渲染 137.8ms，其中 **72.3ms 是 30 次 tewariAnalysis**（每条一次可达性 BFS）。
  //   深会话的清单本来就大幅截断，手割标记只对**最近**几条有意义 ⇒ 大图只算 8 条。
  const tewariCap = Object.keys(g.edges ?? {}).length > 3000 ? 8 : 30;
  for (const e of failures.slice(-tewariCap)) tewariMap.set(e.id, tewariAnalysis(g, e));

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
  // ★ 2026-11-01（C16，调研候选 #15 的符号版）：**重访过的状态**在路径里标出来（`n41×2`）。
  //   `transpositions` 是 mergeNodeInto 记的「同一状态被另一条路径再次到达」次数（图结构事实），
  //   所以 ×N 只陈述「这个位置被到过 N 次」，不写「你该换条路」——行动判断仍归模型/AGENTS。
  //   为什么值得显示：这种循环在热清单里原本完全不可见，模型只看到一长串节点，不知道自己在原地打转。
  //   成本：只有真的重访过才有字符（正常会话 0 成本）。
  const reentryTag = (id) => {
    const extra = Number(g.nodes[id]?.transpositions);
    return Number.isFinite(extra) && extra >= 1 ? `×${extra + 1}` : "";
  };
  // ★ C562：**标签按 id 记忆一次**。真机（c0a5847a）路径长 **846**，而标签会被 4 个档位各算一遍
  //   ⇒ 3,400 次字符串拼接，占单次渲染 41.5% 的采样（profile 里 `foldIds` 是头号热点）。
  //   同一 id 在同一次渲染里标签恒定，缓存后各档位复用。
  const labelCache = new Map();
  const memoLabel = (fn) => (id) => {
    const hit = labelCache.get(id);
    if (hit !== undefined && hit.kind === fn) return hit.text;
    const text = fn(id);
    labelCache.set(id, { kind: fn, text });
    return text;
  };
  const pathLabel = memoLabel((id) => `${id}${g.nodes[id]?.kind === "user" ? "(user)" : ""}${reentryTag(id)}`);
  const workingLabel = memoLabel((id) => (g.nodes[id]?.kind === "user" ? "user" : `${id}${reentryTag(id)}`));
  // 两条待渲染的路径行（full 形态）；L3+ 再按剩余预算折叠（见 fitPaths）
  const { currentLine, workingLine } = foldPaths(currentIds, workingIds, sameAsWorking, pathLabel, workingLabel);
  // WORKING 尾部那条边的 id：L3+ 把 WORKING 合并进 CURRENT PATH 时用它保住「哪条边算工作」
  const workingTailId = workingTail?.id ?? "";

  /** 各档渲染结果（L4/L5 比过再定，见循环末尾）。 */
  const attempts = [];

  // ★ S5（2026-10-31）：TRACE 行两形态。带 recent 的版本在**预算装不下时退回旧形态**，
  //   否则「加一条新信息」会把本来刚好装下的会话顶到 500 以上（真实语料实测 30→31 个超预算）。
  //   先算好两条候选行，各档按预算选（见循环末尾的 dropped 逻辑）。
  // ★ 2026-11-01（调研候选 #3）：热清单里任何「有东西被省掉了」的行都必须给出**可解析的位置**。
  //   规则与 TRACE 行一致：treeDir 先相对化成 `sessions/<sid>`（或配置的 traceRoot），绝不泄漏绝对路径（P6a）；
  //   treeDir 为空时退化成 `graph.json`，但仍带节点区间 —— 不许只剩一个泛称。
  const relTree = treeDir ? traceRelativeDir(treeDir, traceRoot) : "";
  const traceBaseLine = relTree ? `TRACE: ${relTree}/index.md` : null;
  const traceRecentSeg = traceBaseLine === null ? "" : traceRecentSegment(path);
  const traceRecentLine = traceRecentSeg === "" ? null : `${traceBaseLine} · ${traceRecentSeg}`;

  /**
   * 某一档「注定装不下」的下界（只会跳过铁定超预算的档，不误伤）。
   *
   * ★ W-A（2026-11-01）：改按**单位**算（4 单位 = 1 token），而且用**这一档真的会渲染的那批边**
   *   逐条累加 —— 不再用 `LEVEL_LEN` 的**上限**去猜每行长度。
   *   为什么必须换：旧式 `ceil((shownCount*(25+intentLen+reasonLen)+300)/3)` 里的
   *   `intentLen/reasonLen` 是**截断上限**（70/90 字），旧口径下它已经偏保守；换成 CJK 4 单位/字后，
   *   这个「按上限」的下界直接涨到 ~2.6 倍，会把**本来装得下的档**判成注定装不下 ⇒ L0–L3 被整段跳过、
   *   失败边从 30 条掉成 20 条（实测 `ledger-scale` 与 `ledger：S3-2` 两条用例当场变红）。
   *   逐条按真实 intent/reason 长度算，既保住「下界」语义，也不会误伤。
   */
  const failureLineUnits = (edge, lv) => {
    const intentLen = [70, 50, 34, 22][Math.min(lv, 3)];
    const reasonLen = [90, 60, 36, 25][Math.min(lv, 3)];
    const intent = clip(edge.intent || edge.action || "(未记录意图)", intentLen);
    const reason = clip(edge.errorSnippet || edge.verify?.summary || edge.action || "(未记录原因)", reasonLen);
    // +25：id / 引号 / 箭头 / tag 的 ASCII 余量（与旧口径的 25 一致；tag 在 doomed 阶段不展开 ⇒ 只会更小）
    return unitsOf(intent) + unitsOf(reason) + 25;
  };
  const doomed = (lv) => {
    if (failures.length === 0) return false;
    const shownCount = lv === 4 ? Math.min(failures.length, tailFailures) : lv === 5 ? Math.min(failures.length, 10) : failures.length;
    const slice = lv >= 4 ? failures.slice(-shownCount) : failures;
    // 固定开销 300 **按 ASCII 保守处理**（宁可少跳过一档）。
    let units = 300;
    for (const edge of slice) units += failureLineUnits(edge, lv);
    return units > maxTokens * BUDGET_UNITS_PER_TOKEN;
  };

  for (let level = 0; level <= 5; level += 1) {
    if (level < 4 && doomed(level)) continue; // L0–L3：装不下的档不必白渲染（旧行为）
    // L4：只有**连 L5 都装不下**时才跳过 —— 否则「装不下也必须渲染一遍再比」（旧版语义：兜底要有下文）。
    //   旧条件是 `failures.length > tailFailures`（20），而 L5 的 shownCount 用 10 ⇒ 预算只够 L3 时
    //   L5 的下界变小、L4 被跳过 —— 实测 6 张图因此从「L3 全量」直接落成「L5 只列 10 条」并超预算。
    if (level === 4 && doomed(4) && doomed(5)) continue;
    const lines = [];
    lines.push("<chess-ledger>");
    // ★ S3 降级可见（task-186）：上一次 fold 的摘要是**规则生成**时固定打一行提示 ——
    //   否则模型会把没有润色的规则事实当成正常摘要读。旧图没有这个字段 ⇒ 不显示（向后兼容）。
    //   两个字段都认：`lastFoldMode`（规范字段）与 `lastFoldDegraded`（同时写的布尔别名）。
    if (g.lastFoldMode === "rules" || g.lastFoldDegraded === true) lines.push("⚠ 上次摘要是规则生成（无模型润色）");
    // ★ 2026-11-01（调研候选 #1，学 Claude Code 的 "Autocompact is thrashing"）：
    //   压缩无效要当一等状态显示出来。只陈述事实（连续几次、间隔多近），**不给行动指令** ——
    //   「要不要换策略」是模型的判断，不是压缩该替它做的事。只在真的连续发生时出现，正常会话零成本。
    if (typeof g.foldThrash === "number" && g.foldThrash >= 2) {
      lines.push(`⚠ 上次 fold 未回收足够空间（连续 ${g.foldThrash} 次 fold 间隔 < 30 事件）`);
    }
    // ★ C-17 rev6：L3+ 的 root 裁剪从 180 收到 168 —— 给「最小路径行」预留 12 字符。
    //   不这么做时，1.9.1 在 L3 恰好用满预算的会话（如 5b38b355 HEAD=497/1490 字符）
    //   只要多一行 `# path: n185` 就 501，成为唯一一个「新增超预算」。路径信息优先于
    //   root 尾部 12 个字符（root 本来就已被 clip，且 L0–L2 逐字不变）。
    // C44：这两段（根目标 + 约束）**任何档位都只能 clip、不能删** —— 单独记下它们的 token 数，
    // 用来区分「渲染超预算」与「不可裁下限本身就超预算」。
    // ★ C656：约束这段连 clip 也不做（见下）—— 它是「逐字」契约的一部分。
    let unyieldingText = "";
    if (root) {
      const rootLine = `ROOT USER (verbatim): ${clip(root.text, level === 0 ? 900 : level === 1 ? 500 : level === 2 ? 300 : 168)}`;
      unyieldingText += `${rootLine} `;
      lines.push(rootLine);
    }
    // 始终收集**所有** user 节点的约束：旧版只要 root 有约束就只看 root，
    // 后续用户消息里的约束（"不要动 prod 配置"）在热清单里消失（审查 P1-6）。
    const cons = collectConstraints(g);
    if (cons.length) {
      lines.push("CONSTRAINTS (verbatim):");
      // ★ 2026-11-01（边界复审发现的显示 bug）：约束原文常常自带 markdown 列表符号
      //   （用户写「- 不要动 prod 配置」），渲染时再补一个 `- ` 就变成 `- - 不要动…`。
      //   这里只剥掉**渲染用的前缀符号**，正文一个字不改（逐字保留的口径不受影响）。
      // ★ C656：**一条都不许删，也不许裁**。旧版是 `cons.slice(0, 12)` + `clip(…, 120)`：
      //   前者把第 13/14 条**凭空删掉**（真机 2026-11-08：14 条约束的热清单只剩 12 条，
      //   同一份图在规则兜底摘要里也少了这两条），后者把长约束截成「前 120 字符 + …」——
      //   两种都让 `CONSTRAINTS (verbatim)` 名不副实，而约束丢一条 = 任务变了（重注入契约 §1 ②）。
      //   现在：全部逐字；只有病态输入（> LEDGER_CONSTRAINTS_MAX_CHARS）才转入显式省略，
      //   省略行带条数 + 回查指针（与失败边的省略行同一纪律：不许假装不存在）。
      let constraintChars = 0;
      let omittedConstraints = 0;
      for (const c of cons) {
        const line = `- ${constraintLineOf(c)}`;
        // 单条就超上限也走省略（否则「病态上限」对一次巨量粘贴形同虚设）；省略行会给出总数与指针。
        if (constraintChars + line.length + 1 > LEDGER_CONSTRAINTS_MAX_CHARS) {
          omittedConstraints += 1;
          continue;
        }
        constraintChars += line.length + 1;
        unyieldingText += `${line} `;
        lines.push(line);
      }
      if (omittedConstraints > 0) {
        const pointer = relTree ? `${relTree}/graph.json` : "graph.json";
        lines.push(
          `CONSTRAINTS_OMITTED: ${omittedConstraints} of ${cons.length} not listed (section over ${LEDGER_CONSTRAINTS_MAX_CHARS} chars) — full text: ${pointer} nodes[*].constraints`,
        );
      }
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
    if (failures.length) tailLines.push(`LEARNED (${failures.length} failed attempts):`);
    // ★ P6-A / C227 / C654：被排除的残留必须**说一句**（不能静默消失）。一行、带计数与 graph 指针，
    //   模型知道「有东西被省了」。计数行不能挂在 LEARNED 块里：只有 residue、非残留失败为 0 时，
    //   历史同样必须可见，但 residue 本身不塞进 LEARNED。
    if (omittedResidue > 0) {
      tailLines.push(`# 另有 ${omittedResidue} 条无终点残留（rewash 历史，未展开；全文 graph.json）`);
    }
    if (failures.length) {
      // ★ 2026-10-29（goal ⑤）：旧版让模型去读 `graph.md` —— 而那个文件从 v1.2.2 起就不再自动写了（死指针）。
      //   真实的三层树是 index.md + nodes/<id>.md。这里给出**可点的实际路径**，模型要细节时知道去哪。
      // ★ P6a（2026-10-30）：TRACE 只给**相对路径**（`sessions/<sid>/index.md`）。
      //   旧版把 `treeDir` 的绝对路径整条写进去（`["D:", "DeepSeek Harness", "home"].join(String.fromCharCode(92))\chess-context\sessions\<sid>`，
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
      // ★ C52：同类失败的无损压缩 —— 若每条失败边的标记键集合完全相同（典型：全部 blocked:permission），
      //   标记从每行移到一行汇总（`# all 9 failures: blocked:permission`），每行省 20+ 字符，
      //   而「它们全属同一类」这个额外事实也保住了；图例照旧解释键含义 ⇒ 语义零丢失。
      const tagLists = shown.map((e) => failureTags(e, tewariMap.get(e.id) ?? null, markers));
      // 只用「完整标记串」判同一类：`dead retry-if:e1` 与 `dead retry-if:e2` 不同（逐条指针不能并成一条）
      const keySets = tagLists.map((list) => [...list].sort());
      const uniform =
        shown.length >= 3 &&
        level >= 2 &&
        keySets.every((ks) => ks.length > 0 && ks.length === keySets[0].length && ks.every((k, idx) => k === keySets[0][idx]));
      if (uniform) tailLines.push(`# all ${shown.length} failures: ${keySets[0].join(", ")}`);
      const markerLines = markerLegendLines(tagLists, { compact: level >= 2 });
      for (const line of markerLines) tailLines.push(line);
      if (omitted > 0) {
        tailLines.push(
          `- … ${omitted} earlier dead ends omitted for budget: ${failures[0].id}..${failures[omitted - 1].id} — full text: ${relTree ? `${relTree}/graph.json` : "graph.json"} / nodes/<id>.md`,
        );
      }
      // ★ C231（K-6 主体）：**已修正的失败沉底**。
      //   依据（Lost in the Middle，TACL 2023）：中段最容易被漏读 —— 而 LEARNED 里判别价值最低的，
      //   正是「同一条 action 后来自己跑通了」的那些边（数量见 doctor 的抗干扰度）。它们**一条都不删**
      //   （契约要求不丢失败记忆），只是排到段末，让「还没被自己修正过」的留在最前面。
      //   排序稳定 ⇒ 两组内部仍按原顺序（老的在前），不引入新语义。
      const orderedShown = [...shown].sort((a, b) => (laterSuccessOf(a, successEdges) ? 1 : 0) - (laterSuccessOf(b, successEdges) ? 1 : 0));
      for (const e of orderedShown) {
        tailLines.push(
          renderFailureLine(
            e,
            level,
            tewariMap.get(e.id) ?? null,
            // 同类失败：标记已在汇总行说明 ⇒ 行内不再重复（语义没丢，只换了位置）
            uniform ? "off" : markers,
            laterSuccessOf(e, successEdges),
            retriedTimesOf(e),
          ),
        );
      }
    }
    // ★ P6C-1：OPTIONS 区段（新鲜 + 陈旧，陈旧标 `[stale Xm]`）。只在 L0/L1 出现，
  //   与 UNVERIFIED 同档 —— 它们是「下一步要不要接着做」的决策信息，预算紧张时先让位给失败记忆。
  if (options.length) {
      // ★ 2026-11-01（调研建议 D + 提取诱发遗忘依据）：L2+ 也不再整段消失 ——
      //   至少留「还有几个选项 + 最近一条」。只列当前路径会让模型忘记还有别的路，
      //   而沉默本身就是一种断言（"只有这一条路"）。
      if (level <= 1) {
        tailLines.push("OPTIONS (not yet landed):");
        for (const e of options.slice(-6)) tailLines.push(`- ${e.id} "${clip(e.intent || e.action, 50)}"${staleTagOf(e, now)}`);
      } else {
        // ★ 2026-11-01 二次修正（bench）：去掉 latest 的 intent 摘录 —— id 足够定位，省 ~35 字符/行。
        const latest = options[options.length - 1];
        tailLines.push(`OPTIONS: ${options.length} not yet landed (latest ${latest.id})`);
      }
    }
    if (open.length && level <= 1) {
      // C46：只陈述状态（unproven），不写「把它当成未验证来对待」这类认知指令。
      tailLines.push("UNVERIFIED (ran, but no external signal — unproven):");
      for (const e of open.slice(-6)) tailLines.push(`- ${e.id} "${clip(e.intent || e.action, 50)}"`);
    } else if (open.length) {
      // ★ 2026-11-01（handoff-check 在 live 语料上抓到：契约 ⑤ 在 L2+ 静默消失）：
      //   「跑了但没验证」的声明在紧档位整段消失 = 断言「没有未验证的东西」，与 OPTIONS 同一类错误
      //   （提取诱发遗忘）。L2+ 至少留一行计数 + 最近一条 id —— 只陈述事实，不给行动建议。
      const latestOpen = open[open.length - 1];
      // C56：这是计数行、不是省略行 —— 位置信息已由「docs / TRACE」约定承载，不再重复一条指针。
      tailLines.push(`UNVERIFIED: ${open.length} unproven (latest ${latestOpen.id})`);
    }
    // ★ C226：**1 个节点的路径也是路径**。旧条件是 `path.length > 1` ⇒ 任何「只有当前位置、
    //   走不出链」的图（只有一个 agent 节点 / 边还没接上）在**任何档位**都不出路径行，
    //   而 handoff-check 的契约 ⑥ 要求「图有路径 ⇒ 清单必须有当前位置」（live 实测 2 个会话稳定 FAIL）。
    if (path.length > 0) {
      const shape = PATH_SHAPE[Math.min(level, PATH_SHAPE.length - 1)];
      // ★ C-17（2026-10-30，第二轮修）：路径行预算必须扣掉**这一档除路径以外的全部行** ——
      //   header / root / constraints **以及已经算好的 tailLines（失败边块）**、还要 push 的
      //   CURRENT GOAL / weak 图例 / `# WORKING: none` / 置换提示 / `</chess-ledger>`。
      //   第一版只扣了 header 那几行 ⇒ pathBudget 恒 ≈ maxTokens×3 ⇒「整条路径放得下就原样」，
      //   于是 L3 把 n1→…→n177 共 1064 字符原样塞进去：实测 500 预算下超预算会话 7 → 25
      //   （verifier 复验抓到；e3820651 331→742、6f90bd1d 453→810 …）。
      //   现在 `prePathUnits` 是**精确的加权单位数**（W-A：4 单位 = 1 token，CJK 4 单位/字），
      //   `available` 才是路径行真正能用的额度。
      // ★ C448：goal 常常为空（真机 0.3%）⇒ 兜底最近一条 user 原话（否则这行等于不存在）
      const goalOf = currentGoalOf(g, latest);
      const goalLine = goalOf === null ? null : `CURRENT GOAL: ${clip(goalOf.text, level <= 1 ? 240 : 120)}`;
      const transpositionNote = (() => {
        let transposed = 0;
        for (let i = 1; i < path.length; i += 1) {
          const fromId = path[i - 1].id;
          const toId = path[i].id;
          if (transpositionKeys.has(`${fromId}>${toId}`)) transposed += 1;
        }
        if (transposed === 0) return null;
        return `⚠ 置换：当前路径有 ${transposed} 处回到已走过的状态（共 ${path.length - 1} 跳）——那些状态上试过的做法都记在下面的死路清单里。`;
      })();
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
      const suffixUnits = unitsOf(workSummary) + unitsOf(weakTag);
      // ★ W-A（2026-11-01）：预算数学从「字符 / 3」统一到**单位域**（4 单位 = 1 token；CJK 4 单位/字）。
      //   为什么必须动这里：`estimateTokens` 已经改成按字符类别加权，若这里的换算还用 `×3`，
      //   「路径块吃多少预算」就会按旧的一律口径算 —— 正文 CJK 占比 13.7% 但 token 占大头时比例会算错。
      const sizeOfUnits = (arr) => arr.reduce((n, l) => n + unitsOf(l) + 1, 0);
      // 精确口径：正文由各 line 用换行拼成 ⇒ 总单位 = Σ(units+1)；结尾行 `</chess-ledger>` 也要算。
      const prePathUnits = sizeOfUnits(lines) + sizeOfUnits(tailLines) + sizeOfUnits(fixedLines) + unitsOf("</chess-ledger>");
      const budgetUnits = maxTokens * BUDGET_UNITS_PER_TOKEN;
      /** 两条路径行真正能用的字符额度（已扣掉后缀）。fitPaths 按**字符**折行，而路径行是节点 id/ASCII
       *  （1 字符 = 1 单位）⇒ 单位额度可直接当字符额度用。 */
      // 再减 2：`actual = prePath + path − suffix − 1`，而 fitPaths 只看行长度、
      // 不含每行换行（最多 2 行）—— 不扣这 2 个字符就会稳定超 1~2 字符（实测 501 tokens 就是这么来的）。
      // ★ rev6：额度 = min(固定 150 字符, 真实剩余)，并且**这 150 字符要含 weak 图例与行尾后缀** ——
      //   它们都由路径块引起，不能只算路径行本身。实测漏算时单会话净增 90 token（04538c62 346→436：
      //   路径行 159 字符 + 图例 109 字符），直接突破「≤50 token/会话」的硬额度。
      const legendChars = workingWeak > 0 ? WEAK_LEGEND.length + 1 : 0;
      const quota = Math.max(0, PATH_QUOTA_CHARS - suffixChars - legendChars - 2);
      const available = Math.max(0, Math.min(quota, budgetUnits - prePathUnits - suffixUnits - 2));
      /** 两条路径行占用的**单位**数（含各自的行尾换行 + 后缀）。 */
      const pathUnits = (f) =>
        (f.currentLine ? unitsOf(f.currentLine) + 1 : 0) + (f.workingLine ? unitsOf(f.workingLine) + 1 : 0) + (f.currentLine || f.workingLine ? suffixUnits : 0);
      /** 路径块是否会把这档顶出预算（单位域直接比，不再经过 `/3` 的字符折算）。 */
      const overBudgetWith = (f) => prePathUnits + pathUnits(f) > budgetUnits;
      let folded;
      /** 极端兜底：路径降到「一行最小形态」时为 true（此时不挂 weak 标记，见下）。 */
      let minimalPath = false;
      if (shape === "full") {
        folded = { currentLine, workingLine };
      } else {
        // ① 先按**分开写**折（显式 `WORKING:` 行）：模型不该靠 `(working edge e74)` 猜工作位置。
        folded = fitPaths(currentLine, workingLine, available, shape, workingTailId, { allowMerge: false });
        // ② 分开写装不下 ⇒ 允许把同尾的 WORKING 并进 CURRENT PATH（省一整行）
        if (overBudgetWith(folded)) {
          const mergedTry = fitPaths(currentLine, workingLine, available, shape, workingTailId, { allowMerge: true });
          if (pathUnits(mergedTry) < pathUnits(folded)) folded = mergedTry;
        }
        // ③ 折完**实测**一次：`estimateTokens` 数的是整条文本，`(user)` 后缀等会让「路径字符串长度」
        //    与真实占用对不上。装不下就按真实剩余重折，仍装不下再退到摘要形态；折不动了就停（不空转）。
        for (let pass = 0; pass < 3; pass += 1) {
          if (!overBudgetWith(folded)) break;
          const remaining = Math.max(0, Math.min(quota, budgetUnits - prePathUnits - suffixUnits - 2));
          const next = fitPaths(currentLine, workingLine, remaining, pass >= 1 ? "n1" : shape, workingTailId, { allowMerge: true });
          if (pathUnits(next) >= pathUnits(folded)) break;
          folded = next;
        }
        // ★ 最后兜底（C-17 第四轮修）：正文（root/约束/失败边）本身已经把预算吃满时，任何带路径的形态
        //   都可能装不下。**但 L3+ 绝不允许静默省略路径**（verifier 实测有 19 个会话一行路径都没有，
        //   其中 06698df9 pathLen=134、195ca61a 211、c4e44fab 151）——至少必须给出一行「当前位置」。
        //   阶梯：`# path: current <cur> working <work>` → `# path: current <cur>` → `# path: <cur>`。
        //   ★ 这一档不挂 `[weak k/n]`：标记必须与图例同行，图例（~108 字符）在这个预算下放不下；
        //     要么「标记 + 图例」一起有，要么都没有 —— 不许让标记裸奔。
        if (overBudgetWith(folded)) {
          const curTail = currentIds.at(-1) ?? "?";
          const workTail = workingIds !== null ? workingIds.at(-1) : null;
          const ladder = [
            `# path: current ${curTail}${workTail && workTail !== curTail ? ` working ${workTail}` : ""}`,
            `# path: current ${curTail}`,
            `# path: ${curTail}`,
          ];
          const pick = ladder.find((line) => prePathUnits + unitsOf(line) + 1 <= budgetUnits);
          // ★ 连最短一行都装不下也**照样输出最短那行**：宁可这一档超预算（会落到 L4/L5 由 pickFallback 择优），
          //   也不允许「路径整块消失」——静默省略比超预算更危险（模型会以为没有路径）。
          folded = { currentLine: pick ?? ladder[ladder.length - 1], workingLine: null };
          minimalPath = true;
        }
      }
      // ★ C-17 修（2026-10-30）：WORKING 可能被**并进** CURRENT PATH（同尾 ⇒ fitPaths 规则 1，
      //   workingLine 返回 null）。旧写法直接 `${folded.workingLine}${summary}${weakTag}` ⇒
      //   实测 session-example 输出一行字面量 `null [weak 1/1]`：
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
    attempts.push({
      text,
      tokens,
      level,
      omittedEdges: omitted,
      failureCount: failures.length,
      shownFailures: shown.length,
      traceRecent,
      // C44：不可裁下限（root+constraints）的 token 数 —— 超预算归因用
      unyieldingTokens: estimateTokens(unyieldingText),
    });
    // ★ C-17：L0–L3 装下就立刻返回（与旧版一致）；L4/L5 是兜底但要**比一比**再定 ——
    //   旧版 L4 只要走进来就无条件返回，即使它比 L5 更费（L4 列 20 条、L5 列 10 条）。
    //   现在两档都渲染后再选：优先「预算内 tokens 最小」，其次「tokens 最小」，最后「列得最多」。
    if (level < 4 && tokens <= maxTokens) {
      const chosen = attempts.at(-1);
      return {
        ...chosen,
        fallback: "none",
        budgetMax: maxTokens,
        overBudgetBy: 0,
        provenanceCoverage: provenanceCoverageOf(chosen.text, failuresById),
        evidenceMissing,
        sections: measureLedgerSections(chosen.text),
        // C63：所有尝试的 tokens（归因据此判断「所选是否已是最省的一份」）
        attemptTokens: attempts.map((a) => ({ level: a.level, tokens: a.tokens })),
      };
    }
  }
  const best = pickFallback(attempts, maxTokens, failures.length);
  if (best) {
    // ★ P5（2026-10-30）：`pickFallback` 不得**静默**返回超预算内容。
    //   `fallback` 三态：none（预算内）/ over-budget（兜底超限，但已是最省的那份）/ impossible（连兜底都构造不出）。
    //   `overBudgetBy` 给指标系统单独统计，调用方（engine/doctor/审计）不需要自己再算一遍。
    const over = Math.max(0, best.tokens - maxTokens);
    return {
      ...best,
      fallback: fallbackStatusOf(best, maxTokens),
      budgetMax: maxTokens,
      overBudgetBy: over,
      // ★ 出处覆盖率（0–1）：边行里带 (seq …) 的比例。应恒为 1；掉下来说明有路径在砍出处。
      provenanceCoverage: provenanceCoverageOf(best.text, failuresById),
      evidenceMissing,
      attemptTokens: attempts.map((a) => ({ level: a.level, tokens: a.tokens })),
      sections: measureLedgerSections(best.text),
    };
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
    provenanceCoverage: 1,
    evidenceMissing,
    sections: { root: 0, constraints: 0, failures: 0, options: 0, unverified: 0, path: 0, other: 0 },
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
export function renderMinimalLedger(g, { maxTokens = 500, now = Date.now() } = {}) {
  const root = g?.rootNode ?? (g?.rootUserNodeIds ?? []).map((id) => g?.nodes?.[id]).filter(Boolean)[0];
  const latest = latestAgentNode(g);
  const goalText = clip(String(latest?.goal ?? root?.text ?? "").replace(/\s+/g, " ").trim(), 120);
  const constraints = root?.constraints ?? [];
  const lines = ["<chess-ledger>"];
  // ★ C224：契约 ① 认的是 **ROOT USER**（不是 GOAL）——零失败会话走最小清单，
  //   旧版只写 GOAL ⇒ handoff-check ①根目标 直接 FAIL（用生产分支后 live 实测 3 个会话）。
  const rootText = clip(String(root?.text ?? "").replace(/\s+/g, " ").trim(), 120);
  if (rootText) lines.push(`ROOT USER (verbatim): ${rootText}`);
  if (goalText && goalText !== rootText) lines.push(`GOAL: ${goalText}`);
  else if (!rootText && goalText) lines.push(`GOAL: ${goalText}`);
  lines.push(`CONSTRAINTS: ${constraints.length}`);
  // ★ C223：零失败边的会话占真实会话的约 26%，而旧版最小清单**完全没有当前位置** ——
  //   模型只拿到「目标 + 约束个数 + 没有失败」，不知道自己在哪一步、手里那条工作路径是什么。
  //   契约 ⑥（图有路径 ⇒ 清单必须有当前位置）在这里被违反了：handoff-check 在 live 上抓到 2 个会话
  //   （5df02bf8 / 30140e4c）。补一行和主清单同形态的 `# path:`（头尾折叠，宽度由 pathDigestLine 控制）。
  const minimalPathIds = latest ? currentPath(g, latest.id).map((n) => n.id) : [];
  if (minimalPathIds.length > 0) lines.push(pathDigestLine(minimalPathIds));
  // ★ C224：契约 ④/⑤ 认的是 OPTIONS / UNVERIFIED 两个词。零失败**不等于**没有其它问题边 ——
  //   「未落地尝试」与「跑了但没外部信号」都可能存在，旧版把这两类一起吞掉，
  //   生产里模型完全看不到（handoff-check 改走生产分支后立刻抓到 2 个会话）。只给计数行，约 10 token。
  const minimalEdges = Object.values(g?.edges ?? {});
  const unverifiedCount = minimalEdges.filter((e) => e?.result === "unverified" && !isDanglingResidue(e, { graph: g, now })).length;
  const optionCount = minimalEdges.filter((e) => isDanglingOption(e, { graph: g, now })).length;
  if (optionCount > 0) lines.push(`OPTIONS: ${optionCount} not yet landed`);
  if (unverifiedCount > 0) lines.push(`UNVERIFIED: ${unverifiedCount} unproven`);
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
    // 最小清单不渲染任何带 seq 的行 ⇒ 出处覆盖率天然是 1（不是"没检查"，是"没有可砍的"）
    provenanceCoverage: 1,
    evidenceMissing: 0,
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
function markerLegendLines(tagLists, { compact = false } = {}) {
  const seen = [];
  for (const tags of tagLists) {
    for (const tag of tags ?? []) {
      const key = legendKey(tag);
      if (!seen.includes(key)) seen.push(key);
    }
  }
  if (seen.length === 0) return [];
  // ★ C51：L2+ 起图例压成**一行**（`a = x · b = y`）—— 每多一行都要付换行与前缀的 token；
  //   在预算紧张的中低档位，语义一个不少、只省排版。L0/L1 仍用多行形式（预算宽裕时更好读）。
  if (compact) {
    return ["# markers: " + seen.map((key) => `${key} = ${MARKER_LEGEND[key] ?? "(unknown marker)"}`).join(" · ")];
  }
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
export function renderFacts(
  g,
  { maxFailures = 800, headFailures = 80, range = null, treeDir = "", traceRoot = "", now = Date.now() } = {},
) {
  // ★ 2026-11-01（调研候选 #3）：省略行必须给出**可解析的位置**，且不允许泄漏绝对路径（P6a）。
  //   与热清单的 TRACE 行同一套相对化规则：`treeDir` → `sessions/<sid>`（或配置的 traceRoot）。
  const relTree = treeDir ? traceRelativeDir(treeDir, traceRoot) : "";
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
    lines.push(`FAILED_ATTEMPTS_OMITTED: ${omitted} earlier dead ends ${omittedSpan} are NOT listed here for budget — full text: ${relTree ? `${relTree}/graph.json` : "graph.json"} (node files: nodes/<id>.md); do not invent or merge them, just note that they exist.`);
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
        `DANGLING_RESIDUE: ${residueFailures.length} of the failed attempts above have no endpoint (to=null; 1.9.1 rewash residue) — excluded from hot-list analysis, data kept in ${relTree ? `${relTree}/graph.json` : "graph.json"}.`,
      );
    }
    if (stats.fromBroken > 0) {
      lines.push(`FROM_DANGLING: ${stats.fromBroken} edges point from a non-existent node (separate corruption class; NOT residue; do not prune with to-null).`);
    }
    if (stats.liveUnsettled > 0) {
      lines.push(`LIVE_UNSETTLED: ${stats.liveUnsettled} edges are newly unsettled (untested, <=10min) — kept visible on purpose.`);
    }
    if (stats.candidates > 0) {
      lines.push(`STALE_UNSETTLED: ${stats.candidates} edges are untested and older than 10min — listed as OPTIONS (not yet landed), NOT residue.`);
    }
  }
  // ★ P6C-1：未落地的尝试（untested + to=null）单独成段，不再混进 UNVERIFIED_CLAIMS。
  const openAll = openEdges(g);
  const options = openAll.filter((e) => isDanglingOption(e, { graph: g, now }));
  const open = openAll.filter((e) => !isDanglingOption(e, { graph: g, now }));
  if (options.length) {
    lines.push("OPTIONS (not yet landed):");
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
