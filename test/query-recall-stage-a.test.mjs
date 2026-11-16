/**
 * query-recall-stage-a.test.mjs —— Q1 查询召回 Stage A 的门禁（0 模型调用）
 *
 * 这个文件钉住的不是「召回实现细节」，而是**评测本身能不能判红判绿**：
 *   ① 夹具够不够（≥12 题、五类覆盖、图上每道题都能解析到一张合法棋谱）；
 *   ② 公开面脱敏（无驱动路径 / 无 UNC / 无 URL / 无会话 id 形状）；
 *   ③ 脚本正例 exit 0（用合成 stub 实现，证明绿灯通道真的能绿）；
 *   ④ **失败分支真红**：把某题 mandatory 指向不存在的证据 ⇒ 必须 exit 1，
 *      而且不许临时改坏 `src/rooms/query-recall.mjs`（只改临时目录里的夹具副本）；
 *   ⑤ `--home` 基准只输出聚合：不出现 home 路径、会话 id 形状、图正文；
 *   ⑥ `--write` 只写合成聚合；默认不写盘；
 *   ⑦ core 缺失时清晰报缺（exit 3）；core 存在时默认命令必须 Stage A 全绿（真实门）。
 *
 * stub 只用来验证**评测器**，不是被测实现；真实实现由 `src/rooms/query-recall.mjs` 提供。
 */

import { spawnSync } from "node:child_process";
import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { encodeDeltaFrame, sha } from "../src/rooms/kifu-model.mjs";
import {
  DEFAULT_FIXTURES,
  DEFAULT_IMPL,
  EXIT,
  REQUIRED_FAMILIES,
  STAGE_A_EVIDENCE,
  evaluateTask,
  loadFixtures,
  percentile,
} from "../scripts/query-recall-stage-a.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const SCRIPT = nodePath.join(REPO, "scripts", "query-recall-stage-a.mjs");

/** Stage A 必须覆盖的细类（原 12 项 + 长 action 失败边）；五类家族见 REQUIRED_FAMILIES。 */
const REQUIRED_CLASSES = [
  "full-path",
  "windows-path",
  "relative-path",
  "backtick-basename",
  "function-symbol",
  "method-symbol",
  "no-anchor",
  "multi-file-synonym",
  "no-evidence",
  "failure-reason",
  "budget-truncation",
  "stable-ordering",
  "failure-reason-long-action",
];

const readJson = (file) => JSON.parse(nodeFs.readFileSync(file, "utf8"));
const fixture = readJson(DEFAULT_FIXTURES);

export const tests = {};

function run(args, { cwd = REPO } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", timeout: 120_000, env: { ...process.env } });
}

/** 临时目录（测试产物，跑完清理；不写仓库）。 */
function tempDir() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "q1-stage-a-"));
}

/**
 * 合成 stub 实现：只为验证评测器的绿灯通道。
 * 证据文本取自夹具的 `expected`（**不是** mandatory —— 这样改坏的 mandatory 才会真的判红）。
 */
function writeStub(dir, fixturesPath) {
  const file = nodePath.join(dir, "stub-impl.mjs");
  nodeFs.writeFileSync(
    file,
    [
      'import nodeFs from "node:fs";',
      `const fixtures = JSON.parse(nodeFs.readFileSync(${JSON.stringify(fixturesPath)}, "utf8"));`,
      "const byQuery = new Map(fixtures.tasks.map((task) => [task.query, task]));",
      "export function renderQueryRecall(graph, queryText, options = {}) {",
      "  const task = byQuery.get(queryText);",
      "  const limit = Number(options.limit) || 6;",
      "  const anchors = { paths: [], symbols: [] };",
      "  if (!task) {",
      "    const hit = typeof queryText === 'string' && queryText.trim() !== '';",
      "    return { text: hit ? '## 合成 stub\\n- e0 (seq 1-1) stub ⇒ success' : '', anchors: { paths: hit ? [queryText] : [], symbols: [] }, items: hit ? [{ id: 'e0' }] : [], stats: { stub: true } };",
      "  }",
      "  if (task.expectEmptyText) return { text: '', anchors, items: [], stats: { stub: true } };",
      "  for (const matcher of task.expectedAnchors ?? []) anchors.paths.push(String(matcher.contains ?? matcher));",
      "  const text = ['## 合成 stub', ...task.expected.map((line) => '- ' + line)].join('\\n');",
      "  const items = task.expected.slice(0, limit).map((line, index) => ({ id: 'i' + index, text: line }));",
      "  return { text, anchors, items, stats: { stub: true } };",
      "}",
      "",
    ].join("\n"),
  );
  return file;
}

