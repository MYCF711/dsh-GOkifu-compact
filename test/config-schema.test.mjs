/**
 * config-schema.test.mjs —— R15 单一来源的门禁（A2-4，2026-10-30）
 *
 * 这个文件是「配置只有一份真值」的机器判据。它钉住四件事：
 *   ① SCHEMA 的 23 行（键 / 类型 / 默认值 / 归属 / 范围 / 枚举）—— 逐键 golden；
 *   ② 从 SCHEMA 派生的只读表（DEFAULTS / FIELD_LABELS / PRESET_KEYS / BASE_KEYS）；
 *   ③ 引擎侧 `resolveConfig` 与 UI 侧 `describeConfig` / `validatePatch` 的**逐字节输出**
 *      （golden 是 A2-4 之前的老实现跑出来的字面量，改默认值/净化语义必须让它红）；
 *   ④ 消费者真的在用它：`engine.mjs` 的 Config 由 SCHEMA 生成、`ui.mjs` 只做委托、
 *      `engineBlock()` 的 15 行与 PRESET_KEYS 同序同值。
 *
 * 变异自检口径：改 `SCHEMA` 里任一 default / range / values ⇒ 本文件必红。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const ROOM = pathToFileURL(nodePath.join(ROOT, "src", "rooms", "config-schema.mjs")).href;
const PRESET_FORMAT = pathToFileURL(nodePath.join(ROOT, "src", "rooms", "preset-format.mjs")).href;

const { SCHEMA, PRESET_KEYS, BASE_KEYS, describe, configDefaults, fieldLabels, resolveConfig, describeConfig, validatePatch } = await import(ROOM);

/* ───────────────────────── golden（A2-4 之前的实测输出） ───────────────────────── */

const GOLDEN_KEYS = ["thresholdRatio", "headroomTokens", "retainRatio", "retainTokens", "summarizationProvider", "summarizationModel", "maxTokens", "compactionRetries", "maxOverflowRetries", "modelPolicies", "auto", "summaryMode", "growthFloorTokens", "minFoldTokens", "hotLedger", "hotLedgerMaxTokens", "hotLedgerMarkers", "hotLedgerTraceRoot", "hotLedgerReplace", "transposition", "tier2After", "graphDir", "worldHashMaxFiles"];

const GOLDEN_PRESET_KEYS = ["auto", "thresholdRatio", "headroomTokens", "retainRatio", "growthFloorTokens", "minFoldTokens", "summaryMode", "maxTokens", "summarizationProvider", "summarizationModel", "hotLedger", "hotLedgerMaxTokens", "hotLedgerMarkers", "hotLedgerReplace", "transposition", "tier2After"];

const GOLDEN_BASE_KEYS = ["thresholdRatio", "headroomTokens", "retainRatio", "retainTokens", "summarizationProvider", "summarizationModel", "maxTokens", "compactionRetries", "maxOverflowRetries", "modelPolicies", "auto"];

const GOLDEN_DEFAULTS = { auto: true, thresholdRatio: 0.45, headroomTokens: 65536, retainRatio: 0.16, growthFloorTokens: 40000, minFoldTokens: 8000, summaryMode: "hybrid", maxTokens: 8192, summarizationProvider: "", summarizationModel: "", hotLedger: true, hotLedgerMaxTokens: 500, hotLedgerMarkers: "semantic", hotLedgerReplace: true, transposition: true, tier2After: 8 };

const GOLDEN_LABELS = { auto: "自动压缩", thresholdRatio: "触发阈值（占窗口）", headroomTokens: "压力余量（tokens）", retainRatio: "逐字保留尾部", growthFloorTokens: "增长闸（tokens）", minFoldTokens: "最小 fold 量（tokens）", summaryMode: "摘要方式", maxTokens: "摘要输出上限（tokens）", hotLedger: "热清单", hotLedgerMaxTokens: "热清单预算（tokens）", hotLedgerReplace: "就地替换旧清单", hotLedgerMarkers: "清单标记档位", transposition: "置换检测", tier2After: "checkpoint 合并阈值", summarizationProvider: "摘要 provider", summarizationModel: "摘要 model" };

