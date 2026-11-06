/**
 * ledger-calibration.test.mjs —— 「真实会话热清单多大」的统计口径回归（2026-11-02，C72）
 *
 * 为什么要有：README 长期写着「真实会话口径未校准」，合成夹具只能证明上界形状。
 * 校准脚本自己也会出错 —— 百分位算错、把超预算数错、把「没样本」当 0，都会让结论失真。
 * 所以分布统计是**纯函数**，这里逐条钉住。
 */

import { calibrate, percentile } from "../scripts/ledger-calibration.mjs";

export const tests = {};

tests["C72-1 percentile：最近秩法、越界钳制、空数组返回 null"] = (t) => {
  const sorted = [10, 20, 30, 40, 50];
  t.eq(percentile(sorted, 0), 10, "p0 = 最小值");
  t.eq(percentile(sorted, 50), 30, "p50 = 正中间");
  t.eq(percentile(sorted, 90), 50, "p90 落在末尾");
  t.eq(percentile(sorted, 100), 50, "p100 = 最大值");
  t.eq(percentile(sorted, -5), 10, "负值钳制到 p0");
  t.eq(percentile(sorted, 150), 50, "超过 100 钳制到 p100");
  t.eq(percentile([], 50), null, "空数组 ⇒ null");
  t.eq(percentile([7], 50), 7, "单元素");
};

tests["C72-2 calibrate：分布/中位/超预算数/档位计数；非法项被忽略"] = (t) => {
  const entries = [
    { session: "a", tokens: 100, fallback: "none", level: 0 },
    { session: "b", tokens: 400, fallback: "none", level: 3 },
    { session: "c", tokens: 480, fallback: "none", level: 3 },
    { session: "d", tokens: 520, fallback: "over-budget", level: 5 },
    { session: "e", tokens: 688, fallback: "over-budget", level: 3 },
    { session: "bad", tokens: Number.NaN, fallback: "none", level: 0 },
    { session: "bad2" },
  ];
  const s = calibrate(entries);
  t.eq(s.n, 5, "只统计有 tokens 的条目");
  t.eq(s.min, 100, "min");
  t.eq(s.max, 688, "max");
  t.eq(s.p50, 480, "p50 = 中间值（最近秩）");
  t.eq(s.p90, 688, "p90 = 末位");
  t.eq(s.over, 2, "超预算计数看 fallback，不看 tokens 与预算的比较");
  t.eq(s.levels.L3, 3, "L3 计数");
  t.eq(s.levels.L0, 1, "L0 计数");
  t.eq(calibrate([]).n, 0, "空输入 ⇒ n=0");
  t.eq(calibrate([]).p50, null, "空输入 ⇒ p50 null（不是 0）");
  t.eq(calibrate(null).n, 0, "null 也不许抛");
};
