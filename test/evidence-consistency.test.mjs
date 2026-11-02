/**
 * evidence-consistency.test.mjs —— 证据文档里引用的数字必须与 `live-folds.json` 一致（2026-11-02，C118）
 *
 * 为什么：`evidence/README.md` 与 `docs/research/00` §11.1 里写的是「19 次 / 7 会话 / 压缩比 48.45–350.68 /
 * 成本 47–76%」这类**从 JSON 抄来的**数字。抄写一定会漂移 —— 而 C100/C117 只守文档里的**常量锚**
 * （规则数、bench tokens、测试数），守不住「从证据文件同步的数字」。
 *
 * 判据：直接从 `evidence/live-folds.json` 重新算，再断言文档里出现同样口径的字符串。
 * 这是**只读**检查；它不重新采集（要新鲜数据先跑 `node scripts/live-folds.mjs --write`）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const EVIDENCE = JSON.parse(nodeFs.readFileSync(nodePath.join(REPO, "evidence", "live-folds.json"), "utf8"));

export const tests = {};

const read = (rel) => nodeFs.readFileSync(nodePath.join(REPO, rel), "utf8");

/** 从 evidence JSON 的 summary 推出文档里应该出现的几组字符串。 */
function expectedFacts() {
  const s = EVIDENCE.summary;
  const pctMin = Math.round(s.cost.shadowedShareMin * 100);
  const pctMax = Math.round(s.cost.shadowedShareMax * 100);
  return {
    total: s.total,
    sessions: s.bySession.sessionsWithFolds,
    qualityCount: s.quality.count,
    ratioRange: `${s.quality.compressionRatioMin}–${s.quality.compressionRatioMax}`,
    costRange: `${pctMin}–${pctMax}%`,
    thrash: s.thrash.sessions,
  };
}

tests["C118-1 evidence/README 与 research §11.1 的数字必须与 live-folds.json 一致"] = (t) => {
  const f = expectedFacts();
  const readme = read("evidence/README.md");
  const research = read("docs/research/00-蒸馏-对本插件的可执行结论.md");

  // 总数与会话数（两处都要有）
  for (const [label, text] of [["evidence/README.md", readme], ["research §11.1", research]]) {
    t.includes(text, `**${f.total} 次`, `${label} 必须写总 fold 数 ${f.total}`);
    t.eq(text.includes(`${f.sessions} 会话`) || text.includes(`${f.sessions} 个有 fold 的会话`), true, `${label} 必须写有 fold 的会话数 ${f.sessions}`);
    t.includes(text, `quality ${f.qualityCount}`, `${label} 必须写 quality 样本数 ${f.qualityCount}`);
  }

  // 区间类：压缩比与成本（容差为 0 —— 抄错就是错）
  t.includes(readme, `压缩比 ${f.ratioRange}`, `evidence/README.md 的压缩比必须等于 ${f.ratioRange}`);
  t.includes(readme, `成本 ${f.costRange}`, `evidence/README.md 的成本必须等于 ${f.costRange}`);
  t.includes(research, `压缩比 ${f.ratioRange}`, `research 的压缩比必须等于 ${f.ratioRange}`);
  t.includes(research, `成本 ${f.costRange}`, `research 的成本必须等于 ${f.costRange}`);

  // thrash 必须仍是 0（一旦非 0，文档需要改写而不是沉默）
  t.eq(f.thrash, 0, `foldThrash 必须为 0 才与文档一致，实际 ${f.thrash}`);
};

tests["C118-2 逐会话表必须与 live-folds.json 的 bySession 一致（本会话折了几次）"] = (t) => {
  const doc = read("evidence/fold质量-多会话-2026-11-02.md");
  const ours = EVIDENCE.summary.bySession.top.find((x) => x.sessionId.startsWith("session-00b50089"));
  t.eq(!!ours, true, "顶层会话列表里必须有本会话");
  t.includes(doc, `| ${ours.folds} |`, `逐会话表必须写本会话的 fold 次数 ${ours.folds}`);
  const boundaryCount = (EVIDENCE.folds ?? []).filter((x) => x.boundary && typeof x.boundary.openAtEnd === "number").length;
  t.includes(doc, `${boundaryCount} 次带 boundary`, `文档必须写「${boundaryCount} 次带 boundary」`);
  const openSum = (EVIDENCE.folds ?? []).reduce((sum, x) => sum + (x.boundary?.openAtEnd ?? 0), 0);
  t.eq(openSum, 0, `openAtEnd 总和必须为 0（实际 ${openSum}）`);
};

