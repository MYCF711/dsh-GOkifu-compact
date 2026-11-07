#!/usr/bin/env node
/**
 * axiom-shadow.mjs —— AX-10：为冻结的 K-26 / K-2 / K-27 源上下文生成 `guard=false` / `guard=true` 两臂候选
 *
 * 任务书：`docs/任务书-两条公理纠偏-2026-11-07.md` · 任务卡 AX-10
 *
 *   · 目标：用 **AX-00 冻结的默认摘要模型**，对冻结 K-26 / K-2 / K-27 源上下文生成两臂产物；
 *           不得改题、不得改答案。
 *   · 可写路径：本文件、`test/axiom-shadow.test.mjs`、`tmp/axiom-2026-11-07/ax10/`。
 *   · 实现约束：隔离 home；真实模型**只**按 `default-model.json`；真实会话原文不进 git；
 *           记录模型 / prompt / postprocess / usage / 截断；失败标 `NOT_RUN`。
 *   · 验收：两臂同源同题；compact **由当前代码现场生成**，不得拿旧冻结 compact 冒充；缺样本不补合成。
 *
 * ── 这个脚本为什么存在（以及它不做什么） ───────────────────────────────────────
 *
 * AX-11/12/13 要拿「候选上下文」去复判 / 跑真实 reader。候选必须来自**当前代码**：
 * 拿冻结的 `lastOfflineSummary` 或冻结夹具里的 `compactContext` 冒充候选，等于用旧实现的结果
 * 去证明新实现 —— 那是最容易发生的假绿。所以这里只做三件事：
 *
 *   ① 读源：只读 `DSH_HOME` 里的会话日志与 `graph.json`（**零写入**；所有产物只落到 `--out`）；
 *   ② 生成：K-26 走 `runOfflineFold`（离线折叠编排，**生产同一份代码**），K-2 走
 *      `buildContexts` + `renderFacts(graph)`（K-2 预注册里 compact 臂的定义就是它），
 *      K-27 走 `runOfflineFold` + 夹具行适配器（见 `fixtureLinesToEvents`）；
 *   ③ 记账：模型 / prompt 哈希 / usage / 截断 / 守卫裁决**逐项落盘**，失败就是 `NOT_RUN`。
 *
 * 它**不**做的事：不改题面/答案/阈值；不写 `graph.json`；不写 live home；不打开 `factGuard`
 * 默认值（默认值仍由 R15 `config-schema.mjs` 独占）；不重试（一次失败就记失败，不换参重跑掩盖）。
 *
 * ── 模型：唯一合法来源是 AX-00 的冻结结果，没有兜底 ───────────────────────────
 *
 * `--default-model <baseline/default-model.json>` 必须给出且能解析出非空 `provider` + `model`；
 * 否则整轮 `NOT_RUN`（退出码 3），**不做任何模型调用，也不用任何内置/环境变量兜底**。
 * 脚本里没有任何模型名字面量（`test/axiom-shadow.test.mjs` 用静态断言钉住），
 * 也不接受 `--model`/`--provider` 覆盖 —— 「脚本自选模型」在本任务里是被禁止的行为。
 *
 * ── 两臂是什么（必须显式写清，不能靠名字猜） ───────────────────────────────────
 *
 *   guard=false ：`factGuard` 关闭 ⇒ 生产旧路径。摘要提示词**逐字**与生产相同（guardTail 为空数组）。
 *   guard=true  ：`factGuard` 打开 ⇒ 提示词末尾追加「成功工具结果的值 + 输出格式（JSON 信封）」，
 *                 模型交回 `{facts, narratives}`，由 AX-01 的 `guardModelOutput` 机械裁决，
 *                 非 `SUPPORTED` 会带机器标记行（`> 事实守卫：…`）。
 *
 * 两臂除开关外**全部相同**：同一份源事件、同一个折叠区间、同一个图、同一个模型、同一套解码参数、
 * 同一个 token 预算（预算由 `runOfflineFold` 按提示词长度算，两臂各自算）。`assertArmParity()`
 * 在落盘前逐项核对，任何一项对不上就是红，不是警告。
 *
 * ── 隔离 home ─────────────────────────────────────────────────────────────────
 *
 * `--home` **只读**：本文件没有一处写入指向 `<home>`（`auditSource()` 用静态断言钉住这条）。
 * 产物目录若落在 `--home` 之内，`assertIsolated()` 直接抛错 —— 那等于把「只读」写成一句空话。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────────
 *
 *   # 1) 计划（默认；零模型调用、零写入 home）
 *   node scripts/axiom-shadow.mjs \
 *     --home <DSH_HOME> \
 *     --default-model <AX-00 的 baseline/default-model.json> \
 *     --k26-manifest <K-26 私有 manifest.json> \
 *     --k26-samples 1 --k2-sessions 1 --k27-questions 1
 *
 *   # 2) 真跑（小样本；调用上限见 --max-calls，默认 8）
 *   node scripts/axiom-shadow.mjs --live ...同上...
 *
 *   # 3) 只要某一语料
 *   node scripts/axiom-shadow.mjs --live --only k26 ...
 *
 * 退出码：0 = 请求的条目全部 `SCORED`；1 = 两臂不相配 / 隐私自检红；2 = 参数错；3 = `NOT_RUN`。
 *
 * ── 私有边界 ─────────────────────────────────────────────────────────────────
 *
 * 会话正文、quote、sid 只进 `tmp/`（每个条目一个私有 JSON + prompt 原文）。
 * `run.json` 与 `REPORT.md` **只有聚合**（计数 / 原因码 / 哈希 / 截断标志），
 * `privacyCheck()` 在落盘前把每条私有正文的前缀、每个 quote、每个值事实回查一遍产物文本。
 */

import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { loadSessionGraph } from "./graph-audit.mjs";
import { buildContexts, resolveSession, QUESTIONS as K2_QUESTIONS } from "./k2-value-reader.mjs";
import { renderFacts } from "../src/rooms/ledger.mjs";
import { collectFoldValueFacts, runOfflineFold } from "../src/rooms/offline-fold.mjs";
import { findSessionLog, readSessionEvents } from "../src/rooms/zstd-log.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");

/** 运行文档 schema。 */
export const SCHEMA = "axiom-ax10-shadow-run-v1";
/** 单条目文档 schema（私有，落在 tmp）。 */
export const ITEM_SCHEMA = "axiom-ax10-shadow-item-v1";

/** 产物默认根（相对仓库根）。 */
export const DEFAULT_OUT = nodePath.join(ROOT, "tmp", "axiom-2026-11-07", "ax10");

/**
 * 两臂的唯一定义。顺序 = 调用顺序（同一源的两次调用必须相邻，便于查配对）。
 * `prepare` 只决定「开关」，不改源、不改题。
 */
export const ARMS = Object.freeze([
  Object.freeze({ id: "guard=false", factGuard: false, prepare: "offline-fold prompt（生产旧路径，guardTail 为空）" }),
  Object.freeze({ id: "guard=true", factGuard: true, prepare: "offline-fold prompt + 守卫尾（值事实 + JSON 信封）" }),
]);

/** 调用与样本上限（**默认只跑小样本**；一次跑满 50 题是 AX-13 的事，不是 AX-10）。 */
export const LIMITS = Object.freeze({
  maxCalls: 8,
  k26Samples: 12,
  k2Questions: 10,
  k27PilotQuestions: 10,
});

/** 真实 reader / 摘要网关（本机唯一模型出口；地址不是模型）。 */
export const DEFAULT_ENDPOINT = "http://127.0.0.1:3425/v1/chat/completions";
/** 单次调用超时（毫秒）。折叠输入可达数万 token，180s 在慢模型上不够。 */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** K-27 夹具适配器：把 `seq=NNN <text>` 行变成事件（见 `fixtureLinesToEvents`）。 */
export const K27_ADAPTER = "fixture-lines-v1";

/* ══════════════════════════════ 通用小工具 ══════════════════════════════ */

