/**
 * restart-checklist.test.mjs —— 重启清单必须现算、可执行、失败真红。
 * 真 git 夹具；不访问 live home、不重启、不调模型。
 */
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import {
  collectCommits,
  createChecklist,
  evaluateCommandResult,
  inspectReadOnlyCli,
  main,
  parseManifest,
  renderChecklist,
  resolveUserPath,
  verifyChecklist,
} from "../scripts/restart-checklist.mjs";
import { repoBuildId } from "../src/rooms/build-stamp.mjs";

export const tests = {};

const BEFORE = "2026-01-01T00:00:00.000Z";
const MID = "2026-01-02T00:00:00.000Z";
const RUNTIME_ONE = "2026-01-03T00:00:00.000Z";
const SCRIPT_ONLY = "2026-01-04T00:00:00.000Z";
const RUNTIME_TWO = "2026-01-05T00:00:00.000Z";
const GIT_ENV = {
  GIT_AUTHOR_NAME: "restart-fixture",
  GIT_AUTHOR_EMAIL: "restart-fixture@example.com",
  GIT_COMMITTER_NAME: "restart-fixture",
  GIT_COMMITTER_EMAIL: "restart-fixture@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd, args, env = {}) {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function write(root, rel, text) {
  const file = nodePath.join(root, rel);
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, text, "utf8");
}

function commit(root, subject, at) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", subject], { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
  return git(root, ["rev-parse", "HEAD"]).trim();
}

function stamp(home, buildId, startedAt = Date.parse(MID)) {
  write(home, "chess-context/build.json", JSON.stringify({ schema: "gokifu/build-stamp/v1", buildId, startedAt, pid: 12345 }));
}

function makeFixture() {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "restart-checklist-repo-"));
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "restart-checklist-home-"));
  git(root, ["init", "-q", "-b", "main"]);
  write(root, "package.json", JSON.stringify({ name: "restart-fixture", version: "1.0.0", type: "module" }));
  write(root, "test/run.mjs", "// 存在即可；生成器不会替验收提前跑它。\n");
  write(root, "src/engine.mjs", "export const version = 1;\n");
  commit(root, "启动前的旧运行时提交", BEFORE);
  stamp(home, "old-build");

  write(root, "src/engine.mjs", "export const version = 2;\n");
  write(root, "scripts/sample-audit.mjs", [
    "const json = process.argv.includes('--json');",
    "if (process.argv[1]) console.log(json ? JSON.stringify({ ok: true }) : 'audit');",
    "",
  ].join("\n"));
  write(root, "test/sample.test.mjs", "export const tests = { sample(t) { t.eq(2, 2); } };\n");
  const first = commit(root, "运行提交一：带专用测试与只读审计", RUNTIME_ONE);

  write(root, "scripts/diagnostic-only.mjs", "console.log(process.argv.length);\n");
  const skipped = commit(root, "仅诊断脚本：新 Node 进程立即可用", SCRIPT_ONLY);

  write(root, "src/ui.mjs", "export const ui = true;\n");
  write(root, "scripts/probe.mjs", [
    "export function main(argv = process.argv.slice(2)) {",
    "  console.log(argv.includes('--json') ? JSON.stringify({ ok: true }) : 'probe');",
    "  return 0;",
    "}",
    "if (process.argv[1]) process.exitCode = main();",
    "",
  ].join("\n"));
  write(root, "scripts/unsafe-audit.mjs", [
    "import fs from 'node:fs';",
    "if (process.argv[1]) fs.writeFileSync('must-not-run', 'x');",
    "",
  ].join("\n"));
  const second = commit(root, "运行提交二：无专用测试，危险脚本不得裸跑", RUNTIME_TWO);
  return { root, home, first, skipped, second };
}

