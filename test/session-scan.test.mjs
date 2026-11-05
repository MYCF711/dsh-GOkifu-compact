/**
 * session-scan.test.mjs —— 多帧 zstd 解析与「真清单」统计（C358 / C359）
 *
 * 由来：宿主会话文件是多帧拼接（9,236 帧），`zstdDecompressSync` 只解第一帧且不报错；
 * 不按帧切就会得出「0 份清单」的错误结论。而按「整行含标记」去数又会把**模型讨论清单**算进来
 * （实测 86 份里绝大多数是假阳性）—— 真清单的身份是 `data.source.kind === "chess-context"`。
 */
import zlib from "node:zlib";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeMultiFrameZstd, ledgerStats } from "../scripts/session-scan.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.resolve(HERE, "..");
const SCAN = nodePath.join(REPO, "scripts", "session-scan.mjs");
const AUDIT = nodePath.join(REPO, "scripts", "undefined-ref-audit.mjs");
const TMP = nodePath.join(HERE, ".harness", "undefined-ref");

/** 跑一个 node 子进程（同一条命令、同一个解释器，跟人手敲一样）。 */
const runNode = (args) => spawnSync(process.execPath, args, { encoding: "utf8" });

/** 写一个**两帧**的宿主会话日志（正好是 C358 那个多帧坑的形状）。 */
function writeTwoFrameLog(file) {
  const line = (tag) =>
    `${JSON.stringify({
      type: "user/message",
      data: { role: "user", content: [{ type: "text", text: `<chess-ledger>\nROOT: ${tag}\n</chess-ledger>` }], source: { kind: "chess-context" } },
    })}\n`;
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(
    file,
    Buffer.concat([zlib.zstdCompressSync(Buffer.from(line("a"))), zlib.zstdCompressSync(Buffer.from(line("b")))]),
  );
  return file;
}

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

tests["C406 图片统计：数 image 块并给出 token 上限（每张 ≤1024，C392）"] = async (t) => {
  const { imageStats } = await import("../scripts/session-scan.mjs");
  t.eq(typeof imageStats, "function", "必须导出 imageStats");
  const text = [
    JSON.stringify({ data: { content: [{ type: "image", source: {} }, { type: "text", text: "x" }] } }),
    JSON.stringify({ data: { content: [{ type: "image" }] } }),
    '{"type":"text"}',
  ].join("\n");
  const s = imageStats(text);
  t.eq(s.images, 2, "应数到 2 个图片块");
  t.eq(s.maxImageTokens, 2048, "上限 = 张数 × 1024");
  t.eq(imageStats("").images, 0, "空文本 0 个");
  t.eq(imageStats("没有图片").maxImageTokens, 0, "无图 ⇒ 0 token");
};

// ───────────── C651：纯转发（`export { X } from`）不建本地绑定 —— 直接跑就 ReferenceError ─────────────

tests["C651 直接跑 CLI 不报 ReferenceError（真子进程、真多帧文件）"] = (t) => {
  // 复现形状：`node scripts/session-scan.mjs --file <多帧 zstd>` 曾抛
  //   ReferenceError: decodeMultiFrameZstd is not defined（re-export 不建本地绑定，main() 却要用它）
  const file = writeTwoFrameLog(nodePath.join(TMP, "two-frames.v4.jsonl.zstd"));
  const r = runNode([SCAN, "--file", file]);
  t.eq(r.status, 0, `CLI 必须正常退出（修前退出码 1 + ReferenceError）· stderr=${String(r.stderr).slice(0, 300)}`);
  t.notIncludes(r.stderr, "ReferenceError", "stderr 不许出现 ReferenceError");
  t.includes(r.stdout, "帧 2", "必须真的解出 2 帧（不是只解第一帧）");
  t.includes(r.stdout, "清单消息 **2**", "两帧都是 chess-context ⇒ 2 份真清单");
};