export function sha256(text) {
  return nodeCrypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

export function shortHash(text, length = 16) {
  return sha256(text).slice(0, length);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function writeText(file, text) {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, String(text), "utf8");
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

const readJsonOrNull = (file) => {
  try {
    return JSON.parse(nodeFs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/* ══════════════════════ 1 · 默认模型：只读 AX-00 冻结结果 ══════════════════════ */

/**
 * 解析 `default-model.json` 的**内容**（纯函数）。
 *
 * 只接受 AX-00 写下的形状（`{provider, model, source?, home?}`）。缺一个就 `ok:false` ——
 * **不做任何猜测**：没有默认值、没有环境变量兜底、没有「取网关第一个模型」。
 *
 * @param {string|object} input JSON 文本或已解析对象
 * @returns {{ok:boolean, provider:string|null, model:string|null, source:string|null, home:string|null, errors:string[]}}
 */
export function parseDefaultModel(input) {
  const errors = [];
  let doc = input;
  if (typeof input === "string") {
    try {
      doc = JSON.parse(input);
    } catch (error) {
      return {
        ok: false,
        provider: null,
        model: null,
        source: null,
        home: null,
        errors: [`不是合法 JSON：${String(error?.message ?? error)}`],
      };
    }
  }
  if (!isPlainObject(doc)) {
    return { ok: false, provider: null, model: null, source: null, home: null, errors: ["顶层必须是对象"] };
  }
  const provider = typeof doc.provider === "string" && doc.provider.trim() !== "" ? doc.provider.trim() : null;
  const model = typeof doc.model === "string" && doc.model.trim() !== "" ? doc.model.trim() : null;
  if (provider === null) errors.push("provider 缺失或为空");
  if (model === null) errors.push("model 缺失或为空");
  return {
    ok: errors.length === 0,
    provider,
    model,
    source: typeof doc.source === "string" && doc.source !== "" ? doc.source : null,
    home: typeof doc.home === "string" && doc.home !== "" ? doc.home : null,
    errors,
  };
}

/**
 * 读 AX-00 的冻结文件。**读不到就是 `ok:false`，不抛**（调用方据此落 `NOT_RUN`）。
 * @param {string} file
 * @returns {{ok:boolean, file:string, sha256:string|null, provider:string|null, model:string|null, source:string|null, home:string|null, errors:string[]}}
 */
export function loadDefaultModel(file) {
  const path = String(file ?? "");
  if (path === "") {
    return { ok: false, file: "", sha256: null, provider: null, model: null, source: null, home: null, errors: ["没有给 --default-model"] };
  }
  let text;
  try {
    text = nodeFs.readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      file: path,
      sha256: null,
      provider: null,
      model: null,
      source: null,
      home: null,
      errors: [`读不到默认模型文件：${String(error?.message ?? error)}`],
    };
  }
  const parsed = parseDefaultModel(text);
  return { ...parsed, file: path, sha256: sha256(text) };
}

/* ══════════════════════════ 2 · 参数 / 隔离 / 静态自检 ══════════════════════════ */

const VALUE_ARGS = new Set([
  "home",
  "default-model",
  "out",
  "k26-manifest",
  "k26-samples",
  "k2-sessions",
  "k27-questions",
  "only",
  "max-calls",
  "max-tokens-cap",
  "max-chars",
  "timeout",
  "endpoint",
]);
const FLAG_ARGS = new Set(["live", "no-derive", "help"]);

/**
 * 解析命令行。**显式拒绝 `--model` / `--provider`**：模型只能来自 AX-00 的冻结文件。
 * @param {string[]} argv
 * @returns {{ok:boolean, errors:string[], options:object}}
 */
export function parseArgs(argv = []) {
  const errors = [];
  const options = {
    live: false,
    derive: true,
    help: false,
    home: "",
    defaultModel: "",
    out: DEFAULT_OUT,
    k26Manifest: "",
    k26Samples: 0,
    k2Sessions: 0,
    k27Questions: 0,
    only: "all",
    maxCalls: LIMITS.maxCalls,
    maxTokensCap: 8192,
    maxChars: 60_000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    endpoint: DEFAULT_ENDPOINT,
  };
  const list = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (!token.startsWith("--")) {
      errors.push(`多余的参数：${token}`);
      continue;
    }
    const name = token.slice(2);
    if (name === "model" || name === "provider") {
      errors.push(`禁止 --${name}：模型只能来自 --default-model（AX-00 冻结结果），脚本不得自选`);
      continue;
    }
    if (!VALUE_ARGS.has(name) && !FLAG_ARGS.has(name)) {
      errors.push(`未知参数：--${name}`);
      continue;
    }
    if (FLAG_ARGS.has(name)) {
      if (name === "live") options.live = true;
      else if (name === "no-derive") options.derive = false;
      else options.help = true;
      continue;
    }
    const value = list[i + 1];
    if (value === undefined || String(value).startsWith("--")) {
      errors.push(`--${name} 缺少取值`);
      continue;
    }
    i += 1;
    if (name === "home") options.home = String(value);
    else if (name === "default-model") options.defaultModel = String(value);
    else if (name === "out") options.out = String(value);
    else if (name === "k26-manifest") options.k26Manifest = String(value);
    else if (name === "only") options.only = String(value);
    else if (name === "endpoint") options.endpoint = String(value);
    else if (name === "k26-samples") options.k26Samples = Math.max(0, Number(value) || 0);
    else if (name === "k2-sessions") options.k2Sessions = Math.max(0, Number(value) || 0);
    else if (name === "k27-questions") options.k27Questions = Math.max(0, Number(value) || 0);
    else if (name === "max-calls") options.maxCalls = Math.max(1, Number(value) || LIMITS.maxCalls);
    else if (name === "max-tokens-cap") options.maxTokensCap = Math.max(1024, Math.min(16_384, Number(value) || 8192));
    else if (name === "max-chars") options.maxChars = Math.max(500, Number(value) || 60_000);
    else if (name === "timeout") options.timeoutMs = Math.max(1000, Number(value) || DEFAULT_TIMEOUT_MS);
  }
  if (!["all", "k26", "k2", "k27"].includes(options.only)) errors.push(`--only 只能是 all|k26|k2|k27（收到 ${options.only}）`);
  if (options.live && options.home === "") errors.push("--live 需要 --home（只读）");
  if (options.live && options.defaultModel === "") errors.push("--live 需要 --default-model");
  if (options.k26Samples > LIMITS.k26Samples) errors.push(`--k26-samples 不得超过冻结上限 ${LIMITS.k26Samples}`);
  if (options.k27Questions > LIMITS.k27PilotQuestions) errors.push(`--k27-questions 不得超过 pilot 上限 ${LIMITS.k27PilotQuestions}`);
  return { ok: errors.length === 0, errors, options };
}

/**
 * 隔离断言：产物目录**不能**落在 `--home` 之内。
 * 落在里面就等于「只读 home」这句话是假的 —— 那时本脚本的写出会污染 live home。
 * @param {{home?:string, out:string}} input
 */
export function assertIsolated({ home = "", out = "" } = {}) {
  const outAbs = nodePath.resolve(String(out ?? ""));
  if (outAbs === "") throw new Error("产物目录为空");
  if (String(home ?? "") === "") return { out: outAbs, home: null };
  const homeAbs = nodePath.resolve(String(home));
  const rel = nodePath.relative(homeAbs, outAbs);
  if (rel === "" || (!rel.startsWith("..") && !nodePath.isAbsolute(rel))) {
    throw new Error(`隔离断言失败：产物目录落在 --home 之内（${outAbs}）—— home 必须只读，产物必须在外`);
  }
  return { home: homeAbs, out: outAbs };
}

/**
 * 静态自检用的「禁止串」表。
 *
 * 为什么拆成碎片再拼：本函数会**读自己的源码**跑一遍，如果禁止串在源码里以完整形式出现，
 * 自检就会命中自己（假红）。拆开写以后，源码里只有碎片，完整串永远不会被自己匹配到。
 */
const BANNED = Object.freeze({
  /** 模型名前缀（出现即说明脚本硬编码了模型）。 */
  modelPrefixes: Object.freeze(["gro" + "up/", "deep" + "seek-", "ki" + "mi-", "clau" + "de-", "g" + "pt-", "qw" + "en", "g" + "lm-"]),
  /** 宿主全局模型白名单键（插件不读不写）。 */
  globalModelKey: "allowed" + "Models",
  /** 追加写 / 写入 API（只能出现在 writeText 里，且只能指向 --out）。 */
  appendApi: "append" + "FileSync",
  writeApi: "write" + "FileSync",
});

/**
 * 静态自检：本文件不许出现模型名字面量 / 宿主全局模型白名单 / 指向 home 的写入。
 * 返回 problems 数组（空 = 绿）。`test/axiom-shadow.test.mjs` 用它对**源码**跑一遍。
 * @param {string} [source]
 */
export function auditSource(source = null) {
  const text = source === null ? nodeFs.readFileSync(fileURLToPath(import.meta.url), "utf8") : String(source);
  const problems = [];
  // ① 扫描**字符串字面量**里的模型名前缀。模型只能从 default-model.json 读。
  const literals = [...text.matchAll(/(["'`])([^"'`\n]{1,120})\1/g)].map((match) => match[2]);
  const bannedLiteral = literals.find((literal) => BANNED.modelPrefixes.some((prefix) => literal.startsWith(prefix)));
  if (bannedLiteral !== undefined) problems.push(`源码出现模型名字面量：${bannedLiteral}`);
  // ② 不许碰宿主全局模型白名单。
  if (text.includes(BANNED.globalModelKey)) problems.push("源码出现宿主全局模型白名单键");
  // ③ 只读 home：写入只允许发生在 writeText/writeJson（产物根 --out）里，且不许 append。
  const writes = (text.split(BANNED.writeApi).length - 1) + (text.split(BANNED.appendApi).length - 1);
  if (writes !== 1) problems.push(`写入 API 出现 ${writes} 次（应恰好 1 次，只在 writeText 里）`);
  if (text.includes(BANNED.appendApi)) problems.push("源码出现 append 写入");
  // ④ 网络出口只有一个（`fetch`），且必须在本文件的默认 callModel 工厂里。
  const fetches = text.split("fet" + "ch(").length - 1;
  if (fetches !== 1) problems.push(`fetch 出现 ${fetches} 次（应恰好 1 次，且只在默认 callModel 里）`);
  return problems;
}

/* ══════════════════════════ 3 · 两臂：配对与不变式 ══════════════════════════ */

/**
 * 核对两臂**同源同题**（落盘前调用）。任何一项对不上 ⇒ violations 非空 ⇒ 运行失败。
 *
 * 判据（逐条对应任务卡的「两臂同源同题」）：
 *   ① 两臂都在；② `source.hash` 相同；③ `question` 相同（K-26 无题，记 `null`）。
 *   ④ **两臂都 SCORED 时**，模型 / 输入字符数 / 消息条数必须相同（说明喂的是同一段源）。
 *   ⑤ **失败的臂必须带原因**（`error` 或 `failed`）；`SCORED` 却没有正文也算违规。
 *
 * 为什么 ④ 只在「都 SCORED」时比：一臂被守卫整份拒掉（`failed:"empty-response"`）是**合法结局**，
 * 不是配对坏了 —— 把「失败」当「配对违规」会把真实结论（守卫拒了）报成脚本 bug，反过来
 * 也会掩盖真正的 bug（两臂喂了不同输入）。所以：输入必须同源，结局允许不同，但失败必须带原因。
 *
 * @param {object} item 单条目记录
 * @returns {{ok:boolean, violations:string[]}}
 */
export function assertArmParity(item) {
  const violations = [];
  const arms = isPlainObject(item?.arms) ? item.arms : {};
  const ids = ARMS.map((arm) => arm.id);
  for (const id of ids) {
    if (!isPlainObject(arms[id])) violations.push(`缺臂：${id}`);
  }
  if (violations.length > 0) return { ok: false, violations };
  const [a, b] = ids.map((id) => arms[id]);
  if (a.source?.hash !== b.source?.hash) violations.push(`source.hash 不同：${a.source?.hash} vs ${b.source?.hash}`);
  if (String(a.question ?? "") !== String(b.question ?? "")) violations.push("question 不同");
  const aScored = a.status === "SCORED";
  const bScored = b.status === "SCORED";
  if (aScored && bScored) {
    if (String(a.model ?? "") !== String(b.model ?? "")) violations.push(`model 不同：${a.model} vs ${b.model}`);
    if (Number(a.messages) !== Number(b.messages)) violations.push(`messages 不同：${a.messages} vs ${b.messages}`);
    if (Number(a.inputChars) !== Number(b.inputChars)) violations.push(`inputChars 不同：${a.inputChars} vs ${b.inputChars}`);
  }
  for (const [index, record] of [a, b].entries()) {
    const id = ids[index];
    const scored = record.status === "SCORED";
    if (scored && String(record.text ?? "").trim() === "") violations.push(`臂 ${id} 标了 SCORED 却没有正文`);
    if (!scored && String(record.error ?? record.failed ?? "").trim() === "") violations.push(`臂 ${id} 失败但没有原因`);
  }
  return { ok: violations.length === 0, violations };
}

/**
 * 冻结 compact 只能当**对照**，不能当候选。
 * 产物里若出现「候选正文与冻结文本逐字相同」，要么是巧合，要么就是冒充 —— 一律报警。
 * @param {string} candidate 本次生成
 * @param {string|null} frozen 冻结文本
 */
export function frozenVerdict(candidate, frozen) {
  const frozenText = typeof frozen === "string" ? frozen : "";
  const usedFrozen = frozenText !== "" && String(candidate ?? "") === frozenText;
  return {
    usedFrozen,
    candidateChars: String(candidate ?? "").length,
    frozenChars: frozenText.length,
    frozenSha256: frozenText === "" ? null : sha256(frozenText),
    candidateSha256: sha256(String(candidate ?? "")),
    /** 候选必须由本次运行生成：这条只是「不是逐字照抄冻结」的机械证据，不是充分条件。 */
    generatedInThisRun: true,
  };
}

/**
 * 路由留痕：**请求的模型 id**（必须两臂相同）与**网关回显的上游名**（可能不同）分开记。
 *
 * 为什么必须分开：本机网关会把同一个请求 id 负载到不同上游，本轮实测同一次运行里两臂回显的
 * 上游名就不一样。把它当「模型不同」会让配对断言假红；不当回事又会掩盖两臂其实跑在不同后端上
 * 这个混淆项 —— 所以记进 `servedModels`，并在 run.json 里数出 `servedModelMixed`。
 *
 * @param {object} item 单条目
 * @param {string|null} requestedModel AX-00 冻结的模型 id
 */
export function routeSummary(item, requestedModel = null) {
  const arms = {};
  for (const arm of ARMS) {
    const record = item?.arms?.[arm.id] ?? {};
    arms[arm.id] = Array.isArray(record.servedModels) ? [...record.servedModels].sort() : [];
  }
  const ids = ARMS.map((arm) => arm.id);
  const sameServed = ids.every((id) => JSON.stringify(arms[id]) === JSON.stringify(arms[ids[0]]));
  return { requested: requestedModel ?? null, arms, sameServed };
}

/* ══════════════════════════ 4 · 守卫裁决的公开聚合 ══════════════════════════ */

/**
 * 把 `chunk.guard`（含 claim / quote，**私有**）压成可公开的计数。
 * 只出：整份裁决词、逐条裁决计数、原因码、被丢叙事数、语义蕴含标注（恒 `NOT_PROVEN`）。
 * @param {object|null} record `applyOfflineGuard` 的 `record`
 */
export function guardSummary(record) {
  if (!isPlainObject(record)) return null;
  const bucket = (list) => {
    const out = { total: 0, SUPPORTED: 0, UNVERIFIED: 0, REJECTED: 0, PENDING: 0, other: 0 };
    for (const entry of Array.isArray(list) ? list : []) {
      out.total += 1;
      const verdict = String(entry?.verdict ?? "");
      if (Object.prototype.hasOwnProperty.call(out, verdict) && verdict !== "total") out[verdict] += 1;
      else out.other += 1;
    }
    return out;
  };
  const facts = bucket(record.facts);
  const narratives = bucket(record.narratives);
  return {
    verdict: record.verdict ?? null,
    applied: record.applied === true,
    degraded: record.degraded === true,
    degradedReason: record.degradedReason ?? null,
    semanticEntailment: "NOT_PROVEN",
    facts,
    narratives,
    rejectedNarratives: Number(record.rejectedNarratives ?? 0),
    /** 逐条裁决里出现过的原因码（去重、排序；不含正文）。 */
    reasons: [...new Set((Array.isArray(record.reasons) ? record.reasons : []).map(String))].sort(),
    valueFacts: Number(record.valueFacts ?? 0),
  };
}

/* ══════════════════════════ 5 · 语料计划（纯函数） ══════════════════════════ */

/**
 * K-26 计划：按冻结顺序取前 N 个样本（不排序、不挑、**缺样本不补合成**）。
 * @param {Array<object>} samples 私有 manifest 的 `samples`
 * @param {number} limit
 */
export function k26Plan(samples, limit) {
  const list = Array.isArray(samples) ? samples.filter((s) => isPlainObject(s) && typeof s.sampleId === "string") : [];
  const want = Math.max(0, Math.min(Number(limit) || 0, LIMITS.k26Samples));
  return {
    corpus: "k26",
    requested: want,
    available: list.length,
    missing: Math.max(0, want - list.length),
    selected: list.slice(0, want).map((sample, index) => ({
      index,
      sampleId: sample.sampleId,
      graphPath: String(sample.graphPath ?? ""),
      summaryChars: Number(sample.summaryChars ?? 0),
      summaryHash: String(sample.summaryHash ?? ""),
    })),
  };
}

/**
 * K-2 计划：按冻结题面里 `sessionHash` 的**首次出现顺序**取前 N 个会话（同一会话的题一起带上）。
 * @param {Array<object>} questions 预注册题（`scripts/k2-value-reader.mjs` 的 QUESTIONS）
 * @param {number} limit
 */
export function k2Plan(questions, limit) {
  const list = Array.isArray(questions) ? questions.filter((q) => isPlainObject(q)) : [];
  const order = [];
  const bySession = new Map();
  for (const question of list) {
    const hash = String(question.sessionHash ?? "");
    if (hash === "") continue;
    if (!bySession.has(hash)) {
      bySession.set(hash, []);
      order.push(hash);
    }
    bySession.get(hash).push(String(question.id ?? ""));
  }
  const want = Math.max(0, Math.min(Number(limit) || 0, order.length));
  return {
    corpus: "k2",
    requested: want,
    available: order.length,
    missing: Math.max(0, want - order.length),
    selected: order.slice(0, want).map((sessionHash, index) => ({
      index,
      sessionHash,
      questions: bySession.get(sessionHash) ?? [],
    })),
  };
}

/**
 * K-27 计划：按冻结夹具顺序取前 N 题（pilot 上限 10）。
 * @param {Array<object>} fixtures `evidence/lme-task50-v2.fixtures.json` 的 `questions`
 * @param {number} limit
 */
export function k27Plan(fixtures, limit) {
  const list = Array.isArray(fixtures) ? fixtures.filter((q) => isPlainObject(q) && typeof q.id === "string") : [];
  const want = Math.max(0, Math.min(Number(limit) || 0, LIMITS.k27PilotQuestions));
  return {
    corpus: "k27",
    requested: want,
    available: list.length,
    missing: Math.max(0, want - list.length),
    selected: list.slice(0, want).map((fixture, index) => ({
      index,
      questionId: fixture.id,
      type: String(fixture.type ?? ""),
    })),
  };
}

/* ══════════════════════════ 6 · K-27 夹具行适配器 ══════════════════════════ */

/**
 * 把 K-27 冻结夹具的 `fullContext`（`seq=NNN <text>` 行）变成「当前代码」能吃的会话事件。
 *
 * 为什么需要适配器：K-27 的源上下文是**冻结夹具的合成文本**（`evidence/lme-task50-v2.fixtures.json`，
 * 每份 100–250 字符），不是真实会话日志；而「候选 compact 必须由当前代码现场生成」这条纪律
 * 又要求它走生产的折叠编排。适配器只做两件事：按行切分、把行首 `seq=NNN` 当 seq。
 *
 * 它**不**猜角色：所有行一律记为 `user/message`（夹具没有角色信息，猜一个比不猜更糟），
 * 并在产物里标 `adapter: "fixture-lines-v1"` —— 读的人必须知道这不是真实会话。
 *
 * @param {string} text 夹具 `fullContext`
 * @returns {{events:Array<object>, unparsed:string[], seqs:number[]}}
 */
export function fixtureLinesToEvents(text) {
  const events = [];
  const unparsed = [];
  const seqs = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = /^seq=(\d+)\s?([\s\S]*)$/.exec(line);
    const seq = match === null ? NaN : Number(match[1]);
    if (!Number.isSafeInteger(seq)) {
      unparsed.push(line);
      continue;
    }
    const body = match[2] ?? "";
    seqs.push(seq);
    events.push({ seq, type: "user/message", data: { message: { content: [{ type: "text", text: body }] } } });
  }
  return { events, unparsed, seqs };
}

/** 空图（K-27 合成源没有棋谱；`renderFacts` 在空图上返回最短的硬事实块）。 */
export function emptyGraph() {
  return { nodes: {}, edges: {}, rootUserNodeIds: [], nextNode: 1, nextEdge: 1, order: [], pivots: [], foldMarks: [] };
}

/* ══════════════════════════ 7 · 源哈希（两臂配对与可复核） ══════════════════════════ */

/**
 * 源指纹：把「这一臂到底看了什么」压成一个哈希 —— `seq:type:text` 逐条拼接。
 * 两臂必须相同（`assertArmParity`）；事后复核也能据此确认候选不是别处的输入生成的。
 * @param {Array<object>} events
 * @param {{start?:number, end?:number}} [range]
 */
export function sourceDigest(events, { start = null, end = null } = {}) {
  // ★ 注意：`null` 不能被 `Number(null) === 0` 判成「有区间」—— 那会把所有 seq>0 的事件
  //   全部过滤掉，两臂的 source.hash 一起变成空串哈希 ⇒ 配对断言假绿。必须先判 null。
  const hasStart = start !== null && start !== undefined && Number.isFinite(Number(start));
  const hasEnd = end !== null && end !== undefined && Number.isFinite(Number(end));
  const parts = [];
  for (const event of Array.isArray(events) ? events : []) {
    const seq = Number(event?.seq);
    if (!Number.isFinite(seq)) continue;
    if (hasStart && seq < Number(start)) continue;
    if (hasEnd && seq > Number(end)) continue;
    parts.push(`${seq}\u0000${String(event?.type ?? "")}\u0000${JSON.stringify(event?.data ?? null)}`);
  }
  return { hash: sha256(parts.join("\n")), events: parts.length };
}

/* ══════════════════════════ 8 · K-2 值事实的派生（可审计） ══════════════════════════ */

/**
 * 把「当前代码会写进边上的值事实」派到**图的副本**上（不碰 live 图）。
 *
 * 为什么必须派生：K-2 两个冻结会话的 `graph.json` 早于 AX-04，`edge.valueFacts` **一条都没有**
 * （实测 0/17、0/33 条边），于是 `renderFacts(graph, {factGuard:true})` 与 `guard=false` 逐字相同
 * —— 候选等于基线，K-2 就永远测不出差异。这里用 **AX-02/AX-07 的同一个抽取器**
 * （`collectFoldValueFacts`，只读会话日志）重新抽一遍，挂到**证据结束 seq 恰好等于该事实
 * evidenceSeq 的那条边**上（AX-04 在 keeper 里正是「结算那一条边时写入」）。
 *
 * 三条不变量：
 *   ① **不写 live 图**：输入图被深拷贝后才挂；调用方传进来的对象一个字节都不变（测试钉住）。
 *   ② **映射不确定就不挂**：0 条命中或多条命中都只计数（`unmapped` / `multi`），不猜。
 *   ③ **可审计**：返回 `attached` 明细（边 id + 事实种类 + evidenceSeq），产物里能逐条对回源。
 *
 * @param {object} graph 冻结图（只读）
 * @param {Array<object>} events 会话事件（只读）
 * @param {{rangeStart?:number, rangeEnd?:number, derive?:boolean}} [options]
 */
export function deriveValueFacts(graph, events, { rangeStart = 1, rangeEnd = Number.MAX_SAFE_INTEGER, derive = true } = {}) {
  const copy = JSON.parse(JSON.stringify(graph ?? {}));
  const before = countEdgeValueFacts(copy);
  const result = { derive: derive === true, before, facts: 0, attached: [], unmapped: 0, multi: 0 };
  if (derive !== true) return { graph: copy, ...result };
  // ★ 注意：`collectFoldValueFacts` 的默认参数（`rangeStart=null/rangeEnd=null`）会被
  //   `Number(null) === 0` 判成合法区间，于是「不传区间」= 一条都抽不到（AX-07 的默认路径坑）。
  //   这里**必须显式传区间**。
  const facts = collectFoldValueFacts(events, { rangeStart, rangeEnd });
  result.facts = facts.length;
  const byEnd = new Map();
  for (const edge of Object.values(copy.edges ?? {})) {
    const end = Number(edge?.evidence?.end);
    if (!Number.isFinite(end)) continue;
    if (!byEnd.has(end)) byEnd.set(end, []);
    byEnd.get(end).push(edge.id);
  }
  for (const fact of facts) {
    const ids = byEnd.get(Number(fact.evidenceSeq)) ?? [];
    if (ids.length === 0) {
      result.unmapped += 1;
      continue;
    }
    if (ids.length > 1) {
      result.multi += 1;
      continue;
    }
    const edge = copy.edges[ids[0]];
    edge.valueFacts = [...(Array.isArray(edge.valueFacts) ? edge.valueFacts : []), fact];
    result.attached.push({ edge: ids[0], kind: String(fact.kind), evidenceSeq: Number(fact.evidenceSeq) });
  }
  return { graph: copy, ...result };
}

function countEdgeValueFacts(graph) {
  let total = 0;
  for (const edge of Object.values(graph?.edges ?? {})) {
    if (Array.isArray(edge?.valueFacts)) total += edge.valueFacts.length;
  }
  return total;
}

/* ══════════════════════════ 9 · 模型调用（唯一出口） ══════════════════════════ */

/**
 * 一次调用的公开投影：**只有坐标与用量**，没有 prompt 正文、没有回答正文。
 * 这是「记录模型/prompt/postprocess/usage/截断」里 prompt 与 usage 那一半的落盘形状。
 * @param {object} record makeCallModel 写进账本的原始记录
 */
export function callView(record) {
  if (!isPlainObject(record)) return null;
  return {
    index: record.index ?? null,
    model: record.model ?? null,
    servedModel: record.servedModel ?? null,
    promptChars: Number(record.promptChars ?? 0),
    promptSha256: record.promptSha256 ?? null,
    maxTokens: record.maxTokens === undefined ? null : record.maxTokens,
    status: record.status ?? null,
    finish: record.finish ?? null,
    usage: record.usage ?? null,
    outputChars: Number(record.outputChars ?? 0),
    reasoningChars: Number(record.reasoningChars ?? 0),
    ms: Number(record.ms ?? 0),
    error: record.error ?? null,
  };
}

/**
 * 构造 `callModel(prompt, {maxTokens})`（`runOfflineFold` 的注入契约）。
 *
 * 记账口径：每次**真的发出去**的调用都进 `calls`（含失败的 attempt），`usage` 原样保留
 * （网关给什么记什么，`null` 不编）。预算用尽直接抛 —— 宁可这一条 `NOT_RUN`，
 * 也不许悄悄多打网关（任务书把真实调用的次数与费用写进了验收）。
 *
 * 解码参数固定：`temperature:0`、`stream:false`、`max_tokens` 由调用方（`runOfflineFold`）给。
 * `thinking` / `reasoning_effort` 是否被上游尊重**不由本脚本假设** —— 请求里照生产脚本的写法带上，
 * 上游忽略时会表现为 `finish_reason=length` + `content:null`，那就如实记成截断/空回答。
 *
 * @param {{endpoint:string, model:string, apiKey?:string, timeoutMs?:number, maxCalls?:number, calls?:Array<object>}} options
 * @returns {(prompt:string, opts:{maxTokens:number}) => Promise<object>}
 */
export function makeCallModel({ endpoint, model, apiKey = "", timeoutMs = DEFAULT_TIMEOUT_MS, maxCalls = LIMITS.maxCalls, calls = [] } = {}) {
  return async function callModel(prompt, { maxTokens } = {}) {
    if (calls.length >= maxCalls) {
      throw new Error(`shadow 调用上限已用尽（${calls.length}/${maxCalls}）—— 不再打网关`);
    }
    const startedAt = Date.now();
    const record = {
      index: calls.length + 1,
      model,
      promptChars: String(prompt ?? "").length,
      promptSha256: sha256(prompt),
      maxTokens: Number(maxTokens) || null,
      startedAt: new Date(startedAt).toISOString(),
    };
    calls.push(record);
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey === "" ? {} : { authorization: `Bearer ${apiKey}` }) },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: String(prompt ?? "") }],
          max_tokens: Number(maxTokens) || 8192,
          temperature: 0,
          stream: false,
          // 与 `scripts/archive-fold.mjs` 同一写法（生产补折脚本的唯一先例）。
          // 上游不支持时会直接忽略 —— 那就靠 usage.finish 体现，不在这里假装成功。
          thinking: { type: "disabled" },
          reasoning_effort: "none",
          user_id: "gokifu-axiom-shadow",
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      record.error = String(error?.message ?? error).slice(0, 300);
      record.ms = Date.now() - startedAt;
      throw error;
    }
    const body = await response.json().catch(() => null);
    record.status = response.status;
    record.ms = Date.now() - startedAt;
    if (response.ok !== true) {
      record.error = `${response.status}: ${JSON.stringify(body).slice(0, 300)}`;
      throw new Error(`reader HTTP ${response.status}: ${String(body?.error?.message ?? JSON.stringify(body)).slice(0, 300)}`);
    }
    const choice = body?.choices?.[0] ?? {};
    const text = choice?.message?.content;
    record.usage = body?.usage ?? null;
    record.finish = choice?.finish_reason ?? null;
    record.servedModel = body?.model ?? null;
    record.outputChars = typeof text === "string" ? text.length : 0;
    record.reasoningChars = String(choice?.message?.reasoning_content ?? "").length;
    // ★ 返回的是**请求的那个模型 id**（AX-00 冻结值），不是网关回显的上游名。
    //   本机网关会把同一个请求 id 负载到不同上游（实测同一次运行里出现 marvis/… 与 wps-lingxi/…），
    //   拿回显名做两臂配对比较会**假红**，而把它当成「模型不同」又会掩盖真正的路由差异 ——
    //   所以两者分开记：`model` = 请求值（两臂必须相同），`servedModel` = 回显值（可能不同，要留痕）。
    return {
      text: typeof text === "string" ? text : "",
      usage: body?.usage ?? null,
      model: model,
      servedModel: body?.model ?? null,
      finish: choice?.finish_reason ?? null,
    };
  };
}

/* ══════════════════════════ 10 · 单条目：K-26 ══════════════════════════ */

/** 从 `sample.graphPath`（`chess-context/sessions/<sid>/graph.json`）取会话 id。 */
export function sessionIdOfGraphPath(graphPath) {
  const parts = String(graphPath ?? "").split(/[\\/]+/).filter(Boolean);
  const at = parts.lastIndexOf("graph.json");
  return at > 0 ? parts[at - 1] : "";
}

/**
 * K-26 单条目：冻结的 12 份之一。
 *
 * 源 = 会话日志（只读）+ 冻结图；折叠区间 = 该样本 `lastOfflineSummary.range`
 * （冻结摘要自己声明的区间 —— 用它才能说「同一段源」），事件按 `seq <= range.end` 钉住。
 * 两臂都跑**同一次** `runOfflineFold`，只差 `factGuard`。
 *
 * @param {{home:string, sample:object, callModel:Function, maxChars?:number, maxTokensCap?:number, outDir:string, keepPrompts?:boolean}} input
 */
export async function runK26Item({ home, sample, callModel, requestedModel = null, callLedger = null, maxChars = 60_000, maxTokensCap = 8192, outDir = "", keepPrompts = true } = {}) {
  const sampleId = String(sample?.sampleId ?? "");
  const graphPath = String(sample?.graphPath ?? "");
  const item = {
    schema: ITEM_SCHEMA,
    corpus: "k26",
    itemId: sampleId,
    index: Number(sample?.index ?? 0),
    status: "NOT_RUN",
    source: { kind: "session", graphPath, sessionId: "", range: null, events: 0, pinnedEvents: 0, hash: null },
    frozen: { summaryChars: Number(sample?.summaryChars ?? 0), summarySha256: null, usedAsCandidate: false, frozenSha256Match: null },
    arms: {},
  };
  const sessionId = sessionIdOfGraphPath(graphPath);
  item.source.sessionId = sessionId;
  if (sessionId === "") throw new Error(`sample.graphPath 解析不出会话 id：${graphPath}`);
  const graphFile = nodePath.join(home, graphPath);
  const loaded = loadSessionGraph(graphFile);
  if (loaded.deltaError !== null && loaded.deltaError !== undefined) {
    throw new Error(`graph delta 回放失败（${sessionId}）：${loaded.deltaError}`);
  }
  const graph = loaded.graph;
  const frozenSummary = graph?.lastOfflineSummary;
  const range = isPlainObject(frozenSummary?.range) ? frozenSummary.range : null;
  if (range === null || !Number.isFinite(Number(range.start)) || !Number.isFinite(Number(range.end))) {
    throw new Error(`冻结样本没有 lastOfflineSummary.range（${sampleId}）—— 无法界定同源区间`);
  }
  const rangeStart = Number(range.start);
  const rangeEnd = Number(range.end);
  item.source.range = { start: rangeStart, end: rangeEnd };
  const frozenText = typeof frozenSummary?.text === "string" ? frozenSummary.text : "";
  item.frozen.summaryChars = frozenText.length;
  item.frozen.frozenSha256 = sha256(frozenText);
  if (String(sample?.summaryHash ?? "") !== "") {
    item.frozen.frozenSha256Match = sha256(frozenText) === String(sample.summaryHash);
  }
  const logFile = findSessionLog(home, sessionId);
  if (logFile === null) throw new Error(`找不到会话日志（${sessionId}）`);
  const events = readSessionEvents(logFile);
  const pinned = events.filter((event) => Number(event?.seq) <= rangeEnd);
  item.source.events = events.length;
  item.source.pinnedEvents = pinned.length;
  if (pinned.length === 0) throw new Error(`会话日志为空（${sessionId}）`);
  item.source.hash = sourceDigest(pinned).hash;

  for (const arm of ARMS) {
    const prompts = [];
    const servedModels = [];
    const callStart = Array.isArray(callLedger) ? callLedger.length : 0;
    const wrapped = async (prompt, opts) => {
      if (keepPrompts && outDir !== "") {
        const file = nodePath.join(outDir, "prompts", `k26-${item.index}-${arm.factGuard ? "on" : "off"}.txt`);
        writeText(file, prompt);
        prompts.push({ file, chars: String(prompt).length, sha256: sha256(prompt) });
      }
      const out = await callModel(prompt, opts);
      if (typeof out?.servedModel === "string" && out.servedModel !== "") servedModels.push(out.servedModel);
      return out;
    };
    const startedAt = Date.now();
    const armRecord = {
      arm: arm.id,
      factGuard: arm.factGuard,
      prepare: arm.prepare,
      source: { hash: item.source.hash },
      question: null,
      model: requestedModel,
      servedModels: [],
      inputChars: null,
      messages: null,
      status: "NOT_RUN",
    };
    try {
      const result = await runOfflineFold({
        graph,
        events: pinned,
        rangeStart,
        rangeEnd,
        maxChars,
        maxChunks: 1,
        maxTokens: maxTokensCap,
        maxTokensCap,
        fromHead: true,
        callModel: wrapped,
        factGuard: arm.factGuard,
        sessionId,
      });
      const chunk = result.chunks?.[0] ?? null;
      if (chunk === null) {
        armRecord.status = "NOT_RUN";
        armRecord.failed = String(result.failed ?? "null");
        armRecord.error = `折叠没有产出（failed=${result.failed ?? "null"}）`;
        // ★ 守卫整份拒绝时 `runOfflineFold` 会带回 `guard` 记录 —— 那正是最该留痕的诊断
        //   （是「模型没按信封输出」还是「事实全被拒」，读的人必须分得清）。
        armRecord.guard = guardSummary(result.guard ?? null);
        armRecord.ms = Date.now() - startedAt;
        armRecord.prompts = prompts;
        armRecord.servedModels = [...new Set(servedModels)];
        armRecord.calls = Array.isArray(callLedger) ? callLedger.slice(callStart).map(callView) : [];
        item.arms[arm.id] = armRecord;
        continue;
      }
      armRecord.status = "SCORED";
      armRecord.text = chunk.text;
      armRecord.chars = String(chunk.text ?? "").length;
      armRecord.sha256 = sha256(chunk.text);
      armRecord.model = chunk.model ?? null;
      armRecord.inputChars = Number(chunk.chars) || 0;
      armRecord.messages = Number(chunk.messages) || 0;
      armRecord.dropped = Number(chunk.dropped) || 0;
      armRecord.inputTruncated = chunk.inputTruncated === true;
      armRecord.inputCutMessages = Number(chunk.inputCutMessages) || 0;
      armRecord.covered = { start: chunk.start, end: chunk.end };
      armRecord.usage = chunk.usage ?? null;
      armRecord.billedUsage = chunk.billedUsage ?? null;
      armRecord.billedCalls = Number(chunk.billedCalls ?? 1);
      armRecord.finish = chunk.finish ?? null;
      armRecord.truncated = chunk.truncated === true;
      armRecord.retrySkipped = chunk.retrySkipped === true;
      armRecord.postprocess = {
        sanitized: Number(chunk.sanitized) || 0,
        repaired: Number(chunk.repaired) || 0,
        repairedFailures: Number(chunk.repairedFailures) || 0,
        guardApplied: arm.factGuard === true,
      };
      armRecord.guard = arm.factGuard === true ? guardSummary(chunk.guard ?? null) : null;
      armRecord.prompts = prompts;
      armRecord.servedModels = [...new Set(servedModels)];
      armRecord.calls = Array.isArray(callLedger) ? callLedger.slice(callStart).map(callView) : [];
      armRecord.ms = Date.now() - startedAt;
      const frozen = frozenVerdict(chunk.text, frozenText);
      armRecord.frozen = { usedFrozen: frozen.usedFrozen, candidateSha256: frozen.candidateSha256, frozenSha256: frozen.frozenSha256 };
      // 失败要成对：这一臂成、那一臂败 ⇒ 配对断言会红（不在这里吞）。
      item.arms[arm.id] = armRecord;
    } catch (error) {
      armRecord.status = "NOT_RUN";
      armRecord.error = String(error?.message ?? error).slice(0, 500);
      armRecord.ms = Date.now() - startedAt;
      armRecord.prompts = prompts;
      item.arms[arm.id] = armRecord;
    }
  }
  item.route = routeSummary(item, requestedModel);
  item.parity = assertArmParity(item);
  const scored = ARMS.every((arm) => item.arms[arm.id]?.status === "SCORED");
  item.status = scored ? "SCORED" : "NOT_RUN";
  return item;
}

/* ══════════════════════════ 11 · 单条目：K-2 ══════════════════════════ */

/**
 * K-2 单条目：一个冻结会话（题集随会话一起带上）。
 *
 * compact 臂的**定义**来自 K-2 预注册（`scripts/k2-value-reader.mjs` 的 `ARM_MAPPING`）：
 * `user/assistant 文本 + 生产 renderFacts(graph)`。所以这里**没有模型调用** ——
 * 两臂的差别是 `factGuard` 是否让值事实进入 `renderFacts`，而不是摘要写得好不好。
 * 「`--live` 却 0 次调用」不是漏跑，是这条臂本来就不该花模型钱（产物里 `modelCalls: 0` 写清）。
 *
 * @param {{home:string, sessionHash:string, questions:Array<object>, derive?:boolean, outDir?:string}} input
 */
export function runK2Item({ home, sessionHash, questions = K2_QUESTIONS, derive = true, outDir = "" } = {}) {
  const item = {
    schema: ITEM_SCHEMA,
    corpus: "k2",
    itemId: String(sessionHash ?? ""),
    status: "NOT_RUN",
    source: { kind: "session", sessionHash: String(sessionHash ?? ""), sessionId: "", events: 0, hash: null },
    questions: (Array.isArray(questions) ? questions : [])
      .filter((q) => q?.sessionHash === sessionHash)
      .map((q) => ({ id: String(q.id ?? ""), kind: String(q.kind ?? ""), sourceSeq: Number(q.sourceSeq ?? 0) })),
    graph: { valueFactsBefore: 0, valueFactsAfter: 0 },
    derived: null,
    arms: {},
    parity: { ok: false, violations: ["未运行"] },
    modelCalls: 0,
  };
  const session = resolveSession(home, sessionHash);
  item.source.sessionId = session.sessionId;
  const graphFile = nodePath.join(home, "chess-context", "sessions", session.sessionId, "graph.json");
  const loaded = loadSessionGraph(graphFile);
  if (loaded.deltaError !== null && loaded.deltaError !== undefined) {
    throw new Error(`graph delta 回放失败（${session.sessionId}）：${loaded.deltaError}`);
  }
  const graph = loaded.graph;
  const events = readSessionEvents(session.logFile);
  item.source.events = events.length;
  item.source.hash = sourceDigest(events).hash;
  item.graph.valueFactsBefore = countEdgeValueFacts(graph);
  const derived = deriveValueFacts(graph, events, { rangeStart: 1, rangeEnd: Number.MAX_SAFE_INTEGER, derive });
  item.graph.valueFactsAfter = countEdgeValueFacts(derived.graph);
  item.derived = { derive: derived.derive, facts: derived.facts, attached: derived.attached.length, unmapped: derived.unmapped, multi: derived.multi, detail: derived.attached };

  const factsByArm = {
    "guard=false": renderFacts(graph, { factGuard: false }),
    "guard=true": renderFacts(derived.graph, { factGuard: true }),
  };
  for (const arm of ARMS) {
    const facts = factsByArm[arm.id];
    const built = buildContexts(events, facts);
    // 两臂的 user/assistant 正文**逐字相同**（只有 facts 段不同）⇒ 这段就是「同一段源」。
    if (item.sourceText === undefined) item.sourceText = { chars: built.compact.length - facts.length, sha256: sha256(built.compact.slice(0, built.compact.length - facts.length)) };
    if (item.fullText === undefined) item.fullText = built.full;
    item.arms[arm.id] = {
      arm: arm.id,
      factGuard: arm.factGuard,
      prepare: "user/assistant 文本 + 生产 renderFacts(graph)",
      source: { hash: item.source.hash },
      question: "K2:" + item.questions.map((q) => q.id).join(","),
      model: null,
      // ★ 两臂必须比「同一段源」：这里记的是 user/assistant 正文的长度（不含 facts），
      //   compact 的长度另有 `compactChars` —— 拿 compact 当 inputChars 会让配对断言假红。
      inputChars: built.compact.length - facts.length,
      messages: null,
      status: "SCORED",
      // 候选正文就是 compact 上下文（AX-12 直接拿它当 candidate 臂的 context）。
      text: built.compact,
      chars: built.compact.length,
      sha256: sha256(built.compact),
      factsChars: facts.length,
      fullChars: built.full.length,
      compactChars: built.compact.length,
      fullSha256: sha256(built.full),
      compactSha256: sha256(built.compact),
      valueFactsRendered: arm.factGuard === true ? derived.attached.length : 0,
      modelCalls: 0,
    };
  }
  // K-2 没有模型调用 ⇒ route 只记「无请求模型」（两臂都空，不算混淆项）。
  item.route = routeSummary(item, null);
  item.parity = assertArmParity(item);
  item.status = item.parity.ok ? "SCORED" : "NOT_RUN";
  return item;
}

/* ══════════════════════════ 12 · 单条目：K-27 ══════════════════════════ */

/**
 * K-27 单条目（pilot 题之一）：源 = 冻结夹具的 `fullContext`，经 `fixtureLinesToEvents` 适配后
 * 走**生产折叠编排**，两臂只差 `factGuard`。
 *
 * 已知退化（必须在报告里说，不许藏）：夹具用的是合成短上下文（100–250 字符），而生产提示词按
 * `suggestedLength` 要求 400 字以上正文 ⇒ 生成的「compact」很可能**比源还长**。这不会让结果变假，
 * 但会让「compact 更省」这句话在 K-27 上不成立；`oversize` 标志把它记下来。
 *
 * @param {{fixture:object, callModel:Function, index?:number, maxChars?:number, maxTokensCap?:number, outDir?:string, keepPrompts?:boolean}} input
 */
export async function runK27Item({ fixture, callModel, requestedModel = null, callLedger = null, index = 0, maxChars = 60_000, maxTokensCap = 8192, outDir = "", keepPrompts = true } = {}) {
  const fullContext = String(fixture?.fullContext ?? "");
  const adapted = fixtureLinesToEvents(fullContext);
  const item = {
    schema: ITEM_SCHEMA,
    corpus: "k27",
    itemId: String(fixture?.id ?? ""),
    index,
    type: String(fixture?.type ?? ""),
    status: "NOT_RUN",
    source: {
      kind: "fixture",
      adapter: K27_ADAPTER,
      fullContextChars: fullContext.length,
      events: adapted.events.length,
      unparsedLines: adapted.unparsed.length,
      range: adapted.seqs.length > 0 ? { start: Math.min(...adapted.seqs), end: Math.max(...adapted.seqs) } : null,
      hash: sourceDigest(adapted.events).hash,
    },
    frozen: { compactChars: String(fixture?.compactContext ?? "").length, compactSha256: sha256(String(fixture?.compactContext ?? "")), usedAsCandidate: false },
    arms: {},
  };
  if (adapted.events.length === 0) throw new Error(`K-27 夹具没有可解析的 seq 行（${item.itemId}）`);
  const rangeStart = item.source.range.start;
  const rangeEnd = item.source.range.end;
  const graph = emptyGraph();
  for (const arm of ARMS) {
    const prompts = [];
    const servedModels = [];
    const callStart = Array.isArray(callLedger) ? callLedger.length : 0;
    const wrapped = async (prompt, opts) => {
      if (keepPrompts && outDir !== "") {
        const file = nodePath.join(outDir, "prompts", `k27-${item.itemId}-${arm.factGuard ? "on" : "off"}.txt`);
        writeText(file, prompt);
        prompts.push({ file, chars: String(prompt).length, sha256: sha256(prompt) });
      }
      const out = await callModel(prompt, opts);
      if (typeof out?.servedModel === "string" && out.servedModel !== "") servedModels.push(out.servedModel);
      return out;
    };
    const startedAt = Date.now();
    const armRecord = {
      arm: arm.id,
      factGuard: arm.factGuard,
      prepare: arm.prepare,
      source: { hash: item.source.hash },
      question: item.itemId,
      model: requestedModel,
      servedModels: [],
      inputChars: null,
      messages: null,
      status: "NOT_RUN",
    };
    try {
      const result = await runOfflineFold({
        graph,
        events: adapted.events,
        rangeStart,
        rangeEnd,
        maxChars,
        maxChunks: 1,
        maxTokens: maxTokensCap,
        maxTokensCap,
        fromHead: true,
        callModel: wrapped,
        factGuard: arm.factGuard,
        sessionId: null,
      });
      const chunk = result.chunks?.[0] ?? null;
      if (chunk === null) {
        armRecord.failed = String(result.failed ?? "null");
        armRecord.error = `折叠没有产出（failed=${result.failed ?? "null"}）`;
        armRecord.guard = guardSummary(result.guard ?? null);
        armRecord.ms = Date.now() - startedAt;
        armRecord.prompts = prompts;
        armRecord.servedModels = [...new Set(servedModels)];
        armRecord.calls = Array.isArray(callLedger) ? callLedger.slice(callStart).map(callView) : [];
        item.arms[arm.id] = armRecord;
        continue;
      }
      armRecord.status = "SCORED";
      armRecord.text = chunk.text;
      armRecord.chars = String(chunk.text ?? "").length;
      armRecord.sha256 = sha256(chunk.text);
      armRecord.model = chunk.model ?? null;
      armRecord.inputChars = Number(chunk.chars) || 0;
      armRecord.messages = Number(chunk.messages) || 0;
      armRecord.covered = { start: chunk.start, end: chunk.end };
      armRecord.usage = chunk.usage ?? null;
      armRecord.billedUsage = chunk.billedUsage ?? null;
      armRecord.billedCalls = Number(chunk.billedCalls ?? 1);
      armRecord.finish = chunk.finish ?? null;
      armRecord.truncated = chunk.truncated === true;
      armRecord.postprocess = {
        sanitized: Number(chunk.sanitized) || 0,
        repaired: Number(chunk.repaired) || 0,
        repairedFailures: Number(chunk.repairedFailures) || 0,
        guardApplied: arm.factGuard === true,
      };
      armRecord.guard = arm.factGuard === true ? guardSummary(chunk.guard ?? null) : null;
      armRecord.prompts = prompts;
      armRecord.servedModels = [...new Set(servedModels)];
      armRecord.calls = Array.isArray(callLedger) ? callLedger.slice(callStart).map(callView) : [];
      armRecord.ms = Date.now() - startedAt;
      const frozen = frozenVerdict(chunk.text, fullContext === "" ? "" : String(fixture?.compactContext ?? ""));
      armRecord.frozen = { usedFrozen: frozen.usedFrozen, candidateSha256: frozen.candidateSha256, frozenSha256: frozen.frozenSha256 };
      // 退化标志：compact 不比源短（K-27 夹具源的固有形状，见 docblock）。
      armRecord.oversize = armRecord.chars >= fullContext.length;
      item.arms[arm.id] = armRecord;
    } catch (error) {
      armRecord.error = String(error?.message ?? error).slice(0, 500);
      armRecord.ms = Date.now() - startedAt;
      armRecord.prompts = prompts;
      item.arms[arm.id] = armRecord;
    }
  }
  item.route = routeSummary(item, requestedModel);
  item.parity = assertArmParity(item);
  item.status = ARMS.every((arm) => item.arms[arm.id]?.status === "SCORED") ? "SCORED" : "NOT_RUN";
  return item;
}

/* ══════════════════════════ 13 · 聚合 / 隐私 / 报告 ══════════════════════════ */

/** 一条 arm 记录的公开投影（去正文、去 prompt 路径）。 */
export function publicArmView(record) {
  if (!isPlainObject(record)) return null;
  return {
    arm: record.arm ?? null,
    factGuard: record.factGuard === true,
    status: record.status ?? "NOT_RUN",
    chars: Number(record.chars ?? 0),
    sha256: record.sha256 ?? null,
    inputChars: Number(record.inputChars ?? 0),
    messages: record.messages === null || record.messages === undefined ? null : Number(record.messages),
    covered: record.covered ?? null,
    fullChars: record.fullChars === undefined ? undefined : Number(record.fullChars),
    compactChars: record.compactChars === undefined ? undefined : Number(record.compactChars),
    factsChars: record.factsChars === undefined ? undefined : Number(record.factsChars),
    valueFactsRendered: record.valueFactsRendered === undefined ? undefined : Number(record.valueFactsRendered),
    usage: record.usage ?? null,
    billedUsage: record.billedUsage ?? null,
    billedCalls: record.billedCalls === undefined ? null : Number(record.billedCalls),
    model: record.model ?? null,
    servedModels: Array.isArray(record.servedModels) ? record.servedModels : [],
    finish: record.finish ?? null,
    truncated: record.truncated === true,
    retrySkipped: record.retrySkipped === true,
    inputTruncated: record.inputTruncated === true,
    inputCutMessages: Number(record.inputCutMessages ?? 0),
    postprocess: record.postprocess ?? null,
    guard: record.guard ?? null,
    frozen: record.frozen ?? null,
    oversize: record.oversize === undefined ? undefined : record.oversize === true,
    failed: record.failed ?? null,
    calls: Array.isArray(record.calls) ? record.calls : [],
    error: record.error ?? null,
    ms: Number(record.ms ?? 0),
  };
}

/** 一条 K-2 / K-26 / K-27 条目的公开投影。 */
export function publicItemView(item) {
  const arms = {};
  for (const arm of ARMS) arms[arm.id] = publicArmView(item?.arms?.[arm.id]);
  const source = isPlainObject(item?.source) ? item.source : {};
  return {
    corpus: item?.corpus ?? null,
    itemId: item?.itemId ?? null,
    index: item?.index ?? null,
    type: item?.type ?? null,
    status: item?.status ?? "NOT_RUN",
    // ★ 白名单投影：**不带** sessionId / graphPath（那是会话坐标，属私有）。
    source: {
      kind: source.kind ?? null,
      adapter: source.adapter ?? null,
      range: source.range ?? null,
      events: source.events === undefined ? null : Number(source.events),
      pinnedEvents: source.pinnedEvents === undefined ? null : Number(source.pinnedEvents),
      fullContextChars: source.fullContextChars === undefined ? null : Number(source.fullContextChars),
      unparsedLines: source.unparsedLines === undefined ? null : Number(source.unparsedLines),
      hash: source.hash ?? null,
    },
    frozen: item?.frozen ?? null,
    graph: item?.graph ?? null,
    derived: item?.derived
      ? { derive: item.derived.derive, facts: item.derived.facts, attached: item.derived.attached, unmapped: item.derived.unmapped, multi: item.derived.multi }
      : null,
    questions: Array.isArray(item?.questions) ? item.questions.map((q) => ({ id: q.id, kind: q.kind, sourceSeq: q.sourceSeq })) : null,
    modelCalls: Number(item?.modelCalls ?? 0),
    route: item?.route ?? null,
    parity: item?.parity ?? null,
    arms,
  };
}

/**
 * 汇总一次运行（**只吃公开投影**，不接触正文）。
 * @param {object} input `{rev, mode, defaultModel, endpoint, calls, items, notRun, limitations}`
 */
export function summarizeRun(input) {
  const items = Array.isArray(input?.items) ? input.items : [];
  const calls = Array.isArray(input?.calls) ? input.calls : [];
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0, callsWithUsage: 0 };
  for (const call of calls) {
    const u = call?.usage ?? null;
    if (!isPlainObject(u)) continue;
    usage.callsWithUsage += 1;
    usage.promptTokens += Number(u.prompt_tokens ?? 0) || 0;
    usage.completionTokens += Number(u.completion_tokens ?? 0) || 0;
    usage.totalTokens += Number(u.total_tokens ?? 0) || 0;
    usage.reasoningTokens += Number(u.completion_tokens_details?.reasoning_tokens ?? 0) || 0;
  }
  const corpora = {};
  for (const corpus of ["k26", "k2", "k27"]) {
    const list = items.filter((item) => item?.corpus === corpus);
    corpora[corpus] = {
      requested: Number(input?.plans?.[corpus]?.requested ?? 0),
      available: Number(input?.plans?.[corpus]?.available ?? 0),
      missing: Number(input?.plans?.[corpus]?.missing ?? 0),
      items: list.map((item) => publicItemView(item)),
      scored: list.filter((item) => item?.status === "SCORED").length,
      notRun: list.filter((item) => item?.status !== "SCORED").length,
    };
  }
  const parityViolations = items.filter((item) => item?.parity && item.parity.ok !== true);
  const scored = items.filter((item) => item?.status === "SCORED").length;
  return {
    schema: SCHEMA,
    status: items.length === 0 ? "NOT_RUN" : scored === items.length ? "SCORED" : scored === 0 ? "NOT_RUN" : "PARTIAL",
    rev: input?.rev ?? null,
    generatedAt: input?.generatedAt ?? null,
    mode: input?.mode ?? "plan",
    defaultModel: input?.defaultModel ?? null,
    endpoint: input?.endpoint ?? null,
    decode: input?.decode ?? null,
    budget: {
      maxCalls: Number(input?.maxCalls ?? LIMITS.maxCalls),
      callsUsed: calls.length,
      totalBilledCalls: items.reduce((n, item) => n + ARMS.reduce((m, arm) => m + Number(item?.arms?.[arm.id]?.billedCalls ?? 0), 0), 0),
    },
    plans: input?.plans ?? {},
    corpora,
    totals: {
      items: items.length,
      scored,
      notRun: items.length - scored,
      parityViolations: parityViolations.length,
      servedModelMixed: items.filter((item) => item?.route && item.route.sameServed === false).length,
      calls: calls.length,
      errors: calls.filter((call) => call?.error).length,
      truncated: items.reduce((n, item) => n + ARMS.filter((arm) => item?.arms?.[arm.id]?.truncated === true).length, 0),
      inputTruncated: items.reduce((n, item) => n + ARMS.filter((arm) => item?.arms?.[arm.id]?.inputTruncated === true).length, 0),
      usage,
    },
    calls: calls.map(callView),
    notRun: Array.isArray(input?.notRun) ? input.notRun : [],
    limitations: Array.isArray(input?.limitations) ? input.limitations : [],
  };
}

