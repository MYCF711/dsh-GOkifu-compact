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
import { createGraph, addUserNode, addEdge, settleEdge, addAgentNode, toJSON, fromJSON, renderIndexMd } from "./graph-fixtures.mjs";
import { DANGLING_STALE_MS } from "../src/rooms/ledger.mjs";
import { graphRoot, sessionPaths } from "../src/rooms/kifu-persist.mjs";
import { planSession, buildSidecar, dryRun, apply, verify, rollback, hashTree, sha256, listSessions, sessionsRoot, backupsRoot, freshSessions, freshEvidence, APPLY_FRESHNESS_MS, DELTA_NAME, SIDECAR_NAME } from "../src/rooms/migrate.mjs";

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
