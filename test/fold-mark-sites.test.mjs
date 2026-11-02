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
