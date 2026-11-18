/**
 * user-route.mjs —— 会话级「棋路」容器（R16 / C668）
 *
 * 一句话：把**这个人在这一局手动发送的每一句原话，按顺序、逐字、带位置**交出去。
 *
 * ## 为什么只有这些字段（四条硬规矩，改动前先读）
 *
 * 1. **棋路是走向，不是清单** —— 顺序本身就是信息。合并/摘要/挑重点等于把走向抹掉，
 *    所以 `messages[]` 严格按 `graph.order` 输出，不排序、不合并、不截断中间（只截每条尾）。
 * 2. **不产任何语义判断** —— 没有 goal / pivot / polarity / lexicon / anchors。
 *    它们是结论，要从跨会话证据里长出来（那是记忆側的事）；压缩侧做只会把噪声固化成契约。
 * 3. **只装手动发送的** —— 判据是 `node.manual === true`（落账见 keeper 的 C667：
 *    真机 403 条「kind 属人话」的消息里只有 4 条是 GUI 手打，其余 99% 是父代理的委派任务书）。
 *    旧图没有该字段 ⇒ 未知 ⇒ 不收（宁可空，不要假）。
 * 4. **只落盘，不进上下文** —— 不进热清单、不进摘要、不调模型、不跨会话。
 *
 * ## 边界（写进契约，别扩）
 * - 允许依赖：`node:fs` / `node:path`（写盘经注入 port，便于单测断言「没写」）。
 * - 禁止依赖：`@deepseek-ai/*`、engine、scripts/、lib/、kifu-model（纯投影，不碰模型层）。
 * - **不判断子代理** —— 委派 prompt 没有 rpcId，天然为空；真需要按会话跳过的判断在记忆侧。
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

/** 默认 fs port（可注入：测试用假 port 断言「一条都没写」）。 */
export function createUserRouteFsPort(fs = nodeFs) {
  return {
    exists: (file) => fs.existsSync(file),
    read: (file) => fs.readFileSync(file, "utf8"),
    write: (file, text) => fs.writeFileSync(file, text, "utf8"),
    rename: (from, to) => fs.renameSync(from, to),
    remove: (file) => fs.rmSync(file, { force: true }),
  };
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
    const raw = String(node.text ?? "");
    const truncated = raw.length > USER_ROUTE_MAX_TEXT_CHARS;
    messages.push({
      nodeId: node.id,
      seq: node.seq,
      ts: node.ts ?? null,
      text: truncated ? raw.slice(0, USER_ROUTE_MAX_TEXT_CHARS) : raw,
      truncated,
    });
  }
  return {
    version: USER_ROUTE_VERSION,
    kind: USER_ROUTE_KIND,
    sessionId: sessionId ?? graph?.sessionId ?? null,
    cwd: graph?.cwd ?? "",
    builtAt,
    source: {
      graphRevision: stats.graphRevision ?? null,
      sessionEvents: stats.sessionEvents ?? null,
      userNodes,
      manualNodes: messages.length,
    },
    messages,
  };
}

/** 容器路径（与 `graph.json` 同目录）。 */
export function userRoutePath(dir) {
  return nodePath.join(dir, USER_ROUTE_FILE);
}

/** 读已有容器里的消息条数；读不出/格式不对 ⇒ null（当作「没有」，但绝不因此覆盖）。 */
export function readUserRouteCount(dir, port = createUserRouteFsPort()) {
  try {
    const file = userRoutePath(dir);
    if (!port.exists(file)) return null;
    const obj = JSON.parse(port.read(file));
    if (Number(obj?.version) !== USER_ROUTE_VERSION) return null;
    return Array.isArray(obj?.messages) ? obj.messages.length : 0;
  } catch {
    return null;
  }
}

/**
 * 落盘。**永不抛错**（归档路径上的任何异常都不许传给宿主）。
 *
 * 三道守卫（都来自已发生过的真实事故）：
 *   · 0 条手动原话 ⇒ **不写**（不留噪音文件，也让「本局没人手打」不产生磁盘痕迹）。
 *     这一条同时挡住了「重建出的空图覆盖好容器」：空图必然 0 条 ⇒ 一个字节都不写。
 *   · 已有容器条数更多 ⇒ **不覆盖**（图落后一回合、或 delta 异常回放不全时，先别动旧的）。
 *
 * @returns {{ok:boolean, written:boolean, reason:string|null, count:number, file:string|null}}
 */
export function writeUserRoute(dir, graph, { sessionId, now = Date.now(), port = createUserRouteFsPort(), stats = {} } = {}) {
  const base = { ok: false, written: false, reason: null, count: 0, file: null };
  try {
    if (!dir) return { ...base, reason: "no-dir" };
    const container = buildUserRoute(graph, { sessionId, builtAt: now, stats });
    base.count = container.messages.length;
    if (container.messages.length === 0) return { ...base, reason: "no-manual-messages" };
    const prev = readUserRouteCount(dir, port);
    if (prev !== null && prev > container.messages.length) {
      return { ...base, reason: `would-shrink:${prev}->${container.messages.length}` };
    }
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
      return { ...base, reason: `rename-failed:${String(error?.message ?? error)}` };
    }
    return { ok: true, written: true, reason: null, count: container.messages.length, file };
  } catch (error) {
    return { ...base, reason: `error:${String(error?.message ?? error)}` };
  }
}
