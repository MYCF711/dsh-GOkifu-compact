/**
 * session-scan.mjs —— 只读解析宿主会话文件（多帧 zstd），数清单份数与体积（C358）
 *
 * 由来：想验证「热清单是**替换**还是**追加**」，第一反应是 grep 会话文件 —— 但那文件是
 * **多帧拼接的 zstd**：`zstdDecompressSync` 只解第一帧（232 字节）且**不报错**，
 * 流式解码器直接 `Unknown frame descriptor`（见 `docs/knowledge/宿主会话文件格式-zstd多帧.md`）。
 *
 * 正确解法：**按 zstd magic（28 B5 2F FD）切帧，逐帧解压**。
 * 实测（session-8a73e06b）：9,236 帧全部可解，得到 37 MB JSONL。
 *
 * 用法：
 *   node scripts/session-scan.mjs --file <session.v4.jsonl.zstd>
 *   node scripts/session-scan.mjs --session <会话 id 前缀>   # 在 DSH_HOME 下自动找
 *   node scripts/session-scan.mjs --file <…> --json
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/**
 * ★ C358：把多帧 zstd 拆成逐帧解压后的文本（纯函数，输入 Buffer，输出 string）。
 * 只按 magic 切分 —— 压缩数据里出现同样 4 字节的概率极低，且解压失败会被跳过（不会污染结果）。
 * @param {Buffer} buf
 * @returns {{text: string, frames: number, okFrames: number}}
 */
export function decodeMultiFrameZstd(buf) {
  const b = buf;
  const starts = [];
  for (let i = 0; i + 4 <= b.length; i += 1) {
    if (b[i] === ZSTD_MAGIC[0] && b[i + 1] === ZSTD_MAGIC[1] && b[i + 2] === ZSTD_MAGIC[2] && b[i + 3] === ZSTD_MAGIC[3]) {
      starts.push(i);
    }
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
 * ★ C358：统计一份会话文本里的**清单消息**。纯函数。
 * @param {string} text
 * @returns {{ledgers:number, placeholderLike:number, maxChars:number, medianChars:number, totalChars:number}}
 */
export function ledgerStats(text) {
  const sizes = [];
  let placeholderLike = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.includes("<chess-ledger>")) continue;
    let content = line;
    try {
      const msg = JSON.parse(line);
      content = typeof msg?.content === "string" ? msg.content : JSON.stringify(msg);
    } catch {
      /* 非 JSON 行：按原样算 */
    }
    if (/已省略|elided|legacy elided|占位/.test(content)) placeholderLike += 1;
    sizes.push(content.length);
  }
  sizes.sort((a, b) => b - a);
  const total = sizes.reduce((a, b) => a + b, 0);
  return {
    ledgers: sizes.length,
    placeholderLike,
    maxChars: sizes[0] ?? 0,
    medianChars: sizes.length === 0 ? 0 : sizes[Math.floor(sizes.length / 2)],
    totalChars: total,
  };
}

/** 在 DSH_HOME 下按会话 id 前缀找 `session.v4.jsonl.zstd`。 */
export function findSessionFile(home, prefix) {
  const root = nodePath.join(home, "sessions");
  if (!nodeFs.existsSync(root)) return null;
  for (const ws of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = nodePath.join(root, ws.name);
    for (const s of nodeFs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      if (!s.name.startsWith(prefix)) continue;
      const file = nodePath.join(wsDir, s.name, "session.v4.jsonl.zstd");
      if (nodeFs.existsSync(file)) return file;
    }
  }
  return null;
}

export function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const home = getArg("home", process.env.DSH_HOME ?? "");
  const sessionPrefix = getArg("session", null);
  const file = getArg("file", null) ?? (sessionPrefix !== null && home !== "" ? findSessionFile(home, sessionPrefix) : null);
  if (file === null || !nodeFs.existsSync(file)) {
    console.log("需要 --file <session.v4.jsonl.zstd>，或 --session <id 前缀> + DSH_HOME");
    return 2;
  }
  const { text, frames, okFrames } = decodeMultiFrameZstd(nodeFs.readFileSync(file));
  const stats = ledgerStats(text);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ file, frames, okFrames, bytes: text.length, ...stats }, null, 2));
    return 0;
  }
  console.log(`== 会话扫描 · ${nodePath.basename(nodePath.dirname(file))} ==`);
  console.log(`  帧 ${frames}（解压成功 ${okFrames}）· 解压后 ${(text.length / 1e6).toFixed(1)} MB`);
  console.log(
    `  清单消息 **${stats.ledgers}** 份（疑似占位 ${stats.placeholderLike}）· 最大 ${stats.maxChars} 字 · 中位 ${stats.medianChars} 字 · 合计 ${stats.totalChars} 字`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
