/**
 * ledger.mjs —— 热上下文渲染
 *
 * 两个消费者：
 *   1. 给模型的「失败清单」（热、每步可见、有硬预算）
 *   2. 给摘要模型的「硬事实」（压缩时用，权威、不许改）
 *
 * ★ 2026-10-28 性能修正（bench 实测暴露）：
 *   旧版在失败边很多时会把所有边列出来 —— 1201 条边渲染出 28,800 tokens，
 *   比它要省的上下文还大。现在有**硬预算 + 五级降级**：
 *     L0 全量（意图 + 原因 + seq）
 *     L1 原因截短
 *     L2 只留意图
 *     L3 只留 id + 意图前 22 字
 *     L4 最近 N 条（L3 格式）+ 一行汇总（告诉模型还有多少条、去哪里查）
 *   原则不变：**能逐条列出的绝不合并**；实在列不下时用汇总行保证「可发现」，
 *   而不是假装不存在。摘要 prompt 的 renderFacts 仍然全量（那是一次性成本）。
 */

import { failureEdges, openEdges, currentPath, latestAgentNode, norm, tewariAnalysis, failureClass } from "./graph.mjs";

/** 保守 token 估算（CJK 1 字≈1 token，英文 ~4 字/token；取 3 折中偏保守）。 */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 3);
}

function clip(text, n) {
  const t = norm(text);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
}

/**
 * 只取哈希的前 n 位。兼容字符串与历史脏数据里的 { hash, mode, files } 对象 ——
 * 旧版直接 `.slice()`，遇到对象就抛 "latest?.worldHash?.slice is not a function"，
 * 导致 renderLedger 整体失败、压缩链路 100% 中断。
 */
function shortHash(value, n = 12) {
  if (typeof value === "string") return value.slice(0, n);
  if (value && typeof value === "object" && typeof value.hash === "string") return value.hash.slice(0, n);
  return "";
}

function seqSpan(edge) {
  const e = edge.evidence;
  if (!e) return "";
  if (typeof e === "string") return e;
  if (typeof e.start === "number" && typeof e.end === "number") return e.start === e.end ? `${e.start}` : `${e.start}-${e.end}`;
  return "";
}

/**
 * 标记图例（给模型看，不是给人看的缩写）。
 *
 * ★ 2026-10-29 修正（模型消费者视角）：旧版把图例**绑在「检测到手割」**上 ——
 *   一个只有 EACCES 失败、没有成功路径的会话，标记 `[blocked]` 会**裸奔**（没有任何解释）；
 *   而 `redundant` / `longer` 这两个真的出现在清单里的标记，图例里**从来没有**过。
 *   新规则：**只要清单里出现某个标记，它的解释就一定出现**（按实际用到的标记动态生成，不浪费 token）。
 *
 * 键是标记前缀（`redundant:e1+2` 的键是 `redundant`）。
 */
const MARKER_LEGEND = {
  dead: "a working path avoids it — retry only if retry-if breaks",
  "blocked:permission": "needs a permission this environment lacks — retry when it changes",
  "blocked:missing-resource": "absent — retry when it appears, or create it",
  "blocked:timeout": "no answer in time — retry when it recovers",
  "blocked:unreachable": "connection refused — retry when it is up",
  blocked: "not available right now — retry when that changes",
  failed: "retryability unknown",
  redundant: "working edge <edge> reaches the SAME position — take it",
  longer: "working edge <edge> reaches it in fewer steps — take it",
  novel: "reached positions no working path covers — new information",
};

/** 标记 → 图例键（`redundant:e1+2` → `redundant`；`dead retry-if:e1` → `dead`）。 */
export function legendKey(tag) {
  const base = String(tag).split("+")[0];
  if (base.startsWith("redundant")) return "redundant";
  if (base.startsWith("longer")) return "longer";
  if (base.startsWith("dead")) return "dead";
  if (base.startsWith("blocked")) return Object.hasOwn(MARKER_LEGEND, base) ? base : "blocked";
  return base;
}

/**
 * 一条失败边的标记。`mode`：
 *   · `semantic`（默认）—— 标记自带语义：`blocked:permission`（模型不用猜是什么被挡住了，
 *     这正是「什么条件变了就能再试」的机器可判形式）
 *   · `terse`    —— 只写三态（`blocked` / `dead` / `failed`）省 token，图例仍然给
 *   · `off`      —— 完全不打标记（热清单退回纯失败列表）
 * 手割标记（`redundant:<edge>` / `longer:<edge>` / `novel`）在非 off 模式下都会带上 ——
 * 它回答的是「这一步为什么多余、相对哪条成功路径」，正是模型下一步要用的信息。
 */
