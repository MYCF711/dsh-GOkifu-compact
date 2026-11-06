/**
 * test-counts.mjs —— 每个测试文件的用例数**只许长，不许悄悄缩**（C325）
 *
 * 由来（2026-11-02）：我用 `cat > test/check-maintenance.test.mjs` 追加用例，
 * 结果把文件里原有的 4 条覆盖掉了 —— 全量从 1051 掉到 1049，**没有任何东西报警**，
 * 是我自己数条数才发现的。测试被删是最隐蔽的退化：全量还是"全绿"。
 *
 * 规则：`test/counts-baseline.json` 记下每个文件的用例数。
 *   · 变多 ⇒ 允许（顺手更新基线）；
 *   · 变少 ⇒ **红**，要先改基线（= 一次显式、可评审的删减）。
 *
 * 用法：
 *   node scripts/test-counts.mjs            # 比对（有收缩就退出 1）
 *   node scripts/test-counts.mjs --write    # 用当前结果更新基线（只在"确实想删"时用）
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const TEST_DIR = nodePath.join(ROOT, "test");
const BASELINE = nodePath.join(TEST_DIR, "counts-baseline.json");

/**
 * 数一个测试文件里的用例数。
 * 本项目两种写法：`tests["名字"] = …` 与 `tests["名字"] = (t) => …`，
 * 统一按 `tests[` 的出现次数数（这是本项目所有测试文件的唯一入口形式）。
 * @param {string} text
 * @returns {number}
 */
export function countCases(text) {
  return (String(text).match(/^tests\[/gm) ?? []).length;
}

/**
 * 比对当前与基线。
 * @param {Record<string, number>} current
 * @param {Record<string, number>} baseline
 * @returns {{shrunk: Array<{file: string, was: number, now: number}>, grown: Array<{file: string, was: number, now: number}>, added: string[], removed: string[]}}
 */
/**
 * ★ C485：把**最近一次全量测试的通过数**写进基线。
 *
 * 由来：HANDOFF 是新人第一眼读的文件，里面写着「全量 1226 passed」——而实际已经是 1242。
 * 更糟的是**没有任何东西守着它**：C167/C172 只保证「文档之间一致」，三个文件一起过期也照样绿。
 * 这个字段由 `gate.mjs` 在跑完全量测试后回写，于是「文档 vs 现实」终于有了闭环。
 *
 * @param {number} passed
 * @param {{baselineFile?: string}} [options]
 * @returns {{passed:number}} 写入后的值
 */
export function recordPassedCount(passed, { baselineFile = BASELINE } = {}) {
  const n = Number(passed);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`通过数不合理：${passed}`);
  const current = nodeFs.existsSync(baselineFile) ? JSON.parse(nodeFs.readFileSync(baselineFile, "utf8")) : { total: 0, files: {} };
  current.passed = Math.round(n);
  current.passedAt = new Date().toISOString();
  nodeFs.writeFileSync(baselineFile, JSON.stringify(current, null, 1), "utf8");
  return { passed: current.passed };
}

export function compareCounts(current, baseline) {
  const shrunk = [];
  const grown = [];
  const added = [];
  const removed = [];
  for (const [file, now] of Object.entries(current)) {
    const was = baseline[file];
    if (was === undefined) {
      added.push(file);
      continue;
    }
    if (now < was) shrunk.push({ file, was, now });
    else if (now > was) grown.push({ file, was, now });
  }
  for (const file of Object.keys(baseline)) {
    if (current[file] === undefined) removed.push(file);
  }
  return { shrunk, grown, added, removed };
}

/** 收集当前各文件的用例数。 */
export function collectCounts(dir = TEST_DIR) {
  const out = {};
  if (!nodeFs.existsSync(dir)) return out;
  for (const name of nodeFs.readdirSync(dir).sort()) {
    if (!name.endsWith(".test.mjs")) continue;
    out[name] = countCases(nodeFs.readFileSync(nodePath.join(dir, name), "utf8"));
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const current = collectCounts();
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  if (argv.includes("--write")) {
    // ★ C603：`--write` 只许改 `total`/`files`，**不许丢掉 `passed`/`passedAt`**。
    //   丢了的后果是**两处静默失效**：C485（文档里的"N passed"与实测一致）变成软绿；
    //   `sync-doc-numbers` 读不到权威值，只能报「源缺失，不猜」。
    const previous = (() => {
      try {
        const raw = JSON.parse(nodeFs.readFileSync(BASELINE, "utf8"));
        return { passed: raw.passed, passedAt: raw.passedAt };
      } catch {
        return {};
      }
    })();
    const next = { total, files: current };
    if (Number.isFinite(Number(previous.passed))) next.passed = Number(previous.passed);
    if (typeof previous.passedAt === "string") next.passedAt = previous.passedAt;
    nodeFs.writeFileSync(BASELINE, JSON.stringify(next, null, 2) + String.fromCharCode(10), "utf8");
    console.log(`已写入基线：${Object.keys(current).length} 个文件 / ${total} 条用例` + (next.passed === undefined ? "（⚠ 没有 passed：先跑 recordPassedCount）" : `（passed 保留 ${next.passed}）`));
    return 0;
  }
  if (!nodeFs.existsSync(BASELINE)) {
    console.log("没有基线文件 —— 先跑 node scripts/test-counts.mjs --write");
    return 0;
  }
  const baseline = JSON.parse(nodeFs.readFileSync(BASELINE, "utf8"));
  const { shrunk, grown, added, removed } = compareCounts(current, baseline.files ?? {});

  console.log(`== 测试用例数守卫 ==  现在 ${total} 条 / 基线 ${baseline.total ?? "?"} 条`);
  for (const g of grown) console.log(`  ↑ ${g.file}: ${g.was} → ${g.now}`);
  for (const a of added) console.log(`  + ${a}: ${current[a]} 条（新增文件，记得更新基线）`);
  for (const r of removed) console.log(`  − ${r} 整份不见了（基线里有、现在没有）`);
  for (const s of shrunk) console.log(`  ⚠ ${s.file}: ${s.was} → ${s.now}（少了 ${s.was - s.now} 条）`);
  if (shrunk.length > 0) {
    console.log("❌ 有用例被删/被覆盖 —— 如果是有意的，跑 node scripts/test-counts.mjs --write 更新基线并一起提交");
    return 1;
  }
  console.log("✅ 没有用例数收缩");
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
