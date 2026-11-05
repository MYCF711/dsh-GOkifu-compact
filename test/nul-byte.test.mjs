/**
 * nul-byte.test.mjs —— 「字面 NUL」的两件事各钉一颗钉子（T43，2026-11-05）
 *
 * 事故：`src/rooms/keeper.mjs` 的 `actionSignature` 用 NUL 当分隔符（语义没问题），但写成了
 * **真字节 0x00** 而不是转义写法 `\u0000`。后果不是"风格问题"，是**看不见改动**：
 * `git diff --stat` 报 `Bin 16735 -> 21499 bytes`，`git diff` 输出为空，`grep` 判整个文件 binary。
 * 一晚上因为这个来回跑了多次（要 `-a` 才看得见）。
 *
 * 这里钉四类判据：
 *   ① **等价性**：转义写法 `\u0000` 与字面 NUL 在 JS 里是同一个字符 —— 用改前模块实测到的
 *      14 组输入输出（逐条 + 整体 sha256）当基准，改后必须**逐字节相同**；
 *   ② **文件形态**： keeper.mjs 里不许再有 0x00 字节，且分隔符必须是文本 `\u0000`；
 *   ③ **门禁真红/真绿**：往临时目录里放一个带 NUL 的 .mjs ⇒ `--check` 退出 1；
 *      干净目录 ⇒ 退出 0（两条都要，否则"永远红"和"永远绿"都测不出来）；
 *   ④ **白名单不给代码开后门** + 全仓当前是绿的。
 */
import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { actionSignature } from "../src/rooms/keeper.mjs";
import { KNOWN_LEGACY, scan, splitByAllowlist } from "../scripts/nul-byte-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const AUDIT = nodePath.join(ROOT, "scripts", "nul-byte-audit.mjs");
const NUL = String.fromCharCode(0); // ★ 刻意从 charCode 造，测试自己也不许出现字面 NUL
const ESCAPE_TEXT = "\\u0000"; // ★ 双反斜杠 = 文件里的 6 个字符（转义写法）

/**
 * 改前（带字面 NUL 的 keeper.mjs）实测到的 14 组输出 —— 这是"等价"的基准，不是我算出来的期望。
 * 基准里第 45–46 行那两组（键序 A/B）本来就该相同；01 与 05 相同是因为 `null` 与 `undefined`
 * 都走 `?? "?"`，属于既有语义，不是本次引入。
 */
const BASELINE = Object.freeze({
  "01 无参（undefined/undefined）": "52a80919b1cdcb7a",
  "02 空对象参数": "82b6640f0c34212b",
  "03 空串（tool 与 args 都是空串）": "261108173d1e6eb4",
  "04 单字符": "7985cf5588897862",
  "05 null 参数 / null 工具名": "52a80919b1cdcb7a",
  "06 典型 edit": "eb418c8daad882ca",
  "07 键序 A": "f066156c3c7790a2",
  "08 键序 B（同 07，键序颠倒）": "f066156c3c7790a2",
  "09 长文本 8000 字": "ed9aab16ce9c5b0b",
  "10 含 NUL/引号/反斜杠/emoji 的文本": "a02805bc975ccc09",
  "11 工具名里含 NUL": "bfaa058115ded597",
  "12 嵌套结构": "9639196d4bc686e3",
  "13 中文（CJK）": "efa5604a7a774106",
  "14 undefined 值": "fce55400b6bad2ca",
});
/** 14 组输出拼接后的整体 sha256 —— 任一字节不同都会变（改前改后都为这个值）。 */
const BASELINE_TOTAL = "abe2653b2c49247850b1a8d9625a2c7590450cb97dcf3da4b2d0abd83dbc6b1a";