export function failureTags(edge, tewari = null, mode = "semantic") {
  if (mode === "off") return [];
  const cls = failureClass(edge, tewari);
  const tags = [mode === "semantic" && cls.kind === "blocked" && cls.reason ? `blocked:${cls.reason}` : cls.kind];
  // ★ 2026-10-29（goal ③）：「dead」不能是永久墓碑。它成立的依据是「某条成功边不经过这里」，
  //   所以把那条边直接写进标记：`dead retry-if:e1` —— 那条成功路径一旦不通，就是该回头重试的信号。
  //   依据由 tewari 给（dead 的定义就是 same_position ⇒ redundantVs 非空），不是猜的。
  if (cls.kind === "dead" && tewari?.redundantVs?.length) {
    const n = tewari.redundantVs.length;
    tags[0] = `dead retry-if:${tewari.redundantVs[0]}${n > 1 ? `+${n - 1}` : ""}`;
  } else if (tewari?.redundantVs?.length) {
    // 非 dead（典型是 blocked + 同终点）：冗余关系照旧单独标注
    const n = tewari.redundantVs.length;
    tags.push(`redundant:${tewari.redundantVs[0]}${n > 1 ? `+${n - 1}` : ""}`);
  }
  if (tewari?.probes?.length > 0) tags.push("novel");
  if (tewari?.longerVs?.length) {
    const n = tewari.longerVs.length;
    tags.push(`longer:${tewari.longerVs[0]}${n > 1 ? `+${n - 1}` : ""}`);
  }
  return tags;
}

/** 一条失败边的单行渲染。level 控制长度：0=最详细，3=最省。 */
export function renderFailureLine(edge, level = 0, tewari = null, mode = "semantic") {
  const intentLen = [70, 50, 34, 22][Math.min(level, 3)];
  // ★ 2026-10-29：原因（报错原文）**任何级别都保留**，只是越来越短。
  //   旧版 level ≥3 直接把 `→ 原因` 整段砍掉 ⇒ 全库实测 133 条可见失败边里只有 25 条带原因，
  //   模型看到「我试过 X、它 blocked」却看不到「报错是什么」。而原因正是它避免重犯的判据。
  //   现在最省的一档也留 25 字（"Error: EACCES: permissio…" 足够认出是什么错）。
  const reasonLen = [90, 60, 36, 25][Math.min(level, 3)];
  const intent = clip(edge.intent || edge.action || "(未记录意图)", intentLen);
  const reason = clip(edge.errorSnippet || edge.verify?.summary || edge.action || "(未记录原因)", reasonLen);
  const seq = seqSpan(edge);
  const tags = failureTags(edge, tewari, mode);
  const tag = tags.length > 0 ? ` [${tags.join(" ")}]` : "";
  return `- ${edge.id} "${intent}" → ${reason}${seq && level <= 1 ? ` (seq ${seq})` : ""}${tag}`;
}

/**
 * 渲染热上下文。
 * @param {{maxTokens?:number, tailFailures?:number, markers?:'semantic'|'terse'|'off'}} [options]
 * @returns {{text:string, tokens:number, level:number, omittedEdges:number, failureCount:number, shownFailures:number}}
 */
