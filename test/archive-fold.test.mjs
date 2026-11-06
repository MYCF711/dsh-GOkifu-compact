/**
 * archive-fold.test.mjs —— 离线归档压缩的纯函数（C490）
 *
 * 由来（用户原话）：「需要的不是会话自己去压，而是归档的日志需要去调用默认模型压缩一次，
 * 这样就不用依赖对话模型」。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
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
  for (const needle of ["把构建跑通", "不许动 prod 配置", "e1", "EACCES", "e2", "12 passed"]) {
    t.includes(facts, needle, `事实块缺 ${needle}`);
  }
  // ★ C546：**「本段遮蔽 seq」从事实块挪到了 prompt 末尾**（它每段都变，放前面会让分段跑
  //   每段的请求前缀都分叉 ⇒ 缓存全废）。事实块里不该再有它，但 prompt 里必须有。
  t.eq(facts.includes("本段遮蔽"), false, "事实块里不许再有会变的那行（C546）");
  const prompt = buildOfflinePrompt({ facts, messages: [{ role: "user", text: "hi" }], range: { start: 1, end: 99 } });
  t.includes(prompt, "seq 1-99", "坐标要出现在 prompt 里（挪到末尾）");
  t.eq(prompt.indexOf("seq 1-99") > prompt.indexOf("hi"), true, "坐标必须在消息**之后**（缓存友好）");
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

tests["C494 默认模型跟 DSH 走：从 profile 的 cordis.patch.yml 读 agent-default-model"] = async (t) => {
  const m = await import("../scripts/archive-fold.mjs");
  const nodeFs = (await import("node:fs")).default;
  const nodePath = (await import("node:path")).default;
  const { fileURLToPath } = await import("node:url");
  const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
  const home = nodePath.join(HERE, ".tmp-default-model");
  nodeFs.rmSync(home, { recursive: true, force: true });
  nodeFs.mkdirSync(nodePath.join(home, "profiles", "desktop"), { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(home, "profiles", "desktop", "cordis.patch.yml"),
    ["# patch", "- id: agent-default-model # magpie", "  config:", "    provider: magpie", "    model: group/deepseek-v4.1-flash1017", "    reasoningEffort: max", "- id: other", "  config:", "    model: should-not-win"].join("\n"),
    "utf8",
  );
  const r = m.readDefaultModel(home);
  t.eq(r.model, "group/deepseek-v4.1-flash1017", "必须取 agent-default-model 那条");
  t.eq(r.provider, "magpie", "provider 也要拿到");
  t.includes(r.source, "cordis.patch.yml", "要能说出配置来源（排查时有用）");
  t.eq(r.model === "should-not-win", false, "不许被后面的条目覆盖");
  // 没有 profile 时不许抛
  const none = m.readDefaultModel(nodePath.join(HERE, ".nope-home"));
  t.eq(none.model, null, "找不到就返回 null，由调用方兜底");
  nodeFs.rmSync(home, { recursive: true, force: true });
};

tests["C523 活着的会话不许用脚本写回（宿主会覆盖，钱白花）"] = async (t) => {
  const nodeOs = await import("node:os");
  const nodeZlib = await import("node:zlib");
  const { main: archiveMain } = await import("../scripts/archive-fold.mjs");
  const sid = "c523-live-guard";
  const realFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async () => {
    modelCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "## 目标\n- fixture\n\n## 已建立事实\n- 完成" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
        model: "fixture-model",
      }),
    };
  };
  const run = async ({ fresh, force = false }) => {
    const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "archive-c523-"));
    const originalLog = console.log;
    const logs = [];
    const beforeCalls = modelCalls;
    try {
      const graphDir = nodePath.join(home, "chess-context", "sessions", sid);
      nodeFs.mkdirSync(graphDir, { recursive: true });
      const graphFile = nodePath.join(graphDir, "graph.json");
      nodeFs.writeFileSync(graphFile, JSON.stringify({
        version: 1,
        sessionId: sid,
        rootUserNodeIds: ["n1"],
        nodes: {
          n1: { id: "n1", kind: "user", seq: 1, text: "fixture", constraints: [], ts: 1 },
          n2: { id: "n2", kind: "agent", seq: 3, text: "末", ts: 1 },
        },
        edges: {}, order: ["n1", "n2"], stateIndex: {}, foldMarks: [], updatedAt: 1,
      }), "utf8");
      const logDir = nodePath.join(home, "sessions", "workspace", `session-${sid}`);
      nodeFs.mkdirSync(logDir, { recursive: true });
      const events = [u("第一条"), a("回答"), u("最后一条")].map((event, i) => ({ ...event, seq: i + 1 }));
      const logFile = nodePath.join(logDir, "session.v4.jsonl.zstd");
      nodeFs.writeFileSync(logFile, nodeZlib.zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`)));
      const stamp = fresh ? Date.now() / 1000 : (Date.now() - 600_000) / 1000;
      nodeFs.utimesSync(logFile, stamp, stamp);
      console.log = (...args) => logs.push(args.join(" "));
      const code = await archiveMain(["--session", sid, "--write", ...(force ? ["--force-live"] : [])], {
        DSH_HOME: home,
        MAGPIE_BASE_URL: "http://fixture.invalid/v1",
      });
      return { code, logs: logs.join("\n"), calls: modelCalls - beforeCalls, graph: JSON.parse(nodeFs.readFileSync(graphFile, "utf8")) };
    } finally {
      console.log = originalLog;
      nodeFs.rmSync(home, { recursive: true, force: true });
    }
  };
  try {
    // 新鲜日志：必须在模型调用前跳过，图也不能变。
    const live = await run({ fresh: true });
    t.eq(live.code, 0, "活会话跳过不是脚本失败");
    t.eq(live.calls, 0, "活会话不许调模型");
    t.eq(live.graph.foldMarks.length, 0, "活会话不许写图");
    t.includes(live.logs, "仍在跑", "跳过原因必须真的打印出来");

    // 显式逃生口：同一新鲜日志只有 --force-live 才允许继续，并真的走共享写回。
    const forced = await run({ fresh: true, force: true });
    t.eq(forced.code, 0, `--force-live 必须能执行：${forced.logs}`);
    t.eq(forced.calls, 1, "--force-live 必须真的调用一次假模型");
    t.eq(forced.graph.foldMarks.length, 1, "共享写回必须真的新增 foldMark");
    t.eq(forced.graph.lastOfflineSummary?.text.includes("fixture"), true, "共享写回必须落 lastOfflineSummary");
    t.eq(!!forced.graph.closeout, true, "共享写回必须落 closeout");

    // 日志做旧后不再需要逃生口：证明判据确实消费 mtime，而不是一律跳过。
    const archived = await run({ fresh: false });
    t.eq(archived.code, 0, `旧日志必须可写：${archived.logs}`);
    t.eq(archived.calls, 1, "旧日志必须真的调用一次假模型");
    t.eq(archived.graph.foldMarks.length, 1, "旧日志必须真的写回一段折痕");
  } finally {
    globalThis.fetch = realFetch;
  }
};

tests["C538 摘要里的状态节点必须能回溯：消息要带棋谱节点 id（否则全是 n?）"] = async (t) => {
  const src = nodeFs.readFileSync(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "archive-fold.mjs"), "utf8");
  t.includes(src, "idBySeq", "脚本必须构造 seq→id");
  t.includes(src, ", idBySeq }", "必须传给 collectMessages");
  const room = nodeFs.readFileSync(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "src", "rooms", "offline-fold.mjs"), "utf8");
  t.includes(room, "nearestId", "落在两个节点之间时用最近的节点（否则大多消息没有 id）");
  t.includes(room, "· ${m.nodeId}", "id 要单独标在标题行（混在正文里模型不认）");
};
