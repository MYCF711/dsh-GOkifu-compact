/**
 * log-window.test.mjs —— 「该看哪几份会话日志」（C218）
 *
 * 判据来自一次真实事故：`doctor` 只看最新 6 份日志，01:12 那次真实 fold 落在第 7 份里，
 * 于是报告「最近压缩尝试 成功 0 / 失败 0」—— 仪器静默失效。三条性质必须钉住：
 *
 *   ① 窗口内发生过写入的日志**都要看**（哪怕它不是最新的 6 份）；
 *   ② 窗口内一份都没有时，仍然兜底看最新的 N 份（安静期不能显示"什么都没有"）；
 *   ③ 有上限（每份都要解 zstd，不能因为开了 200 个会话就慢 200 倍）。
 */

import { selectSessionLogs, DEFAULT_HEAD, DEFAULT_LIMIT } from "../scripts/log-window.mjs";

export const tests = {};

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** 造 n 份日志：第 i 份的 mtime = now - i 分钟。 */
function mkFiles(n, { startMs = NOW, stepMs = MIN } = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ file: `s${i}.zstd`, mtime: startMs - i * stepMs, session: `session-${i}` });
  return out;
}

tests["C218 时间窗优先：第 12 份日志里的 fold 也必须被看到（旧写法只看最新 6 份 ⇒ 漏）"] = (t) => {
  const files = mkFiles(12);
  // 12 份都在最近 1 小时内（每份差 1 分钟）⇒ 全部要看
  const picked = selectSessionLogs(files, { now: NOW, windowMs: HOUR, head: 6, limit: 24 });
  t.eq(picked.length, 12, "窗口内的日志必须全看，而不是只看最新 6 份");
  t.eq(picked[0].file, "s0.zstd", "仍然从新到旧");
  t.eq(picked.at(-1).file, "s11.zstd", "最老的那份也在");
  t.eq(picked.some((x) => x.file === "s11.zstd"), true, "第 12 份（真实事故里的「第 7 份」同款）必须被选中");
};

tests["C218 安静期兜底：窗口内一份都没有 ⇒ 仍然看最新的 6 份（不许显示「什么都没有」）"] = (t) => {
  // 全部都在 3 小时前：都在窗口外
  const files = mkFiles(10, { startMs: NOW - 3 * HOUR });
  const picked = selectSessionLogs(files, { now: NOW, windowMs: HOUR, head: DEFAULT_HEAD, limit: DEFAULT_LIMIT });
  t.eq(picked.length, DEFAULT_HEAD, "窗口内没有 ⇒ 兜底看最新 6 份");
  t.eq(picked[0].file, "s0.zstd", "兜底的也是从新到旧");
};

tests["C218 上限生效：窗口内 200 份也只取 24 份（解压成本可控）"] = (t) => {
  const files = mkFiles(200, { stepMs: 1000 }); // 200 份都在最近 200 秒内
  const picked = selectSessionLogs(files, { now: NOW, windowMs: HOUR, head: 6, limit: 24 });
  t.eq(picked.length, 24, "上限 24 份");
  t.eq(picked[0].file, "s0.zstd", "取的是最新的那批");
  t.eq(picked.at(-1).file, "s23.zstd", "到第 24 份为止");
};

tests["C218 边界：空列表 / 坏条目 / mtime 缺失 / 无 windowMs 都不抛"] = (t) => {
  t.eq(selectSessionLogs([], { now: NOW, windowMs: HOUR }).length, 0, "空输入 ⇒ 空输出");
  const messy = [
    { file: "a.zstd", mtime: NOW - MIN },
    { file: "b.zstd" }, // 没有 mtime
    null,
    { mtime: NOW }, // 没有 file
    { file: "c.zstd", mtime: NOW - 2 * HOUR },
  ];
  const picked = selectSessionLogs(messy, { now: NOW, windowMs: HOUR, head: 2, limit: 10 });
  t.eq(picked.some((x) => x.file === "a.zstd"), true, "窗口内的正常条目要选上");
  t.eq(picked.every((x) => typeof x.file === "string"), true, "坏条目不许带进结果");
  const noWindow = selectSessionLogs(mkFiles(3), { now: NOW, head: 2 });
  t.eq(noWindow.length, 3, "不传 windowMs ⇒ 不分窗口（cutoff = -∞），三条全在内");
};
