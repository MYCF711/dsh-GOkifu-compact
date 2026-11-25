/**
 * ledger-budget.mjs —— 热清单预算的**只读格式化**（C679 · P1 归位的第一次搬迁）
 *
 * 这三个函数原来在 `src/engine.mjs`（4689 行）里，属于"统计与日志"那一类：
 *   · 它们**不碰 this、不碰 ctx、不读盘、不发网络** —— 纯函数；
 *   · 全仓除了 engine 自己没有任何消费者（`grep` 实测 0 处），所以搬走是零风险。
 *
 * **搬迁纪律**：这次只搬位置，**一个字符的逻辑都没改**（主体逐字复制）。
 * engine.mjs 保留 re-export，任何外部 `mod.ledgerBudgetMetrics` 的写法继续有效。
 */

export function ledgerBudgetMetrics(ledger) {
  const fallback = ledger && typeof ledger.fallback === "string" ? ledger.fallback : "未采集";
  return {
    fallback,
    level: Number.isFinite(ledger?.level) ? ledger.level : null,
    tokens: Number.isFinite(ledger?.tokens) ? ledger.tokens : null,
    budgetMax: Number.isFinite(ledger?.budgetMax) ? ledger.budgetMax : null,
    overBudgetBy: Number.isFinite(ledger?.overBudgetBy) ? ledger.overBudgetBy : 0,
    // ★ 2026-11-01（调研候选 #2 / 建议 I）：出处覆盖率（边行带 (seq …) 的比例，应恒为 1）。
    //   只是**观测**：任何 <1 都说明某条降级路径在砍出处，必须能被告警发现，而不是等到模型胡猜。
    provenanceCoverage: Number.isFinite(ledger?.provenanceCoverage) ? ledger.provenanceCoverage : null,
    // ★ 2026-11-01：分项占用（七段字符数 + total）。让 doctor / ledger-budget.json 能回答
    //   「这几次渲染的钱花在哪一段」——否则 sections 又是个只算不消费的指标（第 2 轮的教训）。
    sections: ledger?.sections && typeof ledger.sections === "object" ? { ...ledger.sections } : null,
    // ★ C44：不可裁下限（root + constraints）的 token 数 —— 用来区分「渲染超预算」与「底线即超预算」。
    unyieldingTokens: Number.isFinite(ledger?.unyieldingTokens) ? ledger.unyieldingTokens : null,
    // ★ C65（专员审计 P2）：traceRecent 此前只被一个测试读取（写入即弃）。接进 doctor 统计：
    //   dropped-for-budget = 「为装进预算而退回了旧 TRACE 形态」的次数，是成本换信息的真实频率。
    traceRecent: typeof ledger?.traceRecent === "string" ? ledger.traceRecent : null,
    // ★ C67（专员审计 P2 收尾）：`renderMinimalLedger` 的 `minimal: true` 此前无任何消费者。
    //   把「零失败边时的最小清单」渲染次数接进统计 —— 它回答「有多少次注入还没走到失败清单这一步」。
    minimal: ledger?.minimal === true,
    // ★ C49：本次列了几条失败边 / 一共几条 —— 用来判断超预算时「还有没有更省的形式」。
    shownFailures: Number.isFinite(ledger?.shownFailures) ? ledger.shownFailures : null,
    failureCount: Number.isFinite(ledger?.failureCount) ? ledger.failureCount : null,
  };
}

/** 预算状态对应的日志级别：impossible 必须 error，over-budget / 出处覆盖率下降至少 warn，其余 info。 */
export function ledgerBudgetLogLevel(metrics) {
  if (!metrics || metrics.fallback === "impossible") return "error";
  if (metrics.fallback === "over-budget") return "warn";
  if (Number.isFinite(metrics.provenanceCoverage) && metrics.provenanceCoverage < 1) return "warn";
  return "info";
}

/** 一行可读的日志文案（含 overBudgetBy —— 验收明确要求）。 */
export function ledgerBudgetLogLine(metrics, sessionId = "") {
  const who = sessionId ? ` session=${sessionId}` : "";
  // 只在覆盖率掉下来时才追加这一段 —— 正常路径的日志文案与旧版逐字一致（不给日志刷屏）。
  const prov =
    Number.isFinite(metrics?.provenanceCoverage) && metrics.provenanceCoverage < 1 ? ` provenance=${metrics.provenanceCoverage}` : "";
  if (metrics.fallback === "over-budget") {
    return `chess-context: 热清单兜底超限（over-budget）${who} tokens=${metrics.tokens} budget=${metrics.budgetMax} overBudgetBy=${metrics.overBudgetBy} level=L${metrics.level}${prov}`;
  }
  if (metrics.fallback === "impossible") {
    return `chess-context: 热清单无解（impossible）${who} level=L${metrics.level} —— 连最省兜底都构造不出，这是 bug，不是预算问题${prov}`;
  }
  return `chess-context: 热清单预算正常（${metrics.fallback}）${who} tokens=${metrics.tokens}/${metrics.budgetMax}${prov}`;
}