const GOLDEN_RESOLVE_EMPTY = { summaryMode: "hybrid", thresholdRatio: 0.45, headroomTokens: 65536, retainRatio: 0.16, summarizationProvider: "", summarizationModel: "", maxTokens: 8192, growthFloorTokens: 40000, minFoldTokens: 8000, hotLedger: true, hotLedgerMaxTokens: 500, hotLedgerMarkers: "semantic", hotLedgerTraceRoot: "sessions", hotLedgerReplace: true, transposition: true, tier2After: 8, graphDir: "", worldHashMaxFiles: 200 };

const GOLDEN_DESCRIBE = { effective: { auto: false, thresholdRatio: 0.5, headroomTokens: 65536, retainRatio: 0.45, growthFloorTokens: 40000, minFoldTokens: 8000, summaryMode: "hybrid", maxTokens: 8192, summarizationProvider: "", summarizationModel: "", hotLedger: true, hotLedgerMaxTokens: 500, hotLedgerMarkers: "terse", hotLedgerReplace: true, transposition: true, tier2After: 8 }, origins: { auto: "preset", thresholdRatio: "preset", headroomTokens: "default", retainRatio: "adjusted", growthFloorTokens: "default", minFoldTokens: "default", summaryMode: "default", maxTokens: "default", summarizationProvider: "default", summarizationModel: "default", hotLedger: "default", hotLedgerMaxTokens: "default", hotLedgerMarkers: "preset", hotLedgerReplace: "default", transposition: "default", tier2After: "default" }, unconfiguredKeys: ["growthFloorTokens", "headroomTokens", "hotLedger", "hotLedgerMaxTokens", "hotLedgerReplace", "maxTokens", "minFoldTokens", "summarizationModel", "summarizationProvider", "summaryMode", "tier2After", "transposition"] };

const RANGES = { thresholdRatio: [0.05, 0.95], headroomTokens: [0, 512000], retainRatio: [0, 0.9], growthFloorTokens: [0, 1000000], minFoldTokens: [0, 1000000], maxTokens: [256, 65536], hotLedgerMaxTokens: [0, 20000], tier2After: [0, 100] };
const ENUMS = { summaryMode: ["hybrid", "rules", "llm"], hotLedgerMarkers: ["semantic", "terse", "off"] };

/* ───────────────────────────── 用例 ───────────────────────────── */

