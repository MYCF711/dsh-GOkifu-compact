/**
 * keeper.mjs —— 把会话事件流归纳成棋谱（每步落账，零模型成本）
 *
 * 输入只有 event（DSH 的 SessionEvent），输出是对 graph 的增量修改。
 * 不碰 session、不碰文件系统、不 await —— 因此可以在同步的 session/event
 * 监听器里安全调用，也可以单测。
 */

import { addUserNode, addEdge, addAgentNode, settleEdge, extractConstraints, norm } from "./graph.mjs";
import { intentFromAssistantText, actionSummary, touchedPaths, writtenPathsFromResult } from "./extract.mjs";
import { classify } from "./verifier.mjs";

const CHECKPOINT_KIND = "compact-checkpoint";
const OWN_SOURCE_KIND = "chess-context";

/**
 * 只有「人类真正说的话」才配当 UserNode（约束锚 + 根目标）。
 * ★ 2026-10-28 实测：user 角色的消息有 8 种 source.kind ——
 *   user / agent-instructions / runtime-context / skill-catalog / plugin:hindsight /
 *   agent-message / subagent-settled / chess-context。
 *   把它们都当用户消息，会把工作区说明和记忆注入抽成「约束」，污染整张棋谱。
 */
const HUMAN_SOURCES = new Set(["user", "prompt", "human"]);

/** 从 user/message 事件里取纯文本（多块拼接）。 */
export function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function isCheckpointMessage(message) {
  return message?.source?.kind === CHECKPOINT_KIND || message?.source?.kind === "compact-checkpoint";
}

export function isOwnMessage(message) {
  return message?.source?.kind === OWN_SOURCE_KIND;
}

/** 这条 user 消息是人打的字，还是系统/插件注入的上下文。 */
export function isHumanMessage(message) {
  const kind = message?.source?.kind;
  if (kind === undefined || kind === null) {
    // 没有 source 的旧格式：保守当成注入，不建约束锚
    return false;
  }
  return HUMAN_SOURCES.has(String(kind));
}

/** 注入来源的分类（只用于统计/调试，不进图）。 */
export function injectionKind(message) {
  const kind = String(message?.source?.kind ?? "unknown");
  return HUMAN_SOURCES.has(kind) ? null : kind;
}

/**
 * 观察一个事件，更新棋谱。
 * @param {object} g 棋谱（graph.mjs 的 createGraph 产物）
 * @param {object} event DSH 会话事件
 * @param {object} state 每会话的运行时状态 { pendingEdges: Map<callId, edgeId>, lastNodeId, touched: string[] }
 * @returns {{ changed: boolean, note?: string }}
 */
