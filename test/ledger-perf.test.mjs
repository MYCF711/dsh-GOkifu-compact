/**
 * ledger-perf.test.mjs —— 热清单渲染不许在大图上白烧时间（C561）
 *
 * 真机（<SESSION_ID>，5,885 节点 / 6,010 边）：单次渲染 137.8ms，每步注入都付一次。
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

tests["C562 路径折叠用二分（旧线性扫描对大路径是 O(n²)）"] = (t) => {
  const src = read("src/rooms/ledger.mjs");
  t.includes(src, "firstFittingLine", "要有二分实现");
  t.includes(src, "lo = mid + 1", "装得下就往上试（找最大 keep，与线性扫描答案一致）");
  t.includes(src, "hi = mid - 1", "装不下就往下");
  // 旧的三处线性扫描不许残留
  const linear = (src.match(/for \(let keep = .*\.length - 1; keep >= KEEP_HEAD \+ KEEP_TAIL \+ 1; keep -= 1\)/g) ?? []).length;
  t.eq(linear, 0, `不许残留线性扫描（实际 ${linear} 处）`);
};

tests["C562 图索引的快路径被撤销（会拿到过期索引）"] = (t) => {
  const src = read("src/rooms/kifu-model.mjs");
  t.includes(src, "撤销", "注释要说明为什么撤回");
  t.eq(src.includes("cached.cheap === cheap && cached.edgesLen"), false, "不许留下跳过签名的快路径");
};