tests["C119-1 bench 证据文件必须等于当前基线（447 那种陈旧值会误导「成本是不是退化了」）"] = (t) => {
  const bench = JSON.parse(nodeFs.readFileSync(nodePath.join(REPO, "evidence", "bench-2000.json"), "utf8"));
  const src = nodeFs.readFileSync(nodePath.join(REPO, "scripts", "bench-repro.mjs"), "utf8");
  const expected = Number((src.match(/const EXPECTED_TOKENS = (\d+);/) ?? [])[1]);
  t.eq(Number.isFinite(expected), true, "bench-repro 必须有 EXPECTED_TOKENS");
  t.eq(bench.ledgerTokens, expected, `evidence/bench-2000.json（${bench.ledgerTokens}）必须等于基线 ${expected} —— 否则证据与文档互相矛盾`);
  t.eq(bench.ledgerLevel, 5, "夹具档位必须仍是 L5");
};

tests["C119-2 校准证据的 p50/p90/min/max/超预算必须与 README 行一致"] = (t) => {
  const calib = JSON.parse(nodeFs.readFileSync(nodePath.join(REPO, "evidence", "ledger-calibration.json"), "utf8"));
  const s = calib.summary;
  const readme = read("evidence/README.md");
  const line = readme.split(String.fromCharCode(10)).find((l) => l.includes("ledger-calibration.json"));
  t.eq(!!line, true, "README 必须有 ledger-calibration 行");
  // README 的写法：`p50 = 419 / p90 = 521 / min 32 / max 688`（分位数带 `=`，极值不带）
  for (const [needle, value] of [["p50 =", s.p50], ["p90 =", s.p90], ["min", s.min], ["max", s.max]]) {
    t.includes(line, `${needle} ${value}`, `README 行必须写 ${needle} ${value}`);
  }
  t.includes(line, `超预算 ${s.over}/${s.n}`, `README 行必须写超预算 ${s.over}/${s.n}`);
};

tests["C120-1 证据目录里的每个文件都必须能被 README 找到（按文件主干匹配，允许 `X.*`）"] = (t) => {
  const dir = nodePath.join(REPO, "evidence");
  const readme = read("evidence/README.md");
  const files = nodeFs.readdirSync(dir).filter((f) => /\.(json|md)$/.test(f) && f !== "README.md");
  t.eq(files.length >= 20, true, `证据文件应有 20+，实际 ${files.length}`);
  const missing = files.filter((f) => {
    const stem = f.replace(/\.(json|md)$/, "");
    return !readme.includes(stem);
  });
  t.eq(missing.length, 0, `这些证据文件在 README 里找不到（新证据没登记 / 被改名）：${missing.join(", ")}`);
};

