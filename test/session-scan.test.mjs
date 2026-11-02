/**
 * session-scan.test.mjs —— 多帧 zstd 解析与「真清单」统计（C358 / C359）
 *
 * 由来：宿主会话文件是多帧拼接（9,236 帧），`zstdDecompressSync` 只解第一帧且不报错；
 * 不按帧切就会得出「0 份清单」的错误结论。而按「整行含标记」去数又会把**模型讨论清单**算进来
 * （实测 86 份里绝大多数是假阳性）—— 真清单的身份是 `data.source.kind === "chess-context"`。
 */
import zlib from "node:zlib";
import { decodeMultiFrameZstd, ledgerStats } from "../scripts/session-scan.mjs";

export const tests = {};

tests["C358 多帧 zstd：必须逐帧解压（只解第一帧会静默丢内容）"] = (t) => {
  const parts = ["aaa\n", "bbb\n", "ccc\n"].map((s) => zlib.zstdCompressSync(Buffer.from(s, "utf8")));
  const buf = Buffer.concat(parts);
  const { text, frames, okFrames } = decodeMultiFrameZstd(buf);
  t.eq(frames, 3, "应识别出 3 帧");
  t.eq(okFrames, 3, "3 帧都应解压成功");
  t.eq(text, "aaa\nbbb\nccc\n", "内容必须完整（只解第一帧只会得到 aaa）");
  t.eq(zlib.zstdDecompressSync(buf).toString("utf8"), "aaa\n", "单次解压只给第一帧（这就是坑）");
};

tests["C359 清单统计只认真注入（source.kind=chess-context），别把「讨论清单」也算进去"] = (t) => {
  const mk = (content, kind) =>
    JSON.stringify({
      type: "user/message",
      data: { role: "user", content: [{ type: "text", text: content }], source: kind ? { kind } : {} },
    });
  const text = [
    mk("<chess-ledger>\nROOT: a\n</chess-ledger>", "chess-context"),
    mk("<chess-ledger>\nROOT: b\n</chess-ledger>", "chess-context"),
    mk("<chess-ledger>（已省略 12 条旧清单）</chess-ledger>", "chess-context"),
    mk("我看到 <chess-ledger> 里有 5 处折叠记录", "other"),
  ].join("\n");

  const s = ledgerStats(text);
  t.eq(s.ledgers, 3, "只数真注入的 3 份");
  t.eq(s.placeholderLike, 1, "占位那份要能识别");
  t.eq(s.mentions, 4, "包含所有提到标记的行（含讨论）");
  t.eq(s.maxChars > 0, true, "最大体积要能算出来（从 blocks 里拼）");
  t.eq(ledgerStats("").ledgers, 0, "空文本 0 份");
  t.eq(ledgerStats("不是 JSON 但提到 <chess-ledger>").unparsable, 1, "不可解析的行单独计数");
};
