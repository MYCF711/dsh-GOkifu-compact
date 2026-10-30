/**
 * config-schema —— 配置的**单一来源**（R15，A2-4，2026-10-30）
 *
 * 背景：同一份配置在 5 个地方各写一遍（`engine.mjs` 的 `Config` 23 键 / `resolveChess()` 20 键 /
 * `ui.mjs` 的 `DEFAULTS` 16 键 + 范围 + 枚举 + 中文名 / `lib/client.js` 的 `FIELDS` 15 键 /
 * `install.mjs` 的 `engineBlock()` 15 键）。它们已经漂移过：`maxTokens` 曾同时是
 * 4096 / 2048 / 8192，`retainRatio >= thresholdRatio` 的修正只在两处里的一处生效。
 *
 * 本房间是**唯一真值**：
 *   · `SCHEMA` 23 行（key / type / default / where / range / values / label / desc）
 *   · `PRESET_KEYS` 16（含顺序 —— `engineBlock()` 的模板顺序必须与它一致，`test/config-schema` 钉住）
 *   · `BASE_KEYS` 11（透传给官方基类的那批同名键）
 *   · `configDefaults()` / `fieldLabels()` / `describe(key)` —— 派生只读表
 *   · `resolveConfig(raw)` —— 引擎侧「原始配置 → 生效配置」（含净化与 `retainRatio` 修正）
 *   · `describeConfig(preset)` / `validatePatch(patch)` —— UI 侧「文件里写了什么 → 生效什么」与
 *     「页面提交的 patch → 规整后的 patch」（中文文案原样保留）
 *
 * 纪律（A2-4）：**零行为**。默认值、范围、枚举、文案、返回形状一个都不许变；
 * `retainTokens` 的默认值必须是 `undefined`（写成 0 会让 `resolveSpec` 走「绝对 token」分支）。
 *
 * 依赖：**零依赖**（不 import 任何东西）—— 它同时被 R09（engine）、R11（ui）、R13（install）消费。
 */

