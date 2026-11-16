/**
 * query-recall.test.mjs —— 「代码锚点按需召回」纯函数模块的门禁（Q1-core）
 *
 * 为什么要有：召回是**机械**的（零模型、零 IO），它的全部价值在「认对了没有、排序对不对、截断真不真」。
 * 任何一条错了，注入给模型的就会是「没问过的文件」或「声称有证据但其实没有」——
 * 这比不给证据更糟（证据不增公理：生成只是候选，证据才使事实成立）。
 *
 * 覆盖：路径（POSIX / Windows / 相对后缀 / 反引号 basename / 文件语境）、符号边界、
 *       无锚点与无匹配的零输出、limit / maxChars 真截断、稳定排序、坏输入不抛、
 *       失败原因保留、只读与可重复（纯函数、无缓存、不改图）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import {
  QUERY_RECALL_HEADER,
  collectQueryRecall,
  extractQueryAnchors,
  renderQueryRecall,
} from "../src/rooms/query-recall.mjs";

export const tests = {};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = nodePath.join(HERE, "..", "src", "rooms", "query-recall.mjs");

/** 造 `{ nodes, edges }` 形状；`evidence` 默认给一个合法区间（没有 evidence 的边本来就不能当证据）。 */
function graphOf(edges) {
  const dict = {};
  edges.forEach((edge, index) => {
    const id = edge.id ?? `e${index + 1}`;
    dict[id] = {
      id,
      from: "n0",
      to: "n1",
      intent: "",
      action: "",
      result: "success",
      verify: { kind: "none", summary: "" },
      errorSnippet: "",
      evidence: { start: 1, end: 1 },
      ...edge,
    };
  });
  return { nodes: {}, edges: dict };
}

/* ── 1. 路径识别 ── */

tests["Q1-1 路径锚点：POSIX 绝对路径与仓库相对路径，paths 保留原文"] = (t) => {
  const anchors = extractQueryAnchors("先看 /tmp/q1/a.md，再看 src/rooms/touched-files.mjs 和 test/run.mjs 吧");
  t.eq(anchors.paths, ["/tmp/q1/a.md", "src/rooms/touched-files.mjs", "test/run.mjs"], "三条路径都要认出来（顺序=出现顺序）");
  t.eq(anchors.symbols, [], "纯路径不应产出符号");
};

tests["Q1-2 Windows 路径：原文保留反斜杠，匹配时统一 `\\`→`/`（按 Windows 语义大小写不敏感）"] = (t) => {
  const anchors = extractQueryAnchors(String.raw`为什么 D:\fixture\repo\src\a.mjs 的 edit 失败`);
  t.eq(anchors.paths, [String.raw`D:\fixture\repo\src\a.mjs`], "原文（反斜杠）必须保留");

  const graph = graphOf([
    { id: "e1", action: String.raw`edit(file_path=D:\fixture\repo\src\a.mjs)`, evidence: { start: 10, end: 11 } },
  ]);
  const recall = collectQueryRecall(graph, "看一下 d:/fixture/REPO/src/a.mjs");
  t.eq(recall.anchors.paths, ["d:/fixture/REPO/src/a.mjs"], "正斜杠写法也是一个锚点");
  t.eq(recall.items.length, 1, "同一路径的不同写法（斜杠、大小写）必须命中");
  t.eq(recall.items[0].kind, "path", "kind 必须是 path");
  t.eq(recall.items[0].score, 100, "完整路径 = 最高档");
  t.eq(recall.items[0].seqStart, 10, "seqStart 来自 evidence");
  t.eq(recall.items[0].path, "d:/fixture/REPO/src/a.mjs", "item.path 保留锚点原文");
};

tests["Q1-3 相对后缀：仓库相对锚点命中绝对路径边（档位 80，低于完整路径）"] = (t) => {
  const graph = graphOf([
    {
      id: "e1",
      action: "read(file_path=D:/fixture/repo/dsh-GOkifu-compact/src/rooms/query-recall.mjs)",
      evidence: { start: 5, end: 6 },
    },
  ]);
  const relative = collectQueryRecall(graph, "src/rooms/query-recall.mjs 为什么没生效");
  t.eq(relative.items.length, 1, "仓库相对后缀要能命中绝对路径边");
  t.eq(relative.items[0].score, 80, "相对后缀档 = 80");

  const full = collectQueryRecall(graph, String.raw`D:\fixture\repo\dsh-GOkifu-compact\src\rooms\query-recall.mjs 呢`);
  t.eq(full.items.length, 1, "完整路径写法也要命中");
  t.eq(full.items[0].score, 100, "完整路径档 = 100（高于相对后缀）");

  // 边界：不能因为后缀相同就跨目录误命中（`notsrc/...` 与 `src/...` 是两回事）
  const other = graphOf([
    { id: "e2", action: "read(file_path=D:/fixture/repo/notsrc/rooms/query-recall.mjs)", evidence: { start: 1, end: 1 } },
  ]);
  t.eq(collectQueryRecall(other, "src/rooms/query-recall.mjs").items.length, 0, "后缀必须落在 `/` 边界上");
};

