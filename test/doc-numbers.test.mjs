/**
 * doc-numbers.test.mjs —— 「文档里的手写计数」由机器维护，而这台机器自己也要被证明能抓到漂移
 *
 * 由来（2026-11-05 专项）：`NNNN passed`、`C1–C<n>`、`xxx 条条目`、`xxx 个编号` 这几类数字
 * 在 4 份文档里被手抄了 10 处。每加一条 CHANGELOG 或一个测试就有守卫变红（C167 / C172 / C485），
 * 修法一直是人肉改数字，下一轮又漂 —— 连续 5 轮的工时耗在这上面。
 *
 * `scripts/sync-doc-numbers.mjs` 把这件事做成「一个来源 + 一张锚点表」。这里钉住四件事：
 *   ① 真实树上 `--check` 必须 exit 0（文档 = 权威源）；
 *   ② 人为改坏一个数字，`--check` 必须**点名到文件:行号**（只说"有漂移"等于没说）；
 *   ③ `--write` 修得回来，且**幂等**；
 *   ④ 源缺失时**报错而不是猜**，锚点失配时**报错而不是静默跳过**（静默跳过 = 那处数字从此没人管）。
 *
 * 另有一条边界：bench tokens / doctor 警告数 / live fold 数**不许**被接进这张表 ——
 * 它们各自有生成脚本（`bench-repro` / `doctor` / `live-folds`），在这里再抄一遍就是第四个来源。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DOCS, TARGETS, normalizeChangelogHeaders, readChangelog } from "../scripts/sync-doc-numbers.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");
const SCRIPT = nodePath.join(REPO, "scripts", "sync-doc-numbers.mjs");
const BASELINE = nodePath.join(REPO, "test", "counts-baseline.json");

export const tests = {};

const run = (args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: "utf8", timeout: 120000 });

/** 复制一份「真实仓库的 6 个关键文件」到临时目录 —— 所有写操作只在副本上做，绝不碰真文档。 */
function makeFixture() {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "docnums-"));
  for (const rel of [...DOCS, "CHANGELOG.md", nodePath.join("test", "counts-baseline.json")]) {
    const dst = nodePath.join(dir, rel);
    nodeFs.mkdirSync(nodePath.dirname(dst), { recursive: true });
    nodeFs.copyFileSync(nodePath.join(REPO, rel), dst);
  }
  return dir;
}

/** 把「门禁行的全量通过数」改成一个**错的**值（+7），返回它所在的 1 起算行号。 */
function breakPassedIn(dir) {
  const file = nodePath.join(dir, "HANDOFF.md");
  const text = nodeFs.readFileSync(file, "utf8");
  const m = /(\| 门禁 \|[^\n]*?全量 \*\*)(\d+)( passed)/.exec(text);
  if (m === null) return null;
  const line = text.slice(0, m.index).split("\n").length;
  nodeFs.writeFileSync(file, text.replace(m[0], `${m[1]}${Number(m[2]) + 7}${m[3]}`), "utf8");
  return line;
}

tests["文档数字 1：真实树上 --check 必须 exit 0（文档里的计数 = 权威源）"] = (t) => {
  const r = run(["--check"]);
  t.eq(r.status, 0, `--check 不通过 ⇒ 有文档计数与权威源不一致，跑 node scripts/sync-doc-numbers.mjs --write\n${r.stdout ?? ""}${r.stderr ?? ""}`);
  const out = String(r.stdout ?? "");
  t.includes(out, "✅ 全部一致", "--check 通过时必须给出「全部一致」结论（否则这条判据形同虚设）");
  t.includes(out, "权威源", "输出必须写明权威源（不然读者不知道数字从哪来）");
};

