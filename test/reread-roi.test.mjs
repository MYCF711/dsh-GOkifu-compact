/**
 * reread-roi.test.mjs —— 「重读率 + ROI」的守卫（T58）
 *
 * 这个指标的死法是**假绿**：率恒为 0、分母虚高、把语义相似当逐字相同 —— 都能让报告「看起来很干净」。
 * 所以这里的用例分三类：
 *   ① **闭集边界**：哪些工具算资产、规范化只做哪三件事、哪些「看起来一样」的**不算**；
 *   ② **数学**：去重 / 只记第一次 / 右删失 / 样本不足 / ROI 三项符号 / 摊销只算实时折叠；
 *   ③ **判据能红**：`judgeCriteria` 喂一份「恒为 0」的分布必须返回 `pass: false`
 *      （判据永远绿的守卫 = 假门禁，T54 的老教训）。
 *
 * 另有一条端到端：临时 home 里造一张图 + 一份多帧 zstd 会话日志，跑 `audit()`。
 * 它守的是**接线**（目录名 `session-<uuid>` 与裸 uuid 两种都要能找到日志）——
 * T56 真机上有 22/42 条重踩因为只按裸 uuid 查而整批记成 `no-log`。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import zlib from "node:zlib";

import {
  ASSET_RULES,
  MIN_CELL,
  assetKey,
  assetsOfCallOrNull,
  assetsOfToolCall,
  audit,
  computeRoi,
  extractFoldAssets,
  findRereads,
  indexSession,
  injectionAfter,
  isModifyTool,
  judgeCriteria,
  markReread,
  modelAt,
  normalizeCommand,
  normalizePath,
  normalizeQuery,
  normalizeUrl,
  renderReport,
  resultTextOf,
  stratify,
  summarize,
} from "../scripts/reread-roi-audit.mjs";
import { GRAPH_VERSION } from "../src/rooms/kifu-model.mjs";

export const tests = {};

/* ───────────────────────────── 夹具 ───────────────────────────── */

const callEv = (seq, name, args, callId = `c${seq}`) => ({
  type: "tool/call",
  seq,
  data: { name, arguments: typeof args === "string" ? args : JSON.stringify(args), callId },
});
const resultEv = (seq, callId, text) => ({
  type: "tool/result",
  seq,
  data: { message: { toolCallId: callId, content: [{ type: "text", text }] } },
});
const stepEv = (seq) => ({ type: "step/start", seq, data: {} });
const injectEv = (seq, kind) => ({ type: "user/message", seq, data: { source: { kind } } });

/** 一条折痕（只填重读率/ROI 要用的字段）。 */
const mark = (over = {}) => ({ at: 1_800_000_000_000, seqStart: 10, seqEnd: 20, trigger: "pressure", ...over });

