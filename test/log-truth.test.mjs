/**
 * log-truth.test.mjs —— 「自动补账避开 0 个」这行必须说真话（C614 / T36）
 *
 * ## 事故
 *
 * 补账定时器每轮（10 分钟）都打：
 *
 *     chess-context: 自动补账避开 0 个刚补过的会话（冷却 45 分钟）
 *
 * 而条件写的是
 *
 *     const pickPool = notCooling.length >= Math.min(max, withLog.length) ? notCooling : withLog;
 *     if (pickPool !== withLog) { info(`… 避开 ${withLog.length - pickPool.length} 个 …`) }
 *
 * `withLog` / `notCooling` 都是 `filter()` 出来的**新数组**，`pickPool` 就是其中一个
 * ⇒ `pickPool !== withLog` 在「走了过滤分支」时**恒真**：一个都没冷却也照打「避开 0 个」，
 * 读日志的人没法用这个数字判断冷却到底工作过没有。
 *
 * ## 这里钉住什么
 *
 *   ① **反向**（避开 0 个）：冷却表为空 ⇒ 一个都没避开 ⇒ **不许写**这行；
 *   ② **正向**（避开 N 个）：冷却 2 个 ⇒ 必须写「避开 2 个」，而且**数字是 2 不是 0**；
 *   ③ **回退**（全冷却）：冷却到不够 `max` 个 ⇒ 退回完整列表（`pickPool === withLog`）
 *      ⇒ 同样**不许写**（回退不是「避开」，不能拿它冒充）；
 *   ④ **静态守卫**：`src/**` 里不许再出现「两个新数组比引用」的判断；
 *   ⑤ **守卫自检**：把旧写法喂给扫描器必须报红（否则 ④ 是永远绿的摆设）。
 *
 * 夹具刻意用「空日志」：`#offlineCloseoutFold` 读到 `events.length === 0` 立刻
 * 返回 `stopped: "empty-log"` —— 不调模型、不花钱、毫秒级结束，而**要测的那行日志
 * 在进循环之前就打完了**。跑的是 `runAutoBackfillOnce()`（与定时器同一条代码）。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");
/** 被审计的那行日志的定位串（与 `scripts/log-truth-audit.mjs` 同一个，改文案要两边一起改）。 */
const TARGET_NEEDLE = "自动补账避开";
/** 夹具会话数：>10 ⇒ `dueNow > 10` ⇒ 每轮 `max = 3`（真机同一条分档）。 */
const FIXTURE_SESSIONS = 12;

export const tests = {};

/* ────────────────────────── 夹具 ────────────────────────── */

/**
 * 造一个「有欠账、日志为空」的 home（只写临时目录，不碰真实 DSH_HOME）。
 *
 * @param {string} home
 * @returns {string[]} 会话 id（顺序固定，冷却档位按下标切）
 */
function buildFixture(home) {
  const graphDir = nodePath.join(home, "chess-context");
  const sessionsDir = nodePath.join(graphDir, "sessions");
  const logRoot = nodePath.join(home, "sessions", "--ws--");
  const now = Date.now();
  const ids = [];
  for (let i = 0; i < FIXTURE_SESSIONS; i += 1) {
    const id = `log-truth-${String(i).padStart(2, "0")}`;
    ids.push(id);
    const gdir = nodePath.join(sessionsDir, id);
    nodeFs.mkdirSync(gdir, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(gdir, "graph.json"),
      JSON.stringify({
        version: 1,
        rootUserNodeIds: ["n1"],
        nodes: {
          n1: { id: "n1", kind: "user", seq: 1, text: "把构建跑通", constraints: [], ts: now },
          n2: { id: "n2", kind: "agent", seq: 200, text: "末", ts: now },
        },
        edges: {},
        order: ["n1", "n2"],
        // 没有 foldMark ⇒ tail = 200 ⇒ due（> closeoutMinEvents）
        foldMarks: [],
        updatedAt: now,
      }),
      "utf8",
    );
    const logDir = nodePath.join(logRoot, `session-${id}`);
    nodeFs.mkdirSync(logDir, { recursive: true });
    const logFile = nodePath.join(logDir, "session.v4.jsonl.zstd");
    nodeFs.writeFileSync(logFile, Buffer.alloc(0));
    // 做旧 10 分钟：tick 会跳过「5 分钟内还在写」的活会话
    const old = (Date.now() - 10 * 60_000) / 1000;
    nodeFs.utimesSync(logFile, old, old);
  }
  return ids;
}

/**
 * 跑一轮真 tick，返回「自动补账避开」那行的原文（没有就 null）与状态文件。
 *
 * @param {number} cooling 冷却表里预置几个会话（生产里由上一轮 `.set(id, Date.now())` 写入）
 * @returns {Promise<{line:string|null, avoided:number|null, state:object|null}>}
 */
