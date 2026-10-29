/**
 * ab-render.mjs —— 热清单 A/B 的夹具：同一张棋谱，三种标记档位各渲染一份。
 *
 * 为什么要这样一个工具：这个项目的每个版本都必须有「模型消费者」证据，
 * 而证据要能量化 —— 同一个场景、唯一自变量（标记档位），三个臂逐字可复现。
 *
 *   臂 A `semantic`（默认）：`[blocked:permission]` + `redundant:e2` + 图例
 *   臂 B `terse`           ：只有三态 `[blocked]`，图例仍在（但说不出是什么被挡住）
 *   臂 C `off`             ：完全不打标记（退回纯失败列表）
 *
 * 用法：
 *   node test/ab-render.mjs            # 打印三个臂
 *   node test/ab-render.mjs --dir DIR  # 每个臂写一个文件到 DIR
 *
 * ⚠ 场景是**自足**的（虚构项目 svc-4021）：受试者只能凭清单作答，不需要读任何代码，
 *   这样才有资格叫「盲测」。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
// ── 夹具专用引导（test/fixtures/entry-argv/gen.mjs 生成；勿手改）──
import { createRequire as __createRequire__ } from "node:module";
import { pathToFileURL as __pathToFileURL__ } from "node:url";
// 仓库根：环境变量优先（被 import 时没有 CLI 参数可借）
const __REPO__ = nodePath.resolve(process.env.GOKIFU_REPO_ROOT || process.argv[3] || ".");
const __require__ = __createRequire__(__pathToFileURL__(nodePath.join(__REPO__, "package.json")));
const __pick__ = (rel) => __require__(nodePath.join(__REPO__, rel));

import { fileURLToPath } from "node:url";
const { createGraph, addUserNode, addAgentNode, addEdge, settleEdge } = __pick__("src/graph.mjs");
const { renderLedger } = __pick__("src/ledger.mjs");

const WIN = process.platform === "win32";

export function scenario() {
  const g = createGraph({ sessionId: "ab-svc-4021", cwd: "/home/dev/work/svc-4021" });
  const u = addUserNode(g, { seq: 1, text: "把 tests/case*.test.js 跑绿：缓存键算错了。不要动 prod 配置。" });

  // ── 成功路径：把缓存键改成「规范化后的参数」（唯一走通的做法）──
  const eWork = addEdge(g, { from: u, intent: "把缓存键改成规范化参数", action: "edit(file_path=src/cache.js)" });
  const n2 = addAgentNode(g, { seq: 6, goal: "缓存键修好，case7 通过", worldHash: "W-key-fixed", constraintHash: "C1", via: eWork }).id;
  g.edges[eWork].to = n2;
  settleEdge(g, eWork, { result: "success", verify: { kind: "exit", summary: "exit 0" }, errorSnippet: "" });

  // ── 失败 1：换了写法但到达同一局面（等价于成功那条）→ redundant:e2 ──
  const eRedundant = addEdge(g, { from: u, intent: "把缓存键改成 JSON.stringify 全部参数", action: "edit(file_path=src/cache.js)" });
  g.edges[eRedundant].to = n2;
  settleEdge(g, eRedundant, {
    result: "failure",
    verify: { kind: "test", summary: "12 tests, 1 failing" },
    errorSnippet: "AssertionError: case7 expected 1 got 2 at tests/case7.test.js:42",
  });

  // ── 失败 2：环境缺权限（外部可变）→ blocked:permission ──
  const eBlocked = addEdge(g, { from: u, intent: "装全局 sqlite 依赖后再跑", action: "bash(npm install -g better-sqlite3)" });
  settleEdge(g, eBlocked, {
    result: "failure",
    verify: { kind: "exit", summary: "exit 243" },
    errorSnippet: "npm ERR! EACCES: permission denied, mkdir '/usr/lib/node_modules/better-sqlite3'",
  });

  // ── 失败 3：绕远路（成功路径也能到同一终点，但更短）→ longer:e2 ──
  const eMissing = addEdge(g, { from: u, intent: "先重写 staging 的 fixture 再同步回来", action: "bash(cp -r ../staging/tests tests)" });
  g.edges[eMissing].to = n2;
  settleEdge(g, eMissing, {
    result: "failure",
    verify: { kind: "exit", summary: "exit 1" },
    errorSnippet: "cp: cannot stat '../staging/tests': No such file or directory",
  });

  return g;
}

/**
 * 场景 2（区分性场景）：错误文本本身**误导**成「可重试」，只有手割关系能纠正。
 *   e2 的报错是 "flaky test run aborted"（看起来重跑一次就好），但图里它到达的节点
 *   与成功边 e1 相同 ⇒ dead + redundant:e1：重试只会再撞同一堵墙。
 *   这是「手割标记 vs 不带」唯一能真正区分行为的场景：没有标记时，模型只能凭错误文本猜。
 */
