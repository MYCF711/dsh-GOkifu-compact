/**
 * check-maintenance.test.mjs —— 维护检查的回归（2026-10-31 终审的 porcelain 假红）
 *
 * 事故：`git()` 对 `git status --porcelain` 的整段 stdout `.trim()`，吃掉**首行**
 * 状态码 X 位的空格（` M evidence/bench-2000.json`）；随后固定列 `slice(3)` 多切
 * 一个字符 ⇒ 路径变成 `vidence/bench-2000.json` ⇒ `evidence/` 排除失效 ⇒
 * 跑过 bench 之后 check 报 8/1（实际 9/0）。
 *
 * 本文件用**真 git 仓库夹具**钉住三件事：
 *   · 脏 `evidence/*.json` 必须仍是 9/0；
 *   · 脏 `src/*` 必须仍红（不能把「代码变了没 bump」一起放过）；
 *   · `git checkout -- evidence/` 之后回到 9/0。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pendingTagCommands } from "../scripts/release-lib.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.resolve(HERE, "..");
const CHECK = nodePath.join(REPO, "scripts", "check-maintenance.mjs");

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr ?? r.stdout}`);
  return r.stdout ?? "";
}

/** 造一个「九项全过」的临时仓库：tag=version、CHANGELOG 有该版本、release.mjs 打 annotated tag、remote 合法。 */
function makeFixture() {
  // realpath：Windows 的 8.3 短名（<LOCAL_USER~1>）会让 git 的 --show-toplevel 与 cwd 比不相等。
  const root = nodeFs.realpathSync.native(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "gokifu-check-")));
  nodeFs.mkdirSync(nodePath.join(root, "src"), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(root, "evidence"), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(root, "scripts"), { recursive: true });
  nodeFs.writeFileSync(nodePath.join(root, "package.json"), `${JSON.stringify({ name: "check-fixture", version: "1.0.0" }, null, 2)}\n`, "utf8");
  nodeFs.writeFileSync(nodePath.join(root, "CHANGELOG.md"), "# 1.0.0\n\n- 初始版本\n", "utf8");
  nodeFs.writeFileSync(nodePath.join(root, "src", "index.mjs"), "export const x = 1;\n", "utf8");
  nodeFs.writeFileSync(nodePath.join(root, "evidence", "bench-2000.json"), '{"tokens":1}\n', "utf8");
  nodeFs.writeFileSync(nodePath.join(root, "scripts", "release.mjs"), '// 发布时：git tag -a <tag> -m "release <tag>"\nexport const x = 1;\n', "utf8");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.com"]);
  git(root, ["config", "user.name", "fixture"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  git(root, ["tag", "-a", "v1.0.0", "-m", "release v1.0.0"]);
  git(root, ["remote", "add", "origin", "git@github.com:owner/repo.git"]);
  return root;
}

function runCheck(root) {
  const r = spawnSync(process.execPath, [CHECK, root], { cwd: REPO, encoding: "utf8", timeout: 120000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ★ C324 起多了一行「待补的 tag」（干净夹具上它是 pass）⇒ 通过数 9 → 10
const SUMMARY_OK = "通过 10 · 警告 0 · 失败 0";

export const tests = {};

tests["check-maintenance 基线：干净夹具必须 9/0"] = (t) => {
  const root = makeFixture();
  try {
    const r = runCheck(root);
    t.eq(r.status, 0, `干净夹具应 exit 0，实际 ${r.status}\n${r.out}`);
    t.includes(r.out, SUMMARY_OK, "基线必须是 10 通过 / 0 警告 / 0 失败（C324 多一行待补 tag）");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["check-maintenance 回归：脏 evidence/bench-2000.json 必须仍是 9/0（porcelain 首行空格）"] = (t) => {
  const root = makeFixture();
  try {
    const file = nodePath.join(root, "evidence", "bench-2000.json");
    nodeFs.writeFileSync(file, '{"tokens":2}\n', "utf8");
    // 先证明夹具真的命中了事故形态：porcelain **首行**以 " M " 开头（X 位是空格）。
    const raw = git(root, ["status", "--porcelain", "-z"]);
    t.eq(raw.slice(0, 3), " M ", `首行必须是「空格+M+空格」的状态前缀，实际 ${JSON.stringify(raw.slice(0, 3))}`);
    t.eq(raw.split("\0")[0].slice(3), "evidence/bench-2000.json", "porcelain -z 的首条路径必须完整");
    const r = runCheck(root);
    t.eq(r.status, 0, `脏 evidence/ 不得判红（旧实现会 exit 1），实际 ${r.status}\n${r.out}`);
    t.includes(r.out, SUMMARY_OK, "脏 evidence/ 时仍应是 10/0");
    t.ok(!r.out.includes("vidence/"), "输出里不许出现被多切一字符的 `vidence/`");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["check-maintenance 回归：脏 src/ 仍必须红（不能为了 evidence 放过代码变更）"] = (t) => {
  const root = makeFixture();
  try {
    nodeFs.writeFileSync(nodePath.join(root, "src", "index.mjs"), "export const x = 2;\n", "utf8");
    const r = runCheck(root);
    t.eq(r.status, 1, `脏 src/ 必须 exit 1，实际 ${r.status}\n${r.out}`);
    t.includes(r.out, "失败 1", "必须报 1 个失败");
    t.includes(r.out, "自上次 tag 以来改了代码", "失败项必须是「代码变了但版本没变」这条");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

tests["check-maintenance 回归：git checkout -- evidence/ 之后回到 9/0"] = (t) => {
  const root = makeFixture();
  try {
    nodeFs.writeFileSync(nodePath.join(root, "evidence", "bench-2000.json"), '{"tokens":3}\n', "utf8");
    t.eq(runCheck(root).status, 0, "先确认脏 evidence 不红");
    git(root, ["checkout", "--", "evidence/"]);
    t.eq(git(root, ["status", "--porcelain"]).trim(), "", "checkout 后工作树应干净");
    const r = runCheck(root);
    t.eq(r.status, 0, `checkout 后必须 9/0，实际 ${r.status}\n${r.out}`);
    t.includes(r.out, SUMMARY_OK);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
};

// ── C324：待补 tag 的命令必须能照抄 ──────────────────────────────────
// 发版是唯一必须交给主人拍板的事（C273）。既然把命令交出去，就必须保证命令本身是对的。

tests["C324 pendingTagCommands：没 tag 的才出命令，且命令里带 commit 与 push"] = (t) => {
  const todo = pendingTagCommands({
    versions: ["1.17.4", "1.17.5", "1.17.6"],
    tags: ["v1.17.5"],
    lookup: (v) => (v === "1.17.6" ? "abcdef1234567890" : "ffff00001111"),
  });
  t.eq(todo.map((x) => x.tag), ["v1.17.4", "v1.17.6"], "已有 tag 的版本不许再出命令");
  const v6 = todo.find((x) => x.tag === "v1.17.6");
  t.includes(v6.command, "git tag -a v1.17.6 abcdef123456", "必须是 annotated tag + 短 sha");
  t.includes(v6.command, "git push origin v1.17.6", "打完要推，否则远端还是没有");
};

tests["C324 找不到对应提交时，要给一句能看懂的说明而不是半条坏命令"] = (t) => {
  const todo = pendingTagCommands({ versions: ["9.9.9"], tags: [], lookup: () => null });
  t.eq(todo.length, 1, "没 tag 就要列出来");
  t.eq(todo[0].commit, null, "commit 必须是 null");
  t.includes(todo[0].command, "找不到", "要说明找不到，而不是给出会失败的 git 命令");
  t.eq(todo[0].command.startsWith("git tag"), false, "不许给出假的 git 命令");
};
