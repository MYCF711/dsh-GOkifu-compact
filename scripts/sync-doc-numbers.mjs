#!/usr/bin/env node
/**
 * sync-doc-numbers.mjs —— 文档里那些**手写的计数**，从今天起只有一处来源
 *
 * 由来（文档计数漂移专项，连续 5 轮白干）：`NNNN passed`、`C1–C<n>`、`xxx 条条目`、
 * `xxx 个编号` 这几类数字在 4 份文档里被手抄了十几份。每加一条 CHANGELOG
 * （`node scripts/add-changelog.mjs`）或每加一个测试，就有守卫变红（C167 / C172 / C485），
 * 而修法一直是「人肉把数字改一遍」——下一轮又漂。
 *
 * 这不是纪律问题，是**拓扑问题**：同一个数有十几个手抄点，任何人都必漏。所以把「维护数字」
 * 从人手里拿走，做成三条规则：
 *
 *   ① **权威源只有一个**
 *      · 全量通过数 ⇒ `test/counts-baseline.json` 的 `passed`（`gate.mjs` 跑完全量测试后回写，C485）；
 *      · CHANGELOG 条目数 / 编号数 / 最大编号 ⇒ 只问 `changelog-index.mjs` 的 `parseEntries`
 *        （解析器**只许有一份**，本文件不复制它的逻辑，只做形状归一化，见 `normalizeChangelogHeaders`）。
 *   ② **落点是一张显式表**（`TARGETS`）：每处都写清「哪个文件、哪句锚点、这个数在说什么」。
 *      锚点**必须命中**——文案被改写导致锚点失配时本脚本**报错退出**，而不是静默跳过。
 *      静默跳过 = 那个数字从此无人维护，正是这次要根治的病。
 *   ③ **不猜**：源缺失（没有 `passed` 字段 / CHANGELOG 解析不出条目）⇒ 直接失败并说清缺什么，
 *      绝不"估一个数"写进文档 —— 猜出来的数字比过期更坏（过期至少还能被守卫抓到）。
 *
 * **不碰**的东西（它们各自有生成脚本，在这里再抄一遍就是第四个来源）：
 *   bench tokens（`bench-repro`）· doctor 警告数（`doctor`）· live fold 次数/会话数（`live-folds`）
 *   · handoff-check 的 FAIL/WARN（`handoff-check`）· 门禁门数（`gate.mjs` 的 `GATES`，且被
 *   `test/gate.test.mjs` 逐项钉死，不许手改）。
 *
 * 用法：
 *   node scripts/sync-doc-numbers.mjs            # 预演：只报告差异，不落盘
 *   node scripts/sync-doc-numbers.mjs --check    # 校验：有漂移或锚点失配 ⇒ exit 1（给门禁/测试用）
 *   node scripts/sync-doc-numbers.mjs --write    # 就地重写；写完立刻复验，仍不一致 ⇒ exit 1
 *   node scripts/sync-doc-numbers.mjs --root=<dir>   # 在别处的副本上跑（测试用）
 *
 * 退出码：0 = 一致 / 已同步；1 = 有漂移（--check）、源缺失、锚点失配、写回后仍不一致。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { parseEntries } from "./changelog-index.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));

/** 仓库根。`--root=` 可指向别处（测试在临时副本上跑，绝不碰真文档）。 */
export const REPO = nodePath.resolve(HERE, "..");

/** 全量通过数的唯一来源。 */
export const PASSED_FILE = nodePath.join("test", "counts-baseline.json");

export const CHANGELOG_FILE = "CHANGELOG.md";

/** 只在这 4 份文档里同步（题目圈定的范围；别的文档不在本次范围）。 */
export const DOCS = Object.freeze([
  "HANDOFF.md",
  "evidence/持续优化-总览-2026-11-02.md",
  "docs/research/00-蒸馏-对本插件的可执行结论.md",
  "docs/knowledge/进度.md",
]);

// ─────────────────────────────────────────────────────────────────────────────
// ① 权威源
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 读「最近一次全量测试的通过数」。
 * 缺字段就抛错 —— 猜一个数写进文档，比留着过期数字更坏。
 * @param {string} [root]
 * @returns {{passed:number, at:string, passedAtUtcZ:string}}
 */