/** 23 行唯一真值。顺序 = 官方基类键在前、棋谱扩展在后（与 `engine.mjs` 今天的字段顺序一致）。 */
export const SCHEMA = Object.freeze([
  // —— 与官方后端同名（语义一致，默认值不同）——
  {
    key: "thresholdRatio",
    type: "number",
    default: 0.45,
    where: "preset",
    range: [0.05, 0.95],
    label: "触发阈值（占窗口）",
    desc: "窗口占比：压力超过 min(窗口×该值, 窗口−输出预留−余量) 才 fold",
  },
  {
    key: "headroomTokens",
    type: "number",
    default: 65536,
    where: "preset",
    range: [0, 512000],
    label: "压力余量（tokens）",
    desc: "路由输出预留之外的额外压力余量",
  },
  { key: "retainRatio", type: "number", default: 0.16, where: "preset", range: [0, 0.9], label: "逐字保留尾部", desc: "逐字保留的近期尾部（占 窗口−输出预留 的比例）" },
  { key: "retainTokens", type: "number", default: undefined, where: "engine", range: [0, Infinity], desc: "逐字保留的近期尾部（绝对 token）；与 retainRatio 互斥" },
  { key: "summarizationProvider", type: "string", default: "", where: "preset", label: "摘要 provider", desc: "摘要模型 provider；留空=跟随最近一次路由" },
  { key: "summarizationModel", type: "string", default: "", where: "preset", label: "摘要 model", desc: "摘要模型 model；留空=跟随最近一次路由" },
  { key: "maxTokens", type: "number", default: 8192, where: "preset", range: [256, 65536], label: "摘要输出上限（tokens）", desc: "摘要输出上限（注意：不在 preset 模板里，今天的 engineBlock 不含它）" },
  { key: "compactionRetries", type: "number", default: 1, where: "engine", desc: "" },
  { key: "maxOverflowRetries", type: "number", default: 1, where: "engine", desc: "" },
  { key: "modelPolicies", type: "array", default: [], where: "engine", desc: "" },
  { key: "auto", type: "boolean", default: true, where: "preset", label: "自动压缩", desc: "自动压缩（between-step 压力触发）" },

  // —— 棋谱扩展 ——
  { key: "summaryMode", type: "enum", values: ["hybrid", "rules", "llm"], default: "hybrid", where: "preset", label: "摘要方式", desc: "hybrid=规则事实+模型润色；rules=零模型调用；llm=完全交给模型" },
  {
    key: "growthFloorTokens",
    type: "number",
    default: 40000,
    where: "preset",
    range: [0, 1000000],
    label: "增长闸（tokens）",
    desc: "距上次 fold 至少新增这么多 token 才再次 fold（0=关闭增长门控）",
  },
  { key: "minFoldTokens", type: "number", default: 8000, where: "preset", range: [0, 1000000], label: "最小 fold 量（tokens）", desc: "被遮蔽内容少于这么多 token 就不 fold（摘要本身要花钱）" },
  { key: "hotLedger", type: "boolean", default: true, where: "preset", label: "热清单", desc: "每轮注入失败清单（热上下文）" },
  { key: "hotLedgerMaxTokens", type: "number", default: 500, where: "preset", range: [0, 20000], label: "热清单预算（tokens）", desc: "失败清单的 token 上限" },
  {
    key: "hotLedgerMarkers",
    type: "enum",
    values: ["semantic", "terse", "off"],
    default: "semantic",
    where: "preset",
    label: "清单标记档位",
    desc: "失败边标记档位：semantic=带语义（blocked:permission）+动态图例；terse=只写三态；off=不打标记",
  },
  {
    key: "hotLedgerTraceRoot",
    type: "string",
    default: "sessions",
    where: "engine",
    desc: "TRACE 行相对路径的根前缀（默认 sessions ⇒ `sessions/<sid>/index.md`；空串 = 只写 `<sid>/index.md`）",
  },
  { key: "hotLedgerReplace", type: "boolean", default: true, where: "preset", label: "就地替换旧清单", desc: "热清单就地替换 surface 上的旧节点（surface 永远只有一条）；false=退回追加（长会话会累积）" },
  { key: "transposition", type: "boolean", default: true, where: "preset", label: "置换检测", desc: "置换检测：同一状态再次到达时不新建节点" },
  { key: "tier2After", type: "number", default: 8, where: "preset", range: [0, 100], label: "checkpoint 合并阈值", desc: "checkpoint 超过这么多时合并最老的两段（tier-2）" },
  { key: "graphDir", type: "string", default: "", where: "engine", desc: "棋谱落盘目录；留空 = <DSH_HOME>/chess-context" },
  { key: "worldHashMaxFiles", type: "number", default: 200, where: "engine", desc: "世界状态哈希最多 stat 多少个文件" },
]);

const BY_KEY = new Map(SCHEMA.map((entry) => [entry.key, entry]));

/** preset 里允许出现的 16 个键（**顺序即 `engineBlock()` 的模板顺序**，`maxTokens` 今天不在模板里）。 */
export const PRESET_KEYS = Object.freeze([
  "auto",
  "thresholdRatio",
  "headroomTokens",
  "retainRatio",
  "growthFloorTokens",
  "minFoldTokens",
  "summaryMode",
  "maxTokens",
  "summarizationProvider",
  "summarizationModel",
  "hotLedger",
  "hotLedgerMaxTokens",
  "hotLedgerMarkers",
  "hotLedgerReplace",
  "transposition",
  "tier2After",
]);

/** 透传给官方基类的 11 个同名键。 */
export const BASE_KEYS = Object.freeze([
  "thresholdRatio",
  "headroomTokens",
  "retainRatio",
  "retainTokens",
  "summarizationProvider",
  "summarizationModel",
  "maxTokens",
  "compactionRetries",
  "maxOverflowRetries",
  "modelPolicies",
  "auto",
]);

/** 单键描述（找不到返回 null）。 */
export function describe(key) {
  return BY_KEY.get(key) ?? null;
}

