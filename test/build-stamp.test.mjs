/**
 * build-stamp.test.mjs —— 「运行实例版本」落盘标记的回归（2026-11-02，C34）
 *
 * 为什么：本机踩过两次「磁盘代码已更新、跑着的进程还是旧代码」的陷阱（C26 事故、
 * C30/C31 之后 doctor 的未采集）。磁盘文件与 package.json 都回答不了「现在跑的是哪版」，
 * 所以插件在启动时写 `<chess-context>/build.json`，doctor 用它比对。
 *
 * 这里只测纯函数与写盘（临时目录），不碰真实 home。
 */

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { buildStampPath, compareBuildId, compareBuildStamp, readBuildStamp, repoBuildId, repoVersion, writeBuildStamp } from "../src/rooms/build-stamp.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

export const tests = {};

tests["S-1 写戳 → 读回：版本/启动时间/pid 都在；路径是 <dir>/build.json"] = (t) => {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-stamp-"));
  try {
    const result = writeBuildStamp({ dir, version: "1.2.3", now: 1762000000000, pid: 4242 });
    t.eq(result.ok, true, `写戳应成功：${JSON.stringify(result)}`);
    t.eq(result.path, buildStampPath(dir), "路径必须是 <dir>/build.json");
    const stamp = readBuildStamp(dir);
    t.eq(stamp.version, "1.2.3", "版本必须写对");
    t.eq(stamp.startedAt, 1762000000000, "启动时间必须写对");
    t.eq(stamp.pid, 4242, "pid 必须写对");
    t.eq(stamp.schema, "gokifu/build-stamp/v1", "schema 必须写明");
    // 临时文件不许残留
    const leftovers = nodeFs.readdirSync(dir).filter((name) => name.includes("tmp-"));
    t.eq(leftovers, [], `不许留下临时文件：${leftovers.join(",")}`);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
};

tests["S-2 compare：一致 ok / 落后 stale（带运行版本）/ 无戳 missing"] = (t) => {
  const stamp = { version: "1.17.1", startedAt: 1 };
  t.eq(compareBuildStamp(stamp, "1.17.1").state, "ok", "同版本 ok");
  const stale = compareBuildStamp(stamp, "1.18.0");
  t.eq(stale.state, "stale", "磁盘更新 ⇒ stale");
  t.eq(stale.running, "1.17.1", "stale 要报运行版本");
  t.eq(stale.disk, "1.18.0", "stale 要报磁盘版本");
  t.eq(compareBuildStamp(null, "1.18.0").state, "missing", "没有戳 ⇒ missing");
  t.eq(compareBuildStamp(null, "1.18.0").disk, "1.18.0", "missing 也要带磁盘版本（文案用）");
};

tests["S-3 写戳失败静默：dir 非法/不存在父路径都返回 ok:false，不抛"] = (t) => {
  const r1 = writeBuildStamp({ dir: "" });
  t.eq(r1.ok, false, "空 dir ⇒ 失败");
  t.eq(r1.error, "no-dir", "原因写清");
  // 文件占位导致 mkdir/写入失败 —— 不许抛
  const file = nodePath.join(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-stamp-bad-")), "blocked");
  nodeFs.writeFileSync(file, "x");
  try {
    const r2 = writeBuildStamp({ dir: file });
    t.eq(r2.ok, false, `dir 是文件 ⇒ 失败但不抛：${JSON.stringify(r2)}`);
  } finally {
    nodeFs.rmSync(nodePath.dirname(file), { recursive: true, force: true });
  }
};

tests["S-5 相对路径拒绝：不许把 build.json 落到工作目录（实机踩过）"] = (t) => {
  const r = writeBuildStamp({ dir: "relative-chess-context" });
  t.eq(r.ok, false, "相对路径 ⇒ 失败");
  t.eq(r.error, "not-absolute", "原因写清");
  t.eq(nodeFs.existsSync(nodePath.join(process.cwd(), "build.json")), false, "工作目录不许出现 build.json");
};

tests["S-4 repoVersion 与仓库 package.json 一致（防止戳里的版本漂移）"] = (t) => {
  const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(REPO, "package.json"), "utf8"));
  t.eq(repoVersion(), pkg.version, "repoVersion 必须等于 package.json 的 version");
};

const NL = String.fromCharCode(10);

tests["S-6 repoBuildId：12 位十六进制且稳定；改一个源文件内容就变（C53）"] = (t) => {
  const id = repoBuildId();
  t.eq(/^[0-9a-f]{12}$/.test(id), true, `必须是 12 位十六进制，实际 ${id}`);
  t.eq(repoBuildId(), id, "同一棵代码树必须稳定");
  // 用临时树验证「内容变了 id 就变」
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gokifu-buildid-"));
  try {
    nodeFs.mkdirSync(nodePath.join(root, "src"));
    nodeFs.writeFileSync(nodePath.join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
    nodeFs.writeFileSync(nodePath.join(root, "src", "a.mjs"), "export const a = 1;" + NL);
    const before = repoBuildId(root);
    nodeFs.writeFileSync(nodePath.join(root, "src", "a.mjs"), "export const a = 2;" + NL);
    const after = repoBuildId(root);
    t.eq(/^[0-9a-f]{12}$/.test(before), true, "临时树也要给出 12 位哈希");
    t.eq(before === after, false, "源文件内容变了，构建标识必须变");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["S-7 compareBuildId：ok / stale / missing 三态；stale 必须报两个 id"] = (t) => {
  t.eq(compareBuildId({ buildId: "aaaa1111bbbb" }, "aaaa1111bbbb").state, "ok", "一致 ⇒ ok");
  const stale = compareBuildId({ buildId: "aaaa1111bbbb" }, "cccc2222dddd");
  t.eq(stale.state, "stale", "不一致 ⇒ stale");
  t.eq(stale.running, "aaaa1111bbbb", "stale 报运行实例 id");
  t.eq(stale.disk, "cccc2222dddd", "stale 报磁盘 id");
  t.eq(compareBuildId(null, "cccc2222dddd").state, "missing", "没有戳 ⇒ missing");
};
