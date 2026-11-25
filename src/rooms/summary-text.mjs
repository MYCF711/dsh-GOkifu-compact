/**
 * summary-text.mjs —— 离线摘要文本的**存储去重**（C684 · P1 归位第六次搬迁）
 *
 * 一个纯函数，原来在 `src/engine.mjs` 的"质量测量"一带：
 * 如果这段文本**与上一次离线摘要逐字相同且区间相同**，就只存一个引用（`summaryTextRef`），
 * 不把同样的长文本在 graph.json 里写第二份 —— 省的是磁盘与 delta 帧体积。
 * 区间为空（NaN）时全等比较天然为 false ⇒ 落回"存一份"是安全的（注释原话，保留）。
 *
 * 不 import 任何宿主包、不读盘、不发网络。**搬迁纪律**：逐字复制，逻辑零改动。
 */

/**
 * ★ T29：foldMark 的**正文落盘**字段 —— 同一份正文在图里**只许出现一次**。
 *
 * C642 只让离线补折落了 `summaryText`，engine 的两条写回点（`compactIfNeeded` 的 pressure/auto/
 * overflow/archive/backfill/disposed/loop、`recordFoldMark` 的手动 `/compact`）一直没落（真机
 * 2026-11-04T22:02:10.932Z 那条 pressure 折痕只有 `summaryChars: 2418`、没有正文）。但**不能无脑写**：
 * `lastOfflineSummary` 是单槽的，最后一段折痕本来就和它共用同一个字符串（只留 `summaryTextRef`），
 * 同一份正文存两遍 = 磁盘成本翻倍。三选一：空正文 ⇒ 不写；同一段同一份已落在 `lastOfflineSummary`
 * ⇒ 只留引用；否则 ⇒ 存这一份。
 *
 * @param {{lastOfflineSummary?: any}} graph 棋谱
 * @param {{start?:number, end?:number}|null} range 本次折叠区间
 * @param {string} text 摘要正文（`_lastSummaryText` 的快照，不重算）
 * @returns {{summaryText:string}|{summaryTextRef:string}|{}} 要并进 foldMark 的字段
 */
export function summaryTextField(graph, range, text) {
  if (typeof text !== "string" || text === "") return {};
  const last = graph?.lastOfflineSummary;
  if (last === null || last === undefined || typeof last.text !== "string" || last.text !== text) {
    return { summaryText: text };
  }
  // 区间为空（NaN）时全等比较天然为 false ⇒ 落回「存一份」是安全的。
  const sameRange = Number(last?.range?.start) === Number(range?.start) && Number(last?.range?.end) === Number(range?.end);
  return sameRange ? { summaryTextRef: "lastOfflineSummary" } : { summaryText: text };
}
