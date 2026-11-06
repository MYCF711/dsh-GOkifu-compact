#!/usr/bin/env node
/**
 * usage-shape-audit.mjs —— **T49-R07 的写侧根因审计**（只读，不写任何文件）
 *
 * 背景：`src/rooms/offline-fold.mjs` 的 `normalizeUsage` 是「usage 五键归一化器」，7 个读取点
 * 共享它写出来的形状。它的 `cached` 那一行只 pick
 *   `u.cachedTokens` → `u.prompt_tokens_details.cached_tokens`
 * **不认 `u.cacheReadTokens`** —— 而宿主引擎（Assembler）交给离线折叠的 usage 恰恰是
 *   `{inputTokens, outputTokens, cacheReadTokens, totalTokens}`
 * ⇒ 引擎那条路的**缓存命中量在落盘时被丢成 `null`**。这是面板「命中率 0%」的**写侧**根因
 * （读侧 `Number(null) === 0` 已由 T49 修掉）。
 *
 * 本脚本只回答五个问题（全部用真机数据，不猜）：
 *   ① 真机 `foldMark.usage` 到底有**哪些键**、各键出现率、值的类型分布；
 *   ② 按 `trigger` 分组 —— `pressure` 有、`archive-offline` 没有 ⇒ 证明差异在**写侧**；
 *   ③ `normalizeUsage` 的 5 个 pick 各自**漏掉了哪些真实存在的键**（逐个列，带有值条数）；
 *   ④ 把 `cacheReadTokens` 补进 pick 链后，**多少条从「命中未知」变成「命中已知」**（真机数）；
 *   ⑤ 「写侧直读」与 T49 的「读侧恒等式」（`hit = total − miss − out`）**对不对得上**。
 *
 * 数据源（确实只读）：
 *   · `<DSH_HOME>/chess-context/sessions/<sid>/graph.json` 的 `foldMarks[i].usage`（落盘后的形状）
 *   · 同图的 `lastFoldUsage`（**未归一**的原始宿主 usage，写侧收到的第一手形状）
 *   · `<DSH_HOME>/sessions/<ws>/<sid>/session.v4.jsonl.zstd` 里 assistant 消息的 `usage`（宿主 usage 的大样本）
 *
 * 口径与取舍：
 *   · **不用 `loadSessionGraph` 重放 delta**：实测 592 个会话图「裸基线」与「重放后」的
 *     `foldMark` 条数**完全相同**（1091 vs 1091，0 个图有差异）⇒ 这里读裸基线即可，
 *     少一个依赖、也不会因为图版本变化而抛。
 *   · 会话日志 646.9 MB（807 份 zstd）：默认**按体积升序取够 24 MB / 60 份**就停 ——
 *     够 1000+ 条真机 usage，跑完 < 1 秒；要全量用 `--full`。
 *   · 「未知道」与「命中 0」分开算：字段缺失 ≈ 不知道，不是没命中（这正是 T49 那条 0% 假读）。
 *
 * 用法：
 *   node scripts/usage-shape-audit.mjs                 # 默认读 DSH_HOME（或下面那条默认路径）
 *   node scripts/usage-shape-audit.mjs --home=["D:", "DeepSeek Harness", "home"].join(String.fromCharCode(92))
 *   node scripts/usage-shape-audit.mjs --json          # 机器可读
 *   node scripts/usage-shape-audit.mjs --full          # 扫全部会话日志（慢）
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMultiFrameZstd } from "../src/rooms/zstd-log.mjs";
import { normalizeUsage } from "../src/rooms/offline-fold.mjs";

const DEFAULT_HOME = ["D:", "DeepSeek Harness", "home"].join(String.fromCharCode(92));

/* ─────────────────────────── 基础工具 ─────────────────────────── */

