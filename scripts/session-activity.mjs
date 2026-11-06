import nodeFs from "node:fs";
import nodePath from "node:path";

function sessionKey(name) {
  return String(name ?? "").replace(/^session-/, "");
}

/**
 * 会话目录最近一次日志写入时间。
 * 只认会话根下的 .zstd 日志；graph 备份/临时文件不算活动信号。
 * @param {string} dir
 * @returns {number|null}
 */
export function latestSessionWrite(dir) {
  let names = [];
  try {
    names = nodeFs.readdirSync(dir);
  } catch {
    return null;
  }
  let latest = null;
  for (const name of names) {
    if (!name.endsWith(".zstd")) continue;
    const full = nodePath.join(dir, name);
    try {
      const st = nodeFs.statSync(full);
      if (!st.isFile()) continue;
      if (latest === null || st.mtimeMs > latest) latest = st.mtimeMs;
    } catch {
      // 正在写的文件可能瞬间消失；忽略这一份
    }
  }
  return latest;
}

/**
 * 一次扫描 home/sessions，建立「会话 id → 最近日志 mtime」索引。
 * 日志与棋谱目录不是同一棵树：日志在 home/sessions/<workspace>/<session>/，棋谱在
 * home/chess-context/sessions/<session>/；逐个图目录全树找会把门禁拖成 O(N²)。
 * @param {string} home
 * @returns {Map<string, number>}
 */
export function indexSessionLogs(home) {
  const out = new Map();
  const root = nodePath.join(home, "sessions");
  const walk = (dir) => {
    let entries;
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".zstd")) continue;
      try {
        const latest = nodeFs.statSync(full).mtimeMs;
        const key = sessionKey(nodePath.basename(dir));
        if (!out.has(key) || latest > out.get(key)) out.set(key, latest);
      } catch {
        // 正在写的文件可能瞬间消失；忽略这一份
      }
    }
  };
  walk(root);
  return out;
}

/**
 * 会话是否仍在活动窗口内（默认 15 分钟）。
 * 活跃会话的 fold 可能还没收口，交接门禁应降级为 WARN，而不是 FAIL。
 * @param {string} dir 棋谱会话目录
 * @param {{now?:number, windowMs?:number, logIndex?:Map<string,number>|null}} [options]
 * @returns {boolean}
 */
export function isSessionActive(dir, { now = Date.now(), windowMs = 15 * 60 * 1000, logIndex = null } = {}) {
  let latest = latestSessionWrite(dir);
  if (latest === null && logIndex instanceof Map) {
    latest = logIndex.get(sessionKey(nodePath.basename(dir))) ?? null;
  }
  return latest !== null && now - latest < windowMs;
}
