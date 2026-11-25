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

const { SCHEMA, PRESET_KEYS, BASE_KEYS, describe, configDefaults, fieldLabels, resolveConfig, describeConfig, validatePatch, FACT_GUARD_DEFAULT, QUERY_RECALL_DEFAULT } = await import(ROOM);

/* ───────────────────────── golden（A2-4 之前的实测输出） ───────────────────────── */

// ★ C248：有意新增 `hotLedgerMinEvents`（注入节流间隔可配，默认 40 = 旧行为）—— 以下 golden 一并更新。
// ★ Q1：有意新增 `queryRecall`（锚点召回，实验线，默认 false）。★ Q1-UI：已提升为 **preset 作用域**——
//   进 DEFAULTS / FIELD_LABELS / describeConfig，并同步 PRESET_KEYS 与 engineBlock()（面板可开关、保存能写回）。
const GOLDEN_KEYS = ["thresholdRatio", "firstFoldRatio", "headroomTokens", "retainRatio", "retainTokens", "summarizationProvider", "summarizationModel", "maxTokens", "compactionRetries", "maxOverflowRetries", "modelPolicies", "auto", "autoBackfill", "summaryMode", "growthFloorTokens", "minFoldTokens", "hotLedger", "hotLedgerMaxTokens", "hotLedgerMinEvents", "hotLedgerMinFailureDelta", "hotLedgerMarkers", "hotLedgerTraceRoot", "hotLedgerReplace", "transposition", "tier2After", "closeoutFold", "closeoutMinEvents", "closeoutTimeoutMs", "closeoutMaxFoldTokens", "graphDir", "worldHashMaxFiles", "factGuard", "queryRecall"];

const GOLDEN_PRESET_KEYS = ["auto", "thresholdRatio", "firstFoldRatio", "headroomTokens", "retainRatio", "growthFloorTokens", "minFoldTokens", "autoBackfill", "summaryMode", "maxTokens", "summarizationProvider", "summarizationModel", "hotLedger", "hotLedgerMaxTokens", "hotLedgerMarkers", "hotLedgerReplace", "queryRecall", "transposition", "tier2After", "closeoutFold", "closeoutMinEvents", "closeoutTimeoutMs", "closeoutMaxFoldTokens"];

const GOLDEN_BASE_KEYS = ["thresholdRatio", "headroomTokens", "retainRatio", "retainTokens", "summarizationProvider", "summarizationModel", "maxTokens", "compactionRetries", "maxOverflowRetries", "modelPolicies", "auto"];

const GOLDEN_DEFAULTS = { auto: true, thresholdRatio: 0.45, firstFoldRatio: 0.3, headroomTokens: 65536, retainRatio: 0.16, growthFloorTokens: 40000, minFoldTokens: 8000, autoBackfill: true, summaryMode: "hybrid", maxTokens: 8192, summarizationProvider: "", summarizationModel: "", hotLedger: true, hotLedgerMaxTokens: 500, hotLedgerMarkers: "semantic", hotLedgerReplace: true, queryRecall: false, transposition: true, tier2After: 8, closeoutFold: true, closeoutMinEvents: 40, closeoutTimeoutMs: 90000, closeoutMaxFoldTokens: 150000 };

const GOLDEN_LABELS = { auto: "自动压缩", thresholdRatio: "触发阈值（占窗口）", firstFoldRatio: "首折阈值（占窗口）", headroomTokens: "压力余量（tokens）", retainRatio: "逐字保留尾部", growthFloorTokens: "增长闸（tokens）", minFoldTokens: "最小 fold 量（tokens）", autoBackfill: "自动补账", summaryMode: "摘要方式", maxTokens: "摘要输出上限（tokens）", hotLedger: "热清单", hotLedgerMaxTokens: "热清单预算（tokens）", hotLedgerReplace: "就地替换旧清单", hotLedgerMarkers: "清单标记档位", queryRecall: "按问题召回代码证据（实验）", transposition: "置换检测", tier2After: "checkpoint 合并阈值", closeoutFold: "归档收尾折叠", closeoutMinEvents: "归档收尾最小事件数", closeoutTimeoutMs: "归档收尾超时(ms)", closeoutMaxFoldTokens: "收尾单段上限(tokens)", summarizationProvider: "摘要 provider", summarizationModel: "摘要 model" };