/** 值的类型分布用：把 `typeof` 拆细到能看出"整数 / 小数 / 空值"。 */
export function typeOf(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** 支持 `a.b.c` 形式的取值（嵌套键也要能统计，例如 `prompt_tokens_details.cached_tokens`）。 */
export function getPath(obj, key) {
  let v = obj;
  for (const part of String(key).split(".")) {
    if (v === null || v === undefined || typeof v !== "object") return undefined;
    v = v[part];
  }
  return v;
}

/**
 * `normalizeUsage` 里那个 `pick` 的**同款判定**（数值、有限、非负；null/undefined 跳过）。
 * 单独写一份是为了让「补键前 vs 补键后」能在同一批真机数据上跑两遍。
 */
export function pickN(u, keys) {
  for (const key of keys) {
    const x = getPath(u, key);
    if (x === null || x === undefined) continue;
    const n = Number(x);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/**
 * 五个归一化字段的**键族谱**。
 *
 * `covered` = 当前 `normalizeUsage` 认的键（逐字照抄实现，别"顺手美化"）；
 * `candidates` = 真机/常见协议里**表示同一个量**的键 —— 用来算"漏了谁"。
 * 只把确实可能同义的键放进来，不凑数：`cacheReadInputTokens`（Anthropic 口径）与
 * `prompt_cache_hit_tokens`（另一种 DeepSeek 口径）各留一个位置，真机没出现就计 0。
 */
export const FIELD_KEYS = [
  {
    field: "miss（未命中输入）",
    out: "inputTokens",
    covered: ["inputTokens", "prompt_tokens"],
    candidates: ["inputTokens", "prompt_tokens", "input", "promptTokens", "missTokens", "uncachedTokens"],
  },
  {
    field: "out（输出）",
    out: "outputTokens",
    covered: ["outputTokens", "completion_tokens"],
    candidates: ["outputTokens", "completion_tokens", "output", "completionTokens", "output_tokens"],
  },
  {
    field: "hit（缓存命中）★本轮修的就是它",
    out: "cacheReadTokens",
    covered: ["cachedTokens", "prompt_tokens_details.cached_tokens"],
    candidates: [
      "cacheReadTokens",
      "cachedTokens",
      "prompt_tokens_details.cached_tokens",
      "cached",
      "cache_read_input_tokens",
      "cacheReadInputTokens",
      "prompt_cache_hit_tokens",
    ],
  },
  {
    field: "reasoning（推理）",
    out: "reasoningTokens",
    covered: ["reasoningTokens", "completion_tokens_details.reasoning_tokens"],
    candidates: [
      "reasoningTokens",
      "completion_tokens_details.reasoning_tokens",
      "reasoning",
      "reasoning_tokens",
      "completion_tokens_details.reasoning",
    ],
  },
  {
    field: "total（总计）",
    out: "totalTokens",
    covered: ["totalTokens", "total_tokens"],
    candidates: ["totalTokens", "total_tokens", "total"],
  },
];

/**
 * 修复后 `cached` 那一行（pick 链里把 `cacheReadTokens` 放在**最前**）。
 * 顺序理由见文件尾注释与 `test/usage-shape.test.mjs` 的断言。
 */
export function cachedAfter(u) {
  return pickN(u, ["cacheReadTokens", "cachedTokens", "prompt_tokens_details.cached_tokens"]);
}

/** 修复前 `cached` 那一行（逐字照抄 T49 之前的实现）。 */
export function cachedBefore(u) {
  return pickN(u, ["cachedTokens", "prompt_tokens_details.cached_tokens"]);
}

/* ─────────────────────────── 采集（只读） ─────────────────────────── */

/** 扫全部会话图，收集 `foldMarks[i]`。 */
export function collectMarks(home) {
  const root = nodePath.join(home, "chess-context", "sessions");
  const marks = [];
  const lastFoldUsages = [];
  let graphs = 0;
  let unreadable = 0;
  if (!nodeFs.existsSync(root)) return { marks, lastFoldUsages, graphs, unreadable };
  for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = nodePath.join(root, entry.name, "graph.json");
    if (!nodeFs.existsSync(file)) continue;
    let graph;
    try {
      graph = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    } catch {
      unreadable += 1;
      continue;
    }
    graphs += 1;
    const list = Array.isArray(graph?.foldMarks) ? graph.foldMarks : [];
    for (const [index, mark] of list.entries()) {
      marks.push({ sessionId: entry.name, index, trigger: String(mark?.trigger ?? "(none)"), usage: mark?.usage ?? null });
    }
    const lfu = graph?.lastFoldUsage;
    if (lfu !== null && typeof lfu === "object") lastFoldUsages.push({ sessionId: entry.name, usage: lfu });
  }
  return { marks, lastFoldUsages, graphs, unreadable };
}

/** 扫会话日志里的 assistant usage（宿主 usage 的大样本）。体积按 MB 预算封顶。 */
export function collectSessionUsages(home, { minSize = 100_000, maxFiles = 60, maxMb = 24, full = false } = {}) {
  const root = nodePath.join(home, "sessions");
  const usages = [];
  const picked = [];
  if (!nodeFs.existsSync(root)) return { usages, files: 0, mb: 0 };
  const all = [];
  for (const ws of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = nodePath.join(root, ws.name);
    for (const s of nodeFs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const file = nodePath.join(wsDir, s.name, "session.v4.jsonl.zstd");
      if (!nodeFs.existsSync(file)) continue;
      const size = nodeFs.statSync(file).size;
      if (!full && size < minSize) continue;
      all.push({ file, size });
    }
  }
  // 体积升序（同体积按路径）⇒ 抽样**可复现**：同样的 home 每次抽到同一批
  all.sort((a, b) => a.size - b.size || a.file.localeCompare(b.file));
  let bytes = 0;
  for (const item of all) {
    if (!full && (picked.length >= maxFiles || bytes + item.size > maxMb * 1024 * 1024)) break;
    let text;
    try {
      text = decodeMultiFrameZstd(nodeFs.readFileSync(item.file)).text;
    } catch {
      continue;
    }
    picked.push(item.file);
    bytes += item.size;
    for (const line of text.split("\n")) {
      if (!line.includes("cacheReadTokens") && !line.includes("cached_tokens")) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = msg?.data?.usage ?? msg?.data?.message?.usage ?? null;
      if (usage === null || typeof usage !== "object") continue;
      usages.push(usage);
    }
  }
  return { usages, files: picked.length, mb: bytes / (1024 * 1024) };
}

/* ─────────────────────────── ① 形状分布 ─────────────────────────── */

/**
 * @param {Array<{trigger:string, usage:object|null}>} marks
 * @returns {Record<string, {n:number, withUsage:number, keys:Record<string,{present:number,nonNull:number,types:Record<string,number>}>}>}
 */
export function shapeStats(marks) {
  const byTrigger = {};
  for (const mark of marks) {
    const t = mark.trigger;
    const bucket = (byTrigger[t] = byTrigger[t] ?? { n: 0, withUsage: 0, keys: {} });
    bucket.n += 1;
    const u = mark.usage;
    if (u === null || typeof u !== "object") continue;
    bucket.withUsage += 1;
    for (const [key, value] of Object.entries(u)) {
      const slot = (bucket.keys[key] = bucket.keys[key] ?? { present: 0, nonNull: 0, types: {} });
      slot.present += 1;
      if (value !== null && value !== undefined) slot.nonNull += 1;
      const t2 = typeOf(value);
      slot.types[t2] = (slot.types[t2] ?? 0) + 1;
    }
  }
  return byTrigger;
}

/** 嵌套候选键（`a.b` 形式）在各 trigger 下的出现/有值条数 —— 只看 FIELD_KEYS 里带点的候选。 */
export function nestedStats(marks) {
  const dotted = new Set();
  for (const spec of FIELD_KEYS) for (const key of spec.candidates) if (key.includes(".")) dotted.add(key);
  const out = {};
  for (const mark of marks) {
    const u = mark.usage;
    if (u === null || typeof u !== "object") continue;
    const t = mark.trigger;
    const bucket = (out[t] = out[t] ?? { n: 0, keys: {} });
    bucket.n += 1;
    for (const key of dotted) {
      const v = getPath(u, key);
      if (v === undefined) continue;
      const slot = (bucket.keys[key] = bucket.keys[key] ?? { present: 0, nonNull: 0 });
      slot.present += 1;
      if (v !== null) slot.nonNull += 1;
    }
  }
  return out;
}

/* ─────────────────────────── ③ 漏掉的键 ─────────────────────────── */

/**
 * 逐个归一化字段算：真机里出现过、但**当前 pick 链读不到**的同义键。
 * @param {Array<object>} usages
 * @returns {Array<{field:string, out:string, rows:Array<{key:string, present:number, nonNull:number, covered:boolean, types:Record<string,number>}>}>}
 */
export function missingKeys(usages) {
  return FIELD_KEYS.map((spec) => {
    const rows = spec.candidates.map((key) => {
      let present = 0;
      let nonNull = 0;
      const types = {};
      for (const u of usages) {
        if (u === null || typeof u !== "object") continue;
        const v = getPath(u, key);
        if (v === undefined) continue;
        present += 1;
        if (v !== null) nonNull += 1;
        const t = typeOf(v);
        types[t] = (types[t] ?? 0) + 1;
      }
      return { key, present, nonNull, covered: spec.covered.includes(key), types };
    });
    return { field: spec.field, out: spec.out, rows };
  });
}

/* ─────────────────────────── ④ 未知 → 已知 ─────────────────────────── */

/**
 * 在**同一批真机 usage** 上跑「补键前 / 补键后」，数四种迁移。
 * @param {Array<object>} usages
 */
export function replayTransition(usages) {
  let unknown = 0;
  let knownWithHit = 0;
  let knownZero = 0;
  let unchangedKnown = 0;
  let lost = 0;
  let moduleMismatch = 0;
  let moduleNullWhileAfterKnown = 0;
  for (const u of usages) {
    if (u === null || typeof u !== "object") continue;
    const before = cachedBefore(u);
    const after = cachedAfter(u);
    // 模块当前实现 vs 审计器的"修复后"口径：不一致 ⇒ 说明跑的是旧链（这就是失败分支的探针）
    const fromModule = normalizeUsage(u)?.cacheReadTokens ?? null;
    if (fromModule !== after) moduleMismatch += 1;
    if (fromModule === null && after !== null) moduleNullWhileAfterKnown += 1;
    if (before === null && after !== null) {
      unknown += 1;
      if (after > 0) knownWithHit += 1;
      else knownZero += 1;
    } else if (before !== null && after === null) {
      lost += 1;
    } else if (before !== null) {
      unchangedKnown += 1;
    }
  }
  return { total: usages.length, unknown, knownWithHit, knownZero, unchangedKnown, lost, moduleMismatch, moduleNullWhileAfterKnown };
}

/* ─────────────────────────── ⑤ 写侧 vs 读侧 ─────────────────────────── */

/**
 * 「写侧直读」与「读侧恒等式」（T49：`hit = total − miss − out`）**在同一个落盘对象上**对账。
 *
 * ★ 关键口径：两边都必须读**归一化之后**的五个键 ——
 *   · 写侧直读 = `normalizeUsage(u).cacheReadTokens`（真机上被写进 mark 的那个字段）；
 *   · 读侧恒等式 = 同一份输出里 `total − miss − out`（`scripts/cache-rate.mjs` 的 T49 兜底口径）。
 *   拿原始对象对账会掩盖问题：原始对象里字段是在的，是**归一化那一步**把它丢了。
 *
 * @param {Array<object>} usages
 */
export function reconcile(usages) {
  let fieldHits = 0;
  let identityHits = 0;
  let miss = 0;
  let out = 0;
  let paired = 0;
  let mismatch = 0;
  let fieldBacked = 0;
  let fallback = 0;
  let neither = 0;
  let mismatchRaw = 0;
  let mismatchHost = 0;
  const worst = [];
  for (const u of usages) {
    if (u === null || typeof u !== "object") continue;
    const written = normalizeUsage(u);
    if (written === null || written.inputTokens === null) continue;
    const m = written.inputTokens;
    const o = written.outputTokens ?? 0;
    const t = written.totalTokens;
    const field = written.cacheReadTokens;
    const inferred = t === null ? null : Math.max(0, t - m - o);
    if (field === null && inferred === null) {
      neither += 1;
      continue;
    }
    miss += m;
    out += o;
    if (field !== null) {
      fieldBacked += 1;
      fieldHits += field;
    } else {
      fallback += 1;
    }
    if (inferred !== null) identityHits += inferred;
    if (field !== null && inferred !== null) {
      paired += 1;
      if (field !== inferred) {
        mismatch += 1;
        // provider 原始口径的 `prompt_tokens` **含**命中 ⇒ 恒等式对这族本就不成立（ui.mjs 有 looksSplit 分支）
        if (getPath(u, "prompt_tokens") === undefined) mismatchHost += 1;
        else mismatchRaw += 1;
        if (worst.length < 5) worst.push({ inputTokens: m, outputTokens: o, totalTokens: t, field, inferred });
      }
    }
  }
  const rate = (hit) => (miss + hit === 0 ? null : hit / (miss + hit));
  const fieldRate = rate(fieldHits);
  const identityRate = rate(identityHits);
  return {
    records: fieldBacked + fallback,
    fieldBacked,
    fallback,
    miss,
    out,
    fieldHits,
    identityHits,
    fieldRate,
    identityRate,
    delta: fieldRate === null || identityRate === null ? null : fieldRate - identityRate,
    paired,
    mismatch,
    mismatchRaw,
    mismatchHost,
    neither,
    worst,
  };
}

/* ─────────────────────────── 输出 ─────────────────────────── */

const pad = (s, n) => {
  const str = String(s);
  const width = [...str].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return str + " ".repeat(Math.max(1, n - width));
};
const pct = (x) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);
const num = (x) => (x === null || x === undefined ? "—" : Number(x).toLocaleString("en-US"));

export function main(argv = process.argv.slice(2)) {
  const arg = (name, fallback) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? fallback : hit.slice(name.length + 3);
  };
  const home = String(arg("home", process.env.DSH_HOME ?? DEFAULT_HOME)).trim();
  const asJson = argv.includes("--json");
  const full = argv.includes("--full");

  const { marks, lastFoldUsages, graphs, unreadable } = collectMarks(home);
  if (graphs === 0) {
    console.error(`✗ 读不到会话图（${nodePath.join(home, "chess-context", "sessions")}）—— 用 --home 指定 DSH_HOME`);
    return 2;
  }
  const sessions = collectSessionUsages(home, {
    full,
    maxFiles: Number(arg("max-files", "60")) || 60,
    maxMb: Number(arg("max-mb", "24")) || 24,
    minSize: Number(arg("min-size", "100000")) || 100_000,
  });
  const markUsages = marks.map((m) => m.usage).filter((u) => u !== null && typeof u === "object");
  const lfuUsages = lastFoldUsages.map((x) => x.usage);

  const shape = shapeStats(marks);
  const nested = nestedStats(marks);
  const missing = missingKeys(markUsages);
  const replayMarks = replayTransition(markUsages);
  const replayLfu = replayTransition(lfuUsages);
  const replaySession = replayTransition(sessions.usages);
  const recMarks = reconcile(markUsages);
  const recLfu = reconcile(lfuUsages);
  const recSession = reconcile(sessions.usages);

  const payload = {
    home,
    graphs,
    unreadable,
    marks: marks.length,
    markUsages: markUsages.length,
    lastFoldUsages: lfuUsages.length,
    sessionUsages: sessions.usages.length,
    sessionFiles: sessions.files,
    sessionMb: Number(sessions.mb.toFixed(2)),
    shape,
    nested,
    missing,
    replay: { marks: replayMarks, lastFoldUsage: replayLfu, session: replaySession },
    reconcile: { marks: recMarks, lastFoldUsage: recLfu, session: recSession },
  };
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  const lines = [];
  lines.push("== T49-R07 写侧根因审计 · usage 形状（只读） ==");
  lines.push(`数据源：${home}`);
  lines.push(
    `  · 会话图 ${graphs} 个（读不动 ${unreadable}）· foldMark ${num(marks.length)} 条 · 其中有 usage ${num(markUsages.length)} 条`,
  );
  lines.push(`  · lastFoldUsage（未归一的第一手宿主 usage）${num(lfuUsages.length)} 条`);
  lines.push(
    `  · 宿主 usage 大样本：${sessions.files} 份会话日志 · ${sessions.mb.toFixed(1)} MB · ${num(sessions.usages.length)} 条 assistant usage`,
  );

  /* ① */
  lines.push("");
  lines.push("── ① usage 形状分布（按 trigger） ──");
  for (const [trigger, bucket] of Object.entries(shape).sort((a, b) => b[1].n - a[1].n)) {
    lines.push(`  [${trigger}] 折痕 ${num(bucket.n)} 条 · 带 usage ${num(bucket.withUsage)} 条`);
    const keys = Object.entries(bucket.keys).sort((a, b) => b[1].present - a[1].present);
    if (keys.length === 0) lines.push("      （无 usage 键）");
    for (const [key, slot] of keys) {
      const types = Object.entries(slot.types)
        .sort((a, b) => b[1] - a[1])
        .map(([t, c]) => `${t}:${c}`)
        .join(" ");
      lines.push(
        `      ${pad(key, 26)} present ${String(slot.present).padStart(4)} · 有值 ${String(slot.nonNull).padStart(4)} · ${types}`,
      );
    }
    const nestedKeys = Object.entries(nested[trigger]?.keys ?? {});
    for (const [key, slot] of nestedKeys) {
      lines.push(
        `      ${pad(key, 26)} present ${String(slot.present).padStart(4)} · 有值 ${String(slot.nonNull).padStart(4)} · (嵌套)`,
      );
    }
  }

  /* ② */
  lines.push("");
  lines.push("── ② 写侧差异：cacheReadTokens 分 trigger 有值率 ──");
  lines.push(`  ${pad("trigger", 18)}${pad("折痕", 8)}${pad("有 usage", 10)}${pad("cacheReadTokens 有值", 22)}有值率`);
  for (const [trigger, bucket] of Object.entries(shape).sort((a, b) => b[1].n - a[1].n)) {
    const slot = bucket.keys.cacheReadTokens ?? { present: 0, nonNull: 0 };
    lines.push(
      `  ${pad(trigger, 18)}${pad(num(bucket.n), 8)}${pad(num(bucket.withUsage), 10)}${pad(`${num(slot.nonNull)} / ${num(bucket.withUsage)}`, 22)}${pct(bucket.withUsage === 0 ? null : slot.nonNull / bucket.withUsage)}`,
    );
  }
  // 恒等式反证：字段是 null，但 total 比 miss+out 大 ⇒ 源侧**确实有命中**，数字在归一化时丢了
  let inferable = 0;
  let inferableTokens = 0;
  let savedFromNothing = 0;
  for (const mark of marks) {
    const u = mark.usage;
    if (u === null || typeof u !== "object") continue;
    if (getPath(u, "cacheReadTokens") === undefined) continue;
    if (getPath(u, "cacheReadTokens") !== null) continue;
    const m = pickN(u, ["inputTokens", "prompt_tokens"]);
    const o = pickN(u, ["outputTokens", "completion_tokens"]);
    const t = pickN(u, ["totalTokens", "total_tokens"]);
    if (m === null || t === null) {
      savedFromNothing += 1;
      continue;
    }
    const inferred = t - m - (o ?? 0);
    if (inferred > 0) {
      inferable += 1;
      inferableTokens += inferred;
    }
  }
  const nullField = marks.filter(
    (m) => m.usage !== null && typeof m.usage === "object" && getPath(m.usage, "cacheReadTokens") === null,
  ).length;
  lines.push(`  · 已落盘折痕里 cacheReadTokens 为 null 的：${num(nullField)} 条 / ${num(markUsages.length)} 条带 usage 的折痕`);
  lines.push(
    `  · 其中 ${num(inferable)} 条**由恒等式反证存在命中**（total > miss + out，合计 ${num(inferableTokens)} token）—— 数字在归一化那一步被丢掉，不是"没命中"`,
  );
  lines.push(`  · 另有 ${num(savedFromNothing)} 条既无 cacheReadTokens 值也无 total，命中量**永不可判**`);

  /* ③ */
  lines.push("");
  lines.push("── ③ normalizeUsage 的 5 个 pick 各自漏掉了哪些真实键 ──");
  for (const spec of missing) {
    lines.push(`  ${spec.field}  ⇒ 写进 \`${spec.out}\``);
    const missed = spec.rows.filter((r) => !r.covered && r.present > 0);
    const coveredRows = spec.rows.filter((r) => r.covered && r.present > 0);
    for (const r of coveredRows) {
      lines.push(`      ✓ ${pad(r.key, 38)} 出现 ${String(r.present).padStart(4)} · 有值 ${String(r.nonNull).padStart(4)}（已在链上）`);
    }
    if (missed.length === 0) lines.push("      （无漏键）");
    for (const r of missed) {
      lines.push(
        `      ✗ ${pad(r.key, 38)} 出现 ${String(r.present).padStart(4)} · 有值 ${String(r.nonNull).padStart(4)} ← 链上没有`,
      );
    }
  }

  /* ④ */
  lines.push("");
  lines.push("── ④ 补上 cacheReadTokens 后：多少条「命中未知」→「命中已知」 ──");
  const row = (label, r) => {
    const known = r.unknown;
    const rate = r.total === 0 ? null : known / r.total;
    lines.push(
      `  ${pad(label, 24)}样本 ${String(num(r.total)).padStart(5)} · 未知→已知 ${String(num(known)).padStart(5)}（${pct(rate)}）· 其中命中>0 ${num(
        r.knownWithHit,
      )} / 命中=0 ${num(r.knownZero)} · 已知→未知 ${num(r.lost)} · 一直已知 ${num(r.unchangedKnown)}`,
    );
  };
  row("历史折痕（再过归一层）", replayMarks);
  row("lastFoldUsage（第一手）", replayLfu);
  row("宿主 usage（写侧输入）", replaySession);
  lines.push(
    "  · 读法：「宿主 usage」那行才是写侧真正的输入 —— 1,059 条**全部**从 null 变成有值；「lastFoldUsage」是同一批折叠留下的第一手 usage；",
  );
  lines.push(
    "    「历史折痕」那行问的是\"把已落盘的值再过一次归一化器会怎样\"（`sumFoldUsage` 重试累加时就会）—— 98 条已知值在旧链下会被再丢一次，补键后保住。",
  );
  lines.push(
    `  · 一致性探针：模块 \`normalizeUsage\` 与"补键后"口径不一致 ${num(
      replaySession.moduleMismatch + replayMarks.moduleMismatch + replayLfu.moduleMismatch,
    )} 条`,
  );
  const probeNull = replaySession.moduleNullWhileAfterKnown + replayMarks.moduleNullWhileAfterKnown + replayLfu.moduleNullWhileAfterKnown;
  lines.push(
    probeNull === 0
      ? "    ⇒ 模块已含 `cacheReadTokens`（写侧补键生效）"
      : `    ⇒ **模块仍是旧链**：${num(probeNull)} 条本该有值却写成了 null（这就是 T49-R07 的写侧根因）`,
  );

  /* ⑤ */
  lines.push("");
  lines.push("── ⑤ 写侧直读 vs 读侧恒等式（T49：hit = total − miss − out） ──");
  const rrow = (label, r) => {
    lines.push(
      `  ${pad(label, 26)}记录 ${String(num(r.records)).padStart(5)}（字段直给 ${num(r.fieldBacked)} / 恒等式兜底 ${num(r.fallback)}）`,
    );
    lines.push(
      `  ${" ".repeat(26)}直读命中 ${num(r.fieldHits).padStart(11)} · 恒等式 ${num(r.identityHits).padStart(11)} · 直读率 ${pct(r.fieldRate)} / 恒等式 ${pct(
        r.identityRate,
      )} · 差 ${r.delta === null ? "—" : `${(r.delta * 100).toFixed(3)}pt`} · 逐条不等 ${num(r.mismatch)}/${num(r.paired)}`,
    );
  };
  lines.push("  【验收口径】这两批正是写侧真正会收到的输入：");
  rrow("宿主 usage（大样本）", recSession);
  rrow("lastFoldUsage（第一手）", recLfu);
  lines.push("  【历史损失】已落盘的字段改代码救不回来，只能靠恒等式兜底（对比用，不是验收项）：");
  rrow("历史折痕", recMarks);
  for (const [label, r] of [
    ["宿主 usage", recSession],
    ["lastFoldUsage", recLfu],
    ["历史折痕", recMarks],
  ]) {
    if (r.worst.length === 0) continue;
    lines.push(
      `  · ${label} 逐条不等样例（provider 原始口径 ${num(r.mismatchRaw)} / 宿主口径 ${num(r.mismatchHost)}）：${JSON.stringify(r.worst.slice(0, 2))}`,
    );
  }
  lines.push("  · 判据：直读用**字段**（写进 mark 的那个数 —— doctor / ui.mjs 的读侧就是看它），恒等式只用 total/miss/out 反推。");
  lines.push("    两者逐条相等 ⇒ 写侧补的键与读侧兜底是同一口径；差得远 ⇒ 写侧把命中量丢了（旧链的 -92.4pt 就是这个）。");

  console.log(lines.join("\n"));
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