tests["QA-1 夹具：≥15 题、五类家族 + 全部细类（含长 action 失败边）都在，且每题的图合法"] = (t) => {
  const loaded = loadFixtures(DEFAULT_FIXTURES);
  t.eq(loaded.data.status, "SYNTHETIC_ONLY", "夹具必须声明纯合成");
  t.eq(loaded.data.zeroModelCalls, true, "夹具必须声明零模型调用");
  t.ok(fixture.tasks.length >= 15, `任务数必须 ≥15（实际 ${fixture.tasks.length}）`);
  const families = [...new Set(fixture.tasks.map((task) => task.family))].sort();
  t.eq(families, [...REQUIRED_FAMILIES].sort(), "五类家族必须全覆盖");
  for (const klass of REQUIRED_CLASSES) {
    t.ok(fixture.tasks.some((task) => task.class === klass), `缺少细类：${klass}`);
  }
  for (const task of fixture.tasks) {
    t.ok(fixture.graphs[task.graph] !== undefined, `${task.id} 的 graph 引用悬空`);
    t.eq(typeof task.query, "string", `${task.id} 缺 query`);
    t.ok(Number(task.options?.maxChars) > 0, `${task.id} 缺 maxChars`);
    t.ok(Number(task.options?.limit) > 0, `${task.id} 缺 limit`);
    t.ok(Array.isArray(task.mandatory), `${task.id} 缺 mandatory`);
  }
  const { fromJSON, validate } = loadedGraphApi();
  for (const [name, graph] of Object.entries(fixture.graphs)) {
    const problems = validate(fromJSON(JSON.stringify(graph)));
    t.eq(problems, [], `${name} 不是合法棋谱：${problems.slice(0, 3).join("; ")}`);
  }
};

/** 延迟 import，避免顶层把 kifu-model 再引一遍（与脚本同一个来源）。 */
let graphApi = null;
function loadedGraphApi() {
  if (graphApi === null) throw new Error("graphApi 尚未初始化");
  return graphApi;
}