tests["Q1-4 反引号 basename：只认反引号或明确文件语境，裸 basename 不猜"] = (t) => {
  t.eq(extractQueryAnchors("`run.mjs` 这个入口").paths, ["run.mjs"], "反引号里的裸 basename = 路径");
  t.eq(extractQueryAnchors("run.mjs 这个入口").paths, [], "没有反引号 / 文件语境的裸 basename 不猜");
  t.eq(extractQueryAnchors("文件 run.mjs 读一下").paths, ["run.mjs"], "明确文件语境可以接受");

  const graph = graphOf([{ id: "e1", action: "read(file_path=test/run.mjs)", evidence: { start: 2, end: 3 } }]);
  const recall = collectQueryRecall(graph, "`run.mjs` 跑不动");
  t.eq(recall.items.length, 1, "basename 锚点要按文件名命中边路径");
  t.eq(recall.items[0].score, 60, "basename 档低于相对后缀");
};

tests["Q1-5 bash 命令里的裸名字、URL 里的斜杠、普通斜杠短语都不算路径"] = (t) => {
  const anchors = extractQueryAnchors(
    "运行 node test/run.mjs，再 cat a.txt，顺便看看 https://example.com/src/a.mjs 和 压缩/热清单",
  );
  t.eq(anchors.paths, ["test/run.mjs"], "只认明确的仓库相对路径");
  t.eq(anchors.symbols, [], "命令里的裸文件名不是符号");
};

/* ── 2. 符号识别与边界 ── */

tests["Q1-6 符号识别：反引号标识符 / name() / obj.method；文件名不当符号"] = (t) => {
  t.eq(extractQueryAnchors("`render` 为什么不走").symbols, ["render"], "反引号标识符");
  t.eq(extractQueryAnchors("render() 为什么没被调用").symbols, ["render"], "name() 形式（去掉括号）");
  t.eq(extractQueryAnchors("`render()` 为什么没被调用").symbols, ["render"], "反引号 + name()");
  t.eq(extractQueryAnchors("graph.edges 是只读的").symbols, ["graph.edges"], "obj.method 形式");
  t.eq(extractQueryAnchors("`graph.edges`").symbols, ["graph.edges"], "反引号 obj.method 是符号，不是路径");
  t.eq(extractQueryAnchors("`a.mjs`").symbols, [], "文件名不能被当成符号");
  t.eq(extractQueryAnchors("e.g. 这样 i.e. 那样").symbols, [], "拉丁缩写不当符号");
};

tests["Q1-7 符号边界：render 不命中 renderer，但命中 render() 与 scripts/render.mjs"] = (t) => {
  const graph = graphOf([
    { id: "e1", action: "bash(command=npm run renderer-build)", evidence: { start: 5, end: 5 } },
    { id: "e2", action: "bash(command=node scripts/render.mjs --check)", evidence: { start: 3, end: 3 } },
  ]);
  const recall = collectQueryRecall(graph, "`render` 为什么失败");
  t.eq(recall.items.map((item) => item.id), ["e2"], "renderer 是子串误命中，必须挡住");
  t.eq(recall.items[0].kind, "symbol", "kind 是 symbol");
  t.eq(recall.items[0].score, 40, "符号档 = 40");
  t.includes(recall.items[0].text, "render", "证据短文本要能看到命中的符号");
};

/* ── 3. 零输出 ── */

