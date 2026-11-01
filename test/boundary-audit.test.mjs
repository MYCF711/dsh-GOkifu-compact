/**
 * boundary-audit.test.mjs —— 「压缩不得越权」机器审计的回归（2026-11-01，C15）
 *
 * 为什么要有这个测试：`scripts/boundary-audit.mjs` 是**判据本身**。判据错了两头都危险 ——
 *   · 太松：漏掉真正的越权（比如旧版 `continue or abandon` 就藏在 renderFacts 里）；
 *   · 太紧：把注释里的引述、摘要模型指令当越界，天天假红，最后没人看。
 * 所以两头都要钉住：能抓真问题、不抓注释、豁免清单只豁免该豁免的。
 */

import { auditRepo, scanSource, stripComments, isAllowed, ALLOW } from "../scripts/boundary-audit.mjs";

export const tests = {};

tests["B-1 行为指导出现在字符串字面量里 ⇒ 必须抓（含中文与英文两种写法）"] = (t) => {
  for (const bad of ['"下一步：接着改配置"', "'不要重试这条死路'", '"you should retry it"', '"OPTIONS (continue or abandon)"']) {
    const findings = scanSource(`const x = ${bad};`, { file: "src/x.mjs" });
    t.eq(findings.length >= 1, true, `必须抓到：${bad}（实际 ${JSON.stringify(findings)}）`);
    // C45/C46 起可能同时命中 retry-advice / epistemic-advice（同一句话两重越界），只要求其中命中行为指导
    t.eq(findings.some((f) => f.rule === "behavior-guidance"), true, `必须归类到 behavior-guidance：${JSON.stringify(findings)}`);
  }
};

tests["B-2 注释里的引述不算越界（我们的注释大量引用「旧版曾写：不要重试」）"] = (t) => {
  const source = `
    // 旧版这里写「下一步：继续」，属于越权 —— 所以删掉了
    /* 也不要重试：那是行为指导 */
    const ok = "最近一条用户消息（逐字摘录）";
  `;
  t.eq(scanSource(source, { file: "src/y.mjs" }).length, 0, "注释必须被剥掉，不许假红");
  t.includes(stripComments(source), "最近一条用户消息", "剥注释不改变正常代码内容");
};

tests["B-6 英文 retry 建议必须抓（C45：图例曾长期带 retry when / take it）"] = (t) => {
  for (const bad of ['"needs a permission — retry when it changes"', '"working edge e1 reaches it — take it"', '"retry only if retry-if breaks"']) {
    const findings = scanSource(`const x = ${bad};`, { file: "src/ledger.mjs" });
    t.eq(findings.length >= 1, true, `必须抓到：${bad}`);
    t.eq(findings[0].rule, "retry-advice", `归类必须是 retry-advice：${JSON.stringify(findings)}`);
  }
  // 纯事实写法不许误报
  const ok = scanSource('const x = "connection refused"; const y = "the required resource is absent";', { file: "src/ledger.mjs" });
  t.eq(ok.length, 0, `事实陈述不许假红：${JSON.stringify(ok)}`);
};

tests["B-7 认知指令必须抓（C46：treat as / you can 也是教模型怎么看待事实）"] = (t) => {
  for (const bad of ['"UNVERIFIED (ran) — treat as unproven"', '"you can continue from here"', '"make sure to re-read it"']) {
    const findings = scanSource(`const x = ${bad};`, { file: "src/ledger.mjs" });
    t.eq(findings.length >= 1, true, `必须抓到：${bad}`);
    t.eq(findings[0].rule, "epistemic-advice", `归类必须是 epistemic-advice：${JSON.stringify(findings)}`);
  }
};

tests["B-3 工具治理字样同样抓（permission: deny / sandbox_permissions）"] = (t) => {
  for (const bad of ['"permission: deny"', '"sandbox_permissions"', '"approval: ask"']) {
    const findings = scanSource(`const y = ${bad};`, { file: "src/z.mjs" });
    t.eq(findings.length >= 1, true, `必须抓到：${bad}`);
    t.eq(findings[0].rule, "tool-governance", `归类必须是工具治理：${JSON.stringify(findings)}`);
  }
};

tests["B-4 豁免清单只豁免登记过的 (文件, 规则) 组合"] = (t) => {
  t.eq(ALLOW.length >= 1, true, "至少登记了 facts-prompt 的摘要指令豁免");
  t.eq(isAllowed({ file: "src/rooms/facts-prompt.mjs", rule: "behavior-guidance" }), true, "摘要指令模板应被豁免");
  t.eq(isAllowed({ file: "src/rooms/ledger.mjs", rule: "behavior-guidance" }), false, "热清单/事实块不许豁免");
  t.eq(isAllowed({ file: "src/rooms/facts-prompt.mjs", rule: "tool-governance" }), false, "豁免按规则区分，不是整文件放行");
};

tests["B-5 真实仓库审计必须 0 条 —— 这是每次发版前要跑的门禁"] = (t) => {
  const { findings, scanned, allowed } = auditRepo();
  t.eq(findings.length, 0, `src/ 里不许有越界线索：${JSON.stringify(findings, null, 1)}`);
  t.eq(scanned >= 15, true, `应当扫到足够多的源文件（实际 ${scanned}）`);
  t.eq(Number.isFinite(allowed), true, "必须报告豁免条数（透明，不静默）");
  // 防回归：这条是 C15 审计自己抓到的真实残留（renderFacts 的 STALE_UNSETTLED 行）
  const ledger = scanSource('const a = `STALE_UNSETTLED: 3 edges (continue or abandon), NOT residue`;', { file: "src/rooms/ledger.mjs" });
  t.eq(ledger.length, 1, "`continue or abandon` 这类行动许可必须能被抓回来");
};
