#!/usr/bin/env node
/**
 * user-route.mjs —— 导出「会话级棋路」（C667 初稿）
 *
 * 一句话：把**这个人在这一局手动发送的每一句原话，按顺序、逐字、带位置**交出去。
 *
 * 为什么只有这样（设计已定的四条，别在这里加字段）：
 *   1. **棋路是走向，不是清单** —— 顺序本身就是信息，合并/摘要等于把走向抹掉；
 *   2. **不产任何语义判断** —— goal / pivot / polarity / lexicon / anchors 全部不交。
 *      它们是结论，由记忆侧从跨会话证据里长出来；压缩侧做只会把噪声固化成契约；
 *   3. **只装手动发送的** —— 判据是 `source.rpcId`（见 keeper 的 C667 注释）。
 *      真机实测：`kind ∈ {user,prompt,human}` 的消息里 99% 是父代理发给子代理的任务书，
 *      kind 挡不住，rpcId 才挡得住；
 *   4. **只落盘，不进上下文** —— 不进热清单、不进摘要、不调模型、不跨会话。
 *
 * 用法：
 *   node scripts/user-route.mjs --session <id>                 # 演练：打印摘要，不写盘
 *   node scripts/user-route.mjs --session <id> --json          # 打印容器 JSON（stdout）
 *   node scripts/user-route.mjs --session <id> --write         # 写 sessions/<id>/user-route.json
 *   node scripts/user-route.mjs --all --write                  # 批量（只处理已归档/不活跃会话前先看 --dry-run）
 *
 * 安全：
 *   · 图被重建（repaired）⇒ 拒绝写盘（与 C149「重建图不许按图清理旧文档」同一条道理）；
 *   · 已有容器且本次消息更少 ⇒ 不覆盖；
 *   · 写盘走 writeFileAtomic（tmp + rename），半写文件不会出现。
 *
 * 已知边界（诚实声明）：
 *   · **历史数据导不出棋路** —— C667 之前的图里根本没有 `manual` 字段，无法回溯。
 *     所以本命令只对「C667 之后落账的会话」有内容，旧会话会得到 0 条并显式说明原因。
 *   · 子代理会话的 user 节点现在也带 `manual`（父代理的委派 prompt 没有 rpcId）⇒ 天然为空。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { sessionPaths } from "../src/rooms/kifu-persist.mjs";
import { writeFileAtomic } from "../src/rooms/migrate.mjs";
import { loadSessionGraph } from "./graph-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const CONTAINER_VERSION = 1;
const CONTAINER_KIND = "gokifu-user-route";
const FILE_NAME = "user-route.json";
const MAX_TEXT_CHARS = 8000; // 单条原话上限；超出标 truncated（逐字前缀，不做摘要）

const USAGE = `用法：
  node scripts/user-route.mjs --session <sessionId> [--home <DSH_HOME>] [--json] [--write]
  node scripts/user-route.mjs --all [--home <DSH_HOME>] [--write] [--limit <n>]

  --session  会话 id（也接受 user-route 里的任意唯一后缀）
  --all      扫 home 下全部会话（默认只打印统计，--write 才落盘）
  --home     DSH home（默认取 $DSH_HOME；都没有就报错，不猜绝对路径）
  --json     把容器 JSON 打到 stdout
  --write    落盘到 sessions/<safeSessionId>/${FILE_NAME}
  --limit    批量模式的最多处理数（默认 200）
`;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

function homeDir() {
  // 不写死绝对 home：只认显式参数或宿主导出的 $DSH_HOME，都没有就报错让人给。
  const explicit = arg("home") ?? process.env.DSH_HOME;
  if (explicit) return explicit;
  process.stdout.write("❌ 缺 --home（或先导出 $DSH_HOME）\n");
  process.exit(2);
}

function chessRoot(home) {
  return nodePath.join(home, "chess-context");
}

/** 把一张已加载的图投影成棋路容器。**纯函数，只读图。** */
export function buildUserRoute(graph, { sessionId, builtAt = Date.now(), stats = {} } = {}) {
  const messages = [];
  for (const id of graph.order ?? []) {
    const node = graph.nodes?.[id];
    if (!node || node.kind !== "user") continue;
    // ★ 只认手动发送。旧图没有该字段 ⇒ 视为未知，不收（宁可空，不要假）。
    if (node.manual !== true) continue;
    const raw = String(node.text ?? "");
    const truncated = raw.length > MAX_TEXT_CHARS;
    messages.push({
      nodeId: node.id,
      seq: node.seq,
      ts: node.ts ?? null,
      text: truncated ? raw.slice(0, MAX_TEXT_CHARS) : raw,
      truncated,
    });
  }
  return {
    version: CONTAINER_VERSION,
    kind: CONTAINER_KIND,
    sessionId: sessionId ?? graph.sessionId ?? null,
    cwd: graph.cwd ?? "",
    builtAt,
    source: {
      graphRevision: stats.graphRevision ?? null,
      sessionEvents: stats.sessionEvents ?? null,
      userNodes: (graph.order ?? []).filter((id) => graph.nodes?.[id]?.kind === "user").length,
      manualNodes: messages.length,
    },
    messages,
  };
}

