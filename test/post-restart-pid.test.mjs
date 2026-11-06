/**
 * post-restart-pid.test.mjs —— 启动戳里的 pid 死了就必须说「不可信」（C293）
 *
 * 真实踩坑（2026-11-02）：build.json 写 pid 37616 / startedAt 12:30:05Z，
 * 而那个进程**早就不在了**。把它当"运行实例就绪时间"会把整轮判断带偏。
 */
import { pidAlive } from "../scripts/post-restart-check.mjs";

export const tests = {};

tests["C293 pid 探活：活着的进程 true、死的 pid false、坏值 null"] = (t) => {
  t.eq(pidAlive(process.pid), true, "自己一定活着");
  // 找一个几乎不可能存在的 pid（进程号上限内，且不是自己）
  const bogus = 2 ** 22 + 12345;
  t.eq(pidAlive(bogus), false, `不存在的 pid 必须判 false（${bogus}）`);
  t.eq(pidAlive(0), null, "0 不是合法 pid");
  t.eq(pidAlive(-1), null, "负数不是合法 pid");
  t.eq(pidAlive(Number.NaN), null, "NaN 不是合法 pid");
  t.eq(pidAlive(1.5), null, "非整数不是合法 pid");
};

tests["C294 能力探针：未知 action 必须判「内存里那份模块比磁盘旧」"] = async (t) => {
  const mod = await import("../scripts/post-restart-check.mjs");
  t.eq(typeof mod.checkPanelCapabilities, "function", "必须导出 checkPanelCapabilities");
  // 不可达端口 ⇒ warn（不许抛，也不许判 ok）
  const down = await mod.checkPanelCapabilities(undefined, { port: 1, timeoutMs: 300 });
  t.eq(down.level, "warn", "面板不可达必须 warn");
  t.includes(down.detail, "不可达", "要说清是端口不可达");
};

tests["C331 能力探针只认阳性证据（405/非 JSON 不算认识）"] = async (t) => {
  const mod = await import("../scripts/post-restart-check.mjs");
  // 面板不可达 ⇒ warn（已有 C294 覆盖），这里补：**死路由**（405）绝不能被判成"认识"
  const dead = await mod.checkPanelCapabilities([{ action: "state" }], { port: 1, timeoutMs: 300 });
  t.eq(dead.level, "warn", "不可达必须 warn");
  t.eq(dead.known, [], "不可达时不许把 action 记成 known");
};

tests["C331 验收判定：路由不响应时必须判 stale，不许判 ready"] = async (t) => {
  const mod = await import("../scripts/accept-after-restart.mjs");
  const r = mod.verdictOf({
    caps: { level: "warn", known: [], unknown: ["update", "backfill"] },
    backfill: { reachable: false, due: null, error: "HTTP 405" },
    closeout: { seen: false, sessions: 0 },
    truncation: { collected: 0, truncated: 0 },
    buildOk: false,
  });
  t.eq(r.verdict, "stale", `路由死了必须 stale：${JSON.stringify(r)}`);
  t.includes(r.line, "重启", "要告诉人重启");
  t.eq(r.todo.length >= 2, true, "至少要列出面板不认识 + buildId 不符");
};

tests["C331 验收判定：全部阳性时判 ready"] = async (t) => {
  const mod = await import("../scripts/accept-after-restart.mjs");
  const r = mod.verdictOf({
    caps: { level: "ok", known: ["update", "backfill"], unknown: [] },
    backfill: { reachable: true, due: 3, error: null },
    closeout: { seen: true, sessions: 1 },
    truncation: { collected: 5, truncated: 0 },
    buildOk: true,
  });
  t.eq(r.verdict, "ready", `全阳性必须 ready：${JSON.stringify(r)}`);
  t.includes(r.line, "欠账 3", "要带出欠账数");
};

