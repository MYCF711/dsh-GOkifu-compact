/**
 * user-route.mjs —— 会话级「棋路」容器（R16 / C668 · C670 加固）
 *
 * 一句话：把**这个人在这一局手动发送的每一句原话，按顺序、逐字、带位置**交出去。
 *
 * ## 四条硬规矩（改动前先读）
 * 1. **棋路是走向，不是清单** —— 顺序本身就是信息；按 `graph.order` 输出，不排序、不合并。
 * 2. **不产任何语义判断** —— 无 goal / pivot / polarity / lexicon / anchors。
 * 3. **只装手动发送的** —— 判据 `node.manual === true`（落账见 keeper C667）；旧图无此字段 = 未知 ⇒ 不收。
 * 4. **只落盘，不进上下文** —— 不进热清单、不进摘要、不调模型、不跨会话。
 *
 * ## C670 加固（两条盲审报的真缺陷 + 三处健壮性）
 * · **D-1**：图被 rebuilt（`graph.json` 读不出/版本不符）时，**只要已有容器就不许写** ——
 *   否则新图攒到相同条数就会把旧容器盖掉，整段棋路无声消失。新会话（无容器）不受影响。
 * · **D-6**：已有容器但**版本不认识** ⇒ 拒绝覆盖（此前被当成"没有容器"而静默覆盖）。
 * · **D-7**：写盘前顺手清理同目录里过期的 `*.tmp-*`（崩溃遗留永不回收）。
 * · **D-8**：`source` 里的 `graphRevision`/`sessionEvents` 一直是 null（死字段）⇒ 换成
 *   `sessionSeq`/`foldCount`/`lastFoldSeq` 三个**真有值**的现场量，容器才能自证"从哪张图来"。
 * · **D-9**：8000 字截断不再切开代理对（此前会留半个 emoji）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";

/** 容器文件名（与 `graph.json` 同级）。 */
export const USER_ROUTE_FILE = "user-route.json";
/** 容器版本：不认识必须显式报错，不许静默降级。 */
export const USER_ROUTE_VERSION = 1;
/** 容器 kind：记忆侧按它识别。 */
export const USER_ROUTE_KIND = "gokifu-user-route";
/** 单条原话上限；超出只留前缀并标 `truncated`（**绝不摘要**）。 */
export const USER_ROUTE_MAX_TEXT_CHARS = 8000;
/** 崩溃遗留的临时文件超过这么久就回收（ms）。 */
export const USER_ROUTE_TMP_TTL_MS = 10 * 60 * 1000;

/** 默认 fs port（可注入：测试用假 port 断言「一条都没写」）。 */
export function createUserRouteFsPort(fs = nodeFs) {
  return {
    exists: (file) => fs.existsSync(file),
    read: (file) => fs.readFileSync(file, "utf8"),
    write: (file, text) => fs.writeFileSync(file, text, "utf8"),
    rename: (from, to) => fs.renameSync(from, to),
    remove: (file) => fs.rmSync(file, { force: true }),
    list: (dir) => fs.readdirSync(dir),
    mtimeMs: (file) => fs.statSync(file).mtimeMs,
  };
}

/**
 * 按码点安全截断：**不许切开代理对**（否则容器里留半个 emoji，记忆侧拿到非法文本）。
 * @param {string} text
 * @param {number} limit
 * @returns {{text:string, truncated:boolean}}
 */
export function truncateVerbatim(text, limit = USER_ROUTE_MAX_TEXT_CHARS) {
  const s = String(text ?? "");
  if (s.length <= limit) return { text: s, truncated: false };
  let cut = limit;
  // 高位代理（0xD800–0xDBFF）落在边界上 ⇒ 退一格，让那对完整字符一起被截掉
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return { text: s.slice(0, cut), truncated: true };
}

/**
 * 图 → 棋路容器。**纯函数：只读图，不碰磁盘，不改入参。**
 *
 * @param {object} graph 棋谱（已回放 delta）
 * @param {{sessionId?:string, builtAt?:number, stats?:object}} [opts]
 * @returns {object} 容器
 */
export function buildUserRoute(graph, { sessionId, builtAt = Date.now(), stats = {} } = {}) {
  const messages = [];
  let userNodes = 0;
  for (const id of graph?.order ?? []) {
    const node = graph.nodes?.[id];
    if (!node || node.kind !== "user") continue;
    userNodes += 1;
    // ★ 只认手动发送；旧图没有该字段 ⇒ 未知 ⇒ 不收。
    if (node.manual !== true) continue;
    const { text, truncated } = truncateVerbatim(node.text);
    messages.push({ nodeId: node.id, seq: node.seq, ts: node.ts ?? null, text, truncated });
  }
  return {
    version: USER_ROUTE_VERSION,
    kind: USER_ROUTE_KIND,
    sessionId: sessionId ?? graph?.sessionId ?? null,
    cwd: graph?.cwd ?? "",
    builtAt,
    source: {
      userNodes,
      manualNodes: messages.length,
      // ★ D-8：这三个是真有值的现场量（旧版 graphRevision/sessionEvents 恒为 null）
      sessionSeq: Number.isFinite(stats.sessionSeq) ? stats.sessionSeq : null,
      foldCount: Number.isFinite(graph?.foldCount) ? graph.foldCount : 0,
      lastFoldSeq: Number.isFinite(graph?.lastFoldSeq) ? graph.lastFoldSeq : null,
    },
    messages,
  };
}

