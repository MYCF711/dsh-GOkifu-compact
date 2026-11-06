#!/usr/bin/env node
/**
 * k26-coverage-check.mjs —— K-26C 关键事实覆盖（锚点下界）
 *
 * 只读私有 labels 与归档摘要；不调用模型，不把摘要正文写进公开报告。
 * must-keep 清单必须来自原始会话，不能由摘要反推；空清单 = NOT_RUN。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KINDS = new Set(["constraint", "failure", "state", "unverified"]);

export function computeCoverage(summaryText, mustKeep) {
  if (!Array.isArray(mustKeep) || mustKeep.length === 0) {
    return { status: "NOT_RUN", total: 0, matched: 0, coverage: null, missing: [] };
  }
  const text = String(summaryText ?? "");
  const missing = [];
  let matched = 0;
  for (const item of mustKeep) {
    const anchor = typeof item?.anchor === "string" ? item.anchor.trim() : "";
    if (anchor !== "" && text.includes(anchor)) matched += 1;
    else missing.push({ kind: item?.kind ?? "unknown", sourceSeq: item?.sourceSeq ?? null, anchor });
  }
  return { status: "OK", total: mustKeep.length, matched, coverage: matched / mustKeep.length, missing };
}

export function validateMustKeep(mustKeep) {
  const errors = [];
  for (const [i, item] of (Array.isArray(mustKeep) ? mustKeep : []).entries()) {
    if (!KINDS.has(item?.kind)) errors.push(`mustKeep[${i}] kind invalid`);
    if (typeof item?.text !== "string" || item.text.trim() === "") errors.push(`mustKeep[${i}] text missing`);
    if (!Number.isInteger(item?.sourceSeq)) errors.push(`mustKeep[${i}] sourceSeq missing`);
    if (typeof item?.anchor !== "string" || item.anchor.trim() === "") errors.push(`mustKeep[${i}] anchor missing`);
  }
  return errors;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function run({ labelsPath, home }) {
  const rows = fs.readFileSync(labelsPath, "utf8").trim().split(/\n/).filter(Boolean).map(JSON.parse);
  const manifest = readJson(path.join(path.dirname(labelsPath), "manifest.json"));
  const byId = new Map(manifest.samples.map((s) => [s.sampleId, s]));
  const samples = [];
  for (const row of rows) {
    const sample = byId.get(row.sampleId);
    const mustKeep = row.mustKeep ?? [];
    const errors = validateMustKeep(mustKeep);
    if (!sample || errors.length > 0) {
      samples.push({ sampleId: row.sampleId, status: "INVALID", errors, ...computeCoverage("", []) });
      continue;
    }
    let summary = "";
    try {
      summary = String(readJson(path.join(home, sample.graphPath)).lastOfflineSummary?.text ?? "");
    } catch {
      samples.push({ sampleId: row.sampleId, status: "READ_ERROR", errors: ["graph/summary not readable"], ...computeCoverage("", []) });
      continue;
    }
    samples.push({ sampleId: row.sampleId, ...computeCoverage(summary, mustKeep) });
  }
  return { schema: "k26-coverage-v1", labelsPath, samples };
}

function main(argv = process.argv.slice(2)) {
  const valueOf = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? String(argv[i + 1] ?? "") : "";
  };
  const labelsPath = valueOf("labels");
  const home = valueOf("home") || String(process.env.DSH_HOME ?? "");
  const out = valueOf("out");
  if (labelsPath === "" || home === "" || out === "") {
    console.error("usage: node scripts/k26-coverage-check.mjs --labels <private labels.jsonl> --home <DSH_HOME> --out <private coverage.json>");
    process.exit(2);
  }
  const result = run({ labelsPath, home });
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  const ok = result.samples.filter((s) => s.status === "OK");
  const total = ok.reduce((n, s) => n + s.total, 0);
  const matched = ok.reduce((n, s) => n + s.matched, 0);
  console.log(JSON.stringify({
    samples: result.samples.length,
    withChecklist: ok.length,
    notRun: result.samples.filter((s) => s.status === "NOT_RUN").length,
    invalid: result.samples.filter((s) => s.status !== "OK" && s.status !== "NOT_RUN").length,
    coverage: total === 0 ? "NOT_RUN" : matched / total,
    wrote: out,
  }, null, 2));
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
