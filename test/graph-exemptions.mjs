/**
 * graph-exemptions.mjs —— 历史违规图的**显式豁免清单**（C-13，2026-10-30）
 *
 * ── 为什么需要这个文件 ──────────────────────────────────────────────
 *
 * `--strict` 在真实库上 15/122 红，类型只有三种：
 *
 *   13 张 edge-per-node > 8   ← 旧版 keeper 的节点冻结：tool 调用写边，但 agent 节点没跟着写，
 *                                E 涨 N 不涨。`to` 早就落定，**节点冻结不可逆**（重放节点会
 *                                改掉所有后续 tewari 结论），所以这些图**修不好**。
 *    2 张 self-loop/坍缩       ← 1.9.1 修复前的历史边，`from === to`。目标位置不可知，
 *                                **不可修**（只能整图清理，S1b 单独做）。
 *
 * 于是产生了死结：`--strict` 永远红 ⇒ 它不可能进提交门禁 ⇒ 门禁退化成一个没人看的开关。
 * 本清单**只解决这个死结**，回答一个很窄的问题：「这张图的这些违规，是登记在案的、
 * 由已知历史缺陷产生的、且此刻一字未变 —— 它不该把一个新写的坏图藏在后面」。
 *
 * ★ 这不是放宽阈值。阈值 8 / 0 / 0.05 一个都没动（`DEFAULT_LIMITS` 原样）。
 * ★ 这不是「未参与判定」。豁免是**豁免后**的结论，输出里必须逐条打印，
 *   且和「未参与 ≠ 通过」同原则：**豁免 ≠ 通过**。
 *
 * ── 三条硬性质（都有测试）──────────────────────────────────────────
 *
 *   1. **精确而非宽松**：一条豁免只吸收「同一个 session + 同一个判据代号 + 同一组数值」。
 *      同一张图的 ratio 从 10.5 涨到 10.6（又长了边）⇒ **仍然红**（数值三元组不匹配）。
 *      新增一条自环 ⇒ self-loop / collapsed-graph 没被登记 ⇒ **仍然红**。
 *   2. **清单不可静默修改**：`exemptions.json` 里每条都带 `fingerprint` —— 由该图的
 *      node/edge 全字段派生的 sha256。图内容变一个字符 ⇒ 指纹不匹配 ⇒ **不再豁免、判红**，
 *      并要求重新登记。这样「把一条边删掉让红线消失」和「台账里悄悄改一个数字」都会露馅。
 *   3. **可审计、可过期**：每条必须有 sessionId / 判据 / 数值 / 理由 / 登记人 / 日期 / 来源；
 *      `expiresOn`（默认 2027-06-30）到期后自动**失效**（恢复判红），提示重新评估；
 *      过期不是静默的 —— 输出里会打「已过期 N 条」。
 *
 * ── 已知局限（写清楚，不要假装没有）────────────────────────────────
 *
 *   · 指纹由**节点文本**参与派生。所以一张被豁免的历史图只要再次被 flush（节点文本变了），
 *     指纹就会失效、重新判红。这是**故意的**：本清单要证明的是「这张历史图冻结了」，
 *     它一旦又开始动，就不再是历史图，该重新评估。
 *   · 豁免是「按图 + 按判据」的，不是「按会话整体放行」：同一张图若同时有 ratio 和自环，
 *     只登记 ratio ⇒ 自环照样红（见测试 "部分豁免：只登记了比例，自环仍然红"）。
 */

import nodeCrypto from "node:crypto";

/** 清单文件格式版本。格式不兼容时必须报错，不能猜。 */
export const EXEMPTIONS_FORMAT = "dsh-gokifu-graph-exemptions";
export const EXEMPTIONS_VERSION = 1;

/** 默认有效期（到期自动失效，必须重新评估 —— 豁免不是永久免死金牌）。 */
export const DEFAULT_EXPIRES_ON = "2027-06-30";

/** 允许被豁免的判据代号：只接受 `graph-invariants.mjs` 里真实存在的四个。 */
export const EXEMPTIBLE_CODES = Object.freeze(["degenerate-graph", "self-loop", "edge-per-node", "collapsed-graph"]);