const GOLDEN_RESOLVE_EMPTY = { summaryMode: "hybrid", thresholdRatio: 0.45, firstFoldRatio: 0.3, headroomTokens: 65536, retainRatio: 0.16, summarizationProvider: "", summarizationModel: "", maxTokens: 8192, growthFloorTokens: 40000, minFoldTokens: 8000, autoBackfill: true, hotLedger: true, hotLedgerMaxTokens: 500, hotLedgerMinEvents: 40, hotLedgerMinFailureDelta: 5, hotLedgerMarkers: "semantic", hotLedgerTraceRoot: "sessions", hotLedgerReplace: true, transposition: true, tier2After: 8, closeoutFold: true, closeoutMinEvents: 40, closeoutTimeoutMs: 90000, graphDir: "", worldHashMaxFiles: 200, factGuard: false, queryRecall: false };

const GOLDEN_DESCRIBE = { effective: { auto: false, thresholdRatio: 0.5, firstFoldRatio: 0.3, headroomTokens: 65536, retainRatio: 0.45, growthFloorTokens: 40000, minFoldTokens: 8000, autoBackfill: true, summaryMode: "hybrid", maxTokens: 8192, summarizationProvider: "", summarizationModel: "", hotLedger: true, hotLedgerMaxTokens: 500, hotLedgerMarkers: "terse", hotLedgerReplace: true, queryRecall: false, transposition: true, tier2After: 8, closeoutFold: true, closeoutMinEvents: 40, closeoutTimeoutMs: 90000, closeoutMaxFoldTokens: 150000 }, origins: { auto: "preset", thresholdRatio: "preset", firstFoldRatio: "default", headroomTokens: "default", retainRatio: "adjusted", growthFloorTokens: "default", minFoldTokens: "default", autoBackfill: "default", summaryMode: "default", maxTokens: "default", summarizationProvider: "default", summarizationModel: "default", hotLedger: "default", hotLedgerMaxTokens: "default", hotLedgerMarkers: "preset", hotLedgerReplace: "default", queryRecall: "default", transposition: "default", tier2After: "default", closeoutFold: "default", closeoutMinEvents: "default", closeoutTimeoutMs: "default", closeoutMaxFoldTokens: "default" }, unconfiguredKeys: ["autoBackfill", "closeoutFold", "closeoutMaxFoldTokens", "closeoutMinEvents", "closeoutTimeoutMs", "firstFoldRatio", "growthFloorTokens", "headroomTokens", "hotLedger", "hotLedgerMaxTokens", "hotLedgerReplace", "maxTokens", "minFoldTokens", "queryRecall", "summarizationModel", "summarizationProvider", "summaryMode", "tier2After", "transposition"] };

const RANGES = { thresholdRatio: [0.05, 0.95], firstFoldRatio: [0, 0.95], headroomTokens: [0, 512000], retainRatio: [0, 0.9], growthFloorTokens: [0, 1000000], minFoldTokens: [0, 1000000], maxTokens: [256, 65536], hotLedgerMaxTokens: [0, 20000], tier2After: [0, 100] };
const ENUMS = { summaryMode: ["hybrid", "rules", "llm"], hotLedgerMarkers: ["semantic", "terse", "off"] };

/* ───────────────────────────── 用例 ───────────────────────────── */

