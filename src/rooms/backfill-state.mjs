/**
 * backfill-state.mjs —— 补账状态的**落盘**（C685 · P1 归位第七次搬迁）
 *
 * 为什么是三份文件（真机事故原文保留）：本机同时跑着多个 DSH 实例，它们**共享**同一个
 * `<chess-context>`。旧实现只写一个 `auto-backfill-state.json` ⇒ 实例之间**互相覆盖**：
 * 实测 02:30 写的是 `everyMs:600000`（10 分钟，新代码），02:34 被另一实例的
 * `everyMs:1800000`（30 分钟，旧代码副本）盖掉；文件里的 pid 每次都不一样，而且**读到时就已退出**。
 * ⇒「读一个共享状态文件判断运行状态」读到的是**最后写者**，不是**当前实例**。
 *
 * 现在每次落盘写三份：
 *   · `auto-backfill-state.<pid>.json` —— 按实例一份，谁写谁的，**互不覆盖**（权威来源）
 *   · `auto-backfill-state.latest.json` —— `{pid, at, file}` 索引，最后写者更新
 *   · `auto-backfill-state.json`        —— 旧版单文件，**只为兼容**（语义仍是最后写者）
 *
 * 读侧聚合在 `scripts/backfill-state.mjs`（默认取最新且存活的那份）。
 * **搬迁纪律**：主体与注释逐字复制，逻辑零改动。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";

/** 旧版单文件（兼容：老工具只认它；多实例会互相覆盖，所以新写侧另有按 pid 的一份）。 */
const LEGACY_BACKFILL_STATE = "auto-backfill-state.json";
/** 最新索引（`{pid, at, file}`，由最后写者更新 —— 让"一行读到最新"的读者不必扫目录）。 */
const LATEST_BACKFILL_STATE = "auto-backfill-state.latest.json";

/**
 * ★ 2026-11-05（真机事故）：本机同时跑着多个 DSH 实例，它们**共享**同一个 `<chess-context>`。
 *   旧实现只写一个 `auto-backfill-state.json` ⇒ 实例之间**互相覆盖**：实测 02:30 写的是
 *   `everyMs:600000`（10 分钟，新代码），02:34 被另一实例的 `everyMs:1800000`（30 分钟，旧代码副本）盖掉；
 *   文件里的 pid 每次都不一样，而且**读到时就已退出**。⇒「读一个共享状态文件判断运行状态」
 *   读到的是**最后写者**，不是**当前实例**；后续所有"这笔补账是谁跑的"都无法归因。
 *
 * 现在每次落盘写三份：
 *   · `auto-backfill-state.<pid>.json` —— 按实例一份，谁写谁的，**互不覆盖**（权威来源）
 *   · `auto-backfill-state.latest.json` —— `{pid, at, file}` 索引，最后写者更新
 *   · `auto-backfill-state.json`        —— 旧版单文件，**只为兼容**（老工具/老用例仍读它，语义仍是最后写者）
 *
 * 读侧聚合在 `scripts/backfill-state.mjs`（默认取最新且存活的那份；已退出 pid 的旧值不当现值）。
 *
 * @param {string} dir `<chess-context>`（测试传临时目录）
 * @param {{at?:number, pid?:number}} payload 状态内容（会补上 pid）
 * @returns {string|undefined} 按实例文件的绝对路径；`dir` 非法时 undefined
 */
export function writeAutoBackfillState(dir, payload) {
  if (typeof dir !== "string" || dir.trim() === "") return undefined;
  const pid = Number(payload?.pid) > 0 ? Number(payload.pid) : process.pid;
  const at = Number(payload?.at) > 0 ? Number(payload.at) : Date.now();
  const instanceName = `auto-backfill-state.${pid}.json`;
  const target = nodePath.resolve(dir);
  nodeFs.mkdirSync(target, { recursive: true });
  // 先写临时名再 rename：读侧可能正读到一半（Windows 上覆盖中的文件会读失败）。
  const put = (name, text) => {
    const file = nodePath.join(target, name);
    const tmp = `${file}.tmp-${pid}`;
    nodeFs.writeFileSync(tmp, text, "utf8");
    nodeFs.renameSync(tmp, file);
  };
  const body = JSON.stringify({ ...payload, pid }, null, 2);
  put(instanceName, body);
  put(LEGACY_BACKFILL_STATE, body);
  put(LATEST_BACKFILL_STATE, JSON.stringify({ pid, at, file: instanceName }, null, 2));
  return nodePath.join(target, instanceName);
}