export function renderLedger(g, { maxTokens = 500, tailFailures = 20, markers = "semantic", treeDir = "" } = {}) {
  const failures = failureEdges(g);
  const open = openEdges(g);
  const latest = latestAgentNode(g);
  const path = latest ? currentPath(g, latest.id) : [];
  const root = g.rootNode ?? g.rootUserNodeIds.map((id) => g.nodes[id]).filter(Boolean)[0];

  // ★ 手割分析（每条边一次 BFS）**只算一次**，算在「最后 30 条失败边」上：
  //   降级链的 L4/L5 只列尾部若干条，都是这 30 条的子集 ⇒ 一次计算够所有档位用。
  //   旧版放在档位循环里，2000 边时要跑 6 档 × 30 条 BFS（实测渲染 4.9 → 7.5ms）；
  //   旧旧版更糟：显示条数 >30 时一条都不算 ⇒ 大会话里手割标记全丢。
  const tewariMap = new Map();
  for (const e of failures.slice(-30)) tewariMap.set(e.id, tewariAnalysis(g, e));

  // ★ 便宜的降级：某一档**注定装不下**时不要白渲染（2000 边时要为 L0–L3 各拼 1201 行字符串，
  //   实测渲染 7.6ms/步；跳过装不下的档位后回到 ~5ms）。判据是每行的**下界**长度
  //   （id + 意图上限 + 原因上限 + 标记余量），再乘条数 —— 比真实输出小，所以只会跳过
  //   铁定不合规的档位，不会误伤。
  const LEVEL_LEN = [[70, 90], [50, 60], [34, 36], [22, 25]];

  for (let level = 0; level <= 5; level += 1) {
    if (level < 5 && failures.length > 0) {
      const shownCount = level === 4 ? Math.min(failures.length, tailFailures) : level === 5 ? Math.min(failures.length, 10) : failures.length;
      const [intentLen, reasonLen] = LEVEL_LEN[Math.min(level, 3)];
      const lowerBound = Math.ceil((shownCount * (25 + intentLen + reasonLen) + 300) / 3);
      if (lowerBound > maxTokens && level < 4) continue; // L4/L5 是兜底，必须真的渲染一遍
      if (lowerBound > maxTokens && shownCount > 0 && level === 4 && failures.length > tailFailures) continue;
    }
    const lines = [];
    lines.push("<chess-ledger>");
    if (root) lines.push(`ROOT USER (verbatim): ${clip(root.text, level === 0 ? 900 : level === 1 ? 500 : level === 2 ? 300 : 180)}`);
    // 始终收集**所有** user 节点的约束：旧版只要 root 有约束就只看 root，
    // 后续用户消息里的约束（"不要动 prod 配置"）在热清单里消失（审查 P1-6）。
    const cons = collectConstraints(g);
    if (cons.length) {
      lines.push("CONSTRAINTS (verbatim):");
      for (const c of cons.slice(0, 12)) lines.push(`- ${clip(c, level <= 1 ? 220 : 120)}`);
    }
    if (path.length > 1 && level <= 2) {
      // 先算完整成功路径（WORKING）—— 和 CURRENT PATH 相同就只显示一个，避免重复
      const successEdges = Object.values(g.edges).filter((e) => e.result === "success" && e.to && g.nodes[e.to]);
      let workingIds = null;
      let workingTail = null;
      if (successEdges.length > 0) {
        const last = successEdges[successEdges.length - 1];
        const ids = [last.from, last.to];
        const seen = new Set(ids);
        let cur = last.from;
        for (;;) {
          const prev = Object.values(g.edges).find(
            (e) => e.result === "success" && e.to === cur && g.nodes[e.from] && !seen.has(e.from),
          );
          if (!prev) break;
          ids.unshift(prev.from);
          seen.add(prev.from);
          cur = prev.from;
        }
        workingIds = ids;
        workingTail = last;
      }

      const currentIds = path.map((n) => n.id);
      const sameAsWorking =
        workingIds !== null &&
        workingIds.length === currentIds.length &&
        workingIds.every((id, i) => id === currentIds[i]);

      // 只有「当前路径 ≠ 成功路径」时才额外显示 CURRENT PATH（否则 WORKING 已经说了）
      if (!sameAsWorking) {
        lines.push(`CURRENT PATH: ${path.map((n) => `${n.id}${n.kind === "user" ? "(user)" : ""}`).join(" → ")}`);
      }
      const goal = latest?.goal;
      if (goal) lines.push(`CURRENT GOAL: ${clip(goal, level <= 1 ? 240 : 120)}`);
      if (workingIds !== null) {
        const label = (id) => (g.nodes[id]?.kind === "user" ? "user" : id);
        lines.push(
          `WORKING: ${workingIds.map(label).join(" → ")}${workingTail?.verify?.summary ? ` (${clip(workingTail.verify.summary, 40)})` : ""}`,
        );
      }
      // ★ 置换提示（P1-12）：路径上出现 transposition 标记的边 = 回到了走过的状态。
      //   旧版 `renderTranspositionWarning` 全项目没有调用点，这个提示永远不会出现。
      const hops = path.length - 1;
      let transposed = 0;
      for (let i = 1; i < path.length; i += 1) {
        const fromId = path[i - 1].id;
        const toId = path[i].id;
        if (Object.values(g.edges).some((e) => e.from === fromId && e.to === toId && e.transposition)) transposed += 1;
      }
      if (transposed > 0) {
        lines.push(`⚠ 置换：当前路径有 ${transposed} 处回到已走过的状态（共 ${hops} 跳）——那些状态上试过的做法都记在下面的死路清单里，别重复。`);
      }
    }

    let shown = failures;
    let omitted = 0;
    if (level === 4 && failures.length > tailFailures) {
      // L4：只列最近的若干条，其余用汇总行保证可发现（不假装不存在）
      shown = failures.slice(-tailFailures);
      omitted = failures.length - shown.length;
    }
    if (level === 5 && failures.length > 10) {
      // L5（P2-13 兜底）：极端输入（如 12 条 200 字约束）下 L4 仍会超预算，最后只留最近 10 条
      shown = failures.slice(-10);
      omitted = failures.length - shown.length;
    }

    if (failures.length) {
      lines.push(`LEARNED (${failures.length} failed attempts):`);
      // ★ 2026-10-29（goal ⑤）：旧版让模型去读 `graph.md` —— 而那个文件从 v1.2.2 起就不再自动写了（死指针）。
      //   真实的三层树是 index.md + nodes/<id>.md。这里给出**可点的实际路径**，模型要细节时知道去哪。
      if (treeDir) lines.push(`TRACE: ${treeDir}/index.md  (per-node detail: nodes/<id>.md)`);
      // 手割分析（tewari）：每条边一次 BFS，防 O(E²) —— 只对**最近 30 条**做。
      // ★ 2026-10-29：旧版是「显示条数 ≤30 才算」⇒ 一次有 40 条失败边的会话里，
      //   手割标记**一条都没有**（而模型永远只对最近几步做决策）。改成对尾部 30 条算，
      //   无论总数多少，最近这批边都有标记。
      const tewariMap = new Map();
      for (const e of shown.slice(-30)) tewariMap.set(e.id, tewariAnalysis(g, e));
      const markerLines = markerLegendLines(shown.map((e) => failureTags(e, tewariMap.get(e.id) ?? null, markers)));
      for (const line of markerLines) lines.push(line);
      if (omitted > 0) {
        lines.push(
          `- … ${omitted} earlier dead ends omitted for budget: ${failures[0].id}..${failures[omitted - 1].id} — full text: ${treeDir ? `${treeDir}/index.md` : "index.md"} (per node: nodes/<id>.md) / by seq in the session log`,
        );
      }
      for (const e of shown) lines.push(renderFailureLine(e, level, tewariMap.get(e.id) ?? null, markers));
    }
    if (open.length && level <= 1) {
      lines.push("UNVERIFIED (ran, but no external signal — treat as unproven):");
      for (const e of open.slice(-6)) lines.push(`- ${e.id} "${clip(e.intent || e.action, 50)}"`);
    }
    lines.push("</chess-ledger>");
    const text = lines.join("\n");
    const tokens = estimateTokens(text);
    if (tokens <= maxTokens || level === 5) {
      return { text, tokens, level, omittedEdges: omitted, failureCount: failures.length, shownFailures: shown.length };
    }
  }
  /* istanbul ignore next -- 循环必然返回 */
  return { text: "", tokens: 0, level: 5, omittedEdges: failures.length, failureCount: failures.length, shownFailures: 0 };
}