export const tests = {
  "SCHEMA：33 行、键集合与顺序逐键一致"(t) {
    t.eq(SCHEMA.length, 33, "SCHEMA 行数（C524 新增 autoBackfill；AX-01 新增 factGuard；Q1 新增 queryRecall）");
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
      } else if (key === "factGuard") {
        // ★ AX-01：实验线未通过总采纳门槛前**不许**默认开启（任务书 §1「默认状态」）。
        t.eq(entry.default, false, "factGuard 默认必须 false（未达标就默认开 = 在用户不知情时引入实验行为）");
      } else if (key === "queryRecall") {
        // ★ Q1：锚点召回同属实验线 ⇒ 默认必须关。
        t.eq(entry.default, false, "queryRecall 默认必须 false（实验线默认开 = 在用户不知情时改变热清单）");
      } else if (GOLDEN_DEFAULTS[key] !== undefined) {
        t.eq(entry.default, GOLDEN_DEFAULTS[key], `${key} 默认值`);
      }
      if (RANGES[key]) t.eq(entry.range, RANGES[key], `${key} 范围`);
      if (ENUMS[key]) t.eq(entry.values, ENUMS[key], `${key} 枚举`);
      if (GOLDEN_LABELS[key]) t.eq(entry.label, GOLDEN_LABELS[key], `${key} 中文名`);
    }
    t.eq(describe("no-such-key"), null, "未知键返回 null");
  },

  "PRESET_KEYS 23 / BASE_KEYS 11：顺序与集合"(t) {
    t.eq([...PRESET_KEYS], GOLDEN_PRESET_KEYS, "PRESET_KEYS 顺序");
    t.eq([...BASE_KEYS], GOLDEN_BASE_KEYS, "BASE_KEYS 顺序");
    const derived = SCHEMA.filter((e) => e.where === "preset").map((e) => e.key).sort();
    t.eq([...PRESET_KEYS].sort(), derived, "PRESET_KEYS 与 SCHEMA 的 preset 集一致");
  },

  "configDefaults：23 键逐键等于 DEFAULTS（C316 +closeoutMaxFoldTokens；Q1-UI 加 queryRecall）"(t) {
    t.eq(configDefaults(), GOLDEN_DEFAULTS, "golden");
    t.eq(Object.keys(configDefaults()), Object.keys(GOLDEN_DEFAULTS), "键序也必须一致（JSON.stringify 会被比对）");
  },

  "fieldLabels：23 键逐键等于 FIELD_LABELS（C316 +closeoutMaxFoldTokens；Q1-UI 加 queryRecall）"(t) {
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

  "AX-01：factGuard 是引擎作用域的实验开关（默认关 / 只认字面 true / 不进 UI 表）"(t) {
    const entry = describe("factGuard");
    t.ok(entry !== null, "factGuard 必须在 SCHEMA 里（AX-06 要从 ctx.config 读）");
    t.eq(entry.where, "engine", "必须是引擎作用域（preset 模板由 preset-format.mjs 固定，AX-01 不改格式）");
    t.eq(FACT_GUARD_DEFAULT, false, "导出的默认值必须 false");
    t.eq(entry.default, FACT_GUARD_DEFAULT, "SCHEMA 默认值必须与导出常量同源（只有一处字面量）");
    t.eq(resolveConfig({}).factGuard, false, "空配置 ⇒ false");
    t.eq(resolveConfig({ factGuard: true }).factGuard, true, "字面 true 才开启");
    t.eq(resolveConfig({ factGuard: "true" }).factGuard, false, "字符串 \"true\" 不许开启实验线");
    t.eq(resolveConfig({ factGuard: 1 }).factGuard, false, "1 不许开启实验线");
    t.eq(resolveConfig({ factGuard: null }).factGuard, false, "null 不许开启实验线");
    t.eq(Object.keys(configDefaults()).includes("factGuard"), false, "引擎作用域不进 UI 默认表");
    t.eq(Object.keys(fieldLabels()).includes("factGuard"), false, "引擎作用域不进 UI 标签表");
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

  "engineBlock：键序 = PRESET_KEYS 去 maxTokens，28 行（C316 加 closeoutMaxFoldTokens；Q1-UI 加 queryRecall）"(t) {
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
      t.eq(Number(values.firstFoldRatio), describe("firstFoldRatio").default, "firstFoldRatio 值（模板写 0.30）");
      t.eq(values.headroomTokens, String(describe("headroomTokens").default), "headroomTokens 值");
      t.eq(values.summaryMode, describe("summaryMode").default, "summaryMode 写裸值");
      t.eq(values.summarizationProvider, "''", "空串写成 ''");
      t.eq(values.tier2After, String(describe("tier2After").default), "tier2After 值");
      // ★ Q1-UI：面板开关必须真的写进安装器模板（否则新建的 preset 里没有这一行，用户只能手写）
      t.eq(values.queryRecall, "false", "queryRecall 在模板里必须是 false（默认关）");
      t.eq(lines.length, 28, "engineBlock 总行数（C524 autoBackfill；Q1-UI queryRecall）");
      return undefined;
    });
  },
};
tests["C252 UI 的 label 表必须是「可编辑键」的子集（有标签没值 = 面板残项）"] = async (t) => {
  const mod = await import(pathToFileURL(nodePath.join(ROOT, "src", "rooms", "config-schema.mjs")).href);
  const labels = Object.keys(mod.fieldLabels());
  const editable = Object.keys(mod.configDefaults());
  for (const key of labels) {
    t.eq(editable.includes(key), true, `fieldLabels 里的 ${key} 不在 configDefaults（面板会出现"有标签没值"）`);
  }
  // 反向不要求相等：有的键可编辑但刻意不给中文名（目前没有，但留口子）
  t.eq(labels.length > 0, true, "label 表不许空");
  // 引擎作用域的两个节流键**不该**出现在 UI 标签表里（它们写在 preset 的 config: 块里生效）
  for (const engineKey of ["hotLedgerMinEvents", "hotLedgerMinFailureDelta"]) {
    t.eq(labels.includes(engineKey), false, `${engineKey} 是引擎作用域，不该进 UI 标签表`);
    t.eq(
      mod.SCHEMA.some((f) => f.key === engineKey),
      true,
      `${engineKey} 必须仍在 SCHEMA 里（用户要能写进 preset 的 config: 块）`,
    );
  }
};