tests["Q1-8 无锚点：items 为空、text 为空串（不输出空标题），stats 仍然记账"] = (t) => {
  const graph = graphOf([
    { id: "e1", action: "read(file_path=/a.md)", evidence: { start: 1, end: 2 } },
    { id: "e2", action: "edit(file_path=/b.mjs)", evidence: { start: 3, end: 4 } },
    { id: "e3", action: "bash(command=ls)", evidence: { start: 5, end: 5 } },
  ]);
  const recall = collectQueryRecall(graph, "继续把剩下的做完");
  t.eq(recall.anchors, { paths: [], symbols: [] }, "没有锚点");
  t.eq(recall.items, [], "没有 item");
  t.eq(recall.stats.scannedEdges, 3, "扫过的边数要真实");
  t.eq(recall.stats.matchedEdges, 0, "命中 0 条");
  t.eq(recall.stats.truncated, false, "没东西可截");

  const rendered = renderQueryRecall(graph, "继续把剩下的做完");
  t.eq(rendered.text, "", "无锚点 ⇒ 空串，不是空标题");
  t.eq(rendered.items, [], "渲染结果也没有 item");
};

tests["Q1-9 有锚点但无匹配：零输出，不编造证据"] = (t) => {
  const graph = graphOf([{ id: "e1", action: "read(file_path=/a.md)", evidence: { start: 1, end: 2 } }]);
  const recall = collectQueryRecall(graph, "src/rooms/nope.mjs 有问题");
  t.eq(recall.anchors.paths, ["src/rooms/nope.mjs"], "锚点识别出来了");
  t.eq(recall.items, [], "图里没有对应边 ⇒ 不给证据");
  t.eq(recall.stats.matchedEdges, 0, "命中 0 条");

  const rendered = renderQueryRecall(graph, "src/rooms/nope.mjs 有问题");
  t.eq(rendered.text, "", "无匹配 ⇒ 空串");
  t.notIncludes(rendered.text, QUERY_RECALL_HEADER, "空集不输出标题");
};

/* ── 4. 截断 ── */

tests["Q1-10 limit 真截断：items 只留前 limit 条，stats.truncated 为 true"] = (t) => {
  const edges = [1, 2, 3, 4, 5].map((seq) => ({
    id: `e${seq}`,
    action: "read(file_path=src/a.mjs)",
    evidence: { start: seq, end: seq },
  }));
  const graph = graphOf(edges);
  const recall = collectQueryRecall(graph, "src/a.mjs", { limit: 2 });
  t.eq(recall.items.length, 2, "limit=2 ⇒ 只给 2 条");
  t.eq(recall.items.map((item) => item.id), ["e5", "e4"], "先按 seqEnd 新到旧再截");
  t.eq(recall.stats.matchedEdges, 5, "命中 5 条是真账");
  t.eq(recall.stats.kept, 2, "kept 是实际给出的条数");
  t.eq(recall.stats.limit, 2, "limit 回显");
  t.eq(recall.stats.truncated, true, "被 limit 截过 ⇒ truncated");

  const defaulted = collectQueryRecall(graph, "src/a.mjs");
  t.eq(defaulted.items.length, 5, "默认 limit 6 放得下 5 条");
  t.eq(defaulted.stats.truncated, false, "没截过 ⇒ false");
};

tests["Q1-11 maxChars 真截断：text 不超上限、放不下的行连同 item 一起丢、truncated 为 true"] = (t) => {
  const edges = [1, 2, 3, 4, 5, 6].map((seq) => ({
    id: `e${seq}`,
    action: `read(file_path=D:/fixture/repo/src/rooms/file-${seq}.mjs)`,
    evidence: { start: seq, end: seq },
  }));
  const graph = graphOf(edges);
  const query = "src/rooms/file-1.mjs 和 src/rooms/file-2.mjs 和 src/rooms/file-3.mjs 和 src/rooms/file-4.mjs";

  const cap = 240;
  const rendered = renderQueryRecall(graph, query, { maxChars: cap });
  t.ok(rendered.text.length > 0, "上限够放标题 + 至少一行时必须给出内容");
  t.ok(rendered.text.length <= cap, `text 长度 ${rendered.text.length} 必须 ≤ maxChars ${cap}`);
  t.ok(rendered.text.startsWith(QUERY_RECALL_HEADER), "有内容时以固定标题开头");
  t.eq(rendered.stats.truncated, true, "被 maxChars 截过 ⇒ truncated 为 true");
  t.ok(rendered.items.length < collectQueryRecall(graph, query).items.length, "被截掉的行不能留在 items 里");
  for (const item of rendered.items) t.includes(rendered.text, item.id, `${item.id} 出现在 items 就必须出现在 text 里`);

  const wide = renderQueryRecall(graph, query, { maxChars: 4000 });
  t.ok(wide.text.length <= 4000, "宽上限也不超");
  t.eq(wide.stats.truncated, collectQueryRecall(graph, query).stats.truncated, "limit 与 maxChars 都没截 ⇒ truncated 与 collect 一致");

  const zero = renderQueryRecall(graph, query, { maxChars: 0 });
  t.eq(zero.text, "", "maxChars=0 ⇒ 真的一点都不输出");
  t.eq(zero.items, [], "对应的 item 也不能留");
  t.eq(zero.stats.truncated, true, "有内容但一个字都放不下 ⇒ truncated");
};