function cleanup(fixture) {
  for (const dir of [fixture?.root, fixture?.home]) {
    if (typeof dir !== "string" || dir === "") continue;
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
}

function staleReport(fixture) {
  return createChecklist({ root: fixture.root, home: fixture.home, diskBuildId: "new-build" });
}

tests["RCL-01 真 git 现算：只列 startedAt 后运行时提交，命令来自同提交测试与只读 CLI"] = (t) => {
  const fixture = makeFixture();
  try {
    const report = staleReport(fixture);
    t.eq(report.state, "stale");
    t.eq(report.commits.map((c) => c.hash), [fixture.first, fixture.second], "启动前提交不列，脚本-only 不硬凑");
    t.eq(report.skippedCommits.map((c) => c.hash), [fixture.skipped]);
    t.eq(report.commits[0].runtimeFiles, ["src/engine.mjs"]);
    t.eq(report.commits[0].commands.map((c) => c.command), [
      "node test/run.mjs sample",
      "node scripts/sample-audit.mjs --json",
    ]);
    t.eq(report.commits[1].commands.map((c) => c.command), [
      "node scripts/probe.mjs --json",
      "node test/run.mjs",
    ]);
    t.ok(!report.commands.some((c) => c.command.includes("unsafe-audit")), "写盘脚本绝不生成裸跑命令");
    t.includes(report.commits[1].manual, "本提交没有专用测试");
    t.includes(report.commits[1].manual, "src/ui.mjs");
    const text = renderChecklist(report);
    t.includes(text, "待生效修复清单（2 条）");
    t.includes(text, "node scripts/restart-checklist.mjs --verify /tmp/restart-checklist.md");
    t.includes(text, "重启后：buildId 必须相等");
    t.ok(!text.includes("fixture.first"), "输出不能写死夹具变量名或固定修复表");
  } finally {
    cleanup(fixture);
  }
};

tests["RCL-02 build 已一致：明确无待生效修复，且完全不读 git"] = (t) => {
  const fixture = makeFixture();
  try {
    const disk = repoBuildId(fixture.root);
    stamp(fixture.home, disk);
    const report = createChecklist({
      root: fixture.root,
      home: fixture.home,
      diskBuildId: disk,
      git: () => { throw new Error("current 分支不许调用 git"); },
    });
    t.eq(report.state, "current");
    t.eq(report.commits, []);
    const text = renderChecklist(report);
    t.includes(text, "当前无待生效修复");
    t.notIncludes(text, "待生效修复清单（1 条）");
    const code = main([`--root=${fixture.root}`, `--home=${fixture.home}`], { log: () => {} });
    t.eq(code, 0, "build 一致退出码必须为 0");
  } finally {
    cleanup(fixture);
  }
};

tests["RCL-03 缺 build.json / git 失败是 unknown，不许假绿"] = (t) => {
  const fixture = makeFixture();
  try {
    const missingHome = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "restart-checklist-missing-"));
    try {
      const missing = createChecklist({ root: fixture.root, home: missingHome, diskBuildId: "new-build" });
      t.eq(missing.state, "unknown");
      t.includes(renderChecklist(missing), "无法判断");
      t.notIncludes(renderChecklist(missing), "## 当前无待生效修复");
    } finally {
      nodeFs.rmSync(missingHome, { recursive: true, force: true });
    }
    const failedGit = createChecklist({
      root: fixture.root,
      home: fixture.home,
      diskBuildId: "new-build",
      git: () => { throw new Error("fixture git failure"); },
    });
    t.eq(failedGit.state, "unknown");
    t.includes(failedGit.reason, "fixture git failure");
    t.notIncludes(renderChecklist(failedGit), "## 当前无待生效修复");
  } finally {
    cleanup(fixture);
  }
};

tests["RCL-04 build 不同但只有 scripts 提交：仍报不一致，不能硬凑也不能说无待生效"] = (t) => {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "restart-checklist-scripts-"));
  const home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "restart-checklist-scripts-home-"));
  try {
    git(root, ["init", "-q", "-b", "main"]);
    write(root, "scripts/old.mjs", "console.log('old');\n");
    commit(root, "before", BEFORE);
    stamp(home, "old-build");
    write(root, "scripts/new.mjs", "console.log('new');\n");
    commit(root, "scripts only", RUNTIME_ONE);
    const report = createChecklist({ root, home, diskBuildId: "new-build" });
    t.eq(report.state, "stale");
    t.eq(report.commits.length, 0);
    t.eq(report.skippedCommits.length, 1);
    const text = renderChecklist(report);
    t.includes(text, "buildId 不一致，但 startedAt 之后没有找到运行时提交");
    t.notIncludes(text, "## 当前无待生效修复");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
    nodeFs.rmSync(home, { recursive: true, force: true });
  }
};

tests["RCL-05 --out 写入人读清单 + 机读 manifest；pending 退出码为 1"] = (t) => {
  const fixture = makeFixture();
  try {
    const out = nodePath.join(fixture.home, "checklist.md");
    let output = "";
    const code = main([`--root=${fixture.root}`, `--home=${fixture.home}`, "--out", out], { log: (line) => { output += `${line}\n`; } });
    t.eq(code, 1, "有待生效修复必须真红");
    const text = nodeFs.readFileSync(out, "utf8");
    t.includes(text, "# 重启验收清单");
    const manifest = parseManifest(text);
    t.eq(manifest.schema, "gokifu/restart-checklist/v1");
    t.eq(manifest.commits.length, 2);
    t.eq(manifest.commands.length, 4, "两条提交的去重命令总数");
    t.ok(manifest.commands.every((command) => Array.isArray(command.args)));
    t.includes(output, "已写入");
  } finally {
    cleanup(fixture);
  }
};