/** 容器路径（与 `graph.json` 同目录）。 */
export function userRoutePath(dir) {
  return nodePath.join(dir, USER_ROUTE_FILE);
}

/**
 * 读已有容器的状态。**区分「没有文件」与「有文件但认不出」** —— 后者绝不能被当成前者。
 * @returns {{exists:boolean, version:number|null, count:number|null}|null}
 */
export function readUserRouteState(dir, port = createUserRouteFsPort()) {
  try {
    const file = userRoutePath(dir);
    if (!port.exists(file)) return { exists: false, version: null, count: null };
    const obj = JSON.parse(port.read(file));
    return {
      exists: true,
      version: Number.isFinite(Number(obj?.version)) ? Number(obj.version) : null,
      count: Array.isArray(obj?.messages) ? obj.messages.length : null,
    };
  } catch {
    // 文件在但解析不出来 ⇒ 当作「认不出」，不许覆盖
    return { exists: true, version: null, count: null };
  }
}

/** 兼容旧调用：只关心条数。认不出/没有 ⇒ null。 */
export function readUserRouteCount(dir, port = createUserRouteFsPort()) {
  const st = readUserRouteState(dir, port);
  if (!st || !st.exists) return null;
  if (st.version !== USER_ROUTE_VERSION) return null;
  return st.count;
}

/** 回收崩溃遗留的 `*.tmp-*`（只在本目录、只删同名前缀、只删过期的）。 */
function cleanStaleTmp(dir, port, now) {
  let removed = 0;
  try {
    const base = nodePath.basename(userRoutePath(dir));
    for (const name of port.list(dir)) {
      if (!name.startsWith(`${base}.tmp-`)) continue;
      const file = nodePath.join(dir, name);
      try {
        if (now - port.mtimeMs(file) < USER_ROUTE_TMP_TTL_MS) continue;
        port.remove(file);
        removed += 1;
      } catch {
        /* 单个文件删不掉不影响写入 */
      }
    }
  } catch {
    /* 目录读不出就当没有残留 */
  }
  return removed;
}

/**
 * 落盘。**永不抛错**（归档路径上的任何异常都不许传给宿主）。
 *
 * 守卫（每条都对应一个已发生过的真实事故）：
 *   · 0 条手动原话 ⇒ **不写**
 *   · `graphRepaired` 且**已有容器** ⇒ **不写**（D-1：重建图不许覆盖真棋路）
 *   · `deltaBroken` ⇒ **不写**（回放不全，证据不可信）
 *   · 已有容器版本不认识 ⇒ **不写**（D-6：不许静默降级覆盖）
 *   · 已有条数更多 ⇒ **不写**（图落后一回合）
 *
 * @returns {{ok:boolean, written:boolean, reason:string|null, count:number, file:string|null, cleanedTmp:number}}
 */
export function writeUserRoute(
  dir,
  graph,
  { sessionId, now = Date.now(), port = createUserRouteFsPort(), stats = {}, graphRepaired = false, deltaBroken = false } = {},
) {
  const base = { ok: false, written: false, reason: null, count: 0, file: null, cleanedTmp: 0 };
  try {
    if (!dir) return { ...base, reason: "no-dir" };
    const container = buildUserRoute(graph, { sessionId, builtAt: now, stats });
    base.count = container.messages.length;
    if (container.messages.length === 0) return { ...base, reason: "no-manual-messages" };
    if (deltaBroken === true) return { ...base, reason: "delta-broken" };
    const prev = readUserRouteState(dir, port);
    if (prev.exists && prev.version !== USER_ROUTE_VERSION) {
      return { ...base, reason: `version-unknown:${prev.version === null ? "unparsable" : prev.version}` };
    }
    if (graphRepaired === true && prev.exists) {
      return { ...base, reason: "graph-repaired" };
    }
    if (prev.count !== null && prev.count > container.messages.length) {
      return { ...base, reason: `would-shrink:${prev.count}->${container.messages.length}` };
    }
    const cleanedTmp = cleanStaleTmp(dir, port, now);
    const file = userRoutePath(dir);
    const tmp = `${file}.tmp-${process.pid}-${now}`;
    port.write(tmp, `${JSON.stringify(container, null, 1)}\n`);
    try {
      port.rename(tmp, file);
    } catch (error) {
      try {
        port.remove(tmp);
      } catch {
        /* 清理失败不掩盖原错误 */
      }
      return { ...base, cleanedTmp, reason: `rename-failed:${String(error?.message ?? error)}` };
    }
    return { ok: true, written: true, reason: null, count: container.messages.length, file, cleanedTmp };
  } catch (error) {
    return { ...base, reason: `error:${String(error?.message ?? error)}` };
  }
}
