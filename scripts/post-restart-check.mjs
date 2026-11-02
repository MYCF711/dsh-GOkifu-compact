/**
 * post-restart-check.mjs —— 重启后「新代码真的接管了吗」的一键核对（2026-11-02，C69）
 *
 * 为什么需要：这一版的核心新能力（buildId 一致、超预算归因字段、C51/C52/C56 的成本下降）
 * **都要等 DSH 重启**才生效，而重启只能由用户执行。重启之后最需要的是一条命令回答：
 * 「现在跑的是新代码吗？新字段开始写了吗？还有没有红线？」
 *
 * 判据全部是**可复核的事实**（不猜、不调用模型）：
 *   ① build.json 存在，且 buildId 与磁盘仓库一致（C53）；
 *   ② 版本号与 package.json 一致；
 *   ③ ledger-budget.json 出现了新归因字段（budgetFloorOver / budgetIrreducible / overBySession…）
 *      —— 这些字段只在「有 over-budget 渲染」时才会写，所以**缺失时是 warn（未采集）而不是 fail**；
 *   ④ doctor 跑出来 0 错误；
 *   ⑤ boundary-audit 0 findings（仓库侧纪律，重启与否都该成立）。
 *
 * 用法：node scripts/post-restart-check.mjs [--home DIR] [--json]
 * 退出码：0 全绿（允许 warn）；1 有 fail。
 */

import { execFileSync } from "node:child_process";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildStamp, repoBuildId, repoVersion } from "../src/rooms/build-stamp.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

/** 只读本地 home（默认为 $DSH_HOME 或 ~/.dsh）。 */
/**
 * ★ C293：pid 还活着吗？
 * @param {number} pid
 * @returns {boolean|null} null = 无法判断（pid 不合法 / 平台不支持）
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0); // 只探测，不发信号
    return true;
  } catch (error) {
    // EPERM = 进程存在但没权限（也算活着）；ESRCH = 不存在
    if (error && error.code === "EPERM") return true;
    if (error && error.code === "ESRCH") return false;
    return null;
  }
}

export function defaultHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : nodePath.join(nodeOs.homedir(), ".dsh");
}

/**
 * 纯评估函数（不读盘，便于单测）：把「戳 + 磁盘构建标识 + 版本 + 预算统计」判成一张检查表。
 * @returns {{ok:boolean, checks:Array<{id:string,name:string,level:"ok"|"warn"|"fail",detail:string}>}}
 */
