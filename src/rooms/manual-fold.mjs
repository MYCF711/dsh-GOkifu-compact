/**
 * manual-fold.mjs —— 手动压缩命令（`/fold`）的**纯决策层**（R17）
 *
 * 背景（2026-11-25，用户需求）：用户要一个**命令行里能敲**的压缩命令，
 * 在「自动压缩还没触发」的空闲时刻也能手动压一次。本插件的压缩算法与 DSH 原生
 * `/compact` 不同（棋谱增量 fold vs 官方 re-summarize），所以**不动原生 `/compact`**，
 * 另开一个命令（方案 2）。
 *
 * 为什么决策要单独成房间：命令处理里真正需要判据的只有三件事 ——
 *   ① 输入合不合法（`/fold` 不收参数）；
 *   ② 现在能不能压（回合开着 / 压缩锁在飞 / 没有可折区间 / 没到最小量）；
 *   ③ 压完怎么向用户交代（遮蔽了多少、省了多少 token、还剩多少）。
 * 这三件事全是**纯函数**，可以脱离宿主单测；engine 只负责把它们接到
 * `ctx.commands.register` 与 `compactRegion` 上。
 *
 * ★ 铁律（docs/上下文压缩-真理与项目铁律.md）：本房间**不产生任何事实** ——
 *   它只读调用方给的数字，不猜、不补、不编。拿不到的数一律 `null` 并如实说明，
 *   绝不把「没测到」写成「0」。
 *
 * 依赖：**零依赖**（不许 import 宿主包、engine、scripts、lib、其它房间）。
 */

/** 命令名（不带斜杠）。宿主 `COMMAND_NAME = /^[a-z][a-z0-9_-]*$/` ⇒ 必须全小写。 */
export const FOLD_COMMAND_NAME = "fold";

/**
 * 命令描述（宿主 discovery UI 里显示的那一句）。
 * 宿主硬要求：非空字符串；空串/非字符串会让 `commands.register` 直接抛 TypeError。
 */
export const FOLD_COMMAND_DESCRIPTION = "Compress older history now (kifu incremental fold)";

/** 用法提示（带参数时回这一句，与官方 `/compact` 的 USAGE 同形）。 */
export const FOLD_USAGE = "Usage: /fold (no arguments)";

/**
 * 手动折叠的失败分类（冻结）。
 * 与 R16 `manual-compact.mjs` 的 `MANUAL_COMPACT_KINDS` **刻意不同名**：
 * 那一套描述的是**宿主** `ManualCompactionError` 的 code，这一套描述的是
 * **我们自己的**入口在**调用宿主之前**就能判定的前置条件。
 */
export const MANUAL_FOLD_KINDS = Object.freeze([
  "args", // 带了参数
  "open-turn", // 回合还开着（宿主 compactRegion 的 owner=null 分支会抛）
  "busy-lock", // 上一次压缩还没结束
  "nothing-to-fold", // 没有可折区间（checkpoint 已在末尾 / surface 太小）
  "below-minimum", // 有区间但不够 minFoldTokens（摘要本身要花钱）
  "ok",
]);

/**
 * 解析命令输入：`/fold` 后面**不许**有任何参数。
 *
 * 为什么必须显式拒绝：宿主的 `rawInput` 是「命令名之后的原文，含分隔空白」，
 * 用户打 `/fold now` 时如果我们静默忽略参数，用户会以为「now 生效了」。
 * 官方 `/compact` 也是这么做的（`rawInput.trim().length > 0` ⇒ USAGE）。
 *
 * @param {string} rawInput 宿主给的 `invocation.rawInput`
 * @returns {{ok:true} | {ok:false, kind:"args", text:string}}
 */
export function parseFoldInput(rawInput) {
  const text = typeof rawInput === "string" ? rawInput : "";
  if (text.trim().length > 0) return { ok: false, kind: "args", text: FOLD_USAGE };
  return { ok: true };
}

/**
 * 判断「现在能不能压」。**只读入参，不做任何副作用**。
 *
 * 判据顺序是**故意的**（先报「更根本」的那一条，用户才知道该先做什么）：
 *   1. 压缩锁在飞 ⇒ busy-lock（此时连回合状态都可能正在变）
 *   2. 回合开着 ⇒ open-turn（宿主 owner=null 分支必抛，提前说清楚）
 *   3. 没有区间 ⇒ nothing-to-fold
 *   4. 区间不够大 ⇒ below-minimum
 *
 * @param {object} input
 * @param {boolean} [input.openTurn] 会话是否还有未结束的 turn
 * @param {boolean} [input.lockActive] 是否有未配对的 `compaction/start`
 * @param {{start:number,end:number,shadowedTokens:number}|null} [input.range] 规划出的区间
 * @param {number} [input.minFoldTokens] 最小可折量（0/未给 = 不设门槛）
 * @returns {{kind:string, ok:boolean, text:string, detail:object}}
 */
