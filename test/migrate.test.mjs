/**
 * migrate.test.mjs —— P6-C 归档工具的回归矩阵（2026-10-30；P6C-2 迁移自 archive-dangling.test.mjs）
 *
 * 工具：`src/rooms/migrate.mjs`（R14）+ CLI `scripts/migrate-dangling.mjs`（dry-run / apply / verify / rollback）。
 * 判据来自 `src/ledger.mjs` 的 `classifyDangling`，本文件不重复实现判据。
 *
 * 危险面：这是**会改真实 graph.json** 的工具。测试必须证明：
 *   · dry-run 一个字节都不写；
 *   · apply 先整目录备份、再写 sidecar、再删主图边，且备份可逐字恢复；
 *   · live_unsettled 与 from-broken **绝不**被归档（变异：把 live 也归档必须红）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createGraph, addUserNode, addEdge, settleEdge, addAgentNode, toJSON, fromJSON, renderIndexMd } from "./graph-fixtures.mjs";
import { DANGLING_STALE_MS } from "../src/rooms/ledger.mjs";
import { graphRoot, sessionPaths } from "../src/rooms/kifu-persist.mjs";
import { planSession, buildSidecar, dryRun, apply, verify, rollback, mergeSidecar, mergeMany, readSidecar, uniqueBackupDirs, hashTree, sha256, listSessions, sessionsRoot, backupsRoot, freshSessions, freshEvidence, APPLY_FRESHNESS_MS, DELTA_NAME, SIDECAR_NAME } from "../src/rooms/migrate.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));

const TMP = nodePath.resolve(os.tmpdir());
const NOW = 1_800_000_000_000;

function tmpRoot(name) {
  const root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), `gokifu-p6c-${name}-`));
  const resolved = nodePath.resolve(root);
  if (!resolved.startsWith(TMP)) throw new Error(`夹具必须在 tmp 下：${resolved}`);
  return root;
}

/** 造一个会话目录，含 graph.json + index.md + nodes/。 */
function makeSessionDir(root, id, build) {
  const dir = nodePath.join(root, id);
  nodeFs.mkdirSync(nodePath.join(dir, "nodes"), { recursive: true });
  const g = build();
  nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), toJSON(g), "utf8");
  nodeFs.writeFileSync(nodePath.join(dir, "index.md"), renderIndexMd(g), "utf8");
  nodeFs.writeFileSync(nodePath.join(dir, "nodes", "n1.md"), "# n1\n", "utf8");
  return { dir, g };
}

/** 把图里所有边的时间戳平移 shift，使夹具的「相对 NOW」变成「相对真实时钟」。 */
function shiftEdgeTimes(g, shift) {
  for (const e of Object.values(g.edges)) if (Number.isFinite(Number(e.ts))) e.ts = Number(e.ts) - shift;
  return g;
}

/** 改文件 mtime（夹具要造「旧图 / 新 delta」，不能靠真实写入时间）。 */
function setMtime(file, ms) {
  const at = new Date(ms);
  nodeFs.utimesSync(file, at, at);
}

/** 混合图：3 residue（旧 ts、to=null）+ 1 live（新 untested）+ 1 fromBroken + 1 真失败 + 1 成功。 */
function mixedGraph(sessionId = "sess-p6c") {
  const g = createGraph({ sessionId });
  const u = addUserNode(g, { seq: 1, text: "把构建跑通。" }).id;
  const e0 = addEdge(g, { from: u, intent: "成功一步", action: "bash(ls)" });
  const n2 = addAgentNode(g, { seq: 3, goal: "ok", worldHash: "W0", constraintHash: "C1", via: e0 }).id;
  g.edges[e0].to = n2;
  settleEdge(g, e0, { result: "success", verify: { kind: "exit", summary: "exit 0" } });
  // 3 条 residue（已结算、无终点、旧 ts）
  for (let i = 0; i < 3; i += 1) {
    const e = addEdge(g, { from: n2, intent: `残留 ${i}`, action: "bash(x)" });
    g.edges[e].ts = NOW - 24 * 3600 * 1000;
    settleEdge(g, e, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: `boom ${i}` });
  }
  // 1 条 live（untested 且新鲜）
  const live = addEdge(g, { from: n2, intent: "正在跑", action: "bash(sleep 1)" });
  g.edges[live].ts = NOW - 1000;
  // ★ P6C-1/2：1 条 candidate（untested 但陈旧）—— **绝不归档**，必须留在图里
  const candidate = addEdge(g, { from: n2, intent: "中断很久的尝试", action: "bash(long-job)" });
  g.edges[candidate].ts = NOW - 3 * 3600 * 1000;
  // 1 条 fromBroken
  const fb = addEdge(g, { from: "n-does-not-exist", intent: "from 悬空", action: "bash(x)" });
  settleEdge(g, fb, { to: n2, result: "unverified", verify: { kind: "no-exit", summary: "x" } });
  // 1 条真失败（有终点）
  const real = addEdge(g, { from: u, intent: "真失败", action: "bash(npm test)" });
  settleEdge(g, real, { to: n2, result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "AssertionError: real" });
  return { g, ids: { residue: [], live, fb, real, okNode: n2 } };
}

/* ───────────────────────────── 用例 ───────────────────────────── */