tests["文档数字 2：人为改错一个数字后，--check 必须点名到「文件:行号」"] = (t) => {
  const dir = makeFixture();
  try {
    const line = breakPassedIn(dir);
    t.eq(Number.isInteger(line), true, "夹具里必须能定位到「门禁行」的通过数");
    const r = run(["--check", `--root=${dir}`]);
    t.eq(r.status, 1, "改了数字还 exit 0 ⇒ 守卫抓不到漂移");
    const out = String(r.stdout ?? "");
    t.includes(out, `HANDOFF.md:${line}`, `必须报出具体位置（期望 HANDOFF.md:${line}）：${out}`);
    t.includes(out, "全量测试通过数", "要写清这个数在说什么（不能只给一个行号）");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["文档数字 3：--write 修得回来，且幂等（第二次 --check 干净）"] = (t) => {
  const dir = makeFixture();
  try {
    breakPassedIn(dir);
    const w = run(["--write", `--root=${dir}`]);
    t.eq(w.status, 0, `--write 必须成功：${String(w.stdout ?? "")}${String(w.stderr ?? "")}`);
    const c = run(["--check", `--root=${dir}`]);
    t.eq(c.status, 0, `--write 之后 --check 必须干净：${String(c.stdout ?? "")}`);
    // 幂等：再写一次不该再改任何东西（否则每次门禁都在动文件）
    const again = run(["--write", `--root=${dir}`]);
    t.eq(again.status, 0, "第二次 --write 应当成功");
    t.includes(String(again.stdout ?? ""), "全部一致", "第二次 --write 不该再发现差异（幂等）");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["文档数字 4：权威源缺失时报错而不是猜（没有 passed 字段 ⇒ exit 1）"] = (t) => {
  const dir = makeFixture();
  try {
    const file = nodePath.join(dir, "test", "counts-baseline.json");
    const json = JSON.parse(nodeFs.readFileSync(BASELINE, "utf8"));
    delete json.passed;
    nodeFs.writeFileSync(file, JSON.stringify(json), "utf8");
    const r = run(["--check", `--root=${dir}`]);
    t.eq(r.status, 1, "没有 passed 字段还敢 exit 0 ⇒ 它在猜");
    const out = `${String(r.stdout ?? "")}${String(r.stderr ?? "")}`;
    t.includes(out, "passed", "必须说清缺的是 passed");
    t.includes(out, "不猜", "必须明说「不猜」（这条判据本身就是给下一个人看的）");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["文档数字 5：锚点失配必须报错（文案改了、脚本没改 ⇒ 不许静默跳过）"] = (t) => {
  const dir = makeFixture();
  try {
    const file = nodePath.join(dir, "docs", "knowledge", "进度.md");
    const text = nodeFs.readFileSync(file, "utf8");
    const broken = text.replace(/(^- 全量测试 \*\*)(\d+)( passed)/m, "$1$2 通过");
    t.eq(broken !== text, true, "夹具必须真的改掉了那处锚点");
    nodeFs.writeFileSync(file, broken, "utf8");
    const r = run(["--check", `--root=${dir}`]);
    t.eq(r.status, 1, "锚点没了还 exit 0 ⇒ 那处数字从此刻起无人维护");
    const out = String(r.stdout ?? "");
    t.includes(out, "锚点失配", "必须点名「锚点失配」");
    t.includes(out, "进度.md", "必须点名是哪个文件");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["文档数字 6：解析口径 —— C36.1 / C322（已回滚）同样算「一条条目」"] = (t) => {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "docnums-cl-"));
  try {
    const text = ["### C1 · 甲", "### C1.1 · 乙", "### C2（已回滚）· 丙", "### C3 · 丁", ""].join("\n");
    nodeFs.writeFileSync(nodePath.join(dir, "CHANGELOG.md"), text, "utf8");
    const stats = readChangelog(dir);
    // C172 守卫的口径是 `^### (C\d+)`：4 条标题 ⇒ 4 条条目、3 个编号（C1 出现两次）、最大 C3
    t.eq(stats.entries, 4, "带注解 / 小版本号的标题也必须算条目（否则与 C172 的口径打架）");
    t.eq(stats.ids, 3, "C1 与 C1.1 是同一个编号 ⇒ 3 个编号");
    t.eq(stats.max, 3, "最大编号必须认 C3");
    t.eq(normalizeChangelogHeaders(text).includes("（已回滚）"), false, "归一化后不该再留注解");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["文档数字 7：CHANGELOG 出现解析器认不出的标题形状 ⇒ 报错（不许写半成品数）"] = (t) => {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "docnums-bad-"));
  try {
    // `### C9` 没有 ` · 标题` ⇒ 守卫数得到、解析器数不到 ⇒ 两个口径会打架，必须当场报错
    nodeFs.writeFileSync(nodePath.join(dir, "CHANGELOG.md"), "### C1 · 甲\n### C9\n", "utf8");
    let message = "";
    try {
      readChangelog(dir);
    } catch (error) {
      message = String(error.message);
    }
    t.includes(message, "解析器只认出", "必须报出「标题数与解析结果不一致」");
    t.includes(message, "对齐解析", "必须给出下一步动作（先对齐解析，再同步文档）");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["文档数字 8：锚点表边界 —— 只覆盖这 4 份文档，且不许接进 bench / doctor / live fold"] = (t) => {
  const files = new Set(TARGETS.map((target) => target.file));
  t.eq([...files].sort(), [...DOCS].sort(), "锚点表只能落在题目圈定的 4 份文档里（别顺手扩到别的文件）");
  for (const target of TARGETS) {
    t.eq(typeof target.what === "string" && target.what.length > 0, true, `锚点必须有 what（报告要能说清这个数在说什么）：${target.re}`);
    const forbidden = /tokens|\bfold\b|doctor|WARN|warn|bench/.test(target.re.source);
    t.eq(forbidden, false, `锚点「${target.what}」命中了不该同步的数（bench / doctor / live fold 各自由生成脚本维护，别在这里抄第四份）`);
  }
};