tests["C651 main() 进程内可用 + re-export 对消费者仍然有效"] = async (t) => {
  // 两个方向都要绿：① main() 自己能用（本地绑定）；② `import { X }` 的消费者还能拿到（转发）
  const file = writeTwoFrameLog(nodePath.join(TMP, "main-callable.v4.jsonl.zstd"));
  const { main } = await import("../scripts/session-scan.mjs");
  const code = main(["--file", file, "--json"]);
  t.eq(code, 0, "main 必须返回 0（修前这里必抛 ReferenceError）");

  // 消费者：6 个 scripts 都写 `import { decodeMultiFrameZstd } from "./session-scan.mjs"`
  const viaReExport = decodeMultiFrameZstd(
    Buffer.concat([zlib.zstdCompressSync(Buffer.from("x\n")), zlib.zstdCompressSync(Buffer.from("y\n"))]),
  );
  t.eq(viaReExport.frames, 2, "从 session-scan 拿到的解码器必须还能用（C498 的转发契约不许破）");
  t.eq(viaReExport.text, "x\ny\n", "两帧内容都要出来");
};

tests["C651 审计脚本能抓到同类问题：已知坏夹具必须红、修好后必须绿"] = (t) => {
  // 自证：扫描器自己不坏（内置 known-bad 必须被抓到、known-good / lookalike 必须 0）
  const selfTest = runNode([AUDIT, "--self-test"]);
  t.eq(selfTest.status, 0, `--self-test 必须通过（否则扫描器数不出东西还报绿）· ${selfTest.stdout}${selfTest.stderr}`);

  const root = nodePath.join(TMP, "fixture-root");
  const fixture = nodePath.join(root, "scripts", "bad.mjs");
  const planted = "decodePlantedThing"; // 故意换个名字：防"硬编码知道这一个"
  const BAD = [
    'export { decodePlantedThing } from "./codec.mjs";',
    "",
    "export function run(buf) {",
    "  return decodePlantedThing(buf);", // ← 只在本地用，没 import
    "}",
  ].join("\n");
  const GOOD = [
    'import { decodePlantedThing } from "./codec.mjs";',
    "export { decodePlantedThing };",
    "",
    "export function run(buf) {",
    "  return decodePlantedThing(buf);",
    "}",
  ].join("\n");

  nodeFs.mkdirSync(nodePath.dirname(fixture), { recursive: true });
  nodeFs.writeFileSync(fixture, BAD);
  const red = runNode([AUDIT, "--root", root]);
  t.eq(red.status, 1, `已知坏夹具必须让审计红（退出码 1），实际 ${red.status}`);
  t.includes(red.stdout, planted, `必须点名 ${planted}`);
  t.includes(red.stdout, "free-identifier", "必须归到 free-identifier 这一类");

  nodeFs.writeFileSync(fixture, GOOD);
  const green = runNode([AUDIT, "--root", root]);
  t.eq(green.status, 0, `修好后必须绿（退出码 0），实际 ${green.status} · ${green.stdout}`);
  t.includes(green.stdout, "0 处", "修好后应为 0 处");
};

tests["C651 本仓 session-scan.mjs 逐文件复核：0 处未定义引用"] = async (t) => {
  // 门禁跟着实现走：以后谁再把 import 删成纯转发，这条 + 上面那条子进程用例都会红
  const { analyzeSource } = await import("../scripts/undefined-ref-audit.mjs");
  const { findings } = analyzeSource(nodeFs.readFileSync(SCAN, "utf8"), "scripts/session-scan.mjs");
  t.eq(findings.length, 0, `session-scan.mjs 不许再有未定义引用，实际 ${JSON.stringify(findings)}`);

  // 反向自证：把修法还原成"纯转发"，同一个分析器必须立刻报它
  const reverted = [
    'export { decodeMultiFrameZstd } from "../src/rooms/zstd-log.mjs";',
    "",
    "export function main(file) {",
    "  const r = decodeMultiFrameZstd(file);",
    "  return r.text.length;",
    "}",
  ].join("\n");
  const { findings: revertedFindings } = analyzeSource(reverted, "scripts/session-scan.mjs@reverted");
  t.eq(revertedFindings.length, 1, "还原成纯转发后必须恰好报 1 处");
  t.eq(revertedFindings[0]?.name, "decodeMultiFrameZstd", "报的必须是 decodeMultiFrameZstd");
};
