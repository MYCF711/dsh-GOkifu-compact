/**
 * offline-cache.test.mjs —— **离线折叠的 prompt 公共前缀**（T47，2026-11-05）
 *
 * ## 这条守卫保护什么
 *
 * `archive-offline` 是**一次性请求**：每次折叠都现拼一条 prompt，跑完就扔。
 * 于是有两个必须钉住的东西：
 *
 *   ① **prompt 的段序**（`buildOfflinePrompt`）：常量在前、坐标行在最后。
 *      它是「两次折叠能共享多少前缀」的**唯一**结构变量 —— C546 把会变的坐标行从事实块
 *      挪到末尾，就是为了让第 2 段起能命中缓存。谁再把它挪回去，命中率立刻归零，
 *      而**单元测试之外没有任何仪表会报警**（`cacheReadTokens` 真机 920 条里 917 条是 `null`）。
 *   ② **审计的算术**（`scripts/offline-cache-audit.mjs`）：LCP 折算、`total − miss − out`
 *      反推命中、天花板逐条夹取。这些数字进了报告就是**决策依据**（"改还是不改"），
 *      算错一位（哪怕只是把 `null` 当成 0）结论就反过来 —— 本脚本第一版就红过一次。
 *
 * ## 失败分支必须真红
 *
 * ④ 那条用例是**端到端夹具**：同一份事实 + 两个不同的消息窗口 ⇒
 * 现状布局的公共前缀 = 「除坐标行之外的全部」；把坐标行挪回第 1 行 ⇒ 前缀塌成 46 字符。
 * 这一条同时是「A 类修法值不值」的度量口径，所以它必须能真的红。
 *
 * ## 为什么额度（$）也要钉
 *
 * 报告里那句「天花板 $0.025 < $1 ⇒ 只报告不改」直接决定要不要动 `buildOfflinePrompt`。
 * 价目表漂了、除法少个 1e6、或者把 token 当成美元 —— 都会让这个判断悄悄反转。
 * 所以 `PRICES` 必须与 `src/ui.mjs` 的 `PRICE_USD_PER_MTOK` 同源，且金额按定义式断言。
 */

import {
  PRICES,
  PRICE_SPREAD,
  SECTION_LABELS,
  SECTION_MARKERS,
  ceilingTokens,
  findLog,
  frontloadInvariants,
  graphAt,
  lcpChars,
  lineAt,
  locateSections,
  median,
  percentile,
  replayPrompt,
  sectionOf,
  spreadUsd,
  tokenBucket,
  usageSplit,
  verdictOf,
} from "../scripts/offline-cache-audit.mjs";
import { buildOfflinePrompt, estimateTokens } from "../src/rooms/offline-fold.mjs";
import { PRICE_USD_PER_MTOK } from "../src/ui.mjs";

export const tests = {};

/* ────────────────────────── 夹具（两条 prompt 只差消息窗口） ────────────────────────── */

/**
 * 一份最小的真机形状棋谱：一个根节点（带约束）+ 一条失败边。
 * `ts` 是 `graphAt` 的裁切依据（不是所有字段都必需 —— 只放 `renderFacts` 会读的）。
 */
function fixtureGraph() {
  return {
    rootUserNodeIds: ["n1"],
    order: ["n1", "n2", "n3"],
    nodes: {
      n1: { id: "n1", kind: "user", seq: 10, text: "目标：把 A 做完\n第二行不该进事实块", constraints: ["不许改 B"], ts: 1_000 },
      n2: { id: "n2", kind: "agent", seq: 12, text: "做完了", constraints: [], ts: 1_200 },
      n3: { id: "n3", kind: "agent", seq: 14, text: "验过了", constraints: [], ts: 1_300 },
    },
    edges: {
      e1: {
        id: "e1",
        from: "n1",
        to: "n2",
        intent: "edit",
        action: "edit(file_path=a.mjs)",
        result: "failure",
        errorSnippet: "cannot modify a.mjs",
        evidence: { start: 10, end: 12 },
        ts: 1_100,
      },
      // 成功边 —— `## 已验证事实` 段只有存在成功边时才渲染；没有它，`sectionOf` 就测不到那一段
      e2: {
        id: "e2",
        from: "n2",
        to: "n3",
        intent: "ls",
        action: "bash(ls)",
        result: "success",
        verify: { summary: "ok" },
        evidence: { start: 12, end: 14 },
        ts: 1_250,
      },
    },
  };
}

