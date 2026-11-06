/**
 * real-headless-fold.mjs —— **真实 DSH 进程**里跑一次真实 fold（goal ② 的验收）
 *
 * 和 real-fold.mjs 的区别：
 *   · real-fold.mjs 用的是「假 Session + 真引擎」——Session 的 JSON 序列化校验、surface 规则、
 *     事件发布全是假的。实测它就漏掉了两个只在真 Session 上才暴露的 bug：
 *       ① 规则摘要缺 provider/model ⇒ `compaction/summary carries non-JSON-serializable data`
 *          ⇒ **summaryMode: rules 在真实 DSH 里从未成功过**；
 *       ② 清单替换的锚点/事件形状（由 test/real-ledger-replace.mjs 单独覆盖）。
 *   · 本文件起一个 **真正的 dsh headless 进程**（独立 profile + overlay），把阈值压到很小，
 *     让它在完成任务的过程中真的触发 fold；然后从会话日志里核对 `compaction/*` 事件。
 *
 * 前置：
 *   · `<DSH_HOME>/profiles/headless` 存在；
 *   · `profiles/headless/node_modules/dsh-gokifu-compact` 是**指向本仓库的 junction**
 *     （脚本会检查并给出修复命令，不会自己改 profile）。
 * 用法：node test/real-headless-fold.mjs
 * 退出码：0 = 至少 1 次成功 fold 且 0 次失败；1 = 不满足。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");
const HOME = process.env.DSH_HOME ?? nodePath.join(os.homedir(), ".dsh");
const DSH_EXE = process.env.DSH_EXE ?? "D:/DeepSeek Harness/DeepSeek Harness.exe";
const CLI = "D:/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js";
const PROFILE = "headless";
const LINK = nodePath.join(HOME, "profiles", PROFILE, "node_modules", "dsh-gokifu-compact");

if (!nodeFs.existsSync(DSH_EXE)) {
  console.log(`! 找不到 DSH 可执行文件：${DSH_EXE}（用 DSH_EXE 环境变量指定）—— 跳过`);
  process.exit(0);
}
if (!nodeFs.existsSync(nodePath.join(HOME, "profiles", PROFILE, "cordis.patch.yml"))) {
  console.log(`! 没有 ${PROFILE} profile —— 跳过（这是可选的集成测试）`);
  process.exit(0);
}
// junction 必须指向本仓库（否则测的是旧副本 —— 实测踩过）
const linkedEngine = nodePath.join(LINK, "src", "engine.mjs");
if (!nodeFs.existsSync(linkedEngine)) {
  console.log(`! 先给 ${PROFILE} 建 junction：\n  ${LINK} → ${ROOT}`);
  process.exit(0);
}
const sameFile = (() => {
  try {
    return nodeFs.readFileSync(linkedEngine, "utf8") === nodeFs.readFileSync(nodePath.join(ROOT, "src", "engine.mjs"), "utf8");
  } catch {
    return false;
  }
})();
if (!sameFile) {
  console.log(`! ${LINK} 不是指向 ${ROOT} 的 junction（内容不一致）—— 测的会是旧副本，跳过。`);
  process.exit(0);
}

/* overlay：把阈值压到很小 + 用规则摘要（不依赖外部模型） */
const overlay = nodePath.join(ROOT, "tmp", "headless-fold-check.patch.yml");
nodeFs.mkdirSync(nodePath.dirname(overlay), { recursive: true });
nodeFs.writeFileSync(
  overlay,
  `# 自动生成（test/real-headless-fold.mjs）：用 dsh-gokifu-compact 替换 compaction-basic，阈值压到很小
- id: compaction-basic
  disabled: true
- id: compaction-tool-result-pruner
  disabled: true
- insert:
    - id: chess-context
      name: 'dsh-gokifu-compact/engine'
      config:
        thresholdRatio: 0.002
        headroomTokens: 1000
        retainRatio: 0.001
        growthFloorTokens: 0
        minFoldTokens: 100
        summaryMode: rules
        maxTokens: 1024
        hotLedger: true
        auto: true
`,
  "utf8",
);

const TASK = "用 node 写一个 1+1 的脚本并运行，把结果告诉我";
console.log(`== real-headless-fold：在真实 dsh ${PROFILE} 进程里触发 fold ==`);
console.log(`task: ${TASK}`);
let out;
try {
  out = execFileSync(DSH_EXE, ["--expose-internals", CLI, "--profile", PROFILE, "--patch", overlay, "--json", TASK], {
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 64 * 1024 * 1024,
    cwd: nodePath.join(ROOT, "tmp"), // 别让受试任务把临时脚本写进仓库根
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
} catch (error) {
  console.error(`✗ headless 运行失败：${String(error?.message ?? error).slice(0, 300)}`);
  process.exit(1);
}
let sessionId = "";
for (const line of String(out).split("\n")) {
  if (line.length === 0) continue;
  try {
    const e = JSON.parse(line);
    if (e.type === "session") sessionId = e.sessionId;
  } catch {
    /* 非 JSON 行 */
  }
}
if (!sessionId) {
  console.error("✗ 没从 --json 输出里找到 sessionId");
  process.exit(1);
}
console.log(`session: ${sessionId}`);

/* 读会话日志核对 compaction/* */
const PY = `import sys, zstandard
with open(sys.argv[1],'rb') as f:
    sys.stdout.buffer.write(zstandard.ZstdDecompressor().stream_reader(f, read_across_frames=True).read())`;
const logFile = (() => {
  for (const ws of nodeFs.readdirSync(nodePath.join(HOME, "sessions"), { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const f = nodePath.join(HOME, "sessions", ws.name, sessionId, "session.v4.jsonl.zstd");
    if (nodeFs.existsSync(f)) return f;
  }
  return "";
})();
if (!logFile) {
  console.error(`✗ 找不到会话日志 ${sessionId}`);
  process.exit(1);
}
const raw = execFileSync("python", ["-c", PY, logFile], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8");
let ok = 0;
const bad = [];
let checkpoints = 0;
for (const line of raw.split("\n")) {
  if (line.length === 0) continue;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  if (e.type === "compaction/end") {
    if (e.data?.error) bad.push(String(e.data.error));
    else ok += 1;
  }
  if (e.type === "user/message" && e.data?.source?.kind === "compact-checkpoint") checkpoints += 1;
}
console.log(`compaction：成功 ${ok} / 失败 ${bad.length}${bad.length ? `（${bad[0]}）` : ""}；checkpoint 消息 ${checkpoints} 条`);
if (ok === 0 || bad.length > 0 || checkpoints === 0) {
  console.error("✗ 真实 fold 没有全绿");
  process.exitCode = 1;
} else {
  console.log("== 全部通过（真实进程 / 真实 Session / 真实 compactRegion） ==");
}