export function evaluatePostRestart({ stamp = null, diskBuildId = "unknown", version = "unknown", budget = null, latestFold = null } = {}) {
  const checks = [];
  const push = (id, name, level, detail) => checks.push({ id, name, level, detail });

  if (stamp === null || typeof stamp !== "object") {
    push("stamp", "build.json 存在", "fail", "没有 build.json —— 插件没在本次进程里写过启动戳");
  } else {
    // ★ C293：先确认「这个 pid 还活着」。
    //   实测（2026-11-02）：build.json 写着 pid 37616 / startedAt 12:30:05Z，
    //   而该进程**早已不存在** —— 启动戳是**已死进程**留下的，拿它当"运行实例就绪时间"会把人带沟里。
    const pidValue = Number(stamp.pid);
    const alive = pidAlive(pidValue);
    push(
      "stamp",
      "build.json 存在",
      alive === false ? "warn" : "ok",
      alive === false
        ? `⚠ 启动戳里的 pid ${pidValue} **已经不存在** —— 这份 stamp 是已退出的进程留下的，` +
            `「启动于 …」不可信；判断代码是否生效请看下面的 buildId 与面板能力探针`
        : `启动于 ${Number.isFinite(stamp.startedAt) ? new Date(stamp.startedAt).toISOString() : "?"}（pid ${stamp.pid ?? "?"}）`,
    );
    const running = typeof stamp.buildId === "string" ? stamp.buildId : "unknown";
    if (running === "unknown") {
      push("buildid", "buildId 与磁盘一致", "fail", `戳里没有 buildId（旧进程写的）—— 磁盘 ${diskBuildId}；**重启后才会写**`);
    } else if (running !== diskBuildId) {
      push("buildid", "buildId 与磁盘一致", "fail", `运行 ${running} ≠ 磁盘 ${diskBuildId} —— 跑的是旧代码，需再重启`);
    } else {
      push("buildid", "buildId 与磁盘一致", "ok", `运行 = 磁盘 = ${running}`);
    }
    const v = typeof stamp.version === "string" ? stamp.version : "unknown";
    push("version", "版本号与磁盘一致", v === version ? "ok" : "fail", `运行 v${v} / 磁盘 v${version}`);
  }

  if (budget === null || typeof budget !== "object") {
    push("budget", "预算归因字段", "warn", "还没有 ledger-budget.json（插件尚未产生热清单渲染）");
  } else {
    const samples = Number(budget.samples ?? 0);
    const over = Number(budget["over-budget"] ?? 0);
    const hasAttribution = ["budgetFloorOver", "budgetIrreducible", "overBySession", "traceDropped", "minimalRenders"].some((k) => budget[k] !== undefined);
    if (samples === 0) push("budget", "预算归因字段", "warn", "ledger-budget.json 没有样本");
    else if (over === 0) push("budget", "预算归因字段", "warn", `尚无 over-budget 渲染（${samples} 次样本）—— 归因字段未触发`);
    else if (!hasAttribution) push("budget", "预算归因字段", "warn", `有 ${over} 次 over-budget 但**没有任何归因字段** —— 旧代码仍在跑（等重启）`);
    else push("budget", "预算归因字段", "ok", `${over}/${samples} over-budget，归因字段已出现（floorOver=${budget.budgetFloorOver ?? "—"} / irreducible=${budget.budgetIrreducible ?? "—"} / 来源=${budget.overBySession ? Object.keys(budget.overBySession).length : "—"}）`);
  }
  // ★ C243：1.17.6 的折叠观测字段。C236/C237 新写了 usage.cacheReadTokens（展示用）与 usage.instructionTokens，
  //   它们**只在新代码跑过一次 fold 之后**才会出现 —— 正好当"新代码是否接管"的第二重判据。
  if (latestFold === null || typeof latestFold !== "object") {
    push("fold-fields", "折叠观测字段（instructionTokens）", "warn", "还没有 foldMark 带 usage —— 等重启后第一次 fold");
  } else if (Number.isFinite(latestFold?.usage?.instructionTokens)) {
    push("fold-fields", "折叠观测字段（instructionTokens）", "ok", `最近一次 fold 记了我们的指令 ${latestFold.usage.instructionTokens} tok（C237）`);
  } else {
    push(
      "fold-fields",
      "折叠观测字段（instructionTokens）",
      "warn",
      "最近一次 fold 没有 instructionTokens —— 旧代码仍在跑（等重启），或这次走的是规则摘要（没有模型调用，正常）",
    );
  }

  // ★ C243：C219 的「注入动作」（append vs replace）也只在重启后才有数据。
  {
    const actions = budget && typeof budget === "object" ? budget.injectActions : null;
    const keys = actions && typeof actions === "object" ? Object.keys(actions) : [];
    if (keys.length === 0) push("inject-actions", "注入动作采集（append/replace）", "warn", "还没有 injectActions —— 等重启后第一次注入");
    else push("inject-actions", "注入动作采集（append/replace）", "ok", keys.map((k) => `${k}=${actions[k]}`).join(" / "));
  }

  return { ok: checks.every((c) => c.level !== "fail"), checks };
}

