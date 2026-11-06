/**
 * rewash-graph.mjs —— 用**当前的** verifier 重洗历史棋谱（数据层修复）
 *
 * 背景（HANDOFF 未完成清单）：`session-5acafe42` 的 101 条 failure 里有 43 条是 verifier 误报
 * （`verify.kind === "text"`：只读工具的叙述文本里出现了「失败」二字），而且很多 `errorSnippet`
 * 是旧版取法抓来的噪声（例如 Python traceback 只抓到 `[stderr]` + 第一帧，真正的异常那行没抓到）。
 *
 * 这个工具做两件事，都用**当时的原始输出**重算（不是猜）：
 *   1. 重算 `errorSnippet`：从会话日志里按 `edge.evidence.{start,end}` 找到 tool/result 原文，
 *      用当前 `errorSnippet()` 重新取「结论行」。
 *   2. 重判 result：用当前 `classify()` 重跑一遍；判不出来（unverified）就把 failure 降级，
 *      并留 `rewashed` 审计字段（谁改的、原值是什么）。
 *
 * 安全纪律：
 *   · 默认 **dry-run**，只打印；`--apply` 才写。
 *   · 写之前备份 `graph.json.bak-before-rewash-<ts>`；写顺序沿用引擎的提交点语义（先树后 json）。
 *   · 会话还在写（文件 mtime 很新）时**拒绝**执行 —— 运行中的 `#flush` 会覆盖我们的改动。
 *
 * 用法：
 *   node test/rewash-graph.mjs <sessionDir>                 # dry-run
 *   node test/rewash-graph.mjs <sessionDir> --apply         # 真写（含重建三层树）
 *   node test/rewash-graph.mjs <sessionDir> --apply --force  # 忽略「会话可能还在写」的检查
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { fromJSON, toJSON, renderIndexMd, renderNodeMd } from "../src/rooms/kifu-model.mjs";
import { classify, errorSnippet } from "../src/rooms/verify.mjs";

const args = process.argv.slice(2);
const dirArg = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");
const force = args.includes("--force");
if (!dirArg) {
  console.error("用法：node test/rewash-graph.mjs <sessionDir> [--apply] [--force]");
  process.exit(1);
}

const dir = nodePath.resolve(dirArg);
const graphFile = nodePath.join(dir, "graph.json");
if (!nodeFs.existsSync(graphFile)) {
  console.error(`找不到 ${graphFile}`);
  process.exit(1);
}

/**
 * 会话日志不在棋谱目录里：它在 `<DSH_HOME>/sessions/<workspace>/session-<id>/`。
 * 按棋谱目录名（= session id）去那里找。
 */
function findSessionLog() {
  const local = nodePath.join(dir, "session.v4.jsonl.zstd");
  if (nodeFs.existsSync(local)) return local;
  const home = process.env.DSH_HOME ?? nodePath.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dsh");
  const root = nodePath.join(home, "sessions");
  const wanted = nodePath.basename(dir);
  if (!nodeFs.existsSync(root)) return "";
  for (const ws of nodeFs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const candidate = nodePath.join(root, ws.name, wanted, "session.v4.jsonl.zstd");
    if (nodeFs.existsSync(candidate)) return candidate;
  }
  return "";
}

const logFile = findSessionLog();
if (!logFile) {
  console.error(`找不到会话日志（在 <DSH_HOME>/sessions/*/${nodePath.basename(dir)}/ 下也没有）—— rewash 需要原始输出才能重算`);
  process.exit(1);
}
console.log(`会话日志：${logFile}`);

const ageMs = Date.now() - nodeFs.statSync(logFile).mtimeMs;
if (!force && ageMs < 120_000) {
  console.error(`拒绝执行：会话日志 ${Math.round(ageMs / 1000)} 秒前还在写（运行中的 #flush 会覆盖改动）。用 --force 覆盖此检查。`);
  process.exit(2);
}

