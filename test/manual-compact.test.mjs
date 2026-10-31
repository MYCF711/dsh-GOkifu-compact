/**
 * manual-compact.test.mjs —— 手动压缩失败诊断（R16，task-174）
 *
 * 两层：
 *   ① **纯函数**：`classifyManualCompactError` / `describeManualCompactError` / `annotateManualCompactError`
 *      对宿主六类 `ManualCompactionError`（busy-open-turn / busy-idle / busy-lock / cancelled /
 *      persistence / commit / changed / summary）逐条分类，并证明 **code 与 cause 原样保留**。
 *   ② **真实 Basic 探针**：用从 asar 提取的**真实** `BasicCompactionEngine` 跑 `compactNow` ——
 *      open turn 必抛 `ManualCompactionError("busy", "…open turn")`，closed turn 不再命中该分支。
 *      依赖闭包不在时 `t.skip(...)`（先跑 `node test/real-modules.mjs`）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyManualCompactError, describeManualCompactError, annotateManualCompactError, MANUAL_COMPACT_KINDS } from "../src/rooms/manual-compact.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");
const WORK = nodePath.join(ROOT, "..", "..", "tmp", "dsh-gokifu-compact", "modules");

/** 造一个宿主认的 `ManualCompactionError`（不 import 宿主包，形状照抄 asar 里的 class）。 */
function manualError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "ManualCompactionError";
  error.code = code;
  return error;
}

/** 最小 session（真实 Basic 事务只用到这些方法；与 test/real-fold.mjs 同形）。 */
function makeSession(id, cwd) {
  const log = [];
  const nodes = [];
  let replaceGen = 0;
  let contentGen = 0;
  const session = {
    id,
    cwd,
    get seq() {
      return log.length;
    },
    surface: {
      get nodes() {
        return nodes;
      },
      get replaceGeneration() {
        return replaceGen;
      },
      get contentGeneration() {
        return contentGen;
      },
    },
    eventAt(seq) {
      return log[seq];
    },
    requestHeader() {
      return { config: { provider: "p", model: "m", maxTokens: 4096 } };
    },
    toolHistory() {
      return { tools: [] };
    },
    deriveMessages() {
      return nodes.map((x) => log[x]).filter(Boolean);
    },
    deriveEventMessage(event) {
      if (!event) return null;
      if (event.type === "system/message") return { role: "system", content: [{ type: "text", text: "sys" }] };
      return event.data?.message ?? event.data ?? null;
    },
    append(type, data, opts) {
      const event = { type, seq: log.length, time: Date.now(), data, ...(opts ?? {}) };
      log.push(event);
      const op = opts?.surfaceOp;
      const surfaceable = ["system/message", "developer/message", "user/message", "assistant/message", "tool/result"].includes(type);
      if (surfaceable) {
        if (op === "append" || op === undefined) nodes.push(event.seq);
        else if (op && op.op === "replace") {
          const a = nodes.indexOf(op.startSeq);
          const b = nodes.indexOf(op.endSeq);
          if (a < 0 || b < 0) throw new Error("bad replace range");
          nodes.splice(a, b - a + 1, event.seq);
          replaceGen += 1;
          contentGen += 1;
        }
      }
      return event;
    },
    seed(kind, text) {
      const data = kind === "system" ? {} : { id: `m${log.length}`, role: kind, content: [{ type: "text", text }], source: { kind: "prompt" } };
      return session.append(kind === "system" ? "system/message" : `${kind}/message`, data, { surfaceOp: "append" });
    },
    types() {
      const out = [];
      for (let i = 0; i < log.length; i += 1) out.push(log[i].type);
      return out;
    },
  };
  return session;
}