tests["C253 宿主消费的三个键不许被当成死配置删掉（本插件不读 ≠ 没用）"] = async (t) => {
  const mod = await import(pathToFileURL(nodePath.join(ROOT, "src", "rooms", "config-schema.mjs")).href);
  // 这三个键由宿主 `dsh-compaction` 读取（asar 实测：compactionRetries / maxOverflowRetries 都在读），
  // 本插件引擎不读它们 —— 所以"没人用就删掉"会**静默改变宿主的重试行为**。
  for (const key of ["compactionRetries", "maxOverflowRetries", "modelPolicies"]) {
    const field = mod.SCHEMA.find((f) => f.key === key);
    t.eq(!!field, true, `${key} 必须仍在 SCHEMA 里（宿主消费）`);
    t.includes(String(field.desc), "宿主", `${key} 的说明必须写明「由宿主消费」，否则下一个人会以为它是死键`);
  }
};

/* ───────────────────── Q1：锚点召回开关（2026-11-16） ───────────────────── */

tests["Q1-UI：queryRecall 是 preset 作用域实验开关（默认关 / 只认字面 true / 面板可写 / 说明齐全）"] = (t) => {
  const entry = describe("queryRecall");
  t.ok(entry !== null, "queryRecall 必须在 SCHEMA 里（R15 单一配置源）");
  t.eq(entry.type, "boolean", "必须是 boolean");
  t.eq(entry.where, "preset", "必须是 preset 作用域（面板要能开关；引擎作用域只能手写 preset）");
  t.eq(QUERY_RECALL_DEFAULT, false, "实验线默认必须关");
  t.eq(entry.default, QUERY_RECALL_DEFAULT, "SCHEMA 默认值必须与导出常量同源（只有一处字面量）");
  // 说明必须自己写全四件事：做什么 / 默认关 / 打开改变什么 / 怎么关 + 零额外模型调用。
  for (const needle of ["默认关", "零额外模型调用", "false", "热清单"]) {
    t.includes(String(entry.desc), needle, `说明里必须写清「${needle}」（不许让人去读代码猜）`);
  }
  t.eq(resolveConfig({}).queryRecall, false, "空配置 ⇒ false");
  t.eq(resolveConfig({ queryRecall: true }).queryRecall, true, "字面 true 才开启");
  for (const bad of ["true", "1", 1, 0, null]) {
    t.eq(resolveConfig({ queryRecall: bad }).queryRecall, false, `${JSON.stringify(bad)} 不许开启实验线`);
  }
  // ★ Q1-UI：面板三件套必须齐全（DEFAULTS / FIELD_LABELS / PRESET_KEYS），否则「有键无值」或「保存写不回」。
  t.eq(Object.keys(configDefaults()).includes("queryRecall"), true, "必须进 UI 默认表（DEFAULTS）");
  t.eq(Object.keys(fieldLabels()).includes("queryRecall"), true, "必须进 UI 标签表（FIELD_LABELS）");
  t.eq(fieldLabels().queryRecall, "按问题召回代码证据（实验）", "中文名必须与 lib/client.js 的 FIELDS label 逐字相同");
  t.eq(PRESET_KEYS.includes("queryRecall"), true, "必须进 preset 白名单（否则 describeConfig/保存路径不认它）");
  t.eq(BASE_KEYS.includes("queryRecall"), false, "不许透传给官方基类（它不是基类键）");
  // 页面提交的 patch 必须能过白名单并被规整（UI 保存能写回）
  t.eq(validatePatch({ queryRecall: "true" }), { patch: { queryRecall: true }, skipped: [] }, "字符串 true 必须规整成布尔");
  t.eq(validatePatch({ queryRecall: false }).patch, { queryRecall: false }, "false 原样通过");
  t.throws(() => validatePatch({ queryRecall: 1 }), "非布尔必须拒绝（与其它 boolean 键同语义）");
  // describeConfig 必须把它当「可配置键」报出来（来源 default / preset 两种）
  t.eq(describeConfig({}).effective.queryRecall, false, "未配置 ⇒ false");
  t.eq(describeConfig({}).origins.queryRecall, "default", "未配置来源 = default");
  t.eq(describeConfig({ queryRecall: true }).effective.queryRecall, true, "文件里写 true ⇒ 生效 true");
  t.eq(describeConfig({ queryRecall: true }).origins.queryRecall, "preset", "来源 = preset");
  t.eq(describeConfig({}).unconfiguredKeys.includes("queryRecall"), true, "未配置时出现在 unconfiguredKeys");
};