/**
 * 隐私自检：产物文本里不许出现任何私有串。
 *
 * 检查对象是**要落盘的公开文档**（`run.json` / `REPORT.md`），needles 由调用方从私有条目里取
 * （正文前缀、每条 quote、每个值事实、sid、会话 id）。命中即违规（不是警告）。
 *
 * @param {string} text 公开文档
 * @param {string[]} needles 私有串
 */
export function privacyCheck(text, needles) {
  const haystack = String(text ?? "");
  const violations = [];
  for (const needle of Array.isArray(needles) ? needles : []) {
    const probe = String(needle ?? "");
    if (probe.length < 8) continue; // 太短的串（"user"、"n1"）命中没有意义
    if (haystack.includes(probe)) violations.push(probe.slice(0, 40));
  }
  return { ok: violations.length === 0, checked: (Array.isArray(needles) ? needles : []).filter((n) => String(n ?? "").length >= 8).length, violations };
}

/**
 * 从私有条目里收集隐私探针（正文前缀 / quote / 值 / 会话 id）。
 * @param {Array<object>} items 私有条目
 */
export function privacyNeedles(items) {
  const needles = new Set();
  const add = (value) => {
    const text = String(value ?? "");
    if (text.length >= 12) needles.add(text);
  };
  for (const item of Array.isArray(items) ? items : []) {
    // ★ sessionId 是会话坐标（私有）；sampleId / sessionHash 是冻结证据里本来就有的短哈希，
    //   不算私有串 —— 它们必须留在产物里，AX-11/12 靠它对应源。
    add(item?.source?.sessionId);
    for (const arm of ARMS) {
      const record = item?.arms?.[arm.id] ?? null;
      if (record === null) continue;
      const text = String(record?.text ?? "");
      if (text !== "") {
        add(text.slice(0, 80));
        add(text.slice(Math.max(0, text.length - 60)));
      }
      for (const verdict of Array.isArray(record?.guard?.facts) ? record.guard.facts : []) {
        add(verdict?.quote);
        add(String(verdict?.value ?? ""));
      }
    }
  }
  return [...needles];
}

