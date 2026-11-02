/**
 * fold-mark-sites.test.mjs —— 每条折叠路径都必须记 quality / trigger / closure（2026-11-02，C108）
 *
 * 历史教训（C10 → C12 → C24 → C31 连续四轮）：
 * 每加一条折叠路径（常规 / 规则降级 / tier-2 合并 / overflow / 手动 `/compact`），
 * 就有人忘记给它的 foldMark 补字段 —— doctor 于是只能对那条路径显示「未采集」。
 *
 * 这条测试是**静态**的：直接读 `src/engine.mjs`，找出所有 `foldMarks.push({...})` 与
 * `recordFoldMark` 的记账体，要求每个都带 `quality:` / `trigger:` / `closure:` 三个键。
 * 以后新增路径若漏了字段，这里先红，不用等 live 数据。
 */

import { planRelease } from "../scripts/release-plan.mjs";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ENGINE = nodePath.join(HERE, "..", "src", "engine.mjs");

export const tests = {};

/**
 * 键既可以写成 `quality: …`，也可以写成 ES 简写 `quality,` —— 两者语义相同，
 * 判据必须同时接受（否则会逼着人把简洁写法改啰嗦，测试反而成了噪音）。
 */
const REQUIRED_KEYS = ["quality", "trigger", "closure"];
const hasKey = (body, key) => new RegExp("(^|[^A-Za-z0-9_])" + key + "[^A-Za-z0-9_]{0,3}[,}:]", "m").test(body);

