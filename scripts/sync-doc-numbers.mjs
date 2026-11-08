#!/usr/bin/env node
/**
 * sync-doc-numbers.mjs —— 文档里那些**手写的计数**，从今天起只有一处来源
 *
 * 由来（文档计数漂移专项，连续 5 轮白干）：`NNNN passed`、`C1–C<n>`、`xxx 条条目`、
 * `xxx 个编号` 这几类数字在 8 份文档里被手抄了十几份。每加一条 CHANGELOG
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
 *   bench tokens（`bench-repro`）· doctor 警告数（`doctor`）
 *   · handoff-check 的 FAIL/WARN（`handoff-check`）· 门禁门数（`gate.mjs` 的 `GATES`，且被
 *   `test/gate.test.mjs` 逐项钉死，不许手改）。
 *
 * live fold 数字的权威源是 `live-folds --write` 已经落盘的 `evidence/live-folds.json`：
 * 本脚本**不重新采集**，只把 JSON 现值同步到现状文档；逐会话表则复用
 * `fold-per-session.mjs` 的 `renderPerSession` 重新生成，避免另写一套 bySession 口径。
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
import { renderPerSession } from "./fold-per-session.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));

/** 仓库根。`--root=` 可指向别处（测试在临时副本上跑，绝不碰真文档）。 */
export const REPO = nodePath.resolve(HERE, "..");

/** 全量通过数的唯一来源。 */
export const PASSED_FILE = nodePath.join("test", "counts-baseline.json");

export const CHANGELOG_FILE = "CHANGELOG.md";
export const LIVE_FOLDS_FILE = nodePath.join("evidence", "live-folds.json");
export const PER_SESSION_FILE = "evidence/fold质量-多会话-2026-11-02.md";

/**
 * 基础 passed / CHANGELOG 计数只在这 8 份文档里同步；live 现状行与逐会话生成物由
 * `LIVE_TARGETS` 额外覆盖（其中逐会话表是第 9 份文档）。
 *
 * 前 4 份是 C603 时的范围（现状块 / 总览 / 调研结论 / 进度页）；后 4 份是「面向用户的手写契约」
 * —— 读者按它们判断「这东西到底过没过测试」，所以里面的 `passed` 过期比别处更贵。
 *
 * ⚠ 每份文档都必须**至少命中一处锚点**（`planSync` 对「在 DOCS 里但没有 TARGETS」的文件会静默跳过，
 *   而 `test/doc-numbers.test.mjs` 的边界用例要求两者集合相等）—— 加文件就顺手加锚点，别留空壳。
 * ⚠ 故意**不在**本表：`docs/压缩的职责边界.md`（全文 0 处 `passed`，没有可接管的数字 ——
 *   别为了凑数量往设计文里塞一个测试数）；`evidence/live-folds.*`（由 `live-folds --write` 生成）；
 *   `docs/knowledge/进度.md` 里那几十条历史快照（`全量 **1308 passed**` 之类，记录的是「当时的事实」，
 *   同步它等于篡改历史 —— 只同步它顶部「当前实测数字」块那一条）。
 */