/* ── 5. 排序 ── */

tests["Q1-12 稳定排序：完整路径 > 相对后缀 > 符号；同分按 seqEnd 新到旧；再同分按 edge id 字典序"] = (t) => {
  const graph = graphOf([
    { id: "e1", action: "read(file_path=D:/fixture/repo/src/a.mjs)", evidence: { start: 5, end: 5 } }, // 100
    { id: "e2", action: "read(file_path=src/a.mjs)", evidence: { start: 9, end: 9 } }, // 80
    { id: "e3", action: "bash(command=node --require collectQueryRecall.js)", evidence: { start: 2, end: 2 } }, // 40 seq 2
    { id: "e4", action: "bash(command=collectQueryRecall --help)", evidence: { start: 7, end: 7 } }, // 40 seq 7
    { id: "e10", action: "bash(command=npm run collectQueryRecall)", evidence: { start: 7, end: 7 } }, // 40 seq 7
    { id: "e5", action: "bash(command=collectQueryRecall)", evidence: { start: 8, end: 8 } }, // 40 seq 8
  ]);
  const query = "D:/fixture/repo/src/a.mjs 和 `collectQueryRecall` 的失败";
  const recall = collectQueryRecall(graph, query, { limit: 10 });
  t.eq(recall.anchors.paths, ["D:/fixture/repo/src/a.mjs"], "路径锚点");
  t.eq(recall.anchors.symbols, ["collectQueryRecall"], "符号锚点");
  t.eq(
    recall.items.map((item) => item.id),
    ["e1", "e2", "e5", "e10", "e4", "e3"],
    "档位降序 ⇒ seqEnd 降序 ⇒ id 字典序（e10 在 e4 前是字典序，不是数字序）",
  );
  t.eq(recall.items.map((item) => item.score), [100, 80, 40, 40, 40, 40], "档位值");
};

/* ── 6. 失败原因与只读 ── */

tests["Q1-13 失败边保留已有失败原因短文本（item.text 与渲染文本都要有）"] = (t) => {
  const graph = graphOf([
    {
      id: "e7",
      action: "edit(file_path=src/rooms/query-recall.mjs)",
      result: "failure",
      errorSnippet: "EACCES: permission denied, open 'src/rooms/query-recall.mjs'",
      verify: { kind: "tool", summary: "tool failed" },
      evidence: { start: 40, end: 41 },
    },
  ]);
  const query = "src/rooms/query-recall.mjs 报错了";
  const recall = collectQueryRecall(graph, query);
  t.includes(recall.items[0].text, "失败", "要标明这是失败边");
  t.includes(recall.items[0].text, "EACCES: permission denied", "失败原因短文本必须保留");

  const rendered = renderQueryRecall(graph, query);
  t.includes(rendered.text, "EACCES: permission denied", "渲染里也要带失败原因");
  t.notIncludes(rendered.text, "下一步", "只陈述已有事实，不写行动指令");
  t.notIncludes(rendered.text, "应该", "只陈述已有事实，不写行动指令");
};

tests["Q1-14 纯只读、可重复：模块无 IO 依赖；两次调用逐字相同；graph 一个字节都没变"] = (t) => {
  const source = nodeFs.readFileSync(MODULE_PATH, "utf8");
  for (const banned of ["node:fs", "node:path", "node:child_process", "fetch(", "@deepseek-ai", "readFileSync("]) {
    t.notIncludes(source, banned, `纯函数模块不得出现 ${banned}`);
  }
  const graph = graphOf([
    { id: "e1", action: "read(file_path=src/a.mjs)", evidence: { start: 1, end: 2 } },
    { id: "e2", action: "bash(command=collectQueryRecall)", evidence: { start: 3, end: 4 } },
  ]);
  const before = JSON.stringify(graph);
  const first = collectQueryRecall(graph, "src/a.mjs 和 `collectQueryRecall`");
  const second = collectQueryRecall(graph, "src/a.mjs 和 `collectQueryRecall`");
  t.eq(first, second, "同输入两次调用必须逐字相同（无隐藏状态 / 无常驻缓存）");
  t.eq(JSON.stringify(graph), before, "只读：graph 未被改写");
  t.eq(first.items.length, 2, "两条边各自命中");
};