export function decideManualFold({ openTurn = false, lockActive = false, range = null, minFoldTokens = 0 } = {}) {
  const detail = {
    openTurn: openTurn === true,
    lockActive: lockActive === true,
    range: range === null || range === undefined ? null : { start: Number(range.start), end: Number(range.end) },
    shadowedTokens: range === null || range === undefined ? null : Number(range.shadowedTokens),
    minFoldTokens: Number.isFinite(Number(minFoldTokens)) ? Number(minFoldTokens) : 0,
  };
  if (detail.lockActive) {
    return {
      kind: "busy-lock",
      ok: false,
      text: "另一次压缩正在进行（compaction lock 已激活）—— 等它结束再执行 /fold。",
      detail,
    };
  }
  if (detail.openTurn) {
    return {
      kind: "open-turn",
      ok: false,
      text: "当前回合还开着 —— 手动压缩只允许在**已结束的回合**里执行。先等本轮跑完（或停止当前运行），再执行 /fold。",
      detail,
    };
  }
  if (detail.range === null) {
    return {
      kind: "nothing-to-fold",
      ok: false,
      text: "没有可折的历史（上一个 checkpoint 之后没有可折区间，或会话太短）—— 无需压缩。",
      detail,
    };
  }
  if (detail.minFoldTokens > 0 && Number.isFinite(detail.shadowedTokens) && detail.shadowedTokens < detail.minFoldTokens) {
    return {
      kind: "below-minimum",
      ok: false,
      text:
        `可折区间只有约 ${detail.shadowedTokens} tokens，低于最小量 ${detail.minFoldTokens} —— ` +
        "摘要本身要花钱，这次不值得压。想强压请调小 minFoldTokens。",
      detail,
    };
  }
  return { kind: "ok", ok: true, text: "", detail };
}

/**
 * 把一次**成功**的手动折叠渲染成一句人话（给命令结果用）。
 *
 * ★ 证据不增：这里每个数字都来自宿主返回的 `CompactionResult`，
 *   拿不到的（`shadowedTokenCount` 非有限数）就写「未知」，**不写 0**。
 *
 * @param {object} result 宿主的 `CompactionResult`
 * @param {number|null} [tokensAfter] 折叠后重新测得的上下文 token 数（拿不到给 null）
 * @returns {string}
 */
export function renderFoldSuccess(result, tokensAfter = null) {
  const seqs = Array.isArray(result?.shadowedSeqs) ? result.shadowedSeqs.length : null;
  const range = result?.shadowedRange ?? null;
  // ★ 证据不增：`Number(null)` 是 0、`Number(undefined)` 是 NaN —— 前者会把「没测到」
  //   渲染成「遮蔽约 0 tokens」。所以先判**原始值是不是数**，再谈有限性。
  const shadowedRaw = result?.shadowedTokenCount;
  const shadowed = typeof shadowedRaw === "number" && Number.isFinite(shadowedRaw) ? shadowedRaw : null;
  const after = typeof tokensAfter === "number" && Number.isFinite(tokensAfter) ? tokensAfter : null;
  const parts = [];
  parts.push(seqs === null ? "已压缩一段历史" : `已压缩 ${seqs} 条历史`);
  if (Number.isFinite(Number(range?.start)) && Number.isFinite(Number(range?.end))) {
    parts.push(`（seq ${Number(range.start)}–${Number(range.end)}）`);
  }
  if (shadowed !== null) parts.push(`，遮蔽约 ${shadowed} tokens`);
  else parts.push("，遮蔽 token 数未知");
  if (after !== null) parts.push(`；压缩后上下文约 ${after} tokens`);
  return parts.join("") + "。";
}

/**
 * 把「没有可折内容」渲染成人话 —— `compactRegion` 返回 null 时用。
 * @param {object} decision `decideManualFold` 的返回
 * @returns {string}
 */
export function renderFoldNoop(decision) {
  const kind = String(decision?.kind ?? "nothing-to-fold");
  if (kind === "below-minimum") return String(decision?.text ?? "");
  return "这次没有可折的内容（无需压缩）。";
}
