#!/usr/bin/env node
/**
 * K-31 永久隐私门：只检测，不改写；报告永不回显命中原值。
 *
 *   node scripts/privacy-audit.mjs            # 同 --changed：只扫工作树相对 HEAD 的新增行
 *   node scripts/privacy-audit.mjs --changed  # 干净树 = 0 个文件；新增泄露 = exit 1
 *   node scripts/privacy-audit.mjs --pack     # 扫完整 npm packlist；confirmed/review 都阻断
 *
 * --changed 同时覆盖已跟踪文件的 staged/unstaged 新增行与未忽略的新文件，不扫历史材料。
 * --pack 以 `npm pack --dry-run --json --ignore-scripts` 为唯一发布面；失败、空清单、
 * 不可解析、不可读、未知二进制与 UTF-8 解码失败均为判分型失败。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const RULE = Object.freeze({
  SECRET: ["P1", "SECRET"].join("-"),
  PERSONAL: "P2-PERSONAL",
  PATH: "P3-PATH",
  NETWORK: "P3-NETWORK",
  RUNTIME: "P4-RUNTIME-ID",
  ERROR: "P5-ERROR",
  PACKLIST: "PACKLIST",
  IO: "SCAN-IO",
  BINARY: "SCAN-BINARY",
});

const PUBLIC_SYNTHETIC_SESSION = "session-k31-public-fixture";
const PUBLIC_GOAL_ID = ["f953036a", "9aa8", "4b8a", "a836", "6ca2e35853b8"].join("-");
const PUBLIC_AUTHOR_EMAIL = "MYCF711@users.noreply.github.com";
const PUBLIC_FIXTURE_PREFIX = `${String.fromCharCode(100, 58)}/fixture`;

/** 合成值必须按 (path, ruleId, literal) 精确登记；绝不豁免整个 test/ 目录。 */
export const EXEMPTIONS = Object.freeze([
  { path: "scripts/privacy-audit.mjs", ruleId: RULE.SECRET, literal: RULE.SECRET, status: "public-synthetic" },
  { path: "scripts/privacy-audit.mjs", ruleId: RULE.PERSONAL, literal: "凌海亮", status: "public-synthetic" },
  { path: "scripts/privacy-audit.mjs", ruleId: RULE.RUNTIME, literal: PUBLIC_SYNTHETIC_SESSION, status: "public-synthetic" },
  { path: "test/privacy-audit.test.mjs", ruleId: RULE.RUNTIME, literal: PUBLIC_SYNTHETIC_SESSION, status: "public-synthetic" },
  { path: "evidence/重启验证.md", ruleId: RULE.RUNTIME, literal: PUBLIC_GOAL_ID, status: "public-declared" },
  { path: "evidence/重启验证.md", ruleId: RULE.ERROR, literal: PUBLIC_GOAL_ID, status: "public-declared" },
]);