export const tests = {
  "P6C-1 planSession：四类互不重叠，residue 只含旧的无终点边、candidate 永不归档"(t) {
    const { g } = mixedGraph();
    const plan = planSession(g, { now: NOW });
    t.eq(plan.residue.length, 3, "residue 必须 3");
    t.eq(plan.candidates.length, 1, "candidates 必须 1（P6C-1 的陈旧 untested）");
    t.eq(plan.live.length, 1, "live 必须 1");
    t.eq(plan.fromBroken.length, 1, "fromBroken 必须 1");
    for (const e of plan.residue) {
      t.eq(e.to, null, "residue 必须 to=null");
      t.ok(NOW - e.ts > DANGLING_STALE_MS, "residue 必须超 10 分钟");
    }
    t.eq(plan.live[0].result, "untested", "live 必须是 untested");
    for (const e of plan.residue) t.eq(e.result === "untested", false, "归档的边不许是 untested（candidate 一律保留）");
    t.eq(plan.residue.some((e) => e.id === plan.candidates[0].id), false, "candidate 不许混进 residue");
    t.eq(plan.residue.some((e) => e.id === plan.live[0].id), false, "live 不许混进 residue");
  },

  "P6C-2 buildSidecar：格式/版本/判据/源图 sha256/全部字段都在"(t) {
    const { g } = mixedGraph();
    const plan = planSession(g, { now: NOW });
    const text = toJSON(g);
    const sc = buildSidecar(g, plan.residue, { now: NOW, sourceSha: sha256(text), sessionId: "sess-p6c" });
    t.eq(sc.format, "dsh-gokifu-dangling-sidecar", "format");
    t.eq(sc.version, 1, "version");
    t.eq(sc.sessionId, "sess-p6c", "sessionId");
    t.eq(sc.source.sha256, sha256(text), "source sha256");
    t.ok(sc.criteria.residue.includes("to==null"), "判据必须写明");
    t.ok(sc.criteria.staleMs > 0, "staleMs");
    t.eq(sc.edges.length, 3, "edges 条数");
    // 全部字段保留：与图里的边 JSON 逐字相同
    for (const e of plan.residue) {
      t.eq(JSON.stringify(sc.edges.find((x) => x.id === e.id)), JSON.stringify(e), `edge ${e.id} 字段必须逐字保留`);
    }
  },

  "P6C-3 dry-run：零写入（前后整树 sha256 不变）"(t) {
    const root = tmpRoot("dry");
    try {
      makeSessionDir(root, "sess-a", () => mixedGraph("sess-a").g);
      makeSessionDir(root, "sess-b", () => {
        const g = createGraph({ sessionId: "sess-b" });
        addUserNode(g, { seq: 1, text: "hi" });
        return g;
      });
      const before = hashTree(root);
      const result = dryRun(root, { now: NOW });
      const after = hashTree(root);
      t.eq(JSON.stringify(after), JSON.stringify(before), "dry-run 不许写任何文件");
      t.eq(result.sessions, 2, "扫到 2 个会话");
      t.eq(result.residue, 3, "residue 3");
      t.eq(result.candidates, 1, "candidates 1（保留）");
      t.eq(result.liveUnsettled, 1, "live 1");
      t.eq(result.fromBroken, 1, "fromBroken 1");
      t.eq(result.sidecarEdges, 3, "sidecar 预计 3 条");
      t.ok(result.deltaBytes < 0, `主图应变小：${result.deltaBytes}`);
      t.eq(nodeFs.existsSync(nodePath.join(root, "sess-a", "graph.dangling.json")), false, "dry-run 不许产 sidecar");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  },

  "P6C-4 apply：整目录备份 + sidecar + 删 residue + 重建 index.md"(t) {
    const root = tmpRoot("apply");
    const backupRoot = tmpRoot("apply-bak");
    try {
      makeSessionDir(root, "sess-a", () => mixedGraph("sess-a").g);
      const beforeGraph = nodeFs.readFileSync(nodePath.join(root, "sess-a", "graph.json"), "utf8");
      const beforeSha = sha256(beforeGraph);
      const res = apply(root, { now: NOW, backupRoot });
      // 备份存在且可逐字恢复
      t.ok(nodeFs.existsSync(res.backupDir), "备份目录必须存在");
      const manifest = JSON.parse(nodeFs.readFileSync(nodePath.join(res.backupDir, "MANIFEST.json"), "utf8"));
      t.ok(manifest.files.length >= 3, `备份文件数 ${manifest.files.length}`);
      const backupGraph = nodeFs.readFileSync(nodePath.join(res.backupDir, "sess-a", "graph.json"), "utf8");
      t.eq(backupGraph, beforeGraph, "备份里的 graph.json 必须与执行前逐字相同");
      t.eq(manifest.files.find((f) => f.rel === "sess-a/graph.json")?.sha256, beforeSha, "清单 sha256");
      // sidecar
      const sc = JSON.parse(nodeFs.readFileSync(nodePath.join(root, "sess-a", "graph.dangling.json"), "utf8"));
      t.eq(sc.edges.length, 3, "sidecar 3 条");
      t.eq(sc.source.sha256, beforeSha, "sidecar 记录的是执行前图 sha");
      // 主图
      const g = fromJSON(nodeFs.readFileSync(nodePath.join(root, "sess-a", "graph.json"), "utf8"));
      t.eq(planSession(g, { now: NOW }).residue.length, 0, "残留必须清零");
      t.eq(planSession(g, { now: NOW }).live.length, 1, "live 必须保留");
      t.eq(planSession(g, { now: NOW }).candidates.length, 1, "candidate 必须保留（P6C-2 不归档未落地边）");
      t.eq(planSession(g, { now: NOW }).fromBroken.length, 1, "fromBroken 必须保留");
      // index.md 重建（不是原样）
      const idx = nodeFs.readFileSync(nodePath.join(root, "sess-a", "index.md"), "utf8");
      t.eq(idx, renderIndexMd(g), "index.md 必须按新图重建");
      // 原子写：不留 tmp 文件
      const leftovers = nodeFs.readdirSync(nodePath.join(root, "sess-a")).filter((f) => f.includes(".tmp-"));
      t.eq(leftovers, [], "不许留 .tmp- 文件");
      t.eq(res.archived, 3, "archived 3");
      t.eq(res.deleted, 3, "deleted 3");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
      nodeFs.rmSync(backupRoot, { recursive: true, force: true });
    }
  },

  "P6C-5 verify：sidecar 数=删边数、residue=0、fromBroken 不变、抽样 10 条逐字相同"(t) {
    const root = tmpRoot("verify");
    const backupRoot = tmpRoot("verify-bak");
    try {
      makeSessionDir(root, "sess-a", () => mixedGraph("sess-a").g);
      makeSessionDir(root, "sess-b", () => mixedGraph("sess-b").g);
      const res = apply(root, { now: NOW, backupRoot });
      const v = verify(root, { now: NOW, backupDir: res.backupDir });
      t.eq(v.ok, true, `verify 必须 ok：${v.problems.join("; ")}`);
      t.eq(v.residue, 0, "residue 0");
      t.eq(v.fromBroken, 2, "fromBroken 2（每个会话 1）");
      t.eq(v.sidecarEdges, 6, "sidecar 6 条");
      t.eq(v.candidates, 2, "candidates 2（每会话 1 条，一条都不许动）");
      t.eq(v.samples.length, Math.min(10, v.sidecarEdges), "抽样条数 = min(10, sidecar 边数)");
      for (const s of v.samples) t.eq(s.identical, true, `抽样 ${s.session}/${s.edge} 必须逐字相同`);
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
      nodeFs.rmSync(backupRoot, { recursive: true, force: true });
    }
  },

  "P6C-6 rollback：从备份逐字恢复（含 index.md / nodes / graph.json）"(t) {
    const root = tmpRoot("rollback");
    const backupRoot = tmpRoot("rollback-bak");
    try {
      makeSessionDir(root, "sess-a", () => mixedGraph("sess-a").g);
      const before = hashTree(root);
      const res = apply(root, { now: NOW, backupRoot });
      t.ok(hashTree(root).some((f) => f.rel === "sess-a/graph.dangling.json"), "apply 后应有 sidecar");
      const r = rollback(res.backupDir);
      t.ok(r.restored > 0, "恢复文件数 > 0");
      // 备份里的 MANIFEST 不参与恢复；其余应逐字一致
      const after = hashTree(root).filter((f) => f.rel !== "MANIFEST.json");
      t.eq(JSON.stringify(after), JSON.stringify(before), "回滚后整树必须逐字一致");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
      nodeFs.rmSync(backupRoot, { recursive: true, force: true });
    }
  },

  "P6C-7 listSessions：只认含 graph.json 的目录，坏 JSON 不崩"(t) {
    const root = tmpRoot("scan");
    try {
      makeSessionDir(root, "sess-a", () => mixedGraph("sess-a").g);
      nodeFs.mkdirSync(nodePath.join(root, "empty"), { recursive: true });
      nodeFs.mkdirSync(nodePath.join(root, "bad"), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(root, "bad", "graph.json"), "{not json", "utf8");
      const list = listSessions(root);
      t.eq(list.length, 2, "只认 sess-a 与 bad（含 graph.json）");
      const d = dryRun(root, { now: NOW }); // 坏 JSON 不许让扫描崩
      t.eq(d.sessions, 2, "扫描数 2");
      t.eq(d.residue, 3, "坏图跳过，不计 residue");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  },

  "P6C-8 路径：sessionsRoot / backupsRoot 都挂在 <DSH_HOME>/chess-context 下（P6C-2 定稿）"(t) {
    const home = nodePath.join(TMP, "fake-dsh-home");
    const graphRootDir = graphRoot({ graphDir: "", dshHome: home });
    t.eq(sessionsRoot(home), nodePath.join(graphRootDir, "sessions"), "会话根必须经 R01 graphRoot（不是自己拼路径）");
    t.eq(graphRootDir, nodePath.join(home, "chess-context"), "graphRoot 缺省 = <DSH_HOME>/chess-context");
    t.eq(backupsRoot(home), nodePath.join(home, "chess-context", "migrate-backups"), "备份根必须在 <DSH_HOME>/chess-context/migrate-backups");
    const old = process.env.DSH_HOME;
    try {
      process.env.DSH_HOME = home;
      t.eq(sessionsRoot(), nodePath.join(home, "chess-context", "sessions"), "DSH_HOME 环境变量必须优先");
      t.eq(backupsRoot(), nodePath.join(home, "chess-context", "migrate-backups"), "备份根跟随 DSH_HOME");
    } finally {
      if (old === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = old;
    }
  },

  "P6C-9 apply 120s 新鲜度守卫：刚写过的图必须拒绝执行（防运行中插件覆盖）"(t) {
    const root = tmpRoot("guard");
    const backupRoot = tmpRoot("guard-bak");
    try {
      // 夹具的时间戳基准是 NOW（远在未来）；这里整体平移成「相对真实时钟的 24 小时前」，
      // 这样守卫（比 mtime）与 residue（比 ts）两套时间轴都成立。
      const REAL = Date.now();
      const shift = NOW - REAL;
      makeSessionDir(root, "sess-fresh", () => {
        const g = mixedGraph("sess-fresh").g;
        for (const e of Object.values(g.edges)) if (Number.isFinite(Number(e.ts))) e.ts = Number(e.ts) - shift;
        return g;
      });
      const fresh = freshSessions(root, { now: REAL });
      t.eq(fresh, ["sess-fresh"], "刚写过的会话必须被判新鲜");
      let error = "";
      try {
        apply(root, { now: REAL, backupRoot });
      } catch (e) {
        error = String(e.message);
      }
      t.includes(error, "拒绝 apply", "apply 必须拒绝");
      t.includes(error, "120s", "报错必须说清守卫窗口");
      t.eq(nodeFs.existsSync(nodePath.join(root, "sess-fresh", SIDECAR_NAME)), false, "拒绝时不许产 sidecar");
      // --force 等价：maxAgeMs=0 ⇒ 守卫窗口为空（CLI 的 --force 就是这个语义）
      const forced = apply(root, { now: REAL, backupRoot: nodePath.join(backupRoot, "forced"), maxAgeMs: 0 });
      t.eq(forced.archived, 3, "--force（maxAgeMs=0）必须跳过守卫并归档 3 条");
      // 过了守卫窗口（120s 之后）再跑：已归档过 ⇒ 幂等 0 条、且不再报「拒绝」
      const ok = apply(root, { now: REAL + APPLY_FRESHNESS_MS + 5000, backupRoot });
      t.eq(ok.archived, 0, "已被 --force 归档过 ⇒ 再跑就是 0 条（幂等，不重复删）");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
      nodeFs.rmSync(backupRoot, { recursive: true, force: true });
    }
  },

  "P6C-11 delta 新鲜也拒绝：只有 graph.json.delta.jsonl 在写时 apply 必须拦住并点名文件"(t) {
    const root = tmpRoot("guard-delta");
    const backupRoot = tmpRoot("guard-delta-bak");
    try {
      t.eq(DELTA_NAME, nodePath.basename(sessionPaths("/tmp/x", "s").deltaFile), "DELTA_NAME 必须与 kifu-persist 的落盘名一致");
      const REAL = Date.now();
      const shift = NOW - REAL;
      const { dir } = makeSessionDir(root, "sess-delta", () => shiftEdgeTimes(mixedGraph("sess-delta").g, shift));
      const graphFile = nodePath.join(dir, "graph.json");
      const deltaFile = nodePath.join(dir, DELTA_NAME);
      nodeFs.writeFileSync(deltaFile, "", "utf8");
      setMtime(graphFile, REAL - 3600_000); // 主图 1 小时前（旧）
      setMtime(deltaFile, REAL - 1000); // delta 1 秒前（新）
      t.eq(freshSessions(root, { now: REAL }), ["sess-delta"], "只有 delta 新鲜也必须判该会话 fresh");
      const ev = freshEvidence(root, { now: REAL });
      t.eq(ev.length, 1, "只应命中 delta 一个文件");
      t.eq(ev[0].file, DELTA_NAME, "命中文件必须是 delta");
      t.ok(ev[0].ageMs < APPLY_FRESHNESS_MS, "ageMs 必须落在窗口内");
      let error = "";
      try {
        apply(root, { now: REAL, backupRoot });
      } catch (e) {
        error = String(e.message);
      }
      t.includes(error, "拒绝 apply", "apply 必须拒绝");
      t.includes(error, DELTA_NAME, "报错必须点名 delta 文件");
      t.includes(error, "sess-delta", "报错必须点名会话");
      t.eq(nodeFs.existsSync(nodePath.join(dir, SIDECAR_NAME)), false, "拒绝时不许产 sidecar");
      // --force 语义 = maxAgeMs 0，必须连 delta 守卫一起绕过
      const forced = apply(root, { now: REAL, backupRoot: nodePath.join(backupRoot, "forced"), maxAgeMs: 0 });
      t.eq(forced.archived, 3, "--force（maxAgeMs=0）必须绕过 delta 守卫并归档 3 条");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
      nodeFs.rmSync(backupRoot, { recursive: true, force: true });
    }
  },

  "P6C-12 delta 缺失不影响：只有 graph.json 且已旧 ⇒ 不判 fresh、apply 放行"(t) {
    const root = tmpRoot("guard-nodelta");
    const backupRoot = tmpRoot("guard-nodelta-bak");
    try {
      const REAL = Date.now();
      const shift = NOW - REAL;
      const { dir } = makeSessionDir(root, "sess-nodelta", () => shiftEdgeTimes(mixedGraph("sess-nodelta").g, shift));
      const deltaFile = nodePath.join(dir, DELTA_NAME);
      t.eq(nodeFs.existsSync(deltaFile), false, "夹具不应有 delta");
      setMtime(nodePath.join(dir, "graph.json"), REAL - 3600_000);
      t.eq(freshSessions(root, { now: REAL }), [], "没有 delta 且主图旧 ⇒ 不判 fresh（delta 缺失不能抛错/误判）");
      t.eq(freshEvidence(root, { now: REAL }), [], "证据也应为空");
      const res = apply(root, { now: REAL, backupRoot });
      t.eq(res.archived, 3, "delta 缺失时必须照常归档 3 条 residue");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
      nodeFs.rmSync(backupRoot, { recursive: true, force: true });
    }
  },

  "P6C-13 旧 mtime 放行：graph 与 delta 都旧 ⇒ 不判 fresh、apply 照常"(t) {
    const root = tmpRoot("guard-old");
    const backupRoot = tmpRoot("guard-old-bak");
    try {
      const REAL = Date.now();
      const shift = NOW - REAL;
      const { dir } = makeSessionDir(root, "sess-old", () => shiftEdgeTimes(mixedGraph("sess-old").g, shift));
      const graphFile = nodePath.join(dir, "graph.json");
      const deltaFile = nodePath.join(dir, DELTA_NAME);
      nodeFs.writeFileSync(deltaFile, "", "utf8");
      setMtime(graphFile, REAL - 3600_000);
      setMtime(deltaFile, REAL - 1800_000);
      t.eq(freshSessions(root, { now: REAL }), [], "两个文件都旧 ⇒ 不判 fresh");
      const res = apply(root, { now: REAL, backupRoot });
      t.eq(res.archived, 3, "旧图旧 delta 必须放行并归档 3 条");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
      nodeFs.rmSync(backupRoot, { recursive: true, force: true });
    }
  },

  "P6C-14 多会话混判：freshSessions 按会话去重，错误逐个点名会话与文件"(t) {
    const root = tmpRoot("guard-multi");
    const backupRoot = tmpRoot("guard-multi-bak");
    try {
      const REAL = Date.now();
      const shift = NOW - REAL;
      // sess-a：主图新（无 delta）
      const a = makeSessionDir(root, "sess-a", () => shiftEdgeTimes(mixedGraph("sess-a").g, shift));
      setMtime(nodePath.join(a.dir, "graph.json"), REAL - 1000);
      // sess-b：主图旧、delta 新
      const b = makeSessionDir(root, "sess-b", () => shiftEdgeTimes(mixedGraph("sess-b").g, shift));
      const bDelta = nodePath.join(b.dir, DELTA_NAME);
      nodeFs.writeFileSync(bDelta, "", "utf8");
      setMtime(nodePath.join(b.dir, "graph.json"), REAL - 3600_000);
      setMtime(bDelta, REAL - 2000);
      // sess-c：主图与 delta 都新 ⇒ 证据 2 条但会话只算 1 个
      const c = makeSessionDir(root, "sess-c", () => shiftEdgeTimes(mixedGraph("sess-c").g, shift));
      const cDelta = nodePath.join(c.dir, DELTA_NAME);
      nodeFs.writeFileSync(cDelta, "", "utf8");
      setMtime(nodePath.join(c.dir, "graph.json"), REAL - 1000);
      setMtime(cDelta, REAL - 1000);
      const fresh = freshSessions(root, { now: REAL }).sort();
      t.eq(fresh, ["sess-a", "sess-b", "sess-c"], "三个会话都应被判 fresh");
      const ev = freshEvidence(root, { now: REAL });
      t.eq(ev.length, 4, "证据按文件计：a 1 + b 1 + c 2 = 4");
      let error = "";
      try {
        apply(root, { now: REAL, backupRoot });
      } catch (e) {
        error = String(e.message);
      }
      t.includes(error, "3 个会话", "错误里的会话数必须去重（3，不是 4）");
      for (const name of ["sess-a", "sess-b", "sess-c"]) t.includes(error, name, `错误必须点名 ${name}`);
      t.includes(error, DELTA_NAME, "错误必须出现 delta 文件名");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
      nodeFs.rmSync(backupRoot, { recursive: true, force: true });
    }
  },

  "P6C-10 坏图逐会话汇总：dry-run 与 apply 都报告，不静默跳过"(t) {
    const root = tmpRoot("badgraph");
    const backupRoot = tmpRoot("badgraph-bak");
    try {
      makeSessionDir(root, "sess-ok", () => mixedGraph("sess-ok").g);
      nodeFs.mkdirSync(nodePath.join(root, "sess-bad"), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(root, "sess-bad", "graph.json"), "{not-json", "utf8");
      const d = dryRun(root, { now: NOW });
      t.eq(d.badGraphs.length, 1, "dry-run 必须汇总 1 个坏图");
      t.eq(d.badGraphs[0].session, "sess-bad", "坏图会话名");
      t.eq(d.badGraphs[0].ok, false, "坏图条目必须带 ok:false");
      t.ok(d.badGraphs[0].reason.length > 0, "坏图必须带错误原文（reason）");
      t.eq(d.residue, 3, "好图照常计入");
      const res = apply(root, { now: NOW, backupRoot });
      t.eq(res.badGraphs.length, 1, "apply 也必须汇总坏图");
      t.eq(res.badGraphs[0].session, "sess-bad", "apply 的坏图会话名");
      t.eq(res.badGraphs[0].ok, false, "apply 的坏图条目也必须 ok:false");
      t.ok(res.badGraphs[0].reason.length > 0, "apply 的坏图必须带 reason");
      t.eq(nodeFs.readFileSync(nodePath.join(root, "sess-bad", "graph.json"), "utf8"), "{not-json", "坏图一个字节都不许改");
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
      nodeFs.rmSync(backupRoot, { recursive: true, force: true });
    }
  },
};

/* ═════════════ P6C-MERGE（task-155）：sidecar 回灌 ═════════════ */

/** 造一个已归档的会话：3 条 residue 进 sidecar、主图里删掉。 */
function archivedSession(label) {
  const root = tmpRoot(label);
  const backupRoot = tmpRoot(`${label}-bak`);
  const sessionId = "sess-merge";
  const { dir } = makeSessionDir(root, sessionId, () => shiftEdgeTimes(mixedGraph(sessionId).g, NOW - Date.now()));
  // 让 apply 的新鲜度守卫放行（文件 mtime 挪到 2 小时前）
  const old = Date.now() - 2 * 3600 * 1000;
  setMtime(nodePath.join(dir, "graph.json"), old);
  if (nodeFs.existsSync(nodePath.join(dir, DELTA_NAME))) setMtime(nodePath.join(dir, DELTA_NAME), old);
  const before = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, "graph.json"), "utf8"));
  const archived = apply(root, { now: Date.now(), backupRoot });
  return { root, backupRoot, dir, before, archived };
}

