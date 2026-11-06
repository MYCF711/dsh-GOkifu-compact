/**
 * fictitious-gap.test.mjs —— uncoveredHead/Tail 只数真正可折的事件（T64）。
 *
 * 生产取消息的唯一判据是 collectMessages：
 *   · user/message / assistant/message：正文经 plainText(reasoning=conclude, hostRole=strip) 后非空；
 *   · tool/call：toolDigestLine 能生成非空行；
 *   · tool/result、system/message、session、sandbox/mode、turn/start、step/start 等一律不进。
 * 本文件直接跑 runOfflineFold（假模型、不联网、不写图），不改 coverageOf 的死值。
 */
import { collectMessages, runOfflineFold } from "../src/rooms/offline-fold.mjs";
import { findSessionLog, readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { resolveHome } from "../scripts/summary-usability-audit.mjs";

export const tests = {};

const text = (seq, type = "user/message", body = "x") => ({
  type,
  seq,
  data: { message: { content: [{ type: "text", text: body }] } },
});
const noise = (seq, type = "step/start") => ({ type, seq, data: {} });
const graph = { sessionId: "fictitious-gap-fixture", nodes: {}, edges: {}, foldMarks: [] };
const fakeModel = async () => ({
  text: `## 目标\n- 假模型重放\n\n## 已验证事实\n- ${"只用于让编排走完，不访问模型。".repeat(30)}`,
  usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
  model: "fake",
  finish: "stop",
});
const run = (events, options = {}) =>
  runOfflineFold({
    graph,
    events,
    rangeStart: 1,
    rangeEnd: 10,
    callModel: fakeModel,
    measureQuality: () => null,
    ...options,
  });

tests["T64 ① 头部 8 个非消息事件：uncoveredHead 8 → 0"] = async (t) => {
  const events = [
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
  const eligible = collectMessages(events, { maxChars: Number.MAX_SAFE_INTEGER }).messages;
  t.eq(eligible.map((m) => m.seq), [9, 10], "前提：collectMessages 只认 seq 9/10，tool/result 不算");
  const out = await run(events, { rangeEnd: 8, fromHead: true });
  t.eq(out.coveredStart, 9, "真机形状：第一条可折消息在 seq 9");
  t.eq(out.coveredStart - 1, 8, "旧实现按原始 seq 差会记 8（失败分支必须能红）");
  t.eq(out.uncoveredHead, 0, "1–8 没有可折事件 ⇒ 新实现没有头部缺口");
  t.eq(out.uncoveredTail, 0, "区间 1–8 里也没有尾部可折事件");
};

tests["T64 ② 混合头部 3 条消息 + 5 个非消息：uncoveredHead = 3"] = async (t) => {
  const events = [
    text(1, "user/message"),
    noise(2, "session"),
    text(3, "assistant/message"),
    noise(4, "sandbox/mode"),
    text(5, "user/message"),
    noise(6, "turn/start"),
    noise(7, "step/start"),
    text(8, "tool/result", "这段工具结果永远不算可折事件"),
    text(9, "user/message"),
    text(10, "assistant/message"),
  ];
  // 每条正文都是 1 字符；预算 2 只留下 seq 9/10，前三条真实消息就是尚未覆盖的真缺口。
  const out = await run(events, { maxChars: 2 });
  t.eq(out.chunks[0]?.messages, 2, "前提：生产字符预算只装下 seq 9/10");
  t.eq(out.coveredStart, 9, "覆盖从 seq 9 开始");
  t.eq(out.coveredStart - 1, 8, "旧实现把 3 条消息 + 5 个非消息一起记成 8");
  t.eq(out.uncoveredHead, 3, "新实现只数 seq 1/3/5 三条真消息，真缺口不会被跳过");
  t.eq(out.uncoveredTail, 0, "尾部两条消息都已覆盖");
};

tests["T64 ③ 真机复放 010c3b44：欠账区间 [1,8] 的缺口 8 → 0"] = async (t) => {
  const home = resolveHome();
  const log = findSessionLog(home, "010c3b44");
  if (log === null) throw new Error(`真机复放找不到 010c3b44 日志（home=${home}）`);
  const events = readSessionEvents(log);
  const leading = events.filter((e) => Number(e.seq) >= 1 && Number(e.seq) <= 8);
  t.eq(leading.length, 8, "真机 seq 1–8 共 8 个事件");
  t.eq(collectMessages(leading, { maxChars: Number.MAX_SAFE_INTEGER }).messages.length, 0, "真机 seq 1–8 零条可折消息");
  const out = await run(events, { rangeEnd: 8, fromHead: true });
  t.eq(out.coveredStart, 9, "真机第一条可折消息在 seq 9");
  t.eq(out.coveredStart - 1, 8, "旧聚合点确实得到 uncoveredHead = 8");
  t.eq(out.uncoveredHead, 0, "修复后同一份真机事件得到 uncoveredHead = 0");
  t.eq(out.uncoveredTail, 0, "修复后同一份真机事件得到 uncoveredTail = 0");
};