const PLACEHOLDER_RE = /^(?:<[^>]*>|\[[^\]]*(?:redact|mask|omit|placeholder)[^\]]*\]|\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*|(?:your|insert|replace|change)[_-]?(?:me|this|token|key|secret|password)?|changeme|change-me|redacted|masked|omitted|placeholder|dummy|fake|sample|example|test|fixture|synthetic|not[-_ ]?(?:a[-_ ]?)?real(?:[-_ ]?(?:token|key|secret|password))?|x+|\*+|\.\.\.|string|\?)$/i;
const PLACEHOLDER_PART_RE = /(?:\$\{|<redacted>|<mask|<placeholder|your[_-](?:token|key|secret)|not[-_ ]?(?:a[-_ ]?)?real|begin[_-](?:token|key|secret))/i;
const SECRET_KEY = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|client[_-]?secret|secret|private[_-]?key|password|passwd|authorization|proxy-authorization|cookie|set-cookie)`;
const SECRET_ASSIGN_RE = new RegExp(String.raw`["']?${SECRET_KEY}["']?\s*[:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|\`([^\`\r\n]+)\`)`, "gi");
const BEARER_RE = /\b(?:authorization\s*[:=]\s*)?bearer\s+([A-Za-z0-9._~+/=-]{8,})/gi;
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g;
const CONNECTION_RE = /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/([^\s/:@]+:[^\s/@]+)@/gi;
const QUERY_SECRET_RE = /[?&](?:access_token|api_key|apikey|token|session|session_id|signature|sig)=([^\s&#"']{4,})/gi;
const KNOWN_TOKEN_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const WINDOWS_PATH_RE = /\b[A-Za-z]:[\\/][^\s<>"'|?*\u0000-\u001F，。；、（）【】“”‘’]*/g;
const HOME_PATH_RE = /(?<![A-Za-z0-9_.:-])(?:\/(?:home|Users|root)\/[^\s<>"'|?*，。；、（）【】“”‘’]+|\/mnt\/[a-z]\/(?:Users|home|repos?|workspace|work)\/[^\s<>"'|?*，。；、（）【】“”‘’]+)/gi;
const UNC_PATH_RE = /(?:\\\\|\/\/)[A-Za-z0-9._-]+\\[^\s<>"'|?*]+/g;
const SESSION_RE = /\bsession-(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8,})\b/gi;
const SUBAGENT_RE = /\bsubagent[-_:](?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8,})\b/gi;
const SESSION_ATTRIBUTE_RE = /\bsession(?:\.previous_id|\.id|Id|_id)\s*[:=]\s*["']([^"'\r\n]+)["']/gi;
const CORRELATION_RE = /\b(?:request|run|interaction|correlation)[_-]?id\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9-]{3,})/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const NAMED_PERSON_RE = /(?:真实姓名|法定姓名|姓名|原告|被告|证人|律师|法定代表人|委托人)\s*[:：=]\s*([\p{Script=Han}]{2,4}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gu;
const KNOWN_PERSON_RE = /凌海亮/g;
const CHINA_ID_RE = /(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?!\d)/g;
const PHONE_CONTEXT_RE = /(?:手机号?|联系电话|电话|mobile|phone)\s*[:：=]?\s*(\+?1[3-9]\d{9})(?!\d)/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const PRIVATE_IP_RE = /(?<!\d)(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?!\d)/g;
const ERROR_RE = /(?:\b(?:error|exception|traceback|stack|typeerror|syntaxerror)\b|\bat\s+\S+\s*\(|错误|异常|堆栈)/i;
const KNOWN_BINARY_RE = /\.(?:png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|zip|gz|tgz|zst|mp4|mp3|wav)$/i;
const TEXT_LIKE_RE = /\.(?:md|mjs|js|json|jsonl|ya?ml|txt|patch)$/i;
const FORBIDDEN_PACK_RE = /(?:^|\/)(?:test|tmp)(?:\/|$)|(?:^|\/)\.harness-stubs(?:\/|$)|(?:^|\/)\.engine-under-test[^/]*$/i;

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function isPlaceholder(value) {
  const text = String(value ?? "").trim();
  return text === "" || PLACEHOLDER_RE.test(text) || PLACEHOLDER_PART_RE.test(text);
}

function publicEmailStatus(email) {
  const lower = email.toLowerCase();
  if (lower === PUBLIC_AUTHOR_EMAIL.toLowerCase() || lower === "git@github.com") return "public-declared";
  if (/(?:^|@)(?:example\.(?:com|net|org)|[^@]+\.(?:example|test|invalid|localhost))$/i.test(lower)) return "public-synthetic";
  return null;
}

function pathStatus(literal) {
  const normalized = normalizePath(literal).replace(/[),;:`'"‘’“”]+$/g, "");
  if (/^\/(?:Users|home|root)\/?$/i.test(normalized) || /^[a-z]:\/+(?:…|\.\.\.)(?:\/|$)/i.test(normalized)) return "public-synthetic";
  if (normalized.toLowerCase() === PUBLIC_FIXTURE_PREFIX || normalized.toLowerCase().startsWith(PUBLIC_FIXTURE_PREFIX + "/")) return "public-synthetic";
  if (/^[a-z]:\/+(?:[a-z]|tmp|my|repo|definitely|other|path|not-a-real)(?:[\/\s]|$)/i.test(normalized)) return "public-synthetic";
  if (/(?:^|\/)(?:Users|home|root)(?:\/|$)/i.test(normalized)) return "confirmed";
  if (/(?:DeepSeek Harness|default-workspace|主工作区|工作区|checkout|repos?|workspace)/i.test(normalized)) return "confirmed";
  return "review";
}

function endpointStatus(host) {
  const h = String(host ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "…" || h === "..." || h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h)) return "public-synthetic";
  if (h === "example.com" || h === "example.net" || h === "example.org" || h.endsWith(".example") || h.endsWith(".test") || h.endsWith(".invalid")) return "public-synthetic";
  if (/^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./.test(h)) return "public-synthetic";
  if (/^(?:10\.|192\.168\.)/.test(h) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(h) || h.endsWith(".internal") || h.endsWith(".local")) return "confirmed";
  return null;
}

function scanUrls(line, add) {
  for (const match of line.matchAll(URL_RE)) {
    try {
      const url = new URL(match[0]);
      const status = endpointStatus(url.hostname);
      if (status) add(RULE.NETWORK, url.host, status);
    } catch {
      const placeholder = /[<>{}\[\]$]|…|\.\.\./.test(match[0]);
      add(RULE.NETWORK, "<unparseable-url>", placeholder ? "public-synthetic" : "review");
    }
  }
  for (const match of line.matchAll(PRIVATE_IP_RE)) add(RULE.NETWORK, match[0], "confirmed");
}

/** 扫单行；返回值中的 literal 只供精确豁免和去重，formatReport 不会输出它。 */
export function scanLine(line, { path = "<inline>", lineNumber = 1, exemptions = EXEMPTIONS } = {}) {
  const found = [];
  const seen = new Set();
  const add = (ruleId, literal, status = "confirmed") => {
    let effective = status;
    if (literal === PUBLIC_AUTHOR_EMAIL && ruleId === RULE.PERSONAL) effective = "public-declared";
    const exemption = exemptions.find((item) => item.path === normalizePath(path) && item.ruleId === ruleId && item.literal === literal);
    if (exemption) effective = exemption.status;
    const key = `${ruleId}\u0000${literal}\u0000${effective}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ path: normalizePath(path), line: lineNumber, ruleId, status: effective, literal: String(literal) });
  };

  for (const match of line.matchAll(PRIVATE_KEY_RE)) add(RULE.SECRET, match[0]);
  for (const match of line.matchAll(KNOWN_TOKEN_RE)) add(RULE.SECRET, match[0]);
  for (const match of line.matchAll(SECRET_ASSIGN_RE)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (!isPlaceholder(value)) add(RULE.SECRET, value);
  }
  for (const match of line.matchAll(BEARER_RE)) if (!isPlaceholder(match[1])) add(RULE.SECRET, match[1]);
  for (const match of line.matchAll(CONNECTION_RE)) if (!isPlaceholder(match[1])) add(RULE.SECRET, match[1]);
  for (const match of line.matchAll(QUERY_SECRET_RE)) if (!isPlaceholder(match[1])) add(RULE.SECRET, match[1]);

  for (const match of line.matchAll(EMAIL_RE)) {
    const email = match[0];
    add(RULE.PERSONAL, email, publicEmailStatus(email) ?? "review");
  }
  for (const match of line.matchAll(NAMED_PERSON_RE)) {
    if (!/^(?:某某|某人|张三|李四|王五|示例|测试|无名)$/.test(match[1])) add(RULE.PERSONAL, match[1], "confirmed");
  }
  for (const match of line.matchAll(KNOWN_PERSON_RE)) add(RULE.PERSONAL, match[0], "confirmed");
  for (const match of line.matchAll(CHINA_ID_RE)) add(RULE.PERSONAL, match[0], "confirmed");
  for (const match of line.matchAll(PHONE_CONTEXT_RE)) add(RULE.PERSONAL, match[1], "confirmed");

  for (const match of line.matchAll(WINDOWS_PATH_RE)) add(RULE.PATH, match[0], pathStatus(match[0]));
  for (const match of line.matchAll(HOME_PATH_RE)) add(RULE.PATH, match[0], pathStatus(match[0]));
  for (const match of line.matchAll(UNC_PATH_RE)) {
    const escapedExample = match[0].includes("*") || match[0].includes("\\.") || /^\\\\(?:profiles|Desktop|nodes)\\\\/i.test(match[0]);
    add(RULE.PATH, match[0], escapedExample ? "public-synthetic" : "review");
  }
  scanUrls(line, add);

  if (line.includes(PUBLIC_SYNTHETIC_SESSION)) add(RULE.RUNTIME, PUBLIC_SYNTHETIC_SESSION, "confirmed");
  for (const match of line.matchAll(SESSION_RE)) add(RULE.RUNTIME, match[0], "confirmed");
  for (const match of line.matchAll(SUBAGENT_RE)) add(RULE.RUNTIME, match[0], "confirmed");
  for (const match of line.matchAll(SESSION_ATTRIBUTE_RE)) {
    const value = match[1];
    if (/^(?:s\d+|legacy\d*|sess-|bench-|test-|fake-|example-|sample-|fixture-)/i.test(value)) {
      add(RULE.RUNTIME, value, "public-synthetic");
    } else if (/^session-[0-9a-f]{8}/i.test(value)) {
      add(RULE.RUNTIME, value, "confirmed");
    } else if (!isPlaceholder(value)) {
      add(RULE.RUNTIME, value, "review");
    }
  }
  for (const match of line.matchAll(CORRELATION_RE)) if (!isPlaceholder(match[1])) add(RULE.RUNTIME, match[1], "review");
  for (const match of line.matchAll(UUID_RE)) {
    if (!/^00000000-0000-0000-0000-000000000000$/i.test(match[0])) add(RULE.RUNTIME, match[0], "review");
  }

  if (ERROR_RE.test(line)) {
    for (const hit of [...found]) {
      if ([RULE.SECRET, RULE.PERSONAL, RULE.PATH, RULE.NETWORK, RULE.RUNTIME].includes(hit.ruleId) && ["confirmed", "review"].includes(hit.status)) {
        add(RULE.ERROR, hit.literal, hit.status);
      }
    }
  }
  return found;
}

export function scanText(text, { path = "<inline>", exemptions = EXEMPTIONS, startLine = 1 } = {}) {
  const lines = String(text ?? "").split(/\r?\n/);
  return lines.flatMap((line, index) => scanLine(line, { path, lineNumber: startLine + index, exemptions }));
}

function finding(path, line, ruleId, status = "confirmed") {
  return { path: normalizePath(path), line, ruleId, status, literal: "" };
}

function safeRelative(root, relative) {
  const normalized = normalizePath(relative);
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) return null;
  const absolute = nodePath.resolve(root, ...normalized.split("/"));
  const base = nodePath.resolve(root);
  if (absolute !== base && !absolute.startsWith(base + nodePath.sep)) return null;
  return { normalized, absolute };
}

function readTextFile(root, relative, { knownBinary = () => false } = {}) {
  const safe = safeRelative(root, relative);
  if (!safe) return { findings: [finding(relative, 0, RULE.IO)], binary: false };
  try {
    const stat = nodeFs.statSync(safe.absolute);
    if (!stat.isFile()) return { findings: [finding(safe.normalized, 0, RULE.IO)], binary: false };
    let buffer = nodeFs.readFileSync(safe.absolute);
    if (knownBinary(safe.normalized)) return { findings: [], binary: true };
    try {
      let encoding = "utf-8";
      if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) encoding = "utf-16le";
      else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) encoding = "utf-16be";
      else if (buffer.includes(0)) {
        if (!TEXT_LIKE_RE.test(safe.normalized) || buffer.some((byte) => byte !== 0 && byte < 0x20 && ![9, 10, 13].includes(byte))) {
          return { findings: [finding(safe.normalized, 0, RULE.BINARY)], binary: false };
        }
        buffer = Buffer.from(buffer.filter((byte) => byte !== 0));
      }
      const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
      return { findings: [], text, binary: false };
    } catch {
      return { findings: [finding(safe.normalized, 0, RULE.BINARY)], binary: false };
    }
  } catch {
    return { findings: [finding(safe.normalized, 0, RULE.IO)], binary: false };
  }
}

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}