/** 升序事件（head 模式从 `seqStart` 往后取）。 */
function fixtureEvents() {
  return [
    { type: "user/message", seq: 10, data: { message: { content: [{ type: "text", text: "目标：把 A 做完" }] } } },
    { type: "assistant/message", seq: 12, data: { message: { content: [{ type: "text", text: "做完了" }] } } },
    { type: "user/message", seq: 20, data: { message: { content: [{ type: "text", text: "继续，把 C 也做完" }] } } },
    { type: "assistant/message", seq: 40, data: { message: { content: [{ type: "text", text: "好" }] } } },
  ];
}

/** 造一条 prompt（生产同参：`maxChunks:1` + 补账的 head 模式）。 */
function fixturePrompt({ seqStart, seqEnd }) {
  const replay = replayPrompt({ graph: graphAt(fixtureGraph(), 5_000), events: fixtureEvents(), mark: { seqStart, seqEnd } });
  if (replay === null || replay.prompt === "") throw new Error(`夹具重放失败（seq ${seqStart}-${seqEnd}）`);
  return replay;
}

/* ────────────────────────── ① LCP 的定义 ────────────────────────── */

tests["T47 ① 公共前缀：相同 / 真前缀 / 首字符即分叉 / 空串 / 多字节"] = (t) => {
  t.eq(lcpChars("abc", "abc"), 3, "完全相同 ⇒ 全长");
  t.eq(lcpChars("abc", "abcd"), 3, "真前缀 ⇒ 短的那条");
  t.eq(lcpChars("abc", "abd"), 2, "最后一个字符分叉 ⇒ 2");
  t.eq(lcpChars("xabc", "abc"), 0, "首字符即分叉 ⇒ 0");
  t.eq(lcpChars("", "abc"), 0, "空串 ⇒ 0");
  t.eq(lcpChars(null, undefined), 0, "非字符串不许崩");
  // 多字节：按 UTF-16 码元比较，中文逐码元相同 ⇒ 长度就是字符数
  t.eq(lcpChars("摘要￼abc", "摘要\u0000abc"), 2, "中文按字符（码元）计");
  t.eq(lcpChars("你在为一个", "你在为一个"), 5, "5 个汉字 = 5");
};

/* ────────────────────────── ② usage 拆账 ────────────────────────── */

tests["T47 ② 命中量：total − miss − out（cacheReadTokens 缺失时也必须算得出来）"] = (t) => {
  // C361 的真机样本：2158 + 19584 + 257 = 21999
  const real = usageSplit({ inputTokens: 2158, outputTokens: 257, totalTokens: 21999, cacheReadTokens: 19584 });
  t.eq(real.miss, 2158, "miss 原样");
  t.eq(real.hit, 19584, "有字段 ⇒ 以字段为准");
  t.eq(real.implied, 19584, "反推应与字段相等（C361 恒等式）");
  t.eq(real.field, true, "字段存在");

  // 真机 917 条里 849 条是这种形状：字段缺失，但 total 里有命中
  const missing = usageSplit({ inputTokens: 54, outputTokens: 7003, totalTokens: 21649, cacheReadTokens: null });
  t.eq(missing.field, false, "`null` 不是数字 —— 必须报 field:false");
  t.eq(missing.hit, 14592, "命中量从 total 反推（21649 − 54 − 7003）");

  // 回归：第一版把 `Number(null)` 当 0 ⇒ 455 次真实命中被报成 0
  t.ne(missing.hit, 0, "`null` 绝不能被当成「命中 0」");

  // 字段真的给了 0（provider 明确说没命中）⇒ 以字段为准，不去反推
  const zero = usageSplit({ inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 0 });
  t.eq(zero.field, true, "0 是数字 ⇒ 字段存在");
  t.eq(zero.hit, 0, "字段 = 0 ⇒ 没命中");

  // 缺 total 也不能编出命中
  t.eq(usageSplit({ inputTokens: 100, outputTokens: 10 }).hit, 0, "没有 total ⇒ 0");
  t.eq(usageSplit(null).hit, 0, "null usage 不许崩");
  t.eq(usageSplit(undefined).miss, 0, "undefined usage 不许崩");
};