tests["QA-2 夹具公开面：无驱动路径 / UNC / URL / 会话 id 形状 / home 路径"] = (t) => {
  const text = nodeFs.readFileSync(DEFAULT_FIXTURES, "utf8");
  t.eq(/\b[A-Za-z]:[\\/]/.test(text), false, "不许出现驱动器绝对路径");
  t.eq(/\\\\/.test(text), false, "不许出现 UNC 形状的连续反斜杠");
  t.eq(/https?:\/\//i.test(text), false, "不许出现 URL");
  t.eq(/\bsession-[0-9a-f]{8}/i.test(text), false, "不许出现运行时会话 id 形状");
  t.eq(/(?:^|\/)(?:Users|home|root)\//i.test(text), false, "不许出现 home 路径");
  // 反斜杠本身是合法的（Windows 路径题），但只能以 unicode 转义出现。
  t.includes(text, "u005c", "Windows 路径题的反斜杠必须用 JSON unicode 转义写出");
};

tests["QA-3 脚本正例 exit 0（合成 stub 实现，零模型调用）"] = (t) => {
  const dir = tempDir();
  try {
    const stub = writeStub(dir, DEFAULT_FIXTURES);
    const result = run(["--impl", stub, "--fixtures", DEFAULT_FIXTURES, "--json"]);
    t.eq(result.status, EXIT.OK, `正例必须 exit 0（实际 ${result.status}）：\n${result.stdout}${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    t.eq(payload.ok, true, "JSON 结论必须是 ok=true");
    t.eq(payload.aggregate.failed, 0, "正例不许有失败题");
    t.eq(payload.aggregate.misses, 0, "正例不许有漏召");
    t.eq(payload.aggregate.falsePositives, 0, "正例不许有误召");
    t.eq(/^[0-9a-f]{64}$/.test(String(payload.impl?.sha256)), true, "JSON 里必须带实现文件的 sha256（Stage B 冻结核验）");
    t.ok(payload.aggregate.renderMs.p95 !== null, "必须报 p95 渲染时延");

    const human = run(["--impl", stub]);
    t.eq(human.status, EXIT.OK, "人读模式也必须 exit 0");
    t.includes(human.stdout, "结论：PASS", "人读模式必须打印结论 PASS");
    t.includes(human.stdout, "零模型调用", "必须声明零模型调用");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["QA-4 失败分支真红：mandatory 指向不存在证据 ⇒ exit 1（只改临时夹具副本）"] = (t) => {
  const dir = tempDir();
  try {
    const mutated = JSON.parse(JSON.stringify(fixture));
    mutated.tasks[0].mandatory = ["absent-evidence-9f3c"];
    const mutatedPath = nodePath.join(dir, "mutated.fixtures.json");
    nodeFs.writeFileSync(mutatedPath, JSON.stringify(mutated));
    const stub = writeStub(dir, mutatedPath);
    const evidenceBefore = nodeFs.existsSync(STAGE_A_EVIDENCE);
    const result = run(["--impl", stub, "--fixtures", mutatedPath]);
    t.eq(result.status, EXIT.FAIL, `缺证据必须 exit 1（实际 ${result.status}）：\n${result.stdout}${result.stderr}`);
    t.includes(result.stdout, "漏召：absent-evidence-9f3c", "必须点名缺失的证据");
    t.includes(result.stdout, "结论：FAIL", "必须打印 FAIL");
    t.eq(nodeFs.existsSync(STAGE_A_EVIDENCE), evidenceBefore, "失败时不许写 evidence 结果 JSON");
    // 共享源码一个字节都没动（只改临时目录里的副本）。
    t.eq(nodeFs.existsSync(mutatedPath), true, "临时夹具应存在（证明测的是副本）");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["QA-5 --home 基准：只出聚合，不出 home 路径 / 会话 id / 图正文，且 delta 已回放"] = (t) => {
  const dir = tempDir();
  try {
    const home = nodePath.join(dir, "home");
    const sessionDir = nodePath.join(home, "chess-context", "sessions", "q1fixture01");
    nodeFs.mkdirSync(sessionDir, { recursive: true });
    const marker = "PRIVATE-BODY-MARKER-9f3c";
    const base = {
      version: 1,
      nodes: { n1: { id: "n1", kind: "user", seq: 1, turn: null, text: marker, constraints: [], ts: 0 } },
      edges: {
        e1: {
          id: "e1",
          from: "n1",
          to: null,
          intent: "renderLedger 预算窗口核对",
          action: "read(file_path=src/rooms/ledger.mjs)",
          result: "success",
          verify: { kind: "tool", summary: "ok" },
          errorSnippet: "",
          evidence: { start: 1, end: 1 },
        },
      },
      order: ["n1"],
      stateIndex: {},
      rootUserNodeIds: ["n1"],
      foldCount: 0,
      checkpointSeq: null,
      foldMarks: [],
      lastFoldUsage: null,
    };
    const baseText = JSON.stringify(base);
    nodeFs.writeFileSync(nodePath.join(sessionDir, "graph.json"), baseText);
    const delta = {
      v: 1,
      nodes: { n2: { id: "n2", kind: "agent", seq: 2, turn: null, goal: marker, worldHash: "w2", constraintHash: "c2", via: null, ts: 0 } },
      edges: {},
      delNodes: [],
      delEdges: [],
      orderAppend: ["n2"],
      orderDrop: [],
      scalars: { nextNode: 3, updatedAt: 0 },
    };
    nodeFs.writeFileSync(nodePath.join(sessionDir, "graph.json.delta.jsonl"), encodeDeltaFrame(sha(baseText).slice(0, 16), delta));

    const stub = writeStub(dir, DEFAULT_FIXTURES);
    const result = run(["--home", home, "--impl", stub, "--iterations", "5", "--json"]);
    t.eq(result.status, EXIT.OK, `基准必须 exit 0（实际 ${result.status}）：\n${result.stdout}${result.stderr}`);
    t.eq(result.stdout.includes(home), false, "不许输出 home 路径");
    t.eq(/[A-Za-z]:[\\/]/.test(result.stdout), false, "不许输出驱动器路径");
    t.eq(/\bsession-[0-9a-f]{8}/i.test(result.stdout), false, "不许输出会话 id 形状");
    t.eq(result.stdout.includes(marker), false, "不许输出图正文");
    const payload = JSON.parse(result.stdout);
    t.eq(payload.mode, "bench", "必须是 bench 模式");
    t.eq(payload.bench.deltaFrames, 1, "必须回放 delta 后再测（deltaFrames=1）");
    t.eq(payload.bench.nodes, 2, "delta 节点必须算进来（nodes=2）");
    t.ok(payload.bench.graphBytes > 0, "必须报 graph.json 字节");
    t.ok(payload.bench.renderMs.p95 !== null, "必须报 p95 渲染时延");
    t.ok(payload.bench.rssMB.after > 0, "必须报 RSS 聚合");
    t.ok(payload.bench.derived.pathsHit >= 1, `必须至少有一条从图内部派生、保证命中的路径 query（pathsHit=${payload.bench.derived.pathsHit}）`);
    t.ok(payload.bench.derived.symbolsHit >= 1, `必须至少有一条 render/ledger 符号 query 命中（symbolsHit=${payload.bench.derived.symbolsHit}）`);
    t.ok(payload.bench.renderHits.hit > 0, `基准必须真的渲染出证据（hit=${payload.bench.renderHits.hit}）`);
    t.ok(payload.bench.derivedRenderMs.p95 !== null, "必须单列派生（保证命中）query 的 p95");
    t.eq(result.stdout.includes("src/rooms/ledger.mjs"), false, "不许输出派生路径原文");
    t.eq(result.stdout.includes("renderLedger"), false, "不许输出派生符号原文");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["QA-6 --write 只写合成聚合；默认不写盘；写出的内容不含图/会话/路径"] = (t) => {
  const dir = tempDir();
  const hadEvidence = nodeFs.existsSync(STAGE_A_EVIDENCE);
  const before = hadEvidence ? nodeFs.readFileSync(STAGE_A_EVIDENCE) : null;
  try {
    const stub = writeStub(dir, DEFAULT_FIXTURES);
    const dry = run(["--impl", stub]);
    t.eq(dry.status, EXIT.OK, "默认模式必须 exit 0");
    t.eq(Buffer.compare(nodeFs.existsSync(STAGE_A_EVIDENCE) ? nodeFs.readFileSync(STAGE_A_EVIDENCE) : Buffer.from(""), before ?? Buffer.from("")), 0, "默认模式不许改 evidence 结果 JSON");

    const write = run(["--impl", stub, "--write"]);
    t.eq(write.status, EXIT.OK, "--write 必须 exit 0");
    t.eq(nodeFs.existsSync(STAGE_A_EVIDENCE), true, "--write 必须写 evidence/query-recall-stage-a.json");
    const payload = readJson(STAGE_A_EVIDENCE);
    t.eq(payload.schema, "query-recall-stage-a-result", "schema 必须正确");
    t.eq(payload.synthetic, true, "必须声明 synthetic");
    t.eq(payload.zeroModelCalls, true, "必须声明零模型调用");
    t.eq(payload.aggregate.failed, 0, "写出的聚合必须是全过");
    t.eq(/^[0-9a-f]{64}$/.test(String(payload.impl?.sha256)), true, "evidence.impl.sha256 必须是 64 位十六进制");
    const stubSha = nodeCrypto.createHash("sha256").update(nodeFs.readFileSync(stub)).digest("hex");
    t.eq(payload.impl.sha256, stubSha, "evidence.impl.sha256 必须是实现文件字节哈希");
    t.eq(Object.hasOwn(payload, "graphs"), false, "不许把图谱进 evidence");
    const text = nodeFs.readFileSync(STAGE_A_EVIDENCE, "utf8");
    t.eq(/\bsession-[0-9a-f]{8}/i.test(text), false, "不许出现会话 id 形状");
    t.eq(/[A-Za-z]:[\\/]/.test(text), false, "不许出现驱动器路径");
    t.eq(text.includes("PRIVATE-BODY-MARKER"), false, "不许出现图正文");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
    // 本任务不产出结果 JSON（由 Lead 集成后生成）⇒ 测完删掉，保持工作树干净。
    if (hadEvidence && before !== null) nodeFs.writeFileSync(STAGE_A_EVIDENCE, before);
    else nodeFs.rmSync(STAGE_A_EVIDENCE, { force: true });
  }
};

tests["QA-7 默认入口：core 缺失 ⇒ exit 3 清晰报缺；core 存在 ⇒ Stage A 必须全绿"] = (t) => {
  const result = run([]);
  if (!nodeFs.existsSync(DEFAULT_IMPL)) {
    t.eq(result.status, EXIT.IMPL_MISSING, `core 缺失必须 exit 3（实际 ${result.status}）`);
    t.includes(result.stdout, "query-recall.mjs", "必须点名缺失的实现文件");
    t.eq(result.stdout.includes("Error"), false, "不许抛栈");
    return;
  }
  t.eq(result.status, EXIT.OK, `core 已存在，默认命令必须 Stage A 全绿（实际 ${result.status}）：\n${result.stdout}${result.stderr}`);
  t.includes(result.stdout, "结论：PASS", "必须打印 PASS");
};

tests["QA-8 评测器双向：空输出判红、正确输出判绿（不是永远绿的门）"] = (t) => {
  const fixtures = fixture.tasks;
  const base = fixture.graphs.base;
  const bad = { renderQueryRecall: () => ({ text: "", anchors: { paths: [], symbols: [] }, items: [], stats: {} }) };
  const badRow = evaluateTask(bad, base, fixtures[0]);
  t.eq(badRow.ok, false, "空输出必须判红");
  t.ok(badRow.problems.some((line) => line.includes("漏召")), "必须报漏召");

  const good = {
    renderQueryRecall: () => ({
      text: "## stub\n- query-recall.mjs — edit(file_path=src/rooms/query-recall.mjs) ⇒ success",
      anchors: { paths: ["src/rooms/query-recall.mjs"], symbols: [] },
      items: [{ id: "e2", text: "edit(file_path=src/rooms/query-recall.mjs)" }],
      stats: {},
    }),
  };
  const goodRow = evaluateTask(good, base, fixtures[0]);
  t.eq(goodRow.ok, true, `正确输出必须判绿：${goodRow.problems.join("; ")}`);

  const overBudget = {
    renderQueryRecall: (graph, query, options) => ({
      text: "x".repeat(options.maxChars + 1),
      anchors: { paths: ["src/rooms/query-recall.mjs"], symbols: [] },
      items: [{ id: "e2" }],
      stats: {},
    }),
  };
  const budgetRow = evaluateTask(overBudget, base, fixtures[0]);
  t.eq(budgetRow.ok, false, "超 maxChars 必须判红");
  t.ok(budgetRow.problems.some((line) => line.includes("预算")), "必须报预算超限");

  t.eq(percentile([1, 2, 3, 4], 95), 4, "percentile 最近秩口径");
};

tests["QA-9 Stage B 预注册：PREREGISTERED / 120 次硬上限 / 0 重试 / 不写死 endpoint"] = (t) => {
  const preregPath = nodePath.join(REPO, "evidence", "query-recall-prereg-v1.json");
  const prereg = readJson(preregPath);
  t.eq(prereg.status, "PREREGISTERED", "status 必须是 PREREGISTERED");
  t.eq(prereg.stageGate.stageA.required.length >= 3, true, "必须写明 Stage A 未过不得运行");
  const design = prereg.design;
  t.eq(design.taskSet.tasks.length, 20, "必须是 20 道题");
  t.eq(design.arms.length, 2, "必须是 2 臂");
  t.eq(design.samplesPerArm, 3, "每臂 3 样本");
  t.eq(design.plannedCalls, 120, "plannedCalls 必须是 120");
  t.eq(design.maxCalls, 120, "maxCalls 必须是 120");
  t.eq(design.retries, 0, "retries 必须是 0");
  t.eq(design.taskSet.tasks.length * design.arms.length * design.samplesPerArm, design.plannedCalls, "20×2×3 必须等于 plannedCalls");
  const gates = prereg.adoptionGates;
  for (const key of ["pairedNoRegression", "unknownNotIncreased", "tokenPositive", "p95Positive", "saturationCap"]) {
    t.ok(gates[key] !== undefined, `采纳门槛缺 ${key}`);
  }
  t.includes(gates.saturationCap.rule, "POSITIVE_SIGNAL", "饱和只能记 POSITIVE_SIGNAL");
  t.includes(gates.saturationCap.rule, "绝不 ADOPT", "饱和绝不 ADOPT");
  t.eq(prereg.readerConfig, undefined, "reader 配置不许放顶层（要按冻结 reader 继承）");
  const serialized = JSON.stringify(prereg);
  t.eq(/https?:\/\//i.test(serialized), false, "不许写死 endpoint / URL");
  t.eq(/[A-Za-z]:[\\/]/.test(serialized), false, "不许出现驱动器绝对路径");
  t.eq(/\bsession-[0-9a-f]{8}/i.test(serialized), false, "不许出现会话 id 形状");
  t.includes(design.readerConfig.endpoint, "INHERIT", "reader endpoint 必须继承冻结 reader");
  const ids = design.taskSet.tasks.map((task) => task.id);
  t.eq(new Set(ids).size, ids.length, "题号必须唯一");
  const controlled = design.taskSet.tasks.filter((task) => task.derivableFrom === "base-context");
  const recallOnly = design.taskSet.tasks.filter((task) => task.derivableFrom === "recall");
  t.ok(controlled.length >= 8, `基线上下文可答的题必须 ≥8（实际 ${controlled.length}）`);
  t.ok(recallOnly.length >= 10, `只有召回块能答的题必须 ≥10（实际 ${recallOnly.length}）`);
  for (const task of design.taskSet.tasks) {
    t.ok(fixture.graphs[task.graph] !== undefined, `${task.id} 的 graph 在 Stage A 夹具里不存在`);
    t.ok(Number(task.options?.maxChars) > 0, `${task.id} 缺 maxChars`);
    t.ok(Array.isArray(task.aliases), `${task.id} 缺 aliases`);
    t.eq(typeof task.gold, "string", `${task.id} 缺 gold`);
  }
  // 冻结输入的哈希：只钉格式。夹具/脚本一改，预注册里的 sha 必然失效 ——
  // 这是预期（Lead 会统一重登记），本测试不替 Lead 改 prereg，也不假装它仍然有效。
  for (const key of ["stageAFixtures", "stageAScript", "stageATest", "reader", "grader"]) {
    t.eq(/^[0-9a-f]{64}$/.test(String(prereg.frozenInputs[key])), true, `frozenInputs.${key} 必须是 sha256`);
  }
  t.eq(typeof prereg.authorization?.status, "string", "预注册必须显式声明授权状态（不得由文件推断授权）");
};

tests["QA-10 长 action（≥210）失败边：失败原因末尾 marker 不许被截掉"] = (t) => {
  const task = fixture.tasks.find((entry) => entry.class === "failure-reason-long-action");
  t.ok(task !== undefined, "夹具必须有 failure-reason-long-action 任务");
  const graph = fixture.graphs[task.graph];
  const edge = Object.values(graph.edges).find((entry) => entry.result === "failure" && String(entry.action ?? "").length >= 210);
  t.ok(edge !== undefined, "必须存在 action ≥210 字符的失败边");
  t.eq(String(edge.action).length >= 210, true, `长 action 长度必须 ≥210（实际 ${String(edge.action).length}）`);
  t.includes(String(edge.errorSnippet), "marker-long-action-tail-7c1e", "失败原因末尾 marker 必须在 errorSnippet 里");
  t.eq(String(edge.action).includes("marker-long-action-tail-7c1e"), false, "marker 不许出现在 action 里（否则截断测试假绿）");

  const truncated = {
    renderQueryRecall: () => ({
      text: String(edge.action).slice(0, 200),
      anchors: { paths: [], symbols: ["renderLedger"] },
      items: [{ id: edge.id }],
      stats: {},
    }),
  };
  const red = evaluateTask(truncated, graph, task);
  t.eq(red.ok, false, "失败原因被截掉必须判红");
  t.ok(red.problems.some((line) => line.includes("marker-long-action-tail-7c1e")), "必须点名缺失的失败原因 marker");

  const preserved = {
    renderQueryRecall: () => ({
      text: `## 合成
- ${edge.id} … ⇒ 失败: ${edge.errorSnippet}`,
      anchors: { paths: [], symbols: ["renderLedger"] },
      items: [{ id: edge.id }],
      stats: {},
    }),
  };
  const green = evaluateTask(preserved, graph, task);
  t.eq(green.ok, true, `保留失败原因必须判绿：${green.problems.join("; ")}`);
};

// graphApi 在模块加载时初始化（供 QA-1 用）。
graphApi = await import("../src/rooms/kifu-model.mjs");
