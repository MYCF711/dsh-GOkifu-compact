/**
 * test-instance-verify.test.mjs —— 把真 Engine + 真机日志 + 隔离 home 的四条验证固化成守卫。
 * 任一实际值偏离都会红；没有 skip，也不以「脚本自己说 pass」代替字段断言。
 */
import {
  verifySmallWindows,
  verifyFictitiousGap,
  verifyTransportClassification,
  verifyTransportRetry,
} from "../scripts/test-instance-verify.mjs";

export const tests = {};

tests["T63 真机 1–8 小缺口：真 Engine 合并成大窗口且不写 live 日志"] = async (t) => {
  const result = await verifySmallWindows();
  t.ok((result.cases ?? []).length > 0, `必须有真机小缺口样本：${JSON.stringify(result.actual ?? result)}`);
  for (const item of result.cases ?? []) {
    t.ok(item.legacyWindow.span >= 1 && item.legacyWindow.span <= 8, `旧窗口必须是 1–8：${JSON.stringify(item.legacyWindow)}`);
    t.ok(item.newMarks.length > 0, `${item.sessionId} 必须产生新折痕`);
    t.ok(item.newMarks[0]?.span >= 20, `${item.sessionId} 首条新折痕必须 >=20，实际 ${JSON.stringify(item.newMarks)}`);
    t.ok(item.newMarks.every((m) => m.span >= 9), `${item.sessionId} 不得再产出 1–8 折痕：${JSON.stringify(item.newMarks)}`);
    t.eq(item.sourceUnchanged, true, `${item.sessionId} 源日志前后 sha/size/mtime 必须不变`);
    t.ok(item.isolatedHome.includes(".harness-test-instance"), `隔离 home 路径不对：${item.isolatedHome}`);
  }
};

tests["T64 真机 <SESSION_ID>：seq 1–8 非消息事件的 uncoveredHead 8→0"] = async (t) => {
  const result = await verifyFictitiousGap();
  t.eq(result.actual?.leadingEvents, 8, "真机 seq 1–8 共 8 个事件");
  t.eq(result.actual?.leadingFoldable, 0, "seq 1–8 没有可折消息");
  t.eq(result.actual?.coveredStart, 9, "第一条可折消息必须在 seq 9");
  t.eq(result.actual?.legacyUncoveredHead, 8, "旧坐标差必须复现为 8（反事实分支）");
  t.eq(result.actual?.uncoveredHead, 0, "新实现只数可折事件，头部缺口必须为 0");
  t.eq(result.actual?.uncoveredTail, 0, "区间 1–8 也不得虚构尾部缺口");
  t.eq(result.sourceAfter?.unchanged, true, "<SESSION_ID> 源日志必须只读");
};

tests["T66 finish.kind=error + TRANSPORT：结局 offline:error 而非 empty-response"] = async (t) => {
  const result = await verifyTransportClassification();
  t.eq(result.actual?.foldNote, "offline:error", "传输错误分类");
  t.ne(result.actual?.foldNote, "offline:empty-response", "TRANSPORT 不得谎报空回答");
  t.includes(result.actual?.foldError ?? "", "TRANSPORT", "原始错误码必须保留");
  t.eq(result.actual?.folded, 0, "失败不得记成折过");
  t.eq(result.actual?.foldMarks, 0, "失败不得写 foldMark");
  t.eq(result.sourceAfter?.unchanged, true, "T66 源日志必须只读");
};

tests["T67 两次 TRANSPORT 后第三次成功：30/60s 退避、抖动与 deadline"] = async (t) => {
  const result = await verifyTransportRetry();
  const centered = result.cases?.centered;
  const jittered = result.cases?.jittered;
  t.eq(centered?.actual?.calls, 3, "中心抖动：必须真的发起第三次调用");
  t.eq(centered?.actual?.delays, [30_000, 60_000], "random=.5 时退避必须为 30s/60s");
  t.eq(centered?.actual?.allCallsBeforeDeadline, true, "中心抖动：所有调用必须在 deadline 前");
  t.eq(centered?.actual?.stopped, "done", "第三次成功后补账必须 done");
  t.eq(centered?.actual?.foldMarks, 1, "第三次成功必须落一条 foldMark");
  t.eq(jittered?.actual?.calls, 3, "端点抖动：必须真的发起第三次调用");
  t.eq(jittered?.actual?.delays, [24_000, 72_000], "random=0/1 必须产生 ±20% 抖动");
  t.eq(jittered?.actual?.allCallsBeforeDeadline, true, "端点抖动：所有调用必须在 deadline 前");
  t.eq(jittered?.actual?.stopped, "done", "端点抖动第三次成功必须 done");
  t.eq(centered?.sourceAfter?.unchanged, true, "中心抖动源日志必须只读");
  t.eq(jittered?.sourceAfter?.unchanged, true, "端点抖动源日志必须只读");
};