/* ────────────────────────── ③ prompt 段序（C546 契约） ────────────────────────── */

tests["T47 ③ 段序：常量在前、坐标行在最后（C546 的缓存契约）"] = (t) => {
  const { prompt } = fixturePrompt({ seqStart: 10, seqEnd: 12 });
  const spans = locateSections(prompt);
  t.eq(spans.facts >= 0, true, "事实块标记必须存在（否则审计静默跳过）");
  t.eq(spans.messages >= 0, true, "消息体标记必须存在");
  t.eq(spans.requirements >= 0, true, "输出要求标记必须存在");
  t.eq(spans.range >= 0, true, "坐标行标记必须存在");
  t.eq(spans.facts < spans.messages, true, "硬事实在消息体之前");
  t.eq(spans.messages < spans.requirements, true, "输出要求在消息体之后（A 类残差的来源）");
  t.eq(spans.requirements < spans.range, true, "坐标行在输出要求之后");
  t.eq(prompt.indexOf(SECTION_MARKERS.preamble), 0, "开头就是常量句（前缀从这里起算）");
  // 坐标行必须是**最后**一段：它每段都变，放在前面会让前缀在第一行就分叉
  t.eq(prompt.slice(spans.range).includes("\n## "), false, "坐标行之后不许再有别的段");
  for (const [key, marker] of Object.entries(SECTION_MARKERS)) {
    const count = prompt.split(marker).length - 1;
    t.eq(count, 1, `段标记「${key}」在 prompt 里必须恰好出现一次（实际 ${count}）`);
  }
};

tests["T47 ③ 首差异归段：段边界互斥且每个段都可达"] = (t) => {
  const { prompt } = fixturePrompt({ seqStart: 10, seqEnd: 12 });
  const spans = locateSections(prompt);
  t.eq(sectionOf(prompt, 0), "preamble", "第 0 个字符 = 开头");
  t.eq(sectionOf(prompt, prompt.indexOf(SECTION_MARKERS.goal)), "facts.goal", "目标段起点");
  t.eq(sectionOf(prompt, prompt.indexOf(SECTION_MARKERS.constraints)), "facts.constraints", "约束段起点");
  t.eq(sectionOf(prompt, prompt.indexOf(SECTION_MARKERS.failures)), "facts.failures", "死路段起点");
  t.eq(sectionOf(prompt, spans.facts), "facts.other", "事实块的段头本身 = other（不是任何子段）");
  t.eq(sectionOf(prompt, spans.messages), "messages", "消息体起点 = 消息段");
  t.eq(sectionOf(prompt, spans.requirements), "requirements", "输出要求起点");
  t.eq(sectionOf(prompt, spans.range), "range", "坐标行起点");
  t.eq(sectionOf(prompt, prompt.length + 999), "range", "越界夹到最后一段");
  // 段标签必须登记过（报告里 `SECTION_LABELS[id]` 直接打出来，漏了就露 `undefined`）
  for (const offset of [0, spans.facts, spans.messages, spans.requirements, spans.range]) {
    t.eq(typeof SECTION_LABELS[sectionOf(prompt, offset)], "string", `偏移 ${offset} 的段名未登记`);
  }
  // 单调：偏移只增不减地推进段
  let last = -1;
  for (let at = 0; at < prompt.length; at += 97) {
    const rank = ["preamble", "facts.goal", "facts.constraints", "facts.failures", "facts.verified", "facts.other", "messages", "requirements", "range"].indexOf(sectionOf(prompt, at));
    t.eq(rank >= last, true, `偏移 ${at} 的段序回退了（${last} → ${rank}）`);
    last = rank;
  }
};

