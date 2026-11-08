/**
 * k2-normalize-v2.mjs —— K-2 答案归一化 **v2**：版本化、显式 opt-in、**只作离线第二列**。
 *
 * 依据（两份预注册都已 FROZEN，本文件不得反过来改它们）：
 *   · 公开：`evidence/k2-normalize-v2-prereg.json`（只有规则 / 哈希 / 类别，不含向量取值）
 *   · 私有：21 条测试向量（向量集 sha256 = `e7ed12de8d9fd78e959ef0dc4027d2228dd8d3f94ef088c92419ee958b63c46a`）
 *
 * 为什么需要 v2：K-2 的 K2-N3 compact 把有序答案写成 `'a', 'b', 'c'`。v1 `normalizeAnswer`
 * 把整串当「一层包裹引号」剥掉，得到 `a', 'b', 'c` —— 这是**格式假阴性**，不是语义错误。
 * v2 只补这一类：整串包裹只在**内层不含同种引号**时才剥；列表先拆元素，再逐个剥。
 *
 * 硬边界（改这里之前先读预注册的 forbiddenTransformations）：
 *   · 禁止翻译/转写、别名注射、大小写折叠、Unicode NFKC、数字格式化、路径分隔符归一化；
 *   · ordered 禁止重排、禁止去重、禁止丢元素；不做语义相似度、不调判分模型；
 *   · v1 `normalizeAnswer` 与 `gradeAnswer` 一行都不改（本文件只 import 后者、只调用不复制）；
 *   · 产品侧（`src/`）不得 import 本模块 —— `test/k2-normalize-v2.test.mjs` 的 K2V2-5 会扫拦；
 *   · 默认关闭，绝不回改历史结果（raw / k2-result.json 只读，不参与任何写入）。
 *
 * 已知口径（预注册没覆盖、也**故意不补** —— 补了就是新增规则）：
 *   ① 代码围栏按 v1 的同一刀切（`slice(3, -3).trim()`），语言标签（```js）会留在正文里；
 *   ② 规则 6 规定用 ", " 重新连接，因此**元素内部**含分隔符时会被 gradeAnswer 的 listValue
 *      重新拆开；21 条向量与 T7 的 20 行都没有这种输入，预注册也没有为它定义行为。
 */
import { gradeAnswer } from "./lme-task50.mjs";

export const K2_V2_VERSION = "k2-normalize-v2";
export const K2_V2_PREREG_SCHEMA = "k2-normalize-v2-prereg-v1";

/** 预注册 `rules.orderOfOperations` 的**逐字**副本；测试拿它对预注册做等值比较，漂移即红。 */
export const ORDER_OF_OPERATIONS = Object.freeze([
  "trim leading and trailing whitespace",
  "strip one triple-backtick code fence only when it wraps the whole answer",
  "strip one matching whole-string quote/backtick pair only when the inner text contains no same-kind quote character; otherwise leave the string unchanged",
  "for set/ordered: parse a valid JSON array if present; otherwise strip one outer [] layer when present; otherwise split on comma, semicolon, Chinese comma, Chinese semicolon or newline",
  "for each list element: trim and strip one matching element quote/backtick pair only when the inner text contains no same-kind quote character",
  "drop empty list elements; preserve order and duplicates for ordered; join list elements with ', '",
  "pass the normalized value to the unchanged gradeAnswer",
]);

export const ALLOWED_TRANSFORMATIONS = Object.freeze([
  "whitespace trim and whitespace-run collapse already performed by exactText",
  "one layer of paired quote/backtick wrapper around a whole answer",
  "one layer of paired quote/backtick wrapper per list element",
  "list delimiter split and canonical comma-space join",
]);

export const FORBIDDEN_TRANSFORMATIONS = Object.freeze([
  "translation or transliteration",
  "alias or synonym injection",
  "case folding",
  "Unicode NFKC",
  "number formatting",
  "path separator normalization",
  "reordering for ordered",
  "deduplication for ordered",
  "dropping extra elements",
  "semantic similarity or judge model",
]);

/** 需要列表解析的判分器；exact / UNKNOWN 只剥整串包裹，不拆列表。 */
export const LIST_GRADERS = Object.freeze(["set", "ordered"]);