/* ── 7. 坏输入 ── */

tests["Q1-15 坏输入不抛：null / 缺 edges / 非对象边 / 非法 limit 全部安全降级"] = (t) => {
  t.eq(extractQueryAnchors(null), { paths: [], symbols: [] }, "null 查询");
  t.eq(extractQueryAnchors(undefined), { paths: [], symbols: [] }, "undefined 查询");
  t.eq(extractQueryAnchors(42), { paths: [], symbols: [] }, "非字符串查询");
  t.eq(extractQueryAnchors(""), { paths: [], symbols: [] }, "空查询");

  t.eq(collectQueryRecall(null, "src/a.mjs").items, [], "null 图");
  t.eq(collectQueryRecall({}, "src/a.mjs").items, [], "没有 edges");
  t.eq(collectQueryRecall({ edges: null }, "src/a.mjs").items, [], "edges 为 null");
  t.eq(collectQueryRecall({ edges: [] }, "src/a.mjs").items, [], "edges 为空数组");
  t.eq(collectQueryRecall({ edges: { e1: null } }, "src/a.mjs").items, [], "非对象边跳过");
  t.eq(collectQueryRecall(null, "src/a.mjs").stats.scannedEdges, 0, "坏图的记账是 0");

  const noisy = graphOf([
    {
      id: "e1",
      action: "read(file_path=src/a.mjs)",
      evidence: null,
      verify: null,
      errorSnippet: null,
    },
    { id: "e2", action: null, intent: 42, evidence: { start: 1, end: 1 } },
  ]);
  t.eq(collectQueryRecall(noisy, "src/a.mjs").items, [], "没有 evidence 的边不能当证据（无法给出处）");
  t.eq(collectQueryRecall(noisy, "src/a.mjs").stats.scannedEdges, 2, "扫过的边仍然要记");

  const g = graphOf([{ id: "e1", action: "read(file_path=src/a.mjs)", evidence: { start: 1, end: 1 } }]);
  t.eq(collectQueryRecall(g, "src/a.mjs", { limit: Number.NaN }).stats.limit, 6, "NaN limit ⇒ 默认 6");
  t.eq(collectQueryRecall(g, "src/a.mjs", { limit: 0 }).stats.limit, 6, "limit=0 视为非法 ⇒ 默认 6");
  t.eq(collectQueryRecall(g, "src/a.mjs", null).items.length, 1, "options=null 不抛");
  t.eq(renderQueryRecall(null, "src/a.mjs").text, "", "null 图渲染成空串");
  t.eq(renderQueryRecall(g, "src/a.mjs", { maxChars: Number.NaN }).text.length > 0, true, "NaN maxChars ⇒ 默认值");
};

tests["Q1-16 真实枚举别名：`failed` 必须保留失败原因，`later-ok` 保留成功结算摘要"] = (t) => {
  const graph = graphOf([
    {
      id: "e1",
      action: "edit(file_path=src/rooms/query-recall.mjs)",
      result: "failed",
      errorSnippet: "TypeError: x is not a function",
      verify: { kind: "tool", summary: "tool failed" },
      evidence: { start: 20, end: 21 },
    },
    {
      id: "e2",
      action: "read(file_path=src/rooms/query-recall.mjs)",
      result: "later-ok",
      verify: { kind: "test", summary: "12 passed" },
      evidence: { start: 30, end: 31 },
    },
  ]);
  const query = "src/rooms/query-recall.mjs 为什么失败过又通过了";
  const recall = collectQueryRecall(graph, query);
  t.eq(recall.items.length, 2, "两条边都要召回");

  const failed = recall.items.find((item) => item.id === "e1");
  t.includes(failed.text, "失败", "`failed` 与 `failure` 同义，要标成失败");
  t.includes(failed.text, "TypeError: x is not a function", "`failed` 边的 errorSnippet 必须保留");

  const laterOk = recall.items.find((item) => item.id === "e2");
  t.includes(laterOk.text, "later-ok", "真实枚举原词要保留（不能改写成 success）");
  t.includes(laterOk.text, "12 passed", "`later-ok` 要带已有的成功结算摘要");

  const rendered = renderQueryRecall(graph, query);
  t.includes(rendered.text, "TypeError: x is not a function", "渲染文本也要带 failed 原因");
  t.includes(rendered.text, "later-ok", "渲染文本保留 later-ok 原词");

  // errorSnippet 为空时退回到 verify.summary（失败原因不能只剩一个「失败」）
  const noSnippet = graphOf([
    {
      id: "e3",
      action: "read(file_path=test/run.mjs)",
      result: "failed",
      verify: { kind: "exit", summary: "exit 1" },
      evidence: { start: 5, end: 5 },
    },
  ]);
  t.includes(collectQueryRecall(noSnippet, "test/run.mjs").items[0].text, "exit 1", "没有 errorSnippet 时用 verify.summary 兜底");
};