/* ───── C671：取整口径由区间决定，不许维护键名白名单 ───── */

tests["C671 小数域键一律保留三位小数：firstFoldRatio 0.9 不许被静默取整成 1"] = (t) => {
  // 旧实现把 thresholdRatio/retainRatio 写死在白名单里，其余 Math.round ⇒ firstFoldRatio 被取整，
  // 面板 step 0.01 / max 0.95（可达）→ 落盘 1，越界且不报错。
  t.eq(validatePatch({ firstFoldRatio: 0.9 }).patch.firstFoldRatio, 0.9, "0.9 必须原样保留");
  t.eq(validatePatch({ firstFoldRatio: 0.3 }).patch.firstFoldRatio, 0.3, "0.3 必须原样保留");
  t.eq(validatePatch({ thresholdRatio: 0.35 }).patch.thresholdRatio, 0.35, "阈值档不被破坏");
  t.eq(validatePatch({ retainRatio: 0.16 }).patch.retainRatio, 0.16, "保留比不被破坏");
};

tests["C671 整数域键仍然取整（不许因为修上一行就把 token 数也变成小数）"] = (t) => {
  t.eq(validatePatch({ headroomTokens: 8000.7 }).patch.headroomTokens, 8001, "token 数必须取整");
  t.eq(validatePatch({ closeoutMinEvents: 40.4 }).patch.closeoutMinEvents, 40, "事件数必须取整");
};

tests["C671 口径判据来自 SCHEMA 的区间，不是代码里的键名清单"] = (t) => {
  const src = nodeFs.readFileSync(nodePath.join(HERE, "..", "src", "rooms", "config-schema.mjs"), "utf8");
  t.eq(/key === "thresholdRatio" \|\| key === "retainRatio"/.test(src), false, "不许再有键名白名单");
  t.includes(src, "Number.isFinite(v) && !Number.isInteger(v)", "必须按区间是否含小数来判");
};

/* ───── C672：preset 里能写的键，引擎必须真的读得到 ───── */

tests["C672 preset 域里没进 RESOLVE_ORDER 的键必须登记（否则面板写了引擎读不到 = 假 UI）"] = (t) => {
  const engineSrc = nodeFs.readFileSync(nodePath.join(HERE, "..", "src", "engine.mjs"), "utf8");
  const start = engineSrc.indexOf("const RESOLVE_ORDER = [");
  const end = engineSrc.indexOf("];", start);
  t.ok(start > 0 && end > start, "找不到 RESOLVE_ORDER");
  const order = new Set([...engineSrc.slice(start, end).matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]));

  // 这份名单是**已知欠账**，不是许可：新增一个就必须同时写理由，或者把它接进 RESOLVE_ORDER。
  const KNOWN_UNRESOLVED = {
    auto: "引擎构造选项（`new Engine(ctx,{auto:false})`），不是 chess 配置",
    autoBackfill: "C524 的「自动补账」勾选；T68/T72 已把总闸改成 autoArchiveBackfill 并判定旧键不生效，面板仍在渲染它 ⇒ 已知假 UI，等接线",
    closeoutMaxFoldTokens: "归档收尾折叠上限；当前经 engineBlock 模板下发，未经 RESOLVE_ORDER",
  };

  const preset = SCHEMA.filter((e) => e.where === "preset").map((e) => e.key);
  const outside = preset.filter((k) => !order.has(k)).sort();
  const known = Object.keys(KNOWN_UNRESOLVED).sort();

  t.eq(JSON.stringify(outside), JSON.stringify(known), `preset 键与已知欠账名单不一致：实际 ${JSON.stringify(outside)}`);
  for (const k of known) {
    t.ok(String(KNOWN_UNRESOLVED[k]).length > 8, `${k} 必须写清为什么可以不在 RESOLVE_ORDER 里`);
  }
};