/** 一层包裹的引号对；顺序 = 规则 3 的检查顺序（反引号 → 双引号 → 单引号 → 中文引号）。 */
export const WRAPPER_PAIRS = Object.freeze([
  Object.freeze(["`", "`"]),
  Object.freeze(['"', '"']),
  Object.freeze(["'", "'"]),
  Object.freeze(["“", "”"]),
]);

/** 与 v1 `listValue` 完全相同的分隔符集合（逗号 / 分号 / 换行 / 中文逗号 / 中文分号）。 */
const LIST_SPLIT_RE = /(?:,|;|\n|，|；)/;

/** 内层是否出现「同种引号」—— 左右任一侧的字符出现都算，中文引号因此会同时查 “ 与 ”。 */
function hasSameKindQuote(inner, pair) {
  return inner.includes(pair[0]) || inner.includes(pair[1]);
}

/** 规则 2：只剥「包住整串」的一层三反引号围栏；切法与 v1 一致（保留语言标签）。 */
function stripOneFence(raw) {
  const value = String(raw ?? "").trim();
  if (value.startsWith("```") && value.endsWith("```") && value.length >= 6) return value.slice(3, -3).trim();
  return value;
}

/**
 * 规则 3 / 5 共用：剥一层配对包裹，**只有内层不含同种引号时**才剥，否则整串原样返回。
 * 与 v1 的差别就在这里：v1 无条件剥一层，于是 `'a', 'b'` 被削成 `a', 'b`（假阴性来源）。
 * 空串、单字符、只有一对引号本身都不会抛。
 */
export function stripOneWrapper(text) {
  const value = String(text ?? "").trim();
  for (const pair of WRAPPER_PAIRS) {
    const [left, right] = pair;
    if (!value.startsWith(left) || !value.endsWith(right)) continue;
    if (value.length < left.length + right.length) return value;
    const inner = value.slice(left.length, value.length - right.length);
    return hasSameKindQuote(inner, pair) ? value : inner.trim();
  }
  return value;
}

/**
 * 规则 4：列表拆分。
 *   · 整串能 JSON.parse 成数组 ⇒ 用它的元素（元素先取原样，交给规则 5 逐个归一化）；
 *   · 否则在确实「以 [ 开头且以 ] 结尾」时剥一层外层方括号；
 *   · 再否则按五种分隔符拆分。
 */
export function splitList(text) {
  const value = String(text ?? "").trim();
  if (value === "") return [];
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
    } catch {
      /* 不是合法 JSON 数组（例如单引号伪数组）⇒ 落到下面的一层 [] 剥离 */
    }
    if (value.endsWith("]")) return value.slice(1, -1).split(LIST_SPLIT_RE);
  }
  return value.split(LIST_SPLIT_RE);
}

/** 规则 6：逐元素归一化、丢空元素、按 ", " 连接；不排序、不去重（ordered 的顺序即答案的一部分）。 */
export function joinList(elements) {
  return elements
    .map((entry) => stripOneWrapper(entry))
    .filter((entry) => entry !== "")
    .join(", ");
}

/**
 * v2 归一化主函数：修剪 → 剥一层代码围栏 → 剥一层整串包裹 → 仅列表判分器再拆/合。
 * @param {unknown} raw reader 的原始输出
 * @param {{grader?: string}} options grader ∈ exact|set|ordered|UNKNOWN（默认 exact）
 * @returns {string} 交给 gradeAnswer 的归一化值
 */
export function normalizeAnswerV2(raw, { grader = "exact" } = {}) {
  const text = stripOneWrapper(stripOneFence(raw));
  if (!LIST_GRADERS.includes(grader)) return text;
  return joinList(splitList(text));
}

/**
 * 归一化后交给**未改动的** `gradeAnswer`；返回 {answer, grade} 以便与 v1 列逐行对照。
 * 注意：本函数不读文件、不发请求，纯粹是「字符串进、判分结果出」。
 */
export function gradeWithV2(expected, raw, grader, aliases = []) {
  const answer = normalizeAnswerV2(raw, { grader });
  return { answer, grade: gradeAnswer(expected, answer, grader, aliases) };
}