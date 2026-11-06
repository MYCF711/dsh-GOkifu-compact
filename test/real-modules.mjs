/**
 * real-modules.mjs —— 用**真实的** @deepseek-ai 模块验证插件（不是 stub）
 *
 * 做法：从 DSH 的 app.asar 里把 engine 的 peer 依赖闭包提取到 tmp 目录，
 * 把 src 复制过去，然后真的 `import(engine)` 并在真实 cordis Context 下构造。
 *
 * 这一步回答的是「重启后会不会一加载就崩」：
 *   · @deepseek-ai/dsh-compaction-basic 的 BasicCompactionEngine 是否如我们假设那样可继承
 *   · @deepseek-ai/schemastery 是否接受我们的 Config schema 写法
 *   · @deepseek-ai/dsh-llm / dsh-compaction 的导出名是否对得上
 *   · preset 里那份 config 是否能通过 Config 校验
 *
 * 用法：node test/real-modules.mjs
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.join(HERE, "..");
const ASAR = process.env.DSH_ASAR ?? "D:\\DeepSeek Harness\\resources\\app.asar";
const WORK = nodePath.join(ROOT, "..", "..", "tmp", "dsh-gokifu-compact", "modules");

const ROOTS = ["@deepseek-ai/dsh-compaction-basic"];

/* ── ① 读 asar 索引 ── */
function indexAsar(file) {
  const fd = nodeFs.openSync(file, "r");
  const head = Buffer.alloc(16);
  nodeFs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const buf = Buffer.alloc(jsonLen);
  nodeFs.readSync(fd, buf, 0, jsonLen, 16);
  const header = JSON.parse(buf.toString("utf8"));
  const base = 16 + jsonLen;
  const entries = new Map();
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = `${prefix}/${name}`;
      if (child.files) walk(child, p);
      else entries.set(p, { offset: Number(child.offset), size: Number(child.size) });
    }
  };
  walk(header, "");
  return { fd, base, entries };
}

function readEntry(asm, p) {
  const e = asm.entries.get(p);
  if (!e) return null;
  const buf = Buffer.alloc(e.size);
  nodeFs.readSync(asm.fd, buf, 0, e.size, asm.base + e.offset);
  return buf;
}

/* ── ② 依赖闭包 ── */
function closure(asm, roots) {
  const rootPrefix = "/dsh/node_modules/";
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const raw = readEntry(asm, `${rootPrefix}${name}/package.json`);
    if (!raw) continue;
    let pkg;
    try {
      pkg = JSON.parse(raw.toString("utf8"));
    } catch {
      continue;
    }
    for (const key of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dep of Object.keys(pkg[key] ?? {})) {
        if (dep.startsWith("@deepseek-ai/") && !seen.has(dep)) queue.push(dep);
      }
    }
  }
  return [...seen];
}

/* ── ③ 提取 ── */
function extract(asm, deps) {
  const rootPrefix = "/dsh/node_modules/";
  let count = 0;
  for (const dep of deps) {
    const prefix = `${rootPrefix}${dep}/`;
    for (const [p, e] of asm.entries) {
      if (!p.startsWith(prefix)) continue;
      const rel = p.slice(prefix.length);
      const dest = nodePath.join(WORK, "node_modules", ...dep.split("/"), ...rel.split("/"));
      nodeFs.mkdirSync(nodePath.dirname(dest), { recursive: true });
      const buf = Buffer.alloc(e.size);
      nodeFs.readSync(asm.fd, buf, 0, e.size, asm.base + e.offset);
      nodeFs.writeFileSync(dest, buf);
      count += 1;
    }
  }
  return count;
}

