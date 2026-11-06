/**
 * real-ledger-replace.mjs —— 用**真实的** @deepseek-ai/dsh-session 验证 P1-4 的机制
 *
 * P1-4 要解决的问题：热清单现在每 40 事件**追加**一条新 user 消息，旧的不替换 ⇒
 * 长会话累积上百条（实测 session-5acafe42 累积 131 条 / 508,308 字符 ≈ 20 万 token）。
 * 彻底修法是把新清单**替换**掉 surface 上的旧清单节点，让「热上下文永远只有一条」。
 *
 * 本文件只回答一件事：**替换机制在真实 Session 上到底行不行、边界在哪**。
 * 前置：先跑 `node test/real-modules.mjs`（提取依赖闭包到 tmp）。
 * 用法：node test/real-ledger-replace.mjs
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");
const WORK = nodePath.join(ROOT, "..", "..", "tmp", "dsh-gokifu-compact", "modules");

if (!nodeFs.existsSync(nodePath.join(WORK, "node_modules", "@deepseek-ai", "dsh-session", "package.json"))) {
  console.log("! 先跑 node test/real-modules.mjs（提取依赖闭包）");
  process.exit(0);
}

const workRequire = createRequire(nodePath.join(WORK, "package.json"));
const { Session } = await import(pathToFileURL(workRequire.resolve("@deepseek-ai/dsh-session")).href);

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  ✗ ${name}\n    ${String(error?.message ?? error)}`);
  }
}

const ledgerMessage = (id, text, digest) => ({
  id,
  role: "user",
  content: [{ type: "text", text }],
  source: { kind: "chess-context", form: "ledger", digest },
});

function freshSession() {
  const s = Session.create("probe-replace");
  const sys = s.append(
    "system/message",
    { message: { id: "sys", role: "system", content: [{ type: "text", text: "system" }] } },
    { surfaceOp: "append" },
  );
  return { s, sys };
}

console.log("== real-ledger-replace：真实 Session 上的 surface 替换 ==");

check("Session.create 能造出可 append 的会话", () => {
  const { s, sys } = freshSession();
  if (!s || s.surface.nodes.length !== 1) throw new Error(`surface 节点数 ${s?.surface?.nodes?.length}`);
  if (s.surface.nodes[0] !== sys.seq) throw new Error("surface 首节点不是 system");
});

check("追加一条清单 → surface 多一个节点", () => {
  const { s } = freshSession();
  const a = s.append("user/message", ledgerMessage("led-1", "LEDGER v1", "d1"), { surfaceOp: "append" });
  if (s.surface.nodes.length !== 2) throw new Error(`surface 节点数 ${s.surface.nodes.length}`);
  if (s.surface.nodes.at(-1) !== a.seq) throw new Error("清单没进 surface 尾");
});

check("替换旧清单 → surface 仍是「system + 一条清单」，且旧 seq 消失", () => {
  const { s } = freshSession();
  const a = s.append("user/message", ledgerMessage("led-1", "LEDGER v1", "d1"), { surfaceOp: "append" });
  const b = s.append("user/message", ledgerMessage("led-2", "LEDGER v2", "d2"), {
    surfaceOp: { op: "replace", startSeq: a.seq, endSeq: a.seq },
    sourceEventSeqs: [a.seq],
  });
  if (s.surface.nodes.length !== 2) throw new Error(`surface 节点数 ${s.surface.nodes.length}（应恒为 2）`);
  if (s.surface.nodes.includes(a.seq)) throw new Error("旧清单仍在 surface 上");
  if (s.surface.nodes.at(-1) !== b.seq) throw new Error("新清单不在 surface 尾");
  const msg = s.eventAt(b.seq).data;
  if (msg.content[0].text !== "LEDGER v2") throw new Error("替换后的内容不对");
  if (s.eventAt(b.seq).sourceEventSeqs[0] !== a.seq) throw new Error("sourceEventSeqs 没记下被遮蔽节点");
});

check("连续替换 50 次 → 仍只有一条清单（这就是 P1-4 想要的形态）", () => {
  const { s } = freshSession();
  let cur = s.append("user/message", ledgerMessage("led-0", "LEDGER 0", "d0"), { surfaceOp: "append" });
  for (let i = 1; i <= 50; i += 1) {
    cur = s.append("user/message", ledgerMessage(`led-${i}`, `LEDGER ${i}`, `d${i}`), {
      surfaceOp: { op: "replace", startSeq: cur.seq, endSeq: cur.seq },
      sourceEventSeqs: [cur.seq],
    });
  }
  if (s.surface.nodes.length !== 2) throw new Error(`50 次替换后 surface 节点数 ${s.surface.nodes.length}`);
  if (s.eventAt(s.surface.nodes.at(-1)).data.content[0].text !== "LEDGER 50") throw new Error("内容不是最后一份");
});

check("小写 surfaceOp 值 'replace'（字符串）被拒绝 —— 必须是 {op,startSeq,endSeq} 对象", () => {
  const { s } = freshSession();
  const a = s.append("user/message", ledgerMessage("led-1", "v1", "d1"), { surfaceOp: "append" });
  let threw = false;
  try {
    s.append("user/message", ledgerMessage("led-2", "v2", "d2"), { surfaceOp: "replace", sourceEventSeqs: [a.seq] });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("非法 surfaceOp 竟然被接受（引擎里不能写错形状）");
});

check("替换一个不在 surface 上的 seq（已被 fold 遮蔽）会抛错 —— 引擎必须先检查", () => {
  const { s } = freshSession();
  const a = s.append("user/message", ledgerMessage("led-1", "v1", "d1"), { surfaceOp: "append" });
  const b = s.append("user/message", ledgerMessage("led-2", "v2", "d2"), { surfaceOp: "append" }); // 另一条独立消息
  // 先把 a 用一次替换遮蔽掉（模拟 fold 或别人改写）
  s.append("user/message", ledgerMessage("led-3", "v3", "d3"), {
    surfaceOp: { op: "replace", startSeq: a.seq, endSeq: a.seq },
    sourceEventSeqs: [a.seq],
  });
  let threw = false;
  try {
    s.append("user/message", ledgerMessage("led-4", "v4", "d4"), {
      surfaceOp: { op: "replace", startSeq: a.seq, endSeq: a.seq },
      sourceEventSeqs: [a.seq],
    });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("替换非当前节点竟然成功（引擎若直接照做会在 fold 后崩）");
  // 用 b 当锚点就仍然可以替换（说明引擎要重新找「当前那条清单」）
  const ok = s.append("user/message", ledgerMessage("led-5", "v5", "d5"), {
    surfaceOp: { op: "replace", startSeq: b.seq, endSeq: b.seq },
    sourceEventSeqs: [b.seq],
  });
  if (!s.surface.nodes.includes(ok.seq)) throw new Error("拿当前节点当锚点应该能替换");
});

check("sourceEventSeqs 漏掉被遮蔽节点会抛错（必须逐条列出）", () => {
  const { s } = freshSession();
  const a = s.append("user/message", ledgerMessage("led-1", "v1", "d1"), { surfaceOp: "append" });
  let threw = false;
  try {
    s.append("user/message", ledgerMessage("led-2", "v2", "d2"), {
      surfaceOp: { op: "replace", startSeq: a.seq, endSeq: a.seq },
      sourceEventSeqs: [],
    });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("漏报 sourceEventSeqs 竟然被接受");
});

check("替换后仍能按 source.kind 找回「当前清单」（引擎定位锚点就是这么做的）", () => {
  const { s } = freshSession();
  const a = s.append("user/message", ledgerMessage("led-1", "v1", "d1"), { surfaceOp: "append" });
  const b = s.append("user/message", ledgerMessage("led-2", "v2", "d2"), {
    surfaceOp: { op: "replace", startSeq: a.seq, endSeq: a.seq },
    sourceEventSeqs: [a.seq],
  });
  const found = s.surface.nodes
    .map((seq) => s.eventAt(seq))
    .filter((event) => event?.type === "user/message" && event.data?.source?.kind === "chess-context");
  if (found.length !== 1) throw new Error(`按 source.kind 找到 ${found.length} 条清单（应 1 条）`);
  if (found[0].seq !== b.seq) throw new Error("找到的不是最新那条");
  if (found[0].data.source.digest !== "d2") throw new Error("digest 没跟着走（去重会失效）");
});

console.log(`\n== ${pass} passed, ${fail} failed ==`);
if (fail > 0) process.exitCode = 1;