/** 从 `start`（指向 `{`）起做括号配平，返回配对 `}` 的下标。 */
function matchBrace(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 收集所有 `foldMarks.push({ ... })` 的块体文本。 */
function pushBlocks(text) {
  const blocks = [];
  const needle = "foldMarks.push({";
  let at = text.indexOf(needle);
  while (at !== -1) {
    const open = at + "foldMarks.push(".length;
    const close = matchBrace(text, open);
    blocks.push({ at, body: close === -1 ? text.slice(open) : text.slice(open, close + 1) });
    at = text.indexOf(needle, at + needle.length);
  }
  return blocks;
}

tests["C108-1 每个 foldMarks.push 都必须带 quality / trigger / closure"] = (t) => {
  const text = nodeFs.readFileSync(ENGINE, "utf8");
  const blocks = pushBlocks(text);
  t.eq(blocks.length >= 2, true, `至少要找到 2 处 foldMarks.push（常规 + tier2），实际 ${blocks.length}`);
  for (const [i, block] of blocks.entries()) {
    for (const key of REQUIRED_KEYS) {
      t.eq(hasKey(block.body, key), true, `第 ${i + 1} 处 foldMarks.push 缺 \`${key}\`（新增折叠路径漏记 ⇒ doctor 会显示「未采集」）`);
    }
  }
};

tests["C108-2 recordFoldMark（手动 /compact 与调用方）也必须记质量"] = (t) => {
  const text = nodeFs.readFileSync(ENGINE, "utf8");
  // 注意：`recordFoldMark(` 有**调用点**与**定义**两处；这里定位定义（形参默认值 `range = null`）。
  const at = text.indexOf("recordFoldMark(session, { range = null");
  t.eq(at !== -1, true, "必须存在 recordFoldMark 定义（形参 range = null）");
  const open = text.indexOf(") {", at) + 2;
  const close = matchBrace(text, open);
  const body = close === -1 ? text.slice(open) : text.slice(open, close + 1);
  for (const key of REQUIRED_KEYS) {
    t.eq(hasKey(body, key), true, `recordFoldMark 的记账体缺 \`${key}\``);
  }
  t.includes(body, "safeMeasureFoldQuality", "质量必须用 safeMeasure（诊断抛错不许拖垮压缩）");
};

tests["C112 每个回滚点（restore()）之后必须走 tree 落盘"] = (t) => {
  const text = nodeFs.readFileSync(ENGINE, "utf8");
  const lines = text.split(String.fromCharCode(10));
  const sites = lines.map((line, i) => (line.trim() === "restore();" ? i : -1)).filter((i) => i >= 0);
  t.eq(sites.length >= 3, true, `至少要找到 3 处 restore()，实际 ${sites.length}`);
  for (const lineNo of sites) {
    const window = lines.slice(lineNo, lineNo + 6).join(String.fromCharCode(10));
    t.includes(window, "#flush(session, { tree: true })", `第 ${lineNo + 1} 行回滚后必须 tree 落盘（否则 index.md / nodes/*.md 与图不一致）`);
  }
};

tests["C113 engine 的回滚必须用 restoreFromSnapshot（不许裸 Object.assign）"] = (t) => {
  const text = nodeFs.readFileSync(ENGINE, "utf8");
  t.eq(/restoreFromSnapshot\(g, graphSnapshot/.test(text), true, "回滚必须走 restoreFromSnapshot（连 dirty 一起处理）");
  // ★ C148（复审 P2-3）：统计**出现次数** —— 只断言「存在一处」的话，新增一处 2 参调用仍会绿。
  const withDirty = text.match(/restoreFromSnapshot\(g, graphSnapshot, dirtySnapshot\)/g) ?? [];
  const withoutDirty = text.match(/restoreFromSnapshot\(g, graphSnapshot\)/g) ?? [];
  t.eq(withDirty.length >= 1, true, "至少要有一处带 dirty 的快照恢复");
  t.eq(withoutDirty.length, 0, `不许存在 2 参（不带 dirty）的调用，实际 ${withoutDirty.length} 处`);
  t.eq(/Object\.assign\(g, fromJSON\(/.test(text), false, "不许再出现裸的 Object.assign(g, fromJSON(...)) —— 它会留下陈旧的 delNodes");
};

tests["C150 repaired 标记必须真的传到落盘层，且每个清理点都带护栏"] = (t) => {
  const engine = nodeFs.readFileSync(ENGINE, "utf8");
  t.eq(/repaired:\s*this\.repairedGraphs\.has\(/.test(engine), true, `#flush 必须把 repaired 标记透传给 persist.flush（C149）`);

  const persist = nodeFs.readFileSync(nodePath.join(HERE, "..", "src", "rooms", "kifu-persist.mjs"), "utf8");
  // 只数**调用点**（`pruneStaleNodeDocs(port`），别把函数定义本身算进去
  const calls = [...persist.matchAll(/pruneStaleNodeDocs\(port/g)].length;
  t.eq(calls >= 2, true, `至少应有 2 个清理调用点（firstWrite / 稳态），实际 ${calls}`);
  const guarded = [...persist.matchAll(/if \(tree && !repaired\) pruneStaleNodeDocs\(port/g)].length;
  t.eq(guarded, calls, `每个清理点都必须带 "tree && !repaired" 护栏（${guarded}/${calls}）`);
  t.eq(/repaired = false/.test(persist), true, "flush 的签名必须声明 repaired 选项（默认 false）");
};

tests["C183 脚本侧读图必须走 loadSessionGraph（不许再出现 fromJSON(读 graph.json) 的裸用法）"] = (t) => {
  const scriptsDir = nodePath.join(HERE, "..", "scripts");
  const offenders = [];
  for (const name of nodeFs.readdirSync(scriptsDir)) {
    if (!name.endsWith(".mjs")) continue;
    const text = nodeFs.readFileSync(nodePath.join(scriptsDir, name), "utf8");
    // 允许 graph-audit.mjs（它**就是** loader 本身）
    if (name === "graph-audit.mjs") continue;
    // 裸用法：fromJSON(nodeFs.readFileSync(... graph.json ...))
    if (/fromJSON\(\s*nodeFs\.readFileSync\(/.test(text)) offenders.push(name);
  }
  t.eq(offenders.length, 0, `这些脚本还在直读 graph.json 基线（应改用 loadSessionGraph）：${offenders.join(", ")}`);
};

tests["C201 测试运行器必须在开跑前清掉 .harness 临时目录（中断后残留会造成偶发假失败）"] = (t) => {
  const runner = nodeFs.readFileSync(nodePath.join(HERE, "..", "test", "run.mjs"), "utf8");
  t.includes(runner, '.harness', "run.mjs 必须提到 .harness");
  t.eq(/rmSync\(\s*harness/.test(runner), true, "run.mjs 必须在开跑前 rmSync(.harness)");
};

tests["C203 handoff-check 必须内建「证据↔磁盘一致」核对（否则 C200 那条命令容易忘跑）"] = (t) => {
  const text = nodeFs.readFileSync(nodePath.join(HERE, "..", "scripts", "handoff-check.mjs"), "utf8");
  t.includes(text, "consistency-check.mjs", "必须 import consistency-check");
  t.includes(text, "⑳证据与磁盘一致", "必须把这个检查挂进门禁");
  t.eq(/level = mismatch\.length > 0 \? "fail"/.test(text), true, "不一致必须是 fail（不是 softly warn）");
};

tests["C204 发布计划：脏树/已存在 tag/版本不一致必须拦住；干净时给出可执行命令且绝不执行发布"] = (t) => {
  const okFacts = { dirty: false, version: "1.17.1", tagName: "v1.17.1", tagExists: false, handoffVersion: "1.17.1", versionMismatch: false, testCount: "912", registryVersion: "1.16.0" };
  const ok = planRelease(okFacts);
  t.eq(ok.ok, true, `干净前置应通过：${JSON.stringify(ok.problems)}`);
  t.eq(ok.commands.some((c) => c.includes("npm publish")), true, "必须给出 npm publish");
  t.eq(ok.commands.some((c) => c.includes("git tag -a v1.17.1")), true, "必须给出 tag 命令");
  t.eq(ok.commands.some((c) => c.includes("git push")), true, "push 只在命令清单里出现（由主人执行）");

  const dirty = planRelease({ ...okFacts, dirty: true });
  t.eq(dirty.ok, false, "脏树必须拦");
  t.eq(dirty.problems.some((x) => x.includes("工作树不干净")), true, "必须说明原因");

  const tagged = planRelease({ ...okFacts, tagExists: true });
  t.eq(tagged.ok, false, "tag 已存在必须拦");

  const mismatch = planRelease({ ...okFacts, version: "1.17.2", handoffVersion: "1.17.1", versionMismatch: true });
  t.eq(mismatch.ok, false, "版本不一致必须拦");
};