tests["C338 端口属主与心跳 pid 对不上时要说清楚（多进程环境的真相）"] = async (t) => {
  const mod = await import("../scripts/accept-after-restart.mjs");
  t.eq(typeof mod.listeningPidOf, "function", "必须导出 listeningPidOf");

  // Windows netstat 真实片段（注意首列是协议名，本地地址在第 2 列，pid 在末列）
  const sample = [
    "  TCP    127.0.0.1:64349        0.0.0.0:0              LISTENING       24944",
    "  TCP    127.0.0.1:60037        0.0.0.0:0              LISTENING       10048",
    "  TCP    127.0.0.1:64349        127.0.0.1:52000        ESTABLISHED     24944",
  ].join("\n");
  t.eq(mod.listeningPidOf(sample, 64349), 24944, "要挑出监听该端口的 pid");
  t.eq(mod.listeningPidOf(sample, 60037), 10048, "另一个端口也要对");
  t.eq(mod.listeningPidOf(sample, 12345), null, "没有就 null");
  // 只认 LISTENING（ESTABLISHED 那行不许算）
  t.eq(mod.listeningPidOf("  TCP    127.0.0.1:9999  0.0.0.0:0  ESTABLISHED  777", 9999), null, "非 LISTENING 不算");
};

async function runAcceptFixture({ json = false, staleBuild = false } = {}) {
  const nodeFs = await import("node:fs");
  const nodeOs = await import("node:os");
  const nodePath = await import("node:path");
  const mod = await import("../scripts/accept-after-restart.mjs");
  const { repoBuildId } = await import("../src/rooms/build-stamp.mjs");
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "accept-fixture-"));
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const previousDiscover = process.env.DSH_GOKIFU_NO_PORT_DISCOVER;
  const logs = [];
  try {
    const graphDir = nodePath.join(home, "chess-context");
    const sessionDir = nodePath.join(graphDir, "sessions", "debt");
    nodeFs.mkdirSync(sessionDir, { recursive: true });
    const now = Date.now();
    nodeFs.writeFileSync(nodePath.join(sessionDir, "graph.json"), JSON.stringify({
      version: 1,
      sessionId: "debt",
      cwd: home,
      rootUserNodeIds: ["n1"],
      nodes: {
        n1: { id: "n1", kind: "user", seq: 1, text: "目标", constraints: [], ts: now },
        n2: { id: "n2", kind: "agent", seq: 200, text: "末", ts: now },
      },
      edges: {}, order: ["n1", "n2"], stateIndex: {},
      foldMarks: [{ seqStart: 1, seqEnd: 100, shadowedTokens: 100_000, ms: 1000 }],
      createdAt: now,
      updatedAt: now,
    }), "utf8");
    nodeFs.writeFileSync(nodePath.join(graphDir, "ui-route.json"), JSON.stringify({
      state: "open",
      pid: process.pid,
      port: 1,
      at: now,
      buildId: staleBuild ? "definitely-not-the-disk-build" : repoBuildId(),
    }), "utf8");
    globalThis.fetch = async (_url, init = {}) => {
      const action = JSON.parse(String(init.body ?? "{}")).action;
      const payload = action === "health"
        ? { ok: true, installed: true, profile: "fixture" }
        : action === "backfill"
          ? { ok: true, dryRun: true, due: 1, items: [] }
          : { ok: true };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
    process.env.DSH_GOKIFU_NO_PORT_DISCOVER = "1";
    console.log = (...args) => logs.push(args.join(" "));
    const code = await mod.main(["--home", home, "--port", "1", ...(json ? ["--json"] : [])]);
    const text = logs.join("\n");
    return { code, text, json: json ? JSON.parse(text) : null };
  } finally {
    globalThis.fetch = previousFetch;
    console.log = previousLog;
    if (previousDiscover === undefined) delete process.env.DSH_GOKIFU_NO_PORT_DISCOVER;
    else process.env.DSH_GOKIFU_NO_PORT_DISCOVER = previousDiscover;
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
}

tests["C353 验收脚本不许把 buildOk 写死 true（旧代码是最常见的情形）"] = async (t) => {
  // 真跑 main：新鲜心跳里的 buildId 与磁盘不同，必须经 repoBuildId 实算后判 stale。
  const stale = await runAcceptFixture({ json: true, staleBuild: true });
  t.eq(stale.code, 2, `构建不一致必须返回 stale 退出码：${stale.text}`);
  t.eq(stale.json.verdict, "stale", "构建不一致必须 stale");
  t.eq(stale.json.todo.some((line) => line.includes("buildId")), true, "必须说明是实际 buildId 比较不一致");

  // 判定函数本身仍保留 unknown 三态：拿不到磁盘/心跳时不许硬判 stale。
  const mod = await import("../scripts/accept-after-restart.mjs");
  const unknown = mod.verdictOf({
    caps: { level: "ok", known: ["update"], unknown: [] },
    backfill: { reachable: true, due: 0, error: null },
    closeout: { seen: true, sessions: 1 },
    truncation: { collected: 3, truncated: 0 },
    buildOk: null,
  });
  t.eq(unknown.verdict, "ready", "构建未知时不该硬判 stale");
};

tests["C386 验收命令要顺带给出补账摘要（别让人再跑第二条命令）"] = async (t) => {
  // 隔离 home 放一笔真实欠账，人读 main 必须经 backfill-plan 算出计划，而非落入降级文案。
  const result = await runAcceptFixture();
  t.includes(result.text, "补账：1 个欠账", `必须打印真实欠账数：\n${result.text}`);
  t.includes(result.text, "次点击", "必须打印由计划算出的点击数");
  t.includes(result.text, "closeoutMaxFoldTokens", "必须打印由计划算出的建议旋钮");
  t.notIncludes(result.text, "补账：算不出来", "有真实欠账时不许掉进降级分支");
};

tests["C405 验收命令顺带带上 doctor 一句话（健康与接管是同一时刻的两个问题）"] = async (t) => {
  // 真跑人读 main：doctor 行只能来自子进程 stdout 的「错误 N / 警告 M」。
  const result = await runAcceptFixture();
  t.eq(/doctor：错误 \d+ \/ 警告 \d+/.test(result.text), true,
    `必须真的执行 doctor 子进程并解析其汇总行：\n${result.text}`);
};

tests["C409/C410 参数级探针 + 端口自动发现（心跳被覆盖时也能找到面板）"] = async (t) => {
  const mod = await import("../scripts/accept-after-restart.mjs");

  // ① listeningPorts：从 netstat 文本取监听端口
  const netstat = [
    "  TCP    127.0.0.1:56319        0.0.0.0:0              LISTENING       37108",
    "  TCP    127.0.0.1:64349        0.0.0.0:0              LISTENING       24944",
    "  TCP    127.0.0.1:56319        127.0.0.1:52000        ESTABLISHED     37108",
    "  TCP    [::1]:8080             [::]:0                 LISTENING       777",
  ].join("\n");
  t.eq(mod.listeningPorts(netstat), [8080, 56319, 64349], "去重 + 只认 LISTENING + 升序");

  // ② sessionIdsProbe：400 = 支持；200+dryRun = 不支持；其它 = 未知
  t.eq(mod.sessionIdsProbe({ status: 400, json: { error: "指定的 sessionIds 都不在待补清单里" } }), "supported", "400 说明参数被识别");
  t.eq(mod.sessionIdsProbe({ status: 200, json: { dryRun: true, items: [] } }), "unsupported", "200+dryRun 说明参数被忽略");
  t.eq(mod.sessionIdsProbe({ status: 500, json: null }), "unknown", "其它情况不许下结论");
  t.eq(mod.sessionIdsProbe({ status: 200, json: { ok: true } }), "unknown", "没有 dryRun 标记也算未知");
};

tests["C413 探针正面判定：ok:true + 软错误（registry 不可达）仍算认识这个 action"] = async (t) => {
  const mod = await import("../scripts/post-restart-check.mjs");
  t.eq(typeof mod.probePositive, "function", "必须导出 probePositive");

  // 典型误判：action 跑通了，但查 registry 失败 ⇒ 响应带 error 字符串
  t.eq(mod.probePositive({ status: 200, json: { ok: true, latest: null, error: "请求 registry 超时" } }), true,
    "ok:true + 软错误仍算认识（C413）");
  // 真正的「不认识」
  t.eq(mod.probePositive({ status: 200, json: { error: "未知 action: xxx" } }), false, "未知 action 必须判不认识");
  // 正常响应
  t.eq(mod.probePositive({ status: 200, json: { ok: true, error: null } }), true, "正常响应算认识");
  t.eq(mod.probePositive({ status: 200, json: { error: null, version: "1" } }), true, "error:null 也算认识");
  // 非 2xx / 非 JSON 一律不认识
  t.eq(mod.probePositive({ status: 405, json: null }), false, "405 不算");
  t.eq(mod.probePositive({ status: 200, json: null }), false, "非 JSON 不算");
  t.eq(mod.probePositive({ status: 500, json: { ok: true } }), false, "5xx 不算");
};

tests["C415 面板识别要严：本机有好几个服务对任意 POST 都回 200"] = async (t) => {
  const mod = await import("../scripts/accept-after-restart.mjs");
  t.eq(typeof mod.looksLikePanel, "function", "必须导出 looksLikePanel");
  // 真正的面板
  t.eq(mod.looksLikePanel({ ok: true, profile: "desktop", installed: true }), true, "面板 health 认得");
  t.eq(mod.looksLikePanel({ ok: true, presets: [] }), true, "带 presets 也认得");
  // 别人的服务：200 但长相不同
  t.eq(mod.looksLikePanel({ ok: true }), false, "只有 ok 不够（本机实测有服务这样回）");
  t.eq(mod.looksLikePanel({ hello: "world" }), false, "无关 JSON 不认");
  t.eq(mod.looksLikePanel(null), false, "null 不认");
  // 端口清单只保留高位端口（避免扫 80/443 等系统服务把命令拖死）
  const netstat = [
    "  TCP    0.0.0.0:80      0.0.0.0:0  LISTENING  4",
    "  TCP    127.0.0.1:56319 0.0.0.0:0  LISTENING  37108",
    "  TCP    127.0.0.1:443   0.0.0.0:0  LISTENING  4",
  ].join("\n");
  t.eq(mod.listeningPorts(netstat), [56319], "只留 >=1024 的高位端口");
};

tests["C438 验收脚本退出码必须区分三态（ready=0 / partial=1 / stale=2）"] = async (t) => {
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const src = nodeFs.readFileSync(nodePath.join(here, "..", "scripts", "accept-after-restart.mjs"), "utf8");
  // 旧写法只有 stale→1，partial 会被当成成功；脚本里 `if accept; then …` 就会误判
  t.eq(src.includes('result.verdict === "stale" ? 1 : 0'), false, "不许只有 stale→1（partial 会被当成功）");
  t.includes(src, 'result.verdict === "ready" ? 0 : result.verdict === "partial" ? 1 : 2', "必须三态映射");
};

tests["C439 面板端口解析：null 不许变 0，候选不许按前 12 个截断"] = async (t) => {
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  for (const f of ["accept-after-restart.mjs", "post-restart-check.mjs", "status.mjs"]) {
    const src = nodeFs.readFileSync(nodePath.join(here, "..", "scripts", f), "utf8");
    // Number(null) === 0 且 isFinite(0) 为 true ⇒ 旧写法把 port:null 当成端口 0
    t.eq(src.includes("return Number.isFinite(Number(hb?.port)) ? Number(hb.port) : null;"), false, `${f}: null 会被当成 0（C439）`);
    // 候选端口按数字升序，真正的面板（56319）排在第 20 个之后 ⇒ 截断前 12 个会永远找不到
    t.eq(src.includes("listeningPorts(out).slice(0, 12)"), false, `${f}: 不许按前 12 个截断候选（C439）`);
  }
};