/* ── ④ 跑 ── */
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`);
  }
};

console.log("== real-modules 验证（真实 @deepseek-ai 模块，非 stub）==");

if (!nodeFs.existsSync(ASAR)) {
  console.log(`! 找不到 asar：${ASAR}（用 DSH_ASAR 环境变量指定）— 跳过`);
  process.exit(0);
}

const asm = indexAsar(ASAR);
const deps = closure(asm, ROOTS);
console.log(`  依赖闭包：${deps.length} 个包`);
nodeFs.rmSync(nodePath.join(WORK, "node_modules"), { recursive: true, force: true });
nodeFs.rmSync(nodePath.join(WORK, "src"), { recursive: true, force: true });
const n = extract(asm, deps);
console.log(`  已提取 ${n} 个文件 → ${WORK}`);
nodeFs.writeFileSync(nodePath.join(WORK, "package.json"), JSON.stringify({ name: "dsh-real-modules-probe", private: true, type: "module" }, null, 2));
nodeFs.cpSync(nodePath.join(ROOT, "src"), nodePath.join(WORK, "src"), { recursive: true });

const engineUrl = pathToFileURL(nodePath.join(WORK, "src", "engine.mjs")).href;
let mod;
try {
  mod = await import(engineUrl);
  check("import src/engine.mjs（真实依赖）", () => {
    if (typeof mod.default !== "function") throw new Error("默认导出不是 class");
    if (mod.name !== "dsh-gokifu-compact") throw new Error(`name=${mod.name}`);
    if (!mod.Config) throw new Error("没有导出 Config");
  });
} catch (error) {
  console.log(`  ✗ import 失败：${error?.message ?? error}`);
  process.exit(1);
}

/* 真 cordis Context 下构造 */
// 从提取目录解析（测试文件自身不在那个 node_modules 树里）
const workRequire = createRequire(nodePath.join(WORK, "package.json"));
const cordisEntry = workRequire.resolve("@deepseek-ai/cordis");
const { Context } = await import(pathToFileURL(cordisEntry).href);
check("在真实 cordis Context 下构造（继承链、config 解析、listener 注册都不抛错）", () => {
  const ctx = new Context();
  ctx.logger = { info() {}, warn() {}, debug() {}, error() {} };
  ctx.llm = { async resolveModelInfo() { return { context: { contextWindow: 200000 }, defaultMaxTokens: 4096 }; } };
  ctx.tokenMeter = { measure() { return { totalTokens: 1000, surfaceTokens: 1000, nodes: [] }; }, estimateMessage() { return 100; } };
  ctx.sessions = { async flush() {} };
  const engine = new mod.default(ctx, { auto: false, graphDir: nodePath.join(WORK, "graphs") });
  if (!engine) throw new Error("构造返回空");
  // 注意：cordis 的服务可见性依赖 plugin fiber（ctx.plugin 的 scope），
  // 这里直接 new 只是验证「构造链不抛错 + 继承自官方类 + config 被接受」。
  // 真实的服务注册由宿主 Loader 完成（见 docs/重启后验证清单.md 第②条）。
  if (typeof engine.compactIfNeeded !== "function") throw new Error("没有继承到 compactIfNeeded");
  if (typeof engine.compactRegion !== "function") throw new Error("没有继承到 compactRegion");
  if (typeof engine.compactNow !== "function") throw new Error("没有继承到 compactNow");
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(engine));
  if (!proto || proto.constructor.name !== "BasicCompactionEngine") {
    throw new Error(`继承链不对：${proto?.constructor?.name}`);
  }
});

/* preset 里那份 config 能否通过 schema */
check("preset 里的 config 能通过 Config schema", () => {
  const presetConfig = {
    thresholdRatio: 0.45,
    headroomTokens: 65536,
    retainRatio: 0.16,
    growthFloorTokens: 40000,
    minFoldTokens: 8000,
    summaryMode: "hybrid",
    maxTokens: 2048,
    hotLedger: true,
    hotLedgerMaxTokens: 500,
    transposition: true,
    tier2After: 8,
  };
  const schema = mod.Config;
  if (typeof schema !== "function") throw new Error("Config 不是可调用的 schema");
  const parsed = schema(presetConfig);
  if (Math.abs((parsed.thresholdRatio ?? 0) - 0.45) > 1e-9) throw new Error(`thresholdRatio 解析成 ${parsed.thresholdRatio}`);
  if (parsed.summaryMode !== "hybrid") throw new Error(`summaryMode 解析成 ${parsed.summaryMode}`);
});

/* 默认值形态（不传任何 config） */
check("空 config 也能构造（全部走默认值）", () => {
  const ctx = new Context();
  ctx.logger = { info() {}, warn() {}, debug() {}, error() {} };
  ctx.llm = {};
  ctx.tokenMeter = {};
  ctx.sessions = {};
  new mod.default(ctx, { auto: false, graphDir: nodePath.join(WORK, "graphs2") });
});

console.log(failures === 0 ? "\n== 全部通过 ==" : `\n== ${failures} 项失败 ==`);
if (failures > 0) process.exitCode = 1;