/** 找会话目录：先按 id 精确匹配，再按唯一后缀匹配。 */
function findSessionDir(home, wanted) {
  const root = nodePath.join(chessRoot(home), "sessions");
  if (!nodeFs.existsSync(root)) return { dir: null, reason: `没有会话目录：${root}` };
  const all = nodeFs.readdirSync(root).filter((d) => nodeFs.existsSync(nodePath.join(root, d, "graph.json")));
  const exact = all.find((d) => d === wanted);
  if (exact) return { dir: nodePath.join(root, exact), reason: null };
  const hits = all.filter((d) => d.includes(wanted));
  if (hits.length === 1) return { dir: nodePath.join(root, hits[0]), reason: null };
  if (hits.length === 0) return { dir: null, reason: `找不到会话：${wanted}` };
  return { dir: null, reason: `会话 id 不唯一（${hits.length} 个匹配），请给完整 id` };
}

function summarize(container) {
  const chars = container.messages.reduce((a, m) => a + m.text.length, 0);
  const first = container.messages[0];
  const last = container.messages[container.messages.length - 1];
  return {
    sessionId: container.sessionId,
    cwd: container.cwd,
    messages: container.messages.length,
    chars,
    spanSeq: first && last ? [first.seq, last.seq] : null,
    spanTs: first && last && first.ts && last.ts ? [first.ts, last.ts] : null,
  };
}