export const DOCS = Object.freeze([
  "HANDOFF.md",
  "evidence/持续优化-总览-2026-11-02.md",
  "docs/research/00-蒸馏-对本插件的可执行结论.md",
  "docs/knowledge/进度.md",
  "README.md",
  "docs/压缩的重注入契约.md",
  "docs/发布就绪-2026-11-02.md",
  "evidence/README.md",
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
  // 时间戳只用于报告（不进文档 —— 见 TARGETS 里的说明），缺了不致命，列表里显示「未记录」
  const minute = at.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
  return { passed, at, passedAtUtcZ: minute === null ? "未记录" : minute[1] };
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
    what: "版本行 · 全量测试通过数（C485 的第一处全量计数）",
    re: /(\| 版本 \|[^\n]*?全量 \*\*)(\d+)( passed)/g,
    want: (m, v) => `${m[1]}${v.passed}${m[3]}`,
  },
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
  // ⚠ **故意不同步「实测时间戳」**：`test/counts-baseline.json` 的 `passedAt` 由 `gate.mjs` 每次跑完
  //   都刷新（通过数没变也刷）。把它抄进文档 ⇒ 每跑一次门禁文档就变一次，`--check` 永远红、
  //   `--write` 变成每轮必做 —— 那正好是这次要消灭的那台跑步机。
  //   文档里改写成「实测时刻见 `test/counts-baseline.json` 的 `passedAt`」：机器写的那个才是戳。
  {
    file: "docs/knowledge/进度.md",
    what: "现状摘要 · 全量测试",
    re: /(^- 全量测试 \*\*)(\d+)( passed)/gm,
    want: (m, v) => `${m[1]}${v.passed}${m[3]}`,
  },
  // ── 以下 4 份是「面向用户的手写契约」（C603 之后扩进来的）─────────────────────
  {
    file: "README.md",
    what: "质量基线 · 全量测试通过数",
    re: /(`node test\/run\.mjs` → \*\*)(\d+)( passed)/g,
    want: (m, v) => `${m[1]}${v.passed}${m[3]}`,
  },
  {
    file: "docs/压缩的重注入契约.md",
    what: "§7 端到端复核 · 全量测试（最后一次实测）",
    // 「最后一次实测」与下面那条「最近实测」是同一段里的两处（§7 复核表 + 第 1 次巡检表），
    // 圈窄到各自的修饰语，免得一条正则同时吃掉两处、报告里只剩一行。
    re: /(最后一次实测 \*\*)(\d+)( passed)/g,
    want: (m, v) => `${m[1]}${v.passed}${m[3]}`,
  },
  {
    file: "docs/压缩的重注入契约.md",
    what: "巡检记录 · 全量测试（最近实测）",
    re: /(最近实测 )(\d+)( passed)/g,
    want: (m, v) => `${m[1]}${v.passed}${m[3]}`,
  },
  {
    file: "docs/发布就绪-2026-11-02.md",
    what: "契约表 · 全量测试通过数",
    re: /(\| 手写契约 \| `node test\/run\.mjs` \| \*\*)(\d+)( passed)/g,
    want: (m, v) => `${m[1]}${v.passed}${m[3]}`,
  },
  {
    file: "evidence/README.md",
    what: "总览行 · 覆盖区间 C1–C<最大编号>",
    // 只圈 `C1–C<n>` 这一处：同一行里另有「条目数只认仓库根 CHANGELOG 当次」是**指向**，不是数字；
    // 文件里 `971 / 880 / 758 passed` 是各次巡检**当时**的实测（历史事实），同步它们等于改历史。
    re: /(人工汇总（C1[–-]C)(\d+)/g,
    want: (m, v) => `${m[1]}${v.max}`,
  },
]);

// ─────────────────────────────────────────────────────────────────────────────
// ②b live-folds 落点（独立表：采集仍归 live-folds，本脚本只同步已落盘的 JSON）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 读 live 权威源。旧的 doc-numbers 单元夹具只复制基础 DOCS / CHANGELOG / counts-baseline，
 * 没有 package.json、live-folds.json 与逐会话表；这种**基础夹具**不启用 live 锚点。
 * 真实仓库或完整副本缺权威源时必须报错，不许把「没文件」当「全部一致」。
 */
