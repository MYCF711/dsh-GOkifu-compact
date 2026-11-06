#!/usr/bin/env node
/**
 * verify-archive.mjs —— 一条命令验证「某个会话归档后到底压没压」（C568）
 *
 * 判据与 `docs/归档压缩-怎么验证.md` 完全一致：
 *   · `foldMark` 是唯一"真的折了"的证据；
 *   · `closeout.folded: true` 但没有新增 mark ⇒ **假成功**（C531/C557 修的就是它）。
 *
 * 用法：
 *   node scripts/verify-archive.mjs --session 4f3cae10
 *   node scripts/verify-archive.mjs --session 4f3cae10 --json
 *
 * 退出码：0 = 真折了；1 = 没折/假成功；2 = 找不到会话
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { loadSessionGraph } from "./graph-audit.mjs";
import { debtOfGraph } from "../src/rooms/closeout-backfill.mjs";

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

function resolveHome() {
  const env = String(process.env.DSH_HOME ?? "").trim();
  if (env !== "") return env;
  return nodePath.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh");
}

/**
 * 纯函数：把一份棋谱判成结论（便于单测）。
 *
 * @param {object} graph
 * @param {{debt?: object|null}} [extra]
 * @returns {{verdict:"folded"|"fake"|"none"|"unfolded", closedOut:boolean, marks:number, offlineMarks:number, detail:string}}
 */
export function verdictOfGraph(graph, { debt = null } = {}) {
  const marks = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
  const closeout = graph?.closeout ?? null;
  const offlineMarks = marks.filter((m) => m?.offline === true).length;
  const closedOut = closeout !== null && closeout !== undefined;
  const foldedFlag = Number(closeout?.folded) > 0 || closeout?.folded === true;
  if (closedOut && foldedFlag && marks.length === 0) {
    return {
      verdict: "fake",
      closedOut,
      marks: marks.length,
      offlineMarks,
      detail: "closeout 说折了，但 foldMarks 是 0 ⇒ 假成功",
    };
  }
  if (marks.length > 0) {
    const last = marks.at(-1);
    return {
      verdict: "folded",
      closedOut,
      marks: marks.length,
      offlineMarks,
      detail: `最近一条：${last?.trigger ?? "?"} seq ${last?.seqStart ?? "?"}-${last?.seqEnd ?? "?"} · ${last?.summaryChars ?? "?"} 字符`,
    };
  }
  if (debt !== null && debt !== undefined && debt.due === true) {
    return { verdict: "unfolded", closedOut, marks: 0, offlineMarks: 0, detail: `仍欠：尾巴 ${debt.tail ?? "?"} 事件${debt.gap ? ` · 缺口 ${debt.gap.events} 事件（from ${debt.gap.from}）` : ""}` };
  }
  return { verdict: "none", closedOut, marks: 0, offlineMarks: 0, detail: closedOut ? "已收尾但没有 foldMark（可能尾巴太短）" : "还没有 closeout" };
}

const LABEL = { folded: "✅ 真折了", fake: "❌ 假成功", unfolded: "⚠ 还没折（欠账）", none: "— 没有折叠记录" };

export function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--session");
  const want = i >= 0 ? argv[i + 1] : null;
  const all = argv.includes("--all");
  if (!all && (want === null || String(want).startsWith("--"))) {
    console.log("用法：node scripts/verify-archive.mjs --session <会话 id 或前缀> | --all");
    return 2;
  }
  const home = resolveHome();
  const root = nodePath.join(home, "chess-context", "sessions");
  if (!nodeFs.existsSync(root)) {
    console.log("没有棋谱目录：" + root);
    return 2;
  }
  const dirs = nodeFs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const hits = all ? dirs : dirs.filter((name) => name.includes(String(want)));
  if (hits.length === 0) {
    console.log(`找不到含「${want}」的会话`);
    return 2;
  }
  const rows = [];
  for (const name of hits) {
    const file = nodePath.join(root, name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    let graph = null;
    try {
      ({ graph } = loadSessionGraph(file));
    } catch {
      continue;
    }
    let debt = null;
    try {
      debt = debtOfGraph(graph);
    } catch {
      debt = null;
    }
    rows.push({ session: name, ...verdictOfGraph(graph, { debt }), debt });
  }
  if (all) {
    const tally = { folded: 0, fake: 0, unfolded: 0, none: 0 };
    for (const r of rows) tally[r.verdict] += 1;
    const bad = rows.filter((r) => r.verdict === "fake" || r.verdict === "unfolded");
    if (argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ tally, needWork: bad }, null, 1)}\n`);
    } else {
      console.log(`== 全部 ${rows.length} 个会话的归档判决 ==`);
      console.log(`  ✅ 真折了 ${tally.folded} · ❌ 假成功 ${tally.fake} · ⚠ 未折 ${tally.unfolded} · — 无记录 ${tally.none}`);
      if (bad.length > 0) {
        console.log("  需要处理的：");
        for (const r of bad.slice(0, 10)) console.log(`    ${LABEL[r.verdict]} · ${r.session.slice(0, 24)} · ${r.detail}`);
        if (bad.length > 10) console.log(`    …另 ${bad.length - 10} 个`);
      }
    }
    return bad.length === 0 ? 0 : 1;
  }
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(rows, null, 1)}\n`);
  } else {
    for (const r of rows) {
      console.log(`${LABEL[r.verdict]} · ${r.session}`);
      console.log(`  · 收尾记录：${r.closedOut ? "有" : "无"} · foldMarks ${r.marks}（离线 ${r.offlineMarks}）`);
      console.log(`  · ${r.detail}`);
      if (r.debt) console.log(`  · 欠账：尾巴 ${r.debt.tail} · 缺口 ${r.debt.gap ? r.debt.gap.events : 0} · due=${r.debt.due}`);
    }
  }
  const worst = rows.some((r) => r.verdict === "folded") ? 0 : 1;
  return worst;
}

if (process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}

void ROOT;
