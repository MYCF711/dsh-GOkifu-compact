/**
 * feature-registry —— **功能 ↔ 配置键的声明式注册表**（R17，C688）
 *
 * 为什么需要它：
 *   `config-schema.mjs` 回答了「**有哪些键**、默认多少、范围多少」，
 *   但它回答不了「**这个键归哪个功能管**」。于是三件事一直在漂：
 *
 *   ① **假 UI**：面板上画了开关，引擎里根本没人读（C672 的判据就是为这个存在的）；
 *   ② **孤儿键**：SCHEMA 里声明了，但没有任何功能消费 —— 用户改了没有任何效果；
 *   ③ **改一个功能不知道要动哪些键**：`closeoutMinEvents` 被 6 处读、`graphDir` 被 8 处读，
 *      全靠人肉 grep。
 *
 * 本房间把「功能 → 它消费的键」写成一张**可校验的表**：
 *   · `FEATURES` —— 每个功能一行：id / 中文名 / 它读的键 / 它是否默认开 / 它花钱吗；
 *   · `featureOf(key)` —— 反查某个键归谁管；
 *   · `orphanKeys()` —— SCHEMA 里**没有任何功能声明**的键（= 孤儿，必须为空或显式豁免）；
 *   · `undeclaredKeys()` —— 功能声明了但 SCHEMA 里没有的键（= 拼错，必须为空）。
 *
 * 纪律：
 *   · **本房间不读配置、不产生事实** —— 它只是一张表 + 三个纯查询；
 *   · **只增不改**：新增功能追加一行；删功能必须让 `FEATURES` 与 SCHEMA 的对账仍然绿；
 *   · `HOST_CONSUMED` 是**显式豁免表**：那几个键由宿主（`dsh-compaction`）消费，
 *     本插件只透传不读 —— 它们是"孤儿"但**不是缺陷**，所以单独列出来而不是混进功能里。
 *
 * 依赖：`./config-schema.mjs`（键的单一来源）。零 fs、零宿主、零 engine。
 */

import { SCHEMA } from "./config-schema.mjs";

/**
 * 由**宿主**消费的键：本插件只经 `pickBase()` 透传给官方基类，自己不读。
 *
 * 为什么单独列：它们在 SCHEMA 里是合法的（用户写在 preset 的 `config:` 块里由宿主生效），
 * 但插件代码里 grep 不到任何读取点。若不显式登记，`orphanKeys()` 会把它们误报成缺陷，
 * 于是下一个人要么去"修"一个没坏的东西，要么把门禁关掉 —— 两种都比现在糟。
 */
export const HOST_CONSUMED = Object.freeze([
  "compactionRetries",
  "maxOverflowRetries",
  "modelPolicies",
  "auto",
]);

/**
 * **引擎注入位**：不在 SCHEMA 里、由 `engine.mjs` 的 `Config` 单独声明的键。
 *
 * 为什么单独一张表而不是混进 `HOST_CONSUMED`：它们的消费者是**本插件自己**（不是宿主），
 * 只是暂时没进 SCHEMA。混进去会让「谁在读」有两个答案。
 *
 * 目前只有 `autoArchiveBackfill`：它是 T68 的付费总闸，收编进 SCHEMA 属于对外交付面变更
 * （C693 的 B2，需仓库负责人拍板），所以**本刀不动它**，只在这里显式登记，
 * 让 `orphanKeys()` 不会把它误报成缺陷。
 */
export const ENGINE_INJECTED = Object.freeze([
  "autoArchiveBackfill",
]);

/**
 * 功能注册表。每行 = 一个**功能**（不是一次调用），列出它消费的配置键。
 *
 * 字段：
 *   · `id`        功能标识（稳定，测试与文档引用它）
 *   · `label`     中文名（与面板/文档用词一致）
 *   · `keys`      它读取的配置键（必须都在 SCHEMA 里）
 *   · `defaultOn` 该功能是否**默认开**（AGENTS §2.0：不成熟的默认关）
 *   · `costs`     打开/运行它会不会**花钱**（调模型）—— 决定默认值的依据之一
 *   · `where`     功能实现在哪个房间/文件（便于"改这个功能要动哪里"）
 *
 * 顺序 = 从「每步都跑」到「归档才跑」，便于人读。
 */
