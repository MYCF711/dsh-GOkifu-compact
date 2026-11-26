/**
 * feature-registry.test.mjs —— 「配置 → 功能」这一层的门禁（C688）
 *
 * 背景：`config-schema.test.mjs` 钉住了「有哪些键」，但钉不住「**这个键归谁管**」。
 * 于是两类缺陷一直能悄悄溜进来：
 *   ① **假配置**：SCHEMA 里加了键、面板也画了，但没有任何功能读它 ⇒ 用户改了没有效果；
 *   ② **假 UI**：面板画了开关，引擎里没人读（C672 只覆盖了 preset 域，引擎域没覆盖）。
 *
 * 本文件把「功能 ↔ 键」的对应关系变成机器判据：
 *   ① `orphanKeys()` 为空 —— 每个键要么被某个功能声明，要么在 `HOST_CONSUMED` 里显式豁免；
 *   ② `undeclaredKeys()` 为空 —— 功能声明的键必须真的在 SCHEMA 里（拼错立刻红）；
 *   ③ `duplicateKeys()` 为空 —— 一个键只归一个功能（跨功能共享要抽成独立功能）；
 *   ④ 每个功能都有 `defaultOn` / `costs` —— AGENTS §2.0 要求"花钱的默认开"必须写清；
 *   ⑤ **墓碑**：删掉某个功能（或把它的 keys 清空）⇒ 它管的键必须立刻变成孤儿 ⇒ 本文件红。
 *
 * 变异自检口径：
 *   · 从 SCHEMA 加一个键、不在 FEATURES 里登记 ⇒ ①红；
 *   · 把 `closeout` 功能的 keys 清空 ⇒ ⑤红（closeoutFold 等变成孤儿）。
 */

import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const REGISTRY = pathToFileURL(nodePath.join(ROOT, "src", "rooms", "feature-registry.mjs")).href;
const SCHEMA_MOD = pathToFileURL(nodePath.join(ROOT, "src", "rooms", "config-schema.mjs")).href;

const reg = await import(REGISTRY);
const { SCHEMA } = await import(SCHEMA_MOD);

const { FEATURES, HOST_CONSUMED, ENGINE_INJECTED, featureOf, feature, declaredKeys, orphanKeys, undeclaredKeys, duplicateKeys, costlyDefaults } = reg;