export function readPassed(root = REPO) {
  const file = nodePath.join(root, PASSED_FILE);
  if (!nodeFs.existsSync(file)) {
    throw new Error(`找不到 ${PASSED_FILE} —— 先跑一次全量测试（\`node scripts/gate.mjs\` 跑完会把实测通过数回写该文件）`);
  }
  let json;
  try {
    json = JSON.parse(nodeFs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${PASSED_FILE} 不是合法 JSON：${error.message}`);
  }
  const passed = Number(json.passed);
  if (!Number.isInteger(passed) || passed <= 0) {
    throw new Error(
      `${PASSED_FILE} 里没有可用的 passed（当前 ${JSON.stringify(json.passed)}）—— 先跑 \`node scripts/gate.mjs\` 让它回写；本脚本不猜`,
    );
  }
  const at = typeof json.passedAt === "string" ? json.passedAt : "";
  const minute = at.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
  if (minute === null) {
    throw new Error(`${PASSED_FILE} 里缺可解析的 passedAt（当前 ${JSON.stringify(json.passedAt)}）—— 文档里的实测时间戳要靠它，本脚本不猜`);
  }
  return { passed, at, passedAtUtcZ: minute[1] };
}

/**
 * `parseEntries` 只认 `### C<n> · 标题`，但 CHANGELOG 里有 7 条标题在编号后带注解或小版本号
 * （`### C322（已回滚）· …`、`### C36.1 · …`）—— 它们同样是「一条条目」，而且 C172 守卫的口径
 * （`^### (C\d+)`）本来就把它们算成 C322 / C36。
 *
 * 所以这里**只做形状归一化**（把注解/小版本号抹到编号上），解析仍然交给
 * `changelog-index.mjs`：解析器不允许有第二份。
 * @param {string} text
 * @returns {string}
 */