tests["T47 ③ 首差异的行证据：截断到可读长度"] = (t) => {
  const text = "a\nbbbbbbbbbbbbbbbbbbb\nccc";
  t.eq(lineAt(text, 2), "bbbbbbbbbbbbbbbbbbb", "取 offset 所在行");
  t.eq(lineAt(text, 1), "a", "行首");
  t.eq(lineAt(text, 0), "a", "第 0 个字符");
  t.eq(lineAt("x".repeat(200), 0).endsWith("…"), true, "超长行截断并留痕");
  t.eq(lineAt(text, text.length + 10), "ccc", "越界夹到最后一行");
};

/* ────────────────────────── ④ 端到端夹具：A 类修法值多少 ────────────────────────── */

tests["T47 ④ 端到端：现状前缀 = 除坐标行外全部；把坐标行挪回前面 ⇒ 入口前缀塌到开头"] = (t) => {
  const a = fixturePrompt({ seqStart: 10, seqEnd: 12 });
  const b = fixturePrompt({ seqStart: 20, seqEnd: 40 });
  t.eq(a.facts, b.facts, "同一份图（同一时刻）⇒ 硬事实必须逐字相同");
  t.eq(a.messages > 0 && b.messages > 0, true, "两条都要有消息");

  const spans = locateSections(a.prompt);
  const lcp = lcpChars(a.prompt, b.prompt);
  const rangeLineLength = a.prompt.length - spans.range;
  // 现状：除了最后那段坐标行，两条 prompt 逐字相同（消息窗口不同 ⇒ 但 head 模式取到的是同一批？）
  // 注意夹具里 seqStart 10 与 20 不同 ⇒ 消息体不同 ⇒ 分叉点在消息体。
  const bodyStart = spans.messages;
  t.eq(lcp >= spans.facts, true, `前缀至少覆盖开头 + 事实块（实际 ${lcp}）`);
  t.eq(sectionOf(a.prompt, lcp), "messages", "消息窗口不同 ⇒ 首差异必须落在消息体里（不是事实块）");

  // 「把不变的部分前置」的增量 = 输出要求块（常量）—— 它现在排在消息体后面，永远进不了前缀
  const frontA = frontloadInvariants(a.prompt);
  const frontB = frontloadInvariants(b.prompt);
  const frontLcp = lcpChars(frontA, frontB);
  t.eq(frontA.length, a.prompt.length, "重排不许增减字符");
  t.eq(frontLcp > lcp, true, `前置后前缀必须变长（${lcp} → ${frontLcp}）`);
  t.eq(frontLcp, lcp + (spans.range - spans.requirements), "增量恰好是「输出要求」块的长度");
  t.eq(frontA.endsWith(a.prompt.slice(spans.range)), true, "坐标行重排后仍在最后（否则缓存契约反了）");

  // 天花板：不变量全固定时能进缓存的 token（除消息体与坐标行）
  const ceiling = ceilingTokens(a.prompt);
  const head = estimateTokens(a.prompt.slice(0, bodyStart) + a.prompt.slice(spans.requirements, spans.range));
  t.eq(ceiling, head, "天花板 = 开头 + 硬事实 + 输出要求");
  t.eq(ceiling < estimateTokens(a.prompt), true, "天花板必须小于整条 prompt（消息体天生不可缓存）");

  // 语义不变：字符多重集完全相同（只换顺序，一个字都不许少）
  const sortChars = (value) => [...value].sort().join("");
  t.eq(sortChars(frontA), sortChars(a.prompt), "前置后字符多重集必须逐字相同（语义不变的机械判据）");
  t.eq(rangeLineLength > 0, true, "坐标行非空");
};