export const tests = {
  "MC-1 分类：宿主六类 ManualCompactionError 逐条对上（busy 三种文案分开）"(t) {
    const cases = [
      ["busy", "manual compaction: the session already has an open turn", "open-turn"],
      ["busy", "manual compaction requires an idle agent with no waking queued work", "idle"],
      ["busy", "compaction: compaction already in progress; the session compaction lock is already active", "busy-lock"],
      ["cancelled", "manual compaction was cancelled", "cancelled"],
      ["persistence", "manual compaction durability checkpoint failed", "persistence"],
      ["commit", "manual compaction did not commit cleanly", "commit"],
      ["changed", "the compacted history changed during manual compaction", "changed"],
      ["summary", "manual compaction could not produce a smaller summary", "summary"],
    ];
    for (const [code, message, kind] of cases) {
      t.eq(classifyManualCompactError(manualError(code, message)), kind, `${code}：${message}`);
    }
    // AbortError 走 cancelled（哪怕没有 code）
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    t.eq(classifyManualCompactError(abort), "cancelled", "AbortError ⇒ cancelled");
    // 任意异常 ⇒ unknown
    t.eq(classifyManualCompactError(new TypeError("boom")), "unknown", "未知类型 ⇒ unknown");
    t.eq(classifyManualCompactError(null), "unknown", "null ⇒ unknown");
    t.eq(classifyManualCompactError("plain string failure"), "unknown", "字符串 ⇒ unknown");
    t.eq(MANUAL_COMPACT_KINDS.includes("open-turn"), true, "open-turn 必须在分类表里");
  },

  "MC-2 describe：保留 code + cause 原引用，text 是人话且点名类别"(t) {
    const cause = new Error("EACCES: permission denied, open graph.json");
    const error = manualError("persistence", "manual compaction durability checkpoint failed", cause);
    const d = describeManualCompactError(error);
    t.eq(d.kind, "persistence", "kind");
    t.eq(d.code, "persistence", "code 必须原样保留");
    t.eq(d.name, "ManualCompactionError", "name");
    t.eq(d.cause, cause, "cause 必须是原始对象引用（不是转述）");
    t.includes(d.causeMessage, "EACCES", "causeMessage 取到原因");
    t.includes(d.text, "手动压缩失败（persistence）", "text 必须点名类别");
    t.includes(d.text, "durability checkpoint", "text 必须带原始 message");
    t.includes(d.text, "EACCES", "text 必须带 cause 摘要");
    // open-turn 的提示必须直说「先结束本轮」
    const openTurn = describeManualCompactError(manualError("busy", "manual compaction: the session already has an open turn"));
    t.includes(openTurn.hint, "回合还开着", "open-turn 提示");
    t.includes(openTurn.hint, "/compact", "必须给出下一步动作");
    t.eq(openTurn.text.includes("open turn"), true, "text 带原始英文（方便搜日志）");
  },

  "MC-3 annotate：原错误类型 / code / cause 不变，message 换成人话（unknown 不动 message）"(t) {
    const cause = new Error("surface changed");
    const error = manualError("changed", "the compacted history changed during manual compaction", cause);
    const { diagnosis } = annotateManualCompactError(error);
    t.eq(error.name, "ManualCompactionError", "类型不许换");
    t.eq(error.code, "changed", "code 不许换");
    t.eq(error.cause, cause, "cause 不许换");
    t.eq(diagnosis.kind, "changed", "diagnosis.kind");
    t.eq(error.diagnosis, diagnosis, "诊断挂在原错误上");
    t.eq(error.rawMessage, "the compacted history changed during manual compaction", "原始 message 保留在 rawMessage");
    t.includes(error.message, "手动压缩失败（changed）", "message 被换成人话");
    // unknown：message 不许动（原始信息更值钱）
    const unknown = new TypeError("boom");
    annotateManualCompactError(unknown);
    t.eq(unknown.message, "boom", "unknown 不许改 message");
    t.eq(unknown.diagnosis.kind, "unknown", "unknown 也挂诊断");
    // 非对象（字符串抛出）也要安全
    const prim = annotateManualCompactError("just a string");
    t.eq(prim.diagnosis.kind, "unknown", "字符串诊断");
  },

  "MC-4 真实 Basic 探针：open turn 必抛 busy/open-turn（诊断后 message 可读、code 保留）"(t) {
    if (!nodeFs.existsSync(nodePath.join(WORK, "src", "engine.mjs"))) {
      t.skip("依赖闭包未提取（先跑 node test/real-modules.mjs）");
      return undefined;
    }
    return (async () => {
      // 用项目当前 src（复制到 WORK，否则 @deepseek-ai/* 解析不到）
      nodeFs.cpSync(nodePath.join(ROOT, "src"), nodePath.join(WORK, "src"), { recursive: true, force: true });
      const { createRequire } = await import("node:module");
      const workRequire = createRequire(nodePath.join(WORK, "package.json"));
      const { Context } = await import(pathToFileURL(workRequire.resolve("@deepseek-ai/cordis")).href);
      const { default: Engine } = await import(pathToFileURL(nodePath.join(WORK, "src", "engine.mjs")).href);
      const { ManualCompactionError } = await import(pathToFileURL(workRequire.resolve("@deepseek-ai/dsh-compaction")).href);

      const ctx = new Context();
      ctx.logger = { info() {}, warn() {}, debug() {}, error() {} };
      ctx.sessions = { async flush() {} };
      ctx.llm = {
        async resolveModelInfo() {
          return { context: { contextWindow: 200_000 }, defaultMaxTokens: 4096 };
        },
        async *stream() {
          yield { type: "text-delta", text: "## 目标\n- mock" };
          yield { type: "finish", kind: "stop" };
        },
      };
      const session = makeSession("probe-manual", process.cwd());
      ctx.tokenMeter = {
        measure() {
          const nodes = session.surface.nodes.map((s) => ({ seq: s, tokens: 20_000, heuristicTokens: 20_000 }));
          return { totalTokens: nodes.length * 20_000, surfaceTokens: nodes.length * 20_000, nodes };
        },
        estimateMessage() {
          return 500;
        },
      };
      const graphDir = nodePath.join(WORK, "graphs-manual");
      nodeFs.rmSync(graphDir, { recursive: true, force: true });
      const engine = new Engine(ctx, { auto: false, graphDir, growthFloorTokens: 0, minFoldTokens: 0, retainRatio: 0.1, summaryMode: "rules" });

      session.seed("system", "sys");
      session.append("turn/start", { turn: 1 });
      for (let i = 0; i < 15; i += 1) session.seed("user", `step ${i}`);
      const agent = { session, options: {}, runMaintenance: async (fn) => fn(new AbortController().signal) };
      const signal = new AbortController().signal;

      // ① open turn：必须抛 ManualCompactionError(busy / open turn)，且被诊断改写成人话
      let openError = null;
      try {
        await engine.compactNow(agent, signal);
      } catch (error) {
        openError = error;
      }
      t.ok(openError !== null, "open turn 时 compactNow 必须抛错（不许静默成功）");
      t.eq(openError instanceof ManualCompactionError, true, `必须是宿主的 ManualCompactionError，实际 ${openError?.name}`);
      t.eq(openError.code, "busy", `code 必须是 busy，实际 ${openError?.code}`);
      t.eq(openError.diagnosis?.kind, "open-turn", `诊断必须是 open-turn，实际 ${openError?.diagnosis?.kind}`);
      t.includes(openError.rawMessage, "open turn", "rawMessage 必须保留原始英文");
      t.includes(openError.message, "手动压缩失败（open-turn）", "message 必须换成人话");
      t.includes(openError.hint ?? openError.diagnosis?.hint ?? "", "回合还开着", "hint 必须说清原因");
      t.eq(openError.name, "ManualCompactionError", "类型名不许丢");

      // ② 关闭回合后：不能再命中「open turn」分支
      session.append("turn/end", { turn: 1 });
      let closedError = null;
      let closedResult = null;
      try {
        closedResult = await engine.compactNow(agent, signal);
      } catch (error) {
        closedError = error;
      }
      if (closedError !== null) {
        t.eq(closedError.diagnosis?.kind === "open-turn", false, `closed turn 不许再报 open-turn，实际 ${closedError.diagnosis?.kind}：${closedError.rawMessage ?? closedError.message}`);
      } else {
        t.ok(closedResult !== null && closedResult !== undefined, "closed turn 成功时必须返回结果（成功路径不许被包装丢值）");
        t.ok(Array.isArray(closedResult.summary), "成功结果必须带 summary（与基类返回同形）");
      }
    })();
  },
};
