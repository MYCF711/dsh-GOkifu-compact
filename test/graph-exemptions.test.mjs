/**
 * graph-exemptions.test.mjs —— C-13「历史违规图豁免清单」的回归矩阵（2026-10-30）
 *
 * 为什么必须单独测：豁免是本仓库**唯一**允许把红线合法吸收的机制。它一旦有 bug，
 * 要么把新坏图放行（门禁失效），要么把历史图永久判红（门禁没人看）。reviewer 抓到
 * `graph-exemptions.mjs` ~20KB 零单测，这里补齐 5–8 项硬要求 + 边界。
 *
 * 覆盖：
 *   已登记历史图绿 / 未登记坏图红 / 数值变化仍红 / 指纹变化仍红（清单不可静默修改）/
 *   过期条目失效 / 空清单 / 格式错误逐类报错 / 放行打印可审计（豁免 ≠ 通过）/
 *   未给清单时不静默放行 / 部分豁免（只登记比例，自环仍红）/ CLI 全链路。
 *
 * 夹具纪律：全部写在 os.tmpdir() 下，**绝不触碰**真实棋谱目录。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createGraph, addUserNode, addEdge, settleEdge, addAgentNode } from "../src/graph.mjs";
import { checkGraph, checkGraphs, checkGraphsWithExemptions, DEFAULT_LIMITS } from "./graph-invariants.mjs";
import {
  graphFingerprint,
  parseExemptions,
  applyExemptions,
  matchEntry,
  isExpired,
  EXEMPTIONS_FORMAT,
  EXEMPTIONS_VERSION,
  DEFAULT_EXPIRES_ON,
} from "./graph-exemptions.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const VERIFY = nodePath.join(HERE, "verify-graphs.mjs");
const TMP = nodePath.resolve(os.tmpdir());

/* ───────────────────────────── 夹具 ───────────────────────────── */

function assertInsideTmp(root) {
  const resolved = nodePath.resolve(root);
  if (resolved !== TMP && !resolved.startsWith(`${TMP}${nodePath.sep}`)) {
    throw new Error(`夹具目录必须在 ${TMP} 下，实际 ${resolved} —— 拒绝触碰真实棋谱数据`);
  }
}

