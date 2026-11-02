/**
 * docs-cli-commands.test.mjs —— 文档里教的命令必须真的存在（C277）
 *
 * 为什么：本仓库已经出现过「文档说 A、代码是 B」三次（C252/C253/C254 那一族）。
 * 命令名拼错比数字写错更狠：用户照抄会直接 command not found。
 *
 * 口径：只看**真的在教人敲 CLI** 的写法——
 *   · 反引号包起来的 `dsh-gokifu-compact <子命令>`
 *   · 行首或 `npx ` 后面的 dsh-gokifu-compact <子命令>
 * `npm view dsh-gokifu-compact version` 这类**npm 用法不算**（那是 npm 的参数，不是我们的子命令）。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");

export const tests = {};

/** 从 cli.mjs 里抠出真实子命令。 */
export function cliSubcommands() {
  const src = nodeFs.readFileSync(nodePath.join(ROOT, "scripts", "cli.mjs"), "utf8");
  return new Set([...src.matchAll(/command === "([a-z][a-z-]*)"/g)].map((m) => m[1]));
}

/** 从一段文本里抠出"被当作 CLI 子命令"的写法。 */
export function mentionedSubcommands(text) {
  const found = new Set();
  const push = (name) => {
    if (/^[a-z][a-z-]*$/.test(name) && !name.startsWith("-")) found.add(name);
  };
  // ① 反引号（含 `npx dsh-gokifu-compact xxx` 这种最常用的写法）
  for (const m of text.matchAll(/`(?:npx\s+)?dsh-gokifu-compact\s+([a-z][a-z-]*)/g)) push(m[1]);
  // ② 行首 / npx 后（代码块里不带反引号的情况）
  for (const m of text.matchAll(/(?:^|\n)\s*(?:npx\s+)?dsh-gokifu-compact\s+([a-z][a-z-]*)/g)) push(m[1]);
  return found;
}

tests["C277 文档里教的 dsh-gokifu-compact 子命令必须都真实存在"] = (t) => {
  const real = cliSubcommands();
  t.eq(real.size >= 5, true, `cli.mjs 至少要认出 5 个子命令（现在 ${real.size} 个）—— 正则失配会让这条永远绿`);

  const files = [
    "README.md",
    "HANDOFF.md",
    "CHANGELOG.md",
    ...nodeFs
      .readdirSync(nodePath.join(ROOT, "docs"), { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => nodePath.join("docs", d.name)),
    ...nodeFs
      .readdirSync(nodePath.join(ROOT, "docs", "knowledge"), { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => nodePath.join("docs", "knowledge", d.name)),
  ].filter((rel) => nodeFs.existsSync(nodePath.join(ROOT, rel)));

  let totalMentions = 0;
  for (const rel of files) {
    const text = nodeFs.readFileSync(nodePath.join(ROOT, rel), "utf8");
    for (const name of mentionedSubcommands(text)) {
      totalMentions += 1;
      t.eq(real.has(name), true, `${rel} 教了 \`dsh-gokifu-compact ${name}\`，但 cli.mjs 里没有这个子命令`);
    }
  }
  // 防"永远绿"：一条都认不出来说明正则失配（本仓库文档里 doctor / install 遍地都是）
  t.eq(totalMentions >= 5, true, `全语料只认出 ${totalMentions} 条 CLI 提及 —— 正则大概失配了`);
};

tests["C277 口径自检：npm view 的用法不许被误判成我们的子命令（否则会假红）"] = (t) => {
  const text = "npm view dsh-gokifu-compact version\n`npm view dsh-gokifu-compact dist-tags`\n`dsh-gokifu-compact doctor`";
  const found = [...mentionedSubcommands(text)];
  t.eq(found, ["doctor"], `只该认出 doctor，实际认出 ${JSON.stringify(found)}`);
};
