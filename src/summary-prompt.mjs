/**
 * summary-prompt.mjs —— 棋谱摘要指令
 *
 * 与官方 compaction-basic 的差别（这是本插件的核心改造点之一）：
 *   官方：让模型从对话里「自己决定保留什么」→ 失败原因必然被当成噪音丢掉。
 *   本插件：把规则抽取的硬事实（根目标原话 / 约束 / 每条失败边 + 原因 + seq）
 *           作为 AUTHORITATIVE 输入塞进指令，模型只负责压缩表达与补写目标。
 *
 * 指令放在最后一条 user 消息里（不是单独 system），这样回放的前缀与真实请求
 * 逐字一致，提供方的 KV cache 能命中 —— 与官方实现同一策略。
 */

import { renderFacts } from "./ledger.mjs";

/**
 * 从 renderFacts 的文本里截取 CONSTRAINTS_VERBATIM 段。
 * 用途：摘要生成后**机械追加**到产物里 —— 不依赖模型遵守（实测 15 条失败边压力下模型会丢约束）。
 */
export function extractConstraintsBlock(facts) {
  const lines = String(facts ?? "").split("\n");
  const i = lines.findIndex((l) => l.trim() === "CONSTRAINTS_VERBATIM:");
  if (i < 0) return "";
  const out = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    if (lines[j].startsWith("* ")) out.push(lines[j].slice(2).trim());
    else break;
  }
  return out.join("\n");
}


export const CHESS_SUMMARY_OPEN = "<chess-fold>";
export const CHESS_SUMMARY_CLOSE = "</chess-fold>";

export function buildChessInstruction({ facts, shadowedStart, shadowedEnd, priorFold = false }) {
  const lines = [];
  lines.push(
    "You are the fold engine of a chess-record (棋谱) context system for an AI coding assistant. " +
      "Fold the conversation ABOVE into a compact record that lets another model resume the work with no loss of essential context.",
  );
  lines.push("");
  lines.push("The block below was extracted MECHANICALLY from the session log. It is authoritative.");
  lines.push("");
  lines.push(facts);
  lines.push("");
  lines.push("Rules that bind your output:");
  lines.push("- ROOT_USER_REQUEST_VERBATIM and CONSTRAINTS_VERBATIM must be preserved word-for-word. Never paraphrase a constraint: the difference between 必须 and 最好 is a different task.");
  lines.push(
    "- COPY every CONSTRAINTS_VERBATIM bullet into your 「## 目标」 section **before** you write anything else. " +
      "Count them: if the input lists N constraints, your output must contain N bullets. " +
      "实测：15 条失败边的压力下，模型曾把 3 条约束全丢 —— 约束丢失比失败边丢失更致命，因为它改变任务本身。",
  );
  lines.push("- If you must cut for length: cut narrative, cut pleasantries, cut redundant explanation — NEVER a constraint, NEVER a failed attempt.");
  lines.push("- EVERY line under FAILED_ATTEMPTS must appear in your output — one line each, with its reason and evidence seq. Never merge two of them, never drop one because it looks obsolete. They are why the next model will not walk into the same wall.");
  lines.push("- Never promote an UNVERIFIED_CLAIM to a verified fact. Only exit codes, test counts, diffs and explicit tool errors count as verification.");
  lines.push("- Never invent a node, an edge, a result, or a path.");
  lines.push("");
  lines.push("Output EXACTLY this Markdown structure. Keep every section, in order. Write \"(none)\" when empty — never drop a section.");
  lines.push("");
  lines.push("## 目标");
  lines.push("- <the user's current goal in 1-2 lines, then every constraint verbatim as its own bullet>");
  lines.push("");
  lines.push("## 棋谱（状态节点）");
  lines.push("- n<id> seq=<seq> 目标=<one line> 状态=<world8>/<constraint8>");
  lines.push("");
  lines.push("## 已探明死路（逐条保留，一条不许少）");
  lines.push("- e<id> \"<intent>\" → <reason> (evidence seq <a-b>)");
  lines.push("");
  lines.push("## 已验证事实");
  lines.push("- <fact + the external signal that proves it: exit 0 / N tests passed / file path written>");
  lines.push("");
  lines.push("## 未验证");
  lines.push("- <claim + why it is unproven>");
  lines.push("");
  lines.push("## 当前节点与下一步");
  lines.push("- 当前节点：n<id>（状态 <world8>/<constraint8>）");
  lines.push("- 下一步：<the single next action, directly in line with the most recent request>");
  lines.push("");
  lines.push("## 原始坐标");
  lines.push(`- 本段遮蔽 seq ${shadowedStart}-${shadowedEnd}；逐字原文仍在 DSH 会话日志中，需要时按 seq 回读。`);
  lines.push("");
  lines.push("Hard limits (a record over these limits counts as a failed fold):");
  // P1-9：旧文案「<1200 字符」与「每条失败边都必须出现」矛盾 —— 超过约 15 条死路就不可满足。
  lines.push(
    "- Length budget: about 40 characters per dead end plus 600 characters for everything else. " +
      "Never cut a dead end or a constraint to meet a length target — cut narrative instead.",
  );
  lines.push("- One line per dead end; no line longer than 120 characters.");
  lines.push("- No prose paragraphs. No restating the conversation. No section longer than 12 lines.");
  lines.push("");
  lines.push("Style:");
  lines.push("- Concise engineering prose. Narrative in Chinese; keep file paths, commands, error strings, identifiers, numbers and code fragments exactly as they appear.");
  lines.push("- Preserve user corrections faithfully — a correction outranks an earlier instruction.");
  lines.push("- Do NOT mention this summarization request, the compaction, or the checkpoint mechanism.");
  lines.push("- Output only the record text: do not call any tool, do not take any other action.");
  if (priorFold) {
    lines.push(
      `- The conversation above already contains a prior ${CHESS_SUMMARY_OPEN} record. Do NOT copy it verbatim: keep the lines that are still true (especially dead ends), drop what a newer fact supersedes, and merge newer information into one consolidated record under the same structure.`,
    );
  }
  return lines.join("\n");
}

/** 便利包装：直接从图生成指令。 */
export function buildInstructionFromGraph(g, { shadowedStart, shadowedEnd, priorFold = false, maxFailures = 200 }) {
  return buildChessInstruction({
    facts: renderFacts(g, { maxFailures }),
    shadowedStart,
    shadowedEnd,
    priorFold,
  });
}

/** 把摘要文本框成落盘的记录块（与官方 <compacted-summary> 并存，供 md 视图使用）。 */
export function frameChessSummary(summaryText) {
  return `${CHESS_SUMMARY_OPEN}\n${summaryText.trim()}\n${CHESS_SUMMARY_CLOSE}`;
}