export function normalizeChangelogHeaders(text) {
  return String(text)
    .split("\n")
    .map((line) =>
      line
        .replace(/^(### C\d+)\.\d+ · /, "$1 · ") // `### C36.1 · …` ⇒ `### C36 · …`
        .replace(/^(### C\d+)（[^）\n]*）· /, "$1 · "), // `### C322（已回滚）· …` ⇒ `### C322 · …`
    )
    .join("\n");
}

/**
 * 读 CHANGELOG 的三个数：条目数 / 编号数 / 最大编号。
 * @param {string} [root]
 * @returns {{entries:number, ids:number, max:number}}
 */
export function readChangelog(root = REPO) {
  const file = nodePath.join(root, CHANGELOG_FILE);
  if (!nodeFs.existsSync(file)) throw new Error(`找不到 ${CHANGELOG_FILE}`);
  const text = nodeFs.readFileSync(file, "utf8");
  const entries = parseEntries(normalizeChangelogHeaders(text));
  if (entries.length === 0) {
    throw new Error(`${CHANGELOG_FILE} 里解析不出任何 \`### C<n> · 标题\` 条目 —— 写法变了？先修解析，别让文档数字跟着猜`);
  }
  const ids = entries.map((entry) => Number(entry.id.slice(1))).filter((n) => Number.isFinite(n));
  // 形状核对：**所有** `### C<n>` 标题都必须被解析器覆盖，否则「条目数」只是个半成品，
  // 写进文档会与 C172 的口径打架（那种红最难查：两个数都对，只是口径不同）。
  const headers = (text.match(/^### C\d+/gm) ?? []).length;
  if (headers !== entries.length) {
    throw new Error(
      `CHANGELOG 有 ${headers} 条 \`### C<n>\` 标题，但 changelog-index 的解析器只认出 ${entries.length} 条（差 ${headers - entries.length}）` +
        ` —— 有条目标题形状不在解析器覆盖内，先对齐解析再同步文档`,
    );
  }
  return { entries: entries.length, ids: new Set(ids).size, max: Math.max(...ids) };
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 落点表
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 每一处手写计数。
 *
 * `re` 只圈**这个数字本身**（连同辨认它所需的紧邻字样），`want(m, v)` 返回该片段应有的样子。
 * `m[0]` 是整段命中，`m[1..]` 是捕获组，`v` 是权威源算出来的值：
 *   { passed, passedAtUtcZ, entries, ids, max }
 *
 * 圈窄一点有两个好处：报告能精确到「哪个文件第几行、哪句锚点」，写回时也不会碰到别的字。
 */
export const TARGETS = Object.freeze([
  {
    file: "HANDOFF.md",
    what: "门禁行 · 全量测试通过数",
    re: /(\| 门禁 \|[^\n]*?全量 \*\*)(\d+)( passed)/g,
    want: (m, v) => `${m[1]}${v.passed}${m[3]}`,
  },
  {
    file: "evidence/持续优化-总览-2026-11-02.md",
    what: "标题 · 覆盖区间 C1–C<最大编号>",
    re: /(^# .*?C1[–-]C)(\d+)/gm,
    want: (m, v) => `${m[1]}${v.max}`,
  },
  {
    file: "evidence/持续优化-总览-2026-11-02.md",
    what: "导语 · 条目数 / 编号数",
    re: /(\*\*)(\d+)( 条条目 \/ )(\d+)( 个编号\*\*)/g,
    want: (m, v) => `${m[1]}${v.entries}${m[3]}${v.ids}${m[5]}`,
  },
  {
    file: "evidence/持续优化-总览-2026-11-02.md",
    what: "规模表 · 条目数（第二处）",
    re: /(\| 循环内提交（C 编号） \| \*\*)(\d+)( 条\*\*)/g,
    want: (m, v) => `${m[1]}${v.entries}${m[3]}`,
  },
  {
    file: "evidence/持续优化-总览-2026-11-02.md",
    what: "规模表 · 覆盖轮次 C1 → C<最大编号>",
    re: /(\| 覆盖轮次 \| C1 → C)(\d+)/g,
    want: (m, v) => `${m[1]}${v.max}`,
  },
  {
    file: "evidence/持续优化-总览-2026-11-02.md",
    what: "规模表 · 全量测试",
    re: /(\| 全量测试 \| \*\*)(\d+)( passed)/g,
    want: (m, v) => `${m[1]}${v.passed}${m[3]}`,
  },
  {
    file: "evidence/持续优化-总览-2026-11-02.md",
    what: "复核命令 · run.mjs 的预期通过数",
    re: /(node test\/run\.mjs\s+# )(\d+)( passed)/g,
    want: (m, v) => `${m[1]}${v.passed}${m[3]}`,
  },
  {
    file: "docs/research/00-蒸馏-对本插件的可执行结论.md",
    what: "§11.1 快照 · 全量测试",
    re: /(最近实测 \*\*)(\d+)( passed)/g,
    want: (m, v) => `${m[1]}${v.passed}${m[3]}`,
  },
  {
    file: "docs/research/00-蒸馏-对本插件的可执行结论.md",
    what: "§11.1 快照 · 实测时间戳（C117 要求「数 + 时间戳」）",
    // 历史上手抄残形 `2026-11-04T13:0xZ` 也认，否则第一次跑不进来、永远修不好
    re: /(0 failed\*\*，)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9a-z]{2}:[0-9a-z]{2}Z/g,
    want: (m, v) => `${m[1]}${v.passedAtUtcZ}Z`,
  },
  {
    file: "docs/knowledge/进度.md",
    what: "现状摘要 · 全量测试",
    re: /(^- 全量测试 \*\*)(\d+)( passed)/gm,
    want: (m, v) => `${m[1]}${v.passed}${m[3]}`,
  },
]);

// ─────────────────────────────────────────────────────────────────────────────
// ③ 扫描 / 落盘
// ─────────────────────────────────────────────────────────────────────────────

/** 第几行（1 起算）—— 报告要精确到行，否则「改了哪处」还得自己找。 */
export function lineOf(text, at) {
  return text.slice(0, at).split("\n").length;
}

/**
 * 扫一段文本，返回 `{ matched, hits }`：
 *   · `matched` = 锚点命中几处（0 ⇒ 锚点失配，那处数字从此无人维护）；
 *   · `hits`    = 需要改的命中（值已经对的**不进**，避免每次 `--write` 都重写文件）。
 * @param {string} text
 * @param {{re:RegExp, want:(m:RegExpMatchArray, v:object)=>string, what:string}} target
 * @param {object} values
 * @returns {{matched:number, hits:Array<{at:number, len:number, have:string, want:string}>}}
 */
export function scanText(text, target, values) {
  const flags = target.re.flags.includes("g") ? target.re.flags : `${target.re.flags}g`;
  const re = new RegExp(target.re.source, flags);
  const hits = [];
  let matched = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    matched += 1;
    if (m[0].length === 0) {
      re.lastIndex += 1; // 空匹配会死循环
      continue;
    }
    const want = target.want(m, values);
    if (want !== m[0]) hits.push({ at: m.index, len: m[0].length, have: m[0], want });
  }
  return { matched, hits };
}

/**
 * 算出「谁该改成什么」。纯函数：只读，不写盘。
 * @param {{root?:string}} [options]
 * @returns {{values:object, files:Array<object>, problems:Array<string>, drifted:number, anchors:number}}
 */
export function planSync({ root = REPO } = {}) {
  const { passed, at, passedAtUtcZ } = readPassed(root);
  const changelog = readChangelog(root);
  const values = { passed, passedAt: at, passedAtUtcZ, ...changelog };

  const problems = [];
  const files = [];
  let anchors = 0;
  let drifted = 0;

  for (const rel of DOCS) {
    const targets = TARGETS.filter((t) => t.file === rel);
    if (targets.length === 0) continue;
    const abs = nodePath.join(root, rel);
    if (!nodeFs.existsSync(abs)) {
      problems.push(`文件不存在：${rel}`);
      continue;
    }
    const text = nodeFs.readFileSync(abs, "utf8");
    const hits = [];
    for (const target of targets) {
      const scanned = scanText(text, target, values);
      anchors += 1;
      if (scanned.matched === 0) {
        problems.push(`锚点失配：${rel} ［${target.what}］ 找不到 /${target.re.source}/ —— 这处数字从此无人维护，改文案时请一并改 TARGETS`);
        continue;
      }
      for (const hit of scanned.hits) {
        hits.push({ ...hit, line: lineOf(text, hit.at), what: target.what });
      }
    }
    // 同一文件里多处的行号顺序（报告好读）
    hits.sort((a, b) => a.at - b.at);
    drifted += hits.length;
    files.push({ file: rel, abs, text, hits });
  }

  return { values, files, problems, drifted, anchors };
}

/** 就地应用命中（从后往前改，索引不会互相弄乱）。 */
export function applyHits(text, hits) {
  let next = text;
  for (const hit of [...hits].sort((a, b) => b.at - a.at)) {
    next = next.slice(0, hit.at) + hit.want + next.slice(hit.at + hit.len);
  }
  return next;
}

/** 人读的报告（`--check` / 预演 / `--write` 共用同一份措辞）。 */
export function renderReport(plan, { wrote = false } = {}) {
  const { values, files, problems, drifted } = plan;
  const out = [];
  out.push("== 文档数字同步 ==");
  out.push(`权威源：passed = ${values.passed}（${PASSED_FILE}，实测 ${values.passedAtUtcZ}Z）`);
  out.push(
    `        CHANGELOG = ${values.entries} 条条目 / ${values.ids} 个编号 / 最大 C${values.max}（经 changelog-index.parseEntries）`,
  );
  out.push(`覆盖 ${DOCS.length} 份文档 / ${plan.anchors} 处锚点`);

  for (const file of files) {
    for (const hit of file.hits) {
      out.push(`  ${wrote ? "✎" : "✗"} ${file.file}:${hit.line} ［${hit.what}］`);
      out.push(`      「${hit.have}」→「${hit.want}」`);
    }
  }
  for (const problem of problems) out.push(`  ! ${problem}`);

  if (problems.length > 0) {
    out.push(`❌ 结构问题 ${problems.length} 处 —— 先修上面这些（本脚本不跳过、不猜）`);
  } else if (drifted === 0) {
    out.push("✅ 全部一致（文档里的计数 = 权威源）");
  } else if (wrote) {
    out.push(`✅ 已就地重写 ${drifted} 处`);
  } else {
    out.push(`❌ 有 ${drifted} 处漂移 —— 跑 \`node scripts/sync-doc-numbers.mjs --write\` 一次改完`);
  }
  return `${out.join("\n")}\n`;
}

/**
 * 入口。
 * @param {string[]} [argv]
 * @returns {number} 退出码
 */
export function main(argv = process.argv.slice(2)) {
  const rootArg = argv.find((a) => a.startsWith("--root="));
  const root = rootArg === undefined ? REPO : nodePath.resolve(rootArg.slice("--root=".length));
  const write = argv.includes("--write");
  const check = argv.includes("--check");

  let plan;
  try {
    plan = planSync({ root });
  } catch (error) {
    process.stdout.write(`❌ 权威源读不出来：${error.message}\n`);
    return 1;
  }

  if (plan.problems.length > 0) {
    process.stdout.write(renderReport(plan));
    return 1;
  }

  if (!write) {
    process.stdout.write(renderReport(plan));
    // 预演：有漂移也只报告（exit 0）；`--check` 才是判据（exit 1）
    return check && plan.drifted > 0 ? 1 : 0;
  }

  if (plan.drifted === 0) {
    process.stdout.write(renderReport(plan));
    return 0;
  }

  for (const file of plan.files) {
    if (file.hits.length === 0) continue;
    nodeFs.writeFileSync(file.abs, applyHits(file.text, file.hits), "utf8");
  }
  process.stdout.write(renderReport(plan, { wrote: true }));

  // 写完立刻复验：落盘后再算一遍必须干净，否则就是本脚本自己错了（宁可红，别留半改状态）
  const again = planSync({ root });
  if (again.problems.length > 0 || again.drifted > 0) {
    process.stdout.write(`❌ 写回后复验失败（漂移 ${again.drifted} 处 / 结构问题 ${again.problems.length} 处）\n`);
    return 1;
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