/** 每条豁免必须有的字段（缺一个 = 格式错误，直接报错，不做默认填充）。 */
export const REQUIRED_FIELDS = Object.freeze(["sessionId", "code", "E", "N", "L", "reason", "registeredBy", "registeredOn", "source", "fingerprint"]);

/* ─────────────────────── 规范序列化 / 指纹 ─────────────────────── */

/**
 * 规范 JSON：键按字典序、数组保序、`undefined` 视为缺省、数字必须是有限数。
 * 不依赖 `JSON.stringify` 的键序（它按插入序，跨 Node 版本/写回路径不可靠）。
 */
export function canonicalJson(value, depth = 0) {
  if (depth > 200) throw new Error("canonicalJson: 嵌套过深（可能是环引用）");
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (type === "boolean") return value ? "true" : "false";
  if (type === "undefined") return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (type === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k], depth + 1)}`).join(",")}}`;
  }
  return "null";
}

/**
 * 单图指纹：sha256( 规范化的 {nodes:[...], edges:[...]} )。
 *
 * 取哪些字段、为什么：
 *   · 节点：id / kind / seq / ts / text / turn / constraints（`text` 与 `constraints` 含**内容**，
 *     是「同一张图没被改写」的最强证据；不取 worldHash，因为它是派生值且历史数据里曾是对象）
 *   · 边：id / from / to / result / transposition / ts / action / intent / evidence / errorSnippet / verify
 *     其中 `evidence.{start,end}` 是消息区间 —— 真实边全都有，删边/挪边一定会让它变。
 * ⚠ 取的是**原始字段**而不是 `fromJSON()` 之后的形态：`fromJSON` 会重算 worldHash / stateIndex，
 *   那属于「派生数据修复」，不该让它把指纹搅乱。调用方传原始 JSON.parse 的对象即可。
 */
export function graphFingerprint(graph) {
  const nodes = Object.keys(graph?.nodes ?? {})
    .sort()
    .map((id) => {
      const n = graph.nodes[id] ?? {};
      return {
        id: n.id ?? id,
        kind: n.kind ?? null,
        seq: n.seq ?? null,
        ts: n.ts ?? null,
        text: n.text ?? null,
        turn: n.turn ?? null,
        constraints: Array.isArray(n.constraints) ? n.constraints : null,
      };
    });
  const edges = Object.keys(graph?.edges ?? {})
    .sort()
    .map((id) => {
      const e = graph.edges[id] ?? {};
      return {
        id: e.id ?? id,
        from: e.from ?? null,
        to: e.to ?? null,
        result: e.result ?? null,
        transposition: e.transposition === true,
        ts: e.ts ?? null,
        action: e.action ?? null,
        intent: e.intent ?? null,
        evidence: e.evidence ? { start: e.evidence.start ?? null, end: e.evidence.end ?? null } : null,
        errorSnippet: e.errorSnippet ?? null,
        verify: e.verify ? { kind: e.verify.kind ?? null, summary: e.verify.summary ?? null } : null,
      };
    });
  const payload = canonicalJson({ edges, nodes });
  return { sha256: nodeCrypto.createHash("sha256").update(payload, "utf8").digest("hex"), chars: payload.length };
}

/* ───────────────────────── 清单解析与校验 ───────────────────────── */

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

/** 环形图上限：历史图最多 120 节点，给 8× 余量。超过 = 数据异常，不是合法豁免。 */
const MAX_PLAUSIBLE_NODES = 1000;
const MAX_PLAUSIBLE_EDGES = 20000;

/**
 * 校验一条豁免。**返回错误数组（空 = 合法）**，不抛错 —— 调用方决定是硬失败还是收集。
 * 严格到「多一个数字都不放过」，因为豁免是本仓库唯一允许「红线被合法吸收」的地方。
 */