function loadOne(home, wanted) {
  const { dir, reason } = findSessionDir(home, wanted);
  if (!dir) return { ok: false, reason };
  const loaded = loadSessionGraph(nodePath.join(dir, "graph.json"));
  const container = buildUserRoute(loaded.graph, {
    sessionId: nodePath.basename(dir),
    stats: { graphRevision: loaded.raw?.rev ?? null, sessionEvents: loaded.graph.eventCount ?? null },
  });
  return { ok: true, dir, loaded, container };
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h") || process.argv.length <= 2) {
    process.stdout.write(USAGE);
    return;
  }
  const home = homeDir();
  const write = process.argv.includes("--write");
  const asJson = process.argv.includes("--json");

  if (process.argv.includes("--all")) {
    const root = nodePath.join(chessRoot(home), "sessions");
    if (!nodeFs.existsSync(root)) {
      process.stdout.write(`❌ 没有会话目录：${root}\n`);
      process.exit(3);
    }
    const limit = Number(arg("limit", "200")) || 200;
    const dirs = nodeFs.readdirSync(root).filter((d) => nodeFs.existsSync(nodePath.join(root, d, "graph.json"))).slice(0, limit);
    let sessions = 0, nonEmpty = 0, messages = 0, skippedRepaired = 0, skippedShrink = 0;
    for (const d of dirs) {
      const dir = nodePath.join(root, d);
      let loaded;
      try { loaded = loadSessionGraph(nodePath.join(dir, "graph.json")); } catch { continue; }
      sessions += 1;
      const container = buildUserRoute(loaded.graph, { sessionId: d });
      if (container.messages.length > 0) { nonEmpty += 1; messages += container.messages.length; }
      if (!write) continue;
      if (loaded.deltaError || loaded.badTail) continue;
      const target = nodePath.join(dir, FILE_NAME);
      if (container.messages.length === 0) continue;                 // 空容器不落盘（不留噪音文件）
      const prev = readExistingCount(target);
      if (prev !== null && prev > container.messages.length) { skippedShrink += 1; continue; }
      writeFileAtomic(target, `${JSON.stringify(container, null, 1)}\n`);
    }
    process.stdout.write(`== 会话级棋路导出 ==\n`);
    process.stdout.write(`  home        ${home}\n`);
    process.stdout.write(`  扫描会话    ${sessions}\n`);
    process.stdout.write(`  有手动原话  ${nonEmpty}（${messages} 条）\n`);
    process.stdout.write(`  落盘        ${write ? "是" : "否（演练，加 --write 才写）"}\n`);
    if (write) process.stdout.write(`  跳过（会变少）${skippedShrink} · 跳过（delta 异常）${dirs.length - sessions}\n`);
    process.stdout.write(`\n  提示：C667 之前的图没有 manual 字段，旧会话天然为空 —— 这不是漏抓，是无法回溯。\n`);
    return;
  }

  const wanted = arg("session");
  if (!wanted) {
    process.stdout.write(`❌ 缺 --session（或用 --all）\n\n${USAGE}`);
    process.exit(2);
  }
  const got = loadOne(home, wanted);
  if (!got.ok) {
    process.stdout.write(`❌ ${got.reason}\n`);
    process.exit(3);
  }
  const { dir, loaded, container } = got;
  if (asJson) process.stdout.write(`${JSON.stringify(container, null, 2)}\n`);
  else {
    const s = summarize(container);
    process.stdout.write(`== 会话级棋路 ==\n`);
    process.stdout.write(`  会话        ${s.sessionId}\n`);
    process.stdout.write(`  cwd         ${s.cwd || "(空)"}\n`);
    process.stdout.write(`  手动原话    ${s.messages} 条 · ${s.chars} 字\n`);
    process.stdout.write(`  seq 区间    ${s.spanSeq ? s.spanSeq.join(" → ") : "(无)"}\n`);
    process.stdout.write(`  delta 帧    ${loaded.deltaFrames}${loaded.deltaError ? `（异常：${loaded.deltaError}）` : ""}\n`);
    if (s.messages === 0) {
      process.stdout.write(`\n  ⚠ 本会话没有「手动发送」的原话。可能原因：\n`);
      process.stdout.write(`     · 这是 C667 之前的旧图（当时还没记 manual 字段）—— 无法回溯；\n`);
      process.stdout.write(`     · 这是子代理会话（父代理的委派 prompt 没有 rpcId）；\n`);
      process.stdout.write(`     · 这一局确实没人手打。\n`);
    }
  }

  if (!write) {
    process.stdout.write(`\n（演练：未写盘。加 --write 落到 ${nodePath.join(dir, FILE_NAME)}）\n`);
    return;
  }
  if (loaded.deltaError || loaded.badTail) {
    process.stdout.write(`❌ 图的 delta 异常（${loaded.deltaError ?? "badTail"}）⇒ 拒绝写盘（宁可没有，不要错的）\n`);
    process.exit(3);
  }
  if (container.messages.length === 0) {
    process.stdout.write(`❌ 0 条手动原话 ⇒ 不写空容器（避免噪音文件）\n`);
    process.exit(3);
  }
  const target = nodePath.join(dir, FILE_NAME);
  const prev = readExistingCount(target);
  if (prev !== null && prev > container.messages.length) {
    process.stdout.write(`❌ 已有容器 ${prev} 条 > 本次 ${container.messages.length} 条 ⇒ 拒绝覆盖（防止重建图写丢数据）\n`);
    process.exit(3);
  }
  writeFileAtomic(target, `${JSON.stringify(container, null, 1)}\n`);
  const stat = nodeFs.statSync(target);
  process.stdout.write(`\n✅ 已写 ${target}（${stat.size} B）\n`);
}

function readExistingCount(file) {
  try {
    if (!nodeFs.existsSync(file)) return null;
    const obj = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    return Array.isArray(obj?.messages) ? obj.messages.length : 0;
  } catch {
    return null;
  }
}

if (process.argv[1] && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) main();
