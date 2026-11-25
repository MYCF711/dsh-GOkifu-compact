/**
 * backfill-route.mjs —— 补账子代理的**路由与结果判定**（C684 · P1 归位第六次搬迁）
 *
 * 两个纯函数，原来在 `src/engine.mjs` 的引擎类前面：
 *   · `backfillSubagentRoute` —— 按钮的一次性路由：**两个值都给了**才覆盖，否则完整继承父 agent 的当前路由
 *     （只给一个就覆盖 = 拿 provider 配另一个 model，是踩过的坑）；
 *   · `backfillSubagentOutcome` —— 子代理只负责生成摘要；**没正常完成 / 产出空摘要都算失败**，
 *     是否补折成功由离线折叠写回结果另行判定（别在这里提前宣布成功）。
 *
 * 不 import 任何宿主包、不读盘、不发网络。**搬迁纪律**：逐字复制，逻辑零改动。
 */

/** 按钮的一次性路由：两个值都给了才覆盖；否则完整继承父 agent 的当前路由。 */
export function backfillSubagentRoute(options = {}, parent = null) {
  const requestedProvider = String(options.summarizationProvider ?? options.provider ?? "").trim();
  const requestedModel = String(options.summarizationModel ?? options.model ?? "").trim();
  const explicit = requestedProvider !== "" && requestedModel !== "";
  const header = (() => {
    try {
      return parent?.session?.requestHeader?.()?.config ?? null;
    } catch {
      return null;
    }
  })();
  const currentProvider = String(header?.provider ?? parent?.options?.provider ?? "").trim();
  const currentModel = String(header?.model ?? parent?.options?.model ?? "").trim();
  return {
    provider: explicit ? requestedProvider : currentProvider,
    model: explicit ? requestedModel : currentModel,
    explicit,
  };
}

/** 子代理只负责生成摘要；是否补折成功由现有离线折叠写回结果另行判定。 */
export function backfillSubagentOutcome(result) {
  const text = String(result?.structured?.text ?? "");
  if (result?.stopReason !== "completed") {
    return { ok: false, text: "", error: `补折子代理未正常完成（${String(result?.stopReason ?? "unknown")}）` };
  }
  if (text.trim() === "") return { ok: false, text: "", error: "补折子代理没有产出摘要" };
  return { ok: true, text, error: null };
}
