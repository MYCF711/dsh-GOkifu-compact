/**
 * manual-compact.mjs —— 手动压缩（`/compact` → `compactNow`）失败诊断（R16）
 *
 * 背景（2026-10-31 实测，task-174）：宿主 `BasicCompactionEngine.compactNow` 在**回合还开着**时
 * 直接抛 `ManualCompactionError("busy", "manual compaction: the session already has an open turn")`；
 * 同一会话等回合关闭后再 `/compact` 就成功。原始错误只有一句英文，用户看不出「要先结束本轮」。
 *
 * 本房间只做一件事：把 `ManualCompactionError`（以及任意异常）翻译成分类 + 人话提示，
 * **原样保留 `code` 与 `cause`** —— 分类不改变任何控制流，也不改宿主的错误类型。
 *
 * 分类来源（从宿主 asar 反查，`dsh-compaction-basic/lib/index.js` 与 `dsh-compaction/lib/index.js`）：
 *   · busy（3 种文案）：open turn / idle agent + queued work / compaction lock already active
 *   · cancelled      —— `manual compaction was cancelled`
 *   · persistence    —— `durability checkpoint failed`（cause = flush 失败）
 *   · commit         —— `did not commit cleanly`（compaction/end 写失败）
 *   · changed        —— `the compacted history changed during`（SurfaceChangedError）
 *   · summary        —— `could not produce a smaller summary`
 *
 * 依赖：**零依赖**（纯函数；不许 import 宿主包、engine、scripts、lib）。
 */

/** 诊断分类（冻结）。`unknown` 之外的每一项都对应宿主的一条真实失败路径。 */
export const MANUAL_COMPACT_KINDS = Object.freeze([
  "open-turn",
  "idle",
  "busy-lock",
  "cancelled",
  "summary",
  "persistence",
  "commit",
  "changed",
  "unknown",
]);

/** 每个分类的人话提示（用户读这一句就知道下一步做什么）。 */
const HINTS = Object.freeze({
  "open-turn":
    "当前回合还开着（open turn）——手动压缩只允许在**已结束的回合**里执行。先等本轮跑完（或停止当前运行），再执行 /compact；自动压缩本轮内照常工作。",
  idle: "agent 还没空闲（有唤醒中的排队工作）——等它空闲后再执行 /compact。",
  "busy-lock": "另一次压缩正在进行（compaction lock 已激活）——等它结束（或先中断那次压缩）再重试。",
  cancelled: "这次手动压缩被取消了（signal abort）——重试即可；若反复被取消，检查上层是否在中断它。",
  summary: "摘要阶段失败或摘要没有变小——检查摘要模型是否可用、这段历史是否还有可压空间。",
  persistence: "提交后的落盘 flush 失败（durability checkpoint）——检查磁盘/权限；历史未被缩短，可重试。",
  commit: "提交阶段失败（compaction/end 写入失败）——历史未被缩短，可重试；反复失败请带原始错误报障。",
  changed: "压缩期间历史被改动了（SurfaceChangedError）——先停掉其它写入（别的 agent/工具），再重试。",
  unknown: "未分类的手动压缩失败——保留原始 code 与 cause 供排查。",
});

/** 从错误对象里取 message（任意类型都安全）。 */
function messageOf(error) {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  return String(error.message ?? "");
}

/** 从错误对象里取 code（宿主可能是字符串，也可能没有）。 */
function codeOf(error) {
  if (error === null || typeof error !== "object") return "";
  return typeof error.code === "string" ? error.code : "";
}

/**
 * 纯分类：只看 `code` / `message` / `name`，不做任何副作用。
 * @param {{code?:string,name?:string,message?:string}|string|null} error
 * @returns {"open-turn"|"idle"|"busy-lock"|"cancelled"|"summary"|"persistence"|"commit"|"changed"|"unknown"}
 */
export function classifyManualCompactError(error) {
  const code = codeOf(error);
  const message = messageOf(error);
  const name = typeof error === "object" && error !== null && typeof error.name === "string" ? error.name : "";
  if (name === "AbortError" || code === "cancelled") return "cancelled";
  if (code === "persistence") return "persistence";
  if (code === "commit") return "commit";
  if (code === "changed") return "changed";
  if (code === "summary") return "summary";
  if (code === "busy") {
    if (/open turn/i.test(message)) return "open-turn";
    if (/idle agent|queued work/i.test(message)) return "idle";
    if (/compaction (?:already )?in progress|lock is already active/i.test(message)) return "busy-lock";
    return "idle";
  }
  // code 缺失时按文案兜底（宿主/上层可能把 cause 原样抛出来）
  if (/open turn/i.test(message)) return "open-turn";
  if (/idle agent|queued work/i.test(message)) return "idle";
  if (/compaction (?:already )?in progress|lock is already active/i.test(message)) return "busy-lock";
  if (/cancelled/i.test(message)) return "cancelled";
  if (/durability checkpoint|persistence/i.test(message)) return "persistence";
  if (/did not commit cleanly|commit/i.test(message)) return "commit";
  if (/changed during/i.test(message)) return "changed";
  if (/smaller summary|summar/i.test(message)) return "summary";
  return "unknown";
}

/**
 * 把一次手动压缩失败翻译成「分类 + 人话 + 原始证据」。
 *
 * 返回值里 **`code` 与 `cause` 都是原始引用**（不是转述）——分类只读不改。
 *
 * @param {any} error 宿主抛出的异常（`ManualCompactionError` 或任意 Error）
 * @returns {{kind:string, code:string, name:string, message:string, hint:string, text:string, cause:any, causeMessage:string}}
 */
export function describeManualCompactError(error) {
  const kind = classifyManualCompactError(error);
  const code = codeOf(error);
  const name = typeof error === "object" && error !== null && typeof error.name === "string" ? error.name : typeof error === "string" ? "" : "";
  const message = messageOf(error);
  const cause = error !== null && typeof error === "object" ? error.cause : undefined;
  const causeMessage = messageOf(cause);
  const hint = HINTS[kind];
  const evidence = [`code=${code || "(none)"}`, name ? `name=${name}` : "", message ? `原始：${message}` : "", causeMessage ? `原因：${causeMessage}` : ""]
    .filter((part) => part.length > 0)
    .join("；");
  return {
    kind,
    code,
    name,
    message,
    hint,
    text: `手动压缩失败（${kind}）：${hint}${evidence ? `（${evidence}）` : ""}`,
    cause,
    causeMessage,
  };
}

/**
 * 把诊断**挂到原错误对象上**（不改类型、不改 code、不改 cause）：
 * 补 `diagnosis` / `rawMessage`，并把 `message` 换成人类可读的一句。
 * `unknown` 分类不改 message（原始信息可能更值钱），只挂 diagnosis。
 *
 * @param {any} error
 * @returns {{error:any, diagnosis:{kind:string,code:string,name:string,message:string,hint:string,text:string,cause:any,causeMessage:string}}}
 */
export function annotateManualCompactError(error) {
  const diagnosis = describeManualCompactError(error);
  if (error !== null && typeof error === "object") {
    try {
      error.diagnosis = diagnosis;
      error.rawMessage = diagnosis.message;
      if (diagnosis.kind !== "unknown") error.message = diagnosis.text;
    } catch {
      /* 冻结/只读的错误对象：放弃改写 —— 诊断绝不许把原始错误吞掉 */
    }
  }
  return { error, diagnosis };
}