Object.assign(tests, {
  "P6C-M1 归档 3 条 → merge 回灌：边恢复、residue 回 3、index.md 重建、有显式备份"(t) {
    const fx = archivedSession("merge1");
    try {
      t.eq(fx.archived.archived, 3, "前置：apply 应归档 3 条");
      const graphFile = nodePath.join(fx.dir, "graph.json");
      const beforeMerge = fromJSON(nodeFs.readFileSync(graphFile, "utf8"));
      t.eq(Object.keys(beforeMerge.edges).length, Object.keys(fx.before.edges).length - 3, "主图少了 3 条边");
      t.eq(planSession(beforeMerge, { now: Date.now() }).residue.length, 0, "归档后 residue 应为 0");

      // ── dry-run：只报告，不写 ──
      const dry = mergeSidecar(fx.dir, { backupRoot: fx.backupRoot });
      t.eq(dry.ok, true, `dry-run 应成功：${dry.errors.join("; ")}`);
      t.eq(dry.dryRun, true, "默认必须 dry-run");
      t.eq(dry.merged, 3, "dry-run 报告将合并 3 条");
      t.eq(dry.backupDir, "", "dry-run 不建备份目录");
      t.eq(nodeFs.readFileSync(graphFile, "utf8"), toJSON(beforeMerge), "dry-run 一个字节都不许写");

      // ── apply：真回灌 ──
      const res = mergeSidecar(fx.dir, { apply: true, backupRoot: fx.backupRoot });
      t.eq(res.ok, true, `merge 应成功：${res.errors.join("; ")}`);
      t.eq(res.merged, 3, "3 条边全部回灌");
      t.eq(res.skipped, 0, "没有重复边");
      t.eq(res.indexRebuilt, true, "必须重建 index.md");
      t.ok(res.backupDir.length > 0 && nodeFs.existsSync(res.backupDir), "必须建备份目录");
      t.ok(nodeFs.existsSync(nodePath.join(res.backupDir, "graph.json")), "备份里必须有 graph.json");
      t.ok(nodeFs.existsSync(nodePath.join(res.backupDir, "index.md")), "备份里必须有 index.md");
      t.ok(nodeFs.existsSync(nodePath.join(res.backupDir, "MERGE.json")), "必须有 MERGE.json 审计");

      const after = fromJSON(nodeFs.readFileSync(graphFile, "utf8"));
      t.eq(Object.keys(after.edges).length, Object.keys(fx.before.edges).length, "边数必须回到归档前");
      t.eq(planSession(after, { now: Date.now() }).residue.length, 3, "residue 必须回到 3");
      // sidecar 里每条边的字段必须逐字段相同（不重算、不改写）
      const sidecar = JSON.parse(nodeFs.readFileSync(nodePath.join(fx.dir, SIDECAR_NAME), "utf8"));
      for (const edge of sidecar.edges) t.eq(after.edges[edge.id], edge, `回灌的边必须与 sidecar 逐字段相同：${edge.id}`);
      // index.md 必须被重建（内容与当前图一致）
      t.eq(nodeFs.readFileSync(nodePath.join(fx.dir, "index.md"), "utf8"), renderIndexMd(after), "index.md 必须与当前图一致（重建过）");
    } finally {
      nodeFs.rmSync(fx.root, { recursive: true, force: true });
      nodeFs.rmSync(fx.backupRoot, { recursive: true, force: true });
    }
  },

  "P6C-M2 幂等：同一个 sidecar 再 merge 一次 ⇒ merged 0 / skipped 3，且不写盘不建备份"(t) {
    const fx = archivedSession("merge2");
    try {
      mergeSidecar(fx.dir, { apply: true, backupRoot: fx.backupRoot });
      const graphFile = nodePath.join(fx.dir, "graph.json");
      const indexFile = nodePath.join(fx.dir, "index.md");
      const graphText = nodeFs.readFileSync(graphFile, "utf8");
      const indexText = nodeFs.readFileSync(indexFile, "utf8");
      const graphMtime = nodeFs.statSync(graphFile).mtimeMs;
      const backupsBefore = nodeFs.readdirSync(fx.backupRoot).length;

      const again = mergeSidecar(fx.dir, { apply: true, backupRoot: fx.backupRoot });
      t.eq(again.ok, true, "第二次 merge 仍应成功（幂等，不是错误）");
      t.eq(again.merged, 0, "第二次不该再合并");
      t.eq(again.skipped, 3, "3 条都已存在 ⇒ 全部 skipped");
      t.eq(again.backupDir, "", "没有改动就不建备份");
      t.eq(nodeFs.readFileSync(graphFile, "utf8"), graphText, "graph.json 一个字节都不许变");
      t.eq(nodeFs.readFileSync(indexFile, "utf8"), indexText, "index.md 一个字节都不许变");
      t.eq(nodeFs.statSync(graphFile).mtimeMs, graphMtime, "连 mtime 都不许变（没写盘）");
      t.eq(nodeFs.readdirSync(fx.backupRoot).length, backupsBefore, "不许新增备份目录");
    } finally {
      nodeFs.rmSync(fx.root, { recursive: true, force: true });
      nodeFs.rmSync(fx.backupRoot, { recursive: true, force: true });
    }
  },

  "P6C-M3 坏 format / 坏 version / 空边 / 坏 JSON / 别的会话 ⇒ 拒绝，且图一个字节不改"(t) {
    const fx = archivedSession("merge3");
    try {
      const graphFile = nodePath.join(fx.dir, "graph.json");
      const original = nodeFs.readFileSync(graphFile, "utf8");
      const sidecarFile = nodePath.join(fx.dir, SIDECAR_NAME);
      const good = JSON.parse(nodeFs.readFileSync(sidecarFile, "utf8"));
      const cases = [
        ["format", { ...good, format: "wrong-format" }, "format"],
        ["version", { ...good, version: 99 }, "version"],
        ["empty", { ...good, edges: [] }, "没有边"],
      ];
      for (const [label, payload, needle] of cases) {
        const bad = nodePath.join(fx.dir, `bad-${label}.json`);
        nodeFs.writeFileSync(bad, JSON.stringify(payload), "utf8");
        const r = mergeSidecar(fx.dir, { sidecarFile: bad, apply: true, backupRoot: fx.backupRoot });
        t.eq(r.ok, false, `${label}: 必须拒绝`);
        t.eq(r.merged, 0, `${label}: 不许合并任何边`);
        t.ok(r.errors.some((e) => e.includes(needle)), `${label}: 错误信息应提到 ${needle}，实际 ${r.errors.join("; ")}`);
        t.eq(nodeFs.readFileSync(graphFile, "utf8"), original, `${label}: 图一个字节都不许改`);
      }
      const brokenFile = nodePath.join(fx.dir, "broken.json");
      nodeFs.writeFileSync(brokenFile, "{ 不是 JSON", "utf8");
      const broken = mergeSidecar(fx.dir, { sidecarFile: brokenFile, apply: true, backupRoot: fx.backupRoot });
      t.eq(broken.ok, false, "坏 JSON 必须拒绝");
      t.eq(nodeFs.readFileSync(graphFile, "utf8"), original, "坏 JSON 后图不许改");
      const foreignFile = nodePath.join(fx.dir, "foreign.json");
      nodeFs.writeFileSync(foreignFile, JSON.stringify({ ...good, sessionId: "someone-else" }), "utf8");
      const f = mergeSidecar(fx.dir, { sidecarFile: foreignFile, apply: true, backupRoot: fx.backupRoot });
      t.eq(f.ok, false, "别的会话的 sidecar 必须拒绝");
      t.ok(f.errors.some((e) => e.includes("别的会话")), "错误信息应说明会话不匹配");
      const probe = readSidecar(foreignFile, { sessionId: "sess-merge" });
      t.eq(probe.ok, false, "readSidecar 也要拒绝");
      t.eq(probe.edges.length, 0, "拒绝时不返回任何边");
    } finally {
      nodeFs.rmSync(fx.root, { recursive: true, force: true });
      nodeFs.rmSync(fx.backupRoot, { recursive: true, force: true });
    }
  },

  "P6C-M4 同 id 已存在 ⇒ 跳过、不覆盖当前边；只有新 id 才合并"(t) {
    const fx = archivedSession("merge4");
    try {
      const sidecar = JSON.parse(nodeFs.readFileSync(nodePath.join(fx.dir, SIDECAR_NAME), "utf8"));
      const ids = sidecar.edges.map((e) => e.id);
      const graphFile = nodePath.join(fx.dir, "graph.json");
      // 先手工把其中 1 条放回图里，但字段被改过（模拟「当前边」）
      const g = fromJSON(nodeFs.readFileSync(graphFile, "utf8"));
      g.edges[ids[0]] = { ...JSON.parse(JSON.stringify(sidecar.edges[0])), intent: "当前边的意图（不许被覆盖）" };
      nodeFs.writeFileSync(graphFile, toJSON(g), "utf8");

      const r = mergeSidecar(fx.dir, { apply: true, backupRoot: fx.backupRoot });
      t.eq(r.ok, true, `应成功：${r.errors.join("; ")}`);
      t.eq(r.merged, 2, "只有 2 条是新 id");
      t.eq(r.skipped, 1, "已存在的 1 条必须跳过");
      t.eq(r.mergedIds.includes(ids[0]), false, "已存在的 id 不许进 mergedIds");
      const after = fromJSON(nodeFs.readFileSync(graphFile, "utf8"));
      t.eq(after.edges[ids[0]].intent, "当前边的意图（不许被覆盖）", "已存在的边绝不允许被 sidecar 覆盖");
      for (const id of ids.slice(1)) t.eq(after.edges[id], sidecar.edges.find((e) => e.id === id), `新 id ${id} 应逐字段回灌`);
    } finally {
      nodeFs.rmSync(fx.root, { recursive: true, force: true });
      nodeFs.rmSync(fx.backupRoot, { recursive: true, force: true });
    }
  },

  "P6C-M5 mergeMany：整个会话根批量回灌（CLI 入口）"(t) {
    const root = tmpRoot("merge5");
    const backupRoot = tmpRoot("merge5-bak");
    try {
      for (const id of ["sess-a", "sess-b"]) {
        const { dir } = makeSessionDir(root, id, () => shiftEdgeTimes(mixedGraph(id).g, NOW - Date.now()));
        const old = Date.now() - 2 * 3600 * 1000;
        setMtime(nodePath.join(dir, "graph.json"), old);
        if (nodeFs.existsSync(nodePath.join(dir, DELTA_NAME))) setMtime(nodePath.join(dir, DELTA_NAME), old);
      }
      apply(root, { now: Date.now(), backupRoot });
      const dry = mergeMany(root, { backupRoot });
      t.eq(dry.ok, true, `dry 应成功：${dry.errors.join("; ")}`);
      t.eq(dry.sessions, 2, "两个会话都有 sidecar");
      t.eq(dry.merged, 6, "两个会话各 3 条");
      const res = mergeMany(root, { apply: true, backupRoot });
      t.eq(res.ok, true, `apply 应成功：${res.errors.join("; ")}`);
      t.eq(res.merged, 6, "共回灌 6 条");
      // ★ task-163：共用 backupRoot ⇒ 汇总 backupDirs 去重成 1 条（run 目录），
      //   每会话的备份在 run 目录下的独立子目录里（互不覆盖）。
      t.eq(res.backupDirs.length, 1, `共用 backupRoot 时 backupDirs 必须去重成 1，实际 ${res.backupDirs.length}`);
      const perDirs = res.perSession.map((r) => r.backupDir);
      t.eq(new Set(perDirs).size, 2, "perSession 仍必须各自有路径");
      for (const one of res.perSession) {
        t.ok(nodeFs.existsSync(nodePath.join(one.backupDir, "graph.json")), `${one.session} 的备份不能丢（曾被覆盖）`);
        t.eq(nodePath.dirname(one.backupDir), res.backupDirs[0], "每个会话的子目录都应在同一个 run 目录下");
      }
      t.eq(nodeFs.readdirSync(res.backupDirs[0]).filter((f) => f.startsWith("sess-")).length, 2, "run 目录下应有两个会话子目录");
      for (const id of ["sess-a", "sess-b"]) {
        const g = fromJSON(nodeFs.readFileSync(nodePath.join(root, id, "graph.json"), "utf8"));
        t.eq(planSession(g, { now: Date.now() }).residue.length, 3, `${id} 的 residue 应回到 3`);
      }
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
      nodeFs.rmSync(backupRoot, { recursive: true, force: true });
    }
  },
});

