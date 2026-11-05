#!/usr/bin/env node
/**
 * nul-byte-audit.mjs —— 「源码里不许有字面 NUL / 控制字符」的机器审计（T43，2026-11-05）
 *
 * 为什么要有它（真机成本，不是洁癖）：
 *   `src/rooms/keeper.mjs` 的 `actionSignature` 里有一个**字面 NUL（0x00）**（用 NUL 当工具名/参数的
 *   分隔符，语义是对的），但它是**真字节**而不是转义写法 `\u0000`。后果：
 *     · `git diff --stat` 变成 `Bin 16735 -> 21499 bytes`（0 insertions / 0 deletions）；
 *     · `git diff` 输出为空、`grep` 判整个文件 binary ⇒ **看不见人改了什么**。
 *   一晚上因为这个来回跑了多次（要加 `-a` 才看得见）。同一种坑在文档里已经踩过两回
 *   （`\b` 被写成真退格符 —— `docs/knowledge/进度.md` 与 `HANDOFF.md` 里都留着现场）。
 *
 * 它查什么（口径写死，避免"我以为它查了"）：
 *   ① **0x00（字面 NUL）**：唯一会让 git / grep / diff 把文本文件当二进制的字节。
 *      注意 git 只在**前 8000 字节**里找 0x00 —— keeper.mjs 那个在偏移 6789，正中靶心。
 *      ⇒ `--check` 时**它是判分项**（有就退出码 1）。
 *   ② **其它控制字符**（0x01–0x08 / 0x0B / 0x0C / 0x0E–0x1F）：不触发二进制判定，但同样是
 *      编辑器/粘贴事故的产物 ⇒ 默认**只报告**，`--strict` 才一起判红。
 *   ③ **0x09 TAB / 0x0A LF / 0x0D CR 是正常空白**，永远不算命中。
 *
 * 「故意还是意外」怎么判（`intent` 字段）—— **是启发式，不是 JS 解析器**，所以判据只有两条，
 * 全写在输出里，人一眼能复核：
 *   · **故意**：控制字符**紧贴 `${…}` 插值**（`}⟪0x00⟫${` 这种形状）⇒ 模板串里的分隔符/哨兵；
 *   · **意外**：其余全部 —— 注释里、正文里、代码里出现的裸控制字符。
 *     这一侧刻意判得**宽**（宁可把"其实故意的写法"也列成意外让人看一眼，也不要漏报）。
 *
 * 二进制文件为什么不会混进来：按**扩展名白名单**扫描（.mjs .js .md .json .yml），
 * 另有一张二进制扩展名黑名单做双保险（.png .jpg .zip .asar …），并且 `.git` / `node_modules` /
 * `tmp` 与**所有 `.` 开头的目录/文件**（测试运行器生成的临时副本，如 `src/.engine-under-test-p3.mjs`）
 * 整枝跳过 —— 跳过的东西会打在输出的「跳过」行里，不是悄悄消失。
 *
 * 用法：
 *   node scripts/nul-byte-audit.mjs                       # 只读全仓扫描，永远退出 0
 *   node scripts/nul-byte-audit.mjs --check               # 门禁：有（未登记的）字面 NUL ⇒ 退出 1
 *   node scripts/nul-byte-audit.mjs --check --strict      # 其它控制字符也算失败
 *   node scripts/nul-byte-audit.mjs --check --root=<dir>  # 扫指定根（守卫用它造假红样本）
 *   node scripts/nul-byte-audit.mjs --json                # 机器可读
 *   node scripts/nul-byte-audit.mjs --quiet               # 只打汇总（明细不逐条打）
 *
 * 退出码：0 通过 / 1 判分失败 / 2 用法错误。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.resolve(HERE, "..");

/** 文本文件白名单 —— 只有这些扩展名会被读。 */
export const EXTS = Object.freeze([".mjs", ".js", ".md", ".json", ".yml"]);

/** 整枝跳过的目录（另有「所有 . 开头的目录/文件」这条通用规则）。 */
export const SKIP_DIRS = Object.freeze([".git", "node_modules", "tmp"]);

/** 二进制扩展名黑名单 —— 白名单之外的双保险，防有人把白名单放宽后误扫二进制。 */
export const BINARY_EXTS = Object.freeze([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".zip", ".gz", ".tgz", ".tar", ".7z", ".rar",
  ".pdf", ".exe", ".dll", ".node", ".wasm", ".asar", ".bin",
  ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".mp4", ".webm",
]);