/**
 * 按**实际用到**的标记生成图例 —— 每个用到的标记一行，没用到的不出现。
 * 这是「模型能不能看懂标记」的兜底：标记只要出现，解释就一定在同一份清单里，
 * 不依赖「有没有检测到手割」这种无关条件（旧版的 bug：只有 EACCES 的会话里 [blocked] 裸奔）。
 */
function markerLegendLines(tagLists) {
  const seen = [];
  for (const tags of tagLists) {
    for (const tag of tags ?? []) {
      const key = legendKey(tag);
      if (!seen.includes(key)) seen.push(key);
    }
  }
  if (seen.length === 0) return [];
  const out = ["# markers:"];
  for (const key of seen) out.push(`#   ${key} = ${MARKER_LEGEND[key] ?? "(unknown marker)"}`);
  return out;
}

export function collectConstraints(g) {
  const out = [];
  for (const id of g.order) {
    const node = g.nodes[id];
    if (node?.kind === "user" && Array.isArray(node.constraints)) out.push(...node.constraints);
  }
  return [...new Set(out)];
}

/**
 * 给摘要模型的「硬事实块」。这是防摘要漂移的核心：
 * 这些内容由规则抽取、逐字保留，模型只负责压缩表达，不负责决定丢什么。
 * ★ 这里**全量**（不降级）—— 摘要是一次性成本，且失败边正是压缩必须保住的东西。
 */