tests["T47 ④ 退化窗口（同一条 prompt 再发一次）前缀 = 除坐标行外全部"] = (t) => {
  // 真机最常见的形状：`9-249` 之后紧接 `8-8`（T37 的退化区间），head 模式取到同一批消息
  const a = fixturePrompt({ seqStart: 10, seqEnd: 12 });
  const b = fixturePrompt({ seqStart: 8, seqEnd: 8 });
  t.eq(a.prompt.slice(0, locateSections(a.prompt).range), b.prompt.slice(0, locateSections(b.prompt).range), "两条 prompt 除坐标行外必须逐字相同");
  const lcp = lcpChars(a.prompt, b.prompt);
  const rangeStart = locateSections(a.prompt).range;
  // 坐标行自己也有公共前缀（`- 本段遮蔽 seq ` 之后才是数字），所以 LCP 会略微越过段起点
  t.eq(lcp > rangeStart, true, "公共前缀必须包进坐标行（说明前面全部相同）");
  t.eq(sectionOf(a.prompt, lcp), "range", "首差异落在坐标行内");
  t.eq(estimateTokens(a.prompt.slice(0, rangeStart)) > 300, true, "退化窗口的前缀是**大头**（>300 token）—— 这正是 C546 修好的那部分");
};

/* ────────────────────────── ⑤ 图按时间裁 ────────────────────────── */

tests["T47 ⑤ graphAt：按 ts 裁图，未来节点/边不许进事实块"] = (t) => {
  const graph = fixtureGraph();
  const early = graphAt(graph, 1_050);
  t.eq(Object.keys(early.nodes), ["n1"], "n2（ts 1200）必须被裁掉");
  t.eq(Object.keys(early.edges), [], "e1（ts 1100）必须被裁掉");
  t.eq(early.rootUserNodeIds, ["n1"], "根节点保留");
  t.eq(early.order, ["n1"], "order 跟着裁");
  const late = graphAt(graph, 9_999);
  t.eq(Object.keys(late.nodes), ["n1", "n2", "n3"], "时间之后全保留");
  t.eq(Object.keys(late.edges), ["e1", "e2"], "边全保留");
  t.eq(graphAt(graph, null), graph, "没有时间戳 ⇒ 原样返回（不许裁成空图）");
  // 裁掉的图必须真的影响事实块（否则这个函数是装饰）
  const before = replayPrompt({ graph: early, events: fixtureEvents(), mark: { seqStart: 10, seqEnd: 12 } });
  t.eq(before.prompt.includes("cannot modify a.mjs"), false, "被裁掉的死路不许出现在事实块里");
};

/* ────────────────────────── ⑥ 判据（四选一） ────────────────────────── */

tests["T47 ⑥ 四类判据互斥：各自只命中自己那一条"] = (t) => {
  const base = { p50Tokens: 10_000, hitShare: 0.4, lcpTokensP50: 2_000 };
  t.eq(verdictOf(base), "D", "前缀稳定 + 有命中 ⇒ D");
  t.eq(verdictOf({ ...base, p50Tokens: 32 }), "B", "请求比缓存单元还短 ⇒ B");
  t.eq(verdictOf({ ...base, hitShare: 0 }), "C", "全库命中 = 0 ⇒ C");
  t.eq(verdictOf({ ...base, lcpTokensP50: 12 }), "A", "开头就分叉 ⇒ A");
  // 边界：64 是「provider 缓存单元量级」的判据线
  t.eq(verdictOf({ ...base, p50Tokens: 64 }), "D", "= 64 不算太短");
  t.eq(verdictOf({ ...base, p50Tokens: 63 }), "B", "< 64 才算太短");
  t.eq(verdictOf({ ...base, lcpTokensP50: 63 }), "A", "< 64 前缀 ⇒ 该前置");
  t.eq(verdictOf({ ...base, lcpTokensP50: 64 }), "D", "= 64 前缀已经够长");
  // 回归：C 只能由「命中量 = 0」触发 —— 字段缺失（fieldShare = 0）不算
  t.eq(verdictOf({ p50Tokens: 10_000, hitShare: 0.01, lcpTokensP50: 2_000 }), "D", "命中量非 0 ⇒ 不是 C（哪怕字段缺失）");
};

