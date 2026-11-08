#!/usr/bin/env node
/**
 * consistency-check.mjs —— 「证据 ↔ 源数据」交叉核对（C200）
 *
 * 为什么需要：C143→C199 一共五次同族事故，都是「某个工具读的不是同一份真相」。
 * 每次都是**人肉比对数字**才发现的。这个脚本把那次比对固化成一条命令：
 *
 *   ① 磁盘真相：逐会话 `loadSessionGraph`（重放 delta）后的 foldMarks 总数、会话数、节点数；
 *   ② 证据：`evidence/live-folds.json` 的 `summary.total` 与 `folds`（**快照**）；
 *   ③ 外部折叠：`ledger-budget.json` 的 `externalFolds`（不重复计入 ①）。
 *
 * 快照语义（C655 后）：证据是 `generatedAt` 时刻的快照。之后磁盘**新增**的 fold 可解释
 * （`newSinceSnapshot`，不算不一致）；**环形淘汰**能严格解释的旧记录缺失也可解释
 * （`evictedSinceSnapshot`，不算篡改）；但以下仍判红：
 *   · 旧 fold 缺失且**解释不了**（删除/源错/证据被改写）—— 必须同时满足：
 *       – 用仍在磁盘上的同会话记录能唯一反查出所属磁盘会话（会话删了/改名了就不算）；
 *       – 该会话在 generatedAt 之后**确有新增** fold（没有追加就不会淘汰）；
 *       – 该会话磁盘折痕数**正好等于**保留上限（没写满就不会淘汰）；
 *       – 缺失条数**正好等于**环形淘汰能解释的条数（超过淘汰数不算）；
 *       – 缺失的**正好是该会话最旧的几条**（环形只从最旧一端淘汰）。
 *   · 磁盘在 generatedAt 前有 fold 不在证据里（证据漏记）；
 *   · 同签名（at+seq）的旧 fold 字段发生变化（非新增差异；session id 脱敏不算改变）；
 *   · 证据里出现 `at > generatedAt` 的记录（生成时不可能存在）。
 * `summary.total` / `summary.manual` 也按可解释淘汰调整：磁盘在 generatedAt 前的条数 +
 * 环形淘汰可解释的条数 = 证据里的条数。判据不依赖 `fold` 索引：环形缓冲淘汰旧 mark 时，
 * 后续记录的 `fold` 序号会整体前移。
 *
 * 边界（必须写清楚，别把这套判据当成"证明"）：记录层能看到的只有「少了哪几条」，所以
 * 「删掉最旧一条 + 新增一条」与「真淘汰」在磁盘上**不可分辨**。本判据保证的是：所有可观测
 * 条件（同会话、写满、快照后确有新增、条数、位置）都与环形语义自洽；要更强就只能让运行时
 * 把淘汰动作本身写进 ledger —— 那是产品改动，不在本脚本里猜。
 *
 * 用法：
 *   node scripts/consistency-check.mjs                 # 默认检查仓库 evidence/
 *   node scripts/consistency-check.mjs --json
 *   DSH_HOME=... node scripts/consistency-check.mjs
 *
 * 退出码：0 = 一致；1 = 不一致（或读不到）。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { loadSessionGraph } from "./graph-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

/**
 * 每个会话的折痕保留上限 —— 与 `src/engine.mjs` 的 `FOLD_MARKS_KEEP` **同值**。
 *
 * 为什么不 import 引擎：`src/engine.mjs` 要拉宿主的 peer 依赖（`@deepseek-ai/dsh-*`），
 * 而本脚本是**独立复核**，不该跟着在途改动一起漂移。这里复制同一个数字，并用测试直接读
 * `src/engine.mjs` 的 `const FOLD_MARKS_KEEP = <n>` 锁死 —— 引擎改了而上限没跟，测试会红。
 *
 * 语义（`recordFoldMark` / `compactIfNeeded` / tier2 三处 push 后的同一行）：
 *   `if (g.foldMarks.length > FOLD_MARKS_KEEP) g.foldMarks = g.foldMarks.slice(-FOLD_MARKS_KEEP);`
 * 即：**写满之后每次追加，都会从最旧一端挤掉同样多的记录**。所以「旧记录不见」只有在
 * 「同会话写满 + 快照后确有新增 + 缺失的正是最旧那几条」时才可能是淘汰。
 */
export const FOLD_MARKS_KEEP = 20;