/**
 * ★ 已知遗留白名单（只报告、不判分）。
 *
 * 每一条都是「本轮**不可写**的路径 + 已经定性的事故」，不是一个可以随手加的口袋：
 *   · 只许登记 `docs/**` / `evidence/**` 这类**当轮无权改**的文件；
 *   · `max` 是**允许的处数上限** —— 同一文件里再多冒一处，照样判红；
 *   · 「不许登记 src/** / scripts/** / test/**」由 `test/nul-byte.test.mjs` 盯着（加了就红）。
 */
export const KNOWN_LEGACY = Object.freeze([
  {
    file: "docs/派单表.md",
    byte: 0x00,
    max: 1,
    why: "T43 派单表里写「→ \\u0000」时被工具落成了真字节（同一种事故的第三个现场）；docs/** 不在 T43 可写范围",
  },
]);

const NUL = 0x00;
const LF = 0x0a;
const DOLLAR = 0x24; // $
const OPEN_BRACE = 0x7b; // {
const CLOSE_BRACE = 0x7d; // }

/** 0x09 TAB / 0x0A LF / 0x0D CR 是正常空白 ⇒ 不算控制字符。 */
export function isControlByte(b) {
  return b === NUL || (b >= 0x01 && b <= 0x08) || b === 0x0b || b === 0x0c || (b >= 0x0e && b <= 0x1f);
}

const hex2 = (b) => `0x${b.toString(16).toUpperCase().padStart(2, "0")}`;

/** 控制字符的可见写法（绝不把真控制字符打到终端上 —— 那会把输出本身搞成不可读）。 */
function visible(byte) {
  const names = { 0x00: "NUL", 0x07: "BEL", 0x08: "BS", 0x0b: "VT", 0x0c: "FF", 0x1b: "ESC", 0x1f: "US" };
  return `⟪${hex2(byte)}${names[byte] ? ` ${names[byte]}` : ""}⟫`;
}

/** 收集待扫文件：白名单 + 排除目录/隐藏项 + 排除二进制扩展名。 */
export function collectFiles(root) {
  const files = [];
  const skipped = { dirs: [], hidden: [], binary: [] };
  const walk = (dir) => {
    let entries;
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = nodePath.join(dir, entry.name);
      const rel = nodePath.relative(root, full).split(nodePath.sep).join("/");
      if (entry.isDirectory()) {
        // `src/.harness-stubs` 这类隐藏目录同样跳过（临时夹具，不属于源码）
        if (entry.name.startsWith(".") || SKIP_DIRS.includes(entry.name)) {
          skipped.dirs.push(rel);
          continue;
        }
        walk(full);
        continue;
      }
      const ext = nodePath.extname(entry.name).toLowerCase();
      if (entry.name.startsWith(".")) {
        // 只有"本来会被扫"的隐藏文件才进跳过清单，免得 .gitignore 之类变成噪声
        if (EXTS.includes(ext)) skipped.hidden.push(rel);
        continue;
      }
      if (BINARY_EXTS.includes(ext)) {
        skipped.binary.push(rel);
        continue;
      }
      if (!EXTS.includes(ext)) continue;
      files.push({ rel, full });
    }
  };
  walk(root);
  return { files, skipped };
}

/**
 * 单个命中的定性（启发式，两条判据，见文件头）。
 * @returns {{region: "template"|"comment"|"text"|"code", intent: string, note: string}}
 */
export function classifyHit(buf, offset, lineText, charIndex, ext) {
  const next = buf[offset + 1];
  const next2 = buf[offset + 2];
  const prev = buf[offset - 1];
  // 判据 A（故意）：紧贴 `${…}` 插值 —— 模板串里当分隔符用的典型形状
  const sentinel = (next === DOLLAR && next2 === OPEN_BRACE) || (prev === CLOSE_BRACE && next === DOLLAR);
  if (sentinel) {
    return {
      region: "template",
      intent: "故意",
      note: "紧贴模板串的 ${…} 插值 ⇒ 当分隔符/哨兵用；语义对，但形态该写成转义 \\u0000",
    };
  }
  if (ext === ".md" || ext === ".yml") {
    return { region: "text", intent: "意外", note: "文档正文/代码块里的裸字节 —— 粘贴时被落成了真字符" };
  }
  const trimmed = lineText.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("#")) {
    return { region: "comment", intent: "意外", note: "落在注释里 —— 没有任何语义理由，是粘贴/编辑器写坏的" };
  }
  return { region: "code", intent: "意外", note: "落在代码/正文里 —— 裸控制字符，没有语义理由" };
}

