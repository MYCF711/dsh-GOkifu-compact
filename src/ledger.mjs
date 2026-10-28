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

import { failureEdges, openEdges, currentPath, latestAgentNode, norm, tewariAnalysis } from "./graph.mjs";

/** 保守 token 估算（CJK 1 字≈1 token，英文 ~4 字/token；取 3 折中偏保守）。 */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 3);
}

function clip(text, n) {
  const t = norm(text);
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
}

function seqSpan(edge) {
  const e = edge.evidence;
  if (!e) return "";
  if (typeof e === "string") return e;
  if (typeof e.start === "number" && typeof e.end === "number") return e.start === e.end ? `${e.start}` : `${e.start}-${e.end}`;
  return "";
}

/** 一条失败边的单行渲染。level 控制长度：0=最详细，3=最省。 */
export function renderFailureLine(edge, level = 0, tewari = null) {
  const intentLen = [70, 50, 34, 22][Math.min(level, 3)];
  const reasonLen = [90, 60, 36, 20][Math.min(level, 3)];
  const intent = clip(edge.intent || edge.action || "(未记录意图)", intentLen);
  const reason = clip(edge.errorSnippet || edge.verify?.summary || edge.action || "(未记录原因)", reasonLen);
  const seq = seqSpan(edge);
  const showReason = level <= 2;
  // 手割标记：纯亏 = 同起点有成功路径且不经过它；绕路 = 成功路径也能到它的终点
  // 手割多标签（可同时成立）。用英文短词 + 图例，模型能直接理解：
  //   redundant = 和某条成功路径到达同一终点（等价，不必重试）
  //   novel     = 探出了成功路径没走过的状态（有参考价值）
  //   longer    = 比某条成功路径绕远
  const tags = [];
  if (tewari?.samePosition) tags.push("redundant");
  if (tewari?.probes?.length > 0) tags.push("novel");
  if (tewari?.vsBaseline === "longer") tags.push("longer");
  if (tags.length === 0) tags.push("dead"); // 没有任何等价/探新/绕路信息 = 纯死路
  const tag = tags.length > 0 ? ` [${tags.join(" ")}]` : "";
  return `- ${edge.id} "${intent}"${showReason ? ` → ${reason}` : ""}${seq && level <= 1 ? ` (seq ${seq})` : ""}${tag}`;
}

/**
 * 渲染热上下文。
 * @returns {{text:string, tokens:number, level:number, omittedEdges:number, failureCount:number, shownFailures:number}}
 */
export function renderLedger(g, { maxTokens = 500, tailFailures = 50 } = {}) {
  const failures = failureEdges(g);
  const open = openEdges(g);
  const latest = latestAgentNode(g);
  const path = latest ? currentPath(g, latest.id) : [];
  const root = g.rootNode ?? g.rootUserNodeIds.map((id) => g.nodes[id]).filter(Boolean)[0];

  for (let level = 0; level <= 5; level += 1) {
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
      lines.push(`CURRENT PATH: ${path.map((n) => `${n.id}${n.kind === "user" ? "(user)" : ""}`).join(" → ")}`);
      const goal = latest?.goal;
      if (goal) lines.push(`CURRENT GOAL: ${clip(goal, level <= 1 ? 240 : 120)}`);
      // 完整成功路径：模型不能只看到「最近一条边」，要知道整条路怎么走通的
      if (level <= 2) {
        const successEdges = Object.values(g.edges).filter((e) => e.result === "success" && e.to && g.nodes[e.to]);
        if (successEdges.length > 0) {
          const last = successEdges[successEdges.length - 1];
          const path = [last.from, last.to];
          const seen = new Set(path);
          let cur = last.from;
          for (;;) {
            const prev = Object.values(g.edges).find(
              (e) => e.result === "success" && e.to === cur && g.nodes[e.from] && !seen.has(e.from),
            );
            if (!prev) break;
            path.unshift(prev.from);
            seen.add(prev.from);
            cur = prev.from;
          }
          const label = (id) => (g.nodes[id]?.kind === "user" ? "user" : id);
          lines.push(`WORKING: ${path.map(label).join(" → ")}${last.verify?.summary ? ` (${clip(last.verify.summary, 40)})` : ""}`);
        }
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
      // 先算手割（只对当前显示、≤30 条），再决定要不要加图例（省 token）
      const tewariMap = new Map();
      if (shown.length <= 30) {
        for (const e of shown) tewariMap.set(e.id, tewariAnalysis(g, e));
      }
      const hasTewari = [...tewariMap.values()].some(
        (t) => t && (t.samePosition || t.probes?.length > 0 || t.vsBaseline === "longer"),
      );
      if (hasTewari) {
        lines.push(
          "# dead=no working path goes through it (don't retry) | redundant=a working path reaches the same endpoint | novel=explored states no working path covered (may revisit) | longer=detours vs a working path",
        );
      }
      if (omitted > 0) {
        lines.push(
          `- … ${omitted} earlier dead ends omitted for budget: ${failures[0].id}..${failures[omitted - 1].id} — full text in graph.md / by seq in the session log`,
        );
      }
      // 手割分析（tewari）：只对**当前显示**的失败边做，且最多 30 条（每条一次 BFS，防 O(E²)）
      for (const e of shown) lines.push(renderFailureLine(e, level, tewariMap.get(e.id) ?? null));
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
    lines.push(`CURRENT_STATE_KEY: ${latest?.worldHash?.slice(0, 12)}/${latest?.constraintHash?.slice(0, 12)}`);
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