const PY_DECOMPRESS = `
import sys, zstandard
with open(sys.argv[1], 'rb') as f:
    sys.stdout.buffer.write(zstandard.ZstdDecompressor().stream_reader(f, read_across_frames=True).read())
`;
const raw = execFileSync("python", ["-c", PY_DECOMPRESS, logFile], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8");
const events = [];
for (const line of raw.split("\n")) {
  if (line.length === 0) continue;
  try {
    events.push(JSON.parse(line));
  } catch {
    /* 坏行跳过 */
  }
}
const bySeq = new Map(events.map((e) => [e.seq, e]));

/**
 * 一条边对应区间内的 tool/result 原文 + 工具名。
 *
 * ★ 证据区间可能**错位**（实测 e20 的 evidence 指向了别的步骤、e373 的区间里根本没有那条 traceback）。
 *   错位时绝不能拿去覆盖/降级 —— 会把真失败洗掉。所以这里加一道**对齐校验**：
 *   区间里找到的 tool/call 参数，必须包含这条边 `action` 里的那段命令（前 40 字）。
 *   对不上就返回 `{ mismatch: true }`，调用方跳过。
 */
function resultFor(edge) {
  const evidence = edge.evidence;
  if (!evidence || typeof evidence !== "object" || typeof evidence.start !== "number") return null;
  const end = typeof evidence.end === "number" ? evidence.end : evidence.start;
  let tool = "";
  let text = "";
  let isError = false;
  let args = "";
  for (let seq = evidence.start; seq <= end; seq += 1) {
    const event = bySeq.get(seq);
    if (!event) continue;
    if (event.type === "tool/call") {
      if (!tool) tool = String(event.data?.name ?? "");
      args += `${event.data?.arguments ?? ""}\n`;
    }
    if (event.type === "user/message" || event.type === "assistant/message") {
      const msg = event.data?.message;
      if (!msg) continue;
      const toolCall = (msg.content ?? []).find((block) => block?.type === "tool-call");
      if (toolCall && !tool) {
        tool = String(toolCall.name ?? "");
        args += `${toolCall.arguments ?? ""}\n`;
      }
    }
    if (event.type === "tool/result") {
      const msg = event.data?.message;
      if (!msg) continue;
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      text += blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n") + "\n";
      if (msg.isError === true) isError = true;
    }
  }
  if (text.trim().length === 0) return null;
  // 对齐校验：action 形如 `bash(command=cd /d/… && node …)`（已被 norm 压过空白、且可能截断），
  // 而 tool/call 的 arguments 是 JSON（保留 \n 与转义）—— 两边都做「去转义 + 压空白」再比前 30 字。
  const action = String(edge.action ?? "");
  const inner = /^[A-Za-z0-9_-]+\((.*)\)$/s.exec(action)?.[1] ?? "";
  const valuePart = inner.includes("=") ? inner.slice(inner.indexOf("=") + 1) : inner;
  const squash = (x) => String(x).replace(/\\[nrt"]/g, " ").replace(/\s+/g, " ").trim();
  const probe = squash(valuePart).slice(0, 30);
  const aligned = probe.length < 8 || squash(args).includes(probe);
  return { tool, text, isError, aligned };
}

const g = fromJSON(nodeFs.readFileSync(graphFile, "utf8"));
const rows = [];
let snippetChanged = 0;
let downgraded = 0;
let rekinded = 0;
let noEvidence = 0;
let misaligned = 0;
/** 这段文字里有没有「像错误」的信号（决定要不要拿它覆盖原 snippet）。 */
const ERRORISH = /(?:ENOENT|EACCES|EPERM|ETIMEDOUT|ECONNREFUSED|Traceback|Cannot find|MODULE_NOT_FOUND|No such file|Permission denied|[A-Za-z_$][\w$]*(?:Error|Exception)\s*:|error:|Error:|FAILED|fatal:|unknown command|command not found|\[exit code:\s*[1-9])/;
/**
 * 「原文里确实有硬错误」的信号 —— 用来避免把**真失败**洗成 unverified。
 * 实测：e11 的 `Error [ERR_MODULE_NOT_FOUND]: Cannot find module …` 是真错误，
 * 但 bash 没给退出码，当前 verifier 只能判 unverified；直接降级会把它从死路清单里抹掉。
 */
const HARD_SIGNAL = /(?:ENOENT|EACCES|EPERM|ETIMEDOUT|ECONNREFUSED|ERR_[A-Z_]+|Cannot find module|MODULE_NOT_FOUND|Traceback|No such file|Permission denied|[A-Za-z_$][\w$]*(?:Error|Exception)\s*:|fatal:|unknown command|command not found)/i;

for (const edge of Object.values(g.edges)) {
  if (edge.result !== "failure") continue;
  // ★ 范围限定：只洗旧版 text 型（HANDOFF 点名的那 43 条）。exit/test/host-error 的证据区间无法可靠对齐，
  //   实测 e21/e38 的区间落在别的步骤上（贴着同前缀的另一条命令），动了只会把别处的输出搬过来。
  if (String(edge.verify?.kind ?? "") !== "text") continue;
  const source = resultFor(edge);
  if (source === null) {
    noEvidence += 1;
    continue;
  }
  if (source.aligned === false) {
    misaligned += 1;
    continue;
  }
  const verdict = classify(source);
  const snip = errorSnippet(source.text);
  const before = { result: edge.result, errorSnippet: edge.errorSnippet, kind: edge.verify?.kind };
  const change = { id: edge.id, tool: source.tool, before, after: { result: verdict.result, errorSnippet: snip, kind: verdict.verify?.kind } };

  // ★ 保守策略：只在「有把握」时改。
  //  · snippet：新取法抓到像错误的行，且与原来不同 ⇒ 换掉（原 snippet 常常是噪声/截断的头部）
  //  · 只处理**旧版 text 型**（HANDOFF 点名的那 43 条误报）；exit / test / host-error 的旧判定不动 ——
  //    证据区间偶尔错位（实测 e20 的证据落在别的步骤上），贸然降级会把真失败洗成 unverified。
  //  · text 型里「原文确有硬错误」的**不降级**，只把 kind 改成 hard-error（诚实：确有错误，只是没有退出码）。
  const snippetDiffers = snip.length > 0 && snip !== String(edge.errorSnippet ?? "") && ERRORISH.test(snip);
  const wasText = String(edge.verify?.kind ?? "") === "text";
  const hard = HARD_SIGNAL.test(source.text);
  if (snippetDiffers) {
    edge.errorSnippet = snip;
    snippetChanged += 1;
  }
  if (wasText && verdict.result === "failure") {
    // 仍然是失败，但旧 kind 是 text ⇒ 换成重判出来的 kind（host-error / error-line / test …）
    edge.verify = verdict.verify;
    edge.rewashed = { at: Date.now(), from: { result: "failure", kind: "text" }, to: { result: "failure", kind: verdict.verify?.kind } };
    rekinded += 1;
  } else if (wasText && verdict.result !== "failure") {
    if (hard) {
      edge.verify = { kind: "hard-error", summary: (snip.split("\n")[0] ?? "").slice(0, 160) };
      edge.rewashed = { at: Date.now(), from: { result: "failure", kind: "text" }, to: { result: "failure", kind: "hard-error" }, why: "text→hard-error（原文确有错误信号）" };
      rekinded += 1;
    } else {
      edge.result = verdict.result;
      edge.rewashed = { at: Date.now(), from: { result: "failure", kind: "text" }, to: { result: verdict.result, kind: verdict.verify?.kind ?? "none" }, why: "text 型误报：原文没有错误信号", snippetBefore: before.errorSnippet };
      downgraded += 1;
    }
  }
  if (snippetDiffers || wasText) {
    change.after = { result: edge.result, errorSnippet: edge.errorSnippet, kind: edge.verify?.kind };
    rows.push(change);
  }
}

console.log(`== rewash ${nodePath.basename(dir)} ==`);
console.log(`失败边：${Object.values(g.edges).filter((e) => e.result === "failure" || e.rewashed).length} 条待检；无原始输出可查：${noEvidence}；证据区间对不上（已跳过）：${misaligned}`);
console.log(`将改 errorSnippet：${snippetChanged} 条；text→hard-error：${rekinded} 条；降级 failure→unverified：${downgraded} 条`);
for (const row of rows.slice(0, 12)) {
  console.log(`  ${row.id} (${row.tool})`);
  console.log(`    before: ${row.before.result} / ${row.before.kind} / ${JSON.stringify(String(row.before.errorSnippet).slice(0, 90))}`);
  console.log(`    after : ${row.after.result} / ${row.after.kind} / ${JSON.stringify(row.after.errorSnippet.slice(0, 90))}`);
}
if (rows.length > 12) console.log(`  … 另有 ${rows.length - 12} 条（省略显示）`);

if (!apply) {
  console.log("\n（dry-run：没有写任何文件。加 --apply 才写。）");
  process.exit(0);
}
if (snippetChanged === 0 && downgraded === 0 && rekinded === 0) {
  console.log("\n没有任何改动，不写文件。");
  process.exit(0);
}

const stamp = Date.now();
nodeFs.copyFileSync(graphFile, `${graphFile}.bak-before-rewash-${stamp}`);
// 先树后 json：json 是提交点（引擎的写序约定）
nodeFs.writeFileSync(nodePath.join(dir, "index.md"), renderIndexMd(g), "utf8");
nodeFs.mkdirSync(nodePath.join(dir, "nodes"), { recursive: true });
let written = 0;
for (const id of Object.keys(g.nodes)) {
  if (!g.nodes[id]) continue;
  nodeFs.writeFileSync(nodePath.join(dir, "nodes", `${id}.md`), renderNodeMd(g, id), "utf8");
  written += 1;
}
nodeFs.writeFileSync(graphFile, toJSON(g), "utf8");
console.log(`\n已写入：errorSnippet ${snippetChanged} 条、降级 ${downgraded} 条；树 ${written} 个节点 + index.md；备份 ${nodePath.basename(graphFile)}.bak-before-rewash-${stamp}`);
