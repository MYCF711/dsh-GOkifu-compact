/**
 * last-summary.test.mjs —— 「看最近一次离线摘要」的挑选逻辑（C566）
 */
import { pickSummaries } from "../scripts/last-summary.mjs";

export const tests = {};

tests["C566 按时间倒序、按会话过滤、空文本不列"] = (t) => {
  const items = [
    { id: "session-aaa", at: 1000, text: "旧", model: "m", quality: null },
    { id: "session-bbb", at: 3000, text: "新", model: "m", quality: null },
    { id: "session-ccc", at: 2000, text: "", model: "m", quality: null },
  ];
  const all = pickSummaries(items, {});
  t.eq(all.map((x) => x.id), ["session-bbb", "session-aaa"], "按时间倒序，空文本被跳过");
  const one = pickSummaries(items, { session: "aaa" });
  t.eq(one.length, 1, "按会话过滤");
  t.eq(one[0].text, "旧", "取到对应那条");
  t.eq(pickSummaries([], {}).length, 0, "空输入不炸");
  t.eq(pickSummaries(null, {}).length, 0, "null 不炸");
};