/**
 * 渲染 `REPORT.md`（**只有聚合**；正文/quote/sid 一个都不进）。
 * @param {object} run `summarizeRun` 的产物
 */
export function renderReport(run) {
  const lines = [];
  const dm = run.defaultModel ?? {};
  lines.push("# AX-10 · shadow 候选上下文（两臂）", "");
  lines.push(`> schema：\`${SCHEMA}\` · 状态：**${run.status}** · rev：\`${run.rev ?? "?"}\` · generatedAt：\`${run.generatedAt ?? "?"}\``);
  lines.push("");
  lines.push("## 1 · 结论");
  lines.push("");
  lines.push(`- 条目：**${run.totals.items}** 个（SCORED ${run.totals.scored} / NOT_RUN ${run.totals.notRun}）· 两臂配对违规 **${run.totals.parityViolations}**。`);
  lines.push(`- 真实模型调用：**${run.totals.calls}** 次（上限 ${run.budget.maxCalls}）；错误 ${run.totals.errors} 次；成对记账共 ${run.budget.totalBilledCalls} 次。`);
  lines.push(`- 模型：\`${dm.provider ?? "?"}\` / \`${dm.model ?? "?"}\`（来源 \`${dm.source ?? "?"}\`，文件 sha256 \`${String(dm.sha256 ?? "?").slice(0, 16)}…\`）。`);
  lines.push(`- 截断：输出撞顶 **${run.totals.truncated}** 臂 · 输入侧裁切 **${run.totals.inputTruncated}** 臂。`);
  if (run.privacy) lines.push(`- 隐私自检：checked **${run.privacy.checked === true}** · 探针 ${run.privacy.needles ?? 0} 条 · 命中 **${run.privacy.violations ?? 0}**。`);
  lines.push(`- 路由：同一请求 id 下，**两臂网关回显上游不同**的条目 ${run.totals.servedModelMixed ?? 0} 个（混淆项，见每条臂的 servedModels）。`);
  lines.push("");
  lines.push("## 2 · 用量");
  lines.push("");
  const u = run.totals.usage ?? {};
  lines.push("| 项 | 值 |");
  lines.push("|---|---:|");
  lines.push(`| prompt tokens | ${u.promptTokens ?? 0} |`);
  lines.push(`| completion tokens | ${u.completionTokens ?? 0} |`);
  lines.push(`| 其中 reasoning | ${u.reasoningTokens ?? 0} |`);
  lines.push(`| total tokens | ${u.totalTokens ?? 0} |`);
  lines.push(`| 带 usage 的调用 | ${u.callsWithUsage ?? 0} / ${run.totals.calls} |`);
  lines.push("");
  for (const corpus of ["k26", "k2", "k27"]) {
    const block = run.corpora?.[corpus] ?? { items: [], requested: 0, available: 0, missing: 0, scored: 0, notRun: 0 };
    lines.push(`## 3 · ${corpus.toUpperCase()}（请求 ${block.requested} / 可用 ${block.available} / 缺 ${block.missing}）`);
    lines.push("");
    if (block.items.length === 0) {
      const flag = corpus === "k26" ? "k26-samples" : corpus === "k2" ? "k2-sessions" : "k27-questions";
      lines.push(`- 未请求（\`--${flag} 0\`）。`);
      lines.push("");
      continue;
    }
    lines.push("| 条目 | 状态 | 臂 | 正文/上下文 chars | 输入 chars | 消息 | 截断 | 守卫 | Ms |");
    lines.push("|---|---|---|---:|---:|---:|:--:|---|---:|");
    for (const item of block.items) {
      for (const armId of Object.keys(item.arms ?? {})) {
        const arm = item.arms[armId];
        if (arm === null) continue;
        const guard = arm.guard === null || arm.guard === undefined ? "—" : `${arm.guard.verdict ?? "?"}（facts ${arm.guard.facts?.total ?? 0}：S${arm.guard.facts?.SUPPORTED ?? 0}/U${arm.guard.facts?.UNVERIFIED ?? 0}/R${arm.guard.facts?.REJECTED ?? 0}/P${arm.guard.facts?.PENDING ?? 0}）`;
        const size = arm.compactChars !== undefined ? `${arm.compactChars}（compact）` : `${arm.chars}`;
        lines.push(
          `| ${item.itemId} | ${item.status} | ${armId} | ${size} | ${arm.inputChars ?? 0} | ${arm.messages ?? "—"} | ${arm.truncated === true ? "是" : "否"} | ${guard} | ${arm.ms ?? 0} |`,
        );
      }
    }
    lines.push("");
    const extra = block.items
      .filter((item) => item.graph || item.derived || item.source?.adapter || item.frozen)
      .map((item) => {
        const bits = [];
        if (item.graph) bits.push(`图内 valueFacts 前 ${item.graph.valueFactsBefore} / 后 ${item.graph.valueFactsAfter}`);
        if (item.derived) bits.push(`派生值事实 ${item.derived.facts} 条（挂边 ${item.derived.attached} / 未命中 ${item.derived.unmapped} / 多义 ${item.derived.multi}）`);
        if (item.source?.adapter) bits.push(`源适配器 \`${item.source.adapter}\`（合成长度 ${item.source.fullContextChars} 字符）`);
        if (item.source?.range) bits.push(`区间 ${item.source.range.start}-${item.source.range.end}`);
        return `- ${item.itemId}：${bits.join(" · ")}`;
      });
    if (extra.length > 0) {
      lines.push(...extra);
      lines.push("");
    }
  }
  if (run.limitations.length > 0) {
    lines.push("## 4 · 限制与未验项");
    lines.push("");
    for (const line of run.limitations) lines.push(`- ${line}`);
    lines.push("");
  }
  if (run.notRun.length > 0) {
    lines.push("## 5 · NOT_RUN 明细");
    lines.push("");
    for (const entry of run.notRun) lines.push(`- ${entry.corpus ?? "?"} / ${entry.itemId ?? "?"}：${entry.reason ?? "?"}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/* ══════════════════════════ 14 · 主流程 ══════════════════════════ */

/** 读 git rev（不依赖 git 也能跑：读不到就返回 null，不编）。 */
function readGitRev() {
  try {
    // ★ worktree 与主仓库的 HEAD 是**两件事**：`.git` 文件指向 `.git/worktrees/<name>`，
    //   那里面的 HEAD 才是本工作树的分支；主仓库的 HEAD 在 commondir 里。先读 gitDir 的 HEAD，
    //   再去 gitDir / commondir 找 ref，最后看 packed-refs —— 顺序错了会把「主仓库 rev」写进报告，
    //   而报告要写的是**这一刀实际用的代码**。
    const dotGit = nodePath.join(ROOT, ".git");
    if (!nodeFs.existsSync(dotGit)) return null;
    let gitDir = dotGit;
    let common = dotGit;
    if (nodeFs.statSync(dotGit).isFile()) {
      const pointer = /^gitdir:s*(.+)$/.exec(nodeFs.readFileSync(dotGit, "utf8").trim());
      if (pointer === null) return null;
      gitDir = nodePath.resolve(ROOT, pointer[1].trim());
      common = gitDir;
      try {
        common = nodePath.resolve(gitDir, nodeFs.readFileSync(nodePath.join(gitDir, "commondir"), "utf8").trim());
      } catch {
        /* 没有 commondir 就是 gitDir 自己 */
      }
    }
    const head = nodeFs.readFileSync(nodePath.join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const branch = /^ref:s*(.+)$/.exec(head);
    if (branch === null) return null;
    const name = branch[1].trim();
    for (const base of [gitDir, common]) {
      const loose = nodePath.join(base, name);
      if (nodeFs.existsSync(loose)) return nodeFs.readFileSync(loose, "utf8").trim();
    }
    const packed = nodePath.join(common, "packed-refs");
    if (nodeFs.existsSync(packed)) {
      for (const line of nodeFs.readFileSync(packed, "utf8").split("
")) {
        const [sha, ref] = line.trim().split(/s+/);
        if (ref === name) return sha;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 主入口。
 * @param {string[]} argv
 * @returns {Promise<number>} 退出码
 */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.options.help) {
    console.log(USAGE);
    return 0;
  }
  if (!parsed.ok) {
    for (const error of parsed.errors) console.error(`✗ ${error}`);
    console.error(USAGE);
    return 2;
  }
  const options = parsed.options;
  const out = nodePath.resolve(options.out);
  try {
    assertIsolated({ home: options.home, out });
  } catch (error) {
    console.error(`✗ ${String(error?.message ?? error)}`);
    return 2;
  }
  const problems = auditSource();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ 静态自检：${problem}`);
    return 1;
  }

  const generatedAt = new Date().toISOString();
  const rev = readGitRev();
  const defaultModel = loadDefaultModel(options.defaultModel);
  const plans = { k26: null, k2: null, k27: null };
  const notRun = [];

  // ── 计划（不需要模型，也能跑）
  const wantK26 = options.only === "all" || options.only === "k26" ? options.k26Samples : 0;
  const wantK2 = options.only === "all" || options.only === "k2" ? options.k2Sessions : 0;
  const wantK27 = options.only === "all" || options.only === "k27" ? options.k27Questions : 0;

  let k26Samples = [];
  if (wantK26 > 0) {
    if (options.k26Manifest === "") {
      plans.k26 = { corpus: "k26", requested: wantK26, available: 0, missing: wantK26, selected: [] };
      notRun.push({ corpus: "k26", itemId: null, reason: "缺 --k26-manifest（K-26 私有 manifest.json 只读路径未给）" });
    } else {
      const manifest = readJsonOrNull(options.k26Manifest);
      if (!isPlainObject(manifest) || !Array.isArray(manifest.samples)) {
        plans.k26 = { corpus: "k26", requested: wantK26, available: 0, missing: wantK26, selected: [] };
        notRun.push({ corpus: "k26", itemId: null, reason: `读不到 K-26 manifest 的 samples（${options.k26Manifest}）` });
      } else {
        const plan = k26Plan(manifest.samples, wantK26);
        plans.k26 = plan;
        k26Samples = plan.selected;
        if (plan.missing > 0) notRun.push({ corpus: "k26", itemId: null, reason: `冻结样本不足：要 ${plan.requested} 实际 ${plan.available}（缺样本不补合成）` });
      }
    }
  } else {
    plans.k26 = { corpus: "k26", requested: 0, available: 0, missing: 0, selected: [] };
  }

  const k2Questions = K2_QUESTIONS;
  if (wantK2 > 0) {
    plans.k2 = k2Plan(k2Questions, wantK2);
  } else {
    plans.k2 = { corpus: "k2", requested: 0, available: k2Plan(k2Questions, 999).available, missing: 0, selected: [] };
  }

  let k27Fixtures = [];
  {
    const fixturesFile = nodePath.join(ROOT, "evidence", "lme-task50-v2.fixtures.json");
    const doc = readJsonOrNull(fixturesFile);
    k27Fixtures = Array.isArray(doc?.questions) ? doc.questions : [];
    if (wantK27 > 0) {
      if (k27Fixtures.length === 0) {
        plans.k27 = { corpus: "k27", requested: wantK27, available: 0, missing: wantK27, selected: [] };
        notRun.push({ corpus: "k27", itemId: null, reason: "读不到 K-27 冻结夹具 evidence/lme-task50-v2.fixtures.json" });
      } else {
        const plan = k27Plan(k27Fixtures, wantK27);
        plans.k27 = plan;
        if (plan.missing > 0) notRun.push({ corpus: "k27", itemId: null, reason: `冻结题不足：要 ${plan.requested} 实际 ${plan.available}（缺样本不补合成）` });
      }
    } else {
      plans.k27 = { corpus: "k27", requested: 0, available: k27Plan(k27Fixtures, 999).available, missing: 0, selected: [] };
    }
  }

  const planDoc = {
    schema: SCHEMA,
    mode: "plan",
    generatedAt,
    rev,
    out,
    home: options.home === "" ? null : nodePath.resolve(options.home),
    defaultModel: { ok: defaultModel.ok, file: defaultModel.file, sha256: defaultModel.sha256, provider: defaultModel.provider, model: defaultModel.model, source: defaultModel.source, errors: defaultModel.errors },
    endpoint: options.endpoint,
    limits: { maxCalls: options.maxCalls, k26Samples: LIMITS.k26Samples, k2Questions: LIMITS.k2Questions, k27PilotQuestions: LIMITS.k27PilotQuestions },
    deriveValueFacts: options.derive,
    plans,
    notRun,
  };
  writeJson(nodePath.join(out, "plan.json"), planDoc);

  if (!options.live) {
    console.log(JSON.stringify({ mode: "plan", out, plans: { k26: plans.k26.requested, k2: plans.k2.requested, k27: plans.k27.requested }, defaultModel: { ok: defaultModel.ok, errors: defaultModel.errors }, notRun }, null, 2));
    return 0;
  }

  // ── 真跑：模型配置必须先读得到；读不到就整轮 NOT_RUN（不兜底、不换模型）
  if (!defaultModel.ok) {
    const run = summarizeRun({
      rev,
      generatedAt,
      mode: "live",
      plans,
      items: [],
      calls: [],
      notRun: [...notRun, { corpus: "all", itemId: null, reason: `默认模型不可用：${defaultModel.errors.join("；")}` }],
      limitations: ["模型配置读不到 ⇒ 整轮 NOT_RUN（任务书：读不到则 NOT_RUN，不得回退伪造）"],
    });
    run.defaultModel = { ok: false, file: defaultModel.file, sha256: defaultModel.sha256, provider: null, model: null, source: null };
    run.endpoint = options.endpoint;
    writeJson(nodePath.join(out, "run.json"), run);
    writeText(nodePath.join(out, "REPORT.md"), renderReport(run));
    console.error(`✗ 默认模型不可用：${defaultModel.errors.join("；")}`);
    return 3;
  }

  const calls = [];
  const callModel = makeCallModel({ endpoint: options.endpoint, model: defaultModel.model, timeoutMs: options.timeoutMs, maxCalls: options.maxCalls, calls });
  const items = [];
  const limitations = [];

  // K-26
  for (const sample of k26Samples) {
    try {
      const item = await runK26Item({
        home: options.home,
        sample,
        callModel,
        requestedModel: defaultModel.model,
        callLedger: calls,
        maxChars: options.maxChars,
        maxTokensCap: options.maxTokensCap,
        outDir: out,
      });
      items.push(item);
      if (item.status !== "SCORED") notRun.push({ corpus: "k26", itemId: item.itemId, reason: (item.arms["guard=false"]?.error ?? "") + " | " + (item.arms["guard=true"]?.error ?? "") });
      writeJson(nodePath.join(out, "k26", `${item.index}-${item.itemId}.json`), item);
    } catch (error) {
      notRun.push({ corpus: "k26", itemId: sample.sampleId, reason: String(error?.message ?? error).slice(0, 300) });
    }
  }

  // K-2（无模型调用：预注册里 compact 臂就是 renderFacts）
  for (const entry of plans.k2.selected ?? []) {
    try {
      const item = runK2Item({ home: options.home, sessionHash: entry.sessionHash, questions: k2Questions, derive: options.derive, outDir: out });
      items.push(item);
      if (item.status !== "SCORED") notRun.push({ corpus: "k2", itemId: item.itemId, reason: item.parity?.violations?.join("；") ?? "配对违规" });
      writeJson(nodePath.join(out, "k2", `${item.itemId}.json`), item);
    } catch (error) {
      notRun.push({ corpus: "k2", itemId: entry.sessionHash, reason: String(error?.message ?? error).slice(0, 300) });
    }
  }

  // K-27
  for (const entry of plans.k27.selected ?? []) {
    const fixture = k27Fixtures.find((q) => q?.id === entry.questionId);
    if (fixture === undefined) {
      notRun.push({ corpus: "k27", itemId: entry.questionId, reason: "夹具里找不到该题（不合成补位）" });
      continue;
    }
    try {
      const item = await runK27Item({
        fixture,
        callModel,
        requestedModel: defaultModel.model,
        callLedger: calls,
        index: entry.index,
        maxChars: options.maxChars,
        maxTokensCap: options.maxTokensCap,
        outDir: out,
      });
      items.push(item);
      if (item.status !== "SCORED") notRun.push({ corpus: "k27", itemId: item.itemId, reason: (item.arms["guard=false"]?.error ?? "") + " | " + (item.arms["guard=true"]?.error ?? "") });
      writeJson(nodePath.join(out, "k27", `${item.itemId}.json`), item);
    } catch (error) {
      notRun.push({ corpus: "k27", itemId: entry.questionId, reason: String(error?.message ?? error).slice(0, 300) });
    }
  }

  // 限制（必须写进公开报告：哪些是真结论、哪些只是这条路的形状）
  limitations.push("K-27 源上下文是**合成夹具**（100–250 字符、无角色信息），由 `fixture-lines-v1` 适配器转成事件；它的「compact」由生产折叠编排现场生成，但该编排按 `suggestedLength` 要求 400 字以上正文 ⇒ 候选很可能**比源更长**（`oversize`）。K-27 的压缩率结论不能从这条臂得出。");
  limitations.push("K-2 的 compact 臂在预注册里的定义就是「user/assistant 文本 + 生产 `renderFacts(graph)`」⇒ **0 次模型调用**。两臂差异 = `factGuard` 是否让 `edge.valueFacts` 进入清单。");
  if (options.derive) {
    limitations.push("K-2 冻结图的 `edge.valueFacts` 为空（两个会话实测 0 条，图早于 AX-04）⇒ 脚本用 AX-02 的同一抽取器从会话日志**派生**值事实，挂到「证据结束 seq == evidenceSeq」的唯一那条边上；live 图未被写入，派生明细在 `k2/<session>.json` 的 `derived.detail`。");
  }
  limitations.push("K-26 的折叠区间取该样本 `lastOfflineSummary.range`（冻结摘要自己声明的区间），事件按 `seq <= range.end` 钉住；因此「同一段源」是可核对的，但**不是**逐字复现当初那次折叠的输入（输入侧裁切见 `inputTruncated` / `dropped`）。");
  limitations.push("本轮**没有**真实 reader；候选可用性由 AX-11（K-26 复判）/AX-12（K-2）/AX-13（K-27）裁决。");
  limitations.push("路由混淆：本机网关把**同一个请求 id** 负载到不同上游（同一次运行里两臂的 servedModels 可能不同）⇒ 两臂的实际推理后端未必是同一个。run.json 的 totals.servedModelMixed 给出这类条目数；配对断言只比**请求的模型 id**（AX-00 冻结值），上游回显名不参与比较，但必须留痕。");
  limitations.push("`collectFoldValueFacts` 的**默认参数**有坑：`rangeStart=null/rangeEnd=null` 经 `Number(null)===0` 会判成合法区间 ⇒ 不传区间时一条都抽不到。本脚本总是显式传区间（见 `deriveValueFacts`）；该默认值本身不在 AX-10 的可写路径内，未改动。");

  // 公开计划：**去掉 graphPath 等私有坐标**（run.json 是要给下游读的聚合文档）。
  const publicPlans = {};
  for (const corpus of ["k26", "k2", "k27"]) {
    const plan = plans[corpus] ?? { corpus, requested: 0, available: 0, missing: 0, selected: [] };
    publicPlans[corpus] = {
      corpus,
      requested: Number(plan.requested ?? 0),
      available: Number(plan.available ?? 0),
      missing: Number(plan.missing ?? 0),
      selected: (Array.isArray(plan.selected) ? plan.selected : []).map((entry) => ({
        index: entry.index,
        itemId: entry.sampleId ?? entry.sessionHash ?? entry.questionId ?? null,
        questions: entry.questions ?? null,
      })),
    };
  }

  const run = summarizeRun({
    rev,
    generatedAt,
    mode: "live",
    plans: publicPlans,
    items,
    calls,
    maxCalls: options.maxCalls,
    endpoint: options.endpoint,
    defaultModel: { ok: true, file: defaultModel.file, sha256: defaultModel.sha256, provider: defaultModel.provider, model: defaultModel.model, source: defaultModel.source },
    decode: { temperature: 0, stream: false, thinking: "disabled(请求携带，上游可忽略)", reasoningEffort: "none(请求携带，上游可忽略)", maxTokens: "由 runOfflineFold 按提示词长度计算（foldBudgetFor / maxTokensCap）" },
    notRun,
    limitations,
  });

  // 隐私自检：公开文档里不许出现任何私有串（只记条数；命中的原文只打到 stderr，不进产物）
  const needles = privacyNeedles(items);
  let privacy = privacyCheck(`${JSON.stringify(run)}\n${renderReport(run)}`, needles);
  run.privacy = { checked: true, needles: privacy.checked, violations: privacy.violations.length };
  if (privacy.violations.length > 0) {
    // 产物里仍只写条数：把命中串留在进程输出里，避免「为了报泄漏而泄漏」。
    run.privacy.violations = privacy.violations.length;
  }
  const finalRunJson = `${JSON.stringify(run, null, 2)}\n`;
  const finalReportText = renderReport(run);
  privacy = privacyCheck(`${finalRunJson}\n${finalReportText}`, needles);
  if (privacy.violations.length > 0) {
    run.privacy.violations = privacy.violations.length;
    const again = `${JSON.stringify(run, null, 2)}\n`;
    writeText(nodePath.join(out, "run.json"), again);
    writeText(nodePath.join(out, "REPORT.md"), renderReport(run));
  } else {
    writeText(nodePath.join(out, "run.json"), finalRunJson);
    writeText(nodePath.join(out, "REPORT.md"), finalReportText);
  }

  const parityViolations = run.totals.parityViolations;
  console.log(
    JSON.stringify(
      {
        status: run.status,
        out,
        items: run.totals.items,
        scored: run.totals.scored,
        notRun: run.totals.notRun,
        calls: run.totals.calls,
        parityViolations,
        privacyViolations: privacy.violations.length,
        usage: run.totals.usage,
      },
      null,
      2,
    ),
  );
  if (privacy.violations.length > 0) {
    console.error(`✗ 隐私自检命中 ${privacy.violations.length} 处`);
    return 1;
  }
  if (parityViolations > 0) {
    console.error(`✗ 两臂配对违规 ${parityViolations} 处`);
    return 1;
  }
  if (run.totals.notRun > 0 || items.length === 0) return 3;
  return 0;
}

export const USAGE = `用法：
  node scripts/axiom-shadow.mjs --home <DSH_HOME> --default-model <baseline/default-model.json> \\
    [--k26-manifest <K-26 私有 manifest.json>] [--k26-samples N] [--k2-sessions N] [--k27-questions N] \\
    [--only all|k26|k2|k27] [--max-calls N] [--out <dir>] [--live]

  默认（不带 --live）= 只写计划 plan.json，零模型调用、零写入 home。
  --live 才真的调用模型；模型**只能**来自 --default-model（拒绝 --model/--provider）。`;

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(String(error?.stack ?? error));
      process.exitCode = 1;
    });
}
