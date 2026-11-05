/**
 * archive-fold-gap.test.mjs —— 手工 archive-fold 与自动 runOfflineFold 的缺口必须同源（T64 遗留）。
 * 手工路径跑到模型调用前的干跑分支；自动路径用假模型。两条路径都不联网、不写生产图。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import nodeZlib from "node:zlib";
import { main as archiveMain } from "../scripts/archive-fold.mjs";
import { runOfflineFold } from "../src/rooms/offline-fold.mjs";

export const tests = {};

const SID = "archive-fold-gap-fixture";
const text = (seq, type = "user/message", body = "x") => ({
  type,
  seq,
  data: { message: { content: [{ type: "text", text: body }] } },
});
const noise = (seq, type = "step/start") => ({ type, seq, data: {} });
const graphFor = (rangeEnd) => ({
  version: 1,
  sessionId: SID,
  rootUserNodeIds: ["n1"],
  nodes: { n1: { id: "n1", kind: "user", seq: rangeEnd, text: "fixture", ts: 1 } },
  edges: {},
  order: ["n1"],
  // 让手工路径与自动路径都走单段、尾部优先；seqEnd=0 使欠账区间仍从 1 开始。
  foldMarks: [{ seqEnd: 0 }],
  updatedAt: 1,
});

const allNonMessageHead = [
  noise(1, "session"),
  noise(2, "sandbox/mode"),
  noise(3, "turn/start"),
  noise(4, "step/start"),
  text(5, "system/message", "宿主系统消息"),
  noise(6, "approval/policy"),
  noise(7, "permission/preset"),
  text(8, "tool/result", "工具结果不进折叠输入"),
  text(9, "user/message", "第一条真实用户消息"),
  text(10, "assistant/message", "第一条真实助手消息"),
];
const mixedHead = [
  text(1),
  noise(2, "session"),
  text(3, "assistant/message"),
  noise(4, "sandbox/mode"),
  text(5),
  noise(6, "turn/start"),
  noise(7, "step/start"),
  text(8, "tool/result"),
  text(9),
  text(10, "assistant/message"),
];

async function manualGap(events, { rangeEnd, maxChars = 60_000 }) {
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "archive-fold-gap-"));
  const originalLog = console.log;
  const lines = [];
  try {
    const graphDir = nodePath.join(home, "chess-context", "sessions", SID);
    nodeFs.mkdirSync(graphDir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(graphDir, "graph.json"), JSON.stringify(graphFor(rangeEnd)));
    const logDir = nodePath.join(home, "sessions", "workspace", `session-${SID}`);
    nodeFs.mkdirSync(logDir, { recursive: true });
    const jsonl = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    nodeFs.writeFileSync(nodePath.join(logDir, "session.v4.jsonl.zstd"), nodeZlib.zstdCompressSync(Buffer.from(jsonl)));
    console.log = (...args) => lines.push(args.join(" "));
    const code = await archiveMain(["--session", SID, "--max-chars", String(maxChars)], { DSH_HOME: home });
    if (code !== 0) throw new Error(`archive-fold 干跑退出码 ${code}\n${lines.join("\n")}`);
  } finally {
    console.log = originalLog;
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
  const line = lines.find((x) => x.includes(" 段 ") && x.includes("欠账区间"));
  const span = line?.match(/段 (\d+)-(\d+)（欠账区间 (\d+)-(\d+)/);
  if (!span) throw new Error(`找不到手工路径的覆盖行：\n${lines.join("\n")}`);
  const [coveredStart, coveredEnd, rangeStart, debtEnd] = span.slice(1).map(Number);
  return {
    uncoveredHead: Number(line.match(/前段 .*?未覆盖（(\d+) 事件）/)?.[1] ?? 0),
    uncoveredTail: Number(line.match(/尾部还剩 (\d+) 事件未覆盖/)?.[1] ?? 0),
    coveredStart,
    legacyCoordinateHead: Math.max(0, coveredStart - rangeStart),
    legacyCoordinateTail: Math.max(0, debtEnd - coveredEnd),
  };
}

async function automaticGap(events, { rangeEnd, maxChars = 60_000 }) {
  return runOfflineFold({
    graph: graphFor(rangeEnd),
    events,
    rangeStart: 1,
    rangeEnd,
    maxChars,
    fromHead: false,
    callModel: async () => ({
      text: `## 目标\n- 假模型重放\n\n## 已验证事实\n- ${"只用于让编排走完，不访问模型。".repeat(30)}`,
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
      model: "fake",
      finish: "stop",
    }),
    measureQuality: () => null,
  });
}

tests["T64 手工① 头部 8 个非消息事件：缺口 0（旧坐标差为 8）"] = async (t) => {
  const manual = await manualGap(allNonMessageHead, { rangeEnd: 8 });
  console.log(`FIXTURE 全非消息头部：manual uncoveredHead=${manual.uncoveredHead}, uncoveredTail=${manual.uncoveredTail}; 旧坐标差=${manual.legacyCoordinateHead}`);
  t.eq(manual.coveredStart, 9, "第一条可折消息在 seq 9");
  t.eq(manual.legacyCoordinateHead, 8, "失败分支前提：旧坐标差确实为 8");
  t.eq(manual.uncoveredHead, 0, "1–8 没有可折事件，手工路径不得虚构缺口");
  t.eq(manual.uncoveredTail, 0, "区间内也没有尾部可折事件");
};

tests["T64 手工② 混合头部 3 条消息 + 5 个非消息：缺口 3"] = async (t) => {
  const manual = await manualGap(mixedHead, { rangeEnd: 10, maxChars: 12 });
  console.log(`FIXTURE 混合头部：manual uncoveredHead=${manual.uncoveredHead}, uncoveredTail=${manual.uncoveredTail}; 旧坐标差=${manual.legacyCoordinateHead}`);
  t.eq(manual.coveredStart, 9, "字符预算只装下 seq 9/10");
  t.eq(manual.legacyCoordinateHead, 8, "失败分支前提：旧实现把 3+5 一起记成 8");
  t.eq(manual.uncoveredHead, 3, "只数 seq 1/3/5 三条可折消息");
  t.eq(manual.uncoveredTail, 0, "尾部两条消息已覆盖");
};

tests["T64 ③ 同一输入：手工与自动两条路径给出同一个数"] = async (t) => {
  for (const [name, events, options, expected] of [
    ["全非消息头部", allNonMessageHead, { rangeEnd: 8 }, 0],
    ["混合头部", mixedHead, { rangeEnd: 10, maxChars: 12 }, 3],
  ]) {
    const manual = await manualGap(events, options);
    const automatic = await automaticGap(events, options);
    console.log(`FIXTURE 双路径一致 ${name}：manual=${manual.uncoveredHead}, automatic=${automatic.uncoveredHead}, expected=${expected}`);
    t.eq(manual.uncoveredHead, expected, `${name}：手工路径缺口`);
    t.eq(automatic.uncoveredHead, expected, `${name}：自动路径缺口`);
    t.eq(
      { head: manual.uncoveredHead, tail: manual.uncoveredTail },
      { head: automatic.uncoveredHead, tail: automatic.uncoveredTail },
      `${name}：两条路径必须同源同数`,
    );
  }
};