/** preset 可编辑键的默认值（UI 的 `DEFAULTS`；键序与 A2-4 之前逐键相同）。 */
export function configDefaults() {
  const out = {};
  for (const key of PRESET_KEYS) out[key] = describe(key).default;
  return out;
}

/** 中文名的展示顺序（与 A2-4 之前 ui.mjs 的 FIELD_LABELS 逐键同序）。 */
const LABEL_ORDER = Object.freeze([
  "auto",
  "thresholdRatio",
  "headroomTokens",
  "retainRatio",
  "growthFloorTokens",
  "minFoldTokens",
  "summaryMode",
  "maxTokens",
  "hotLedger",
  "hotLedgerMaxTokens",
  "hotLedgerReplace",
  "hotLedgerMarkers",
  "transposition",
  "tier2After",
  "summarizationProvider",
  "summarizationModel",
]);

/** preset 可编辑键的中文名（UI 的 `FIELD_LABELS`）。 */
export function fieldLabels() {
  const out = {};
  for (const key of LABEL_ORDER) out[key] = describe(key).label;
  return out;
}

/* ───────────────────────────── 引擎侧 ───────────────────────────── */

function num(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function str(value, fallback) {
  return typeof value === "string" ? value : fallback;
}
function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 「原始配置 → 引擎生效配置」。
 *
 * 语义与 A2-4 之前的 `engine.mjs:resolveChess()` **逐键相同**：
 *   · 数字键：非有限数字 ⇒ 默认值；
 *   · 字符串键：非字符串 ⇒ 默认值；
 *   · 枚举键：不在枚举里 ⇒ 默认值；
 *   · 布尔键：`!== false` 语义（不是严格 boolean）；
 *   · `retainTokens`：**没有默认** —— 未提供就是 `undefined`（不是 0）；
 *   · 末尾修正：`retainRatio >= thresholdRatio` ⇒ 压到 `max(0.05, thresholdRatio − 0.05)`。
 *
 * @param {Record<string, any>} raw
 * @returns {Record<string, any>} 19 个键（不含 `onLedgerBudget` —— 那是 engine 的注入位）
 */
export function resolveConfig(raw = {}) {
  const c = raw ?? {};
  const out = {
    summaryMode: describe("summaryMode").values.includes(c.summaryMode) ? c.summaryMode : describe("summaryMode").default,
    thresholdRatio: num(c.thresholdRatio, describe("thresholdRatio").default),
    headroomTokens: num(c.headroomTokens, describe("headroomTokens").default),
    retainRatio: num(c.retainRatio, describe("retainRatio").default),
    retainTokens: numberOrUndefined(c.retainTokens),
    summarizationProvider: str(c.summarizationProvider, describe("summarizationProvider").default),
    summarizationModel: str(c.summarizationModel, describe("summarizationModel").default),
    maxTokens: num(c.maxTokens, describe("maxTokens").default),
    growthFloorTokens: num(c.growthFloorTokens, describe("growthFloorTokens").default),
    minFoldTokens: num(c.minFoldTokens, describe("minFoldTokens").default),
    hotLedger: c.hotLedger !== false,
    hotLedgerMaxTokens: num(c.hotLedgerMaxTokens, describe("hotLedgerMaxTokens").default),
    hotLedgerMarkers: describe("hotLedgerMarkers").values.includes(c.hotLedgerMarkers) ? c.hotLedgerMarkers : describe("hotLedgerMarkers").default,
    hotLedgerTraceRoot: str(c.hotLedgerTraceRoot, describe("hotLedgerTraceRoot").default),
    hotLedgerReplace: c.hotLedgerReplace !== false,
    transposition: c.transposition !== false,
    tier2After: num(c.tier2After, describe("tier2After").default),
    graphDir: str(c.graphDir, describe("graphDir").default),
    worldHashMaxFiles: num(c.worldHashMaxFiles, describe("worldHashMaxFiles").default),
  };
  // 与 A2-4 之前 engine.mjs 的结尾修正逐字相同：保留尾部不得 ≥ 触发阈值。
  if (out.retainRatio >= out.thresholdRatio) out.retainRatio = Math.max(0.05, out.thresholdRatio - 0.05);
  return out;
}

/* ───────────────────────────── UI 侧 ───────────────────────────── */

const label = (key) => describe(key)?.label ?? key;

/**
 * 「preset 里写了什么 → 引擎实际生效什么」+ 逐键来源（default / preset / sanitized / adjusted）。
 *
 * 与 A2-4 之前 `ui.mjs:describeConfig()` **逐键相同**（注意：数字键只判「是不是有限数字」，
 * **不判范围** —— 范围只用于页面提交校验，这是既有行为，本刀不改）。
 */
export function describeConfig(presetConfig = {}) {
  const src = presetConfig ?? {};
  const defaults = configDefaults();
  const effective = {};
  const origins = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const entry = describe(key);
    const raw = src[key];
    if (raw === undefined) {
      effective[key] = fallback;
      origins[key] = "default";
      continue;
    }
    let valid = true;
    if (entry.type === "number") valid = typeof raw === "number" && Number.isFinite(raw);
    else if (entry.type === "enum") valid = entry.values.includes(raw);
    else if (entry.type === "boolean") valid = typeof raw === "boolean";
    else valid = typeof raw === "string";
    effective[key] = valid ? raw : fallback;
    origins[key] = valid ? "preset" : "sanitized";
  }
  if (typeof effective.retainRatio === "number" && typeof effective.thresholdRatio === "number" && effective.retainRatio >= effective.thresholdRatio) {
    effective.retainRatio = Math.max(0.05, effective.thresholdRatio - 0.05);
    origins.retainRatio = "adjusted";
  }
  const unconfiguredKeys = Object.keys(defaults)
    .filter((key) => src[key] === undefined)
    .sort();
  return { effective, origins, unconfiguredKeys };
}