async function runTick({ cooling }) {
  const harness = await import(pathToFileURL(nodePath.join(HERE, "engine-harness.test.mjs")).href);
  const { Engine } = await harness.load();
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "log-truth-"));
  try {
    const ids = buildFixture(home);
    const ctx = harness.makeCtx();
    const lines = [];
    ctx.logger.info = (message) => lines.push(String(message));
    const graphDir = nodePath.join(home, "chess-context");
    const engine = new Engine(ctx, { graphDir, auto: false, closeoutMinEvents: 10 });
    engine._backfillLastPicked = new Map(ids.slice(0, cooling).map((id) => [id, Date.now()]));
    await engine.runAutoBackfillOnce();
    const line = lines.find((row) => row.includes(TARGET_NEEDLE)) ?? null;
    const m = line === null ? null : /自动补账避开\s+(\d+)\s+个/.exec(line);
    let state = null;
    try {
      state = JSON.parse(nodeFs.readFileSync(nodePath.join(graphDir, "auto-backfill-state.json"), "utf8"));
    } catch {
      /* 状态文件是附加证据，缺了不算失败（另有测试守着它） */
    }
    return { line, avoided: m === null ? null : Number(m[1]), state };
  } finally {
    nodeFs.rmSync(home, { recursive: true, force: true });
    // harness 把变异副本写进 src/，用完就清（与 test/run.mjs 收尾同一套动作）
    for (const name of (() => {
      try {
        return nodeFs.readdirSync(nodePath.join(ROOT, "src"));
      } catch {
        return [];
      }
    })()) {
      if (name.startsWith(".engine-under-test") && name.endsWith(".mjs")) nodeFs.rmSync(nodePath.join(ROOT, "src", name), { force: true });
    }
  }
}

/* ────────────────────────── 用例 ────────────────────────── */

tests["C614 反向：冷却 0 个时**不许**写「避开 0 个」（旧代码在这里恒真）"] = async (t) => {
  const { line } = await runTick({ cooling: 0 });
  t.eq(line, null, `一个都没避开时不许打日志（旧代码打的是「${line ?? ""}」）`);
};

tests["C614 正向：冷却 2 个时必须写「避开 2 个」，而且真是 2 不是 0"] = async (t) => {
  const { line, avoided, state } = await runTick({ cooling: 2 });
  t.eq(line !== null, true, "冷却生效时必须留下这行（日志减少 ≠ 修好）");
  t.eq(avoided, 2, `数字必须是实际避开的 2 个（实际：${line ?? "（没写）"}）`);
  t.includes(line ?? "", "冷却 45 分钟", "文案里要保留冷却窗口，否则读日志的人不知道在避什么");
  t.eq(Array.isArray(state?.results) && state.results.length >= 1, true, "这一轮必须真的挑到了会话（否则 2 是空算出来的）");
};

tests["C614 回退：冷却到不够 max 个 ⇒ 退回完整列表，同样不许拿「避开 0 个」冒充"] = async (t) => {
  const { line } = await runTick({ cooling: FIXTURE_SESSIONS });
  t.eq(line, null, `回退完整列表 = 一个都没避开 ⇒ 不许写日志（实际：${line ?? "（没写）"}）`);
};

tests["C614 静态守卫：src/** 里不许再有「两个新数组比引用」的判断"] = async (t) => {
  const { scanSource } = await import(pathToFileURL(nodePath.join(ROOT, "scripts", "log-truth-audit.mjs")).href);
  const engineFile = nodePath.join(ROOT, "src", "engine.mjs");
  const hits = scanSource(engineFile, nodeFs.readFileSync(engineFile, "utf8")).filter((hit) => hit.rule === "fresh-identity");
  t.eq(hits, [], `engine.mjs 里还有恒真判断：${JSON.stringify(hits.map((h) => `${h.line} ${h.snippet}`))}`);
};

tests["C614 守卫自检：把旧写法喂给扫描器必须报红（否则上一条是摆设）"] = async (t) => {
  const { scanSource } = await import(pathToFileURL(nodePath.join(ROOT, "scripts", "log-truth-audit.mjs")).href);
  // ① 旧写法（两个 filter 出来的数组比引用）—— 必须认出来
  const bad = [
    "const withLog = (listed.items ?? []).filter(Boolean);",
    "const notCooling = withLog.filter(Boolean);",
    "const pickPool = notCooling.length >= 1 ? notCooling : withLog;",
    "if (pickPool !== withLog) { log(); }",
  ].join("\n");
  const badHits = scanSource("probe.mjs", bad).filter((hit) => hit.rule === "fresh-identity");
  t.eq(badHits.length, 1, `旧写法必须被认出来（实际 ${badHits.length} 条）`);
  t.includes(badHits[0]?.why ?? "", "恒真", "判定要说明为什么恒真");

  // ② 修好后的写法（比 length）—— 不许红（`!==` 用在原始值上是对的，别一起改）
  const good = [
    "const withLog = (listed.items ?? []).filter(Boolean);",
    "const notCooling = withLog.filter(Boolean);",
    "const pickPool = notCooling.length >= 1 ? notCooling : withLog;",
    "if (pickPool.length < withLog.length) { log(); }",
  ].join("\n");
  t.eq(scanSource("probe.mjs", good), [], "正确写法不许假红");

  // ③ 注释里的旧代码不许假红（本仓库注释里大量引用历史写法）
  const commented = ["// 旧版曾写：if (pickPool !== withLog) {}", "/* if (a.filter(Boolean) !== b.map(Boolean)) {} */", "const x = 1;"].join("\n");
  t.eq(scanSource("probe.mjs", commented), [], "注释里的旧代码不许算命中");
};
