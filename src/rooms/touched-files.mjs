import { evidenceSpan } from "./kifu-model.mjs";
/**
 * touched-files.mjs —— 折叠摘要里的「最近访问的文件」（C4，2026-11-01）
 *
 * 为什么（只做压缩本职，判据见 docs/压缩的职责边界.md 第 1 节）：
 *   fold 之后，被遮蔽区间里的 read/edit/write 只剩摘要里一句「改了接口」；
 *   模型知道**做过什么**，却不知道**是哪个文件**。而这些文件路径本来就在图边的 `action`
 *   里（`read(file_path=…)`、`edit(path=…)`），不需要模型润色、也不需要再花一次调用 ——
 *   机械解析、确定性、可复现，正好是压缩该做的事。
 *
 * 边界（红线，任何一条破了就不要这个功能）：
 *   · 只从**本进程的图**里解析，只取 evidence 与本次 fold range 有交集的边 —— 不跨会话、不读盘；
 *   · 只进**折叠摘要**（一次性，`engine.summarize` 的机械追加段），**不进**每步热清单（那是常驻成本）；
 *   · 只陈述「访问过什么 + seq 区间」这个事实，不写「下一步该读哪个文件」这类行为指导 ——
 *     要不要接着改是模型自己的判断，压缩只提供历史。
 *
 * 不做的事：
 *   · **不解析 bash 命令里的路径**。`bash(command=…)` 里可能是 `cd`、通配、重定向、管道，
 *     启发式猜出来的路径会污染「最近访问的文件」这个事实清单；工具名不是文件类就直接跳过。
 */

/** 只认这些工具：它们的第一个路径参数就是「访问了哪个文件」。 */
const FILE_TOOLS = new Set(["read", "edit", "write", "multi_edit", "apply_patch"]);
/** 参数名按优先级取第一个存在的（`file_path` 是 DSH 文件类工具的主键，`path` 是兼容键）。 */
const PATH_KEYS = ["file_path", "path"];
/** 路径最长保留多少字符（图的 action 本身在 kifu-model 里就是 240 上限，这里再兜一次）。 */
const MAX_PATH_CHARS = 240;
/** 下一个 `key=` 的边界 —— actionSummary 的形态是 `key=value key=value`，值里可以有空格。 */
const NEXT_ARG_RE = /(?:^|\s)[A-Za-z0-9_-]+=/;

/**
 * 从一条图边的 `action` 字符串里解析出「文件路径」。
 *
 * 形态（keeper.actionSummary 的确定性产物）：
 *   `read(file_path=<workspace>`
 *   `edit(file_path=<workspace>`
 *   `write(file_path=<workspace> content=# 标题 …)`      ← 第二个参数带空格，要在 ` content=` 处截断
 *   `write(file_path="<workspace> docs\a.md")`               ← 带引号（宿主/测试都可能出现）
 *   `read(file_path=<workspace>`                    ← action 被截断（没有闭合括号）
 *
 * @param {unknown} action
 * @returns {string|null} 路径（最长 {@link MAX_PATH_CHARS} 字符）；不是文件类工具或没有路径参数 ⇒ null
 */