/* ═════════════ P6C-CLI（task-157）：merge 的 --json 与人类摘要 ═════════════ */

Object.assign(tests, {
  "P6C-C1 CLI 输出：不带 --json 打人类摘要（merged/skipped/backup），带 --json 才是 JSON"(t) {
    const fx = archivedSession("cli1");
    const cli = nodePath.join(HERE, "..", "scripts", "migrate-dangling.mjs");
    const run = (args) => {
      try {
        const out = execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
        return { code: 0, out };
      } catch (error) {
        return { code: error.status ?? "spawn-error", out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
      }
    };
    try {
      // ① dry-run（人类摘要）
      const humanDry = run([`--merge-sidecar=${fx.dir}`, `--backup-dir=${fx.backupRoot}`]);
      t.eq(humanDry.code, 0, `dry-run 人类摘要必须 exit 0，实际 ${humanDry.code}\n${humanDry.out}`);
      t.includes(humanDry.out, "== migrate-dangling merge-dry-run ==", "必须打人类摘要标题（不是裸 JSON）");
      t.includes(humanDry.out, "merged 3", `摘要必须写 merged 3，实际：\n${humanDry.out}`);
      t.includes(humanDry.out, "skipped 0", "摘要必须写 skipped 0");
      t.includes(humanDry.out, "dry-run：什么都没写", "dry-run 必须说明没写盘");
      t.notIncludes(humanDry.out, '{\n "mode"', "不带 --json 时不该是 JSON");

      // ② --json 必须是纯 JSON（可直接 parse）
      const jsonDry = run([`--merge-sidecar=${fx.dir}`, `--backup-dir=${fx.backupRoot}`, "--json"]);
      t.eq(jsonDry.code, 0, "--json 必须 exit 0");
      let parsed = null;
      try {
        parsed = JSON.parse(jsonDry.out);
      } catch (error) {
        throw new Error(`--json 输出必须是合法 JSON：${String(error?.message ?? error)}\n${jsonDry.out.slice(0, 300)}`);
      }
      t.eq(parsed.merged, 3, "--json 里 merged 必须是 3");
      t.eq(parsed.dryRun ?? true, true, "--json 里 dryRun 必须是 true");

      // ③ apply（人类摘要）要打 backup 目录
      const humanApply = run([`--merge-sidecar=${fx.dir}`, "--apply", `--backup-dir=${fx.backupRoot}`]);
      t.eq(humanApply.code, 0, `apply 人类摘要必须 exit 0，实际 ${humanApply.code}\n${humanApply.out}`);
      t.includes(humanApply.out, "merged 3", "apply 摘要必须写 merged 3");
      t.includes(humanApply.out, "backup:", `apply 必须打备份目录，实际：\n${humanApply.out}`);
      t.includes(humanApply.out, "已回灌并重建 index.md", "apply 必须说明已写盘");

      // ④ 幂等（人类摘要）：第二次 merged 0 / skipped 3
      const again = run([`--merge-sidecar=${fx.dir}`, "--apply", `--backup-dir=${fx.backupRoot}`]);
      t.eq(again.code, 0, "幂等 merge 必须 exit 0");
      t.includes(again.out, "merged 0", "第二次 merged 必须是 0");
      t.includes(again.out, "skipped 3", "第二次 skipped 必须是 3");

      // ⑤ 坏 sidecar：exit 1 且摘要里能看见错误
      const bad = JSON.parse(nodeFs.readFileSync(nodePath.join(fx.dir, SIDECAR_NAME), "utf8"));
      const badFile = nodePath.join(fx.root, "bad-version.json");
      nodeFs.writeFileSync(badFile, JSON.stringify({ ...bad, version: 99 }), "utf8");
      const badRun = run([`--merge-sidecar=${badFile}`, "--json"]);
      t.eq(badRun.code, 1, "坏 sidecar 必须 exit 1");
      t.includes(badRun.out, "version", "错误信息必须提到 version");

      // ⑥ 目标根本不存在：exit 1 且明确说「目标不存在」（不许默默读 . )
      const missing = run(["--merge-sidecar=DOES-NOT-EXIST-xyz", "--json"]);
      t.eq(missing.code, 1, "目标不存在必须 exit 1");
      t.includes(missing.out, "目标不存在", "错误信息必须说清目标不存在");
    } finally {
      nodeFs.rmSync(fx.root, { recursive: true, force: true });
      nodeFs.rmSync(fx.backupRoot, { recursive: true, force: true });
    }
  },

  "P6C-C2 结构回归：main() 里 merge 的 dispatch 与输出分支各恰好一处（不许再重复）"(t) {
    const src = nodeFs.readFileSync(nodePath.join(HERE, "..", "scripts", "migrate-dangling.mjs"), "utf8");
    const count = (src.match(/opts\.mode === "merge"/g) ?? []).length;
    t.eq(count, 2, `merge 分支必须恰好 2 处（执行 + 输出），实际 ${count}`);
    // 执行链里必须调 mergeMany，输出链里必须有 backup:
    t.includes(src, "mergeMany(opts.mergeTarget", "必须调 mergeMany");
    t.includes(src, "backup:", "人类摘要必须打印备份目录");
    t.includes(src, "已回灌并重建 index.md", "apply 人类摘要必须说明写了什么");
  },
});

/* ═════════════ P6C-BACKUP（task-163）：汇总去重 + 非字节级还原说明 ═════════════ */

Object.assign(tests, {
  "P6C-B1 uniqueBackupDirs：同一 run 目录 ×48 ⇒ 1 条；不同目录 ⇒ 各留一条"(t) {
    const run = nodePath.join("D:", "bak", "merge-2026-01-01T00-00-00-000Z");
    const same = Array.from({ length: 48 }, (_, i) => ({ session: `s${i}`, backupDir: nodePath.join(run, `s${i}`) }));
    const deduped = uniqueBackupDirs(same);
    t.eq(deduped.length, 1, `48 个会话共用一个 run 目录 ⇒ 去重成 1 条，实际 ${deduped.length}`);
    t.eq(deduped[0], run, "去重后应是 run 目录（不是某个会话子目录）");
    // 不同 backupRoot ⇒ 各留一条
    const mixed = [...same, { session: "other", backupDir: nodePath.join("D:", "bak2", "merge-x", "other") }];
    const two = uniqueBackupDirs(mixed);
    t.eq(two.length, 2, `两个不同的 run 目录 ⇒ 2 条，实际 ${two.length}`);
    t.eq(two.includes(nodePath.join("D:", "bak2", "merge-x")), true, "第二个 run 目录必须在");
    // 边界：没有备份 / 空输入
    t.eq(uniqueBackupDirs([{ session: "a", backupDir: "" }]).length, 0, "空 backupDir 要过滤");
    t.eq(uniqueBackupDirs([]).length, 0, "空输入 ⇒ 空数组");
  },

  "P6C-B2 同 root 批量 merge：run 目录 1 个、每会话子目录各自独立、两份备份都不丢（旧版会覆盖）"(t) {
    const root = tmpRoot("b2");
    const backupRoot = tmpRoot("b2-bak");
    try {
      for (const id of ["sess-x", "sess-y"]) {
        const { dir } = makeSessionDir(root, id, () => shiftEdgeTimes(mixedGraph(id).g, NOW - Date.now()));
        const old = Date.now() - 2 * 3600 * 1000;
        setMtime(nodePath.join(dir, "graph.json"), old);
        if (nodeFs.existsSync(nodePath.join(dir, DELTA_NAME))) setMtime(nodePath.join(dir, DELTA_NAME), old);
      }
      apply(root, { now: NOW, backupRoot });
      const beforeX = nodeFs.readFileSync(nodePath.join(root, "sess-x", "graph.json"), "utf8");
      const beforeY = nodeFs.readFileSync(nodePath.join(root, "sess-y", "graph.json"), "utf8");

      const res = mergeMany(root, { apply: true, backupRoot });
      t.eq(res.ok, true, `应成功：${res.errors.join("; ")}`);
      t.eq(res.backupDirs.length, 1, "共用 backupRoot ⇒ 汇总只有 1 个 run 目录");
      t.eq(res.perSession.length, 2, "两个会话各一条结果");
      const dirs = res.perSession.map((r) => r.backupDir);
      t.eq(new Set(dirs).size, 2, "两个会话的备份目录必须不同（否则互相覆盖）");
      for (const one of res.perSession) {
        t.eq(nodePath.dirname(one.backupDir), res.backupDirs[0], "会话子目录都挂在同一个 run 目录下");
      }
      // ★ 关键：旧版这里只剩最后一份 —— 两份备份的 graph.json 内容必须各自等于自己合并前的图
      const xBackup = nodeFs.readFileSync(nodePath.join(res.perSession[0].backupDir, "graph.json"), "utf8");
      const yBackup = nodeFs.readFileSync(nodePath.join(res.perSession[1].backupDir, "graph.json"), "utf8");
      t.eq(xBackup, beforeX, "sess-x 的备份必须是它自己合并前的图（没被 sess-y 覆盖）");
      t.eq(yBackup, beforeY, "sess-y 的备份必须是它自己合并前的图");
      t.notIncludes(xBackup, yBackup, "两份备份不许相同（相同=覆盖了）");
      // MERGE.json 也必须各一份且指向自己的会话
      for (const one of res.perSession) {
        const audit = JSON.parse(nodeFs.readFileSync(nodePath.join(one.backupDir, "MERGE.json"), "utf8"));
        t.eq(audit.session, one.session, `MERGE.json 必须属于 ${one.session}`);
      }
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
      nodeFs.rmSync(backupRoot, { recursive: true, force: true });
    }
  },

  "P6C-B3 merge 不是字节级还原：updatedAt 会刷新，逐字节恢复要走 rollback（文档 + 行为双证）"(t) {
    const fx = archivedSession("b3");
    try {
      const graphFile = nodePath.join(fx.dir, "graph.json");
      const archivedText = nodeFs.readFileSync(graphFile, "utf8");
      const archived = JSON.parse(archivedText);
      // 用一个明显不同的 now，保证 updatedAt 一定被刷新
      const res = mergeSidecar(fx.dir, { apply: true, backupRoot: fx.backupRoot, now: 1_900_000_000_000 });
      t.eq(res.ok, true, `应成功：${res.errors.join("; ")}`);
      const afterText = nodeFs.readFileSync(graphFile, "utf8");
      const after = JSON.parse(afterText);
      t.eq(after.updatedAt, 1_900_000_000_000, "merge 必须刷新 updatedAt（这正是「非字节级还原」的含义）");
      t.eq(after.updatedAt !== archived.updatedAt, true, "updatedAt 必须与归档时不同");
      t.eq(afterText !== archivedText, true, "合并不可能逐字节等于归档前的文本");
      // JSDoc / 文档必须写明这件事，否则用户会以为 merge 能当回滚用
      const src = nodeFs.readFileSync(nodePath.join(HERE, "..", "src", "rooms", "migrate.mjs"), "utf8");
      t.includes(src, "不是字节级还原", "mergeSidecar/mergeMany 的文档必须写明非字节级还原");
      t.includes(src, "--rollback", "文档必须指向 rollback 作为字节级恢复手段");
      t.includes(src, "stateIndex", "文档必须提到 stateIndex 可能不同");
    } finally {
      nodeFs.rmSync(fx.root, { recursive: true, force: true });
      nodeFs.rmSync(fx.backupRoot, { recursive: true, force: true });
    }
  },
});
