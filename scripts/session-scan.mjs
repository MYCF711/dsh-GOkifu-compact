/**
 * session-scan.mjs —— 只读解析宿主会话文件（多帧 zstd），数清单份数与体积（C358）
 *
 * 由来：想验证「热清单是**替换**还是**追加**」，第一反应是 grep 会话文件 —— 但那文件是
 * **多帧拼接的 zstd**：`zstdDecompressSync` 只解第一帧（232 字节）且**不报错**，
 * 流式解码器直接 `Unknown frame descriptor`（见 `docs/knowledge/宿主会话文件格式-zstd多帧.md`）。
 *
 * 正确解法：**按 zstd magic（28 B5 2F FD）切帧，逐帧解压**。
 * 实测（<redacted>）：9,236 帧全部可解，得到 37 MB JSONL。
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
// ★ C498：多帧解码已搬进 src/rooms/zstd-log.mjs（插件进程也要读日志），这里只做转发
// ★ C651：`export { X } from "…"` **只转发、不建本地绑定** —— 而 `main()` 自己要用它。
//   所以必须先 `import` 再 `export`（纯 re-export 那句让 CLI 一跑就 ReferenceError）。
import { decodeMultiFrameZstd } from "../src/rooms/zstd-log.mjs";
export { decodeMultiFrameZstd };

/**
 * ★ C359：统计**真清单消息**。
 *
 * 关键修正：C358 的版本按"整行含 `<chess-ledger>`"来数 —— 实测**几乎全是假阳性**：
 * 模型在推理/回答里讨论清单格式时也会出现这个字面量（一条 assistant 消息里出现 5 次的那种）。
 * 真清单的身份是 `data.source.kind === "chess-context"`（我们注入的那条 user 消息）。
 *
 * @param {string} text
 * @returns {{ledgers:number, placeholderLike:number, maxChars:number, medianChars:number,
 *            totalChars:number, mentions:number, unparsable:number}}
 */
export function ledgerStats(text) {
  const sizes = [];
  let placeholderLike = 0;
  let mentions = 0;
  let unparsable = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.includes("<chess-ledger>")) continue;
    mentions += 1;
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      unparsable += 1;
      continue;
    }
    const kind = msg?.data?.source?.kind ?? msg?.data?.message?.source?.kind ?? msg?.source?.kind ?? null;
    if (kind !== "chess-context") continue; // 不是我们注入的：只是"提到"了清单
    // 真身：`data.content` 是 block 数组（实测），也兼容 `data.message.content` / 顶层 content
    const raw = msg?.data?.content ?? msg?.data?.message?.content ?? msg?.content ?? "";
    const s2 = Array.isArray(raw)
      ? raw.map((b) => (typeof b?.text === "string" ? b.text : "")).join("")
      : typeof raw === "string"
        ? raw
        : JSON.stringify(raw);
    if (/已省略|elided|legacy elided|占位/.test(s2)) placeholderLike += 1;
    sizes.push(s2.length);
  }
  sizes.sort((a, b) => b - a);
  const total = sizes.reduce((a, b) => a + b, 0);
  return {
    ledgers: sizes.length,
    placeholderLike,
    maxChars: sizes[0] ?? 0,
    medianChars: sizes.length === 0 ? 0 : sizes[Math.floor(sizes.length / 2)],
    totalChars: total,
    mentions,
    unparsable,
  };
}

/**
 * ★ C406：数图片块。官方 Vision：图片自动缩放到 约 1300×1300 像素 ⇒ **每张上限 1024 token**（C392）。
 * 我们的 `estimateTokens()` 只数文本 ⇒ 这里至少把"盲区有多大"量出来。
 * @param {string} text
 * @returns {{images:number, maxImageTokens:number}}
 */
export function imageStats(text) {
  const images = (String(text ?? "").match(/"type"\s*:\s*"image"/g) ?? []).length;
  return { images, maxImageTokens: images * 1024 };
}

/** 在 DSH_HOME 下按会话 id 前缀找/** 在 DSH_HOME 下按会话 id 前缀找 `session.v4.jsonl.zstd`。 */
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
  const img = imageStats(text);
  if (img.images > 0) {
    console.log(`  图片块 **${img.images}** 个 ⇒ 上限 约 **${img.maxImageTokens.toLocaleString()}** token（每张 ≤1024，C392）—— 这部分不进我们的文本估算`);
  }
  console.log(
    `  清单消息 **${stats.ledgers}** 份（疑似占位 ${stats.placeholderLike}）· 最大 ${stats.maxChars} 字 · 中位 ${stats.medianChars} 字 · 合计 ${stats.totalChars} 字`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
