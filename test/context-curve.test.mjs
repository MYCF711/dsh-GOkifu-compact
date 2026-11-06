/**
 * context-curve.test.mjs —— 「折叠有没有真的削上下文」的判据（C364）
 *
 * 曲线 = 每次请求的 input+hit（口径 C361）。锯齿=折叠在工作；单调上升=折叠没跟上。
 */
import { curveStats } from "../scripts/context-curve.mjs";

export const tests = {};

tests["C364 没回落 = 折叠没在工作；有回落 = 锯齿成立"] = (t) => {
  const mk = (n) => ({ inputTokens: n, cacheReadTokens: 0 });
  // 单调上升：不该有回落
  const rising = curveStats([100, 200, 400, 800].map(mk));
  t.eq(rising.drops, 0, "单调上升 ⇒ 0 次回落");
  t.eq(rising.max, 800, "max 取最大");
  // 折了一次：800 → 100 算一次回落；之后小抖动不算
  const saw = curveStats([100, 400, 800, 100, 110, 140].map(mk));
  t.eq(saw.drops, 1, `应只认那次大回落，实际 ${saw.drops}`);
  t.eq(saw.min, 100, "min 取最小");
  // 空输入不许崩
  const empty = curveStats([]);
  t.eq([empty.n, empty.drops, empty.max], [0, 0, 0], "空输入全 0");
};

tests["C364 输入口径是 input+hit（只算 input 会漏掉命中部分）"] = (t) => {
  // 一条 1000 miss + 9000 hit ⇒ 上下文 10000
  const s = curveStats([{ inputTokens: 1000, cacheReadTokens: 9000 }]);
  t.eq(s.max, 10000, "必须把命中算进上下文大小");
  t.eq(s.n, 1, "1 条样本");
};

tests["C375 折叠与请求对齐：算出折后首个请求与 totalAfter 的差（K-22 的证据）"] = async (t) => {
  const { pairFoldsWithRequests } = await import("../scripts/context-curve.mjs");
  t.eq(typeof pairFoldsWithRequests, "function", "必须导出 pairFoldsWithRequests");

  const folds = [{ at: 100, totalAfter: 300_000 }, { at: 200, totalAfter: null }, { at: 999, totalAfter: 1 }];
  const reqs = [{ t: 90, size: 1 }, { t: 110, size: 26_000 }, { t: 210, size: 28_000 }];
  const rows = pairFoldsWithRequests(folds, reqs);

  t.eq(rows.length, 3, "每条 fold 一行");
  t.eq(rows[0].prompt, 26_000, "要取 fold 之后**第一个**请求（不是之前那个）");
  t.eq(rows[0].gap, 26_000 - 300_000, "gap = 真实请求 − totalAfter");
  t.eq(rows[1].gap, null, "totalAfter 缺失 ⇒ gap 为 null（不许瞎算）");
  t.eq(rows[2].prompt, null, "后面没有请求 ⇒ prompt 为 null");
};