export const FEATURES = Object.freeze([
  {
    id: "fold-pressure",
    label: "压力触发折叠",
    // 阈值/保留/首折/增长闸/最小折量 —— 决定"什么时候压、压多少"
    keys: ["thresholdRatio", "firstFoldRatio", "headroomTokens", "retainRatio", "retainTokens", "growthFloorTokens", "minFoldTokens"],
    defaultOn: true,
    costs: true,
    where: "rooms/config-resolve.mjs（resolveSpec）+ engine.mjs（compactIfNeeded）",
  },
  {
    id: "summary",
    label: "摘要生成",
    // 摘要方式 + 用哪个模型 + 输出上限
    keys: ["summaryMode", "summarizationProvider", "summarizationModel", "maxTokens"],
    defaultOn: true,
    costs: true,
    where: "engine.mjs（summarize）+ rooms/facts-prompt.mjs",
  },
  {
    id: "hot-ledger",
    label: "热清单注入",
    // 每步注入失败清单：开关 / 预算 / 节流 / 标记档位 / 路径前缀 / 就地替换
    keys: [
      "hotLedger",
      "hotLedgerMaxTokens",
      "hotLedgerMinEvents",
      "hotLedgerMinFailureDelta",
      "hotLedgerMarkers",
      "hotLedgerTraceRoot",
      "hotLedgerReplace",
    ],
    defaultOn: true,
    costs: false,
    where: "rooms/hot-inject.mjs（decideInjection）",
  },
  {
    id: "query-recall",
    label: "按问题召回代码证据（实验）",
    keys: ["queryRecall"],
    defaultOn: false,
    costs: false,
    where: "rooms/query-recall.mjs + rooms/hot-inject.mjs",
  },
  {
    id: "fact-guard",
    label: "事实守卫（实验）",
    keys: ["factGuard"],
    defaultOn: false,
    costs: false,
    where: "rooms/fact-guard.mjs",
  },
  {
    id: "transposition",
    label: "置换检测",
    keys: ["transposition"],
    defaultOn: true,
    costs: false,
    where: "rooms/keeper.mjs + engine.mjs",
  },
  {
    id: "tier2",
    label: "checkpoint 合并（tier-2）",
    keys: ["tier2After"],
    defaultOn: true,
    costs: true,
    where: "engine.mjs（#tier2IfNeeded）",
  },
  {
    id: "closeout",
    label: "归档收尾折叠",
    // 归档时补一次折叠：开关 / 门槛 / 超时 / 单段上限
    keys: ["closeoutFold", "closeoutMinEvents", "closeoutTimeoutMs", "closeoutMaxFoldTokens"],
    defaultOn: true,
    costs: true,
    where: "engine.mjs（#closeout / #closeoutFold）",
  },
  {
    id: "auto-backfill",
    label: "后台自动补账",
    // ★ T68：真实使用 0 次、已花 $11.05 ⇒ 默认关（AGENTS §2.0）
    keys: ["autoBackfill"],
    defaultOn: false,
    costs: true,
    where: "engine.mjs（#startAutoBackfill / #autoBackfillTick）",
  },
  {
    id: "storage",
    label: "棋谱落盘",
    keys: ["graphDir"],
    defaultOn: true,
    costs: false,
    where: "rooms/kifu-persist.mjs（graphRoot）",
  },
  {
    id: "world-hash",
    label: "世界状态哈希",
    keys: ["worldHashMaxFiles"],
    defaultOn: true,
    costs: false,
    where: "rooms/world.mjs（createWorldTracker）",
  },
]);

/** 键 → 功能 id 的反查表（一个键只允许归一个功能，重复即视为表写错）。 */
const KEY_TO_FEATURE = (() => {
  const map = new Map();
  for (const f of FEATURES) {
    for (const k of f.keys) {
      if (map.has(k)) {
        // 不抛错：本房间是**只读表**，抛错会让整个插件加载失败。
        // 冲突由测试（`feature-registry.test.mjs`）点名，而不是让运行时崩。
        map.set(k, `${map.get(k)}+${f.id}`);
      } else {
        map.set(k, f.id);
      }
    }
  }
  return map;
})();

/** 某个配置键归哪个功能管（找不到返回 null）。 */
export function featureOf(key) {
  return KEY_TO_FEATURE.get(key) ?? null;
}

/** 按 id 取功能（找不到返回 null）。 */
export function feature(id) {
  return FEATURES.find((f) => f.id === id) ?? null;
}

/** 全部被功能声明的键（去重）。 */
export function declaredKeys() {
  return [...new Set(FEATURES.flatMap((f) => f.keys))];
}

/**
 * **孤儿键**：SCHEMA 里有、但既没有功能声明、也不在 `HOST_CONSUMED` 里的键。
 *
 * 非空 ⇒ 用户能改它、但改了没有任何效果（假配置）。测试要求它为空。
 */
export function orphanKeys() {
  const declared = new Set(declaredKeys());
  const host = new Set(HOST_CONSUMED);
  const injected = new Set(ENGINE_INJECTED);
  return SCHEMA.map((e) => e.key)
    .filter((k) => !declared.has(k) && !host.has(k) && !injected.has(k))
    .sort();
}

/**
 * **未声明键**：功能声明了、但 SCHEMA 里根本没有的键。
 *
 * 非空 ⇒ 表里拼错了键名（或 SCHEMA 删了键但表没跟着删）。测试要求它为空。
 */
export function undeclaredKeys() {
  const known = new Set(SCHEMA.map((e) => e.key));
  return declaredKeys()
    .filter((k) => !known.has(k))
    .sort();
}

/**
 * **重复归属**：同一个键被两个以上功能声明。
 *
 * 非空 ⇒ 表写错了（一个键只能归一个功能；跨功能共享的键应当抽成独立功能）。
 */
export function duplicateKeys() {
  const seen = new Map();
  for (const f of FEATURES) {
    for (const k of f.keys) seen.set(k, (seen.get(k) ?? []).concat(f.id));
  }
  return [...seen.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key, features: ids }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * **默认开且花钱**的功能 —— AGENTS §2.0 要求这类必须写清"打开会多花多少钱"。
 *
 * 返回它们，供文档/面板提示；测试用它钉住"新增花钱功能必须显式声明 defaultOn"。
 */
export function costlyDefaults() {
  return FEATURES.filter((f) => f.costs === true && f.defaultOn === true).map((f) => f.id);
}
