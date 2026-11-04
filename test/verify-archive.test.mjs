/**
 * verify-archive.test.mjs —— 「归档后到底压没压」的判定（C568）
 *
 * 判据与 docs/归档压缩-怎么验证.md 一致：foldMark 是唯一证据。
 */
import { verdictOfGraph } from "../scripts/verify-archive.mjs";

export const tests = {};

tests["C568 假成功：closeout 说折了但 foldMarks 是 0"] = (t) => {
  const g = { closeout: { folded: 1, source: "disposed" }, foldMarks: [] };
  const r = verdictOfGraph(g);
  t.eq(r.verdict, "fake", "必须判成假成功");
  t.includes(r.detail, "假成功", "文案要直说");
};

tests["C568 真折了：有 mark 就是有证据"] = (t) => {
  const g = { closeout: { folded: 1 }, foldMarks: [{ trigger: "archive-offline", seqStart: 9, seqEnd: 63, summaryChars: 3959, offline: true }] };
  const r = verdictOfGraph(g);
  t.eq(r.verdict, "folded", "有 mark ⇒ 真折了");
  t.eq(r.offlineMarks, 1, "离线条数");
  t.includes(r.detail, "9-63", "要点出区间");
};

tests["C568 欠账：没有 mark 且 due"] = (t) => {
  const g = { closeout: null, foldMarks: [] };
  const r = verdictOfGraph(g, { debt: { due: true, tail: 800, gap: { events: 12, from: 5 } } });
  t.eq(r.verdict, "unfolded", "没折且欠账");
  t.includes(r.detail, "缺口 12", "要报缺口");
};

tests["C568 尾巴太短：收尾了但没折，不算错"] = (t) => {
  const g = { closeout: { folded: 0 }, foldMarks: [] };
  const r = verdictOfGraph(g, { debt: { due: false, tail: 3, gap: null } });
  t.eq(r.verdict, "none", "没折但不欠 ⇒ none（不是 fake）");
};
