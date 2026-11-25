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

/**
 * 把一次渲染的 metrics 累计进统计对象（纯函数，便于单测；engine 的 `consumeLedgerBudget` 调用它）。
 *
 * 为什么单独抽出来：累计规则是**持久化文件的口径**（`ledger-budget.json` 被 doctor 读），
 * 旧文件没有 `provenanceMin` 字段 ⇒ 首次累计按 1 起算（1 = 没有观察到任何下降），
 * 不能因为旧文件缺字段就报成 0（那会让 doctor 误报「出处全丢了」）。
 */
export function accumulateLedgerBudget(stats, metrics, now = Date.now(), sessionId = "") {
  const target = stats ?? {};
  target[metrics.fallback] = (target[metrics.fallback] ?? 0) + 1;
  target.samples = (target.samples ?? 0) + 1;
  if (metrics.minimal === true) {
    target.minimalRenders = (Number.isFinite(target.minimalRenders) ? target.minimalRenders : 0) + 1;
  }
  if (metrics.traceRecent === "dropped-for-budget") {
    target.traceDropped = (Number.isFinite(target.traceDropped) ? target.traceDropped : 0) + 1;
  }
  target.maxOverBudgetBy = Math.max(Number.isFinite(target.maxOverBudgetBy) ? target.maxOverBudgetBy : 0, metrics.overBudgetBy ?? 0);
  // ★ C245：**over-budget 按成因归因**：超预算到底是「约束/根目标逐字保留那段就占了大半」，
  //   还是「失败边等可压缩内容占大头」？实测（session-example，579 tok / 预算 500）：
  //   CONSTRAINTS 198 + markers 图例 43 + ROOT 19 ⇒ 不可裁部分已占 45%，失败边只有 230。
  //   这两类的处置完全不同：前者只能改预算或改约束长度，后者才有"再压一点"的空间。
  if (
    metrics.fallback === "over-budget" &&
    Number.isFinite(metrics.tokens) &&
    metrics.tokens > 0 &&
    Number.isFinite(metrics.unyieldingTokens)
  ) {
    const by = target.overByCause && typeof target.overByCause === "object" ? { ...target.overByCause } : {};
    const cause = metrics.unyieldingTokens / metrics.tokens >= 0.4 ? "constraints" : "content";
    by[cause] = (Number.isFinite(by[cause]) ? by[cause] : 0) + 1;
    target.overByCause = by;
  }
  // ★ C244：**over-budget 按档位归因**。此前 1005 次超预算里只有 174 次有归因（floorOver 86 + irreducible 88），
  //   剩下 831 次「不知道为什么超」—— 而档位能直接回答：落在 L5（已是最省一份）就是设计内，
  //   落在 L0–L3 就说明还有压缩空间。一个字段把 831 次从"未知"变成"已知"。
  if (metrics.fallback === "over-budget" && Number.isFinite(metrics.level)) {
    const by = target.overByLevel && typeof target.overByLevel === "object" ? { ...target.overByLevel } : {};
    const key = `L${Math.max(0, Math.min(5, Math.trunc(metrics.level)))}`;
    by[key] = (Number.isFinite(by[key]) ? by[key] : 0) + 1;
    target.overByLevel = by;
  }
  // ★ C44：over-budget 里有多少次是「约束+根目标下限」本身就超预算（不可裁 ⇒ 设计内，不是渲染 bug）。
  if (
    metrics.fallback === "over-budget" &&
    Number.isFinite(metrics.unyieldingTokens) &&
    Number.isFinite(metrics.budgetMax) &&
    metrics.unyieldingTokens >= metrics.budgetMax
  ) {
    target.budgetFloorOver = (Number.isFinite(target.budgetFloorOver) ? target.budgetFloorOver : 0) + 1;
  }
  // ★ C49：超预算但**已经把失败边全列出来**（shownFailures === failureCount）⇒ 再省就只能删失败边，
  //   而「每条失败边都要出现」是合同红线（L4/L5 已经只在 >20/>10 条时才截）。这类超预算是设计内，
  //   与「明明有更省形式却仍超」区分开（后者才可能是渲染 bug）。
  if (
    metrics.fallback === "over-budget" &&
    Number.isFinite(metrics.shownFailures) &&
    Number.isFinite(metrics.failureCount) &&
    metrics.failureCount > 0 &&
    metrics.shownFailures >= metrics.failureCount
  ) {
    target.budgetIrreducible = (Number.isFinite(target.budgetIrreducible) ? target.budgetIrreducible : 0) + 1;
  }
  // ★ C48：超预算按会话归因 —— 只有一个会话反复超时，聚合数字会误导（"系统性问题" vs "这一个会话"）。
  //   有界保留前 8 个来源，避免 ledger-budget.json 无限增长。
  if (metrics.fallback === "over-budget" && typeof sessionId === "string" && sessionId.length > 0) {
    const by = target.overBySession && typeof target.overBySession === "object" ? { ...target.overBySession } : {};
    by[sessionId] = (Number.isFinite(by[sessionId]) ? by[sessionId] : 0) + 1;
    const entries = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8);
    target.overBySession = Object.fromEntries(entries);
  }
  if (Number.isFinite(metrics.provenanceCoverage)) {
    const prev = Number.isFinite(target.provenanceMin) ? target.provenanceMin : 1;
    target.provenanceMin = Math.min(prev, metrics.provenanceCoverage);
    if (metrics.provenanceCoverage < 1) target.provenanceLow = (Number.isFinite(target.provenanceLow) ? target.provenanceLow : 0) + 1;
  }
  // ★ 2026-11-01：分项占用按**样本累加**（平均 It 才代表"钱通常花在哪"）。
  //   只留最后一次会让"某次恰好被根目标占满"被误当成常态。
  if (metrics.sections && typeof metrics.sections === "object") {
    const acc = target.sectionsAvg && typeof target.sectionsAvg === "object" ? target.sectionsAvg : {};
    const next = { ...acc };
    for (const [key, value] of Object.entries(metrics.sections)) {
      if (Number.isFinite(value)) next[key] = (Number.isFinite(next[key]) ? next[key] : 0) + value;
    }
    target.sectionsAvg = next;
  }
  target.updatedAt = now;
  return target;
}