export function parseTouchedFileAction(action) {
  const raw = String(action ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (raw === "") return null;
  const head = /^([A-Za-z0-9_-]+)\(/.exec(raw);
  if (head === null || !FILE_TOOLS.has(head[1])) return null;
  const body = raw.slice(head[0].length);
  // 两个键都可能有；取**先出现**的那个（正常 action 只有一个，`multi_edit` 之类可能有同义键）。
  let keyAt = -1;
  let keyLen = 0;
  for (const key of PATH_KEYS) {
    const m = new RegExp(`(?:^|\\s)${key}=`).exec(body);
    if (m !== null && (keyAt < 0 || m.index < keyAt)) {
      keyAt = m.index;
      keyLen = m[0].length;
    }
  }
  if (keyAt < 0) return null;
  let rest = body.slice(keyAt + keyLen);
  // 值到「下一个 key=」为止：路径里可以有空格（`<workspace> docs\a.md`），所以不能按空格切。
  const next = NEXT_ARG_RE.exec(rest);
  const truncated = next === null;
  if (next !== null) rest = rest.slice(0, next.index);
  rest = rest.trim();
  // 没被截断时 action 以 `)` 收尾；路径内部合法的 `)` 无法与语法括号区分，因此只在**末尾**剥一个。
  // ★ 必须先剥括号再剥引号：`file_path="…"）` 的末尾是 `"` + `)`，顺序反了会剩一个孤引号。
  if (truncated && rest.endsWith(")")) rest = rest.slice(0, -1);
  // 引号：成对出现就剥两层；被截断时只会剩开头引号，也要剥（否则路径带着 `"` 去重会错）。
  if (rest.length >= 2 && ((rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'")))) {
    rest = rest.slice(1, -1);
  } else if (rest.startsWith('"') || rest.startsWith("'")) {
    rest = rest.slice(1);
  }
  rest = rest.replace(/\s+/g, " ").trim();
  return rest === "" ? null : rest.slice(0, MAX_PATH_CHARS);
}

/** 边的 evidence 区间；支持数字与 `{start,end}`（旧图/测试夹具两种形态都出现过）。 */

/**
 * 折叠区间内「最近访问的文件」。
 *
 * 规则（顺序即契约）：
 *   1. 只看图**边**（不看节点评语），evidence 缺失的边直接跳过 —— 没有 seq 就没法给出处；
 *   2. 给了 `range` 就只取与区间有**交集**的边（`end >= start && start <= end`）；
 *      `range` 为 null ⇒ 不按区间过滤（手动 `/compact` 之外、或测试里直接调用的场景）；
 *   3. 按 `evidence.end` **倒序**（最近访问的在前），同一时间点上后创建的边优先；
 *   4. 按**路径**去重 —— 保留最近的一次访问（同一文件被 edit 多次只出现一行）；
 *   5. 最多 `limit` 条（默认 5）。
 *
 * @param {object} graph 棋谱（`edges` 为对象字典）
 * @param {{range?: {start:number,end:number}|null, limit?: number}} [options]
 * @returns {Array<{path:string, seqStart:number, seqEnd:number}>}
 */
export function extractTouchedFiles(graph, { range = null, limit = 5 } = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
  const edges = graph !== null && typeof graph === "object" && graph.edges !== null && typeof graph.edges === "object" ? Object.values(graph.edges) : [];
  const lo = range !== null && typeof range === "object" && Number.isFinite(range.start) ? range.start : null;
  const hi = range !== null && typeof range === "object" && Number.isFinite(range.end) ? range.end : null;
  const rows = [];
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    const span = evidenceSpan(edge);
    if (span === null) continue;
    if (lo !== null && hi !== null && !(span.end >= lo && span.start <= hi)) continue;
    const path = parseTouchedFileAction(edge.action);
    if (path === null) continue;
    rows.push({ path, seqStart: span.start, seqEnd: span.end, index });
  }
  rows.sort((a, b) => b.seqEnd - a.seqEnd || b.index - a.index);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(row.path)) continue;
    seen.add(row.path);
    out.push({ path: row.path, seqStart: row.seqStart, seqEnd: row.seqEnd });
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * 机械渲染（给 `engine.summarize` 的追加段用）：每行 `- <path> (seq a-b)`。
 * 不经过模型、不排序（排序已在 extractTouchedFiles 里定好），空数组返回空串。
 * @param {Array<{path:string, seqStart:number, seqEnd:number}>} list
 */
export function formatTouchedFiles(list) {
  if (!Array.isArray(list) || list.length === 0) return "";
  return list.map((row) => `- ${row.path} (seq ${row.seqStart}-${row.seqEnd})`).join("\n");
}

/** 追加段的标题（机械段，与「约束（机械保留…）」同一种语气：只陈述事实，不给行动指令）。 */
export const TOUCHED_FILES_HEADER = "## 最近访问的文件（机械保留，不由模型改写）";

/**
 * 给 `engine.summarize` 的一整段文本（含前导空行）；空集返回空串（**不要**输出一个空标题）。
 *
 * 边界：只进**折叠摘要**（一次 fold 的产物），不进每步热清单 —— 后者是常驻成本。
 * 内容只陈述「哪个文件、在哪个 seq 区间被访问过」，不写「下一步该读哪个」。
 *
 * @param {object} graph 棋谱
 * @param {{start:number,end:number}|null} [range] 本次 fold 遮蔽的 seq 区间
 */
export function touchedFilesBlock(graph, range = null) {
  const body = formatTouchedFiles(extractTouchedFiles(graph, { range, limit: 5 }));
  if (body === "") return "";
  return `\n\n${TOUCHED_FILES_HEADER}\n${body}`;
}
