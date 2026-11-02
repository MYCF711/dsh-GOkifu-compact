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
