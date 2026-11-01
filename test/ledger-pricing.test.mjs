/**
 * ledger-pricing.test.mjs —— 热清单 token 定价的钉值回归（W-A，2026-11-01）
 *
 * 背景：热清单预算判定以前一律用 `ceil(len / 3)`（3 字符/token）。实测（`计划表.md` 的 OPT-TOKENS）
 * 它**对纯中文低估 38%、对真实热清单低估 8.8%** —— 低估意味着「以为没超预算、其实超了」，
 * 而热清单预算是个**硬预算**，所以这是危险方向。
 *
 * 现在的口径（与 `src/rooms/ledger.mjs` 的 `estimateTokens` 一一对应）：
 *   · **CJK 字符**（汉字/假名/谚文/CJK 标点/全角形）—— **1 token/字**（保守上界）；
 *   · **其余字符** —— **1/4 token/字**（= 宿主 `dsh-token-meter` 的 `CHARS_PER_TOKEN = 4`）；
 *   · 合计后向上取整；空串 = 0。
 *
 * ★ 这个文件里**每一个用例都钉死具体数字**，不写「大于几」——因为旧的那条
 * `estimateTokens 是保守估计` 就是因为只断言 `>= 3` 而恒真，才让「低估」藏了三个版本。
 */

import { estimateTokens } from "../src/rooms/ledger.mjs";

export const tests = {};

tests["P-0 空串 = 0；单个 ASCII = 1；4 个 ASCII = 1；8 个 ASCII = 2"] = (t) => {
  t.eq(estimateTokens(""), 0, "空串必须是 0（不能因为向上取整变成 1）");
  t.eq(estimateTokens(null), 0, "null 也必须是 0（外部调用可能传 null）");
  t.eq(estimateTokens(undefined), 0, "undefined 也必须是 0");
  t.eq(estimateTokens("a"), 1, "单个 ASCII 字符向上取整 = 1 token");
  t.eq(estimateTokens("abcd"), 1, "4 字符 / 4 = 1 token（宿主 CHARS_PER_TOKEN=4）");
  t.eq(estimateTokens("abcdefgh"), 2, "8 字符 / 4 = 2 token");
};

tests["P-1 纯 ASCII 与宿主同一套常数：400 字符 = 100 token（旧口径是 134）"] = (t) => {
  const ascii400 = "a".repeat(400);
  t.eq(estimateTokens(ascii400), 100, "400 ASCII / 4 = 100 —— 与宿主 estimate.js 的 ceil(len/4) 完全一致");
  // 旧口径 `len/3` 会给 134（= ceil(400/3)），既不是 3 的倍数也不是 4 的倍数 ⇒ 对 ASCII 高估 34%
  t.ne(estimateTokens(ascii400), Math.ceil(400 / 3), "不许退回旧的 `len/3`（会给 134）");
};

tests["P-2 纯中文 1 token/字：10 字 = 10 token（旧口径是 4）"] = (t) => {
  const ten = "中文十个字应该超过十";
  t.eq(ten.length, 10, "夹具字面量应为 10 字");
  t.eq(estimateTokens(ten), 10, "10 个汉字 = 10 token");
  t.ne(estimateTokens(ten), Math.ceil(10 / 3), "不许退回旧的 `len/3`（会给 4）");
  // 184 字的中文样本：旧口径 62，实测真实 usage 是 100（OPT-TOKENS）——
  // 新口径给 184（**故意取上界**：见 ledger.mjs 定价注释里「为什么 CJK 取 1 token/字」）
  t.eq(estimateTokens("中".repeat(184)), 184, "184 个汉字 = 184 token（保守上界，不是均值）");
};

tests["P-3 混合文本按字符类别分别计价（真实热清单锚点：418 汉字 + 2060 ASCII = 933）"] = (t) => {
  t.eq(estimateTokens("abc中"), 2, "3 ASCII(3 单位) + 1 汉字(4 单位) = 7 单位 ⇒ ceil(7/4) = 2");
  t.eq(estimateTokens("中abc"), 2, "位置不影响，只按类别");
  t.eq(estimateTokens("ab中中"), 3, "2 + 8 = 10 单位 ⇒ ceil(10/4) = 3");
  // ★ 真实锚点：语料里唯一一条有真实 usage 的热清单是 2478 字符（418 汉字 / 2060 ASCII），
  //   网关实测 905 tokens。旧口径 826（−8.8%），新口径 933（+3.1%）。
  //   这里用等价字符构成复算，钉住这个校准结果。
  const sample = "中".repeat(418) + "a".repeat(2060);
  t.eq(sample.length, 2478, "锚点总字符数必须是 2478");
  t.eq(estimateTokens(sample), 933, "418 汉字 + 2060 ASCII ⇒ (1672+2060)/4 = 933（实测 905，+3.1%）");
};

