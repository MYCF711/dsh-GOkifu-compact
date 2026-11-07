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

export function buildChessInstruction({ facts, shadowedStart, shadowedEnd, priorFold = false, preGraph = false }) {
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
  if (preGraph) {
    // ★ C39：重启续跑的历史可能**早于棋谱**（C30 的 preGraph）。这段没有任何节点 id 可引用 ——
    //   明说这一点，避免模型给不存在的 nN 编号（幻觉探针 unknownIds 会把它抓出来）。
    lines.push(
      "NOTE: the folded segment predates the chess record, so it has NO node ids. Cite it by seq ranges only; " +
        "never introduce a node id that is not listed in the authoritative block above.",
    );
    lines.push("");
  }
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
  // ★ 真机（2026-11-07）：对话里出现「上下文已到 ~87%，后面我只报退出码」，而同一时刻
  //   宿主状态栏是 39%。根因不是模型算错，是**摘要把瞬时测量当事实存了下来**：
  //   历次折叠写进「压力 89% / 97% / 100%」「上下文压缩连续 4 次失败」，
  //   于是每一步注入（热清单 + 摘要）都在告诉下一个模型「你快满了」—— 而真实占用早就降下来了。
  //   瞬时量每步都在变，**只有宿主能给出当下值**；把它折进摘要 = 刻舟求剑，
  //   而且越折越吓人（连续失败次数会不断累积成一段恐怖叙事）。
  lines.push(
    "- NEVER carry a TRANSIENT MEASUREMENT into the summary: context-usage percentage (「压力 89%」「上下文已到 87%」), " +
      "remaining-token counts, TPS, cache-hit rate. They were true only for the instant they were observed; the next step " +
      "re-reads them from the host. A summary that says \"pressure 92%\" makes the next model believe a past instant is the " +
      "present — the exact opposite of what compression is for. Compress the WORK, not the gauge.",
  );
  // ★ 边界（boundary-audit 抓到过我的第一版）：只许写**输出格式**，不许解释「什么是事实」——
  //   那是 persona / AGENTS 的职责，压缩产物越界去教模型「怎么看待」就违反职责边界。
  lines.push(
    "- A compression failure is recorded as its raw error text only, with no gauge beside it: " +
      "write 「折叠失败：compactRegion: no open turn」, never 「折叠失败，压力 89%」.",
  );
  // ★ C455：**"别发明 id"这条规矩以前只在 preGraph 分支里出现** —— 常规折叠反而没写。
  //   而真机上确实有摘要写出「这次折叠时还不存在的 id」（doctor 的 outOfRangeLater，19 次，
  //   含 pressure 折叠；重渲染事实块确认那些 id 不在块里 ⇒ 不是我们喂的，是模型自己补的）。
  //   编号一旦进了 checkpoint，下一个模型就会拿它去查 —— 查不到，或者查到一个**未来**的状态。
  //   所以这条必须**无条件**出现，并且把"合法集合"说清楚：只能是上面那块里出现过的。
  lines.push(
    "- Cite ONLY ids that literally appear in the authoritative block above. Never guess, never continue a sequence " +
      "(n1, n2, n3 …). Never invent a node, an edge, a result, or a path. An id that is not in that block does not exist for you.",
  );
  lines.push("");
  lines.push("Output EXACTLY this Markdown structure. Keep every section, in order. Write \"(none)\" when empty — never drop a section.");
  lines.push("");
  lines.push("## 目标");
  lines.push("- <the user's current goal in 1-2 lines, then every constraint verbatim as its own bullet>");
  lines.push("");
  lines.push("## 棋谱（状态节点）");
  lines.push("- n<id> seq=<seq> 目标=<one line> 状态=<world8>/<constraint8>");
  lines.push("");
  // C47：标题只写事实（章节名）；「一条都不许丢」已在上面的规则里说过两遍，
  // 写进标题会随摘要**长期留在上下文里**，变成一条对后来模型的指令。
  lines.push("## 已探明死路");
  lines.push("- e<id> \"<intent>\" → <reason> (evidence seq <a-b>)");
  lines.push("");
  lines.push("## 已验证事实");
  lines.push("- <fact + the external signal that proves it: exit 0 / N tests passed / file path written>");
  lines.push("");
  lines.push("## 未验证");
  lines.push("- <claim + why it is unproven>");
  lines.push("");
  lines.push("## 当前节点与最近用户消息");
  lines.push("- 当前节点：n<id>（状态 <world8>/<constraint8>）");
  // ★ 边界（2026-11-01，见 docs/压缩的职责边界.md）：这里要**事实**，不要「下一步该做什么」。
  //   旧模板写的是 `- 下一步：<the single next action, ...>` —— 那会让摘要产出行动建议，
  //   而行动决策属于 AGENTS / persona / 模型自身；压缩产物只该回答「发生过什么、用户最后说了什么」。
  lines.push("- 最近一条用户消息（逐字摘录首行）：<verbatim first line of the latest user message>");
  lines.push("");
  lines.push("## 原始坐标");
  // ★ C64（专员审计 P0）：「需要时按 seq 回读」是**教模型何时恢复记忆**（职责边界 §2 明列禁止）。
  //   这里只陈述坐标事实（原文在哪、按什么可定位），何时回读由模型/AGENTS 决定。
  lines.push(`- 本段遮蔽 seq ${shadowedStart}-${shadowedEnd}；逐字原文在 DSH 会话日志中（seq 可定位）。`);
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

