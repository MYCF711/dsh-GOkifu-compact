/**
 * archive-fold.test.mjs —— 离线归档压缩的纯函数（C490）
 *
 * 由来（用户原话）：「需要的不是会话自己去压，而是归档的日志需要去调用默认模型压缩一次，
 * 这样就不用依赖对话模型」。
 */
import { collectMessages, renderFacts, buildOfflinePrompt } from "../scripts/archive-fold.mjs";

export const tests = {};

const u = (text) => ({ type: "user/message", data: { message: { content: [{ type: "text", text }] } } });
const a = (text) => ({ type: "assistant/message", data: { message: { content: [{ type: "text", text }] } } });
const tr = (text) => ({ type: "tool/result", data: { message: { content: [{ type: "text", text }] } } });

tests["C490 只挑 user/assistant 文本，工具结果不进摘要请求（真机上它占 44.9%）"] = (t) => {
  const r = collectMessages([u("目标 A"), tr("x".repeat(10000)), a("做法 B")]);
  t.eq(r.messages.length, 2, "两条文本消息");
  t.eq(r.messages[0].role, "user", "第一条是 user");
  t.eq(r.messages[1].role, "assistant", "第二条是 assistant");
  t.eq(r.chars, "目标 A".length + "做法 B".length, "字符数不含工具结果");
};

tests["C490 预算从**最近**往前取（早期内容已经在既有棋谱里）"] = (t) => {
  const events = [u("一".repeat(100)), a("二".repeat(100)), u("三".repeat(100))];
  const r = collectMessages(events, { maxChars: 150 });
  t.eq(r.messages.length, 1, "只放得下最近一条");
  t.includes(r.messages[0].text, "三", "放进来的是**最近**那条");
  t.eq(r.dropped, 2, "丢掉的是更早的两条");
};

tests["C490 事实块必须带目标/约束/死路/坐标（这几样不许压没）"] = (t) => {
  const graph = {
    rootUserNodeIds: ["n1"],
    nodes: {
      n1: { id: "n1", seq: 1, kind: "user", text: "把构建跑通", constraints: ["不许动 prod 配置"] },
    },
    edges: {
      e1: { id: "e1", intent: "改 prod 配置", action: "edit(prod.yml)", result: "failure", errorSnippet: "EACCES: permission denied", evidence: { start: 2, end: 3 } },
      e2: { id: "e2", action: "bash(npm test)", result: "success", verify: { summary: "12 passed" } },
    },
  };
  const facts = renderFacts(graph, { start: 1, end: 99 });
  for (const needle of ["把构建跑通", "不许动 prod 配置", "e1", "EACCES", "e2", "12 passed", "seq 1-99"]) {
    t.includes(facts, needle, `事实块缺 ${needle}`);
  }
};

tests["C490 prompt 要明说：这是归档会话、只输出摘要、不许给行动建议"] = (t) => {
  const prompt = buildOfflinePrompt({ facts: "## 目标\n- x", messages: [{ role: "user", text: "做件事" }] });
  t.includes(prompt, "归档", "要说清这是归档会话（否则模型会以为还在对话）");
  t.includes(prompt, "不要写「下一步该做什么」", "禁止行动建议（压缩的职责边界）");
  t.includes(prompt, "做件事", "消息要带进去");
  t.includes(prompt, "n123", "要求只能引用出现过的实体");
};

tests["C491 覆盖区间要算清前后两段（只压了尾部，就别宣称压了全部）"] = async (t) => {
  const m = await import("../scripts/archive-fold.mjs");
  const c = m.coverageOf({ rangeStart: 100, rangeEnd: 500, seqs: [480, 490, 500] });
  t.eq(c.start, 480, "起点是第一条被压的 seq");
  t.eq(c.end, 500, "终点是最后一条");
  t.eq(c.uncoveredHead, 380, "前段 100–479 没压到");
  t.eq(c.uncoveredTail, 0, "尾部压到了");
  // 全范围
  const all = m.coverageOf({ rangeStart: 100, rangeEnd: 500, seqs: [100, 300, 500] });
  t.eq(all.uncoveredHead + all.uncoveredTail, 0, "全覆盖 ⇒ 没有缺口");
  // 没有 seq（日志里没有文本消息）⇒ 覆盖 0 宽，两头都算缺
  const none = m.coverageOf({ rangeStart: 100, rangeEnd: 500, seqs: [] });
  t.eq(none.start, 100, "起点退回归一化");
  t.eq(none.uncoveredHead, 0, "等于起点时不算缺");
  t.eq(none.uncoveredTail, 400, "整段都没覆盖");
  // 越界的 seq 必须被夹住
  const clamp = m.coverageOf({ rangeStart: 100, rangeEnd: 200, seqs: [50, 999] });
  t.eq(clamp.start, 100, "起点夹到 rangeStart");
  t.eq(clamp.end, 200, "终点夹到 rangeEnd");
};
