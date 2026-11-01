/**
 * facts-prompt.test.mjs —— 摘要指令的回归（2026-11-02，C39）
 *
 * 摘要指令是**唯一**允许带行为约束的地方（boundary-audit 的 ALLOW 只放行
 * `src/rooms/facts-prompt.mjs`）：它的读者是摘要模型，不是会话模型。
 *
 * C39 新增：`preGraph`（本段历史早于棋谱，没有任何节点 id 可引用）时，指令必须**明说**
 * 「只按 seq 引用、不许编造 nN」——否则重启续跑的历史会让模型引出不存在的节点，
 * 幻觉探针（foldMarks[i].quality.unknownIds）就会记一笔。
 */

import { buildChessInstruction, extractConstraintsBlock } from "../src/rooms/facts-prompt.mjs";

export const tests = {};

const FACTS = [
  "ROOT_USER_REQUEST_VERBATIM >>",
  "把设置改回侧边栏显示",
  "<< END ROOT_USER_REQUEST (seq 9)",
  "CONSTRAINTS_VERBATIM:",
  "* 不要动 prod 配置",
  "FAILED_ATTEMPTS (1 listed of 1; keep every line):",
  "* e3 | bash(curl) | exit 7 | seq 16-18",
].join("\n");

tests["F-1 指令带上事实块原文与折叠区间（事实块是权威输入）"] = (t) => {
  const text = buildChessInstruction({ facts: FACTS, shadowedStart: 9, shadowedEnd: 18 });
  t.includes(text, "把设置改回侧边栏显示", "ROOT 原文必须在");
  t.includes(text, "e3 | bash(curl) | exit 7 | seq 16-18", "失败边行必须在");
  t.includes(text, "authoritative", "必须声明事实块是权威输入");
  t.eq(extractConstraintsBlock(FACTS), "不要动 prod 配置", "约束抽取口径不变");
};

tests["F-2 preGraph=true ⇒ 明说「本段没有节点 id，只按 seq 引用」；false ⇒ 不出现"] = (t) => {
  const withFlag = buildChessInstruction({ facts: FACTS, shadowedStart: 8, shadowedEnd: 1019, preGraph: true });
  t.includes(withFlag, "predates the chess record", "preGraph 时必须提示本段早于棋谱");
  t.includes(withFlag, "NO node ids", "必须说清没有节点 id");
  t.includes(withFlag, "seq ranges only", "必须要求只按 seq 引用");
  t.eq((withFlag.match(/predates the chess record/g) ?? []).length, 1, "提示只许出现一次");

  const without = buildChessInstruction({ facts: FACTS, shadowedStart: 8, shadowedEnd: 1019, preGraph: false });
  t.eq(without.includes("predates the chess record"), false, "非 preGraph 不许出现该提示");
};

tests["F-3 契约要点仍在：约束逐字 / 失败边逐条 / 不许把 UNVERIFIED 升成事实"] = (t) => {
  const text = buildChessInstruction({ facts: FACTS, shadowedStart: 1, shadowedEnd: 9 });
  t.includes(text, "must be preserved word-for-word", "约束逐字保留");
  t.includes(text, "EVERY line under FAILED_ATTEMPTS", "失败边逐条保留");
  t.includes(text, "Never promote an UNVERIFIED_CLAIM", "不许把未验证升成事实");
  t.includes(text, "Never invent a node, an edge", "不许编造节点/边");
};

tests["C107 摘要 prompt 必须保留两条冗余保险（约束逐字 + 每条失败边）"] = (t) => {
  // 设计取舍：机械追加已经保证召回，prompt 仍要求模型复述 —— 这是**故意的冗余**（防线纵深）。
  // 任何「去重式优化」若删掉这两条规则，等于把「模型丢约束」的风险重新引回来
  // —— 见 docs/research/00 §11.3 对候选 #17（derivable 标记）的否决。
  const prompt = buildChessInstruction({
    facts: FACTS,
    shadowedStart: 1,
    shadowedEnd: 20,
    preGraph: false,
  });
  t.includes(prompt, "must be preserved word-for-word", "约束必须要求逐字保留（不许改写）");
  t.includes(prompt, "COPY every CONSTRAINTS_VERBATIM bullet", "必须要求把约束逐条抄进输出");
  t.includes(prompt, "EVERY line under FAILED_ATTEMPTS must appear in your output", "必须要求每条失败边都出现");
  t.includes(prompt, "Count them", "必须要求清点数量（防「看起来写了其实少一条」）");
  // 反向：这两条不许被「精简」成软性措辞
  t.eq(/MAY (summarize|paraphrase) (constraints|failed attempts)/i.test(prompt), false, "不许出现「可概括约束/失败」的软性措辞");
};
