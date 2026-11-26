/**
 * guard-source.mjs —— 事实守卫的**证据源**（C689 · P1 归位第八次搬迁）
 *
 * 守卫裁决要引用的证据 = **本段折叠区间内**的会话事件 `{seq, role, text}`。为什么不是全量：
 * 摘要只折叠这一段，模型能引用的 seq 也只能是这一段里出现过的；把区间外的事件也当证据，
 * 等于允许「拿别的段落的话给这一段背书」。
 *
 * 三个关键判据（连同踩坑史一起搬过来，别删）：
 *   · 必须按 `session.eventAt(seq)` 走**完整事件日志**，不能只走 `surface.nodes` ——
 *     surface 只收 message 类事件，`tool/call` 不在其上（真机 surfaceOp 恒 null），
 *     只走 surface 会把 tool/call 整类漏掉（P1-1 的根因）。
 *   · `user/message` 的 `role` 由宿主恒填 "user"，主体必须由 `source.kind` 派生
 *     （与 keeper 的注入分类**同一份判定**），否则子代理收尾/技能目录这些注入消息永远算成 user。
 *   · `tool/call` 的文本与离线证据源**同一份** `toolDigestLine` —— 不复制文本逻辑。
 *
 * 依赖：keeper 的 `injectionKind` / `messageText`，offline-fold 的 `toolDigestLine`。
 * 不碰 this / ctx / 磁盘 / 网络。**搬迁纪律**：逐字复制，逻辑零改动。
 */

import { injectionKind, messageText } from "./keeper.mjs";
import { toolDigestLine } from "./offline-fold.mjs";

/** 事件类型 → 主体（与 `fact-guard.mjs` 的 `SUBJECTS` 同一枚举）。 */
const GUARD_ROLE_BY_EVENT_TYPE = Object.freeze({
  "user/message": "user",
  "assistant/message": "assistant",
  "tool/result": "tool",
  // ★ AX-17（P1-1）：离线证据源（`offline-fold.mjs` 的 `GUARD_ROLE_BY_EVENT`）有这一条，
  //   在线以前缺 ⇒ 同一个 `evidenceSeq` 的 `tool/call` 候选 online REJECTED、offline SUPPORTED，
  //   违反「同输入同裁决」。补上后两条路径的事件类型 → 主体映射逐条相同。
  "tool/call": "tool",
  "system/message": "system",
});
const GUARD_ROLES = new Set(["user", "assistant", "tool", "harness", "system"]);
/** 证据源上限：一次 fold 的区间不会这么大，但它们是外部输入，不许撑爆内存。 */
const GUARD_MAX_EVENTS = 4000;
/** 值型事实进事实块的上限（一行一条，再多就变成回灌）。 */
/** 取事件携带的消息对象（`user/message` 的 event.data 本身就是消息，assistant/tool 在 data.message 里）。 */
function guardEventMessage(event) {
  const data = event?.data;
  if (data === null || typeof data !== "object") return null;
  if (data.message !== null && typeof data.message === "object") return data.message;
  if (typeof data.role === "string") return data;
  return null;
}

/** 取事件携带的 `source.kind`（`user/message` 在 `data.source`，assistant/tool 在 `data.message.source`）。 */
function guardEventSourceKind(event) {
  const data = event?.data;
  if (data === null || typeof data !== "object") return null;
  const direct = data.source?.kind;
  if (typeof direct === "string" && direct !== "") return direct;
  const nested = data.message?.source?.kind;
  if (typeof nested === "string" && nested !== "") return nested;
  return null;
}