/* ───── C675：配置面对外的版本号 + 键序快照（P3 第三张面） ───── */

tests["C675 配置布局有版本号，且键序是对外契约（preset 行序 / 面板顺序）"] = async (t) => {
  const { CONFIG_SCHEMA_VERSION, SCHEMA } = await import(ROOM);
  t.eq(CONFIG_SCHEMA_VERSION, 1, "配置面版本号必须导出且为 1");
  // 键序 = preset 块里 engine 段的行序 = 面板渲染顺序 ⇒ 记忆侧与手写 preset 都依赖它。
  // 加键追加到末尾；删/重排必须让版本号 +1 并同步发布说明。
  t.eq(JSON.stringify(SCHEMA.map((e) => e.key)), JSON.stringify([
      "thresholdRatio",
      "firstFoldRatio",
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
      "autoBackfill",
      "summaryMode",
      "growthFloorTokens",
      "minFoldTokens",
      "hotLedger",
      "hotLedgerMaxTokens",
      "hotLedgerMinEvents",
      "hotLedgerMinFailureDelta",
      "hotLedgerMarkers",
      "hotLedgerTraceRoot",
      "hotLedgerReplace",
      "transposition",
      "tier2After",
      "closeoutFold",
      "closeoutMinEvents",
      "closeoutTimeoutMs",
      "closeoutMaxFoldTokens",
      "graphDir",
      "worldHashMaxFiles",
      "factGuard",
      "queryRecall",
    ]), "SCHEMA 键序变了：必须改快照（这是对外契约）");
};

/* ───── C677：面板字段声明必须从 SCHEMA 派生（UI 声明下沉的 host 侧） ───── */

tests["C677 describeFields 与 SCHEMA 一一对应：条数、键序、标签、范围、枚举全一致"] = async (t) => {
  const { describeFields, SCHEMA, fieldLabels } = await import(ROOM);
  const fields = describeFields();
  t.eq(fields.length, SCHEMA.length, `字段声明条数必须等于 SCHEMA 条数（${SCHEMA.length}）`);
  t.eq(JSON.stringify(fields.map((f) => f.key)), JSON.stringify(SCHEMA.map((e) => e.key)), "键序必须与 SCHEMA 完全一致（它同时是 preset 行序）");

  const labels = fieldLabels();
  for (const entry of SCHEMA) {
    const f = fields.find((x) => x.key === entry.key);
    t.ok(f !== undefined, `${entry.key} 必须有字段声明`);
    // 数值域：range 必须原样（这是"面板放行、保存即 400"那 5 处不一致的根治点）
    if (entry.type === "number" && Array.isArray(entry.range)) {
      t.eq(JSON.stringify(f.range), JSON.stringify([entry.range[0], entry.range[1] === null ? null : entry.range[1]]), `${entry.key} 的 range 必须与 SCHEMA 相同`);
    }
    // 枚举域：可选值必须原样
    if (entry.type === "enum") {
      t.eq(JSON.stringify(f.options), JSON.stringify([...entry.values]), `${entry.key} 的枚举必须与 SCHEMA 相同`);
    }
    // 标签必须与 fieldLabels 同源（否则面板与 state 各显示一套名字）
    // fieldLabels 只覆盖可编辑键（C252）；不在其中的（如 engine 作用域的 factGuard）以 SCHEMA 的 label 为准。
    if (labels[entry.key] !== undefined) {
      t.eq(f.label, labels[entry.key], `${entry.key} 的 label 必须与 fieldLabels 同源`);
    }
    // 类型必须原样
    t.eq(f.type, entry.type, `${entry.key} 的 type 必须与 SCHEMA 相同`);
  }
};

tests["C677 墓碑：字段声明里不许出现 SCHEMA 之外的键（面板会渲染出保存不了的东西）"] = async (t) => {
  const { describeFields, SCHEMA } = await import(ROOM);
  const keys = new Set(SCHEMA.map((e) => e.key));
  const extra = describeFields().map((f) => f.key).filter((k) => !keys.has(k));
  t.eq(JSON.stringify(extra), "[]", `字段声明里出现了 SCHEMA 之外的键：${JSON.stringify(extra)}（面板会渲染出保存不了的东西）`);
};