/** 跑 doctor --json（有错误时退出码非 0，用 error.stdout）。 */
function runDoctorJson(home) {
  const args = [nodePath.join(REPO, "scripts", "doctor.mjs"), "--json"];
  try {
    return JSON.parse(execFileSync(process.execPath, args, { cwd: REPO, env: { ...process.env, DSH_HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    const out = error && typeof error.stdout === "string" ? error.stdout : "";
    return JSON.parse(out);
  }
}

/** 跑 boundary-audit --json（若支持），否则跑人读版取末行。 */
function runBoundaryFindings() {
  try {
    const out = execFileSync(process.execPath, [nodePath.join(REPO, "scripts", "boundary-audit.mjs")], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const m = out.match(/越界线索 (\d+) 条/);
    return m ? Number(m[1]) : null;
  } catch (error) {
    const out = error && typeof error.stdout === "string" ? error.stdout : "";
    const m = out.match(/越界线索 (\d+) 条/);
    return m ? Number(m[1]) : null;
  }
}

/**
 * ★ C264：**重启后自动问一次面板**（`backfill` 的 dryRun）—— 不 resume、不调模型，秒回。
 * 为什么做成可选（`--api`）：这条要连 `127.0.0.1` 的宿主端口，单元测试里不该发网络请求。
 * 失败一律判 **warn**（面板 API 不可达不等于插件坏了，可能只是端口变了）。
 * @returns {Promise<{level:string, detail:string}>}
 */
/**
 * ★ C294：**能力探针** —— 直接问面板「你认识这些新 action 吗」。
 *
 * 为什么需要：`build.json` 的启动戳可能是**已死进程**留下的（C293），buildId 也只能说明
 * "磁盘变了"，说明不了"进程里跑的是哪一版"。唯一可靠的是**问它做得到什么**。
 * 实测（2026-11-02）：live 面板认识 models / defaults / health，却不认识 update / backfill ⇒
 * 内存里那份模块比磁盘旧。这条探针就是把这件事实变成一行结论。
 *
 * @param {Array<{action:string, body?:object}>} probes
 * @param {{port?:number, timeoutMs?:number}} options
 * @returns {Promise<{level:string, detail:string, known:string[], unknown:string[]}>}
 */
export async function checkPanelCapabilities(
  probes = [{ action: "update" }, { action: "backfill", body: { dryRun: true } }],
  { port = 64349, timeoutMs = 3000 } = {},
) {
  const url = `http://127.0.0.1:${port}/gokifu/api`;
  const known = [];
  const unknown = [];
  let lastFailure = null;  // C331：非阳性响应（如 405）要能说清是什么
  for (const probe of probes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: probe.action, ...(probe.body ?? {}) }),
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      const saidUnknown = typeof json?.error === "string" && json.error.includes("未知 action");
      // ★ C331：**只有拿到能解析的响应才算"认识"**。
      //   实测（2026-11-02 真机）：重启后 `/gokifu/api` 对**所有** action 回 HTTP 405 + 空体
      //   （插件路由没起来），而旧逻辑"没有『未知 action』字样就算认识" ⇒ 把死路由判成"新代码已接管"。
      //   仪器骗人的第 N 次：判定必须基于**阳性证据**（2xx 且能解析），不是"没有反证"。
      // ★ C389：`error: null` 是**正常**响应（我们的 handler 就是这么写的）。
      //   旧写法 `error === undefined` 会把 `error:null` 当成反面证据 ⇒ 真机上把能用的 `update` 判成了"不认识"（误报「需要重启」）。
      const noError = json !== null && (json?.error === undefined || json?.error === null || json?.error === "");
      const positive = res.ok && noError;
      if (saidUnknown) unknown.push(probe.action);
      else if (positive) known.push(probe.action);
      else unknown.push(probe.action);
      if (!positive) lastFailure = `HTTP ${res.status}${json === null ? "（非 JSON）" : ""}`;
    } catch {
      return { level: "warn", detail: `面板不可达（端口 ${port}）：${probe.action} 探不了`, known, unknown };
    } finally {
      clearTimeout(timer);
    }
  }
  if (unknown.length === 0) {
    return { level: "ok", detail: `面板认识全部 ${known.length} 个新 action（${known.join(" / ")}）⇒ 跑的是新代码`, known, unknown };
  }
  // 全部拿不到阳性响应（如路由 405）⇒ 这不是"旧代码"，是**面板根本没起来**
  if (known.length === 0 && lastFailure !== null) {
    return {
      level: "warn",
      detail: `面板路由不响应（${lastFailure}）—— 插件可能**没加载**（不是"旧代码"）：先确认插件在 profile 里、再重启`,
      known,
      unknown,
    };
  }
  return {
    level: "warn",
    detail:
      `面板不认识 ${unknown.length} 个新 action（${unknown.join(" / ")}）⇒ **内存里那份模块比磁盘旧**，` +
      `需要重启才生效（认识的：${known.length > 0 ? known.join(" / ") : "无"}）`,
    known,
    unknown,
  };
}

export async function checkBackfillApi({ port = 64349, timeoutMs = 3000 } = {}) {
  const url = `http://127.0.0.1:${port}/gokifu/api`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "backfill", dryRun: true }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { level: "warn", detail: `面板返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 80)}` };
    }
    // 旧版本面板对未知 action 的回应是 `{ error: "未知 action: backfill" }`（连 ok 字段都没有）
    if (typeof json?.error === "string" && json.error !== "") {
      return { level: "warn", detail: `面板拒了 dryRun：${json.error}（未知 action ⇒ 运行实例还没更新，重启后才有这个接口）` };
    }
    if (json?.ok === false) return { level: "warn", detail: `面板拒了 dryRun：${json.code ?? "未知"}` };
    const due = Number(json?.due);
    const scanned = Number(json?.scanned);
    if (!Number.isFinite(due)) return { level: "warn", detail: "面板返回里没有 due 字段（版本太旧？）" };
    return {
      level: due > 0 ? "warn" : "ok",
      detail: due > 0 ? `欠账 ${due} 个会话（扫了 ${scanned ?? "?"} 个）—— 面板点「补账」或去掉 dryRun 打一次` : `没有欠账（扫了 ${scanned ?? "?"} 个会话）`,
    };
  } catch (error) {
    const message = String(error?.message ?? error);
    return { level: "warn", detail: `面板 API 不可达（${url}）：${message.slice(0, 80)}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const home = getArg("home", defaultHome());
  const asJson = argv.includes("--json");
  const stamp = readBuildStamp(nodePath.join(home, "chess-context"));
  let budget = null;
  try {
    const file = nodePath.join(home, "chess-context", "ledger-budget.json");
    if (nodeFs.existsSync(file)) budget = JSON.parse(nodeFs.readFileSync(file, "utf8"));
  } catch {
    budget = null;
  }
  // 最近一次带 usage 的 foldMark（跨会话取 at 最大的那个）—— 给"折叠观测字段"判据用
  const latestFold = (() => {
    let best = null;
    const root = nodePath.join(home, "chess-context", "sessions");
    try {
      for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = nodePath.join(root, entry.name, "graph.json");
        if (!nodeFs.existsSync(file)) continue;
        let marks;
        try {
          marks = JSON.parse(nodeFs.readFileSync(file, "utf8"))?.foldMarks ?? [];
        } catch {
          continue; // 坏图跳过，不因一张坏图让整个核对失败
        }
        for (const mark of marks) {
          if (!mark || typeof mark.at !== "number") continue;
          if (best === null || mark.at > best.at) best = mark;
        }
      }
    } catch {
      return null;
    }
    return best;
  })();
  const result = evaluatePostRestart({ stamp, diskBuildId: repoBuildId(), version: repoVersion(), budget, latestFold });

  // ④ doctor 0 错误；⑤ boundary-audit 0 findings（两者都是仓库/运行态红线，独立于上面的纯评估）
  let doctor = null;
  try {
    doctor = runDoctorJson(home);
    result.checks.push({ id: "doctor", name: "doctor 0 错误", level: Number(doctor.bad ?? 0) === 0 ? "ok" : "fail", detail: `错误 ${doctor.bad ?? "?"} / 警告 ${doctor.warn ?? "?"}` });
  } catch {
    result.checks.push({ id: "doctor", name: "doctor 0 错误", level: "warn", detail: "doctor 跑不起来（解析失败）" });
  }
  // ★ C264：`--api` 时问一次面板（默认不发网络请求）
  if (argv.includes("--api")) {
    // ★ C388：端口不能写死 64349。真机事故（2026-11-03）：重启后 GUI 换到 56319，
    //   而这里还在探 64349 ⇒ 报「面板 API 不可达」，把正常的面板判成了坏的。
    //   顺序：`--port` 显式指定 > 心跳 `ui-route.json` 里的端口 > 默认 64349。
    const portArg = getArg("port", "");
    const heartbeatPort = (() => {
      try {
        const file = nodePath.join(home, "chess-context", "ui-route.json");
        if (!nodeFs.existsSync(file)) return null;
        const hb = JSON.parse(nodeFs.readFileSync(file, "utf8"));
        return Number.isFinite(Number(hb?.port)) ? Number(hb.port) : null;
      } catch {
        return null;
      }
    })();
    const port = Number(portArg) || heartbeatPort || 64349;
    const api = await checkBackfillApi({ port });
    result.checks.push({ id: "backfill-api", name: "面板补账接口（dryRun）", level: api.level, detail: api.detail });
    // ★ C294：能力探针 —— 唯一能证明"进程里跑的是新代码"的东西
    const caps = await checkPanelCapabilities(undefined, { port });
    result.checks.push({ id: "panel-caps", name: "面板能力探针（update / backfill）", level: caps.level, detail: caps.detail });
    result.ok = result.checks.every((c) => c.level !== "fail");
  }
  const findings = runBoundaryFindings();
  result.checks.push({
    id: "boundary",
    name: "越权审计 0 findings",
    level: findings === 0 ? "ok" : findings === null ? "warn" : "fail",
    detail: findings === null ? "boundary-audit 输出解析失败" : `${findings} 条`,
  });
  result.ok = result.checks.every((c) => c.level !== "fail");

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("== 重启后核对（post-restart-check）==");
    for (const c of result.checks) console.log(`  ${c.level === "ok" ? "✓" : c.level === "warn" ? "!" : "✗"} ${c.name} — ${c.detail}`);
    const fails = result.checks.filter((c) => c.level === "fail").length;
    console.log(`\n${fails === 0 ? "✅" : "❌"} fail ${fails} / warn ${result.checks.filter((c) => c.level === "warn").length}`);
  }
  return result.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