tests["Q1-17 stats 记账：scannedEdges == graph.edges 条数；matchedEdges 含被 limit 截掉的边"] = (t) => {
  const graph = graphOf([
    { id: "e1", action: "read(file_path=src/a.mjs)", evidence: { start: 1, end: 1 } },
    { id: "e2", action: "edit(file_path=src/a.mjs)", evidence: { start: 2, end: 2 } },
    { id: "e3", action: "write(file_path=src/a.mjs)", evidence: { start: 3, end: 3 } },
    { id: "e4", action: "read(file_path=/other.md)", evidence: { start: 4, end: 4 } },
    { id: "e5", action: "bash(command=ls)", evidence: { start: 5, end: 5 } },
    { id: "e6", action: "read(file_path=/x.json)", evidence: { start: 6, end: 6 } },
  ]);
  const recall = collectQueryRecall(graph, "src/a.mjs", { limit: 1 });
  t.eq(recall.stats.scannedEdges, 6, "扫了 6 条");
  t.eq(recall.stats.matchedEdges, 3, "命中 3 条（截断的也算命中）");
  t.eq(recall.stats.kept, 1, "给出 1 条");
  t.eq(recall.items.length, 1, "items 也只有 1 条");
  t.eq(recall.stats.truncated, true, "3 > 1 ⇒ 截过");
  t.eq(Object.keys(recall.items[0]).sort(), ["id", "kind", "path", "score", "seqEnd", "seqStart", "symbol", "text"], "item 形状是冻结契约");
};

/* ── 8. reviewer 返修（B-2 / M-3 性能 / 三个 MINOR） ── */

tests["Q1-18 B-2：长 action（≥210）的失败边，`⇒ 失败: <errorSnippet>` 不能被 200 字符上限切掉"] = (t) => {
  const longAction = `edit(file_path=src/rooms/query-recall.mjs content=${"x".repeat(210)})`;
  t.ok(longAction.length >= 210, `夹具的 action 必须 ≥210 字符（实际 ${longAction.length}）`);
  const reason = "EACCES: permission denied, open 'src/rooms/query-recall.mjs'";
  const graph = graphOf([
    {
      id: "e1",
      action: longAction,
      result: "failure",
      errorSnippet: reason,
      verify: { kind: "tool", summary: "tool failed" },
      evidence: { start: 70, end: 71 },
    },
  ]);
  const query = "src/rooms/query-recall.mjs 为什么写不进去";
  const recall = collectQueryRecall(graph, query);
  t.eq(recall.items.length, 1, "长 action 边同样要召回");
  const text = recall.items[0].text;
  t.ok(text.length <= 200, `item.text 仍受 200 上限约束（实际 ${text.length}）`);
  t.includes(text, "失败", "失败标记不能丢");
  t.includes(text, "EACCES: permission denied", "长 action 下 errorSnippet 必须保留（B-2）");
  t.includes(text, "…", "被裁的是 action（带省略号），不是状态后缀");
  t.ok(text.endsWith(reason), "失败原因必须在结尾完整出现");

  const rendered = renderQueryRecall(graph, query);
  t.includes(rendered.text, "EACCES: permission denied", "渲染文本同样保留失败原因");

  // 状态后缀自身就超长：200 字符内至少保住「⇒ 失败: 」+ 原因前缀
  const huge = graphOf([
    { id: "e2", action: longAction, result: "failure", errorSnippet: `EACCES: ${"y".repeat(400)}`, evidence: { start: 5, end: 5 } },
  ]);
  const hugeText = collectQueryRecall(huge, "src/rooms/query-recall.mjs").items[0].text;
  t.ok(hugeText.length <= 200, "极端长的原因也不许破 200 上限");
  t.includes(hugeText, "失败: EACCES:", "极端长的原因也要保住「失败: 原因前缀」");
};

