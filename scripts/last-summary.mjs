#!/usr/bin/env node
/**
 * last-summary.mjs —— 看某个会话最近一次的**离线摘要正文**（C566）
 *
 * 为什么需要：补账/归档之后，摘要只存在 `graph.json` 的 `lastOfflineSummary` 里，
 * 人要确认"它到底压出了什么"只能去翻 JSON。这个小命令直接把正文打印出来，
 * 并附上质量指标（约束召回 / 缺段 / 结尾是否干净）。
 *
 * 用法：
 *   node scripts/last-summary.mjs                 # 列最近 10 条离线摘要
 *   node scripts/last-summary.mjs --session 3a3f # 打印该会话最近一次的正文
 *   node scripts/last-summary.mjs --session 3a3f --full   # 不截断
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { loadSessionGraph } from "./graph-audit.mjs";

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

function resolveHome() {
  const env = String(process.env.DSH_HOME ?? "").trim();
  if (env !== "") return env;
  return nodePath.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh");
}

/**
 * 从一批会话目录里挑出离线摘要。纯函数（便于单测）。
 * @param {Array<{id:string, at:number, text:string, model:string|null, quality:object|null}>} items
 * @param {{session?: string|null, limit?: number}} opts
 * @returns {Array<object>}
 */
export function pickSummaries(items, { session = null, limit = 10 } = {}) {
  const want = session === null || session === undefined ? null : String(session);
  const filtered = (Array.isArray(items) ? items : [])
    .filter((x) => x !== null && typeof x === "object" && typeof x.text === "string" && x.text !== "")
    .filter((x) => (want === null ? true : String(x.id).includes(want)));
  return filtered.sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0)).slice(0, Math.max(1, Number(limit) || 10));
}

export function main(argv = process.argv.slice(2)) {
  const get = (name, dflt = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith("--") ? argv[i + 1] : dflt;
  };
  const session = get("session");
  const full = argv.includes("--full");
  const home = resolveHome();
  const root = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(root)) {
    console.log("没有棋谱目录：" + root);
    return 1;
  }
  const items = [];
  for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = nodePath.join(root, entry.name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    let graph = null;
    try {
      ({ graph } = loadSessionGraph(file));
    } catch {
      continue;
    }
    const last = graph?.lastOfflineSummary;
    if (last === null || last === undefined || typeof last.text !== "string" || last.text === "") continue;
    items.push({ id: entry.name, at: Number(last.at ?? 0), text: last.text, model: last.model ?? null, quality: last.quality ?? null });
  }
  const picked = pickSummaries(items, { session, limit: session === null ? 10 : 1 });
  if (picked.length === 0) {
    console.log(session === null ? "没有任何离线摘要" : `没有找到含「${session}」的离线摘要`);
    return 1;
  }
  for (const item of picked) {
    const when = item.at > 0 ? new Date(item.at).toLocaleString("zh-CN") : "时间未知";
    console.log("=".repeat(70));
    console.log(`${item.id} · ${when} · ${item.text.length} 字符 · ${item.model ?? "模型未知"}`);
    if (item.quality !== null && item.quality !== undefined) {
      console.log(
        `质量：约束召回 ${item.quality.constraintRecall ?? "?"} · 未知 id ${(item.quality.unknownIds ?? []).length} · ` +
          `缺段 ${(item.quality.sectionsMissing ?? []).join("/") || "无"} · 结尾干净 ${item.quality.endedCleanly ?? "?"}`,
      );
    }
    console.log("-".repeat(70));
    const text = full || session !== null ? item.text : `${item.text.slice(0, 400)}…`;
    console.log(text);
  }
  return 0;
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}

void ROOT;
