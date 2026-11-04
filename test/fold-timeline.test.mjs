/**
 * fold-timeline.test.mjs —— 「最近 N 次折叠的时间线」必须真的看得见（2026-11-05，C599 同批）
 *
 * 由来：今天连续三个「静默停摆」类 bug（补账不跑 / 假成功 / 探测器恒假），共同点是
 * **出问题时磁盘上看不出来**。`foldMarks` 里其实样样都有，但此前只能 `node -e` 逐图 parse。
 * 这个脚本把「折叠到底发生没发生、什么时候、折了哪一段、花了多少钱」变成一行。
 *
 * 钉住四件事：
 *   ① 列序与排序（最近的在前、会话取 8 位、reasoning / cached 两列必须在）；
 *   ② **空数据给人话**（不许打一张空表，也不许把"没折过"说成健康）；
 *   ③ 数据源必须重放 delta（C143：最近的折叠往往只在 delta 层，只读 graph.json 会漏）；
 *   ④ 参数写错要报错（静默回落会让 `--hours=7d` 打出一份"24 小时"的表）。
 */

import { spawnSync } from "node:child_process";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { collectFolds, formatRow, parseArgs, readUsage, resolveHome, shortSessionId } from "../scripts/fold-timeline.mjs";
import { createGraph, encodeDeltaFrame, sha, toJSON } from "./graph-fixtures.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const SCRIPT = nodePath.join(REPO, "scripts", "fold-timeline.mjs");

export const tests = {};

/** 造一个假 home，返回 {root, sessionsDir}。 */
function makeHome() {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-timeline-"));
  const sessionsDir = nodePath.join(root, "chess-context", "sessions");
  nodeFs.mkdirSync(sessionsDir, { recursive: true });
  return { root, sessionsDir };
}

/** 一个带 foldMarks 的会话图（不写盘）。 */
function graphWith(sessionId, marks) {
  const g = createGraph({ sessionId });
  g.foldMarks = marks;
  return g;
}

/** 写一个会话目录。 */
function writeSession(sessionsDir, dirName, graph) {
  const dir = nodePath.join(sessionsDir, dirName);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), toJSON(graph), "utf8");
  return dir;
}

/** 跑脚本（临时 home，绝不碰真实 DSH_HOME）。 */
function run(home, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: home },
    encoding: "utf8",
  });
}

const HOUR = 3600 * 1000;
const NOW = Date.now();

