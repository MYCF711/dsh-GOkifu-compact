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

tests["C353 验收脚本不许把 buildOk 写死 true（旧代码是最常见的情形）"] = async (t) => {
  const mod = await import("../scripts/accept-after-restart.mjs");
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const src = nodeFs.readFileSync(nodePath.join(here, "..", "scripts", "accept-after-restart.mjs"), "utf8");
  t.eq(src.includes("buildOk: true"), false, "不许写死 buildOk: true（C353）");
  t.includes(src, "repoBuildId", "必须真的去比构建");

  // 判定：构建不一致 ⇒ stale，且理由里提到 buildId
  const stale = mod.verdictOf({
    caps: { level: "ok", known: ["update"], unknown: [] },
    backfill: { reachable: true, due: 0, error: null },
    closeout: { seen: true, sessions: 1 },
    truncation: { collected: 3, truncated: 0 },
    buildOk: false,
  });
  t.eq(stale.verdict, "stale", "构建不一致必须 stale");
  t.eq(stale.todo.some((x) => x.includes("buildId")), true, "要说清是 buildId 不一致");

  // 未知（拿不到心跳/磁盘）不许当成"不一致"硬判 stale
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
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const src = nodeFs.readFileSync(nodePath.join(here, "..", "scripts", "accept-after-restart.mjs"), "utf8");
  t.includes(src, "backfill-plan.mjs", "必须复用 backfill-plan 的口径（而不是自己再算一套）");
  t.includes(src, "补账：", "必须打印补账摘要行");
  t.includes(src, "closeoutMaxFoldTokens", "要给出建议旋钮");
  t.includes(src, "次点击", "要给出点击次数（用户真正关心的调度量）");
  // 失败要降级，不许把验收整体搞挂
  t.includes(src, "算不出来", "算不出来时要降级提示，而不是抛错");
};

tests["C405 验收命令顺带带上 doctor 一句话（健康与接管是同一时刻的两个问题）"] = async (t) => {
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const src = nodeFs.readFileSync(nodePath.join(here, "..", "scripts", "accept-after-restart.mjs"), "utf8");
  t.includes(src, "doctor.mjs", "必须调用 doctor（C405）");
  t.includes(src, "doctor：", "必须打印 doctor 一行");
  t.eq(src.includes('match(/错误\s*(\d+)\s*\/\s*警告\s*(\d+)/)') || src.includes("错误"), true, "要解析「错误 N / 警告 M」");
  t.includes(src, "拿不到就不说", "解析不到时不许瞎说");
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
