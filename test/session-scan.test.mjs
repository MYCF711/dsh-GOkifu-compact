/**
 * session-scan.test.mjs —— 多帧 zstd 解析与清单统计（C358）
 *
 * 由来：宿主会话文件是多帧拼接（9,236 帧），`zstdDecompressSync` 只解第一帧且不报错；
 * 不按帧切就会得出「0 份清单」的错误结论。
 */
import zlib from "node:zlib";
import { decodeMultiFrameZstd, ledgerStats } from "../scripts/session-scan.mjs";

export const tests = {};

tests["C358 多帧 zstd：必须逐帧解压（只解第一帧会静默丢内容）"] = (t) => {
  // 造 3 帧拼接
  const parts = ["aaa\n", "bbb\n", "ccc\n"].map((s) => zlib.zstdCompressSync(Buffer.from(s, "utf8")));
  const buf = Buffer.concat(parts);
  const { text, frames, okFrames } = decodeMultiFrameZstd(buf);
  t.eq(frames, 3, "应识别出 3 帧");
  t.eq(okFrames, 3, "3 帧都应解压成功");
  t.eq(text, "aaa\nbbb\nccc\n", "内容必须完整（只解第一帧只会得到 aaa）");
  // 对照：单次解压确实只能拿到第一帧
  t.eq(zlib.zstdDecompressSync(buf).toString("utf8"), "aaa\n", "单次解压只给第一帧（这就是坑）");
};

tests["C358 清单统计：数份数、最大体积、占位识别"] = (t) => {
  const mk = (content) => JSON.stringify({ role: "user", content });
  const text = [
    mk("<chess-ledger>\nROOT: a\n</chess-ledger>"),
    mk("<chess-ledger>\nROOT: b\n</chess-ledger>"),
    mk("<chess-ledger>（已省略 12 条旧清单）</chess-ledger>"),
    mk("普通消息"),
  ].join("\n");
  const s = ledgerStats(text);
  t.eq(s.ledgers, 3, "应数到 3 份清单");
  t.eq(s.placeholderLike, 1, "占位那份要能识别");
  t.eq(s.maxChars > 0, true, "最大体积要算出来");
  t.eq(s.totalChars > s.maxChars, true, "合计应大于最大");

  // 非 JSON 行也要能数（不崩）
  t.eq(ledgerStats("<chess-ledger>x</chess-ledger>").ledgers, 1, "非 JSON 行也要数到");
  t.eq(ledgerStats("").ledgers, 0, "空文本 0 份");
};
