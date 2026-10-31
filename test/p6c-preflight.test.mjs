/**
 * p6c-preflight.test.mjs —— 停窗预检脚本的回归（只读、可拒绝）
 *
 * 钉住三件事：
 *   · 夹具就绪时 exit 0，JSON 里会话数 / graph.json-only 哈希都在；
 *   · 端口可连或进程存在时 **exit 1**（拒绝 apply 预检）；
 *   · 脚本**只读**：跑前跑后夹具整树 sha256 不变。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import nodeNet from "node:net";
import nodeCrypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.resolve(HERE, "..");
const SCRIPT = nodePath.join(REPO, "scripts", "p6c-preflight.mjs");

function sha256(buf) {
  return nodeCrypto.createHash("sha256").update(buf).digest("hex");
}

/** 夹具：<tmp>/chess-context/sessions/<sid>/{graph.json,graph.json.delta.jsonl?} */
function makeFixture() {
  const root = nodeFs.realpathSync.native(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "gokifu-preflight-")));
  const sessions = nodePath.join(root, "chess-context", "sessions");
  for (const id of ["sess-a", "sess-b"]) {
    const dir = nodePath.join(sessions, id);
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, "graph.json"), JSON.stringify({ id, nodes: {}, edges: {} }), "utf8");
  }
  nodeFs.writeFileSync(nodePath.join(sessions, "sess-a", "graph.json.delta.jsonl"), "", "utf8");
  return { root, sessions };
}

/** 整树 sha256（只读快照，用来证明脚本没写文件）。 */
function snapshot(root) {
  const rows = [];
  const walk = (dir) => {
    for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
      const p = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else rows.push(`${nodePath.relative(root, p)} ${sha256(nodeFs.readFileSync(p))}`);
    }
  };
  walk(root);
  return rows.sort().join("\n");
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: "utf8", timeout: 60000, windowsHide: true });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  let json = null;
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      json = JSON.parse(out.slice(start, end + 1));
    } catch {
      json = null;
    }
  }
  return { status: r.status, out, json };
}

function listenEphemeral() {
  return new Promise((resolve, reject) => {
    const server = nodeNet.createServer((sock) => sock.destroy());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

export const tests = {};

tests["p6c-preflight 夹具就绪：--port=0 --proc-name=（跳过外部探测）时 exit 0，且 JSON 带会话数与 graph 哈希"] = (t) => {
  const { root, sessions } = makeFixture();
  try {
    const r = run([`--root=${sessions}`, "--port=0", "--proc-name=", "--json"]);
    t.eq(r.status, 0, `夹具应 exit 0，实际 ${r.status}\n${r.out}`);
    t.ok(r.json !== null, "必须输出 JSON");
    t.eq(r.json.ready, true, "ready 必须为 true");
    t.eq(r.json.sessions.count, 2, "会话数必须 2");
    t.eq(r.json.sessions.deltaFiles, 1, "delta 文件数必须 1");
    t.ok(typeof r.json.sessions.combined === "string" && r.json.sessions.combined.length === 64, "graph.json-only 汇总哈希必须是 sha256");
    t.eq(r.json.runtime.running, false, "跳过探测时 running 必须 false");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["p6c-preflight 拒绝：端口可连接时必须 exit 1（不得放行 apply）"] = (t) => {
  const { root, sessions } = makeFixture();
  let server = null;
  try {
    return (async () => {
      server = await listenEphemeral();
      const port = server.address().port;
      const r = run([`--root=${sessions}`, `--port=${port}`, "--proc-name=", "--json"]);
      t.eq(r.status, 1, `端口可连时必须 exit 1，实际 ${r.status}`);
      t.eq(r.json.ready, false, "ready 必须 false");
      t.eq(r.json.runtime.portOpen, true, "portOpen 必须 true");
      t.includes(r.json.verdict, "拒绝 apply 预检", "结论必须明确拒绝");
      t.includes(r.json.verdict, String(port), "结论必须点名端口");
    })().finally(() => {
      if (server) server.close();
    });
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["p6c-preflight 拒绝：检测到同名进程时必须 exit 1"] = (t) => {
  const { root, sessions } = makeFixture();
  try {
    // 用当前跑的 node 进程当「DSH 进程」的替身：tasklist 一定找得到它。
    const procName = nodePath.basename(process.execPath);
    const r = run([`--root=${sessions}`, "--port=0", `--proc-name=${procName}`, "--json"]);
    t.eq(r.status, 1, `进程存在时必须 exit 1，实际 ${r.status}`);
    t.eq(r.json.ready, false, "ready 必须 false");
    t.ok(r.json.runtime.procCount > 0, `进程数必须 >0，实际 ${r.json.runtime.procCount}`);
    t.includes(r.json.verdict, "拒绝 apply 预检", "结论必须明确拒绝");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["p6c-preflight 只读：跑前跑后夹具整树 sha256 不变"] = (t) => {
  const { root, sessions } = makeFixture();
  try {
    const before = snapshot(root);
    run([`--root=${sessions}`, "--port=0", "--proc-name=", "--json"]);
    const after = snapshot(root);
    t.eq(after, before, "预检不得写任何文件（整树 sha256 必须相同）");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["p6c-preflight 计数：进程名不存在时 procCount 必须是 0（tasklist 的本地化提示行不得被算成进程）"] = (t) => {
  const { root, sessions } = makeFixture();
  try {
    // 墓碑测试（2026-10-31 事故）：中文 Windows 上 `tasklist /FI IMAGENAME eq <不存在>` 会打印
    // 「信息: 没有运行的任务匹配指定标准。」，默认表格格式 + utf8 解码后首字符是 U+FFFD，
    // 旧逻辑（过滤空行 + 不以 `INFO:` 开头）会把它算成 **1 个进程** ⇒ running=true ⇒ 预检永远拒绝，
    // P6-C 停窗流程在「DSH 已完全退出」的情况下仍然报「退出码 1」。
    // 这条用例在旧实现上必红（procCount=1、exit 1），在 /FO CSV 实现上必绿。
    const r = run([`--root=${sessions}`, "--port=0", "--proc-name=definitely-not-a-real-process-xyz.exe", "--json"]);
    t.ok(r.json !== null, "必须输出 JSON");
    t.eq(r.json.runtime.procCount, 0, `无匹配进程时 procCount 必须为 0，实际 ${r.json.runtime.procCount}`);
    t.eq(r.json.runtime.procApplicable, true, "Windows 上 procApplicable 必须为 true");
    t.eq(r.json.runtime.running, false, "无端口、无进程时 running 必须 false");
    t.eq(r.json.ready, true, "ready 必须 true");
    t.eq(r.status, 0, `夹具就绪且 DSH 未运行时应 exit 0，实际 ${r.status}\n${r.out}`);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};