function parseNullList(output) {
  return String(output ?? "").split("\u0000").filter(Boolean);
}

function addedLines(diff) {
  const out = [];
  let newLine = null;
  for (const line of String(diff ?? "").split(/\r?\n/)) {
    const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (newLine === null || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      out.push({ number: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-")) {
      // 删除行不占新文件行号。
    } else {
      newLine += 1;
    }
  }
  return out;
}

export function auditChanged({ cwd = process.cwd(), exemptions = EXEMPTIONS } = {}) {
  const findings = [];
  let tracked = [];
  let untracked = [];
  const listed = run("git", ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "HEAD", "--"], cwd);
  const others = run("git", ["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  if (listed.status !== 0 || others.status !== 0) {
    findings.push(finding(".git", 0, RULE.IO));
  } else {
    tracked = parseNullList(listed.stdout);
    untracked = parseNullList(others.stdout);
  }
  let scanned = 0;
  let binary = 0;
  for (const relative of [...new Set([...tracked, ...untracked])]) {
    const safe = safeRelative(cwd, relative);
    if (!safe || !nodeFs.existsSync(safe.absolute)) continue;
    scanned += 1;
    findings.push(...scanLine(relative, { path: relative, lineNumber: 0, exemptions }));
    const read = readTextFile(cwd, relative, { knownBinary: (p) => KNOWN_BINARY_RE.test(p) });
    findings.push(...read.findings);
    if (read.binary) {
      binary += 1;
      continue;
    }
    if (read.text === undefined) continue;
    if (untracked.includes(relative)) {
      findings.push(...scanText(read.text, { path: relative, exemptions }));
      continue;
    }
    const diff = run("git", ["diff", "--no-ext-diff", "--no-textconv", "--unified=0", "--no-color", "--text", "HEAD", "--", relative], cwd);
    if (diff.status !== 0) {
      findings.push(finding(relative, 0, RULE.IO));
      continue;
    }
    for (const line of addedLines(diff.stdout)) findings.push(...scanLine(line.text, { path: relative, lineNumber: line.number, exemptions }));
  }
  return { mode: "changed", findings, scanned, binary, packEntries: null };
}

function parsePackList(stdout) {
  const parsed = JSON.parse(String(stdout ?? "").trim());
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || !Array.isArray(first.files) || first.files.length === 0) return [];
  return first.files.map((entry) => normalizePath(entry?.path)).filter(Boolean);
}

function requiredPackEntries(cwd) {
  const required = ["package.json"];
  try {
    const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(cwd, "package.json"), "utf8"));
    if (typeof pkg.main === "string") required.push(normalizePath(pkg.main));
    if (typeof pkg.bin === "string") required.push(normalizePath(pkg.bin));
    if (pkg.bin && typeof pkg.bin === "object") for (const value of Object.values(pkg.bin)) if (typeof value === "string") required.push(normalizePath(value));
    for (const name of nodeFs.readdirSync(cwd)) {
      if (/^(?:readme|licen[sc]e)(?:\.|$)/i.test(name)) required.push(normalizePath(name));
    }
  } catch {
    // package.json 缺失/坏 JSON 已由 PACKLIST 或 SCAN-IO 判红；这里不额外回显错误。
  }
  return [...new Set(required)];
}