export function observeEvent(g, event, state) {
  switch (event.type) {
    case "user/message": {
      const message = event.data;
      if (!message || isCheckpointMessage(message) || isOwnMessage(message)) return { changed: false };
      if (!isHumanMessage(message)) {
        // 注入上下文：不计入棋谱（既不建 UserNode，也不参与约束抽取）
        state.injected = (state.injected ?? 0) + 1;
        return { changed: false, note: `ignored injection:${injectionKind(message)}` };
      }
      const text = messageText(message);
      if (!text.trim()) return { changed: false };
      const id = addUserNode(g, { seq: event.seq, turn: event.data?.turn ?? null, text, constraints: extractConstraints(text) });
      state.lastUserNodeId = id;
      // 用户的新消息开启一条新的主路径：把当前 agent 节点挂到最近的 user 节点下
      state.lastNodeId = id;
      // 用户纠正 ⇒ 约束集变化 ⇒ 之后的节点必然是新状态
      state.constraintDirty = true;
      return { changed: true, note: `user node ${id}` };
    }

    case "assistant/message": {
      const message = event.data?.message;
      if (!message || !Array.isArray(message.content)) return { changed: false };
      const text = messageText(message);
      const intent = intentFromAssistantText(text);
      let changed = false;
      for (const block of message.content) {
        if (!block || block.type !== "tool-call") continue;
        const args = parseArgs(block.arguments);
        const edgeId = addEdge(g, {
          from: state.lastNodeId ?? null,
          intent,
          action: actionSummary(block.name, args),
          evidence: { start: event.seq, end: event.seq },
        });
        state.pendingEdges.set(block.id ?? edgeId, edgeId);
        (state.stepEdges ??= []).push(edgeId);
        for (const p of touchedPaths(block.name, args)) {
          state.touched.push(p);
          // 真的把路径喂给世界状态，否则 hash() 永远不变（置换判断失效）
          if (typeof state.touchPath === "function") state.touchPath(p);
        }
        changed = true;
      }
      if (changed) {
        state.lastAssistantText = intent;
        state.lastStepSeq = event.seq;
      }
      return { changed };
    }

    case "tool/result": {
      const message = event.data?.message;
      if (!message) return { changed: false };
      const callId = message.source?.callId ?? message.toolCallId;
      const edgeId = state.pendingEdges.get(callId);
      if (edgeId === undefined) return { changed: false };
      state.pendingEdges.delete(callId);
      const text = messageText(message);
      const verdict = classify({ tool: state.toolNameByCall?.get(callId) ?? guessToolFromEdge(g, edgeId), text, isError: message.isError === true });
      for (const p of writtenPathsFromResult(text)) {
        state.touched.push(p);
        if (typeof state.touchPath === "function") state.touchPath(p);
      }
      const edge = settleEdge(g, edgeId, {
        result: verdict.result,
        verify: verdict.verify,
        errorSnippet: verdict.errorSnippet,
        // S2a：只读弱成功（verdict.weak = "read"）原样落进边，供热清单的 WORKING 路径使用。
        // result 仍是 verdict.result（unverified）—— 失败集 / 事实块 / 手割一律看不到它。
        weak: verdict.weak ?? null,
      });
      if (edge.evidence && typeof edge.evidence === "object") edge.evidence.end = event.seq;
      return { changed: true, note: `${edgeId} → ${verdict.result}` };
    }

    case "turn/end":
    case "step/end": {
      // 关闭步骤时，仍未结算的边标成 unverified（不是 success）
      let changed = false;
      for (const [callId, edgeId] of state.pendingEdges) {
        settleEdge(g, edgeId, { result: "unverified", verify: { kind: "no-result", summary: "step closed with no tool result" } });
        state.pendingEdges.delete(callId);
        changed = true;
      }
      // 一个 step 结束 = 一个状态节点（本步所有边指向它；下一步从这里出发）
      if (event.type === "step/end" && (state.stepEdges?.length ?? 0) > 0) {
        const edges = state.stepEdges.map((id) => g.edges[id]).filter(Boolean);
        const last = edges[edges.length - 1];
        const node = addAgentNode(g, {
          seq: event.seq,
          turn: event.data?.turn ?? null,
          goal: state.lastAssistantText ?? "",
          // ★ 用创建时刻的真实状态哈希（engine 注入 state.worldHashOf）。
          //   旧版一律写 "pending"，由 engine 在 fold 前**统一回填成同一个哈希** ——
          //   结果整段路径被判定为同一状态，fold 时折叠成一个节点（实测节点 5→2、边 from 悬空）。
          worldHash: typeof state.worldHashOf === "function" ? state.worldHashOf() : "pending",
          constraintHash: typeof state.constraintHashOf === "function" ? state.constraintHashOf() : "pending",
          via: last ? last.id : null,
        });
        for (const edge of edges) edge.to = node.id;
        state.lastNodeId = node.id;
        state.stepEdges = [];
        changed = true;
      }
      return { changed };
    }

    default:
      return { changed: false };
  }
}

function parseArgs(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function guessToolFromEdge(g, edgeId) {
  const edge = g.edges[edgeId];
  const m = /^([A-Za-z0-9_-]+)\(/.exec(edge?.action ?? "");
  return m ? m[1] : "unknown";
}