export function validateEntry(entry, { index = null, knownSessions = null } = {}) {
  const errors = [];
  const where = index === null ? "条目" : `第 ${index + 1} 条`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return [`${where} 必须是对象，实际 ${Array.isArray(entry) ? "数组" : typeof entry}`];
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in entry)) errors.push(`${where} 缺字段 ${field}`);
  }
  if (isNonEmptyString(entry.sessionId) === false) errors.push(`${where}.sessionId 必须是非空字符串`);
  if (!EXEMPTIBLE_CODES.includes(entry.code)) {
    errors.push(`${where}.code 必须是 ${EXEMPTIBLE_CODES.join(" / ")} 之一，收到 ${JSON.stringify(entry.code)}`);
  }
  for (const metric of ["E", "N", "L"]) {
    const v = entry[metric];
    if (!Number.isInteger(v) || v < 0) errors.push(`${where}.${metric} 必须是 ≥0 的整数，收到 ${JSON.stringify(v)}`);
  }
  if (Number.isInteger(entry.N) && entry.N > MAX_PLAUSIBLE_NODES) errors.push(`${where}.N=${entry.N} 超出可信上限 ${MAX_PLAUSIBLE_NODES}`);
  if (Number.isInteger(entry.E) && entry.E > MAX_PLAUSIBLE_EDGES) errors.push(`${where}.E=${entry.E} 超出可信上限 ${MAX_PLAUSIBLE_EDGES}`);
  for (const field of ["reason", "registeredBy", "source"]) {
    if (isNonEmptyString(entry[field]) === false) errors.push(`${where}.${field} 必须是非空字符串（豁免必须能解释自己从哪来）`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(entry.registeredOn ?? ""))) {
    errors.push(`${where}.registeredOn 必须是 YYYY-MM-DD，收到 ${JSON.stringify(entry.registeredOn)}`);
  }
  if ("expiresOn" in entry && !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.expiresOn))) {
    errors.push(`${where}.expiresOn 必须是 YYYY-MM-DD，收到 ${JSON.stringify(entry.expiresOn)}`);
  }
  if (typeof entry.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(entry.fingerprint)) {
    errors.push(`${where}.fingerprint 必须是 64 位小写 hex sha256，收到 ${JSON.stringify(entry.fingerprint)}`);
  }
  // 自环豁免必须真带自环，比例豁免必须真超比 —— 否则这条豁免毫无意义（说明登记错了）。
  if (entry.code === "self-loop" || entry.code === "collapsed-graph") {
    if (Number.isInteger(entry.L) && entry.L <= 0) errors.push(`${where} 登记了 ${entry.code} 但 L=${entry.L}（没有自环就无从豁免）`);
  }
  if (entry.code === "edge-per-node" && Number.isFinite(entry.N) && entry.N <= 0) {
    errors.push(`${where} 登记了 edge-per-node 但 N=${entry.N}（分母为 0 时比率不是超阈而是退化图）`);
  }
  // 已知会话集（真实库扫描时传进来）：登记了一个库里根本没有的会话 id = 拷贝粘贴错误。
  if (knownSessions && isNonEmptyString(entry.sessionId) && !knownSessions.has(entry.sessionId)) {
    errors.push(`${where}.sessionId=${entry.sessionId} 不在本次扫描的图里（可能是笔误，或图已被删/移）`);
  }
  return errors;
}

/**
 * 解析清单文本。**任何格式问题都报错**（不忽略、不跳过）—— 一份读不懂的清单如果被当成
 * 「空清单」，就等于静默取消了所有豁免；反过来若被当成「全放行」，红线就没了。
 *
 * @param {string} text 文件内容
 * @returns {{ok:boolean, errors:string[], entries:object[], meta:{format:string,version:number,updatedOn:string|null}}}
 */