tests["RCL-06 verify 成功分支：build 一致后逐条跑，test/JSON 都校验内容而非只看退出码"] = (t) => {
  const fixture = makeFixture();
  try {
    const before = staleReport(fixture);
    const manifest = parseManifest(renderChecklist(before, { includeManifest: true }));
    const disk = repoBuildId(fixture.root);
    manifest.diskBuildId = disk;
    stamp(fixture.home, disk);
    const calls = [];
    const logs = [];
    const result = verifyChecklist({
      manifest,
      root: fixture.root,
      home: fixture.home,
      diskBuildId: disk,
      runCommand: (command) => {
        calls.push(command.command);
        if (command.kind === "test") return { status: 0, stdout: "== 3 passed, 0 skipped, 0 failed ==\n", stderr: "" };
        if (command.kind === "json") return { status: 0, stdout: '{"ok":true}\n', stderr: "" };
        return { status: 0, stdout: "audit\n", stderr: "" };
      },
      log: (line) => logs.push(line),
    });
    t.eq(result.code, 0);
    t.eq(result.passed, manifest.commands.length);
    t.eq(calls, manifest.commands.map((command) => command.command), "命令顺序与清单一致且每条都真调用");
    t.includes(logs.at(-1), `== 重启验收通过：buildId 一致，${manifest.commands.length}/${manifest.commands.length} 条验证命令通过 ==`);
  } finally {
    cleanup(fixture);
  }
};

tests["RCL-07 verify 失败真红：build 不同不跑命令；测试失败/坏 JSON 也算失败"] = (t) => {
  const fixture = makeFixture();
  try {
    const before = staleReport(fixture);
    const manifest = parseManifest(renderChecklist(before, { includeManifest: true }));
    let calls = 0;
    const stale = verifyChecklist({
      manifest,
      root: fixture.root,
      home: fixture.home,
      diskBuildId: "new-build",
      runCommand: () => { calls += 1; return { status: 0, stdout: "", stderr: "" }; },
      log: () => {},
    });
    t.eq(stale.code, 1);
    t.eq(calls, 0, "build 不一致时不许拿命令输出冒充重启验收");

    const disk = repoBuildId(fixture.root);
    manifest.diskBuildId = disk;
    stamp(fixture.home, disk);
    const failedTest = verifyChecklist({
      manifest,
      root: fixture.root,
      home: fixture.home,
      diskBuildId: disk,
      runCommand: () => ({ status: 0, stdout: "== 0 passed, 0 skipped, 1 failed ==\n", stderr: "" }),
      log: () => {},
    });
    t.eq(failedTest.code, 1, "退出码 0 但 failed != 0 仍必须红");
    t.eq(evaluateCommandResult({ kind: "json" }, { status: 0, stdout: "not json" }).ok, false);
    t.eq(evaluateCommandResult({ kind: "plain" }, { status: 0, stdout: "ReferenceError: x" }).ok, false);
    t.eq(evaluateCommandResult({ kind: "json" }, { status: 0, stdout: '{"ok":true}' }).ok, true);
  } finally {
    cleanup(fixture);
  }
};

tests["RCL-08 路径/参数与静态安全边界"] = (t) => {
  const converted = resolveUserPath("/tmp/a.md", { platform: "win32", convert: (value) => value === "/tmp/a.md" ? "C:\\Temp\\a.md" : "bad" });
  t.eq(converted, "C:\\Temp\\a.md");
  t.eq(inspectReadOnlyCli("if (process.argv[1]) console.log('ok')").safe, true);
  t.eq(inspectReadOnlyCli("if (process.argv[1]) fetch('http://x')").safe, false);
  t.eq(inspectReadOnlyCli("if (process.argv[1]) process.exit(0)").safe, false);
  t.eq(inspectReadOnlyCli("if (process.argv[1]) runOfflineFold({ events })").safe, false, "无样本边界的全量重放不得自动生成裸跑命令");
  t.eq(main(["--out"], { log: () => {} }), 2, "--out 缺路径必须参数红");
  t.eq(main(["--unknown"], { log: () => {} }), 2);
};

tests["RCL-09 collectCommits 保留完整标题、时间和逐提交文件，供影响面使用"] = (t) => {
  const fixture = makeFixture();
  try {
    const got = collectCommits({ root: fixture.root, sinceMs: Date.parse(MID) });
    t.eq(got.state, "ok");
    t.eq(got.commits.length, 3);
    t.eq(got.commits[0].subject, "运行提交一：带专用测试与只读审计");
    t.eq(Date.parse(got.commits[0].committedAt), Date.parse(RUNTIME_ONE));
    t.ok(got.commits[0].files.includes("test/sample.test.mjs"));
    t.ok(got.commits.every((commit) => Number.isFinite(commit.committedAtMs)));
  } finally {
    cleanup(fixture);
  }
};
