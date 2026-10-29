import fs from "node:fs";
import path from "node:path";
import { fromJSON, toJSON } from "../src/graph.mjs";
import { renderFacts } from "../src/ledger.mjs";

const root = "D:/DeepSeek Harness/home/chess-context/sessions";
const rows = [];
let totalObjBefore = 0, totalObjAfter = 0, totalAgent = 0;
let totalIdxBefore = 0, totalIdxAfter = 0, errors = 0;
for (const d of fs.readdirSync(root, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const f = path.join(root, d.name, "graph.json");
  if (!fs.existsSync(f)) continue;
  let raw;
  try { raw = fs.readFileSync(f, "utf8"); } catch { continue; }
  let before;
  try { before = JSON.parse(raw); } catch (e) { rows.push([d.name, "PARSE-FAIL", String(e)]); errors++; continue; }
  const agentsBefore = Object.values(before.nodes ?? {}).filter((n) => n && n.kind === "agent");
  const objBefore = agentsBefore.filter((n) => n.worldHash && typeof n.worldHash === "object").length;
  const idxBefore = Object.keys(before.stateIndex ?? {}).length;
  let g;
  try { g = fromJSON(raw); } catch (e) { rows.push([d.name, "FROMJSON-FAIL", String(e)]); errors++; continue; }
  const agentsAfter = Object.values(g.nodes ?? {}).filter((n) => n && n.kind === "agent");
  const objAfter = agentsAfter.filter((n) => n.worldHash && typeof n.worldHash === "object").length;
  const idxAfter = Object.keys(g.stateIndex ?? {}).length;
  let factsLen = -1, factErr = "";
  try { factsLen = renderFacts(g).length; } catch (e) { factErr = String(e); errors++; }
  const round = JSON.parse(toJSON(g));
  const objRound = Object.values(round.nodes ?? {}).filter((n) => n && n.kind === "agent" && n.worldHash && typeof n.worldHash === "object").length;
  totalAgent += agentsBefore.length;
  totalObjBefore += objBefore;
  totalObjAfter += objAfter;
  totalIdxBefore += idxBefore;
  totalIdxAfter += idxAfter;
  rows.push([d.name.slice(0, 28), agentsBefore.length, objBefore, objAfter, idxBefore, idxAfter, factsLen, factErr || (objRound ? "ROUND-OBJ!" : "ok")]);
}
console.log("session".padEnd(30), "agents", "objBefore", "objAfter", "idxBefore", "idxAfter", "factsChars", "status");
for (const r of rows) console.log(String(r[0]).padEnd(30), String(r[1]).padStart(6), String(r[2]).padStart(9), String(r[3]).padStart(8), String(r[4]).padStart(9), String(r[5]).padStart(8), String(r[6]).padStart(10), r[7]);
console.log("\nTOTAL agents=%d objBefore=%d objAfter=%d idxBefore=%d idxAfter=%d errors=%d", totalAgent, totalObjBefore, totalObjAfter, totalIdxBefore, totalIdxAfter, errors);
