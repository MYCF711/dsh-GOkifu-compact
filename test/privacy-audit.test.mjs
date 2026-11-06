/** K-31：合成阳性必须真红，公开默认值必须真绿，且报告绝不回显敏感原值。 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { auditChanged, formatReport, scanLine, scanText, RULE } from "../scripts/privacy-audit.mjs";

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const ROOT = nodePath.resolve(HERE, "..");
const SCRIPT = nodePath.join(ROOT, "scripts", "privacy-audit.mjs");
const SECRET = ["k31", "credential", "9f8e7d6c5b4a"].join("-");
const PRIVATE_PATH = ["D:", "Users", "k31-private", "checkout"].join("/");
const REAL_SESSION = ["session", "9f8e7d6c"].join("-");
const SYNTHETIC_SESSION = ["session", "k31-public-fixture"].join("-");
const PRIVATE_EMAIL = ["person", "private-mail.com"].join("@");
const UUID = ["123e4567", "e89b", "12d3", "a456", "426614174000"].join("-");

export const tests = {};
const temp = (label) => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), `k31-privacy-${label}-`));
const cleanup = (dir) => nodeFs.rmSync(dir, { recursive: true, force: true });
const hits = (line, path = "fixture.md") => scanLine(line, { path });
const statuses = (found, ruleId) => found.filter((h) => h.ruleId === ruleId).map((h) => h.status);

function runAudit(cwd, args = ["--changed"], env = process.env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env, timeout: 60000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error(`fixture git ${args[0]} failed`);
}

function makeRepo() {
  const dir = temp("changed");
  git(dir, ["init", "-q"]);
  git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(dir, ["config", "user.email", "fixture@example.com"]);
  git(dir, ["config", "user.name", "Fixture"]);
  nodeFs.writeFileSync(nodePath.join(dir, "README.md"), "public relative path: src/ui.mjs\n");
  git(dir, ["add", "--", "README.md"]);
  git(dir, ["commit", "-qm", "fixture"]);
  return dir;
}

function makePackage({ content = "export const ok = true;\n", files = ["src", "scripts"], extra = [] } = {}) {
  const dir = temp("pack");
  nodeFs.mkdirSync(nodePath.join(dir, "src"), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(dir, "scripts"), { recursive: true });
  const pkg = {
    name: "k31-privacy-fixture",
    version: "1.0.0",
    author: "MYCF711 <MYCF711@users.noreply.github.com>",
    main: "src/ui.mjs",
    bin: { k31: "scripts/cli.mjs" },
    files,
  };
  nodeFs.writeFileSync(nodePath.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  nodeFs.writeFileSync(nodePath.join(dir, "README.md"), "http://127.0.0.1:3425/v1 · D:/fixture/public.txt · person@example.com\n");
  nodeFs.writeFileSync(nodePath.join(dir, "LICENSE"), "MIT\n");
  nodeFs.writeFileSync(nodePath.join(dir, "src", "ui.mjs"), content);
  nodeFs.writeFileSync(nodePath.join(dir, "scripts", "cli.mjs"), "#!/usr/bin/env node\n");
  for (const [rel, text] of extra) {
    const target = nodePath.join(dir, ...rel.split("/"));
    nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true });
    nodeFs.writeFileSync(target, text);
  }
  return dir;
}

tests["K31-P1 高置信 secret / 私钥 / Bearer / 连接串全部 confirmed，占位值不红"] = (t) => {
  const positive = [
    `api_key = "${SECRET}"`,
    `secret = "${SECRET}"`,
    ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" "),
    `Authorization: Bearer ${SECRET}`,
    `mongodb://user:${SECRET}@db.internal/example`,
    `session_token = "${SECRET}"`,
  ];
  for (const line of positive) t.eq(statuses(hits(line), RULE.SECRET), ["confirmed"], line);
  const negative = [
    'api_key = "<redacted>"',
    'password = "${process.env.PASSWORD}"',
    "Authorization: Bearer $GITHUB_TOKEN",
    "access_token = 'your_token'",
    "const token = process.env.ACCESS_TOKEN;",
  ];
  for (const line of negative) t.eq(hits(line).some((h) => h.ruleId === RULE.SECRET && h.status === "confirmed"), false, line);
};

tests["K31-P2 真实姓名/法律上下文与直接标识判红，公开作者和示例邮箱分开"] = (t) => {
  const name = ["陈", "实", "铭"].join("");
  t.eq(statuses(hits(`原告：${name}`), RULE.PERSONAL), ["confirmed"]);
  t.eq(statuses(hits(`联系电话：${["138", "0013", "8000"].join("")}`), RULE.PERSONAL), ["confirmed"]);
  t.eq(statuses(hits(PRIVATE_EMAIL), RULE.PERSONAL), ["review"]);
  t.eq(statuses(hits("person@example.com"), RULE.PERSONAL), ["public-synthetic"]);
  t.eq(statuses(hits("MYCF711@users.noreply.github.com"), RULE.PERSONAL), ["public-declared"]);
};

tests["K31-P3 私有 home/checkout 确认，通用盘符 review，D:/fixture 与相对路径豁免"] = (t) => {
  t.eq(statuses(hits(PRIVATE_PATH), RULE.PATH), ["confirmed"]);
  t.eq(statuses(hits(["E:", "ordinary", "data.bin"].join("/")), RULE.PATH), ["review"]);
  t.eq(statuses(hits("D:/fixture/private-looking-name.txt"), RULE.PATH), ["public-synthetic"]);
  t.eq(hits("src/rooms/ledger.mjs").some((h) => h.ruleId === RULE.PATH), false);
  t.eq(statuses(hits("http://127.0.0.1:3425/v1/models"), RULE.NETWORK), ["public-synthetic"]);
  t.eq(statuses(hits(["http:", "", ["192", "168", "1", "8"].join("."), "private"].join("/")), RULE.NETWORK), ["confirmed"]);
};

tests["K31-P1 回环 host 不豁免同一 URL 中的 token"] = (t) => {
  const found = hits(`http://127.0.0.1:3425/v1?access_token=${SECRET}`);
  t.eq(statuses(found, RULE.NETWORK), ["public-synthetic"]);
  t.eq(statuses(found, RULE.SECRET), ["confirmed"]);
};

tests["K31-P4 session/subagent 判红，request/run/UUID 先 review；精确合成豁免不扩散"] = (t) => {
  t.eq(statuses(hits(REAL_SESSION), RULE.RUNTIME), ["confirmed"]);
  t.eq(statuses(hits(["subagent", "9f8e7d6c"].join("-")), RULE.RUNTIME), ["confirmed"]);
  t.eq(statuses(hits(`requestId = "${UUID}"`), RULE.RUNTIME).every((status) => status === "review"), true);
  t.eq(statuses(hits(UUID), RULE.RUNTIME), ["review"]);
  t.eq(statuses(hits(SYNTHETIC_SESSION, "test/privacy-audit.test.mjs"), RULE.RUNTIME), ["public-synthetic"]);
  t.eq(statuses(hits(SYNTHETIC_SESSION, "test/other.test.mjs"), RULE.RUNTIME), ["confirmed"]);
};

tests["K31-P5 通用错误详情绿，含 P1-P4 的错误才追加判分"] = (t) => {
  t.eq(hits("TypeError: invalid public input").some((h) => h.ruleId === RULE.ERROR), false);
  const found = hits(`TypeError: cannot read ${PRIVATE_PATH}`);
  t.eq(statuses(found, RULE.PATH), ["confirmed"]);
  t.eq(statuses(found, RULE.ERROR), ["confirmed"]);
};

tests["K31-report 输出只有文件/行号/规则/状态，不含 secret 或私有路径原值"] = (t) => {
  const report = formatReport({ mode: "changed", scanned: 1, binary: 0, packEntries: null, findings: hits(`Error: api_key="${SECRET}" ${PRIVATE_PATH}`) });
  t.eq(report.ok, false);
  t.notIncludes(report.text, SECRET);
  t.notIncludes(report.text, PRIVATE_PATH);
  t.includes(report.text, "fixture.md:1 P1-SECRET confirmed");
  t.includes(report.text, "P3-PATH confirmed");
};

tests["K31-changed 干净仓库 0 文件且 exit 0"] = (t) => {
  const dir = makeRepo();
  try {
    const r = runAudit(dir);
    t.eq(r.code, 0, r.out);
    t.includes(r.out, "files=0");
    t.includes(r.out, "confirmed=0 review=0");
  } finally { cleanup(dir); }
};

tests["K31-changed 只扫新增行：历史敏感行未改不红，新增 secret 必红且不回显"] = (t) => {
  const dir = makeRepo();
  try {
    nodeFs.writeFileSync(nodePath.join(dir, "legacy.txt"), `old api_key = "${SECRET}"\nkeep = 1\n`);
    git(dir, ["add", "--", "legacy.txt"]);
    git(dir, ["commit", "-qm", "legacy fixture"]);
    nodeFs.writeFileSync(nodePath.join(dir, "legacy.txt"), `old api_key = "${SECRET}"\nkeep = 2\n`);
    const historical = runAudit(dir);
    t.eq(historical.code, 0, historical.out);
    nodeFs.appendFileSync(nodePath.join(dir, "legacy.txt"), `new password = "${SECRET}"\n`);
    const added = runAudit(dir);
    t.eq(added.code, 1, added.out);
    t.includes(added.out, "legacy.txt:3 P1-SECRET confirmed");
    t.notIncludes(added.out, SECRET);
  } finally { cleanup(dir); }
};

tests["K31-changed 新增未跟踪敏感文件必红；审计后字节不变"] = (t) => {
  const dir = makeRepo();
  try {
    const target = nodePath.join(dir, "new.txt");
    const content = `access_token = "${SECRET}"\n`;
    nodeFs.writeFileSync(target, content);
    const before = nodeFs.readFileSync(target, "utf8");
    const r = runAudit(dir, []);
    t.eq(r.code, 1, r.out);
    t.includes(r.out, "new.txt:1 P1-SECRET confirmed");
    t.notIncludes(r.out, SECRET);
    t.eq(nodeFs.readFileSync(target, "utf8"), before);
  } finally { cleanup(dir); }
};

tests["K31-changed 公开合成 fixture 绿，但同一值换个 test 文件仍红（非全局忽略 test/）"] = (t) => {
  const dir = makeRepo();
  try {
    nodeFs.mkdirSync(nodePath.join(dir, "test"), { recursive: true });
    const safe = `const endpoint = "http://localhost:3425";\nconst path = "D:/fixture/a.txt";\nconst id = "${SYNTHETIC_SESSION}";\n`;
    nodeFs.writeFileSync(nodePath.join(dir, "test", "privacy-audit.test.mjs"), safe);
    const green = runAudit(dir);
    t.eq(green.code, 0, green.out);
    nodeFs.writeFileSync(nodePath.join(dir, "test", "other.test.mjs"), `const id = "${SYNTHETIC_SESSION}";\n`);
    const red = runAudit(dir);
    t.eq(red.code, 1, red.out);
    t.notIncludes(red.out, SYNTHETIC_SESSION);
  } finally { cleanup(dir); }
};

tests["K31-pack 临时敏感包必红且输出不含秘密值"] = (t) => {
  const dir = makePackage({ content: `export const credential = "${SECRET}";\nexport const api_key = "${SECRET}";\n` });
  try {
    const r = runAudit(dir, ["--pack"]);
    t.eq(r.code, 1, r.out);
    t.includes(r.out, "src/ui.mjs:2 P1-SECRET confirmed");
    t.notIncludes(r.out, SECRET);
    t.eq(nodeFs.existsSync(nodePath.join(dir, "k31-privacy-fixture-1.0.0.tgz")), false);
  } finally { cleanup(dir); }
};

tests["K31-pack 公开合成 fixture 全绿：回环、D:/fixture、示例邮箱、公开作者、精确 session 豁免"] = (t) => {
  const dir = makePackage({
    content: "export const endpoint = 'http://127.0.0.1:3425';\nexport const path = 'D:/fixture/a.txt';\n",
    extra: [["scripts/privacy-audit.mjs", `export const id = "${SYNTHETIC_SESSION}";\n`]],
  });
  try {
    const r = runAudit(dir, ["--pack"]);
    t.eq(r.code, 0, r.out);
    t.includes(r.out, "confirmed=0 review=0");
    t.includes(r.out, "public-synthetic=");
    t.includes(r.out, "public-declared=1");
  } finally { cleanup(dir); }
};

tests["K31-pack 未知二进制不得静默跳过，必须 SCAN-BINARY 真红"] = (t) => {
  const dir = makePackage();
  try {
    nodeFs.writeFileSync(nodePath.join(dir, "src", "ui.mjs"), Buffer.from([0, 1, 2, 3]));
    const r = runAudit(dir, ["--pack"]);
    t.eq(r.code, 1, r.out);
    t.includes(r.out, "src/ui.mjs:0 SCAN-BINARY confirmed");
  } finally { cleanup(dir); }
};

tests["K31-pack test/ 进入 packlist 必红，不能靠 files 白名单假定"] = (t) => {
  const dir = makePackage({ files: ["src", "scripts", "test"], extra: [["test/safe.test.mjs", "export const ok = true;\n"]] });
  try {
    const r = runAudit(dir, ["--pack"]);
    t.eq(r.code, 1, r.out);
    t.includes(r.out, "test/safe.test.mjs:0 PACKLIST confirmed");
  } finally { cleanup(dir); }
};

tests["K31-pack 空清单、不可解析、npm 失败三种形状全部真红"] = (t) => {
  for (const [label, stdout, code] of [["empty", '[{"files":[]}]\n', 0], ["bad-json", "not-json\n", 0], ["failure", "", 7]]) {
    const dir = temp(`pack-${label}`);
    const bin = nodePath.join(dir, "bin");
    nodeFs.mkdirSync(bin);
    try {
      if (process.platform === "win32") {
        const lines = stdout ? [`@echo ${stdout.trim()}`] : ["@echo off"];
        lines.push(`@exit /b ${code}`);
        nodeFs.writeFileSync(nodePath.join(bin, "npm.cmd"), lines.join("\r\n"));
      } else {
        nodeFs.writeFileSync(nodePath.join(bin, "npm"), `#!/bin/sh\nprintf '%s\\n' '${stdout.trim()}'\nexit ${code}\n`, { mode: 0o755 });
      }
      const r = runAudit(dir, ["--pack"], { ...process.env, PATH: `${bin}${nodePath.delimiter}${process.env.PATH ?? ""}` });
      t.eq(r.code, 1, `${label}: ${r.out}`);
      t.includes(r.out, "package.json:0 PACKLIST confirmed", label);
    } finally { cleanup(dir); }
  }
};

tests["K31-auditChanged 对非 git 目录不吞错，operational failure 也红"] = (t) => {
  const dir = temp("not-git");
  try {
    const result = auditChanged({ cwd: dir });
    const report = formatReport(result);
    t.eq(report.ok, false);
    t.includes(report.text, ".git:0 SCAN-IO confirmed");
  } finally { cleanup(dir); }
};

tests["K31-scanText 保持真实行号，不在报告中携带 literal"] = (t) => {
  const found = scanText(`safe\napi_key = "${SECRET}"\n`, { path: "a.md" });
  t.eq(found[0].line, 2);
  const report = formatReport({ mode: "pack", scanned: 1, binary: 0, packEntries: 1, findings: found });
  t.eq(Object.hasOwn(JSON.parse(JSON.stringify(report)), "findings"), false);
  t.notIncludes(report.text, SECRET);
};
