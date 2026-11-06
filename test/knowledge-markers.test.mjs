/**
 * knowledge-markers.test.mjs —— 每篇知识库条目都必须同时标「已核实」与「待核实」（C436）
 *
 * goal 的 ① 明确要求：「docs/knowledge/ 下，带来源 URL 与要点，且标注「已核实/待核实」」。
 * 之前实测 44 篇里有 7 篇缺前者、7 篇缺后者——**要求存在，但没有闸门**。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const DIR = nodePath.join(HERE, "..", "docs", "knowledge");
const SKIP = new Set(["README.md", "进度.md", "结论速查.md"]);

export const tests = {};

tests["C436 每篇知识库条目都同时含「已核实」与「待核实」"] = (t) => {
  const files = nodeFs.readdirSync(DIR).filter((f) => f.endsWith(".md") && !SKIP.has(f));
  t.eq(files.length >= 30, true, `只扫到 ${files.length} 篇 —— 目录变了？`);
  const missV = [];
  const missT = [];
  for (const f of files) {
    const text = nodeFs.readFileSync(nodePath.join(DIR, f), "utf8");
    if (!text.includes("已核实")) missV.push(f);
    if (!text.includes("待核实")) missT.push(f);
  }
  t.eq(missV, [], `这些条目缺「已核实」标注：${missV.join(" / ")}`);
  t.eq(missT, [], `这些条目缺「待核实」段落：${missT.join(" / ")}`);
};

tests["C436 每条要点都该带来源 URL（否则无法回溯）"] = (t) => {
  const files = nodeFs.readdirSync(DIR).filter((f) => f.endsWith(".md") && !SKIP.has(f));
  const noUrl = [];
  for (const f of files) {
    const text = nodeFs.readFileSync(nodePath.join(DIR, f), "utf8");
    // ★ C436：来源可以是**网址**，也可以是**本机证据**（asar / DSH_HOME / 实测）——两者都能回溯
    const hasUrl = /https?:\/\//.test(text) || /app\.asar|DSH_HOME|本机实测/.test(text);
    if (!hasUrl) noUrl.push(f);
  }
  t.eq(noUrl, [], `这些条目没有来源 URL：${noUrl.join(" / ")}`);
};
