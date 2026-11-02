/**
 * token-calib.mjs —— 我们的 token 估算 vs **官方比例**估算，差多少（K-20 的前置工具）
 *
 * 为什么需要：官方 `token_usage` 说 英文 **0.3 token/字**、中文 **0.6 token/字**；
 * 我们用的是 ASCII 0.25 / CJK 1.0（见 `docs/knowledge/token计量官方比例-deepseek.md`）。
 * 想按官方比例重标定（K-20），得先**量出**真实文本上的偏差，而不是拍脑袋改常量 ——
 * 因为一改，L0–L5 的档位阈值全要重推（实测会让 17 条测试红）。
 *
 * 用法：
 *   node scripts/token-calib.mjs --file <路径>      # 量一个文件
 *   node scripts/token-calib.mjs --text "…"         # 量一段文本
 *   node scripts/token-calib.mjs --dir <目录>       # 量目录下所有 .md（取合计）
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens } from "../src/rooms/ledger.mjs";

/** 与 `ledger.mjs` 的 CJK 判定同源（汉字 + 全角标点）。 */
const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * ★ C352：**按官方比例**估 token（英文 0.3/字、中文 0.6/字）。纯函数，供校准与对照。
 * @param {string} text
 * @returns {{tokens:number, cjkChars:number, asciiChars:number}}
 */
export function officialEstimate(text) {
  const s = String(text ?? "");
  let cjk = 0;
  let ascii = 0;
  for (const ch of s) {
    if (ch === "\n" || ch === "\r") continue;
    if (CJK_RE.test(ch)) cjk += 1;
    else ascii += 1;
  }
  const tokens = Math.ceil(cjk * 0.6 + ascii * 0.3);
  return { tokens, cjkChars: cjk, asciiChars: ascii };
}

/**
 * 比较两种估算。纯函数。
 * @param {string} text
 * @returns {{ours:number, official:number, ratio:number, cjkChars:number, asciiChars:number}}
 *          ratio = ours / official；>1 表示我们偏高
 */
export function compareEstimates(text) {
  const ours = estimateTokens(text);
  const { tokens, cjkChars, asciiChars } = officialEstimate(text);
  return {
    ours,
    official: tokens,
    ratio: tokens === 0 ? 1 : ours / tokens,
    cjkChars,
    asciiChars,
  };
}

export function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const pick = () => {
    const text = getArg("text", null);
    if (text !== null) return { label: "（--text）", text };
    const file = getArg("file", null);
    if (file !== null) return { label: file, text: nodeFs.readFileSync(file, "utf8") };
    const dir = getArg("dir", null);
    if (dir !== null) {
      let all = "";
      for (const name of nodeFs.readdirSync(dir)) {
        if (!name.endsWith(".md")) continue;
        all += nodeFs.readFileSync(nodePath.join(dir, name), "utf8");
      }
      return { label: `${dir}（所有 .md 合计）`, text: all };
    }
    return null;
  };
  const sample = pick();
  if (sample === null) {
    console.log("用法：--text \"…\" | --file <路径> | --dir <目录>");
    return 2;
  }
  const r = compareEstimates(sample.text);
  console.log(`== token 估算校准 · ${sample.label} ==`);
  console.log(`  中文 ${r.cjkChars} 字 / 其它 ${r.asciiChars} 字`);
  console.log(`  我们估 ${r.ours} tok · 官方比例估 ${r.official} tok ⇒ **${r.ratio.toFixed(2)}×**`);
  console.log(
    r.ratio > 1.05
      ? "  ⇒ 我们偏高（中文场景更安全，但会把清单裁得更狠）"
      : r.ratio < 0.95
        ? "  ⇒ 我们偏低（英文/路径重的文本要小心超预算）"
        : "  ⇒ 两者接近",
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