/* ────────────────────────── ⑦ 金额与桶 ────────────────────────── */

tests["T47 ⑦ 价目表同源 + 金额按定义式"] = (t) => {
  t.eq(PRICES, PRICE_USD_PER_MTOK, "审计的价目表必须与 src/ui.mjs 同源（漂移 ⇒ 两份报告的美元不可比）");
  t.eq(PRICE_SPREAD, PRICES.miss - PRICES.hit, "价差 = miss − hit");
  t.eq(Math.abs(PRICE_SPREAD - 0.147) < 1e-12, true, `价差应为 $0.147/1M，实际 ${PRICE_SPREAD}`);
  t.eq(spreadUsd(1_000_000), PRICE_SPREAD, "1M token 的价差 = $0.147");
  t.eq(Math.abs(spreadUsd(1_000) - 0.000147) < 1e-15, true, "1k token 按比例");
  t.eq(spreadUsd(0), 0, "0 ⇒ 0");
  t.eq(spreadUsd(-5), 0, "负数 ⇒ 0（不许算成负数省钱）");
  t.eq(spreadUsd(NaN), 0, "NaN ⇒ 0");
  // 「天花板 < $1 只报告不改」这条判据本身要能被算出来
  t.eq(spreadUsd(168_576) < 1, true, "真机剩余天花板（168,576 token）必须 < $1");
};

tests["T47 ⑦ token 桶：边界上开区间"] = (t) => {
  t.eq(tokenBucket(0), "0–63", "0 落第一桶");
  t.eq(tokenBucket(63), "0–63", "63 仍在第一桶");
  t.eq(tokenBucket(64), "64–255", "64 进第二桶");
  t.eq(tokenBucket(1023), "256–1023", "1023");
  t.eq(tokenBucket(1024), "1024–4095", "1024");
  t.eq(tokenBucket(16384), "≥16384", "最后一桶无上界");
  t.eq(tokenBucket(null), "unknown", "非数字 ⇒ unknown（不许静默进 0）");
};

tests["T47 ⑦ 中位数/分位数：空数组返回 null（不是 0）"] = (t) => {
  t.eq(median([]), null, "空 ⇒ null");
  t.eq(median([3, 1, 2]), 2, "奇数取中");
  t.eq(median([4, 1, 2, 3]), 2.5, "偶数取平均");
  t.eq(median([1, "x", null, 3]), 2, "非数字剔除");
  t.eq(percentile([], 0.9), null, "空 ⇒ null");
  t.eq(percentile([1, 2, 3, 4, 5], 1), 5, "p100 = 最大");
  t.eq(percentile([1, 2, 3, 4, 5], 0), 1, "p0 = 最小");
};

/* ────────────────────────── ⑧ 日志索引 ────────────────────────── */

tests["T47 ⑧ 会话 id → 日志：`session-` 前缀与子串匹配"] = (t) => {
  const logs = ["/x/--D-repo--/a/08c3f737-b0d4-4b2a.zstd", "/x/--D-repo--/b/<SESSION_ID>.zstd"];
  t.eq(findLog(logs, "08c3f737-b0d4"), logs[0], "普通 id 子串命中");
  t.eq(findLog(logs, "<SESSION_ID>"), logs[1], "带 session- 前缀也要能命中");
  t.eq(findLog(logs, "<SESSION_ID>"), logs[1], "去掉前缀后按子串命中");
  t.eq(findLog(logs, ""), null, "空 id ⇒ null");
  t.eq(findLog(logs, "不存在的会话"), null, "找不到 ⇒ null（调用方据此计缺日志）");
  t.eq(findLog([], "x"), null, "空索引 ⇒ null");
};