export function parseExemptions(text) {
  const errors = [];
  const entries = [];
  const meta = { format: "", version: 0, updatedOn: null };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`清单不是合法 JSON：${String(error.message ?? error)}`], entries, meta };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, errors: ["清单根必须是对象 {format,version,updatedOn,exemptions[]}"], entries, meta };
  }
  meta.format = doc.format ?? "";
  meta.version = doc.version ?? 0;
  meta.updatedOn = doc.updatedOn ?? null;
  if (doc.format !== EXEMPTIONS_FORMAT) {
    errors.push(`清单 format 必须是 ${JSON.stringify(EXEMPTIONS_FORMAT)}，收到 ${JSON.stringify(doc.format)}`);
  }
  if (doc.version !== EXEMPTIONS_VERSION) {
    errors.push(`清单 version 必须是 ${EXEMPTIONS_VERSION}，收到 ${JSON.stringify(doc.version)}`);
  }
  if (doc.updatedOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(doc.updatedOn))) {
    errors.push(`清单 updatedOn 必须是 YYYY-MM-DD，收到 ${JSON.stringify(doc.updatedOn)}`);
  }
  if (!Array.isArray(doc.exemptions)) {
    errors.push(`清单 exemptions 必须是数组，收到 ${doc.exemptions === undefined ? "undefined" : typeof doc.exemptions}`);
    return { ok: false, errors, entries, meta };
  }
  for (let i = 0; i < doc.exemptions.length; i += 1) {
    const entry = doc.exemptions[i];
    const entryErrors = validateEntry(entry, { index: i });
    if (entryErrors.length > 0) {
      errors.push(...entryErrors);
      continue;
    }
    entries.push(entry);
  }
  // 同一 (sessionId, code) 只能登记一次 —— 重复登记说明有人在互相覆盖，必须人工看清。
  const seen = new Map();
  for (const entry of entries) {
    const key = `${entry.sessionId}::${entry.code}`;
    if (seen.has(key)) errors.push(`清单里有重复登记：${key}（第 ${seen.get(key) + 1} 条与后面一条冲突）`);
    else seen.set(key, entries.indexOf(entry));
  }
  return { ok: errors.length === 0, errors, entries, meta };
}

/* ───────────────────────── 判定：豁免是否命中 ───────────────────────── */

/**
 * 判断「这条违规」是否被某条登记豁免合法吸收。四条**全部**满足才算命中：
 *   ① sessionId 相同
 *   ② 判据代号相同
 *   ③ E / N / L 三元组与登记值**逐值相同**
 *      （同一张图继续长边 ⇒ E 变 ⇒ 不命中 ⇒ 红。这是 C-13 的核心：豁免冻结的是**数值**，不是会话）
 *   ④ 该图当前指纹与登记指纹相同（图内容一字未改）
 *
 * @param {object} entry 已通过 validateEntry 的登记项
 * @param {{sessionId:string, code:string, E:number, N:number, L:number, fingerprint:string}} actual
 * @returns {{match:boolean, reasons:string[]}} 不匹配的原因（用于输出，便于审计）
 */
export function matchEntry(entry, actual) {
  const reasons = [];
  if (entry.sessionId !== actual.sessionId) reasons.push(`sessionId 不同（${entry.sessionId} ≠ ${actual.sessionId}）`);
  if (entry.code !== actual.code) reasons.push(`判据不同（${entry.code} ≠ ${actual.code}）`);
  for (const metric of ["E", "N", "L"]) {
    if (entry[metric] !== actual[metric]) reasons.push(`${metric} 已变化（登记 ${entry[metric]} → 现在 ${actual[metric]}）`);
  }
  if (entry.fingerprint !== actual.fingerprint) reasons.push("图内容已变（指纹不匹配，需重新登记）");
  return { match: reasons.length === 0, reasons };
}

/**
 * 单条违规是否「被豁免」。返回命中条目或 null（未命中必须带上原因，供输出解释）。
 *
 * @param {{sessionId:string, code:string, E:number, N:number, L:number, fingerprint:string}} actual
 * @param {object} manifest parseExemptions() 的结果
 * @param {{today?:string}} [opts] 用 `today` 传入「今天」（YYYY-MM-DD），便于测试过期逻辑
 */
export function findExemption(actual, manifest, { today = todayIso() } = {}) {
  const entries = Array.isArray(manifest) ? manifest : manifest?.entries ?? [];
  let best = null;
  for (const entry of entries) {
    if (entry.sessionId !== actual.sessionId || entry.code !== actual.code) continue;
    const { match, reasons } = matchEntry(entry, actual);
    if (match) {
      const expired = isExpired(entry, today);
      if (expired) {
        best = best ?? { entry, expired: true, reasons: [`豁免已于 ${entry.expiresOn ?? DEFAULT_EXPIRES_ON} 过期`] };
        continue;
      }
      return { entry, expired: false, reasons: [] };
    }
    best = best ?? { entry, expired: false, reasons };
  }
  return best ? { entry: null, expired: best.expired, reasons: best.reasons, candidate: best.entry } : { entry: null, expired: false, reasons: ["清单里没有这张图的这条判据"] };
}