export const tests = {
  "C688① 孤儿键必须为空：SCHEMA 里每个键都要么归某个功能，要么在 HOST_CONSUMED 里显式豁免"(t) {
    const orphans = orphanKeys();
    t.eq(
      orphans,
      [],
      `这些键能改但没有任何功能读它（假配置）：${orphans.join(", ")} —— 要么登记进 FEATURES，要么加进 HOST_CONSUMED`,
    );
    // 判据自检：合成一个"谁都不管"的键，必须被检出
    const fake = [...SCHEMA.map((e) => e.key), "ghostKey"];
    const declared = new Set(declaredKeys());
    const host = new Set(HOST_CONSUMED);
    const detected = fake.filter((k) => !declared.has(k) && !host.has(k));
    t.eq(detected, ["ghostKey"], "判据自检：未登记的合成键必须被检出（否则门禁形同虚设）");
  },

  "C688② 未声明键必须为空：功能里写的键必须真的在 SCHEMA 里（拼错立刻红）"(t) {
    const bad = undeclaredKeys();
    t.eq(bad, [], `这些键在 FEATURES 里声明了但 SCHEMA 里没有（拼错或 SCHEMA 删了没跟着删）：${bad.join(", ")}`);
    // ★ 本刀**不**收编 autoArchiveBackfill：它是引擎作用域的注入位，收编进 SCHEMA 会升
    //   对外契约版本号（CONFIG_SCHEMA_VERSION），属 C693 的 B2，需仓库负责人拍板。
    //   这里反过来钉住"它确实还没进 SCHEMA"，防止有人顺手改了却没人发现。
    t.eq(SCHEMA.map((e) => e.key).includes("autoArchiveBackfill"), false, "本刀不收编 autoArchiveBackfill（B2 待拍板）");
    t.eq(ENGINE_INJECTED.includes("autoArchiveBackfill"), true, "它必须在 ENGINE_INJECTED 里显式登记，否则 orphanKeys 会误报");
    t.eq(orphanKeys(), [], "登记后不许再算孤儿");
  },

  "C688③ 一个键只许归一个功能（重复归属 = 表写错）"(t) {
    const dup = duplicateKeys();
    t.eq(dup, [], `重复归属：${dup.map((d) => `${d.key} → ${d.features.join("+")}`).join("; ")}`);
    // 反查必须能答出唯一功能
    t.eq(featureOf("closeoutFold"), "closeout", "closeoutFold 归 closeout");
    t.eq(featureOf("hotLedgerMaxTokens"), "hot-ledger", "hotLedgerMaxTokens 归 hot-ledger");
    t.eq(featureOf("no-such-key"), null, "未知键返回 null");
  },

  "C688④ 每个功能都声明 defaultOn / costs / where（AGENTS §2.0：花钱的默认开必须写清）"(t) {
    for (const f of FEATURES) {
      t.ok(typeof f.id === "string" && f.id.length > 0, `${JSON.stringify(f)} 必须有 id`);
      t.ok(typeof f.label === "string" && f.label.length > 0, `${f.id} 必须有中文名`);
      t.eq(typeof f.defaultOn, "boolean", `${f.id}.defaultOn 必须是布尔（不成熟的开关默认关）`);
      t.eq(typeof f.costs, "boolean", `${f.id}.costs 必须是布尔（会不会花钱）`);
      t.ok(typeof f.where === "string" && f.where.length > 0, `${f.id} 必须写清实现在哪（改它要动哪里）`);
      t.ok(Array.isArray(f.keys) && f.keys.length > 0, `${f.id} 必须至少声明一个键`);
    }
    // 花钱且默认开的功能必须能被列出来（文档/面板据此提示"打开会多花多少钱"）
    const costly = costlyDefaults();
    t.ok(costly.includes("closeout"), "归档收尾折叠是花钱且默认开的（必须在 costlyDefaults 里）");
    t.eq(costly.includes("auto-backfill"), false, "自动补账花钱但默认关（T68：真实使用 0 次、已花 $11.05）");
  },

  "C688⑤ 墓碑：清空某个功能的 keys ⇒ 它管的键必须立刻变成孤儿（门禁真的会红）"(t) {
    // 模拟"有人把 closeout 功能的声明删了"
    const withoutCloseout = FEATURES.filter((f) => f.id !== "closeout");
    const declared = new Set(withoutCloseout.flatMap((f) => f.keys));
    const host = new Set(HOST_CONSUMED);
    const orphans = SCHEMA.map((e) => e.key).filter((k) => !declared.has(k) && !host.has(k));
    t.ok(orphans.includes("closeoutFold"), "删掉 closeout 功能后 closeoutFold 必须变成孤儿（否则门禁是摆设）");
    t.ok(orphans.includes("closeoutMinEvents"), "closeoutMinEvents 同理");
    t.eq(orphans.includes("thresholdRatio"), false, "别的功能管的键不受影响（判据不能一刀切）");
  },

  "C688⑥ HOST_CONSUMED 里的键必须真的在 SCHEMA 里（豁免表不许写幽灵）"(t) {
    const known = new Set(SCHEMA.map((e) => e.key));
    const ghosts = HOST_CONSUMED.filter((k) => !known.has(k));
    t.eq(ghosts, [], `HOST_CONSUMED 里有 SCHEMA 不认识的键：${ghosts.join(", ")}`);
    // 宿主消费的键**不许**同时被某个功能声明（否则"谁在读"会有两个答案）
    const declared = new Set(declaredKeys());
    const overlap = HOST_CONSUMED.filter((k) => declared.has(k));
    t.eq(overlap, [], `这些键既被宿主消费又被功能声明（归属冲突）：${overlap.join(", ")}`);
  },

  "C688⑦ 注册表是只读表：不许被运行时改写（否则门禁可被绕过）"(t) {
    t.eq(Object.isFrozen(FEATURES), true, "FEATURES 必须 Object.freeze");
    t.eq(Object.isFrozen(HOST_CONSUMED), true, "HOST_CONSUMED 必须 Object.freeze");
    t.eq(feature("closeout") !== null, true, "feature(id) 能按 id 取");
    t.eq(feature("no-such-feature"), null, "未知 id 返回 null");
  },
};