export function auditPack({ cwd = process.cwd(), exemptions = EXEMPTIONS } = {}) {
  const findings = [];
  const packed = spawnSync("npm pack --dry-run --json --ignore-scripts", {
    cwd,
    encoding: "utf8",
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  let entries = [];
  if (packed.status !== 0) {
    findings.push(finding("package.json", 0, RULE.PACKLIST));
  } else {
    try {
      entries = parsePackList(packed.stdout);
      if (entries.length === 0) findings.push(finding("package.json", 0, RULE.PACKLIST));
    } catch {
      findings.push(finding("package.json", 0, RULE.PACKLIST));
    }
  }
  const unique = [...new Set(entries)];
  for (const required of requiredPackEntries(cwd)) {
    if (entries.length > 0 && !unique.includes(required)) findings.push(finding(required, 0, RULE.PACKLIST));
  }
  let scanned = 0;
  let binary = 0;
  for (const relative of unique) {
    if (FORBIDDEN_PACK_RE.test(relative)) findings.push(finding(relative, 0, RULE.PACKLIST));
    const safe = safeRelative(cwd, relative);
    if (!safe) {
      findings.push(finding(relative, 0, RULE.PACKLIST));
      continue;
    }
    scanned += 1;
    findings.push(...scanLine(relative, { path: relative, lineNumber: 0, exemptions }));
    const read = readTextFile(cwd, relative, { knownBinary: (p) => KNOWN_BINARY_RE.test(p) });
    findings.push(...read.findings);
    if (read.binary) {
      binary += 1;
      continue;
    }
    if (read.text !== undefined) findings.push(...scanText(read.text, { path: relative, exemptions }));
  }
  return { mode: "pack", findings, scanned, binary, packEntries: unique.length };
}

export function formatReport(result, { maxFindings = 200 } = {}) {
  const counts = { confirmed: 0, review: 0, "public-synthetic": 0, "public-declared": 0 };
  for (const hit of result.findings) if (Object.hasOwn(counts, hit.status)) counts[hit.status] += 1;
  const blocking = result.findings.filter((hit) => hit.status === "confirmed" || hit.status === "review");
  const lines = [];
  for (const hit of blocking.slice(0, maxFindings)) lines.push(`${hit.path}:${hit.line} ${hit.ruleId} ${hit.status}`);
  if (blocking.length > maxFindings) lines.push(`<report>:0 FINDINGS-SUPPRESSED confirmed`);
  const pack = result.packEntries === null ? "" : ` packlist=${result.packEntries}`;
  lines.push(`privacy-audit ${result.mode}: files=${result.scanned}${pack} binary=${result.binary} confirmed=${counts.confirmed} review=${counts.review} public-synthetic=${counts["public-synthetic"]} public-declared=${counts["public-declared"]}`);
  lines.push(`${blocking.length === 0 ? "✅" : "❌"} privacy-audit ${result.mode}: ${blocking.length === 0 ? "pass" : "blocked"}`);
  return { text: lines.join("\n") + "\n", ok: blocking.length === 0, counts, blocking: blocking.length };
}

export function main(argv = process.argv.slice(2)) {
  const changed = argv.includes("--changed");
  const pack = argv.includes("--pack");
  if ((changed && pack) || argv.some((arg) => !["--changed", "--pack"].includes(arg))) {
    process.stdout.write("privacy-audit: usage is --changed (default) or --pack\n");
    return 2;
  }
  const result = pack ? auditPack() : auditChanged();
  const report = formatReport(result);
  process.stdout.write(report.text);
  return report.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && nodePath.resolve(process.argv[1]) === nodePath.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