/** 临时 home（跑完删）。 */
function withTempHome(fn) {
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "reread-roi-"));
  try {
    return fn(dir);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ═════════════════════════ ① 规范化：只做「逐字相同」允许的那三件事 ═════════════════════════ */

tests["① 路径规范化：去 ./ · 统一斜杠 · 转小写（**不 resolve**）"] = (t) => {
  t.eq(normalizePath("./src/a.mjs"), "src/a.mjs", "去 ./ 前缀");
  t.eq(normalizePath(".\\src\\a.mjs"), "src/a.mjs", "反斜杠也统一");
  t.eq(normalizePath("SRC/A.MJS"), "src/a.mjs", "Windows 大小写不敏感");
  t.eq(normalizePath("src//a.mjs"), "src/a.mjs", "重复斜杠压掉");
  t.eq(normalizePath("src/a.mjs/"), "src/a.mjs", "去尾斜杠");
  t.eq(normalizePath("  src/a.mjs  "), "src/a.mjs", "去首尾空白");
  // ★ 关键反例：`..` 不许被解析 —— 那是语义推断，不是逐字相同
  t.eq(normalizePath("src/../a.mjs"), "src/../a.mjs", "`..` 不 resolve（宁可少算）");
  t.eq(normalizePath(""), "", "空串 = 不可指认");
  t.eq(normalizePath(null), "", "null = 不可指认");
};

tests["① 命令/搜索/URL 的规范化：命令压空白，搜索与 URL 只去首尾"] = (t) => {
  t.eq(normalizeCommand("  cd  /x \n&&  git   status "), "cd /x && git status", "连续空白压一个");
  t.eq(normalizeCommand(""), "", "空命令不可指认");
  // 搜索**不压内部空白**：`grep "a b"` 与 `grep "a  b"` 在正则里是不同模式
  t.eq(normalizeQuery(" a  b "), "a  b", "搜索只去首尾，内部空白保留");
  t.eq(normalizeQuery("a b"), "a b", "单空格原样");
  t.ne(normalizeQuery("a b"), normalizeQuery("a  b"), "内部空白不同 ⇒ 不是同一个搜索");
  t.eq(normalizeUrl(" https://x/y "), "https://x/y", "URL 去首尾");
  t.ne(normalizeUrl("https://x/A"), normalizeUrl("https://x/a"), "URL 路径大小写敏感（不转小写）");
  t.ne(normalizeUrl("https://x/a"), normalizeUrl("https://x/a/"), "尾斜杠是两个资源");
};

tests["① 资产键带类型：read('x') 与 bash('x') 不是同一个资产"] = (t) => {
  t.eq(assetKey("file", "./X"), "file:x", "文件键 = 类型:规范化值");
  t.ne(assetKey("file", "x"), assetKey("command", "x"), "类型进键（合并就是语义推断）");
  t.eq(assetKey("file", "  "), null, "不可指认 ⇒ null（不是空串键）");
};

/* ═════════════════════════ ② 闭集：哪些工具算资产 ═════════════════════════ */

tests["② 闭集：只认登记过的工具，闭集外返回 null（不是空数组）"] = (t) => {
  t.eq(
    ASSET_RULES.map((rule) => rule.type),
    ["file", "command", "search", "search", "url"],
    "闭集固定（改闭集要改这个断言）",
  );
  t.eq(assetsOfToolCall(callEv(1, "read", { file_path: "a.mjs" })).length, 1, "read 算文件");
  t.eq(assetsOfToolCall(callEv(1, "edit", { file_path: "a.mjs" })).length, 1, "edit 算文件");
  t.eq(assetsOfToolCall(callEv(1, "write", { file_path: "a.mjs" })).length, 1, "write 算文件");
  t.eq(assetsOfToolCall(callEv(1, "bash", { command: "ls" })).length, 1, "bash 算命令");
  t.eq(assetsOfToolCall(callEv(1, "grep", { pattern: "x" })).length, 1, "grep 算搜索");
  t.eq(assetsOfToolCall(callEv(1, "glob", { pattern: "*.mjs" })).length, 1, "glob 算搜索");
  t.eq(assetsOfToolCall(callEv(1, "web_fetch", { url: "https://a" })).length, 1, "web_fetch 算 URL");
  // ★ 闭集外：`read_image` / `job_output` 也是「又获取了同一个东西」，但**不在闭集里** ——
  //   闭集是刻意窄的（每个类型都要能说清「逐字相同」是什么），宁可少算。
  t.eq(assetsOfToolCall(callEv(1, "read_image", { file_path: "a.png" })), [], "闭集外 ⇒ 空数组");
  t.eq(assetsOfCallOrNull(callEv(1, "read_image", { file_path: "a.png" })), null, "闭集外 ⇒ null（与「抽不出」区分）");
  t.eq(assetsOfCallOrNull(callEv(1, "read", { file_path: "" })), [], "闭集内但不可指认 ⇒ 空数组");
};

tests["② web_search.queries 是数组：每条一个资产，非数组不算"] = (t) => {
  const many = assetsOfToolCall(callEv(1, "web_search", { queries: ["a", "b c"] }));
  t.eq(many.map((item) => item.key), ["search:a", "search:b c"], "逐条抽出");
  t.eq(assetsOfToolCall(callEv(1, "web_search", { queries: "a" })), [], "不是数组 ⇒ 不算（不猜）");
};

tests["② 参数不是 JSON ⇒ 不猜（空数组，不是「没有资产」的 0）"] = (t) => {
  t.eq(assetsOfToolCall({ type: "tool/call", seq: 1, data: { name: "read", arguments: "{不是 JSON" } }), [], "坏 JSON");
  t.eq(assetsOfToolCall({ type: "tool/call", seq: 1, data: { name: "read", arguments: null } }), [], "null 参数");
  t.eq(assetsOfToolCall({ type: "tool/call", seq: 1, data: {} }), [], "没有工具名");
};

/* ═════════════════════════ ③ 去重与重读 ═════════════════════════ */

tests["③ 折叠区间内同一资产读 5 次 = **1 个**可重读机会（去重）"] = (t) => {
  const calls = [
    { seq: 10, callId: "a", assets: [{ type: "file", key: "file:a.mjs", raw: "a.mjs", tool: "read" }] },
    { seq: 11, callId: "b", assets: [{ type: "file", key: "file:a.mjs", raw: "a.mjs", tool: "read" }] },
    { seq: 12, callId: "c", assets: [{ type: "file", key: "file:a.mjs", raw: "a.mjs", tool: "read" }] },
  ];
  const assets = extractFoldAssets(calls, 10, 20);
  t.eq(assets.size, 1, "一个文件只算一个机会");
  t.eq(assets.get("file:a.mjs").seq, 10, "留第一次出现的 seq");
};

tests["③ 折叠后重读 3 次 = **1 次**重读（每个资产只记第一次）"] = (t) => {
  const assets = new Map([["file:a.mjs", { type: "file", key: "file:a.mjs", raw: "a.mjs", tool: "read", seq: 10 }]]);
  const calls = [
    { seq: 30, callId: "x", tool: "read", assets: [{ type: "file", key: "file:a.mjs", raw: "a.mjs", tool: "read" }], argsText: "" },
    { seq: 40, callId: "y", tool: "read", assets: [{ type: "file", key: "file:a.mjs", raw: "a.mjs", tool: "read" }], argsText: "" },
    { seq: 50, callId: "z", tool: "read", assets: [{ type: "file", key: "file:a.mjs", raw: "a.mjs", tool: "read" }], argsText: "" },
  ];
  const hits = findRereads(calls, new Map(), assets, 20);
  t.eq(hits.length, 1, "只记第一次重读");
  t.eq(hits[0].rereadSeq, 30, "记的是第一次的 seq");
  t.eq(hits[0].foldSeq, 10, "带上折叠时的 seq（明细要能画时间线）");
};

tests["③ 折叠**区间内**的重复不算重读（必须 seq > seqEnd）"] = (t) => {
  const assets = new Map([["file:a.mjs", { type: "file", key: "file:a.mjs", raw: "a.mjs", tool: "read", seq: 10 }]]);
  const calls = [{ seq: 15, callId: "x", tool: "read", assets: [{ type: "file", key: "file:a.mjs", raw: "a.mjs", tool: "read" }], argsText: "" }];
  t.eq(findRereads(calls, new Map(), assets, 20), [], "区间内的第二次读不是重读");
  t.eq(findRereads(calls, new Map(), assets, 14).length, 1, "越过右端就算重读（边界含/不含要钉死）");
};

tests["③ 逐字相同才算：同一个文件的两种写法都算，不同文件不算"] = (t) => {
  const assets = new Map([["file:src/a.mjs", { type: "file", key: "file:src/a.mjs", raw: "src/a.mjs", tool: "read", seq: 5 }]]);
  const mk = (seq, raw) => ({
    seq,
    callId: `c${seq}`,
    tool: "read",
    assets: [{ type: "file", key: assetKey("file", raw), raw, tool: "read" }],
    argsText: "",
  });
  t.eq(findRereads([mk(30, "src/a.mjs")], new Map(), assets, 20).length, 1, "逐字相同 ⇒ 重读");
  t.eq(findRereads([mk(30, "./src/a.mjs")], new Map(), assets, 20).length, 1, "去 ./ 后相同 ⇒ 重读");
  t.eq(findRereads([mk(30, "SRC\\A.MJS")], new Map(), assets, 20).length, 1, "斜杠+大小写规范化后相同 ⇒ 重读");
  t.eq(findRereads([mk(30, "src/a.js")], new Map(), assets, 20), [], "换个扩展名不是同一个文件");
  t.eq(findRereads([mk(30, "src/../src/a.mjs")], new Map(), assets, 20), [], "`..` 不 resolve ⇒ 不算（已知少算）");
  t.eq(findRereads([mk(30, "other/a.mjs")], new Map(), assets, 20), [], "不同目录不算");
};

tests["③ 修改型 vs 读取型：edit/write 是改文件，不是「又看了一遍」"] = (t) => {
  t.eq(isModifyTool("edit"), true, "edit 是修改型");
  t.eq(isModifyTool("write"), true, "write 是修改型");
  t.eq(isModifyTool("read"), false, "read 是读取型");
  t.eq(isModifyTool("bash"), false, "其他都不是修改型");
};

tests["③ 结果正文 token：多块拼起来，缺结果记 0 不报错"] = (t) => {
  const ev = { type: "tool/result", seq: 3, data: { message: { content: [{ type: "text", text: "ab" }, { type: "text", text: "cd" }] } } };
  t.eq(resultTextOf(ev), "ab\ncd", "多块用换行拼");
  t.eq(resultTextOf({ type: "tool/result", seq: 3, data: {} }), "", "没有正文 ⇒ 空串");
  t.eq(resultTextOf({ type: "tool/result", seq: 3, data: { content: "raw" } }), "raw", "content 是字符串也认");
};

/* ═════════════════════════ ④ 右删失 / 样本不足 / 分层 ═════════════════════════ */

tests["④ 右删失：折叠后一个事件都没有 ⇒ 不可测，率记 null（**不记 0**）"] = (t) => {
  const calls = [{ seq: 10, callId: "c10", tool: "read", assets: [{ type: "file", key: "file:a.mjs", raw: "a.mjs", tool: "read" }], argsText: "" }];
  const row = markReread(mark(), {
    index: 0,
    session: "s",
    graphMaxSeq: 20,
    calls,
    results: new Map(),
    eventSeqs: [10, 15, 20], // 全部在折叠区间内
    stepSeqs: [],
    injection: [],
    models: [],
  });
  t.eq(row.measurable, false, "没有折后事件 ⇒ 不可测");
  t.eq(row.rate, null, "率记 null —— `Number(null) === 0` 是本仓踩过的坑");
  t.includes(row.why, "右删失", "理由要写出来");
};

tests["④ 折叠后没有可指认资产 ⇒ 不可测（不是 0 个机会的 0%）"] = (t) => {
  const row = markReread(mark(), {
    index: 0,
    session: "s",
    graphMaxSeq: 30,
    calls: [],
    results: new Map(),
    eventSeqs: [10, 20, 30],
    stepSeqs: [30],
    injection: [],
    models: [],
  });
  t.eq(row.measurable, false, "区间内没有工具调用");
  t.eq(row.opportunities, 0, "机会为 0");
  t.eq(row.rate, null, "率不可算");
  t.includes(row.why, "没有可指认资产", "理由要写出来");
};

tests["④ 样本不足：机会 < MIN_CELL 时**不许算率**"] = (t) => {
  const row = (n, rereads) => ({
    measurable: true,
    opportunities: n,
    rereads,
    rereadsPure: rereads,
    rereadsModify: 0,
    byType: { file: n, command: 0, search: 0, url: 0 },
    byTypeRereads: { file: rereads, command: 0, search: 0, url: 0 },
    rate: n === 0 ? null : rereads / n,
  });
  const small = summarize([row(MIN_CELL - 1, 1)]);
  t.eq(small.insufficient, true, "低于门槛要标 insufficient");
  t.eq(small.rate, null, "样本不足 ⇒ 率是 null（不是 0.1）");
  t.eq(small.byType.file.rate, null, "分类型的格子也要守门槛");
  const enough = summarize([row(MIN_CELL, 1)]);
  t.eq(enough.insufficient, false, "刚够门槛就能算");
  t.eq(Number(enough.rate.toFixed(4)), Number((1 / MIN_CELL).toFixed(4)), "率 = 重读/机会");
  t.eq(summarize([]).rate, null, "空集 ⇒ null");
};

tests["④ 分层：热清单 / 摘要 checkpoint 分开数，任一注入单独一列"] = (t) => {
  const injection = [
    { seq: 100, kind: "chess-context" },
    { seq: 200, kind: "compact-checkpoint" },
  ];
  t.eq(injectionAfter(injection, 50), { hot: true, checkpoint: true, any: true }, "两条都在折后 ⇒ 三个都真");
  t.eq(injectionAfter(injection, 150), { hot: false, checkpoint: true, any: true }, "热清单在折**前** ⇒ hot 假");
  t.eq(injectionAfter(injection, 250), { hot: false, checkpoint: false, any: false }, "折后没有 ⇒ 全假");
  t.eq(injectionAfter([{ seq: 300, kind: "user" }], 50), { hot: false, checkpoint: false, any: false }, "非注入来源不算");
  t.eq(injectionAfter(null, 50), { hot: false, checkpoint: false, any: false }, "null 安全");
};

tests["④ 分层：stratify 的 yes/no 两个池加起来 = 全量"] = (t) => {
  const rows = [
    { measurable: true, opportunities: 10, rereads: 1, byType: { file: 10 }, byTypeRereads: { file: 1 }, rate: 0.1, injected: { hot: true } },
    { measurable: true, opportunities: 10, rereads: 0, byType: { file: 10 }, byTypeRereads: { file: 0 }, rate: 0, injected: { hot: false } },
  ];
  const split = stratify(rows, (row) => row.injected.hot === true);
  t.eq(split.yes.opportunities + split.no.opportunities, 20, "两池机会数相加 = 全量");
  t.eq(split.yes.rereads + split.no.rereads, 1, "两池重读数相加 = 全量");
  t.eq(split.yes.rate, 0.1, "热清单池的率");
  t.eq(split.no.rate, 0, "无注入池的率");
};

tests["④ 模型时刻：取 seq 之前最近的一条 request/context"] = (t) => {
  const models = [
    { seq: 10, model: "deepseek-flash" },
    { seq: 100, model: "deepseek-v4-pro" },
  ];
  t.eq(modelAt(models, 10), "deepseek-flash", "正好命中");
  t.eq(modelAt(models, 50), "deepseek-flash", "取前面最近的一条");
  t.eq(modelAt(models, 500), "deepseek-v4-pro", "最后一条");
  t.eq(modelAt([], 5), null, "没有 ⇒ null（回落 flash 价）");
  t.eq(modelAt(models, 5), null, "比第一条还早 ⇒ null");
};

/* ═════════════════════════ ⑤ ROI 符号 ═════════════════════════ */

tests["⑤ ROI 三项：省下 − 花费 − 白付，**必须能算出负数**"] = (t) => {
  const base = {
    measurable: true,
    live: true,
    opportunities: 10,
    rereads: 1,
    byType: { file: 10 },
    byTypeRereads: { file: 1 },
    rate: 0.1,
    detail: [],
    requestsAfter: 100,
    savedTokens: 100_000,
    savedUsd: 0.015, // 100,000 × $0.15/M
    spendUsd: 0.008,
    wasteTokens: 1_000,
    wasteUsd: 0.00015,
    netUsd: 0.015 - 0.008 - 0.00015,
    amortizedSavedUsd: 0.015 * 100,
    amortizedNetUsd: 0.015 * 100 - 0.008 - 0.00015,
    breakEvenRequests: (0.008 + 0.00015) / 0.015,
    requestWasteTokens: 0,
    requestNetUsd: 0,
  };
  const roi = computeRoi([base]);
  t.eq(Number(roi.netUsd.toFixed(6)), Number((0.015 - 0.008 - 0.00015).toFixed(6)), "单次净值 = 省下 − 花费 − 白付");
  t.eq(roi.marksPositive, 1, "正数要被数出来");
  t.eq(roi.marksNegative, 0, "没有负数就不数");
  t.eq(Number(roi.amortizedNetUsd.toFixed(4)), Number((1.5 - 0.00815).toFixed(4)), "摊销净值 = 省下×请求数 − 花费 − 白付");

  // ★ 负例：白付 + 花费 > 省下（硬话：要能算负的）
  const bad = computeRoi([{ ...base, savedTokens: 100, savedUsd: 0.000015, spendUsd: 0.01, wasteUsd: 0.02, netUsd: 0.000015 - 0.03, amortizedNetUsd: -0.01 }]);
  t.eq(bad.netUsd < 0, true, "亏的时候是负数（不是 0、不是绝对值）");
  t.eq(bad.marksNegative, 1, "负数要被数出来");
  t.eq(bad.marksPositive, 0, "这时没有正数");
};

tests["⑤ 摊销只算实时折叠：archive-offline 的折后请求数必须是 0"] = (t) => {
  const calls = [{ seq: 10, callId: "c10", tool: "read", assets: [{ type: "file", key: "file:a.mjs", raw: "a.mjs", tool: "read" }], argsText: "" }];
  const ctx = {
    index: 0,
    session: "s",
    graphMaxSeq: 500,
    calls,
    results: new Map(),
    eventSeqs: [10, 20, 30, 40],
    stepSeqs: [30, 40, 500], // 折后还有 3 次请求
    injection: [],
    models: [],
  };
  const live = markReread(mark({ trigger: "pressure", shadowedTokens: 100_000, usage: { inputTokens: 1000, outputTokens: 100 }, totalAfter: 5000 }), ctx);
  const archive = markReread(mark({ trigger: "archive-offline", shadowedTokens: 100_000, usage: { inputTokens: 1000, outputTokens: 100 }, totalAfter: 5000 }), ctx);
  t.eq(live.requestsAfter, 3, "实时折叠：折后 3 次请求");
  t.eq(archive.requestsAfter, 0, "归档补折：会话已结束，摊销记 0（否则净值虚增一个数量级）");
  t.eq(archive.live, false, "archive-offline 不是实时折叠");
  t.eq(archive.amortizedSavedUsd, 0, "摊销省下 = 0");
  t.eq(live.amortizedSavedUsd > 0, true, "实时折叠的摊销省下 > 0");
};

tests["⑤ shadowedTokens / usage 缺失 ⇒ 记 null，**不记 0**"] = (t) => {
  const row = markReread(mark({ shadowedTokens: null, usage: null }), {
    index: 0,
    session: "s",
    graphMaxSeq: 100,
    calls: [{ seq: 10, callId: "c10", tool: "read", assets: [{ type: "file", key: "file:a.mjs", raw: "a.mjs", tool: "read" }], argsText: "" }],
    results: new Map(),
    eventSeqs: [10, 50],
    stepSeqs: [50],
    injection: [],
    models: [],
  });
  t.eq(row.savedTokens, null, "省下未知 ⇒ null");
  t.eq(row.savedUsd, null, "省下美元未知 ⇒ null");
  t.eq(row.spendUsd, null, "没有 usage ⇒ 花费 null（页面显示 —，不许编 0）");
  t.eq(row.netUsd, null, "三项缺一 ⇒ 净值不可算");
  const roi = computeRoi([row]);
  t.eq(roi.marksWithSaved, 0, "缺失不进合计");
  t.eq(roi.savedUsd, 0, "合计是 0（不是把缺失当 0 加进去）");
  t.eq(roi.completeMarks, 0, "三条都齐的折痕数为 0（同集合口径不能靠缺失凑数）");
  t.eq(roi.netUsd, 0, "没有可算的折痕 ⇒ 同集合净值为 0");
  t.eq(roi.marksWithSpend, 0, "没有 usage ⇒ 有花费的折痕数也是 0（缺测不是 0 美元）");
};

/* ═════════════════════════ ⑥ 四条判据必须能红 ═════════════════════════ */

tests["⑥ 判据①能红：重读率恒为 0 ⇒ 无方差 ⇒ pass === false"] = (t) => {
  const constant = {
    overall: { insufficient: false, n: 50, opportunities: 500, modalValue: 0, modalShare: 1, rate: 0 },
    correlations: { tailGap: { n: 50, spearman: 0.05 }, span: { n: 50, spearman: 0.05 } },
    poolsBySummaryAvailability: null,
  };
  const criteria = judgeCriteria(constant);
  t.eq(criteria[0].pass, false, "众数占比 100% ⇒ 判据①必须红（否则就是假门禁）");
  t.eq(criteria[0].degenerate, false, "样本够时不算退化");

  const varied = { ...constant, overall: { ...constant.overall, modalShare: 0.5, modalValue: 0.02 } };
  t.eq(judgeCriteria(varied)[0].pass, true, "半个众数 ⇒ 有方差");
};

tests["⑥ 判据②能红：与形状强相关（|ρ| ≥ 0.2）⇒ 不过"] = (t) => {
  const result = {
    overall: { insufficient: false, n: 50, opportunities: 500, modalValue: 0, modalShare: 0.5 },
    correlations: { tailGap: { n: 50, spearman: 0.9 }, span: { n: 50, spearman: 0.05 } },
    poolsBySummaryAvailability: null,
  };
  const criteria = judgeCriteria(result);
  t.eq(criteria[1].pass, false, "离尾部 ρ=0.9 ⇒ 判据②红");
  t.eq(Number(criteria[1].value.toFixed(2)), 0.9, "取两个 |ρ| 的最大值");
};

tests["⑥ 判据③能红：与已有指标 ρ ≥ 0.8 ⇒ 不过（换个名字不产生新信息）"] = (t) => {
  const result = {
    overall: { insufficient: false, n: 50, opportunities: 500, modalValue: 0, modalShare: 0.5 },
    correlations: {
      tailGap: { n: 50, spearman: 0.05 },
      span: { n: 50, spearman: 0.05 },
      traceableShare: { n: 50, spearman: 0.95 },
      qualityTotal: { n: 50, spearman: 0.1 },
    },
    poolsBySummaryAvailability: null,
  };
  t.eq(judgeCriteria(result)[2].pass, false, "ρ(可定位率)=0.95 ⇒ 判据③红");
};

tests["⑥ 判据不可判时是 null（不是 true）：样本不足 / 缺对照量"] = (t) => {
  const empty = judgeCriteria({ overall: { insufficient: true, n: 0 }, correlations: {}, poolsBySummaryAvailability: null });
  t.eq(empty[0].pass, null, "样本不足 ⇒ ①不可判");
  t.eq(empty[0].degenerate, true, "要标退化");
  t.eq(empty[1].pass, null, "没有 ρ ⇒ ②不可判");
  t.eq(empty[2].pass, null, "没有对照 ⇒ ③不可判");
  t.eq(empty[3].pass, true, "④ 是设计保证，恒真");
  t.eq(judgeCriteria({})[3].pass, true, "④ 不依赖数据");
};

/* ═════════════════════════ ⑦ 端到端：audit() 的接线 ═════════════════════════ */

tests["⑦ 端到端：临时 home 造图+日志，audit() 能算出 1 次重读"] = (t) => {
  withTempHome((home) => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    const graphDir = nodePath.join(home, "chess-context", "sessions", `session-${uuid}`);
    nodeFs.mkdirSync(graphDir, { recursive: true });
    const graph = {
      version: GRAPH_VERSION,
      sessionId: `session-${uuid}`,
      cwd: "/tmp",
      createdAt: 1,
      updatedAt: 2,
      nextNode: 3,
      nextEdge: 1,
      nodes: {
        n2: { id: "n2", kind: "agent", seq: 2, turn: 1, ts: 1, text: "读了 a.mjs", goal: "", worldHash: "w", constraintHash: "c", via: "" },
        n5: { id: "n5", kind: "agent", seq: 5, turn: 1, ts: 2, text: "又读了一遍", goal: "", worldHash: "w", constraintHash: "c", via: "" },
      },
      edges: {},
      order: ["n2", "n5"],
      stateIndex: {},
      rootUserNodeIds: [],
      checkpointSeq: 3,
      foldCount: 1,
      lastFoldTotalTokens: 5000,
      foldMarks: [
        {
          at: 1_800_000_000_000,
          seqStart: 2,
          seqEnd: 3,
          trigger: "pressure",
          shadowedTokens: 100_000,
          totalAfter: 5000,
          route: { provider: "magpie", model: "deepseek-flash" },
          usage: { inputTokens: 100_000, outputTokens: 2_000, totalTokens: 102_000, cacheReadTokens: 0 },
        },
      ],
    };
    nodeFs.writeFileSync(nodePath.join(graphDir, "graph.json"), JSON.stringify(graph), "utf8");

    // 会话日志：放在**另一个**目录树里，文件名是裸 uuid ⇒ 守「session- 前缀回落」这条
    const logDir = nodePath.join(home, "sessions", "--ws--");
    nodeFs.mkdirSync(logDir, { recursive: true });
    const events = [
      { type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "hi" }] } },
      callEv(2, "read", { file_path: "a.mjs" }, "c2"),
      resultEv(3, "c2", "export const a = 1;"),
      { type: "step/start", seq: 4, data: {} },
      callEv(5, "read", { file_path: "./A.MJS" }, "c5"), // 规范化后同一个资产
      resultEv(6, "c5", "export const a = 1;"),
      { type: "step/start", seq: 7, data: {} },
    ];
    nodeFs.writeFileSync(nodePath.join(logDir, `${uuid}.zstd`), zlib.zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n")), "utf8");

    const result = audit({ home, limit: 10 });
    t.eq(result.graphs, 1, "找到 1 张图");
    t.eq(result.epoch.logsRead, 1, "日志按裸 uuid 也能找到（session- 前缀回落）");
    t.eq(result.marks, 1, "1 条折痕");
    t.eq(result.overall.opportunities, 1, "1 个可重读机会");
    t.eq(result.overall.rereads, 1, "1 次重读（./A.MJS 规范化后 = a.mjs）");
    t.eq(result.overall.rereads / result.overall.opportunities, 1, "原始比 = 1/1");
    t.eq(result.overall.insufficient, true, "机会 1 < 10 ⇒ 样本不足");
    t.eq(result.overall.rate, null, "样本不足时率是 null（不是 1）");
    t.eq(result.roi.marksWithSaved, 1, "shadowedTokens 记到了");
    t.eq(result.verdict, "usable", "判据全过 ⇒ usable");
    const report = renderReport(result);
    t.includes(report, "重读率 + ROI 审计", "报告有标题");
    t.includes(report, "资产抽取规则", "报告有 ① 抽取规则");
    t.includes(report, "样本不足", "样本不足要写出来，不许硬算率");
  });
};