/** 样本表：空串 / 单字符 / 长文本 / 特殊字符 / 键序 / 中文 / 嵌套都要有。 */
function samples() {
  return {
    "01 无参（undefined/undefined）": () => actionSignature(),
    "02 空对象参数": () => actionSignature("bash", {}),
    "03 空串（tool 与 args 都是空串）": () => actionSignature("", ""),
    "04 单字符": () => actionSignature("a", "b"),
    "05 null 参数 / null 工具名": () => actionSignature(null, null),
    "06 典型 edit": () => actionSignature("edit", { file_path: "D:/a/b.md", old_string: "x", new_string: "y" }),
    "07 键序 A": () => actionSignature("bash", { command: "ls -la", description: "看看" }),
    "08 键序 B（同 07，键序颠倒）": () => actionSignature("bash", { description: "看看", command: "ls -la" }),
    "09 长文本 8000 字": () => actionSignature("bash", { command: "x".repeat(8000) }),
    "10 含 NUL/引号/反斜杠/emoji 的文本": () =>
      actionSignature("bash", { command: `a${NUL}b`, description: "q\"uo'te\\n\\u0000 🀄️" }),
    "11 工具名里含 NUL": () => actionSignature(`ba${NUL}sh`, { a: 1 }),
    "12 嵌套结构": () => actionSignature("read", { paths: ["a", "b"], opts: { deep: true } }),
    "13 中文（CJK）": () => actionSignature("写", { 文本: "围棋棋谱 —— 压缩" }),
    "14 undefined 值": () => actionSignature("x", { a: undefined, b: 1 }),
  };
}

const sha256 = (text) => nodeCrypto.createHash("sha256").update(String(text), "utf8").digest("hex");