/** 按「环形里的先后」排：`fold` 是快照当时的数组下标（越小越旧）；缺失时退回 `at`。 */
function oldestFirst(a, b) {
  const fa = Number.isFinite(Number(a?.fold)) ? Number(a.fold) : Number.POSITIVE_INFINITY;
  const fb = Number.isFinite(Number(b?.fold)) ? Number(b.fold) : Number.POSITIVE_INFINITY;
  if (fa !== fb) return fa - fb;
  return (Number(a?.at ?? 0) || 0) - (Number(b?.at ?? 0) || 0);
}

function resolveHome() {
  const env = process.env.DSH_HOME;
  return env && env.trim().length > 0 ? env.trim() : nodePath.join(nodeOs.homedir(), ".dsh");
}

/**
 * 记录签名：at + seq 区间 + 有无区间。
 * `fold` 是环形缓冲里的位置（淘汰/追加会整体前移）；`sessionId` 可能被隐私脱敏改写；
 * 二者都不进签名 —— fold 的稳定身份是「什么时间、折了哪段」。
 */
function recordKey(record) {
  const at = record?.at ?? "";
  const start = record?.seqStart ?? "";
  const end = record?.seqEnd ?? "";
  const ranged = record?.hasRange === false ? "manual" : "ranged";
  return `${at}|${start}|${end}|${ranged}`;
}

/**
 * 字段级稳定序列化：去掉 `fold`（位置会变）与 `sessionId`（隐私脱敏可改写），
 * 并排序对象键避免键序假差异。其余字段（trigger/区间/成本/quality/closure/boundary/...）都参与比较。
 */
function comparableRecord(record) {
  const { fold, sessionId, ...rest } = record ?? {};
  return JSON.stringify(rest, (key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]));
    }
    return value;
  });
}

/**
 * 磁盘 foldMark → 与 live-folds `folds` 同形状的记录（**本地实现**）。
 *
 * 为什么不 import `live-folds.mjs` 的 `foldRecord`：本脚本是**独立复核**，不能跟着生成器的
 * 在途改动（例如 session id 脱敏）一起漂移；同样的折叠在两侧必须摊成同一形状才能逐字段比较。
 */
function diskRecord(sessionId, index, mark) {
  const quality = mark?.quality ?? null;
  const closure = mark?.closure ?? null;
  const usage = mark?.usage ?? null;
  const shadowed = Number(mark?.shadowedTokens ?? quality?.shadowedTokens ?? 0);
  const input = Number(usage?.inputTokens ?? 0);
  return {
    sessionId,
    fold: index + 1,
    at: Number(mark?.at ?? 0) || null,
    trigger: typeof mark?.trigger === "string" ? mark.trigger : null,
    seqStart: mark?.seqStart ?? null,
    seqEnd: mark?.seqEnd ?? null,
    hasRange: Number.isFinite(Number(mark?.seqStart)) && Number.isFinite(Number(mark?.seqEnd)),
    summaryChars: mark?.summaryChars ?? null,
    shadowedTokens: shadowed,
    inputTokens: input || null,
    outputTokens: Number(usage?.outputTokens ?? 0) || null,
    inputPerShadowed: shadowed > 0 && input > 0 ? Number((input / shadowed).toFixed(2)) : null,
    shadowedShare: shadowed > 0 && input > 0 ? Number((shadowed / input).toFixed(3)) : null,
    ms: Number(mark?.ms ?? 0) || null,
    route: mark?.route ?? null,
    fallback: mark?.fallback ?? null,
    quality: quality
      ? {
          constraintRecall: quality.constraintRecall ?? null,
          failureRecall: quality.failureRecall ?? null,
          compressionRatio: quality.compressionRatio ?? null,
          expectedConstraints: quality.expectedConstraints ?? null,
          expectedFailures: quality.expectedFailures ?? null,
          unknownIds: Array.isArray(quality.unknownIds) ? quality.unknownIds.length : null,
          summaryTokens: quality.summaryTokens ?? null,
        }
      : null,
    closure: closure
      ? {
          nodes: closure.nodes ?? null,
          edges: closure.edges ?? null,
          firstNode: closure.firstNode ?? null,
          lastNode: closure.lastNode ?? null,
          preGraph: typeof closure.preGraph === "boolean" ? closure.preGraph : null,
          graphNodes: closure.graphNodes ?? null,
        }
      : null,
    dangling: mark?.dangling ?? null,
    boundary: mark?.boundary
      ? {
          overlapping: mark.boundary.overlapping ?? null,
          openAtEnd: mark.boundary.openAtEnd ?? null,
          unsettled: mark.boundary.unsettled ?? null,
        }
      : null,
  };
}