tests["C599-1 时间线：最近的在前、8 位会话、seq 区间与 reasoning/cached 两列都在"] = (t) => {
  const { root, sessionsDir } = makeHome();
  try {
    const older = NOW - 2 * HOUR;
    const newer = NOW - 1 * HOUR;
    writeSession(
      sessionsDir,
      "session-aaaa1111-2222-3333-4444-555566667777",
      graphWith("session-aaaa1111-2222-3333-4444-555566667777", [
        { at: older, seqStart: 10, seqEnd: 20, trigger: "pressure", summaryChars: 1200, ms: 4000, usage: { inputTokens: 5000, outputTokens: 500, cacheReadTokens: 4096, reasoningTokens: 128 } },
      ]),
    );
    writeSession(
      sessionsDir,
      "session-bbbb9999-8888-7777-6666-555544443333",
      graphWith("session-bbbb9999-8888-7777-6666-555544443333", [
        { at: newer, seqStart: 100, seqEnd: 250, trigger: "archive-offline", summaryChars: 3300, ms: 190000, usage: { cacheReadTokens: 0, reasoningTokens: 0 } },
      ]),
    );

    const r = run(root, ["--hours=0", "--limit=10"]);
    t.eq(r.status, 0, `应正常退出：${r.stderr}`);
    const lines = String(r.stdout).split(String.fromCharCode(10)).filter((l) => l.trim().startsWith("20"));
    t.eq(lines.length, 2, `应有 2 行折叠记录，实际：${JSON.stringify(lines)}`);
    // 最近的在前
    t.includes(lines[0], "bbbb9999", "第一行必须是更近的会话");
    t.includes(lines[1], "aaaa1111", "第二行必须是更早的会话");
    // 列序：时间 · 会话(8) · 触发 · seq 区间 · 摘要字符数 · 耗时ms · reasoning · cached
    t.eq(lines[0].split(" · ").length, 8, `必须恰好 8 列（时间/会话/触发/区间/字符/耗时/reasoning/cached）：${lines[0]}`);
    t.includes(lines[0], "archive-offline", "要带触发原因");
    t.includes(lines[0], "100→250", "要带 seq 区间（带千分位）");
    t.includes(lines[0], "3,300 字", "要带摘要字符数");
    t.includes(lines[0], "190,000 ms", "要带耗时毫秒");
    t.includes(lines[1], "reasoning 128", "reasoning token 必须读出来");
    t.includes(lines[1], "cached 4,096", "cached token 必须读出来");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["C599-2 空数据：必须给一句人话，不许打空表、也不许说成健康"] = (t) => {
  const { root, sessionsDir } = makeHome();
  try {
    // 目录在、但没有 graph.json
    const r = run(root, []);
    t.eq(r.status, 0, `没有数据不是错误（退出码必须 0）：${r.stderr}`);
    t.includes(r.stdout, "没有折叠记录", "必须给人话");
    t.includes(r.stdout, "全库一条 foldMark 都没有", "要说明全库都没有（而不是窗口外的被藏起来）");
    t.eq(/^\s*\S+ · \S+/m.test(r.stdout), false, `不许打出任何数据行：${r.stdout}`);

    // 棋谱目录压根不存在也要一句话（不是崩）
    const missing = run(nodePath.join(root, "nowhere"), []);
    t.eq(missing.status, 0, "目录不存在也要正常退出");
    t.includes(missing.stdout, "没有找到棋谱目录", "要说明目录不存在");

    // --json 的空结果形状
    writeSession(sessionsDir, "session-empty", graphWith("session-empty", []));
    const j = run(root, ["--json"]);
    const payload = JSON.parse(j.stdout);
    t.eq(payload.shown, 0, "shown 必须为 0");
    t.eq(payload.rows, [], "rows 必须是空数组（不是 null）");
    t.eq(payload.sessions, 0, "没有 foldMark 的会话不计入 sessions");
    t.includes(j.stdout, "missingDir", "JSON 必须带 missingDir 字段（调用方要能区分「没图」与「没折过」）");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["C599-3 数据源必须重放 delta：只在 delta 里的折叠也要出现（C143 同族）"] = (t) => {
  const { root, sessionsDir } = makeHome();
  try {
    const baseMark = { at: NOW - 3 * HOUR, seqStart: 1, seqEnd: 40, trigger: "pressure", summaryChars: 900, ms: 3000 };
    const deltaOnlyMark = { at: NOW - 1 * HOUR, seqStart: 41, seqEnd: 90, trigger: "tier2", summaryChars: 2468, ms: null };
    const dir = writeSession(sessionsDir, "session-deltaonly", graphWith("session-deltaonly", [baseMark]));
    // 基线只带老的那条；新的只在 delta 帧里（applyDelta 对 foldMarks 是绝对覆盖）
    const graphText = nodeFs.readFileSync(nodePath.join(dir, "graph.json"), "utf8");
    const frame = encodeDeltaFrame(sha(graphText).slice(0, 16), { v: 1, nodes: {}, edges: {}, scalars: { foldMarks: [baseMark, deltaOnlyMark] } });
    nodeFs.writeFileSync(`${nodePath.join(dir, "graph.json")}.delta.jsonl`, frame, "utf8");

    // 反证：只读基线看不到第二条（这正是 C143 的误报来源）
    const baselineOnly = JSON.parse(graphText).foldMarks.length;
    t.eq(baselineOnly, 1, "基线里确实只有 1 条（否则这条用例证明不了什么）");

    const r = run(root, ["--hours=0"]);
    t.eq(r.status, 0, `应正常退出：${r.stderr}`);
    t.includes(r.stdout, "41→90", "delta 里那条折叠必须出现在时间线上");
    t.includes(r.stdout, "2,468 字", "字段必须来自 delta 帧");
    // ★ 这条是踩出来的：`Number(null) === 0` ⇒ 没记 ms 的折叠会被印成「0 ms」（假数据）
    t.includes(r.stdout, "· — · reasoning", "没有 ms 的记录必须印「—」，不许印「0 ms」");
    const j = JSON.parse(run(root, ["--hours=0", "--json"]).stdout);
    t.eq(j.shown, 2, `重放后应有 2 条，实际 ${j.shown}`);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["C599-4 --hours 是窗口、--limit 是条数：老记录被排除，截断要明说"] = (t) => {
  const { root, sessionsDir } = makeHome();
  try {
    const marks = [
      { at: NOW - 100 * HOUR, seqStart: 1, seqEnd: 2, trigger: "pressure" },
      { at: NOW - 1 * HOUR, seqStart: 3, seqEnd: 4, trigger: "pressure" },
      { at: NOW - 2 * HOUR, seqStart: 5, seqEnd: 6, trigger: "pressure" },
    ];
    writeSession(sessionsDir, "session-window", graphWith("session-window", marks));

    const j24 = JSON.parse(run(root, ["--hours=24", "--json"]).stdout);
    t.eq(j24.rows.length, 2, `24 小时窗口内应有 2 条，实际 ${j24.rows.length}`);
    t.eq(j24.total, 3, "全库总数仍必须是 3（窗口不改变总数）");

    const jAll = JSON.parse(run(root, ["--hours=0", "--json"]).stdout);
    t.eq(jAll.rows.length, 3, "--hours=0 必须不限时间");

    const jLimit = JSON.parse(run(root, ["--hours=0", "--limit=1", "--json"]).stdout);
    t.eq(jLimit.rows.length, 1, "--limit 必须生效");
    t.eq(jLimit.rows[0].seqStart, 3, "截断必须保留最近的一条");
    t.includes(run(root, ["--hours=0", "--limit=1"]).stdout, "只显示最近 1 条", "截断必须在人读输出里明说");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["C599-5 参数写错必须报错（静默回落会让人看错窗口）"] = (t) => {
  const { root } = makeHome();
  try {
    const bad = run(root, ["--hours=7d"]);
    t.eq(bad.status, 2, `非法 --hours 必须 exit 2：${JSON.stringify(bad.stdout)}`);
    t.includes(bad.stderr, "非负整数", "要说明期望的形状");
    const zeroLimit = run(root, ["--limit=0"]);
    t.eq(zeroLimit.status, 2, "--limit=0 也必须报错（否则会打出一张空表）");
    const unknown = run(root, ["--since=昨天"]);
    t.eq(unknown.status, 2, "未知参数必须报错");
    t.includes(unknown.stderr, "未知参数", "要指出哪个参数不认识");
    // 纯函数层：合法参数原样保留
    t.eq(parseArgs(["--hours=72", "--limit=5", "--json"]), { hours: 72, limit: 5, asJson: true, error: null }, "合法参数不许被改写");
    t.eq(parseArgs([]).hours, 24, "默认窗口 24 小时");
    t.eq(parseArgs([]).limit, 30, "默认最多 30 条");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["C599-6 纯函数判据：usage 两种形状都要认（C587 的教训：只认一种 = 假「—」）"] = (t) => {
  t.eq(readUsage({ cacheReadTokens: 10, reasoningTokens: 20, inputTokens: 1, outputTokens: 2 }), { input: 1, output: 2, reasoning: 20, cached: 10 }, "新写法");
  t.eq(
    readUsage({ prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 7 } }),
    { input: 100, output: 30, reasoning: 7, cached: 64 },
    "provider 原始写法（离线补账落的就是这个形状）",
  );
  t.eq(readUsage({ cached: 5, reasoning: 6, input: 7, output: 8 }), { input: 7, output: 8, reasoning: 6, cached: 5 }, "归一后的写法");
  t.eq(readUsage(null), { input: null, output: null, reasoning: null, cached: null }, "没有 usage ⇒ 全 null（打 —，不编 0）");
  // 行渲染：缺字段必须是 —，不许印 0
  t.includes(
    formatRow({ at: null, sessionShort: "abc12345", trigger: "(未记)", seqStart: null, seqEnd: null, summaryChars: null, ms: null, reasoningTokens: null, cacheReadTokens: null }),
    "— · — · — · reasoning — · cached —",
    "空字段必须是破折号",
  );
  t.eq(shortSessionId("session-deadbeef-0000"), "deadbeef", "会话取 8 位（去掉 session- 前缀）");
  t.eq(resolveHome({ DSH_HOME: "  D:/x  " }), "D:/x", "DSH_HOME 必须 trim（尾部空格会拼出不存在的路径）");
  t.eq(collectFolds, collectFolds, "collectFolds 必须是可独立调用的纯函数（供 doctor/测试复用）");
};
