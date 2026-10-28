import fs from "node:fs";
import { createGraph } from "../src/graph.mjs";
import { observeEvent } from "../src/keeper.mjs";

const rows = fs.readFileSync(process.argv[2], "utf8")
  .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const g = createGraph({ sessionId: "replay" });
const st = { pendingEdges: new Map(), lastNodeId: null, lastUserNodeId: null, constraintDirty: true, touched: [], stepEdges: [] };
const unmatched = [];
const callNames = new Map();
for (const ev of rows) {
  if (ev.type === "assistant/message") {
    for (const b of ev.data?.message?.content ?? []) if (b.type === "tool-call") callNames.set(b.id, b.name);
  }
  const before = st.pendingEdges.size;
  const r = observeEvent(g, ev, st);
  if (ev.type === "tool/result") {
    const m = ev.data?.message ?? {};
    const cid = m.source?.callId ?? m.toolCallId;
    if (!r.changed) unmatched.push(String(cid) + " (" + (callNames.get(cid) ?? "?") + ")");
    void before;
  }
}
console.log("events", rows.length, "| edges", Object.keys(g.edges).length, "| nodes", g.order.length);
const byResult = {};
for (const e of Object.values(g.edges)) byResult[e.result] = (byResult[e.result] ?? 0) + 1;
console.log("result 分布:", byResult);
console.log("未匹配 tool/result:", unmatched.length, unmatched.slice(0, 12));
console.log("failures:");
for (const e of Object.values(g.edges)) if (e.result === "failure") console.log(" -", e.id, e.action.slice(0,44), "|", e.verify.kind, "|", (e.errorSnippet||"").slice(0,50).replace(/\n/g," "));
console.log("user nodes:", g.order.map(id=>g.nodes[id]).filter(n=>n.kind==='user').map(n=>n.text.slice(0,40).replace(/\n/g,' ')));
