/**
 * evidence-privacy.test.mjs —— 公开证据必须脱敏（t3）
 *
 * 由来：live fold 证据会进公开仓库，而 `graph.json` 的会话目录名是运行时 id、
 * `live-folds.json` 的 `home` 是本机路径 —— 这两类东西在 `privacy-audit --changed` 里
 * 分别命中 `P4-RUNTIME-ID` 与 `P3-PATH`。证据本身要能公开，所以**生成器出口**就必须脱敏：
 *   · `sessionId` 只写稳定 pseudonym `s_<12hex>`（同 id 同名，可加盐）；
 *   · `home` 只写 `<DSH_HOME>`；
 *   · 闭包链 offender / 会话分布 top / 外部折叠的 session 同样只留 pseudonym。
 *
 * 这里钉住四件事：
 *   ① 三份公开证据（json / md / 逐会话表）里**没有**原始 session id、UUID、驱动器路径；
 *   ② pseudonym 的形状与稳定性（同 id 同名、换盐换名）；
 *   ③ 证据 JSON 显式声明「快照、非累计、净变化」；
 *   ④ 采集过程对原始图/账本**只读**（内容、mtime、文件清单都不变）。
 *
 * ⚠ 本文件本身也会被 `privacy-audit` 扫：所以「原始 id 的形状」用字符串拼接构造，
 *   不写完整样本（否则测试自己就是泄露源）。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { HOME_REDACTED, collectLiveFolds, pseudonymOf } from "../scripts/live-folds.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const EVIDENCE_JSON = nodePath.join(REPO, "evidence", "live-folds.json");
const EVIDENCE_MD = nodePath.join(REPO, "evidence", "live-folds.md");
const PER_SESSION_MD = nodePath.join(REPO, "evidence", "fold质量-多会话-2026-11-02.md");

const read = (file) => nodeFs.readFileSync(file, "utf8");

/** UUID 形状（与 privacy-audit 同口径：允许任意版本位，宁可多报）。 */
const UUID_SHAPE = new RegExp(["\\b[0-9a-f]{8}", "[0-9a-f]{4}", "[0-9a-f]{4}", "[0-9a-f]{4}", "[0-9a-f]{12}\\b"].join("-"), "i");
/** 运行时会话目录名形状（`session-` + ≥8 位十六进制 / 完整 UUID）。 */
const SESSION_SHAPE = /\bsession-[0-9a-f]{8}/i;
/** 驱动器绝对路径形状。 */
const DRIVE_SHAPE = /\b[A-Za-z]:[\\/]/;

/** 运行时拼一个「原始 id」样本：既证明扫描器有效，又不把样本写进本文件。 */
const RAW_SAMPLE = ["session", "a1b2c3d4", "e5f6", "4a7b", "8c9d", "e1f2a3b4c5d6"].join("-");
const HOST_WORDS = ["DeepSeek", "Harness"].join(" ");

const PSEUDONYM_RE = /^s_[0-9a-f]{12}$/;

export const tests = {};

tests["EP-1 证据 JSON：home 脱敏 + 快照/非累计/净变化语义显式"] = (t) => {
  const json = JSON.parse(read(EVIDENCE_JSON));
  t.eq(json.home, HOME_REDACTED, `home 必须是 ${HOME_REDACTED}（实际 ${JSON.stringify(json.home)}）`);
  t.eq(json.homeRedacted, true, "必须显式标明 home 已脱敏");
  t.eq(json.semantics?.snapshot, true, "必须标明这是快照");
  t.eq(json.semantics?.notCumulative, true, "必须标明不是累计台账");
  t.eq(json.semantics?.trendIsNetChange, true, "与上次对比必须是净变化口径");
  if (json.trend) t.eq(json.trend.trendKind, "net-change", "trend 必须自带 net-change 标记");
};

tests["EP-2 证据 JSON：每条 fold 的 sessionId 都是 s_<12hex>（没有原始 id）"] = (t) => {
  const json = JSON.parse(read(EVIDENCE_JSON));
  const folds = Array.isArray(json.folds) ? json.folds : [];
  t.eq(folds.length > 0, true, "证据里必须有 fold 记录");
  const bad = folds.filter((f) => !PSEUDONYM_RE.test(String(f?.sessionId ?? "")));
  t.eq(bad.length, 0, `这些 fold 的 sessionId 不是 pseudonym：${bad.slice(0, 5).map((f) => f.sessionId).join(" / ")}`);
  const text = read(EVIDENCE_JSON);
  t.eq(UUID_SHAPE.test(text), false, "证据 JSON 里不许出现 UUID 形状");
  t.eq(SESSION_SHAPE.test(text), false, "证据 JSON 里不许出现 session-<hex> 形状");
  t.eq(DRIVE_SHAPE.test(text), false, "证据 JSON 里不许出现驱动器绝对路径");
  t.eq(text.includes(HOST_WORDS), false, "证据 JSON 里不许出现宿主安装目录名");
};

tests["EP-3 会话分布 top / 闭包链 offender 同样只留 pseudonym"] = (t) => {
  const json = JSON.parse(read(EVIDENCE_JSON));
  const top = json.summary?.bySession?.top ?? [];
  const badTop = top.filter((e) => !PSEUDONYM_RE.test(String(e?.sessionId ?? "")));
  t.eq(badTop.length, 0, `top 榜出现非 pseudonym：${badTop.map((e) => e.sessionId).join(" / ")}`);
  const offenders = json.summary?.closureChain?.offenders ?? [];
  const OFFENDER_RE = /^s_[0-9a-f]{12}:n\d+→n\d+$/;
  const badOffenders = offenders.filter((line) => !OFFENDER_RE.test(String(line)));
  t.eq(badOffenders.length, 0, `闭包链 offender 出现非 pseudonym 形状：${badOffenders.slice(0, 3).join(" / ")}`);
  const thrash = json.summary?.thrash?.list ?? [];
  const badThrash = thrash.filter((e) => !PSEUDONYM_RE.test(String(e?.sessionId ?? "")));
  t.eq(badThrash.length, 0, "foldThrash 列表里的会话也必须脱敏");
};

