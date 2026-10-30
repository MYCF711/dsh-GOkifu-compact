#!/usr/bin/env node
/**
 * dsh-gokifu-compact —— 命令行入口
 *
 *   dsh-gokifu-compact install [--profile desktop] [--preset personal-assistant] [--dry-run]
 *   dsh-gokifu-compact revert  [--profile desktop]
 *   dsh-gokifu-compact doctor  [--json]
 *
 * `install` 做的事只有一件是人手做起来最容易错的：把 agent preset 的 compaction group 里
 * `@deepseek-ai/dsh-compaction-basic` 那一行换成 `dsh-gokifu-compact`（带备份、可回滚、幂等）。
 * 为什么必须改 preset 文件而不是 bundle patch：见 scripts/install.mjs 顶部注释。
 */
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { run } from "./install.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const command = argv[0] ?? "";

if (command === "install" || command === "revert") {
  process.exitCode = run(argv);
} else if (command === "doctor") {
  // doctor 与 cli 同目录（scripts/）：它本来就是 CLI 子命令，不是测试夹具。
  // 早先放在 test/ 下 ⇒ test/ 不在 package.json 的 files 里 ⇒ 从 npm 装的用户
  // 跑 `npx dsh-gokifu-compact doctor` 必 ENOENT。1.9.1 迁移到 scripts/。
  const doctor = nodePath.join(HERE, "doctor.mjs");
  try {
    execFileSync(process.execPath, [doctor, ...argv.slice(1)], { stdio: "inherit" });
  } catch (error) {
    process.exitCode = typeof error?.status === "number" ? error.status : 1;
  }
} else if (command === "migrate-dangling") {
  const migrate = nodePath.join(HERE, "migrate-dangling.mjs");
  try {
    execFileSync(process.execPath, [migrate, ...argv.slice(1)], { stdio: "inherit" });
  } catch (error) {
    process.exitCode = typeof error?.status === "number" ? error.status : 1;
  }
} else {
  console.log(`dsh-gokifu-compact — DSH 的棋谱式上下文压缩后端

用法:
  dsh-gokifu-compact install [--profile <name>] [--preset <name>] [--dry-run]
      把压缩后端从 dsh-compaction-basic 换成 dsh-gokifu-compact（自动改 preset，带备份，幂等）
  dsh-gokifu-compact revert  [--profile <name>]
      还原上一次的 preset 备份
  dsh-gokifu-compact doctor
      体检：安装 / 摘要模型 / 压缩成败 / 棋谱 / 树新鲜度
  dsh-gokifu-compact migrate-dangling [--apply] [--verify --backup=<dir>]
      P6-C 悬空边 sidecar 归档（默认 dry-run；apply 需停插件窗口）

装包（先做这一步）:
  dsh plugin --profile <name> add dsh-gokifu-compact
`);
  process.exitCode = command === "" || command === "--help" || command === "-h" ? 0 : 1;
}
