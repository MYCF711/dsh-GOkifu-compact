/**
 * loop-guard.test.mjs —— 「思考死循环」判据（C444）
 *
 * 真机（2026-11-03 DSH-GO）：会话末尾连续 8 步同一个 `bash(...)`、零文本产出，
 * **手动压缩一次就好了**。这里把那个动作变成自动的判据。
 */
import { loopStreak, shouldFoldForLoop } from "../src/rooms/loop-guard.mjs";

export const tests = {};

tests["C444 连续相同动作 ≥4 才算循环；不足/中断都不算"] = (t) => {
  const mk = (...acts) => acts.map((a, i) => ({ action: a, evidence: { end: i + 1 } }));
  t.eq(loopStreak(mk("a", "a", "a")).looped, false, "3 次不够（阈值 4）");
  const four = loopStreak(mk("a", "a", "a", "a"));
  t.eq(four.looped, true, "4 次算循环");
  t.eq(four.streak, 4, "streak 记 4");
  t.eq(four.action, "a", "动作要带出来");
  t.eq(loopStreak(mk("a", "a", "b", "b", "b")).looped, false, "中间被打断（末尾只有 3 个 b）");
  t.eq(loopStreak([]).looped, false, "空图不算");
};

tests["C444 限流：太近不折、折够次数就停手"] = (t) => {
  const looped = { streak: 4, action: "bash", looped: true };
  t.eq(shouldFoldForLoop(looped, { seq: 1000 }).fire, true, "第一次该折");
  t.eq(shouldFoldForLoop(looped, { seq: 1000, lastLoopFoldSeq: 950 }).fire, false, "距离太近要限流");
  t.eq(shouldFoldForLoop(looped, { seq: 1000, lastLoopFoldSeq: 950 }).reason, "throttled", "理由要写清");
  t.eq(shouldFoldForLoop(looped, { seq: 2000, loopFoldCount: 3 }).fire, false, "折够 3 次就停手（防误判反复打断）");
  t.eq(shouldFoldForLoop({ streak: 1, looped: false }, { seq: 1000 }).fire, false, "不是循环就不折");
};

tests["C446 同一动作串但参数不同 ⇒ 不算循环（真机 3 个会话连续 5–6 次 edit 同一文件，全是 success）"] = (t) => {
  // 真机形状：edit(file_path=X) ×5，每次改的内容不同 ⇒ action 逐字相同、sig 不同
  const mk = (n, sigOf) => Array.from({ length: n }, (_, i) => ({ action: "edit(file_path=D:/a/b.md)", sig: sigOf(i), evidence: { end: i + 1 } }));
  const five = loopStreak(mk(5, (i) => `s${i}`));
  t.eq(five.looped, false, `5 次不同编辑不该算循环（streak=${five.streak}）`);
  // 真的把同一个编辑重复 5 次（sig 相同）⇒ 必须是循环
  const real = loopStreak(mk(5, () => "same"));
  t.eq(real.looped, true, "同一参数重复 5 次才算循环");
  t.eq(real.streak, 5, "streak 记 5");
};

tests["C446 老棋谱没有 sig ⇒ 回落 action（升级后行为不变，不会因为缺字段就失效）"] = (t) => {
  const legacy = ["a", "a", "a", "a"].map((a, i) => ({ action: a, evidence: { end: i + 1 } }));
  t.eq(loopStreak(legacy).looped, true, "没有 sig 时按动作串判（与 C444 一致）");
  // 混合（老边 + 新边）：不能把「同一个动作但一个有无 sig」拼成一条
  const mixed = [{ action: "a" }, { action: "a", sig: "x" }, { action: "a", sig: "x" }, { action: "a", sig: "x" }];
  t.eq(loopStreak(mixed).streak, 3, "有 sig 的 3 条连在一起；无 sig 的那条不算同键");
};