export function renderFacts(g, { maxFailures = 800, headFailures = 80, range = null } = {}) {
  let allFailures = failureEdges(g);
  // ★ P1-8：增量 fold 只应把**本段**失败边塞进摘要。旧版取全量 → 摘要体积随全局失败数增长，
  //   真实会话的 fold 摘要已 13,953 字符；再涨会触发官方「summary 不小于被遮蔽内容」，fold 永久失败。
  //   历史失败边由前一个 checkpoint 的摘要承载。
  if (range && typeof range.start === "number" && typeof range.end === "number") {
    const overlapped = allFailures.filter((e) => {
      const s = e.evidence?.start ?? (typeof e.evidence === "number" ? e.evidence : null);
      const t = e.evidence?.end ?? s;
      if (s === null) return true; // 没有位置信息的保守保留
      return t >= range.start && s <= range.end;
    });
    // 极端情况下本段没有失败边：保留最近 20 条，避免摘要完全失去失败记忆
    allFailures = overlapped.length > 0 ? overlapped : allFailures.slice(-20);
  }
  let failures = allFailures;
  let omitted = 0;
  let omittedSpan = "";
  if (allFailures.length > maxFailures) {
    // 极端规模（bench 实测 1201 条 ≈ 22 万字符 / 7.4 万 token，单次摘要就贵得离谱）：
    // 保留「最早的 headFailures 条（根因）+ 最近的部分（当前状态）」，中间用汇总行保证可发现。
    const head = allFailures.slice(0, headFailures);
    const tail = allFailures.slice(-(maxFailures - headFailures));
    failures = [...head, ...tail];
    omitted = allFailures.length - failures.length;
    const firstOmitted = allFailures[headFailures];
    const lastOmitted = allFailures[allFailures.length - (maxFailures - headFailures) - 1];
    omittedSpan = `${firstOmitted.id}..${lastOmitted.id}`;
  }
  const compact = allFailures.length > 300;
  const latest = latestAgentNode(g);
  const path = latest ? currentPath(g, latest.id) : [];
  const root = g.rootUserNodeIds.map((id) => g.nodes[id]).filter(Boolean)[0];
  const lines = [];
  lines.push("[HARD FACTS — mechanically extracted from the session log; authoritative; must survive compression unchanged]");
  if (root) {
    // 1MB 的粘贴内容不能整段进 prompt（实测：100 万字符）。保留前 4000 字符 + 明确标注截断。
    const ROOT_LIMIT = 4000;
    const rootText = root.text.length > ROOT_LIMIT ? `${root.text.slice(0, ROOT_LIMIT)}
[… truncated ${root.text.length - ROOT_LIMIT} chars; full text in session log seq ${root.seq}]` : root.text;
    lines.push(`ROOT_USER_REQUEST_VERBATIM >>`);
    lines.push(rootText);
    lines.push(`<< END ROOT_USER_REQUEST (seq ${root.seq})`);
  }
  const cons = collectConstraints(g);
  if (cons.length) {
    lines.push("CONSTRAINTS_VERBATIM:");
    for (const c of cons) lines.push(`* ${c}`);
  }
  if (omitted > 0) {
    lines.push(`FAILED_ATTEMPTS_OMITTED: ${omitted} earlier dead ends ${omittedSpan} are NOT listed here for budget — their full text is in graph.json; do not invent or merge them, just note that they exist.`);
  }
  if (failures.length) {
    lines.push(`FAILED_ATTEMPTS (${failures.length} listed of ${allFailures.length}; keep every line, never merge, never drop):`);
    for (const e of failures) {
      const seq = seqSpan(e);
      if (compact) {
        lines.push(`* ${e.id} "${clip(e.intent, 70) || "-"}" → ${clip(e.errorSnippet || e.verify?.summary, 80)}`);
      } else {
        lines.push(
          `* ${e.id} intent="${norm(e.intent) || "-"}" action="${clip(e.action, 120) || "-"}" reason="${clip(e.errorSnippet || e.verify?.summary, 160)}"${seq ? ` evidence=seq ${seq}` : ""}`,
        );
      }
    }
  }
  if (path.length) {
    lines.push(`CURRENT_PATH: ${path.map((n) => n.id).join(" -> ")}`);
    if (latest?.goal) lines.push(`CURRENT_GOAL: ${latest.goal}`);
    lines.push(`CURRENT_STATE_KEY: ${shortHash(latest?.worldHash)}/${shortHash(latest?.constraintHash)}`);
  }
  const open = openEdges(g);
  if (open.length) {
    lines.push("UNVERIFIED_CLAIMS (no external verification signal):");
    for (const e of open.slice(-40)) lines.push(`* ${e.id} "${clip(e.intent || e.action, 90)}"`);
  }
  return lines.join("\n");
}

/** 人读的「下一步提示」：置换命中时给模型一句警告。 */
export function renderTranspositionWarning(result) {
  if (!result?.transposition) return "";
  const { nodeId, hops } = result.transposition;
  return `⚠ 置换：你回到了节点 ${nodeId}${hops ? `（经过 ${hops} 条边）` : ""}——这里试过的路都已经记在 LEARNED 里，换一条没试过的。`;
}