tests["⑦ home 给错 ⇒ graphs = 0（CLI 用退出码 2 报，不装作跑完）"] = (t) => {
  withTempHome((home) => {
    const result = audit({ home });
    t.eq(result.graphs, 0, "空 home 一张图都没有");
    t.eq(result.marks, 0, "也没有折痕");
  });
};

tests["⑦ indexSession：闭集内/外、可指认/不可指认分开数"] = (t) => {
  const index = indexSession([
    callEv(1, "read", { file_path: "a.mjs" }),
    resultEv(2, "c1", "x"),
    callEv(3, "read_image", { file_path: "a.png" }),
    callEv(4, "read", {}),
    callEv(5, "bash", { command: "  ls   -la " }),
    injectEv(6, "chess-context"),
    { type: "request/context", seq: 7, data: { model: "deepseek-v4-pro" } },
    stepEv(8),
  ]);
  t.eq(index.toolCalls, 4, "4 次工具调用");
  t.eq(index.closedCalls, 3, "闭集内 3 次（read×2 + bash）");
  t.eq(index.outsideCalls, 1, "闭集外 1 次（read_image）");
  t.eq(index.outsideTools.read_image, 1, "闭集外工具要能点名");
  t.eq(index.unidentifiableCalls, 1, "read({}) 参数不可指认");
  t.eq(index.calls.length, 2, "只有 2 次能进重读检测（a.mjs / ls -la）");
  t.eq(index.calls[1].assets[0].key, "command:ls -la", "命令压空白后成键");
  t.eq(index.results.get("c1"), "x", "结果按 callId 索引");
  t.eq(index.injection.length, 1, "注入事件被记下");
  t.eq(index.stepSeqs.length, 1, "step 序列被记下（摊销的请求数靠它）");
  t.eq(modelAt(index.models, 7), "deepseek-v4-pro", "模型时刻");
};