/** 扫一个文件，返回命中明细。 */
export function auditFile(file) {
  const buf = nodeFs.readFileSync(file.full);
  const ext = nodePath.extname(file.rel).toLowerCase();
  const hits = [];
  const offsets = [];
  for (let i = 0; i < buf.length; i += 1) if (isControlByte(buf[i])) offsets.push(i);
  if (offsets.length === 0) return hits; // 快路：绝大多数文件在这里就结束

  // 行首偏移表（二分定位行号，避免每个命中都从头数）
  const lineStarts = [0];
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === LF) lineStarts.push(i + 1);

  for (const i of offsets) {
    const b = buf[i];
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= i) lo = mid;
      else hi = mid - 1;
    }
    const lineStart = lineStarts[lo];
    const lineEnd = lo + 1 < lineStarts.length ? lineStarts[lo + 1] - 1 : buf.length;
    const lineText = buf.subarray(lineStart, Math.min(lineEnd, buf.length)).toString("utf8").replace(/[\r\n]+$/, "");
    const col = buf.subarray(lineStart, i).toString("utf8").length + 1; // 按字符算列
    const charIndex = col - 1;
    const { region, intent, note } = classifyHit(buf, i, lineText, charIndex, ext);
    // 上下文：命中处换成可见标记，左右各留 60 字符
    const before = lineText.slice(Math.max(0, charIndex - 60), charIndex);
    const after = lineText.slice(charIndex + 1, charIndex + 1 + 60);
    hits.push({
      file: file.rel,
      byte: b,
      hex: hex2(b),
      offset: i,
      line: lo + 1,
      col,
      region,
      intent,
      note,
      ctx: `${before}${visible(b)}${after}`,
    });
  }
  return hits;
}

/** 全量扫描（导出给测试与门禁共用）。 */
export function scan(root = REPO) {
  const { files, skipped } = collectFiles(root);
  const hits = [];
  for (const file of files) hits.push(...auditFile(file));
  return { root, scanned: files.length, skipped, hits };
}

/** 白名单匹配：同一 (file, byte) 的**处数**不许超过 max，超出的照样判红。 */
export function splitByAllowlist(hits) {
  const known = [];
  const fresh = [];
  const used = new Map();
  for (const hit of hits) {
    const key = `${hit.file}\u0001${hit.byte}`; // ★ \u0001 是**转义写法**，文件里没有真字节
    const entry = KNOWN_LEGACY.find((k) => k.file === hit.file && k.byte === hit.byte);
    const count = used.get(key) ?? 0;
    if (entry !== undefined && count < entry.max) {
      used.set(key, count + 1);
      known.push({ ...hit, why: entry.why });
      continue;
    }
    fresh.push(hit);
  }
  return { known, fresh };
}