export function scenarioTrap() {
  const g = createGraph({ sessionId: "ab-trap", cwd: "/home/dev/work/svc-4021" });
  const u = addUserNode(g, { seq: 1, text: "把 tests/case*.test.js 跑绿：缓存键算错了。不要动 prod 配置。" });
  const eWin = addEdge(g, { from: u, intent: "把缓存键改成参数去重、排序后再序列化", action: "edit(file_path=src/cache.js)" });
  const n2 = addAgentNode(g, { seq: 6, goal: "缓存键修好，全部用例通过", worldHash: "W-key-dedup", constraintHash: "C1", via: eWin }).id;
  g.edges[eWin].to = n2;
  settleEdge(g, eWin, { result: "success", verify: { kind: "exit", summary: "exit 0" }, errorSnippet: "" });
  // 1) 看起来像 flaky（重跑就好），实际与成功边到达同一局面 —— 真正的死路
  const eFlaky = addEdge(g, { from: u, intent: "再跑一遍测试（上次可能是 flaky）", action: "bash(npm test -- tests/case7.test.js)" });
  g.edges[eFlaky].to = n2;
  settleEdge(g, eFlaky, { result: "failure", verify: { kind: "exit", summary: "exit 137" }, errorSnippet: "Error: flaky test run aborted (SIGKILL) after 12s" });
  // 2) 环境阻塞
  const ePerm = addEdge(g, { from: u, intent: "先把 Node 升到 22 再跑", action: "bash(n install 22)" });
  settleEdge(g, ePerm, { result: "failure", verify: { kind: "exit", summary: "exit 1" }, errorSnippet: "Error: EACCES: permission denied, open '/usr/local/n/versions/node'" });
  // 3) 探出新局面（没走过的状态）
  const eNovel = addEdge(g, { from: u, intent: "把 case7 的断言改成跳过", action: "edit(file_path=tests/case7.test.js)" });
  const nX = addAgentNode(g, { seq: 9, goal: "case7 被跳过", worldHash: "W-skip-case7", constraintHash: "C1", via: eNovel }).id;
  g.edges[eNovel].to = nX;
  settleEdge(g, eNovel, { result: "failure", verify: { kind: "test", summary: "1 failing" }, errorSnippet: "AssertionError: case7 expected 1 got 2 at tests/case7.test.js:42" });
  return g;
}

export const ARMS = ["semantic", "terse", "off"];

export function renderArm(markers = "semantic", maxTokens = 500, which = "basic") {
  const g = which === "trap" ? scenarioTrap() : scenario();
  return renderLedger(g, { maxTokens, markers });
}

/**
 * 入口判据（C-12）—— 不许拿 import.meta.url 直接与 argv[1] 的 basename 比结尾。
 * 旧写法假设 URL 里带**未编码**的文件名；本机实测改成 `ab 渲染.mjs` 后
 * `import.meta.url` 是 `…/ab%20%E6%B8%B2%E6%9F%93.mjs` ⇒ 旧判据 false
 * ⇒ 脚本「成功」退出 0 却什么都不打印（与 S10a 第 3 条同一种假绿）。
 * 正确判据：两边都归一成**文件系统路径**再比 —— argv[1] 允许是普通路径或 file:// URL，
 * import.meta.url 一律经 fileURLToPath（它负责把 %XX 解码回真实文件名）。
 * Windows 大小写不敏感，所以两边都先 realpath（拿不到真实路径时退化为 resolve 后小写比）。
 */
function judgeEntry(argv1, selfUrl) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  let selfPath;
  try {
    selfPath = fileURLToPath(selfUrl);
  } catch {
    return false;
  }
  let argPath = argv1;
  if (/^file:/i.test(argv1)) {
    try {
      argPath = fileURLToPath(argv1);
    } catch {
      return false;
    }
  }
  const norm = (p) => {
    try {
      return nodeFs.realpathSync.native(p);
    } catch {
      return nodePath.resolve(p);
    }
  };
  const a = norm(argPath);
  const b = norm(selfPath);
  return WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export { judgeEntry };

const invokedDirectly = judgeEntry(process.argv[1], import.meta.url);
if (invokedDirectly) {
  const which = process.argv.includes("--scenario=trap") ? "trap" : "basic";
  const dirIndex = process.argv.indexOf("--dir");
  const dir = dirIndex >= 0 ? process.argv[dirIndex + 1] : "";
  for (const arm of ARMS) {
    const r = renderArm(arm, 500, which);
    const header = `<!-- arm=${arm} level=L${r.level} tokens=${r.tokens} failures=${r.failureCount} -->\n`;
    if (dir) {
      nodeFs.mkdirSync(dir, { recursive: true });
      nodeFs.writeFileSync(nodePath.join(dir, `${arm}.md`), header + r.text + "\n", "utf8");
      console.log(`${arm}: L${r.level} / ${r.tokens} tokens → ${nodePath.join(dir, `${arm}.md`)}`);
    } else {
      console.log(`\n########## arm=${arm}  L${r.level}  tokens=${r.tokens} ##########\n${r.text}`);
    }
  }
}