tests["P-4 全角标点算 CJK：，。！？：；（） 各 1 token/字（ASCII 标点仍是 1/4）"] = (t) => {
  // 全角标点在 BPE 词表里与汉字同区间，按 ASCII 计会稳定偏乐观；本仓热清单的标点几乎全是全角
  // （`（逐条保留，一条不许少）` 这类），所以必须算 CJK。
  t.eq(estimateTokens("，。！？：；（）"), 8, "8 个全角标点 = 8 token");
  t.eq(estimateTokens(",.!?;:()"), 2, "对应的 ASCII 标点 8 字符 / 4 = 2 token");
  t.eq(estimateTokens("中文，。"), 4, "汉字与全角标点同价：4 字符 = 4 token");
  // CJK 符号区里常出现在热清单里的：、。「」【】
  t.eq(estimateTokens("、。「」【】"), 6, "CJK 标点（U+3000–303F）同样 1 token/字");
};

tests["P-5 假名 / 谚文 / 全角字母都算 CJK；半角片假名按全角形规则算（保守方向）"] = (t) => {
  t.eq(estimateTokens("ひらがな"), 4, "4 个平假名 = 4 token");
  t.eq(estimateTokens("カタカナ"), 4, "4 个片假名 = 4 token");
  t.eq(estimateTokens("한국어"), 3, "3 个谚文音节 = 3 token");
  t.eq(estimateTokens("ＡＢＣＤ"), 4, "4 个全角字母 = 4 token（全角形，U+FF00–FFEF）");
  t.eq(estimateTokens("ｶﾀｶﾅ"), 4, "半角片假名在 U+FF66–FF9F（全角形区）⇒ 按 CJK 计 = 4 token（保守上界）");
};

tests["P-6 emoji 与箭头：不在 CJK 区 ⇒ 按 1/4 token/字（与宿主一致）"] = (t) => {
  // emoji / 箭头都按「非 CJK」计。注意这是**逐码点**计数：一个 emoji 是一个码点（1 单位）。
  t.eq(estimateTokens("🚀"), 1, "单个 emoji = 1 单位 ⇒ 向上取整 1 token");
  t.eq(estimateTokens("🚀🚀🚀🚀"), 1, "4 个 emoji = 4 单位 ⇒ 1 token");
  t.eq(estimateTokens("→"), 1, "箭头 → 不在 CJK 区 ⇒ 1 单位 ⇒ 1 token（取整后）");
  t.eq(estimateTokens("→→→→→→→→"), 2, "8 个箭头 = 8 单位 ⇒ 2 token");
  t.eq(estimateTokens("…"), 1, "省略号 … 同样按 1 单位计");
};

tests["P-6b 星形平面的扩展汉字也算 CJK（U+20000 起，需要 u 标志）"] = (t) => {
  // 扩展 B 及以后的汉字在 BMP 之外（UTF-16 代理对）。旧正则只覆盖 BMP ⇒ 这类字会被当成「其余字符」按 1/4 计。
  // 现在用 /u 标志 + \u{20000}-\u{2FA1F}，逐码点判定。
  const astral8 = "\u{20000}".repeat(8);
  t.eq(astral8.length, 16, "8 个星形平面对应 16 个 UTF-16 单元（确属代理对）");
  t.eq(estimateTokens(astral8), 8, "8 个扩展汉字 = 8 token");
  t.eq(estimateTokens("a".repeat(8)), 2, "对照：8 个 ASCII = 2 token —— 两类字符不同价");
};

tests["P-7 单调与量级：加字符不会变便宜；CJK 明显比 ASCII 贵"] = (t) => {
  t.eq(estimateTokens("中中中中"), 4, "4 个汉字 = 4 token");
  t.eq(estimateTokens("aaaa"), 1, "4 个 ASCII = 1 token ⇒ 同长度下 CJK 贵 4×");
  const short = estimateTokens("中文");
  const long = estimateTokens("中文中文中文中文");
  t.ok(long > short, `加内容不得变便宜：${short} → ${long}`);
  // 真实热清单的字符构成（13.7% CJK）下，新口径整体比旧口径贵 ≈5.7%（436.03 vs 412.40 avg）——
  // 这里只钉「不完全等于旧口径」这个契约，避免有人把两个口径又写成同一个数。
  const mixed = "中文abc".repeat(20);
  t.ne(estimateTokens(mixed), Math.ceil(mixed.length / 3), "混合文本不得与旧 `len/3` 口径同值（否则等于没改）");
};
