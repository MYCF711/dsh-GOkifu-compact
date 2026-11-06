/**
 * action-cost.test.mjs —— 「哪个动作最费钱」的归因与口径（C451 / K-13）
 *
 * 这份报告的结论会被拿去做取舍（比如"少读整文件"），所以口径必须钉死：
 *   · 一步的开销归因到**上一步**的动作；
 *   · `inputTokens` 只是**未命中缓存**那部分，不能当上下文大小 —— 真机上它会让"增量"乱跳；
 *   · 负增量 = 中间折过，要剔除并单独计数。
 */
import { attributeCosts, byTool, topActions, firstToolCall, median, percentile } from "../scripts/action-cost.mjs";

export const tests = {};

const assistant = (seq, calls, usage) => ({
  type: "assistant/message",
  seq,
  ...(usage === undefined ? {} : { usage }),
  data: {
    message: {
      role: "assistant",
      content: [
        ...(calls ?? []).map((c) => ({ type: "tool-call", id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) })),
      ],
    },
  },
});
const result = (seq, callId, text) => ({ type: "tool/result", seq, data: { message: { role: "tool", toolCallId: callId, content: [{ type: "text", text }] } } });

tests["C451 median/percentile：空数组必须返回 null（返回 0 会被当成'真的很便宜'）"] = (t) => {
  t.eq(median([]), null, "空 ⇒ null");
  t.eq(percentile([], 0.9), null, "空 ⇒ null");
  t.eq(median([3, 1, 2]), 2, "中位数");
  t.eq(median([1, 2, 3, 4]), 2.5, "偶数取中间两个的均值");
  t.eq(percentile([1, 2, 3, 4, 5], 0.9), 5, "p90");
};

tests["C451 firstToolCall：取第一个 tool-call，参数串也能解，并给出同一步的调用数"] = (t) => {
  const m = { content: [{ type: "text", text: "x" }, { type: "tool-call", id: "c1", name: "read", arguments: JSON.stringify({ file_path: "D:/a.md" }) }, { type: "tool-call", id: "c2", name: "bash", arguments: "{}" }] };
  const call = firstToolCall(m);
  t.eq(call?.tool, "read", "工具名");
  t.eq(call?.arg, "D:/a.md", "关键参数");
  t.eq(call?.calls, 2, "同一步有 2 个 tool-call（报告里只说第一个）");
  t.eq(firstToolCall({ content: [{ type: "text", text: "x" }] }), null, "没有 tool-call ⇒ null");
};

tests["C451 attributeCosts：开销归因到上一条动作，增量 = 本次请求上下文 − 上次请求上下文"] = (t) => {
  // 序列：msg1(read) → 结果 → msg2(bash) → 结果 → msg3(edit)
  // 语义：read 的代价体现在 **msg2 的上下文** 里（它的结果被塞回去了）
  const events = [
    assistant(1, [{ id: "c1", name: "read", args: { file_path: "a.md" } }], { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 100 }),
    result(2, "c1", "x".repeat(500)),
    // 真机形态：miss 很小、cacheRead 很大 —— 不能把 inputTokens 当上下文大小
    assistant(3, [{ id: "c2", name: "bash", args: { command: "ls" } }], { inputTokens: 200, cacheReadTokens: 12000, outputTokens: 50 }),
    result(4, "c2", "y"),
    assistant(5, [{ id: "c3", name: "edit", args: { file_path: "b.md" } }], { inputTokens: 300, cacheReadTokens: 13000, outputTokens: 50 }),
  ];
  const { steps, unattributed } = attributeCosts(events);
  t.eq(steps.length, 2, "两条动作被结算（最后一条还没有下一次请求）");
  t.eq(steps[0].tool, "read", "第一条动作是 read");
  t.eq(steps[0].resultChars, 500, "带上工具结果字符数");
  t.eq(steps[0].contextTokens, 12200, "read 的代价 = 下一次请求的上下文（200 + 12,000）");
  t.eq(steps[0].inputDelta, 2200, "增量 = 12200 − 10000（上一次请求的上下文）");
  t.eq(steps[1].tool, "bash", "第二条是 bash");
  t.eq(steps[1].inputDelta, 1100, "13300 − 12200");
  t.eq(unattributed, 0, "都有 usage");
};