function render(result, { check, strict, quiet }) {
  const lines = [];
  const { hits, scanned, skipped } = result;
  const nuls = hits.filter((h) => h.byte === NUL);
  const { known, fresh } = splitByAllowlist(hits);
  const freshNul = fresh.filter((h) => h.byte === NUL);
  const freshOther = fresh.filter((h) => h.byte !== NUL);
  const hitFiles = new Set(hits.map((h) => h.file)).size;

  lines.push("== 字面 NUL / 控制字符审计（T43）==");
  lines.push(`根目录：${result.root}`);
  lines.push(`扫描范围：${EXTS.join(" ")}（文本白名单）｜排除 ${SKIP_DIRS.join(" / ")} 及所有 . 开头的目录与文件`);
  lines.push(
    `          另有二进制黑名单（${BINARY_EXTS.slice(0, 4).join(" ")} …共 ${BINARY_EXTS.length} 项）兜底，二进制文件不会进来`,
  );
  lines.push(
    `扫描 ${scanned} 个文本文件（跳过 ${skipped.dirs.length} 个目录 / ${skipped.hidden.length} 个隐藏临时文件 / ${skipped.binary.length} 个二进制扩展名文件）`,
  );
  lines.push("判据：0x00 = 字面 NUL（唯一会让 git 判 binary、grep 判 binary、diff 变空的东西）；");
  lines.push("      其它控制字符（0x01–0x08 / 0x0B / 0x0C / 0x0E–0x1F）默认只报告，--strict 才判分；");
  lines.push("      0x09 TAB / 0x0A LF / 0x0D CR 是正常空白，不算命中。");
  if (skipped.hidden.length > 0) lines.push(`跳过清单：${skipped.hidden.join(" · ")}`);
  lines.push("");

  if (hits.length === 0) {
    lines.push("── 命中 0 处 ──");
  } else {
    lines.push(`── 命中 ${hits.length} 处 / ${hitFiles} 个文件 ──`);
    if (!quiet) {
      hits.forEach((h, i) => {
        const legacy = known.some((k) => k.file === h.file && k.offset === h.offset);
        lines.push(
          `[${i + 1}] ${h.file}:${h.line}:${h.col}  ${h.hex}  偏移 ${h.offset}  ` +
            `${h.intent}（${h.region}）${legacy ? "  ← 已知遗留（白名单，只报告）" : ""}`,
        );
        lines.push(`     ${h.note}`);
        lines.push(`     ctx: ${h.ctx}`);
      });
    }
    lines.push("");
    lines.push("── 按文件汇总 ──");
    const per = new Map();
    for (const h of hits) {
      if (!per.has(h.file)) per.set(h.file, []);
      per.get(h.file).push(h);
    }
    for (const [file, list] of [...per.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const n = list.filter((h) => h.byte === NUL).length;
      lines.push(`  · ${file}  NUL×${n} · 其它控制字符×${list.length - n}`);
    }
    if (known.length > 0) {
      lines.push("");
      lines.push(`── 已知遗留（当轮不可写，只报告不判分：${known.length} 处）──`);
      for (const k of known) lines.push(`  · ${k.file}:${k.line}:${k.col}  ${k.hex} —— ${k.why}`);
    }
  }

  lines.push("");
  lines.push(
    `统计：命中 ${hitFiles} 个文件 / ${hits.length} 处（NUL ${nuls.length} · 其它控制字符 ${hits.length - nuls.length}）` +
      `｜扣除已知遗留后：NUL ${freshNul.length} 处 · 其它 ${freshOther.length} 处`,
  );

  let failed = false;
  if (freshNul.length > 0) {
    failed = true;
    lines.push(`❌ 发现 ${freshNul.length} 处字面 NUL（不在已知遗留里）：${freshNul.map((h) => `${h.file}:${h.line}`).join(", ")}`);
    lines.push("   修法：把真字节换成转义写法 \\u0000（JS 字符串里同一个字符，但文件是纯文本、diff 看得见）。");
  } else {
    lines.push(
      "✅ 通过：全仓无字面 NUL" + (known.length > 0 ? `（另有已登记的遗留 ${known.length} 处，只报告不判分）` : ""),
    );
  }
  if (freshOther.length > 0) {
    const list = freshOther.map((h) => `${h.file}:${h.line} ${h.hex}`).join(", ");
    if (strict) {
      failed = true;
      lines.push(`❌ --strict：另有 ${freshOther.length} 处其它控制字符：${list}`);
    } else {
      lines.push(`⚠ 另有 ${freshOther.length} 处其它控制字符（不触发二进制判定，默认不判分）：${list}`);
      lines.push("   要连它们一起收：node scripts/nul-byte-audit.mjs --check --strict");
    }
  }
  lines.push(
    check
      ? failed
        ? "（--check 模式：退出码 1）"
        : "（--check 模式：退出码 0）"
      : "（只读模式：退出码 0；加 --check 才判红）",
  );
  return { text: lines.join("\n"), failed, freshNul, freshOther, known };
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const strict = argv.includes("--strict");
  const json = argv.includes("--json");
  const quiet = argv.includes("--quiet");
  const rootArg = argv.find((a) => a.startsWith("--root="));
  const root = rootArg ? nodePath.resolve(rootArg.slice("--root=".length)) : REPO;

  if (!nodeFs.existsSync(root) || !nodeFs.statSync(root).isDirectory()) {
    console.error(`✗ --root 不是目录：${root}`);
    return 2;
  }

  const result = scan(root);
  const rendered = render(result, { check, strict, quiet });

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          root: result.root,
          scanned: result.scanned,
          skipped: result.skipped,
          hits: result.hits,
          known: rendered.known.map((k) => ({ file: k.file, line: k.line, hex: k.hex })),
          freshNul: rendered.freshNul.map((h) => ({ file: h.file, line: h.line })),
          freshOther: rendered.freshOther.map((h) => ({ file: h.file, line: h.line, hex: h.hex })),
          failed: rendered.failed,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${rendered.text}\n`);
  }
  return check && rendered.failed ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
