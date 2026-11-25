/**
 * summary-error.mjs —— 摘要失败的**分类与说人话**（C682 · P1 归位第四次搬迁）
 *
 * 三个纯函数，原来在 `src/engine.mjs` 的"错误与重试"类里：
 *   · `isPermanentSummaryError` —— 官方错误码表里哪些是"重试也没用"；
 *   · `classifySummaryError` —— 分成 permanent / rate-limit / overload / timeout / other；
 *     顺序有讲究：先分「不是我们的错」那几类，再谈提示词/参数（C467 真机 2026-11-03T05:38 的教训）；
 *   · `summaryErrorHint` —— 每一类给一句**能照着做**的话（改提示词 / 查分组 / 充值 / 调超时）。
 *
 * 全部不碰 this / ctx / 磁盘 / 网络。**搬迁纪律**：逐字复制，逻辑零改动；engine 保留 import + export。
 */

export function isPermanentSummaryError(message) {
  const text = String(message ?? "");
  if (text === "") return false;
  // ★ C349：官方错误码表（<https://api-docs.deepseek.com/quick_start/error_codes>，2026-11-03 抓）：
  //   400 请求格式错 / 401 鉴权失败 / 402 余额不足 / **422 参数非法** ⇒ **都是永久的**，重试没用；
  //   429 限流 / 500 服务错 / 503 过载 ⇒ 官方明说"稍后重试"，**不能**判成永久。
  //   旧版漏了 422（"invalid parameters"），遇到会白白重试到上限。
  // ★ C382：**「上下文超长」的 400 不是永久错误**。官方 Responses API 文档明说：
  //   `truncation 不支持 —— Requests exceeding the context window return a 400 error`。
  //   这种 400 的正确反应是「再折一段」，而不是"永久失败 + 退避到上限"。
  //   实测里它可能以 400 / invalid_request_error / "context length" / "too long" 等形式出现。
  if (/context[ _-]?length|context window|maximum context|too many tokens|too long|exceeds? the context/i.test(text)) return false;
  if (/(^|[^0-9])(429|500|503)([^0-9]|$)/.test(text)) return false; // 先排除可重试的，防误伤
  return /(^|[^0-9])(400|401|402|422)([^0-9]|$)/.test(text)
    || /invalid format/i.test(text)
    || /invalid parameters/i.test(text)
    || /authentication fails?/i.test(text)
    || /insufficient balance/i.test(text)
    || /invalid api key/i.test(text);
}

/**
 * ★ C350：把摘要错误分成**退避档位**用的几类。
 *
 * 官方口径（`quick_start/error_codes`）：429 是"放慢节奏"、500/503 是"稍后重试" ——
 * 它们**都不该用同一档退避**：限流时立刻重试等于继续撞墙，过载时该早一点再试。
 *
 * @param {unknown} message
 * @returns {"permanent"|"rate-limit"|"overload"|"timeout"|"other"}
 */
export function classifySummaryError(message) {
  const text = String(message ?? "");
  if (text === "") return "other";
  // ★ C467：**先分流"不是我们的错"的那几类**，再谈提示词/参数。
  //   顺序很重要：`isPermanentSummaryError` 里也认 400，若放在前面，普通 400 会被它吞成 permanent，
  //   就再也分不出「被路由到别的上游」这种最需要人干预的情况（真机 2026-11-03T05:38 那次就是）。
  if (/(^|[^0-9])402([^0-9]|$)/.test(text) || /insufficient balance|余额/i.test(text)) return "balance";
  if (/上游返回|upstream returned|Lingxi|灵犀/i.test(text)) return "upstream-routing";
  if (/(^|[^0-9])429([^0-9]|$)/.test(text) || /rate limit/i.test(text)) return "rate-limit";
  if (/(^|[^0-9])(500|503)([^0-9]|$)/.test(text) || /overload|server error/i.test(text)) return "overload";
  if (/timeout|timed out|aborted|etimedout/i.test(text)) return "timeout";
  // ★ C497：422 已经是 permanent（见 isPermanentSummaryError）—— 这里**不动**分类，
  //   只把"该怎么读"写进提示：400 与 422 都是"改请求"，不是"等一会儿"。
  if (/(^|[^0-9])400([^0-9]|$)/.test(text) || /invalid format|invalid_request/i.test(text)) return "invalid-request";
  if (isPermanentSummaryError(text)) return "permanent";
  return "other";
}

/**
 * ★ C467：每类错误**该做什么**（一句话，给 doctor 与日志直接用）。
 * @param {string} kind
 * @returns {string}
 */
export function summaryErrorHint(kind) {
  if (kind === "upstream-routing") return "模型组把请求路由到了别的上游 ⇒ 查 magpie 分组/换非 group 模型；改提示词没有用";
  if (kind === "balance") return "余额不足（402）⇒ 充值是唯一解；期间走规则摘要";
  if (kind === "invalid-request") return "400/422 先看错误正文里的上游名字，再查 max_tokens 是否超过该模型上限（422 通常是参数本身不合法）";
  if (kind === "rate-limit") return "限流 ⇒ 放慢节奏（已加最小等待）";
  if (kind === "overload") return "上游过载 ⇒ 稍后重试";
  if (kind === "timeout") return "超时 ⇒ 调大 closeoutTimeoutMs 或减小单段上限";
  if (kind === "permanent") return "永久性错误（含 422 参数错误）⇒ 已强制走规则摘要；要改的是请求本身，不是等一会儿";
  return "";
}