/**
 * 校验并规整页面提交的 patch（A2-4 之前叫 `ui.mjs:sanitizePatch()`，语义与文案逐字相同）。
 *
 * 两条硬规则：数字空串 ≠ 0；白名单外的键收集到 `skipped`（不静默丢由路由的 400 保证）。
 *
 * @returns {{patch: Record<string, any>, skipped: string[]}}
 */
export function validatePatch(patch = {}) {
  const editable = new Set(Object.keys(configDefaults()));
  const out = {};
  const skipped = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!editable.has(key)) {
      skipped.push(key);
      continue;
    }
    const entry = describe(key);
    if (entry.type === "number" && entry.range) {
      const raw = typeof value === "string" ? value.trim() : value;
      if (raw === null || raw === undefined || raw === "") throw new Error(`${label(key)} 不能为空`);
      let n;
      if (typeof raw === "number") n = raw;
      else if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw)) n = Number(raw);
      else throw new Error(`${label(key)} 必须是数字（收到 ${JSON.stringify(value)}）`);
      if (!Number.isFinite(n)) throw new Error(`${label(key)} 必须是有限数字`);
      const [min, max] = entry.range;
      if (n < min || n > max) throw new Error(`${label(key)} 超出范围 [${min}, ${max}]（收到 ${n}）`);
      out[key] = key === "thresholdRatio" || key === "retainRatio" ? Math.round(n * 1000) / 1000 : Math.round(n);
      continue;
    }
    if (entry.type === "enum") {
      if (!entry.values.includes(value)) throw new Error(`${label(key)} 必须是 ${entry.values.join(" | ")}`);
      out[key] = value;
      continue;
    }
    if (entry.type === "boolean") {
      if (typeof value === "boolean") out[key] = value;
      else if (value === "true" || value === "false") out[key] = value === "true";
      else throw new Error(`${label(key)} 必须是 true / false（收到 ${JSON.stringify(value)}）`);
      continue;
    }
    out[key] = String(value ?? "");
  }
  return { patch: out, skipped };
}
