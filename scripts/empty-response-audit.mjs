#!/usr/bin/env node
/**
 * empty-response-audit.mjs —— 只读取证 offline:empty-response。
 *
 * 历史 closeout 没保存 callModel 的完整返回对象；本脚本不编造它，而是把仍然存在的
 * 三类原始证据拼起来：closeout 时间、同会话原始 assistant/attempt（usage / finish /
 * stream 块类型）、最近 foldMark 的真实路由与用量。默认绝不调用模型。
 *
 * 用法：node scripts/empty-response-audit.mjs [--limit 10]
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import { findSessionLog, readSessionEvents } from "../src/rooms/zstd-log.mjs";
import { readDefaultModel } from "../src/rooms/offline-fold.mjs";

const home = process.env.DSH_HOME ?? nodePath.join(nodeOs.homedir(), ".dsh");
const limitArg = process.argv.indexOf("--limit");
const limit = Math.max(1, Math.min(50, Number(limitArg >= 0 ? process.argv[limitArg + 1] : 10) || 10));
const graphRoot = nodePath.join(home, "chess-context", "sessions");

function readJson(file, fallback = null) {
  try {
    return JSON.parse(nodeFs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function attemptShape(event) {
  const stream = Array.isArray(event?.data?.stream) ? event.data.stream : [];
  const chunkTypes = {};
  const blockTypes = {};
  let usage = null;
  let finish = null;
  let reasoningChars = 0;
  let textChars = 0;
  for (const part of stream) {
    const chunk = part?.chunk ?? {};
    const type = String(chunk?.type ?? part?.type ?? "unknown");
    chunkTypes[type] = (chunkTypes[type] ?? 0) + 1;
    if (type === "block-start") {
      const blockType = String(chunk?.blockType ?? "unknown");
      blockTypes[blockType] = (blockTypes[blockType] ?? 0) + 1;
    }
    if (type === "reasoning-chunks") reasoningChars += String(part?.text ?? "").length;
    if (type === "text-delta") textChars += String(chunk?.text ?? "").length;
    if (type === "usage") usage = chunk?.usage ?? null;
    if (type === "finish") finish = chunk?.reason ?? chunk?.finish ?? null;
  }
  return { chunkTypes, blockTypes, reasoningChars, textChars, usage, finish };
}

const incidents = [];
const latestFolds = [];
for (const entry of nodeFs.readdirSync(graphRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const graph = readJson(nodePath.join(graphRoot, entry.name, "graph.json"));
  if (graph === null) continue;
  if (graph?.closeout?.foldNote === "offline:empty-response") incidents.push({ id: entry.name, graph });
  for (const mark of Array.isArray(graph?.foldMarks) ? graph.foldMarks : []) {
    if (mark?.trigger === "archive-offline") latestFolds.push({ id: entry.name, mark });
  }
}
incidents.sort((a, b) => Number(b.graph.closeout.foldAt ?? b.graph.closeout.at) - Number(a.graph.closeout.foldAt ?? a.graph.closeout.at));
latestFolds.sort((a, b) => Number(b.mark.at) - Number(a.mark.at));

console.log("== empty-response 只读取证（不发模型请求）==");
console.log(`DSH_HOME ${home}`);
console.log(`默认模型 ${JSON.stringify(readDefaultModel(home))}`);
console.log(`empty-response 事故 ${incidents.length} 个；本次展开 ${Math.min(limit, incidents.length)} 个`);

for (const { id, graph } of incidents.slice(0, limit)) {
  const closeout = graph.closeout;
  const at = Number(closeout.foldAt ?? closeout.at);
  const log = findSessionLog(home, id);
  const events = log === null ? [] : readSessionEvents(log);
  const attempts = events
    .filter((event) => event?.type === "assistant/attempt" && Math.abs(Number(event?.time) - at) <= 1_000)
    .sort((a, b) => Math.abs(Number(a.time) - at) - Math.abs(Number(b.time) - at));
  const nearest = attempts[0] ?? null;
  console.log(`\n${id}`);
  console.log(`closeout ${JSON.stringify({ at, iso: new Date(at).toISOString(), source: closeout.source, foldNote: closeout.foldNote, folded: closeout.folded ?? 0 })}`);
  console.log(`callModel历史落盘 ${JSON.stringify({ usage: null, blocks: null, note: "旧版本未保存 callModel 返回；以下取同毫秒原始流，不冒充已丢失的对象" })}`);
  if (nearest === null) {
    console.log("同毫秒原始流 null");
    continue;
  }
  console.log(`原始流 ${JSON.stringify({ seq: nearest.seq, time: nearest.time, ...attemptShape(nearest) })}`);
}

console.log("\n== 最近 archive-offline 成功折痕（真实路由 / usage）==");
for (const { id, mark } of latestFolds.slice(0, 5)) {
  console.log(JSON.stringify({
    id,
    at: mark.at,
    iso: new Date(Number(mark.at)).toISOString(),
    route: mark.route ?? null,
    usage: mark.usage ?? null,
    finishReason: mark.finishReason ?? null,
    summaryChars: mark.summaryChars ?? null,
  }));
}