export const tests = {
  "SCHEMA：23 行、键集合与顺序逐键一致"(t) {
    t.eq(SCHEMA.length, 23, "SCHEMA 行数");
    t.eq(SCHEMA.map((e) => e.key), GOLDEN_KEYS, "键与顺序");
  },

  "SCHEMA 逐键：类型 / 默认值 / 归属 / 范围 / 枚举 / 中文名"(t) {
    for (const key of GOLDEN_KEYS) {
      const entry = describe(key);
      t.ok(entry !== null, `${key} 必须在 SCHEMA 里`);
      if (!entry) continue;
      t.eq(entry.where === "preset" || entry.where === "engine", true, `${key}.where 只能是 preset/engine`);
      if (key === "retainTokens") {
        t.eq(entry.default, undefined, "retainTokens 默认必须是 undefined（写成 0 会走绝对 token 分支）");
      } else if (GOLDEN_DEFAULTS[key] !== undefined) {
        t.eq(entry.default, GOLDEN_DEFAULTS[key], `${key} 默认值`);
      }
      if (RANGES[key]) t.eq(entry.range, RANGES[key], `${key} 范围`);
      if (ENUMS[key]) t.eq(entry.values, ENUMS[key], `${key} 枚举`);
      if (GOLDEN_LABELS[key]) t.eq(entry.label, GOLDEN_LABELS[key], `${key} 中文名`);
    }
    t.eq(describe("no-such-key"), null, "未知键返回 null");
  },

  "PRESET_KEYS 16 / BASE_KEYS 11：顺序与集合"(t) {
    t.eq([...PRESET_KEYS], GOLDEN_PRESET_KEYS, "PRESET_KEYS 顺序");
    t.eq([...BASE_KEYS], GOLDEN_BASE_KEYS, "BASE_KEYS 顺序");
    const derived = SCHEMA.filter((e) => e.where === "preset").map((e) => e.key).sort();
    t.eq([...PRESET_KEYS].sort(), derived, "PRESET_KEYS 与 SCHEMA 的 preset 集一致");
  },

  "configDefaults：16 键逐键等于 A2-4 之前的 DEFAULTS"(t) {
    t.eq(configDefaults(), GOLDEN_DEFAULTS, "golden");
    t.eq(Object.keys(configDefaults()), Object.keys(GOLDEN_DEFAULTS), "键序也必须一致（JSON.stringify 会被比对）");
  },

  "fieldLabels：16 键逐键等于 A2-4 之前的 FIELD_LABELS"(t) {
    t.eq(fieldLabels(), GOLDEN_LABELS, "golden");
    t.eq(Object.keys(fieldLabels()), Object.keys(GOLDEN_LABELS), "键序");
  },

  "resolveConfig：空输入 golden + retainTokens 的 undefined 语义"(t) {
    t.eq(resolveConfig({}), GOLDEN_RESOLVE_EMPTY, "空输入 golden");
    t.eq(resolveConfig({}).retainTokens, undefined, "未提供 retainTokens 时值必须是 undefined（不是 0）");
    t.eq(resolveConfig({ retainTokens: 0 }).retainTokens, 0, "提供 0 时必须保留 0");
    t.eq(resolveConfig({ retainTokens: "12" }).retainTokens, undefined, "字符串必须被净化成 undefined");
  },

  "resolveConfig：净化语义（非数字/非字符串/非法枚举）+ retainRatio 修正"(t) {
    const r = resolveConfig({ thresholdRatio: "0.5", maxTokens: 123.5, summaryMode: "bogus", hotLedgerMarkers: "nope", hotLedger: 0, transposition: null, hotLedgerTraceRoot: 5 });
    t.eq(r.thresholdRatio, 0.45, "数字键收到字符串 ⇒ 默认值");
    t.eq(r.maxTokens, 123.5, "有限数字原样保留（不做取整）");
    t.eq(r.summaryMode, "hybrid", "非法枚举 ⇒ 默认");
    t.eq(r.hotLedgerMarkers, "semantic", "非法枚举 ⇒ 默认");
    t.eq(r.hotLedger, true, "布尔键是 !== false 语义");
    t.eq(r.transposition, true, "null 也走 !== false ⇒ true");
    t.eq(r.hotLedgerTraceRoot, "sessions", "字符串键收到数字 ⇒ 默认");
    const adj = resolveConfig({ thresholdRatio: 0.5, retainRatio: 0.6 });
    t.eq(adj.retainRatio, 0.45, "retainRatio ≥ thresholdRatio ⇒ 压到 threshold−0.05");
    const floor = resolveConfig({ thresholdRatio: 0.05, retainRatio: 0.9 });
    t.eq(floor.retainRatio, 0.05, "压低不得低于 0.05");
  },

  "describeConfig：四来源（default/preset/sanitized/adjusted）golden"(t) {
    t.eq(describeConfig({ auto: false, thresholdRatio: 0.5, retainRatio: 0.6, hotLedgerMarkers: "terse" }), GOLDEN_DESCRIBE, "golden");
    const bad = describeConfig({ thresholdRatio: "0.5", summaryMode: "bogus", hotLedger: 0, summarizationProvider: 7 });
    t.eq(bad.origins.thresholdRatio, "sanitized", "字符串数字 ⇒ sanitized");
    t.eq(bad.origins.summaryMode, "sanitized", "非法枚举 ⇒ sanitized");
    t.eq(bad.origins.hotLedger, "sanitized", "非布尔 ⇒ sanitized");
    t.eq(bad.origins.summarizationProvider, "sanitized", "非字符串 ⇒ sanitized");
    t.eq(bad.effective.thresholdRatio, 0.45, "净化后回默认");
    t.eq(describeConfig({ growthFloorTokens: -1 }).origins.growthFloorTokens, "preset", "负数仍是 preset（范围只在提交校验里用）");
  },

  "validatePatch：空串≠0、非十进制拒、越界拒、枚举/布尔、未知键 skipped"(t) {
    t.eq(validatePatch({ thresholdRatio: "0.55", maxTokens: "8192", auto: "true", hotLedgerMarkers: "off", summarizationProvider: "p" }), { patch: { thresholdRatio: 0.55, maxTokens: 8192, auto: true, hotLedgerMarkers: "off", summarizationProvider: "p" }, skipped: [] }, "正常规整");
    t.throws(() => validatePatch({ thresholdRatio: "" }), "空串必须报错（不是 0）");
    t.throws(() => validatePatch({ thresholdRatio: "0x10" }), "非十进制必须拒");
    t.throws(() => validatePatch({ tier2After: 200 }), "越界必须拒");
    t.throws(() => validatePatch({ summaryMode: "nope" }), "枚举必须拒");
    t.throws(() => validatePatch({ auto: 1 }), "布尔必须是 true/false");
    t.eq(validatePatch({ nope: 1, auto: false }).skipped, ["nope"], "未知键进 skipped");
    t.eq(validatePatch({ retainRatio: "0.12345" }).patch.retainRatio, 0.123, "比率保留三位小数");
    t.eq(validatePatch({ tier2After: "9.6" }).patch.tier2After, 10, "整数键四舍五入");
    let msg = "no-throw";
    try {
      validatePatch({ maxTokens: "" });
    } catch (e) {
      msg = e.message;
    }
    t.includes(msg, "摘要输出上限（tokens） 不能为空", "错误信息必须用中文字段名");
  },

  "消费者接线：engine.mjs 的 Config 由 SCHEMA 生成、ui.mjs 只做委托"(t) {
    const engine = nodeFs.readFileSync(nodePath.join(ROOT, "src", "engine.mjs"), "utf8");
    t.includes(engine, 'from "./rooms/config-schema.mjs"', "engine 必须 import 房间");
    t.includes(engine, "SCHEMA.map((entry) => [entry.key, zodField(entry)])", "Config 必须由 SCHEMA 生成");
    t.notIncludes(engine, "thresholdRatio: z.number().default(0.45)", "engine 不许再留手写 schema 字面量");
    t.includes(engine, "resolveConfig(c)", "resolveChess 必须委托");
    const ui = nodeFs.readFileSync(nodePath.join(ROOT, "src", "ui.mjs"), "utf8");
    t.includes(ui, "export const DEFAULTS = Object.freeze(configDefaults());", "DEFAULTS 必须派生");
    t.includes(ui, "export const FIELD_LABELS = Object.freeze(fieldLabels());", "FIELD_LABELS 必须派生");
    t.notIncludes(ui, "const NUM_RANGES = {", "NUM_RANGES 必须删除");
    t.notIncludes(ui, "const EDITABLE = new Set(", "EDITABLE 必须删除");
    t.includes(ui, "return validatePatch(patch);", "sanitizePatch 必须委托");
    t.includes(ui, "return describeConfigFromSchema(presetConfig);", "describeConfig 必须委托");
  },

  "engineBlock：键序 = PRESET_KEYS 去 maxTokens，15 行逐字节未变"(t) {
    return import(PRESET_FORMAT).then((pf) => {
      const lines = pf.engineBlock();
      const keys = [];
      const values = {};
      for (const line of lines) {
        const m = /^ {4}([A-Za-z][A-Za-z0-9]*): (.*)$/.exec(line);
        if (m) {
          keys.push(m[1]);
          values[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
        }
      }
      t.eq(keys, PRESET_KEYS.filter((k) => k !== "maxTokens"), "engineBlock 的键序必须 = PRESET_KEYS 去掉 maxTokens");
      t.eq(values.auto, "true", "auto");
      t.eq(values.thresholdRatio, String(describe("thresholdRatio").default), "thresholdRatio 值");
      t.eq(values.headroomTokens, String(describe("headroomTokens").default), "headroomTokens 值");
      t.eq(values.summaryMode, describe("summaryMode").default, "summaryMode 写裸值");
      t.eq(values.summarizationProvider, "''", "空串写成 ''");
      t.eq(values.tier2After, String(describe("tier2After").default), "tier2After 值");
      t.eq(lines.length, 21, "engineBlock 总行数（3 注释 + id + name + config + 15 键）");
      return undefined;
    });
  },
};