tests["EP-4 证据 Markdown：无原始 id / 路径，且写明快照语义与净变化"] = (t) => {
  const md = read(EVIDENCE_MD);
  t.includes(md, HOME_REDACTED, "数据源必须写成 <DSH_HOME>");
  t.eq(UUID_SHAPE.test(md), false, "证据页不许出现 UUID 形状");
  t.eq(SESSION_SHAPE.test(md), false, "证据页不许出现 session-<hex> 形状");
  t.eq(DRIVE_SHAPE.test(md), false, "证据页不许出现驱动器绝对路径");
  t.eq(md.includes(HOST_WORDS), false, "证据页不许出现宿主安装目录名");
  for (const needle of ["快照语义", "不是累计台账", "净变化", "累计新增折数"]) {
    t.includes(md, needle, `证据页必须写清快照语义（缺「${needle}」）`);
  }
};

tests["EP-5 逐会话表：会话列全是 pseudonym，且无原始 id / 路径"] = (t) => {
  const doc = read(PER_SESSION_MD);
  t.eq(UUID_SHAPE.test(doc), false, "逐会话表不许出现 UUID 形状");
  t.eq(SESSION_SHAPE.test(doc), false, "逐会话表不许出现 session-<hex> 形状");
  t.eq(DRIVE_SHAPE.test(doc), false, "逐会话表不许出现驱动器绝对路径");
  t.includes(doc, "稳定 pseudonym", "逐会话表要写明会话标识已脱敏");
  const rows = doc.split(String.fromCharCode(10)).filter((line) => /^\| \d+ \| `/.test(line));
  t.eq(rows.length > 0, true, "逐会话表必须有数据行");
  const badRows = rows.filter((line) => !/^\| \d+ \| `s_[0-9a-f]{12}` \|/.test(line));
  t.eq(badRows.length, 0, `这些行的会话列不是 pseudonym：${badRows.slice(0, 3).join(" | ")}`);
};

tests["EP-6 pseudonym：同 id 稳定、不同 id 不同、可加盐（盐不进证据）"] = (t) => {
  const a = pseudonymOf("session-zzz0001");
  t.eq(PSEUDONYM_RE.test(a), true, `格式必须是 s_<12hex>（实际 ${a}）`);
  t.eq(a, pseudonymOf("session-zzz0001"), "同一 id 必须每次同名（快照可比的前提）");
  t.eq(a === pseudonymOf("session-zzz0002"), false, "不同 id 必须是不同 pseudonym");
  const salted = pseudonymOf("session-zzz0001", "private-salt");
  t.eq(salted === a, false, "换盐必须换名（映射可私有）");
  t.eq(salted, pseudonymOf("session-zzz0001", "private-salt"), "同盐同 id 仍必须稳定");
};

tests["EP-7 扫描器自检：原始 id / UUID / 驱动器路径的样本必须被认出"] = (t) => {
  t.eq(SESSION_SHAPE.test(RAW_SAMPLE), true, "session-<uuid> 形状必须被本文件的扫描器认出");
  t.eq(UUID_SHAPE.test(RAW_SAMPLE), true, "UUID 形状必须被认出");
  t.eq(DRIVE_SHAPE.test(["D:", "x"].join("/")), true, "驱动器路径形状必须被认出");
};

tests["EP-8 采集只读：graph / 账本的内容、mtime、文件清单都不变"] = (t) => {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-privacy-ro-"));
  try {
    const sessionsRoot = nodePath.join(root, "chess-context", "sessions");
    const sessionDir = nodePath.join(sessionsRoot, "session-aaa");
    nodeFs.mkdirSync(sessionDir, { recursive: true });
    const graphFile = nodePath.join(sessionDir, "graph.json");
    nodeFs.writeFileSync(
      graphFile,
      JSON.stringify({ nodes: {}, edges: {}, foldMarks: [{ at: 1762200000000, seqStart: 1, seqEnd: 10, trigger: "pressure" }] }, null, 1),
      "utf8",
    );
    const budgetFile = nodePath.join(root, "chess-context", "ledger-budget.json");
    nodeFs.writeFileSync(budgetFile, JSON.stringify({ externalFolds: 1, lastExternalFold: { at: Date.now(), seqStart: 1, seqEnd: 2, session: "session-aaa" } }), "utf8");

    const snapshot = () => {
      const out = {};
      for (const file of [graphFile, budgetFile]) {
        const stat = nodeFs.statSync(file);
        out[file] = { text: nodeFs.readFileSync(file, "utf8"), mtimeMs: stat.mtimeMs, size: stat.size };
      }
      return out;
    };
    const before = snapshot();
    const collected = collectLiveFolds(root);
    const after = snapshot();
    t.eq(JSON.stringify(after), JSON.stringify(before), "采集前后原始文件内容 / mtime / 大小必须完全一致（只读）");
    t.eq(collected.records.length, 1, "采集必须真的读到那条 foldMark");
    t.eq(collected.records[0].sessionId, pseudonymOf("session-aaa"), "采集结果里只能是 pseudonym");
    t.eq(collected.external.last.session, pseudonymOf("session-aaa"), "外部折叠的 session 也必须脱敏");
    const filesAfter = nodeFs.readdirSync(sessionDir).sort();
    t.eq(filesAfter.includes("graph.json") && filesAfter.length === 1, true, "不许在原始会话目录里新建任何文件");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};