tests["Q1-19 M-3 性能：text 只为最终保留的条目构建（命中 20 条、limit 3 ⇒ 恰好 3 次读取）"] = (t) => {
  const graph = graphOf(
    Array.from({ length: 20 }, (_unused, index) => {
      const seq = index + 1;
      return { id: `e${seq}`, action: "read(file_path=src/a.mjs)", result: "failure", errorSnippet: `boom-${seq}`, evidence: { start: seq, end: seq } };
    }),
  );
  // 用 getter 计数 errorSnippet 的读取次数：只有真正建 text 的条目才会读它。
  const reads = new Map();
  for (const [id, edge] of Object.entries(graph.edges)) {
    reads.set(id, 0);
    Object.defineProperty(edge, "errorSnippet", {
      enumerable: true,
      get() {
        reads.set(id, reads.get(id) + 1);
        return `boom-${id.slice(1)}`;
      },
    });
  }
  const recall = collectQueryRecall(graph, "src/a.mjs", { limit: 3 });
  const totalReads = [...reads.values()].reduce((sum, value) => sum + value, 0);
  t.eq(recall.items.map((item) => item.id), ["e20", "e19", "e18"], "排序/limit 契约不变");
  t.eq(recall.stats.matchedEdges, 20, "命中 20 条是真账");
  t.eq(recall.stats.truncated, true, "截过");
  t.eq(totalReads, 3, `只给保留的 3 条建 text（实际读了 ${totalReads} 次 errorSnippet）`);
  t.includes(recall.items[0].text, "boom-20", "保留条目的 text 仍然正确");
  t.includes(recall.items[2].text, "boom-18", "保留条目的 text 仍然正确");
};

tests["Q1-20 MINOR：Windows 图（graph.cwd 为盘符路径）上相对路径大小写不敏感；POSIX 图仍敏感"] = (t) => {
  // 边路径是 Windows 绝对路径时，相对锚点的大小写差异本来就要忽略
  const absoluteGraph = graphOf([{ id: "e1", action: "read(file_path=D:/repo/src/rooms/query-recall.mjs)", evidence: { start: 3, end: 4 } }]);
  t.eq(collectQueryRecall(absoluteGraph, "SRC/Rooms/Query-Recall.MJS 看一下").items.length, 1, "Windows 绝对边路径 + 大写相对锚点要命中");

  // 边路径也是相对路径时：由 graph.cwd 判定文件系统语义
  const relativeEdge = "read(file_path=Src/Rooms/Query-Recall.MJS)";
  const winGraph = { ...graphOf([{ id: "e1", action: relativeEdge, evidence: { start: 3, end: 4 } }]), cwd: "D:\\repo" };
  const win = collectQueryRecall(winGraph, "src/rooms/query-recall.mjs 看一下");
  t.eq(win.items.length, 1, "Windows 图上相对路径大小写不同也是同一个文件");
  t.eq(win.items[0].score, 100, "同一相对路径 = 完整路径档");

  const posixGraph = graphOf([{ id: "e1", action: relativeEdge, evidence: { start: 3, end: 4 } }]);
  t.eq(collectQueryRecall(posixGraph, "src/rooms/query-recall.mjs 看一下").items.length, 0, "POSIX 图上大小写不同是两个文件（不许误命中）");
};

tests["Q1-21 MINOR：点链符号边界 —— `graph.edges` 不得命中 `x.graph.edges`"] = (t) => {
  const graph = graphOf([
    { id: "e1", action: "bash(command=node -e require('x.graph.edges'))", evidence: { start: 9, end: 9 } },
    { id: "e2", action: "bash(command=cat graph.edges)", evidence: { start: 3, end: 3 } },
  ]);
  const recall = collectQueryRecall(graph, "`graph.edges` 是只读的吗");
  t.eq(recall.anchors.symbols, ["graph.edges"], "锚点识别成一个点链");
  t.eq(recall.items.map((item) => item.id), ["e2"], "x.graph.edges 是另一个点链，不许命中");
  t.eq(recall.items[0].kind, "symbol", "kind 仍是 symbol");
};