/** 今天（本地日期）YYYY-MM-DD。抽成函数便于测试固定「今天」。 */
export function todayIso() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 到期日当天**仍然有效**（含当日），次日起失效。日期字符串可直接字典序比较（同 YYYY-MM-DD）。 */
export function isExpired(entry, today = todayIso()) {
  const expires = entry?.expiresOn ?? DEFAULT_EXPIRES_ON;
  return String(today) > String(expires);
}

/* ───────────────────── 把豁免应用到 checkGraphs 的结果 ───────────────────── */

/**
 * 对 `checkGraphs()` 的输出逐条违规套豁免。**纯函数**：不读盘、不改入参。
 *
 * 关键语义（别把它做成「放水」）：
 *   · 一条违规被豁免时，它**从 violations 里移除**（因此 ok 可能变 true），
 *     但同时**出现在 exempted 里**并带上登记理由 —— 「豁免 ≠ 通过」在数据层也成立。
 *   · 只要还剩**任何**未被豁免的违规，该图 `ok` 仍为 false。
 *   · `metrics` 原样保留（豁免的是判定，不是事实：读数照旧）。
 *   · 过期条目不会被当作命中（`findExemption` 处理），且会出现在 `expired` 里。
 *
 * @param {{ok:boolean, graphs:object[], failed:object[], checked:number, limits:object}} gate checkGraphs() 结果
 * @param {object} manifest parseExemptions() 结果
 * @param {{fingerprints?:Record<string,string>, today?:string}} opts 每图（按 session）的指纹
 * @returns {{ok:boolean, checked:number, failed:object[], graphs:object[], exempted:object[], expired:object[], missed:object[]}}
 */
export function applyExemptions(gate, manifest, { fingerprints = {}, today = todayIso() } = {}) {
  const exempted = [];
  const expired = [];
  const missed = [];
  const graphs = gate.graphs.map((item) => {
    const fingerprint = fingerprints[item.session] ?? "";
    const kept = [];
    const excused = [];
    for (const violation of item.violations) {
      const actual = {
        sessionId: item.sessionId,
        code: violation.code,
        E: item.metrics.edges,
        N: item.metrics.nodes,
        L: item.metrics.selfLoops,
        fingerprint,
      };
      const found = findExemption(actual, manifest, { today });
      if (found.entry) {
        excused.push({ code: violation.code, message: violation.message, value: violation.value, limit: violation.limit, entry: found.entry });
        exempted.push({
          session: item.session,
          sessionId: item.sessionId,
          code: violation.code,
          value: violation.value,
          // 登记的 E/N/L 全量带上：审计方要能自己复算「登记值 vs 现在值」是否真的相同
          registeredE: found.entry.E,
          registeredN: found.entry.N,
          registeredL: found.entry.L,
          registeredValue: found.entry.code === "edge-per-node" ? Number((found.entry.E / found.entry.N).toFixed(2)) : found.entry.L,
          reason: found.entry.reason,
          registeredBy: found.entry.registeredBy,
          registeredOn: found.entry.registeredOn,
          source: found.entry.source,
          expiresOn: found.entry.expiresOn ?? DEFAULT_EXPIRES_ON,
        });
        continue;
      }
      kept.push(violation);
      if (found.expired) {
        expired.push({ session: item.session, sessionId: item.sessionId, code: violation.code, entry: found.candidate, reasons: found.reasons });
      } else {
        missed.push({ session: item.session, sessionId: item.sessionId, code: violation.code, reasons: found.reasons });
      }
    }
    return { ...item, ok: kept.length === 0, violations: kept, exempted: excused, exemptedCount: excused.length };
  });
  const failed = graphs.filter((x) => !x.ok);
  return { ok: failed.length === 0, limits: gate.limits, checked: gate.checked, graphs, failed, exempted, expired, missed };
}
