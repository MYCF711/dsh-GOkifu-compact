/**
 * fold-protocol.test.mjs —— 「停止原因」这张协议表不许悄悄扩（C556）
 *
 * 由来（真机 2026-11-04）：C531 给分段折叠加了一个新的停止原因 `no-op`，
 * 但下游 `shouldTryOfflineFold` 的"放弃理由"白名单没同步 ⇒ **"空转 ⇒ 转离线"永远不会触发**。
 * 同一类错 C503 已经犯过一次（那时是 `timeout` 没进白名单）。
 *
 * 这类 bug 不会让任何测试变红 —— 它只是让功能在真机上静默不发生。
 * 所以这里把**协议表本身**钉住：新增一个 `stopped: "xxx"` 就必须在两处同时登记。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { shouldTryOfflineFold } from "../src/rooms/offline-fold.mjs";

export const tests = {};

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

/** 已知的停止原因 → 它的语义（也是文档）。 */
const KNOWN_STOPPED = {
  // 分段折叠（closeout-plan.mjs）
  deadline: "预算用尽（已折的段保留）",
  "no-op": "调用了但什么都没变 ⇒ **必须转离线**",
  error: "折叠抛错 ⇒ 看错误内容决定（surface 缺失要转离线）",
  done: "正常折完",
  // 离线补折（engine.mjs）
  busy: "同一会话已有人在补（不重试）",
  "no-log": "找不到会话日志",
  "empty-log": "日志为空",
  "no-range": "没有可折区间",
  "no-model": "拿不到模型",
  // ★ C600：后台定时器里宿主服务容器是 inactive 的（真机：cannot get required service "llm"）
  //   ⇒ 这一轮**不折**，等活跃回合拿句柄再折。它不是"失败"，是"时机不对"。
  "inactive-context": "后台定时器拿不到宿主服务 ⇒ 等活跃回合再折",
};

/** 从源码里抓出所有 `stopped: "xxx"` 字面量。 */
export function stoppedLiterals(source) {
  const out = new Set();
  for (const m of String(source ?? "").matchAll(/stopped:\s*"([a-z-]+)"/g)) out.add(m[1]);
  return [...out].sort();
}

tests["C556 每个 stopped 字面量都必须在协议表里登记"] = (t) => {
  const files = [
    "src/engine.mjs",
    "src/rooms/closeout-plan.mjs",
    "src/rooms/offline-fold.mjs",
    "src/rooms/closeout-backfill.mjs",
  ];
  const unknown = [];
  for (const rel of files) {
    const src = nodeFs.readFileSync(nodePath.join(ROOT, rel), "utf8");
    for (const lit of stoppedLiterals(src)) {
      if (!(lit in KNOWN_STOPPED)) unknown.push(`${rel}: ${lit}`);
    }
  }
  t.eq(
    unknown,
    [],
    `出现了没登记的停止原因（要么加进 KNOWN_STOPPED，要么想清楚它算不算"放弃"）：${unknown.join(", ")}`,
  );
};

tests["C556 「放弃」类原因必须能真的触发离线（不能只是登记了）"] = (t) => {
  const base = { closeout: null, tailEvents: 500, enabled: true, minEvents: 40 };
  // 这些是"在线折不了"的形状 —— 必须转离线
  for (const reason of ["no-op", "no-foldable-span", "timeout"]) {
    t.eq(shouldTryOfflineFold({ ...base, reason }).go, true, `${reason} 必须能转离线`);
  }
  // 这些是"离线自己也做不了"的形状 —— 不许再花钱
  for (const reason of ["no-log", "empty-log", "no-range", "no-model", "busy"]) {
    t.eq(shouldTryOfflineFold({ ...base, reason }).go, false, `${reason} 不该再转离线`);
  }
};

tests["C556 抓字面量的工具本身要能把 no-op 抓出来（反向验证）"] = (t) => {
  const sample = 'return { folded, stopped: "no-op", error: null };';
  t.eq(stoppedLiterals(sample), ["no-op"], "能抓到 no-op");
  t.eq(stoppedLiterals("stopped: `dynamic`"), [], "模板字符串不算字面量（不当成协议项）");
};