function withRoot(label, fn) {
  const root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), `gokifu-exempt-${label}-`));
  try {
    assertInsideTmp(root);
    return fn(root);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 高 ratio 图：`agents` 个 agent 节点 + 每节点 `perAgent` 条未结算边。
 * edgePerNode = (agents*perAgent) / (1+agents)。默认 8 agents × 12 边 = 96/9 ≈ 10.67 > 8。
 */
function stormGraph({ agents = 8, perAgent = 12, sessionId = "fx-storm" } = {}) {
  const g = createGraph({ sessionId });
  const u = addUserNode(g, { seq: 1, text: "目标：跑绿" });
  for (let i = 0; i < agents; i += 1) {
    const e = addEdge(g, { from: u, intent: `成功 ${i}`, action: "bash(ls)" });
    const a = addAgentNode(g, { seq: 3 + i, goal: "", worldHash: `W${i}`, constraintHash: "C1", via: e }).id;
    g.edges[e].to = a;
    settleEdge(g, e, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
    for (let k = 1; k < perAgent; k += 1) {
      const extra = addEdge(g, { from: a, intent: `重试 ${k}`, action: "bash(x)" });
      settleEdge(g, extra, { result: "unverified", verify: { kind: "no-exit", summary: "" } });
    }
  }
  return g;
}

/** 自环图：`loops` 条 from===to 的边 + `normal` 条正常边。 */
function loopGraph({ loops = 3, normal = 10, sessionId = "fx-loop" } = {}) {
  const g = createGraph({ sessionId });
  const u = addUserNode(g, { seq: 1, text: "目标" });
  for (let i = 0; i < normal; i += 1) {
    const e = addEdge(g, { from: u, intent: `正常 ${i}`, action: "bash(ls)" });
    settleEdge(g, e, { to: u, result: "unverified", verify: { kind: "no-exit", summary: "" } });
  }
  for (let i = 0; i < loops; i += 1) {
    const e = addEdge(g, { from: u, intent: `自环 ${i}`, action: "read(x)" });
    settleEdge(g, e, { to: u, result: "success", verify: { kind: "exit", summary: "exit 0" } });
  }
  return g;
}

/** 从 checkGraph 结果里取一条违规的 (code, value, limit)。 */
function violationOf(graph, code) {
  const item = checkGraph({ session: "fx", graph });
  return item.violations.find((v) => v.code === code) ?? null;
}

/**
 * 为某张图生成一条**合法**的登记项（E/N/L 与指纹都按当前图算）。
 * 这样每个用例的「已登记」都是真的可命中，不会因为夹具漂移假绿。
 */
function makeEntry(graph, session, code, overrides = {}) {
  const m = graphFingerprint(graph);
  const metrics = checkGraph({ session, graph }).metrics;
  return {
    sessionId: session,
    code,
    E: metrics.edges,
    N: metrics.nodes,
    L: metrics.selfLoops,
    reason: `测试夹具：${code} 历史豁免`,
    registeredBy: "implementer-gokifu",
    registeredOn: "2026-10-30",
    source: "test/graph-exemptions.test.mjs",
    fingerprint: m.sha256,
    ...overrides,
  };
}

function manifestOf(entries) {
  return { format: EXEMPTIONS_FORMAT, version: EXEMPTIONS_VERSION, updatedOn: "2026-10-30", exemptions: entries };
}

function runCli(root, args = []) {
  assertInsideTmp(root);
  const result = spawnSync(process.execPath, [VERIFY, root, ...args], { encoding: "utf8", timeout: 20000 });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function writeGraph(root, name, g) {
  const dir = nodePath.join(root, name);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify(g), "utf8");
}

/* ───────────────────────────── 用例 ───────────────────────────── */

export const tests = {
  "C-13-1 已登记历史图：strict 从红转绿，且豁免被记为「已吸收」而不是「通过」"(t) {
    const g = stormGraph();
    const base = checkGraphs([{ session: "sid-x", sessionId: "sid-x", graph: g }]);
    t.eq(base.ok, false, "未豁免时必须红");
    const entry = makeEntry(g, "sid-x", "edge-per-node");
    const manifest = parseExemptions(JSON.stringify(manifestOf([entry])));
    t.eq(manifest.ok, true, `清单必须合法：${manifest.errors.join("; ")}`);
    const applied = checkGraphsWithExemptions([{ session: "sid-x", sessionId: "sid-x", graph: g }], DEFAULT_LIMITS, manifest, {
      fingerprints: { "sid-x": entry.fingerprint },
    });
    t.eq(applied.ok, true, "已登记历史图必须绿");
    t.eq(applied.failed.length, 0, "不应有失败图");
    t.eq(applied.exempted.length, 1, "必须记录 1 条被豁免的违规（豁免 ≠ 通过）");
    t.eq(applied.exempted[0].code, "edge-per-node", "被豁免的判据代号");
    t.eq(applied.exempted[0].registeredBy, "implementer-gokifu", "登记人必须可审计");
    t.eq(applied.graphs[0].violations.length, 0, "剩余违规应为空");
    t.eq(applied.graphs[0].exempted.length, 1, "逐图也要记录被豁免项");
  },

  "C-13-2 未登记坏图：清单是空的也照样红（不静默放行）"(t) {
    const g = stormGraph();
    const empty = parseExemptions(JSON.stringify(manifestOf([])));
    t.eq(empty.ok, true, "空清单是合法格式");
    const applied = checkGraphsWithExemptions([{ session: "sid-new", sessionId: "sid-new", graph: g }], DEFAULT_LIMITS, empty, {
      fingerprints: { "sid-new": graphFingerprint(g).sha256 },
    });
    t.eq(applied.ok, false, "未登记的坏图必须红");
    t.eq(applied.failed.length, 1, "1 张失败");
    t.eq(applied.exempted.length, 0, "0 条豁免");
    t.includes(applied.failed[0].violations.map((v) => v.code).join(","), "edge-per-node", "失败原因必须是比例超阈");
  },

  "C-13-3 登记后数值变化仍红：同一会话继续长边（E 变）必须重新登记"(t) {
    const g = stormGraph({ agents: 8, perAgent: 12 });
    const entry = makeEntry(g, "sid-grow", "edge-per-node");
    const manifest = parseExemptions(JSON.stringify(manifestOf([entry])));
    // 原样命中
    const before = checkGraphsWithExemptions([{ session: "sid-grow", sessionId: "sid-grow", graph: g }], DEFAULT_LIMITS, manifest, {
      fingerprints: { "sid-grow": entry.fingerprint },
    });
    t.eq(before.ok, true, "登记时的数值必须绿");
    // 同一张图再长 5 条边 —— 指纹与 E 都变
    const g2 = stormGraph({ agents: 8, perAgent: 12 });
    const u = Object.keys(g2.nodes)[0];
    for (let i = 0; i < 5; i += 1) {
      const e = addEdge(g2, { from: u, intent: `新增 ${i}`, action: "bash(x)" });
      settleEdge(g2, e, { result: "unverified", verify: { kind: "no-exit", summary: "" } });
    }
    const after = checkGraphsWithExemptions([{ session: "sid-grow", sessionId: "sid-grow", graph: g2 }], DEFAULT_LIMITS, manifest, {
      fingerprints: { "sid-grow": graphFingerprint(g2).sha256 },
    });
    t.eq(after.ok, false, "数值变了必须恢复判红");
    t.eq(after.exempted.length, 0, "不能继续吃旧豁免");
    const reasons = after.missed.map((x) => x.reasons.join(";")).join(" | ");
    t.includes(reasons, "E 已变化", `未命中原因必须说清数值变了，实际：${reasons}`);
    t.includes(reasons, "指纹", `未命中原因必须说清指纹变了，实际：${reasons}`);
  },

  "C-13-4 指纹变化仍红：数值一样但图内容被改（清单不可静默修改）"(t) {
    const g = stormGraph();
    const entry = makeEntry(g, "sid-fp", "edge-per-node");
    const manifest = parseExemptions(JSON.stringify(manifestOf([entry])));
    const g2 = stormGraph();
    // 只改一个节点文本，E/N/L 完全不变
    const firstId = Object.keys(g2.nodes)[0];
    g2.nodes[firstId].text = "目标：被改过的文本";
    const m2 = checkGraph({ session: "sid-fp", graph: g2 }).metrics;
    t.eq([m2.edges, m2.nodes, m2.selfLoops], [entry.E, entry.N, entry.L], "夹具前提：E/N/L 必须没变");
    t.ne(graphFingerprint(g2).sha256, entry.fingerprint, "指纹必须变");
    const applied = checkGraphsWithExemptions([{ session: "sid-fp", sessionId: "sid-fp", graph: g2 }], DEFAULT_LIMITS, manifest, {
      fingerprints: { "sid-fp": graphFingerprint(g2).sha256 },
    });
    t.eq(applied.ok, false, "图内容变了必须恢复判红");
    t.includes(applied.missed.map((x) => x.reasons.join(";")).join(" "), "指纹", "原因必须指出指纹不匹配");
  },

  "C-13-5 过期条目失效：到期日之后必须恢复判红，并记录 expired"(t) {
    const g = stormGraph();
    const entry = makeEntry(g, "sid-exp", "edge-per-node", { expiresOn: "2026-01-01" });
    const manifest = parseExemptions(JSON.stringify(manifestOf([entry])));
    t.eq(isExpired(entry, "2026-01-01"), false, "到期日当天仍有效");
    t.eq(isExpired(entry, "2026-01-02"), true, "次日起失效");
    const applied = checkGraphsWithExemptions([{ session: "sid-exp", sessionId: "sid-exp", graph: g }], DEFAULT_LIMITS, manifest, {
      fingerprints: { "sid-exp": entry.fingerprint },
      today: "2026-12-31",
    });
    t.eq(applied.ok, false, "过期后必须红");
    t.eq(applied.exempted.length, 0, "过期条目不能继续吸收");
    t.eq(applied.expired.length, 1, "必须记录 1 条过期");
    t.includes(applied.expired[0].reasons.join(";"), "过期", "过期原因必须打印");
    // 未填 expiresOn 时使用默认有效期，默认值必须在未来
    t.eq(DEFAULT_EXPIRES_ON, "2027-06-30", "默认有效期");
    t.eq(isExpired({}, "2026-10-30"), false, "默认有效期未到");
  },

  "C-13-6 空清单：格式合法但什么也不吸收（与「不给清单」可区分）"(t) {
    const g = stormGraph();
    const empty = parseExemptions(JSON.stringify(manifestOf([])));
    t.eq(empty.ok, true, "空清单合法");
    t.eq(empty.entries.length, 0, "0 条登记");
    const plain = checkGraphs([{ session: "sid-empty", sessionId: "sid-empty", graph: g }]);
    const applied = applyExemptions(plain, empty, { fingerprints: { "sid-empty": graphFingerprint(g).sha256 } });
    t.eq(applied.ok, false, "空清单不能把坏图变绿");
    t.eq(applied.exempted.length, 0, "无豁免");
    t.eq(applied.failed.length, 1, "仍 1 张红");
  },

  "C-13-7 格式错误：坏 JSON / 错 format / 错 version / 缺字段 / 非法判据 / 重复登记 逐类报错"(t) {
    const badJson = parseExemptions("{not json");
    t.eq(badJson.ok, false, "坏 JSON 必须报错");
    t.includes(badJson.errors.join(";"), "不是合法 JSON", "错误要说清是 JSON");

    const wrongFormat = parseExemptions(JSON.stringify({ format: "nope", version: 1, exemptions: [] }));
    t.eq(wrongFormat.ok, false, "错 format 必须报错");
    t.includes(wrongFormat.errors.join(";"), "format", "错误要点名 format");

    const wrongVersion = parseExemptions(JSON.stringify({ format: EXEMPTIONS_FORMAT, version: 99, exemptions: [] }));
    t.eq(wrongVersion.ok, false, "错 version 必须报错");
    t.includes(wrongVersion.errors.join(";"), "version", "错误要点名 version");

    const g = stormGraph();
    const good = makeEntry(g, "sid-fmt", "edge-per-node");
    for (const missing of ["sessionId", "code", "E", "N", "L", "reason", "registeredBy", "registeredOn", "source", "fingerprint"]) {
      const entry = { ...good };
      delete entry[missing];
      const parsed = parseExemptions(JSON.stringify(manifestOf([entry])));
      t.eq(parsed.ok, false, `缺 ${missing} 必须报错`);
      t.includes(parsed.errors.join(";"), missing, `错误要点名缺 ${missing}`);
    }
    const badCode = parseExemptions(JSON.stringify(manifestOf([{ ...good, code: "not-a-real-code" }])));
    t.eq(badCode.ok, false, "非法判据代号必须报错");
    t.includes(badCode.errors.join(";"), "code", "错误要点名 code");

    const dup = parseExemptions(JSON.stringify(manifestOf([good, { ...good }])));
    t.eq(dup.ok, false, "重复登记必须报错");
    t.includes(dup.errors.join(";"), "重复登记", "错误要说清重复");
  },

  "C-13-8 部分豁免：只登记了比例，自环仍然红（豁免是按判据逐条的）"(t) {
    // E=7 / N=1 = 7 ≤ 8（不触发比例判据）；自环 3/7 = 42.9% ⇒ 只触发 self-loop + collapsed-graph
    const g = loopGraph({ loops: 3, normal: 4 });
    // 这张图同时有 self-loop + collapsed-graph；只登记 self-loop
    const entry = makeEntry(g, "sid-part", "self-loop");
    const manifest = parseExemptions(JSON.stringify(manifestOf([entry])));
    const applied = checkGraphsWithExemptions([{ session: "sid-part", sessionId: "sid-part", graph: g }], DEFAULT_LIMITS, manifest, {
      fingerprints: { "sid-part": entry.fingerprint },
    });
    t.eq(applied.ok, false, "只豁免 self-loop，collapsed-graph 仍必须红");
    t.eq(applied.exempted.length, 1, "self-loop 被吸收");
    t.eq(applied.failed[0].violations.map((v) => v.code).join(","), "collapsed-graph", "剩余违规必须是 collapsed-graph");
  },

  "C-13-9 未给清单时仍红：CLI --strict 不传 --exemptions 不得静默放行"(t) {
    withRoot("no-manifest", (root) => {
      writeGraph(root, "fx-storm", stormGraph());
      const run = runCli(root, ["--strict"]);
      t.eq(run.code, 1, "不给清单必须 exit 1");
      t.includes(run.stdout, "✗ 1 / 1 张图违反不变量", "必须点名失败");
      t.notIncludes(run.stdout, "豁免", "不给清单时不得出现豁免字样");
      const json = runCli(root, ["--strict", "--json"]);
      t.eq(json.code, 1, "JSON 模式同退出码");
      const payload = JSON.parse(json.stdout);
      t.eq(payload.strict.ok, false, "strict.ok 必须 false");
      t.eq(Object.prototype.hasOwnProperty.call(payload.strict, "exemptions"), false, "不给清单时不得注入 exemptions 段");
    });
  },

  "C-13-10 CLI 全链路：--exemptions 后转绿、打印可审计；改一个图立刻退回红"(t) {
    withRoot("cli", (root) => {
      const g = stormGraph({ sessionId: "sid-cli" });
      writeGraph(root, "fx-storm", g);
      const entry = makeEntry(g, "sid-cli", "edge-per-node");
      const manifestPath = nodePath.join(root, "exemptions.json");
      nodeFs.writeFileSync(manifestPath, JSON.stringify(manifestOf([entry]), null, 2), "utf8");

      const green = runCli(root, ["--strict", `--exemptions=${manifestPath}`]);
      t.eq(green.code, 0, `已登记必须 exit 0，实际 ${green.code}；stderr=${green.stderr}`);
      t.includes(green.stdout, "豁免 1 条已登记的历史违规", "必须打印豁免条数");
      t.includes(green.stdout, "豁免 ≠ 通过", "必须明确「豁免 ≠ 通过」");
      t.includes(green.stdout, "⊘", "每条豁免必须逐条打印");
      t.includes(green.stdout, "edge-per-node", "必须点名判据");
      t.includes(green.stdout, "登记：implementer-gokifu @ 2026-10-30", "必须能审计到登记人与登记日期");
      t.includes(green.stdout, "test/graph-exemptions.test.mjs", "必须打印来源");

      const json = runCli(root, ["--strict", "--json", `--exemptions=${manifestPath}`]);
      t.eq(json.code, 0, "JSON 模式 exit 0");
      const payload = JSON.parse(json.stdout);
      t.eq(payload.strict.exemptions.applied, 1, "JSON 里必须有 applied=1");
      t.eq(payload.strict.exemptions.preExemptionFailed, 1, "豁免前 1 张红");
      t.eq(payload.strict.ok, true, "strict.ok 与退出码一致");

      // 把图改大 ⇒ 指纹/数值都变 ⇒ 必须退回红
      const g2 = stormGraph({ sessionId: "sid-cli" });
      const u = Object.keys(g2.nodes)[0];
      for (let i = 0; i < 3; i += 1) {
        const e = addEdge(g2, { from: u, intent: `新增 ${i}`, action: "bash(x)" });
        settleEdge(g2, e, { result: "unverified", verify: { kind: "no-exit", summary: "" } });
      }
      writeGraph(root, "fx-storm", g2);
      const red = runCli(root, ["--strict", `--exemptions=${manifestPath}`]);
      t.eq(red.code, 1, "图变了必须退回 exit 1");
      t.includes(red.stdout, "未被清单吸收", "必须解释为什么没吸收");
    });
  },

  "C-13-11 CLI：--exemptions 只在 --strict 下有效（否则 exit 2）；清单缺失/非法也 exit 2"(t) {
    withRoot("cli-args", (root) => {
      writeGraph(root, "fx-ok", (() => {
        const g = createGraph({ sessionId: "ok" });
        addUserNode(g, { seq: 1, text: "目标" });
        return g;
      })());
      const manifestPath = nodePath.join(root, "exemptions.json");
      nodeFs.writeFileSync(manifestPath, JSON.stringify(manifestOf([])), "utf8");
      t.eq(runCli(root, [`--exemptions=${manifestPath}`]).code, 2, "不带 --strict 必须 exit 2");
      t.eq(runCli(root, ["--strict", "--exemptions="]).code, 2, "空路径必须 exit 2");
      t.eq(runCli(root, ["--strict", "--exemptions=" + nodePath.join(root, "nope.json")]).code, 2, "文件不存在必须 exit 2");
      const badPath = nodePath.join(root, "bad.json");
      nodeFs.writeFileSync(badPath, "{oops", "utf8");
      const bad = runCli(root, ["--strict", `--exemptions=${badPath}`]);
      t.eq(bad.code, 2, "坏清单必须 exit 2");
      t.includes(bad.stderr, "豁免清单错误", "错误必须点名是清单问题");
    });
  },

  "C-13-12 matchEntry 的四个条件缺一不可（session/判据/E-N-L/指纹）"(t) {
    const g = stormGraph();
    const entry = makeEntry(g, "sid-m", "edge-per-node");
    const fp = entry.fingerprint;
    const base = { sessionId: "sid-m", code: "edge-per-node", E: entry.E, N: entry.N, L: entry.L, fingerprint: fp };
    t.eq(matchEntry(entry, base).match, true, "四条件全同必须命中");
    t.eq(matchEntry(entry, { ...base, sessionId: "sid-other" }).match, false, "sessionId 不同 → 不命中");
    t.eq(matchEntry(entry, { ...base, code: "self-loop" }).match, false, "判据不同 → 不命中");
    t.eq(matchEntry(entry, { ...base, E: base.E + 1 }).match, false, "E 不同 → 不命中");
    t.eq(matchEntry(entry, { ...base, N: base.N + 1 }).match, false, "N 不同 → 不命中");
    t.eq(matchEntry(entry, { ...base, L: base.L + 1 }).match, false, "L 不同 → 不命中");
    t.eq(matchEntry(entry, { ...base, fingerprint: "0".repeat(64) }).match, false, "指纹不同 → 不命中");
  },
};