tests["Q1-22 MINOR：maxChars 精确记账 —— 恰好「标题+换行+首行」时必须保留该行，少 1 字符才丢"] = (t) => {
  const graph = graphOf([
    { id: "e1", action: "read(file_path=src/a.mjs)", verify: { summary: "ok" }, evidence: { start: 5, end: 5 } },
    { id: "e2", action: "read(file_path=src/a.mjs)", verify: { summary: "ok" }, evidence: { start: 4, end: 4 } },
  ]);
  const wide = renderQueryRecall(graph, "src/a.mjs");
  const firstLine = wide.text.split("\n")[1];
  const exact = QUERY_RECALL_HEADER.length + 1 + firstLine.length;
  const fit = renderQueryRecall(graph, "src/a.mjs", { maxChars: exact });
  t.eq(fit.text, `${QUERY_RECALL_HEADER}\n${firstLine}`, "恰好到上限的那一行必须保留（旧实现多算 1 字符会误丢）");
  t.eq(fit.text.length, exact, "记账必须与 text.length 逐字一致");
  t.eq(fit.items.length, 1, "只为放下的行保留 item");
  t.eq(fit.stats.truncated, true, "后面还有行没放下 ⇒ truncated");
  const short = renderQueryRecall(graph, "src/a.mjs", { maxChars: exact - 1 });
  t.eq(short.text, "", "少 1 字符连首行都放不下 ⇒ 空串");
  t.eq(short.items.length, 0, "对应 item 也不留");
  t.eq(short.stats.truncated, true, "有内容但放不下 ⇒ truncated");
};

tests["Q1-23 M-3 top-K 选择器：与全量排序参考一致（档位 > seqEnd 新到旧 > id 字典序）"] = (t) => {
  const graph = graphOf([
    // 100 档：完整路径
    { id: "f1", action: "read(file_path=D:/fixture/repo/src/a.mjs)", evidence: { start: 3, end: 3 } },
    // 80 档：仓库相对后缀（同 seqEnd 用 id 字典序：e10 在 e2 前面）
    { id: "e10", action: "read(file_path=src/a.mjs)", evidence: { start: 20, end: 20 } },
    { id: "e2", action: "read(file_path=src/a.mjs)", evidence: { start: 20, end: 20 } },
    { id: "s3", action: "read(file_path=src/a.mjs)", evidence: { start: 9, end: 9 } },
    // 40 档：符号
    { id: "m1", action: "bash(command=collectQueryRecall one)", evidence: { start: 30, end: 30 } },
    { id: "m2", action: "bash(command=collectQueryRecall two)", evidence: { start: 30, end: 30 } },
    { id: "m10", action: "bash(command=collectQueryRecall ten)", evidence: { start: 30, end: 30 } },
    { id: "m4", action: "bash(command=collectQueryRecall four)", evidence: { start: 40, end: 40 } },
    { id: "m5", action: "bash(command=collectQueryRecall five)", evidence: { start: 40, end: 40 } },
    // 不命中
    { id: "x1", action: "read(file_path=/other.md)", evidence: { start: 100, end: 100 } },
    { id: "x2", action: "bash(command=ls)", evidence: { start: 99, end: 99 } },
  ]);
  const query = "D:/fixture/repo/src/a.mjs 和 `collectQueryRecall` 怎么了";
  const recall = collectQueryRecall(graph, query, { limit: 5 });
  t.eq(
    recall.items.map((item) => [item.id, item.score, item.seqEnd]),
    [["f1", 100, 3], ["e10", 80, 20], ["e2", 80, 20], ["s3", 80, 9], ["m4", 40, 40]],
    "top-K 的结果必须与全量排序取前 5 完全一致（e10 在 e2 前是 id 字典序，m4 在 m5 前同理）",
  );
  t.eq(recall.stats.matchedEdges, 9, "命中 9 条（全部，含被 top-K 淘汰的）");
  t.eq(recall.stats.kept, 5, "只保留 5 条");
  t.eq(recall.stats.truncated, true, "9 > 5 ⇒ 截过");

  // 大一点的混合集：limit 超过候选数 ⇒ 不截断且全序正确
  const all = collectQueryRecall(graph, query, { limit: 50 });
  t.eq(all.items.map((item) => item.id), ["f1", "e10", "e2", "s3", "m4", "m5", "m1", "m10", "m2"], "全序：100 ⇒ 80(seq 新→旧, id 字典序) ⇒ 40(同前；m1 < m10 < m2 是字典序)");
  t.eq(all.stats.truncated, false, "全部放下 ⇒ 不截断");
};