tests["C451 attributeCosts：没有 usage 的步骤要计数，不能静默当 0"] = (t) => {
  const events = [
    assistant(1, [{ id: "c1", name: "bash", args: { command: "a" } }], { inputTokens: 10, cacheReadTokens: 10, outputTokens: 1 }),
    result(2, "c1", "ok"),
    assistant(3, [{ id: "c2", name: "bash", args: { command: "b" } }]), // 没有 usage
  ];
  const { steps, unattributed } = attributeCosts(events);
  t.eq(steps.length, 0, "没 usage ⇒ 这条不算进统计");
  t.eq(unattributed, 1, "但要计数（否则报告会显得样本齐全）");
};

tests["C451 attributeCosts：负增量（中间折过）必须剔除并单独计数"] = (t) => {
  const u = (miss, hit) => ({ inputTokens: miss, cacheReadTokens: hit, outputTokens: 10 });
  const events = [
    assistant(1, [{ id: "c1", name: "bash", args: { command: "a" } }], u(100, 900)),   // 上下文 1000
    result(2, "c1", "ok"),
    assistant(3, [{ id: "c2", name: "bash", args: { command: "b" } }], u(100, 2900)),  // 3000 ⇒ a 的增量 +2000
    result(4, "c2", "ok"),
    assistant(5, [{ id: "c3", name: "bash", args: { command: "c" } }], u(100, 400)),   // 500 ⇒ b 的增量 −2500（折过）
    result(6, "c3", "ok"),
    assistant(7, [{ id: "c4", name: "bash", args: { command: "d" } }], u(100, 700)),   // 800 ⇒ c 的增量 +300
  ];
  const { steps, resets } = attributeCosts(events);
  t.eq(resets, 1, "负增量计 1 次");
  t.eq(steps[0].inputDelta, 2000, "a 的增量 +2000");
  t.eq(steps[1].inputDelta, null, "折过的那条不进统计（不能当成'省了钱'）");
  t.eq(steps[2].inputDelta, 300, "折后继续：800 − 500");
};

tests["C451 byTool / topActions：排序口径（累计 vs 单次）必须分开"] = (t) => {
  const steps = [
    { tool: "bash", arg: "a", resultChars: 100, contextTokens: 1000, inputDelta: 100, outputTokens: 10 },
    { tool: "bash", arg: "b", resultChars: 200, contextTokens: 1400, inputDelta: 400, outputTokens: 10 },
    { tool: "read", arg: "c", resultChars: 5000, contextTokens: 6400, inputDelta: 5000, outputTokens: 10 },
  ];
  const tools = byTool(steps);
  t.eq(tools[0].tool, "read", "单次增量最大的排最前");
  const bash = tools.find((x) => x.tool === "bash");
  t.eq(bash.count, 2, "次数");
  t.eq(bash.deltaTotal, 500, "累计增量 100+400");
  t.eq(bash.deltaMedian, 250, "单次中位");
  // 按累计排：bash 500 vs read 5000 ⇒ read 仍在前；构造反例
  const steps2 = [
    { tool: "many", arg: "", resultChars: 1, contextTokens: 1, inputDelta: 600, outputTokens: 0 },
    { tool: "many", arg: "", resultChars: 1, contextTokens: 1, inputDelta: 600, outputTokens: 0 },
    { tool: "big", arg: "", resultChars: 1, contextTokens: 1, inputDelta: 1000, outputTokens: 0 },
  ];
  const byTotal = [...byTool(steps2)].sort((a, b) => b.deltaTotal - a.deltaTotal);
  t.eq(byTotal[0].tool, "many", "累计口径下 many(1200) 赢 big(1000) —— 步数才是成本主因");
  t.eq(topActions(steps, { top: 2, key: "delta" }).length, 2, "top 按增量取 2 条");
  t.eq(topActions(steps, { top: 2, key: "delta" })[0].tool, "read", "增量最大的是 read");
  t.eq(topActions(steps, { top: 2 })[0].tool, "read", "按字符也是 read");
};