export function readLiveFolds(root = REPO) {
  const file = nodePath.join(root, LIVE_FOLDS_FILE);
  if (!nodeFs.existsSync(file)) {
    const completeRoot =
      nodePath.resolve(root) === nodePath.resolve(REPO) ||
      nodeFs.existsSync(nodePath.join(root, "package.json")) ||
      nodeFs.existsSync(nodePath.join(root, PER_SESSION_FILE));
    if (completeRoot) throw new Error(`找不到 ${LIVE_FOLDS_FILE} —— 先跑 \`node scripts/live-folds.mjs --write\`；本脚本不猜`);
    return null;
  }
  let json;
  try {
    json = JSON.parse(nodeFs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${LIVE_FOLDS_FILE} 不是合法 JSON：${error.message}`);
  }
  const summary = json?.summary;
  const required = {
    total: summary?.total,
    sessionsWithFolds: summary?.bySession?.sessionsWithFolds,
    qualityCount: summary?.quality?.count,
    constraintRecallMin: summary?.quality?.constraintRecallMin,
    failureRecallMin: summary?.quality?.failureRecallMin,
    compressionRatioMin: summary?.quality?.compressionRatioMin,
    compressionRatioMax: summary?.quality?.compressionRatioMax,
    unknownIdsTotal: summary?.quality?.unknownIdsTotal,
    shadowedShareMin: summary?.cost?.shadowedShareMin,
    shadowedShareMax: summary?.cost?.shadowedShareMax,
    thrashSessions: summary?.thrash?.sessions,
  };
  for (const [name, value] of Object.entries(required)) {
    if (!Number.isFinite(value)) throw new Error(`${LIVE_FOLDS_FILE} 缺少数值 summary.${name}（当前 ${JSON.stringify(value)}）；本脚本不猜`);
  }
  if (!Array.isArray(json?.folds)) throw new Error(`${LIVE_FOLDS_FILE} 缺少 folds 数组；无法生成逐会话表`);
  if (typeof json?.generatedAt !== "string" || json.generatedAt.length === 0) {
    throw new Error(`${LIVE_FOLDS_FILE} 缺少 generatedAt；现状文档不能伪造生成时间`);
  }
  const boundaryCount = json.folds.filter((x) => x.boundary && typeof x.boundary.openAtEnd === "number").length;
  const openAtEnd = json.folds.reduce((sum, x) => sum + (x.boundary?.openAtEnd ?? 0), 0);
  // ★ t3：成本区间上限会被「小遮蔽量」样本抬高。证据里已经把样本数与主要路由算好了，
  //   这里只负责把它写进文档 —— 不再写死「那次走到 wps-lingxi 的异常样本」（实测 28 次）。
  const overInputRecords = json.folds.filter((x) => x && typeof x.shadowedShare === "number" && x.shadowedShare > 1);
  const overModels = new Map();
  for (const record of overInputRecords) {
    const model = record?.route && typeof record.route.model === "string" && record.route.model !== "" ? record.route.model : "（未记录）";
    overModels.set(model, (overModels.get(model) ?? 0) + 1);
  }
  const overTop =
    [...overModels.entries()]
      .map(([model, count]) => ({ model, count }))
      .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model))[0] ?? null;
  return {
    json,
    summary,
    generatedAt: json.generatedAt,
    records: json.folds.length,
    manual: Number.isFinite(summary.manual) ? summary.manual : json.folds.length - summary.total,
    boundaryCount,
    openAtEnd,
    overInput: overInputRecords.length,
    overTop,
    costMin: Math.round(summary.cost.shadowedShareMin * 100),
    costMax: Math.round(summary.cost.shadowedShareMax * 100),
    perSessionText: renderPerSession(json),
  };
}

/** 成本上限的来历（t3）：>100% 的样本数与主要路由；0 次时不写骇人的括注。 */
function renderCostNote(live) {
  if (!live.overInput) return "";
  const top = live.overTop;
  return `（>100% 共 ${live.overInput} 次${top ? `，其中 ${top.count} 次路由 \`${top.model}\`` : ""}；上限由这些小遮蔽量样本抬高，不是模型优劣）`;
}

function renderEvidenceLiveRow(live) {
  const s = live.summary;
  return `| \`live-folds.json\` / \`.md\` | \`node scripts/live-folds.mjs --write\`（**默认只打印**，显式 \`--write\` 才落盘） | ${live.generatedAt} | **${s.total} 次 live fold / ${s.bySession.sessionsWithFolds} 会话**（另有 ${live.manual} 条手工压缩记录，无区间；**快照非累计**，口径见 \`.md\` 的「快照语义」）；quality ${s.quality.count}、质量 c=${s.quality.constraintRecallMin} / f=${s.quality.failureRecallMin}、压缩比 ${s.quality.compressionRatioMin}–${s.quality.compressionRatioMax}、幻觉探针 ${s.quality.unknownIdsTotal} 次；成本 ${live.costMin}–${live.costMax}%${renderCostNote(live)}；\`foldThrash\` ${s.thrash.sessions}（会话 id 一律为稳定伪名 \`s_<12hex>\`） |`;
}

function renderEvidencePerSessionRow(live) {
  const s = live.summary;
  return `| \`fold质量-多会话-2026-11-02.md\` | \`node scripts/fold-per-session.mjs --write\`（**生成物**，从 \`live-folds.json\` 摊开，勿手改） | ${live.generatedAt} | **${s.bySession.sessionsWithFolds} 个有 fold 的会话 / ${live.records} 条 fold 记录**（= ${s.total} 次 fold + ${live.manual} 条手工记录）：quality ${s.quality.count} 次召回最小 ${s.quality.constraintRecallMin}、**failureRecall 最小 ${s.quality.failureRecallMin}**；带 boundary 的 **${live.boundaryCount}** 次，openAtEnd **合计 ${live.openAtEnd}**；\`foldThrash\` ${s.thrash.sessions} |`;
}

function renderResearchLiveRow(live) {
  const s = live.summary;
  const triggers = s.triggerCounts ?? {};
  return `| live fold | **${s.total} 次 / ${s.bySession.sessionsWithFolds} 会话**（thrash ${s.thrash.sessions}；trigger: pressure ${triggers.pressure ?? 0} / tier2 ${triggers.tier2 ?? 0} / context-overflow ${triggers["context-overflow"] ?? 0} / archive-offline ${triggers["archive-offline"] ?? 0}）；**quality ${s.quality.count}/${s.total}**，\`constraintRecall\` min **${s.quality.constraintRecallMin}**、\`failureRecall\` min **${s.quality.failureRecallMin}**（**不是"召回全 1"**）；boundary 切在工具调用中间 **${live.openAtEnd}** 次；压缩比 ${s.quality.compressionRatioMin}–${s.quality.compressionRatioMax}；成本 ${live.costMin}–${live.costMax}%${renderCostNote(live)} |`;
}

function renderOverviewLiveRow(live) {
  const s = live.summary;
  return `| live 证据 | **${s.total} 次 fold / ${s.bySession.sessionsWithFolds} 会话**（**快照非累计**）：quality ${s.quality.count} 次、\`constraintRecall\` min **${s.quality.constraintRecallMin}**、\`failureRecall\` min **${s.quality.failureRecallMin}**（有 1 次掉到 0，别再说"召回全 1"）、boundary 切点落在工具调用中间 **${live.openAtEnd}** 次、\`foldThrash\` ${s.thrash.sessions}；逐项见 \`evidence/live-folds.json\`（生成于 ${live.generatedAt}；逐会话表由 \`scripts/fold-per-session.mjs\` 生成） |`;
}

export const LIVE_TARGETS = Object.freeze([
  {
    file: "evidence/README.md",
    what: "live-folds 索引行 · 总数 / 会话 / quality / 区间 / 成本 / 生成时间",
    re: /^\| `live-folds\.json` \/ `\.md` \|.*$/gm,
    want: (m, v) => renderEvidenceLiveRow(v.live),
  },
  {
    file: "evidence/README.md",
    what: "逐会话索引行 · 记录数 / 会话 / quality / boundary / 生成时间",
    re: /^\| `fold质量-多会话-2026-11-02\.md` \|.*$/gm,
    want: (m, v) => renderEvidencePerSessionRow(v.live),
  },
  {
    file: "docs/research/00-蒸馏-对本插件的可执行结论.md",
    what: "§11.1 live 行 · 总数 / 会话 / trigger / quality / 区间 / 成本",
    re: /^\| live fold \|.*$/gm,
    want: (m, v) => renderResearchLiveRow(v.live),
  },
  {
    file: "evidence/持续优化-总览-2026-11-02.md",
    what: "总览 live 行 · 总数 / 会话 / quality / boundary / 生成时间",
    re: /^\| live 证据 \|.*$/gm,
    want: (m, v) => renderOverviewLiveRow(v.live),
  },
  {
    file: PER_SESSION_FILE,
    what: "逐会话表 · 由 renderPerSession(live-folds.json) 全量重生成",
    re: /^# 逐会话折叠质量（\*\*生成物\*\*，勿手改）[\s\S]*$/,
    want: (m, v) => v.live.perSessionText,
    report: (hit, v) => ({
      haveLabel: hit.have.split("\n").find((line) => line.startsWith("> 共 ")) ?? "旧逐会话生成物",
      wantLabel: v.live.perSessionText.split("\n").find((line) => line.startsWith("> 共 ")) ?? "新逐会话生成物",
    }),
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
  const live = readLiveFolds(root);
  const values = { passed, passedAt: at, passedAtUtcZ, ...changelog, live };
  const activeTargets = live === null ? TARGETS : [...TARGETS, ...LIVE_TARGETS];
  const docs = live === null ? DOCS : [...new Set([...DOCS, ...LIVE_TARGETS.map((target) => target.file)])];

  const problems = [];
  const files = [];
  let anchors = 0;
  let drifted = 0;

  for (const rel of docs) {
    const targets = activeTargets.filter((t) => t.file === rel);
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
        const report = target.report?.(hit, values) ?? {};
        hits.push({ ...hit, ...report, line: lineOf(text, hit.at), what: target.what });
      }
    }
    // 同一文件里多处的行号顺序（报告好读）
    hits.sort((a, b) => a.at - b.at);
    drifted += hits.length;
    files.push({ file: rel, abs, text, hits });
  }

  return { values, files, problems, drifted, anchors, coveredDocs: docs.length };
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
  const stamp = values.passedAtUtcZ === "未记录" ? "未记录" : `${values.passedAtUtcZ}Z`;
  out.push(`权威源：passed = ${values.passed}（${PASSED_FILE}，最近实测 ${stamp}）`);
  out.push(
    `        CHANGELOG = ${values.entries} 条条目 / ${values.ids} 个编号 / 最大 C${values.max}（经 changelog-index.parseEntries）`,
  );
  if (values.live) {
    const s = values.live.summary;
    out.push(`        live-folds = ${s.total} 次 / ${s.bySession.sessionsWithFolds} 会话 / quality ${s.quality.count}（${LIVE_FOLDS_FILE}）`);
  }
  out.push(`覆盖 ${plan.coveredDocs ?? DOCS.length} 份文档 / ${plan.anchors} 处锚点`);

  for (const file of files) {
    for (const hit of file.hits) {
      out.push(`  ${wrote ? "✎" : "✗"} ${file.file}:${hit.line} ［${hit.what}］`);
      out.push(`      「${hit.haveLabel ?? hit.have}」→「${hit.wantLabel ?? hit.want}」`);
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
