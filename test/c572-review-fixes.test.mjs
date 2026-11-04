/**
 * c572-review-fixes.test.mjs —— 对抗式审核查出的 4 处「重启后才发现坏了」（C572）
 *
 * 每条都对应一个真机会坏掉的现象：
 *   ① 离线补折永远 no-log（home 取错）
 *   ② 分段永远 0 段（空转凭据取错）
 *   ③ 离线零段被写成 folded:1（假成功生成器）
 *   ④ 收尾覆盖写抹掉证据 + folded:false 被当结清（失败的补账把欠账抹掉）
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { applyCloseoutOutcome } from "../src/rooms/closeout-plan.mjs";
import { closeoutSettles, debtOfGraph } from "../src/rooms/closeout-backfill.mjs";
import { applyOfflineFoldToGraph } from "../src/rooms/offline-fold.mjs";

export const tests = {};

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
const engine = () => nodeFs.readFileSync(nodePath.join(ROOT, "src", "engine.mjs"), "utf8");

tests["C572① 离线补折的 home 必须来自 graphRoot（this.graphDir 从未赋值）"] = (t) => {
  const src = engine();
  t.eq(src.includes("String(this.graphDir"), false, "不许再用 this.graphDir（它从未被赋值 ⇒ home=. ⇒ 永远 no-log）");
  const at = src.indexOf("async #offlineCloseoutFold");
  const seg = src.slice(at, at + 3000);
  t.includes(seg, "graphRoot({ graphDir: this.chess.graphDir", "要走与 tick 同一个算法");
};

tests["C572② 分段空转凭据：externalFolds 在 this.ledgerBudget 上，图取 session"] = (t) => {
  const src = engine();
  t.eq(src.includes("g0?.ledgerBudget"), false, "graph 上没有 ledgerBudget 字段");
  t.includes(src, "this.ledgerBudget?.externalFolds", "计数在 this.ledgerBudget");
  t.includes(src, "const foldSession = this.#asAgent(target)?.session ?? target", "target 可能是 session，要归一");
};

tests["C572③ 离线零段不许折成 folded:1（假成功生成器）"] = (t) => {
  const base = { at: 1, source: "archive" };
  const nolog = applyCloseoutOutcome(base, { tier: "offline", folded: 0, chunks: 0, stopped: "no-log", partial: true });
  t.eq(Number(nolog.folded), 0, "零段必须 folded=0");
  t.includes(String(nolog.foldNote ?? ""), "no-log", "要留下停止原因");
  t.eq(nolog.partial, true, "没折完要标 partial");
  const done = applyCloseoutOutcome(base, { tier: "offline", folded: 1, chunks: 1, stopped: "done", coveredStart: 9, coveredEnd: 63 });
  t.eq(Number(done.folded), 1, "真折了才是 1");
  t.eq(done.foldOffline, true, "要标离线");
};

tests["C572④ folded:false 是判决，不是'缺字段'——失败的补账不许把欠账抹掉"] = (t) => {
  t.eq(closeoutSettles({ foldAttempted: true, folded: false }), false, "显式失败 ⇒ 未结清");
  t.eq(closeoutSettles({ foldAttempted: true, folded: 0 }), false, "数字 0 同理");
  const g = {
    nodes: { n1: { seq: 1 }, n2: { seq: 5000 } },
    foldMarks: [],
    closeout: { foldAttempted: true, folded: false, source: "archive" },
  };
  t.eq(debtOfGraph(g).due, true, "于是它仍然出现在欠账里");
};

tests["C572④ closeoutNow 必须合并写并补 foldAttempted / chunkedFolded"] = (t) => {
  const src = engine();
  const at = src.indexOf("g.closeout = {");
  const seg = src.slice(at, at + 700);
  // 合并写：可以是 `...(g.closeout ?? {})`，也可以是先 `const carried = {...(g.closeout ?? {})}` 再 `...carried`
  t.eq(seg.includes("...(g.closeout ?? {})") || (src.includes("const carried = { ...(g.closeout ?? {}) }") && seg.includes("...carried")), true, "合并写（否则抹掉 partial/gap/chunked）");
  t.includes(seg, "foldAttempted: true", "补齐 foldAttempted（只在真尝试时写）");
  // ★ C575：两处 `g.closeout = {` 都必须是合并写（第一轮只改了一处，审核当场抓到第二处）
  const all = src.match(/g\.closeout = \{/g) ?? [];
  t.eq(all.length, 2, `目前应有两处 closeout 落账（实际 ${all.length}）`);
  const sites = [];
  let idx = src.indexOf("g.closeout = {");
  while (idx >= 0) {
    sites.push(src.slice(idx, idx + 160));
    idx = src.indexOf("g.closeout = {", idx + 1);
  }
  const merges = src.split("g.closeout = {").slice(1);
  for (const site of merges) {
    const ok = site.slice(0, 200).includes("...(g.closeout ?? {})") || site.slice(0, 200).includes("...carried");
    t.eq(ok, true, "每一处都必须合并写（抹掉证据会让 154 条欠账消失）");
  }
  t.eq(src.includes("chunkedEvidence"), true, "分段/离线的证据要一起写");
};

tests["C572 disposed 也是折叠证据"] = (t) => {
  const g = {
    nodes: { n1: { seq: 1 }, n2: { seq: 5000 } },
    foldMarks: [{ trigger: "disposed", seqStart: 1, seqEnd: 5000 }],
    closeout: { foldAttempted: true, folded: 1, source: "disposed" },
  };
  t.eq(debtOfGraph(g).closedOut, true, "disposed 收尾折过的会话不是欠账");
};

tests["C572 离线补折覆盖了旧缺口后，旧 partial/gap 必须被清掉"] = (t) => {
  const graph = {
    version: 1,
    nodes: { n1: { id: "n1", kind: "user", seq: 1 }, n2: { id: "n2", kind: "agent", seq: 400 } },
    edges: {},
    foldMarks: [],
    closeout: { at: 1, partial: true, offlineUncoveredHead: { events: 100, from: 1 } },
  };
  applyOfflineFoldToGraph(graph, {
    chunks: [{ start: 1, end: 400, text: "## 目标", summaryChars: 6 }],
    coveredStart: 1,
    coveredEnd: 400,
    uncoveredHead: 0,
    uncoveredTail: 0,
  }, { model: { model: "m" }, rangeStart: 1 });
  t.eq(graph.closeout.partial, undefined, "旧 partial 必须清掉");
  t.eq(graph.closeout.offlineUncoveredHead, undefined, "旧缺口必须清掉（否则永远 due）");
  t.eq(Number(graph.closeout.folded) > 0, true, "这次确实折了");
};

tests["C572⑤ factsIds 必须声明在 runOfflineFold 之前（否则 TDZ 崩在模型答完之后）"] = (t) => {
  const src = engine();
  const at = src.indexOf("async #offlineCloseoutFold");
  const seg = src.slice(at, at + 9000);
  const factsAt = seg.indexOf("const factsIds = (() =>");
  const callAt = seg.indexOf("runOfflineFold({", seg.indexOf("const foldDeadline") >= 0 ? 0 : 0);
  t.eq(factsAt >= 0 && callAt >= 0, true, "两处都要在");
  t.eq(factsAt < callAt, true, "factsIds 必须先声明（闭环里被 measureQuality 读取）");
  t.includes(seg, "Cannot access before initialization", "注释要留下这个坑");
};

tests["C577 面板「补做收尾」必须认 graphDir（否则自定义目录时列 0 条）"] = (t) => {
  const ui = nodeFs.readFileSync(nodePath.join(ROOT, "src", "ui.mjs"), "utf8");
  t.includes(ui, "graphRoot({ graphDir: configuredGraphDir, dshHome: home })", "要用配置里的 graphDir");
  t.includes(ui, "bridge?.chess?.graphDir", "从引擎实例取配置（不是从参数猜）");
  t.eq(/graphRoot\(\{ dshHome: home \}\)/.test(ui), false, "不许再忽略 graphDir");
};

tests["C579 活会话必须在排序之前剔除（否则名额被占满、永远补不动）"] = (t) => {
  const src = engine();
  const at = src.indexOf("async #autoBackfillTick");
  const seg = src.slice(at, at + 9000);
  const filterAt = seg.indexOf("const withLog = (listed.items ?? []).filter");
  const rankAt = Math.max(seg.indexOf("rankDebts(pickPool"), seg.indexOf("rankDebts(withLog"));
  t.eq(filterAt >= 0 && rankAt >= 0, true, "两处都要在");
  t.eq(filterAt < rankAt, true, "过滤要在排序之前");
  t.includes(seg, "liveSkipIds", "跳过要留痕");
  t.includes(seg, "日志还在写", "文案要说清为什么跳过");
};

tests["C586 并发安全的空转判定：用 lastExternalFold 指纹，而不是全局计数差"] = (t) => {
  const src = engine();
  t.includes(src, "const ourStamp = () =>", "要有指纹判据");
  t.includes(src, "lef.seqStart", "指纹要比对区间");
  t.includes(src, "const stamped = afterStamp === true && beforeStamp === false", "只有我们的这一段被登记才算折了");
};

tests["C588 面板补账通道不许引用不存在的变量（bridge0 曾让整条通道 100% 不可用）"] = (t) => {
  const ui = nodeFs.readFileSync(nodePath.join(ROOT, "src", "ui.mjs"), "utf8");
  // 去掉行注释再看标识符 —— 注释里提到这个坑是允许的（那正是留痕）
  const code = ui
    .split(String.fromCharCode(10))
    .filter((line) => !line.trim().startsWith("//"))
    .join(String.fromCharCode(10));
  t.eq(/(^|[^A-Za-z0-9_$.])bridge0([^A-Za-z0-9_]|$)/.test(code), false, "代码里不许出现 bridge0");
  t.includes(code, "bridge.isBackfillBusy(it.sessionId)", "必须用真实存在的 bridge");
};

tests["C591 补账要轮转：刚补过的会话 45 分钟内不再优先（否则头部永远占满）"] = (t) => {
  const src = engine();
  const at = src.indexOf("async #autoBackfillTick");
  const seg = src.slice(at, at + 9000);
  t.includes(seg, "_backfillLastPicked", "要记谁刚补过");
  t.includes(seg, "COOLDOWN_MS", "要有冷却窗口");
  t.includes(seg, "pickPool", "冷却后不够时要退回完整列表");
  t.eq(seg.includes("rankDebts(withLog, { limit: max })"), false, "不许再直接对完整列表取头部");
};

tests["C593 后台补账必须有状态文件（否则零产出与没跑过长得一样）"] = (t) => {
  const src = engine();
  t.includes(src, "auto-backfill-state.json", "要写状态文件");
  t.includes(src, "armed: true", "启动要落一个已布防标记");
  t.includes(src, "异常也要落盘", "抛错也要能看出来");
};

tests["C597 routedTarget 必须容错合成会话（补账 tick 传的是 {id,cwd}）"] = (t) => {
  const src = engine();
  const at = src.indexOf("function routedTarget(session)");
  t.eq(at > 0, true, "函数还在");
  const seg = src.slice(at, at + 900);
  t.includes(seg, 'typeof session?.requestHeader === "function"', "必须先判方法再调（否则 TypeError）");
  t.includes(seg, "C597", "注释要写明真机现象");
  t.eq(/const config = session\.requestHeader\(\)/.test(seg), false, "不许直接调用");
};