/** 跑一场 audit 子进程，返回 {status, out}。 */
function runAudit(args) {
  const res = spawnSync(process.execPath, [AUDIT, ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** 造一个临时目录并在结束时删掉。 */
async function withTempTree(files, fn) {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "nul-byte-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = nodePath.join(dir, rel);
      nodeFs.mkdirSync(nodePath.dirname(full), { recursive: true });
      nodeFs.writeFileSync(full, content);
    }
    return await fn(dir);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
}

export const tests = {};

tests["T43 等价性：转义写法 \\u0000 与字面 NUL 逐字节等价（14 组输入 · sha256 为证）"] = (t) => {
  const rows = samples();
  t.eq(Object.keys(rows).length, Object.keys(BASELINE).length, "样本数必须与基准一致（少了就是漏了一类输入）");
  const actual = {};
  for (const [label, fn] of Object.entries(rows)) actual[label] = fn();
  for (const label of Object.keys(BASELINE)) {
    t.eq(actual[label], BASELINE[label], `${label}：与改前（字面 NUL 版本）的输出必须逐字节相同`);
  }
  const joined = Object.entries(actual)
    .map(([label, value]) => `${label}\u0001${value}`)
    .join("\u0002");
  t.eq(sha256(joined), BASELINE_TOTAL, "14 组输出拼接后的整体 sha256 必须与改前一致");
};

tests["T43 文件形态：keeper.mjs 里不许有 0x00 字节，分隔符必须是文本 \\u0000"] = (t) => {
  const buf = nodeFs.readFileSync(nodePath.join(ROOT, "src", "rooms", "keeper.mjs"));
  t.eq(buf.indexOf(0), -1, "keeper.mjs 里还有字面 NUL（0x00）—— git 会重新判 binary");
  const text = buf.toString("utf8");
  // 转义写法在**源码文本**里是 6 个字符：\ u 0 0 0 0
  t.eq(text.includes(`}${ESCAPE_TEXT}${"${"}stableJson`), true, "actionSignature 的分隔符必须是转义写法 \\u0000");
  t.eq(text.includes(`${ESCAPE_TEXT}${"${"}stableJson`), true, "分隔符后面紧跟 ${stableJson(...)} 插值（形状没被改坏）");
  // 反证：如果谁把转义写法退回真字节，上面第一条会红；这里再钉一次"真字节不是等价物"
  t.eq(NUL.length, 1, "String.fromCharCode(0) 是**一个**字符");
  t.eq(ESCAPE_TEXT.length, 6, "转义写法在源码里是 6 个字符（文件因此是纯文本）");
};

tests["T43 门禁真红：新增一个字面 NUL ⇒ nul-byte-audit --check 退出 1"] = async (t) => {
  const { status, out } = await withTempTree({ "src/bad.mjs": `const sep = "a${NUL}b";\n` }, (dir) =>
    runAudit(["--check", `--root=${dir}`]),
  );
  t.eq(status, 1, "--check 必须在有 NUL 时退出 1（否则门禁是假的）");
  t.includes(out, "❌ 发现 1 处字面 NUL", "输出里必须明确说红在哪");
  t.includes(out, "src/bad.mjs:1", "输出里必须给出文件:行");
  t.includes(out, "（--check 模式：退出码 1）", "结尾要说清退出码");
};

tests["T43 门禁真绿：干净目录 ⇒ --check 退出 0（不许永远红）"] = async (t) => {
  const { status, out } = await withTempTree({ "src/ok.mjs": `const sep = "a${ESCAPE_TEXT}b";\n` }, (dir) =>
    runAudit(["--check", `--root=${dir}`]),
  );
  t.eq(status, 0, "干净目录必须退出 0（转义写法不算命中）");
  t.includes(out, "✅ 通过：全仓无字面 NUL", "通过时要有明确结论行");
  t.includes(out, "（--check 模式：退出码 0）", "结尾要说清退出码");
};

tests["T43 排除规则：.git / node_modules / tmp / 隐藏临时副本 / 二进制扩展名 都不进扫描"] = async (t) => {
  const dirty = `const x = "a${NUL}b";\n`;
  const files = {
    "src/real.mjs": "const ok = 1;\n",
    ".git/hooks/x.mjs": dirty,
    "node_modules/pkg/index.js": dirty,
    "tmp/scratch.mjs": dirty,
    "src/.engine-under-test-p3.mjs": dirty,
    "assets/pic.png": `\x89PNG${NUL}`,
    "notes/nul.md": dirty, // 这一份**必须**被抓到（白名单里的 .md）
  };
  const { status, out, result } = await withTempTree(files, (dir) => ({
    ...runAudit(["--check", `--root=${dir}`]),
    result: scan(dir),
  }));
  t.eq(status, 1, "只有 notes/nul.md 那处该判红");
  t.includes(out, "❌ 发现 1 处字面 NUL", "只许报 1 处（其余都被排除规则挡掉了）");
  t.includes(out, "notes/nul.md:1", "白名单里的 .md 必须被抓到");
  // 直接从扫描结果核对排除面（打印里出现名字不算命中 —— 跳过清单里也会出现）
  t.eq(result.hits.map((h) => `${h.file}:${h.line}`), ["notes/nul.md:1"], "命中集合必须恰好是 notes/nul.md");
  t.eq(result.skipped.dirs.includes(".git"), true, ".git 必须被整枝跳过");
  t.eq(result.skipped.dirs.includes("node_modules"), true, "node_modules 必须被整枝跳过");
  t.eq(result.skipped.dirs.includes("tmp"), true, "tmp 必须被整枝跳过");
  t.eq(result.skipped.hidden, ["src/.engine-under-test-p3.mjs"], "隐藏临时副本要进跳过清单（不是悄悄消失）");
  t.eq(result.skipped.binary, ["assets/pic.png"], "二进制扩展名要进二进制清单");
  t.eq(result.hits.every((h) => !h.file.endsWith(".png")), true, "二进制文件不许被读进来当文本扫");
};

tests["T43 白名单不给代码开后门 + 全仓当前是绿的（未登录的 NUL 必须为 0）"] = (t) => {
  t.ok(KNOWN_LEGACY.length >= 1, "白名单至少要有一条（docs/派单表.md 那处）");
  for (const entry of KNOWN_LEGACY) {
    t.eq(/^(docs|evidence)\//.test(entry.file), true, `白名单只许登记 docs/** 或 evidence/**：${entry.file}`);
    t.eq(Number.isInteger(entry.max) && entry.max >= 1, true, `${entry.file} 必须写明处数上限 max`);
    t.eq(typeof entry.why === "string" && entry.why.length >= 10, true, `${entry.file} 必须写清为什么留着`);
  }
  const result = scan(ROOT);
  const { known, fresh } = splitByAllowlist(result.hits);
  t.eq(
    fresh.filter((h) => h.byte === 0).map((h) => `${h.file}:${h.line}`),
    [],
    "全仓不许有未登记的字面 NUL（keeper.mjs 那处已修）",
  );
  t.eq(known.map((h) => `${h.file}:${h.byte}`), ["docs/派单表.md:0"], "已知遗留目前只该有 docs/派单表.md 那一处");
  t.eq(result.scanned > 100, true, `扫描面太小（${result.scanned} 个文件）—— 排除规则是不是写过头了`);
};
