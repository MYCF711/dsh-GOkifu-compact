/**
 * cli-routing.test.mjs —— CLI 入口的「子命令 → 脚本」路由不许断（2026-11-02，C83）
 *
 * 为什么需要：`package.json` 的 `bin` 指向 `scripts/cli.mjs`，用户从 npm 装完第一件事就是
 * `npx dsh-gokifu-compact doctor`。历史上真实事故：doctor 曾放在 `test/` 下，而 `files` 白名单
 * 不含 `test/` —— 装出来的包一跑就 ENOENT（1.9.1 才迁到 `scripts/`）。
 *
 * 这条测试把「路由表」钉住：cli.mjs 里每个 `nodePath.join(HERE, "X.mjs")` 的目标必须真的存在，
 * 每个 `command === "x"` 分支必须在用法文本里出现，`bin` 指向的文件也必须在解析后的包里。
 */

import { execFileSync } from "node:child_process";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.join(HERE, "..");

export const tests = {};

const read = (rel) => nodeFs.readFileSync(nodePath.join(REPO, rel), "utf8");

tests["C83-1 cli.mjs 里每个转发的脚本目标必须存在（防 test/ 事件重演）"] = (t) => {
  const src = read("scripts/cli.mjs");
  const targets = [...src.matchAll(/nodePath\.join\(HERE,\s*"([^"]+\.mjs)"\)/g)].map((m) => m[1]);
  t.eq(targets.length >= 2, true, `至少要识别出 2 个转发目标，实际 ${targets.length}`);
  for (const target of new Set(targets)) {
    const abs = nodePath.join(REPO, "scripts", target);
    t.eq(nodeFs.existsSync(abs), true, `cli 转发的 ${target} 必须存在（实际查 ${abs}）`);
  }
};

tests["C83-2 每个 command 分支都要在用法文本里出现（否则用户不知道怎么用）"] = (t) => {
  const src = read("scripts/cli.mjs");
  const commands = [...new Set([...src.matchAll(/command === "([a-z][a-z-]*)"/g)].map((m) => m[1]))];
  t.eq(commands.length >= 3, true, `至少要识别出 3 个子命令，实际 ${commands.join(",")}`);
  for (const cmd of commands) {
    t.eq(src.includes(`dsh-gokifu-compact ${cmd}`), true, `用法文本里必须出现 \`dsh-gokifu-compact ${cmd}\``);
  }
};

tests["C83-3 package.json 的 bin 指向的文件存在，且它确实分派 doctor"] = (t) => {
  const pkg = JSON.parse(read("package.json"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin ?? {})[0];
  t.eq(typeof bin === "string" && bin.length > 0, true, "package.json 必须有 bin");
  const rel = String(bin).replace(/^\.\//, "");
  t.eq(nodeFs.existsSync(nodePath.join(REPO, rel)), true, `bin 文件必须存在：${rel}`);
  const src = nodeFs.readFileSync(nodePath.join(REPO, rel), "utf8");
  t.eq(src.includes('command === "doctor"'), true, "bin 必须分派 doctor（用户装完第一条命令）");
  // files 白名单必须把 bin 所在的整个目录包含进去（否则打包后 bin 不在包里）
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const dir = rel.split("/")[0];
  t.eq(files.some((f) => f === dir || f.startsWith(`${dir}/`) || f === rel), true, `files 白名单必须包含 ${dir}/ 或 ${rel}`);
};

tests["C83-4 未知子命令：打印用法并返回非 0；--help 返回 0"] = (t) => {
  const runCli = (args) => {
    try {
      const out = execFileSync(process.execPath, [nodePath.join(REPO, "scripts", "cli.mjs"), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out };
    } catch (error) {
      return { code: typeof error?.status === "number" ? error.status : 1, out: String(error?.stdout ?? "") };
    }
  };
  const bogus = runCli(["definitely-not-a-command"]);
  t.eq(bogus.code !== 0, true, "未知子命令必须非 0 退出");
  t.includes(bogus.out, "用法", "未知子命令要打印用法");
  const help = runCli(["--help"]);
  t.eq(help.code, 0, "--help 必须 0 退出");
};