tests["C120-2 README 里点名的证据文件必须真实存在（反过来防「删了文件但索引还写着」）"] = (t) => {
  const readme = read("evidence/README.md");
  const refs = [...new Set([...readme.matchAll(/`([^`\s]+?\.(?:md|json))`/g)].map((m) => m[1]))];
  t.eq(refs.length >= 10, true, `README 至少点名 10 个文件，实际 ${refs.length}`);
  const missing = refs.filter((name) => !nodeFs.existsSync(nodePath.join(REPO, "evidence", name)));
  t.eq(missing.length, 0, `README 点名但文件不存在：${missing.join(", ")}`);
};

tests["C120-3 现行文档里以 `evidence/xxx.{md,json}` 形式引用的文件必须存在"] = (t) => {
  const docs = [
    "README.md",
    "QUICKSTART.md",
    "docs/压缩的重注入契约.md",
    "docs/发布就绪-2026-11-02.md",
    "docs/research/00-蒸馏-对本插件的可执行结论.md",
    "docs/落盘与回滚不变量.md",
  ];
  let seen = 0;
  const missing = [];
  for (const rel of docs) {
    if (!nodeFs.existsSync(nodePath.join(REPO, rel))) continue;
    for (const m of read(rel).matchAll(/(evidence\/[A-Za-z0-9一-鿿_.\-]+\.(?:md|json))/g)) {
      seen += 1;
      if (!nodeFs.existsSync(nodePath.join(REPO, m[1]))) missing.push(`${rel} → ${m[1]}`);
    }
  }
  void seen;
  t.eq(missing.length, 0, `现行文档引用了不存在的证据文件：${missing.join(" / ")}`);
};

tests["C121 文档里对 `docs/research/NN-*.md` 的引用必须存在（调研文改名最容易留下死引用）"] = (t) => {
  const NL = String.fromCharCode(10);
  void NL;
  const targets = ["README.md", "QUICKSTART.md", "evidence/README.md"];
  for (const rel of nodeFs.readdirSync(nodePath.join(REPO, "docs"))) {
    if (rel.endsWith(".md")) targets.push(`docs/${rel}`);
  }
  for (const rel of nodeFs.readdirSync(nodePath.join(REPO, "docs", "research"))) {
    if (rel.endsWith(".md") && rel !== "README.md") targets.push(`docs/research/${rel}`);
  }
  let seen = 0;
  const missing = [];
  for (const rel of targets) {
    if (!nodeFs.existsSync(nodePath.join(REPO, rel))) continue;
    for (const m of read(rel).matchAll(/docs\/research\/([A-Za-z0-9一-鿿_.\-]+\.md)/g)) {
      seen += 1;
      if (!nodeFs.existsSync(nodePath.join(REPO, "docs", "research", m[1]))) missing.push(`${rel} → ${m[1]}`);
    }
  }
  t.eq(seen >= 5, true, `至少要扫到 5 处对调研文的引用，实际 ${seen}`);
  t.eq(missing.length, 0, `引用了不存在的调研文：${missing.join(" / ")}`);
};

tests["C122 可引用数字表的 bench 行必须等于当前基线（它是「引用前先看这里」的那张表）"] = (t) => {
  const src = nodeFs.readFileSync(nodePath.join(REPO, "scripts", "bench-repro.mjs"), "utf8");
  const expected = Number((src.match(/const EXPECTED_TOKENS = (\d+);/) ?? [])[1]);
  t.eq(Number.isFinite(expected), true, "bench-repro 必须有 EXPECTED_TOKENS");
  const doc = read("docs/research/06-可引用数字表.md");
  const rows = doc.split(String.fromCharCode(10)).filter((line) => line.includes("bench-repro"));
  t.eq(rows.length >= 1, true, "06 表里必须有一行以 bench-repro 为来源的热清单数字");
  const hit = rows.find((line) => /\*\*(\d+) tokens\*\*/.test(line));
  t.eq(!!hit, true, `bench 行必须写「**N tokens**」：${rows.join(" | ")}`);
  const number = Number(hit.match(/\*\*(\d+) tokens\*\*/)[1]);
  t.eq(number, expected, `可引用数字表写的是 ${number}，当前基线是 ${expected}（这张表就是给人抄的，抄错代价最大）`);
};

tests["C123 可引用数字表的「算术自洽」：均值与比例必须能从行内样本算出来"] = (t) => {
  const doc = read("docs/research/06-可引用数字表.md");
  const lines = doc.split(String.fromCharCode(10));

  // ① 失败边保留：`**6.67/8 vs 5.67/8**` 与同行的三次采样必须对得上（改了样本忘改均值会红）
  const row = lines.find((line) => /\*\*[\d.]+\/8 vs [\d.]+\/8\*\*/.test(line) && line.includes("三次采样"));
  t.eq(!!row, true, "06 表里必须有「本插件 vs 官方」的失败边保留行（含三次采样）");
  const stated = Number(row.match(/\*\*([\d.]+)\/8 vs/)[1]);
  // 只在「三次采样：…」那一段里解析，避免把 `6.67/8` 的 `67/8` 当成采样值
  const listPart = (row.match(/三次采样：([^）]+)/) ?? [])[1] ?? "";
  const samples = [...listPart.matchAll(/(\d+)\/8/g)].map((m) => Number(m[1])).slice(0, 3);
  t.eq(samples.length, 3, `必须能解析出 3 个采样值：${samples.join(",")}`);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  t.eq(Math.abs(avg - stated) < 0.005, true, `三个采样均值 ${avg.toFixed(3)} 与文中 ${stated} 不一致（改样本没改均值）`);

  // ② 摘要字符比例：`804 字符` 与 `10,419 字符` 的比 ≈ 行里断言的 1/13
  const ratioRow = lines.find((line) => line.includes("804 字符") && line.includes("1/13"));
  t.eq(!!ratioRow, true, "06 表里必须有「804 字符 / 10,419 字符 = 1/13」这行");
  const ratio = 804 / 10419;
  t.eq(Math.abs(ratio - 1 / 13) < 0.005, true, `804/10419 = ${ratio.toFixed(4)}，与「1/13 = ${(1 / 13).toFixed(4)}」差距过大`);
};

tests["C154 发布核对文档必须与本地版本一致，且标明是「只读核对」"] = (t) => {
  const pkg = JSON.parse(read("package.json"));
  const doc = read("evidence/发布核对-2026-11-02.md");
  t.includes(doc, pkg.version, `发布核对必须写当前本地版本 ${pkg.version}（改版本后忘了更新会红）`);
  t.eq(/20[0-9]{2}-[0-9]{2}-[0-9]{2}/.test(doc), true, "必须带日期");
  t.includes(doc, "只读核对", "必须声明是只读核对（未执行 publish/tag/push）");
  t.eq(/npm publish/.test(doc), true, "必须把发布命令写出来（否则读者不知道差哪一步）");
};

tests["C156 重启验收清单必须存在且覆盖关键判据（否则重启后没人知道该看什么）"] = (t) => {
  const doc = read("evidence/重启验收清单-2026-11-02.md");
  for (const needle of ["post-restart-check", "buildId", "doctor", "graph-audit", "live-folds", "boundary-audit"]) {
    t.includes(doc, needle, `清单必须覆盖 ${needle}`);
  }
  t.includes(doc, "912 passed", "清单里的全量测试数必须写当前值（改数字要同步）");
  t.eq(/20[0-9]{2}-[0-9]{2}-[0-9]{2}/.test(doc), true, "必须带日期");
};

tests["C167 调研文里的 live 数字与测试数必须跟 HANDOFF / live-folds.json 一致"] = (t) => {
  const doc = read("docs/research/00-蒸馏-对本插件的可执行结论.md");
  const handoff = read("HANDOFF.md");

  // ① 测试数：调研文与 HANDOFF 必须同源（HANDOFF 的测试数由 C117 管时间戳）
  const docPassed = doc.match(/最近实测 \*\*(\d+) passed/);
  const handoffPassed = handoff.match(/全量 \*\*(\d+) passed/);
  t.eq(!!docPassed, true, "调研文必须写测试数（并标「最近实测」）");
  t.eq(!!handoffPassed, true, "HANDOFF 必须写测试数");
  t.eq(docPassed[1], handoffPassed[1], `调研文 ${docPassed[1]} vs HANDOFF ${handoffPassed[1]} 不一致`);

  // ② live fold 数量/会话数：与证据 JSON 同源
  const json = JSON.parse(read("evidence/live-folds.json"));
  const total = json.summary.total;
  const sessions = json.summary.bySession.sessionsWithFolds;
  const docLive = doc.match(/live fold \| \*\*(\d+) 次 \/ (\d+) 会话\*\*/);
  t.eq(!!docLive, true, "调研文必须写 live fold 次数与会话数");
  t.eq(Number(docLive[1]), total, `调研文的 fold 次数 ${docLive[1]} 与证据 ${total} 不一致`);
  t.eq(Number(docLive[2]), sessions, `调研文的会话数 ${docLive[2]} 与证据 ${sessions} 不一致`);
};

tests["C172 「2 分钟总览」必须与 CHANGELOG / HANDOFF / live-folds.json 同步（此前无人守）"] = (t) => {
  const overview = read("evidence/持续优化-总览-2026-11-02.md");
  const changelog = read("CHANGELOG.md");
  const handoff = read("HANDOFF.md");
  const json = JSON.parse(read("evidence/live-folds.json"));

  // ① 条目数与编号数：CHANGELOG 历史上有同编号补充条目（C5/C26/C36）与一个缺号（C40），
  //    所以「条数」与「编号数」必须分开写、分开校验 —— 只写一个数必然对不上。
  const headers = [...changelog.matchAll(/^### (C\d+)/gm)].map((m) => Number(m[1].slice(1)));
  const distinct = new Set(headers).size;
  const claimed = overview.match(/\*\*(\d+) 条条目 \/ (\d+) 个编号\*\*/);
  t.eq(!!claimed, true, "总览必须写「N 条条目 / M 个编号」");
  t.eq(Number(claimed[1]), headers.length, `总览写 ${claimed[1]} 条条目，CHANGELOG 实际 ${headers.length}`);
  t.eq(Number(claimed[2]), distinct, `总览写 ${claimed[2]} 个编号，CHANGELOG 实际 ${distinct}`);

  // ② 覆盖区间：总览标题里的 C1–C<n> 必须等于 CHANGELOG 的最大编号
  const maxC = Math.max(...headers);
  const range = overview.match(/C1[–-]C(\d+)/);
  t.eq(!!range, true, "总览标题必须写覆盖区间 C1–C<n>");
  t.eq(Number(range[1]), maxC, `总览写到 C${range[1]}，CHANGELOG 最大是 C${maxC}`);

  // ③ 测试数：与 HANDOFF 同源
  const handoffPassed = handoff.match(/全量 \*\*(\d+) passed/);
  const overviewPassed = overview.match(/\*\*(\d+) passed/);
  t.eq(!!overviewPassed, true, "总览必须写测试数");
  t.eq(overviewPassed[1], handoffPassed[1], `总览 ${overviewPassed[1]} vs HANDOFF ${handoffPassed[1]} 不一致`);

  // ④ live fold：与证据 JSON 同源
  const live = overview.match(/\*\*(\d+) 次 fold \/ (\d+) 会话\*\*/);
  t.eq(!!live, true, "总览必须写 live fold 次数与会话数");
  t.eq(Number(live[1]), json.summary.total, `总览 fold ${live[1]} vs 证据 ${json.summary.total}`);
  t.eq(Number(live[2]), json.summary.bySession.sessionsWithFolds, `总览会话 ${live[2]} vs 证据 ${json.summary.bySession.sessionsWithFolds}`);
};
