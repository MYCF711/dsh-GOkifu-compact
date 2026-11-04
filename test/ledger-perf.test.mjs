/**
 * ledger-perf.test.mjs —— 热清单渲染不许在大图上白烧时间（C561）
 *
 * 真机（c0a5847a，5,885 节点 / 6,010 边）：单次渲染 137.8ms，每步注入都付一次。
 * 其中 **72.3ms 是 30 次 tewariAnalysis**（每条失败边一次可达性 BFS）。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

export const tests = {};

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => nodeFs.readFileSync(nodePath.join(ROOT, rel), "utf8");

tests["C561 大图上手割只算最近 8 条（渲染 137.8 → 50.3 ms）"] = (t) => {
  const src = read("src/rooms/ledger.mjs");
  t.includes(src, "tewariCap", "要有上限变量");
  t.includes(src, "> 3000 ? 8 : 30", "大图 8 条、小图 30 条");
  t.includes(src, "failures.slice(-tewariCap)", "按上限切片");
  t.includes(src, "72.3ms", "注释要留下实测数字（否则下一个人不知道为什么是 8）");
};

tests["C561 小图仍然算满 30 条（改的是大图，不是一刀切）"] = (t) => {
  const src = read("src/rooms/ledger.mjs");
  t.eq(src.includes("failures.slice(-30)"), false, "旧写法不许残留（否则两套逻辑并存）");
  t.includes(src, "> 3000 ? 8 : 30", "阈值清楚：3000 边以下不降级");
};
