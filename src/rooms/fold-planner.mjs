/**
 * range.mjs —— 增量 fold 的范围选择（本插件对官方实现的核心修正）
 *
 * 官方的 selectCompactableRange 从「surface 第一个非 system 节点」开始压，
 * 于是每轮都会把**上一次的 checkpoint 一起再摘要一遍** ⇒ 保留率 ρ^k 几何衰减，
 * 早期约束与否定结果在大约 4~5 轮后基本归零。
 *
 * 本模块从「上一个 checkpoint 之后」开始压：每段内容一生只被摘要一次。
 */

/**
 * @param {object} input
 * @param {number[]} input.surfaceNodes 当前 surface 的 seq 列表（顺序即表面顺序）
 * @param {Array<{seq:number,heuristicTokens:number,tokens:number}>} input.pricedNodes token-meter 的节点列表（与 surface 一一对应）
 * @param {number} input.retainTokens 逐字保留的近期尾部预算
 * @param {boolean} input.hasSystemHead surface 节点 0 是否是 system/message
 * @param {number|null} input.foldStartSeq 上一个 checkpoint 之后第一个 surface seq（含）；null 表示从头
 * @param {number} input.minFoldTokens 低于这么多 token 不值得压（摘要本身要花钱）
 * @param {(seq:number)=>boolean} [input.balancedBefore] 该 seq 之前是否是合法的工具对边界
 * @param {(seq:number)=>boolean} [input.balancedAfter] 该 seq 之后是否是合法的工具对边界
 * @returns {{start:number,end:number,shadowedTokens:number,startIdx:number,endIdx:number}|null}
 */
export function selectIncrementalRange({
  surfaceNodes,
  pricedNodes,
  retainTokens,
  hasSystemHead,
  foldStartSeq,
  minFoldTokens = 0,
  balancedBefore,
  balancedAfter,
}) {
  if (!Array.isArray(surfaceNodes) || surfaceNodes.length === 0) return null;
  if (!Array.isArray(pricedNodes) || pricedNodes.length !== surfaceNodes.length) return null;

  const firstIdx = hasSystemHead ? 1 : 0;

  // 保留尾部：从后往前累计到 retainTokens
  let accumulated = 0;
  let keepFromIdx = pricedNodes.length;
  for (let i = pricedNodes.length - 1; i >= 0; i -= 1) {
    accumulated += pricedNodes[i].heuristicTokens ?? pricedNodes[i].tokens ?? 0;
    keepFromIdx = i;
    if (accumulated >= retainTokens) break;
  }

  // 起点：上一个 checkpoint 之后
  let startIdx = firstIdx;
  if (foldStartSeq !== null && foldStartSeq !== undefined) {
    const at = surfaceNodes.indexOf(foldStartSeq);
    if (at >= 0) startIdx = Math.max(firstIdx, at);
  }

  // 工具对边界：向后找第一个平衡点（宁可少压，不可切断 tool-call/result）
  if (typeof balancedBefore === "function") {
    let guard = 0;
    while (startIdx < keepFromIdx && !safeCall(balancedBefore, surfaceNodes[startIdx]) && guard < 64) {
      startIdx += 1;
      guard += 1;
    }
  }
  if (typeof balancedAfter === "function") {
    let guard = 0;
    while (keepFromIdx > startIdx && !safeCall(balancedAfter, surfaceNodes[keepFromIdx - 1]) && guard < 64) {
      keepFromIdx -= 1;
      guard += 1;
    }
  }

  if (startIdx >= keepFromIdx) return null;

  let shadowedTokens = 0;
  for (let i = startIdx; i < keepFromIdx; i += 1) {
    shadowedTokens += pricedNodes[i].heuristicTokens ?? pricedNodes[i].tokens ?? 0;
  }
  if (shadowedTokens < minFoldTokens) return null;

  return {
    start: surfaceNodes[startIdx],
    end: surfaceNodes[keepFromIdx - 1],
    shadowedTokens,
    startIdx,
    endIdx: keepFromIdx - 1,
  };
}

function safeCall(fn, arg) {
  try {
    return fn(arg) === true;
  } catch {
    return false;
  }
}

/**
 * 在 surface 上找「最后一个 checkpoint 消息之后」的 seq。
 * ★ 返回值区分三种情况（不能只返回 null —— 那会把「没有 checkpoint」与
 *   「checkpoint 就在末尾」混为一谈，导致每次 fold 都空转）：
 *     { found: false, nextSeq: null }        → 没有 checkpoint，从头压
 *     { found: true,  nextSeq: number }      → 从该 seq 起压
 *     { found: true,  nextSeq: null }        → checkpoint 在末尾，本次无可压内容
 * @param {number[]} surfaceNodes
 * @param {(seq:number)=>object|undefined} eventAt
 */
export function nextSeqAfterLastCheckpoint(surfaceNodes, eventAt) {
  for (let i = surfaceNodes.length - 1; i >= 0; i -= 1) {
    const event = eventAt(surfaceNodes[i]);
    if (event?.type === "user/message" && isCheckpointSource(event.data?.source)) {
      const next = surfaceNodes[i + 1];
      return { found: true, nextSeq: next === undefined ? null : next };
    }
  }
  return { found: false, nextSeq: null };
}

export function isCheckpointSource(source) {
  return Boolean(source && (source.kind === "compact-checkpoint" || source.kind === "compaction-checkpoint"));
}

/** surface 节点 0 是否是 system/message（其后再压）。 */
export function hasSystemHead(eventAt, surfaceNodes) {
  if (!surfaceNodes || surfaceNodes.length === 0) return false;
  const event = eventAt(surfaceNodes[0]);
  return event?.type === "system/message";
}

/**
 * 一次 fold 的完整规划（engine 与单测共用同一条路径，避免两套逻辑漂移）。
 * @param {object} input
 * @param {number[]} input.surfaceNodes
 * @param {Array<{seq:number,tokens:number,heuristicTokens:number}>} input.pricedNodes
 * @param {(seq:number)=>object|undefined} input.eventAt
 * @param {number} input.retainTokens
 * @param {number} input.minFoldTokens
 * @param {boolean} [input.overflow] 溢出自救：绕过保留尾部与最小量门槛
 * @param {(seq:number)=>boolean} [input.balancedBefore]
 * @param {(seq:number)=>boolean} [input.balancedAfter]
 * @returns {{range: {start:number,end:number,shadowedTokens:number}|null, reason: string, checkpointAtTail: boolean}}
 */
export function planFold({ surfaceNodes, pricedNodes, eventAt, retainTokens, minFoldTokens, overflow = false, balancedBefore, balancedAfter }) {
  if (!Array.isArray(surfaceNodes) || surfaceNodes.length === 0) return { range: null, reason: "empty-surface", checkpointAtTail: false };
  const cp = nextSeqAfterLastCheckpoint(surfaceNodes, eventAt);
  if (cp.found && cp.nextSeq === null) return { range: null, reason: "checkpoint-at-tail", checkpointAtTail: true };
  const range = selectIncrementalRange({
    surfaceNodes,
    pricedNodes,
    retainTokens: overflow ? 0 : retainTokens,
    hasSystemHead: hasSystemHead(eventAt, surfaceNodes),
    foldStartSeq: cp.nextSeq,
    minFoldTokens: overflow ? 0 : minFoldTokens,
    balancedBefore,
    balancedAfter,
  });
  return { range, reason: range === null ? "no-foldable-span" : "ok", checkpointAtTail: false };
}
