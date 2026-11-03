/**
 * inject-tail.test.mjs —— replace 到底作废多少缓存（C460）
 *
 * 由来：doctor 一直说「replace = 改写 surface **中间**那条 ⇒ 从那里起前缀失配」，但没说"中间"在哪儿。
 * 实测（9 条清单消息 / 6 个会话）：**89% 的情况下清单就是请求里的最后一条**，后面 0 条 ——
 * 那时代价只有它自己。所以判据必须换成「替换点后面还有几条消息」。
 */
import { countAfterSeq, afterTailBucket } from "../src/rooms/hot-inject.mjs";

export const tests = {};

tests["C460 countAfterSeq：只数 surface 上位置更大的节点"] = (t) => {
  const session = { surface: { nodes: [10, 20, 30, 40] } };
  t.eq(countAfterSeq(session, 30), 1, "30 后面只有 40");
  t.eq(countAfterSeq(session, 40), 0, "最后一条后面 0 条（这正是真机 89% 的情形）");
  t.eq(countAfterSeq(session, 5), 4, "比谁都小 ⇒ 全在后面");
  t.eq(countAfterSeq({}, 10), 0, "没有 surface 不许抛");
  t.eq(countAfterSeq(session, NaN), 0, "非法 seq 不许抛");
};

tests["C460 afterTailBucket：分桶要能把「0 条」单独分出来（它和 1 条是不同的结论）"] = (t) => {
  t.eq(afterTailBucket(0), "0", "0 条单独一桶");
  t.eq(afterTailBucket(-3), "0", "负数（脏数据）归 0");
  t.eq(afterTailBucket(1), "1", "1 条");
  t.eq(afterTailBucket(2), "2", "2 条");
  t.eq(afterTailBucket(3), "3+", "3 条起归一桶（别让长尾撑爆统计表）");
  t.eq(afterTailBucket(99), "3+", "长尾");
  t.eq(afterTailBucket(NaN), "0", "非法值按 0（宁可算作「代价小」，也不能虚报风险）");
};