/**
 * 证据快照 vs 磁盘记录（纯函数，供 check 与测试使用）。
 *
 * `evidenceFolds` 是 live-folds 的 `folds` 数组（含无区间的 manual 记录）；
 * `diskRecords` 是 `scanDisk` 收集的同一形状记录（`foldRecord` 产出）。
 * `retentionCap` = 每会话折痕保留上限（默认 `FOLD_MARKS_KEEP`，测试可传别的档位）。
 */
export function compareSnapshot({
  evidenceFolds,
  generatedAt,
  evidenceTotal = null,
  evidenceManual = null,
  diskRecords,
  retentionCap = FOLD_MARKS_KEEP,
}) {
  const problems = [];
  if (!Array.isArray(evidenceFolds) || !Array.isArray(diskRecords) || typeof generatedAt !== "string" || !Number.isFinite(Date.parse(generatedAt))) {
    problems.push("证据缺少 generatedAt/folds（旧格式），无法做快照感知核对；先跑 node scripts/live-folds.mjs --write");
    return { snapshot: null, problems };
  }
  const generatedAtMs = Date.parse(generatedAt);
  const cap = Number.isFinite(Number(retentionCap)) && Number(retentionCap) > 0 ? Number(retentionCap) : FOLD_MARKS_KEEP;
  const isNewSinceSnapshot = (record) => typeof record?.at === "number" && record.at > generatedAtMs;
  const evidenceFuture = evidenceFolds.filter(isNewSinceSnapshot);
  const newSinceDisk = diskRecords.filter(isNewSinceSnapshot);
  const oldDisk = diskRecords.filter((record) => !isNewSinceSnapshot(record));

  const evidenceByKey = new Map();
  for (const record of evidenceFolds) {
    const key = recordKey(record);
    if (!evidenceByKey.has(key)) evidenceByKey.set(key, record);
  }
  const diskByKey = new Map();
  for (const record of diskRecords) {
    const key = recordKey(record);
    if (!diskByKey.has(key)) diskByKey.set(key, record);
  }

  /** 证据侧按会话分组（`sessionId` 是脱敏后的 `s_<12hex>`；只用于分组，不写进输出）。 */
  const evidenceBySession = new Map();
  for (const record of evidenceFolds) {
    const id = String(record?.sessionId ?? "");
    if (!evidenceBySession.has(id)) evidenceBySession.set(id, []);
    evidenceBySession.get(id).push(record);
  }
  /** 磁盘侧按会话目录名分组。 */
  const diskBySession = new Map();
  for (const record of diskRecords) {
    const id = String(record?.sessionId ?? "");
    if (!diskBySession.has(id)) diskBySession.set(id, []);
    diskBySession.get(id).push(record);
  }

  const missingFromDisk = evidenceFolds.filter((record) => !diskByKey.has(recordKey(record)));

  /**
   * 环形淘汰解释（C656）：把「证据里记过、磁盘上没有」的记录逐会话判定。
   *
   * 纯粹的「缺失」和「淘汰」在磁盘上看不出差别 —— 只有把**环形语义**当判据才能在
   * 不冤枉淘汰的同时抓住删除。五条**同时**成立才算淘汰，任何一条不成立都算真缺失：
   *   ① 同会话：用仍在磁盘上的同会话记录反查（证据 id 已脱敏，不能直接和目录名比）；
   *   ② 快照后确有新增：`k > 0`（没有追加就没有淘汰）；
   *   ③ 会话写满：磁盘折痕数 === 保留上限（没写满就不会 `slice(-cap)`）；
   *   ④ 条数对得上：缺失数 === max(0, 证据条数 + k - cap)（超过 = 删多了）；
   *   ⑤ 位置对得上：缺失的正是该会话**最旧**的几条（环形只从最旧一端淘汰）。
   */
  const evicted = [];
  const unexplained = [];
  const denyReasons = new Map();
  const deny = (records, reason) => {
    unexplained.push(...records);
    denyReasons.set(reason, (denyReasons.get(reason) ?? 0) + records.length);
  };
  const missingBySession = new Map();
  for (const record of missingFromDisk) {
    const id = String(record?.sessionId ?? "");
    if (!missingBySession.has(id)) missingBySession.set(id, []);
    missingBySession.get(id).push(record);
  }
  for (const [sessionId, missing] of missingBySession) {
    const group = evidenceBySession.get(sessionId) ?? missing;
    // ① 同会话：反查存活记录所属的磁盘会话；不唯一就不解释（会话被删/改名、证据被改写）。
    const survivorSessions = new Set();
    for (const record of group) {
      const hit = diskByKey.get(recordKey(record));
      if (hit !== undefined && hit !== null) survivorSessions.add(String(hit.sessionId ?? ""));
    }
    if (survivorSessions.size !== 1) {
      deny(missing, "找不到唯一的所属磁盘会话（会话被删/改名，或证据被改写）");
      continue;
    }
    const diskGroup = diskBySession.get([...survivorSessions][0]) ?? [];
    const newSince = diskGroup.filter(isNewSinceSnapshot).length;
    const explainable = Math.max(0, group.length + newSince - cap);
    // 逐条判据**各自独立**给结论：不满足的条条列出来，而不是"命中第一条就返回"——
    // 这样人看到的是「为什么不能算淘汰」的全部理由（缺几条、没写满、没新增、位置不对）。
    const failures = [];
    const staleOld = diskGroup.filter((record) => !isNewSinceSnapshot(record) && !evidenceByKey.has(recordKey(record)));
    if (staleOld.length > 0) failures.push("该会话在 generatedAt 前的磁盘记录不全在证据里（快照本身漏记，不能拿淘汰解释）");
    // ② 快照后确有新增。
    if (newSince <= 0) failures.push("该会话快照后没有新增 fold（没有追加就不会淘汰）");
    // ③ 会话写满（写满才会在追加时 `slice(-cap)` 淘汰最旧的那条）。
    if (diskGroup.length !== cap) failures.push(`该会话磁盘 ${diskGroup.length} 条 ≠ 保留上限 ${cap}（没写满就不会淘汰）`);
    // ④ 条数对得上。`group.length` 含 manual 记录 —— 环形缓冲数的是折痕条数，不分 manual。
    if (missing.length !== explainable) failures.push(`缺失 ${missing.length} 条 ≠ 环形淘汰能解释的 ${explainable} 条（超过淘汰数）`);
    // ⑤ 位置对得上：环形从最旧一端淘汰。
    const oldestKeys = [...group].sort(oldestFirst).slice(0, missing.length).map(recordKey).sort().join("\n");
    const missingKeys = [...missing].map(recordKey).sort().join("\n");
    if (oldestKeys !== missingKeys) failures.push("缺失的不是该会话最旧的记录（环形只从最旧一端淘汰）");
    if (failures.length > 0) {
      deny(missing, failures.join("；"));
      continue;
    }
    evicted.push(...missing);
  }

  const evictedRanged = evicted.filter((record) => record?.hasRange !== false).length;
  const evictedManual = evicted.length - evictedRanged;
  const oldRanged = oldDisk.filter((record) => record?.hasRange !== false).length;
  const oldManual = oldDisk.filter((record) => record?.hasRange === false).length;
  const missingFromEvidence = oldDisk.filter((record) => !evidenceByKey.has(recordKey(record)));
  const changed = [];
  for (const record of evidenceFolds) {
    const diskRecord = diskByKey.get(recordKey(record));
    if (diskRecord && comparableRecord(record) !== comparableRecord(diskRecord)) changed.push(record);
  }

  const snapshot = {
    generatedAt,
    retentionCap: cap,
    evidenceRecords: evidenceFolds.length,
    diskOldRecords: oldDisk.length,
    newSinceSnapshot: newSinceDisk.length,
    evidenceFuture: evidenceFuture.length,
    missingFromDisk: missingFromDisk.length,
    evictedSinceSnapshot: evicted.length,
    unexplainedMissing: unexplained.length,
    missingFromEvidence: missingFromEvidence.length,
    changed: changed.length,
  };

  if (evidenceFuture.length > 0) {
    problems.push(`证据含 ${evidenceFuture.length} 条 at > generatedAt 的记录（生成时不应存在；证据被改写或 generatedAt 不实）`);
  }
  // `summary.total` / `summary.manual` 的「可解释淘汰」扣减：旧记录少了多少、证据里就少算多少。
  if (Number.isFinite(evidenceTotal) && evidenceTotal !== oldRanged + evictedRanged) {
    problems.push(
      `证据 fold 数 ${evidenceTotal} ≠ 磁盘在 generatedAt 前的 ${oldRanged} 条 ranged fold` +
        (evictedRanged > 0 ? ` + 环形淘汰可解释的 ${evictedRanged} 条` : "（跑 --write 或核对 generatedAt）"),
    );
  }
  if (Number.isFinite(evidenceManual) && evidenceManual !== oldManual + evictedManual) {
    problems.push(
      `证据 manual 记录 ${evidenceManual} ≠ 磁盘在 generatedAt 前的 ${oldManual} 条 manual` +
        (evictedManual > 0 ? ` + 环形淘汰可解释的 ${evictedManual} 条` : ""),
    );
  }
  if (unexplained.length > 0) {
    // 原因按条数排序、最多列 5 类：会话多的时候（例如整个 home 换过）逐条贴会撑爆输出。
    const ranked = [...denyReasons.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked.slice(0, 5).map(([reason, count]) => `${count} 条：${reason}`);
    const more = ranked.length > top.length ? `（另有 ${ranked.length - top.length} 类原因未展开）` : "";
    problems.push(`证据有 ${unexplained.length} 条记录不在磁盘（旧 fold 缺失，环形淘汰解释不了）：${top.join("；")}${more}`);
  }
  if (missingFromEvidence.length > 0) {
    problems.push(`磁盘在 generatedAt 前有 ${missingFromEvidence.length} 条 fold 不在证据（证据漏记/源错）`);
  }
  if (changed.length > 0) {
    problems.push(`${changed.length} 条同签名旧 fold 字段不一致（非新增差异）`);
  }
  return { snapshot, problems };
}

/** 磁盘真相：重放 delta 后逐会话统计；`records` 与 live-folds 的 folds 同形状，供快照核对。 */
export function scanDisk(home) {
  const sessionsRoot = nodePath.join(home, "chess-context", "sessions");
  const out = { sessions: 0, foldMarks: 0, manualMarks: 0, nodes: 0, edges: 0, unreadable: 0, deltaOnlyMarks: 0, records: [] };
  if (!nodeFs.existsSync(sessionsRoot)) return out;
  for (const name of nodeFs.readdirSync(sessionsRoot)) {
    const graphFile = nodePath.join(sessionsRoot, name, "graph.json");
    if (!nodeFs.existsSync(graphFile)) continue;
    out.sessions += 1;
    let replayed;
    try {
      replayed = loadSessionGraph(graphFile).graph;
    } catch {
      out.unreadable += 1;
      continue;
    }
    // ★ C211：`recordFoldMark(range=null)` 的手工压缩记录没有区间 ⇒ 不算「区间折叠」，
    //   否则证据（live-folds 只数有区间的）与磁盘永远差 1。
    const marks = replayed.foldMarks ?? [];
    marks.forEach((mark, index) => {
      if (Number.isFinite(Number(mark?.seqStart)) && Number.isFinite(Number(mark?.seqEnd))) out.foldMarks += 1;
      else out.manualMarks += 1;
      out.records.push(diskRecord(name, index, mark));
    });
    out.nodes += Object.keys(replayed.nodes ?? {}).length;
    out.edges += Object.keys(replayed.edges ?? {}).length;
    // 基线里没有、但重放后有的 foldMark ⇒ 说明「只读基线」的工具会漏（C199 的病根）
    try {
      const raw = JSON.parse(nodeFs.readFileSync(graphFile, "utf8"));
      const rawCount = Array.isArray(raw.foldMarks) ? raw.foldMarks.length : 0;
      const replayedCount = marks.length;
      if (replayedCount > rawCount) out.deltaOnlyMarks += replayedCount - rawCount;
    } catch {
      /* 基线坏了，上面已经算 unreadable 或仍可 replay */
    }
  }
  return out;
}

/** 证据文件与预算账本。 */
export function readEvidence(home) {
  const out = {
    evidenceTotal: null,
    evidencePath: null,
    generatedAt: null,
    folds: null,
    manual: null,
    externalFolds: null,
    budgetPath: null,
  };
  const evidencePath = nodePath.join(REPO, "evidence", "live-folds.json");
  out.evidencePath = evidencePath;
  if (nodeFs.existsSync(evidencePath)) {
    try {
      const parsed = JSON.parse(nodeFs.readFileSync(evidencePath, "utf8"));
      out.evidenceTotal = Number(parsed?.summary?.total ?? NaN);
      out.generatedAt = typeof parsed?.generatedAt === "string" ? parsed.generatedAt : null;
      out.folds = Array.isArray(parsed?.folds) ? parsed.folds : null;
      out.manual = Number.isFinite(Number(parsed?.summary?.manual)) ? Number(parsed.summary.manual) : null;
    } catch {
      out.evidenceTotal = NaN;
    }
  }
  const budgetPath = nodePath.join(home, "chess-context", "ledger-budget.json");
  out.budgetPath = budgetPath;
  if (nodeFs.existsSync(budgetPath)) {
    try {
      out.externalFolds = Number(JSON.parse(nodeFs.readFileSync(budgetPath, "utf8"))?.externalFolds ?? 0);
    } catch {
      out.externalFolds = NaN;
    }
  }
  return out;
}

export function check({ home = resolveHome() } = {}) {
  const { records: diskRecords, ...disk } = scanDisk(home);
  const { folds: evidenceFolds, ...evidence } = readEvidence(home);
  const problems = [];
  let snapshot = null;
  if (disk.unreadable > 0) problems.push(`${disk.unreadable} 个会话的图读不出来（先跑 graph-audit 看具体会话）`);
  if (evidence.evidenceTotal === null) {
    problems.push("没有 evidence/live-folds.json（先跑 node scripts/live-folds.mjs --write）");
  } else if (!Number.isFinite(evidence.evidenceTotal)) {
    problems.push("evidence/live-folds.json 里的 summary.total 不是数字");
  } else if (!Array.isArray(evidenceFolds) || evidence.generatedAt === null) {
    problems.push("证据缺少 generatedAt/folds（旧格式），无法做快照感知核对；先跑 node scripts/live-folds.mjs --write");
    if (evidence.evidenceTotal !== disk.foldMarks) {
      problems.push(
        `证据 fold 数 ${evidence.evidenceTotal} ≠ 磁盘 ${disk.foldMarks}` +
          (disk.deltaOnlyMarks > 0 ? `（其中 ${disk.deltaOnlyMarks} 条只在 delta 里 ⇒ 证据过期，跑 --write）` : "（证据过期或工具读错源，跑 --write 再判断）"),
      );
    }
  } else {
    const compared = compareSnapshot({
      evidenceFolds,
      generatedAt: evidence.generatedAt,
      evidenceTotal: evidence.evidenceTotal,
      evidenceManual: evidence.manual,
      diskRecords,
    });
    snapshot = compared.snapshot;
    problems.push(...compared.problems);
  }
  if (!Number.isFinite(evidence.externalFolds)) problems.push("ledger-budget.json 读不出（externalFolds 无法核对）");
  return { home, disk, evidence, snapshot, problems, ok: problems.length === 0 };
}

function main() {
  const json = process.argv.includes("--json");
  const result = check();
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + String.fromCharCode(10));
  } else {
    const d = result.disk;
    process.stdout.write(`一致性核对：${result.home}` + String.fromCharCode(10));
    process.stdout.write(`  磁盘（重放 delta）：${d.sessions} 会话 / ${d.nodes} 节点 / ${d.edges} 边 / ${d.foldMarks} 条 foldMark` + String.fromCharCode(10));
    process.stdout.write(
      `  证据 live-folds.json：${result.evidence.evidenceTotal ?? "—"} 次 fold` +
        (result.evidence.generatedAt ? `（generatedAt ${result.evidence.generatedAt}）` : "") +
        String.fromCharCode(10),
    );
    if (result.snapshot) {
      const s = result.snapshot;
      process.stdout.write(
        `  快照核对：旧记录 ${s.diskOldRecords} 条；快照后新增 ${s.newSinceSnapshot} 条（可解释）；环形淘汰 ${s.evictedSinceSnapshot} 条（可解释）；缺失 ${s.missingFromDisk} / 漏记 ${s.missingFromEvidence} / 字段变 ${s.changed}` +
          String.fromCharCode(10),
      );
    }
    process.stdout.write(`  外部折叠（宿主直调）：${result.evidence.externalFolds ?? "—"} 次` + String.fromCharCode(10));
    if (d.deltaOnlyMarks > 0) process.stdout.write(`  · 其中 ${d.deltaOnlyMarks} 条 foldMark 只在 delta 里（只读基线的工具会漏）` + String.fromCharCode(10));
    const newSince = result.snapshot?.newSinceSnapshot ?? 0;
    const evicted = result.snapshot?.evictedSinceSnapshot ?? 0;
    const suffix =
      result.ok && (newSince > 0 || evicted > 0)
        ? `（快照后新增 ${newSince} 条 fold 可解释${evicted > 0 ? `；环形淘汰 ${evicted} 条可解释` : ""}）`
        : "";
    process.stdout.write((result.ok ? `✅ 一致${suffix}` : `❌ ${result.problems.length} 处不一致：${result.problems.join(" / ")}`) + String.fromCharCode(10));
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url))) main();