function guardEventRole(event) {
  const type = String(event?.type ?? "");
  const message = guardEventMessage(event);
  const role = typeof message?.role === "string" ? message.role : null;
  // ★ AX-17（P0-2）：`user/message` 的 `role` **由宿主恒填 "user"** —— DSH 把子代理收尾
  //   （`subagent-settled`）、`agent-message`、`agent-instructions`、`runtime-context`、
  //   `skill-catalog`、`time-context`、`tool-jobs`、`chess-context`、`compact-checkpoint` 等
  //   注入消息也投递成 `user/message`（2026-11-07 真机日志实测 12 种 `source.kind`）。
  //   只看 `role` ⇒ 这类事件的主体永远是 `user`，主体混同判据对它们永不触发；
  //   模型写正确主体 `harness` 反而会被拒。主体改由 `source.kind` 派生：
  //   人类来源（`user` / `prompt` / `human`，与 keeper 的注入分类**同一份判定**）⇒ `user`，
  //   其余来源 ⇒ `harness`。没有 `source.kind` 的旧消息退回 `role`（旧行为逐字不变）。
  if (type === "user/message") {
    const kind = guardEventSourceKind(event);
    if (kind !== null) return injectionKind({ source: { kind } }) === null ? "user" : "harness";
  }
  if (role !== null && GUARD_ROLES.has(role)) return role;
  return GUARD_ROLE_BY_EVENT_TYPE[type] ?? null;
}

function guardEventText(event) {
  // ★ AX-17（P1-1）：`tool/call` 的文本与离线证据源**同一份** `toolDigestLine`
  //   （`offline-fold.mjs` 的 `buildGuardSource` 那一行）—— 不复制文本逻辑。
  if (String(event?.type ?? "") === "tool/call") {
    try {
      return toolDigestLine(event.data);
    } catch {
      return "";
    }
  }
  const message = guardEventMessage(event);
  if (message === null) return "";
  try {
    return messageText(message);
  } catch {
    return "";
  }
}

/**
 * 守卫的证据源 = **本段折叠区间内**的会话事件 `{seq, role, text}`。
 *
 * 为什么不是全量：摘要只折叠这一段，模型能引用的 seq 也只能是这一段里出现过的；
 * 把区间外的事件也当证据，等于允许「拿别的段落的话给这一段背书」（跨段引用）。
 * `range` 为空（宿主直调 / 单测直调 `summarize`）时退回 surface 全量 —— **不放水**：
 * 守卫生成的裁决里每条都带 `evidenceSeq`，读者能自己核对这段证据当时在不在。
 *
 * ★ AX-17：**导出给测试对拍** —— 这是在线路径唯一的证据源构造函数，离线路径的对拍
 * （`buildGuardSource`）必须与它逐字段相同，否则「同输入同裁决」只是口号。
 *
 * @param {object} session 宿主 session（读 `seq` 与 `eventAt(seq)`）
 * @param {{start:number,end:number}|null} range
 * @returns {Array<{seq:number, role:string, text:string}>}
 */
export function collectGuardEvents(session, range) {
  const events = [];
  const at = typeof session?.eventAt === "function" ? session.eventAt.bind(session) : null;
  if (at === null) return events;
  const start = Number.isFinite(range?.start) ? Math.max(0, Math.trunc(range.start)) : 0;
  // ★ AX-17（P1-1）：**必须按 seq 走完整事件日志，不能只走 `session.surface.nodes`**。
  //   DSH 的 surface 只收 message 类事件（`SURFACE_EVENT_TYPES` = system/developer/user/
  //   assistant message + tool/result）；`tool/call` **不在 surface 上**（真机日志 `surfaceOp`
  //   恒为 null）。只走 surface 会把 tool/call 整类漏掉 —— 那正是 P1-1 的根因
  //   （同一 seq 的 tool/call 候选 online REJECTED / offline SUPPORTED）。
  //   `session.eventAt(seq)` 读的是完整追加日志（`log[seq]`），所以按 seq 走才拿得到它们。
  const end = Number.isFinite(range?.end)
    ? Math.trunc(range.end)
    : Number.isSafeInteger(session?.seq) && session.seq > 0
      ? session.seq - 1
      : -1;
  for (let seq = start; seq <= end; seq += 1) {
    let event = null;
    try {
      event = at(seq);
    } catch {
      event = null;
    }
    if (event === null || event === undefined) continue;
    const role = guardEventRole(event);
    const text = guardEventText(event);
    if (role === null || text === "") continue;
    events.push({ seq, role, text });
    if (events.length >= GUARD_MAX_EVENTS) break;
  }
  return events;
}
