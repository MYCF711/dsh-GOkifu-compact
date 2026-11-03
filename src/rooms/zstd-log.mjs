/**
 * zstd-log.mjs —— 读宿主会话日志（多帧 zstd）的最小实现（C498）
 *
 * 由来：这段代码原来只在 `scripts/session-scan.mjs` 里，而**插件进程**也要用它 ——
 * 归档后的会话只能从日志里读回来（宿主的 surface 已经没了）。
 * `src/rooms/` 不许 import `scripts/`（C3 守卫），所以把它搬到这里，脚本侧改为转发。
 */
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

/** zstd 帧 magic（小端 u32 = 0xFD2FB528）。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/**
 * 把多帧 zstd 拆成逐帧解压后的文本。
 *
 * 宿主把会话写成一串**首尾相接的 zstd 帧**（真机单个文件 9,236 帧），
 * `zstdDecompressSync` 只解**第一帧而且不报错** —— 这正是当初"只看到开头几十条消息"的原因。
 *
 * @param {Buffer} buf
 * @returns {{text: string, frames: number, okFrames: number}}
 */
export function decodeMultiFrameZstd(buf) {
  const b = buf;
  const starts = [];
  // ★ C463：用 Buffer.indexOf 找 magic，不要逐字节 for（35MB 文件 = 3500 万次 JS 迭代）
  const magic = Buffer.from(ZSTD_MAGIC);
  let from = 0;
  for (;;) {
    const at = b.indexOf(magic, from);
    if (at < 0) break;
    starts.push(at);
    from = at + magic.length;
  }
  const parts = [];
  let okFrames = 0;
  for (let k = 0; k < starts.length; k += 1) {
    const end = starts[k + 1] ?? b.length;
    try {
      parts.push(zlib.zstdDecompressSync(b.subarray(starts[k], end)));
      okFrames += 1;
    } catch {
      /* 误切的 magic：解压失败就跳过 */
    }
  }
  return { text: Buffer.concat(parts).toString("utf8"), frames: starts.length, okFrames };
}

/**
 * 按会话 id 前缀在 `<home>/sessions/` 下找会话日志文件（多帧 zstd）。
 * @param {string} home DSH_HOME
 * @param {string} sessionId 完整或前缀
 * @returns {string|null}
 */
export function findSessionLog(home, sessionId) {
  const want = String(sessionId ?? "");
  if (want === "") return null;
  const root = path.join(String(home ?? ""), "sessions");
  let found = null;
  const walk = (dir) => {
    if (found !== null) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found !== null) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".zstd") && p.includes(want)) found = p;
    }
  };
  walk(root);
  return found;
}

/**
 * 读会话日志 → 事件数组（坏行跳过；读不到就是空数组，调用方自己判断）。
 * @param {string} logFile
 * @returns {Array<object>}
 */
export function readSessionEvents(logFile) {
  let text;
  try {
    text = decodeMultiFrameZstd(fs.readFileSync(logFile)).text;
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}
